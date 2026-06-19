export type AircraftTier = 1 | 2 | 3 | 4;

export interface AircraftDefinition {
  id: string;
  name: string;
  tier: AircraftTier;
  description: string;
  stats: AircraftStats;
  unlockCost: number;
  spriteKey: string;
}

export interface AircraftStats {
  maxSpeed: number;          // km/h
  cruiseSpeed: number;       // km/h
  stallSpeed: number;        // km/h
  maxAltitude: number;       // metres
  climbRate: number;         // m/s
  cargoCapacity: number;     // kg
  fuelCapacity: number;      // litres
  fuelBurnRate: number;      // litres/minute at cruise
  engineReliability: number; // 0–1, probability of no failure per minute
  landingDifficulty: number; // 1–10, affects required pilot skill
  repairCostPerUnit: number; // currency per % structural damage
}

// Runtime state for a player-owned aircraft
export interface OwnedAircraft {
  definitionId: string;
  fuel: number;            // current litres
  integrity: number;       // 0–100
  engineTemp: number;      // 0–1 (0=cold, 1=overheating)
  cargoSlots: CargoSlot[];
}

export interface CargoSlot {
  goodId: string | null;
  weightKg: number;
  condition: number; // 0–100, for fragile goods
}
