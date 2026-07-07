import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
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
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'output', 'playwright', 'audio-music');
const requestedPort = Number(process.env.PROOF_PORT || 0);
const subpathPrefix = '/goldberg-planet/';

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

function proofUrl(base, touch = false) {
  const url = new URL(base);
  url.searchParams.set('nosave', '1');
  url.searchParams.set('resetSave', '1');
  url.searchParams.set('creative', '1');
  url.searchParams.set('debug', '1');
  url.searchParams.set('seed', 'audio-proof');
  url.searchParams.set('skyq', 'low');
  if (touch) url.searchParams.set('touch', '1');
  return url.toString();
}

function startDevServer(port) {
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

async function stopProcess(child) {
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

async function startStaticSubpathServer(port) {
  const server = http.createServer((req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (!requestUrl.pathname.startsWith(subpathPrefix)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      let requestPath = decodeURIComponent(requestUrl.pathname.slice(subpathPrefix.length));
      if (!requestPath || requestPath.endsWith('/')) requestPath += 'index.html';
      let file = path.resolve(distDir, requestPath);
      if (!file.startsWith(distDir)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) {
        file = path.join(distDir, 'index.html');
      }
      serveFile(req, res, file);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function serveFile(req, res, file) {
  const stat = statSync(file);
  const headers = {
    'content-type': contentType(file),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < stat.size) {
        res.writeHead(206, {
          ...headers,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${stat.size}`,
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, { ...headers, 'content-length': String(stat.size) });
  createReadStream(file).pipe(res);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function canvasPixelProbe(page) {
  return page.evaluate(() => {
    const source = document.querySelector('canvas');
    if (!source) return { ok: false, reason: 'missing canvas', samples: 0, unique: 0 };
    const probe = document.createElement('canvas');
    probe.width = 24;
    probe.height = 24;
    const ctx = probe.getContext('2d');
    if (!ctx) return { ok: false, reason: 'missing 2d context', samples: 0, unique: 0 };
    ctx.drawImage(source, 0, 0, probe.width, probe.height);
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set();
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 20) {
        opaque++;
        colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
      }
    }
    return { ok: opaque > 16 && colors.size > 3, samples: opaque, unique: colors.size };
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
      colorType = data[9];
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height || (colorType !== 2 && colorType !== 6) || chunks.length === 0) {
    return { ok: false, reason: `unsupported png ${width}x${height} color ${colorType}`, samples: 0, unique: 0 };
  }
  const inflated = zlib.inflateSync(Buffer.concat(chunks));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  let src = 0;
  let prev = Buffer.alloc(stride);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = Buffer.from(inflated.subarray(src, src + stride));
    src += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= bpp ? prev[x - bpp] ?? 0 : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 255;
    }
    rows.push(row);
    prev = row;
  }
  const colors = new Set();
  let samples = 0;
  const stepY = Math.max(1, Math.floor(height / 18));
  const stepX = Math.max(1, Math.floor(width / 18));
  for (let y = 0; y < height; y += stepY) {
    const row = rows[y];
    if (!row) continue;
    for (let x = 0; x < width; x += stepX) {
      const i = x * bpp;
      if (colorType === 2 || (row[i + 3] ?? 0) > 20) {
        samples++;
        colors.add(`${(row[i] ?? 0) >> 4},${(row[i + 1] ?? 0) >> 4},${(row[i + 2] ?? 0) >> 4}`);
      }
    }
  }
  return { ok: samples > 16 && colors.size > 4, samples, unique: colors.size };
}

async function runAudioProfile(browser, target, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    isMobile: profile.touch,
    hasTouch: profile.touch,
    deviceScaleFactor: profile.touch ? 2 : 1,
  });
  const page = await context.newPage();
  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  const audioResponses = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (!url.pathname.includes('/audio/')) return;
    audioResponses.push({ url: res.url(), status: res.status() });
    if (res.status() >= 400) failures.push(`audio request failed ${res.status()} ${res.url()}`);
  });

  const url = proofUrl(target.baseUrl, profile.touch);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__world?.audio), null, { timeout: 45000 });
  await page.waitForTimeout(500);

  if (profile.touch) {
    await page.touchscreen.tap(Math.floor(profile.viewport.width / 2), Math.floor(profile.viewport.height / 2));
  } else {
    await page.mouse.click(Math.floor(profile.viewport.width / 2), Math.floor(profile.viewport.height / 2));
  }

  await page.waitForFunction(() => {
    const audio = window.__world?.audio?.();
    return Boolean(audio?.supported && audio?.unlocked && audio?.contextState === 'running');
  }, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const audio = window.__world?.audio?.();
    return Boolean(
      audio?.musicStarted &&
      audio?.musicTrackCount === 14 &&
      audio?.musicTrackId &&
      audio?.musicTrack &&
      audio?.ambiencePlaying &&
      audio?.loaded?.includes('planetWindLoop'),
    );
  }, null, { timeout: 20000 });
  await page.waitForTimeout(750);

  const initialAudio = await page.evaluate(() => window.__world.audio());
  if (initialAudio.failed.length > 0) failures.push(`audio decode failures: ${initialAudio.failed.join(', ')}`);
  if (initialAudio.errors.length > 0) failures.push(`audio diagnostic errors: ${initialAudio.errors.join(' | ')}`);
  if (!initialAudio.musicPlaying) failures.push('music should be playing after unlock');

  await page.waitForFunction(() => {
    return performance.getEntriesByType('resource').some((entry) => entry.name.includes('/audio/music/') || entry.name.includes('audio/music/'));
  }, null, { timeout: 10000 }).catch(() => failures.push('no music resource request observed'));

  if (!audioResponses.some((res) => res.url.includes('/audio/music/') && (res.status === 200 || res.status === 206))) {
    failures.push('no successful streamed music response observed');
  }
  if (target.expectSubpathAudio) {
    const rootAudio = audioResponses.filter((res) => new URL(res.url).pathname.startsWith('/audio/'));
    if (rootAudio.length > 0) failures.push(`production subpath made root audio requests: ${rootAudio.map((res) => res.url).join(', ')}`);
    const subpathAudio = audioResponses.filter((res) => new URL(res.url).pathname.startsWith(`${subpathPrefix}audio/`));
    if (subpathAudio.length === 0) failures.push('production subpath did not request audio below /goldberg-planet/audio/');
  }

  await page.evaluate(() => window.__world.toggleMute());
  await page.waitForFunction(() => {
    const audio = window.__world.audio();
    return audio.muted && !audio.musicPlaying;
  }, null, { timeout: 10000 });
  const mutedAudio = await page.evaluate(() => window.__world.audio());

  await page.evaluate(() => window.__world.toggleMute());
  await page.waitForFunction(() => {
    const audio = window.__world.audio();
    return !audio.muted && audio.musicPlaying;
  }, null, { timeout: 10000 });
  const resumedAudio = await page.evaluate(() => window.__world.audio());

  const canvasProbe = await canvasPixelProbe(page).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err), samples: 0, unique: 0 }));

  const screenshotPath = path.join(outDir, `${target.name}-${profile.name}.png`);
  const screenshotBuffer = await page.screenshot({ path: screenshotPath, fullPage: false });
  const screenshotProbe = pngPixelProbe(screenshotBuffer);
  if (!screenshotProbe.ok) failures.push(`screenshot pixel probe failed: ${screenshotProbe.reason ?? 'low variance'}`);

  if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(' | ')}`);
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join(' | ')}`);

  await context.close();

  return {
    target: target.name,
    profile: profile.name,
    url,
    screenshot: path.relative(root, screenshotPath).replaceAll(path.sep, '/'),
    initialAudio,
    mutedAudio,
    resumedAudio,
    canvasProbe,
    screenshotProbe,
    audioResponses,
    consoleErrors,
    pageErrors,
    failures,
  };
}

async function runTarget(playwright, target) {
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const profiles = [
      { name: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
      { name: 'phone-touch', viewport: { width: 390, height: 844 }, touch: true },
    ];
    const results = [];
    for (const profile of profiles) results.push(await runAudioProfile(browser, target, profile));
    return results;
  } finally {
    await browser.close();
  }
}

async function main() {
  const playwright = loadPlaywright();
  await fs.mkdir(outDir, { recursive: true });
  const proof = {
    generatedAt: new Date().toISOString(),
    status: 'pass',
    targets: [],
    skipped: [],
    failures: [],
  };

  const devPort = await getFreePort();
  const devServer = startDevServer(devPort);
  try {
    const devBaseUrl = process.env.PROOF_URL || `http://127.0.0.1:${devPort}/`;
    await waitForServer(devBaseUrl);
    const target = { name: 'dev-root', baseUrl: devBaseUrl, expectSubpathAudio: false };
    proof.targets.push(...await runTarget(playwright, target));
  } finally {
    await stopProcess(devServer);
  }

  if (existsSync(path.join(distDir, 'index.html'))) {
    const staticPort = await getFreePort();
    const staticServer = await startStaticSubpathServer(staticPort);
    try {
      const staticBaseUrl = `http://127.0.0.1:${staticPort}${subpathPrefix}`;
      await waitForServer(staticBaseUrl);
      const target = { name: 'dist-subpath', baseUrl: staticBaseUrl, expectSubpathAudio: true };
      proof.targets.push(...await runTarget(playwright, target));
    } finally {
      await new Promise((resolve) => staticServer.close(resolve));
    }
  } else {
    proof.skipped.push('dist-subpath: dist/index.html missing; run npm run build before full production-subpath proof');
  }

  for (const result of proof.targets) {
    proof.failures.push(...result.failures.map((message) => `${result.target}/${result.profile}: ${message}`));
  }
  proof.status = proof.failures.length === 0 ? 'pass' : 'fail';
  const proofPath = path.join(outDir, 'proof.json');
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);

  if (proof.failures.length > 0) {
    console.error(`Audio music proof failed; wrote ${path.relative(root, proofPath)}`);
    for (const failure of proof.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`Audio music proof passed; wrote ${path.relative(root, proofPath)}`);
  for (const result of proof.targets) {
    console.log(`${result.target}/${result.profile}: ${result.initialAudio.musicTrack} (${result.initialAudio.musicTrackId})`);
  }
  if (proof.skipped.length > 0) {
    for (const skipped of proof.skipped) console.log(`Skipped: ${skipped}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
