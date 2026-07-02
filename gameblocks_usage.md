# GameBlocks Usage

Selected GameBlocks material was used as reference/spec guidance only. No modules were copied into this project.

## Reviewed Modules

- `modules/math/WorldBasis.js`
  - Purpose: basis-aware right/up/forward thinking, tangent motion, and frame construction.
  - Use: informed the local-up/tangent-frame route math in `src/game/courierRoutes.ts`.
  - Reuse status: adapted conceptually; not copied because this project already has sphere-native tile frames and transported heading.

- `modules/gameplay/RaceCheckpointLapPlay.js`
  - Purpose: ordered checkpoint state, countdown, checkpoint events, finish state, reset.
  - Use: informed `CourierRally` state ownership, event queue, countdown, route completion, and retry flow.
  - Reuse status: adapted conceptually for one-player ring-plus-pad delivery instead of lap racing.

- `modules/gameplay/FlightPlay.js`
  - Purpose: flight state and ground-contact failure events.
  - Use: informed explicit stow/crash handling in active courier runs.
  - Reuse status: adapted conceptually because the existing `Player` already owns terrain-following AGL flight and stow behavior.

- `modules/user-interface/FlightHud.js`
  - Purpose: cockpit-style flight readouts, stable numeric displays, warning/status zones.
  - Use: informed the compact route HUD with objective, target, timer, score/chain, speed, altitude, AGL, progress, and hint zones.
  - Reuse status: adapted conceptually to match the existing DOM HUD and mobile constraints.

- `modules/actor-motion/aircraft/AirplaneMotionController.js`
  - Purpose: throttle, boost, bank, pitch, and speed tuning architecture.
  - Use: validated that the current player aircraft already has the right ownership shape; route work uses the existing controller rather than replacing it.
  - Reuse status: not copied.

- `modules/camera/PoseFollowCameraRig.js`
  - Purpose: camera/state separation and frame-relative offsets.
  - Use: informed keeping route visuals camera-relative without moving gameplay coordinates.
  - Reuse status: not copied because the current floating-origin camera is project-specific.
