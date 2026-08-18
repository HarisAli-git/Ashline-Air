import Phaser from 'phaser';
import type { WeatherCondition } from '../../types';

/**
 * Weather as places on the map, not as a global mood.
 *
 * The old model rolled one condition for the whole world on a timer
 * (`Math.random() < CHANGE_CHANCE_PER_SECOND`), so weather was something that
 * HAPPENED TO YOU. You could not see it coming, could not go round it, and the
 * only decision it ever offered was whether to keep flying.
 *
 * A cell is an object at a world position with a size, a life cycle and a
 * drift. It is somewhere you can see on the horizon, decide about, and route
 * around — which turns weather from an event into navigation. Being caught out
 * becomes your call rather than the dice's.
 *
 * Cells are seeded per route so a leg you have flown before presents the same
 * problem, then drift on top of that so it is never quite the same crossing.
 */

export interface WeatherCell {
  /** Centre, world px. Drifts. */
  x: number;
  /** Half-width, world px. */
  radius: number;
  kind: WeatherCondition;
  /** Seconds lived, and how long it lives in total. */
  age: number;
  life: number;
  /** Drift speed, world px/s. Negative means it comes at you. */
  drift: number;
  /** Peak strength this cell reaches, 0–1. */
  peak: number;
  seed: number;
}

export interface WeatherSample {
  /** Strongest condition at this position; 'clear' when nothing reaches it. */
  condition: WeatherCondition;
  /** 0 at the edge, 1 in the core of a mature cell. */
  intensity: number;
  /**
   * Vertical air movement from the weather itself, m/s.
   *
   * A storm is not just rough — it has a violent updraught in the core and an
   * outflow downdraught ahead of it. Blundering into the leading edge of a
   * thunderstorm should drop you, and that is the specific thing that makes
   * going around it the right decision rather than a cosmetic one.
   */
  draught: number;
  /** How much the cell shuts convection off underneath it, 0–1 remaining. */
  convection: number;
  /** Distance to the nearest cell's leading edge, world px. Infinity if none. */
  distanceToEdge: number;
  /** The cell that is closest ahead, for drawing it on the horizon. */
  ahead: WeatherCell | null;
}

/** How strong each kind of cell is at its peak, and how it behaves. */
const KINDS: Array<{ kind: WeatherCondition; weight: number; draught: number }> = [
  { kind: 'thunderstorm', weight: 0.18, draught: 9 },
  { kind: 'dust_storm', weight: 0.24, draught: 4 },
  { kind: 'strong_winds', weight: 0.24, draught: 2.5 },
  { kind: 'cloudy', weight: 0.20, draught: 0.6 },
  { kind: 'fog', weight: 0.08, draught: 0.3 },
  { kind: 'blizzard', weight: 0.06, draught: 5 },
];

