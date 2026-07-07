// Register the sphere-planet palette in Kiln so every generation can pin the same colors.
// Uses POST /v1/palettes (scope: palettes:write) and reports the server-assigned paletteId.
//
// Palette slot shape (from kiln-studio/shared/manifest-schemas.ts -> PaletteSlotSchema):
//   { name, color: "#rrggbb", kind?: opaque|glass|glow, metalness?, roughness?, opacity?, use? }
// Create body (kiln-studio/server/src/routes/v1.ts -> PaletteCreateZ):
//   { name: string, slots?: PaletteSlot[], fromPreset?: string }   // server assigns the paletteId
//
// Usage (Node 20+):
//   node scripts/create-palette.mjs                 # reads ../palette.sphere-planet.json
//   node scripts/create-palette.mjs path/to/palette.json
//
// After it prints a paletteId, generate with pinned colors:
//   KILN_PALETTE_ID=<paletteId> node scripts/generate-asset.mjs "wooden signpost"

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kilnJson } from './http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(here, '..', 'palette.sphere-planet.json');

const palette = JSON.parse(readFileSync(file, 'utf8'));
const name = palette.name ?? palette.id ?? 'sphere-planet';
const slots = palette.slots;
if (!Array.isArray(slots) || slots.length === 0) throw new Error('palette needs a non-empty "slots" array');

console.log(`> registering palette "${name}" (${slots.length} slots) from ${file}`);

// If a palette with this name already exists you'll get a 409 — list and reuse instead.
let created;
try {
  created = await kilnJson('/palettes', { method: 'POST', body: { name, slots } });
} catch (err) {
  if (String(err).includes(' 409')) {
    console.log('> a palette with this name already exists; listing existing palettes...');
    const list = await kilnJson('/palettes'); // scope: palettes:read
    const match = (list.palettes ?? []).find((p) => p.name === name);
    if (match) {
      console.log(`> reuse existing paletteId: ${match.paletteId}`);
      console.log(`\nUse it with:  KILN_PALETTE_ID=${match.paletteId} node scripts/generate-asset.mjs "<prompt>"`);
      process.exit(0);
    }
  }
  throw err;
}

const rec = created.palette ?? created;
const paletteId = rec.paletteId ?? rec.id;
console.log('> created:', JSON.stringify(rec, null, 2));
console.log(`\nDone. paletteId = ${paletteId}`);
console.log(`Use it with:  KILN_PALETTE_ID=${paletteId} node scripts/generate-asset.mjs "<prompt>"`);
console.log('Tip: also set KILN_PALETTE_ID in your .env.local so every generation pins these colors.');
