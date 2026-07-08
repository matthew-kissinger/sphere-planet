import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Goldberg } from '../src/geo/goldberg';
import { FishSchoolRenderer, kilnFishSkinForSchool, type FishSchoolVisualSite } from '../src/render/fishSchools';
import type {
  FishSkinProvider,
  KilnFishSkinSlug,
  KilnFishSkinTemplate,
} from '../src/render/kilnAssets';
import type { FishSchoolReport } from '../src/sim/fishing';
import { WATER_SURFACE } from '../src/world/layers';
import { buildLayers } from '../src/world/layers';
import { Columns } from '../src/world/columns';
import { Terrain } from '../src/world/terrain';

const SCHOOL_BY_SLUG: Record<KilnFishSkinSlug, FishSchoolReport['kind']> = {
  'fish-shore-minnow': 'shore',
  'fish-storm-runner': 'storm',
  'fish-cave-shimmer': 'cave',
  'creature-driftjelly': 'run',
  'fish-reed-fry': 'run',
};

function school(kind: FishSchoolReport['kind'], label = `${kind} school`, catchCount = 2): FishSchoolReport {
  return {
    kind,
    label,
    strength: 0.72,
    catchCount,
    baitUseful: true,
    usesBait: false,
    message: label,
  };
}

function template(slug: KilnFishSkinSlug): KilnFishSkinTemplate {
  const root = new THREE.Group();
  root.name = `fake-template-${slug}`;
  root.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.14, 0.72),
    new THREE.MeshStandardMaterial({ color: 0x8bb7c8 }),
  ));
  const clipNames = slug === 'creature-driftjelly'
    ? ['idle', 'swim', 'turn', 'pulse']
    : slug === 'fish-reed-fry'
    ? ['idle', 'swim', 'turn']
    : ['idle', 'swim', 'turn', 'dart'];
  return {
    slug,
    schoolKind: SCHOOL_BY_SLUG[slug],
    manifest: {
      slug,
      status: 'ready',
      file: `models/${slug}.glb`,
      geometry: { materialCount: 1, meshCount: 1 },
      animations: clipNames.map((name) => ({ name, channels: 2, durationSec: 1 })),
    },
    sourceUrl: `/assets/kiln/models/${slug}.glb`,
    template: root,
    clips: clipNames.map((name) => new THREE.AnimationClip(name, 1, [])),
    fit: {
      slug,
      schoolKind: SCHOOL_BY_SLUG[slug],
      socketRole: 'fish-school-body',
      sourceBboxSize: [0.24, 0.14, 0.72],
      runtimeSourceBboxSize: [0.24, 0.14, 0.72],
      orientedSourceBboxSize: [0.24, 0.14, 0.72],
      normalizedBboxSize: [0.24, 0.14, 0.72],
      normalizePolicy: 'center-xyz-fit-length-longest-axis-forward',
      orientation: { policy: 'longest-axis-to-z', sourceUpAxis: 'z', axisCorrection: [0, 0, 0] },
      animationPolicy: 'single-animated-anchors-plus-point-school-near-freeze-far',
      sourceUrl: `/assets/kiln/models/${slug}.glb`,
      sourceMeshCount: 1,
      materialCount: 1,
      animationClips: clipNames.map((name) => ({ name, channels: 2, durationSec: 1 })),
      activeMixerRadius: 110,
      lowRateMixerRadius: 165,
      frozenMixerRadius: 230,
      acceptanceNote: 'fake fish template',
    },
  };
}

class FakeFishSkins implements FishSkinProvider {
  readonly requested: KilnFishSkinSlug[] = [];

  async createFishSkinTemplate(slug: KilnFishSkinSlug): Promise<KilnFishSkinTemplate | null> {
    this.requested.push(slug);
    return template(slug);
  }
}

async function flushSkinPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function fixtureWorld() {
  const geo = new Goldberg(8);
  const layers = buildLayers();
  const terrain = new Terrain('fish-school-renderer');
  const columns = new Columns(geo, layers, terrain);
  return { geo, layers, columns };
}

function cameraAtTile(geo: Goldberg, tile: number): { x: number; y: number; z: number } {
  const c = geo.centers;
  return {
    x: c[tile * 3] * WATER_SURFACE,
    y: c[tile * 3 + 1] * WATER_SURFACE,
    z: c[tile * 3 + 2] * WATER_SURFACE,
  };
}

