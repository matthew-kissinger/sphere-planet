/**
 * Sky: a raymarched atmosphere shell and a voxel cloud band.
 *
 * Both draw as backside spheres with depth *testing off* — the old fresnel shell was
 * depth-tested, which clipped the glow hard at the planet silhouette (the "flat edge").
 * Occlusion is instead done per pixel inside the shader: every view ray is clamped by
 * the scene depth buffer (viewportLinearDepth) and by the analytic water sphere, so the
 * glow hazes distant terrain (aerial perspective), stops at ocean, and never bleeds
 * through nearby cliffs, trees, or cave ceilings.
 *
 * All ray math runs in the planet frame: the shells are recentered on the planet every
 * frame (floating origin), so positionLocal is planet-centered and the camera sits at
 * camU = the planet-frame camera position. The fragment ray is exact — the interpolated
 * shell point IS the pixel's world position, so rd = normalize(positionLocal - camU).
 */

import * as THREE from 'three/webgpu';
import {
  Break, Fn, If, Loop,
  cameraFar, cameraNear, viewportLinearDepth,
  dot, exp, float, floor, fract, length, max, min, mix, normalize,
  positionLocal, pow, smoothstep, sqrt, time, uniform, vec3, vec4,
} from 'three/tsl';
import { PLANET_RADIUS, WATER_SURFACE } from '../world/layers';

const RG = WATER_SURFACE;             // occluder sphere + density floor
const RA = PLANET_RADIUS * 1.2;       // atmosphere top
const ATMO_H = 46;                    // density scale height (m)
const CLOUD_LO = 120;                 // cloud band above the surface (m) — clears peaks and builds
const CLOUD_HI = 165;
const CLOUD_CELL = 21;                // voxel size (m)
const R_LO = PLANET_RADIUS + CLOUD_LO;
const R_HI = PLANET_RADIUS + CLOUD_HI;

export type SkyQuality = 'high' | 'low';
const ATMO_STEPS = { high: 12, low: 8 };
const CLOUD_MARCH = { high: { steps: 44, len: 11.5 }, low: { steps: 22, len: 17 } };

/* eslint-disable @typescript-eslint/no-explicit-any */

// fract-based hash (Dave Hoskins style): stays precise for large |p|, which matters
// because cloud cells drift with time indefinitely (sin-based hashes fall apart)
const hash3 = Fn(([pIn]: any[]) => {
  const q = fract(vec3(pIn).mul(0.1031)).toVar();
  q.addAssign(dot(q, q.zyx.add(31.32)));
  return fract(q.x.add(q.y).mul(q.z));
});

