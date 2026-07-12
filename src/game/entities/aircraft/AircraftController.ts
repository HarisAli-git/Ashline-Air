import type { AircraftDefinition, FlightState } from '../../../types';
import { clamp } from '../../utils/math';
import { specFor } from './render/AircraftVisualSpec';

const GRAVITY = 9.81; // m/s²

/**
 * All feel-related constants in one place so balancing is a single-file job.
 * Aerodynamic coefficients themselves are derived per aircraft from its data
 * stats (see the constructor) so every airframe obeys the same equations.
 */
export const TUNING = {
  throttleRate: 0.6,        // throttle change per second of key held
  pitchRate: 40,            // degrees per second
  pitchAutoLevel: 4,        // 1/s exponential ground auto-level
  thrustTimeConstant: 8,    // seconds to ~63% of vMax at full throttle
  aoa0Deg: 3,               // built-in wing incidence
  cruisePitchDeg: 2,        // pitch needed for level flight at cruise speed
  vsLiftFactor: 1.2,        // (lift − g) → target vertical speed
  vsResponse: 2.5,          // 1/s convergence of vertical speed
  maxSink: -22,             // m/s hard sink limit
  climbHeadroom: 2,         // vsTarget cap = climbRate × this
  stallBand: 0.25,          // stall develops over this fraction below vStall
  stallLiftLoss: 0.8,       // lift multiplier lost at full stall
  stallNoseDownRate: 12,    // deg/s nose-drop at full stall
  flapsLift: 1.35,
  flapsStallRelief: 0.85,   // flaps lower effective stall speed
  flapsDragFactor: 0.5,     // extra drag as a fraction of base kD
  rollingFriction: 0.35,    // m/s² while on the ground
  tempHeatRate: 0.055,      // 1/s convergence while heating
  tempCoolRate: 0.11,       // 1/s convergence while cooling
  overspeedDamage: 3,       // integrity/s above 95% vMax
  gearDragDamage: 1.2,      // integrity/s with gear out well above stall speed
};

