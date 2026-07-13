import Phaser from 'phaser';
import type { FlightState } from '../../../../types';
import type { AircraftVisualSpec } from './AircraftVisualSpec';

/**
 * Owns the aircraft's particle emitters (Phaser 3.60+ API: an emitter IS the
 * game object). Emitters live in scene space and are repositioned every frame
 * from the container position + body pitch, so puffs trail correctly.
 */
export class AircraftParticles {
  private readonly exhaust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly fire: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly rollDust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly burst: Phaser.GameObjects.Particles.ParticleEmitter;

  private readonly fuelMist: Phaser.GameObjects.Particles.ParticleEmitter;

  private exhaustOn = false;
  private fireOn = false;
  private rollOn = false;
  private leakOn = false;

  private readonly spec: AircraftVisualSpec;

  constructor(scene: Phaser.Scene, spec: AircraftVisualSpec) {
    this.spec = spec;
    this.exhaust = scene.add.particles(0, 0, 'px_soft', {
      lifespan: { min: 500, max: 950 },
      speedX: { min: -140, max: -60 },
      speedY: { min: -14, max: 10 },
      scale: { start: 0.14, end: 0.6 },
      alpha: { start: 0.26, end: 0 },
      tint: 0x554e42,
      frequency: 120,
      emitting: false,
    });

    this.fire = scene.add.particles(0, 0, 'px_soft', {
      lifespan: { min: 200, max: 380 },
      speedX: { min: -60, max: -15 },
      speedY: { min: -14, max: 14 },
      scale: { start: 0.38, end: 0.06 },
      alpha: { start: 0.85, end: 0 },
      tint: [0xffa030, 0xff6018, 0xb22808],
      frequency: 28,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });

    this.embers = scene.add.particles(0, 0, 'px_streak', {
      lifespan: { min: 300, max: 700 },
      speedX: { min: -160, max: -80 },
      speedY: { min: -20, max: 30 },
      scale: { start: 0.5, end: 0.1 },
      alpha: { start: 0.9, end: 0 },
      tint: 0xffb040,
      frequency: 110,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });

    this.rollDust = scene.add.particles(0, 0, 'px_soft', {
      lifespan: { min: 400, max: 800 },
      speedX: { min: -90, max: -35 },
      speedY: { min: -22, max: -4 },
      scale: { start: 0.3, end: 1.1 },
      alpha: { start: 0.20, end: 0 },
      tint: 0xb08a50,
      frequency: 55,
      emitting: false,
    });

    this.burst = scene.add.particles(0, 0, 'px_soft', {
      lifespan: { min: 450, max: 900 },
      speedX: { min: -120, max: 60 },
      speedY: { min: -70, max: -10 },
      scale: { start: 0.5, end: 1.4 },
      alpha: { start: 0.30, end: 0 },
      tint: 0xb08a50,
      emitting: false,
    });

    this.fuelMist = scene.add.particles(0, 0, 'px_soft', {
      lifespan: { min: 500, max: 900 },
      speedX: { min: -170, max: -100 },
      speedY: { min: 4, max: 28 },
      scale: { start: 0.1, end: 0.42 },
      alpha: { start: 0.35, end: 0 },
      tint: 0xcfe8f2,
      frequency: 30,
      emitting: false,
    });
  }

  /** Persistent thin mist streaming off the wing after a fuel-leak event. */
  setFuelLeak(on: boolean): void {
    if (on === this.leakOn) return;
    this.leakOn = on;
    if (on) this.fuelMist.start(); else this.fuelMist.stop();
  }

  /** Reposition + toggle emitters. (x, y) = container position, rot = body rotation. */
  update(state: FlightState, x: number, y: number, rot: number, engineOn: boolean, groundY: number): void {
    const s = this.spec.scale;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const at = (lx: number, ly: number): [number, number] => {
      // Body-local design units → scene coords (body sits groundContactY above container origin)
      const bx = lx * s, by = (ly - this.spec.groundContactY) * s;
      return [x + bx * cos - by * sin, y + bx * sin + by * cos];
    };

    // Exhaust — throttle-scaled; darkens and thickens when hot or damaged
    const distress = state.engineTemp > 0.85 || state.integrity < 35;
    const wantExhaust = engineOn && state.throttle > 0.02;
    if (wantExhaust !== this.exhaustOn) {
      this.exhaustOn = wantExhaust;
      if (wantExhaust) this.exhaust.start(); else this.exhaust.stop();
    }
    if (wantExhaust) {
      const [ex, ey] = at(this.spec.exhaust.x, this.spec.exhaust.y);
      this.exhaust.setPosition(ex, ey);
      this.exhaust.frequency = distress ? 26 : 210 - state.throttle * 165;
      this.exhaust.particleTint = distress ? 0x26221c : 0x554e42;
    }

    // Engine fire below 20% integrity
    const wantFire = state.integrity < 20;
    if (wantFire !== this.fireOn) {
      this.fireOn = wantFire;
      if (wantFire) { this.fire.start(); this.embers.start(); }
      else { this.fire.stop(); this.embers.stop(); }
    }
    if (wantFire) {
      const e0 = this.spec.engines[0];
      const [fx, fy] = at(e0.x - e0.cowlLen * 0.3, e0.y);
      this.fire.setPosition(fx, fy);
      this.embers.setPosition(fx, fy);
    }

    // Fuel-leak mist trails from the wing
    if (this.leakOn) {
      const w = this.spec.wing;
      const [mx, my] = at(w.rootX - w.chord * 0.5, w.y + 2);
      this.fuelMist.setPosition(mx, my);
    }

    // Ground-roll dust behind the wheels
    const wantRoll = state.altitude <= 0 && state.speed > 3;
    if (wantRoll !== this.rollOn) {
      this.rollOn = wantRoll;
      if (wantRoll) this.rollDust.start(); else this.rollDust.stop();
    }
    if (wantRoll) {
      this.rollDust.setPosition(x + (this.spec.gear.mainX - 14) * s, groundY + 2);
      this.rollDust.frequency = Math.max(18, 70 - state.speed * 1.4);
    }
  }

  /** One-shot dust burst at touchdown, scaled by impact severity. */
  touchdownBurst(x: number, groundY: number, vSpeedAtImpact: number): void {
    const n = Math.round(Phaser.Math.Clamp(8 + Math.abs(vSpeedAtImpact) * 6, 8, 50));
    this.burst.explode(n, x + this.spec.gear.mainX * this.spec.scale, groundY);
  }

  destroy(): void {
    this.exhaust.destroy();
    this.fire.destroy();
    this.embers.destroy();
    this.rollDust.destroy();
    this.burst.destroy();
    this.fuelMist.destroy();
  }
}
