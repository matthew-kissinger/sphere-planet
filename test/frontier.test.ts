import { describe, expect, it } from 'vitest';
import { Goldberg } from '../src/geo/goldberg';
import { buildLayers } from '../src/world/layers';
import { Terrain, MAT } from '../src/world/terrain';
import { Columns } from '../src/world/columns';
import { Trees } from '../src/world/trees';
import { contractForRoute } from '../src/game/contracts';
import {
  createOutpostBuildSite,
  findFrontierOutpostTile,
  inspectBuildSite,
  materialsReady,
} from '../src/game/buildSites';
import { FrontierMode } from '../src/game/frontierMode';

function buildFixture() {
  const geo = new Goldberg(16);
  const layers = buildLayers();
  const terrain = new Terrain('frontier-test');
  const columns = new Columns(geo, layers, terrain);
  const trees = new Trees(geo, columns, terrain, 'frontier-test');
  return { geo, layers, terrain, columns, trees };
}

describe('frontier build sites', () => {
  it('creates a 7-cell pad plus beacon and validates placed cells', () => {
    const { geo, layers, terrain, columns, trees } = buildFixture();
    const contract = contractForRoute('tutorial');
    const centerTile = findFrontierOutpostTile(geo, columns, terrain, trees, 0);
    const site = createOutpostBuildSite(geo, layers, columns, centerTile, contract.routeId, contract.requiredMaterials);
    expect(site.padCells).toHaveLength(7);
    expect(site.beaconCell.tileId).not.toBe(site.centerTile);

    let inspection = inspectBuildSite(site, columns);
    expect(inspection.padPlaced).toBe(0);
    expect(inspection.beaconPlaced).toBe(false);
    expect(inspection.buildComplete).toBe(false);

    for (const cell of site.padCells) {
      expect(columns.place(cell.tileId, cell.layer, MAT.ROCK)).toBe(true);
    }
    expect(columns.place(site.beaconCell.tileId, site.beaconCell.layer, MAT.WOOD)).toBe(true);

    inspection = inspectBuildSite(site, columns);
    expect(inspection.padPlaced).toBe(7);
    expect(inspection.beaconPlaced).toBe(true);
    expect(inspection.buildComplete).toBe(true);
    expect(inspection.quality).toBe(100);
  });

  it('keeps material requirements separate from footprint completion', () => {
    const required = contractForRoute('tutorial').requiredMaterials;
    expect(materialsReady(required, { wood: 11, rock: 6 })).toBe(false);
    expect(materialsReady(required, { wood: 12, rock: 5 })).toBe(false);
    expect(materialsReady(required, { wood: 12, rock: 6 })).toBe(true);
  });
});

describe('frontier mode state', () => {
  it('gates launch until materials and build site are both complete', () => {
    const { geo, layers, terrain, columns, trees } = buildFixture();
    const contract = contractForRoute('tutorial');
    const centerTile = findFrontierOutpostTile(geo, columns, terrain, trees, 0);
    const site = createOutpostBuildSite(geo, layers, columns, centerTile, contract.routeId, contract.requiredMaterials);
    const frontier = new FrontierMode();
    frontier.start(contract, site);

    frontier.recordGather('wood', 12);
    frontier.recordGather('rock', 6);
    let snapshot = frontier.tick(1, inspectBuildSite(site, columns));
    expect(snapshot.materialsComplete).toBe(true);
    expect(snapshot.buildComplete).toBe(false);
    expect(snapshot.canLaunch).toBe(false);

    for (const cell of site.padCells) columns.place(cell.tileId, cell.layer, MAT.ROCK);
    columns.place(site.beaconCell.tileId, site.beaconCell.layer, MAT.WOOD);

    snapshot = frontier.tick(1, inspectBuildSite(site, columns));
    expect(snapshot.buildComplete).toBe(true);
    expect(snapshot.canLaunch).toBe(true);
    expect(frontier.beginFlight()).toBe(true);
    expect(frontier.getSnapshot().status).toBe('flying');
  });
});
