---
name: kiln-generate-pack
description: Generate a themed multi-asset Kiln pack (a coherent set of GLBs sharing one palette and style) for the sphere-planet voxel game via the Kiln Studio /v1 API. Use when you need several related assets that must look like one family — e.g. a biome prop set, a creature family, or a structure kit.
---

# Kiln: Generate an Asset Pack (sphere-planet drop-in)

A pack is the right primitive when you want CONSISTENCY across many assets: all members are planned
and generated under one manifest with a shared palette and toggles, so they read as one set. Adapted
from `kiln-threejs-starter/agent/skills/kiln-generate-pack/SKILL.md` and `scripts/kiln/generate-pack.ts`.

## Prerequisites
- Same as `kiln-generate-asset`: `.env.local` with `KILN_API_KEY=ks_live_...`, Node 20+.
- The developer key needs pack scopes (`packs:create packs:read packs:write packs:run packs:export`).
  The starter provisioning grants these by default; if pack calls 402/403, the key lacks the scope or
  the pack pro-feature gate is closed — ask the owner.
- Packs cost more than a single asset (one generation per member). Mind the daily spend cap.

## Endpoint flow (async; see knowledge/04-packs-for-consistent-sets.md)
1. `POST /v1/packs/validate  { manifest }`  — no-spend validation of the pack manifest.
2. `POST /v1/packs           { manifest }`  — create; returns `{ pack: { packId } }`.
3. `POST /v1/packs/:id/run   {}`            — queues one generation per member; returns `generationIds`.
4. `GET  /v1/packs/:id`                      — poll until every member is `ok` or `failed`.
5. `POST /v1/packs/:id/download-url` (or `/export`) — get the package / per-member GLBs.

## Manifest shape (`kiln.pack.v1`)
```json
{
  "schemaVersion": "kiln.pack.v1",
  "name": "Sphere Planet Forest Props",
  "sourceIntent": "coherent low-poly forest prop set for a voxel planet",
  "paletteId": "sphere-planet",
  "toggles": { "moreDetail": false, "optimizedPalette": true },
  "items": [
    { "name": "pine",   "prompt": "low-poly pine tree",        "category": "nature", "role": "prop", "count": 3 },
    { "name": "boulder","prompt": "mossy granite boulder",     "category": "nature", "role": "prop", "count": 2 },
    { "name": "signpost","prompt": "wooden trail signpost",    "category": "prop",   "role": "prop", "count": 1 }
  ]
}
```
Set `paletteId` (or `paletteConfig`) at the pack level so every member shares the sphere-planet colors.

## Rules
- `/v1` only. Runtime owns terrain/paths/colliders; generated meshes are decorative or actor-facing.
- Validate before spend. Keep counts modest first; scale up once the look is confirmed.
- Import members into the game's asset manifest; never hardcode generated filenames in gameplay code.
- Never commit secrets, presigned URLs, or generated packages.
