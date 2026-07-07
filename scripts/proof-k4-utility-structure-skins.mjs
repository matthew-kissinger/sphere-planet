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
const outDir = path.join(root, 'output', 'playwright', 'k4-utility-structure-skins');
const requestedPort = Number(process.env.PROOF_PORT || 0);

const K4_PROPS = [
  { item: 'compostBin', slug: 'compost-bin', waterline: false },
  { item: 'rainCistern', slug: 'rain-cistern', waterline: false },
  { item: 'rootCellar', slug: 'root-cellar', waterline: false },
  { item: 'dockSegment', slug: 'dock-segment', waterline: true },
  { item: 'fishTrap', slug: 'fish-trap', waterline: true },
  { item: 'shoreNet', slug: 'shore-net', waterline: true },
  { item: 'lantern', slug: 'lantern-post', waterline: false },
];

const ITEM_BY_SLUG = Object.fromEntries(K4_PROPS.map((entry) => [entry.slug, entry.item]));

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
  url.searchParams.set('gpu', 'gl');
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

async function seedK4Props(page) {
  return page.evaluate((props) => {
    const world = window.__world;
    const reset = JSON.parse(world.save.export());
    reset.structures = [];
    reset.craftedItems = { ...(reset.craftedItems ?? {}) };
    reset.inventory = reset.inventory ?? {};
    for (const prop of props) reset.craftedItems[prop.item] = 3;
    reset.craftedItems.bait = 2;
    if (!world.save.import(JSON.stringify(reset))) throw new Error('failed to reset K4 prop proof save');
    world.setZoom?.(0.15);

    const placed = [];
    const failures = [];
    const used = new Set([world.player.tile]);
    const placeFromCandidates = (item, candidates) => {
      for (const tile of candidates) {
        if (used.has(tile)) continue;
        const before = new Set(world.structures().items.map((entry) => entry.id));
        if (!world.placeStructure(item, tile)) continue;
        const entry = world.structures().items.find((candidate) => !before.has(candidate.id));
        if (!entry) throw new Error(`placed ${item} but could not find saved structure`);
        used.add(tile);
        placed.push(entry);
        return entry;
      }
      failures.push({ item, candidates: candidates.slice(0, 24), lastAction: world.structures().lastAction, placement: world.structures().placement });
      return null;
    };

    const normalCandidates = world.nearbyTiles(6).filter((tile) => tile !== world.player.tile);
    for (const prop of props.filter((entry) => !entry.waterline)) {
      placeFromCandidates(prop.item, normalCandidates);
    }

    const feature = world.spawnAtNaturalFeature?.('seaCave') ?? world.spawnAtNaturalFeature?.('dryCave') ?? null;
    const waterlineCandidates = world.nearbyTiles(10).filter((tile) => tile !== world.player.tile);
    for (const prop of props.filter((entry) => entry.waterline)) {
      placeFromCandidates(prop.item, waterlineCandidates);
    }
    if (failures.length) throw new Error(`K4 placement failures ${JSON.stringify({ feature, failures })}`);

    const staged = JSON.parse(world.save.export());
    for (const structure of staged.structures) {
      if (structure.item === 'compostBin') structure.state = { composts: 1 };
      if (structure.item === 'rainCistern') structure.state = { water: 3, fills: 1 };
      if (structure.item === 'rootCellar') structure.state = { provisions: 3, caches: 1 };
      if (structure.item === 'fishTrap') structure.state = { trapSetDay: 2, trapSetMinute: 30, trapBaited: true };
      if (structure.item === 'shoreNet') structure.state = { netSetDay: 2, netSetMinute: 40 };
      if (structure.item === 'lantern') structure.state = { lit: true };
    }
    if (!world.save.import(JSON.stringify(staged))) throw new Error('failed to import staged K4 prop states');
    return {
      feature,
      placed,
      structures: world.structures(),
    };
  }, K4_PROPS);
}

function assertK4Renderer(result, label) {
  const renderer = result?.proof?.structures?.renderer;
  if (!renderer) throw new Error(`${label}: missing structure renderer diagnostics`);
  if (renderer.kilnSkinsLoaded !== K4_PROPS.length) throw new Error(`${label}: expected ${K4_PROPS.length} loaded K4 skins, got ${renderer.kilnSkinsLoaded}`);
  if (renderer.kilnSkinsPending !== 0) throw new Error(`${label}: K4 skins still pending ${renderer.kilnSkinsPending}`);
  if (renderer.kilnSkinFallbacks !== 0) throw new Error(`${label}: K4 fallback triggered ${renderer.kilnSkinFallbacks}`);
  for (const { item, slug } of K4_PROPS) {
    const bySlug = renderer.kilnSkinsBySlug?.[slug];
    if (!bySlug || bySlug.loaded !== 1 || bySlug.pending !== 0 || bySlug.fallback !== 0) {
      throw new Error(`${label}: bad ${slug} loaded/fallback counts ${JSON.stringify(bySlug)}`);
    }
    const fit = renderer.kilnSkinFits?.[slug];
    if (!fit || fit.item !== item || fit.glbPolicy !== 'decorative-skin-after-normalization') {
      throw new Error(`${label}: bad ${slug} fit metadata ${JSON.stringify(fit)}`);
    }
    if (!String(fit.sourceUrl ?? '').includes(`/assets/kiln/models/${slug}.glb`)) {
      throw new Error(`${label}: ${slug} fit does not point at committed model ${JSON.stringify(fit)}`);
    }
    if (slug === 'shore-net' && Math.abs((fit.rotation?.[1] ?? 0) - Math.PI / 2) > 0.001) {
      throw new Error(`${label}: shore-net missing 90-degree Y correction ${JSON.stringify(fit)}`);
    }
  }
  const structures = result.proof.structures.items ?? [];
  for (const { item } of K4_PROPS) {
    if (!structures.some((entry) => entry.item === item)) throw new Error(`${label}: missing placed ${item}`);
  }
  const utilitySockets = result.proof.structures.sockets?.k4Utilities ?? [];
  if (utilitySockets.length !== K4_PROPS.length) throw new Error(`${label}: missing K4 utility socket diagnostics`);
  for (const item of ['dockSegment', 'fishTrap', 'shoreNet']) {
    const entry = structures.find((candidate) => candidate.item === item);
    if (entry?.socket?.kind !== 'edge') throw new Error(`${label}: ${item} did not resolve to edge socket ${JSON.stringify(entry)}`);
  }
}

