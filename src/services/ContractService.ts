import type {
  Contract,
  ContractPayload,
  ContractType,
  SaveData,
  SettlementDefinition,
  GoodDefinition,
  FactionReputation,
} from '../types';
import { generateId } from '../game/utils/idGenerator';
import { randomBetween, randomInt, distance, pixelsToKm } from '../game/utils/math';
import { EventBus } from '../game/utils/EventBus';

const CONTRACTS_PER_SETTLEMENT = 3;
const CONTRACT_TTL_MINUTES = 240;  // in-game minutes before expiry
const KM_PER_PIXEL = 0.5;

// Contract type mix: mostly cargo, with rarer high-stakes work
const TYPE_WEIGHTS: Array<[ContractType, number]> = [
  ['cargo', 0.60],
  ['passenger', 0.20],
  ['emergency', 0.12],
  ['secret', 0.08],
];

class ContractServiceClass {
  private goods: GoodDefinition[] = [];

  initialise(goods: GoodDefinition[]): void {
    this.goods = goods;
  }

  generateContractsForSettlement(
    origin: SettlementDefinition,
    allSettlements: SettlementDefinition[],
    unlockedIds: string[],
    reputation: FactionReputation[],
    gameTimestamp: number
  ): Contract[] {
    const destinations = allSettlements.filter(
      s => s.id !== origin.id && unlockedIds.includes(s.id)
    );
    if (destinations.length === 0) return [];

    const contracts: Contract[] = [];

    for (let i = 0; i < CONTRACTS_PER_SETTLEMENT; i++) {
      const dest = destinations[randomInt(0, destinations.length - 1)];
      const contract = this.buildContract(origin, dest, reputation, gameTimestamp);
      if (contract) contracts.push(contract);
    }

    return contracts;
  }

  private rollType(): ContractType {
    const roll = Math.random();
    let cumulative = 0;
    for (const [type, weight] of TYPE_WEIGHTS) {
      cumulative += weight;
      if (roll < cumulative) return type;
    }
    return 'cargo';
  }

  private buildContract(
    origin: SettlementDefinition,
    dest: SettlementDefinition,
    _reputation: FactionReputation[],
    gameTimestamp: number
  ): Contract | null {
    const availableGoods = origin.goods
      .map(g => this.goods.find(gd => gd.id === g.goodId))
      .filter((g): g is GoodDefinition => g !== undefined);

    if (availableGoods.length === 0) return null;

    let type = this.rollType();
    const illegalGoods = availableGoods.filter(g => g.illegal);
    if (type === 'secret' && illegalGoods.length === 0) type = 'cargo';

    const distKm = pixelsToKm(
      distance(origin.position.x, origin.position.y, dest.position.x, dest.position.y),
      KM_PER_PIXEL
    );
    const repGain = Math.max(1, Math.round(distKm / 50));

    // Type-specific payload, pay and gating
    let payload: ContractPayload[];
    let title: string;
    let description: string;
    let basePay: number;
    let payMult = 1;
    let repRequirement = 0;
    let ttl = CONTRACT_TTL_MINUTES;
    let penaltyMult = 0.3;

    if (type === 'passenger') {
      const seats = randomInt(2, 6);
      payload = [{ goodId: 'passengers', quantity: seats, totalWeightKg: seats * 90, minimumCondition: 0 }];
      title = `Fly ${seats} passengers to ${dest.name}`;
      description = `${seats} settlers need safe passage to ${dest.name}. They will not forgive a rough ride. Distance: ~${Math.round(distKm)} km.`;
      basePay = Math.round(seats * 180 * (1 + distKm / 500) * randomBetween(0.9, 1.2));
    } else {
      const pool = type === 'secret' ? illegalGoods : availableGoods;
      const good = pool[randomInt(0, pool.length - 1)];
      const quantity = randomInt(1, 5);
      payload = [{
        goodId: good.id,
        quantity,
        totalWeightKg: good.weightPerUnit * quantity,
        minimumCondition: good.fragile ? 60 : 0,
      }];
      basePay = Math.round(good.baseValue * quantity * (1 + distKm / 500) * randomBetween(0.9, 1.2));

      if (type === 'emergency') {
        payMult = 2.2;
        repRequirement = 100;
        ttl = randomInt(30, 45); // take it now or lose it
        title = `EMERGENCY — rush ${good.name} to ${dest.name}`;
        description = `${dest.name} is desperate for ${good.name.toLowerCase()} and paying over the odds. The offer won't last. Distance: ~${Math.round(distKm)} km.`;
      } else if (type === 'secret') {
        payMult = 1.8;
        repRequirement = 250;
        penaltyMult = 0.8;
        title = `Discreet delivery to ${dest.name}`;
        description = `An unmarked crate of ${good.name.toLowerCase()}. No questions, no manifest, heavy penalty if it doesn't arrive. Distance: ~${Math.round(distKm)} km.`;
      } else {
        title = `Deliver ${good.name} to ${dest.name}`;
        description = `${dest.name} needs ${quantity} unit(s) of ${good.name.toLowerCase()}. Distance: ~${Math.round(distKm)} km.`;
      }
    }

    basePay = Math.round(basePay * payMult);

    return {
      id: generateId('contract'),
      type,
      title,
      description,
      originId: origin.id,
      destinationId: dest.id,
      factionId: origin.factionId,
      payload,
      reward: {
        basePay,
        bonusPay: Math.round(basePay * 0.25),
        reputationGain: type === 'emergency' ? repGain * 2 : repGain,
        penaltyForFailure: Math.round(basePay * penaltyMult),
      },
      expiresAt: gameTimestamp + ttl,
      timeLimit: Math.round(distKm / 2),
      status: 'available',
      reputationRequirement: repRequirement,
    };
  }

