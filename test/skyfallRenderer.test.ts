import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SkyfallRenderer } from '../src/render/skyfall';
import type {
  KilnSkyfallSkinSlug,
  KilnSkyfallSkinTemplate,
  SkyfallSkinProvider,
} from '../src/render/kilnAssets';
import { skyfallProfile, type SkyfallKind, type SkyfallSite } from '../src/sim/skyfall';

const KIND_BY_SLUG: Record<KilnSkyfallSkinSlug, SkyfallKind> = {
  'crater-emberfall': 'emberFall',
  'crater-glassrain': 'glassRain',
  'crater-starbloom': 'starBloom',
};

const SLUG_BY_KIND: Record<SkyfallKind, KilnSkyfallSkinSlug> = {
  emberFall: 'crater-emberfall',
  glassRain: 'crater-glassrain',
  starBloom: 'crater-starbloom',
};

function site(id: number, kind: SkyfallKind): SkyfallSite {
  const profile = skyfallProfile(kind);
  return {
    id,
    day: 0,
    window: id,
    tile: id + 1,
    kind,
    label: profile.label,
    dormantLabel: profile.dormantLabel,
    detail: profile.detail,
    omen: profile.omen,
    reward: profile.reward,
    active: true,
    harvested: false,
    minutesRemaining: 30,
    hint: 'test skyfall',
  };
}

function named(renderer: SkyfallRenderer, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  renderer.group.traverse((child) => {
    if (child.name === name) found = child;
  });
  return found;
}

function visibleNamed(renderer: SkyfallRenderer, name: string): number {
  let count = 0;
  renderer.group.traverse((child) => {
    if (child.name === name && child.visible) count += 1;
  });
  return count;
}

function template(slug: KilnSkyfallSkinSlug): KilnSkyfallSkinTemplate {
  const root = new THREE.Group();
  root.name = `fake-skyfall-template-${slug}`;
  root.add(new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.32, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x7f6b58 }),
  ));
  return {
    slug,
    kind: KIND_BY_SLUG[slug],
    manifest: {
      slug,
      status: 'ready',
      file: `models/${slug}.glb`,
      geometry: { materialCount: 1, meshCount: 1 },
    },
    sourceUrl: `/assets/kiln/models/${slug}.glb`,
    template: root,
    fit: {
      slug,
      kind: KIND_BY_SLUG[slug],
      socketRole: 'skyfall-crater-shell',
      sourceBboxSize: [1.2, 0.32, 1.2],
      runtimeSourceBboxSize: [1.2, 0.32, 1.2],
      normalizedBboxSize: [1.2, 0.32, 1.2],
      normalizePolicy: 'center-xz-bottom-y-fit-footprint-height',
      orientation: { policy: 'preserve-y-up', sourceUpAxis: 'y', axisCorrection: [0, 0, 0] },
      animationPolicy: 'static-shell-with-procedural-omen-overlays',
      sourceUrl: `/assets/kiln/models/${slug}.glb`,
      sourceMeshCount: 1,
      materialCount: 1,
      targetFootprint: 1.875,
      targetHeight: 0.411,
      acceptanceNote: 'fake crater shell',
    },
  };
}

class FakeSkyfallSkins implements SkyfallSkinProvider {
  readonly requested: KilnSkyfallSkinSlug[] = [];

  async createSkyfallSkinTemplate(slug: KilnSkyfallSkinSlug): Promise<KilnSkyfallSkinTemplate | null> {
    this.requested.push(slug);
    return template(slug);
  }
}

class FailingSkyfallSkins implements SkyfallSkinProvider {
  async createSkyfallSkinTemplate(): Promise<KilnSkyfallSkinTemplate | null> {
    return null;
  }
}

async function flushSkinPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('skyfall renderer asset readability', () => {
  it('skins skyfall crater shells with approved GLBs while preserving omen overlays', async () => {
    const scene = new THREE.Scene();
    const provider = new FakeSkyfallSkins();
    const renderer = new SkyfallRenderer(scene, provider);
    const sites = [site(1, 'emberFall'), site(2, 'glassRain'), site(3, 'starBloom')];

    renderer.setSites(sites);
    await flushSkinPromises();
    const stats = renderer.stats();

    expect(provider.requested).toEqual(['crater-emberfall', 'crater-glassrain', 'crater-starbloom']);
    for (const current of sites) {
      const slug = SLUG_BY_KIND[current.kind];
      expect(named(renderer, `kiln-skyfall-skin-${slug}`)).toBeTruthy();
      expect(stats.kilnSkyfallSkinsBySlug[slug]).toMatchObject({ loaded: 1, pending: 0, fallback: 0 });
      expect(stats.kilnSkyfallSkinFits[slug]).toMatchObject({
        kind: current.kind,
        socketRole: 'skyfall-crater-shell',
        animationPolicy: 'static-shell-with-procedural-omen-overlays',
      });
    }
    expect(stats.kilnSkyfallSkinsLoaded).toBe(3);
    expect(stats.kilnSkyfallSkinFallbacks).toBe(0);
    expect(stats.kilnSkyfallGlbMeshesVisible).toBe(3);
    expect(stats.proceduralCraterPartsVisible).toBe(0);
    expect(visibleNamed(renderer, 'skyfallCraterRing')).toBe(0);
    expect(visibleNamed(renderer, 'skyfallCraterRock')).toBe(0);
    expect(visibleNamed(renderer, 'skyfallShard')).toBe(0);
    expect(visibleNamed(renderer, 'skyfallCoreGlow')).toBe(3);
    expect(visibleNamed(renderer, 'skyfallFallingBeam')).toBe(3);
    expect(visibleNamed(renderer, 'skyfallOmenTrail')).toBe(3);
    expect(visibleNamed(renderer, 'skyfallSpark0')).toBe(3);
  });

  it('keeps procedural crater shells visible when Kiln skyfall skins fall back', async () => {
    const scene = new THREE.Scene();
    const renderer = new SkyfallRenderer(scene, new FailingSkyfallSkins());
    const sites = [site(1, 'emberFall'), site(2, 'glassRain'), site(3, 'starBloom')];

    renderer.setSites(sites);
    await flushSkinPromises();
    const stats = renderer.stats();

    expect(stats.kilnSkyfallSkinsLoaded).toBe(0);
    expect(stats.kilnSkyfallSkinFallbacks).toBe(3);
    expect(stats.kilnSkyfallGlbMeshesVisible).toBe(0);
    expect(stats.proceduralCraterPartsVisible).toBeGreaterThan(20);
    expect(visibleNamed(renderer, 'skyfallCraterRing')).toBe(3);
    expect(visibleNamed(renderer, 'skyfallCoreGlow')).toBe(3);
    for (const slug of ['crater-emberfall', 'crater-glassrain', 'crater-starbloom'] as const) {
      expect(stats.kilnSkyfallSkinsBySlug[slug]).toMatchObject({ loaded: 0, pending: 0, fallback: 1 });
    }
  });
});
