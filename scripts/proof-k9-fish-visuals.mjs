import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
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
const outDir = path.join(root, 'output', 'playwright', 'k9-fish-visuals');
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

async function main() {
  const { chromium } = loadPlaywright();
  await fs.mkdir(outDir, { recursive: true });
  const port = await getFreePort();
  const server = startServer(port);
  const target = proofUrl(port);
  let browser;
  try {
    await waitForServer(target);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[browser:${msg.type()}] ${msg.text()}`);
    });
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const world = window.__world;
      return !!world?.fishVisuals
        && !!world?.spawnAtNaturalFeature
        && !!world?.giveItem
        && typeof window.render_game_to_text === 'function';
    }, null, { timeout: 45000 });
    const setup = await page.evaluate(() => {
      window.__world.giveItem('fishingRod', 1);
      window.__world.giveItem('bait', 2);
      return window.__world.spawnAtNaturalFeature('seaCave');
    });
    if (!setup) throw new Error('Unable to spawn at a sea cave for fish visual proof');
    await page.waitForFunction(() => {
      const proof = window.__world?.fishVisuals?.();
      const renderer = proof?.renderer;
      const cave = renderer?.kilnFishSkinsBySlug?.['fish-cave-shimmer'];
      return proof?.site?.school?.kind === 'cave'
        && renderer?.slug === 'fish-cave-shimmer'
        && (cave?.loaded ?? 0) > 0
        && (cave?.visibleAnchors ?? 0) > 0
        && (renderer?.pointSchoolSprites ?? 0) > 0
        && (renderer?.kilnFishSkinFallbacks ?? 0) === 0;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const proof = await page.evaluate(() => ({
      fishVisuals: window.__world.fishVisuals(),
      text: JSON.parse(window.render_game_to_text()),
      kiln: window.__world.stats().kilnAssets,
    }));
    await fs.writeFile(path.join(outDir, 'proof.json'), JSON.stringify({ ok: true, setup, proof }, null, 2));
    await page.screenshot({ path: path.join(outDir, 'fish-cave-shimmer.png'), fullPage: false });
    console.log(JSON.stringify({
      ok: true,
      slug: proof.fishVisuals.renderer.slug,
      anchors: proof.fishVisuals.renderer.glbAnchorsVisible,
      points: proof.fishVisuals.renderer.pointSchoolSprites,
      loaded: proof.fishVisuals.renderer.kilnFishSkinsBySlug['fish-cave-shimmer']?.loaded ?? 0,
      screenshot: path.join(outDir, 'fish-cave-shimmer.png'),
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
