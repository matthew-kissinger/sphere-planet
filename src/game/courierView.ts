import * as THREE from 'three/webgpu';
import type { CourierRallySnapshot } from './courierRally';
import type { CourierRoute, CourierTarget, Vec3Like } from './courierRoutes';

interface TargetVisual {
  target: CourierTarget;
  root: THREE.Group;
  ring: THREE.Mesh;
  arrow: THREE.Mesh;
  padFill: THREE.Mesh | null;
}

interface PulseVisual {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  worldPosition: Vec3Like;
  age: number;
  duration: number;
  baseRadius: number;
  active: boolean;
}

const TARGET_COLORS = {
  pending: 0x4d7fd8,
  active: 0x67e5ff,
  passed: 0x86f2a0,
  pad: 0xffd166,
  fail: 0xff5e5b,
};

function makeMatrixForRing(target: CourierTarget, matrix: THREE.Matrix4): THREE.Matrix4 {
  return matrix.makeBasis(
    new THREE.Vector3(target.right.x, target.right.y, target.right.z),
    new THREE.Vector3(target.up.x, target.up.y, target.up.z),
    new THREE.Vector3(target.forward.x, target.forward.y, target.forward.z),
  );
}

function makeMatrixForPad(target: CourierTarget, matrix: THREE.Matrix4): THREE.Matrix4 {
  return matrix.makeBasis(
    new THREE.Vector3(target.right.x, target.right.y, target.right.z),
    new THREE.Vector3(target.forward.x, target.forward.y, target.forward.z),
    new THREE.Vector3(target.up.x, target.up.y, target.up.z),
  );
}

function makeMatrixForCone(target: CourierTarget, matrix: THREE.Matrix4): THREE.Matrix4 {
  return matrix.makeBasis(
    new THREE.Vector3(target.right.x, target.right.y, target.right.z),
    new THREE.Vector3(target.forward.x, target.forward.y, target.forward.z),
    new THREE.Vector3(target.up.x, target.up.y, target.up.z),
  );
}

function setRelativePosition(object: THREE.Object3D, position: Vec3Like, camWorld: Vec3Like): void {
  object.position.set(position.x - camWorld.x, position.y - camWorld.y, position.z - camWorld.z);
}

export class CourierRouteView {
  readonly root = new THREE.Group();
  private route: CourierRoute | null = null;
  private readonly visuals: TargetVisual[] = [];
  private readonly routeLine: THREE.Line;
  private readonly routeLinePositions: THREE.BufferAttribute;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly ringGeometry = new THREE.TorusGeometry(1, 0.045, 8, 80);
  private readonly padGeometry = new THREE.RingGeometry(0.52, 1, 72);
  private readonly padFillGeometry = new THREE.CircleGeometry(0.5, 72);
  private readonly coneGeometry = new THREE.ConeGeometry(0.16, 0.44, 4);
  private readonly pulseGeometry = new THREE.TorusGeometry(1, 0.035, 8, 72);
  private readonly pendingMaterial = new THREE.MeshBasicMaterial({ color: TARGET_COLORS.pending, transparent: true, opacity: 0.48, depthWrite: false });
  private readonly activeMaterial = new THREE.MeshBasicMaterial({ color: TARGET_COLORS.active, transparent: true, opacity: 0.92, depthWrite: false });
  private readonly passedMaterial = new THREE.MeshBasicMaterial({ color: TARGET_COLORS.passed, transparent: true, opacity: 0.38, depthWrite: false });
  private readonly padMaterial = new THREE.MeshBasicMaterial({ color: TARGET_COLORS.pad, transparent: true, opacity: 0.86, depthWrite: false, side: THREE.DoubleSide });
  private readonly padFillMaterial = new THREE.MeshBasicMaterial({ color: 0x342611, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0x8dd8ff, transparent: true, opacity: 0.35, depthWrite: false });
  private readonly pulses: PulseVisual[] = [];

