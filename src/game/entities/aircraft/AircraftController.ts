import type { AircraftDefinition, FlightState } from '../../../types';
import { clamp } from '../../utils/math';
import { specFor } from './render/AircraftVisualSpec';

const GRAVITY = 9.81;          // m/s²
const DEG = Math.PI / 180;

/**
 * A real 2-D point-mass aerodynamic model.
 *
 * The aircraft is flown by FORCES, not by hand-written vertical-speed
 * targets. Lift, drag, thrust and weight act on the velocity vector:
 *
 *     dV/dt  = T·cos α − D − g·sin γ
 *     dγ/dt  = (L + T·sin α − g·cos γ) / V
 *
 * where γ is the flight-path angle and α = pitch − γ is the angle of attack.
 * Lift comes from a real CL(α) curve that stalls, drag has a parasitic and an
 * induced part, and weight is always pulling down.
 *
 * Everything that used to need a special case now falls out of the maths:
 * cutting the engine makes you glide down, holding the nose up too slow makes
 * you stall and drop, the aircraft leaves the runway at the exact moment lift
 * exceeds weight, and flaring near the ground trades speed for a soft
 * touchdown. No `authority` ramps, no `powerBalance` fudge, no vertical-speed
 * lag filters.
 */
export const TUNING = {
  throttleRate: 0.9,        // throttle change per second of key held

  // ── Wing ──
  CL0: 0.25,                // lift coefficient at zero angle of attack
  CLalpha: 5.0,             // lift-curve slope, per radian
  CLmax: 1.45,              // stall happens here
  stallDrop: 0.62,          // fraction of lift lost once fully stalled
  inducedK: 0.07,           // induced-drag factor (k·CL²)
  CD0: 0.075,               // parasitic drag — also sets max-speed thrust
  flapsCL: 0.45,            // extra lift from flaps
  flapsCD: 0.028,           // and the drag that comes with it
  gearCD: 0.014,            // retractable gear hanging out
  groundEffect: 0.55,       // induced drag retained at zero height (float)

  // ── Pitch: a driven, damped, self-stabilising airframe ──
  controlPower: 78,         // elevator moment, deg/s² at cruise
  pitchStability: 3.4,      // restoring moment toward the trim ANGLE OF ATTACK
  pitchDamping: 2.8,        // pitch-rate damping
  maxPitchRate: 65,         // deg/s clamp

  // ── Ground ──
  rollingFriction: 0.45,    // m/s² rolling resistance
  brakeFriction: 4.5,       // m/s² extra once rolling out after landing
  rotateSpeedFactor: 0.7,   // elevator bites from this fraction of stall speed

  // ── Systems ──
  tempHeatRate: 0.055,
  tempCoolRate: 0.11,
  overspeedDamage: 3,       // integrity/s above Vne
  gearDragDamage: 1.2,
  vneFactor: 1.05,          // never-exceed speed as a multiple of vMax
};

const STEP = 1 / 120;       // fixed physics step (s)
const MAX_FRAME_DT = 0.25;  // allows time warp up to ×8 at 30+ fps
const MAX_SUBSTEPS = 32;

// Controls input snapshot
export interface FlightInput {
  throttleUp: boolean;
  throttleDown: boolean;
  pitchUp: boolean;
  pitchDown: boolean;
  engineOn: boolean;
}

export class AircraftController {
  private readonly def: AircraftDefinition;

  // Speeds in m/s
  private readonly vMax: number;
  private readonly vCruise: number;
  private readonly vStall: number;

  /**
   * Lift/drag scale = ½ρS/m lumped into one constant, solved so that level
   * flight at the data-sheet stall speed needs exactly CLmax.
   */
  private readonly K: number;
  /** Full-throttle thrust acceleration, solved so level flight tops out at vMax. */
  private readonly tMax: number;
  private readonly gearFixed: boolean;

  private accumulator = 0;

  /** Set by FlightScene: called with stall intensity 0–1 while buffeting. */
  onBuffet: ((intensity: number) => void) | null = null;
  /** Fires at the substep the wheels meet the ground, with impact values. */
  onTouchdown: ((verticalSpeed: number, speed: number) => void) | null = null;
  /** True while the pilot is braking on the rollout. */
  braking = false;
  /** How stalled the wing actually is, 0–1. Read by the HUD. */
  stallIntensity = 0;
  /** Margin above the stall angle, 1 = plenty, 0 = about to let go. */
  stallMargin = 1;

  constructor(definition: AircraftDefinition) {
    this.def = definition;
    const s = definition.stats;
    this.vMax = s.maxSpeed / 3.6;
    this.vCruise = s.cruiseSpeed / 3.6;
    this.vStall = s.stallSpeed / 3.6;

    // Wing loading that makes the quoted stall speed true
    this.K = GRAVITY / (this.vStall * this.vStall * TUNING.CLmax);
    // Thrust that makes the quoted top speed true in level flight
    const clAtVmax = GRAVITY / (this.K * this.vMax * this.vMax);
    const cdAtVmax = TUNING.CD0 + TUNING.inducedK * clAtVmax * clAtVmax;
    this.tMax = this.K * this.vMax * this.vMax * cdAtVmax;

    this.gearFixed = specFor(definition.id).gear.fixed;
  }

