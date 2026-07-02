import type { Goldberg } from '../geo/goldberg';
import type { Layers } from '../world/layers';
import type { Columns } from '../world/columns';
import type { Terrain } from '../world/terrain';
import type { Trees } from '../world/trees';
import { MAT, type MaterialId } from '../world/terrain';
import type { FrontierMaterialRequirement } from './contracts';

export interface FrontierInventory {
  wood: number;
  rock: number;
}

export interface BuildSiteCell {
  role: 'pad' | 'beacon';
  tileId: number;
  layer: number;
  label: string;
}

export interface BuildSite {
  id: string;
  name: string;
  routeId: string;
  centerTile: number;
  padCells: BuildSiteCell[];
  beaconCell: BuildSiteCell;
  requiredMaterials: FrontierMaterialRequirement;
}

export interface BuildSiteCellInspection extends BuildSiteCell {
  placed: boolean;
  material: MaterialId | null;
}

export interface BuildSiteInspection {
  siteId: string;
  padPlaced: number;
  padTotal: number;
  beaconPlaced: boolean;
  buildComplete: boolean;
  quality: number;
  cells: BuildSiteCellInspection[];
}

function uniquePush(values: number[], value: number): void {
  if (!values.includes(value)) values.push(value);
}

export function tilesWithin(geo: Goldberg, startTile: number, depth: number): number[] {
  const result: number[] = [];
  const seen = new Set<number>([startTile]);
  const queue: { tileId: number; depth: number }[] = [{ tileId: startTile, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    result.push(item.tileId);
    if (item.depth >= depth) continue;
    const deg = geo.degreeOf(item.tileId);
    for (let k = 0; k < deg; k++) {
      const next = geo.neighbor(item.tileId, k);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ tileId: next, depth: item.depth + 1 });
    }
  }
  return result;
}

function placementLayer(layers: Layers, columns: Columns, tileId: number): number {
  return Math.max(0, columns.groundLayerBelow(tileId, layers.bounds[0]) - 1);
}

export function createOutpostBuildSite(
  geo: Goldberg,
  layers: Layers,
  columns: Columns,
  centerTile: number,
  routeId: string,
  requiredMaterials: FrontierMaterialRequirement,
): BuildSite {
  const footprint = [centerTile];
  const deg = geo.degreeOf(centerTile);
  for (let k = 0; k < deg && footprint.length < 7; k++) uniquePush(footprint, geo.neighbor(centerTile, k));
  let seed = footprint[footprint.length - 1] ?? centerTile;
  for (let ring = 0; footprint.length < 7 && ring < 3; ring++) {
    const deg2 = geo.degreeOf(seed);
    for (let k = 0; k < deg2 && footprint.length < 7; k++) uniquePush(footprint, geo.neighbor(seed, k));
    seed = geo.neighbor(seed, 0);
  }

  let beaconTile = centerTile;
  for (const tile of tilesWithin(geo, centerTile, 2)) {
    if (!footprint.includes(tile)) {
      beaconTile = tile;
      break;
    }
  }

  return {
    id: 'frontier-outpost-pad',
    name: 'Harbor Outpost Pad',
    routeId,
    centerTile,
    padCells: footprint.map((tileId, index) => ({
      role: 'pad',
      tileId,
      layer: placementLayer(layers, columns, tileId),
      label: index === 0 ? 'pad-center' : `pad-${index}`,
    })),
    beaconCell: {
      role: 'beacon',
      tileId: beaconTile,
      layer: placementLayer(layers, columns, beaconTile),
      label: 'beacon',
    },
    requiredMaterials,
  };
}

export function inspectBuildSite(site: BuildSite, columns: Columns): BuildSiteInspection {
  const padCells = site.padCells.map((cell): BuildSiteCellInspection => {
    const placed = columns.placedAt(cell.tileId, cell.layer);
    return { ...cell, placed, material: placed ? columns.materialAt(cell.tileId, cell.layer) : null };
  });
  const beaconPlaced = columns.placedAt(site.beaconCell.tileId, site.beaconCell.layer);
  const beaconCell: BuildSiteCellInspection = {
    ...site.beaconCell,
    placed: beaconPlaced,
    material: beaconPlaced ? columns.materialAt(site.beaconCell.tileId, site.beaconCell.layer) : null,
  };
  const padPlaced = padCells.filter((cell) => cell.placed).length;
  const padRatio = padPlaced / Math.max(1, site.padCells.length);
  const beaconRatio = beaconPlaced ? 1 : 0;
  const rockPadCount = padCells.filter((cell) => cell.material === MAT.ROCK).length;
  const materialBonus = Math.min(1, rockPadCount / Math.max(1, site.requiredMaterials.rock)) * 0.15;
  const quality = Math.round(Math.min(1, padRatio * 0.7 + beaconRatio * 0.15 + materialBonus) * 100);
  return {
    siteId: site.id,
    padPlaced,
    padTotal: site.padCells.length,
    beaconPlaced,
    buildComplete: padPlaced >= site.padCells.length && beaconPlaced,
    quality,
    cells: [...padCells, beaconCell],
  };
}

export function materialsReady(requirements: FrontierMaterialRequirement, inventory: FrontierInventory): boolean {
  return inventory.wood >= requirements.wood && inventory.rock >= requirements.rock;
}

function nearbyResourceCounts(
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  trees: Trees,
  tileId: number,
): { trees: number; rock: number } {
  let treeCount = 0;
  let rockCount = 0;
  for (const tile of tilesWithin(geo, tileId, 2)) {
    if (trees.hasTree(tile)) treeCount++;
    if (terrain.surfaceMaterial(columns.heightOf(tile)) === MAT.ROCK) rockCount++;
  }
  return { trees: treeCount, rock: rockCount };
}

export function findFrontierOutpostTile(
  geo: Goldberg,
  columns: Columns,
  terrain: Terrain,
  trees: Trees,
  startTile: number,
): number {
  const seen = new Set<number>([startTile]);
  const queue: { tileId: number; depth: number }[] = [{ tileId: startTile, depth: 0 }];
  let bestTile = startTile;
  let bestScore = -Infinity;

  while (queue.length > 0 && seen.size < 6000) {
    const { tileId, depth } = queue.shift()!;
    const height = columns.heightOf(tileId);
    if (height > 3.2 && height < 70 && !trees.hasTree(tileId)) {
      const resources = nearbyResourceCounts(geo, columns, terrain, trees, tileId);
      const heightComfort = height < 35 ? 2 : 0;
      const score = resources.trees * 8 + resources.rock * 7 + heightComfort - depth * 0.08;
      if (score > bestScore) {
        bestScore = score;
        bestTile = tileId;
      }
      if (resources.trees >= 2 && resources.rock >= 1 && depth > 3) return tileId;
    }

    const deg = geo.degreeOf(tileId);
    for (let k = 0; k < deg; k++) {
      const next = geo.neighbor(tileId, k);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ tileId: next, depth: depth + 1 });
    }
  }

  return bestTile;
}
