import type { AircraftDefinition, FlightState } from '../../../types';
import { clamp } from '../../utils/math';
import { specFor } from './render/AircraftVisualSpec';

const GRAVITY = 9.81;          // m/s²
const DEG = Math.PI / 180;

/**
 * A 2-D point-mass aerodynamic model of a propeller aeroplane.
 *
 *     dV/dt  = T·cos α − D − W·sin γ − (on the ground) μ·(W − L)
 *     dγ/dt  = (L + T·sin α − W·cos γ) / V
 *
 * γ is the flight path, α = pitch − γ the angle of attack. Everything a pilot
 * feels comes out of these two lines and the curves that feed them, and
 * nothing is clamped to a rate:
 *
 *  - THRUST comes from engine POWER through a propeller, T = ηP/V. It is
 *    strongest standing still and falls away with speed, so a take-off roll
 *    accelerates hard and then less hard, and a climb is whatever power is
 *    left over after the drag is paid — fast near the best-climb speed, slow
 *    either side of it. There used to be a hard cap on the climb angle, which
 *    is why every climb was a ruler-straight line at exactly the data-sheet
 *    rate, all the way up.
 *  - The AIR thins exponentially with height and the engine loses power
 *    faster than the wing loses lift, so the climb tails off on its own as the
 *    ceiling approaches. There is no flame-out at the ceiling — real engines
 *    do not stop up there, the aeroplane simply will not go any higher.
 *  - FLAPS run on a motor through four notches. The first ones are mostly
 *    lift, the last one is mostly drag; each moves the stall speed, the
 *    attitude and the speed the aeroplane wants to fly at, and each has a
 *    limit speed above which the panels are being torn off the wing.
 *  - GROUND EFFECT is the real function of height over span: it only matters
 *    in the last couple of metres, which is where a too-fast flare floats.
 *  - On the ground the wheels carry only the weight the wing is not, so
 *    rolling drag and braking fade as the wing starts to fly.
 */
export const TUNING = {
  /**
   * How fast the LEVER moves, and how fast the ENGINE follows it. A piston
   * engine takes seconds to come up, so a recovery has to be STARTED early.
   */
  throttleRate: 0.55,       // lever travel per second of input held
  spoolUp: 2.4,             // seconds for the engine to chase the lever up
  spoolDown: 1.5,           // …and to come back down

  // ── Wing ──
  CL0: 0.25,                // lift coefficient at zero angle of attack
  CLalpha: 5.0,             // lift-curve slope, per radian
  CLmax: 1.45,              // clean
  /** The lift curve rounds over this many degrees before the peak, not a corner. */
  stallRound: 5 * DEG,
  stallDrop: 0.6,           // fraction of lift lost once fully stalled
  stallWidth: 11 * DEG,     // AoA past the peak to a full stall
  stallCD: 0.22,            // extra drag from a fully separated wing
  inducedK: 0.07,           // induced-drag factor (k·CL²), aspect ratio ~6
  alphaAeroMax: 42 * DEG,
  alphaAeroMin: -22 * DEG,

  // ── Flaps, as functions of how far down they are (0 = up, 1 = full) ──
  /** Lift at a given α: the first notches give most of it. */
  flapCL: 0.70,
  flapCLmax: 0.62,
  /** Drag grows with the square of deflection: the last notch is the air brake. */
  flapCD: 0.062,
  /** Degrees per second the flap motor drives. */
  flapRate: 6,

  // ── Propeller and engine ──
  /** Propeller efficiency at speed. */
  propEta: 0.8,
  /**
   * Below about twice the stall speed a fixed-pitch propeller is far from its
   * design point, which is what keeps static thrust to a third of the weight.
   */
  propRefStall: 2.3,
  /** Power follows the lever on a curve: a quarter throttle is well under a quarter of the power. */
  powerExp: 1.35,
  /** Normally aspirated: power drops faster than the air does. */
  thrustLapse: 1.3,
  /**
   * Drag of the propeller at idle (or windmilling with the engine off), as
   * CD, falling off with power.
   *
   * 0.022 for everything meant a power cut barely registered: from cruise,
   * holding height, an ATR took a full minute to come down to 1.7 × stall,
   * and the engine could be shut down and the aeroplane flown on its stored
   * speed for most of a kilometre a minute. A propeller at flight idle is a
   * disc of fine-pitch blades — on a turboprop it is the brake pilots slow
   * down with — so it is several times that, and a turboprop's much more.
   */
  idleDragPiston: 0.035,
  idleDragTurboprop: 0.065,
  /** Airbrake panels fully up: drag, lift spoiled in the air, lift dumped on the ground. */
  airbrakeCD: 0.055,
  airbrakeLift: 0.08,
  airbrakeGroundDump: 0.55,
  /** Seconds for the panels to travel all the way. */
  airbrakeTime: 0.8,
  /**
   * Fraction of the data-sheet climb rate the aeroplane actually achieves.
   *
   * 0.45 was faithful and miserable: the crop duster crawled up at 4–5 m/s
   * through the height band the guns cover, so the first minute of every
   * flight was spent being shot at on the way up. 0.62 still curves and still
   * fades with height, but you get off the ground and up out of the small
   * arms in a few seconds rather than half a minute.
   */
  climbFraction: 0.62,

  // ── Pitch: a driven, damped, statically stable airframe ──
  controlPower: 78,         // elevator moment, deg/s² at cruise dynamic pressure
  /**
   * Restoring moment per DEGREE of angle-of-attack error. Full stick settles
   * where control balances stability (αerr ≈ controlPower / pitchStability ≈
   * 12°), which clears the critical angle: you can stall it if you insist.
   */
  pitchStability: 6.5,
  /**
   * Fraction of static stability left at zero thrust. Stability comes from
   * the tailplane, not the engine — but propwash over it is part of the
   * elevator's bite, so the airframe gets looser as the power comes off.
   */
  stabIdle: 0.7,
  powerAuthorityLow: 0.15,
  powerAuthorityHigh: 0.52,
  /** Degrees of nose-down TRIM shift as power is lost (thrust line above the CG). */
  powerTrimShift: 1.6,
  /** Seconds for the trimmed speed to follow a change of POWER. */
  trimLag: 9,
  /**
   * The power-off glide path — see "The path a thrust deficit buys". The
   * slowing-down the trim asks for takes this long, and is never harder than
   * pathDecelMax (in g) when the power first goes, relaxing to pathDecelLate
   * over pathSettle seconds of deficit; the steepest the deficit may tip the
   * nose; how hard the path is chased (lift shed per radian off it) and the
   * most lift ever shed doing so.
   */
  pathSpeedLag: 8,
  pathDecelMax: 0.05,
  pathDecelLate: 0.2,
  pathSettle: 20,
  pathMaxDive: 10 * DEG,
  pathGain: 3,
  pathShedMax: 0.35,
  pitchDamping: 2.8,
  stallPitchDamp: 3.0,
  stallNoseDown: 54,        // deg/s² nose-down once fully stalled
  maxPitchRate: 65,
  pitchMin: -85,
  /** Pitch disturbance that grows as the aircraft slows below flying speed. */
  wallow: 240,

  // ── Ground ──
  /** Rolling friction coefficient on a dirt strip. */
  rollingMu: 0.04,
  /** Extra friction coefficient with the brakes on. */
  brakeMu: 0.36,

  // ── Systems ──
  /** Seconds to heat toward the target temperature, and to cool. */
  tempHeatTau: 60,
  tempCoolTau: 25,
  overspeedDamage: 3,       // integrity/s above Vne
  flapOverspeedDamage: 1.4, // integrity/s with flaps out above their limit speed
  gearDragDamage: 1.2,
  vneFactor: 1.05,          // never-exceed speed as a multiple of the data-sheet max
};

