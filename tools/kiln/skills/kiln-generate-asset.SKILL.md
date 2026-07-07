---
name: kiln-generate-asset
description: Generate one Kiln game-ready 3D GLB asset for the sphere-planet voxel game through the Kiln Studio /v1 developer API, with a no-spend check first, a pinned palette for color consistency, safe artifact download, and GLB verification. Use when an agent needs to create a prop, creature, POI, structure, or decoration for the game.
---

# Kiln: Generate One Asset (sphere-planet drop-in)

Drives Kiln Studio's production `/v1` REST API to turn a text prompt into a downloadable GLB.
This kit is self-contained: raw `fetch`, no `@kiln/studio-sdk`, no Kiln monorepo. Adapted from
`kiln-threejs-starter/agent/skills/kiln-generate-asset/SKILL.md` and `scripts/kiln/generate-asset.ts`.

## When to use
- One GLB role at a time: a prop, creature/actor, point-of-interest, structure, vehicle, or VFX object.
- For a whole coherent SET (e.g. a biome's worth of props), prefer `kiln-generate-pack` — one pack
  run keeps roles, palette, and toggles consistent across every member.

## Prerequisites
- A `.env.local` next to `scripts/` containing `KILN_API_KEY=ks_live_...` (admin-issued PAT).
  See `knowledge/01-auth-and-keys.md`. If it is missing, STOP and tell the human to provision one
  (owner must `aws sso login --profile mkclouds` and run the Kiln provisioning script / Admin UI).
- Node 20+ (built-in `fetch`). No `npm install` required for this kit.

## Rules (hard constraints)
- Use ONLY `/v1`. Never touch `@kiln/engine`, runtime/composer internals, provider keys, S3, or DynamoDB.
- Run the no-spend capability check before spending. Generation costs money and meters against a
  per-key daily spend cap (default $5).
- Never print, commit, or persist the `ks_live_...` secret, presigned URLs, or SDK tarballs.
- Download only through the scoped `/v1/assets/:id/download-url` response; verify GLB magic is `glTF`.
- Write GLBs under the gitignored output root (`KILN_OUT_DIR`, default `public/assets/kiln/generated`).

## Workflow
1. **No-spend check:** `node scripts/capabilities.mjs` — confirms the token works and `/v1` is live.
2. **Pin the palette (once per project):** `node scripts/create-palette.mjs`, then set
   `KILN_PALETTE_ID=<returned id>` in `.env.local`. This is the color-consistency anchor
   (see `knowledge/03-palette-consistency.md`).
3. **Generate:** `node scripts/generate-asset.mjs "a mossy low-poly stone well"`
   - The script sets `optimizedPalette: true` and passes `paletteId` when `KILN_PALETTE_ID` is set.
   - Choose `KILN_ASSET_CATEGORY` / `KILN_ASSET_ROLE` per asset (prop, building, actor, poi, vehicle...).
4. It POSTs `/v1/generations` (202), polls `GET /v1/generations/:jobId` (~2s) to `succeeded`,
   POSTs `/v1/assets/:id/download-url`, downloads the GLB, verifies `glTF`, writes
   `model.glb` + `asset.json` under `KILN_OUT_DIR/<assetId>/`.
5. **Register in the game's asset manifest** rather than hardcoding the filename in gameplay code
   (see `knowledge/05-glb-voxel-integration.md`).
6. Preserve any sidecar metadata (scale, pivot, front axis, yaw offset, bounds, animation clips)
   before guessing at orientation/scale in the loader.

## Voxel fit
This game's terrain is voxel/blocks; Kiln outputs smooth GLB meshes. Best fit is **props, creatures,
POIs, structures, and decorations** — NOT terrain blocks. Keep the voxel terrain procedural; drop GLBs
on top as scene objects. See `knowledge/05-glb-voxel-integration.md`.