async function runViewport(browser, port, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    isMobile: profile.touch,
    hasTouch: profile.touch,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const kilnAssetRequests = [];
  const kilnAssetResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/assets/kiln/')) kilnAssetRequests.push(url);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/assets/kiln/')) kilnAssetResponses.push({ url, status: response.status() });
  });

  await page.goto(proofUrl(port, profile.touch), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const world = window.__world;
    return !!world?.placeStructure
      && !!world?.nearbyTiles
      && !!world?.spawnAtNaturalFeature
      && !!world?.structures
      && !!world?.save?.export
      && !!world?.save?.import
      && typeof window.render_game_to_text === 'function';
  }, null, { timeout: 45000 });
  const setup = await seedK4Props(page);
  await page.waitForFunction((slugs) => {
    const renderer = window.__world?.structures?.().renderer;
    return renderer
      && renderer.kilnSkinsLoaded === slugs.length
      && renderer.kilnSkinsPending === 0
      && renderer.kilnSkinFallbacks === 0
      && slugs.every((slug) => {
        const entry = renderer.kilnSkinsBySlug?.[slug];
        return entry?.loaded === 1 && entry.pending === 0 && entry.fallback === 0;
      });
  }, K4_PROPS.map((entry) => entry.slug), { timeout: 90000 });
  await page.waitForTimeout(700);
  const proof = await page.evaluate(() => ({
    structures: window.__world.structures(),
    text: JSON.parse(window.render_game_to_text()),
    kilnAssets: window.__world.stats().kilnAssets,
  }));
  const screenshot = path.join(outDir, `${profile.name}.png`);
  const screenshotBuffer = await page.screenshot({ path: screenshot, fullPage: true });
  const screenshotProbe = pngPixelProbe(screenshotBuffer);
  await context.close();

  const result = {
    profile: profile.name,
    setup,
    proof,
    screenshot,
    screenshotProbe,
    kilnAssets: { requests: kilnAssetRequests, responses: kilnAssetResponses },
    consoleErrors,
    pageErrors,
  };
  assertK4Renderer(result, profile.name);
  const responsesOk = (suffix) => kilnAssetResponses.some((asset) => asset.url.includes(suffix) && asset.status >= 200 && asset.status < 300);
  for (const { slug } of K4_PROPS) {
    if (!responsesOk(`/assets/kiln/models/${slug}.glb`)) throw new Error(`${profile.name}: missing successful ${slug}.glb response`);
  }
  const generatedRequests = kilnAssetRequests.filter((url) => url.includes('/assets/kiln/generated/'));
  if (generatedRequests.length > 0) throw new Error(`${profile.name}: runtime requested raw generated assets ${JSON.stringify(generatedRequests)}`);
  if (!screenshotProbe.ok || screenshotBuffer.length < 1024) throw new Error(`${profile.name}: screenshot pixel proof failed ${JSON.stringify(screenshotProbe)}`);
  if (consoleErrors.length || pageErrors.length) throw new Error(`${profile.name}: browser errors ${JSON.stringify({ consoleErrors, pageErrors })}`);
  return result;
}

const { chromium } = loadPlaywright();
await fs.mkdir(outDir, { recursive: true });
const port = await getFreePort();
const server = startServer(port);
try {
  await waitForServer(proofUrl(port));
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const results = [];
  try {
    results.push(await runViewport(browser, port, { name: 'desktop', touch: false, viewport: { width: 1360, height: 860 } }));
    results.push(await runViewport(browser, port, { name: 'phone', touch: true, viewport: { width: 390, height: 844 } }));
  } finally {
    await browser.close();
  }
  const proof = {
    ok: true,
    generatedAt: new Date().toISOString(),
    props: K4_PROPS,
    itemsBySlug: ITEM_BY_SLUG,
    results,
  };
  await fs.writeFile(path.join(outDir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({
    ok: true,
    generatedAt: proof.generatedAt,
    screenshots: results.map((result) => ({ profile: result.profile, screenshot: result.screenshot, probe: result.screenshotProbe })),
    loaded: results.map((result) => ({
      profile: result.profile,
      kilnSkinsLoaded: result.proof.structures.renderer.kilnSkinsLoaded,
      kilnSkinFallbacks: result.proof.structures.renderer.kilnSkinFallbacks,
      slugs: Object.fromEntries(K4_PROPS.map(({ slug }) => [slug, result.proof.structures.renderer.kilnSkinsBySlug[slug]])),
    })),
  }, null, 2));
} finally {
  await stopServer(server);
}
