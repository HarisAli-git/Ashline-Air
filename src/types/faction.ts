export interface FactionDefinition {
  id: string;
  name: string;
  description: string;
  color: string; // hex, for map display
  preferredGoods: string[]; // good ids they trade most
  hostileToFactions: string[]; // faction ids
  reputationTiers: ReputationTier[];
}

export interface ReputationTier {
  label: string;
  minReputation: number;  // 0–1000
  discountPercent: number;
  unlocksAircraftIds: string[];
  unlocksContractTypes: string[];
}

// Per-faction reputation stored in save
export interface FactionReputation {
  factionId: string;
  points: number; // 0–1000
}