const STEP = 1 / 120;       // fixed physics step (s)
/*
 * Time warp ×8 on FlightScene's 50 ms frame cap is 0.4 s a frame. At 0.25 the
 * physics fell behind the world scroll below ~32 fps: the aeroplane covered a
 * quarter more ground than it flew, gliding and burning fuel at 80%.
 */
const MAX_FRAME_DT = 0.4;
const MAX_SUBSTEPS = 48;

/** Standard-atmosphere density ratio at a real height in metres. */
function isaSigma(realM: number): number {
  return Math.pow(Math.max(0.15, 1 - 2.25577e-5 * realM), 4.2559);
}

/**
 * Density ratio at a gameplay altitude. The vertical scale is compressed, so
 * each aircraft maps its own altitudes onto the real atmosphere — see
 * `altScale` in the controller. Without an aircraft, 8 real metres a metre.
 */
export function densityRatio(altitudeM: number, scale = 8): number {
  return isaSigma(altitudeM * scale);
}

/**
 * Wingspan and the height of the wing above the wheels, in metres. Ground
 * effect is a function of height over span, so the transport floats from
 * higher up than the crop duster does.
 */
const GEOMETRY: Record<string, { span: number; wingH: number; flapGain: number; takeoffFlap: number }> = {
  crop_duster: { span: 13, wingH: 1.4, flapGain: 1.0, takeoffFlap: 1 },
  // Full-span slotted flaps: the whole point of a bush aeroplane
  bush_plane: { span: 15, wingH: 2.3, flapGain: 1.4, takeoffFlap: 2 },
  regional_freighter: { span: 27, wingH: 4.2, flapGain: 1.1, takeoffFlap: 1 },
  // A tactical transport is built to get out of short, rough strips
  military_transport: { span: 40, wingH: 5.0, flapGain: 1.25, takeoffFlap: 2 },
};

export interface FlightInput {
  throttleUp: boolean;
  throttleDown: boolean;
  pitchUp: boolean;
  pitchDown: boolean;
  engineOn: boolean;
  /** The airbrake switch: out while true. */
  airbrake?: boolean;
}

export class AircraftController {
  private readonly def: AircraftDefinition;

  // Speeds in m/s (sea level, equivalent airspeed)
  readonly vMax: number;
  private readonly vCruise: number;
  readonly vStall: number;
  /** Full-power level-flight speed at sea level. The data-sheet max is a dive limit. */
  private readonly vTop: number;

