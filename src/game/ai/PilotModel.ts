/**
 * The Pilot Model — Phase 4.
 *
 * Phase 1 gave the gunners a memory that lasted one flight. Phase 2 made the
 * air a place. Phase 3 gave a crossing a shape. All three forget you the
 * moment you land: flight twenty begins exactly like flight one, against a
 * world that has never met you.
 *
 * This is the part that remembers. It watches how you actually fly - the
 * height you settle at, how tightly you hold it, how hard you run the engine,
 * how you meet the ground, whether you go round weather or through it - and
 * keeps those estimates in the save. The world then starts each flight already
 * knowing something about you.
 *
 * On the word "learned": this is online parameter estimation, not a neural
 * network, and it is worth being plain about that. Every quantity here is a
 * running mean or variance updated once per frame with no history buffer, in
 * the same shape as the gunners' habit-reading in Raiders.ts. It is small,
 * inspectable, and cheap - and it is genuinely adaptive, which is the part
 * that matters.
 *
 * Two rules it must never break:
 *
 *   1. EVERY PRIOR MUST BE BEATABLE WITHIN THE FLIGHT. The gunners may start
 *      the day already half-ranged on a creature of habit, but jinking still
 *      breaks their aim inside a minute. A model you cannot fly your way out
 *      of is a difficulty setting the player never agreed to.
 *   2. IT MUST BE LEGIBLE. An invisible adaptive system is indistinguishable
 *      from an unfair one. `describe()` exists so the logbook can say, in
 *      words, what the world has worked out about you.
 */

/** Everything the model keeps between flights. Persisted in the save. */
export interface PilotProfile {
  /** Flights with usable observation behind them. */
  flights: number;
  /** Seconds of airborne observation in total - the confidence weight. */
  observedS: number;
  /** The height this pilot settles at, m. */
  cruiseAltM: number;
  /** How tightly they hold it, m. Small = a creature of habit. */
  cruiseAltSd: number;
  /** 0-1, career-long: how readable this pilot's altitude is. */
  predictability: number;
  /** Mean cruise throttle, 0-1. Running it hot is a choice with a bill. */
  throttle: number;
  /** Mean touchdown rate, m/s. The landing signature. */
  touchdownVs: number;
  /** 0 routes around weather … 1 flies straight through it. */
  weatherNerve: number;
  /** 0-1. Seeds the Director so a veteran does not start at "average". */
  competence: number;
}

export function blankProfile(): PilotProfile {
  return {
    flights: 0,
    observedS: 0,
    // Deliberately mid-range rather than zero: an unflown pilot should read as
    // UNKNOWN, and the confidence weight below is what expresses that. Starting
    // these at 0 would make the first flight's first second look like a violent
    // change of habit.
    cruiseAltM: 120,
    cruiseAltSd: 60,
    predictability: 0,
    throttle: 0.7,
    touchdownVs: 2.0,
    weatherNerve: 0.5,
    competence: 0.5,
  };
}

/** What the model sees, once per frame, while airborne. */
export interface PilotSample {
  altitudeM: number;
  throttle: number;
  /** 0-1 strength of the weather cell the aircraft is actually inside. */
  weatherStrength: number;
  /** 0-1 strength of the nearest cell ahead, whether or not we entered it. */
  weatherAheadStrength: number;
  /** The Director's live read, so career competence tracks in-flight skill. */
  competence: number;
}

/**
 * How much observation before the model is taken at face value.
 *
 * Roughly three or four flights. Below this every prior is blended back toward
 * neutral, so a single unusual sortie cannot convince the world you are
 * something you are not.
 */
const CONFIDENT_S = 900;

export class PilotModel {
  private p: PilotProfile;
  /** Airborne seconds in the CURRENT flight, so a bounced start counts little. */
  private flightS = 0;
  /** Running variance of altitude within this flight. */
  private altVar = 3600;
  private altMean = 0;
  private seenWeatherAhead = 0;
  private enteredWeather = 0;

  constructor(profile?: Partial<PilotProfile> | null) {
    this.p = { ...blankProfile(), ...(profile ?? {}) };
  }

  get profile(): PilotProfile { return { ...this.p }; }

  /**
   * 0-1. How much the model trusts itself.
   *
   * Everything the world reads out of this model is scaled by it, which is
   * what stops a first-time pilot being treated as a known quantity.
   */
  get confidence(): number {
    return Math.min(1, this.p.observedS / CONFIDENT_S);
  }

  beginFlight(): void {
    this.flightS = 0;
    this.altMean = this.p.cruiseAltM;
    this.altVar = this.p.cruiseAltSd * this.p.cruiseAltSd;
    this.seenWeatherAhead = 0;
    this.enteredWeather = 0;
  }

