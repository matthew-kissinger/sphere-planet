# QA And Pages Release Checklist

Status: use this before committing, pushing, or deploying a browser build.

## Required Local Gates

- `npm test`
- `npm run build`
- Production preview of `dist/`
- Desktop browser smoke test
- Mobile/touch browser smoke test
- Console/page error check
- Nonblank canvas check
- Renderer/performance snapshot during active play

## Desktop And Mobile Parity

Both desktop and mobile must be able to reach the same shipped modes:

- `Play`: launch a quick courier route, pass at least one ring, pause/resume, retry or return to menu.
- `Frontier`: start ground prep, observe material/build objectives, complete pad/beacon requirements, launch delivery, and reach a completion state.
- `Creative`: start with full hotbar resources, free-flight enabled, and terrain editing available.

Desktop-specific controls:

- Mouse/drag look, `WASD`, `Space`, `Shift`, `E`, `F`, `Esc`, number hotkeys.

Mobile-specific controls:

- Left joystick movement/throttle.
- Drag look.
- Tap mine/chop.
- Hold build.
- Jump/down buttons.
- Plane button for craft/board/stow, Frontier launch, and Creative free-flight/walk toggle.

## Performance Notes

- Mobile uses a lower DPR cap and low sky quality by default.
- WebGPU is attempted first; WebGL2 fallback must boot with `?gpu=gl`.
- Current build has a large Vite chunk warning because Three.js and the full game ship in one bundle; this is acceptable for the current prototype, but should remain visible in release notes.
- Record FPS/frame time and renderer diagnostics from an active scene, not just the title menu.

## Pages Deployment

- Target: GitHub Pages at `https://matthew-kissinger.github.io/goldberg-planet/`.
- Vite base path: `./`, so assets are relative and compatible with the project subpath.
- Build artifact: `dist/`.
- No client-side secrets or runtime API keys are expected.
- After deploy, verify the live URL loads the newest UI and the browser console is clean.
