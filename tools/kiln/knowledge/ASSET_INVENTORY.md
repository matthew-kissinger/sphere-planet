# Goldberg Planet — Asset Inventory & Kiln Generation Roadmap

Atomic inventory of every **authored visual asset** in the game (excluding hexagon terrain,
water sphere, and sky/atmosphere), assembled from a 6-agent read of `src/render/*` + `src/sim/*`.
Purpose: plan which assets to replace/upgrade with **Kiln** palette-consistent GLBs.

> **Everything is authored in code** with three.js primitives (box/cylinder/cone/sphere),
> flat-shaded, ~one shared palette. No model files exist today. So "replace with Kiln" = swap a
> code-built `THREE.Group` for a loaded GLB — see the **Integration rules** before generating.

## Counts at a glance
| Bucket | Distinct assets | GLB-worthy | Notes |
|---|---|---|---|
| Player avatar | 1 (Soft-Facet Wayfarer, ~35 sub-meshes, rigged, 20 poses) | **NO** | Procedural rig IS the value — do not swap |
| Vehicle | 1 (bush plane) | **YES (hero)** | Keep prop as separate node; no carts exist |
| Held / back props | ~24 builders / 60 prop IDs | mixed | ~10 are placeholder boxes today |
| Creatures | 9 species (~20 variants) | YES (w/ rig caveats) | Identity lives in procedural animation |
| Structures / placeables | 19 | YES (static shells) | 13/19 have stateful named sub-nodes |
| Landmarks | 12 shrines (1 kit × 12 skins) + 12 resource nodes | **YES (hero leverage)** | One kit upgrades all twelve |
| Vegetation | 1 conifer (parametric) | YES (biggest payoff) | Baked in terrain buffer — needs refactor |
| Resource drops | 5 variants | partial | Rock/ore drop is the weakest token |
| Cave mouths | 3 kinds | YES (best world-feature ROI) | Low count, opaque POIs |
| Skyfall | 3 kinds (crater + beacon) | crater only | Beacon column = VFX, keep procedural |
| Route ribbons / Murmur FX / glow signals | ~12 | **NO** | Shader/VFX — do not chase with GLBs |

**~90+ distinct authored builders total.** Art language is coherent soft-faceted low-poly in a
warm/teal desaturated palette — any Kiln replacement must match it (use the `sphere-planet`
palette + `optimizedPalette:true` on every generation) or it will clash.

---

## Kiln generation backlog (ranked by payoff × ubiquity ÷ integration risk)

### Wave 1 — Cleanest, highest-visibility wins (do first)
1. **Bush plane** (`vehicle`/`vehicle`) — player-controlled hero, always on screen, single rigid body. *Keep the propeller as its own named node; author nose-forward −Z, +Y up.*
2. **Workbench** (`prop`/`building`) — ubiquitous crafting hub, **fully stateless** = lowest-risk complete drop-in.
3. **Chest** (`prop`/`prop`) — iconic, near-stateless (preserve `frontLatch` node), text-to-3D nails chests.
4. **Campfire** (`prop`/`prop`) — most primitive-looking object every player builds. *Swap the stone-ring+logs shell only; keep `flameCore` + `smokePuff*` procedural.*
5. **Shelter kit — doorKit, windowFrame, roofBundle, dockSegment** (`architecture`/`building`) — stateless modular building pieces; currently the crudest slabs. Keep footprints consistent for tiling.

### Wave 2 — Landmarks (single highest-leverage architectural swap)
6. **Shrine kit** (`architecture`/`wonder`) — all 12 pentagon shrines share ONE procedural kit. Generate **1 base shrine + 12 domain threshold/silhouette variants** → upgrades all twelve at once. Keep glow orb / signal beam / core as code overlays. Hero silhouettes to prioritize: **Last Horizon**, **High Lantern**.
7. **12 domain-resource nodes** (`poi`/`poi`, batch) — coal ember, rain reed, salt shells, lantern prism, root pods, red nodule, snow bloom, glass panes, storm amber, kelp tangle, bell crystal, horizon marker. Currently crude trinkets; keep dormant/discovered glow spheres separate.

