/**
 * Canonical icosahedron: 12 vertices, 20 faces, 30 edges.
 * Face winding is *enforced* CCW-viewed-from-outside at module init (not trusted from the table),
 * and edge/vertex "owner faces" give every shared lattice feature a single canonical home.
 */

export interface Icosahedron {
  /** 12 unit vertices, xyz interleaved */
  verts: Float64Array;
  /** 20 faces * 3 vertex indices, CCW viewed from outside */
  faces: Int32Array;
  /** 30 edges * 2 vertex indices, lo < hi, sorted lexicographically */
  edges: Int32Array;
  /** edgeIndexOf[lo*12+hi] -> edge index, -1 if not an edge */
  edgeIndexLut: Int32Array;
  /** for each of 12 vertices: the lowest face index that contains it */
  vertexOwnerFace: Int32Array;
  /** for each of 30 edges: the lower face index of its two adjacent faces */
  edgeOwnerFace: Int32Array;
  /** for each face: inverse of the 3x3 matrix [A B C] (columns), row-major. For barycentric queries. */
  faceInv: Float64Array;
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function buildIcosahedron(): Icosahedron {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const verts = new Float64Array(36);
  for (let i = 0; i < 12; i++) {
    const [x, y, z] = raw[i];
    const len = Math.hypot(x, y, z);
    verts[i * 3] = x / len;
    verts[i * 3 + 1] = y / len;
    verts[i * 3 + 2] = z / len;
  }

  const faceTable = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const faces = new Int32Array(60);
  for (let f = 0; f < 20; f++) {
    let [a, b, c] = faceTable[f];
    // Enforce outward CCW winding: (B-A)x(C-A) must point away from origin.
    const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
    const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
    const cx = verts[c * 3], cy = verts[c * 3 + 1], cz = verts[c * 3 + 2];
    const [nx, ny, nz] = cross(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
    const centroidDot = nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz);
    if (centroidDot < 0) { const tmp = b; b = c; c = tmp; }
    faces[f * 3] = a; faces[f * 3 + 1] = b; faces[f * 3 + 2] = c;
  }

  // Edges: unique sorted pairs, ordered lexicographically for stable indexing.
  const edgeSet = new Set<number>();
  for (let f = 0; f < 20; f++) {
    for (let s = 0; s < 3; s++) {
      const a = faces[f * 3 + s];
      const b = faces[f * 3 + ((s + 1) % 3)];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      edgeSet.add(lo * 12 + hi);
    }
  }
  const edgeKeys = [...edgeSet].sort((x, y) => x - y);
  if (edgeKeys.length !== 30) throw new Error(`icosahedron: expected 30 edges, got ${edgeKeys.length}`);
  const edges = new Int32Array(60);
  const edgeIndexLut = new Int32Array(144).fill(-1);
  edgeKeys.forEach((key, e) => {
    const lo = Math.floor(key / 12), hi = key % 12;
    edges[e * 2] = lo; edges[e * 2 + 1] = hi;
    edgeIndexLut[lo * 12 + hi] = e;
    edgeIndexLut[hi * 12 + lo] = e;
  });

  const vertexOwnerFace = new Int32Array(12).fill(-1);
  const edgeOwnerFace = new Int32Array(30).fill(-1);
  for (let f = 0; f < 20; f++) {
    for (let s = 0; s < 3; s++) {
      const a = faces[f * 3 + s];
      const b = faces[f * 3 + ((s + 1) % 3)];
      if (vertexOwnerFace[a] === -1) vertexOwnerFace[a] = f;
      const e = edgeIndexLut[a * 12 + b];
      if (edgeOwnerFace[e] === -1) edgeOwnerFace[e] = f;
    }
  }

  // Per-face inverse matrix for barycentric solves: M = [A|B|C] columns; store M^-1 row-major.
  const faceInv = new Float64Array(20 * 9);
  for (let f = 0; f < 20; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    const m = [
      verts[a * 3], verts[b * 3], verts[c * 3],
      verts[a * 3 + 1], verts[b * 3 + 1], verts[c * 3 + 1],
      verts[a * 3 + 2], verts[b * 3 + 2], verts[c * 3 + 2],
    ];
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[1] * (m[3] * m[8] - m[5] * m[6]) +
      m[2] * (m[3] * m[7] - m[4] * m[6]);
    const inv = [
      (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
      (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
      (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
    ];
    faceInv.set(inv, f * 9);
  }

  return { verts, faces, edges, edgeIndexLut, vertexOwnerFace, edgeOwnerFace, faceInv };
}

export const ICO = buildIcosahedron();