  initialState(): FlightState {
    const { stats } = this.def;
    return {
      throttle: 0,
      pitch: 0,
      pitchRate: 0,
      speed: 0,
      groundSpeed: 0,
      altitude: 0,
      verticalSpeed: 0,
      heading: 0,
      fuel: stats.fuelCapacity,
      engineTemp: 0.2,
      integrity: 100,
      gearDown: true,
      flapsDeployed: false,
      distanceTravelled: 0,
      elapsedSeconds: 0,
      modifiers: { fuelBurnMult: 1, dragMult: 1 },
    };
  }

  /** Airspeed at which the wing will just carry the aircraft, for the HUD. */
  get stallSpeed(): number {
    return this.vStall;
  }

  /**
   * Frame-rate-independent integration: the real frame delta feeds a
   * fixed-step accumulator, so the sim advances identically at 30, 60 or
   * 144 Hz. windX is the along-track wind component in m/s (+ = tailwind).
   */
  update(state: FlightState, input: FlightInput, dtSeconds: number, windX = 0): FlightState {
    const next: FlightState = { ...state, modifiers: { ...state.modifiers } };

    this.accumulator += clamp(dtSeconds, 0, MAX_FRAME_DT);
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_SUBSTEPS) {
      this.step(next, input, STEP, windX);
      this.accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0; // shed backlog after a stall

    return next;
  }

