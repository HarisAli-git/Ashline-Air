/**
 * What the country around a field is like. Drives the approach the player
 * has to fly, the hazards on the way in, and how the destination is drawn.
 */
export type ApproachKind = 'open' | 'mountain' | 'canyon' | 'coastal' | 'industrial';

/**
 * The airfield itself — the thing that decides WHICH AIRCRAFT CAN GO THERE.
 *
 * This is the spine of stage design: a nomad strip scratched out of a valley
 * cannot take a four-engine freighter, and a heavy industrial hub has no
 * interest in what a crop duster can carry. Without it, every settlement was
 * interchangeable and the fleet was cosmetic.
 */
export interface AirfieldProfile {
  /** Usable runway length in metres. */
  runwayM: number;
  /** Field elevation. High fields need a longer roll and a higher approach. */
  elevationM: number;
  approach: ApproachKind;
  /** One line the chart prints under the field name. */
  note: string;
}

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
  field: AirfieldProfile;
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
