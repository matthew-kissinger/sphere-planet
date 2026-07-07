import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

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
const outDir = path.join(root, 'output', 'playwright', 'c1-build-placement');
const requestedPort = Number(process.env.PROOF_PORT || 0);
const profileFilter = (process.env.PROOF_PROFILE || '').trim().toLowerCase();

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

function proofUrl(port, touch = false) {
  const base = process.env.PROOF_URL || `http://127.0.0.1:${port}/`;
  const url = new URL(base);
  url.searchParams.set('nosave', '1');
  url.searchParams.set('resetSave', '1');
  url.searchParams.set('mute', '1');
  if (touch) url.searchParams.set('touch', '1');
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
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
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
          samples++;
        }
      }
    }
    prev.set(row);
  }
  return { ok: colors.size >= 12 && samples > 40, samples, unique: colors.size, width, height };
}

async function screenshot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  const buffer = await page.screenshot({ path: file, fullPage: true });
  const probe = pngPixelProbe(buffer);
  if (!probe.ok) throw new Error(`${name}: screenshot pixel probe failed ${JSON.stringify(probe)}`);
  return { file, probe };
}

async function waitForWorld(page) {
  await page.waitForFunction(() => {
    const world = window.__world;
    return !!world?.placeStructure && !!world?.rotatePlacement && !!world?.rotateStructure && !!world?.dismantleStructure;
  }, null, { timeout: 45000 });
  await page.waitForTimeout(350);
}

async function runPlacementContract(page, name, options = {}) {
  await waitForWorld(page);
  await page.evaluate(() => window.__world.setZoom?.(0.22));

  const inputProof = await page.evaluate(async (profile) => {
    const world = window.__world;
    for (const item of ['doorKit', 'windowFrame', 'roofBundle', 'workbench', 'campfire']) world.giveItem(item, 2);
    world.selectStructure('doorKit');
    const before = world.structures().placement.turn;
    if (profile === 'gamepad') {
      world.injectGamepad({ pin: true }, 3);
      await window.advanceTime(160);
    }
    return {
      before,
      after: world.structures().placement.turn,
      selected: world.structures().placement.selected,
      controls: world.controls(),
    };
  }, options.gamepad ? 'gamepad' : 'debug');

  if (options.keyboard) {
    await page.keyboard.press('KeyX');
    await page.waitForTimeout(120);
  } else if (!options.gamepad) {
    await page.evaluate(() => window.__world.rotatePlacement(1));
  }

  const afterInput = await page.evaluate(() => window.__world.structures().placement);
  const expectedTurn = (inputProof.before + 1) % 6;
  if (options.gamepad && inputProof.after !== expectedTurn) {
    throw new Error(`${name}: gamepad build rotation did not advance placement ${JSON.stringify(inputProof)}`);
  }
  if (!options.gamepad && afterInput.turn !== expectedTurn) {
    throw new Error(`${name}: build rotation did not advance placement ${JSON.stringify({ inputProof, afterInput })}`);
  }

  const result = await page.evaluate(() => {
    const world = window.__world;
    const used = new Set();
    const candidates = world.nearbyTiles(3).filter((tile) => tile !== world.player.tile);
    function place(item) {
      for (const tile of candidates) {
        if (used.has(tile)) continue;
        if (world.placeStructure(item, tile)) {
          used.add(tile);
          const items = world.structures().items;
          return items[items.length - 1];
        }
      }
      throw new Error(`could not place ${item}`);
    }

    const door = place('doorKit');
    world.selectStructure('roofBundle');
    world.rotatePlacement(1);
    const roof = place('roofBundle');
    const windowFrame = place('windowFrame');
    const workbench = place('workbench');
    const campfire = place('campfire');

    const beforeRotate = world.structures().items.find((entry) => entry.id === door.id);
    world.rotateStructure(door.id, 1);
    const afterRotate = world.structures().items.find((entry) => entry.id === door.id);

    const packBefore = world.crafting().crafted.workbench ?? 0;
    const packed = world.dismantleStructure(workbench.id);
    const packAfter = world.crafting().crafted.workbench ?? 0;

    world.useStructure(campfire.id);
    const unsafePack = world.dismantleStructure(campfire.id);
    const final = world.structures();
    return {
      door,
      roof,
      windowFrame,
      workbench,
      campfire,
      beforeRotate,
      afterRotate,
      packed,
      packBefore,
      packAfter,
      unsafePack,
      final,
      text: JSON.parse(window.render_game_to_text()),
    };
  });

  const rotatedTurn = (result.beforeRotate.turn + 1) % 6;
  if (result.afterRotate.turn !== rotatedTurn) throw new Error(`${name}: placed door did not rotate one hex face ${JSON.stringify(result.beforeRotate)} -> ${JSON.stringify(result.afterRotate)}`);
  if (result.packed !== true || result.final.items.some((entry) => entry.id === result.workbench.id)) throw new Error(`${name}: safe workbench did not pack out`);
  if (result.packAfter < result.packBefore + 1) throw new Error(`${name}: packed workbench did not return to crafted inventory`);
  if (result.unsafePack !== false || !/douse light first/.test(result.final.lastAction ?? '')) throw new Error(`${name}: lit campfire packing was not blocked ${JSON.stringify(result.final.lastAction)}`);
  if (result.final.items.length < 4) throw new Error(`${name}: expected visible house-kit cluster after pack flow`);
  if (result.text.structures.placement.selected === undefined) throw new Error(`${name}: render_game_to_text missing placement diagnostics`);

  const shot = await screenshot(page, `${name}-build-placement`);
  return {
    name,
    inputProof,
    afterInput,
    result: {
      door: result.afterRotate,
      roof: result.roof,
      windowFrame: result.windowFrame,
      packedReturned: result.packAfter,
      unsafeLastAction: result.final.lastAction,
      structures: result.final.items.length,
      renderer: result.final.renderer,
    },
    screenshot: shot,
  };
}