describe('fish school renderer', () => {
  it('maps existing fishing schools to approved singleton fish bodies', () => {
    expect(kilnFishSkinForSchool(school('shore', 'shore nibble', 1))).toBe('fish-shore-minnow');
    expect(kilnFishSkinForSchool(school('dock', 'dockside fish run', 2))).toBe('fish-shore-minnow');
    expect(kilnFishSkinForSchool(school('storm', 'storm fish run', 3))).toBe('fish-storm-runner');
    expect(kilnFishSkinForSchool(school('cave', 'cave fish shimmer', 2))).toBe('fish-cave-shimmer');
    expect(kilnFishSkinForSchool(school('run', 'salt-tide fish run', 3))).toBe('creature-driftjelly');
    expect(kilnFishSkinForSchool(school('run', 'reed-water fish run', 3))).toBe('fish-reed-fry');
    expect(kilnFishSkinForSchool(school('none', 'quiet water', 0))).toBeNull();
  });

  it('loads GLB fish anchors, point-school sprites, and distance-gates mixer work', async () => {
    const scene = new THREE.Scene();
    const provider = new FakeFishSkins();
    const renderer = new FishSchoolRenderer(scene, provider);
    const { geo, layers, columns } = fixtureWorld();
    const site: FishSchoolVisualSite = { id: 123, tile: 4, school: school('storm', 'storm fish run', 3) };

    renderer.setSchool(site);
    await flushSkinPromises();
    renderer.update(site, geo, layers, columns, cameraAtTile(geo, site.tile), 2.4);
    const near = renderer.stats();

    expect(provider.requested).toEqual(['fish-storm-runner']);
    expect(near).toMatchObject({
      active: 1,
      slug: 'fish-storm-runner',
      kilnFishSkinsLoaded: 1,
      kilnFishSkinsPending: 0,
      kilnFishSkinFallbacks: 0,
      glbAnchors: 2,
      glbAnchorsVisible: 2,
      fallbackVisible: 0,
      activeMixers: 2,
      motionPolicy: 'two-glb-anchors-plus-near-only-analytic-boids-freeze-far',
      motionBand: 'nearBoids',
    });
    expect(near.pointSchoolSprites).toBeGreaterThanOrEqual(20);
    expect(near.nearBoidSprites).toBe(near.pointSchoolSprites);
    expect(near.swimPathVisible).toBe(1);
    expect(near.swimPathBeads).toBeGreaterThanOrEqual(12);
    expect(near.swimPathLength).toBeGreaterThan(0.75);
    expect(near.schoolSpread).toBeGreaterThan(0.25);
    expect(near.kilnFishSkinsBySlug['fish-storm-runner']).toMatchObject({
      loaded: 1,
      activeMixers: 2,
      visibleAnchors: 2,
      clips: ['idle', 'swim', 'turn', 'dart'],
    });
    expect(near.kilnFishSkinFits['fish-storm-runner']).toMatchObject({
      animationPolicy: 'single-animated-anchors-plus-point-school-near-freeze-far',
      activeMixerRadius: 110,
      lowRateMixerRadius: 165,
      frozenMixerRadius: 230,
    });

    const cam = cameraAtTile(geo, site.tile);
    renderer.update(site, geo, layers, columns, { x: cam.x + 135, y: cam.y, z: cam.z }, 2.7);
    const low = renderer.stats();
    expect(low.activeMixers).toBe(0);
    expect(low.lowRateMixers).toBe(2);
    expect(low.motionBand).toBe('frozenCloud');
    expect(low.nearBoidSprites).toBe(0);
    expect(low.swimPathVisible).toBe(0);
    expect(low.swimPathBeads).toBe(0);
    expect(low.pointSchoolSprites).toBeGreaterThan(0);

    renderer.update(site, geo, layers, columns, { x: cam.x + 360, y: cam.y, z: cam.z }, 3);
    const hidden = renderer.stats();
    expect(hidden.active).toBe(0);
    expect(hidden.glbAnchorsVisible).toBe(0);
    expect(hidden.pointSchoolSprites).toBe(0);
    expect(hidden.nearBoidSprites).toBe(0);
    expect(hidden.swimPathVisible).toBe(0);
    expect(hidden.swimPathBeads).toBe(0);
    expect(hidden.motionBand).toBe('hidden');
  });
});