  constructor(scene: THREE.Scene) {
    this.root.visible = false;
    scene.add(this.root);

    const lineGeometry = new THREE.BufferGeometry();
    this.routeLinePositions = new THREE.BufferAttribute(new Float32Array(1), 3);
    lineGeometry.setAttribute('position', this.routeLinePositions);
    this.routeLine = new THREE.Line(lineGeometry, this.lineMaterial);
    this.routeLine.frustumCulled = false;
    this.root.add(this.routeLine);

    for (let i = 0; i < 10; i++) {
      const material = new THREE.MeshBasicMaterial({ color: TARGET_COLORS.active, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(this.pulseGeometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.pulses.push({
        mesh,
        material,
        worldPosition: { x: 0, y: 0, z: 0 },
        age: 0,
        duration: 0.55,
        baseRadius: 1,
        active: false,
      });
      this.root.add(mesh);
    }
  }

  setRoute(route: CourierRoute | null): void {
    if (this.route?.id === route?.id) return;
    this.route = route;
    for (const visual of this.visuals) visual.root.removeFromParent();
    this.visuals.length = 0;

    if (!route) {
      this.root.visible = false;
      this.routeLine.geometry.setDrawRange(0, 0);
      return;
    }

    for (const target of route.targets) {
      const root = new THREE.Group();
      root.frustumCulled = false;
      const material = target.kind === 'pad' ? this.padMaterial : this.pendingMaterial;
      const ring = new THREE.Mesh(target.kind === 'pad' ? this.padGeometry : this.ringGeometry, material);
      ring.frustumCulled = false;
      if (target.kind === 'ring') {
        ring.scale.setScalar(target.radius);
        this.quaternion.setFromRotationMatrix(makeMatrixForRing(target, this.matrix));
      } else {
        ring.scale.setScalar(target.radius);
        this.quaternion.setFromRotationMatrix(makeMatrixForPad(target, this.matrix));
      }
      ring.quaternion.copy(this.quaternion);
      root.add(ring);

      const padFill = target.kind === 'pad' ? new THREE.Mesh(this.padFillGeometry, this.padFillMaterial) : null;
      if (padFill) {
        padFill.frustumCulled = false;
        padFill.scale.setScalar(target.radius);
        padFill.quaternion.copy(this.quaternion);
        root.add(padFill);
      }

      const arrow = new THREE.Mesh(this.coneGeometry, target.kind === 'pad' ? this.padMaterial : this.activeMaterial);
      arrow.frustumCulled = false;
      arrow.scale.setScalar(target.radius);
      this.quaternion.setFromRotationMatrix(makeMatrixForCone(target, this.matrix));
      arrow.quaternion.copy(this.quaternion);
      root.add(arrow);

      this.root.add(root);
      this.visuals.push({ target, root, ring, arrow, padFill });
    }

    const positions = new Float32Array((route.targets.length + 1) * 3);
    this.routeLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.routeLine.geometry.setDrawRange(0, route.targets.length + 1);
    this.root.visible = true;
  }

  pulseTarget(target: CourierTarget, color = TARGET_COLORS.active): void {
    const pulse = this.pulses.find((item) => !item.active) ?? this.pulses[0];
    pulse.active = true;
    pulse.age = 0;
    pulse.duration = target.kind === 'pad' ? 0.72 : 0.5;
    pulse.baseRadius = target.radius;
    pulse.worldPosition = { ...target.position };
    pulse.material.color.setHex(color);
    pulse.material.opacity = 0.82;
    pulse.mesh.visible = true;
    pulse.mesh.position.set(target.position.x, target.position.y, target.position.z);
    this.quaternion.setFromRotationMatrix(target.kind === 'pad'
      ? makeMatrixForPad(target, this.matrix)
      : makeMatrixForRing(target, this.matrix));
    pulse.mesh.quaternion.copy(this.quaternion);
    pulse.mesh.scale.setScalar(target.radius);
  }

  update(snapshot: CourierRallySnapshot, camWorld: Vec3Like, deltaSeconds: number): void {
    if (!this.route) {
      this.root.visible = false;
      return;
    }
    this.root.visible = snapshot.status !== 'menu';
    const activeIndex = snapshot.targetIndex;
    const pulse = snapshot.status === 'countdown' ? 1 + Math.sin(performance.now() * 0.008) * 0.035 : 1;

    for (const visual of this.visuals) {
      const target = visual.target;
      setRelativePosition(visual.root, target.position, camWorld);
      const isPassed = target.index < activeIndex;
      const isActive = target.index === activeIndex && (snapshot.status === 'running' || snapshot.status === 'countdown');
      const isFinal = target.kind === 'pad';
      if (isPassed) {
        visual.ring.material = this.passedMaterial;
        visual.arrow.visible = false;
      } else if (isActive) {
        visual.ring.material = isFinal ? this.padMaterial : this.activeMaterial;
        visual.arrow.visible = true;
      } else {
        visual.ring.material = isFinal ? this.padMaterial : this.pendingMaterial;
        visual.arrow.visible = !isFinal;
      }
      const targetScale = isActive ? target.radius * pulse : target.radius;
      visual.ring.scale.setScalar(targetScale);
      if (visual.padFill) visual.padFill.scale.setScalar(target.radius * (isActive ? 0.76 : 0.58));
      visual.root.visible = snapshot.status !== 'complete' || target.index >= activeIndex - 1;
    }

    this.updateRouteLine(camWorld);
    this.updatePulses(camWorld, deltaSeconds);
  }

  private updateRouteLine(camWorld: Vec3Like): void {
    if (!this.route) return;
    const attr = this.routeLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(
      0,
      this.route.start.position.x - camWorld.x,
      this.route.start.position.y - camWorld.y,
      this.route.start.position.z - camWorld.z,
    );
    for (let i = 0; i < this.route.targets.length; i++) {
      const p = this.route.targets[i].position;
      attr.setXYZ(i + 1, p.x - camWorld.x, p.y - camWorld.y, p.z - camWorld.z);
    }
    attr.needsUpdate = true;
  }

  private updatePulses(camWorld: Vec3Like, deltaSeconds: number): void {
    for (const pulse of this.pulses) {
      if (!pulse.active) continue;
      pulse.age += deltaSeconds;
      const t = pulse.age / pulse.duration;
      if (t >= 1) {
        pulse.active = false;
        pulse.mesh.visible = false;
        continue;
      }
      pulse.mesh.position.set(
        pulse.worldPosition.x - camWorld.x,
        pulse.worldPosition.y - camWorld.y,
        pulse.worldPosition.z - camWorld.z,
      );
      pulse.mesh.scale.setScalar(pulse.baseRadius * (1 + t * 0.72));
      pulse.material.opacity = (1 - t) * 0.82;
    }
  }
}
