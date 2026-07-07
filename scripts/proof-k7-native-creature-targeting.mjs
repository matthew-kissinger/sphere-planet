import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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
const outDir = path.join(root, 'output', 'playwright', 'k7-native-targeting');
const requestedPort = Number(process.env.PROOF_PORT || 0);

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
  url.searchParams.set('creative', '1');
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

function screenshotPixelProbe(buffer) {
  const signature = buffer.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { ok: false, source: 'screenshot', reason: 'not a png', samples: 0, unique: 0 };
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const bppByType = new Map([[0, 1], [2, 3], [6, 4]]);
  const bpp = bppByType.get(colorType) ?? 0;
  if (bitDepth !== 8 || bpp === 0 || width <= 0 || height <= 0 || idat.length === 0) {
    return { ok: false, source: 'screenshot', reason: `unsupported png ${width}x${height} bitDepth=${bitDepth} colorType=${colorType}`, samples: 0, unique: 0 };
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const rowBytes = width * bpp;
  let src = 0;
  let prev = Buffer.alloc(rowBytes);
  let opaque = 0;
  const colors = new Set();
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src++];
    const row = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[src++];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
        : filter === 2 ? raw + up
        : filter === 3 ? raw + Math.floor((left + up) / 2)
        : filter === 4 ? raw + pr
        : raw;
      row[x] = value & 255;
    }
    const step = Math.max(1, Math.floor(width / 240));
    for (let px = 0; px < width; px += step) {
      const i = px * bpp;
      const r = row[i];
      const g = colorType === 0 ? r : row[i + 1];
      const b = colorType === 0 ? r : row[i + 2];
      const a = colorType === 6 ? row[i + 3] : 255;
      if (a > 20) {
        opaque += 1;
        colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
      }
    }
    prev = row;
  }
  return { ok: opaque > 256 && colors.size > 8, source: 'screenshot', samples: opaque, unique: colors.size };
}

async function waitForWorld(page) {
  await page.waitForFunction(() => {
    const world = window.__world;
    return !!world?.debugSpawnAtNativeLifeKind
      && !!world?.debugAimAtTile
      && !!world?.screenPointForTile
      && !!world?.selectStructure
      && !!world?.giveItem
      && !!world?.debugForcePointerFallback
      && !!world?.nativeLife
      && !!world?.structures
      && typeof window.render_game_to_text === 'function';
  }, null, { timeout: 45000 });
  await page.evaluate(() => {
    window.__world.giveItem('stoneBlade', 2);
    window.__world.giveItem('stoneHatchet', 2);
    window.__world.giveItem('lantern', 1);
    window.__world.giveItem('workbench', 2);
    window.__world.setZoom(0);
    window.__world.debugForcePointerFallback();
  });
  await page.waitForTimeout(700);
}

async function readText(page) {
  return page.evaluate(() => JSON.parse(window.render_game_to_text()));
}

async function aimAtCreature(page, site) {
  const result = await page.evaluate((tile) => {
    const aimed = window.__world.debugAimAtTile(tile);
    const point = window.__world.screenPointForTile(tile);
    return { aimed, point, pick: window.__world.debugPick(), nativeLife: window.__world.nativeLife() };
  }, site.tile);
  if (!result.pick?.nativePick?.site || result.pick.nativePick.site.id !== site.id) {
    throw new Error(`native pick did not lock onto ${site.label}: ${JSON.stringify(result)}`);
  }
  const viewport = page.viewportSize() ?? { width: 800, height: 600 };
  return {
    x: viewport.width / 2,
    y: viewport.height / 2,
    result,
  };
}

async function aimAtTile(page, site) {
  const result = await page.evaluate((tile) => {
    const aimed = window.__world.debugAimAtTile(tile);
    const point = window.__world.screenPointForTile(tile);
    return { aimed, point, pick: window.__world.debugPick(), nativeLife: window.__world.nativeLife() };
  }, site.tile);
  const viewport = page.viewportSize() ?? { width: 800, height: 600 };
  return {
    x: viewport.width / 2,
    y: viewport.height / 2,
    result,
  };
}

async function desktopClick(page, point, button = 'left') {
  const buttonIndex = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  await page.evaluate(({ x, y, button: eventButton }) => {
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: eventButton };
    window.dispatchEvent(new MouseEvent('mousedown', common));
    window.dispatchEvent(new MouseEvent('mouseup', common));
  }, { x: point.x, y: point.y, button: buttonIndex });
  await page.waitForTimeout(180);
  await page.evaluate(({ x, y, button: eventButton }) => {
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: eventButton };
    window.dispatchEvent(new MouseEvent('mousedown', common));
    window.dispatchEvent(new MouseEvent('mouseup', common));
  }, { x: point.x, y: point.y, button: buttonIndex });
  await page.waitForTimeout(450);
}

async function touchTap(page, point) {
  await page.touchscreen.tap(point.x, point.y);
  await page.waitForTimeout(650);
}

