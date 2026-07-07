// Wave 1 batch generation — the cleanest, highest-visibility asset swaps.
// Excludes the bush plane (the one keeper). Sequential, palette-locked, Gemini 3.5 Flash.
//
// Configs applied to EVERY asset:
//   modelId          google:gemini-3.5-flash   (Kiln's standout GLB model; = KILN_MODEL_ID override)
//   paletteId        sphere-planet             (saved 10-slot terrain palette)
//   optimizedPalette true                      (REQUIRED to hard-snap GLB colors to the palette)
//   moreDetail       true                      (spend geometry where it improves the read)
//   per-asset        category / role / tier    (from the asset inventory)
//
// Footprint: all Wave 1 structures sit on ONE hexagonal ground tile (~5.6 world-units
// flat-to-flat). Prompts frame each as a single free-standing object on one tile.
//
// Usage (Node 20+, from tools/kiln/):  node scripts/wave1-generate.mjs
// Output: <KILN_OUT_DIR>/<slug>/model.glb + asset.json  (slug-named for easy review)

import { resolve } from 'node:path';
import { downloadBytes, kilnJson, sleep, verifyGlb, writeWithin } from './http.mjs';

const MODEL_ID = process.env.KILN_MODEL_ID ?? 'google:gemini-3.5-flash';
const PALETTE_ID = process.env.KILN_PALETTE_ID ?? 'sphere-planet';
const OUT_ROOT = resolve(process.env.KILN_OUT_DIR ?? 'public/assets/kiln/generated');

// Shared style spine so the whole set reads as one art language.
const STYLE = 'stylized low-poly, flat-shaded faceted, soft rounded forms, warm desaturated survival palette, clean game-ready single object, sized to sit on one hexagonal ground tile';

const WAVE1 = [
  { slug: 'workbench', category: 'prop', role: 'building', tier: 'standard',
    prompt: `A rustic survival carpenter's workbench: thick weathered wooden top, a small iron vise, a tool block, four sturdy legs. ${STYLE}.` },
  { slug: 'chest', category: 'prop', role: 'prop', tier: 'standard',
    prompt: `A wooden survival storage chest with iron banding, a hinged domed lid, and a front latch, closed. ${STYLE}.` },
  { slug: 'campfire', category: 'prop', role: 'prop', tier: 'standard',
    prompt: `An unlit survival campfire: a ring of rounded river stones with a few charred crossed logs stacked in the center, no flames. ${STYLE}.` },
  { slug: 'door-kit', category: 'architecture', role: 'building', tier: 'standard',
    prompt: `A rustic wooden door set in a timber frame: two jamb posts, a lintel, a plank slab door, a small iron knob. ${STYLE}, modular building piece.` },
  { slug: 'window-frame', category: 'architecture', role: 'building', tier: 'standard',
    prompt: `A wooden framed window: timber sill and rails around a single translucent glass pane. ${STYLE}, modular building piece.` },
  { slug: 'roof-bundle', category: 'architecture', role: 'building', tier: 'standard',
    prompt: `A pitched roof section: two sloped thatch-and-timber planes meeting at a ridge beam. ${STYLE}, modular tiling building piece with a consistent footprint.` },
  { slug: 'dock-segment', category: 'architecture', role: 'building', tier: 'standard',
    prompt: `A short wooden dock segment on pilings: plank deck, two support stringers, four pilings, a simple rope handrail. ${STYLE}, weathered timber, modular.` },
];

console.log(`Wave 1: ${WAVE1.length} assets · model=${MODEL_ID} · palette=${PALETTE_ID} · optimizedPalette+moreDetail on`);
const results = [];

for (const [i, a] of WAVE1.entries()) {
  const tag = `[${i + 1}/${WAVE1.length}] ${a.slug}`;
  try {
    const assetSpec = {
      schemaVersion: 'kiln.asset.v1',
      name: a.slug,
      prompt: a.prompt,
      category: a.category,
      role: a.role,
      tier: a.tier,
      moreDetail: true,
      optimizedPalette: true,       // required to bake palette into the GLB
      paletteId: PALETTE_ID,
    };
    console.log(`${tag}: submitting (category=${a.category}, role=${a.role})`);
    const accepted = await kilnJson('/generations', {
      method: 'POST',
      body: { assetSpec, modelId: MODEL_ID, idempotencyKey: `wave1-${a.slug}-${Date.now()}` },
    });
    const job = await poll(accepted.jobId, tag);
    if (!job.asset) throw new Error('succeeded without asset payload');
    const urls = await kilnJson(`/assets/${encodeURIComponent(job.asset.assetId)}/download-url`, {
      method: 'POST', body: { includeProvenance: false },
    });
    const glb = await downloadBytes(urls.glb);
    verifyGlb(glb);
    writeWithin(OUT_ROOT, `${a.slug}/model.glb`, glb);
    writeWithin(OUT_ROOT, `${a.slug}/asset.json`, Buffer.from(JSON.stringify(job.asset, null, 2)));
    console.log(`${tag}: OK ${(glb.byteLength / 1024).toFixed(0)}KB -> ${a.slug}/model.glb`);
    results.push({ slug: a.slug, ok: true, assetId: job.asset.assetId, bytes: glb.byteLength });
  } catch (err) {
    console.error(`${tag}: FAILED - ${err.message}`);
    results.push({ slug: a.slug, ok: false, error: err.message });
  }
  if (i < WAVE1.length - 1) await sleep(3000 + Math.floor(Math.random() * 3000));
}

console.log('\n=== WAVE 1 SUMMARY ===');
for (const r of results) console.log(r.ok ? `  OK   ${r.slug} (${(r.bytes / 1024).toFixed(0)}KB)` : `  FAIL ${r.slug}: ${r.error}`);
const okc = results.filter((r) => r.ok).length;
console.log(`${okc}/${results.length} generated into ${OUT_ROOT}`);

async function poll(jobId, tag) {
  for (let i = 0; i < 180; i++) {
    const j = await kilnJson(`/generations/${encodeURIComponent(jobId)}`);
    if (j.status === 'succeeded') return j;
    if (j.status === 'failed') throw new Error(j.error ?? 'generation failed');
    await sleep(2000);
  }
  throw new Error(`${tag} timed out`);
}
