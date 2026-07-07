import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type KilnStructureSkinSlug = 'waystone' | 'door-kit' | 'window-frame' | 'roof-bundle';

type KilnAssetStatus = 'ready' | 'unused' | 'missing';

interface KilnManifestAsset {
  slug: string;
  status: KilnAssetStatus;
  file: string | null;
  bytes?: number;
  title?: string;
  category?: string;
  role?: string;
  instanceability?: string;
  modularKit?: boolean;
  wiringRisk?: string;
  geometry?: {
    triangles?: number;
    meshCount?: number;
    nodeCount?: number;
    materialCount?: number;
    bboxLocal?: { size?: number[] };
  };
}

interface KilnManifest {
  assets?: KilnManifestAsset[];
}

interface KilnSkinTransform {
  scale: number | [number, number, number];
  fitSourceSize?: [number, number, number];
  position: [number, number, number];
  rotation: [number, number, number];
  hideProceduralNames: readonly string[];
  socket: {
    item: string;
    role: string;
    gridWidth: number;
    gridDepth: number;
    height: number;
    loadBearing: 'code-socket';
    glbPolicy: 'decorative-skin-after-normalization';
  };
  acceptanceNote: string;
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
  fit: KilnSkinFitSnapshot;
}

export interface KilnSkinFitSnapshot {
  slug: KilnStructureSkinSlug;
  item: string;
  socketRole: string;
  sourceBboxSize: readonly number[];
  fittedBboxSize: readonly number[];
  scale: number | readonly [number, number, number];
  runtimeSourceBboxSize?: readonly number[];
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  loadBearing: 'code-socket';
  glbPolicy: 'decorative-skin-after-normalization';
  instanceability?: string;
  modularKit?: boolean;
  acceptanceNote: string;
  sourceUrl: string;
}

