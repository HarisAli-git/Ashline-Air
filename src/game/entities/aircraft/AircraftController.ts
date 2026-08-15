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
  stallDrop: 0.78,          // fraction of lift lost once fully stalled
  stallWidth: 11 * DEG,     // AoA past the critical angle to a full stall
  stallCD: 0.22,            // extra drag from a fully separated wing
  inducedK: 0.07,           // induced-drag factor (k·CL²)
  CD0: 0.105,               // parasitic drag — also sets max-speed thrust
  /**
   * A closed throttle is a huge speed brake, not a gentle one — a windmilling
   * propeller is a disc of drag roughly the size of the aeroplane.
   *
   * At 0.055 the model settled into a comfortable, permanent glide with the
   * engine dead: 93 km/h and −7.8 m/s, held for ever, with the wing still
   * carrying 95% of the aircraft's weight. That is why gravity read as
   * fictional. At 0.42 the aeroplane cannot hold itself up at all without
   * power: 130 → 56 km/h in six seconds, then it stalls and falls.
   *
   * The cubic falloff matters as much as the number. Scaled linearly, half
   * throttle still carried more braking drag than the airframe's own CD0 and
   * dragged the whole envelope down — level flight needed 85% power. Cubed,
   * the brake is savage at idle and gone by cruise, which is also the honest
   * reading: a prop under power makes thrust, not drag.
   */
  idleDragCD: 0.42,
  idleDragCurve: 3,
  flapsCL: 0.45,            // extra lift from flaps
  flapsCD: 0.028,           // and the drag that comes with it
  gearCD: 0.014,            // retractable gear hanging out
  groundEffect: 0.55,       // induced drag retained at zero height (float)
  /**
   * The thin-aerofoil curve is fiction past these incidences. Clamping keeps
   * the post-stall regime bounded — unclamped, a stall break ran the angle of
   * attack to 58°, where CL = CL0 + 5α means nothing at all.
   */
  alphaAeroMax: 42 * DEG,
  alphaAeroMin: -22 * DEG,

  // ── Pitch: a driven, damped, self-stabilising airframe ──
  controlPower: 78,         // elevator moment, deg/s² at cruise
  pitchStability: 3.4,      // restoring moment toward the trim ANGLE OF ATTACK
  /**
   * Fraction of that self-trimming authority that survives at zero thrust.
   *
   * With it at 1 the aeroplane flew itself into a tidy equilibrium whatever
   * the engine was doing — power off simply meant a different, equally stable
   * attitude, so there was never a moment of being out of control. At 0.10 the
   * airframe stops flying itself when the power comes off: the nose wanders,
   * the wing mushes into a stall and it falls, and you are a passenger until
   * the throttle goes back in (measured: ~4 s of full power to fly again).
   */
  stabIdle: 0.10,
  pitchDamping: 2.8,        // pitch-rate damping
  stallPitchDamp: 3.0,      // extra damping in the stall — stops porpoising
  stallNoseDown: 54,        // deg/s² nose-down once fully stalled
  maxPitchRate: 65,         // deg/s clamp
  pitchMin: -38,            // airborne nose-down limit; a stall break needs room
  /**
   * Pitch disturbance that grows as the aircraft slows below flying speed.
   * Down there it stops flying and starts wallowing: the controls go soft
   * (elevator authority already scales with dynamic pressure) and the nose
   * wanders on its own until power is restored.
   */
  wallow: 240,

  /**
   * Trim speed at idle, as a multiple of the stall speed. The trim slides
   * between this and cruise with the throttle — see the trim block in step().
   */
  trimLowFactor: 1.55,

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
  /** 0 = normal control, 1 = wallowing below flying speed. Read by the HUD. */
  controlSlack = 0;

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
      flightPathAngle: 0,
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
      modifiers: { fuelBurnMult: 1, dragMult: 1, liftMult: 1 },
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
    const aT = effThrottle * this.tMax * (1 - s.engineTemp * 0.3)
      * (1 - clamp(1 - s.integrity / 100, 0, 1) * 0.45);

    // ── Flight-path angle and angle of attack ─────────────────────────────
    // γ is integrated state, NOT re-derived from vertical speed: recomputing
    // atan2(vs, v) every frame quietly flattens the path as speed builds,
    // which caps dives and descents no matter how hard you push.
    if (onGround) s.flightPathAngle = 0;   // the wheels hold you on the runway
    const gamma = s.flightPathAngle;
    const alpha = clamp(s.pitch * DEG - gamma, TUNING.alphaAeroMin, TUNING.alphaAeroMax);

    // ── Wing: linear to the break, then a genuine collapse ────────────────
    const flapCL = s.flapsDeployed ? TUNING.flapsCL : 0;
    const clMax = TUNING.CLmax + flapCL;
    const alphaCrit = (clMax - TUNING.CL0 - flapCL) / TUNING.CLalpha;

    let stallT = 0;
    let CL: number;
    if (alpha <= alphaCrit) {
      CL = TUNING.CL0 + flapCL + TUNING.CLalpha * alpha;
    } else {
      // Past the critical ANGLE the wing gives up — this IS the stall, and it
      // is keyed off α rather than a runaway linear CL so the collapse is
      // bounded and the drag penalty below can be trusted.
      stallT = clamp((alpha - alphaCrit) / TUNING.stallWidth, 0, 1);
      CL = clMax * (1 - TUNING.stallDrop * stallT);
    }
    CL = clamp(CL, -1.0, clMax);
    this.stallIntensity = stallT;
    // How close the wing is to letting go — this is what the warning horn
    // should track, NOT raw airspeed. You can be slow and perfectly happy,
    // and you can stall at speed by hauling the nose up.
    this.stallMargin = clamp(1 - alpha / Math.max(0.01, alphaCrit), 0, 1);

    // Battle damage is not cosmetic: torn skin drags, a holed wing lifts
    // worse, and a knocked-about engine gives less power.
    const dmg = clamp(1 - s.integrity / 100, 0, 1);
    const dmgDrag = 1 + dmg * 1.3;
    const dmgLift = 1 - dmg * 0.35;

    const qK = this.K * s.speed * s.speed;   // ½ρV²S/m

    // Ground effect: induced drag falls away close to the runway, which is
    // what makes a flared aeroplane float instead of thumping down.
    const heightRatio = clamp(s.altitude / 12, 0, 1);
    const induced = TUNING.inducedK * CL * CL *
      (TUNING.groundEffect + (1 - TUNING.groundEffect) * heightRatio);

    let CD = TUNING.CD0 + induced;
    if (s.flapsDeployed) CD += TUNING.flapsCD;
    if (s.gearDown && !this.gearFixed) CD += TUNING.gearCD;
    CD += stallT * TUNING.stallCD;           // separated flow: nearly a barn door
    // A prop turning at idle is a disc of drag, not a free-wheeling fan. This
    // is most of what makes chopping the throttle actually slow you down.
    CD += TUNING.idleDragCD * Math.pow(1 - effThrottle, TUNING.idleDragCurve);

    const aL = qK * CL * dmgLift * s.modifiers.liftMult;   // lift acceleration
    const aD = qK * CD * s.modifiers.dragMult * dmgDrag;

    // ── Pitch: driven, damped, statically stable ──────────────────────────
    // Stability restores toward the TRIM ANGLE OF ATTACK — the α that would
    // hold level flight at this speed. That is real longitudinal stability:
    // hands off, the aeroplane settles into level flight by itself, and it
    // produces the phugoid for free.
    const rotateAt = this.vStall * TUNING.rotateSpeedFactor;
    const elevator = onGround ? clamp(s.speed / Math.max(1, rotateAt), 0, 1) : 1;
    const qNorm = clamp((s.speed / this.vCruise) ** 2, 0.1, 1.7);

    // Trim holds a SPEED, not an altitude — pitch sets airspeed, power sets
    // climb — and the trimmed speed FOLLOWS THE POWER LEVER.
    //
    // That second half matters as much as the first. A real pilot re-trims
    // when the power changes; with no trim wheel in the game the aeroplane has
    // to do it. Pinned at cruise regardless of throttle, the trim simply dived
    // to hold cruise speed no matter what: measured across the whole throttle
    // range, settled airspeed was 126–130 km/h at 0% AND at 100%. The lever
    // did nothing to speed, which is exactly the "reducing throttle doesn't
    // slow me down, even with the engine off" complaint. Sliding the trim
    // between a slow setting at idle and cruise at full power gives 92 km/h at
    // idle and 128 at full, with level flight around half throttle.
    const vTrimLow = this.vStall * TUNING.trimLowFactor;
    const vTrim = s.flapsDeployed
      ? vTrimLow                                   // configured for the approach
      : vTrimLow + (this.vCruise - vTrimLow) * effThrottle;
    const clForLevel = clamp(GRAVITY / (this.K * vTrim * vTrim), 0, clMax);
    const alphaTrim = clamp(
      (clForLevel - TUNING.CL0 - flapCL) / TUNING.CLalpha,
      -6 * DEG, alphaCrit,
    );

    // …and it trims onto the flight path THE CURRENT POWER CAN SUSTAIN, not
    // onto whatever path we happen to be on.
    //
    // This is the other half of "chop the throttle and come down". Trimming to
    // `gamma` gave the aeroplane no opinion about whether that path was
    // payable: with the engine at idle it kept trying to hold whatever it had,
    // pitched UP to chase the slower trim speed, and ballooned — measured as
    // five seconds of CLIMB after the throttle was closed, and only 65 m lost
    // in twenty seconds. Solving the sustainable angle from thrust minus drag
    // puts the nose down the instant the power comes off: 120 m in the same
    // twenty seconds, sinking from the first second.
    const qTrim = this.K * vTrim * vTrim;
    let cdTrim = TUNING.CD0 + TUNING.inducedK * clForLevel * clForLevel
      + TUNING.idleDragCD * Math.pow(1 - effThrottle, TUNING.idleDragCurve);
    if (s.flapsDeployed) cdTrim += TUNING.flapsCD;
    if (s.gearDown && !this.gearFixed) cdTrim += TUNING.gearCD;
    const gammaTrim = Math.asin(clamp((aT - qTrim * cdTrim) / GRAVITY, -0.62, 0.42));
    const pitchTrimDeg = onGround ? 0 : (gammaTrim + alphaTrim) / DEG;

    const command = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
    const controlMoment = command * TUNING.controlPower * qNorm * elevator;
    // Stability fades with power: with the engine dead the airframe largely
    // stops holding its own attitude, which is what turns "no thrust" into
    // "out of control" instead of "a different stable glide".
    const stabPower = TUNING.stabIdle + (1 - TUNING.stabIdle) * effThrottle;
    const stabilityMoment = (pitchTrimDeg - s.pitch) * TUNING.pitchStability * stabPower * qNorm;

    s.pitchRate += (controlMoment + stabilityMoment) * dt;
    // Extra damping while stalled: without it the aircraft porpoises between
    // +35° and −26° indefinitely instead of breaking and recovering.
    s.pitchRate *= Math.exp(-dt * (TUNING.pitchDamping + TUNING.stallPitchDamp * stallT));

    if (stallT > 0) {
      // A stalled wing drops its nose — that is how you recover
      s.pitchRate -= TUNING.stallNoseDown * stallT * dt;
      this.onBuffet?.(stallT);
    }

    // Below flying speed it wallows: the elevator has almost no dynamic
    // pressure to work with and the nose wanders on its own. You are a
    // passenger until you put the power back on.
    const slack = clamp(1 - s.speed / (this.vStall * 1.25), 0, 1);
    this.controlSlack = onGround ? 0 : slack;
    if (slack > 0 && !onGround) {
      s.pitchRate += (Math.random() - 0.5) * TUNING.wallow * slack * dt;
    }

    s.pitchRate = clamp(s.pitchRate, -TUNING.maxPitchRate, TUNING.maxPitchRate);
    s.pitch += s.pitchRate * dt;
    const lo = onGround ? -4 : TUNING.pitchMin;
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
        // Hand a matching flight path to the airborne integrator
        s.flightPathAngle = Math.atan2(s.verticalSpeed, Math.max(2, s.speed));
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
      const newGamma = clamp(gamma + gammaDot * dt, -1.35, 1.35);
      s.flightPathAngle = newGamma;

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
