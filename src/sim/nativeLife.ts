import type { Goldberg } from '../geo/goldberg';
import type { Columns } from '../world/columns';
import { NATURAL_VOID_SCAN_LAYERS, type NaturalVoidKind } from '../world/caves';
import { MAT, type Terrain } from '../world/terrain';
import { hashString } from '../util/prng';
import type { ItemId } from './crafting';

export type NativeCreatureKind = 'mossPuff' | 'shellSkitter' | 'reedbackGrazer' | 'caveBlinker' | 'tideLurker' | 'caveBelljaw' | 'screeSnapper' | 'stormBurr' | 'brambleback';
export type NativeCreatureTemperament = 'harmless' | 'territorial' | 'combative';
export type NativeCreatureRoamState = 'settled' | 'graze' | 'wander' | 'curious' | 'flee' | 'return' | 'watch' | 'patrol' | 'warn' | 'telegraph' | 'lunge' | 'prowl' | 'recover';
export type NativeCreatureMood = 'calm' | 'curious' | 'startled' | 'alert' | 'pressuring' | 'recovering';
export type NativeCreatureAlertSource = 'player' | 'miningNoise' | 'fishingSplash' | 'wardFailed';

export interface NativeCreatureBehaviorContext {
  playerTile?: number;
  alertSource?: NativeCreatureAlertSource;
}

export interface NativeCreatureMotion {
  homeTile: number;
  fromTile: number;
  toTile: number;
  currentTile: number;
  targetTile: number;
  progress: number;
  moving: boolean;
  state: NativeCreatureRoamState;
  clip: 'idle' | 'walk';
  leashRings: number;
  mood?: NativeCreatureMood;
  playerRings?: number;
  alertSource?: NativeCreatureAlertSource;
  behaviorNote?: string;
}

export interface NativeCreatureSite {
  id: number;
  kind: NativeCreatureKind;
  tile: number;
  homeTile?: number;
  slot: number;
  label: string;
  detail: string;
  temperament: NativeCreatureTemperament;
  reward: { item: ItemId; count: number; label: string };
  tended: boolean;
  warded: boolean;
  hint: string;
  pressure?: { stamina: number; exposure: number; interval: number; radiusRings: number; label: string };
  combat?: { telegraph: string; weakness: string; result: string };
  motion?: NativeCreatureMotion;
}

export interface NativeCreatureTendResult {
  ok: boolean;
  alreadyTended: boolean;
  site: NativeCreatureSite;
  item?: ItemId;
  count?: number;
  message: string;
}

export interface NativeCreatureWardResult {
  ok: boolean;
  alreadyWarded: boolean;
  prepared: boolean;
  pressureApplied: boolean;
  site: NativeCreatureSite;
  item?: ItemId;
  count?: number;
  message: string;
}

function hash01(seedHash: number, tile: number, salt: number): number {
  let h = (Math.imul(tile + 0x9e37, 0x85ebca6b) ^ seedHash ^ Math.imul(salt, 0xc2b2ae35)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function creatureId(tile: number, slot: number): number {
  return Math.max(0, Math.trunc(tile)) * 4 + slot + 1;
}

function waterNeighborCount(geo: Goldberg, columns: Columns, tile: number): number {
  let count = columns.heightOf(tile) <= 0.9 ? 1 : 0;
  const deg = geo.degreeOf(tile);
  for (let k = 0; k < deg; k++) {
    if (columns.heightOf(geo.neighbor(tile, k)) <= 0.9) count++;
  }
  return count;
}

function naturalVoidNeighborCount(geo: Goldberg, columns: Columns, tile: number): number {
  let count = columns.hasNaturalVoids(tile) ? 1 : 0;
  const deg = geo.degreeOf(tile);
  for (let k = 0; k < deg; k++) {
    if (columns.hasNaturalVoids(geo.neighbor(tile, k))) count++;
  }
  return count;
}

interface CaveMouthInfo {
  kind: Exclude<NaturalVoidKind, 'arch'>;
  depth: number;
  flooded: boolean;
  spring: boolean;
  clearance: number;
}

function caveMouthInfoAt(columns: Columns, tile: number): CaveMouthInfo | null {
  if (!columns.hasNaturalVoids(tile)) return null;
  const top = columns.topLayerOf(tile);
  const max = Math.min(columns.layers.L - 2, top + NATURAL_VOID_SCAN_LAYERS);
  let best: CaveMouthInfo | null = null;
  let bestScore = Infinity;
  for (let layer = top + 1; layer <= max; layer++) {
    const sample = columns.naturalVoidAt(tile, layer);
    if (!sample) continue;
    let end = layer;
    while (end + 1 <= max && columns.naturalVoidAt(tile, end + 1)?.kind === sample.kind) end++;
    if (sample.kind !== 'arch') {
      const clearance = Math.max(0, end + 1 - layer);
      if (clearance >= 2) {
        const info: CaveMouthInfo = {
          kind: sample.kind,
          depth: sample.depth,
          flooded: sample.flooded,
          spring: sample.spring === true,
          clearance,
        };
        const score = (sample.kind === 'dryCave' ? 0 : 6)
          - (info.spring ? 4 : 0)
          - Math.min(8, info.clearance)
          + Math.abs(info.depth - 9) * 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = info;
        }
      }
    }
    layer = end;
  }
  return best;
}

function tileEntriesAround(geo: Goldberg, centerTile: number, rings: number): { tile: number; ring: number }[] {
  const center = Math.max(0, Math.min(geo.count - 1, Math.trunc(centerTile)));
  const seen = new Set<number>([center]);
  const queue: { tile: number; ring: number }[] = [{ tile: center, ring: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (entry.ring >= rings) continue;
    const deg = geo.degreeOf(entry.tile);
    for (let k = 0; k < deg; k++) {
      const n = geo.neighbor(entry.tile, k);
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ tile: n, ring: entry.ring + 1 });
    }
  }
  return queue;
}

