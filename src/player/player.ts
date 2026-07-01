/**
 * Player simulation in f64 planet-centered coordinates.
 *
 * "Up" is always the local radial direction — the sphere's surface normal — so orientation
 * follows the ground everywhere, pentagons included; there is no world up anywhere in here.
 * Heading is a tangent vector parallel-transported as the player moves (re-orthonormalized
 * against up each frame), which is what makes walking over the whole sphere seamless:
 * no poles, no gimbal, no global chart.
 *
 * Movement states:
 *  - walk: gravity toward the core, jump with space
 *  - glide: hold space while airborne — an arcade wing. Nose down trades altitude for
 *    speed, flare bleeds speed for lift, velocity chases the view direction so mouse
 *    carving banks smoothly. Stows on landing, on release, or on water contact.
 *  - swim: buoyancy floats the player at the surface of the sea
 *  - fly: creative free-flight (F), kept for inspection/debugging
 */

import type { Columns } from '../world/columns';
import type { Layers } from '../world/layers';
import type { Goldberg } from '../geo/goldberg';
import { WATER_SURFACE } from '../world/layers';

export type MoveMode = 'walk' | 'fly';

const EYE_HEIGHT = 1.65;
const BODY_HEIGHT = 1.8;
const STEP_UP = 1.35;
const GRAVITY = 14;
const JUMP_V = 7.4;
const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const FLY_ACCEL = 55;
const FLY_DRAG = 2.1;
const FLY_BOOST = 3.2;
const MAX_FALL = 55;

// glider tuning: trim glide ratio ~9:1, dive to 42 m/s, mushy stall under 11 m/s
const GLIDE_TRIM = 15;
const GLIDE_MIN = 7;
const GLIDE_MAX = 42;
const GLIDE_SINK = 1.6;
const GLIDE_STEER = 4.5;

export interface PlayerInput {
  forward: number;
  strafe: number;
  upDown: number;
  sprint: boolean;
  jump: boolean;
  glideHeld: boolean;
}

export class Player {
  // f64 planet-frame state
  px = 0; py = 0; pz = 0;          // feet position
  vx = 0; vy = 0; vz = 0;
  fwdX = 1; fwdY = 0; fwdZ = 0;    // transported tangent heading
  pitch = 0;
  mode: MoveMode = 'walk';
  grounded = false;
  gliding = false;
  submerged = 0;                   // meters of body below the water surface
  glideSpeed = GLIDE_TRIM;
  bank = 0;                        // smoothed roll for the character model
  forceGlide = false;              // demo hook: behave as if space is held
  tile = 0;

  constructor(
    private readonly geo: Goldberg,
    private readonly layers: Layers,
    private readonly columns: Columns,
  ) {}

  spawnAt(tileId: number): void {
    const c = this.geo.centers;
    const x = c[tileId * 3], y = c[tileId * 3 + 1], z = c[tileId * 3 + 2];
    const ground = this.layers.topRadius(this.columns.groundLayerBelow(tileId, this.layers.bounds[0]));
    this.px = x * (ground + 0.05);
    this.py = y * (ground + 0.05);
    this.pz = z * (ground + 0.05);
    this.tile = tileId;
    const f = this.geo.frameOf(tileId);
    this.fwdX = f.east[0]; this.fwdY = f.east[1]; this.fwdZ = f.east[2];
  }

  radius(): number { return Math.hypot(this.px, this.py, this.pz); }

  up(): [number, number, number] {
    const r = this.radius();
    return [this.px / r, this.py / r, this.pz / r];
  }

  /** altitude above local ground surface (AGL) */
  altitudeAGL(): number {
    const r = this.radius();
    const k = this.columns.groundLayerBelow(this.tile, r);
    return r - this.layers.topRadius(k);
  }

  eye(): [number, number, number] {
    const [ux, uy, uz] = this.up();
    return [this.px + ux * EYE_HEIGHT, this.py + uy * EYE_HEIGHT, this.pz + uz * EYE_HEIGHT];
  }

