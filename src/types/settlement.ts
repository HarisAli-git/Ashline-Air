export interface SettlementDefinition {
  id: string;
  name: string;
  description: string;
  factionId: string;
  position: { x: number; y: number }; // world-map pixel coords
  population: number;
  securityLevel: number; // 1–10
  fuelBasePrice: number;
  repairBaseCost: number;
  goods: SettlementGoodEntry[];
  unlocked: boolean; // whether player can visit on new game
}

export interface SettlementGoodEntry {
  goodId: string;
  supplyLevel: number;   // 0–100 (100 = abundant)
  demandLevel: number;   // 0–100 (100 = desperate)
  basePrice: number;
}

// Runtime mutable state, persisted in save
export interface SettlementState {
  definitionId: string;
  goodStates: Record<string, GoodState>;
  fuelPrice: number;
  repairCost: number;
  lastVisited: number | null; // game timestamp
}

export interface GoodState {
  supplyLevel: number;
  demandLevel: number;
  currentPrice: number;
}