function nearSeaCave(geo: Goldberg, columns: Columns, tile: number): boolean {
  if (caveMouthInfoAt(columns, tile)?.kind === 'seaCave') return true;
  const deg = geo.degreeOf(tile);
  for (let k = 0; k < deg; k++) {
    if (caveMouthInfoAt(columns, geo.neighbor(tile, k))?.kind === 'seaCave') return true;
  }
  return false;
}

function creatureHabitatScore(
  site: NativeCreatureSite,
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  tile: number,
): number {
  if (tile < 0 || tile >= geo.count) return Infinity;
  const homeHeight = columns.heightOf(site.homeTile ?? site.tile);
  const height = columns.heightOf(tile);
  const slope = Math.abs(height - homeHeight);
  if (slope > 10) return Infinity;
  const material = terrain.surfaceMaterial(height);
  const c = geo.centers;
  const forest = terrain.forestAt(c[tile * 3], c[tile * 3 + 1], c[tile * 3 + 2]);
  const water = waterNeighborCount(geo, columns, tile);
  const caveLinks = naturalVoidNeighborCount(geo, columns, tile);
  const mouth = caveMouthInfoAt(columns, tile);
  const jitter = hash01(seedHash, site.id, 900 + tile % 997) * 0.12;

  if (site.kind === 'mossPuff') {
    if (height < 2.5 || height > 46 || material !== MAT.GRASS || forest < 0.2) return Infinity;
    return slope * 0.5 + Math.max(0, 0.42 - forest) + jitter;
  }
  if (site.kind === 'shellSkitter') {
    if (height < -1.4 || height > 3.8 || material !== MAT.SAND || water <= 0) return Infinity;
    return slope * 0.25 + Math.abs(height) * 0.2 - Math.min(4, water) * 0.12 + jitter;
  }
  if (site.kind === 'reedbackGrazer') {
    if (height < 1 || height > 20 || material !== MAT.GRASS || water <= 0 || forest > 0.65) return Infinity;
    return slope * 0.3 + Math.max(0, forest - 0.35) + Math.abs(height - 3.5) * 0.04 + jitter;
  }
  if (site.kind === 'caveBlinker') {
    if (height < -2.5 || height > 44 || !mouth) return Infinity;
    if (material !== MAT.GRASS && material !== MAT.SAND && material !== MAT.SNOW && material !== MAT.ROCK) return Infinity;
    return slope * 0.35 + (mouth.kind === 'dryCave' ? 0 : 0.5) - Math.min(1, mouth.clearance / 8) + jitter;
  }
  if (site.kind === 'caveBelljaw') {
    if (height < -1.5 || height > 42 || !mouth) return Infinity;
    if (material !== MAT.GRASS && material !== MAT.SAND && material !== MAT.SNOW && material !== MAT.ROCK) return Infinity;
    return slope * 0.4 + (mouth.spring ? -0.2 : 0) + (mouth.kind === 'dryCave' ? 0 : 0.35) + jitter;
  }
  if (site.kind === 'tideLurker') {
    if (height < -2.5 || height > 18 || !nearSeaCave(geo, columns, tile) || water <= 0) return Infinity;
    if (material !== MAT.SAND && material !== MAT.ROCK && material !== MAT.GRASS) return Infinity;
    return slope * 0.28 + Math.abs(height - 1.4) * 0.05 - Math.min(4, water) * 0.1 + jitter;
  }
  if (site.kind === 'screeSnapper') {
    if (height < 30 || height > 92 || (material !== MAT.ROCK && material !== MAT.SNOW)) return Infinity;
    if (caveLinks <= 0 && height < 54) return Infinity;
    return slope * 0.45 - Math.min(3, caveLinks) * 0.14 + jitter;
  }
  if (site.kind === 'stormBurr') {
    if (height < 16 || height > 76 || (material !== MAT.GRASS && material !== MAT.SNOW) || forest > 0.42 || water > 2) return Infinity;
    return slope * 0.34 + Math.max(0, forest - 0.18) + jitter;
  }
  if (site.kind === 'brambleback') {
    if (height < 7 || height > 60 || (material !== MAT.GRASS && material !== MAT.SNOW) || forest > 0.7) return Infinity;
    return slope * 0.35 + Math.max(0, 0.28 - forest) * -0.25 + jitter;
  }
  return Infinity;
}

function roamLeashRings(site: NativeCreatureSite): number {
  if (site.kind === 'caveBelljaw' || site.kind === 'caveBlinker') return 1;
  if (site.kind === 'tideLurker' || site.kind === 'shellSkitter') return 1;
  if (site.temperament === 'combative') return 1;
  return 2;
}

function candidateRoamTiles(
  site: NativeCreatureSite,
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
): number[] {
  const home = site.homeTile ?? site.tile;
  const candidates = new Map<number, number>([[home, 0]]);
  for (const entry of tileEntriesAround(geo, home, roamLeashRings(site))) {
    const score = creatureHabitatScore(site, seedHash, geo, columns, terrain, entry.tile);
    if (Number.isFinite(score)) candidates.set(entry.tile, score + entry.ring * 0.08);
  }
  return [...candidates.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([tile]) => tile)
    .slice(0, 7);
}