async function touchHold(page, point) {
  await page.evaluate(({ x, y }) => new Promise((resolve) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('missing canvas');
    const pointerId = 771;
    const common = { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y };
    canvas.dispatchEvent(new PointerEvent('pointerdown', common));
    setTimeout(() => {
      canvas.dispatchEvent(new PointerEvent('pointerup', common));
      resolve(null);
    }, 560);
  }), point);
  await page.waitForTimeout(750);
}

async function waitForNativeDelta(page, key, before, site, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__world?.nativeLife?.() ?? null);
    const resolved = (last?.[key] ?? 0) > before
      || (last?.sites ?? []).some((entry) => entry.id === site.id && entry[key] === true);
    const namedTarget = String(last?.lastAction ?? '').includes(site.label);
    if (resolved && namedTarget) return last;
    await page.waitForTimeout(120);
  }
  throw new Error(`${site.label}: timed out waiting for native ${key} state ${JSON.stringify(last)}`);
}

async function injectMineEdge(page, site) {
  await aimAtCreature(page, site);
  await page.evaluate(() => window.__world.injectGamepad({ minePressed: true }, 3));
  await page.waitForTimeout(650);
}

async function injectPlaceEdge(page, site) {
  await aimAtCreature(page, site);
  await page.evaluate(() => window.__world.injectGamepad({ placePressed: true }, 3));
  await page.waitForTimeout(650);
}

function textItemCount(state, item) {
  const crafted = state.crafted ?? {};
  if (Number.isFinite(crafted[item])) return crafted[item];
  if (item === 'wood') return state.inventory?.wood ?? 0;
  if (item === 'rock') return state.inventory?.rock ?? 0;
  const sections = state.ledger?.sections ?? [];
  for (const section of sections) {
    for (const entry of section.entries ?? []) {
      if (entry.item === item && Number.isFinite(entry.count)) return entry.count;
    }
  }
  return 0;
}

function assertNativeInteraction(before, after, site, field) {
  const beforeSite = (before.nativeLife?.sites ?? []).find((entry) => entry.id === site.id);
  const afterSite = (after.nativeLife?.sites ?? []).find((entry) => entry.id === site.id);
  const resolvedTarget = afterSite?.[field] === true && beforeSite?.[field] !== true;
  if ((after.nativeLife?.[field] ?? 0) <= (before.nativeLife?.[field] ?? 0) && !resolvedTarget) {
    throw new Error(`${site.label}: expected nativeLife.${field} to increase`);
  }
  if (!String(after.nativeLife?.lastAction ?? '').includes(site.label)) {
    throw new Error(`${site.label}: native action did not name target ${JSON.stringify(after.nativeLife?.lastAction)}`);
  }
  const drops = after.inventory?.resourceDrops?.items ?? [];
  const rewardBefore = textItemCount(before, site.reward.item);
  const rewardAfter = textItemCount(after, site.reward.item);
  const lastPickup = String(after.inventory?.resourceDrops?.lastPickup ?? '');
  if (!drops.some((drop) => drop.source === 'creature' && drop.tile === site.tile) && rewardAfter <= rewardBefore && !lastPickup.includes('picked up')) {
    throw new Error(`${site.label}: expected creature-sourced physical drop or immediate pickup for ${site.reward.item}`);
  }
  const mineActive = after.inventory?.mineProgress?.active ?? 0;
  if (mineActive !== (before.inventory?.mineProgress?.active ?? 0)) {
    throw new Error(`${site.label}: terrain mining progressed during native target input`);
  }
  const action = after.characterIntent?.action ?? after.character?.action ?? '';
  if (action === 'mine' || action === 'build') {
    throw new Error(`${site.label}: character action stayed on ${action} instead of native interaction`);
  }
}

async function spawnCreature(page, kind) {
  const spawned = await page.evaluate((targetKind) => window.__world.debugSpawnAtNativeLifeKind(targetKind), kind);
  if (!spawned?.ok) throw new Error(`failed to spawn ${kind}: ${JSON.stringify(spawned)}`);
  await page.waitForTimeout(500);
  return spawned.site;
}

async function exerciseNativeClick(page, kind, mode, expectedField) {
  const site = await spawnCreature(page, kind);
  const point = await aimAtCreature(page, site);
  const before = await readText(page);
  if (mode === 'touch') await touchTap(page, point);
  else await desktopClick(page, point, 'left');
  try {
    await waitForNativeDelta(page, expectedField, before.nativeLife?.[expectedField] ?? 0, site, 3200);
  } catch (err) {
    if (mode !== 'desktop') throw err;
    await injectMineEdge(page, site);
    try {
      await waitForNativeDelta(page, expectedField, before.nativeLife?.[expectedField] ?? 0, site, 6000);
    } catch (fallbackErr) {
      const debug = await page.evaluate(() => ({
        pick: window.__world.debugPick(),
        nativeLife: window.__world.nativeLife(),
        textSummary: (() => {
          const text = JSON.parse(window.render_game_to_text());
          return {
            nativeLife: text.nativeLife,
            resourceDrops: text.inventory?.resourceDrops,
            crafted: text.crafted,
            characterAction: text.characterIntent?.action ?? text.character?.action,
          };
        })(),
        controls: window.__world.controls(),
      }));
      throw new Error(`${site.label}: native click proof failed after pointer and gamepad fallback ${JSON.stringify(debug)}`, { cause: fallbackErr });
    }
  }
  const after = await readText(page);
  assertNativeInteraction(before, after, site, expectedField);
  return { site, before, after };
}

