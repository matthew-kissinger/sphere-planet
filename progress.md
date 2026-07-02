Original prompt: complete courier frontier plan

## 2026-07-02

- Read the Courier Frontier plan and current rally implementation.
- Scope for this pass: implement the first Outpost Prep Tutorial slice with contract/build-site state, ground prep UI/markers, existing gather/place hooks, route handoff, and route completion feedback.
- Use existing sphere movement, route, mining, chopping, placement, and courier rally systems; do not replace player motion or camera code.
- Added pure Frontier modules for contracts, build-site inspection, mode state, prep HUD, and footprint markers.
- Added `test/frontier.test.ts`; focused Frontier tests pass with `npm test -- --run test/frontier.test.ts`.
- Wired the `Frontier` menu entry, outpost prep start, material tracking, build markers, launch gating, route handoff, route completion feedback, debug text hooks, and touch launch state.
- Verified desktop Frontier prep/ready/launch/complete and mobile/touch prep/ready with Playwright screenshots and state assertions; temporary screenshot artifacts were reviewed and removed.
- Added the `Creative` menu entry for full-hotbar free-flight inspection/building and wired touch parity so the mobile plane button toggles free-flight/walk like desktop `F`.
- Fixed keyboard edge buffering so quick `Esc`, `R`, `E`, `F`, `G`, `O`, `F3`, and `H` taps are not dropped during slower frames or headless browser runs.
- Updated README and release QA docs for PC/mobile parity, Frontier, Creative, production preview, Pages deployment, and the known Vite large-chunk warning.
- Rebuilt production assets before preview QA after detecting a stale preview bundle; fresh `dist/` passed desktop Creative and mobile `?touch=1` Creative parity checks with no console/page errors.
