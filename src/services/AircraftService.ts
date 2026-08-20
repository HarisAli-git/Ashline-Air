import { SaveService } from './SaveService';
import { EventBus } from '../game/utils/EventBus';
import type { SaveData, AircraftDefinition, OwnedAircraft } from '../types';
import { routeBlock } from './RouteService';

/**
 * Owning, buying and choosing aircraft.
 *
 * The fleet has always existed in the data — five airframes with tiers and
 * unlock costs — but nothing ever read those fields, so every pilot flew the
 * same battered crop duster for ever and the money they earned had nothing to
 * be spent on. This is the loop that was missing: fly, get paid, buy something
 * that carries more and flies further, take the contracts that were out of
 * reach with the old aeroplane.
 */

/** Reputation with any one faction needed before a tier is offered at all. */
const TIER_REPUTATION: Record<number, number> = {
  1: 0,
  2: 60,
  3: 160,
};

export type AircraftAvailability =
  | { state: 'owned'; active: boolean; strandedHere: string | null }
  | { state: 'buyable'; cost: number }
  | { state: 'too-poor'; cost: number; short: number }
  | { state: 'locked'; reason: string };

class AircraftServiceClass {
  /** Every airframe in the game, cheapest first. */
  all(): AircraftDefinition[] {
    return [...window.gameData.aircraft].sort(
      (a, b) => a.tier - b.tier || a.unlockCost - b.unlockCost,
    );
  }

  owned(save: SaveData = SaveService.get()): OwnedAircraft[] {
    return save.player.ownedAircraft;
  }

  ownsDefinition(definitionId: string, save: SaveData = SaveService.get()): boolean {
    return save.player.ownedAircraft.some(o => o.definitionId === definitionId);
  }

  activeIndex(save: SaveData = SaveService.get()): number {
    const idx = Number.parseInt(save.player.activeAircraftId, 10);
    return Number.isFinite(idx) && save.player.ownedAircraft[idx] ? idx : 0;
  }

  /** Best reputation held with any single faction — the tier gate. */
  private bestReputation(save: SaveData): number {
    return save.player.reputation.reduce((m, r) => Math.max(m, r.points), 0);
  }

  /**
   * Would taking this airframe leave you stuck where you are standing?
   *
   * The whole fleet sits wherever the player is, so a light aircraft can end
   * up parked at a field it could never have flown to - land the freighter at
   * Irongate, switch to the crop duster, and every route out is four times its
   * range. It can take off; it just has nowhere to go. That is a soft-lock
   * reached through a menu, so the menu is where it gets refused.
   *
   * @returns the field name that would strand it, or null if it is fine
   */
  private strandedAt(def: AircraftDefinition, save: SaveData): string | null {
    const here = window.gameData.settlements.find(x => x.id === save.player.currentLocationId);
    if (!here) return null;
    const anywhere = window.gameData.settlements.some(
      d => d.id !== here.id
        && save.player.unlockedSettlementIds.includes(d.id)
        && routeBlock(def, here, d) === null,
    );
    return anywhere ? null : here.name;
  }

  /** What the player can do with this airframe right now, and why. */
  availability(def: AircraftDefinition, save: SaveData = SaveService.get()): AircraftAvailability {
    const ownedIdx = save.player.ownedAircraft.findIndex(o => o.definitionId === def.id);
    if (ownedIdx >= 0) {
      return {
        state: 'owned',
        active: ownedIdx === this.activeIndex(save),
        strandedHere: this.strandedAt(def, save),
      };
    }

    const need = TIER_REPUTATION[def.tier] ?? 0;
    const rep = this.bestReputation(save);
    if (rep < need) {
      return { state: 'locked', reason: `Needs ${need} reputation with any faction (you have ${rep})` };
    }
    /*
     * You cannot buy something that cannot leave the field you are standing on.
     *
     * Without this the heavy transport - 1150 m of runway - could be bought at
     * a 430 m mountain strip, and the player would own an aircraft with no
     * legal route out of where it is parked. That is a soft-lock you pay
     * 140,000 for.
     */
    const here = window.gameData.settlements.find(x => x.id === save.player.currentLocationId);
    const hereRunway = here?.field?.runwayM ?? 600;
    if (here && hereRunway < def.stats.runwayM) {
      return {
        state: 'locked',
        reason: `${here.name} has ${hereRunway} m of runway — the ${def.name} needs ${def.stats.runwayM} m. Buy it somewhere it can take off.`,
      };
    }
    if (save.player.money < def.unlockCost) {
      return { state: 'too-poor', cost: def.unlockCost, short: def.unlockCost - save.player.money };
    }
    return { state: 'buyable', cost: def.unlockCost };
  }

