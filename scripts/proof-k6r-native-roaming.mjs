import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to resolve Playwright. Install it or set NODE_PATH to a local node_modules containing playwright. ${message}`);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'output', 'playwright', 'k6r-native-roaming');
const requestedPort = Number(process.env.PROOF_PORT || 0);

const creatureSlugByKind = {
  mossPuff: 'creature-moss-puff',
  shellSkitter: 'creature-shell-skitter',
  reedbackGrazer: 'creature-reedback-grazer',
  caveBlinker: 'creature-cave-blinker',
  brambleback: 'creature-brambleback',
  caveBelljaw: 'creature-cave-belljaw',
  screeSnapper: 'creature-scree-snapper',
  stormBurr: 'creature-storm-burr',
  tideLurker: 'creature-tide-lurker',
};

async function getFreePort() {
  if (requestedPort > 0) return requestedPort;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(targetUrl, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(targetUrl, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Timed out waiting for ${targetUrl}`);
}

function proofUrl(port) {
  const base = process.env.PROOF_URL || `http://127.0.0.1:${port}/`;
  const url = new URL(base);
  url.searchParams.set('nosave', '1');
  url.searchParams.set('resetSave', '1');
  url.searchParams.set('creative', '1');
  url.searchParams.set('mute', '1');
  return url.toString();
}

function startServer(port) {
  if (process.env.PROOF_URL) return null;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function stopServer(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => {
        child.kill();
        resolve();
      });
      killer.on('close', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
}

async function waitForWorld(page) {
  await page.waitForFunction(() => {
    const world = window.__world;
    return !!world?.debugSpawnAtNativeLifeKind
      && !!world?.debugSetNativeLifeTime
      && !!world?.debugAimAtTile
      && !!world?.debugPick
      && !!world?.nativeLife
      && !!world?.setZoom
      && typeof window.render_game_to_text === 'function';
  }, null, { timeout: 45000 });
  await page.evaluate(() => {
    window.__world.setZoom(0);
    window.__world.giveItem?.('stoneBlade', 2);
    window.__world.giveItem?.('stoneHatchet', 2);
    window.__world.giveItem?.('lantern', 1);
    window.__world.giveItem?.('reedBow', 1);
    window.__world.giveItem?.('whistlingArrow', 8);
  });
  await page.waitForTimeout(700);
}

async function canvasPixelProbe(page) {
  return page.evaluate(() => {
    const source = document.querySelector('canvas');
    if (!source) return { ok: false, reason: 'missing canvas', samples: 0, unique: 0 };
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 32;
    const ctx = probe.getContext('2d');
    if (!ctx) return { ok: false, reason: 'missing 2d context', samples: 0, unique: 0 };
    ctx.drawImage(source, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set();
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 20) {
        opaque += 1;
        colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
      }
    }
    return { ok: opaque > 24 && colors.size > 4, samples: opaque, unique: colors.size };
  });
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngPixelProbe(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { ok: false, reason: 'not a png', samples: 0, unique: 0 };
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return { ok: false, reason: `unsupported png ${bitDepth}/${colorType}`, samples: 0, unique: 0 };
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  const colors = new Set();
  let samples = 0;
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      const value = raw[src++];
      row[x] = (value + (
        filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : paeth(left, up, upLeft)
      )) & 255;
    }
    if (y % Math.max(1, Math.floor(height / 24)) === 0) {
      for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 32))) {
        const i = x * channels;
        const a = channels === 4 ? row[i + 3] : 255;
        if (a > 8) {
          colors.add(`${row[i]},${row[i + 1]},${row[i + 2]}`);
          samples += 1;
        }
      }
    }
    prev.set(row);
  }
  return { ok: colors.size >= 12 && samples > 40, samples, unique: colors.size, width, height };
}

