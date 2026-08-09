import { SaveService } from './SaveService';
import { EventBus } from '../game/utils/EventBus';
import type { SaveData, SettlementDefinition } from '../types';

/**
 * Where you are, and what that has earned you.
 *
 * Before this, landing somewhere changed nothing: the map showed no position,
 * every unlocked settlement was one click away regardless of where the
 * aircraft actually was, and the one locked settlement on the chart could
 * never be opened by any amount of play. A delivery has to move you and it has
 * to move the world, or the map is just a level-select menu.
 */

/** What a settlement wants before it will take your calls. */
interface UnlockRule {
  settlementId: string;
  /** Successful deliveries needed. */
  deliveries: number;
  /**
   * Reputation needed — measured as the BEST standing you hold with any one
   * faction, not with the settlement's own.
   *
   * This is not flavour, it is the difference between a rule that fires and a
   * rule that cannot. A contract's reputation is credited to its ORIGIN's
   * faction, and a locked settlement is never an origin — so gating Irongate
   * on Merchants Guild standing would have made it permanently unreachable,
   * which is the exact dead end this whole system exists to remove. It also
   * happens to fit them: the Guild respects results, not loyalty.
   */
  reputation: number;
  /** Shown when it opens up. */
  blurb: string;
}

const UNLOCKS: UnlockRule[] = [
  {
    settlementId: 'irongate_station',
    deliveries: 3,
    reputation: 10,
    blurb: 'The Guild has seen your manifests. Irongate Station will take your traffic.',
  },
];

/** Best standing held with any single faction. */
function bestReputation(save: SaveData): number {
  return save.player.reputation.reduce((m, r) => Math.max(m, r.points), 0);
}

class ProgressionServiceClass {
  /** The settlement the aircraft is currently sitting at. */
  currentLocation(save: SaveData = SaveService.get()): SettlementDefinition | null {
    const id = save.player.currentLocationId;
    return window.gameData.settlements.find(s => s.id === id) ?? null;
  }

  /** True if a contract may be flown out of this settlement right now. */
  canDepartFrom(settlementId: string, save: SaveData = SaveService.get()): boolean {
    return save.player.currentLocationId === settlementId;
  }

  /**
   * The aircraft has arrived somewhere. Moves the player, opens the airfield's
   * own settlement if it was still dark, and returns anything newly unlocked
   * so the landing report can announce it.
   */
  arriveAt(settlementId: string, save: SaveData = SaveService.get()): SettlementDefinition[] {
    const known = window.gameData.settlements.some(s => s.id === settlementId);
    if (!known) return [];

    const moved = save.player.currentLocationId !== settlementId;
    save.player.currentLocationId = settlementId;
    if (!save.player.unlockedSettlementIds.includes(settlementId)) {
      save.player.unlockedSettlementIds.push(settlementId);
    }
    if (moved) EventBus.emit('player:location-changed', { settlementId });

    return this.evaluateUnlocks(save);
  }

  /**
   * Check every unlock rule against the current save. Returns the settlements
   * that opened up on THIS call, so they can be announced once.
   */
  evaluateUnlocks(save: SaveData = SaveService.get()): SettlementDefinition[] {
    const opened: SettlementDefinition[] = [];
    const deliveries = save.player.completedContractIds.length;

    const rep = bestReputation(save);
    for (const rule of UNLOCKS) {
      if (save.player.unlockedSettlementIds.includes(rule.settlementId)) continue;
      const def = window.gameData.settlements.find(s => s.id === rule.settlementId);
      if (!def) continue;
      if (deliveries < rule.deliveries || rep < rule.reputation) continue;

      save.player.unlockedSettlementIds.push(rule.settlementId);
      opened.push(def);
      EventBus.emit('player:settlement-unlocked', { settlementId: def.id, name: def.name });
    }
    return opened;
  }

  /** How far off the next locked settlement is, for the map's progress line. */
  nextUnlockHint(save: SaveData = SaveService.get()): string | null {
    const deliveries = save.player.completedContractIds.length;
    const rep = bestReputation(save);
    for (const rule of UNLOCKS) {
      if (save.player.unlockedSettlementIds.includes(rule.settlementId)) continue;
      const def = window.gameData.settlements.find(s => s.id === rule.settlementId);
      if (!def) continue;
      const needD = Math.max(0, rule.deliveries - deliveries);
      const needR = Math.max(0, rule.reputation - rep);
      const parts: string[] = [];
      if (needD > 0) parts.push(`${needD} more ${needD === 1 ? 'delivery' : 'deliveries'}`);
      if (needR > 0) parts.push(`${needR} more reputation`);
      return `${def.name.toUpperCase()} — needs ${parts.join(' and ') || 'nothing, next landing'}`;
    }
    return null;
  }

  /** The unlock blurb for a settlement, if it has one. */
  blurbFor(settlementId: string): string | null {
    return UNLOCKS.find(r => r.settlementId === settlementId)?.blurb ?? null;
  }
}

export const ProgressionService = new ProgressionServiceClass();
