/**
 * Chunk mesher: turns tile columns into a watertight prism mesh.
 *
 * Per solid run of each owned tile:
 *  - a top cap at the run's top radius, a bottom cap (cave ceiling) at its bottom,
 *  - wall quads along each tile edge for every layer band where this tile is solid
 *    and the neighbor across that edge is not. Faces are emitted only from the solid
 *    side, so interior faces are culled and nothing is drawn twice.
 *
 * Pure data in, typed arrays out (positions relative to a f64 anchor) — no three.js
 * imports, so this can move to a Worker wholesale if measurement says it must.
 */

import type { Goldberg } from '../geo/goldberg';
import type { Layers } from '../world/layers';
import type { Columns } from '../world/columns';
import type { ChunkInfo } from '../world/chunks';
import { PLANET_RADIUS } from '../world/layers';
import { materialColor } from './palette';

export interface ChunkMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** f64 world anchor; vertex positions are relative to it */
  anchor: [number, number, number];
  triangles: number;
}

class Sink {
  pos: Float32Array = new Float32Array(65536 * 3);
  nrm: Float32Array = new Float32Array(65536 * 3);
  col: Float32Array = new Float32Array(65536 * 3);
  n = 0;

  reset(): void { this.n = 0; }

  ensure(extraVerts: number): void {
    const need = (this.n + extraVerts) * 3;
    if (need <= this.pos.length) return;
    let cap = this.pos.length;
    while (cap < need) cap *= 2;
    const np = new Float32Array(cap); np.set(this.pos.subarray(0, this.n * 3)); this.pos = np;
    const nn = new Float32Array(cap); nn.set(this.nrm.subarray(0, this.n * 3)); this.nrm = nn;
    const nc = new Float32Array(cap); nc.set(this.col.subarray(0, this.n * 3)); this.col = nc;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): void {
    const i = this.n * 3;
    this.pos[i] = x; this.pos[i + 1] = y; this.pos[i + 2] = z;
    this.nrm[i] = nx; this.nrm[i + 1] = ny; this.nrm[i + 2] = nz;
    this.col[i] = r; this.col[i + 1] = g; this.col[i + 2] = b;
    this.n++;
  }
}

const sink = new Sink();
const cornerScratch = new Float64Array(18);
const colorScratch = new Float32Array(3);

export function buildChunkMesh(
  chunk: ChunkInfo,
  geo: Goldberg,
  layers: Layers,
  columns: Columns,
): ChunkMeshData | null {
  sink.reset();
  const ax = chunk.cx * PLANET_RADIUS, ay = chunk.cy * PLANET_RADIUS, az = chunk.cz * PLANET_RADIUS;
  const bounds = layers.bounds;
  const L = layers.L;
  const cen = geo.centers;

  for (const id of chunk.tiles) {
    const deg = geo.corners(id, cornerScratch);
    const isPent = deg === 5;
    const edit = columns.editOf(id);
    const top = columns.topLayerOf(id);
    const solidHere = (k: number): boolean => {
      if (k < 0 || k >= L) return false;
      if (edit) return (edit.solid[k >> 5] & (1 << (k & 31))) !== 0;
      return k >= top;
    };

    // scan window: from the highest possibly-solid layer of this tile down to where
    // this tile and all neighbors are permanently solid (default columns below their tops).
    let kMin = edit ? 0 : top;
    let kMax = top; // deepest layer at which a wall could still be exposed
    for (let e = 0; e < deg; e++) {
      const n = geo.nbrs[id * 6 + e];
      if (columns.editOf(n)) { kMax = L - 1; break; }
      const nTop = columns.topLayerOf(n);
      if (nTop > kMax) kMax = nTop;
    }
    if (edit) kMax = L - 1;
    if (kMin < 0) kMin = 0;

    const tcx = cen[id * 3], tcy = cen[id * 3 + 1], tcz = cen[id * 3 + 2];

    // --- caps ---
    for (let k = kMin; k <= Math.min(kMax, L - 1); k++) {
      const s = solidHere(k);
      if (!s) continue;
      const above = solidHere(k - 1);
      const below = solidHere(k + 1) || k === L - 1;
      if (above && below) continue;
      if (!above) {
        // top cap at bounds[k]
        emitCap(deg, bounds[k], tcx, tcy, tcz, ax, ay, az, false, columns.materialAt(id, k), id, isPent);
      }
      if (!below && k < L - 1) {
        // bottom cap (cave ceiling) at bounds[k+1]
        emitCap(deg, bounds[k + 1], tcx, tcy, tcz, ax, ay, az, true, columns.materialAt(id, k), id, isPent);
      }
    }

    // --- walls ---
    for (let e = 0; e < deg; e++) {
      const n = geo.nbrs[id * 6 + e];
      const ca = ((e - 1) + deg) % deg; // corner between neighbor e-1 and e
      const cAx = cornerScratch[ca * 3], cAy = cornerScratch[ca * 3 + 1], cAz = cornerScratch[ca * 3 + 2];
      const cBx = cornerScratch[e * 3], cBy = cornerScratch[e * 3 + 1], cBz = cornerScratch[e * 3 + 2];
      let bandStart = -1;
      let bandMat = -1;
      for (let k = kMin; k <= kMax + 1; k++) {
        const exposed = k <= kMax && k < L && solidHere(k) && !columns.solidAt(n, k);
        const mat = exposed ? columns.materialAt(id, k) : -1;
        if (exposed && bandStart === -1) { bandStart = k; bandMat = mat; }
        else if (bandStart !== -1 && (!exposed || mat !== bandMat)) {
          emitWall(cAx, cAy, cAz, cBx, cBy, cBz, bounds[bandStart], bounds[k], tcx, tcy, tcz, ax, ay, az, bandMat, id, isPent);
          bandStart = exposed ? k : -1;
          bandMat = mat;
        }
      }
    }
  }

  if (sink.n === 0) return null;
  return {
    positions: sink.pos.slice(0, sink.n * 3),
    normals: sink.nrm.slice(0, sink.n * 3),
    colors: sink.col.slice(0, sink.n * 3),
    anchor: [ax, ay, az],
    triangles: sink.n / 3,
  };
}