async function findMovingActor(page) {
  const spawnKinds = ['mossPuff', 'brambleback', 'shellSkitter', 'reedbackGrazer', 'tideLurker'];
  for (const kind of spawnKinds) {
    const spawned = await page.evaluate((targetKind) => window.__world.debugSpawnAtNativeLifeKind(targetKind), kind);
    if (!spawned?.ok) continue;
    for (let seconds = 0; seconds <= 80; seconds += 0.5) {
      const diagnostics = await page.evaluate((value) => window.__world.debugSetNativeLifeTime(value), seconds);
      const moving = (diagnostics.sites ?? []).find((site) => site.id === spawned.site?.id && site.motion?.moving && site.motion?.clip === 'walk');
      if (moving) return { spawned, seconds, moving, diagnostics };
    }
  }
  throw new Error(`no moving native-life actor found after scanning ${spawnKinds.join(', ')}`);
}

async function findReactiveActor(page) {
  const reactiveStates = new Set(['curious', 'flee', 'warn', 'telegraph', 'lunge']);
  const spawnKinds = ['brambleback', 'mossPuff', 'shellSkitter', 'reedbackGrazer', 'tideLurker'];
  for (const kind of spawnKinds) {
    const spawned = await page.evaluate((targetKind) => window.__world.debugSpawnAtNativeLifeKind(targetKind), kind);
    if (!spawned?.ok) continue;
    for (let seconds = 0; seconds <= 24; seconds += 0.5) {
      const diagnostics = await page.evaluate((value) => window.__world.debugSetNativeLifeTime(value), seconds);
      const reactive = (diagnostics.sites ?? []).find((site) => {
        const state = site.motion?.state;
        return site.id === spawned.site?.id
          && reactiveStates.has(state)
          && typeof site.motion?.mood === 'string'
          && Number.isFinite(site.motion?.playerRings);
      });
      if (reactive) return { spawned, seconds, reactive, diagnostics };
    }
  }
  throw new Error(`no reactive native-life actor found after scanning ${spawnKinds.join(', ')}`);
}

async function assertGlbRoaming(page, moving) {
  const slug = creatureSlugByKind[moving.kind];
  if (!slug) throw new Error(`no creature GLB slug mapped for ${moving.kind}`);
  await page.waitForFunction((targetSlug) => {
    const renderer = window.__world?.nativeLife?.().renderer;
    const bySlug = renderer?.kilnCreatureSkinsBySlug?.[targetSlug];
    return (renderer?.movingActors ?? 0) > 0
      && (renderer?.clipHints?.walk ?? 0) > 0
      && (bySlug?.loaded ?? 0) > 0
      && (bySlug?.glbVisible ?? 0) > 0
      && (renderer?.kilnCreatureSkinFallbacks ?? 0) === 0;
  }, slug, { timeout: 45000 });
  const proof = await page.evaluate((target) => {
    const aimed = window.__world.debugAimAtTile(target.tile);
    return {
      aimed,
      pick: window.__world.debugPick(),
      nativeLife: window.__world.nativeLife(),
      text: JSON.parse(window.render_game_to_text()),
      target,
    };
  }, { id: moving.id, tile: moving.tile, slug });
  if (proof.pick?.nativePick?.site?.id !== moving.id) {
    throw new Error(`roaming native pick did not lock onto moving actor ${JSON.stringify({ aimed: proof.aimed, pick: proof.pick, target: proof.target })}`);
  }
  const renderer = proof.nativeLife.renderer;
  const bySlug = renderer.kilnCreatureSkinsBySlug?.[slug];
  if ((renderer.kilnCreatureSkinFallbacks ?? 0) !== 0 || (bySlug?.loaded ?? 0) <= 0 || (bySlug?.glbVisible ?? 0) <= 0) {
    throw new Error(`roaming actor is not using the approved GLB skin ${JSON.stringify({ slug, renderer, bySlug })}`);
  }
  return proof;
}

