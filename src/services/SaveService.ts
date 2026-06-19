import type { SaveData, PlayerState, WorldState } from '../types';
import { EventBus } from '../game/utils/EventBus';

const SAVE_KEY = 'ashline_air_save';
const SAVE_VERSION = 1;

function makeDefaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    timestamp: Date.now(),
    player: {
      money: 2500,
      activeAircraftId: '0',
      ownedAircraft: [
        {
          definitionId: 'crop_duster',
          fuel: 80,
          integrity: 100,
          engineTemp: 0,
          cargoSlots: [],
        },
      ],
      activeContractId: null,
      completedContractIds: [],
      failedContractIds: [],
      reputation: [
        { factionId: 'republic',        points: 0 },
        { factionId: 'merchants_guild', points: 0 },
        { factionId: 'nomads',          points: 0 },
        { factionId: 'raiders',         points: 0 },
      ],
      unlockedSettlementIds: ['ashford_basin', 'redrock_camp'],
      stats: {
        totalFlights: 0,
        totalDistanceKm: 0,
        totalCargoDeliveredKg: 0,
        totalEarned: 0,
        perfectLandings: 0,
      },
    },
    world: {
      gameTimestamp: 0,
      settlements: [],
      availableContracts: [],
    },
  };
}

class SaveServiceClass {
  private current: SaveData | null = null;

  load(): SaveData {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      this.current = makeDefaultSave();
      return this.current;
    }

    try {
      const parsed = JSON.parse(raw) as SaveData;
      this.current = this.migrate(parsed);
    } catch {
      console.warn('[SaveService] Corrupt save detected, using default.');
      this.current = makeDefaultSave();
    }

    EventBus.emit('save:loaded');
    return this.current;
  }

  save(player: PlayerState, world: WorldState): void {
    this.current = {
      version: SAVE_VERSION,
      timestamp: Date.now(),
      player,
      world,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.current));
    EventBus.emit('save:saved');
  }

  deleteSave(): void {
    localStorage.removeItem(SAVE_KEY);
    this.current = null;
  }

  hasSave(): boolean {
    return localStorage.getItem(SAVE_KEY) !== null;
  }

  get(): SaveData {
    if (!this.current) return this.load();
    return this.current;
  }

  private migrate(data: SaveData): SaveData {
    // Future: add migration steps per version increment
    if (data.version === SAVE_VERSION) return data;
    console.warn(`[SaveService] Migrating save from v${data.version} to v${SAVE_VERSION}`);
    return { ...makeDefaultSave(), ...data, version: SAVE_VERSION };
  }
}

export const SaveService = new SaveServiceClass();
