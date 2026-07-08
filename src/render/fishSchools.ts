import * as THREE from 'three/webgpu';
import type { Goldberg } from '../geo/goldberg';
import type { FishSchoolReport } from '../sim/fishing';
import type { Columns } from '../world/columns';
import type { Layers } from '../world/layers';
import { WATER_SURFACE } from '../world/layers';
import {
  FISH_ACTIVE_MIXER_RADIUS,
  FISH_FROZEN_MIXER_RADIUS,
  FISH_LOW_RATE_MIXER_RADIUS,
  type FishSkinProvider,
  type KilnFishSkinFitSnapshot,
  type KilnFishSkinSlug,
  type KilnFishSkinTemplate,
} from './kilnAssets';
import { makeSurfaceBasisFromYaw } from './surfaceFrame';

export interface FishSchoolVisualSite {
  id: number;
  tile: number;
  school: FishSchoolReport;
}

type FishSkinStatus = 'pending' | 'loaded' | 'fallback';
type FishAnimationBand = 'active' | 'lowRate' | 'frozen' | 'hidden';
type FishMotionBand = 'nearBoids' | 'frozenCloud' | 'hidden';

interface FishAnchorRecord {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  actions: Map<string, THREE.AnimationAction>;
  currentClip: string | null;
  lastMixerSeconds: number;
  lastLowRateStepSeconds: number;
  band: FishAnimationBand;
}

export const KILN_FISH_SKIN_SLUGS: readonly KilnFishSkinSlug[] = [
  'fish-shore-minnow',
  'fish-storm-runner',
  'fish-cave-shimmer',
  'creature-driftjelly',
  'fish-reed-fry',
];

const MAX_POINT_SPRITES = 32;
const MAX_SWIM_PATH_BEADS = 14;
const FISH_MOTION_POLICY = 'two-glb-anchors-plus-near-only-analytic-boids-freeze-far' as const;

function schoolColor(slug: KilnFishSkinSlug): number {
  if (slug === 'fish-storm-runner') return 0xa3e2f2;
  if (slug === 'fish-cave-shimmer') return 0x72d6ce;
  if (slug === 'creature-driftjelly') return 0xb38bed;
  if (slug === 'fish-reed-fry') return 0x9dcc7a;
  return 0x8bb7c8;
}

export function kilnFishSkinForSchool(school: FishSchoolReport): KilnFishSkinSlug | null {
  if (school.kind === 'none' || school.catchCount <= 0) return null;
  if (school.kind === 'cave') return 'fish-cave-shimmer';
  if (school.kind === 'storm') return 'fish-storm-runner';
  if (school.kind === 'run') {
    const label = school.label.toLowerCase();
    if (label.includes('salt') || label.includes('tide')) return 'creature-driftjelly';
    if (label.includes('reed') || label.includes('water')) return 'fish-reed-fry';
    return 'fish-storm-runner';
  }
  return 'fish-shore-minnow';
}

function mat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02, emissive: color, emissiveIntensity: 0.04 });
}

const fishBody = new THREE.SphereGeometry(0.5, 9, 6);
const fishTail = new THREE.ConeGeometry(0.5, 0.8, 7);

function makeFallbackFish(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'fish-school-fallback-body';
  const body = new THREE.Mesh(fishBody, mat(0x8bb7c8));
  body.name = 'fallbackFishBody';
  body.scale.set(0.28, 0.16, 0.42);
  const tail = new THREE.Mesh(fishTail, mat(0x5f8da5));
  tail.name = 'fallbackFishTail';
  tail.position.set(0, 0, 0.42);
  tail.scale.set(0.11, 0.22, 0.11);
  tail.rotation.x = Math.PI / 2;
  group.add(body, tail);
  group.visible = false;
  return group;
}

