import type { OwnedAircraft } from './aircraft';
import type { FactionReputation } from './faction';
import type { SettlementState } from './settlement';
import type { Contract } from './contract';

export interface SaveData {
  version: number;            // schema version for migration
  timestamp: number;          // epoch ms of last save
  player: PlayerState;
  world: WorldState;
}

export interface PlayerState {
  money: number;
  activeAircraftId: string;   // owned aircraft slot index as string
  ownedAircraft: OwnedAircraft[];
  activeContractId: string | null;
  completedContractIds: string[];
  failedContractIds: string[];
  reputation: FactionReputation[];
  unlockedSettlementIds: string[];
  stats: PlayerStats;
}

export interface PlayerStats {
  totalFlights: number;
  totalDistanceKm: number;
  totalCargoDeliveredKg: number;
  totalEarned: number;
  perfectLandings: number;
}

export interface WorldState {
  gameTimestamp: number;      // in-game minutes elapsed
  settlements: SettlementState[];
  availableContracts: Contract[];
}
