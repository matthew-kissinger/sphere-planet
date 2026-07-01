/**
 * Goldberg polyhedron GP(m,0) topology: the dual of a frequency-m geodesic subdivision
 * of an icosahedron, projected onto the unit sphere.
 *
 * Every geodesic lattice vertex becomes one tile: hexagonal everywhere except the 12
 * icosahedron vertices, which become pentagons.
 *
 * Tile addressing deliberately avoids any global coordinate chart. A tile id encodes its
 * *combinatorial* home — icosa vertex, icosa edge + offset, or icosa face + (i,j) — an atlas
 * of 20 local charts stitched by explicit canonical ownership of shared edges/vertices.
 * Neighbor relationships are stored as explicit lists, ordered CCW viewed from outside.
 *
 * Corner rule: the corner shared by tiles {a,b,c} is the normalized centroid of their three
 * centers, summed in ascending-id order — so all three tiles compute bit-identical floats
 * and meshes are watertight across tiles, chunks, and icosa faces by construction.
 */

import { ICO, type Icosahedron } from './icosahedron';

export class Goldberg {
  readonly m: number;
  readonly count: number;
  readonly ico: Icosahedron;
  /** unit tile centers, xyz interleaved, Float64 */
  readonly centers: Float64Array;
  /** 6 neighbor ids per tile, CCW from outside, -1 padding on pentagons */
  readonly nbrs: Int32Array;
  /** 5 or 6 */
  readonly degrees: Uint8Array;
  readonly buildMs: number;

  private readonly edgeBase = 12;
  private readonly intBase: number;
  private readonly perEdge: number;
  private readonly perFaceInterior: number;
  private readonly rowOffsets: Int32Array;

