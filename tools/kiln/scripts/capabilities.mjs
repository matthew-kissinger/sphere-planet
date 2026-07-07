// No-spend smoke check: verifies the token, base URL, and that /v1 is live.
// GET /v1/capabilities (scope: library:read). Run this BEFORE any generation.
//   node scripts/capabilities.mjs
import { kilnJson } from './http.mjs';

const caps = await kilnJson('/capabilities');
console.log(JSON.stringify(caps, null, 2));
console.log('\nOK — token authenticates and /v1 is reachable. Safe to generate.');