const STEP = 1 / 120;      // fixed physics step (s)
const MAX_FRAME_DT = 0.1;  // clamp huge frame gaps (tab switch etc.)
const MAX_SUBSTEPS = 12;

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

  // Per-aircraft coefficients, derived once from data stats (all speeds m/s)
  private readonly vMax: number;
  private readonly vCruise: number;
  private readonly vStall: number;
  private readonly tMax: number;   // full-throttle acceleration, m/s²
  private readonly kD: number;     // drag coefficient (equilibrium at vMax)
  private readonly kL: number;     // lift coefficient (level flight at cruise)
  private readonly gearLimit: number; // speed above which extended gear takes damage
  private readonly gearFixed: boolean; // fixed gear is built for it — no drag damage

  private accumulator = 0;

  /** Set by FlightScene: called with stall intensity 0–1 while buffeting. */
  onBuffet: ((intensity: number) => void) | null = null;
  /**
   * Set by FlightScene: fires at the exact substep the wheels meet the ground,
   * with the impact vertical speed and airspeed (before they get zeroed).
   */
  onTouchdown: ((verticalSpeed: number, speed: number) => void) | null = null;

  constructor(definition: AircraftDefinition) {
    this.def = definition;
    const s = definition.stats;
    this.vMax = s.maxSpeed / 3.6;
    this.vCruise = s.cruiseSpeed / 3.6;
    this.vStall = s.stallSpeed / 3.6;
    this.tMax = this.vMax / TUNING.thrustTimeConstant;
    this.kD = this.tMax / (this.vMax * this.vMax);
    const aoaRad = ((TUNING.aoa0Deg + TUNING.cruisePitchDeg) * Math.PI) / 180;
    this.kL = GRAVITY / (this.vCruise * this.vCruise * Math.sin(aoaRad));
    this.gearLimit = this.vStall * 1.6;
    this.gearFixed = specFor(definition.id).gear.fixed;
  }

  initialState(): FlightState {
    const { stats } = this.def;
    return {
      throttle: 0,
      pitch: 0,
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
    if (steps === MAX_SUBSTEPS) this.accumulator = 0; // shed backlog after a huge stall

    return next;
  }

  private step(s: FlightState, input: FlightInput, dt: number, windX: number): void {
    const { stats } = this.def;
    const onGround = s.altitude <= 0;

    // ── Controls ──────────────────────────────────────────────────────────
    if (input.throttleUp)   s.throttle = clamp(s.throttle + TUNING.throttleRate * dt, 0, 1);
    if (input.throttleDown) s.throttle = clamp(s.throttle - TUNING.throttleRate * dt, 0, 1);
    if (input.pitchUp)   s.pitch = clamp(s.pitch + TUNING.pitchRate * dt, -30, 30);
    if (input.pitchDown) s.pitch = clamp(s.pitch - TUNING.pitchRate * dt, -30, 30);
    if (onGround && !input.pitchUp && !input.pitchDown) {
      s.pitch += (0 - s.pitch) * (1 - Math.exp(-dt * TUNING.pitchAutoLevel));
    }

    const effThrottle = input.engineOn && s.fuel > 0 ? s.throttle : 0;

    // ── Stall factor (0 = clean, 1 = fully stalled) ───────────────────────
    const vStallEff = this.vStall * (s.flapsDeployed ? TUNING.flapsStallRelief : 1);
    const stallT = !onGround
      ? clamp((vStallEff - s.speed) / (TUNING.stallBand * vStallEff), 0, 1)
      : 0;

    // ── Horizontal: thrust vs drag ────────────────────────────────────────
    const thrust = effThrottle * this.tMax * (1 - s.engineTemp * 0.3);
    let drag = this.kD * s.speed * s.speed * s.modifiers.dragMult;
    if (s.flapsDeployed) drag += this.kD * TUNING.flapsDragFactor * s.speed * s.speed;
    const rolling = onGround && s.speed > 0 ? TUNING.rollingFriction : 0;
    s.speed = clamp(s.speed + (thrust - drag - rolling) * dt, 0, this.vMax);

    // ── Vertical: lift model with smooth stall ────────────────────────────
    const pitchRad = (s.pitch * Math.PI) / 180;
    const aoaRad = pitchRad + (TUNING.aoa0Deg * Math.PI) / 180;
    const flapMult = s.flapsDeployed ? TUNING.flapsLift : 1;
    const lift = this.kL * s.speed * s.speed * Math.sin(aoaRad) * flapMult * (1 - TUNING.stallLiftLoss * stallT);

    const vsTarget = clamp(
      (lift - GRAVITY) * TUNING.vsLiftFactor,
      TUNING.maxSink,
      stats.climbRate * TUNING.climbHeadroom,
    );
    s.verticalSpeed += (vsTarget - s.verticalSpeed) * (1 - Math.exp(-dt * TUNING.vsResponse));

    if (stallT > 0) {
      s.pitch = clamp(s.pitch - TUNING.stallNoseDownRate * stallT * dt, -30, 30);
      this.onBuffet?.(stallT);
    }

    const wasAirborne = s.altitude > 0;
    s.altitude = clamp(s.altitude + s.verticalSpeed * dt, 0, stats.maxAltitude);
    if (wasAirborne && s.altitude <= 0) {
      this.onTouchdown?.(s.verticalSpeed, s.speed);
    }
    if (s.altitude <= 0 && s.verticalSpeed < 0) s.verticalSpeed = 0; // resting on the ground

    // ── Ground speed / distance (wind acts on track, not airspeed) ────────
    s.groundSpeed = Math.max(0, s.speed + windX);
    s.distanceTravelled += (s.groundSpeed * dt) / 1000;

    // ── Fuel & engine temperature ─────────────────────────────────────────
    const burnPerSecond = (stats.fuelBurnRate * effThrottle * s.modifiers.fuelBurnMult) / 60;
    s.fuel = clamp(s.fuel - burnPerSecond * dt, 0, stats.fuelCapacity);

    const tempTarget = effThrottle * 0.9;
    const tempRate = tempTarget > s.engineTemp ? TUNING.tempHeatRate : TUNING.tempCoolRate;
    s.engineTemp += (tempTarget - s.engineTemp) * (1 - Math.exp(-dt * tempRate));
    s.engineTemp = clamp(s.engineTemp, 0, 1);

    // ── Structural stress ─────────────────────────────────────────────────
    if (s.speed > this.vMax * 0.95) {
      s.integrity = clamp(s.integrity - TUNING.overspeedDamage * dt, 0, 100);
    }
    if (!this.gearFixed && s.gearDown && !onGround && s.speed > this.gearLimit && s.altitude > 5) {
      s.integrity = clamp(s.integrity - TUNING.gearDragDamage * dt, 0, 100);
    }

    s.elapsedSeconds += dt;
  }
}
