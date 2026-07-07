# Palette Consistency (the key to a coherent voxel game)

The single biggest lever for "everything looks like one game" is pinning the SAME palette on every
generation. Kiln gives three composable knobs (source: `kiln-studio/server/src/routes/v1.ts` `Body`
schema + `shared/manifest-schemas.ts`):

## 1. `optimizedPalette: true`  (always on for this game)
Quantizes each asset to a small, clean palette instead of noisy free-form color. Gives the
flat, low-poly, voxel-adjacent look. Cheap default; set on every asset and pack.

## 2. `paletteId: "sphere-planet"`  (the consistency anchor)
Reference a **saved palette** so every asset draws from the SAME fixed hex colors.
- Register it once: `node scripts/create-palette.mjs` (reads `palette.sphere-planet.json`,
  POSTs `/v1/palettes`, prints the server `paletteId`).
- Then set `KILN_PALETTE_ID=<paletteId>` in `.env.local` — `generate-asset.mjs` passes it on every job.
- Palette slot shape: `{ name, color: "#rrggbb", kind?: opaque|glass|glow, metalness?, roughness?,
  opacity?, use? }`. Max slots enforced server-side (`MAX_PALETTE_SLOTS`).

## 3. `paletteConfig: { name, slots: [...] }`  (inline alternative)
Same colors passed inline instead of by id — useful for one-offs without registering a palette.

## The sphere-planet palette (this game's real colors)
From `palette.sphere-planet.json`:

| slot        | hex       | use |
|-------------|-----------|-----|
| grass       | `#6fae4e` | vegetation, ground cover |
| dirt        | `#8a6242` | soil, paths |
| rock        | `#7d7f85` | stone, cliffs, walls |
| sand        | `#d8c48a` | beaches, deserts |
| snow        | `#eef2f5` | snow caps, bright accents |
| wood        | `#a8763f` | trunks, planks, structures |
| stone-dark  | `#4f5257` | shadowed rock, iron |
| foliage     | `#4c7a34` | darker leaves, canopy |
| water       | `#3f7fae` | water (glass, opacity 0.7) |
| glow        | `#ffcf6b` | markers, lanterns, emissive |

The first six are the game's canonical terrain hexes (provided by the owner); the last four are
sensible on-palette extras so props/creatures don't drift off the terrain's color language.

## Recipe
1. `node scripts/create-palette.mjs` -> copy the printed `paletteId` into `.env.local` as `KILN_PALETTE_ID`.
2. Generate every asset with `optimizedPalette: true` + that `paletteId` (the script does both).
3. For a coherent multi-asset set, put `paletteId` at the **pack** level (see packs doc) so the whole
   set shares it in one run.
4. Optionally add a `seed` (integer) on `assetSpec` for reproducible regeneration.

## Prompt discipline (reinforces the palette)
Keep a consistent style phrase in prompts, e.g. "low-poly, flat-shaded, chunky, matte" and name the
material by palette slot ("mossy grass-green top, brown wood trunk"). The palette clamps color; the
prompt clamps form and finish.
