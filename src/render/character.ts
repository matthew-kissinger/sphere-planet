/**
 * The player's body: a capsule with a visor hint, plus a deployable glider wing.
 * Visible whenever the camera is pulled back; oriented by the player's local frame
 * (up = radial, forward = transported heading), pitched and banked while gliding.
 */

import * as THREE from 'three/webgpu';
import type { Player } from '../player/player';

export class Character {
  readonly group: THREE.Group;
  private readonly wing: THREE.Group;
  private readonly body: THREE.Group;
  private readonly m = new THREE.Matrix4();
  private readonly right = new THREE.Vector3();
  private readonly upV = new THREE.Vector3();
  private readonly back = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.body = new THREE.Group();

    const suit = new THREE.MeshStandardMaterial({ color: 0xd8dee8, roughness: 0.6, metalness: 0.05 });
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x2a3d55, roughness: 0.25, metalness: 0.2 });
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xc4502e, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });

    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.05, 6, 14), suit);
    capsule.position.set(0, 0.93, 0);
    this.body.add(capsule);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.1), visorMat);
    visor.position.set(0, 1.38, -0.29);
    this.body.add(visor);

    // glider: two swept panels + a spar
    this.wing = new THREE.Group();
    const panelGeom = new THREE.BoxGeometry(1.85, 0.05, 0.85);
    const left = new THREE.Mesh(panelGeom, wingMat);
    left.position.set(-0.92, 0, 0.12);
    left.rotation.y = 0.22;
    left.rotation.z = 0.08;
    const rightPanel = new THREE.Mesh(panelGeom, wingMat);
    rightPanel.position.set(0.92, 0, 0.12);
    rightPanel.rotation.y = -0.22;
    rightPanel.rotation.z = -0.08;
    const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1), suit);
    spar.rotation.x = Math.PI / 2;
    spar.position.set(0, -0.08, 0.1);
    this.wing.add(left, rightPanel, spar);
    this.wing.position.set(0, 1.78, 0.1);
    this.wing.visible = false;
    this.body.add(this.wing);

    this.group.add(this.body);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** eye/camera-relative update; camWorld is f64 */
  update(player: Player, camWorld: { x: number; y: number; z: number }, camDist: number): void {
    const show = camDist > 0.8;
    this.group.visible = show;
    if (!show) return;
    this.wing.visible = player.gliding;

    const [ux, uy, uz] = player.up();
    this.upV.set(ux, uy, uz);
    this.back.set(-player.fwdX, -player.fwdY, -player.fwdZ);
    this.right.crossVectors(this.upV, this.back); // = fwd x up ... right-handed with back
    this.m.makeBasis(this.right, this.upV, this.back);
    this.group.quaternion.setFromRotationMatrix(this.m);

    // glide attitude: pitch with the view, bank with the turn
    if (player.gliding) {
      const q = new THREE.Quaternion();
      q.setFromAxisAngle(this.right.normalize(), -Math.max(-1.0, Math.min(1.0, player.pitch)) * 0.75);
      this.group.quaternion.premultiply(q);
      const qb = new THREE.Quaternion();
      this.back.set(-player.fwdX, -player.fwdY, -player.fwdZ).normalize();
      qb.setFromAxisAngle(this.back, -player.bank);
      this.group.quaternion.premultiply(qb);
    }

    this.group.position.set(player.px - camWorld.x, player.py - camWorld.y, player.pz - camWorld.z);
  }
}
