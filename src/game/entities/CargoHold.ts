import type { CargoSlot, Contract, GoodDefinition } from '../../types';
import { clamp } from '../utils/math';

const PERISHABLE_DECAY_PER_SECOND = 0.15;  // ~9 condition/min of flight
const FRAGILE_TURBULENCE_FACTOR = 0.8;     // condition/s at full turbulence

/**
 * Runtime cargo condition for the active contract. Perishables decay with
 * flight time, fragile goods suffer in turbulence and on rough touchdowns,
 * and events can damage everything. Payout scales with what survives.
 */
export class CargoHold {
  readonly slots: CargoSlot[];
  private readonly fragileById = new Map<string, boolean>();
  private readonly perishableById = new Map<string, boolean>();

  constructor(contract: Contract | null, goods: GoodDefinition[]) {
    this.slots = (contract?.payload ?? []).map(p => ({
      goodId: p.goodId,
      weightKg: p.totalWeightKg,
      condition: 100,
    }));
    for (const g of goods) {
      this.fragileById.set(g.id, g.fragile);
      this.perishableById.set(g.id, g.perishable);
    }
  }

  get hasCargo(): boolean {
    return this.slots.length > 0;
  }

  /** Per-frame decay: perishables rot, fragile goods hate turbulence. */
  update(dt: number, turbulence: number): void {
    for (const slot of this.slots) {
      if (!slot.goodId) continue;
      if (this.perishableById.get(slot.goodId)) {
        slot.condition = clamp(slot.condition - PERISHABLE_DECAY_PER_SECOND * dt, 0, 100);
      }
      if (turbulence > 0.3 && this.fragileById.get(slot.goodId)) {
        slot.condition = clamp(slot.condition - turbulence * FRAGILE_TURBULENCE_FACTOR * dt, 0, 100);
      }
    }
  }

  /** Flat damage from events or landings; fragile goods take it 1.5×. */
  applyDamage(amount: number): void {
    for (const slot of this.slots) {
      const mult = slot.goodId && this.fragileById.get(slot.goodId) ? 1.5 : 1;
      slot.condition = clamp(slot.condition - amount * mult, 0, 100);
    }
  }

  averageCondition(): number {
    if (this.slots.length === 0) return 100;
    return this.slots.reduce((sum, s) => sum + s.condition, 0) / this.slots.length;
  }

  /** True if every payload met its contract's minimum condition. */
  meetsMinimums(contract: Contract): boolean {
    return contract.payload.every(p => {
      const slot = this.slots.find(s => s.goodId === p.goodId);
      return !slot || slot.condition >= p.minimumCondition;
    });
  }

  totalWeightKg(): number {
    return this.slots.reduce((sum, s) => sum + s.weightKg, 0);
  }
}
