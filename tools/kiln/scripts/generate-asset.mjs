// Generate ONE Kiln 3D asset from a text prompt and download the GLB.
// Adapted from kiln-threejs-starter/scripts/kiln/generate-asset.ts (raw fetch, no SDK).
//
// Flow (async 202 + poll contract):
//   POST /v1/generations           -> { jobId, status: 'queued' }
//   GET  /v1/generations/:jobId     -> poll until status 'succeeded' (embeds .asset.assetId)
//   POST /v1/assets/:id/download-url -> { glb: <presigned url> }
//   GET  <glb url>                  -> raw GLB bytes
//
// Usage (Node 20+, no install):
//   node scripts/generate-asset.mjs "a mossy low-poly stone well"
//   KILN_ASSET_PROMPT="rusty treasure chest" node scripts/generate-asset.mjs
//
// Optional env:
//   KILN_ASSET_CATEGORY   default "prop"   (prop | architecture | vfx | character | vehicle | nature ...)
//   KILN_ASSET_ROLE       default "prop"   (prop | building | actor | poi | vehicle ...)
//   KILN_PALETTE_ID       e.g. "sphere-planet" — reuse a saved palette for consistent color
//   KILN_OUT_DIR          default "public/assets/kiln/generated"

import { resolve } from 'node:path';
import { downloadBytes, kilnJson, sleep, verifyGlb, writeWithin } from './http.mjs';

const prompt = process.argv.slice(2).join(' ').trim()
  || process.env.KILN_ASSET_PROMPT
  || 'low-poly brass key for a locked gate';
const category = process.env.KILN_ASSET_CATEGORY ?? 'prop';
const role = process.env.KILN_ASSET_ROLE ?? 'prop';
const paletteId = process.env.KILN_PALETTE_ID; // optional consistency anchor
const outRoot = resolve(process.env.KILN_OUT_DIR ?? 'public/assets/kiln/generated');

const assetSpec = {
  schemaVersion: 'kiln.asset.v1',
  name: `dropin-${Date.now()}`,
  prompt,
  category,
  role,
  optimizedPalette: true,           // quantize to a small clean palette (good voxel-adjacent look)
  ...(paletteId ? { paletteId } : {}), // pin saved-palette colors when provided
};

console.log(`> generating: "${prompt}" (category=${category}, role=${role}${paletteId ? `, paletteId=${paletteId}` : ''})`);

const accepted = await kilnJson('/generations', {
  method: 'POST',
  body: { assetSpec, idempotencyKey: `dropin-asset-${Date.now()}` },
});
console.log(`> accepted job ${accepted.jobId}`);

const job = await pollGeneration(accepted.jobId);
if (!job.asset) throw new Error('generation succeeded without an asset payload');
console.log(`> asset ${job.asset.assetId}`);

const urls = await kilnJson(`/assets/${encodeURIComponent(job.asset.assetId)}/download-url`, {
  method: 'POST',
  body: { includeProvenance: false },
});
const glb = await downloadBytes(urls.glb);
verifyGlb(glb);

const dir = sanitize(job.asset.assetId);
const modelPath = writeWithin(outRoot, `${dir}/model.glb`, glb);
writeWithin(outRoot, `${dir}/asset.json`, Buffer.from(JSON.stringify(job.asset, null, 2)));

console.log(JSON.stringify({ ok: true, assetId: job.asset.assetId, prompt, modelPath, bytes: glb.byteLength }, null, 2));

async function pollGeneration(jobId) {
  for (let i = 0; i < 180; i++) {
    const j = await kilnJson(`/generations/${encodeURIComponent(jobId)}`);
    console.log(`  ${j.status} ${jobId}`);
    if (j.status === 'succeeded') return j;
    if (j.status === 'failed') throw new Error(j.error ?? 'generation failed');
    await sleep(2000);
  }
  throw new Error(`generation ${jobId} timed out`);
}

function sanitize(v) {
  return v.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
}