function hash(i: number): number {
  const x = Math.sin(i * 57.13 + 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export class WeatherField {
  private cells: WeatherCell[] = [];
  private seed = 1;
  private routeEndPx = 40000;
  private spawnTimer = 0;

  /**
   * Lay out the weather for a route.
   *
   * Deliberately deterministic from the route seed: the same leg presents the
   * same problem twice, which is what lets a player learn a route at all. The
   * drift and the life cycles then make each crossing different in detail.
   */
  reset(seed: number, routeEndPx: number): void {
    this.seed = seed % 100000;
    this.routeEndPx = routeEndPx;
    this.cells = [];
    this.spawnTimer = 0;

    // Three to five cells strewn down the route, never over either airfield —
    // taking off into a wall of dust you could not have avoided is not a
    // decision, it is a punishment.
    const n = 3 + Math.floor(hash(this.seed) * 3);
    const usable = routeEndPx * 0.72;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = routeEndPx * 0.16 + usable * t + (hash(this.seed + i * 31) - 0.5) * usable * 0.22;
      this.cells.push(this.makeCell(x, this.seed + i * 97));
    }
  }

  /**
   * @param pressure the Director's budget, 0-1. Only ever passed for cells
   *   spawned mid-flight; the route's opening layout is built at 0.5 so the
   *   same leg always presents the same problem. See update().
   */
  private makeCell(x: number, seed: number, pressure = 0.5): WeatherCell {
    // Weighted pick over the kinds, tilted by how much the Director is
    // willing to spend. At low pressure the roll is pushed down the table
    // toward cloud and fog; at high pressure it is pulled up toward the two
    // kinds that actually cost you something.
    const r = Phaser.Math.Clamp(hash(seed) - (pressure - 0.5) * 0.34, 0, 1);
    let acc = 0;
    let kind: WeatherCondition = 'cloudy';
    for (const k of KINDS) { acc += k.weight; if (r <= acc) { kind = k.kind; break; } }

    const life = 90 + hash(seed + 3) * 150;
    return {
      x,
      radius: 1400 + hash(seed + 5) * 2600,
      kind,
      // Start part-grown so the route is not uniformly calm at the first
      // second and uniformly angry a minute later.
      age: hash(seed + 7) * life * 0.6,
      life,
      drift: (hash(seed + 11) - 0.62) * 90,
      peak: (0.55 + hash(seed + 13) * 0.45) * (0.72 + pressure * 0.56),
      seed,
    };
  }

  /**
   * @param pressure the Director's budget, 0-1. It governs how often new cells
   *   arrive, how many may stand at once, and how hard they blow - but NOT the
   *   cells laid down by reset(). That layout stays deterministic per route,
   *   because a leg you cannot learn is a leg you cannot fly well.
   */
  update(dt: number, playerX: number, pressure = 0.5): void {
    for (const c of this.cells) {
      c.age += dt;
      c.x += c.drift * dt;
    }
    // Retire dead cells and anything that has drifted well behind
    this.cells = this.cells.filter(c => c.age < c.life && c.x > playerX - 9000);

    // Keep the sky populated ahead of the aircraft. In a respite the ceiling
    // drops to two cells and the interval nearly doubles, which is what a
    // quiet stretch of sky actually is.
    const maxCells = 2 + Math.round(Phaser.Math.Clamp(pressure, 0, 1) * 3);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.cells.length < maxCells) {
      const eagerness = 1.65 - Phaser.Math.Clamp(pressure, 0, 1) * 1.05;
      this.spawnTimer = (25 + hash(this.seed + Math.floor(playerX / 1000)) * 35) * eagerness;
      const x = playerX + 14000 + hash(this.seed + this.cells.length * 17 + Math.floor(playerX)) * 12000;
      if (x < this.routeEndPx * 0.92) {
        this.cells.push(this.makeCell(x, this.seed + Math.floor(playerX / 500) * 7, pressure));
      }
    }
  }

  /** A cell's strength right now: it builds, holds, then blows itself out. */
  private strengthOf(c: WeatherCell): number {
    const t = Phaser.Math.Clamp(c.age / c.life, 0, 1);
    // Ramp up over the first fifth, hold, decay over the last third
    const grow = Phaser.Math.Clamp(t / 0.2, 0, 1);
    const fade = Phaser.Math.Clamp((1 - t) / 0.33, 0, 1);
    return c.peak * Math.min(grow, fade);
  }

  sample(worldX: number): WeatherSample {
    let condition: WeatherCondition = 'clear';
    let intensity = 0;
    let draught = 0;
    let convection = 1;
    let distanceToEdge = Infinity;
    let ahead: WeatherCell | null = null;
    let bestAheadDist = Infinity;

    for (const c of this.cells) {
      const d = worldX - c.x;                 // + = we are past the centre
      const inside = Math.abs(d) / c.radius;

      // Track the nearest cell in front for the horizon art and the warning
      if (c.x + c.radius > worldX) {
        const gap = (c.x - c.radius) - worldX;
        if (gap < bestAheadDist) { bestAheadDist = gap; ahead = c; }
        if (gap > 0) distanceToEdge = Math.min(distanceToEdge, gap);
      }

      if (inside >= 1) continue;
      const strength = this.strengthOf(c);
      if (strength <= 0.02) continue;

      // Soft edge, hard core
      const core = Math.pow(1 - inside, 0.75) * strength;
      if (core > intensity) { intensity = core; condition = c.kind; }

      // Cloud shuts off the heating underneath it
      convection = Math.min(convection, 1 - core * 0.92);

      /**
       * Updraught in the core, outflow DOWNdraught ahead of it.
       *
       * This is the shape of a real convective cell and it is the whole
       * reason to respect one: the leading edge throws you at the ground and
       * the middle throws you at the sky. Flying the edge of a thunderstorm
       * is the single most dangerous thing available in the game.
       */
      const kind = KINDS.find(k => k.kind === c.kind);
      const power = (kind?.draught ?? 1) * strength;

      /**
       * Two lobes, positioned the way a real convective cell is built.
       *
       * A single sine through the cell put the peak draught at the EDGES and
       * exactly zero in the middle — the one place a storm's updraught should
       * be strongest. Explicit lobes fix that and are far easier to reason
       * about: a sinking outflow ahead of the cell, then the core going up.
       *
       * `u` runs −1 (still ahead of it) → +1 (through and out the back).
       */
      const u = d / c.radius;
      const outflow = Math.exp(-((u + 0.55) ** 2) / 0.10);   // gust front, sinking
      const updraft = Math.exp(-((u - 0.10) ** 2) / 0.14);   // the core, rising
      draught += power * (updraft - outflow * 0.9);
    }

    return { condition, intensity, draught, convection, distanceToEdge, ahead };
  }

  /** Everything currently alive — the renderer walks this to draw the sky. */
  get all(): ReadonlyArray<WeatherCell> { return this.cells; }

  /** Strength of a given cell right now, for the renderer. */
  strength(c: WeatherCell): number { return this.strengthOf(c); }
}
