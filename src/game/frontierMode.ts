import type { CourierRouteResult } from './courierRally';
import type { BuildSite, BuildSiteInspection, FrontierInventory } from './buildSites';
import { materialsReady } from './buildSites';
import type { FrontierContractDefinition } from './contracts';

export type FrontierStatus = 'inactive' | 'prepping' | 'ready' | 'flying' | 'complete' | 'failed';
export type FrontierMaterial = keyof FrontierInventory;

export interface FrontierSnapshot {
  status: FrontierStatus;
  contractId: string | null;
  contractName: string;
  routeId: string | null;
  objective: string;
  hint: string;
  prepSeconds: number;
  gathered: FrontierInventory;
  required: FrontierInventory;
  materialsComplete: boolean;
  buildComplete: boolean;
  canLaunch: boolean;
  padPlaced: number;
  padTotal: number;
  beaconPlaced: boolean;
  buildQuality: number;
  result: CourierRouteResult | null;
  failReason: string;
}

const EMPTY_INVENTORY: FrontierInventory = { wood: 0, rock: 0 };

function cloneInventory(value: FrontierInventory): FrontierInventory {
  return { wood: value.wood, rock: value.rock };
}

export class FrontierMode {
  status: FrontierStatus = 'inactive';
  private contract: FrontierContractDefinition | null = null;
  private site: BuildSite | null = null;
  private prepSeconds = 0;
  private gathered: FrontierInventory = cloneInventory(EMPTY_INVENTORY);
  private inspection: BuildSiteInspection | null = null;
  private result: CourierRouteResult | null = null;
  private failReason = '';

  get activeContract(): FrontierContractDefinition | null {
    return this.contract;
  }

  get activeSite(): BuildSite | null {
    return this.site;
  }

  start(contract: FrontierContractDefinition, site: BuildSite, startingInventory: Partial<FrontierInventory> = {}): void {
    this.contract = contract;
    this.site = site;
    this.prepSeconds = 0;
    this.gathered = {
      wood: Math.max(0, startingInventory.wood ?? 0),
      rock: Math.max(0, startingInventory.rock ?? 0),
    };
    this.inspection = null;
    this.result = null;
    this.failReason = '';
    this.status = 'prepping';
  }

  reset(): void {
    this.status = 'inactive';
    this.contract = null;
    this.site = null;
    this.prepSeconds = 0;
    this.gathered = cloneInventory(EMPTY_INVENTORY);
    this.inspection = null;
    this.result = null;
    this.failReason = '';
  }

  recordGather(material: FrontierMaterial, amount: number): void {
    if (amount <= 0 || !this.contract) return;
    this.gathered[material] += amount;
  }

  recordInventory(inventory: Partial<FrontierInventory>): void {
    if (!this.contract) return;
    this.gathered.wood = Math.max(this.gathered.wood, inventory.wood ?? 0);
    this.gathered.rock = Math.max(this.gathered.rock, inventory.rock ?? 0);
  }

  tick(deltaSeconds: number, inspection: BuildSiteInspection, inventory: Partial<FrontierInventory> = {}): FrontierSnapshot {
    if (this.status === 'prepping' || this.status === 'ready') this.prepSeconds += Math.max(0, deltaSeconds);
    this.inspection = inspection;
    this.recordInventory(inventory);
    if (this.status === 'prepping' || this.status === 'ready') {
      this.status = this.canLaunch() ? 'ready' : 'prepping';
    }
    return this.getSnapshot();
  }

  canLaunch(): boolean {
    if (!this.contract || !this.site || !this.inspection) return false;
    return this.inspection.buildComplete && materialsReady(this.contract.requiredMaterials, this.gathered);
  }

  beginFlight(): boolean {
    if (!this.canLaunch()) return false;
    this.status = 'flying';
    this.failReason = '';
    return true;
  }

  failFlight(reason: string): void {
    if (!this.contract) return;
    this.status = 'failed';
    this.failReason = reason;
  }

  retryFlight(): void {
    if (this.contract && (this.status === 'failed' || this.status === 'complete')) {
      this.status = 'flying';
      this.failReason = '';
    }
  }

  complete(result: CourierRouteResult): void {
    if (!this.contract) return;
    this.status = 'complete';
    this.result = result;
    this.failReason = '';
  }

  getSnapshot(): FrontierSnapshot {
    const required = this.contract?.requiredMaterials ?? EMPTY_INVENTORY;
    const inspection = this.inspection;
    const materialsComplete = this.contract ? materialsReady(required, this.gathered) : false;
    const buildComplete = inspection?.buildComplete ?? false;
    const canLaunch = materialsComplete && buildComplete && (this.status === 'prepping' || this.status === 'ready');
    let objective = 'No frontier contract';
    let hint = 'Open Frontier from the courier menu.';

    if (this.contract) {
      if (!materialsComplete) {
        objective = 'Gather outpost materials';
        hint = `Need ${Math.max(0, required.wood - this.gathered.wood)} wood and ${Math.max(0, required.rock - this.gathered.rock)} rock.`;
      } else if (!buildComplete) {
        objective = 'Build the outpost pad';
        hint = `Place blocks on the marked footprint: ${inspection?.padPlaced ?? 0}/${inspection?.padTotal ?? 0} pad, beacon ${inspection?.beaconPlaced ? 'ready' : 'missing'}.`;
      } else if (this.status === 'ready') {
        objective = 'Launch delivery';
        hint = 'Press E or the plane button to fly the prepared route.';
      } else if (this.status === 'flying') {
        objective = 'Deliver cargo';
        hint = 'Fly the route and land on the pad you prepared.';
      } else if (this.status === 'failed') {
        objective = 'Delivery failed';
        hint = this.failReason || 'Retry from the prepared launch.';
      } else if (this.status === 'complete') {
        objective = 'Outpost contract complete';
        hint = `Prep ${Math.round(this.prepSeconds)}s, build quality ${inspection?.quality ?? 0}%.`;
      }
    }

    return {
      status: this.status,
      contractId: this.contract?.id ?? null,
      contractName: this.contract?.name ?? '',
      routeId: this.contract?.routeId ?? null,
      objective,
      hint,
      prepSeconds: this.prepSeconds,
      gathered: cloneInventory(this.gathered),
      required: cloneInventory(required),
      materialsComplete,
      buildComplete,
      canLaunch,
      padPlaced: inspection?.padPlaced ?? 0,
      padTotal: inspection?.padTotal ?? 0,
      beaconPlaced: inspection?.beaconPlaced ?? false,
      buildQuality: inspection?.quality ?? 0,
      result: this.result,
      failReason: this.failReason,
    };
  }
}
