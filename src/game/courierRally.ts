import {
  distance,
  dot,
  sub,
  type CourierRoute,
  type CourierTarget,
  type Vec3Like,
} from './courierRoutes';

export type CourierRallyStatus = 'menu' | 'countdown' | 'running' | 'paused' | 'complete' | 'failed';

export interface CourierPlayerSample {
  position: Vec3Like;
  velocity: Vec3Like;
  mode: string;
  speed: number;
  agl: number;
  planeStowed: boolean;
  submerged: number;
}

export type CourierRallyEvent =
  | { type: 'route.selected'; route: CourierRoute }
  | { type: 'route.started'; route: CourierRoute }
  | { type: 'ring.passed'; target: CourierTarget; score: number; chain: number }
  | { type: 'route.completed'; result: CourierRouteResult }
  | { type: 'route.failed'; reason: string }
  | { type: 'route.restarted'; route: CourierRoute }
  | { type: 'ui.click' };

export interface CourierRouteResult {
  routeId: string;
  routeName: string;
  elapsedSeconds: number;
  adjustedSeconds: number;
  ringsHit: number;
  ringCount: number;
  score: number;
  bestChain: number;
  landingQuality: number;
  medal: 'Gold' | 'Silver' | 'Bronze' | 'Complete';
}

export interface CourierRallySnapshot {
  status: CourierRallyStatus;
  routeId: string | null;
  routeName: string;
  objective: string;
  targetLabel: string;
  hint: string;
  elapsedSeconds: number;
  adjustedSeconds: number;
  score: number;
  chain: number;
  bestChain: number;
  ringsHit: number;
  ringCount: number;
  targetIndex: number;
  targetCount: number;
  countdownSeconds: number;
  result: CourierRouteResult | null;
  failReason: string;
}

const COUNTDOWN_SECONDS = 3;
const MISS_GRACE_SECONDS = 1.25;
const LANDING_MAX_SPEED = 62;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatRingLabel(target: CourierTarget, ringCount: number): string {
  return `Ring ${target.ringNumber}/${ringCount}`;
}

function medalFor(route: CourierRoute, adjustedSeconds: number): CourierRouteResult['medal'] {
  if (adjustedSeconds <= route.medalSeconds.gold) return 'Gold';
  if (adjustedSeconds <= route.medalSeconds.silver) return 'Silver';
  if (adjustedSeconds <= route.medalSeconds.bronze) return 'Bronze';
  return 'Complete';
}

export class CourierRally {
  readonly routes: CourierRoute[];
  selectedRouteId: string;
  status: CourierRallyStatus = 'menu';
  private route: CourierRoute | null = null;
  private targetIndex = 0;
  private elapsedSeconds = 0;
  private bonusSeconds = 0;
  private score = 0;
  private chain = 0;
  private bestChain = 0;
  private ringsHit = 0;
  private countdownSeconds = COUNTDOWN_SECONDS;
  private failReason = '';
  private result: CourierRouteResult | null = null;
  private events: CourierRallyEvent[] = [];

  constructor(routes: CourierRoute[]) {
    if (routes.length === 0) throw new Error('CourierRally requires at least one route');
    this.routes = routes;
    this.selectedRouteId = routes[0].id;
  }

  get activeRoute(): CourierRoute | null {
    return this.route;
  }

  get selectedRoute(): CourierRoute {
    return this.routes.find((route) => route.id === this.selectedRouteId) ?? this.routes[0];
  }

  showMenu(): void {
    this.status = 'menu';
    this.route = null;
    this.result = null;
    this.failReason = '';
  }

  selectRoute(routeId: string): CourierRoute {
    const route = this.routes.find((item) => item.id === routeId) ?? this.routes[0];
    this.selectedRouteId = route.id;
    this.events.push({ type: 'route.selected', route });
    return route;
  }

  startRoute(routeId = this.selectedRouteId): CourierRoute {
    const route = this.selectRoute(routeId);
    this.route = route;
    this.status = 'countdown';
    this.targetIndex = 0;
    this.elapsedSeconds = 0;
    this.bonusSeconds = 0;
    this.score = 0;
    this.chain = 0;
    this.bestChain = 0;
    this.ringsHit = 0;
    this.countdownSeconds = COUNTDOWN_SECONDS;
    this.failReason = '';
    this.result = null;
    return route;
  }

  restartRoute(): CourierRoute | null {
    if (!this.route) return null;
    const route = this.startRoute(this.route.id);
    this.events.push({ type: 'route.restarted', route });
    return route;
  }

  pause(): void {
    if (this.status === 'running' || this.status === 'countdown') this.status = 'paused';
  }

  resume(): void {
    if (this.status === 'paused') this.status = 'running';
  }

  isPlayerControlBlocked(): boolean {
    return this.status === 'menu'
      || this.status === 'countdown'
      || this.status === 'paused'
      || this.status === 'complete'
      || this.status === 'failed';
  }

  update(deltaSeconds: number, sample: CourierPlayerSample): CourierRallyEvent[] {
    if (!this.route) return this.drainEvents();

    if (this.status === 'countdown') {
      this.countdownSeconds = Math.max(0, this.countdownSeconds - deltaSeconds);
      if (this.countdownSeconds <= 0) {
        this.status = 'running';
        this.events.push({ type: 'route.started', route: this.route });
      }
      return this.drainEvents();
    }

    if (this.status !== 'running') return this.drainEvents();

    this.elapsedSeconds += deltaSeconds;
    const target = this.route.targets[this.targetIndex];
    if (!target) return this.drainEvents();

    if (target.kind !== 'pad' && (sample.planeStowed || sample.mode !== 'plane')) {
      this.fail('Courier plane stowed before delivery');
      return this.drainEvents();
    }

    if (target.kind === 'ring') {
      this.updateRing(target, sample);
      return this.drainEvents();
    }

    this.updateLanding(target, sample);
    return this.drainEvents();
  }

