# GLB vs Voxel — What Kiln Is Good For Here

## The mismatch (read this first)
- **This game (sphere-planet / goldberg-planet) is voxel/block terrain.** Terrain is procedural
  blocks, authored in code, and owns collision, paths, and the ground surface.
- **Kiln outputs smooth GLB meshes** (glTF binary), not voxel/block data. You cannot feed a Kiln GLB
  in as a terrain block, a chunk, or a greedy-meshed voxel face.

## Where Kiln fits (the good fit)
Use Kiln GLBs as **scene objects placed on top of the voxel world**:
- **Props / decorations:** trees, rocks, crates, signposts, lanterns, fences, wells, ruins.
- **Creatures / actors:** animals, enemies, NPCs (request animation clips when needed).
- **Points of interest / structures:** shrines, huts, gates, towers, markers (`role: poi`/`building`).
- **VFX objects:** glowing markers, portals (use the `glow` palette slot).

Do NOT try to generate: terrain blocks, chunks, the planet surface, tileable ground, or anything the
voxel meshing owns. Keep terrain procedural; drop GLBs as `THREE.Object3D`s at world positions.

## Integration pattern (Vite + TS + three.js)
1. `generate-asset.mjs` writes `KILN_OUT_DIR/<assetId>/model.glb` + `asset.json`.
   Point `KILN_OUT_DIR` at something under the game's `public/` (e.g. `public/assets/kiln/generated`)
   so Vite serves it and `GLTFLoader` can fetch it by URL.
2. Register the asset in a small **manifest** the game reads at runtime (don't hardcode generated
   filenames in gameplay code). Example entry:
   ```json
   { "id": "<assetId>", "label": "stone well", "role": "prop",
     "url": "/assets/kiln/generated/<assetId>/model.glb",
     "scale": 1, "position": [0, 0, 0] }
   ```
3. Load with `GLTFLoader`, add the scene to your object, place it at the voxel surface height.
4. **Respect sidecar metadata** before guessing: if `asset.json`/provenance carries `frontAxis`,
   `yawOffsetDeg`, `bounds`, pivot, or `animationClips`, use them instead of eyeballing rotation/scale.
   Kiln-authored assets default to `+X` forward.

## Scale & orientation notes
- GLBs come in their own unit scale; normalize to your voxel unit at load (a per-asset `scale` in the
  manifest is the simplest knob).
- Keep simulation/game state OUTSIDE the three.js scene graph; the GLB is presentation only.
- For animated creatures, drive an `AnimationMixer` from the asset's clips; fall back to static if none.

## Consistency reminder
Even though GLBs sit on voxel terrain, pinning `paletteId: sphere-planet` + `optimizedPalette: true`
keeps their colors matched to the block palette so props read as part of the same world
(see `knowledge/03-palette-consistency.md`).
