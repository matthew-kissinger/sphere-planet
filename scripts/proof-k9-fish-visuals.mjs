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
const fishScenarios = [
  { slug: 'fish-shore-minnow', labelIncludes: 'shore' },
  { slug: 'fish-storm-runner', labelIncludes: 'storm' },
  { slug: 'fish-cave-shimmer', labelIncludes: 'cave' },
  { slug: 'creature-driftjelly', labelIncludes: 'tide' },
  { slug: 'fish-reed-fry', labelIncludes: 'reed' },
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

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
    const consoleErrors = [];
    const pageErrors = [];
    const kilnRequests = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        consoleErrors.push(text);
        console.error(`[browser:${msg.type()}] ${text}`);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err instanceof Error ? err.message : String(err)));
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/assets/kiln/')) kilnRequests.push(url);
    });
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const world = window.__world;
      return !!world?.fishVisuals
        && !!world?.debugSetFishVisualScenario
        && !!world?.debugClearFishVisualScenario
        && !!world?.giveItem
        && typeof window.render_game_to_text === 'function';
    }, null, { timeout: 45000 });
    await page.evaluate(() => {
      window.__world.giveItem('fishingRod', 1);
      window.__world.giveItem('bait', 5);
    });

    const results = [];
    for (const scenario of fishScenarios) {
      const setup = await page.evaluate((slug) => {
        window.__world.debugClearFishVisualScenario();
        return window.__world.debugSetFishVisualScenario(slug);
      }, scenario.slug);
      if (!setup?.ok) throw new Error(`${scenario.slug}: unable to set fish visual scenario ${JSON.stringify(setup)}`);
      await page.waitForTimeout(250);
      await page.evaluate((tile) => {
        window.__world.setZoom?.(0.48);
        window.__world.debugAimAtTile?.(tile);
      }, setup.site.tile);
      await page.waitForTimeout(250);
      await page.waitForFunction(({ slug, labelIncludes }) => {
        const proof = window.__world?.fishVisuals?.();
        const renderer = proof?.renderer;
        const row = renderer?.kilnFishSkinsBySlug?.[slug];
        const label = String(proof?.site?.school?.label ?? '').toLowerCase();
        return renderer?.slug === slug
          && (renderer?.active ?? 0) === 1
          && label.includes(labelIncludes)
          && (row?.loaded ?? 0) > 0
          && (row?.visibleAnchors ?? 0) > 0
          && (renderer?.glbAnchorsVisible ?? 0) > 0
          && (renderer?.pointSchoolSprites ?? 0) > 0
          && (renderer?.nearBoidSprites ?? 0) > 0
          && (renderer?.swimPathVisible ?? 0) === 1
          && (renderer?.swimPathBeads ?? 0) > 0
          && renderer?.motionBand === 'nearBoids'
          && renderer?.motionPolicy === 'two-glb-anchors-plus-near-only-analytic-boids-freeze-far'
          && (renderer?.kilnFishSkinsPending ?? 0) === 0
          && (renderer?.kilnFishSkinFallbacks ?? 0) === 0;
      }, scenario, { timeout: 60000 });
      await page.waitForTimeout(350);
      const proof = await page.evaluate(() => ({
        fishVisuals: window.__world.fishVisuals(),
        text: JSON.parse(window.render_game_to_text()),
      }));
      const screenshot = path.join(outDir, `${scenario.slug}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      const screenPoint = await page.evaluate(() => {
        const site = window.__world.fishVisuals()?.site;
        return site ? window.__world.screenPointForTile?.(site.tile) ?? null : null;
      });
      const focusScreenshot = path.join(outDir, `${scenario.slug}-focus.png`);
      const viewport = page.viewportSize() ?? { width: 1280, height: 820 };
      if (screenPoint?.visible && Number.isFinite(screenPoint.x) && Number.isFinite(screenPoint.y)) {
        const width = Math.min(420, viewport.width);
        const height = Math.min(300, viewport.height);
        await page.screenshot({
          path: focusScreenshot,
          clip: {
            x: clamp(screenPoint.x - width / 2, 0, Math.max(0, viewport.width - width)),
            y: clamp(screenPoint.y - height / 2, 0, Math.max(0, viewport.height - height)),
            width,
            height,
          },
        });
      } else {
        await page.screenshot({ path: focusScreenshot, fullPage: false });
      }
      const row = proof.fishVisuals.renderer.kilnFishSkinsBySlug[scenario.slug];
      const scenarioRequests = kilnRequests.filter((url) => url.includes(`${scenario.slug}.glb`));
      if (scenarioRequests.length < 1) throw new Error(`${scenario.slug}: no committed model request recorded`);
      if (scenarioRequests.some((url) => url.includes('/generated/'))) {
        throw new Error(`${scenario.slug}: generated asset request leaked ${JSON.stringify(scenarioRequests)}`);
      }
      results.push({
        slug: scenario.slug,
        setup,
        school: proof.fishVisuals.site.school,
        text: proof.text,
        renderer: {
          slug: proof.fishVisuals.renderer.slug,
          anchors: proof.fishVisuals.renderer.glbAnchorsVisible,
          points: proof.fishVisuals.renderer.pointSchoolSprites,
          nearBoids: proof.fishVisuals.renderer.nearBoidSprites,
          swimPathVisible: proof.fishVisuals.renderer.swimPathVisible,
          swimPathBeads: proof.fishVisuals.renderer.swimPathBeads,
          motionBand: proof.fishVisuals.renderer.motionBand,
          motionPolicy: proof.fishVisuals.renderer.motionPolicy,
          swimPathLength: proof.fishVisuals.renderer.swimPathLength,
          schoolSpread: proof.fishVisuals.renderer.schoolSpread,
          loaded: row?.loaded ?? 0,
          clips: row?.clips ?? [],
          activeMixers: row?.activeMixers ?? 0,
          lowRateMixers: row?.lowRateMixers ?? 0,
          fallback: row?.fallback ?? 0,
        },
        screenshot,
        focusScreenshot,
        screenPoint,
        requests: scenarioRequests,
      });
    }
    const generatedRequests = kilnRequests.filter((url) => url.includes('/generated/'));
    if (generatedRequests.length > 0) {
      throw new Error(`K9 fish proof leaked generated asset requests: ${JSON.stringify(generatedRequests)}`);
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`K9 fish proof had browser errors: ${JSON.stringify({ consoleErrors, pageErrors })}`);
    }

    const proof = {
      ok: true,
      scenarios: results,
      kilnRequests,
      generatedRequests,
      consoleErrors,
      pageErrors,
      note: 'Five-slug visual/provenance proof uses debug-set fish visual scenarios built from existing fishSchoolAt contexts; true live route reachability remains a separate gameplay proof.',
    };
    await fs.writeFile(path.join(outDir, 'proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify({
      ok: true,
      slugs: results.map((result) => result.slug),
      screenshots: results.map((result) => result.screenshot),
      focusScreenshots: results.map((result) => result.focusScreenshot),
      anchors: Object.fromEntries(results.map((result) => [result.slug, result.renderer.anchors])),
      points: Object.fromEntries(results.map((result) => [result.slug, result.renderer.points])),
      nearBoids: Object.fromEntries(results.map((result) => [result.slug, result.renderer.nearBoids])),
      swimPathBeads: Object.fromEntries(results.map((result) => [result.slug, result.renderer.swimPathBeads])),
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