  applyLook(dx: number, dy: number): void {
    const yaw = -dx * 0.0023;
    const [ux, uy, uz] = this.up();
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const dot = this.fwdX * ux + this.fwdY * uy + this.fwdZ * uz;
    const crx = uy * this.fwdZ - uz * this.fwdY;
    const cry = uz * this.fwdX - ux * this.fwdZ;
    const crz = ux * this.fwdY - uy * this.fwdX;
    this.fwdX = this.fwdX * cos + crx * sin + ux * dot * (1 - cos);
    this.fwdY = this.fwdY * cos + cry * sin + uy * dot * (1 - cos);
    this.fwdZ = this.fwdZ * cos + crz * sin + uz * dot * (1 - cos);
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0023));
    this.reorthonormalize();
  }

  /** keep heading tangent to the sphere as position changes (parallel transport step) */
  reorthonormalize(): void {
    const [ux, uy, uz] = this.up();
    const d = this.fwdX * ux + this.fwdY * uy + this.fwdZ * uz;
    let fx = this.fwdX - d * ux, fy = this.fwdY - d * uy, fz = this.fwdZ - d * uz;
    const l = Math.hypot(fx, fy, fz);
    if (l < 1e-9) {
      const ax = Math.abs(ux) < 0.9 ? 1 : 0, ay = Math.abs(ux) < 0.9 ? 0 : 1;
      fx = uy * 0 - uz * ay; fy = uz * ax - ux * 0; fz = ux * ay - uy * ax;
      const l2 = Math.hypot(fx, fy, fz);
      fx /= l2; fy /= l2; fz /= l2;
    } else {
      fx /= l; fy /= l; fz /= l;
    }
    this.fwdX = fx; this.fwdY = fy; this.fwdZ = fz;
  }

  toggleFly(): void {
    this.mode = this.mode === 'walk' ? 'fly' : 'walk';
    this.gliding = false;
    if (this.mode === 'fly') {
      const [ux, uy, uz] = this.up();
      this.vx += ux * 3; this.vy += uy * 3; this.vz += uz * 3;
      this.grounded = false;
    }
  }

  update(dt: number, input: PlayerInput): void {
    const [ux, uy, uz] = this.up();
    this.reorthonormalize();
    const fx = this.fwdX, fy = this.fwdY, fz = this.fwdZ;
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const glideHeld = input.glideHeld || this.forceGlide;
    const r0 = this.radius();
    this.submerged = Math.max(0, WATER_SURFACE - r0);
    const prevFwdX = fx, prevFwdY = fy, prevFwdZ = fz;

    // --- glider state transitions ---
    if (this.mode === 'walk') {
      const canGlide = !this.grounded && glideHeld && this.submerged <= 0 && this.altitudeAGL() > 1.2;
      if (!this.gliding && canGlide) {
        this.gliding = true;
        // carry momentum into the wing
        this.glideSpeed = Math.max(GLIDE_TRIM * 0.7, Math.min(GLIDE_MAX, Math.hypot(this.vx, this.vy, this.vz)));
      }
      if (this.gliding && (!glideHeld || this.grounded || this.submerged > 0)) {
        this.gliding = false;
      }
    } else {
      this.gliding = false;
    }

    if (this.mode === 'walk' && this.gliding) {
      // --- glide: velocity chases the pitched view direction ---
      const gp = Math.max(-1.0, Math.min(1.0, this.pitch));
      const cosP = Math.cos(gp), sinP = Math.sin(gp);
      const vfx = fx * cosP + ux * sinP, vfy = fy * cosP + uy * sinP, vfz = fz * cosP + uz * sinP;
      const noseDown = -(vfx * ux + vfy * uy + vfz * uz); // >0 diving
      this.glideSpeed += (noseDown * GRAVITY * 1.35 - (this.glideSpeed - GLIDE_TRIM) * 0.5) * dt;
      this.glideSpeed = Math.max(GLIDE_MIN, Math.min(GLIDE_MAX, this.glideSpeed));
      const sink = GLIDE_SINK + Math.max(0, 11 - this.glideSpeed) * 0.6;
      const tx = vfx * this.glideSpeed - ux * sink;
      const ty = vfy * this.glideSpeed - uy * sink;
      const tz = vfz * this.glideSpeed - uz * sink;
      const blend = Math.min(1, GLIDE_STEER * dt);
      this.vx += (tx - this.vx) * blend;
      this.vy += (ty - this.vy) * blend;
      this.vz += (tz - this.vz) * blend;
    } else if (this.mode === 'walk') {
      const speed = (input.sprint ? SPRINT_SPEED : WALK_SPEED) * (this.submerged > 0.6 ? 0.5 : 1);
      const wx = (fx * input.forward + rx * input.strafe);
      const wy = (fy * input.forward + ry * input.strafe);
      const wz = (fz * input.forward + rz * input.strafe);
      const wl = Math.hypot(wx, wy, wz);
      const twx = wl > 1e-6 ? (wx / wl) * speed : 0;
      const twy = wl > 1e-6 ? (wy / wl) * speed : 0;
      const twz = wl > 1e-6 ? (wz / wl) * speed : 0;
      let vr = this.vx * ux + this.vy * uy + this.vz * uz;
      let tx2 = this.vx - vr * ux, ty2 = this.vy - vr * uy, tz2 = this.vz - vr * uz;
      const blend = Math.min(1, (this.grounded ? 14 : 3.5) * dt);
      tx2 += (twx - tx2) * blend; ty2 += (twy - ty2) * blend; tz2 += (twz - tz2) * blend;
      vr -= GRAVITY * dt;
      if (vr < -MAX_FALL) vr = -MAX_FALL;
      if (input.jump && this.grounded) { vr = JUMP_V; this.grounded = false; }
      // buoyancy: float with head above water (equilibrium ~1.4 m of body submerged),
      // brisk rise from depth, swim up with space
      if (this.submerged > 0) {
        const push = Math.min(this.submerged, 5);
        vr += (push * 10 - vr * 3) * dt;
        if (glideHeld) vr += 7 * dt;
        tx2 *= Math.exp(-0.9 * dt); ty2 *= Math.exp(-0.9 * dt); tz2 *= Math.exp(-0.9 * dt);
      }
      this.vx = tx2 + vr * ux; this.vy = ty2 + vr * uy; this.vz = tz2 + vr * uz;
    } else {
      // fly (creative)
      const boost = input.sprint ? FLY_BOOST : 1;
      const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
      const vfx = fx * cosP + ux * sinP, vfy = fy * cosP + uy * sinP, vfz = fz * cosP + uz * sinP;
      const ax = (vfx * input.forward + rx * input.strafe + ux * input.upDown) * FLY_ACCEL * boost;
      const ay = (vfy * input.forward + ry * input.strafe + uy * input.upDown) * FLY_ACCEL * boost;
      const az = (vfz * input.forward + rz * input.strafe + uz * input.upDown) * FLY_ACCEL * boost;
      this.vx += ax * dt; this.vy += ay * dt; this.vz += az * dt;
      const drag = Math.exp(-FLY_DRAG * dt);
      this.vx *= drag; this.vy *= drag; this.vz *= drag;
    }

    // --- integrate with horizontal wall blocking ---
    const nx = this.px + this.vx * dt, ny = this.py + this.vy * dt, nz = this.pz + this.vz * dt;
    const newTile = this.geo.tileOf(nx, ny, nz);
    let blocked = false;
    if (newTile !== this.tile) {
      const groundK = this.columns.groundLayerBelow(newTile, r0 + STEP_UP);
      const groundR = this.layers.topRadius(groundK);
      if (groundR - r0 > STEP_UP) blocked = true;
      const ceilK = this.columns.ceilingLayerAbove(newTile, Math.min(groundR + 0.01, r0) + 0.05);
      if (ceilK >= 0) {
        const gap = this.layers.bottomRadius(ceilK) - Math.max(groundR, r0 - 0.1);
        if (gap < BODY_HEIGHT) blocked = true;
      }
    }
    if (blocked) {
      const vr = this.vx * ux + this.vy * uy + this.vz * uz;
      this.px += ux * vr * dt; this.py += uy * vr * dt; this.pz += uz * vr * dt;
      this.vx = ux * vr; this.vy = uy * vr; this.vz = uz * vr;
      this.gliding = false; // wing folds on impact
    } else {
      this.px = nx; this.py = ny; this.pz = nz;
      this.tile = newTile;
    }

    // --- radial collision in the current column ---
    const r = this.radius();
    const [nux, nuy, nuz] = this.up();
    const groundK = this.columns.groundLayerBelow(this.tile, r + (this.grounded ? STEP_UP : 0.05));
    const groundR = this.layers.topRadius(groundK);
    const vr = this.vx * nux + this.vy * nuy + this.vz * nuz;
    if (r <= groundR + 0.02) {
      if (vr <= 0.01 || this.grounded) {
        const scale = (groundR + 0.001) / r;
        this.px *= scale; this.py *= scale; this.pz *= scale;
        if (vr < 0) {
          this.vx -= vr * nux; this.vy -= vr * nuy; this.vz -= vr * nuz;
        }
        this.grounded = true;
        this.gliding = false;
      }
    } else if (r - groundR > 0.06) {
      this.grounded = false;
    }

    // head bump
    const ceilK = this.columns.ceilingLayerAbove(this.tile, r + 0.05);
    if (ceilK >= 0) {
      const ceilR = this.layers.bottomRadius(ceilK);
      if (r + BODY_HEIGHT > ceilR) {
        const scale = Math.max(0.5, (ceilR - BODY_HEIGHT) / r);
        this.px *= scale; this.py *= scale; this.pz *= scale;
        const vr2 = this.vx * nux + this.vy * nuy + this.vz * nuz;
        if (vr2 > 0) {
          this.vx -= vr2 * nux; this.vy -= vr2 * nuy; this.vz -= vr2 * nuz;
        }
      }
    }

    // hard floor: never below bedrock top
    const minR = this.layers.bounds[this.layers.L] + 1;
    const r2 = this.radius();
    if (r2 < minR) {
      const s = minR / r2;
      this.px *= s; this.py *= s; this.pz *= s;
    }

    // smoothed bank (roll) for the character model, from heading turn rate
    const turn = (prevFwdX * this.fwdY - prevFwdY * this.fwdX) * nuz
      + (prevFwdY * this.fwdZ - prevFwdZ * this.fwdY) * nux
      + (prevFwdZ * this.fwdX - prevFwdX * this.fwdZ) * nuy;
    const targetBank = this.gliding ? Math.max(-0.7, Math.min(0.7, (turn / Math.max(dt, 1e-4)) * 0.35)) : 0;
    this.bank += (targetBank - this.bank) * Math.min(1, 6 * dt);
  }
}
