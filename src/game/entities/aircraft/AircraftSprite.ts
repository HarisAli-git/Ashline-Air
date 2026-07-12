import Phaser from 'phaser';
import type { FlightState, AircraftDefinition } from '../../../types';
import { specFor, flapHinge, type AircraftVisualSpec } from './render/AircraftVisualSpec';
import { ensureAircraftTextures, SS, type AircraftTexKeys } from './render/AircraftPainter';
import { AircraftParticles } from './render/AircraftParticles';

/**
 * Fully procedural aircraft renderer.
 *
 * Scene graph:
 *   container (scene pos; origin = ground-contact point with gear down)
 *   └── body (offset up by groundContactY; origin = fuselage datum; pitch rotates this)
 *       └── all part images (baked textures, nose facing RIGHT)
 *
 * Articulation is transform-only: the propeller spins real blade images and
 * cross-fades to blur discs with rpm, the gear swings on a door→strut→oleo
 * sub-timeline, flaps rotate about their hinge, damage overlays cross-fade.
 */

const GEAR_TRANSIT_SECONDS = 1.4;
const FLAP_TRANSIT_SECONDS = 0.6;
const MAIN_STOWED_RAD = Phaser.Math.DegToRad(100);   // main gear tucks rearward
const NOSE_STOWED_RAD = Phaser.Math.DegToRad(-100);  // nose gear tucks forward

interface PropAssembly {
  root: Phaser.GameObjects.Container;
  blades: Phaser.GameObjects.Image[];
  disc: Phaser.GameObjects.Image;
  discBlur: Phaser.GameObjects.Image;
}

interface GearLeg {
  root: Phaser.GameObjects.Container;   // hinge point; rotation swings the leg
  wheel: Phaser.GameObjects.Image;
  stowedRad: number;
  door: Phaser.GameObjects.Image | null;
}

export class AircraftSprite {
  /** Positioned by FlightScene; y = ground-contact altitude mapping (as before). */
  readonly container: Phaser.GameObjects.Container;
  /** False for fixed-gear aircraft — FlightScene should ignore the G key. */
  readonly hasRetractableGear: boolean;

  private readonly scene: Phaser.Scene;
  private readonly spec: AircraftVisualSpec;
  private readonly tex: AircraftTexKeys;
  private readonly body: Phaser.GameObjects.Container;
  private readonly shadowImg: Phaser.GameObjects.Image;
  private readonly particles: AircraftParticles | null;
  private readonly groundY: number;

  private readonly props: PropAssembly[] = [];
  private readonly legs: GearLeg[] = [];
  private readonly flapImg: Phaser.GameObjects.Image;
  private readonly damageImg: Phaser.GameObjects.Image;
  private readonly beaconCore: Phaser.GameObjects.Image;
  private readonly beaconGlow: Phaser.GameObjects.Image;
  private readonly lightCone: Phaser.GameObjects.Graphics;