  getSnapshot(): CourierRallySnapshot {
    const route = this.route;
    const target = route?.targets[this.targetIndex] ?? null;
    let objective = 'Choose a route';
    let targetLabel = 'Menu';
    let hint = 'Pick a route and launch when ready.';
    if (route && this.status === 'countdown') {
      objective = 'Launch prep';
      targetLabel = `Start in ${Math.ceil(this.countdownSeconds)}`;
      hint = 'Throttle up when the count clears.';
    } else if (route && target?.kind === 'ring') {
      objective = 'Fly the ring route';
      targetLabel = formatRingLabel(target, route.ringCount);
      hint = this.ringsHit === 0 ? 'Aim through the center and keep altitude above terrain.' : 'Chain rings for score and time bonuses.';
    } else if (route && target?.kind === 'pad') {
      objective = 'Deliver cargo';
      targetLabel = 'Landing pad';
      hint = 'Reduce speed, touch down inside the marked pad, and keep wings level.';
    }
    if (this.status === 'paused') hint = 'Paused';
    if (this.status === 'failed') {
      objective = 'Delivery failed';
      targetLabel = 'Retry ready';
      hint = this.failReason;
    }
    if (this.status === 'complete' && this.result) {
      objective = 'Delivery complete';
      targetLabel = this.result.medal;
      hint = `${this.result.ringsHit}/${this.result.ringCount} rings, landing ${this.result.landingQuality}%`;
    }
    return {
      status: this.status,
      routeId: route?.id ?? null,
      routeName: route?.name ?? this.selectedRoute.name,
      objective,
      targetLabel,
      hint,
      elapsedSeconds: this.elapsedSeconds,
      adjustedSeconds: Math.max(0, this.elapsedSeconds - this.bonusSeconds),
      score: this.score,
      chain: this.chain,
      bestChain: this.bestChain,
      ringsHit: this.ringsHit,
      ringCount: route?.ringCount ?? 0,
      targetIndex: this.targetIndex,
      targetCount: route?.targets.length ?? 0,
      countdownSeconds: this.countdownSeconds,
      result: this.result,
      failReason: this.failReason,
    };
  }

  drainEvents(): CourierRallyEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private updateRing(target: CourierTarget, sample: CourierPlayerSample): void {
    const d = distance(sample.position, target.position);
    if (d <= target.radius) {
      this.ringsHit++;
      this.chain++;
      this.bestChain = Math.max(this.bestChain, this.chain);
      const chainBonus = Math.max(0, this.chain - 1) * 85;
      this.score += target.score + chainBonus;
      this.bonusSeconds += target.bonusSeconds;
      this.events.push({ type: 'ring.passed', target, score: this.score, chain: this.chain });
      this.targetIndex++;
      return;
    }

    if (this.elapsedSeconds < MISS_GRACE_SECONDS) return;
    const pastPlaneMeters = dot(sub(sample.position, target.position), target.forward);
    if (pastPlaneMeters > target.radius * 2.2 && d > target.radius * 1.25) {
      this.fail(`Missed ${formatRingLabel(target, this.route?.ringCount ?? 0)}`);
    }
  }

  private updateLanding(target: CourierTarget, sample: CourierPlayerSample): void {
    const d = distance(sample.position, target.position);
    const insidePad = d <= target.radius;
    if (insidePad && (sample.planeStowed || sample.mode !== 'plane' || sample.agl <= 2.5)) {
      const centerRatio = clamp01(1 - d / target.radius);
      const speedRatio = clamp01(1 - sample.speed / LANDING_MAX_SPEED);
      const waterPenalty = sample.submerged > 0.2 ? 0.25 : 0;
      const landingQuality = Math.round(clamp01(centerRatio * 0.65 + speedRatio * 0.35 - waterPenalty) * 100);
      this.score += target.score + Math.round(landingQuality * 18);
      const adjustedSeconds = Math.max(0, this.elapsedSeconds - this.bonusSeconds);
      this.result = {
        routeId: this.route!.id,
        routeName: this.route!.name,
        elapsedSeconds: this.elapsedSeconds,
        adjustedSeconds,
        ringsHit: this.ringsHit,
        ringCount: this.route!.ringCount,
        score: this.score,
        bestChain: this.bestChain,
        landingQuality,
        medal: medalFor(this.route!, adjustedSeconds),
      };
      this.status = 'complete';
      this.events.push({ type: 'route.completed', result: this.result });
      return;
    }

    if (sample.planeStowed || sample.mode !== 'plane') {
      this.fail(insidePad ? 'Touchdown was unstable' : 'Landed outside the delivery pad');
      return;
    }

    const pastPlaneMeters = dot(sub(sample.position, target.position), target.forward);
    if (pastPlaneMeters > target.radius * 3 && d > target.radius * 1.5) {
      this.fail('Overshot the delivery pad');
    }
  }

  private fail(reason: string): void {
    this.status = 'failed';
    this.failReason = reason;
    this.chain = 0;
    this.events.push({ type: 'route.failed', reason });
  }
}
