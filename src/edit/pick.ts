/**
 * Cell picking by ray-marching the column field: step the ray, look up (tile, layer),
 * test solidity, then bisect to the surface. O(steps) column lookups, no triangle
 * intersection or acceleration structure needed — and it works through mined tunnels,
 * because it samples the same volume the mesh was built from.
 */

import type { Goldberg } from '../geo/goldberg';
import type { Layers } from '../world/layers';
import type { Columns } from '../world/columns';

export interface PickResult {
  hitTile: number;
  hitLayer: number;
  /** last empty cell before the hit — the placement target (-1 if ray started inside solid) */
  prevTile: number;
  prevLayer: number;
  dist: number;
}

const STEP = 0.4;

export function pick(
  geo: Goldberg, layers: Layers, columns: Columns,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): PickResult | null {
  const Ro = layers.bounds[0] + 0.75;
  const core = layers.bounds[layers.L];

  // fast-forward to the outer shell if starting outside it
  let t = 0;
  const oo = ox * ox + oy * oy + oz * oz;
  if (oo > Ro * Ro) {
    const b = ox * dx + oy * dy + oz * dz;
    const disc = b * b - (oo - Ro * Ro);
    if (disc < 0) return null;
    const tEnter = -b - Math.sqrt(disc);
    if (tEnter > maxDist || tEnter < 0) return null;
    t = Math.max(0, tEnter);
  }

  let prevTile = -1, prevLayer = -1;
  let solid = false;
  let px = 0, py = 0, pz = 0, r = 0;

  const sample = (tt: number): { tile: number; k: number; solid: boolean } => {
    px = ox + dx * tt; py = oy + dy * tt; pz = oz + dz * tt;
    r = Math.hypot(px, py, pz);
    if (r >= Ro || r <= core) return { tile: -1, k: -1, solid: false };
    const k = layers.layerOfRadius(r);
    if (k < 0) return { tile: -1, k: -1, solid: false };
    const tile = geo.tileOf(px, py, pz);
    return { tile, k, solid: columns.solidAt(tile, k) };
  };

  for (; t <= maxDist; t += STEP) {
    const s = sample(t);
    if (s.tile === -1) {
      // outside shell — bail if we're heading further out
      if (r > Ro && px * dx + py * dy + pz * dz > 0) return null;
      prevTile = -1; prevLayer = -1;
      continue;
    }
    if (!s.solid) {
      prevTile = s.tile; prevLayer = s.k;
      solid = false;
      continue;
    }
    // hit: bisect [t-STEP, t] to sharpen prev/hit cells
    let lo = Math.max(0, t - STEP), hi = t;
    let hitTile = s.tile, hitLayer = s.k;
    for (let it = 0; it < 10; it++) {
      const mid = (lo + hi) / 2;
      const sm = sample(mid);
      if (sm.solid) {
        hi = mid; hitTile = sm.tile; hitLayer = sm.k;
      } else {
        lo = mid;
        if (sm.tile >= 0) { prevTile = sm.tile; prevLayer = sm.k; }
      }
    }
    return { hitTile, hitLayer, prevTile, prevLayer, dist: hi };
  }
  return null;
}