  private step(s: FlightState, input: FlightInput, dt: number, windX: number): void {
    const { stats } = this.def;
    const onGround = s.altitude <= 0;

    // ── Throttle ──────────────────────────────────────────────────────────
    if (input.throttleUp)   s.throttle = clamp(s.throttle + TUNING.throttleRate * dt, 0, 1);
    if (input.throttleDown) s.throttle = clamp(s.throttle - TUNING.throttleRate * dt, 0, 1);
    const effThrottle = input.engineOn && s.fuel > 0 ? s.throttle : 0;
    const aT = effThrottle * this.tMax * (1 - s.engineTemp * 0.3);

    // ── Flight-path angle and angle of attack ─────────────────────────────
    // On the wheels the aircraft can only travel along the runway.
    const gamma = onGround ? 0 : Math.atan2(s.verticalSpeed, Math.max(2, s.speed));
    const alpha = s.pitch * DEG - gamma;

    // ── Wing: a real lift curve that stalls ───────────────────────────────
    const flapCL = s.flapsDeployed ? TUNING.flapsCL : 0;
    const clMax = TUNING.CLmax + flapCL;
    const clLinear = TUNING.CL0 + flapCL + TUNING.CLalpha * alpha;

    let stallT = 0;
    let CL = clLinear;
    if (clLinear > clMax) {
      // Past the critical angle the wing gives up — this IS the stall
      stallT = clamp((clLinear - clMax) / (clMax * 0.55), 0, 1);
      CL = clMax * (1 - TUNING.stallDrop * stallT);
    }
    CL = clamp(CL, -1.0, clMax);
    this.stallIntensity = stallT;
    // How close the wing is to letting go — this is what the warning horn
    // should track, NOT raw airspeed. You can be slow and perfectly happy,
    // and you can stall at speed by hauling the nose up.
    const alphaCrit = (clMax - TUNING.CL0 - flapCL) / TUNING.CLalpha;
    this.stallMargin = clamp(1 - alpha / Math.max(0.01, alphaCrit), 0, 1);

    const qK = this.K * s.speed * s.speed;   // ½ρV²S/m

    // Ground effect: induced drag falls away close to the runway, which is
    // what makes a flared aeroplane float instead of thumping down.
    const heightRatio = clamp(s.altitude / 12, 0, 1);
    const induced = TUNING.inducedK * CL * CL *
      (TUNING.groundEffect + (1 - TUNING.groundEffect) * heightRatio);

    let CD = TUNING.CD0 + induced;
    if (s.flapsDeployed) CD += TUNING.flapsCD;
    if (s.gearDown && !this.gearFixed) CD += TUNING.gearCD;
    CD += stallT * 0.09;                     // separated flow is draggy

    const aL = qK * CL;                      // lift acceleration
    const aD = qK * CD * s.modifiers.dragMult;

    // ── Pitch: driven, damped, statically stable ──────────────────────────
    // Stability restores toward the TRIM ANGLE OF ATTACK — the α that would
    // hold level flight at this speed. That is real longitudinal stability:
    // hands off, the aeroplane settles into level flight by itself, and it
    // produces the phugoid for free.
    const rotateAt = this.vStall * TUNING.rotateSpeedFactor;
    const elevator = onGround ? clamp(s.speed / Math.max(1, rotateAt), 0, 1) : 1;
    const qNorm = clamp((s.speed / this.vCruise) ** 2, 0.1, 1.7);

    // Trim holds a SPEED, not an altitude. This is the classic relationship —
    // pitch sets airspeed, power sets climb. Trimming for level flight at
    // whatever speed you happen to have makes the aeroplane fight to keep its
    // height with no engine, which is precisely the "it never comes down" bug.
    // Flaps out means you are configured for the approach, so it trims slower.
    const vTrim = s.flapsDeployed ? this.vStall * 1.35 : this.vCruise;
    const clForLevel = clamp(GRAVITY / (this.K * vTrim * vTrim), 0, clMax);
    const alphaTrim = clamp(
      (clForLevel - TUNING.CL0 - flapCL) / TUNING.CLalpha,
      -6 * DEG, (clMax - TUNING.CL0 - flapCL) / TUNING.CLalpha,
    );
    const pitchTrimDeg = onGround ? 0 : (gamma + alphaTrim) / DEG;

    const command = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
    const controlMoment = command * TUNING.controlPower * qNorm * elevator;
    const stabilityMoment = (pitchTrimDeg - s.pitch) * TUNING.pitchStability * qNorm;

    s.pitchRate += (controlMoment + stabilityMoment) * dt;
    s.pitchRate *= Math.exp(-dt * TUNING.pitchDamping);

    if (stallT > 0) {
      // A stalled wing drops its nose — that is how you recover
      s.pitchRate -= 26 * stallT * dt;
      this.onBuffet?.(stallT);
    }

    s.pitchRate = clamp(s.pitchRate, -TUNING.maxPitchRate, TUNING.maxPitchRate);
    s.pitch += s.pitchRate * dt;
    const lo = onGround ? -4 : -35;
    const hi = onGround ? 16 : 35;
    if (s.pitch < lo || s.pitch > hi) {
      s.pitch = clamp(s.pitch, lo, hi);
      s.pitchRate *= 0.2;
    }

    // ── Integrate the velocity vector ─────────────────────────────────────
    const vne = this.vMax * TUNING.vneFactor;

    if (onGround) {
      // Rolling: thrust against drag, friction and (after landing) brakes
      const friction = TUNING.rollingFriction + (this.braking ? TUNING.brakeFriction : 0);
      s.speed = clamp(s.speed + (aT - aD - friction) * dt, 0, vne);

      // The aeroplane leaves the ground the instant the wing carries it —
      // no special case, no scripted lift-off. Rotate, lift exceeds weight,
      // and the whole aircraft rises.
      if (aL > GRAVITY) {
        s.verticalSpeed += (aL - GRAVITY) * dt;
        s.altitude = Math.max(0, s.altitude + s.verticalSpeed * dt);
      } else {
        s.verticalSpeed = 0;
      }
    } else {
      // Along the flight path
      s.speed = clamp(
        s.speed + (aT * Math.cos(alpha) - aD - GRAVITY * Math.sin(gamma)) * dt,
        0, vne,
      );

      // Perpendicular to it — this is what curves the trajectory. If lift is
      // less than the weight component, the path bends downward. Always.
      const vSafe = Math.max(6, s.speed);
      const gammaDot = (aL + aT * Math.sin(alpha) - GRAVITY * Math.cos(gamma)) / vSafe;
      const newGamma = clamp(gamma + gammaDot * dt, -1.3, 1.3);

      s.verticalSpeed = s.speed * Math.sin(newGamma);
      const wasAirborne = s.altitude > 0;
      s.altitude = clamp(s.altitude + s.verticalSpeed * dt, 0, stats.maxAltitude);
      if (wasAirborne && s.altitude <= 0) {
        this.onTouchdown?.(s.verticalSpeed, s.speed);
        s.verticalSpeed = 0;
      }
    }

    // ── Ground track, fuel, temperature, stress ───────────────────────────
    s.groundSpeed = Math.max(0, s.speed * Math.cos(gamma) + windX);
    s.distanceTravelled += (s.groundSpeed * dt) / 1000;

    const burnPerSecond = (stats.fuelBurnRate * effThrottle * s.modifiers.fuelBurnMult) / 60;
    s.fuel = clamp(s.fuel - burnPerSecond * dt, 0, stats.fuelCapacity);

    const tempTarget = effThrottle * 0.9;
    const tempRate = tempTarget > s.engineTemp ? TUNING.tempHeatRate : TUNING.tempCoolRate;
    s.engineTemp = clamp(
      s.engineTemp + (tempTarget - s.engineTemp) * (1 - Math.exp(-dt * tempRate)), 0, 1,
    );

    if (s.speed > this.vMax * 0.97) {
      s.integrity = clamp(s.integrity - TUNING.overspeedDamage * dt, 0, 100);
    }
    if (!this.gearFixed && s.gearDown && !onGround && s.speed > this.vStall * 1.8) {
      s.integrity = clamp(s.integrity - TUNING.gearDragDamage * dt, 0, 100);
    }

    s.elapsedSeconds += dt;
  }
}
