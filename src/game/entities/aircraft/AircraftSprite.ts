import Phaser from 'phaser';
import type { FlightState } from '../../../types';

// ── Container scale ────────────────────────────────────────────────────────────
// setScale(-SCALE, SCALE) flips X (plane faces right) and sizes the assembly.
// Tune SCALE to make the plane larger/smaller on screen.
const SCALE = 0.78;

// ── Layer offsets — natural pixels, origin = gear ground contact (0,0) ─────────
// Positive x  → toward tail in source coords → appears LEFT on screen (after flip).
// Negative x  → toward nose in source coords → appears RIGHT on screen (nose side).
// Negative y  → above ground.
//
// Tune each constant until parts visually align with the fuselage reference.
const FUS_X   =    0;   // fuselage H-centre on container axis
const FUS_Y   = -200;   // fuselage V-centre from ground (gear height ≈ 130 → belly ≈ -136)

const WING_X   =   8,   WING_Y   = FUS_Y + 42;   // below mid-fuselage
const TAIL_X   = 148,   TAIL_Y   = FUS_Y - 24;   // rear top (vertical stabiliser)
const COCKPIT_X = -82,  COCKPIT_Y = FUS_Y - 2;   // forward cockpit overlay
const DOOR_X   =  52,   DOOR_Y   = FUS_Y + 10;   // cargo door on fuselage side
const ANTENNA_X =  30,  ANTENNA_Y = FUS_Y - 48;  // dorsal antenna

// Engine nacelles — below wing at forward area
const ENG_L_X  = -48,   ENG_L_Y  = FUS_Y + 68;  // near engine (front in z)
const ENG_R_X  = -30,   ENG_R_Y  = FUS_Y + 76;  // far engine (slightly lower = depth)

// Propellers — at the nose of each engine (engine half-width ≈ 107 px)
const PROP_L_X = ENG_L_X - 105,  PROP_L_Y = ENG_L_Y;
const PROP_R_X = ENG_R_X -  98,  PROP_R_Y = ENG_R_Y;

// Wing trailing-edge flaps
const FLAPS_X  = WING_X + 55,    FLAPS_Y  = WING_Y + 6;

// Gear — struts anchor at ground (setOrigin 0.5, 1.0)
const GEAR_REAR_X  =  28;   // main gear under wing
const GEAR_FRONT_X = -108;  // nose gear

// Gear belly-door — top-anchored at fuselage belly (setOrigin 0.5, 0.0)
const GEAR_DOOR_X  =  28,   GEAR_DOOR_Y = FUS_Y + 64;  // ≈ fuselage belly

// Effects
const LIGHTS_X =  FUS_X,   LIGHTS_Y  = FUS_Y;
const DAMAGE_X =  FUS_X,   DAMAGE_Y  = FUS_Y;
const OIL_X    =  FUS_X + 20, OIL_Y = FUS_Y + 28;
const SMOKE_X  =  ENG_L_X + 82, SMOKE_Y = ENG_L_Y - 8; // trails BEHIND engine (tail side)

// Propeller animation keys
const PROP_FRAMES: string[] = ['cp_prop_f1', 'cp_prop_f2', 'cp_prop_f3', 'cp_prop_f4'];

// ─────────────────────────────────────────────────────────────────────────────

export class AircraftSprite {
  /** Plane body container — set Y each frame for altitude. */
  readonly container: Phaser.GameObjects.Container;
  /** Ground-level shadow — keep at groundY; update alpha via updateShadow. */
  readonly shadowImg: Phaser.GameObjects.Image;

  // Layer references
  private wing!:      Phaser.GameObjects.Image;
  private flaps!:     Phaser.GameObjects.Image;
  private tail!:      Phaser.GameObjects.Image;
  private gearDoor!:  Phaser.GameObjects.Image;
  private gearRear!:  Phaser.GameObjects.Image;
  private gearFront!: Phaser.GameObjects.Image;
  private engR!:      Phaser.GameObjects.Image;
  private propR!:     Phaser.GameObjects.Image;
  private engL!:      Phaser.GameObjects.Image;
  private propL!:     Phaser.GameObjects.Image;
  private fuselage!:  Phaser.GameObjects.Image;
  private cockpit!:   Phaser.GameObjects.Image;
  private door!:      Phaser.GameObjects.Image;
  private antenna!:   Phaser.GameObjects.Image;
  private lights!:    Phaser.GameObjects.Image;
  private damageImg!: Phaser.GameObjects.Image;
  private oilLeak!:   Phaser.GameObjects.Image;
  private smoke!:     Phaser.GameObjects.Image;

