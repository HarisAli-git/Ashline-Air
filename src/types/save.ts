import type { PilotProfile } from '../game/ai/PilotModel';
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
  /**
   * Where the aircraft physically is right now. Contracts depart from here and
   * nowhere else — without it the map is a menu of teleports rather than a
   * position you have to fly yourself out of.
   */
  currentLocationId: string;
  stats: PlayerStats;
  /**
   * What the world has worked out about how you fly. Written every flight,
   * read at the start of the next one. See game/ai/PilotModel.ts - and note
   * that everything derived from it must stay beatable within a single
   * flight, or it becomes a difficulty setting the player never chose.
   */
  pilot?: PilotProfile;
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
