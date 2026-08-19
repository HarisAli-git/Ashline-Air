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
  /**
   * How fast the LEVER moves, and how fast the ENGINE follows it.
   *
   * These were 0.9 and nothing: the lever swept idle→full in 1.1 s and thrust
   * tracked it instantly, so "dive, slam the throttle, pull up" cost nothing.
   * A piston engine takes seconds to come up. Measured before: full power
   * 1.0 s after asking. After: the lever takes 1.8 s and the engine another
   * ~2.4 s behind it, so a recovery has to be STARTED early — which is the
   * whole point of managing energy.
   */
  throttleRate: 0.55,       // lever travel per second of input held
  spoolUp: 2.4,             // seconds for the engine to chase the lever up
  spoolDown: 1.5,           // …and to come back down (faster, as in a real one)

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
   * Drag added by a windmilling propeller, on top of CD0.
   *
   * This was 0.42 — five times the airframe's own CD0 — and it made GRAVITY
   * IRRELEVANT. Measured: a crop duster held in a 42° idle dive *lost* speed,
   * 113 → 80 km/h, with a peak acceleration of 0.00 m/s². An aeroplane
   * pointed at the ground was slowing down. That is the "no physics, gravity
   * is nonexistent" complaint exactly, and no camera or tuning fixes it,
   * because the brake simply outran g·sin γ at every angle.
   *
   * The reason it was ever set that high — "power off must not be a happy
   * glide" — no longer applies: the AoA stability and `powerAuthority` do that
   * job now. Sweeping it proves the old trade-off was backwards. Lower idle
   * drag makes an unpowered descent WORSE, not gentler, because the aeroplane
   * accelerates and the path steepens:
   *
   *     CD     dive 12 s        peak accel    power-off 20 s
   *     0.42   113 → 80 km/h    -0.04 m/s²    -14.9 m/s, 261 m lost
   *     0.16   113 → 110        +1.56         -19.2 m/s, 317 m
   *     0.09   113 → 127        +2.39         -21.7 m/s, 349 m
   *
   * The cubic falloff still matters: savage at idle, gone by cruise, which is
   * the honest reading — a prop under power makes thrust, not drag.
   */
  idleDragCD: 0.09,
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
  /**
   * Restoring moment per DEGREE of angle-of-attack error.
   *
   * This is now the number that decides AUTHORITY, because full stick settles
   * where control balances stability: αerr ≈ controlPower / pitchStability.
   * At 16 that was 4.9° — less than the margin to the stall, so the aeroplane
   * literally could not be rotated for takeoff or stalled in the air. At 6.5 it
   * is ~12°, which clears the ~14° critical angle when you are already trimmed
   * nose-up: you can haul it into a stall if you insist, and you have to work
   * for it.
   */
  pitchStability: 6.5,
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
  /**
   * Fraction of static stability that survives at zero thrust.
   *
   * At 0.10 the airframe effectively stopped being an aeroplane below about
   * half power, and the result was measurable and unflyable: on a flaps-and-
   * gear-down approach the descent rate went −43 m/s at 20% throttle, −86 m/s
   * at 40%, then snapped to −0.5 m/s at 50%. A cliff, with no window anywhere
   * near a real approach setting. That is the whole of "landing is not
   * natural and difficult" — you cannot fly an approach that does not exist.
   *
   * The physics was wrong too. Static stability comes from the TAILPLANE, not
   * the engine; an aeroplane with a dead engine is still stable, it just
   * glides. What the engine actually provides is propwash over the tail —
   * elevator AUTHORITY — and the ability to hold height. So stability stays
   * largely intact and "power off is a problem" is carried by `powerTrimShift`,
   * `wallow` near the stall, and simply not being able to stay up.
   */
  stabIdle: 0.55,
  /**
   * Power is what keeps a propeller aeroplane civilised.
   *
   * Most of the elevator's authority on a single is propwash over the tail,
   * and the thrust line does not pass through the centre of gravity — so
   * pulling the power off pitches the nose DOWN and takes the trim with it.
   * Modelling that is the difference between "throttle back and settle into a
   * tidy glide" and "throttle back and have a problem".
   *
   * Authority is zero at or below `powerAuthorityLow`, full at
   * `powerAuthorityHigh`, and squared in between so it collapses fast. The
   * high end is deliberately at half throttle: an approach is flown at 45–55%
   * and has to stay flyable.
   */
  powerAuthorityLow: 0.15,
  powerAuthorityHigh: 0.52,
  /** Nose-down pitching moment at zero power, deg/s². */
  /** Degrees of nose-down TRIM shift as power is lost (not a pitch rate). */
  powerTrimShift: 3.2,
  pitchDamping: 2.8,        // pitch-rate damping
  stallPitchDamp: 3.0,      // extra damping in the stall — stops porpoising
  stallNoseDown: 54,        // deg/s² nose-down once fully stalled
  maxPitchRate: 65,         // deg/s clamp
  /**
   * How far the nose can go down.
   *
   * At −38° this quietly CAPPED every dive: the aeroplane could not be pointed
   * steeply enough for gravity to do much, so a dive plateaued at 127 km/h
   * with a never-exceed speed of 189. "Out of control" has to mean the nose
   * can actually drop, and that recovery is then a real problem.
   */
  /**
   * Nose-down limit. Deliberately steep: at -72° the aeroplane could not be
   * pointed hard enough at the ground to feel like it was falling, which is
   * what "we can't control the plane, it is not free falling steeply" was
   * describing. -85° is as near vertical as makes any difference.
   */
  pitchMin: -85,
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
/**
 * How thin the air is at a given height, relative to sea level.
 *
 * The model had NO altitude term at all: the wing made the same lift and the
 * engine the same thrust at eight thousand metres as on the runway. That is
 * why `maxAltitude` could only ever be a hard clamp - there was no physics to
 * stop you, so the number had to. And it is most of why an engine-off descent
 * felt weightless: nothing about the aeroplane changed with height.
 *
 * Standard atmosphere: 74% of sea-level density at 3000 m, 43% at 8000 m.
 */
