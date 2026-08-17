import Phaser from 'phaser';

/**
 * The air itself moves.
 *
 * Until now the sky was a vacuum with a weather tint over it: the aircraft's
 * altitude changed only because of what the aircraft did. Every stretch of the
 * route flew identically, and "terrain" was wallpaper behind a flat strip.
 *
 * This is a world-space field of vertical air velocity, sampled at the
 * aircraft's own coordinates, with three sources:
 *
 *   - **Thermals**: columns of rising air over open sun-heated ground. Ride
 *     one and you climb without burning a drop of fuel.
 *   - **Inter-thermal sink**: the air going up has to come down somewhere. The
 *     gaps between columns sink, which is what makes finding a thermal worth
 *     anything.
 *   - **Rotor**: mechanical turbulence and sink in the lee of anything solid —
 *     masts, towers, the city blocks. Flying low past structures is genuinely
 *     rougher, which gives the low route a cost beyond gunfire.
 *
 * Everything is keyed to WORLD x at 1:1, the same frame the aircraft, the
 * obstacles and the runways live in — so the cues drawn for it sit exactly
 * where the lift is. A field whose visualisation is on a parallax layer would
 * be a lie the player could never learn to read.
 *
 * Sign convention: POSITIVE is UP, in metres per second, like a variometer.
 */

/** Thermals stop working near the ground and die out at the inversion. */
const THERMAL_FLOOR_M = 18;
const THERMAL_TOP_M = 420;

/** Spacing between thermal columns, world px. Wide enough to have to hunt. */
const THERMAL_SPACING = 2400;

/** How far downwind of a structure the rotor reaches, world px. */
const ROTOR_REACH_PX = 340;

export interface AirSample {
  /** Vertical air velocity in m/s, positive up. */
  vertical: number;
  /** Extra turbulence from mechanical mixing, 0–1, added to the weather's. */
  turbulence: number;
  /** True when the aircraft is inside a working thermal — drives the HUD cue. */
  inThermal: boolean;
}

function hash(i: number): number {
  const x = Math.sin(i * 91.7 + 41.3) * 27183.13;
  return x - Math.floor(x);
}

export class AirMass {
  private seed = 1;
  /** 0 at night, 1 at midday — thermals are driven by the sun. */
  private solar = 1;
  /** Suppressed by rain, storms and fog: cloud shuts the heating off. */
  private convection = 1;
  /** Structures that shed rotor, in world px. Fed from Hazards each route. */
  private obstacles: ReadonlyArray<{ x: number; heightM: number }> = [];

  reset(seed: number): void {
    this.seed = seed % 100000;
    this.obstacles = [];
  }

  /** Structures the air has to flow around. */
  setObstacles(list: ReadonlyArray<{ x: number; heightM: number }>): void {
    this.obstacles = list;
  }

  /**
   * Sun angle and cloud cover, both 0–1.
   *
   * Convection is why weather matters here beyond damage: an overcast route
   * has dead air and you fly it on the engine, while a clear afternoon hands
   * you free height if you can find it.
   */
  setConditions(solar: number, convection: number): void {
    this.solar = Phaser.Math.Clamp(solar, 0, 1);
    this.convection = Phaser.Math.Clamp(convection, 0, 1);
  }

  /** Where the nearest thermal core is, world px — used to draw its cues. */
  thermalCoreNear(worldX: number): { x: number; strength: number } {
    const i = Math.round(worldX / THERMAL_SPACING);
    return { x: this.coreX(i), strength: this.coreStrength(i) };
  }

  /** Thermal columns wander so they are not a picket fence. */
  private coreX(i: number): number {
    return i * THERMAL_SPACING + (hash(i + this.seed) - 0.5) * THERMAL_SPACING * 0.55;
  }

  private coreStrength(i: number): number {
    /**
     * 3–8 m/s at the core, before sun and cloud scale it.
     *
     * Calibrated against what these aircraft actually are. A loaded cargo
     * aeroplane at idle sinks about 13 m/s, so nothing here will ever let you
     * soar it like a glider and it should not pretend to. What this range DOES
     * do is change the decision at cruise power: measured on the crop duster
     * at 45% throttle, a core turns a −1 m/s cruise into a +4 m/s climb and
     * the sink between columns turns it into −3. That is the difference
     * between arriving with fuel and not.
     */
    return 3 + hash(i * 7 + this.seed) * 5;
  }

  /** Column half-width in world px; the wider ones are the gentler ones. */
  private coreRadius(i: number): number {
    return 260 + hash(i * 13 + this.seed) * 300;
  }

  sample(worldX: number, altitudeM: number): AirSample {
    let vertical = 0;
    let turbulence = 0;
    let inThermal = false;

    // ── Convective layer ────────────────────────────────────────────────
    const heat = this.solar * this.convection;
    if (heat > 0.05 && altitudeM > THERMAL_FLOOR_M) {
      // Height profile: nothing at the deck, strongest in the middle of the
      // convective layer, gone at the inversion.
      const band = Phaser.Math.Clamp(
        (altitudeM - THERMAL_FLOOR_M) / (THERMAL_TOP_M - THERMAL_FLOOR_M), 0, 1,
      );
      const profile = Math.sin(band * Math.PI) ** 0.7;

      // Only the two nearest columns can matter at any point
      const i0 = Math.round(worldX / THERMAL_SPACING);
      let best = 0;
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        const d = Math.abs(worldX - this.coreX(i));
        const r = this.coreRadius(i);
        if (d > r) continue;
        // Bell across the column: the core is narrow and the edges are rough
        const t = 1 - d / r;
        const lift = this.coreStrength(i) * Math.pow(t, 1.6) * profile * heat;
        if (lift > best) {
          best = lift;
          // The edge of a thermal is where it is roughest — that shear is how
          // a real pilot finds the core.
          turbulence = Math.max(turbulence, (1 - t) * t * 2.4 * heat);
        }
      }
      if (best > 0.25) { vertical += best; inThermal = true; }

      // Inter-thermal sink. Mass has to balance: the air rising in the
      // columns is the air descending everywhere else, and it is what makes
      // a thermal worth crossing the sink to reach.
      if (!inThermal) vertical -= 1.8 * profile * heat;
    }

    // ── Rotor in the lee of solid structures ─────────────────────────────
    for (const o of this.obstacles) {
      // Only matters if you are low enough to be in its wake
      if (altitudeM > o.heightM * 1.8 + 25) continue;
      const behind = worldX - o.x;              // route runs +x, so lee is +x
      if (behind < 0 || behind > ROTOR_REACH_PX) continue;
      const decay = 1 - behind / ROTOR_REACH_PX;
      const height = Phaser.Math.Clamp(1 - altitudeM / (o.heightM * 1.8 + 25), 0, 1);
      const strength = decay * height;
      vertical -= 2.6 * strength;
      turbulence = Math.max(turbulence, strength * 0.85);
    }

    return {
      vertical,
      turbulence: Phaser.Math.Clamp(turbulence, 0, 1),
      inThermal,
    };
  }
}