await fs.mkdir(outDir, { recursive: true });
const port = await getFreePort();
const server = startServer(port);
try {
  await waitForServer(proofUrl(port));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const result = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    const kilnRequests = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/assets/kiln/')) kilnRequests.push(url);
    });

    await page.goto(proofUrl(port), { waitUntil: 'domcontentloaded' });
    await waitForWorld(page);
    const moving = await findMovingActor(page);
    const glbProof = await assertGlbRoaming(page, moving.moving);
    const reactive = await findReactiveActor(page);
    if ((reactive.diagnostics.roaming?.playerReactive ?? 0) <= 0) {
      throw new Error(`reactive actor did not register in native-life diagnostics ${JSON.stringify(reactive.diagnostics.roaming)}`);
    }
    const rendererMoods = reactive.diagnostics.renderer?.moods ?? {};
    if (!Object.keys(rendererMoods).some((mood) => mood !== 'unknown' && rendererMoods[mood] > 0)) {
      throw new Error(`reactive actor did not register renderer mood diagnostics ${JSON.stringify(reactive.diagnostics.renderer)}`);
    }
    const screenshot = path.join(outDir, 'desktop-k6r-native-roaming.png');
    const screenshotBuffer = await page.screenshot({ path: screenshot, fullPage: true });
    const pixelProbe = await canvasPixelProbe(page);
    const screenshotProbe = pngPixelProbe(screenshotBuffer);
    await page.close();

    const generatedRequests = kilnRequests.filter((url) => url.includes('/assets/kiln/generated/'));
    if (generatedRequests.length > 0) throw new Error(`runtime requested generated Kiln quarantine assets ${JSON.stringify(generatedRequests)}`);
    if ((!pixelProbe.ok && !screenshotProbe.ok) || screenshotBuffer.length < 1024) throw new Error(`pixel proof failed ${JSON.stringify({ pixelProbe, screenshotProbe, screenshotBytes: screenshotBuffer.length })}`);
    if (consoleErrors.length || pageErrors.length) throw new Error(`browser errors ${JSON.stringify({ consoleErrors, pageErrors })}`);
    Object.assign(result, {
      name: 'desktop',
      screenshot,
      moving,
      reactive,
      glbProof: {
        target: glbProof.target,
        renderer: glbProof.nativeLife.renderer,
        pick: glbProof.pick?.nativePick,
      },
      kilnRequests,
      generatedRequests,
      pixelProbe: { canvas: pixelProbe, screenshot: screenshotProbe },
      consoleErrors,
      pageErrors,
    });
  } finally {
    await browser.close();
  }
  const proof = {
    ok: true,
    generatedAt: new Date().toISOString(),
    targetContract: 'approved creature GLBs expose deterministic roaming state, proximity moods, walk clip hints, current-tile picking, and no generated quarantine runtime paths',
    result,
  };
  await fs.writeFile(path.join(outDir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({
    ok: proof.ok,
    generatedAt: proof.generatedAt,
    screenshot: result.screenshot,
    moving: {
      id: result.moving.moving.id,
      kind: result.moving.moving.kind,
      tile: result.moving.moving.tile,
      homeTile: result.moving.moving.homeTile,
      seconds: result.moving.seconds,
      state: result.moving.moving.motion?.state,
      clip: result.moving.moving.motion?.clip,
    },
    reactive: {
      id: result.reactive.reactive.id,
      kind: result.reactive.reactive.kind,
      tile: result.reactive.reactive.tile,
      seconds: result.reactive.seconds,
      state: result.reactive.reactive.motion?.state,
      mood: result.reactive.reactive.motion?.mood,
      playerRings: result.reactive.reactive.motion?.playerRings,
    },
    renderer: {
      roamingActors: result.glbProof.renderer.roamingActors,
      movingActors: result.glbProof.renderer.movingActors,
      moods: result.reactive.diagnostics.renderer?.moods,
      clipHints: result.glbProof.renderer.clipHints,
      fallbacks: result.glbProof.renderer.kilnCreatureSkinFallbacks,
      generatedRequests: result.generatedRequests.length,
    },
    pixelProbe: result.pixelProbe,
  }, null, 2));
} finally {
  await stopServer(server);
}