### Wave 3 — Creatures (charm; mind the rigs)
8. **caveBlinker → tideLurker → mossPuff**, then brambleback / reedback / stormBurr / shellSkitter, then the trickier **caveBelljaw** (two-part hinged jaw = multi-part GLB) and **screeSnapper** (must still read as camouflaged rubble). All `character`/`character`. *No rigs exist — keep animatable sub-parts (eyes, jaws, eyestalks) as named nodes; keep telegraph warning rings in code.*

### Wave 4 — World features & vegetation
9. **Cave mouths** (`prop`/`poi`) — arch / dryCave / seaCave. Low count (≤8), opaque, structural = best world-feature ROI. Keep glyph + spring seep as FX accents.
10. **Trees** (`vegetation`/`fill`) — biggest gameplay-visible payoff (most-repeated, weakest detail, single species). Generate **3–4 species** (pine, broadleaf, dead snag, shrub). **Caveat: requires refactoring trees out of the baked terrain vertex buffer into an instanced scatter system — the biggest engineering lift in the whole plan.**
11. **Skyfall crater floors + rock/ore resource drops** (`poi` + `fill`) — crater ground half is a natural GLB (keep beam/omen FX); the rock drop is a recolored cube today = easy win.

### Wave 5 — Mid-tier held / wearable / stateful bodies
Storm cloak (boxy cloth → real drape), pack frame, weather-vane body (keep `weatherVaneNeedle`
spinning node), fish trap / drying rack / rain cistern bodies (keep water/state nodes),
echoLantern / glowCrystal (emissive).

### Do NOT Kiln-replace
- **Player avatar** — SDF soft-facet shells + TSL breathing + 20 code-driven poses; a static GLB forfeits all of it.
- **Held terrain blocks** (dirt/rock/sand/snow/wood in hand) — deliberately voxel-matched.
- **Route ribbons, murmur FX, skyfall beacon column, all telegraph rings & glow/emissive gameplay signals** — these are shader/VFX; a GLB fights their dynamic layout/transparency.

---

## Integration rules (read before generating)
1. **No skeletons exist.** All motion is procedural, driven by matching child mesh `.name` in each renderer's `update()/applyState()`. A GLB is either (a) a **static-shell swap** with the animated/stateful children kept code-authored and parented on, or (b) shipped with named sub-nodes the existing code can still target. 13/19 structures and most creatures fall here.
2. **Keep gameplay signals in code** — flames, smoke, water surfaces, growing plants, spinning needles/props, hinged jaws, toggling glyphs, glow orbs, signal beams, telegraph rings. Swap geometry, not behavior.
3. **Match the art language** — soft-faceted, flat-shaded, warm/teal desaturated. Always pass the `sphere-planet` palette (`paletteId`) + `optimizedPalette:true`. See `03-palette-consistency.md`.
4. **Pivots & orientation** — assets place onto the sphere via a per-tile tangent basis; GLBs need a **base-origin pivot, +Y up** (props ~unit scale, shrine apron ~3.5u, nodes ~0.6u). Plane must be **nose-forward −Z**.
5. **Transparency** — window glass, smoke, water, and the avatar's camera-distance fade rely on `transparent:true` materials; imported GLB materials must preserve that where relevant.
6. **Not instanced today** — creatures/trees/scatter spawn hundreds of individual meshes. A GLB swap is also the moment to add InstancedMesh + LOD (especially trees and creatures).

## Source map (where each bucket lives)
- Character + plane + held props: `src/render/character.ts`
- Creatures: `src/render/nativeLife.ts` + `src/sim/nativeLife.ts`
- Structures: `src/render/structures.ts` + `src/sim/structures.ts` + `src/sim/crafting.ts`
- Landmarks + domain nodes: `src/render/landmarks.ts` + `src/render/domainResources.ts` (+ sim)
- Trees: `src/world/trees.ts` + `src/render/mesher.ts` (`emitTree`)
- Drops / routes / murmurs / cave mouths / skyfall: `src/render/{resourceDrops,routes,murmurs,caveMouths,skyfall}.ts`
- Master item vocabulary: `ITEM_DEFS` in `src/sim/crafting.ts` (56 items: 5 materials + 51 crafted)
