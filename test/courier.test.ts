import { describe, expect, it } from 'vitest';
import { Goldberg } from '../src/geo/goldberg';
import { buildLayers } from '../src/world/layers';
import { Terrain } from '../src/world/terrain';
import { Columns } from '../src/world/columns';
import { buildCourierRoutes, dot, scale, add } from '../src/game/courierRoutes';
import { CourierRally, type CourierPlayerSample } from '../src/game/courierRally';

function buildTestRoutes() {
  const geo = new Goldberg(16);
  const layers = buildLayers();
  const columns = new Columns(geo, layers, new Terrain('courier-test'));
  const spawnTile = 0;
  return buildCourierRoutes(geo, layers, columns, spawnTile);
}

function sampleAt(position: { x: number; y: number; z: number }, overrides: Partial<CourierPlayerSample> = {}): CourierPlayerSample {
  return {
    position,
    velocity: { x: 0, y: 0, z: 0 },
    mode: 'plane',
    speed: 42,
    agl: 35,
    planeStowed: false,
    submerged: 0,
    ...overrides,
  };
}

describe('courier routes', () => {
  it('builds maintainable spherical routes with rings and a landing pad', () => {
    const routes = buildTestRoutes();
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.targets.length).toBeGreaterThan(4);
      expect(route.targets[route.targets.length - 1].kind).toBe('pad');
      expect(route.ringCount).toBe(route.targets.length - 1);
      for (const target of route.targets) {
        expect(Number.isFinite(target.position.x)).toBe(true);
        expect(Number.isFinite(target.position.y)).toBe(true);
        expect(Number.isFinite(target.position.z)).toBe(true);
        expect(Math.hypot(target.unit.x, target.unit.y, target.unit.z)).toBeCloseTo(1, 6);
        expect(Math.abs(dot(target.unit, target.forward))).toBeLessThan(1e-6);
        expect(Math.abs(dot(target.unit, target.right))).toBeLessThan(1e-6);
      }
    }
  });
});

describe('courier rally state', () => {
  it('counts down, scores rings, and completes on the delivery pad', () => {
    const [route] = buildTestRoutes();
    const rally = new CourierRally([route]);
    rally.startRoute(route.id);
    let events = rally.update(3.1, sampleAt(route.start.position));
    expect(events.some((event) => event.type === 'route.started')).toBe(true);
    expect(rally.getSnapshot().status).toBe('running');

    for (const target of route.targets) {
      if (target.kind === 'ring') {
        events = rally.update(0.25, sampleAt(target.position));
        expect(events.some((event) => event.type === 'ring.passed')).toBe(true);
      } else {
        events = rally.update(0.25, sampleAt(target.position, {
          mode: 'walk',
          speed: 20,
          agl: 0.4,
          planeStowed: true,
        }));
        expect(events.some((event) => event.type === 'route.completed')).toBe(true);
      }
    }

    const snapshot = rally.getSnapshot();
    expect(snapshot.status).toBe('complete');
    expect(snapshot.result?.ringsHit).toBe(route.ringCount);
    expect(snapshot.result?.landingQuality).toBeGreaterThan(40);
  });

  it('fails when the next ring is clearly missed', () => {
    const [route] = buildTestRoutes();
    const rally = new CourierRally([route]);
    rally.startRoute(route.id);
    rally.update(3.1, sampleAt(route.start.position));
    const firstRing = route.targets[0];
    const missPosition = add(
      firstRing.position,
      add(scale(firstRing.forward, firstRing.radius * 3.2), scale(firstRing.right, firstRing.radius * 2)),
    );
    const events = rally.update(1.5, sampleAt(missPosition));
    expect(events.some((event) => event.type === 'route.failed')).toBe(true);
    expect(rally.getSnapshot().status).toBe('failed');
  });
});