export interface KilnAssetSnapshot {
  enabled: readonly KilnStructureSkinSlug[];
  manifestUrl: string;
  modelRequests: readonly string[];
  manifestLoaded: boolean;
  loaded: readonly KilnStructureSkinSlug[];
  failed: readonly string[];
  structureSkins: Partial<Record<KilnStructureSkinSlug, Omit<KilnSkinFitSnapshot, 'fittedBboxSize' | 'sourceUrl'>>>;
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
    socket: {
      item: 'waystone',
      role: 'route-marker',
      gridWidth: 0.62,
      gridDepth: 0.62,
      height: 1.25,
      loadBearing: 'code-socket',
      glbPolicy: 'decorative-skin-after-normalization',
    },
    acceptanceNote: 'accepted as decorative route-marker shell; procedural glyph overlays remain authoritative',
  },
  'door-kit': {
    scale: [1, 1, 1],
    fitSourceSize: [1, 1.9, 0.22],
    position: [0, 0.95, 0],
    rotation: [0, 0, 0],
    hideProceduralNames: ['leftJamb', 'rightJamb', 'lintel', 'doorSlab', 'knob'],
    socket: {
      item: 'doorKit',
      role: 'wall-opening',
      gridWidth: 1,
      gridDepth: 0.22,
      height: 1.9,
      loadBearing: 'code-socket',
      glbPolicy: 'decorative-skin-after-normalization',
    },
    acceptanceNote: 'conditionally accepted as flattened decorative door skin; snap, opening, and collider stay code-authored',
  },
  'window-frame': {
    scale: [1, 1, 1],
    fitSourceSize: [0.18, 1.45, 0.92],
    position: [0, 0.72, 0],
    rotation: [0, Math.PI / 2, 0],
    hideProceduralNames: ['topRail', 'bottomRail', 'leftRail', 'rightRail', 'glassPane'],
    socket: {
      item: 'windowFrame',
      role: 'wall-light',
      gridWidth: 0.92,
      gridDepth: 0.18,
      height: 1.45,
      loadBearing: 'code-socket',
      glbPolicy: 'decorative-skin-after-normalization',
    },
    acceptanceNote: 'conditionally accepted despite C instanceability by remapping wide local Z to wall width; warm-light overlay remains procedural',
  },
  'roof-bundle': {
    scale: [1, 1, 1],
    fitSourceSize: [1.12, 0.62, 1.12],
    position: [0, 0.54, 0],
    rotation: [0, 0, 0],
    hideProceduralNames: ['leftRoofPlane', 'rightRoofPlane', 'ridgeBeam'],
    socket: {
      item: 'roofBundle',
      role: 'roof-cap',
      gridWidth: 1.12,
      gridDepth: 1.12,
      height: 0.62,
      loadBearing: 'code-socket',
      glbPolicy: 'decorative-skin-after-normalization',
    },
    acceptanceNote: 'conditionally accepted as roof-cap decoration only; shelter coverage and glow remain procedural proof surfaces',
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
  root.userData.kilnSocketItem = transform.socket.item;
  root.userData.kilnSocketRole = transform.socket.role;
  root.userData.kilnAcceptanceNote = transform.acceptanceNote;
  root.position.set(...transform.position);
  root.rotation.set(...transform.rotation);
  if (Array.isArray(transform.scale)) root.scale.set(...transform.scale);
  else root.scale.setScalar(transform.scale);

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

function fittedSize(object: THREE.Object3D): number[] {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return [0, 0, 0];
  const size = new THREE.Vector3();
  box.getSize(size);
  return [size.x, size.y, size.z].map((value) => Number(value.toFixed(3)));
}

function resolveTransform(base: KilnSkinTransform, template: THREE.Object3D): KilnSkinTransform {
  if (!base.fitSourceSize) return base;
  const source = fittedSize(template);
  const scale = base.fitSourceSize.map((target, index) => {
    const size = source[index] ?? 0;
    return size > 0 ? Number((target / size).toFixed(4)) : 1;
  }) as [number, number, number];
  return { ...base, scale };
}

function sourceBboxSize(manifest: KilnManifestAsset): number[] {
  return manifest.geometry?.bboxLocal?.size?.map((value) => Number(value.toFixed(3))) ?? [];
}

function policySnapshot(
  slug: KilnStructureSkinSlug,
  transform: KilnSkinTransform,
  manifest: KilnManifestAsset,
  template?: THREE.Object3D,
): Omit<KilnSkinFitSnapshot, 'fittedBboxSize' | 'sourceUrl'> {
  return {
    slug,
    item: transform.socket.item,
    socketRole: transform.socket.role,
    sourceBboxSize: sourceBboxSize(manifest),
    runtimeSourceBboxSize: template ? fittedSize(template) : undefined,
    scale: transform.scale,
    position: transform.position,
    rotation: transform.rotation,
    loadBearing: transform.socket.loadBearing,
    glbPolicy: transform.socket.glbPolicy,
    instanceability: manifest.instanceability,
    modularKit: manifest.modularKit,
    acceptanceNote: transform.acceptanceNote,
  };
}

export class KilnRuntimeAssets implements StructureSkinProvider {
  private readonly enabled = new Set<KilnStructureSkinSlug>(['waystone', 'door-kit', 'window-frame', 'roof-bundle']);
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
    const fit: KilnSkinFitSnapshot = {
      ...policySnapshot(slug, loaded.transform, loaded.manifest, loaded.template),
      fittedBboxSize: fittedSize(object),
      sourceUrl: loaded.sourceUrl,
    };
    object.userData.kilnSkinFit = fit;
    return {
      slug,
      object,
      manifest: loaded.manifest,
      sourceUrl: loaded.sourceUrl,
      hideProceduralNames: loaded.transform.hideProceduralNames,
      fit,
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
      structureSkins: Object.fromEntries(
        [...this.enabled].map((slug) => {
          const transform = RUNTIME_STRUCTURE_SKINS[slug];
          return [slug, policySnapshot(slug, transform, { slug, status: 'ready', file: null })];
        }),
      ),
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
        const transform = resolveTransform(RUNTIME_STRUCTURE_SKINS[slug], gltf.scene as unknown as THREE.Object3D);
        this.loaded.add(slug);
        return {
          slug,
          manifest: asset,
          sourceUrl,
          template: gltf.scene as unknown as THREE.Object3D,
          transform,
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
