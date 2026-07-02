import type { Goldberg } from '../geo/goldberg';
import type { Columns } from '../world/columns';
import type { Layers } from '../world/layers';
import { PLANET_RADIUS, WATER_SURFACE } from '../world/layers';

export type CourierTargetKind = 'ring' | 'pad';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface CourierTargetSpec {
  kind: CourierTargetKind;
  id: string;
  forwardMeters: number;
  rightMeters: number;
  agl: number;
  radius: number;
  score: number;
  bonusSeconds: number;
}

export interface CourierRouteDefinition {
  id: string;
  name: string;
  summary: string;
  startAgl: number;
  starterThrottle: number;
  medalSeconds: {
    gold: number;
    silver: number;
    bronze: number;
  };
  targets: CourierTargetSpec[];
}

export interface CourierTarget {
  kind: CourierTargetKind;
  id: string;
  index: number;
  ringNumber: number;
  tileId: number;
  unit: Vec3Like;
  position: Vec3Like;
  forward: Vec3Like;
  right: Vec3Like;
  up: Vec3Like;
  radius: number;
  agl: number;
  score: number;
  bonusSeconds: number;
}

export interface CourierRoute {
  id: string;
  name: string;
  summary: string;
  startAgl: number;
  starterThrottle: number;
  medalSeconds: CourierRouteDefinition['medalSeconds'];
  start: {
    tileId: number;
    unit: Vec3Like;
    position: Vec3Like;
    forward: Vec3Like;
    right: Vec3Like;
    up: Vec3Like;
  };
  targets: CourierTarget[];
  ringCount: number;
}

export const COURIER_ROUTE_DEFINITIONS: CourierRouteDefinition[] = [
  {
    id: 'tutorial',
    name: 'Harbor Loop',
    summary: 'Short courier route with four training rings and one delivery pad.',
    startAgl: 34,
    starterThrottle: 46,
    medalSeconds: { gold: 54, silver: 72, bronze: 95 },
    targets: [
      { kind: 'ring', id: 't-ring-1', forwardMeters: 125, rightMeters: 0, agl: 34, radius: 27, score: 500, bonusSeconds: 2 },
      { kind: 'ring', id: 't-ring-2', forwardMeters: 255, rightMeters: 34, agl: 42, radius: 25, score: 550, bonusSeconds: 2 },
      { kind: 'ring', id: 't-ring-3', forwardMeters: 390, rightMeters: 76, agl: 38, radius: 24, score: 600, bonusSeconds: 3 },
      { kind: 'ring', id: 't-ring-4', forwardMeters: 530, rightMeters: 46, agl: 30, radius: 25, score: 650, bonusSeconds: 3 },
      { kind: 'pad', id: 't-pad', forwardMeters: 675, rightMeters: 18, agl: 0.55, radius: 30, score: 1200, bonusSeconds: 0 },
    ],
  },
  {
    id: 'challenge',
    name: 'Ridge Express',
    summary: 'Longer ring chain with higher altitude changes before the final pad.',
    startAgl: 42,
    starterThrottle: 56,
    medalSeconds: { gold: 92, silver: 122, bronze: 158 },
    targets: [
      { kind: 'ring', id: 'c-ring-1', forwardMeters: 155, rightMeters: -16, agl: 42, radius: 25, score: 550, bonusSeconds: 2 },
      { kind: 'ring', id: 'c-ring-2', forwardMeters: 330, rightMeters: -76, agl: 55, radius: 24, score: 600, bonusSeconds: 2 },
      { kind: 'ring', id: 'c-ring-3', forwardMeters: 510, rightMeters: -34, agl: 69, radius: 23, score: 650, bonusSeconds: 2 },
      { kind: 'ring', id: 'c-ring-4', forwardMeters: 690, rightMeters: 58, agl: 60, radius: 23, score: 700, bonusSeconds: 3 },
      { kind: 'ring', id: 'c-ring-5', forwardMeters: 875, rightMeters: 98, agl: 44, radius: 24, score: 750, bonusSeconds: 3 },
      { kind: 'ring', id: 'c-ring-6', forwardMeters: 1060, rightMeters: 32, agl: 36, radius: 24, score: 800, bonusSeconds: 3 },
      { kind: 'ring', id: 'c-ring-7', forwardMeters: 1240, rightMeters: -42, agl: 48, radius: 23, score: 850, bonusSeconds: 4 },
      { kind: 'pad', id: 'c-pad', forwardMeters: 1460, rightMeters: -68, agl: 0.55, radius: 32, score: 1600, bonusSeconds: 0 },
    ],
  },
];

function clone(v: Vec3Like): Vec3Like {
  return { x: v.x, y: v.y, z: v.z };
}