function emitCap(
  deg: number, r: number,
  ncx: number, ncy: number, ncz: number,
  ax: number, ay: number, az: number,
  flip: boolean, mat: number, tileId: number, isPent: boolean,
): void {
  materialColor(mat, tileId, isPent, colorScratch);
  const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
  const nx = flip ? -ncx : ncx, ny = flip ? -ncy : ncy, nz = flip ? -ncz : ncz;
  sink.ensure((deg - 2) * 3);
  const c = cornerScratch;
  const x0 = c[0] * r - ax, y0 = c[1] * r - ay, z0 = c[2] * r - az;
  for (let t = 1; t < deg - 1; t++) {
    const i1 = flip ? t + 1 : t;
    const i2 = flip ? t : t + 1;
    sink.vert(x0, y0, z0, nx, ny, nz, cr, cg, cb);
    sink.vert(c[i1 * 3] * r - ax, c[i1 * 3 + 1] * r - ay, c[i1 * 3 + 2] * r - az, nx, ny, nz, cr, cg, cb);
    sink.vert(c[i2 * 3] * r - ax, c[i2 * 3 + 1] * r - ay, c[i2 * 3 + 2] * r - az, nx, ny, nz, cr, cg, cb);
  }
}

function emitWall(
  cAx: number, cAy: number, cAz: number,
  cBx: number, cBy: number, cBz: number,
  rTop: number, rBot: number,
  tcx: number, tcy: number, tcz: number,
  ax: number, ay: number, az: number,
  mat: number, tileId: number, isPent: boolean,
): void {
  materialColor(mat, tileId, isPent, colorScratch);
  const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
  // quad corners (world, then relative to anchor)
  const v0x = cAx * rTop, v0y = cAy * rTop, v0z = cAz * rTop;
  const v1x = cBx * rTop, v1y = cBy * rTop, v1z = cBz * rTop;
  const v2x = cBx * rBot, v2y = cBy * rBot, v2z = cBz * rBot;
  const v3x = cAx * rBot, v3y = cAy * rBot, v3z = cAz * rBot;
  // face normal, oriented away from the tile center
  let nx = (v1y - v0y) * (v3z - v0z) - (v1z - v0z) * (v3y - v0y);
  let ny = (v1z - v0z) * (v3x - v0x) - (v1x - v0x) * (v3z - v0z);
  let nz = (v1x - v0x) * (v3y - v0y) - (v1y - v0y) * (v3x - v0x);
  const midx = (v0x + v1x) * 0.5 - tcx * rTop, midy = (v0y + v1y) * 0.5 - tcy * rTop, midz = (v0z + v1z) * 0.5 - tcz * rTop;
  let flip = false;
  if (nx * midx + ny * midy + nz * midz < 0) { nx = -nx; ny = -ny; nz = -nz; flip = true; }
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  sink.ensure(6);
  const q = [
    v0x - ax, v0y - ay, v0z - az,
    v1x - ax, v1y - ay, v1z - az,
    v2x - ax, v2y - ay, v2z - az,
    v3x - ax, v3y - ay, v3z - az,
  ];
  const order = flip ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3];
  for (const idx of order) {
    sink.vert(q[idx * 3], q[idx * 3 + 1], q[idx * 3 + 2], nx, ny, nz, cr, cg, cb);
  }
}