  /**
   * Contract lifecycle upkeep, run whenever game time advances:
   * fail an overdue active contract, drop expired offers, and top the board
   * back up to CONTRACTS_PER_SETTLEMENT per unlocked settlement.
   */
  maintainBoard(save: SaveData): void {
    const now = save.world.gameTimestamp;
    const settlements: SettlementDefinition[] = window.gameData.settlements;
    let changed = false;

    // Overdue active contract → failed, with penalty
    if (save.player.activeContractId) {
      const active = save.world.availableContracts.find(c => c.id === save.player.activeContractId);
      if (active && active.expiresAt < now) {
        save.player.money = Math.max(0, save.player.money - active.reward.penaltyForFailure);
        save.player.failedContractIds.push(active.id);
        save.world.availableContracts = save.world.availableContracts.filter(c => c.id !== active.id);
        save.player.activeContractId = null;
        this.failContract(active.id, 'Contract expired');
        EventBus.emit('ui:show-notification', {
          message: `Contract expired: ${active.title} (−₢${active.reward.penaltyForFailure})`,
          type: 'danger',
        });
        EventBus.emit('player:money-changed', { amount: save.player.money, delta: -active.reward.penaltyForFailure });
        changed = true;
      }
    }

    // Drop expired offers
    const beforeCount = save.world.availableContracts.length;
    save.world.availableContracts = save.world.availableContracts.filter(
      c => c.status !== 'available' || c.expiresAt > now
    );
    if (save.world.availableContracts.length !== beforeCount) changed = true;

    // Top each unlocked settlement back up
    for (const settlement of settlements) {
      if (!save.player.unlockedSettlementIds.includes(settlement.id)) continue;
      const count = save.world.availableContracts.filter(
        c => c.originId === settlement.id && c.status === 'available'
      ).length;
      for (let i = count; i < CONTRACTS_PER_SETTLEMENT; i++) {
        const destinations = settlements.filter(
          s => s.id !== settlement.id && save.player.unlockedSettlementIds.includes(s.id)
        );
        if (destinations.length === 0) break;
        const dest = destinations[randomInt(0, destinations.length - 1)];
        const contract = this.buildContract(settlement, dest, save.player.reputation, now);
        if (contract) {
          save.world.availableContracts.push(contract);
          changed = true;
        }
      }
    }

    if (changed) EventBus.emit('contract:board-refreshed');
  }

  refreshBoard(
    settlements: SettlementDefinition[],
    unlockedIds: string[],
    reputation: FactionReputation[],
    gameTimestamp: number
  ): Contract[] {
    const contracts: Contract[] = [];
    for (const settlement of settlements) {
      if (!unlockedIds.includes(settlement.id)) continue;
      const batch = this.generateContractsForSettlement(
        settlement, settlements, unlockedIds, reputation, gameTimestamp
      );
      contracts.push(...batch);
    }
    EventBus.emit('contract:board-refreshed');
    return contracts;
  }

  acceptContract(contract: Contract): Contract {
    const updated = { ...contract, status: 'active' as const };
    EventBus.emit('contract:accepted', { contract: updated });
    return updated;
  }

  completeContract(contractId: string): void {
    EventBus.emit('contract:completed', { contractId });
  }

  failContract(contractId: string, reason: string): void {
    EventBus.emit('contract:failed', { contractId, reason });
  }

  filterExpired(contracts: Contract[], gameTimestamp: number): Contract[] {
    return contracts.filter(c => c.status === 'available' && c.expiresAt > gameTimestamp);
  }
}

export const ContractService = new ContractServiceClass();