async function runProfile(browser, url, profile) {
  const consoleErrors = [];
  const pageErrors = [];
  const page = await browser.newPage({
    viewport: profile.viewport,
    isMobile: !!profile.touch,
    hasTouch: !!profile.touch,
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const result = await runPlacementContract(page, profile.name, profile.options);
    if (consoleErrors.length || pageErrors.length) throw new Error(`${profile.name}: browser errors ${JSON.stringify({ consoleErrors, pageErrors })}`);
    return {
      ...result,
      url,
      viewport: profile.viewport,
      touch: !!profile.touch,
      consoleErrors,
      pageErrors,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const { chromium } = loadPlaywright();
  await fs.mkdir(outDir, { recursive: true });
  const port = await getFreePort();
  const server = startServer(port);
  const desktopUrl = proofUrl(port, false);
  const touchUrl = proofUrl(port, true);
  const profiles = [
    { name: 'desktop-keyboard', url: desktopUrl, viewport: { width: 1440, height: 900 }, options: { keyboard: true } },
    { name: 'laptop-keyboard', url: desktopUrl, viewport: { width: 1366, height: 720 }, options: { keyboard: true } },
    { name: 'tablet-touch', url: touchUrl, viewport: { width: 820, height: 1180 }, touch: true, options: {} },
    { name: 'phone-touch', url: touchUrl, viewport: { width: 390, height: 844 }, touch: true, options: {} },
    { name: 'desktop-gamepad', url: desktopUrl, viewport: { width: 1440, height: 900 }, options: { gamepad: true } },
  ].filter((profile) => !profileFilter || profile.name.toLowerCase().includes(profileFilter));
  if (profiles.length === 0) throw new Error(`No proof profiles matched PROOF_PROFILE=${profileFilter}`);

  try {
    await waitForServer(desktopUrl);
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
      for (const profile of profiles) {
        results.push(await runProfile(browser, profile.url, profile));
      }
    } finally {
      await browser.close();
    }
    const proof = {
      ok: true,
      generatedAt: new Date().toISOString(),
      desktopUrl,
      touchUrl,
      profiles: results,
    };
    const proofFile = path.join(outDir, 'proof.json');
    await fs.writeFile(proofFile, JSON.stringify(proof, null, 2));
    console.log(`C1 build placement proof passed: ${proofFile}`);
  } finally {
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
