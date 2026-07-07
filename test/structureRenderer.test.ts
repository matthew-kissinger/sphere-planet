import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Goldberg } from '../src/geo/goldberg';
import { StructureRenderer } from '../src/render/structures';
import type { StructureSkinProvider } from '../src/render/kilnAssets';
import type { StructureSave } from '../src/sim/structures';
import { buildLayers } from '../src/world/layers';

function meshNames(renderer: StructureRenderer): Set<string> {
  const names = new Set<string>();
  renderer.group.traverse((part) => {
    if ((part as THREE.Mesh).isMesh) names.add(part.name);
  });
  return names;
}

function readabilityRoles(renderer: StructureRenderer): Set<string> {
  const roles = new Set<string>();
  renderer.group.traverse((part) => {
    const role = part.userData.structureReadabilityRole;
    if (typeof role === 'string') roles.add(role);
  });
  return roles;
}

function namedObject(renderer: StructureRenderer, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  renderer.group.traverse((part) => {
    if (part.name === name) found = part;
  });
  return found;
}

async function flushAsyncSkinLoads(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeKilnAssets implements StructureSkinProvider {
  async createStructureSkin() {
    const object = new THREE.Group();
    object.name = 'kiln-skin-waystone';
    object.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    return {
      slug: 'waystone' as const,
      object,
      manifest: { slug: 'waystone', status: 'ready' as const, file: 'models/waystone.glb' },
      sourceUrl: '/assets/kiln/models/waystone.glb',
      hideProceduralNames: ['waystoneBase', 'waystoneCore', 'waystoneBand'],
    };
  }
}

describe('structure renderer asset readability', () => {
  it('gives cave anchors and waystones distinct route-marker glyph roles', () => {
    const scene = new THREE.Scene();
    const geo = new Goldberg(8);
    const layers = buildLayers();
    const renderer = new StructureRenderer(scene);
    const structures: StructureSave[] = [
      { id: 1, item: 'waystone', tile: 1, layer: 100, yaw: 0, state: { waystone: 'survey', markerUses: 1 } },
      { id: 2, item: 'waystone', tile: 2, layer: 100, yaw: 0, state: { waystone: 'home', markerUses: 1 } },
      { id: 3, item: 'waystone', tile: 3, layer: 100, yaw: 0, state: { waystone: 'cave', markerUses: 1 } },
      { id: 4, item: 'waystone', tile: 4, layer: 100, yaw: 0, state: { waystone: 'shore', markerUses: 1 } },
      { id: 5, item: 'waystone', tile: 5, layer: 100, yaw: 0, state: { waystone: 'forage', markerUses: 1 } },
      { id: 6, item: 'caveAnchor', tile: 6, layer: 100, yaw: 0, state: { anchorUses: 1, anchorKind: 'arch', anchorFlooded: false, anchorSpring: false } },
      { id: 7, item: 'caveAnchor', tile: 7, layer: 100, yaw: 0, state: { anchorUses: 1, anchorKind: 'dryCave', anchorFlooded: false, anchorSpring: true } },
      { id: 8, item: 'caveAnchor', tile: 8, layer: 100, yaw: 0, state: { anchorUses: 1, anchorKind: 'seaCave', anchorFlooded: true, anchorSpring: false } },
    ];

    renderer.setStructures(structures);
    renderer.update(structures, geo, layers, { x: 0, y: 0, z: 0 }, 0.5);
    const stats = renderer.stats();

    expect(stats.groups).toBe(8);
    expect(stats.routeSilhouettes).toBe(2);
    expect(stats.routeReadabilityRoles).toBeGreaterThanOrEqual(18);
    expect([...meshNames(renderer)]).toEqual(expect.arrayContaining([
      'waystoneGlyph-survey',
      'waystoneGlyph-home',
      'waystoneGlyph-cave',
      'waystoneGlyph-shore',
      'waystoneGlyph-forage',
      'caveAnchorGlyph-arch',
      'caveAnchorGlyph-dryCave',
      'caveAnchorGlyph-seaCave',
      'caveAnchorSpringMark',
      'caveAnchorFloodMark',
    ]));
    expect([...readabilityRoles(renderer)]).toEqual(expect.arrayContaining([
      'survey bearing needle',
      'home roof chevron',
      'cave arch lintel',
      'shore wave bar',
      'forage leaf sprout',
      'walk-under arch glyph',
      'dark dry-cave mouth glyph',
      'sea-cave waterline glyph',
      'freshwater spring bead',
      'set-anchor flood marker',
      'coiled return rope',
    ]));
  });

  it('skins waystones with Kiln GLB bodies while preserving attuned glyph overlays', async () => {
    const scene = new THREE.Scene();
    const geo = new Goldberg(8);
    const layers = buildLayers();
    const renderer = new StructureRenderer(scene, new FakeKilnAssets());
    const structures: StructureSave[] = [
      { id: 1, item: 'waystone', tile: 1, layer: 100, yaw: 0, state: { waystone: 'home', markerUses: 1 } },
    ];

    renderer.setStructures(structures);
    await flushAsyncSkinLoads();
    renderer.update(structures, geo, layers, { x: 0, y: 0, z: 0 }, 0.5);

    expect(namedObject(renderer, 'kiln-skin-waystone')).toBeTruthy();
    expect(namedObject(renderer, 'waystoneBase')?.visible).toBe(false);
    expect(namedObject(renderer, 'waystoneCore')?.visible).toBe(false);
    expect(namedObject(renderer, 'waystoneBand')?.visible).toBe(false);
    expect(namedObject(renderer, 'waystoneGlyph-home')?.visible).toBe(true);
    expect(namedObject(renderer, 'waystoneGlyph-survey')?.visible).toBe(false);
    expect(renderer.stats().kilnSkinsLoaded).toBe(1);
    expect(renderer.stats().kilnSkinFallbacks).toBe(0);
  });
});