  /** ½ρ₀S/m, solved so level flight at the stall speed needs exactly CLmax. */
  private readonly K: number;
  /** Parasitic drag, solved so the aeroplane climbs at its quoted rate. */
  private readonly CD0: number;
  /** Propeller drag at idle for this engine type — see TUNING. */
  private readonly idleDrag: number;
  /** Shaft power per kilogram at full throttle, sea level — solved from vTop. */
  private readonly pMax: number;
  /** Speed scale of the propeller's low-speed inefficiency. */
  private readonly vRef: number;
  /** Real metres of atmosphere per gameplay metre for THIS aircraft. */
  private readonly altScale: number;
  private readonly span: number;
  private readonly wingH: number;
  private readonly flapGain: number;
  /** Elevator authority from propeller slipstream over the tail, per unit power. */
  private readonly propwash: number;
  /** The flap notch this aircraft departs with. */
  readonly takeoffFlap: number;
  /** Flap deflection at each notch, degrees. */
  readonly flapStops: number[];
  private readonly flapMax: number;
  private readonly gearFixed: boolean;

  /** The speed the airframe is currently trimmed to fly at, EAS m/s. */
  private vTrim: number;
  /** Flap lift increment at the previous step (−1 before the first). */
  private lastFlapCL = -1;
  /** Seconds the power has been short of level flight — see the deficit path. */
  private deficitT = 0;

  private accumulator = 0;

  get hasRetractableGear(): boolean { return !this.gearFixed; }

  /** Set by FlightScene: called with stall intensity 0–1 while buffeting. */
  onBuffet: ((intensity: number) => void) | null = null;
  /** Fires at the substep the wheels meet the ground, with impact values. */
  onTouchdown: ((verticalSpeed: number, speed: number) => void) | null = null;
  /** True while the pilot is braking on the rollout. */
  braking = false;
  /** How stalled the wing actually is, 0–1. Read by the HUD. */
  stallIntensity = 0;
  /** Margin below the stall angle, 1 = plenty, 0 = about to let go. */
  stallMargin = 1;
  /** 0 = normal control, 1 = wallowing below flying speed. */
  controlSlack = 0;
  /** 1g stall speed in the current configuration and air, m/s true. */
  stallSpeedNow: number;
  /** Highest speed the flaps may be out at in their current position, m/s (Infinity when up). */
  flapLimit = Infinity;
  /** True while the flaps are out above their limit speed. */
  flapOverspeed = false;
  /** True while the airload is holding the flaps short of the selected notch. */
  flapBlownBack = false;
  /** Density ratio at the current altitude. */
  sigma = 1;
  /** Best climb rate available at this height, as a fraction of sea level. */
  climbReserve = 1;

