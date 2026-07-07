# Packs — Consistent Multi-Asset Sets

When you need several related assets that must look like ONE family (a biome's props, a creature
set, a building kit), generate a **pack** instead of many independent single assets. A pack plans
and runs all members under one manifest with a shared palette and toggles, which is what makes them
cohere. (Source: `kiln-studio/server/src/routes/v1.ts` pack routes; adapted from
`kiln-threejs-starter/scripts/kiln/generate-pack.ts`.)

## Manifest (`kiln.pack.v1`)
```json
{
  "schemaVersion": "kiln.pack.v1",
  "name": "Sphere Planet Forest Props",
  "sourceIntent": "coherent low-poly forest prop set for a voxel planet",
  "paletteId": "sphere-planet",
  "toggles": { "moreDetail": false, "optimizedPalette": true },
  "items": [
    { "name": "pine",    "prompt": "low-poly pine tree",       "category": "nature", "role": "prop", "count": 3 },
    { "name": "boulder", "prompt": "mossy granite boulder",    "category": "nature", "role": "prop", "count": 2 },
    { "name": "signpost","prompt": "wooden trail signpost",    "category": "prop",   "role": "prop", "count": 1 }
  ]
}
```
- Put `paletteId` (or `paletteConfig`) at the pack level so every member shares the game's colors.
- `count` fans out one generation per unit — budget accordingly (each unit spends).

## Flow
```
POST /v1/packs/validate  { manifest }            (no spend)          -> { ok, errors? }
POST /v1/packs           { manifest }                                -> { pack: { packId } }
POST /v1/packs/:id/run   {}                                          -> { generationIds: [...] }
GET  /v1/packs/:id                                (poll ~5s)         -> { members: [{ generationId, status }] }
POST /v1/packs/:id/download-url  { }   (or POST /v1/packs/:id/export)-> package / per-member GLBs
```
Poll until every member is `ok` or `failed`. Then download each member's GLB (same
`/v1/assets/:id/download-url` step as a single asset) or use the pack export.

## Scopes
Needs `packs:create packs:read packs:write packs:run packs:export` on the developer key, and the
pack "pro feature" gate must be open for the key's owner. A 402/403 on pack routes means one of those
is missing — ask the owner.

## When NOT to use a pack
For a single prop, or when iterating on look/prompt, use `kiln-generate-asset` (cheaper, faster
loop). Graduate to a pack once the style + palette are dialed in and you want the whole set at once.
