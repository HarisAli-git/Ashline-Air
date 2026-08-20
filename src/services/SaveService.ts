import type { SaveData, PlayerState, WorldState, OwnedAircraft, AircraftDefinition } from '../types';
import { EventBus } from '../game/utils/EventBus';
import { ProfileService } from './ProfileService';

/**
 * Saves are namespaced per pilot. `ProfileService.ensureActive()` guarantees
 * there is one (adopting any pre-profiles save), so this never falls back.
 */
function saveKey(): string {
  return ProfileService.saveKeyFor(ProfileService.ensureActive().id);
}
// v3: the player now has a position on the map, and settlements unlock
const SAVE_VERSION = 4;

/**
 * Airframes removed in v4, and what a save holding one gets instead.
 *
 * Both map UPWARDS. The old cargo aircraft carried 1500 kg and the twin
 * turboprop 2500, so the nearest survivor by capability is a promotion in
 * both cases - and charging an existing player for a change they did not ask
 * for would be the wrong way round.
 */
const RETIRED_AIRCRAFT: Record<string, string> = {
  old_cargo_aircraft: 'regional_freighter',
  twin_turboprop: 'military_transport',
};

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
      currentLocationId: 'ashford_basin',
      stats: {
        totalFlights: 0,
        totalDistanceKm: 0,
        totalCargoDeliveredKg: 0,
        totalEarned: 0,
        perfectLandings: 0,
      },
    },
    world: {
      gameTimestamp: 480, // day 1, 08:00 — start in morning light
      settlements: [],
      availableContracts: [],
    },
  };
}

class SaveServiceClass {
  private current: SaveData | null = null;

  load(): SaveData {
    const raw = localStorage.getItem(saveKey());
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
    localStorage.setItem(saveKey(), JSON.stringify(this.current));
    EventBus.emit('save:saved');
  }

  /** Forget the in-memory save so the next read comes from the new pilot. */
  invalidate(): void {
    this.current = null;
  }

  deleteSave(): void {
    localStorage.removeItem(saveKey());
    this.current = null;
  }

  hasSave(): boolean {
    return localStorage.getItem(saveKey()) !== null;
  }

  get(): SaveData {
    if (!this.current) return this.load();
    return this.current;
  }

  /**
   * Bounds-checked lookup of the player's active aircraft.
   * `activeAircraftId` is stored as a stringified array index; fall back to
   * slot 0 rather than crashing on a stale or malformed id.
   */
  getActiveAircraft(): { owned: OwnedAircraft; def: AircraftDefinition } {
    const save = this.get();
    const idx = Number.parseInt(save.player.activeAircraftId, 10);
    const owned =
      (Number.isFinite(idx) ? save.player.ownedAircraft[idx] : undefined) ??
      save.player.ownedAircraft[0];
    const def = window.gameData.aircraft.find(a => a.id === owned.definitionId);
    if (!def) throw new Error(`[SaveService] Unknown aircraft definition: ${owned.definitionId}`);
    return { owned, def };
  }

  private migrate(data: SaveData): SaveData {
    if (data.version === SAVE_VERSION) return data;
    console.warn(`[SaveService] Migrating save from v${data.version} to v${SAVE_VERSION}`);

    const defaults = makeDefaultSave();
    const migrated: SaveData = {
      ...defaults,
      ...data,
      version: SAVE_VERSION,
      player: {
        ...defaults.player,
        ...data.player,
        stats: { ...defaults.player.stats, ...data.player?.stats },
        // Saves from before v3 have no position — put the aircraft at the
        // first settlement they had unlocked rather than nowhere.
        currentLocationId:
          data.player?.currentLocationId
          ?? data.player?.unlockedSettlementIds?.[0]
          ?? defaults.player.currentLocationId,
        activeContractId: null, // old contract shapes are discarded below
        // v4 cut the fleet from six airframes to four. A save owning one of
        // the retired two is re-equipped with its nearest survivor rather than
        // left holding an aircraft the game can no longer describe - which
        // would fall through specFor() and silently fly as a crop duster.
        ownedAircraft: (data.player?.ownedAircraft ?? defaults.player.ownedAircraft)
          .map(o => RETIRED_AIRCRAFT[o.definitionId]
            ? { ...o, definitionId: RETIRED_AIRCRAFT[o.definitionId] }
            : o),
      },
      world: {
        ...defaults.world,
        ...data.world,
        // v1 contracts lack the reworked type/expiry semantics — drop them;
        // BootScene regenerates the board when it's empty.
        availableContracts: [],
      },
    };
    return migrated;
  }
}

export const SaveService = new SaveServiceClass();
