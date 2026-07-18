import type { AircraftDefinition, FlightState } from '../../../types';
import { clamp } from '../../utils/math';
import { specFor } from './render/AircraftVisualSpec';

const GRAVITY = 9.81; // m/s²

/**
 * All feel-related constants in one place so balancing is a single-file job.
 *
 * Flight model philosophy (TU-46 style): the nose commands the flight path.
 * Pitch up and the velocity vector follows — climbing bleeds airspeed,
 * diving buys it back. No artificial climb-rate caps; energy is the limit.
 */
export const TUNING = {
  throttleRate: 0.9,        // throttle change per second of key held
  pitchRate: 44,            // degrees per second
  pitchAutoLevel: 4,        // 1/s exponential ground auto-level
  thrustTimeConstant: 5.5,  // seconds to ~63% of vMax at full throttle
  pathResponse: 5,          // 1/s — how fast the flight path follows the nose
  energyExchange: 0.9,      // fraction of gravity felt along the flight path
  maxSink: -38,             // m/s hard sink limit (terminal-ish dive)
  diveOverspeed: 1.15,      // dives may exceed vMax by this factor
  stallBand: 0.25,          // stall develops over this fraction below vStall
  stallNoseDownRate: 14,    // deg/s nose-drop at full stall
  flapsStallRelief: 0.85,   // flaps lower effective stall speed
  flapsDragFactor: 0.5,     // extra drag as a fraction of base kD
  rollingFriction: 0.35,    // m/s² while on the ground
  rotateSpeedFactor: 0.85,  // elevator has full authority at vStall × this
  tempHeatRate: 0.055,      // 1/s convergence while heating
  tempCoolRate: 0.11,       // 1/s convergence while cooling
  overspeedDamage: 3,       // integrity/s above 95% vMax
  gearDragDamage: 1.2,      // integrity/s with gear out well above stall speed
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

  // Per-aircraft coefficients, derived once from data stats (all speeds m/s)
  private readonly vMax: number;
  private readonly vCruise: number;
  private readonly vStall: number;
  private readonly tMax: number;   // full-throttle acceleration, m/s²
  private readonly kD: number;     // drag coefficient (equilibrium at vMax)
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

    const vStallEff = this.vStall * (s.flapsDeployed ? TUNING.flapsStallRelief : 1);

    // ── Controls ──────────────────────────────────────────────────────────
    if (input.throttleUp)   s.throttle = clamp(s.throttle + TUNING.throttleRate * dt, 0, 1);
    if (input.throttleDown) s.throttle = clamp(s.throttle - TUNING.throttleRate * dt, 0, 1);

    // On the runway the elevator only bites once there's airflow over it —
    // yanking the stick at parking speed does nothing (rotate ~stall speed).
    const rotateAt = vStallEff * TUNING.rotateSpeedFactor;
    const elevatorAuthority = onGround ? clamp(s.speed / Math.max(1, rotateAt), 0, 1) : 1;
    if (input.pitchUp)   s.pitch = clamp(s.pitch + TUNING.pitchRate * elevatorAuthority * dt, -30, 30);
    if (input.pitchDown) s.pitch = clamp(s.pitch - TUNING.pitchRate * elevatorAuthority * dt, -30, 30);
    if (onGround && !input.pitchUp && !input.pitchDown) {
      s.pitch += (0 - s.pitch) * (1 - Math.exp(-dt * TUNING.pitchAutoLevel));
    }

    const effThrottle = input.engineOn && s.fuel > 0 ? s.throttle : 0;

    // ── Stall factor (0 = clean, 1 = fully stalled) ───────────────────────
    const stallT = !onGround
      ? clamp((vStallEff - s.speed) / (TUNING.stallBand * vStallEff), 0, 1)
      : 0;

    // ── Thrust vs drag along the flight path ──────────────────────────────
    const thrust = effThrottle * this.tMax * (1 - s.engineTemp * 0.3);
    let drag = this.kD * s.speed * s.speed * s.modifiers.dragMult;
    if (s.flapsDeployed) drag += this.kD * TUNING.flapsDragFactor * s.speed * s.speed;
    const rolling = onGround && s.speed > 0 ? TUNING.rollingFriction : 0;

    // ── Flight path follows the nose (the TU-46 feel) ─────────────────────
    // Climb authority builds with airspeed above stall; a slow aircraft can
    // point up all it wants — it won't go up.
    const pitchRad = (s.pitch * Math.PI) / 180;
    const authority = clamp((s.speed - vStallEff * 0.8) / (vStallEff * 0.5), 0, 1);
    const gammaEff = pitchRad > 0
      ? pitchRad * authority * (1 - stallT)
      : pitchRad;
    let vsTarget = clamp(s.speed * Math.sin(gammaEff), TUNING.maxSink, 1000);
    // Ground effect: the air cushions the sink close to the runway, so a
    // flare genuinely arrests the descent instead of slamming through it.
    if (!onGround && s.altitude < 14 && vsTarget < 0) {
      vsTarget *= 0.45 + 0.55 * (s.altitude / 14);
    }
    s.verticalSpeed += (vsTarget - s.verticalSpeed) * (1 - Math.exp(-dt * TUNING.pathResponse));

    // Energy exchange: gravity acts along the actual flight path — climbing
    // bleeds airspeed, diving converts height back into speed.
    const gammaActual = Math.asin(clamp(s.verticalSpeed / Math.max(s.speed, 3), -1, 1));
    const gravityAlongPath = -GRAVITY * Math.sin(gammaActual) * TUNING.energyExchange;

    const vLimit = s.verticalSpeed < -4 ? this.vMax * TUNING.diveOverspeed : this.vMax;
    s.speed = clamp(s.speed + (thrust - drag - rolling + gravityAlongPath) * dt, 0, vLimit);

    // ── Stall behaviour: nose drops, buffet warns ─────────────────────────
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
