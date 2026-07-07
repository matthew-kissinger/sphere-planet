// Promote reviewed (status:ready) GLBs out of the gitignored `generated/` quarantine into
// the committed runtime path `public/assets/kiln/models/<slug>.glb`, following the repo's
// "move curated runtime assets to a committed path after proof" convention (see root .gitignore
// and the audio proof-gate pattern). Copies only assets NOT flagged `unused` in the catalog,
// then rewrites ASSET_MANIFEST.json `file` fields to the committed models/ path.
//
// Usage (from tools/kiln/):  node scripts/promote.mjs   (run build-manifest.mjs first)

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(resolve(HERE, '../assets-catalog.json'), 'utf8'));
const ROOT = resolve(HERE, '../../../public/assets/kiln');
const GEN = resolve(ROOT, 'generated');
const MODELS = resolve(ROOT, 'models');
const MANIFEST = resolve(ROOT, 'ASSET_MANIFEST.json');

function assertGlb(file, slug) {
  const bytes = readFileSync(file);
  if (bytes.length < 12) throw new Error(`${slug}: ${file} is too small to be a GLB`);
  const magic = bytes.toString('ascii', 0, 4);
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (magic !== 'glTF') throw new Error(`${slug}: ${file} has GLB magic ${JSON.stringify(magic)}, expected glTF`);
  if (version !== 2) throw new Error(`${slug}: ${file} is GLB version ${version}, expected 2`);
  if (declaredLength !== bytes.length) throw new Error(`${slug}: ${file} declares ${declaredLength} bytes but is ${bytes.length}`);
}

const plan = [];
let skipped = 0;
for (const a of CATALOG.assets) {
  if (a.unused) {
    skipped++;
    continue;
  }
  const src = resolve(GEN, a.slug, 'model.glb');
  if (!existsSync(src)) throw new Error(`${a.slug}: no GLB in generated/; run the raw proof and regenerate before promotion`);
  assertGlb(src, a.slug);
  plan.push({ slug: a.slug, src, dst: resolve(MODELS, `${a.slug}.glb`) });
}

// clean models/ so removed/renamed assets don't linger
if (existsSync(MODELS)) for (const f of readdirSync(MODELS)) rmSync(resolve(MODELS, f), { force: true });
mkdirSync(MODELS, { recursive: true });

let promoted = 0;
for (const asset of plan) {
  copyFileSync(asset.src, asset.dst);
  promoted++;
}

// repoint manifest file paths at the committed models/ path
if (existsSync(MANIFEST)) {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const rec of m.assets) {
    rec.source = `generated/${rec.slug}/model.glb (gitignored raw drop)`;
    rec.file = rec.status === 'ready' ? `models/${rec.slug}.glb` : null;
  }
  m.runtimePath = 'public/assets/kiln/models/<slug>.glb (committed). Raw drops stay in generated/ (gitignored).';
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

console.log(`Promoted ${promoted} ready GLBs to models/, skipped ${skipped} (unused/missing).`);