  constructor(m: number) {
    if (m < 1) throw new Error('m must be >= 1');
    const t0 = performance.now();
    this.m = m;
    this.ico = ICO;
    this.count = 10 * m * m + 2;
    this.perEdge = m - 1;
    this.intBase = 12 + 30 * (m - 1);
    this.perFaceInterior = ((m - 1) * (m - 2)) / 2;

    // rowOffsets[i'] = index offset of interior row i' (i = i'+1)
    this.rowOffsets = new Int32Array(Math.max(1, m - 1));
    for (let ip = 1; ip < m - 1; ip++) {
      this.rowOffsets[ip] = this.rowOffsets[ip - 1] + (m - 2 - (ip - 1));
    }

    const N = this.count;
    this.centers = new Float64Array(3 * N);
    this.nbrs = new Int32Array(6 * N).fill(-1);
    this.degrees = new Uint8Array(N);

    this.computeCenters();
    this.buildAdjacency();
    this.orderNeighborsCCW();
    this.buildMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- ids

  /** Stable id for lattice point (i,j) on face f. Shared points canonicalize identically from all faces. */
  pointId(f: number, i: number, j: number): number {
    const m = this.m;
    const F = this.ico.faces;
    const A = F[f * 3], B = F[f * 3 + 1], C = F[f * 3 + 2];
    if (i === 0 && j === 0) return A;
    if (i === m && j === 0) return B;
    if (i === 0 && j === m) return C;
    const lut = this.ico.edgeIndexLut;
    if (j === 0) {
      const e = lut[A * 12 + B];
      const t = A < B ? i : m - i;
      return this.edgeBase + e * this.perEdge + (t - 1);
    }
    if (i === 0) {
      const e = lut[A * 12 + C];
      const t = A < C ? j : m - j;
      return this.edgeBase + e * this.perEdge + (t - 1);
    }
    if (i + j === m) {
      const e = lut[B * 12 + C];
      const t = B < C ? j : i;
      return this.edgeBase + e * this.perEdge + (t - 1);
    }
    const ip = i - 1, jp = j - 1;
    return this.intBase + f * this.perFaceInterior + this.rowOffsets[ip] + jp;
  }

  /** Canonical representative (face, i, j) for a tile id. Inverse of pointId through owner faces. */
  repOf(id: number): { f: number; i: number; j: number } {
    const m = this.m;
    const F = this.ico.faces;
    if (id < 12) {
      const f = this.ico.vertexOwnerFace[id];
      const s = F[f * 3] === id ? 0 : F[f * 3 + 1] === id ? 1 : 2;
      return { f, i: s === 1 ? m : 0, j: s === 2 ? m : 0 };
    }
    if (id < this.intBase) {
      const rel = id - this.edgeBase;
      const e = Math.floor(rel / this.perEdge);
      const t = (rel - e * this.perEdge) + 1;
      const f = this.ico.edgeOwnerFace[e];
      const lo = this.ico.edges[e * 2], hi = this.ico.edges[e * 2 + 1];
      const A = F[f * 3], B = F[f * 3 + 1], C = F[f * 3 + 2];
      // Which side of f is {lo,hi}?
      if ((A === lo && B === hi) || (A === hi && B === lo)) {
        return { f, i: A === lo ? t : m - t, j: 0 };
      }
      if ((A === lo && C === hi) || (A === hi && C === lo)) {
        return { f, i: 0, j: A === lo ? t : m - t };
      }
      // side B-C: param from lo; distance from B along B->C is j, from C is i.
      if (B === lo) return { f, i: m - t, j: t };
      return { f, i: t, j: m - t };
    }
    const rel = id - this.intBase;
    const f = Math.floor(rel / this.perFaceInterior);
    let idx = rel - f * this.perFaceInterior;
    // find row ip: largest with rowOffsets[ip] <= idx
    let ip = 0;
    // rowOffsets is short (m-1 entries); binary search
    let loI = 0, hiI = m - 2 - 1;
    while (loI <= hiI) {
      const mid = (loI + hiI) >> 1;
      if (this.rowOffsets[mid] <= idx) { ip = mid; loI = mid + 1; } else { hiI = mid - 1; }
    }
    const jp = idx - this.rowOffsets[ip];
    return { f, i: ip + 1, j: jp + 1 };
  }

  // ---------------------------------------------------------------- topology build

  private computeCenters(): void {
    const m = this.m;
    const V = this.ico.verts, F = this.ico.faces;
    for (let id = 0; id < this.count; id++) {
      const { f, i, j } = this.repOf(id);
      const A = F[f * 3], B = F[f * 3 + 1], C = F[f * 3 + 2];
      const w0 = (m - i - j) / m, w1 = i / m, w2 = j / m;
      let x = w0 * V[A * 3] + w1 * V[B * 3] + w2 * V[C * 3];
      let y = w0 * V[A * 3 + 1] + w1 * V[B * 3 + 1] + w2 * V[C * 3 + 1];
      let z = w0 * V[A * 3 + 2] + w1 * V[B * 3 + 2] + w2 * V[C * 3 + 2];
      const len = Math.hypot(x, y, z);
      x /= len; y /= len; z /= len;
      this.centers[id * 3] = x;
      this.centers[id * 3 + 1] = y;
      this.centers[id * 3 + 2] = z;
    }
  }

  private addEdge(a: number, b: number): void {
    const na = this.degrees[a];
    let found = false;
    for (let k = 0; k < na; k++) if (this.nbrs[a * 6 + k] === b) { found = true; break; }
    if (!found) {
      if (na >= 6) throw new Error(`tile ${a} exceeds degree 6`);
      this.nbrs[a * 6 + na] = b;
      this.degrees[a] = na + 1;
    }
    const nb = this.degrees[b];
    found = false;
    for (let k = 0; k < nb; k++) if (this.nbrs[b * 6 + k] === a) { found = true; break; }
    if (!found) {
      if (nb >= 6) throw new Error(`tile ${b} exceeds degree 6`);
      this.nbrs[b * 6 + nb] = a;
      this.degrees[b] = nb + 1;
    }
  }

  private buildAdjacency(): void {
    const m = this.m;
    for (let f = 0; f < 20; f++) {
      for (let i = 0; i <= m; i++) {
        for (let j = 0; j <= m - i; j++) {
          const a = this.pointId(f, i, j);
          if (i + 1 + j <= m) this.addEdge(a, this.pointId(f, i + 1, j));
          if (i + j + 1 <= m) this.addEdge(a, this.pointId(f, i, j + 1));
          if (j >= 1 && i + j <= m) this.addEdge(a, this.pointId(f, i + 1, j - 1));
        }
      }
    }
  }

  private orderNeighborsCCW(): void {
    const c = this.centers;
    const idxScratch = [0, 1, 2, 3, 4, 5];
    const angScratch = new Float64Array(6);
    const nbrScratch = new Int32Array(6);
    for (let v = 0; v < this.count; v++) {
      const deg = this.degrees[v];
      const cx = c[v * 3], cy = c[v * 3 + 1], cz = c[v * 3 + 2];
      // reference tangent: toward lowest-id neighbor (deterministic)
      let ref = Infinity;
      for (let k = 0; k < deg; k++) ref = Math.min(ref, this.nbrs[v * 6 + k]);
      let ex = c[ref * 3] - cx, ey = c[ref * 3 + 1] - cy, ez = c[ref * 3 + 2] - cz;
      const d0 = ex * cx + ey * cy + ez * cz;
      ex -= d0 * cx; ey -= d0 * cy; ez -= d0 * cz;
      const el = Math.hypot(ex, ey, ez);
      ex /= el; ey /= el; ez /= el;
      // e2 = c x e1  (so atan2(d.e2, d.e1) increases CCW viewed from outside)
      const fx = cy * ez - cz * ey, fy = cz * ex - cx * ez, fz = cx * ey - cy * ex;
      for (let k = 0; k < deg; k++) {
        const n = this.nbrs[v * 6 + k];
        const dx = c[n * 3] - cx, dy = c[n * 3 + 1] - cy, dz = c[n * 3 + 2] - cz;
        angScratch[k] = Math.atan2(dx * fx + dy * fy + dz * fz, dx * ex + dy * ey + dz * ez);
        nbrScratch[k] = n;
        idxScratch[k] = k;
      }
      const order = idxScratch.slice(0, deg).sort((p, q) => angScratch[p] - angScratch[q]);
      for (let k = 0; k < deg; k++) this.nbrs[v * 6 + k] = nbrScratch[order[k]];
    }
  }

  // ---------------------------------------------------------------- queries

  degreeOf(id: number): number { return this.degrees[id]; }

  neighbor(id: number, k: number): number { return this.nbrs[id * 6 + k]; }

  center(id: number, out: Float64Array | number[], o = 0): void {
    out[o] = this.centers[id * 3];
    out[o + 1] = this.centers[id * 3 + 1];
    out[o + 2] = this.centers[id * 3 + 2];
  }

  /**
   * Corner k of tile id (between neighbors k and k+1), as a unit vector.
   * Bit-identical across the three tiles sharing the corner.
   */
  cornerUnit(id: number, k: number, out: Float64Array | number[], o = 0): void {
    const deg = this.degrees[id];
    const a = this.nbrs[id * 6 + k];
    const b = this.nbrs[id * 6 + ((k + 1) % deg)];
    // ascending-id summation for float determinism
    let s0 = id, s1 = a, s2 = b, tmp;
    if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
    if (s1 > s2) { tmp = s1; s1 = s2; s2 = tmp; }
    if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
    const c = this.centers;
    const x = c[s0 * 3] + c[s1 * 3] + c[s2 * 3];
    const y = c[s0 * 3 + 1] + c[s1 * 3 + 1] + c[s2 * 3 + 1];
    const z = c[s0 * 3 + 2] + c[s1 * 3 + 2] + c[s2 * 3 + 2];
    const len = Math.hypot(x, y, z);
    out[o] = x / len; out[o + 1] = y / len; out[o + 2] = z / len;
  }

  /** All corners of a tile into out (deg*3 floats). Returns degree. */
  corners(id: number, out: Float64Array): number {
    const deg = this.degrees[id];
    for (let k = 0; k < deg; k++) this.cornerUnit(id, k, out, k * 3);
    return deg;
  }

  /**
   * Tile containing/nearest to direction (x,y,z) (need not be normalized).
   * Spatial *query* only — addressing stays id/neighbor-based.
   */
  tileOf(x: number, y: number, z: number): number {
    const inv = this.ico.faceInv;
    let bestF = 0, bestScore = -Infinity;
    let b0 = 0, b1 = 0, b2 = 0;
    for (let f = 0; f < 20; f++) {
      const q = f * 9;
      const u = inv[q] * x + inv[q + 1] * y + inv[q + 2] * z;
      const v = inv[q + 3] * x + inv[q + 4] * y + inv[q + 5] * z;
      const w = inv[q + 6] * x + inv[q + 7] * y + inv[q + 8] * z;
      const sum = u + v + w;
      if (sum <= 0) continue; // opposite hemisphere for this face plane
      const score = Math.min(u, v, w) / sum;
      if (score > bestScore) { bestScore = score; bestF = f; b0 = u; b1 = v; b2 = w; }
    }
    const m = this.m;
    const wsum = b0 + b1 + b2;
    let i = Math.round((b1 / wsum) * m);
    let j = Math.round((b2 / wsum) * m);
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    if (i > m) i = m;
    if (i + j > m) j = m - i;
    let best = this.pointId(bestF, i, j);
    // hill-climb on dot product (gnomonic rounding can be off near distortion)
    const c = this.centers;
    let bestDot = c[best * 3] * x + c[best * 3 + 1] * y + c[best * 3 + 2] * z;
    for (let iter = 0; iter < 8; iter++) {
      let improved = false;
      const deg = this.degrees[best];
      for (let k = 0; k < deg; k++) {
        const n = this.nbrs[best * 6 + k];
        const d = c[n * 3] * x + c[n * 3 + 1] * y + c[n * 3 + 2] * z;
        if (d > bestDot) { bestDot = d; best = n; improved = true; }
      }
      if (!improved) break;
    }
    return best;
  }

  /**
   * Oriented local surface frame of a tile: outward normal (radial), east toward neighbor 0,
   * north completing the right-handed basis. Purely local — derived from the tile's own
   * center and its first CCW neighbor, no global chart involved.
   */
  frameOf(id: number): { normal: [number, number, number]; east: [number, number, number]; north: [number, number, number] } {
    const c = this.centers;
    const nx = c[id * 3], ny = c[id * 3 + 1], nz = c[id * 3 + 2];
    const n0 = this.nbrs[id * 6];
    let ex = c[n0 * 3] - nx, ey = c[n0 * 3 + 1] - ny, ez = c[n0 * 3 + 2] - nz;
    const d = ex * nx + ey * ny + ez * nz;
    ex -= d * nx; ey -= d * ny; ez -= d * nz;
    const l = Math.hypot(ex, ey, ez);
    ex /= l; ey /= l; ez /= l;
    const tx = ny * ez - nz * ey, ty = nz * ex - nx * ez, tz = nx * ey - ny * ex;
    return { normal: [nx, ny, nz], east: [ex, ey, ez], north: [tx, ty, tz] };
  }
}
