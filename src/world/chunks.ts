/**
 * Chunking: tiles are grouped by their canonical lattice cell — (face, i>>4, j>>4) of the
 * tile's canonical representative. This partitions the whole planet into ~900 chunks of
 * up to ~256 tiles with no tile owned twice, seams included.
 */

import type { Goldberg } from '../geo/goldberg';

export const CHUNK_S = 16;

export interface ChunkInfo {
  key: number;
  f: number;
  ci: number;
  cj: number;
  tiles: Int32Array;
  /** unit center direction of the chunk (f64) */
  cx: number;
  cy: number;
  cz: number;
  /** max angle (radians) from center dir to any owned tile center, plus one tile of margin */
  angRadius: number;
}

export function chunkKey(f: number, ci: number, cj: number): number {
  return f * 4096 + ci * 64 + cj;
}

export function chunkKeyOfTile(geo: Goldberg, id: number): number {
  const { f, i, j } = geo.repOf(id);
  return chunkKey(f, Math.floor(i / CHUNK_S), Math.floor(j / CHUNK_S));
}

/** Enumerate every non-empty chunk on the planet (topology only — no terrain, no meshes). */
export function enumerateChunks(geo: Goldberg): Map<number, ChunkInfo> {
  const m = geo.m;
  const cells = Math.ceil((m + 1) / CHUNK_S);
  const out = new Map<number, ChunkInfo>();
  const tileScratch: number[] = [];
  for (let f = 0; f < 20; f++) {
    for (let ci = 0; ci < cells; ci++) {
      for (let cj = 0; cj < cells; cj++) {
        if (ci * CHUNK_S + cj * CHUNK_S > m) continue;
        tileScratch.length = 0;
        const iEnd = Math.min((ci + 1) * CHUNK_S - 1, m);
        for (let i = ci * CHUNK_S; i <= iEnd; i++) {
          const jEnd = Math.min((cj + 1) * CHUNK_S - 1, m - i);
          for (let j = cj * CHUNK_S; j <= jEnd; j++) {
            const id = geo.pointId(f, i, j);
            const rep = geo.repOf(id);
            if (rep.f === f && rep.i === i && rep.j === j) tileScratch.push(id);
          }
        }
        if (tileScratch.length === 0) continue;
        const tiles = Int32Array.from(tileScratch);
        let cx = 0, cy = 0, cz = 0;
        const c = geo.centers;
        for (const id of tiles) {
          cx += c[id * 3]; cy += c[id * 3 + 1]; cz += c[id * 3 + 2];
        }
        const len = Math.hypot(cx, cy, cz);
        cx /= len; cy /= len; cz /= len;
        let minDot = 1;
        for (const id of tiles) {
          const d = c[id * 3] * cx + c[id * 3 + 1] * cy + c[id * 3 + 2] * cz;
          if (d < minDot) minDot = d;
        }
        // one tile of angular margin (~1.1/m radians)
        const angRadius = Math.acos(Math.min(1, minDot)) + 1.3 / m;
        const key = chunkKey(f, ci, cj);
        out.set(key, { key, f, ci, cj, tiles, cx, cy, cz, angRadius });
      }
    }
  }
  return out;
}
