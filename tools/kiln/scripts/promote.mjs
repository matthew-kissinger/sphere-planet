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

// clean models/ so removed/renamed assets don't linger
if (existsSync(MODELS)) for (const f of readdirSync(MODELS)) rmSync(resolve(MODELS, f), { force: true });
mkdirSync(MODELS, { recursive: true });

let promoted = 0, skipped = 0;
for (const a of CATALOG.assets) {
  const src = resolve(GEN, a.slug, 'model.glb');
  if (a.unused) { skipped++; continue; }
  if (!existsSync(src)) { console.warn(`  ! ${a.slug}: no GLB in generated/, skipped`); skipped++; continue; }
  copyFileSync(src, resolve(MODELS, `${a.slug}.glb`));
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
