import type { SettlementDefinition, SettlementState, GoodState } from '../types';
import { EventBus } from '../game/utils/EventBus';
import { clamp, randomBetween } from '../game/utils/math';

const PRICE_DRIFT_RATE = 0.02;      // max fractional drift per economy step
const SUPPLY_DRIFT_RATE = 1.5;      // max supply/demand point drift per step

class EconomyServiceClass {
  private definitions: SettlementDefinition[] = [];

  initialise(definitions: SettlementDefinition[]): SettlementState[] {
    this.definitions = definitions;
    return definitions.map(def => this.buildInitialState(def));
  }

  buildInitialState(def: SettlementDefinition): SettlementState {
    const goodStates: Record<string, GoodState> = {};
    for (const entry of def.goods) {
      goodStates[entry.goodId] = {
        supplyLevel: entry.supplyLevel,
        demandLevel: entry.demandLevel,
        currentPrice: entry.basePrice,
      };
    }
    return {
      definitionId: def.id,
      goodStates,
      fuelPrice: def.fuelBasePrice,
      repairCost: def.repairBaseCost,
      lastVisited: null,
    };
  }

  /**
   * Run `steps` drift iterations (TimeService calls this once per 30 in-game
   * minutes elapsed). Returns the updated settlement states.
   */
  step(states: SettlementState[], steps: number): SettlementState[] {
    let current = states;
    for (let i = 0; i < steps; i++) current = this.driftOnce(current);
    return current;
  }

  private driftOnce(states: SettlementState[]): SettlementState[] {
    const updated = states.map(state => {
      const def = this.definitions.find(d => d.id === state.definitionId);
      if (!def) return state;

      const newGoodStates: Record<string, GoodState> = {};

      for (const [goodId, gs] of Object.entries(state.goodStates)) {
        const defEntry = def.goods.find(g => g.goodId === goodId);
        if (!defEntry) continue;

        // Drift supply/demand toward base values with random noise
        const supplyDrift = randomBetween(-SUPPLY_DRIFT_RATE, SUPPLY_DRIFT_RATE);
        const demandDrift = randomBetween(-SUPPLY_DRIFT_RATE, SUPPLY_DRIFT_RATE);

        const newSupply = clamp(
          gs.supplyLevel + supplyDrift + (defEntry.supplyLevel - gs.supplyLevel) * 0.05,
          0, 100
        );
        const newDemand = clamp(
          gs.demandLevel + demandDrift + (defEntry.demandLevel - gs.demandLevel) * 0.05,
          0, 100
        );

        // Price is driven by demand/supply ratio
        const ratio = newDemand / Math.max(newSupply, 1);
        const targetPrice = defEntry.basePrice * ratio;
        const priceDrift = randomBetween(-PRICE_DRIFT_RATE, PRICE_DRIFT_RATE);
        const newPrice = clamp(
          gs.currentPrice + (targetPrice - gs.currentPrice) * 0.1 + gs.currentPrice * priceDrift,
          defEntry.basePrice * 0.3,
          defEntry.basePrice * 3.0
        );

        newGoodStates[goodId] = {
          supplyLevel: newSupply,
          demandLevel: newDemand,
          currentPrice: Math.round(newPrice),
        };

        if (Math.abs(newPrice - gs.currentPrice) > 5) {
          EventBus.emit('economy:price-changed', {
            settlementId: state.definitionId,
            goodId,
            newPrice: Math.round(newPrice),
          });
        }
      }

      // Fuel price drifts independently
      const fuelDrift = randomBetween(-0.1, 0.1);
      const newFuelPrice = clamp(
        state.fuelPrice + fuelDrift,
        def.fuelBasePrice * 0.7,
        def.fuelBasePrice * 2.0
      );

      return { ...state, goodStates: newGoodStates, fuelPrice: Math.round(newFuelPrice * 10) / 10 };
    });

    return updated;
  }

  /** Returns total cost to fill fuel at a settlement */
  fuelCost(state: SettlementState, litres: number): number {
    return Math.round(litres * state.fuelPrice);
  }

  /** Returns repair cost for given percent integrity loss */
  repairCost(state: SettlementState, integrityLoss: number): number {
    return Math.round(integrityLoss * state.repairCost);
  }
}

export const EconomyService = new EconomyServiceClass();
