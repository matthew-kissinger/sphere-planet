import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type KilnStructureSkinSlug = 'waystone';

type KilnAssetStatus = 'ready' | 'unused' | 'missing';

interface KilnManifestAsset {
  slug: string;
  status: KilnAssetStatus;
  file: string | null;
  title?: string;
  category?: string;
  role?: string;
  geometry?: {
    triangles?: number;
    meshCount?: number;
    bboxLocal?: { size?: number[] };
  };
}

interface KilnManifest {
  assets?: KilnManifestAsset[];
}

interface KilnSkinTransform {
  scale: number;
  position: [number, number, number];
  rotation: [number, number, number];
  hideProceduralNames: readonly string[];
}

interface LoadedKilnAsset {
  slug: KilnStructureSkinSlug;
  manifest: KilnManifestAsset;
  sourceUrl: string;
  template: THREE.Object3D;
  transform: KilnSkinTransform;
}

export interface KilnStructureSkin {
  slug: KilnStructureSkinSlug;
  object: THREE.Group;
  manifest: KilnManifestAsset;
  sourceUrl: string;
  hideProceduralNames: readonly string[];
}

export interface KilnAssetSnapshot {
  enabled: readonly KilnStructureSkinSlug[];
  manifestUrl: string;
  modelRequests: readonly string[];
  manifestLoaded: boolean;
  loaded: readonly KilnStructureSkinSlug[];
  failed: readonly string[];
}

export interface StructureSkinProvider {
  createStructureSkin(slug: KilnStructureSkinSlug): Promise<KilnStructureSkin | null>;
  snapshot?(): KilnAssetSnapshot;
}

const RUNTIME_STRUCTURE_SKINS: Record<KilnStructureSkinSlug, KilnSkinTransform> = {
  waystone: {
    scale: 1.45,
    position: [0, 0.22, 0],
    rotation: [0, 0, 0],
    hideProceduralNames: ['waystoneBase', 'waystoneCore', 'waystoneBand'],
  },
};

function publicAssetUrl(relativePath: string, base = import.meta.env.BASE_URL || '/'): string {
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  return `${cleanBase}${relativePath.replace(/^\/+/, '')}`;
}

function cloneTemplate(template: THREE.Object3D, slug: KilnStructureSkinSlug, transform: KilnSkinTransform): THREE.Group {
  const root = new THREE.Group();
  root.name = `kiln-skin-${slug}`;
  root.userData.kilnAssetSlug = slug;
  root.position.set(...transform.position);
  root.rotation.set(...transform.rotation);
  root.scale.setScalar(transform.scale);

  const body = template.clone(true);
  body.name = `kiln-body-${slug}`;
  body.traverse((child) => {
    child.userData.kilnAssetSlug = slug;
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
    }
  });
  root.add(body);
  return root;
}

export class KilnRuntimeAssets implements StructureSkinProvider {
  private readonly enabled = new Set<KilnStructureSkinSlug>(['waystone']);
  private readonly loader = new GLTFLoader();
  private readonly loaded = new Set<KilnStructureSkinSlug>();
  private readonly failed: string[] = [];
  private readonly modelRequests: string[] = [];
  private manifestPromise: Promise<KilnManifest | null> | null = null;
  private manifestLoaded = false;
  private readonly templates = new Map<KilnStructureSkinSlug, Promise<LoadedKilnAsset | null>>();
  private readonly baseUrl: string;

  readonly manifestUrl: string;

  constructor(baseUrl = import.meta.env.BASE_URL || '/') {
    this.baseUrl = baseUrl;
    this.manifestUrl = publicAssetUrl('assets/kiln/ASSET_MANIFEST.json', baseUrl);
  }

  async createStructureSkin(slug: KilnStructureSkinSlug): Promise<KilnStructureSkin | null> {
    const loaded = await this.loadTemplate(slug);
    if (!loaded) return null;
    const object = cloneTemplate(loaded.template, slug, loaded.transform);
    object.userData.kilnAssetFile = loaded.manifest.file;
    object.userData.kilnAssetSourceUrl = loaded.sourceUrl;
    return {
      slug,
      object,
      manifest: loaded.manifest,
      sourceUrl: loaded.sourceUrl,
      hideProceduralNames: loaded.transform.hideProceduralNames,
    };
  }

  snapshot(): KilnAssetSnapshot {
    return {
      enabled: [...this.enabled],
      manifestUrl: this.manifestUrl,
      modelRequests: [...this.modelRequests],
      manifestLoaded: this.manifestLoaded,
      loaded: [...this.loaded],
      failed: [...this.failed],
    };
  }

  private async loadManifest(): Promise<KilnManifest | null> {
    if (!this.manifestPromise) {
      this.manifestPromise = fetch(this.manifestUrl, { cache: 'force-cache' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Kiln manifest HTTP ${response.status}`);
          const manifest = await response.json() as KilnManifest;
          this.manifestLoaded = true;
          return manifest;
        })
        .catch((err: unknown) => {
          this.failed.push(`manifest: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
    }
    return this.manifestPromise;
  }

  private loadTemplate(slug: KilnStructureSkinSlug): Promise<LoadedKilnAsset | null> {
    if (!this.enabled.has(slug)) return Promise.resolve(null);
    const existing = this.templates.get(slug);
    if (existing) return existing;

    const promise = this.loadManifest()
      .then(async (manifest) => {
        const asset = manifest?.assets?.find((entry) => entry.slug === slug);
        if (!asset || asset.status !== 'ready' || !asset.file) {
          this.failed.push(`${slug}: missing ready manifest record`);
          return null;
        }
        const sourceUrl = publicAssetUrl(`assets/kiln/${asset.file}`, this.baseUrl);
        this.modelRequests.push(sourceUrl);
        const gltf = await this.loader.loadAsync(sourceUrl);
        this.loaded.add(slug);
        return {
          slug,
          manifest: asset,
          sourceUrl,
          template: gltf.scene as unknown as THREE.Object3D,
          transform: RUNTIME_STRUCTURE_SKINS[slug],
        };
      })
      .catch((err: unknown) => {
        this.failed.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

    this.templates.set(slug, promise);
    return promise;
  }
}
