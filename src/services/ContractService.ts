import type {
  Contract,
  ContractPayload,
  SettlementDefinition,
  GoodDefinition,
  FactionReputation,
} from '../types';
import { generateId } from '../game/utils/idGenerator';
import { randomBetween, randomInt, distance, pixelsToKm } from '../game/utils/math';
import { EventBus } from '../game/utils/EventBus';

const CONTRACTS_PER_SETTLEMENT = 3;
const CONTRACT_TTL_MINUTES = 120;  // in-game minutes before expiry
const KM_PER_PIXEL = 0.5;

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

  private buildContract(
    origin: SettlementDefinition,
    dest: SettlementDefinition,
    reputation: FactionReputation[],
    gameTimestamp: number
  ): Contract | null {
    const availableGoods = origin.goods
      .map(g => this.goods.find(gd => gd.id === g.goodId))
      .filter((g): g is GoodDefinition => g !== undefined);

    if (availableGoods.length === 0) return null;

    const good = availableGoods[randomInt(0, availableGoods.length - 1)];
    const quantity = randomInt(1, 5);
    const totalWeight = good.weightPerUnit * quantity;

    const distKm = pixelsToKm(
      distance(origin.position.x, origin.position.y, dest.position.x, dest.position.y),
      KM_PER_PIXEL
    );

    const basePay = Math.round(good.baseValue * quantity * (1 + distKm / 500) * randomBetween(0.9, 1.2));
    const bonusPay = Math.round(basePay * 0.25);
    const repGain = Math.round(distKm / 50);

    const factionRep = reputation.find(r => r.factionId === origin.factionId);
    const repRequirement = good.illegal ? 250 : 0;

    return {
      id: generateId('contract'),
      type: 'cargo',
      title: `Deliver ${good.name} to ${dest.name}`,
      description: `${dest.name} needs ${quantity} unit(s) of ${good.name.toLowerCase()}. Distance: ~${Math.round(distKm)} km.`,
      originId: origin.id,
      destinationId: dest.id,
      factionId: origin.factionId,
      payload: [
        {
          goodId: good.id,
          quantity,
          totalWeightKg: totalWeight,
          minimumCondition: good.fragile ? 60 : 0,
        } satisfies ContractPayload,
      ],
      reward: {
        basePay,
        bonusPay,
        reputationGain: repGain,
        penaltyForFailure: Math.round(basePay * 0.3),
      },
      expiresAt: gameTimestamp + CONTRACT_TTL_MINUTES,
      timeLimit: Math.round(distKm / 2),
      status: 'available',
      reputationRequirement: repRequirement,
    };
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
