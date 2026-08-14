import type { FlightState, WeatherCondition } from '../../../types';
import { clamp } from '../../utils/math';

/**
 * What the weather actually does to you.
 *
 * Storms used to be scenery: a palette shift, some particles, a shaken camera
 * and a bit of pitch noise. You could fly through a thunderstorm at full power
 * and land with a pristine airframe, which made the whole weather system
 * dramatic lighting rather than a reason to change anything.
 *
 * Every condition now has a mechanism attached to it, and each one asks for a
 * different response:
 *
 *   blizzard      ICING — ice builds on the airframe, killing lift and adding
 *                 drag until the wing simply will not carry you. The answer is
 *                 to descend into warmer air; the answer is never "wait".
 *   thunderstorm  LIGHTNING — a strike kills the engine outright and blanks
 *                 the panel for a few seconds. You restart it or you glide.
 *                 Also ices, more slowly.
 *   dust_storm    GRIT — sand through the intake drives the temperature up,
 *                 grinds integrity away and makes the engine far more likely
 *                 to quit. The answer is to climb out of it or throttle back.
 *   strong_winds  SHEAR — hard gusts that upset the aircraft, worst low down.
 *
 * Nothing here is instant-death: each hazard gives a warning, degrades over
 * time, and has a specific action that fixes it.
 */

export interface WeatherHazardReport {
  /** 0–1 ice on the airframe. */
  iceLoad: number;
  /** 0–1 grit through the engine. */
  grit: number;
  /** True on the frame a strike lands. */
  struck: boolean;
  /** Seconds of blanked instruments remaining after a strike. */
  blackout: number;
  /** Integrity lost this frame. */
  damage: number;
  /** The engine should quit now. */
  killEngine: boolean;
  /** Human-readable caution for the annunciator, or null. */
  caution: string | null;
}

/**
 * Ice accretion per second at full effect, by condition.
 *
 * Paced so there is time to act: at 0.055 a blizzard took the airframe from
 * clean to fully iced in fifteen seconds, which is a death sentence dressed up
 * as a warning. Halved, the first caution lands around eight seconds in and
 * severe icing around twenty — enough to decide to descend and get there.
 */
const ICING: Partial<Record<WeatherCondition, number>> = {
  blizzard: 0.028,
  thunderstorm: 0.015,
  fog: 0.006,
};

/** Grit ingestion per second. */
const GRIT: Partial<Record<WeatherCondition, number>> = {
  dust_storm: 0.075,
  strong_winds: 0.012,
};

/** Below this altitude the air is warm enough that ice comes off. */
const MELT_ALTITUDE = 55;
/** Mean seconds between strikes while inside a thunderstorm. */
const STRIKE_MEAN_SECONDS = 26;

export class WeatherHazards {
  private ice = 0;
  private grit = 0;
  private blackout = 0;
  private strikeTimer = STRIKE_MEAN_SECONDS;
  private lastCaution: string | null = null;

  reset(): void {
    this.ice = 0;
    this.grit = 0;
    this.blackout = 0;
    this.strikeTimer = STRIKE_MEAN_SECONDS * (0.6 + Math.random() * 0.8);
    this.lastCaution = null;
  }

  get iceLoad(): number { return this.ice; }
  get gritLoad(): number { return this.grit; }
  get blackoutLeft(): number { return this.blackout; }

  /**
   * Advance the hazards and write their effects into the flight state's
   * modifiers. Returns what happened so the scene can play it.
   */
  update(
    dt: number,
    condition: WeatherCondition,
    state: FlightState,
    engineRunning: boolean,
  ): WeatherHazardReport {
    let struck = false;
    let killEngine = false;
    let damage = 0;

    this.blackout = Math.max(0, this.blackout - dt);

    // ── Icing ─────────────────────────────────────────────────────────────
    // Ice only forms in the cold air up top, and only where there is moisture
    // to freeze. Down low it melts off again, which is the escape route.
    const iceRate = ICING[condition] ?? 0;
    if (iceRate > 0 && state.altitude > MELT_ALTITUDE) {
      // Worse the higher and colder you are
      const altFactor = clamp((state.altitude - MELT_ALTITUDE) / 180, 0, 1);
      this.ice = clamp(this.ice + iceRate * (0.35 + 0.65 * altFactor) * dt, 0, 1);
    } else {
      // Shedding is quicker than accretion — a descent is a real answer
      const meltRate = state.altitude <= MELT_ALTITUDE ? 0.10 : 0.035;
      this.ice = clamp(this.ice - meltRate * dt, 0, 1);
    }

    // ── Grit ──────────────────────────────────────────────────────────────
    const gritRate = GRIT[condition] ?? 0;
    if (gritRate > 0 && engineRunning) {
      // Sand is worst near the deck where the storm is picking it up
      const lowFactor = clamp(1 - state.altitude / 260, 0.25, 1);
      this.grit = clamp(this.grit + gritRate * lowFactor * state.throttle * dt, 0, 1);
    } else {
      this.grit = clamp(this.grit - 0.045 * dt, 0, 1);
    }

    // ── Effects on the aircraft ───────────────────────────────────────────
    // Ice is heavy and the wrong shape: it destroys lift and piles on drag,
    // so the stall creeps up on you at a speed that was comfortable a minute
    // ago. This is what makes a blizzard a problem you have to solve.
    state.modifiers.liftMult = 1 - this.ice * 0.42;
    state.modifiers.dragMult = 1 + this.ice * 0.85 + this.grit * 0.15;

    // Grit cooks the engine and grinds it away
    if (this.grit > 0.05) {
      state.engineTemp = clamp(state.engineTemp + this.grit * 0.055 * dt, 0, 1);
      damage += this.grit * 0.55 * dt;
    }
    // Ice on the airframe scours it too, once there is a lot of it
    if (this.ice > 0.6) damage += (this.ice - 0.6) * 1.2 * dt;

    // ── Lightning ─────────────────────────────────────────────────────────
    if (condition === 'thunderstorm' && state.altitude > 25) {
      this.strikeTimer -= dt;
      if (this.strikeTimer <= 0) {
        this.strikeTimer = STRIKE_MEAN_SECONDS * (0.6 + Math.random() * 0.9);
        struck = true;
        killEngine = engineRunning;
        this.blackout = 3.2 + Math.random() * 2.2;
        damage += 8 + Math.random() * 7;
      }
    }

    // ── Grit-driven engine failure ────────────────────────────────────────
    // Not a cliff: the odds climb with how much sand has gone through it.
    if (this.grit > 0.45 && engineRunning && Math.random() < (this.grit - 0.45) * 0.28 * dt) {
      killEngine = true;
    }

    return {
      iceLoad: this.ice,
      grit: this.grit,
      struck,
      blackout: this.blackout,
      damage,
      killEngine,
      caution: this.caution(),
    };
  }

  /** The single most urgent weather caution, or null. */
  private caution(): string | null {
    let c: string | null = null;
    if (this.blackout > 0) c = 'AVIONICS OUT';
    else if (this.ice > 0.6) c = `SEVERE ICING ${Math.round(this.ice * 100)}% — DESCEND`;
    else if (this.ice > 0.22) c = `ICING ${Math.round(this.ice * 100)}% — DESCEND`;
    else if (this.grit > 0.5) c = 'SAND INGESTION — CLIMB OR THROTTLE BACK';
    else if (this.grit > 0.22) c = 'SAND IN THE INTAKE';
    this.lastCaution = c;
    return c;
  }

  /** True when the caution text has just changed, so it is announced once. */
  cautionChanged(previous: string | null): boolean {
    return this.lastCaution !== previous;
  }
}
