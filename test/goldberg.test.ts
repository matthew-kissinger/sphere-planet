import { describe, expect, it } from 'vitest';
import { ICO } from '../src/geo/icosahedron';
import { Goldberg } from '../src/geo/goldberg';
import { mulberry32 } from '../src/util/prng';

describe('icosahedron', () => {
  it('has 12 unit vertices, 20 outward-CCW faces, 30 edges', () => {
    expect(ICO.verts.length).toBe(36);
    for (let v = 0; v < 12; v++) {
      const len = Math.hypot(ICO.verts[v * 3], ICO.verts[v * 3 + 1], ICO.verts[v * 3 + 2]);
      expect(len).toBeCloseTo(1, 12);
    }
    expect(ICO.faces.length).toBe(60);
    expect(ICO.edges.length).toBe(60);
    // winding: (B-A)x(C-A) . centroid > 0
    for (let f = 0; f < 20; f++) {
      const [a, b, c] = [ICO.faces[f * 3], ICO.faces[f * 3 + 1], ICO.faces[f * 3 + 2]];
      const V = ICO.verts;
      const abx = V[b * 3] - V[a * 3], aby = V[b * 3 + 1] - V[a * 3 + 1], abz = V[b * 3 + 2] - V[a * 3 + 2];
      const acx = V[c * 3] - V[a * 3], acy = V[c * 3 + 1] - V[a * 3 + 1], acz = V[c * 3 + 2] - V[a * 3 + 2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      const dot = nx * (V[a * 3] + V[b * 3] + V[c * 3]) + ny * (V[a * 3 + 1] + V[b * 3 + 1] + V[c * 3 + 1]) + nz * (V[a * 3 + 2] + V[b * 3 + 2] + V[c * 3 + 2]);
      expect(dot).toBeGreaterThan(0);
    }
    // every vertex belongs to exactly 5 faces
    const counts = new Array(12).fill(0);
    for (let i = 0; i < 60; i++) counts[ICO.faces[i]]++;
    for (const c of counts) expect(c).toBe(5);
  });
});

describe('goldberg topology', () => {
  it('tile count is 10m^2+2 with exactly 12 pentagons (ids 0..11)', () => {
    for (const m of [1, 2, 3, 8]) {
      const g = new Goldberg(m);
      expect(g.count).toBe(10 * m * m + 2);
      let pentagons = 0;
      for (let id = 0; id < g.count; id++) {
        const d = g.degreeOf(id);
        expect(d === 5 || d === 6).toBe(true);
        if (d === 5) {
          pentagons++;
          expect(id).toBeLessThan(12);
        }
      }
      expect(pentagons).toBe(12);
    }
  });

  it('neighbor lists are symmetric and duplicate-free (m=8)', () => {
    const g = new Goldberg(8);
    for (let id = 0; id < g.count; id++) {
      const deg = g.degreeOf(id);
      const seen = new Set<number>();
      for (let k = 0; k < deg; k++) {
        const n = g.neighbor(id, k);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(seen.has(n)).toBe(false);
        seen.add(n);
        // symmetry
        let back = false;
        for (let q = 0; q < g.degreeOf(n); q++) if (g.neighbor(n, q) === id) back = true;
        expect(back).toBe(true);
      }
      // padding
      for (let k = deg; k < 6; k++) expect(g.nbrs[id * 6 + k]).toBe(-1);
    }
  });

  it('pointId/repOf round-trip over every lattice point (m=5)', () => {
    const m = 5;
    const g = new Goldberg(m);
    for (let f = 0; f < 20; f++) {
      for (let i = 0; i <= m; i++) {
        for (let j = 0; j <= m - i; j++) {
          const id = g.pointId(f, i, j);
          expect(id).toBeGreaterThanOrEqual(0);
          expect(id).toBeLessThan(g.count);
          const rep = g.repOf(id);
          expect(g.pointId(rep.f, rep.i, rep.j)).toBe(id);
        }
      }
    }
    // every id reachable exactly once via reps
    const seen = new Set<number>();
    for (let f = 0; f < 20; f++) {
      for (let i = 0; i <= m; i++) {
        for (let j = 0; j <= m - i; j++) {
          const id = g.pointId(f, i, j);
          const rep = g.repOf(id);
          if (rep.f === f && rep.i === i && rep.j === j) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
        }
      }
    }
    expect(seen.size).toBe(g.count);
  });

  it('seam positions agree between adjacent faces (m=5)', () => {
    const m = 5;
    const g = new Goldberg(m);
    const V = ICO.verts, F = ICO.faces;
    for (let f = 0; f < 20; f++) {
      const A = F[f * 3], B = F[f * 3 + 1], C = F[f * 3 + 2];
      for (let i = 0; i <= m; i++) {
        for (let j = 0; j <= m - i; j++) {
          const id = g.pointId(f, i, j);
          const w0 = (m - i - j) / m, w1 = i / m, w2 = j / m;
          let x = w0 * V[A * 3] + w1 * V[B * 3] + w2 * V[C * 3];
          let y = w0 * V[A * 3 + 1] + w1 * V[B * 3 + 1] + w2 * V[C * 3 + 1];
          let z = w0 * V[A * 3 + 2] + w1 * V[B * 3 + 2] + w2 * V[C * 3 + 2];
          const l = Math.hypot(x, y, z);
          x /= l; y /= l; z /= l;
          const dx = x - g.centers[id * 3], dy = y - g.centers[id * 3 + 1], dz = z - g.centers[id * 3 + 2];
          expect(Math.hypot(dx, dy, dz)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('corners wind CCW, close the boundary, and are bit-identical across sharing tiles (m=8)', () => {
    const g = new Goldberg(8);
    const corners = new Float64Array(18);
    const nCorners = new Float64Array(18);
    const cornerKeys = new Set<string>();
    for (let id = 0; id < g.count; id++) {
      const deg = g.corners(id, corners);
      const cx = g.centers[id * 3], cy = g.centers[id * 3 + 1], cz = g.centers[id * 3 + 2];
      let angleSum = 0;
      for (let k = 0; k < deg; k++) {
        const k1 = (k + 1) % deg;
        const ax = corners[k * 3], ay = corners[k * 3 + 1], az = corners[k * 3 + 2];
        const bx = corners[k1 * 3], by = corners[k1 * 3 + 1], bz = corners[k1 * 3 + 2];
        // CCW from outside: (a x b) . center > 0
        const crx = ay * bz - az * by, cry = az * bx - ax * bz, crz = ax * by - ay * bx;
        expect(crx * cx + cry * cy + crz * cz).toBeGreaterThan(0);
        angleSum += Math.acos(Math.min(1, ax * bx + ay * by + az * bz));
        cornerKeys.add(`${ax.toFixed(14)},${ay.toFixed(14)},${az.toFixed(14)}`);
      }
      expect(angleSum).toBeGreaterThan(0);
      // shared corners with each neighbor: exactly two, float-identical
      for (let e = 0; e < deg; e++) {
        const n = g.neighbor(id, e);
        const nDeg = g.corners(n, nCorners);
        let shared = 0;
        for (let k = 0; k < deg; k++) {
          for (let q = 0; q < nDeg; q++) {
            if (
              corners[k * 3] === nCorners[q * 3] &&
              corners[k * 3 + 1] === nCorners[q * 3 + 1] &&
              corners[k * 3 + 2] === nCorners[q * 3 + 2]
            ) shared++;
          }
        }
        expect(shared).toBe(2);
      }
    }
    // dual of geodesic: exactly 20*m^2 distinct corners (triangles)
    expect(cornerKeys.size).toBe(20 * 8 * 8);
  });

  it('tileOf matches brute-force nearest center (m=16, 4000 seeded dirs)', () => {
    const g = new Goldberg(16);
    const rand = mulberry32(12345);
    for (let s = 0; s < 4000; s++) {
      const z = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const x = r * Math.cos(phi), y = r * Math.sin(phi);
      let best = -1, bestDot = -Infinity;
      for (let id = 0; id < g.count; id++) {
        const d = g.centers[id * 3] * x + g.centers[id * 3 + 1] * y + g.centers[id * 3 + 2] * z;
        if (d > bestDot) { bestDot = d; best = id; }
      }
      expect(g.tileOf(x, y, z)).toBe(best);
    }
  });

  it('builds the production-size planet (m=128, 163842 tiles)', () => {
    const g = new Goldberg(128);
    expect(g.count).toBe(163842);
    let pent = 0;
    for (let id = 0; id < 12; id++) if (g.degreeOf(id) === 5) pent++;
    expect(pent).toBe(12);
    // eslint-disable-next-line no-console
    console.log(`m=128 topology build: ${g.buildMs.toFixed(1)} ms`);
  });
});