export function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function sub(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3Like, s: number): Vec3Like {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function add(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function cross(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(v: Vec3Like): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize(v: Vec3Like, fallback: Vec3Like = { x: 1, y: 0, z: 0 }): Vec3Like {
  const l = length(v);
  if (l < 1e-9) return clone(fallback);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function tileUnit(geo: Goldberg, tileId: number): Vec3Like {
  const c = geo.centers;
  return {
    x: c[tileId * 3],
    y: c[tileId * 3 + 1],
    z: c[tileId * 3 + 2],
  };
}

function surfaceRadius(layers: Layers, columns: Columns, tileId: number): number {
  return Math.max(
    WATER_SURFACE,
    layers.topRadius(columns.groundLayerBelow(tileId, layers.bounds[0])),
  );
}

export function unitFromTangentOffset(
  origin: Vec3Like,
  forward: Vec3Like,
  right: Vec3Like,
  forwardMeters: number,
  rightMeters: number,
  planetRadius = PLANET_RADIUS,
): Vec3Like {
  const tangent = add(scale(forward, forwardMeters), scale(right, rightMeters));
  const tangentLength = length(tangent);
  if (tangentLength < 1e-6) return normalize(origin);
  const axis = scale(tangent, 1 / tangentLength);
  const angle = tangentLength / planetRadius;
  return normalize(add(scale(origin, Math.cos(angle)), scale(axis, Math.sin(angle))));
}

function findLandingTileNear(geo: Goldberg, columns: Columns, startTile: number): number {
  const queue = [startTile];
  const seen = new Set<number>(queue);
  let fallback = startTile;
  while (queue.length > 0 && seen.size < 140) {
    const id = queue.shift()!;
    const height = columns.heightOf(id);
    if (height > 5) return id;
    if (height > columns.heightOf(fallback)) fallback = id;
    const deg = geo.degreeOf(id);
    for (let k = 0; k < deg; k++) {
      const n = geo.neighbor(id, k);
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return fallback;
}

function tangentToward(from: Vec3Like, to: Vec3Like, fallback: Vec3Like): Vec3Like {
  const projected = sub(to, scale(from, dot(to, from)));
  return normalize(projected, fallback);
}

function frameForTarget(unit: Vec3Like, nextUnit: Vec3Like, fallbackForward: Vec3Like): {
  forward: Vec3Like;
  right: Vec3Like;
  up: Vec3Like;
} {
  const up = normalize(unit);
  const forward = tangentToward(up, nextUnit, fallbackForward);
  const right = normalize(cross(forward, up), cross(fallbackForward, up));
  return { forward, right, up };
}

export function buildCourierRoutes(
  geo: Goldberg,
  layers: Layers,
  columns: Columns,
  spawnTile: number,
): CourierRoute[] {
  const spawnFrame = geo.frameOf(spawnTile);
  const origin = tileUnit(geo, spawnTile);
  const routeForward = normalize({
    x: spawnFrame.east[0] * 0.72 + spawnFrame.north[0] * 0.28,
    y: spawnFrame.east[1] * 0.72 + spawnFrame.north[1] * 0.28,
    z: spawnFrame.east[2] * 0.72 + spawnFrame.north[2] * 0.28,
  }, { x: spawnFrame.east[0], y: spawnFrame.east[1], z: spawnFrame.east[2] });
  const routeRight = normalize(cross(routeForward, origin));

  return COURIER_ROUTE_DEFINITIONS.map((definition, routeIndex) => {
    const yawOffset = routeIndex === 0 ? 0 : -0.72;
    const f = normalize(add(
      scale(routeForward, Math.cos(yawOffset)),
      scale(routeRight, Math.sin(yawOffset)),
    ), routeForward);
    const r = normalize(cross(f, origin), routeRight);

    const rawUnits = definition.targets.map((target) =>
      unitFromTangentOffset(origin, f, r, target.forwardMeters, target.rightMeters),
    );
    const startGround = surfaceRadius(layers, columns, spawnTile);
    const start = {
      tileId: spawnTile,
      unit: clone(origin),
      position: scale(origin, startGround + 1.3),
      forward: f,
      right: r,
      up: clone(origin),
    };
    let ringNumber = 0;
    const targets = definition.targets.map((spec, index) => {
      let tileId = geo.tileOf(rawUnits[index].x, rawUnits[index].y, rawUnits[index].z);
      if (spec.kind === 'pad') tileId = findLandingTileNear(geo, columns, tileId);
      const unit = tileUnit(geo, tileId);
      const nextUnit = index + 1 < rawUnits.length ? rawUnits[index + 1] : unitFromTangentOffset(unit, f, r, 90, 0);
      const frame = frameForTarget(unit, nextUnit, f);
      const ground = surfaceRadius(layers, columns, tileId);
      if (spec.kind === 'ring') ringNumber++;
      return {
        kind: spec.kind,
        id: spec.id,
        index,
        ringNumber: spec.kind === 'ring' ? ringNumber : 0,
        tileId,
        unit,
        position: scale(unit, ground + spec.agl),
        forward: frame.forward,
        right: frame.right,
        up: frame.up,
        radius: spec.radius,
        agl: spec.agl,
        score: spec.score,
        bonusSeconds: spec.bonusSeconds,
      };
    });
    return {
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      startAgl: definition.startAgl,
      starterThrottle: definition.starterThrottle,
      medalSeconds: definition.medalSeconds,
      start,
      targets,
      ringCount: targets.filter((target) => target.kind === 'ring').length,
    };
  });
}
