// Full catalog batch runner. Reads assets-catalog.json, generates every asset that
// doesn't already have a GLB (resumable), regenerates ones flagged `regen`, and skips
// ones flagged `done` that already exist. Palette-locked, Gemini 3.5 Flash.
//
// Robustness: 5s poll (avoids CloudFront WAF), kilnJson already retries edge blocks,
// per-asset jobId is remembered so a poll-blocked-but-server-succeeded generation is
// recovered at the end instead of lost. After every success the review manifest is
// rebuilt so the local viewer updates live on refresh.
//
// Usage (from tools/kiln/):  KILN_REVIEW_DIR=<dir> node scripts/batch.mjs
//   optional: node scripts/batch.mjs shrine creature   (only slugs containing those terms)

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadBytes, kilnJson, sleep, verifyGlb, writeWithin } from './http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(resolve(HERE, '../assets-catalog.json'), 'utf8'));
const MODEL_ID = process.env.KILN_MODEL_ID ?? CATALOG.model;
const PALETTE_ID = process.env.KILN_PALETTE_ID ?? CATALOG.palette;
const OUT_ROOT = resolve(process.env.KILN_OUT_DIR ?? 'public/assets/kiln/generated');
const REVIEW = process.env.KILN_REVIEW_DIR ? resolve(process.env.KILN_REVIEW_DIR) : null;
const POLL_MS = 8000;
const CONC = Number(process.env.KILN_CONC ?? 3);
const filters = process.argv.slice(2);

if (REVIEW) mkdirSync(resolve(REVIEW, 'models'), { recursive: true });

const assets = CATALOG.assets.filter((a) => !filters.length || filters.some((f) => a.slug.includes(f)));
console.log(`Catalog batch: ${assets.length} assets · model=${MODEL_ID} · palette=${PALETTE_ID}`);

const failed = [];   // { asset, jobId }
let ok = 0, skip = 0, fail = 0;

// Concurrency pool: CONC workers pull from a shared cursor (default 3, cap 6).
let cursor = 0;
async function processOne(a, i) {
  const tag = `[${i + 1}/${assets.length}] ${a.slug}`;
  const glbPath = resolve(OUT_ROOT, a.slug, 'model.glb');
  try {
    if (a.regen && existsSync(glbPath)) removeWithin(OUT_ROOT, a.slug);
    if (!a.regen && existsSync(glbPath)) {
      publish(a, glbPath); skip++; console.log(`${tag}: already present, kept`); return;
    }
    const prompt = `${a.prompt} ${CATALOG.styleSpine} ${CATALOG.footprints[a.footprint] ?? ''}`.trim();
    const assetSpec = {
      schemaVersion: 'kiln.asset.v1', name: a.slug, prompt,
      category: a.category, role: a.role, tier: a.tier ?? 'standard',
      moreDetail: true, optimizedPalette: true, paletteId: PALETTE_ID,
      ...(a.animate ? { includeAnimation: true, animationClips: a.animationClips ?? ['idle', 'walk'] } : {}),
    };
    console.log(`${tag}: submitting (${a.category}/${a.role})`);
    const accepted = await kilnJson('/generations', {
      method: 'POST', body: { assetSpec, modelId: MODEL_ID, idempotencyKey: `batch-${a.slug}-${Date.now()}` },
    });
    const job = await poll(accepted.jobId, tag);
    await finalize(a, job, glbPath);
    ok++; console.log(`${tag}: OK`);
  } catch (err) {
    fail++; console.error(`${tag}: FAILED - ${err.message}`);
    if (err.jobId) failed.push({ a, jobId: err.jobId });
  }
}
async function worker() {
  await sleep(Math.floor(Math.random() * 2500)); // stagger worker starts
  while (true) {
    const i = cursor++;
    if (i >= assets.length) return;
    await processOne(assets[i], i);
    await sleep(1500 + Math.floor(Math.random() * 2500)); // gentle spacing between submits
  }
}
console.log(`Concurrency: ${CONC} at a time`);
await Promise.all(Array.from({ length: Math.max(1, Math.min(6, CONC)) }, () => worker()));