function roamStateFor(site: NativeCreatureSite, moving: boolean): NativeCreatureRoamState {
  if (site.tended) return 'settled';
  if (site.warded) return 'recover';
  if (site.temperament === 'harmless') return moving ? 'wander' : 'graze';
  if (site.temperament === 'combative') return moving ? 'prowl' : 'warn';
  return moving ? 'patrol' : 'watch';
}

function smooth01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function defaultMoodFor(site: NativeCreatureSite): NativeCreatureMood {
  if (site.tended) return 'calm';
  if (site.warded) return 'recovering';
  return site.temperament === 'harmless' ? 'calm' : 'alert';
}

function ringDistanceBetween(geo: Goldberg, fromTile: number, toTile: number, maxRings: number): number | undefined {
  const from = Math.max(0, Math.min(geo.count - 1, Math.trunc(fromTile)));
  const to = Math.max(0, Math.min(geo.count - 1, Math.trunc(toTile)));
  for (const entry of tileEntriesAround(geo, from, Math.max(0, Math.trunc(maxRings)))) {
    if (entry.tile === to) return entry.ring;
  }
  return undefined;
}

function farthestCandidateFromPlayer(
  geo: Goldberg,
  currentTile: number,
  playerTile: number,
  candidates: readonly number[],
): number {
  let best = currentTile;
  let bestScore = -Infinity;
  for (const candidate of candidates.length ? candidates : [currentTile]) {
    if (candidate === playerTile) continue;
    const rings = ringDistanceBetween(geo, candidate, playerTile, 5);
    const score = (rings ?? 6) * 10 + (candidate === currentTile ? -2 : 0) - Math.abs(candidate - currentTile) * 0.0001;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function applyNativeCreatureBehavior(
  site: NativeCreatureSite,
  seedHash: number,
  geo: Goldberg,
  motion: NativeCreatureMotion,
  candidates: readonly number[],
  seconds: number,
  context?: NativeCreatureBehaviorContext,
): NativeCreatureMotion {
  const base: NativeCreatureMotion = {
    ...motion,
    mood: motion.mood ?? defaultMoodFor(site),
  };
  const rawPlayerTile = context?.playerTile;
  if (typeof rawPlayerTile !== 'number' || !Number.isFinite(rawPlayerTile)) return base;
  const playerTile = Math.max(0, Math.min(geo.count - 1, Math.trunc(rawPlayerTile)));
  const playerRings = ringDistanceBetween(geo, base.currentTile, playerTile, Math.max(5, base.leashRings + 3));
  if (playerRings === undefined) return base;
  const alertSource = context?.alertSource ?? 'player';

  if (site.tended) return { ...base, mood: 'calm', playerRings };
  if (site.warded) return { ...base, mood: 'recovering', playerRings, behaviorNote: 'already warded; recovering near its home tile' };

  if (site.temperament === 'harmless') {
    if (playerRings === 0) {
      const fromTile = base.currentTile;
      const toTile = farthestCandidateFromPlayer(geo, fromTile, playerTile, candidates);
      const moving = toTile !== fromTile;
      const phase = ((Math.max(0, seconds) * 0.82) + hash01(seedHash, site.id, 982)) % 1;
      const progress = moving ? Math.max(0.08, Math.min(0.92, smooth01(phase))) : 1;
      return {
        ...base,
        fromTile,
        toTile: moving ? toTile : fromTile,
        currentTile: moving && progress >= 0.5 ? toTile : fromTile,
        targetTile: moving ? toTile : fromTile,
        progress,
        moving,
        state: 'flee',
        clip: moving ? 'walk' : 'idle',
        mood: 'startled',
        playerRings,
        alertSource,
        behaviorNote: 'startled by player proximity; backs toward a valid habitat tile',
      };
    }
    if (playerRings <= 1) {
      const currentTile = base.currentTile;
      return {
        ...base,
        fromTile: currentTile,
        toTile: currentTile,
        currentTile,
        targetTile: currentTile,
        progress: 1,
        moving: false,
        state: 'curious',
        clip: 'idle',
        mood: 'curious',
        playerRings,
        alertSource,
        behaviorNote: 'curious about the player; safe to tend instead of mine',
      };
    }
    return base;
  }

  const pressureRings = Math.max(1, Math.trunc(site.pressure?.radiusRings ?? 1));
  const warningRings = Math.max(2, pressureRings + (site.temperament === 'combative' ? 1 : 0));
  if (playerRings <= warningRings) {
    const currentTile = base.currentTile;
    const state: NativeCreatureRoamState = playerRings <= pressureRings
      ? (site.temperament === 'combative' && playerRings === 0 ? 'lunge' : 'telegraph')
      : 'warn';
    return {
      ...base,
      fromTile: currentTile,
      toTile: currentTile,
      currentTile,
      targetTile: currentTile,
      progress: 1,
      moving: false,
      state,
      clip: state === 'lunge' ? 'walk' : 'idle',
      mood: state === 'lunge' ? 'pressuring' : 'alert',
      playerRings,
      alertSource,
      behaviorNote: state === 'warn'
        ? (site.pressure?.label ?? 'keeps watch as the player gets close')
        : (site.combat?.telegraph ?? site.pressure?.label ?? 'telegraphs before pressure applies'),
    };
  }
  return base;
}

export function withNativeCreatureRoaming(
  seed: string,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  site: NativeCreatureSite,
  seconds: number,
  context?: NativeCreatureBehaviorContext,
): NativeCreatureSite {
  const homeTile = site.homeTile ?? site.tile;
  const seedHash = hashString(`${seed}:native-life-roaming`);
  if (!Number.isFinite(seconds) || site.tended || site.warded) {
    const motion = applyNativeCreatureBehavior(site, seedHash, geo, {
      homeTile,
      fromTile: homeTile,
      toTile: homeTile,
      currentTile: homeTile,
      targetTile: homeTile,
      progress: 1,
      moving: false,
      state: roamStateFor(site, false),
      clip: 'idle',
      leashRings: roamLeashRings(site),
    }, [homeTile], Number.isFinite(seconds) ? seconds : 0, context);
    return {
      ...site,
      tile: motion.currentTile,
      homeTile,
      motion,
    };
  }

  const candidates = candidateRoamTiles(site, seedHash, geo, columns, terrain);
  if (candidates.length <= 1) {
    const motion = applyNativeCreatureBehavior(site, seedHash, geo, {
      homeTile,
      fromTile: homeTile,
      toTile: homeTile,
      currentTile: homeTile,
      targetTile: homeTile,
      progress: 1,
      moving: false,
      state: roamStateFor(site, false),
      clip: 'idle',
      leashRings: roamLeashRings(site),
    }, candidates, seconds, context);
    return {
      ...site,
      tile: motion.currentTile,
      homeTile,
      motion,
    };
  }

  const period = 6.5 + hash01(seedHash, site.id, 940) * 4.5;
  const phase = Math.floor(Math.max(0, seconds + hash01(seedHash, site.id, 941) * period) / period);
  const local = ((seconds + hash01(seedHash, site.id, 941) * period) / period) - phase;
  const roamIndex = 1 + (Math.floor(hash01(seedHash, site.id, 960 + Math.floor(phase / 2)) * (candidates.length - 1)) % (candidates.length - 1));
  const roamTile = candidates[roamIndex] ?? homeTile;
  const outbound = phase % 2 === 0;
  const travelFrac = site.temperament === 'harmless' ? 0.52 : 0.62;
  const moving = local < travelFrac && roamTile !== homeTile;
  const progress = moving ? smooth01(local / travelFrac) : 1;
  const fromTile = outbound ? homeTile : roamTile;
  const toTile = outbound ? roamTile : homeTile;
  const restTile = outbound ? roamTile : homeTile;
  const currentTile = moving ? (progress < 0.5 ? fromTile : toTile) : restTile;
  const motion: NativeCreatureMotion = {
    homeTile,
    fromTile: moving ? fromTile : restTile,
    toTile: moving ? toTile : restTile,
    currentTile,
    targetTile: toTile,
    progress,
    moving,
    state: roamStateFor(site, moving),
    clip: moving ? 'walk' : 'idle',
    leashRings: roamLeashRings(site),
  };
  const adjustedMotion = applyNativeCreatureBehavior(site, seedHash, geo, motion, candidates, seconds, context);
  return { ...site, tile: adjustedMotion.currentTile, homeTile, motion: adjustedMotion };
}

export function normalizeNativeCreatureTends(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    const id = Math.max(1, Math.trunc(entry));
    seen.add(id);
  }
  return [...seen].sort((a, b) => a - b);
}

export function normalizeNativeCreatureWards(raw: unknown): number[] {
  return normalizeNativeCreatureTends(raw);
}

function mossPuffAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const height = columns.heightOf(id);
  if (height < 2.5 || height > 46) return null;
  if (terrain.surfaceMaterial(height) !== MAT.GRASS) return null;
  const c = geo.centers;
  const forest = terrain.forestAt(c[id * 3], c[id * 3 + 1], c[id * 3 + 2]);
  if (forest < 0.28) return null;
  const density = 0.035 + Math.max(0, forest - 0.28) * 0.16;
  if (hash01(seedHash, id, 1) > density) return null;
  const slot = 0;
  const creatureIdValue = creatureId(id, slot);
  const bright = hash01(seedHash, id, 3) > 0.54;
  return {
    id: creatureIdValue,
    kind: 'mossPuff',
    tile: id,
    slot,
    label: bright ? 'sun-moss puff' : 'moss-puff',
    detail: bright
      ? 'a harmless round grazer carrying berry seeds in its coat'
      : 'a harmless mossy grazer that sheds seed burrs when gently brushed',
    temperament: 'harmless',
    reward: { item: 'seeds', count: bright ? 2 : 1, label: bright ? 'berry seeds' : 'seed burr' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'brush it gently for berry seeds; it flees from loud chopping later',
  };
}

function bramblebackAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const height = columns.heightOf(id);
  if (height < 8 || height > 58) return null;
  const material = terrain.surfaceMaterial(height);
  if (material !== MAT.GRASS && material !== MAT.SNOW) return null;
  const c = geo.centers;
  const forest = terrain.forestAt(c[id * 3], c[id * 3 + 1], c[id * 3 + 2]);
  if (forest > 0.62) return null;
  const ridgeBias = Math.max(0, Math.min(1, (height - 12) / 34));
  const openBias = Math.max(0, 0.32 - forest);
  const density = 0.018 + ridgeBias * 0.035 + openBias * 0.09 + (material === MAT.SNOW ? 0.012 : 0);
  if (hash01(seedHash, id, 11) > density) return null;
  const slot = 1;
  const creatureIdValue = creatureId(id, slot);
  const thorny = hash01(seedHash, id, 13) > 0.58;
  return {
    id: creatureIdValue,
    kind: 'brambleback',
    tile: id,
    slot,
    label: thorny ? 'thorn-crown brambleback' : 'brambleback',
    detail: thorny
      ? 'a nervous territorial grazer with a crown of springy thorn reeds'
      : 'a squat bristled native that rattles when crowded',
    temperament: 'territorial',
    reward: { item: 'reeds', count: thorny ? 3 : 2, label: thorny ? 'thorn reeds' : 'bristle reeds' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'give it room, ward it close with blade/axe/light/cloak, or scare it off at range with bow and whistling arrows',
    pressure: {
      stamina: thorny ? 10 : 8,
      exposure: thorny ? 5 : 4,
      interval: thorny ? 2.8 : 3.2,
      radiusRings: 1,
      label: thorny ? 'thorn crown rattle' : 'brambleback rattle',
    },
  };
}

function caveBelljawAt(
  seedHash: number,
  _geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const mouth = caveMouthInfoAt(columns, id);
  if (!mouth) return null;
  const height = columns.heightOf(id);
  if (height < -1.5 || height > 42) return null;
  const material = terrain.surfaceMaterial(height);
  if (material !== MAT.GRASS && material !== MAT.SAND && material !== MAT.SNOW && material !== MAT.ROCK) return null;
  const depthBias = Math.max(0, 1 - Math.abs(mouth.depth - 9) / 18);
  const clearanceBias = Math.min(1, mouth.clearance / 6);
  const density = 0.16 + depthBias * 0.1 + clearanceBias * 0.12 + (mouth.spring ? 0.08 : 0) + (mouth.kind === 'dryCave' ? 0.05 : 0);
  if (hash01(seedHash, id, 41) > density) return null;
  const slot = 1;
  const creatureIdValue = creatureId(id, slot);
  const spring = mouth.spring && hash01(seedHash, id, 43) > 0.35;
  const tide = mouth.kind === 'seaCave';
  return {
    id: creatureIdValue,
    kind: 'caveBelljaw',
    tile: id,
    slot,
    label: spring ? 'spring bell-jaw' : tide ? 'tide bell-jaw' : 'cave bell-jaw',
    detail: spring
      ? 'a goofy cave-mouth snapper that clacks when spring water echoes below'
      : tide
      ? 'a stone-shelled cave-mouth hazard that snaps at splashing feet and loose light'
      : 'a squat cave-mouth hazard with a bell shell, hinge feet, and a nervous glow tongue',
    temperament: 'territorial',
    reward: { item: 'glowCrystal', count: spring ? 2 : 1, label: spring ? 'spring-glow shards' : 'bell-glow shard' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'keep light on its hinge or meet it with a short blade; it teaches cave prep, not enemy farming',
    pressure: {
      stamina: spring ? 12 : 10,
      exposure: tide ? 7 : 6,
      interval: spring ? 2.4 : 2.7,
      radiusRings: 1,
      label: spring ? 'spring jaw clap' : tide ? 'tide jaw clap' : 'cave jaw clap',
    },
  };
}

function caveBlinkerAt(
  seedHash: number,
  _geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const mouth = caveMouthInfoAt(columns, id);
  if (!mouth) return null;
  const height = columns.heightOf(id);
  if (height < -2.5 || height > 44) return null;
  const material = terrain.surfaceMaterial(height);
  if (material !== MAT.GRASS && material !== MAT.SAND && material !== MAT.SNOW && material !== MAT.ROCK) return null;
  const clearanceBias = Math.min(1, mouth.clearance / 7);
  const dryBias = mouth.kind === 'dryCave' ? 0.08 : 0.02;
  const springBias = mouth.spring ? 0.06 : 0;
  const density = 0.18 + clearanceBias * 0.12 + dryBias + springBias;
  if (hash01(seedHash, id, 81) > density) return null;
  const slot = 2;
  const creatureIdValue = creatureId(id, slot);
  const spring = mouth.spring && hash01(seedHash, id, 83) > 0.28;
  const tide = mouth.kind === 'seaCave';
  return {
    id: creatureIdValue,
    kind: 'caveBlinker',
    tile: id,
    slot,
    label: spring ? 'spring cave blinker' : tide ? 'tide cave blinker' : 'cave blinker',
    detail: spring
      ? 'a harmless cave-mouth native with huge blinking glow eyes and a mushroom satchel warmed by spring air'
      : tide
      ? 'a soft-footed cave helper that blinks at tide echoes and hides mushroom caps under its shell'
      : 'a goofy harmless cave helper with sleepy glow eyes, tiny antennae, and a wobbling mushroom pack',
    temperament: 'harmless',
    reward: { item: 'caveMushroom', count: spring ? 2 : 1, label: spring ? 'springcap mushrooms' : 'blinkcap mushroom' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'match its blink rhythm for cave-focus breath, safer cave air, and a blinkcap mushroom gift',
  };
}

function tideLurkerAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const mouth = caveMouthInfoAt(columns, id);
  const height = columns.heightOf(id);
  const material = terrain.surfaceMaterial(height);
  const waterNeighbors = waterNeighborCount(geo, columns, id);
  let nearSeaCave = mouth?.kind === 'seaCave';
  if (!nearSeaCave) {
    const deg = geo.degreeOf(id);
    for (let k = 0; k < deg; k++) {
      const nb = geo.neighbor(id, k);
      const nbMouth = caveMouthInfoAt(columns, nb);
      if (nbMouth?.kind === 'seaCave') {
        nearSeaCave = true;
        break;
      }
    }
  }
  if (!nearSeaCave) return null;
  if (height < -2.5 || height > 18) return null;
  if (material !== MAT.SAND && material !== MAT.ROCK && material !== MAT.GRASS) return null;
  if (waterNeighbors <= 0 && mouth?.flooded !== true) return null;
  const mouthBias = mouth?.kind === 'seaCave' ? 0.18 : 0;
  const wetBias = Math.min(5, waterNeighbors) * 0.026;
  const lowBias = 1 - Math.min(1, Math.abs(height - 1.4) / 18);
  const density = 0.12 + mouthBias + wetBias + lowBias * 0.12;
  if (hash01(seedHash, id, 71) > density) return null;
  const slot = 3;
  const creatureIdValue = creatureId(id, slot);
  const lampShy = hash01(seedHash, id, 73) > 0.55;
  return {
    id: creatureIdValue,
    kind: 'tideLurker',
    tile: id,
    slot,
    label: lampShy ? 'lamp-shy tide lurker' : 'tide lurker',
    detail: lampShy
      ? 'a flat sea-cave native with eye bulbs, paddle fins, and a habit of flinching from steady light'
      : 'a goofy tide-flat hazard that hides beside cave fish shimmer until a cast splashes too close',
    temperament: 'territorial',
    reward: { item: 'rawFish', count: lampShy ? 3 : 2, label: lampShy ? 'startled cave fish' : 'tide-stunned fish' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'sea-cave casts can wake it; steady lantern light, a short blade, hatchet/axe, or whistling arrow startles it off',
    pressure: {
      stamina: lampShy ? 13 : 11,
      exposure: 7,
      interval: lampShy ? 2.25 : 2.55,
      radiusRings: 1,
      label: lampShy ? 'lamp-shy tide snap' : 'tide-lurk surge',
    },
    combat: {
      telegraph: 'eye bulbs rise and fins cup the water before the snap',
      weakness: 'steady lantern or echo lantern light, short blade, hatchet, axe, or whistling arrow',
      result: 'startle it once, then it slips below the cave tide and scatters fish',
    },
  };
}

function screeSnapperAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const height = columns.heightOf(id);
  if (height < 34 || height > 92) return null;
  const material = terrain.surfaceMaterial(height);
  if (material !== MAT.ROCK && material !== MAT.SNOW) return null;
  const caveLinks = naturalVoidNeighborCount(geo, columns, id);
  if (caveLinks <= 0 && height < 54) return null;
  const c = geo.centers;
  const forest = terrain.forestAt(c[id * 3], c[id * 3 + 1], c[id * 3 + 2]);
  if (forest > 0.18) return null;
  const ridgeBias = Math.max(0, Math.min(1, (height - 42) / 42));
  const caveBias = Math.min(1, caveLinks / 3);
  const density = 0.022 + ridgeBias * 0.045 + caveBias * 0.12 + (material === MAT.SNOW ? 0.012 : 0);
  if (hash01(seedHash, id, 51) > density) return null;
  const slot = 0;
  const creatureIdValue = creatureId(id, slot);
  const slateBack = hash01(seedHash, id, 53) > 0.58;
  return {
    id: creatureIdValue,
    kind: 'screeSnapper',
    tile: id,
    slot,
    label: slateBack ? 'slate-back scree-snapper' : 'scree-snapper',
    detail: slateBack
      ? 'a flat rocky snapper that looks like loose scree until its jaw plates hinge open'
      : 'a small combative rock native that wakes when mining rings through nearby caves',
    temperament: 'combative',
    reward: { item: 'rock', count: slateBack ? 4 : 3, label: slateBack ? 'slate scree plates' : 'scree plates' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'watch its jaw wind-up; stun with blade, hatchet, axe, or whistling arrow when mining wakes it',
    pressure: {
      stamina: slateBack ? 15 : 13,
      exposure: material === MAT.SNOW ? 4 : 3,
      interval: slateBack ? 2.15 : 2.35,
      radiusRings: 1,
      label: slateBack ? 'slate snap wind-up' : 'scree snap wind-up',
    },
    combat: {
      telegraph: 'shell plates lift before the snap',
      weakness: 'short blade, hatchet, axe, or whistling arrow',
      result: 'stun once, then it flees under the scree',
    },
  };
}

function stormBurrAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const height = columns.heightOf(id);
  if (height < 18 || height > 74) return null;
  const material = terrain.surfaceMaterial(height);
  if (material !== MAT.GRASS && material !== MAT.SNOW) return null;
  const c = geo.centers;
  const forest = terrain.forestAt(c[id * 3], c[id * 3 + 1], c[id * 3 + 2]);
  if (forest > 0.34) return null;
  const waterNeighbors = waterNeighborCount(geo, columns, id);
  if (waterNeighbors > 2) return null;
  const ridgeBias = Math.max(0, Math.min(1, (height - 20) / 38));
  const openBias = Math.max(0, 0.38 - forest);
  const coldBias = material === MAT.SNOW ? 0.032 : 0;
  const density = 0.016 + ridgeBias * 0.04 + openBias * 0.085 + coldBias;
  if (hash01(seedHash, id, 61) > density) return null;
  const slot = 2;
  const creatureIdValue = creatureId(id, slot);
  const crackling = hash01(seedHash, id, 63) > 0.56;
  return {
    id: creatureIdValue,
    kind: 'stormBurr',
    tile: id,
    slot,
    label: crackling ? 'crackle-coat storm burr' : 'storm burr',
    detail: crackling
      ? 'a wind-rolled burr native with static quills that only gets brave in bad weather'
      : 'a goofy little ridge hazard that tumbles with gusts and pins travelers with burr spines',
    temperament: 'territorial',
    reward: { item: 'reeds', count: crackling ? 3 : 2, label: crackling ? 'storm-bent reed fibers' : 'wind-burr fibers' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'dangerous in storm, rain, cold, or soaked weather; brace with a storm cloak, blade, hatchet, axe, or whistling arrow',
    pressure: {
      stamina: crackling ? 12 : 10,
      exposure: material === MAT.SNOW ? 7 : 6,
      interval: crackling ? 2.25 : 2.55,
      radiusRings: 1,
      label: crackling ? 'static burr gust' : 'storm burr gust',
    },
    combat: {
      telegraph: 'quills lean flat just before the gust roll',
      weakness: 'storm cloak brace, short blade, hatchet, axe, or whistling arrow',
      result: 'ground it once, then it tumbles away with the squall',
    },
  };
}

function shellSkitterAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const height = columns.heightOf(id);
  if (height < -1.2 || height > 3.2) return null;
  if (terrain.surfaceMaterial(height) !== MAT.SAND) return null;
  const waterNeighbors = waterNeighborCount(geo, columns, id);
  if (waterNeighbors <= 0) return null;
  const shoreBand = 1 - Math.min(1, Math.abs(height) / 3.2);
  const density = 0.045 + shoreBand * 0.11 + Math.min(4, waterNeighbors) * 0.012;
  if (hash01(seedHash, id, 21) > density) return null;
  const slot = 2;
  const creatureIdValue = creatureId(id, slot);
  const tideMarked = hash01(seedHash, id, 23) > 0.62;
  return {
    id: creatureIdValue,
    kind: 'shellSkitter',
    tile: id,
    slot,
    label: tideMarked ? 'tide-shell skitter' : 'shell-skitter',
    detail: tideMarked
      ? 'a shy little shore native that taps its shell when fish scraps wash close'
      : 'a harmless sand skitter that noses up bait scraps along the waterline',
    temperament: 'harmless',
    reward: tideMarked
      ? { item: 'kelp', count: 1, label: 'tideline kelp' }
      : { item: 'bait', count: 2, label: 'bait scraps' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'coax it gently for bait or kelp; it marks shore food without becoming an enemy',
  };
}

function reedbackGrazerAt(
  seedHash: number,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  id: number,
  tended: ReadonlySet<number>,
  warded: ReadonlySet<number>,
): NativeCreatureSite | null {
  const height = columns.heightOf(id);
  if (height < 1.5 || height > 18) return null;
  if (terrain.surfaceMaterial(height) !== MAT.GRASS) return null;
  const waterNeighbors = waterNeighborCount(geo, columns, id);
  if (waterNeighbors <= 0) return null;
  const c = geo.centers;
  const forest = terrain.forestAt(c[id * 3], c[id * 3 + 1], c[id * 3 + 2]);
  if (forest > 0.58) return null;
  const wetBand = 1 - Math.min(1, Math.abs(height - 3.5) / 14);
  const openBias = Math.max(0, 0.42 - forest);
  const density = 0.04 + wetBand * 0.08 + Math.min(4, waterNeighbors) * 0.018 + openBias * 0.08;
  if (hash01(seedHash, id, 31) > density) return null;
  const slot = 3;
  const creatureIdValue = creatureId(id, slot);
  const lush = hash01(seedHash, id, 33) > 0.58;
  return {
    id: creatureIdValue,
    kind: 'reedbackGrazer',
    tile: id,
    slot,
    label: lush ? 'garden-back grazer' : 'reedback grazer',
    detail: lush
      ? 'a harmless wetland grazer carrying damp compost in its reed mane'
      : 'a sheepish shore grazer that pats muddy reed scraps into fertile pellets',
    temperament: 'harmless',
    reward: { item: 'compost', count: lush ? 2 : 1, label: lush ? 'garden compost' : 'compost pellet' },
    tended: tended.has(creatureIdValue),
    warded: warded.has(creatureIdValue),
    hint: 'scratch its reed mane for compost; gardens near water grow better with what it sheds',
  };
}

export function nativeCreatureAt(
  seed: string,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  tile: number,
  tended: ReadonlySet<number> = new Set(),
  warded: ReadonlySet<number> = new Set(),
): NativeCreatureSite | null {
  const id = Math.max(0, Math.min(geo.count - 1, Math.trunc(tile)));
  const seedHash = hashString(`${seed}:native-life`);
  return mossPuffAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? shellSkitterAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? reedbackGrazerAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? tideLurkerAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? caveBelljawAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? caveBlinkerAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? screeSnapperAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? stormBurrAt(seedHash, geo, columns, terrain, id, tended, warded)
    ?? bramblebackAt(seedHash, geo, columns, terrain, id, tended, warded);
}

export function nativeCreatureSitesAround(
  seed: string,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  centerTile: number,
  rings = 6,
  tended: ReadonlySet<number> = new Set(),
  warded: ReadonlySet<number> = new Set(),
  maxSites = 6,
  kind: NativeCreatureKind | 'any' = 'any',
  roamingSeconds?: number,
  behaviorContext?: NativeCreatureBehaviorContext,
): NativeCreatureSite[] {
  const sites: NativeCreatureSite[] = [];
  const baseRings = Math.max(0, Math.trunc(rings));
  const withRoaming = Number.isFinite(roamingSeconds);
  const visibleTiles = withRoaming ? new Set(tileEntriesAround(geo, centerTile, baseRings).map((entry) => entry.tile)) : null;
  const scanRings = withRoaming ? baseRings + 2 : baseRings;
  for (const entry of tileEntriesAround(geo, centerTile, scanRings)) {
    const site = nativeCreatureAt(seed, geo, columns, terrain, entry.tile, tended, warded);
    if (!site) continue;
    if (kind !== 'any' && site.kind !== kind) continue;
    const finalSite = withRoaming
      ? withNativeCreatureRoaming(seed, geo, columns, terrain, site, roamingSeconds!, behaviorContext)
      : site;
    if (visibleTiles && !visibleTiles.has(finalSite.tile) && !visibleTiles.has(finalSite.homeTile ?? finalSite.tile)) continue;
    sites.push(finalSite);
    if (sites.length >= maxSites) break;
  }
  return sites;
}

export function nearestNativeCreatureSite(
  seed: string,
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  centerTile: number,
  rings = 1,
  tended: ReadonlySet<number> = new Set(),
  warded: ReadonlySet<number> = new Set(),
  kind: NativeCreatureKind | 'any' = 'any',
): NativeCreatureSite | null {
  for (const entry of tileEntriesAround(geo, centerTile, Math.max(0, Math.trunc(rings)))) {
    const site = nativeCreatureAt(seed, geo, columns, terrain, entry.tile, tended, warded);
    if (site && (kind === 'any' || site.kind === kind)) return site;
  }
  return null;
}

export function tendNativeCreature(tended: Set<number>, site: NativeCreatureSite): NativeCreatureTendResult {
  if (site.temperament !== 'harmless') {
    return {
      ok: false,
      alreadyTended: false,
      site,
      message: `${site.label} is not safe to tend · give it room or ward it first`,
    };
  }
  if (tended.has(site.id)) {
    return {
      ok: false,
      alreadyTended: true,
      site: { ...site, tended: true },
      message: `${site.label} already brushed · it settles back into the grass`,
    };
  }
  tended.add(site.id);
  const tendPhrase = site.kind === 'shellSkitter'
    ? 'coaxed from its shell'
    : site.kind === 'reedbackGrazer'
    ? 'scratched behind its reed mane'
    : site.kind === 'caveBlinker'
    ? 'matched its blink rhythm'
    : 'brushed gently';
  return {
    ok: true,
    alreadyTended: false,
    site: { ...site, tended: true },
    item: site.reward.item,
    count: site.reward.count,
    message: `${site.label} ${tendPhrase} · ${site.reward.count} ${site.reward.label} dropped`,
  };
}

export function wardNativeCreature(warded: Set<number>, site: NativeCreatureSite, prepared: boolean): NativeCreatureWardResult {
  if (site.temperament === 'harmless') {
    return {
      ok: false,
      alreadyWarded: false,
      prepared,
      pressureApplied: false,
      site,
      message: `${site.label} does not need warding`,
    };
  }
  if (warded.has(site.id)) {
    const already = site.kind === 'screeSnapper'
      ? 'already stunned and fled · the scree lies still'
      : site.kind === 'caveBelljaw'
      ? 'already folded back · its hinge is quiet'
      : site.kind === 'stormBurr'
      ? 'already grounded and rolled away · the gust is quiet'
      : site.kind === 'tideLurker'
      ? 'already slipped below the tide · the cave water is quiet'
      : 'already backed off · its reeds are quiet';
    return {
      ok: false,
      alreadyWarded: true,
      prepared,
      pressureApplied: false,
      site: { ...site, warded: true },
      message: `${site.label} ${already}`,
    };
  }
  if (!prepared) {
    const threat = site.kind === 'caveBelljaw'
      ? 'claps its stone jaw'
      : site.kind === 'screeSnapper'
      ? 'winds up its jaw plates'
      : site.kind === 'stormBurr'
      ? 'leans its quills into the gust'
      : site.kind === 'tideLurker'
      ? 'raises its eye bulbs in the splash'
      : 'rattles its bristles';
    return {
      ok: false,
      alreadyWarded: false,
      prepared: false,
      pressureApplied: true,
      site,
      message: `${site.label} ${threat} · ${site.hint}`,
    };
  }
  warded.add(site.id);
  const wardPhrase = site.kind === 'caveBelljaw'
    ? 'folds back into the lit cave seam'
    : site.kind === 'screeSnapper'
    ? 'stunned by the opening strike and skitters under scree'
    : site.kind === 'stormBurr'
    ? 'grounded by the brace and tumbles away with the squall'
    : site.kind === 'tideLurker'
    ? 'startled by the steady answer and slips below the cave tide'
    : 'backs off';
  return {
    ok: true,
    alreadyWarded: false,
    prepared: true,
    pressureApplied: false,
    site: { ...site, warded: true },
    item: site.reward.item,
    count: site.reward.count,
    message: `${site.label} ${wardPhrase} · ${site.reward.count} ${site.reward.label} dropped`,
  };
}
