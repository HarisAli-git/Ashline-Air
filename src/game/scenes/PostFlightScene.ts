import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { TimeService } from '../../services/TimeService';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import { ContractService } from '../../services/ContractService';
import { ProgressionService } from '../../services/ProgressionService';
import type { LandingResult, Contract, FlightState, CargoSlot, SettlementDefinition } from '../../types';
import { clamp } from '../utils/math';

interface PostFlightData {
  result: LandingResult;
  contractId: string;
  finalState: FlightState;
  cargoSlots: CargoSlot[];
  reachedDestination: boolean;
  landedOnRunway: boolean;
  /** Traffic threaded inside 30 m without hitting it. Pays a bonus. */
  closeCalls?: number;
  /**
   * What the world has worked out about how this pilot flies, in words.
   * See game/ai/PilotModel.ts - the model adjusts the next flight, so it has
   * to say so out loud.
   */
  logbook?: string[];
}

type Outcome = 'delivered' | 'cargo_ruined' | 'diverted' | 'crashed' | 'ferry';

export class PostFlightScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PostFlightScene' });
  }

  create(data: PostFlightData): void {
    const { result, contractId, finalState, cargoSlots, reachedDestination } = data;
    const landedOnRunway = data.landedOnRunway ?? true;
    const closeCalls = data.closeCalls ?? 0;
    const { width, height } = this.cameras.main;
    const cx = width / 2;

    // Tell React the flight is over so the FlightHUD overlay unmounts
    EventBus.emit('scene:flight-complete', { result, contractId });

    this.cameras.main.setBackgroundColor('#100c04');
    fadeIn(this, 400);
    SoundEngine.stopFlightLoop();

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
    let airmanship = 0;
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

        // ── Airmanship ─────────────────────────────────────────────────────
        // Threading traffic instead of blundering through it is the most
        // satisfying thing you can do in the air, so it is worth money. It is
        // the one bonus you cannot earn by flying carefully and slowly.
        if (closeCalls > 0) {
          airmanship = closeCalls * 120;
          payout += airmanship;
        }

        // Condition scaling: half the pay rides on cargo state
        payout = Math.round(payout * (0.5 + 0.5 * (avgCondition / 100)));

        // Precision matters: putting it on the asphalt pays, dropping it in
        // the open means somebody hauls it the rest of the way through
        // walker country — and they charge for that.
        if (!landedOnRunway) {
          payout = Math.round(payout * 0.65);
          repGain = Math.max(0, Math.round(repGain * 0.5));
        }

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

    // ── Where the aircraft now is ───────────────────────────────────────────
    // Arriving somewhere has to actually move you, or the map is a level
    // select. You end up at the destination if you got there in one piece;
    // anything else and you are still standing where you took off from.
    let unlocked: SettlementDefinition[] = [];
    let arrivedAt: string | null = null;
    const madeIt = reachedDestination && result.quality !== 'crash';
    if (contract && madeIt) {
      arrivedAt = contract.destinationId;
      unlocked = ProgressionService.arriveAt(contract.destinationId, save);
    } else {
      // Diverted, crashed or ferried — re-check unlocks anyway, since
      // reputation may have moved on an earlier leg.
      unlocked = ProgressionService.evaluateUnlocks(save);
    }
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
      delivered:    landedOnRunway
        ? ['CARGO DELIVERED — ON-FIELD', '#00ff88']
        : ['DELIVERED OFF-FIELD — recovery fee deducted', '#ffd080'],
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
      if (airmanship > 0) {
        this.add.text(cx, payY + (bonusEarned > 0 ? 46 : 26),
          `AIRMANSHIP: ₢ ${airmanship.toLocaleString()}   (${closeCalls} close call${closeCalls > 1 ? 's' : ''})`, {
            fontSize: '15px', color: '#88ccff', fontFamily: 'monospace',
          }).setOrigin(0.5);
      }
      this.add.text(cx, payY + (airmanship > 0 ? 76 : 58), `TOTAL:  ₢ ${payout.toLocaleString()}`, {
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

    // ── Where you are now, and what that opened ─────────────────────────────
    // "You landed" is not a result. Say the place, so the map that comes next
    // is showing you something you already know.
    // Collected first, then laid out bottom-up from just above the button, so
    // a long unlock blurb can never end up printed through "RETURN TO MAP".
    interface InfoLine {
      text: string; size: number; color: string;
      bold?: boolean; star?: boolean;
      /** Row height. Defaults to the standard 24 - the logbook runs tighter. */
      h?: number;
    }
    const info: InfoLine[] = [];

    const here = ProgressionService.currentLocation(save);
    if (here) {
      info.push({
        text: `${arrivedAt ? '✈  ARRIVED AT' : '⌂  STILL AT'}  ${here.name.toUpperCase()}`,
        size: 15, color: arrivedAt ? '#88ccff' : '#8a7a5a',
      });
    }
    for (const s of unlocked) {
      info.push({
        text: `★  NEW DESTINATION UNLOCKED — ${s.name.toUpperCase()}`,
        size: 16, color: '#ffd080', bold: true, star: true,
      });
      const blurb = ProgressionService.blurbFor(s.id);
      if (blurb) info.push({ text: blurb, size: 12, color: '#c8b888' });
      SoundEngine.chime();
    }
    if (unlocked.length === 0) {
      const hint = ProgressionService.nextUnlockHint(save);
      if (hint) info.push({ text: `Next destination:  ${hint}`, size: 12, color: '#6a5a3a' });
    }

    /*
     * The logbook.
     *
     * The pilot model changes how hard the NEXT flight is, so it owes the
     * player an account of itself. Capped at two lines: this is a note in the
     * margin, not the subject of the screen.
     */
    const logbook = data.logbook ?? [];
    if (logbook.length > 0) {
      info.push({ text: '- LOGBOOK -', size: 11, color: '#5a4a2a', h: 20 });
      for (const line of logbook.slice(0, 2)) {
        info.push({ text: line, size: 12, color: '#8a7a5a', h: 18 });
      }
    }

    const blockBottom = height - 84;
    const blockH = info.reduce((a2, l) => a2 + (l.h ?? 24), 0);
    let infoY = Math.max(payY + 96, blockBottom - blockH);
    for (const line of info) {
      const t = this.add.text(cx, infoY, line.text, {
        fontSize: `${line.size}px`, color: line.color, fontFamily: 'monospace',
        fontStyle: line.bold ? 'bold' : 'normal',
      }).setOrigin(0.5);
      if (line.star) {
        t.setAlpha(0);
        this.tweens.add({ targets: t, alpha: 1, duration: 500, delay: 700 });
        this.tweens.add({ targets: t, scale: 1.04, duration: 900, yoyo: true, repeat: 2, delay: 700 });
      }
      infoY += line.h ?? 24;
    }

    if (outcome === 'delivered') SoundEngine.success();
    else if (outcome === 'crashed' || outcome === 'cargo_ruined') SoundEngine.failure();

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