  /**
   * Watch the aeroplane. Called every airborne frame.
   *
   * Time constants are long on purpose. These are CAREER habits: a number that
   * moves inside ten seconds is measuring a manoeuvre, not a pilot.
   */
  observe(dt: number, s: PilotSample): void {
    if (dt <= 0) return;
    this.flightS += dt;
    this.p.observedS += dt;

    // Only count the cruise. A climb-out and an approach are the same shape
    // for everybody and would drag every pilot toward the same numbers.
    const cruising = s.altitudeM > 45;

    if (cruising) {
      // Exponential mean and variance, the same estimator the gunners use.
      const k = Math.min(1, dt / 12);
      const d = s.altitudeM - this.altMean;
      this.altMean += d * k;
      this.altVar += (d * d - this.altVar) * k;

      // Blend this flight's habit into the career one, slowly.
      const c = Math.min(1, dt / 240);
      this.p.cruiseAltM += (this.altMean - this.p.cruiseAltM) * c;
      const sd = Math.sqrt(Math.max(0, this.altVar));
      this.p.cruiseAltSd += (sd - this.p.cruiseAltSd) * c;

      // 45 m of scatter is enough to keep anyone guessing - the same threshold
      // the gunners use inside a single flight, so the two agree.
      const readable = Math.max(0, 1 - this.p.cruiseAltSd / 45);
      this.p.predictability += (readable - this.p.predictability) * c;

      this.p.throttle += (s.throttle - this.p.throttle) * Math.min(1, dt / 300);
    }

    // Nerve: of the weather that stood in the way, how much did they enter?
    if (s.weatherAheadStrength > 0.25) this.seenWeatherAhead += dt;
    if (s.weatherStrength > 0.25) this.enteredWeather += dt;

    // Career competence tracks the Director's live read, very slowly, so it is
    // an average of how you have coped across everything you have flown.
    this.p.competence += (s.competence - this.p.competence) * Math.min(1, dt / 1800);
  }

  /** Called once when the wheels touch, whatever the quality. */
  recordLanding(verticalSpeedMs: number): void {
    const w = Math.min(0.25, 1 / (this.p.flights + 2));
    this.p.touchdownVs += (Math.abs(verticalSpeedMs) - this.p.touchdownVs) * w;
  }

  /**
   * Close the flight and fold this crossing into the career numbers.
   *
   * @returns the profile to persist
   */
  endFlight(): PilotProfile {
    // A flight too short to have shown anything teaches nothing.
    if (this.flightS > 45) {
      this.p.flights += 1;
      if (this.seenWeatherAhead > 5) {
        const nerve = Math.min(1, this.enteredWeather / this.seenWeatherAhead);
        const w = Math.min(0.3, 1 / (this.p.flights + 1));
        this.p.weatherNerve += (nerve - this.p.weatherNerve) * w;
      }
    }
    this.p.cruiseAltM = Math.max(0, this.p.cruiseAltM);
    this.p.cruiseAltSd = Math.max(0, this.p.cruiseAltSd);
    this.p.predictability = clamp01(this.p.predictability);
    this.p.weatherNerve = clamp01(this.p.weatherNerve);
    this.p.competence = Math.min(1, Math.max(0.1, this.p.competence));
    return this.profile;
  }

  // ── What the world reads out of it ────────────────────────────────────────

  /**
   * The Director's starting competence.
   *
   * Blended toward 0.5 by confidence, so an unknown pilot still starts
   * average and a known one does not have to re-prove themselves every flight.
   */
  directorSeed(): number {
    const c = this.confidence;
    return 0.5 + (this.p.competence - 0.5) * c;
  }

  /**
   * What the gunners already believe about your altitude before you arrive.
   *
   * Capped at 0.45 deliberately. Word gets around, but nobody has your number
   * before you are in range - and the in-flight estimate must be able to pull
   * this DOWN within a minute if you fly unpredictably today. See rule 1.
   */
  raiderPrior(): number {
    return Math.min(0.45, this.p.predictability * this.confidence);
  }

  /**
   * The logbook read, in words.
   *
   * This is the whole reason the model is allowed to exist: a system that
   * quietly changes the difficulty without ever saying so is indistinguishable
   * from one that is simply unfair.
   */
  describe(): string[] {
    if (this.confidence < 0.2) {
      return ['Not enough flying on record yet to say much about you.'];
    }
    const out: string[] = [];
    const alt = Math.round(this.p.cruiseAltM / 5) * 5;
    const sd = this.p.cruiseAltSd;

    out.push(
      sd < 25
        ? `You settle at ${alt} m and you stay there. The guns have noticed.`
        : sd < 55
          ? `You cruise around ${alt} m, give or take.`
          : `You never fly the same height twice. Nobody can range you.`,
    );

    if (this.p.throttle > 0.86) {
      out.push('You run the engine hard. It will not last for ever.');
    } else if (this.p.throttle < 0.62) {
      out.push('You fly gently and your engines show it.');
    }

    out.push(
      this.p.touchdownVs < 1.2 ? 'You put it down softly, every time.'
        : this.p.touchdownVs < 2.6 ? 'Your landings are honest.'
          : 'You arrive rather than land.',
    );

    if (this.p.weatherNerve > 0.65) {
      out.push('You fly through weather other pilots go around.');
    } else if (this.p.weatherNerve < 0.3) {
      out.push('You give weather a wide berth.');
    }
    return out;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
