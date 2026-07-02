export interface FrontierMaterialRequirement {
  wood: number;
  rock: number;
}

export interface FrontierContractDefinition {
  id: string;
  name: string;
  routeId: string;
  summary: string;
  requiredMaterials: FrontierMaterialRequirement;
}

export const FRONTIER_CONTRACTS: FrontierContractDefinition[] = [
  {
    id: 'outpost-prep-tutorial',
    name: 'Outpost Prep Tutorial',
    routeId: 'tutorial',
    summary: 'Prepare a landing pad and beacon, then fly the Harbor Loop delivery.',
    requiredMaterials: { wood: 12, rock: 6 },
  },
];

export function contractForRoute(routeId: string): FrontierContractDefinition {
  return FRONTIER_CONTRACTS.find((contract) => contract.routeId === routeId) ?? FRONTIER_CONTRACTS[0];
}
