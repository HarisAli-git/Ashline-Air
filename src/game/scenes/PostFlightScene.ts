import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { TimeService } from '../../services/TimeService';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import { ContractService } from '../../services/ContractService';
import type { LandingResult, Contract, FlightState, CargoSlot } from '../../types';
import { clamp } from '../utils/math';

interface PostFlightData {
  result: LandingResult;
  contractId: string;
  finalState: FlightState;
  cargoSlots: CargoSlot[];
  reachedDestination: boolean;
}

type Outcome = 'delivered' | 'cargo_ruined' | 'diverted' | 'crashed' | 'ferry';

export class PostFlightScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PostFlightScene' });
  }

  create(data: PostFlightData): void {
    const { result, contractId, finalState, cargoSlots, reachedDestination } = data;
    const { width, height } = this.cameras.main;
    const cx = width / 2;

    // Tell React the flight is over so the FlightHUD overlay unmounts
    EventBus.emit('scene:flight-complete', { result, contractId });

    this.cameras.main.setBackgroundColor('#100c04');
    fadeIn(this, 400);

    const save = SaveService.get();
    const contract = save.world.availableContracts.find(c => c.id === contractId);

    // ── Aircraft wear: the flight consumed fuel and stressed the engine ────
    const { owned: aircraft, def } = SaveService.getActiveAircraft();
    aircraft.integrity  = clamp(aircraft.integrity - result.integrityDamage, 0, 100);
    aircraft.fuel       = clamp(finalState.fuel, 0, def.stats.fuelCapacity);
    aircraft.engineTemp = clamp(finalState.engineTemp, 0, 1);

    // ── Outcome ─────────────────────────────────────────────────────────────
    const avgCondition = cargoSlots.length
      ? cargoSlots.reduce((s, c) => s + c.condition, 0) / cargoSlots.length
      : 100;
    const meetsMinimums = !contract || contract.payload.every(p => {
      const slot = cargoSlots.find(s => s.goodId === p.goodId);
      return !slot || slot.condition >= p.minimumCondition;
    });

    let outcome: Outcome;
    if (!contract) outcome = 'ferry';
    else if (result.quality === 'crash') outcome = 'crashed';
    else if (!reachedDestination) outcome = 'diverted';
    else if (!meetsMinimums) outcome = 'cargo_ruined';
    else outcome = 'delivered';

    let payout = 0;
    let bonusEarned = 0;
    let repGain = 0;
    let penalty = 0;

    if (contract) {
      if (outcome === 'delivered') {
        const { basePay, bonusPay, reputationGain } = contract.reward;
        const isPassenger = contract.type === 'passenger';

        payout = basePay;
        repGain = reputationGain;
        if (result.quality === 'perfect') {
          bonusEarned = bonusPay;
        } else if (result.quality === 'good') {
          bonusEarned = Math.round(bonusPay * 0.5);
        } else if (result.quality === 'hard') {
          // Passengers do not tip after a slam-down
          if (isPassenger) { payout = Math.round(payout * 0.5); repGain = 0; }
        }
        payout += bonusEarned;

        // Condition scaling: half the pay rides on cargo state
        payout = Math.round(payout * (0.5 + 0.5 * (avgCondition / 100)));

        save.player.money += payout;
        save.player.completedContractIds.push(contractId);
        save.player.stats.totalCargoDeliveredKg += cargoSlots.reduce((s, c) => s + c.weightKg, 0);
        save.player.stats.totalEarned += payout;
        save.world.availableContracts = save.world.availableContracts.filter(c => c.id !== contractId);
        save.player.activeContractId = null;

        const repEntry = save.player.reputation.find(r => r.factionId === contract.factionId);
        if (repEntry) repEntry.points = clamp(repEntry.points + repGain, 0, 1000);
        ContractService.completeContract(contractId);
        EventBus.emit('player:money-changed', { amount: save.player.money, delta: payout });
        EventBus.emit('player:reputation-changed', {
          factionId: contract.factionId, delta: repGain,
          total: repEntry?.points ?? 0,
        });
      } else if (outcome === 'crashed' || outcome === 'cargo_ruined') {
        penalty = contract.reward.penaltyForFailure;
        save.player.money = Math.max(0, save.player.money - penalty);
        save.player.failedContractIds.push(contractId);
        save.world.availableContracts = save.world.availableContracts.filter(c => c.id !== contractId);
        save.player.activeContractId = null;
        ContractService.failContract(contractId, outcome === 'crashed' ? 'Crash landing' : 'Cargo ruined');
        EventBus.emit('player:money-changed', { amount: save.player.money, delta: -penalty });
      }
      // 'diverted': the contract stays active — fly the route again to deliver
    }

    save.player.stats.totalFlights++;
    save.player.stats.totalDistanceKm += finalState.distanceTravelled;
    if (result.quality === 'perfect') save.player.stats.perfectLandings++;
    SaveService.save(save.player, save.world);

    // ── World clock: flight time + turnaround (1 flight second = 1 minute) ─
    TimeService.advance(Math.round(finalState.elapsedSeconds) + 15);

    // ── Render results ─────────────────────────────────────────────────────
    const qualityColor: Record<string, string> = {
      perfect: '#00ff88', good: '#ffd080', hard: '#ff8844', crash: '#ff4444',
    };

    this.add.text(cx, 52, 'LANDING REPORT', {
      fontSize: '32px', color: '#e8d5b7', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(cx, 100, result.quality.toUpperCase(), {
      fontSize: '40px',
      color: qualityColor[result.quality],
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const outcomeLabel: Record<Outcome, [string, string]> = {
      delivered:    ['CARGO DELIVERED', '#00ff88'],
      cargo_ruined: ['CARGO RUINED — DELIVERY REJECTED', '#ff4444'],
      diverted:     ['DIVERTED — CONTRACT STILL ACTIVE', '#ffd080'],
      crashed:      ['CONTRACT FAILED', '#ff4444'],
      ferry:        ['FERRY FLIGHT', '#8a7a5a'],
    };
    this.add.text(cx, 138, outcomeLabel[outcome][0], {
      fontSize: '15px', color: outcomeLabel[outcome][1], fontFamily: 'monospace',
    }).setOrigin(0.5);

    const stats = [
      `Vertical Speed:    ${result.verticalSpeed.toFixed(1)} m/s`,
      `Horizontal Speed:  ${(result.horizontalSpeed * 3.6).toFixed(0)} km/h`,
      `Gear:              ${result.gearDown ? 'DOWN ✓' : 'UP — penalty!'}`,
      `Airframe Damage:   -${result.integrityDamage}%`,
      `Flight Time:       ${Math.round(finalState.elapsedSeconds)} min (game time)`,
    ];
    if (cargoSlots.length > 0) {
      stats.push(`Cargo Condition:   ${avgCondition.toFixed(0)}%`);
    }

    stats.forEach((line, i) => {
      this.add.text(cx, 185 + i * 28, line, {
        fontSize: '15px', color: '#c8b888', fontFamily: 'monospace',
      }).setOrigin(0.5);
    });

    const payY = 185 + stats.length * 28 + 18;
    if (outcome === 'delivered' && contract) {
      this.add.text(cx, payY, `BASE PAY:  ₢ ${contract.reward.basePay.toLocaleString()}`, {
        fontSize: '17px', color: '#e8d5b7', fontFamily: 'monospace',
      }).setOrigin(0.5);
      if (bonusEarned > 0) {
        this.add.text(cx, payY + 26, `BONUS:     ₢ ${bonusEarned.toLocaleString()}`, {
          fontSize: '17px', color: '#00ff88', fontFamily: 'monospace',
        }).setOrigin(0.5);
      }
      this.add.text(cx, payY + 58, `TOTAL:  ₢ ${payout.toLocaleString()}`, {
        fontSize: '23px', color: '#ffd080', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      if (repGain > 0) {
        this.add.text(cx, payY + 90, `Reputation +${repGain}`, {
          fontSize: '15px', color: '#88ccff', fontFamily: 'monospace',
        }).setOrigin(0.5);
      }
    } else if (penalty > 0) {
      this.add.text(cx, payY, `PENALTY:  -₢ ${penalty.toLocaleString()}`, {
        fontSize: '20px', color: '#ff4444', fontFamily: 'monospace',
      }).setOrigin(0.5);
    } else if (outcome === 'diverted') {
      this.add.text(cx, payY, 'Take off again and fly the full route to deliver.', {
        fontSize: '14px', color: '#8a7a5a', fontFamily: 'monospace',
      }).setOrigin(0.5);
    }

    this.makeButton(cx, height - 52, 'RETURN TO MAP', () => {
      EventBus.emit('scene:return-to-map');
      fadeToScene(this, 'MapScene');
    });
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void): void {
    this.add.text(x, y, label, {
      fontSize: '20px', color: '#e8d5b7', fontFamily: 'monospace',
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', function(this: Phaser.GameObjects.Text) { this.setStyle({ color: '#ffd080' }); })
      .on('pointerout',  function(this: Phaser.GameObjects.Text) { this.setStyle({ color: '#e8d5b7' }); })
      .on('pointerdown', () => { SoundEngine.click(); onClick(); });
  }
}
