import { describe, expect, it } from 'vitest';
import { materialColor } from '../src/render/palette';
import { MAT } from '../src/world/terrain';

const MATERIALS = Object.values(MAT);

function colorOf(mat: number, tile: number, pentagon = false): [number, number, number] {
  const out = [0, 0, 0];
  materialColor(mat, tile, pentagon, out);
  return out as [number, number, number];
}

function roundedKey(color: readonly number[]): string {
  return color.map((value) => value.toFixed(4)).join(',');
}

describe('terrain material palette', () => {
  it('is deterministic and bounded for every terrain material', () => {
    for (const mat of MATERIALS) {
      for (const tile of [0, 1, 7, 42, 4096, 65535]) {
        const a = colorOf(mat, tile);
        const b = colorOf(mat, tile);
        expect(a).toEqual(b);
        for (const channel of a) {
          expect(Number.isFinite(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('creates controlled material-specific swatches without changing material ownership', () => {
    for (const mat of MATERIALS) {
      const keys = new Set(Array.from({ length: 24 }, (_, index) => roundedKey(colorOf(mat, index * 37 + 11))));
      expect(keys.size).toBeGreaterThanOrEqual(3);
    }
    const grass = roundedKey(colorOf(MAT.GRASS, 99));
    const sand = roundedKey(colorOf(MAT.SAND, 99));
    const snow = roundedKey(colorOf(MAT.SNOW, 99));
    const rock = roundedKey(colorOf(MAT.ROCK, 99));
    expect(new Set([grass, sand, snow, rock]).size).toBe(4);
  });

  it('keeps the pentagon warm boost bounded', () => {
    const normal = colorOf(MAT.GRASS, 12, false);
    const pentagon = colorOf(MAT.GRASS, 12, true);
    expect(pentagon[0]).toBeGreaterThanOrEqual(normal[0]);
    expect(pentagon[1]).toBeGreaterThanOrEqual(normal[1]);
    for (const channel of pentagon) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});
