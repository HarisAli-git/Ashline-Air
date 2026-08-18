import Phaser from 'phaser';

/**
 * The Director.
 *
 * Every system in this game already decides for itself when to act. The
 * weather field spawns a cell every 25-60 s, traffic spawns one every 26-60 s,
 * the gunners fire whenever you are in range. Each is individually reasonable
 * and the combination is uniform noise: a thunderstorm can land on top of a
 * traffic conflict inside a hostile stretch, or you can fly five minutes with
 * nothing to do at all. A flight has no shape.
 *
 * The Director gives it one. It does three things:
 *
 *   1. MEASURES what is actually happening to the pilot - not what the world
 *      intended. If a storm is thrown at you and you fly through it untroubled,
 *      that is a calm moment and the Director will escalate.
 *   2. STEERS toward a dramatic arc - build, peak, relief, enforced respite -
 *      anchored to where you are on the route.
 *   3. ADAPTS to how well you are flying, so a competent pilot gets a harder
 *      crossing and a struggling one gets a genuine break.
 *
 * It never spawns anything itself. It publishes one number - `pressure` - and
 * the weather, traffic and gunners each spend it in their own way. That keeps
 * every system's logic where it belongs, and means the Director can be lifted
 * out without breaking any of them.
 */

/** Where the arc is. */
export type DirectorPhase = 'build' | 'peak' | 'relief' | 'respite';

/** What the Director watches. All values are current-frame truth. */
export interface DirectorSenses {
  /** 0 at the departure field, 1 at the destination. */
  routeFrac: number;
  onGround: boolean;
  /** Integrity points lost per second, recent average. */
  hullLostRate: number;
  /** 0 = nothing in the air, 1 = rounds passing close. */
  roundsNear: number;
  /** 0 = at the critical angle of attack. */
  stallMargin: number;
  /** Metres between the aircraft and whatever is under it. */
  groundClearanceM: number;
  /** 0-1, the air itself. */
  turbulence: number;
  /** 0-1 strength of the weather cell the aircraft is inside. */
  weatherStrength: number;
  trafficConflict: boolean;
  engineFailed: boolean;
  /** Remaining hull, 0-1. */
  integrityFrac: number;
}

export interface DirectorState {
  /** 0-1. How much the world is permitted to throw at you right now. */
  pressure: number;
  phase: DirectorPhase;
  /** 0-1. Measured, not assumed. */
  intensity: number;
  /** 0-1. The Director's read on how well you are flying. */
  competence: number;
  /** Seconds spent in the current phase. */
  phaseFor: number;
}

/**
 * Felt stress does not decay at the rate the event does - a burst of ground
 * fire keeps your pulse up well after the last round has gone past. So the
 * smoothing is deliberately asymmetric: intensity snaps up and bleeds off.
 */
const RISE_TAU = 0.35;
const FALL_TAU = 4.0;

/** A peak has to be held this long before it counts as spent. */
const PEAK_HOLD = 7;
/** The relief has to actually land before the quiet begins. */
const RELIEF_MIN = 6;
/**
 * And the quiet is a floor, not a suggestion. This constant is what makes the
 * peaks read as peaks - without it the arc is only a slower kind of noise.
 */
const RESPITE_MIN = 22;

/** Intensity above this is "something is happening to me". */
const PEAK_ENTER = 0.62;
const PEAK_EXIT = 0.34;

export class Director {
  private _pressure = 0.35;
  private _intensity = 0;
  private _competence = 0.5;
  private phase: DirectorPhase = 'build';
  private phaseFor = 0;
  /** Fires once when the arc drops into respite, so a scene can say so. */
  onRespite: (() => void) | null = null;

  reset(): void {
    this._pressure = 0.35;
    this._intensity = 0;
    this._competence = 0.5;
    this.phase = 'build';
    this.phaseFor = 0;
  }

  get state(): DirectorState {
    return {
      pressure: this._pressure,
      phase: this.phase,
      intensity: this._intensity,
      competence: this._competence,
      phaseFor: this.phaseFor,
    };
  }

  /** How much the world may throw at you, 0-1. The one number that matters. */
  get pressure(): number { return this._pressure; }

  /**
   * What is happening TO the pilot, right now, on one scale.
   *
   * Combined as a probabilistic OR rather than a max or a sum. A max is wrong
   * because two medium problems at once are worse than one of them; a sum is
   * wrong because it runs off the end of the scale and then everything past
   * 1.0 feels identical. This gives both: threats compound, and the scale
   * holds.
   */
  private measure(s: DirectorSenses): number {
    const c: number[] = [];

    // Being shot at, and being hit - counted separately, because the near
    // misses are most of the drama and the hull loss is most of the cost.
    c.push(s.roundsNear);
    c.push(Phaser.Math.Clamp(s.hullLostRate / 6, 0, 1));

    // Flying the aeroplane badly enough to be in trouble. The stall margin is
    // already the wing's own measure, so this needs no speed table.
    c.push(Phaser.Math.Clamp(1 - s.stallMargin / 0.35, 0, 1));

    // Low and moving. Only counts in the air: sitting on the runway is 0 m of
    // clearance and is not, in fact, exciting.
    if (!s.onGround) {
      c.push(Phaser.Math.Clamp(1 - s.groundClearanceM / 110, 0, 1) * 0.85);
    }

    c.push(s.turbulence * 0.9);
    c.push(s.weatherStrength * 0.75);
    if (s.trafficConflict) c.push(0.7);
    if (s.engineFailed) c.push(0.9);

    let calm = 1;
    for (const v of c) calm *= 1 - Phaser.Math.Clamp(v, 0, 1);
    return 1 - calm;
  }

