/**
 * The player's body: a capsule with a visor hint, plus a little bush plane that appears
 * around it in plane mode. Visible whenever the camera is pulled back — faded in over a
 * short distance band instead of popping — oriented by the player's local frame
 * (up = radial, forward = transported heading), pitched with velocity and banked with
 * the turn while flying.
 */

import * as THREE from 'three/webgpu';
import type { Player } from '../player/player';

export class Character {
  readonly group: THREE.Group;
  private readonly plane: THREE.Group;
  private readonly prop: THREE.Group;
  private readonly body: THREE.Group;
  private readonly fadeMats: THREE.MeshStandardMaterial[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly right = new THREE.Vector3();
  private readonly upV = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private propAngle = 0;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.body = new THREE.Group();

    const mat = (color: number, roughness = 0.6, metalness = 0.05): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, transparent: true });
      this.fadeMats.push(m);
      return m;
    };

    const suit = mat(0xd8dee8);
    const visorMat = mat(0x2a3d55, 0.25, 0.2);
    const hullMat = mat(0xc4502e, 0.55, 0.1);
    const wingMat = mat(0xe8dfc8, 0.7, 0);
    wingMat.side = THREE.DoubleSide;
    const propMat = mat(0x2b2b30, 0.5, 0.1);

    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.05, 6, 14), suit);
    capsule.position.set(0, 0.93, 0);
    this.body.add(capsule);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.1), visorMat);
    visor.position.set(0, 1.38, -0.29);
    this.body.add(visor);

    // --- the plane: a high-wing bush flyer, forward = -Z, pilot rides in the open cockpit ---
    this.plane = new THREE.Group();

    // fuselage: dark engine cowl, red cabin, long tapered tail boom
    const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.4, 0.55, 12), propMat);
    cowl.rotation.x = Math.PI / 2;
    cowl.position.set(0, 0.82, -1.42);
    const cabin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.52, 1.5, 12), hullMat);
    cabin.rotation.x = Math.PI / 2;
    cabin.position.set(0, 0.85, -0.42);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.48, 1.9, 10), hullMat);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 0.92, 1.27);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.5, 12), propMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.82, -1.9);
    this.plane.add(cowl, cabin, boom, nose);

    // raked windshield in front of the pilot
    const shield = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.55, 0.05), visorMat);
    shield.position.set(0, 1.5, -0.82);
    shield.rotation.x = 0.42;
    this.plane.add(shield);

    // wing: two halves with dihedral, red tip accents, above the pilot's head
    for (const sign of [1, -1]) {
      const halfGeo = new THREE.BoxGeometry(3.0, 0.09, 1.15);
      halfGeo.translate(sign * 1.5, 0, 0);
      const half = new THREE.Mesh(halfGeo, wingMat);
      half.position.set(0, 1.86, -0.35);
      half.rotation.z = sign * 0.07;
      const tipGeo = new THREE.BoxGeometry(0.24, 0.11, 1.17);
      tipGeo.translate(sign * 2.9, 0, 0);
      const tip = new THREE.Mesh(tipGeo, hullMat);
      tip.position.copy(half.position);
      tip.rotation.z = half.rotation.z;
      this.plane.add(half, tip);
    }
    const strutR = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.58, 6), propMat);
    strutR.position.set(0.99, 1.28, -0.35);
    strutR.rotation.z = -0.8;
    const strutL = strutR.clone();
    strutL.position.x = -0.99;
    strutL.rotation.z = 0.8;
    this.plane.add(strutR, strutL);

    // tail: fin with a cream cap, low-set stabilizer
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.8, 0.6), hullMat);
    fin.position.set(0, 1.45, 2.0);
    const finTip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.62), wingMat);
    finTip.position.set(0, 1.78, 2.0);
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.55), wingMat);
    stab.position.set(0, 1.0, 2.05);
    this.plane.add(fin, finTip, stab);

    // bush gear: fat mains on splayed legs, tiny tail wheel
    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelR = new THREE.Mesh(wheelGeo, propMat);
    wheelR.position.set(0.7, 0.18, -0.85);
    const wheelL = wheelR.clone();
    wheelL.position.x = -0.7;
    const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.75, 6), hullMat);
    legR.position.set(0.45, 0.51, -0.85);
    legR.rotation.z = 0.87;
    const legL = legR.clone();
    legL.position.x = -0.45;
    legL.rotation.z = -0.87;
    const tailWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 10).rotateZ(Math.PI / 2), propMat);
    tailWheel.position.set(0, 0.58, 2.15);
    const tailStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 6), propMat);
    tailStrut.position.set(0, 0.72, 2.15);
    this.plane.add(wheelR, wheelL, legR, legL, tailWheel, tailStrut);

    // two-blade prop behind a pointed spinner
    this.prop = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.15, 0.05), propMat);
    const blade2 = blade.clone();
    blade2.rotation.z = Math.PI / 2;
    this.prop.add(blade, blade2);
    this.prop.position.set(0, 0.82, -2.2);
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 10), propMat);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.set(0, 0.82, -2.32);
    this.plane.add(this.prop, spinner);

    this.plane.visible = false;
    this.body.add(this.plane);

    this.group.add(this.body);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** eye/camera-relative update; camWorld is f64 */
  update(player: Player, camWorld: { x: number; y: number; z: number }, camDist: number, dt: number): void {
    // fade in with distance instead of popping at a threshold
    const alpha = Math.max(0, Math.min(1, (camDist - 1.3) / 1.7));
    const show = alpha > 0.02;
    this.group.visible = show;
    if (!show) return;
    for (const m of this.fadeMats) m.opacity = alpha;
    this.plane.visible = player.mode === 'plane';

    const [ux, uy, uz] = player.up();
    this.upV.set(ux, uy, uz);
    this.back.set(-player.fwdX, -player.fwdY, -player.fwdZ);
    this.right.crossVectors(this.upV, this.back);
    this.m.makeBasis(this.right, this.upV, this.back);
    this.group.quaternion.setFromRotationMatrix(this.m);

    // flight attitude: pitch with actual velocity, bank with the turn
    if (player.mode === 'plane') {
      // positive rotation about the right axis pitches the nose UP, so climbing
      // (vr > 0) must apply +vp — the old -vp had the plane diving while it climbed
      const v = Math.hypot(player.vx, player.vy, player.vz);
      if (v > 1) {
        const vr = (player.vx * ux + player.vy * uy + player.vz * uz) / v;
        const vp = Math.asin(Math.max(-1, Math.min(1, vr)));
        this.q.setFromAxisAngle(this.right.normalize(), vp * 0.8);
        this.group.quaternion.premultiply(this.q);
      }
      // bank > 0 = left turn; positive roll about the back axis drops the left wing
      this.back.set(-player.fwdX, -player.fwdY, -player.fwdZ).normalize();
      this.q.setFromAxisAngle(this.back, player.bank);
      this.group.quaternion.premultiply(this.q);
      this.propAngle += dt * (8 + player.planeSpeed * 0.5);
      this.prop.rotation.z = this.propAngle;
    }

    // subtract the step-up render offset so the body glides up terraces like the eye does
    const s = player.stepSmooth;
    this.group.position.set(
      player.px - camWorld.x - this.upV.x * s,
      player.py - camWorld.y - this.upV.y * s,
      player.pz - camWorld.z - this.upV.z * s,
    );
  }
}