// trilinear value noise over the integer lattice — smooth cloud-bank coverage
const vnoise = Fn(([pIn]: any[]) => {
  const p = vec3(pIn);
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();
  const a = mix(hash3(i), hash3(i.add(vec3(1, 0, 0))), u.x);
  const b = mix(hash3(i.add(vec3(0, 1, 0))), hash3(i.add(vec3(1, 1, 0))), u.x);
  const c = mix(hash3(i.add(vec3(0, 0, 1))), hash3(i.add(vec3(1, 0, 1))), u.x);
  const d = mix(hash3(i.add(vec3(0, 1, 1))), hash3(i.add(vec3(1, 1, 1))), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
});

export class Sky {
  readonly atmo: THREE.Mesh;
  readonly clouds: THREE.Mesh | null = null;
  /** live-tunable: atmosphere glow strength */
  readonly kGlow = uniform(0.006);
  /** live-tunable: cloud coverage threshold (lower = more cloud) */
  readonly cover = uniform(0.62);
  private readonly camU = uniform(new THREE.Vector3());
  private readonly fwdU = uniform(new THREE.Vector3(0, 0, -1));

  constructor(scene: THREE.Scene, sunDir: THREE.Vector3, quality: SkyQuality, withClouds: boolean) {
    const sunU = uniform(sunDir);
    const camU = this.camU;
    const fwdU = this.fwdU;

    // distance along the current view ray at which the depth buffer's surface sits
    const sceneT = (rd: any): any =>
      cameraNear.add(viewportLinearDepth.mul(cameraFar.sub(cameraNear))).div(max(dot(rd, fwdU), 1e-4));

    // --- atmosphere: integrate exponential density along the shell chord ---
    {
      const N = ATMO_STEPS[quality];
      const kGlow = this.kGlow;
      const shader = Fn(() => {
        const ro = vec3(camU).toVar();
        const rd = normalize(positionLocal.sub(camU)).toVar();
        const b = dot(ro, rd).toVar();
        const roro = dot(ro, ro).toVar();
        const col = vec3(0).toVar();
        const disc = b.mul(b).sub(roro).add(RA * RA).toVar();
        // camera below the water sphere = underground/underwater: no sky
        If(disc.greaterThan(0).and(roro.greaterThan(RG * RG)), () => {
          const sq = sqrt(disc);
          const t0 = max(b.negate().sub(sq), 0).toVar();
          const t1 = b.negate().add(sq).toVar();
          t1.assign(min(t1, sceneT(rd)));
          const discW = b.mul(b).sub(roro).add(RG * RG);
          If(discW.greaterThan(0), () => {
            const tw = b.negate().sub(sqrt(discW));
            If(tw.greaterThan(0), () => { t1.assign(min(t1, tw)); });
          });
          If(t1.sub(t0).greaterThan(1), () => {
            const dt = t1.sub(t0).div(N);
            const od = float(0).toVar();
            const li = float(0).toVar();
            Loop(N, ({ i }: any) => {
              const p = ro.add(rd.mul(t0.add(float(i).add(0.5).mul(dt))));
              const r = length(p);
              const dens = exp(max(r.sub(RG), 0).div(-ATMO_H));
              const day = smoothstep(-0.28, 0.22, dot(p, sunU).div(r));
              od.addAssign(dens);
              li.addAssign(dens.mul(day));
            });
            od.mulAssign(dt);
            li.mulAssign(dt);
            const glow = float(1).sub(exp(li.mul(kGlow).negate())).toVar();
            // deep blue that whitens as the glow saturates; warm band at the terminator
            const pm = ro.add(rd.mul(t0.add(t1).mul(0.5)));
            const sdm = dot(normalize(pm), sunU);
            const warm = pow(float(1).sub(min(sdm.abs().mul(2.8), 1)), 3);
            const base = mix(vec3(0.18, 0.45, 0.95), vec3(0.62, 0.78, 1.0), glow.mul(glow));
            col.assign(base.mul(glow));
            col.assign(mix(col, vec3(1.0, 0.42, 0.15).mul(glow), warm.mul(0.5)));
            // faint cold rim on the night side so the dark limb never cuts to pure black
            const night = float(1).sub(exp(od.mul(-0.0012)));
            col.addAssign(vec3(0.05, 0.08, 0.16).mul(night).mul(float(1).sub(glow)));
          });
        });
        return col;
      });
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.colorNode = shader();
      mat.transparent = true;
      mat.blending = THREE.AdditiveBlending;
      mat.depthWrite = false;
      mat.depthTest = false;
      mat.side = THREE.BackSide;
      mat.fog = false;
      this.atmo = new THREE.Mesh(new THREE.IcosahedronGeometry(RA, 4), mat);
      this.atmo.frustumCulled = false;
      this.atmo.renderOrder = 6;
      scene.add(this.atmo);
    }

    // --- voxel clouds: march the band, cell-quantized occupancy from banked noise ---
    if (withClouds) {
      const { steps: N, len: STEP } = CLOUD_MARCH[quality];
      const cover = this.cover;
      const shader = Fn(() => {
        const ro = vec3(camU).toVar();
        const rd = normalize(positionLocal.sub(camU)).toVar();
        const b = dot(ro, rd).toVar();
        const roro = dot(ro, ro).toVar();
        const acc = vec3(0).toVar();
        const trans = float(1).toVar();
        const disc = b.mul(b).sub(roro).add(R_HI * R_HI).toVar();
        If(disc.greaterThan(0).and(roro.greaterThan(RG * RG)), () => {
          const sq = sqrt(disc);
          const t0 = max(b.negate().sub(sq), 0).toVar();
          const t1 = b.negate().add(sq).toVar();
          t1.assign(min(t1, sceneT(rd)));
          const discW = b.mul(b).sub(roro).add(RG * RG);
          If(discW.greaterThan(0), () => {
            const tw = b.negate().sub(sqrt(discW));
            If(tw.greaterThan(0), () => { t1.assign(min(t1, tw)); });
          });
          // camera below the band: skip straight up to its underside
          If(roro.lessThan(R_LO * R_LO), () => {
            const discL = b.mul(b).sub(roro).add(R_LO * R_LO);
            t0.assign(max(t0, b.negate().add(sqrt(max(discL, 0)))));
          });
          If(t1.sub(t0).greaterThan(0.5), () => {
            Loop(N, ({ i }: any) => {
              const t = t0.add(float(i).add(0.5).mul(STEP));
              If(t.greaterThanEqual(t1), () => { Break(); });
              const p = ro.add(rd.mul(t)).toVar();
              const r = length(p).toVar();
              const h = r.sub(PLANET_RADIUS).toVar();
              If(h.greaterThan(CLOUD_LO).and(h.lessThan(CLOUD_HI)), () => {
                const pd = p.add(vec3(2.2, 0.5, -1.6).mul(time));
                const q = floor(pd.div(CLOUD_CELL)).toVar();
                const covN = vnoise(q.mul(0.1)).mul(0.72).add(vnoise(q.mul(0.23)).mul(0.28));
                const shellF = h.sub(CLOUD_LO).div(CLOUD_HI - CLOUD_LO);
                const field = covN.add(hash3(q).mul(0.09)).sub(shellF.mul(0.22));
                If(field.greaterThan(cover), () => {
                  const day = smoothstep(-0.25, 0.3, dot(p, sunU).div(r));
                  // per-cell brightness jitter makes adjacent voxels read as distinct blocks
                  const cellJit = hash3(q.add(7.31)).mul(0.16).add(0.92);
                  const bright = mix(0.62, 1.08, shellF).mul(cellJit);
                  const cS = mix(vec3(0.05, 0.075, 0.14), vec3(0.97, 0.985, 1.0).mul(bright), day);
                  // fade the first ~45 m so flying through a bank stays readable
                  const a = smoothstep(6, 45, t).mul(0.7);
                  acc.addAssign(cS.mul(trans.mul(a)));
                  trans.mulAssign(float(1).sub(a));
                  If(trans.lessThan(0.05), () => { Break(); });
                });
              });
            });
          });
        });
        const alpha = float(1).sub(trans);
        return vec4(acc.div(max(alpha, 1e-3)), alpha);
      });
      const mat = new THREE.MeshBasicNodeMaterial();
      const out = shader();
      mat.colorNode = out.xyz;
      mat.opacityNode = out.w;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthTest = false;
      mat.side = THREE.BackSide;
      mat.fog = false;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(R_HI, 4), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.clouds = mesh;
    }
  }

  /** floating origin: recenter the shells and refresh the planet-frame camera uniforms */
  update(camX: number, camY: number, camZ: number, camera: THREE.PerspectiveCamera): void {
    this.camU.value.set(camX, camY, camZ);
    camera.getWorldDirection(this.fwdU.value);
    this.atmo.position.set(-camX, -camY, -camZ);
    if (this.clouds) this.clouds.position.set(-camX, -camY, -camZ);
  }
}
