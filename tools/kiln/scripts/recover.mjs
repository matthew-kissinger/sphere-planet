// Recover Wave 1 assets whose generation succeeded server-side but whose POLL got
// CloudFront-blocked. Tries the known jobId first; only regenerates if truly missing.
// Gentle poll (5s) to avoid re-tripping the edge WAF.

import { resolve } from 'node:path';
import { downloadBytes, kilnJson, sleep, verifyGlb, writeWithin } from './http.mjs';

const MODEL_ID = process.env.KILN_MODEL_ID ?? 'google:gemini-3.5-flash';
const PALETTE_ID = process.env.KILN_PALETTE_ID ?? 'sphere-planet';
const OUT_ROOT = resolve(process.env.KILN_OUT_DIR ?? 'public/assets/kiln/generated');
const STYLE = 'stylized low-poly, flat-shaded faceted, soft rounded forms, warm desaturated survival palette, clean game-ready single object, sized to sit on one hexagonal ground tile';

// Failed jobs from the Wave 1 run + their specs (for regenerate fallback).
const FAILED = [
  { slug: 'chest', jobId: '25c23e86-8210-445b-b188-b7499fa9b623', category: 'prop', role: 'prop',
    prompt: `A wooden survival storage chest with iron banding, a hinged domed lid, and a front latch, closed. ${STYLE}.` },
  { slug: 'door-kit', jobId: 'c4450dea-f452-4ac9-9453-18948976d4cd', category: 'architecture', role: 'building',
    prompt: `A rustic wooden door set in a timber frame: two jamb posts, a lintel, a plank slab door, a small iron knob. ${STYLE}, modular building piece.` },
];

for (const a of FAILED) {
  try {
    let job = await tryFetch(a.jobId, a.slug);
    if (!job) {
      console.log(`  ${a.slug}: prior job unrecoverable -> regenerating`);
      job = await regenerate(a);
    }
    if (!job?.asset) throw new Error('no asset payload');
    const urls = await kilnJson(`/assets/${encodeURIComponent(job.asset.assetId)}/download-url`, {
      method: 'POST', body: { includeProvenance: false },
    });
    const glb = await downloadBytes(urls.glb);
    verifyGlb(glb);
    writeWithin(OUT_ROOT, `${a.slug}/model.glb`, glb);
    writeWithin(OUT_ROOT, `${a.slug}/asset.json`, Buffer.from(JSON.stringify(job.asset, null, 2)));
    console.log(`  ${a.slug}: RECOVERED ${(glb.byteLength / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`  ${a.slug}: FAILED - ${err.message}`);
  }
  await sleep(4000);
}

async function tryFetch(jobId, slug) {
  // Poll the existing job a few times; it may already be terminal.
  for (let i = 0; i < 30; i++) {
    try {
      const j = await kilnJson(`/generations/${encodeURIComponent(jobId)}`);
      if (j.status === 'succeeded') { console.log(`  ${slug}: prior job already succeeded`); return j; }
      if (j.status === 'failed') { console.log(`  ${slug}: prior job failed server-side`); return null; }
      console.log(`  ${slug}: prior job ${j.status}...`);
    } catch (e) {
      console.log(`  ${slug}: fetch blocked, waiting (${e.message.slice(0, 40)})`);
    }
    await sleep(5000);
  }
  return null;
}

async function regenerate(a) {
  const assetSpec = {
    schemaVersion: 'kiln.asset.v1', name: a.slug, prompt: a.prompt,
    category: a.category, role: a.role, tier: 'standard',
    moreDetail: true, optimizedPalette: true, paletteId: PALETTE_ID,
  };
  const accepted = await kilnJson('/generations', {
    method: 'POST', body: { assetSpec, modelId: MODEL_ID, idempotencyKey: `recover-${a.slug}-${Date.now()}` },
  });
  for (let i = 0; i < 120; i++) {
    const j = await kilnJson(`/generations/${encodeURIComponent(accepted.jobId)}`);
    if (j.status === 'succeeded') return j;
    if (j.status === 'failed') throw new Error(j.error ?? 'generation failed');
    await sleep(5000);
  }
  throw new Error('regenerate timed out');
}
