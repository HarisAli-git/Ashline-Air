import { SaveService } from './SaveService';
import { EventBus } from '../game/utils/EventBus';

/**
 * Test harness for the player.
 *
 * Progression is the whole point of the game, which makes it a nuisance when
 * you are trying to look at the sixth destination or fly the heavy transport.
 * This grants everything at once so the content can be inspected without
 * playing thirty contracts to reach it.
 *
 * Available whenever the dev server is running, or on any build with `?dev=1`
 * in the URL — deliberately not silently on in a normal production session.
 */

const CHEAT_MONEY = 9_999_999;

class DevServiceClass {
  /** True when the cheats should be reachable at all. */
  get enabled(): boolean {
    if (import.meta.env.DEV) return true;
    try {
      return new URLSearchParams(window.location.search).has('dev');
    } catch {
      return false;
    }
  }

  /** Money, the whole fleet, and every destination on the chart. */
  unlockEverything(): string {
    const save = SaveService.get();

    save.player.money = CHEAT_MONEY;

    // One of every airframe, fuelled and undamaged
    for (const def of window.gameData.aircraft) {
      if (save.player.ownedAircraft.some(o => o.definitionId === def.id)) continue;
      save.player.ownedAircraft.push({
        definitionId: def.id,
        fuel: def.stats.fuelCapacity,
        integrity: 100,
        engineTemp: 0,
        cargoSlots: [],
      });
    }

    // Every settlement open, and enough standing that nothing is tier-gated
    save.player.unlockedSettlementIds = window.gameData.settlements.map(s => s.id);
    save.player.reputation = save.player.reputation.map(r => ({ ...r, points: Math.max(r.points, 500) }));

    SaveService.save(save.player, save.world);
    EventBus.emit('player:money-changed', { amount: save.player.money, delta: 0 });
    EventBus.emit('player:fleet-changed', { definitionId: 'dev' });

    return `Unlocked: ₢${CHEAT_MONEY.toLocaleString()}, `
      + `${save.player.ownedAircraft.length} aircraft, `
      + `${save.player.unlockedSettlementIds.length} destinations.`;
  }
}

export const DevService = new DevServiceClass();
