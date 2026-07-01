/**
 * Scripted demos that double as measurements:
 *  - traversal: a full great-circle circumnavigation at low altitude and speed,
 *    terrain-following, streaming chunks in ahead and releasing behind. Captures
 *    frame times for the whole lap.
 *  - orbit: smooth pull-back from the surface until the planet fits in frame, hold,
 *    and return. Captures the transition.
 */

import type { Player } from '../player/player';
import type { Columns } from '../world/columns';
import type { Layers } from '../world/layers';
import type { Goldberg } from '../geo/goldberg';
import type { Metrics } from './metrics';

const SPEED = 110;
const TARGET_AGL = 55;

export class Autopilot {
  active = false;
  private ax = 0; private ay = 0; private az = 1;
  private lap = 0;
  private startAnnounced = false;

  constructor(
    private readonly geo: Goldberg,
    private readonly layers: Layers,
    private readonly columns: Columns,
    private readonly metrics: Metrics,
    private readonly onDone: (msg: string) => void,
  ) {}

  toggle(player: Player): void {
    if (this.active) { this.stop('traversal aborted'); return; }
    this.active = true;
    this.lap = 0;
    this.startAnnounced = false;
    player.mode = 'fly';
    const [ux, uy, uz] = player.up();
    // axis = up x forward -> rotating around it moves along forward's great circle
    let ax = uy * player.fwdZ - uz * player.fwdY;
    let ay = uz * player.fwdX - ux * player.fwdZ;
    let az = ux * player.fwdY - uy * player.fwdX;
    const l = Math.hypot(ax, ay, az) || 1;
    this.ax = -ax / l; this.ay = -ay / l; this.az = -az / l;
    this.metrics.begin('traversal');
  }

  private stop(msg: string): void {
    this.active = false;
    const report = this.metrics.end();
    this.onDone(report ? `${msg} · avg ${report.fpsAvg.toFixed(0)} fps · p99 ${report.frameP99Ms.toFixed(1)} ms · ${report.chunkLoads} loads / ${report.chunkReleases} releases` : msg);
  }

  update(dt: number, player: Player): void {
    if (!this.active) return;
    const r = player.radius();
    const omega = SPEED / r;
    const ang = omega * dt;
    this.lap += ang;

    // rotate position direction around axis
    let dx = player.px / r, dy = player.py / r, dz = player.pz / r;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const dot = this.ax * dx + this.ay * dy + this.az * dz;
    const crx = this.ay * dz - this.az * dy;
    const cry = this.az * dx - this.ax * dz;
    const crz = this.ax * dy - this.ay * dx;
    dx = dx * cos + crx * sin + this.ax * dot * (1 - cos);
    dy = dy * cos + cry * sin + this.ay * dot * (1 - cos);
    dz = dz * cos + crz * sin + this.az * dot * (1 - cos);
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl; dy /= dl; dz /= dl;

    // terrain-follow: sample ground here and slightly ahead, keep AGL
    const tileHere = this.geo.tileOf(dx, dy, dz);
    const lookAheadAng = (SPEED * 2.4) / r;
    const cosA = Math.cos(lookAheadAng), sinA = Math.sin(lookAheadAng);
    const dotA = this.ax * dx + this.ay * dy + this.az * dz;
    const carx = this.ay * dz - this.az * dy, cary = this.az * dx - this.ax * dz, carz = this.ax * dy - this.ay * dx;
    const ahx = dx * cosA + carx * sinA + this.ax * dotA * (1 - cosA);
    const ahy = dy * cosA + cary * sinA + this.ay * dotA * (1 - cosA);
    const ahz = dz * cosA + carz * sinA + this.az * dotA * (1 - cosA);
    const tileAhead = this.geo.tileOf(ahx, ahy, ahz);
    const gHere = this.layers.topRadius(this.columns.groundLayerBelow(tileHere, this.layers.bounds[0]));
    const gAhead = this.layers.topRadius(this.columns.groundLayerBelow(tileAhead, this.layers.bounds[0]));
    const targetR = Math.max(gHere, gAhead) + TARGET_AGL;
    let newR = r + (targetR - r) * Math.min(1, 3.0 * dt);
    newR = Math.max(newR, gHere + 12); // hard floor over ridge crests

    player.px = dx * newR; player.py = dy * newR; player.pz = dz * newR;
    player.tile = tileHere;
    // heading = direction of motion (axis x dir), transported
    const vx = this.ay * dz - this.az * dy;
    const vy = this.az * dx - this.ax * dz;
    const vz = this.ax * dy - this.ay * dx;
    const vl = Math.hypot(vx, vy, vz) || 1;
    player.fwdX = vx / vl; player.fwdY = vy / vl; player.fwdZ = vz / vl;
    player.vx = (vx / vl) * SPEED; player.vy = (vy / vl) * SPEED; player.vz = (vz / vl) * SPEED;
    player.pitch = -0.12;
    player.reorthonormalize();

    if (!this.startAnnounced) { this.startAnnounced = true; }
    if (this.lap >= Math.PI * 2 + 0.02) {
      this.stop('traversal complete: full circumnavigation');
      player.vx = 0; player.vy = 0; player.vz = 0;
    }
  }
}

/** Orbit pull-back demo: zoom exponent 0 -> 1 -> hold -> 0, capturing frame times. */
export class OrbitDemo {
  active = false;
  private phase = 0; // 0 out, 1 hold, 2 in
  private t = 0;
  readonly outSec = 8;
  readonly holdSec = 2.5;

  constructor(private readonly metrics: Metrics, private readonly onDone: (msg: string) => void) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.phase = 0;
    this.t = 0;
    this.metrics.begin('orbit');
  }

  /** returns the zoom exponent override, or null when idle */
  update(dt: number): number | null {
    if (!this.active) return null;
    this.t += dt;
    const ease = (x: number): number => x * x * (3 - 2 * x);
    if (this.phase === 0) {
      const u = Math.min(1, this.t / this.outSec);
      if (u >= 1) { this.phase = 1; this.t = 0; }
      return ease(u);
    }
    if (this.phase === 1) {
      if (this.t >= this.holdSec) { this.phase = 2; this.t = 0; }
      return 1;
    }
    const u = Math.min(1, this.t / this.outSec);
    if (u >= 1) {
      this.active = false;
      const r = this.metrics.end();
      this.onDone(r ? `orbit round-trip · avg ${r.fpsAvg.toFixed(0)} fps · p99 ${r.frameP99Ms.toFixed(1)} ms` : 'orbit done');
      return 0;
    }
    return ease(1 - u);
  }
}
