/**
 * Whole-planet far view: a coarse geodesic mesh (frequency 96, ~92k verts / ~184k tris)
 * sampling the *same* terrain field and palette as the fine world, sunk 6 m below the
 * true surface so near chunks always draw on top.
 *
 * It is small, built once (sliced across frames behind the splash), and always resident —
 * the orbit view never waits on streaming, and the horizon silhouette is a ~550-segment
 * circle (sub-pixel sag at any zoom). Triangles fully covered by resident chunks are
 * filtered out of the index so mined pits never show a phantom coarse surface inside them;
 * partially covered boundary triangles overlap harmlessly underneath.
 */

import * as THREE from 'three/webgpu';
import { Goldberg } from '../geo/goldberg';
import { PLANET_RADIUS } from '../world/layers';
import type { Terrain } from '../world/terrain';
import { materialColor } from './palette';
import { chunkKeyOfTile } from '../world/chunks';

export const FAR_MARGIN = 6;
const MAX_CHUNK_KEY = 20 * 4096;

export class FarSphere {
  readonly mesh: THREE.Mesh;
  readonly triangles: number;
  private readonly fullIndex: Uint32Array;
  private readonly triChunkKey: Uint32Array; // 3 keys per triangle (one per vertex)
  private readonly geometry: THREE.BufferGeometry;
  private readonly indexAttr: THREE.BufferAttribute;
  private readonly residentLut = new Uint8Array(MAX_CHUNK_KEY);
  readonly buildMs: number;

  private constructor(
    geometry: THREE.BufferGeometry, indexAttr: THREE.BufferAttribute,
    fullIndex: Uint32Array, triChunkKey: Uint32Array, material: THREE.Material, buildMs: number,
  ) {
    this.geometry = geometry;
    this.indexAttr = indexAttr;
    this.fullIndex = fullIndex;
    this.triChunkKey = triChunkKey;
    this.triangles = fullIndex.length / 3;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.buildMs = buildMs;
  }

  static async build(
    coarse: Goldberg, fine: Goldberg, terrain: Terrain, material: THREE.Material,
    onProgress?: (frac: number) => Promise<void>,
  ): Promise<FarSphere> {
    const t0 = performance.now();
    const N = coarse.count;
    const positions = new Float32Array(N * 3);
    const normals = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const vertChunkKey = new Uint32Array(N);
    const c = coarse.centers;
    const colScratch = new Float32Array(3);
    const SLICE = 16384;
    for (let start = 0; start < N; start += SLICE) {
      const end = Math.min(N, start + SLICE);
      for (let id = start; id < end; id++) {
        const x = c[id * 3], y = c[id * 3 + 1], z = c[id * 3 + 2];
        const h = terrain.heightAt(x, y, z);
        const r = PLANET_RADIUS + h - FAR_MARGIN;
        positions[id * 3] = x * r;
        positions[id * 3 + 1] = y * r;
        positions[id * 3 + 2] = z * r;
        normals[id * 3] = x; normals[id * 3 + 1] = y; normals[id * 3 + 2] = z;
        materialColor(terrain.surfaceMaterial(h), id, coarse.degreeOf(id) === 5, colScratch);
        colors[id * 3] = colScratch[0]; colors[id * 3 + 1] = colScratch[1]; colors[id * 3 + 2] = colScratch[2];
        const fineTile = fine.tileOf(x, y, z);
        vertChunkKey[id] = chunkKeyOfTile(fine, fineTile);
      }
      if (onProgress) await onProgress(end / N * 0.8);
    }

    // triangles = goldberg corners: triple (tile, nbr k, nbr k+1), deduped by sorted key
    const triSet = new Set<number>();
    const tris: number[] = [];
    for (let id = 0; id < N; id++) {
      const deg = coarse.degreeOf(id);
      for (let k = 0; k < deg; k++) {
        const a = coarse.neighbor(id, k);
        const b = coarse.neighbor(id, (k + 1) % deg);
        let s0 = id, s1 = a, s2 = b, tmp;
        if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
        if (s1 > s2) { tmp = s1; s1 = s2; s2 = tmp; }
        if (s0 > s1) { tmp = s0; s0 = s1; s1 = tmp; }
        const key = (s0 * N + s1) * N + s2;
        if (triSet.has(key)) continue;
        triSet.add(key);
        const ax = c[s0 * 3], ay = c[s0 * 3 + 1], az = c[s0 * 3 + 2];
        const bx = c[s1 * 3], by = c[s1 * 3 + 1], bz = c[s1 * 3 + 2];
        const cx = c[s2 * 3], cy = c[s2 * 3 + 1], cz = c[s2 * 3 + 2];
        const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (nx * ax + ny * ay + nz * az >= 0) tris.push(s0, s1, s2);
        else tris.push(s0, s2, s1);
      }
    }
    if (onProgress) await onProgress(0.92);
    const fullIndex = Uint32Array.from(tris);
    const triCount = fullIndex.length / 3;
    const triChunkKey = new Uint32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      triChunkKey[t * 3] = vertChunkKey[fullIndex[t * 3]];
      triChunkKey[t * 3 + 1] = vertChunkKey[fullIndex[t * 3 + 1]];
      triChunkKey[t * 3 + 2] = vertChunkKey[fullIndex[t * 3 + 2]];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const indexAttr = new THREE.BufferAttribute(fullIndex.slice(), 1);
    geometry.setIndex(indexAttr);
    geometry.computeBoundingSphere();
    if (onProgress) await onProgress(1);
    return new FarSphere(geometry, indexAttr, fullIndex, triChunkKey, material, performance.now() - t0);
  }

  /** Hide coarse triangles fully underneath resident fine chunks. */
  setResidentChunks(keys: ReadonlySet<number>): void {
    this.residentLut.fill(0);
    for (const k of keys) if (k < MAX_CHUNK_KEY) this.residentLut[k] = 1;
    const lut = this.residentLut;
    const idx = this.indexAttr.array as Uint32Array;
    let n = 0;
    for (let t = 0; t < this.triangles; t++) {
      const covered =
        lut[this.triChunkKey[t * 3]] === 1 &&
        lut[this.triChunkKey[t * 3 + 1]] === 1 &&
        lut[this.triChunkKey[t * 3 + 2]] === 1;
      if (covered) continue;
      idx[n * 3] = this.fullIndex[t * 3];
      idx[n * 3 + 1] = this.fullIndex[t * 3 + 1];
      idx[n * 3 + 2] = this.fullIndex[t * 3 + 2];
      n++;
    }
    this.geometry.setDrawRange(0, n * 3);
    this.indexAttr.needsUpdate = true;
  }
}
