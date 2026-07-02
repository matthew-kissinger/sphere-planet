Original prompt: complete courier frontier plan

## 2026-07-02

- User rejected the courier route modes and Frontier/outpost-building loop; current direction is back to the sandbox planet: creative/free-flight, mining, building, chopping, and the craftable plane.
- Reverted the Courier/Frontier release in the working tree, removing the route/outpost modules, docs, UI CSS, and tests instead of leaving unused mode code.
- Kept useful non-mode improvements: key-edge buffering for reliable quick taps, `render_game_to_text`, `advanceTime`, and a clearer `?creative=1` path.
- Updated plane onboarding: startup hint explains two trees -> 12 wood -> `E`/plane button, tree chopping reports plane progress, and failed craft attempts say how to get wood.
- Verified `npm test` returns the original 24-test suite, `npm run build` passes, the develop-web-game Playwright client captures Creative/touch gameplay, and targeted Playwright assertions confirm no Courier/Frontier UI remains.
- User approved committing, pushing, and deploying this cleanup to Pages.
- Added README QA/deployment notes for the simplified sandbox release path and Pages workflow.
- Release gates for this commit: `npm test` passed 24 tests; `npm run build` passed with the known Vite large-chunk warning; production preview passed desktop default sandbox plane-craft and mobile `?creative=1&touch=1` checks with clean console/page errors and nonblank canvas pixel samples.