  constructor(definition: AircraftDefinition) {
    this.def = definition;
    const s = definition.stats;
    this.vMax = s.maxSpeed / 3.6;
    this.vCruise = s.cruiseSpeed / 3.6;
    this.vStall = s.stallSpeed / 3.6;
    this.vTop = Math.min(this.vMax, this.vCruise * 1.12);
    this.K = GRAVITY / (this.vStall * this.vStall * TUNING.CLmax);

    const spec = specFor(definition.id);
    // A turboprop's constant-speed propeller keeps much more of its bite at
    // low speed than a fixed-pitch one on a radial does.
    this.vRef = this.vStall * TUNING.propRefStall * (spec.engineStyle === 'turboprop' ? 0.8 : 1);
    this.gearFixed = spec.gear.fixed;
    const geo = GEOMETRY[definition.id] ?? { span: 14, wingH: 2, flapGain: 1, takeoffFlap: 1 };
    this.span = geo.span;
    this.wingH = geo.wingH;
    this.flapGain = geo.flapGain;
    this.takeoffFlap = geo.takeoffFlap;
    // A nose engine blows straight over the tail; wing engines mostly miss it
    this.propwash = spec.engines.some(e => e.nose) ? 0.3 : 0.1;
    this.idleDrag = spec.engineStyle === 'turboprop' ? TUNING.idleDragTurboprop : TUNING.idleDragPiston;
    this.flapMax = spec.flap.maxDeflectDeg;
    this.flapStops = [0, Math.round(this.flapMax * 0.33), Math.round(this.flapMax * 0.6), this.flapMax];

    /*
     * Solve the airframe from the data sheet. Two numbers fix it: the top
     * speed sets the power (power required goes as V³), and the climb rate
     * sets how draggy the airframe is (a cleaner one needs less power for the
     * same top speed, so has less left over to climb with at low speed).
     */
    const target = s.climbRate * TUNING.climbFraction;
    let lo = 0.008, hi = 0.3;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.bestClimb(mid, this.powerForTop(mid), 1) > target) hi = mid; else lo = mid;
    }
    this.CD0 = (lo + hi) / 2;
    this.pMax = this.powerForTop(this.CD0);

    /*
     * And the ceiling. Find how much real atmosphere this aircraft's
     * gameplay metres stand for, such that at its quoted ceiling it can only
     * just climb. Below it the climb fades smoothly, the way it really does.
     */
    let a = 0.2, b = 80;
    for (let i = 0; i < 40; i++) {
      const mid = (a + b) / 2;
      if (this.bestClimb(this.CD0, this.pMax, isaSigma(s.maxAltitude * mid)) > 0.4) a = mid; else b = mid;
    }
    this.altScale = (a + b) / 2;

    this.vTrim = this.vStall * 1.45;
    this.stallSpeedNow = this.vStall;
  }

  // ── Solving the airframe ─────────────────────────────────────────────────

  /** Drag coefficient in clean 1g flight at true speed V. */
  private cdLevel(V: number, sigma: number, cd0: number): number {
    const cl = GRAVITY / (this.K * sigma * V * V);
    return cd0 + TUNING.inducedK * cl * cl;
  }

  /** Thrust per kilogram from shaft power P (W/kg) at true speed V. */
  private thrust(P: number, V: number): number {
    return (P * TUNING.propEta) / Math.sqrt(V * V + this.vRef * this.vRef);
  }

  /** Power that makes full-throttle level flight top out at vTop. */
  private powerForTop(cd0: number): number {
    const v = this.vTop;
    const drag = this.K * v * v * this.cdLevel(v, 1, cd0);
    return (drag * Math.sqrt(v * v + this.vRef * this.vRef)) / TUNING.propEta;
  }

  /** Best steady climb rate at full power in air of density ratio sigma. */
  private bestClimb(cd0: number, pMax: number, sigma: number): number {
    const P = pMax * Math.pow(sigma, TUNING.thrustLapse);
    const vLo = (this.vStall * 1.1) / Math.sqrt(sigma);
    const vHi = (this.vTop * 1.05) / Math.sqrt(sigma);
    let best = -Infinity;
    for (let i = 0; i <= 60; i++) {
      const V = vLo + ((vHi - vLo) * i) / 60;
      const T = this.thrust(P, V);
      const D = this.K * sigma * V * V * this.cdLevel(V, sigma, cd0);
      best = Math.max(best, ((T - D) * V) / GRAVITY);
    }
    return best;
  }

  /**
   * How much of the idle propeller drag is there at this power: all of it at
   * idle, none above half power. A propeller only turns into a brake once
   * the power is nearly off; letting it linger into cruise power just made
   * every aeroplane slower and thirstier in level flight.
   */
  private idleShare(power: number): number {
    const k = Math.max(0, 1 - power / 0.5);
    return k * k;
  }

  /** Density ratio at a gameplay altitude, for this aircraft. */
  sigmaAt(altitudeM: number): number {
    return isaSigma(Math.max(0, altitudeM) * this.altScale);
  }

  /** Flap increments at a fraction of full deflection. */
  private flapTerms(f: number): { dCL: number; dCLmax: number; dCD: number } {
    const lift = Math.sin(clamp(f, 0, 1) * Math.PI / 2) * this.flapGain;
    return {
      dCL: TUNING.flapCL * lift,
      dCLmax: TUNING.flapCLmax * lift,
      dCD: TUNING.flapCD * f * f + 0.006 * f,
    };
  }

  /** Limit speed for flaps at fraction f, EAS m/s. */
  private vfe(f: number): number {
    return f < 0.02 ? Infinity : this.vStall * (2.4 - 0.95 * f);
  }

  /** Limit speed for the flaps at a given notch, m/s — for the HUD. */
  flapLimitAt(stage: number): number {
    return this.vfe(this.flapStops[clamp(Math.round(stage), 0, 3)] / this.flapMax);
  }

  // ── State ────────────────────────────────────────────────────────────────

  initialState(): FlightState {
    const { stats } = this.def;
    this.vTrim = this.vStall * 1.45;
    this.lastFlapCL = -1;
    this.deficitT = 0;
    return {
      throttle: 0,
      enginePower: 0,
      loadFactor: 1,
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
      flapStage: 0,
      flapAngle: 0,
      distanceTravelled: 0,
      elapsedSeconds: 0,
      modifiers: { fuelBurnMult: 1, dragMult: 1, liftMult: 1, stabilityMult: 1 },
      airbrake: 0,
    };
  }

  /** Clean 1g stall speed at sea level, m/s. */
  get stallSpeed(): number {
    return this.vStall;
  }

  /**
   * Frame-rate-independent integration: the real frame delta feeds a
   * fixed-step accumulator, so the sim advances identically at 30, 60 or
   * 144 Hz. windX is the along-track wind component in m/s (+ = tailwind).
   */
  update(
    state: FlightState, input: FlightInput, dtSeconds: number,
    windX = 0, windUp = 0,
  ): FlightState {
    const next: FlightState = { ...state, modifiers: { ...state.modifiers } };
    this.accumulator += clamp(dtSeconds, 0, MAX_FRAME_DT);
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_SUBSTEPS) {
      this.step(next, input, STEP, windX, windUp);
      this.accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    return next;
  }

  private step(
    s: FlightState, input: FlightInput, dt: number, windX: number, windUp = 0,
  ): void {
    const { stats } = this.def;
    const onGround = s.altitude <= 0;

    // ── Throttle and engine ───────────────────────────────────────────────
    if (input.throttleUp)   s.throttle = clamp(s.throttle + TUNING.throttleRate * dt, 0, 1);
    if (input.throttleDown) s.throttle = clamp(s.throttle - TUNING.throttleRate * dt, 0, 1);
    const lever = input.engineOn && s.fuel > 0 ? s.throttle : 0;
    const tau = lever > s.enginePower ? TUNING.spoolUp : TUNING.spoolDown;
    s.enginePower += (lever - s.enginePower) * (1 - Math.exp(-dt / tau));
    const effThrottle = s.enginePower;

    // ── Airbrakes: the panels follow the switch on their own motor ────────
    {
      const want = input.airbrake ? 1 : 0;
      const now = s.airbrake ?? 0;
      s.airbrake = now + clamp(want - now, -dt / TUNING.airbrakeTime, dt / TUNING.airbrakeTime);
    }
    const brakeF = s.airbrake;

    const sigma = this.sigmaAt(s.altitude);
    this.sigma = sigma;
    const sqrtSigma = Math.sqrt(sigma);
    const vEAS = s.speed * sqrtSigma;

    // ── Flaps: the motor drives the panels toward the lever ───────────────
    const stage = clamp(Math.round(s.flapStage ?? (s.flapsDeployed ? 2 : 0)), 0, 3);
    s.flapStage = stage;
    /*
     * Load relief: above their limit speed the airload blows the panels back,
     * so they only come out as far as the speed allows and follow the speed
     * down as it falls. Without it, dropping full flap at cruise put five
     * times the aeroplane's weight of lift on the wing at once and it
     * ballooned two hundred metres. Selecting flap early is now just early.
     */
    const fAllowed = clamp((2.4 - vEAS / this.vStall) / 0.95, 0, 1);
    const flapTarget = onGround ? this.flapStops[stage] : Math.min(this.flapStops[stage], fAllowed * this.flapMax);
    this.flapBlownBack = !onGround && this.flapStops[stage] > fAllowed * this.flapMax + 0.5;
    const flapNow = s.flapAngle ?? 0;
    const flapStep = TUNING.flapRate * dt;
    s.flapAngle = Math.abs(flapTarget - flapNow) <= flapStep ? flapTarget : flapNow + Math.sign(flapTarget - flapNow) * flapStep;
    s.flapsDeployed = s.flapAngle > 0.5;
    const flapF = s.flapAngle / this.flapMax;
    const flap = this.flapTerms(flapF);
    /*
     * As the panels move the nose settles to the attitude that makes the same
     * lift with the new camber, as a pilot following it
     * would. Without this every notch was a balloon: the extra lift arrived
     * at the old attitude and the aeroplane went up fifty metres before its
     * stability caught up. It is tied to the flap MOTOR, so it is a few
     * degrees over a few seconds, never a jump.
     */
    if (!onGround && this.lastFlapCL >= 0) {
      const dCLstep = flap.dCL - this.lastFlapCL;
      if (dCLstep !== 0) s.pitch -= (dCLstep / TUNING.CLalpha) / DEG;
    }
    this.lastFlapCL = flap.dCL;

    // ── Engine power, through the propeller ───────────────────────────────
    // Hot cylinders detonate and lose power before anything breaks.
    const heatLoss = 1 - 0.25 * clamp((s.engineTemp - 0.9) / 0.1, 0, 1);
    const dmg = clamp(1 - s.integrity / 100, 0, 1);
    const power = this.pMax * Math.pow(effThrottle, TUNING.powerExp)
      * Math.pow(sigma, TUNING.thrustLapse) * heatLoss * (1 - dmg * 0.45);
    const aT = this.thrust(power, Math.max(0, s.speed));

    // ── Flight-path angle and angle of attack ─────────────────────────────
    if (onGround) s.flightPathAngle = 0;
    const gamma = s.flightPathAngle;
    const alpha = clamp(s.pitch * DEG - gamma, TUNING.alphaAeroMin, TUNING.alphaAeroMax);

    // ── Wing: linear, rounding over into the stall, then a collapse ───────
    const hWing = Math.max(0, s.altitude) + this.wingH;
    const ge = (16 * hWing) / this.span;
    const geFactor = (ge * ge) / (1 + ge * ge);            // 1 = free air
    const clAlpha = TUNING.CLalpha * (1 + 0.1 * (1 - geFactor));
    const clMax = TUNING.CLmax + flap.dCLmax;
    const clBase = TUNING.CL0 + flap.dCL;
    // Where the straight line would reach clMax, and the rounded peak past it
    const alphaLin = (clMax - clBase) / clAlpha;
    const round = TUNING.stallRound;
    const alphaKnee = alphaLin - round / 2;
    const alphaPeak = alphaLin + round / 2;
    let CL: number;
    let stallT = 0;
    if (alpha <= alphaKnee) {
      CL = clBase + clAlpha * alpha;
    } else if (alpha <= alphaPeak) {
      const d = alphaPeak - alpha;
      CL = clMax - (clAlpha / (2 * round)) * d * d;
    } else {
      stallT = clamp((alpha - alphaPeak) / TUNING.stallWidth, 0, 1);
      const sm = stallT * stallT * (3 - 2 * stallT);
      CL = clMax * (1 - TUNING.stallDrop * sm);
    }
    CL = clamp(CL, -1.0, clMax);
    // On the brakes the nose is held down onto the runway, which dumps most of
    // the wing's lift onto the wheels — otherwise full flap at touchdown speed
    // still carries the aeroplane and the brakes have nothing to bite with.
    if (onGround && this.braking) CL *= 0.45;
    // Airbrakes on the ground are lift dumpers: weight onto the wheels
    if (onGround) CL *= 1 - TUNING.airbrakeGroundDump * brakeF;
    this.stallIntensity = stallT;
    this.stallMargin = clamp((alphaPeak - alpha) / Math.max(0.01, alphaPeak), 0, 1);

    const dmgDrag = 1 + dmg * 1.3;
    const dmgLift = 1 - dmg * 0.35;
    // Up in the air the panels spoil a little of the wing as well
    const liftK = dmgLift * s.modifiers.liftMult * (onGround ? 1 : 1 - TUNING.airbrakeLift * brakeF);

    // 1g stall speed in this configuration, for the HUD
    this.stallSpeedNow = Math.sqrt(GRAVITY / (this.K * clMax * Math.max(0.2, liftK))) / sqrtSigma;

    const qK = this.K * sigma * s.speed * s.speed;          // ½ρV²S/m
    const induced = TUNING.inducedK * CL * CL * geFactor;
    let CD = this.CD0 + induced + flap.dCD;
    if (s.gearDown && !this.gearFixed) CD += 0.014;
    CD += stallT * TUNING.stallCD;
    // A windmilling prop at idle is a disc of drag; under power it makes thrust.
    CD += this.idleDrag * this.idleShare(effThrottle);
    CD += TUNING.airbrakeCD * brakeF;

    const aL = qK * CL * liftK;
    s.loadFactor = onGround ? 1 : clamp(aL / GRAVITY, -1.5, 6);
    const aD = qK * CD * s.modifiers.dragMult * dmgDrag;

    // ── Trim: the speed the airframe wants to fly at ──────────────────────
    //
    // Clean, it follows the power — level flight at the speed the engine can
    // hold. With flaps out it is the approach speed for that flap setting,
    // whatever the power: on an approach, power controls the descent and the
    // nose holds the speed, which is how a landing is actually flown. It
    // follows with a lag, so a change of power is first a climb or a sink
    // and only then a change of speed.
    const vsCfg = Math.sqrt(GRAVITY / (this.K * clMax));    // EAS
    const vsClean = this.vStall;
    const vClimb = vsClean * 1.45;
    const flapBlend = clamp(flapF * 1.6, 0, 1);
    // The speed the CURRENT POWER can actually hold level, near enough
    let vSus = this.vCruise;
    {
      const cdT = this.CD0 + TUNING.inducedK * 0.3 + this.idleDrag * this.idleShare(effThrottle)
        + (s.gearDown && !this.gearFixed ? 0.014 : 0) + TUNING.airbrakeCD * brakeF;
      for (let i = 0; i < 4; i++) {
        const t = this.thrust(power, Math.max(1, vSus / sqrtSigma));
        vSus = Math.sqrt(Math.max(0, t) / Math.max(1e-5, this.K * cdT));
      }
    }
    /*
     * The POWER half of the trim drifts slowly. Pull the power off and the
     * nose drops and the aeroplane goes DOWN at roughly the speed it was
     * flying; it only settles back toward a slower glide over the next ten
     * seconds or so. With a quick drift it did the opposite — held its height
     * for twenty seconds while the speed bled away, which is the "holding
     * altitude like it is still in cruise" that made every approach float.
     */
    const powerTarget = clamp(
      Math.min(vClimb + (this.vCruise - vClimb) * effThrottle, vSus * 1.12), vClimb, this.vCruise * 1.1,
    );
    this.vTrim += (powerTarget - this.vTrim) * (1 - Math.exp(-dt / TUNING.trimLag));
    // The FLAP half acts as the panels move: flaps out, and the aeroplane is
    // trimmed for the approach speed of that setting.
    const vApp = vsCfg * 1.3;
    const vFloor = vsCfg * (1.25 + 0.2 * (1 - flapBlend));
    const vTrimNow = Math.max(vFloor, this.vTrim + (vApp - this.vTrim) * flapBlend);
    /*
     * ── The path a thrust deficit buys ──────────────────────────────────
     *
     * Cut the engine and the aeroplane held its height for five to ten
     * seconds — the ATR actually gained a few metres — while drag ate the
     * speed: the round-out below asked for level lift the moment the path
     * dipped, so every bit of missing thrust went into slowing down level.
     * An engine cut read as nothing happening at all.
     *
     * Now, when the power cannot pay for the drag at the speed the trim is
     * heading for, the shortfall becomes a descent: the path along which the
     * aeroplane slows only as fast as the trim wants, never steeper than
     * pathMaxDive. With power to spare it is level and nothing changes.
     * Clean only — flaps out is the approach, which has its own rules below —
     * and fading out from 60 m to 15 m, so a forced landing rounds out the way
     * a pilot would and the flare is never pushed into the runway.
     */
    // Only ever a slowing-down: speeding up toward the trim is the trim's own
    // job, and asking for it here pushed the nose over in every climb.
    // At full power the anti-balloon cap below holds it level FASTER than its
    // trim, so the slowing-down is capped too — or it would soak up the whole
    // deficit and the cut would be a level deceleration again. Tightly at
    // first, so the nose goes down; then easing, so the speed comes back to
    // a glide. Held fast all the way down, a heavy arrived at 300 km/h with
    // nothing left to flare with.
    const excessDrag = (aT * Math.cos(alpha) - aD) / GRAVITY;
    this.deficitT = excessDrag < -0.02 && !onGround
      ? this.deficitT + dt : Math.max(0, this.deficitT - 2 * dt);
    const decelCap = TUNING.pathDecelMax
      + (TUNING.pathDecelLate - TUNING.pathDecelMax) * clamp(this.deficitT / TUNING.pathSettle, 0, 1);
    const wantAccel = clamp(
      (vTrimNow / sqrtSigma - s.speed) / TUNING.pathSpeedLag, -decelCap * GRAVITY, 0,
    );
    const shortfall = excessDrag - wantAccel / GRAVITY;
    const pathGate = (1 - flapBlend) * clamp((s.altitude - 15) / 45, 0, 1);
    const gammaPath = onGround ? 0
      : Math.max(-TUNING.pathMaxDive, Math.asin(clamp(shortfall, -1, 0))) * pathGate;
    /*
     * The trim may ask for less lift than level flight needs (to speed up, it
     * dives) but never MORE than level flight at the current speed needs.
     *
     * Without that cap, slowing down — less power, or flap out — swung the
     * trimmed speed below the airspeed and the nose came up to bleed the
     * difference off by climbing: fifty to two hundred and fifty metres of
     * balloon, then a dive back through it, then another climb. That porpoise
     * was the approach testers could not land from. Capped, the aeroplane
     * holds its height while drag slows it, and the nose-down trim that
     * comes with taking the power off (powerTrimShift) still starts the
     * descent at once.
     */
    // (Descending, it may still ask for more — enough to round out of the
    // dive back toward level, never enough to climb. Short of power, it
    // rounds out onto the deficit path instead, and sheds lift to reach it.)
    const clTrim = clamp(GRAVITY / (this.K * vTrimNow * vTrimNow), 0, clMax);
    const clLevelNow = (GRAVITY * Math.cos(gamma)) / (this.K * Math.max(1, vEAS) ** 2);
    const pushOver = gammaPath < 0
      ? clamp(TUNING.pathGain * (gamma - gammaPath), 0, TUNING.pathShedMax) : 0;
    const clForLevel = Math.min(clTrim, clLevelNow * (1 + 2.6 * Math.max(0, gammaPath - gamma)))
      * (1 - pushOver);
    // Down to -12°: a big slotted flap at speed needs a nose-down wing to make
    // only the lift it needs, and at -3° the trim fought that and ballooned.
    const alphaTrim = clamp((clForLevel - clBase) / clAlpha, -12 * DEG, alphaKnee);

    // ── Pitch: driven, damped, statically stable on ANGLE OF ATTACK ───────
    // Elevator authority on the ground needs airflow over the tail.
    const elevator = onGround ? clamp((s.speed - this.vStall * 0.5) / (this.vStall * 0.6), 0, 1) : 1;
    // Dynamic pressure at the TAIL: the free stream, plus the slipstream the
    // propeller throws over it. That slipstream is why a single can lift its
    // tail and rotate at a walking pace with full power on, and why the
    // elevator goes soft when the power comes off on short final.
    const qFree = (vEAS / this.vCruise) ** 2;
    const qNorm = clamp(qFree + this.propwash * effThrottle * (1 - clamp(qFree, 0, 1)), 0.08, 1.7);
    const command = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
    const controlMoment = command * TUNING.controlPower * qNorm * elevator;

    const powerAuthority = clamp(
      (effThrottle - TUNING.powerAuthorityLow)
        / (TUNING.powerAuthorityHigh - TUNING.powerAuthorityLow), 0, 1,
    ) ** 2;
    const stabPower = (TUNING.stabIdle + (1 - TUNING.stabIdle) * powerAuthority) * s.modifiers.stabilityMult;
    // Taking the power off sheds a FRACTION of the lift, not a fixed angle: a
    // fixed degree and a half is nothing at approach speed and a steep dive at
    // cruise, where the wing is flying on a sliver of its lift range.
    const alphaTrimEff = alphaTrim
      - (clForLevel * TUNING.powerTrimShift * 0.09 * (1 - powerAuthority)) / clAlpha;
    const alphaErrDeg = (alpha - alphaTrimEff) / DEG;
    const stabilityMoment = onGround
      ? -s.pitch * TUNING.pitchStability * qNorm
      : -alphaErrDeg * TUNING.pitchStability * stabPower * qNorm;

    s.pitchRate += (controlMoment + stabilityMoment) * dt;
    s.pitchRate *= Math.exp(-dt * (TUNING.pitchDamping + TUNING.stallPitchDamp * stallT));
    if (stallT > 0) {
      s.pitchRate -= TUNING.stallNoseDown * stallT * dt;
      this.onBuffet?.(stallT);
    }
    const slack = clamp(1 - s.speed / (this.stallSpeedNow * 1.2), 0, 1);
    this.controlSlack = onGround ? 0 : slack;
    if (slack > 0 && !onGround) s.pitchRate += (Math.random() - 0.5) * TUNING.wallow * slack * dt;

    s.pitchRate = clamp(s.pitchRate, -TUNING.maxPitchRate, TUNING.maxPitchRate);
    s.pitch += s.pitchRate * dt;
    const lo = onGround ? -4 : TUNING.pitchMin;
    const hi = onGround ? 16 : 48;
    if (s.pitch < lo || s.pitch > hi) {
      s.pitch = clamp(s.pitch, lo, hi);
      s.pitchRate *= 0.2;
    }

    // ── Integrate the velocity vector ─────────────────────────────────────
    const vne = this.vMax * TUNING.vneFactor;
    if (onGround) {
      // The wheels carry what the wing does not, so the drag of the roll and
      // the bite of the brakes both fade as the wing starts to fly.
      const onWheels = Math.max(0, GRAVITY - aL - aT * Math.sin(s.pitch * DEG));
      const mu = TUNING.rollingMu + (this.braking ? TUNING.brakeMu : 0);
      const friction = s.speed > 0.05 ? mu * onWheels : 0;
      s.speed = clamp(s.speed + (aT * Math.cos(alpha) - aD - friction) * dt, 0, vne);

      // Lift-off: the wing carries the weight AND the speed is there to fly
      // away at, not merely to bounce into the air and settle back.
      const vRotate = this.stallSpeedNow * 1.08;
      if (aL > GRAVITY && s.speed >= vRotate) {
        s.verticalSpeed += (aL - GRAVITY) * dt;
        s.altitude = Math.max(0, s.altitude + s.verticalSpeed * dt);
        s.flightPathAngle = Math.atan2(s.verticalSpeed, Math.max(2, s.speed));
      } else {
        s.verticalSpeed = 0;
      }
    } else {
      s.speed = clamp(s.speed + (aT * Math.cos(alpha) - aD - GRAVITY * Math.sin(gamma)) * dt, 0, vne);
      const vSafe = Math.max(6, s.speed);
      const gammaDot = (aL + aT * Math.sin(alpha) - GRAVITY * Math.cos(gamma)) / vSafe;
      const newGamma = clamp(gamma + gammaDot * dt, -1.45, 1.45);
      s.flightPathAngle = newGamma;
      // The aeroplane flies through the AIR; the air itself may be rising.
      s.verticalSpeed = s.speed * Math.sin(newGamma) + windUp;
      const wasAirborne = s.altitude > 0;
      s.altitude = clamp(s.altitude + s.verticalSpeed * dt, 0, stats.maxAltitude * 1.4);
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

    /*
     * Heat follows power, and AIRFLOW carries it away. A long full-power
     * climb at low speed is what cooks an engine; cruise at three-quarters
     * power with the air rushing through the cowl does not. Thin air cools
     * worse, so the same power runs hotter up high.
     */
    const flow = clamp(vEAS / this.vCruise, 0, 1.3);
    const tempTarget = clamp(
      0.2 + 0.72 * Math.pow(effThrottle, 1.4) - 0.24 * flow + (1 - sigma) * 0.3, 0.05, 1,
    );
    const tTau = tempTarget > s.engineTemp ? TUNING.tempHeatTau : TUNING.tempCoolTau;
    s.engineTemp = clamp(s.engineTemp + (tempTarget - s.engineTemp) * (1 - Math.exp(-dt / tTau)), 0, 1);

    if (s.speed > this.vMax * 0.97) {
      s.integrity = clamp(s.integrity - TUNING.overspeedDamage * dt, 0, 100);
    }
    this.flapLimit = this.vfe(flapF);
    // Only if they are out faster than the motor can blow them back
    this.flapOverspeed = !onGround && vEAS > this.flapLimit * 1.12;
    if (this.flapOverspeed) {
      s.integrity = clamp(s.integrity - TUNING.flapOverspeedDamage * dt, 0, 100);
    }
    if (!this.gearFixed && s.gearDown && !onGround && s.speed > this.vStall * 1.8) {
      s.integrity = clamp(s.integrity - TUNING.gearDragDamage * dt, 0, 100);
    }
    this.climbReserve = clamp(this.bestClimbQuick(sigma), 0, 1);

    s.elapsedSeconds += dt;
  }

  private climbAtSea = -1;
  /** Climb available here as a fraction of sea level — cached per 2 m of height. */
  private bestClimbQuick(sigma: number): number {
    if (this.climbAtSea < 0) this.climbAtSea = Math.max(0.1, this.bestClimb(this.CD0, this.pMax, 1));
    const key = Math.round(sigma * 500);
    if (key !== this.reserveKey) {
      this.reserveKey = key;
      this.reserveVal = this.bestClimb(this.CD0, this.pMax, sigma) / this.climbAtSea;
    }
    return this.reserveVal;
  }
  private reserveKey = -1;
  private reserveVal = 1;
}