// --- recovery pass: jobs that likely succeeded server-side but whose poll was blocked ---
if (failed.length) {
  console.log(`\n=== RECOVERY: ${failed.length} poll-blocked jobs ===`);
  for (const { a, jobId } of failed) {
    try {
      const job = await refetch(jobId, a.slug);
      if (job) { finalize(a, job, resolve(OUT_ROOT, a.slug, 'model.glb')); ok++; fail--; console.log(`  ${a.slug}: RECOVERED`); }
      else console.log(`  ${a.slug}: not recoverable (regenerate later)`);
    } catch (e) { console.error(`  ${a.slug}: recovery failed - ${e.message}`); }
    await sleep(4000);
  }
}

console.log(`\n=== DONE === generated ${ok}, kept ${skip}, failed ${fail}`);
if (REVIEW) console.log(`Review viewer manifest: ${resolve(REVIEW, 'manifest.json')} (refresh the page)`);

// ---------- helpers ----------
async function poll(jobId, tag) {
  for (let i = 0; i < 150; i++) {
    let j;
    try { j = await kilnJson(`/generations/${encodeURIComponent(jobId)}`); }
    catch (e) { const err = new Error(`poll blocked: ${e.message.slice(0, 60)}`); err.jobId = jobId; throw err; }
    if (j.status === 'succeeded') return j;
    if (j.status === 'failed') throw new Error(j.error ?? 'generation failed');
    await sleep(POLL_MS + Math.floor(Math.random() * 3000));
  }
  const err = new Error(`${tag} timed out`); err.jobId = jobId; throw err;
}

async function refetch(jobId, slug) {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await kilnJson(`/generations/${encodeURIComponent(jobId)}`);
      if (j.status === 'succeeded') return j;
      if (j.status === 'failed') return null;
    } catch { /* edge block, keep waiting */ }
    await sleep(POLL_MS + Math.floor(Math.random() * 3000));
  }
  return null;
}

async function finalize(a, job, glbPath) {
  if (!job.asset) throw new Error('succeeded without asset payload');
  const urls = await kilnJson(`/assets/${encodeURIComponent(job.asset.assetId)}/download-url`, {
    method: 'POST', body: { includeProvenance: false },
  });
  const glb = await downloadBytes(urls.glb);
  verifyGlb(glb);
  writeWithin(OUT_ROOT, `${a.slug}/model.glb`, glb);
  writeWithin(OUT_ROOT, `${a.slug}/asset.json`, Buffer.from(JSON.stringify(job.asset, null, 2)));
  publish(a, glbPath);
}

function publish(a, glbPath) {
  if (!REVIEW || !existsSync(glbPath)) return;
  copyFileSync(glbPath, resolve(REVIEW, 'models', `${a.slug}.glb`));
  rebuildManifest();
}

function rebuildManifest() {
  const entries = [];
  for (const a of CATALOG.assets) {
    const p = resolve(REVIEW, 'models', `${a.slug}.glb`);
    if (!existsSync(p)) continue;
    entries.push({ slug: a.slug, title: a.title, category: a.category, role: a.role, bytes: statSync(p).size, path: `models/${a.slug}.glb` });
  }
  writeFileSync(resolve(REVIEW, 'manifest.json'),
    JSON.stringify({ model: MODEL_ID, palette: PALETTE_ID, assets: entries }, null, 0));
}

function removeWithin(root, relPath) {
  if (!relPath.trim() || isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`unsafe delete path ${relPath}`);
  }
  const outRoot = resolve(root);
  const target = resolve(outRoot, relPath);
  const rel = relative(outRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`delete path escapes output root: ${relPath}`);
  rmSync(target, { recursive: true, force: true });
}
