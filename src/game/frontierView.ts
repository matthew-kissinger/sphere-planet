import * as THREE from 'three/webgpu';
import type { Goldberg } from '../geo/goldberg';
import type { Layers } from '../world/layers';
import type { BuildSite, BuildSiteCell, BuildSiteInspection } from './buildSites';
import type { Vec3Like } from './courierRoutes';

interface CellVisual {
  cell: BuildSiteCell;
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  attr: THREE.BufferAttribute;
}

const PAD_PENDING = 0xffd166;
const PAD_DONE = 0x8cf2ac;
const BEACON_PENDING = 0x78d6ff;
const BEACON_DONE = 0xffffff;

export class FrontierBuildView {
  readonly root = new THREE.Group();
  private site: BuildSite | null = null;
  private visuals: CellVisual[] = [];
  private readonly corner = new Float64Array(3);

  constructor(
    scene: THREE.Scene,
    private readonly geo: Goldberg,
    private readonly layers: Layers,
  ) {
    this.root.visible = false;
    scene.add(this.root);
  }

  setSite(site: BuildSite | null): void {
    if (this.site?.id === site?.id) return;
    for (const visual of this.visuals) visual.line.removeFromParent();
    this.visuals = [];
    this.site = site;
    if (!site) {
      this.root.visible = false;
      return;
    }

    for (const cell of [...site.padCells, site.beaconCell]) {
      const positions = new Float32Array(8 * 3);
      const geometry = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(positions, 3);
      geometry.setAttribute('position', attr);
      const material = new THREE.LineBasicMaterial({
        color: cell.role === 'beacon' ? BEACON_PENDING : PAD_PENDING,
        transparent: true,
        opacity: cell.role === 'beacon' ? 0.98 : 0.86,
        depthTest: true,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      this.root.add(line);
      this.visuals.push({ cell, line, material, attr });
    }
    this.root.visible = true;
  }

  update(inspection: BuildSiteInspection | null, camWorld: Vec3Like): void {
    if (!this.site || !inspection) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    for (const visual of this.visuals) {
      const inspected = inspection.cells.find((cell) => cell.role === visual.cell.role && cell.tileId === visual.cell.tileId);
      const placed = inspected?.placed ?? false;
      const color = visual.cell.role === 'beacon'
        ? (placed ? BEACON_DONE : BEACON_PENDING)
        : (placed ? PAD_DONE : PAD_PENDING);
      visual.material.color.setHex(color);
      visual.material.opacity = placed ? 0.72 : 0.95;

      const deg = this.geo.degreeOf(visual.cell.tileId);
      const radius = this.layers.topRadius(visual.cell.layer) + (visual.cell.role === 'beacon' ? 0.18 : 0.06);
      for (let k = 0; k < deg; k++) {
        this.geo.cornerUnit(visual.cell.tileId, k, this.corner);
        visual.attr.setXYZ(
          k,
          this.corner[0] * radius - camWorld.x,
          this.corner[1] * radius - camWorld.y,
          this.corner[2] * radius - camWorld.z,
        );
      }
      visual.attr.setXYZ(deg, visual.attr.getX(0), visual.attr.getY(0), visual.attr.getZ(0));
      for (let k = deg + 1; k < 8; k++) {
        visual.attr.setXYZ(k, visual.attr.getX(deg), visual.attr.getY(deg), visual.attr.getZ(deg));
      }
      visual.attr.needsUpdate = true;
      visual.line.geometry.setDrawRange(0, deg + 1);
    }
  }
}