  // ── Animation state ────────────────────────────────────────────────────────
  private engineOn = true;
  private propSpeed = 0;      // 0..1 spooled rpm
  private bladeAngle = 0;
  private gearProgress = 1;   // 1 = down/locked, 0 = stowed
  private gearTargetDown = true;
  private flapProgress = 0;   // 0 = clean, 1 = full deflection
  private wheelSpin = 0;
  private oleoKick = 0;       // touchdown compression impulse, decays
  private beaconT = 0;
  private damageTier = 0;     // 0 = pristine … 4
  private damageFade = 0;
  private t = 0;              // local clock
  private coneOn = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    groundY: number,
    def: AircraftDefinition,
    opts: { particles?: boolean } = {},
  ) {
    this.scene = scene;
    this.groundY = groundY;
    this.spec = specFor(def.id);
    this.tex = ensureAircraftTextures(scene, def.id, this.spec);
    this.hasRetractableGear = !this.spec.gear.fixed;

    const spec = this.spec;

    // Particles first so their emitters render behind the aircraft
    this.particles = opts.particles === false ? null : new AircraftParticles(scene, spec);

    // Shadow (scene-level, stays at ground)
    this.shadowImg = scene.add.image(x, groundY + 4, 'px_shadow')
      .setScale(((spec.length * spec.scale) / 96) * 1.15, 1);

    this.container = scene.add.container(x, groundY);
    this.container.setScale(spec.scale);
    this.body = scene.add.container(0, -spec.groundContactY);
    this.container.add(this.body);

    const img = (key: string, lx = 0, ly = 0): Phaser.GameObjects.Image => {
      const i = scene.add.image(lx, ly, key).setScale(1 / SS);
      this.body.add(i);
      return i;
    };

    // ── Layers, back → front ──────────────────────────────────────────────
    img(this.tex.wingFar);

    this.lightCone = scene.add.graphics();
    this.body.add(this.lightCone);

    for (const e of spec.engines.filter(e => e.far)) {
      img(this.tex.nacelle, e.x, e.y).setAlpha(0.85).setTint(0xb0b0b0);
      this.props.push(this.buildProp(e.x + e.cowlLen / 2 + 6, e.y, 0.75));
    }

    this.buildGear();

    img(this.tex.hull);
    this.damageImg = img(this.tex.damage[0]).setAlpha(0);

    // Gear bay doors sit on the belly skin, in front of the hull
    if (this.hasRetractableGear) {
      for (const leg of this.legs) {
        if (leg.door) this.body.add(leg.door);
      }
    }

    img(this.tex.wingNear);

    const hinge = flapHinge(spec);
    this.flapImg = scene.add.image(hinge.x, hinge.y, this.tex.flap)
      .setScale(1 / SS)
      .setOrigin(1, 0.5);
    this.body.add(this.flapImg);

    img(this.tex.canopy);

    for (const e of spec.engines.filter(e => !e.far)) {
      img(this.tex.nacelle, e.x, e.y);
      this.props.push(this.buildProp(e.x + e.cowlLen / 2 + 6, e.y, 1));
    }

    // Beacon strobe on the fin tip
    this.beaconGlow = img('px_soft', spec.beacon.x, spec.beacon.y)
      .setScale(0.6).setTint(0xff3820).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.beaconCore = img('px_soft', spec.beacon.x, spec.beacon.y)
      .setScale(0.18).setTint(0xffd0c0).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
  }

  // ── Construction helpers ───────────────────────────────────────────────────

  private buildProp(lx: number, ly: number, alpha: number): PropAssembly {
    const root = this.scene.add.container(lx, ly);
    root.setScale(0.32, 1);         // side-view foreshortening of the prop disc
    root.setAlpha(alpha);

    const blades: Phaser.GameObjects.Image[] = [];
    const nBlades = this.spec.prop.bladePairs;
    for (let i = 0; i < nBlades; i++) {
      const b = this.scene.add.image(0, 0, this.tex.propBlade).setScale(1 / SS);
      b.rotation = (Math.PI / 2) * i;
      root.add(b);
      blades.push(b);
    }
    const disc = this.scene.add.image(0, 0, this.tex.propDisc).setScale(1 / SS).setAlpha(0);
    const discBlur = this.scene.add.image(0, 0, this.tex.propDiscBlur).setScale(1 / SS).setAlpha(0);
    root.add(disc);
    root.add(discBlur);

    this.body.add(root);
    return { root, blades, disc, discBlur };
  }

  private buildGear(): void {
    const g = this.spec.gear;
    const bellyY = this.spec.height / 2;

    const makeLeg = (hx: number, stowedRad: number, scale = 1): GearLeg => {
      const root = this.scene.add.container(hx, g.hingeY);
      root.setScale(scale);
      const strut = this.scene.add.image(0, 0, this.tex.gearStrut).setScale(1 / SS).setOrigin(0.5, 0.06);
      const wheel = this.scene.add.image(0, g.strutLen, this.tex.wheel).setScale(1 / SS);
      root.add(strut);
      root.add(wheel);
      this.body.add(root);

      let door: Phaser.GameObjects.Image | null = null;
      if (!g.fixed) {
        door = this.scene.add.image(hx - 9, bellyY - 1, this.tex.gearDoor)
          .setScale(1 / SS)
          .setOrigin(0.05, 0.2); // hinge at the door's forward edge
        // added to body later so it renders in front of the hull
      }
      return { root, wheel, stowedRad, door };
    };

    this.legs.push(makeLeg(g.mainX, MAIN_STOWED_RAD));
    if (g.noseX !== null) this.legs.push(makeLeg(g.noseX, NOSE_STOWED_RAD));
    if (g.tailWheelX !== null) {
      // Taildragger tail wheel: small, never retracts
      const tail = makeLeg(g.tailWheelX, 0, 0.55);
      tail.door = null;
      this.legs.push(tail);
      tail.root.setRotation(0);
    }

    this.gearProgress = 1;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  startEngine(): void { this.engineOn = true; }
  stopEngine(): void { this.engineOn = false; }

  setGearDown(down: boolean): void {
    if (!this.hasRetractableGear) return;
    this.gearTargetDown = down;
  }

  /** Called by FlightScene at the moment of touchdown. */
  notifyTouchdown(vSpeedAtImpact: number): void {
    this.oleoKick = Phaser.Math.Clamp(Math.abs(vSpeedAtImpact) / 6, 0.15, 1);
    this.particles?.touchdownBurst(this.container.x, this.groundY, vSpeedAtImpact);
  }

  /** Per-frame update. dt in seconds. */
  update(dt: number, state: FlightState): void {
    this.t += dt;

    this.updatePropeller(dt, state.throttle);
    this.updateGear(dt, state);
    this.updateFlaps(dt, state.flapsDeployed);
    this.updateDamage(dt, state.integrity);
    this.updateBeacon(dt);
    this.updateLightCone(state);
    this.updateAttitude(state);
    this.updateShadow(state);

    this.particles?.update(
      state, this.container.x, this.container.y, this.body.rotation, this.engineOn, this.groundY,
    );
  }

  destroy(): void {
    this.particles?.destroy();
    this.shadowImg.destroy();
    this.container.destroy();
  }

  // ── Private updaters ───────────────────────────────────────────────────────

  private updatePropeller(dt: number, throttle: number): void {
    const target = this.engineOn ? 0.12 + throttle * 0.88 : 0;
    const k = this.engineOn ? 2.6 : 1.1;
    this.propSpeed += (target - this.propSpeed) * (1 - Math.exp(-dt * k));

    this.bladeAngle += this.propSpeed * 46 * dt;

    const rpm = this.propSpeed;
    // Blade visibility: solid → ghost → hidden
    const bladeAlpha = rpm < 0.25 ? 1 : rpm < 0.6 ? Phaser.Math.Linear(1, 0, (rpm - 0.25) / 0.35) * 0.6 + 0.15 : 0;
    // Disc: fades in through the mid band, hands over to the blur disc
    const discAlpha = rpm < 0.25 ? 0 : rpm < 0.6 ? (rpm - 0.25) / 0.35 : Phaser.Math.Linear(1, 0, (rpm - 0.6) / 0.15);
    // Blur disc with per-frame shimmer — the classic motion-blur flicker
    const blurAlpha = rpm < 0.55 ? 0 : Phaser.Math.Clamp((rpm - 0.55) / 0.2, 0, 1) * (0.75 + Math.random() * 0.35);

    for (const p of this.props) {
      // Rotate blades together, keeping pair phase offsets intact
      p.blades.forEach((b, i) => {
        b.setAlpha(bladeAlpha);
        b.rotation = this.bladeAngle + (Math.PI / 2) * i;
      });
      p.disc.setAlpha(discAlpha);
      p.disc.scaleY = (1 / SS) * (1 + Math.sin(this.t * 30) * 0.03);
      p.discBlur.setAlpha(blurAlpha);
    }
  }

  private updateGear(dt: number, state: FlightState): void {
    if (state.altitude <= 0) this.gearTargetDown = true; // never retract on the ground
    if (!this.hasRetractableGear) this.gearTargetDown = true;

    const dir = this.gearTargetDown ? 1 : -1;
    this.gearProgress = Phaser.Math.Clamp(this.gearProgress + (dir * dt) / GEAR_TRANSIT_SECONDS, 0, 1);
    const prog = this.gearProgress;

    // Oleo touchdown compression decays quickly
    this.oleoKick = Math.max(0, this.oleoKick - dt * 3);

    for (const leg of this.legs) {
      if (leg.stowedRad === 0) { // fixed tail wheel
        leg.wheel.rotation = this.wheelSpin;
        continue;
      }

      // Door: opens 0→0.2, stays open through transit, half-closes 0.85→1
      if (leg.door) {
        let doorDeg: number;
        if (prog <= 0.2) doorDeg = Phaser.Math.Linear(0, 80, prog / 0.2);
        else if (prog <= 0.85) doorDeg = 80;
        else doorDeg = Phaser.Math.Linear(80, 25, (prog - 0.85) / 0.15);
        if (!this.hasRetractableGear) doorDeg = 0;
        leg.door.rotation = Phaser.Math.DegToRad(doorDeg);
      }

      // Strut: swings 0.15→0.85 with a Back.Out overshoot as it locks down
      const st = Phaser.Math.Clamp((prog - 0.15) / 0.7, 0, 1);
      const eased = Phaser.Math.Easing.Back.Out(st);
      leg.root.rotation = leg.stowedRad * (1 - eased);
      leg.root.setVisible(prog > 0.04);

      // Oleo settle at end of transit + touchdown compression
      const settle = prog > 0.85 ? Phaser.Math.Linear(1.06, 1, (prog - 0.85) / 0.15) : 1;
      leg.root.scaleY = settle * (1 - this.oleoKick * 0.12);

      leg.wheel.rotation = this.wheelSpin;
    }

    // Wheel spin while rolling
    if (state.altitude <= 0 && state.speed > 0.5) {
      this.wheelSpin += state.speed * dt * 0.35;
    } else {
      this.wheelSpin *= 1 - Math.min(1, dt * 0.8); // spin-down after liftoff
    }
  }

  private updateFlaps(dt: number, deployed: boolean): void {
    const dir = deployed ? 1 : -1;
    this.flapProgress = Phaser.Math.Clamp(this.flapProgress + (dir * dt) / FLAP_TRANSIT_SECONDS, 0, 1);
    const eased = Phaser.Math.Easing.Sine.InOut(this.flapProgress);
    // Negative rotation = trailing edge down for a right-facing aircraft
    this.flapImg.rotation = Phaser.Math.DegToRad(-this.spec.flap.maxDeflectDeg) * eased;
    this.flapImg.x = flapHinge(this.spec).x - eased * 2; // slight rearward slide
  }

  private updateDamage(dt: number, integrity: number): void {
    const tier = integrity > 82 ? 0 : integrity > 60 ? 1 : integrity > 40 ? 2 : integrity > 20 ? 3 : 4;
    if (tier !== this.damageTier) {
      this.damageTier = tier;
      if (tier > 0) this.damageImg.setTexture(this.tex.damage[tier - 1]);
      this.damageFade = 0;
    }
    const target = tier === 0 ? 0 : 1;
    this.damageFade = Phaser.Math.Clamp(this.damageFade + dt / 0.3, 0, 1);
    this.damageImg.setAlpha(Phaser.Math.Linear(this.damageImg.alpha, target, this.damageFade));
  }

  private updateBeacon(dt: number): void {
    // Double-strobe: blink-blink……pause
    this.beaconT = (this.beaconT + dt) % 1.15;
    const on = this.beaconT < 0.08 || (this.beaconT >= 0.17 && this.beaconT < 0.25);
    this.beaconCore.setAlpha(on ? 1 : 0);
    this.beaconGlow.setAlpha(on ? 0.4 : 0);
  }

  private updateLightCone(state: FlightState): void {
    const want = state.gearDown && state.altitude < 250 && state.verticalSpeed < -0.3;
    if (!want) {
      if (this.coneOn) { this.lightCone.clear(); this.coneOn = false; }
      return;
    }
    this.coneOn = true;
    const L = this.spec.length;
    const flicker = 0.09 + Math.abs(Math.sin(this.t * 25)) * 0.035;
    this.lightCone.clear();
    this.lightCone.fillStyle(0xfff2c0, flicker);
    this.lightCone.fillTriangle(L / 2 + 4, 2, L / 2 + 105, 18, L / 2 + 105, 50);
  }

  private updateAttitude(state: FlightState): void {
    // Nose-up (positive pitch) = counter-clockwise = negative Phaser rotation
    const clamped = Phaser.Math.Clamp(state.pitch, -30, 30);
    let rot = -Phaser.Math.DegToRad(clamped * 0.6);

    let yOff = -this.spec.groundContactY;
    if (state.altitude > 0.5) {
      // Airborne: gentle bob + faint bank noise
      yOff += Math.sin(this.t * 1.4) * 1.5;
      rot += Math.sin(this.t * 1.7) * 0.008 + Math.sin(this.t * 3.3) * 0.005;
    } else if (state.speed > 1) {
      // Ground roll vibration scales with speed
      yOff += Math.sin(this.t * 22) * 0.35 * Math.min(1, state.speed / 10);
    }

    this.body.rotation = rot;
    this.body.y = yOff;
  }

  private updateShadow(state: FlightState): void {
    const t = Math.max(0, 1 - state.altitude / 300);
    this.shadowImg.setX(this.container.x);
    this.shadowImg.setAlpha(t * 0.5);
    const base = ((this.spec.length * this.spec.scale) / 96) * 1.15;
    this.shadowImg.setScale(base * (0.55 + t * 0.45) * (1 + state.speed / 200), 0.6 + t * 0.4);
  }
}
