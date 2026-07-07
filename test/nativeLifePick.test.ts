import { describe, expect, it } from 'vitest';
import { pickNativeCreature } from '../src/edit/pick';
import { Goldberg } from '../src/geo/goldberg';
import type { NativeCreatureSite } from '../src/sim/nativeLife';
import { Columns } from '../src/world/columns';
import { buildLayers } from '../src/world/layers';
import { Terrain } from '../src/world/terrain';

function site(tile: number, tended = false, warded = false): NativeCreatureSite {
  return {
    id: 101,
    kind: 'brambleback',
    tile,
    slot: 1,
    label: 'test brambleback',
    detail: 'fixture native-life target',
    temperament: 'territorial',
    reward: { item: 'reeds', count: 2, label: 'fixture reeds' },
    tended,
    warded,
    hint: 'fixture hint',
    pressure: { stamina: 8, exposure: 4, interval: 3, radiusRings: 1, label: 'fixture pressure' },
  };
}

describe('native-life ray picking', () => {
  it('picks visible untended creature capsules before terrain ownership', () => {
    const geo = new Goldberg(8);
    const layers = buildLayers();
    const terrain = new Terrain('native-life-pick');
    const columns = new Columns(geo, layers, terrain);
    const tile = 0;
    const c = geo.centers;
    const nx = c[tile * 3];
    const ny = c[tile * 3 + 1];
    const nz = c[tile * 3 + 2];
    const ground = layers.topRadius(columns.groundLayerBelow(tile, layers.bounds[0]));

    const hit = pickNativeCreature(
      geo,
      layers,
      columns,
      [site(tile)],
      nx * (ground + 7),
      ny * (ground + 7),
      nz * (ground + 7),
      -nx,
      -ny,
      -nz,
      20,
    );

    expect(hit).toMatchObject({ tile, site: { id: 101, kind: 'brambleback' } });
    expect(hit!.dist).toBeGreaterThan(4);
    expect(hit!.dist).toBeLessThan(8);
  });

  it('keeps resolved visible encounters pickable but ignores ray misses', () => {
    const geo = new Goldberg(8);
    const layers = buildLayers();
    const terrain = new Terrain('native-life-pick-miss');
    const columns = new Columns(geo, layers, terrain);
    const tile = 0;
    const frame = geo.frameOf(tile);
    const c = geo.centers;
    const nx = c[tile * 3];
    const ny = c[tile * 3 + 1];
    const nz = c[tile * 3 + 2];
    const ground = layers.topRadius(columns.groundLayerBelow(tile, layers.bounds[0]));

    expect(pickNativeCreature(geo, layers, columns, [site(tile, false, true)], nx * (ground + 7), ny * (ground + 7), nz * (ground + 7), -nx, -ny, -nz, 20))
      .toMatchObject({ site: { warded: true } });
    expect(pickNativeCreature(
      geo,
      layers,
      columns,
      [site(tile)],
      nx * (ground + 7) + frame.east[0] * 3,
      ny * (ground + 7) + frame.east[1] * 3,
      nz * (ground + 7) + frame.east[2] * 3,
      -nx,
      -ny,
      -nz,
      20,
    )).toBeNull();
  });
});
