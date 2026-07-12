import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { ContractService } from '../../services/ContractService';
import type { LandingResult, Contract, FlightState } from '../../types';
import { clamp } from '../utils/math';

interface PostFlightData {
  result: LandingResult;
  contractId: string;
  finalState: FlightState;
}

export class PostFlightScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PostFlightScene' });
  }

  create(data: PostFlightData): void {
    const { result, contractId, finalState } = data;
    const { width, height } = this.cameras.main;
    const cx = width / 2;

    // Tell React the flight is over so the FlightHUD overlay unmounts
    EventBus.emit('scene:flight-complete', { result, contractId });

    this.cameras.main.setBackgroundColor('#100c04');
    fadeIn(this, 400);

    const save = SaveService.get();
    const contract = save.world.availableContracts.find(c => c.id === contractId)
      ?? save.world.availableContracts.find(c => c.status === 'active');

    const { payout, repGain, bonusEarned } = this.calculateRewards(result, contract);

    // Update player state — the flight consumed fuel and stressed the engine
    const { owned: aircraft, def } = SaveService.getActiveAircraft();
    aircraft.integrity  = clamp(aircraft.integrity - result.integrityDamage, 0, 100);
    aircraft.fuel       = clamp(finalState.fuel, 0, def.stats.fuelCapacity);
    aircraft.engineTemp = clamp(finalState.engineTemp, 0, 1);

    if (contract) {
      if (result.quality !== 'crash') {
        save.player.money += payout;
        save.player.completedContractIds.push(contractId);
        save.world.availableContracts = save.world.availableContracts.filter(c => c.id !== contractId);
        const repEntry = save.player.reputation.find(r => r.factionId === contract.factionId);
        if (repEntry) repEntry.points = clamp(repEntry.points + repGain, 0, 1000);
        ContractService.completeContract(contractId);
        EventBus.emit('player:money-changed', { amount: save.player.money, delta: payout });
        EventBus.emit('player:reputation-changed', {
          factionId: contract.factionId, delta: repGain,
          total: save.player.reputation.find(r => r.factionId === contract.factionId)?.points ?? 0,
        });
      } else {
        save.player.money = Math.max(0, save.player.money - (contract?.reward.penaltyForFailure ?? 0));
        save.player.failedContractIds.push(contractId);
        save.world.availableContracts = save.world.availableContracts.filter(c => c.id !== contractId);
        ContractService.failContract(contractId, 'Crash landing');
      }
    }

    save.player.activeContractId = null;
    save.player.stats.totalFlights++;
    save.player.stats.totalDistanceKm += finalState.distanceTravelled;
    if (contract && result.quality !== 'crash') save.player.stats.totalEarned += payout;
    if (result.quality === 'perfect') save.player.stats.perfectLandings++;
    SaveService.save(save.player, save.world);

    // --- Render results ---
    const qualityColor: Record<string, string> = {
      perfect: '#00ff88',
      good:    '#ffd080',
      hard:    '#ff8844',
      crash:   '#ff4444',
    };

    this.add.text(cx, 60, 'LANDING REPORT', {
      fontSize: '32px', color: '#e8d5b7', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(cx, 110, result.quality.toUpperCase(), {
      fontSize: '40px',
      color: qualityColor[result.quality],
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const stats = [
      `Vertical Speed:    ${result.verticalSpeed.toFixed(1)} m/s`,
      `Horizontal Speed:  ${(result.horizontalSpeed * 3.6).toFixed(0)} km/h`,
      `Gear:              ${result.gearDown ? 'DOWN ✓' : 'UP — penalty!'}`,
      `Airframe Damage:   -${result.integrityDamage}%`,
      `Cargo Damage:      -${result.cargoDamagePercent}%`,
    ];

    stats.forEach((line, i) => {
      this.add.text(cx, 175 + i * 30, line, {
        fontSize: '16px', color: '#c8b888', fontFamily: 'monospace',
      }).setOrigin(0.5);
    });

    if (contract && result.quality !== 'crash') {
      this.add.text(cx, 345, `BASE PAY:  ₢ ${contract.reward.basePay.toLocaleString()}`, {
        fontSize: '18px', color: '#e8d5b7', fontFamily: 'monospace',
      }).setOrigin(0.5);

      if (bonusEarned > 0) {
        this.add.text(cx, 372, `BONUS:     ₢ ${bonusEarned.toLocaleString()}`, {
          fontSize: '18px', color: '#00ff88', fontFamily: 'monospace',
        }).setOrigin(0.5);
      }

      this.add.text(cx, 410, `TOTAL:  ₢ ${payout.toLocaleString()}`, {
        fontSize: '24px', color: '#ffd080', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);

      this.add.text(cx, 445, `Reputation +${repGain}`, {
        fontSize: '16px', color: '#88ccff', fontFamily: 'monospace',
      }).setOrigin(0.5);
    } else if (result.quality === 'crash') {
      const penalty = contract?.reward.penaltyForFailure ?? 0;
      this.add.text(cx, 345, `PENALTY:  -₢ ${penalty.toLocaleString()}`, {
        fontSize: '20px', color: '#ff4444', fontFamily: 'monospace',
      }).setOrigin(0.5);
    }

    this.makeButton(cx, height - 60, 'RETURN TO MAP', () => {
      EventBus.emit('scene:return-to-map');
      fadeToScene(this, 'MapScene');
    });
  }

  private calculateRewards(
    result: LandingResult,
    contract: Contract | undefined
  ): { payout: number; repGain: number; bonusEarned: number } {
    if (!contract) return { payout: 0, repGain: 0, bonusEarned: 0 };

    const { basePay, bonusPay, reputationGain } = contract.reward;
    let payout = basePay;
    let bonusEarned = 0;

    if (result.quality === 'perfect') {
      bonusEarned = bonusPay;
      payout += bonusEarned;
    } else if (result.quality === 'good') {
      bonusEarned = Math.round(bonusPay * 0.5);
      payout += bonusEarned;
    } else if (result.quality === 'crash') {
      return { payout: 0, repGain: 0, bonusEarned: 0 };
    }

    const cargoPenalty = (result.cargoDamagePercent / 100) * basePay;
    payout = Math.max(0, payout - cargoPenalty);

    return { payout: Math.round(payout), repGain: reputationGain, bonusEarned };
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void): void {
    this.add.text(x, y, label, {
      fontSize: '20px', color: '#e8d5b7', fontFamily: 'monospace',
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', function(this: Phaser.GameObjects.Text) { this.setStyle({ color: '#ffd080' }); })
      .on('pointerout',  function(this: Phaser.GameObjects.Text) { this.setStyle({ color: '#e8d5b7' }); })
      .on('pointerdown', onClick);
  }
}