  // ── Propeller state ──────────────────────────────────────────────────────
  private propSpeed = 0;    // 0 = stopped … 1 = full
  private propAccum = 0;    // frame accumulator
  private engineOn  = true;

  // ── Gear animation ───────────────────────────────────────────────────────
  private gearProgress  = 1.0;  // 1 = fully down, 0 = fully up
  private gearTargetDown = true;
  private readonly GEAR_SPEED = 0.014; // progress units per physics tick (1/60s)

  // ── Lights ───────────────────────────────────────────────────────────────
  private lightTimer = 0;
  private lightPhase = false; // beacon blink phase

  constructor(scene: Phaser.Scene, x: number, groundY: number) {
    // ── Shadow (scene-level, never inside container so it stays at ground) ──
    this.shadowImg = scene.add.image(x, groundY + 4, 'cp_shadow')
      .setOrigin(0.5, 0.5)
      .setAlpha(0.55)
      .setScale(SCALE);

    // ── Container — flipX via negative x-scale ───────────────────────────
    this.container = scene.add.container(x, groundY);
    this.container.setScale(-SCALE, SCALE);

    const img = (key: string, cx: number, cy: number,
                 ox = 0.5, oy = 0.5): Phaser.GameObjects.Image => {
      const i = scene.add.image(cx, cy, key).setOrigin(ox, oy);
      this.container.add(i);
      return i;
    };

    // ── Layers added back→front ───────────────────────────────────────────
    // 1  Wing
    this.wing     = img('cp_wing',       WING_X,      WING_Y);
    // 2  Flaps (trailing edge of wing)
    this.flaps    = img('cp_flaps_up',   FLAPS_X,     FLAPS_Y);
    // 3  Tail fin (behind fuselage where it blends)
    this.tail     = img('cp_tail',       TAIL_X,      TAIL_Y);
    // 4  Gear bay door (behind fuselage skin)
    this.gearDoor = img('cp_gear_closed', GEAR_DOOR_X, GEAR_DOOR_Y, 0.5, 0.0);
    // 5  Main gear strut (wheel at y=0)
    this.gearRear  = img('cp_gear_rear',  GEAR_REAR_X,  0, 0.5, 1.0);
    // 6  Nose gear strut
    this.gearFront = img('cp_gear_front', GEAR_FRONT_X, 0, 0.5, 1.0);
    // 7  Far engine (slightly transparent — depth cue)
    this.engR  = img('cp_engine_r', ENG_R_X, ENG_R_Y).setAlpha(0.78);
    // 8  Far propeller
    this.propR = img('cp_prop_f1',  PROP_R_X, PROP_R_Y).setAlpha(0.70);
    // 9  Near engine
    this.engL  = img('cp_engine_l', ENG_L_X, ENG_L_Y);
    // 10 Near propeller
    this.propL = img('cp_prop_l',   PROP_L_X, PROP_L_Y);
    // 11 Fuselage body
    this.fuselage = img('cp_fuselage', FUS_X, FUS_Y);
    // 12 Cockpit glass overlay
    this.cockpit  = img('cp_cockpit',    COCKPIT_X, COCKPIT_Y);
    // 13 Cargo door
    this.door     = img('cp_cargo_door', DOOR_X,    DOOR_Y);
    // 14 Dorsal antenna
    this.antenna  = img('cp_antenna',    ANTENNA_X, ANTENNA_Y);
    // 15 Navigation lights (blinks)
    this.lights   = img('cp_lights',     LIGHTS_X,  LIGHTS_Y).setAlpha(0);
    // 16 Damage overlay
    this.damageImg = img('cp_damage_0',  DAMAGE_X,  DAMAGE_Y).setAlpha(0);
    // 17 Oil-leak streak
    this.oilLeak  = img('cp_oil_leak',   OIL_X,     OIL_Y).setAlpha(0);
    // 18 Engine smoke (damage / overheat)
    this.smoke    = img('cp_smoke',      SMOKE_X,   SMOKE_Y).setAlpha(0);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  startEngine(): void { this.engineOn = true; }
  stopEngine(): void  { this.engineOn = false; }

  setGearDown(down: boolean): void { this.gearTargetDown = down; }

  /** Called every frame by FlightScene. dt = delta in seconds. */
  update(dt: number, state: FlightState): void {
    this.updatePropeller(dt, state.throttle);
    this.updateGear(dt, state);
    this.updateFlaps(state.flapsDeployed);
    this.updateDamage(state.integrity);
    this.updateLights(dt, state);
    this.updateSmoke(state);
    this.applyPitch(state.pitch);

    // Subtle ground-roll vibration
    if (state.altitude <= 0 && state.speed > 1) {
      this.container.y += Math.sin(state.elapsedSeconds * 22) * 0.35;
    }
  }

  /** Update shadow independently (called from FlightScene with groundY). */
  updateShadow(altitude: number): void {
    const t = Math.max(0, 1 - altitude / 320);
    this.shadowImg.setAlpha(t * 0.55);
    this.shadowImg.setScale(SCALE * (0.55 + t * 0.45));
  }

  destroy(): void {
    this.container.destroy();
    this.shadowImg.destroy();
  }

  // ── Private updaters ──────────────────────────────────────────────────────

  private updatePropeller(dt: number, throttle: number): void {
    // Spool RPM toward target
    const target = this.engineOn ? (0.10 + throttle * 0.90) : 0;
    const rate   = this.engineOn ? 0.018 : 0.008;
    this.propSpeed += (target - this.propSpeed) * rate;

    if (this.propSpeed < 0.015) {
      // Stationary — show static blade images
      this.propL.setTexture('cp_prop_l');
      this.propR.setTexture('cp_prop_r');
      return;
    }

    // Animate through the 4 pre-rendered frames
    const fps = 5 + this.propSpeed * 35;          // 5 fps idle → 40 fps full
    this.propAccum += dt * fps;
    const fi = Math.floor(this.propAccum) % 4;

    // At high speed show the most-blurred frame continuously
    const frame = this.propSpeed > 0.60 ? 'cp_prop_f1' : PROP_FRAMES[fi];
    this.propL.setTexture(frame);
    this.propR.setTexture(frame);
  }

  private updateGear(dt: number, state: FlightState): void {
    // Always show gear extended on the ground
    if (state.altitude <= 0) {
      this.gearTargetDown = true;
    }

    // Animate gear transit
    const dir = this.gearTargetDown ? 1 : -1;
    this.gearProgress = Phaser.Math.Clamp(
      this.gearProgress + dir * this.GEAR_SPEED * dt * 60,
      0, 1
    );

    const down = this.gearProgress > 0.85;
    const mid  = this.gearProgress > 0.15 && this.gearProgress <= 0.85;
    const up   = this.gearProgress <= 0.15;

    // Struts
    this.gearRear.setVisible(down);
    this.gearFront.setVisible(down);

    // Bay door
    if (down) this.gearDoor.setTexture('cp_gear_open');
    else if (mid) this.gearDoor.setTexture('cp_gear_mid');
    else if (up) this.gearDoor.setTexture('cp_gear_closed');
  }

  private updateFlaps(deployed: boolean): void {
    this.flaps.setTexture(deployed ? 'cp_flaps_down' : 'cp_flaps_up');
  }

  private updateDamage(integrity: number): void {
    if (integrity > 82) {
      this.damageImg.setAlpha(0);
      this.oilLeak.setAlpha(0);
      return;
    }
    this.damageImg.setAlpha(1);
    if      (integrity > 60) this.damageImg.setTexture('cp_damage_0');
    else if (integrity > 40) this.damageImg.setTexture('cp_damage_1');
    else if (integrity > 20) this.damageImg.setTexture('cp_damage_2');
    else                     this.damageImg.setTexture('cp_damage_3');

    // Oil streak starts at 50% integrity
    const oilT = Math.max(0, (50 - integrity) / 50);
    this.oilLeak.setAlpha(oilT * 0.75);
  }

  private updateLights(dt: number, state: FlightState): void {
    this.lightTimer += dt;
    if (this.lightTimer > 0.55) {
      this.lightTimer = 0;
      this.lightPhase = !this.lightPhase;
    }
    // Lights always on; beacon pulses, landing lights brighten on approach
    const base  = 0.5;
    const pulse = this.lightPhase ? 0.9 : base;
    const extra = (state.altitude < 200 && state.gearDown) ? 0.3 : 0;
    this.lights.setAlpha(Math.min(1, pulse + extra));
  }

  private updateSmoke(state: FlightState): void {
    const overheated = state.engineTemp > 0.86;
    const damaged    = state.integrity < 35;
    const alpha = (overheated || damaged) ? 0.55 : 0;
    this.smoke.setAlpha(alpha);
  }

  private applyPitch(pitch: number): void {
    // Positive pitch = nose up = visual counter-clockwise for right-facing plane.
    // With container setScale(-1,1), positive setRotation appears CCW visually.
    const clamped = Phaser.Math.Clamp(pitch, -30, 30);
    this.container.setRotation(Phaser.Math.DegToRad(clamped * 0.55));
  }
}