/**
 * Gameplay metres of altitude per real atmospheric metre.
 *
 * The vertical scale is compressed the same way the horizontal one is: a route
 * is a fifth of its lore distance, and the sky is an eighth of its real depth.
 * Without this the whole atmosphere would sit in the top 12% of the band and a
 * ceiling of 1000 m would be indistinguishable from sea level.
 *
 * With it, 1000 gameplay metres is 8000 m of real air - 43% density - so a
 * ceiling is once again something the aerodynamics produce rather than
 * something a clamp asserts.
 */
const ALTITUDE_COMPRESSION = 8;

export function densityRatio(altitudeM: number): number {
  const real = altitudeM * ALTITUDE_COMPRESSION;
  return Math.pow(Math.max(0.15, 1 - 2.25577e-5 * real), 4.2559);
}

/**
 * Thrust falls off FASTER than density does.
 *
 * A normally-aspirated engine loses manifold pressure as well as mass flow, so
 * its power drops roughly as density^1.3 while the drag it has to overcome
 * drops only as density^1. That gap is what a service ceiling actually IS -
 * the height where the two curves meet and the aeroplane stops climbing. With
 * this in, the ceiling emerges from the aerodynamics instead of being a clamp
 * bolted on top of them.
 */
const THRUST_LAPSE = 1.3;

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
  readonly vMax: number;
  private readonly vCruise: number;
  readonly vStall: number;

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
      distanceTravelled: 0,
      elapsedSeconds: 0,
      modifiers: { fuelBurnMult: 1, dragMult: 1, liftMult: 1, stabilityMult: 1 },
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
    if (steps === MAX_SUBSTEPS) this.accumulator = 0; // shed backlog after a stall

    return next;
  }

  private step(
    s: FlightState, input: FlightInput, dt: number, windX: number, windUp = 0,
  ): void {
    const { stats } = this.def;
    const onGround = s.altitude <= 0;

    // ── Throttle ──────────────────────────────────────────────────────────
    if (input.throttleUp)   s.throttle = clamp(s.throttle + TUNING.throttleRate * dt, 0, 1);
    if (input.throttleDown) s.throttle = clamp(s.throttle - TUNING.throttleRate * dt, 0, 1);
    const lever = input.engineOn && s.fuel > 0 ? s.throttle : 0;
    // The engine LAGS the lever. Everything downstream that used to read the
    // lever now reads delivered power, so the drag of a windmilling prop also
    // takes its time to come and go.
    const tau = lever > s.enginePower ? TUNING.spoolUp : TUNING.spoolDown;
    s.enginePower += (lever - s.enginePower) * (1 - Math.exp(-dt / tau));
    const effThrottle = s.enginePower;
    const sigma = densityRatio(s.altitude);
    const aT = effThrottle * this.tMax * Math.pow(sigma, THRUST_LAPSE)
      * (1 - s.engineTemp * 0.3)
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

    // ½ρV²S/m — and ρ is now a real function of height, so the wing has less
    // to work with up high exactly as the engine does.
    const qK = this.K * sigma * s.speed * s.speed;

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
    // What the airframe is pulling, in g. Everything that should make a hard
    // manoeuvre FELT rather than merely reported reads this: the camera, the
    // airframe wobble, the engine and wind note.
    s.loadFactor = onGround ? 1 : clamp(aL / GRAVITY, -1.5, 6);
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
    const vWanted = s.flapsDeployed
      ? vTrimLow                                   // configured for the approach
      : vTrimLow + (this.vCruise - vTrimLow) * effThrottle;

    /**
     * The aeroplane must never be trimmed to a speed its CURRENT POWER cannot
     * come close to holding. That single omission is what turned a throttle
     * reduction into a dive instead of a descent.
     *
     * Measured before this: at 30% power the military transport was trimmed to
     * 254 km/h with 130 km/h of stall speed — a speed nothing but a steep dive
     * could supply — so it went and got it, at −81 m/s. Across the fleet the
     * approach window was a cliff: −43 to −86 m/s below half throttle, then
     * −0.5 m/s at 50%. There was no setting anywhere that gave the 3–5 m/s of
     * a real approach, which is the whole of "landing is not natural".
     *
     * Solving the speed the thrust can actually sustain and keeping the demand
     * within reach of it makes the shortfall show up as a steady descent — and
     * at idle it falls back to best glide, which is exactly right: engine dead,
     * trimmed for the glide, coming down at a rate you can fly.
     */
    let cdTrim = TUNING.CD0 + TUNING.inducedK * 0.55
      + TUNING.idleDragCD * Math.pow(1 - effThrottle, TUNING.idleDragCurve);
    if (s.flapsDeployed) cdTrim += TUNING.flapsCD;
    if (s.gearDown && !this.gearFixed) cdTrim += TUNING.gearCD;
    const vSustain = Math.sqrt(Math.max(0, aT) / Math.max(1e-4, this.K * cdTrim));
    const vTrim = clamp(vWanted, vTrimLow, Math.max(vTrimLow, vSustain * 1.12));
    const clForLevel = clamp(GRAVITY / (this.K * vTrim * vTrim), 0, clMax);
    const alphaTrim = clamp(
      (clForLevel - TUNING.CL0 - flapCL) / TUNING.CLalpha,
      -2 * DEG, alphaCrit,
    );

    const command = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
    const controlMoment = command * TUNING.controlPower * qNorm * elevator;

    // ── Longitudinal stability acts on ANGLE OF ATTACK, never on attitude ──
    //
    // This used to solve the flight path the current power could sustain and
    // then SERVO the nose onto it. That is an autopilot, not an aeroplane: it
    // knew the right answer and flew there, and the player only nudged its
    // setpoint. Measured, the tell was unmistakable — from a 28° nose-up
    // attitude, hands off, it converged to pitch 2° and vertical speed 0.0 and
    // sat there for ever. Nothing real does that. That single behaviour is
    // what made the whole thing feel like driving a robot.
    //
    // A real tailplane makes a restoring moment proportional to how far the
    // ANGLE OF ATTACK has strayed from its trimmed value, and knows nothing
    // about flight paths or thrust. Fly too slowly and α must rise to hold the
    // lift, so the tail pushes the nose DOWN — the aeroplane trades height for
    // speed on its own. Too fast and α falls, so the nose comes UP and it
    // climbs, bleeding the speed off again. That exchange is the phugoid, and
    // it is exactly the "adjusts itself to gravity" behaviour that was missing:
    // it is emergent here, not scripted.

    // Propwash over the tail is much of a single's elevator authority, so
    // stability still fades with power — but it fades toward WALLOWING, not
    // toward a different tidy equilibrium. The curve is deliberately squared
    // between 15% and 52%: scaled linearly, a third of throttle still left the
    // aeroplane 37% stabilised, which measured as a trimmed, perfectly
    // controllable glide — the opposite of losing an engine.
    const powerAuthority = clamp(
      (effThrottle - TUNING.powerAuthorityLow)
        / (TUNING.powerAuthorityHigh - TUNING.powerAuthorityLow), 0, 1,
    ) ** 2;
    // Rough air degrades the airframe's manners as well as shaking it.
    const stabPower = (TUNING.stabIdle + (1 - TUNING.stabIdle) * powerAuthority)
      * s.modifiers.stabilityMult;
    /**
     * Losing power drops the nose — but as a TRIM SHIFT, not as a raw pitch
     * acceleration.
     *
     * As an unopposed `pitchRate -= 34 * (1 - powerAuthority)` this was a
     * constant ~28 deg/s² nose-down at 30% throttle that nothing balanced, so
     * the aeroplane simply drove itself into the ground: measured −81 m/s at
     * 30% power and −0.5 m/s at 50%, a cliff with no approach anywhere in
     * between. Stability could never win because the term did not act like a
     * moment at all.
     *
     * A thrust line above the CG and the loss of propwash over the tail shift
     * where the aeroplane TRIMS. Biasing the target angle of attack reproduces
     * that: the nose drops, stability still balances it at a new attitude, and
     * a throttle reduction becomes a steeper descent rather than a dive.
     */
    const alphaTrimEff = alphaTrim - TUNING.powerTrimShift * DEG * (1 - powerAuthority);
    const alphaErrDeg = (alpha - alphaTrimEff) / DEG;
    const stabilityMoment = onGround
      ? -s.pitch * TUNING.pitchStability * qNorm          // hold the runway attitude
      : -alphaErrDeg * TUNING.pitchStability * stabPower * qNorm;

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
    const hi = onGround ? 16 : 48;   // and more room to haul the nose up
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
      let newGamma = clamp(gamma + gammaDot * dt, -1.35, 1.35);

      /*
       * `climbRate` was declared in the type and read by NOTHING - the hangar
       * printed a number that had no effect on anything. Aircraft were in fact
       * climbing at 34-93 m/s at a sustained 50° nose-up, which is why every
       * airframe reached safety in five to thirteen seconds regardless of what
       * it was.
       *
       * Capping the CLIMB ANGLE rather than the vertical speed keeps the model
       * honest: V·sin(γ) ≤ climbRate is exactly the statement "this aeroplane
       * has only so much excess power", and γ stays the integrated state that
       * everything else is derived from. Descending is deliberately not capped
       * — gravity is allowed to do whatever it likes.
       */
      const maxClimb = stats.climbRate;
      if (newGamma > 0 && s.speed > 1) {
        const gammaCap = Math.asin(clamp(maxClimb / s.speed, 0, 1));
        if (newGamma > gammaCap) newGamma = gammaCap;
      }
      s.flightPathAngle = newGamma;

      /**
       * The aeroplane flies through the AIR; the air moves over the ground.
       *
       * This is the whole trick, and it is why it is applied here rather than
       * by nudging `verticalSpeed` from outside. All the aerodynamics above —
       * α, lift, drag, the flight path — are computed relative to the air and
       * are untouched: the wing does not know it is in a thermal. What changes
       * is the aeroplane's speed over the GROUND, because the parcel of air
       * carrying it is itself going up or down.
       *
       * Nudging vertical speed directly would have quietly rewritten γ, which
       * is integrated state, and fought the flight model every frame.
       */
      const airSpeedVertical = s.speed * Math.sin(newGamma);
      s.verticalSpeed = airSpeedVertical + windUp;
      const wasAirborne = s.altitude > 0;
      /*
       * No longer clamped at the data-sheet ceiling. The thinning air above
       * makes the climb peter out on its own, and FlightScene starves the
       * engine past it - a limit you fly into, rather than one you slide
       * along. The absolute cap is only a backstop against nonsense.
       */
      s.altitude = clamp(s.altitude + s.verticalSpeed * dt, 0, stats.maxAltitude * 1.35);
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
     * ── There is no longer a free altitude ────────────────────────────────
     *
     * Thin air carries heat away worse, so the same power setting runs hotter
     * the higher you are. This is real, and more to the point it is the fix
     * for the shape of the game: climbing above the guns used to be free,
     * permanent and total, which made "climb and wait" both the optimal play
     * and the dullest one. Now height is a loan against the engine — you can
     * take it, you cannot sit on it, and coming down is how you pay it back.
     *
     * At the ceiling this adds about a third to the target temperature, so a
     * cruise up there overheats in a couple of minutes even at modest power.
     */
    const coolingPenalty = 1 + (1 - sigma) * 0.62;
    const tempTarget = clamp(effThrottle * 0.9 * coolingPenalty, 0, 1);
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
