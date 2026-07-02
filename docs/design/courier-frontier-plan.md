# Courier Frontier Ground Mode Plan

Status: first playable slice implemented. This document records the plan and the current implemented shape.

## Why This Exists

The current courier rally loop makes flight the main objective. Walking, mining, chopping, inventory, and tile placement still exist in the engine, but they do not have a meaningful job inside the new route challenge. The proposed mode gives those verbs a purpose by making ground preparation feed directly into delivery play.

## Mode Split

- `Planet Courier Rally`: the current quick-play arcade flight route mode.
- `Courier Frontier`: a ground-based logistics mode where the player gathers materials, builds or repairs delivery infrastructure, then flies routes unlocked by that prep.

The intent is to keep the current rally mode fast and readable while adding a second mode that uses the original sandbox engine strengths.

## Current Implemented Slice

- The title menu keeps quick-play `Play` and adds `Frontier`.
- Frontier starts the player on foot at a selected outpost tile near usable ground resources.
- The active contract is `Outpost Prep Tutorial` for the Harbor Loop route.
- The contract tracks lifetime gathered materials: `12 wood` and `6 rock`.
- The marked build site has a `7-cell` pad footprint plus one beacon cell.
- Existing mining, chopping, hotbar selection, and tile placement satisfy the mode objectives.
- The route launch is blocked until material and build-site requirements are complete.
- Pressing `E` or the touch plane button launches the prepared Harbor Loop route.
- The Harbor Loop delivery pad is anchored to the prepared outpost site, so the route lands on the pad the player built.
- The route completion screen includes Frontier prep time, materials, build completion, and build quality.
- Quick-play rally remains available separately.

## Design Goal

Make the player feel like they are opening delivery access across the planet, not just flying through rings. The ground loop should answer why walking, harvesting, breaking, and placing tiles matter:

- Build landing pads so routes have safe destinations.
- Repair beacons so flight paths become visible and scoreable.
- Assemble cargo and fuel caches so deliveries can launch.
- Improve route quality through better preparation, not only better flying.

## Core Loop

1. Pick a delivery contract from a simple contract board.
2. Walk to a marked outpost site on the planet surface.
3. Inspect the site requirements and ghost footprint.
4. Gather materials by chopping trees, mining rocks, and breaking usable tiles.
5. Place required blocks into the footprint to repair or build the outpost feature.
6. Craft, fuel, or board the plane once the site is ready.
7. Fly the courier route.
8. Land at the prepared pad and receive rewards based on prep quality and route performance.

## First Approved Slice: Outpost Prep Tutorial

The smallest useful version should prove the ground-to-flight loop without building a large crafting game.

Target flow:

1. Start the player on foot near a forest and rocky patch.
2. Show one contract: prepare a nearby outpost for the Harbor Loop delivery.
3. Require `12 wood` and `6 rock`.
4. Show a `7-tile` landing pad ghost footprint.
5. Let existing break/gather/place controls fill the pad footprint.
6. Require a small beacon or cargo marker beside the pad.
7. Unlock the plane once the pad and marker are complete.
8. Hand off to the existing courier ring route.
9. Require landing on or near the prepared pad to complete the contract.
10. Show a result screen that credits gather time, build completion, route time, misses, and landing quality.

## Gameplay Rules

- Build sites use ghost footprints snapped to existing planet tile coordinates.
- Only placed cells inside the active footprint count toward completion.
- Landing pad quality can score filled cells, surface flatness, and obstruction clearance.
- Beacons can enable route markers or widen the route grace window.
- Cargo and fuel caches can consume materials and gate route launch.
- The first prototype should not permanently punish failure; failed flights return the player to launch with materials and site progress intact.
- The first prototype should avoid deep survival systems. Hunger, health, weather, and a broad recipe tree are out of scope unless approved later.

## Architecture Plan

Add the mode as a thin layer over the current planet, inventory, building, and courier systems.

Planned modules:

- `src/game/contracts.ts`: contract definitions, progress state, rewards, and route linkage.
- `src/game/buildSites.ts`: build-site footprints, material requirements, placement validation, and completion scoring.
- `src/game/frontierMode.ts`: state machine for contract selection, ground prep, launch, flight handoff, and completion.
- `src/game/frontierUi.ts`: contract board, objective checklist, material requirements, and completion prompts.

Reused systems:

- Existing planet columns, terrain, collision, chopping, mining, inventory, and tile placement.
- Existing `CourierRally` route timing, miss tracking, results, retry, and pause behavior.
- Existing courier camera and UI patterns where they fit.

Integration points:

- Ground interactions should emit build-site progress when a frontier site is active.
- Route launch should be blocked until the active site requirements are complete.
- Courier route completion should report back to frontier mode so the contract can finish.
- Rally quick-play should remain available unless we explicitly decide to replace it.

## Implementation Phases

1. Documentation and approval: captured the plan and mode boundaries.
2. Data/state slice: added contracts and build-site validation with focused tests.
3. Visual slice: rendered pad/beacon markers and objective UI.
4. Interaction slice: connected existing gather/place actions to build-site requirements.
5. Route handoff slice: completed outpost launches the Harbor Loop route.
6. Completion slice: landing and results complete the contract and show prep/flight scoring.
7. Tuning and QA: verified desktop and touch flows; future tuning can adjust material counts, distances, and failure rules.

## Open Decisions

- `Planet Courier Rally` currently remains a separate quick-play mode.
- The first screen currently defaults to quick-play rally, with `Frontier` as a separate entry.
- Pad completion currently requires placed cells in the footprint; rock placement improves quality, while material gathering is tracked separately.
- Route prep does not yet tune gate width, marker clarity, or fuel reserves.
- Build-site progress does not persist across page reloads in the first slice.
- Failed flights remain forgiving and do not consume cargo or fuel.

## Non-Goals For The First Slice

- No large recipe system.
- No economy or shop.
- No hunger, thirst, or health survival loop.
- No procedural quest chain.
- No save-game format unless approved.
- No new external art pipeline requirement.

## Verification Plan

- Unit tests for contract state, build-site validation, material requirements, and completion scoring.
- Browser smoke test for menu to frontier start, gather, build, launch, route, landing, and retry.
- Regression check that the existing rally quick-play path still works.
- Touch viewport check for movement, interaction, route HUD, and prompts.
- Console check for runtime errors during ground prep and route handoff.
