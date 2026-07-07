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

function previewObject(renderer: StructureRenderer, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  renderer.snapPreviewGroup.traverse((part) => {
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

  it('renders functional shelter warmth and comfort signals from the room report', () => {
    const scene = new THREE.Scene();
    const geo = new Goldberg(8);
    const layers = buildLayers();
    const renderer = new StructureRenderer(scene);
    const homeTile = Array.from({ length: geo.count }, (_, tile) => tile).find((tile) => geo.degreeOf(tile) >= 6);
    if (homeTile === undefined) throw new Error('test Goldberg lacks a six-neighbor home tile');
    const local = Array.from({ length: geo.degreeOf(homeTile) }, (_, edge) => geo.neighbor(homeTile, edge));
    const structures: StructureSave[] = [
      { id: 1, item: 'bedroll', tile: homeTile, layer: 100, yaw: 0, state: { home: true } },
      { id: 2, item: 'roofBundle', tile: local[0], layer: 100, yaw: 0 },
      { id: 3, item: 'roofBundle', tile: local[1], layer: 100, yaw: 0 },
      { id: 4, item: 'doorKit', tile: local[2], layer: 100, yaw: 0 },
      { id: 5, item: 'campfire', tile: local[3], layer: 100, yaw: 0, state: { lit: true } },
      { id: 6, item: 'workbench', tile: local[4], layer: 100, yaw: 0 },
      { id: 7, item: 'chest', tile: local[5], layer: 100, yaw: 0 },
    ];

    renderer.setStructures(structures);
    renderer.update(structures, geo, layers, { x: 0, y: 0, z: 0 }, 1.25);
    const stats = renderer.stats();

    expect(namedObject(renderer, 'homeComfortRing')?.visible).toBe(true);
    expect(namedObject(renderer, 'hearthWarmthHalo')?.visible).toBe(true);
    expect(namedObject(renderer, 'roofShelterGlow')?.visible).toBe(true);
    expect(stats.homeComfortSignals).toBeGreaterThanOrEqual(4);
    expect(stats.shelterReadabilityRoles).toBeGreaterThanOrEqual(3);
    expect(stats.homeComfort).toMatchObject({
      visibleWarmthMeshes: 4,
      visibleLightMeshes: 1,
      visibleHomeMarkers: 1,
      visibleSmokePuffs: 6,
      litCampfires: 1,
      litLanterns: 0,
    });
    expect([...readabilityRoles(renderer)]).toEqual(expect.arrayContaining([
      'functional shelter comfort ring',
      'warmth radius from lit shelter fire',
      'roof coverage shelter glow',
    ]));
  });

  it('renders valid and blocked snap previews without adding saved structure groups', () => {
    const scene = new THREE.Scene();
    const geo = new Goldberg(8);
    const layers = buildLayers();
    const renderer = new StructureRenderer(scene);
    const structures: StructureSave[] = [
      { id: 1, item: 'doorKit', tile: 1, layer: 100, yaw: 0 },
    ];

    renderer.setStructures(structures);
    renderer.update(structures, geo, layers, { x: 0, y: 0, z: 0 }, 1);
    renderer.updateSnapPreview({
      active: true,
      mode: 'place',
      ok: true,
      item: 'windowFrame',
      tile: 2,
      layer: 100,
      yaw: Math.PI / 3,
      turn: 1,
      message: 'Window frame can snap here',
      blocker: null,
      blockers: [],
      socket: {
        item: 'windowFrame',
        name: 'Window frame',
        role: 'wall-light',
        modularKit: true,
        gridWidth: 0.92,
        gridDepth: 0.18,
        height: 1.45,
        pivot: 'wall-center',
        collider: 'thin-wall',
        snap: ['front edge on hex face'],
        visualScale: 'test',
        loadBearing: 'code-socket',
        glbPolicy: 'decorative-skin-after-normalization',
      },
    }, geo, layers, { x: 0, y: 0, z: 0 }, 1.1);

    expect(renderer.stats()).toMatchObject({
      groups: 1,
      snapPreview: {
        active: true,
        ok: true,
        mode: 'place',
        item: 'windowFrame',
        tile: 2,
        blocker: null,
      },
    });
    expect(renderer.stats().snapPreview.meshes).toBeGreaterThan(2);
    expect(renderer.stats().snapPreview.readabilityRoles).toBeGreaterThanOrEqual(3);
    expect(previewObject(renderer, 'snapPreviewFootprint')?.visible).toBe(true);
    expect(previewObject(renderer, 'snapPreviewBlockerA')?.visible).toBe(false);

    renderer.updateSnapPreview({
      active: true,
      mode: 'relocate',
      ok: false,
      item: 'doorKit',
      id: 1,
      tile: 1,
      layer: 100,
      yaw: 0,
      turn: 0,
      fromTile: 1,
      fromLayer: 100,
      message: 'door kit already on that snap hex',
      blocker: 'same snap target',
      blockers: ['same snap target'],
      socket: {
        item: 'doorKit',
        name: 'Door kit',
        role: 'wall-opening',
        modularKit: true,
        gridWidth: 1,
        gridDepth: 0.22,
        height: 1.9,
        pivot: 'wall-center',
        collider: 'thin-wall',
        snap: ['front edge on hex face'],
        visualScale: 'test',
        loadBearing: 'code-socket',
        glbPolicy: 'decorative-skin-after-normalization',
      },
    }, geo, layers, { x: 0, y: 0, z: 0 }, 1.2);

    expect(renderer.stats()).toMatchObject({
      groups: 1,
      snapPreview: {
        active: true,
        ok: false,
        mode: 'relocate',
        item: 'doorKit',
        tile: 1,
        blocker: 'same snap target',
      },
    });
    expect(previewObject(renderer, 'snapPreviewBlockerA')?.visible).toBe(true);
    expect(previewObject(renderer, 'snapPreviewBlockerB')?.visible).toBe(true);

    renderer.updateSnapPreview(null, geo, layers, { x: 0, y: 0, z: 0 }, 1.3);
    expect(renderer.stats().snapPreview.active).toBe(false);
    expect(renderer.stats().groups).toBe(1);
  });
});