export class FishSchoolRenderer {
  readonly group = new THREE.Group();
  private readonly fallback = makeFallbackFish();
  private readonly pointPositions = new Float32Array(MAX_POINT_SPRITES * 3);
  private readonly swimPathPositions = new Float32Array(MAX_SWIM_PATH_BEADS * 3);
  private readonly pointsGeometry = new THREE.BufferGeometry();
  private readonly swimPathGeometry = new THREE.BufferGeometry();
  private readonly pointsMaterial = new THREE.PointsMaterial({
    color: 0x8bb7c8,
    size: 0.13,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  private readonly swimPathMaterial = new THREE.PointsMaterial({
    color: 0x8bb7c8,
    size: 0.22,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.66,
    depthWrite: false,
  });
  private readonly points: THREE.Points;
  private readonly swimPath: THREE.Points;
  private readonly skinTemplates = new Map<KilnFishSkinSlug, KilnFishSkinTemplate>();
  private readonly skinPromises = new Map<KilnFishSkinSlug, Promise<KilnFishSkinTemplate | null>>();
  private readonly skinStatus = new Map<KilnFishSkinSlug, FishSkinStatus>();
  private readonly anchors: FishAnchorRecord[] = [];
  private currentSite: FishSchoolVisualSite | null = null;
  private currentSlug: KilnFishSkinSlug | null = null;
  private currentAnchorCount = 0;
  private visibleSlug: KilnFishSkinSlug | null = null;
  private pointSpriteCount = 0;
  private nearBoidSpriteCount = 0;
  private swimPathBeadCount = 0;
  private motionBand: FishMotionBand = 'hidden';
  private swimPathLength = 0;
  private schoolSpread = 0;

  constructor(scene: THREE.Scene, private readonly fishSkins?: FishSkinProvider) {
    this.group.name = 'fish-school-visuals';
    this.pointsGeometry.setAttribute('position', new THREE.BufferAttribute(this.pointPositions, 3));
    this.pointsGeometry.setDrawRange(0, 0);
    this.swimPathGeometry.setAttribute('position', new THREE.BufferAttribute(this.swimPathPositions, 3));
    this.swimPathGeometry.setDrawRange(0, 0);
    this.swimPath = new THREE.Points(this.swimPathGeometry, this.swimPathMaterial);
    this.swimPath.name = 'fish-school-swim-path-beads';
    this.swimPath.frustumCulled = false;
    this.swimPath.visible = false;
    this.points = new THREE.Points(this.pointsGeometry, this.pointsMaterial);
    this.points.name = 'fish-school-point-sprites';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.group.add(this.swimPath, this.fallback, this.points);
    this.group.visible = false;
    scene.add(this.group);
  }

  setSchool(site: FishSchoolVisualSite | null): void {
    this.currentSite = site && site.school.kind !== 'none' && site.school.catchCount > 0 ? site : null;
    if (!this.currentSite) {
      this.group.visible = false;
      this.points.visible = false;
      this.swimPath.visible = false;
      this.fallback.visible = false;
      this.pointSpriteCount = 0;
      this.nearBoidSpriteCount = 0;
      this.swimPathBeadCount = 0;
      this.motionBand = 'hidden';
      return;
    }
    const slug = kilnFishSkinForSchool(this.currentSite.school);
    this.visibleSlug = slug;
    if (!slug) {
      this.group.visible = false;
      return;
    }
    this.pointsMaterial.color.setHex(schoolColor(slug));
    this.swimPathMaterial.color.setHex(schoolColor(slug));
    this.ensureSkin(slug);
    const template = this.skinTemplates.get(slug);
    if (template) {
      this.ensureAnchors(this.currentSite, template);
      this.fallback.visible = false;
    } else if (!this.fishSkins || this.skinStatus.get(slug) === 'fallback') {
      this.disposeAnchors();
      this.fallback.visible = true;
    }
  }

  private ensureSkin(slug: KilnFishSkinSlug): void {
    if (this.skinTemplates.has(slug)) {
      this.skinStatus.set(slug, 'loaded');
      return;
    }
    if (!this.fishSkins) {
      this.skinStatus.set(slug, 'fallback');
      return;
    }
    if (this.skinPromises.has(slug)) {
      this.skinStatus.set(slug, 'pending');
      return;
    }
    this.skinStatus.set(slug, 'pending');
    const promise = this.fishSkins.createFishSkinTemplate(slug)
      .then((template) => {
        this.skinPromises.delete(slug);
        if (!template) {
          this.skinStatus.set(slug, 'fallback');
          return null;
        }
        this.skinTemplates.set(slug, template);
        this.skinStatus.set(slug, 'loaded');
        return template;
      })
      .catch(() => {
        this.skinPromises.delete(slug);
        this.skinStatus.set(slug, 'fallback');
        return null;
      });
    this.skinPromises.set(slug, promise);
  }

  private disposeAnchors(): void {
    for (const record of this.anchors) {
      record.mixer.stopAllAction();
      record.mixer.uncacheRoot(record.root);
      this.group.remove(record.root);
    }
    this.anchors.length = 0;
    this.currentSlug = null;
    this.currentAnchorCount = 0;
  }

  private ensureAnchors(site: FishSchoolVisualSite, template: KilnFishSkinTemplate): void {
    const desired = Math.max(1, Math.min(2, Math.trunc(site.school.catchCount)));
    if (this.currentSlug === template.slug && this.currentAnchorCount === desired) return;
    this.disposeAnchors();
    this.currentSlug = template.slug;
    this.currentAnchorCount = desired;
    for (let i = 0; i < desired; i += 1) {
      const root = template.template.clone(true);
      root.name = `kiln-fish-${template.slug}-${i}`;
      root.userData.kilnAssetSlug = template.slug;
      root.userData.kilnFishSchoolKind = template.schoolKind;
      root.userData.kilnFishSkinFit = template.fit;
      root.traverse((child) => {
        child.userData.kilnAssetSlug = template.slug;
        child.userData.kilnFishSchoolKind = template.schoolKind;
      });
      const mixer = new THREE.AnimationMixer(root);
      const clips = new Map(template.clips.map((clip) => [clip.name, clip]));
      this.anchors.push({
        root,
        mixer,
        clips,
        actions: new Map(),
        currentClip: null,
        lastMixerSeconds: 0,
        lastLowRateStepSeconds: 0,
        band: 'hidden',
      });
      this.group.add(root);
    }
  }

  private updateSwimPath(site: FishSchoolVisualSite, flowSeconds: number, pathLength: number, spread: number, visible: boolean): void {
    if (!visible) {
      this.swimPathGeometry.setDrawRange(0, 0);
      this.swimPath.visible = false;
      this.swimPathBeadCount = 0;
      return;
    }
    const count = MAX_SWIM_PATH_BEADS;
    this.swimPathBeadCount = count;
    for (let i = 0; i < count; i += 1) {
      const t = count > 1 ? i / (count - 1) : 0.5;
      const phase = site.id * 0.018 + i * 0.57 + flowSeconds * 0.82;
      this.swimPathPositions[i * 3] = Math.sin(phase) * spread * 0.18;
      this.swimPathPositions[i * 3 + 1] = 0.04 + Math.cos(phase * 1.3) * 0.022;
      this.swimPathPositions[i * 3 + 2] = (t - 0.5) * pathLength;
    }
    this.swimPathGeometry.setDrawRange(0, count);
    this.swimPathGeometry.attributes.position.needsUpdate = true;
    this.swimPath.visible = true;
  }

  private updatePoints(site: FishSchoolVisualSite, slug: KilnFishSkinSlug, seconds: number, distance: number): void {
    const strength = Math.max(0, Math.min(1, site.school.strength));
    const count = Math.max(8, Math.min(MAX_POINT_SPRITES, 8 + Math.trunc(site.school.catchCount * 5 + strength * 10)));
    const nearBoids = distance <= FISH_ACTIVE_MIXER_RADIUS;
    const flowSeconds = nearBoids ? seconds : 0;
    const drift = slug === 'creature-driftjelly';
    const pathLength = (drift ? 0.42 : 0.64) + strength * (drift ? 0.28 : 0.46) + Math.min(0.28, site.school.catchCount * 0.045);
    const spread = (drift ? 0.2 : 0.16) + strength * 0.18 + Math.min(0.12, site.school.catchCount * 0.018);
    const schoolTurn = Math.sin(flowSeconds * 0.41 + site.id * 0.017) * (nearBoids ? 0.18 : 0);
    this.swimPathLength = pathLength;
    this.schoolSpread = spread;
    this.motionBand = nearBoids ? 'nearBoids' : 'frozenCloud';
    this.nearBoidSpriteCount = nearBoids ? count : 0;
    this.pointSpriteCount = count;
    this.updateSwimPath(site, flowSeconds, pathLength, spread, nearBoids);
    for (let i = 0; i < count; i += 1) {
      const lane = (i % 7) - 3;
      const row = Math.floor(i / 7);
      const t = count > 1 ? i / (count - 1) : 0.5;
      const phase = site.id * 0.021 + i * 1.713 + flowSeconds * (0.72 + strength * 0.34 + (i % 5) * 0.018);
      const laneOffset = lane * spread * 0.2;
      const separation = Math.sin(phase * 1.43) * spread * 0.08;
      const cohesion = Math.cos(flowSeconds * 0.27 + row * 0.83 + site.id * 0.007) * spread * 0.09;
      const vertical = drift
        ? Math.sin(phase * 1.12 + row) * (0.04 + strength * 0.04)
        : Math.sin(phase * 1.7 + i * 0.17) * (0.035 + strength * 0.03);
      this.pointPositions[i * 3] = laneOffset + separation + cohesion;
      this.pointPositions[i * 3 + 1] = 0.02 + vertical + row * 0.004;
      this.pointPositions[i * 3 + 2] = (t - 0.5) * pathLength + Math.cos(phase) * spread * 0.18 + lane * schoolTurn * 0.035;
    }
    this.pointsGeometry.setDrawRange(0, count);
    this.pointsGeometry.attributes.position.needsUpdate = true;
    this.points.visible = true;
  }

  private updateAnchorAnimation(record: FishAnchorRecord, site: FishSchoolVisualSite, slug: KilnFishSkinSlug, distance: number, seconds: number): void {
    const desiredBand: FishAnimationBand =
      distance <= FISH_ACTIVE_MIXER_RADIUS ? 'active'
      : distance <= FISH_LOW_RATE_MIXER_RADIUS ? 'lowRate'
      : distance <= FISH_FROZEN_MIXER_RADIUS ? 'frozen'
      : 'hidden';
    record.band = desiredBand;
    record.root.visible = desiredBand !== 'hidden';
    const desiredClip = slug === 'creature-driftjelly'
      ? (site.school.strength >= 0.45 ? 'swim' : 'pulse')
      : site.school.catchCount <= 1 && site.school.strength < 0.45
      ? 'idle'
      : 'swim';
    const clip = record.clips.get(desiredClip)
      ?? record.clips.get('swim')
      ?? record.clips.get('pulse')
      ?? record.clips.get('idle')
      ?? [...record.clips.values()][0];
    if (!clip) return;
    let action = record.actions.get(clip.name);
    if (!action) {
      action = record.mixer.clipAction(clip);
      record.actions.set(clip.name, action);
    }
    if (record.currentClip !== clip.name) {
      if (record.currentClip) record.actions.get(record.currentClip)?.fadeOut(0.12);
      action.reset().fadeIn(0.12).play();
      record.currentClip = clip.name;
    }
    const dt = record.lastMixerSeconds > 0 ? Math.max(0, Math.min(0.05, seconds - record.lastMixerSeconds)) : 1 / 60;
    record.lastMixerSeconds = seconds;
    const shouldStepLowRate = desiredBand === 'lowRate' && seconds - record.lastLowRateStepSeconds >= 0.24;
    for (const ownedAction of record.actions.values()) ownedAction.paused = desiredBand !== 'active' && !shouldStepLowRate;
    if (desiredBand === 'active') {
      record.mixer.update(dt);
    } else if (shouldStepLowRate) {
      record.mixer.update(Math.min(0.08, Math.max(0.016, seconds - record.lastLowRateStepSeconds)));
      record.lastLowRateStepSeconds = seconds;
      for (const ownedAction of record.actions.values()) ownedAction.paused = true;
    }
  }

  update(
    site: FishSchoolVisualSite | null,
    geo: Goldberg,
    _layers: Layers,
    _columns: Columns,
    camWorld: { x: number; y: number; z: number },
    seconds: number,
  ): void {
    this.setSchool(site);
    if (!this.currentSite || !this.visibleSlug) return;
    const tile = Math.max(0, Math.min(geo.count - 1, Math.trunc(this.currentSite.tile)));
    const c = geo.centers;
    const frame = geo.frameOf(tile);
    const swimBob = Math.sin(seconds * 1.45 + this.currentSite.id * 0.17) * 0.035;
    const radius = WATER_SURFACE + 0.08 + swimBob;
    this.group.position.set(
      c[tile * 3] * radius - camWorld.x,
      c[tile * 3 + 1] * radius - camWorld.y,
      c[tile * 3 + 2] * radius - camWorld.z,
    );
    const distance = this.group.position.length();
    const active = distance <= FISH_FROZEN_MIXER_RADIUS;
    this.group.visible = active;
    if (!active) {
      this.points.visible = false;
      this.swimPath.visible = false;
      this.fallback.visible = false;
      this.group.scale.setScalar(1);
      this.pointSpriteCount = 0;
      this.nearBoidSpriteCount = 0;
      this.swimPathBeadCount = 0;
      this.motionBand = 'hidden';
      for (const record of this.anchors) {
        record.band = 'hidden';
        record.root.visible = false;
      }
      return;
    }
    const nearBoids = distance <= FISH_ACTIVE_MIXER_RADIUS;
    const flowSeconds = nearBoids ? seconds : 0;
    this.group.scale.setScalar(nearBoids ? 1.55 : 1);
    const yaw = this.currentSite.id * 0.013 + flowSeconds * 0.18;
    const vX = new THREE.Vector3();
    const vY = new THREE.Vector3();
    const vZ = new THREE.Vector3();
    this.group.setRotationFromMatrix(makeSurfaceBasisFromYaw(frame, yaw, new THREE.Matrix4(), vX, vY, vZ));
    this.updatePoints(this.currentSite, this.visibleSlug, seconds, distance);
    if (this.fallback.visible) {
      this.fallback.position.set(0, 0.04, Math.sin(flowSeconds * 1.3) * 0.08);
      this.fallback.rotation.y = Math.sin(flowSeconds * 2.1) * 0.26;
      this.fallback.scale.setScalar(1 + Math.sin(flowSeconds * 2.7) * 0.03);
    }
    for (let i = 0; i < this.anchors.length; i += 1) {
      const record = this.anchors[i];
      const strength = Math.max(0, Math.min(1, this.currentSite.school.strength));
      const drift = this.visibleSlug === 'creature-driftjelly';
      const phase = flowSeconds * (drift ? 0.72 + i * 0.1 : 1.05 + i * 0.17) + this.currentSite.id * 0.031 + i * 1.7;
      const lane = i === 0 ? -0.08 : 0.12;
      const lead = i === 0 ? 0.18 : -0.18;
      const path = (drift ? 0.42 : 0.62) + strength * (drift ? 0.2 : 0.34);
      record.root.position.set(
        lane + Math.cos(phase * 0.83) * (0.045 + i * 0.025),
        0.04 + Math.sin(phase * (drift ? 1.1 : 1.7)) * (drift ? 0.085 : 0.055),
        lead + Math.sin(phase) * path * 0.32,
      );
      record.root.rotation.set(0, Math.sin(phase * 1.23) * (drift ? 0.18 : 0.32) + i * 0.18, 0);
      record.root.scale.setScalar(1 + i * 0.08 + Math.sin(phase * 1.9) * 0.025);
      this.updateAnchorAnimation(record, this.currentSite, this.visibleSlug, distance, seconds);
    }
  }

  stats(): {
    active: number;
    slug: KilnFishSkinSlug | null;
    schoolKind: string;
    label: string;
    motionPolicy: typeof FISH_MOTION_POLICY;
    motionBand: FishMotionBand;
    pointSchoolSprites: number;
    nearBoidSprites: number;
    swimPathVisible: number;
    swimPathBeads: number;
    swimPathLength: number;
    schoolSpread: number;
    glbAnchors: number;
    glbAnchorsVisible: number;
    fallbackVisible: number;
    activeMixers: number;
    lowRateMixers: number;
    frozenMixers: number;
    hiddenFishSkins: number;
    activeMixerRadius: number;
    lowRateMixerRadius: number;
    frozenMixerRadius: number;
    kilnFishSkinsLoaded: number;
    kilnFishSkinsPending: number;
    kilnFishSkinFallbacks: number;
    kilnFishSkinsBySlug: Partial<Record<KilnFishSkinSlug, {
      loaded: number;
      pending: number;
      fallback: number;
      clips: readonly string[];
      activeMixers: number;
      lowRateMixers: number;
      frozenMixers: number;
      hidden: number;
      visibleAnchors: number;
    }>>;
    kilnFishSkinFits: Partial<Record<KilnFishSkinSlug, KilnFishSkinFitSnapshot>>;
  } {
    const bySlug: Partial<Record<KilnFishSkinSlug, {
      loaded: number;
      pending: number;
      fallback: number;
      clips: readonly string[];
      activeMixers: number;
      lowRateMixers: number;
      frozenMixers: number;
      hidden: number;
      visibleAnchors: number;
    }>> = {};
    const fits: Partial<Record<KilnFishSkinSlug, KilnFishSkinFitSnapshot>> = {};
    let activeMixers = 0;
    let lowRateMixers = 0;
    let frozenMixers = 0;
    let hiddenFishSkins = 0;
    let visibleAnchors = 0;
    for (const slug of KILN_FISH_SKIN_SLUGS) {
      const status = this.skinStatus.get(slug);
      const template = this.skinTemplates.get(slug);
      const records = this.currentSlug === slug ? this.anchors : [];
      const row = {
        loaded: template ? 1 : 0,
        pending: status === 'pending' ? 1 : 0,
        fallback: status === 'fallback' ? 1 : 0,
        clips: template?.clips.map((clip) => clip.name) ?? [],
        activeMixers: records.filter((record) => record.band === 'active').length,
        lowRateMixers: records.filter((record) => record.band === 'lowRate').length,
        frozenMixers: records.filter((record) => record.band === 'frozen').length,
        hidden: records.filter((record) => record.band === 'hidden').length,
        visibleAnchors: records.filter((record) => record.root.visible).length,
      };
      if (row.loaded || row.pending || row.fallback || records.length) bySlug[slug] = row;
      if (template) fits[slug] = template.fit;
      activeMixers += row.activeMixers;
      lowRateMixers += row.lowRateMixers;
      frozenMixers += row.frozenMixers;
      hiddenFishSkins += row.hidden;
      visibleAnchors += row.visibleAnchors;
    }
    return {
      active: this.group.visible ? 1 : 0,
      slug: this.visibleSlug,
      schoolKind: this.currentSite?.school.kind ?? 'none',
      label: this.currentSite?.school.label ?? '',
      motionPolicy: FISH_MOTION_POLICY,
      motionBand: this.motionBand,
      pointSchoolSprites: this.points.visible ? this.pointSpriteCount : 0,
      nearBoidSprites: this.nearBoidSpriteCount,
      swimPathVisible: this.swimPath.visible ? 1 : 0,
      swimPathBeads: this.swimPath.visible ? this.swimPathBeadCount : 0,
      swimPathLength: this.points.visible ? this.swimPathLength : 0,
      schoolSpread: this.points.visible ? this.schoolSpread : 0,
      glbAnchors: this.anchors.length,
      glbAnchorsVisible: visibleAnchors,
      fallbackVisible: this.fallback.visible ? 1 : 0,
      activeMixers,
      lowRateMixers,
      frozenMixers,
      hiddenFishSkins,
      activeMixerRadius: FISH_ACTIVE_MIXER_RADIUS,
      lowRateMixerRadius: FISH_LOW_RATE_MIXER_RADIUS,
      frozenMixerRadius: FISH_FROZEN_MIXER_RADIUS,
      kilnFishSkinsLoaded: [...this.skinTemplates.keys()].length,
      kilnFishSkinsPending: [...this.skinStatus.values()].filter((status) => status === 'pending').length,
      kilnFishSkinFallbacks: [...this.skinStatus.values()].filter((status) => status === 'fallback').length,
      kilnFishSkinsBySlug: bySlug,
      kilnFishSkinFits: fits,
    };
  }
}