  /**
   * Buy an airframe. It arrives fuelled and undamaged at your current field,
   * and becomes the active aircraft — you bought it to fly it.
   */
  purchase(definitionId: string): { ok: boolean; message: string } {
    const save = SaveService.get();
    const def = window.gameData.aircraft.find(a => a.id === definitionId);
    if (!def) return { ok: false, message: 'No such aircraft.' };

    const av = this.availability(def, save);
    if (av.state === 'owned') return { ok: false, message: `You already own a ${def.name}.` };
    if (av.state === 'locked') return { ok: false, message: av.reason };
    if (av.state === 'too-poor') {
      return { ok: false, message: `Short by ₢${av.short.toLocaleString()}.` };
    }

    save.player.money -= def.unlockCost;
    save.player.ownedAircraft.push({
      definitionId: def.id,
      fuel: def.stats.fuelCapacity,
      integrity: 100,
      engineTemp: 0,
      cargoSlots: [],
    });
    save.player.activeAircraftId = String(save.player.ownedAircraft.length - 1);
    SaveService.save(save.player, save.world);

    EventBus.emit('player:money-changed', { amount: save.player.money, delta: -def.unlockCost });
    EventBus.emit('player:fleet-changed', { definitionId: def.id });
    return { ok: true, message: `${def.name} delivered. It is now your active aircraft.` };
  }

  /** Make an owned airframe the one you fly. */
  select(index: number): boolean {
    const save = SaveService.get();
    if (!save.player.ownedAircraft[index]) return false;
    const def = window.gameData.aircraft.find(
      a => a.id === save.player.ownedAircraft[index].definitionId,
    );
    const stranded = def ? this.strandedAt(def, save) : null;
    if (def && stranded) {
      EventBus.emit('ui:show-notification', {
        message: `The ${def.name} has nothing it can reach from ${stranded}. Fly out on something with the legs for it first.`,
        type: 'warning',
      });
      return false;
    }
    save.player.activeAircraftId = String(index);
    SaveService.save(save.player, save.world);
    EventBus.emit('player:fleet-changed', {
      definitionId: save.player.ownedAircraft[index].definitionId,
    });
    return true;
  }

  /** Refuel and repair the active aircraft at the current field, for a price. */
  serviceActive(): { ok: boolean; message: string; cost: number } {
    const save = SaveService.get();
    const { owned, def } = SaveService.getActiveAircraft();
    const fuelNeeded = def.stats.fuelCapacity - owned.fuel;
    const wear = 100 - owned.integrity;
    const cost = Math.round(fuelNeeded * 3.2 + wear * def.stats.repairCostPerUnit);
    if (cost <= 0) return { ok: false, message: 'Already fuelled and airworthy.', cost: 0 };
    if (save.player.money < cost) {
      return { ok: false, message: `Servicing costs ₢${cost.toLocaleString()} — you cannot cover it.`, cost };
    }
    save.player.money -= cost;
    owned.fuel = def.stats.fuelCapacity;
    owned.integrity = 100;
    owned.engineTemp = 0;
    SaveService.save(save.player, save.world);
    EventBus.emit('player:money-changed', { amount: save.player.money, delta: -cost });
    EventBus.emit('player:fleet-changed', { definitionId: def.id });
    return { ok: true, message: `Fuelled and repaired for ₢${cost.toLocaleString()}.`, cost };
  }
}

export const AircraftService = new AircraftServiceClass();