  /**
   * The skill read.
   *
   * Deliberately NOT "did you finish the route" - that arrives far too late to
   * shape anything. It is time spent under real load without losing hull,
   * which is available every second and is the thing a good pilot actually
   * does differently from a poor one.
   */
  private judge(s: DirectorSenses, dt: number): void {
    if (this._intensity > 0.45 && s.hullLostRate < 0.4) {
      // Slow on purpose: this should take a minute of good flying to move,
      // not a lucky ten seconds.
      this._competence += dt * 0.010 * this._intensity;
    } else if (s.hullLostRate > 1.2) {
      this._competence -= dt * 0.045;
    }
    // Hanging on the stall horn is not competence, however calm the sky is.
    if (s.stallMargin < 0.08 && !s.onGround) this._competence -= dt * 0.025;
    this._competence = Phaser.Math.Clamp(this._competence, 0.1, 1);
  }

  /**
   * The arc.
   *
   * build -> peak -> relief -> respite -> build. Phases advance on MEASURED
   * intensity, never on a timer alone, so the shape tracks the flight rather
   * than running along beside it.
   */
  private advance(dt: number): void {
    this.phaseFor += dt;
    switch (this.phase) {
      case 'build':
        if (this._intensity > PEAK_ENTER) this.enter('peak');
        break;
      case 'peak':
        // Over when the pilot has either been held at it long enough, or has
        // flown their way out of it.
        if (this.phaseFor > PEAK_HOLD || this._intensity < PEAK_EXIT) this.enter('relief');
        break;
      case 'relief':
        if (this.phaseFor > RELIEF_MIN && this._intensity < 0.3) {
          this.enter('respite');
          this.onRespite?.();
        }
        break;
      case 'respite':
        if (this.phaseFor > RESPITE_MIN) this.enter('build');
        break;
    }
  }

  private enter(p: DirectorPhase): void {
    this.phase = p;
    this.phaseFor = 0;
  }

  /**
   * How hard this crossing is allowed to get, right now.
   *
   * Peaks in the middle third of the route. The departure and the approach are
   * protected: a storm cell thrown at an aeroplane that is already configured
   * to land is not a decision, it is an ambush - the same rule the traffic
   * spawner already applies to itself.
   */
  private ceiling(s: DirectorSenses): number {
    const t = Phaser.Math.Clamp(s.routeFrac, 0, 1);
    // A broad hump: quiet at both ends, richest a little past halfway.
    const arc = Math.sin(Math.PI * Phaser.Math.Clamp((t - 0.06) / 0.82, 0, 1));
    /*
     * The hump tops out at 0.80, not at 1.0, and that headroom is the point.
     * The first version ran the base curve to 0.995 at mid-route, so the skill
     * multiplier below was clipped away by the final clamp and every pilot got
     * an identical crossing at exactly the place the arc is supposed to matter
     * most. Leaving room above the curve is what lets the skill read survive.
     */
    let cap = 0.24 + arc * 0.56;

    if (t < 0.10 || t > 0.88) cap = Math.min(cap, 0.22);

    // A better pilot gets a harder flight. This is the whole adaptive claim,
    // and it is worth being modest about it: about a quarter either way, not
    // a different game.
    cap *= 0.78 + this._competence * 0.44;

    // -- Mercy --------------------------------------------------------------
    // Never escalate onto someone who is already in trouble. Piling a storm
    // onto a dead engine is not drama, it is just the end of the flight.
    if (s.engineFailed) cap = Math.min(cap, 0.12);
    if (s.integrityFrac < 0.3) cap = Math.min(cap, 0.25);
    if (s.onGround) cap = Math.min(cap, 0.20);
    return Phaser.Math.Clamp(cap, 0, 1);
  }

  update(dt: number, s: DirectorSenses): DirectorState {
    if (dt <= 0) return this.state;

    // -- 1. Measure ---------------------------------------------------------
    const raw = this.measure(s);
    const tau = raw > this._intensity ? RISE_TAU : FALL_TAU;
    this._intensity += (raw - this._intensity) * Math.min(1, dt / tau);

    // -- 2. Judge -----------------------------------------------------------
    this.judge(s, dt);

    // -- 3. Advance the arc -------------------------------------------------
    this.advance(dt);

    // -- 4. Steer -----------------------------------------------------------
    const cap = this.ceiling(s);
    let target: number;
    switch (this.phase) {
      case 'build':
      case 'peak':
        target = cap;
        break;
      case 'relief':
        target = cap * 0.25;
        break;
      case 'respite':
        target = cap * 0.06;
        break;
    }

    /*
     * If the pilot is already at or past the intended level, stop spending -
     * whatever the phase says. The measured world overrules the planned one,
     * which is the entire point of measuring it.
     *
     * Stated as a target of zero rather than as a fraction of the current
     * pressure: a fraction compounds once per frame, so it collapsed six
     * times faster at 120 fps than at 20. The descent rate below is what
     * governs how fast this lands, and it is per second.
     */
    if (this._intensity > cap + 0.1) target = 0;

    // Pressure eases up and drops away fast. Escalation should be something
    // you notice building; relief has to be immediate or it is not relief.
    const rate = target > this._pressure ? 0.055 : 0.55;
    this._pressure = Phaser.Math.Clamp(
      this._pressure + Phaser.Math.Clamp(target - this._pressure, -rate * dt * 4, rate * dt),
      0, 1,
    );

    return this.state;
  }
}