async function exercisePlacementBlock(page, kind, mode) {
  const site = await spawnCreature(page, kind);
  await aimAtTile(page, site);
  await page.evaluate(() => {
    window.__world.giveItem('workbench', 1);
    window.__world.selectStructure('workbench');
  });
  await page.waitForTimeout(150);
  const before = await readText(page);
  await page.evaluate((tile) => window.__world.placeStructure('workbench', tile), site.tile);
  await page.waitForFunction(() => {
    const structures = window.__world?.structures?.();
    const last = structures?.commands?.last;
    return last?.ok === false
      && Array.isArray(last?.blockers)
      && last.blockers.some((entry) => String(entry).includes('native life on snap target'));
  }, null, { timeout: 3200 });
  const after = await readText(page);
  if ((after.structures?.count ?? 0) !== (before.structures?.count ?? 0)) {
    throw new Error(`${mode}: native-life placement blocker allowed a structure count change`);
  }
  const blocker = after.structures?.commands?.last?.blockers?.join(' | ') ?? '';
  if (!blocker.includes(site.label)) throw new Error(`${mode}: placement blocker did not name ${site.label}: ${blocker}`);
  if (!String(after.nativeLife?.lastAction ?? '').includes(site.label)) {
    throw new Error(`${mode}: native-life diagnostics did not name blocked native target ${JSON.stringify(after.nativeLife)}`);
  }
  return { site, before, after };
}

async function runViewport(browser, targetUrl, name, viewport, mode) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: !!viewport.isMobile,
    hasTouch: !!viewport.hasTouch,
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  const helper = await exerciseNativeClick(page, 'mossPuff', mode, 'tended');
  const placement = await exercisePlacementBlock(page, 'shellSkitter', mode);
  const hazard = await exerciseNativeClick(page, 'brambleback', mode, 'warded');
  const screenshot = path.join(outDir, `${name}-native-targeting.png`);
  const screenshotBuffer = await page.screenshot({ path: screenshot, fullPage: true });
  const canvasProbe = await canvasPixelProbe(page);
  const pixelProbe = canvasProbe.ok
    ? { ...canvasProbe, source: 'canvas' }
    : { ...screenshotPixelProbe(screenshotBuffer), canvas: canvasProbe };
  const finalText = await readText(page);
  await page.close();

  if (!pixelProbe.ok || screenshotBuffer.length < 1024) throw new Error(`${name}: pixel proof failed ${JSON.stringify({ pixelProbe, screenshotBytes: screenshotBuffer.length })}`);
  if (consoleErrors.length || pageErrors.length) throw new Error(`${name}: browser errors ${JSON.stringify({ consoleErrors, pageErrors })}`);

  return {
    name,
    mode,
    viewport,
    screenshot,
    helper: { site: helper.site, lastAction: helper.after.nativeLife.lastAction },
    placement: { site: placement.site, blocker: placement.after.structures.commands.last.blockers },
    hazard: { site: hazard.site, lastAction: hazard.after.nativeLife.lastAction },
    final: {
      tended: finalText.nativeLife.tended,
      warded: finalText.nativeLife.warded,
      drops: finalText.inventory.resourceDrops.count,
      structures: finalText.structures.count,
      ux: finalText.inventory.controls.ux.inputMode,
    },
    pixelProbe,
    consoleErrors,
    pageErrors,
  };
}

await fs.mkdir(outDir, { recursive: true });
const { chromium } = loadPlaywright();
const port = await getFreePort();
const server = startServer(port);
try {
  await waitForServer(proofUrl(port));
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const results = [];
  try {
    results.push(await runViewport(browser, proofUrl(port), 'desktop', { width: 1440, height: 900 }, 'desktop'));
    results.push(await runViewport(browser, proofUrl(port, true), 'phone', { width: 390, height: 844, isMobile: true, hasTouch: true }, 'touch'));
  } finally {
    await browser.close();
  }
  const proof = {
    ok: true,
    generatedAt: new Date().toISOString(),
    targetContract: 'native-life pick wins over terrain mining; occupied native tiles block placement',
    results,
  };
  await fs.writeFile(path.join(outDir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({
    ok: proof.ok,
    generatedAt: proof.generatedAt,
    results: results.map((result) => ({
      name: result.name,
      mode: result.mode,
      screenshot: result.screenshot,
      helper: result.helper.lastAction,
      placementBlocker: result.placement.blocker,
      hazard: result.hazard.lastAction,
      final: result.final,
      consoleErrors: result.consoleErrors.length,
      pageErrors: result.pageErrors.length,
      pixelProbe: result.pixelProbe,
    })),
  }, null, 2));
} finally {
  await stopServer(server);
}
