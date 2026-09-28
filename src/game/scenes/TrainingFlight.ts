import type { FlightState } from '../../types';
import type { DropSite } from '../world/SupplyDrops';

/**
 * Flight school: one short circuit that teaches the whole game by flying it.
 *
 * The first-flight hints were one line of text on a real contract, and they
 * taught the controls but none of the WORLD — nothing about masts, cables,
 * raider ground, or how a supply drop is actually flown. A new player met all
 * of that for the first time with money on the line.
 *
 * This is a thirteen-kilometre loop from your home field with each lesson
 * placed on the route in the order it is taught: a mast, a power line into a
 * town where people are waiting for a crate, a stretch of rifles, and home.
 * Every step waits for you to actually do it; nothing is on a timer except
 * the one about time warp, and nothing can be failed except by crashing.
 */

export interface TrainingContext {
  retractableGear: boolean;
  engineRunning: boolean;
  loadingLeft: number;
  worldX: number;
  landed: boolean;
  timeWarp: number;
  /** Where each lesson is on the route, world px. */
  mastX: number;
  lineEndX: number;
  zone: [number, number];
  site: DropSite | null;
  remainingKm: number;
  /** Rotation speed for this airframe, km/h. */
  vrKmh: number;
  touch: boolean;
}

/** What the HUD panel shows for the current step. */
export interface TrainingView {
  step: number;
  total: number;
  title: string;
  text: string;
  /** Keys (or on-screen buttons) that do it, shown as keycaps. */
  keys: string[];
  /** A height band to draw across the sky, metres, or null. */
  guide: { lo: number; hi: number } | null;
}

interface Step {
  id: string;
  title: string;
  text: (c: TrainingContext) => string;
  keys?: string[];
  touchKeys?: string[];
  guide?: (c: TrainingContext) => { lo: number; hi: number } | null;
  /**
   * True once it has been done — OR once the flight has plainly moved past
   * it. Steps are strict about order, so a step that can never come true
   * (you took off at 88% throttle; you flew past the drop) would otherwise
   * hold the whole lesson on it for the rest of the circuit.
   * `t` is seconds spent on this step.
   */
  done: (s: FlightState, c: TrainingContext, t: number, band: number) => boolean;
  skip?: (s: FlightState, c: TrainingContext) => boolean;
}

const CRUISE = { lo: 90, hi: 140 };
const ABOVE_RIFLES = { lo: 95, hi: 150 };

const STEPS: Step[] = [
  {
    id: 'load',
    title: 'Loading',
    text: () => 'The crew is putting cargo aboard. The engine cannot start until they are clear.',
    done: (_s, c) => c.loadingLeft <= 0,
  },
  {
    id: 'start',
    title: 'Start the engine',
    text: () => 'Turn it over. It coughs for a couple of seconds before it catches.',
    keys: ['E'], touchKeys: ['▶ START'],
    done: (_s, c) => c.engineRunning,
  },
  {
    id: 'throttle',
    title: 'Full power',
    text: c => c.touch
      ? 'Push the throttle lever on the left all the way up.'
      : 'Hold W until the throttle is all the way open — THR, bottom right.',
    keys: ['W'], touchKeys: ['LEVER ▲'],
    done: s => s.throttle > 0.85 || s.altitude > 5,
  },
  {
    id: 'rotate',
    title: 'Take off',
    text: c => `Let her roll. Once you pass ${c.vrKmh} km/h, raise the nose and she will fly.`,
    keys: ['A'], touchKeys: ['NOSE UP'],
    done: s => s.altitude > 20,
  },
  {
    id: 'clean',
    title: 'Clean up',
    text: () => 'Flaps up. They got you off the ground; now they are only drag.',
    keys: ['F'], touchKeys: ['FLAP'],
    done: (s, c) => !s.flapsDeployed || c.worldX > c.mastX - 5000,
    skip: (_s, c) => c.retractableGear,
  },
  {
    id: 'clean-retract',
    title: 'Clean up',
    text: () => 'Gear and flaps up. They got you off the ground; now they are only drag.',
    keys: ['G', 'F'], touchKeys: ['GEAR', 'FLAP'],
    done: (s, c) => (!s.flapsDeployed && !s.gearDown) || c.worldX > c.mastX - 5000,
    skip: (_s, c) => !c.retractableGear,
  },
  {
    id: 'climb',
    title: 'Climb to cruise',
    text: c => c.touch
      ? 'Climb into the green band, then ease the nose down to level off in it.'
      : 'Climb into the green band, then ease the nose down with D to level off in it.',
    guide: () => CRUISE,
    done: (_s, c, _t, band) => band > 1.5 || c.worldX > c.mastX - 2500,
  },
  {
    id: 'warp',
    title: 'Speed up time',
    text: () => 'Quiet stretches can be flown faster. Time warp turns itself off the moment something needs you.',
    keys: ['T'], touchKeys: ['TIME ⏩'],
    guide: () => CRUISE,
    done: (_s, c, t) => c.timeWarp > 1 || t > 10,
    skip: (_s, c) => c.worldX > c.mastX - 3000,
  },
  {
    id: 'mast',
    title: 'Obstacle ahead',
    text: () => 'A radio mast, 46 m tall. The OBSTACLE call up top tells you its height. Stay above it.',
    guide: () => CRUISE,
    done: (_s, c) => c.worldX > c.mastX + 200,
  },
  {
    id: 'power',
    title: 'Power lines',
    text: () => 'Pylons ahead, with cables strung between them into the town. The cables are as solid as the pylons. Stay above the tops.',
    guide: () => ({ lo: 55, hi: 140 }),
    done: (_s, c) => c.worldX > c.lineEndX,
    skip: (_s, c) => c.worldX > c.lineEndX,
  },
  {
    id: 'descend',
    title: 'Supply drop',
    text: c => c.site
      ? `People in ${c.site.place} need a crate. The card top left says when to start down. Get into the green band.`
      : 'People ahead need a crate. Get down into the green band.',
    done: (s, c) => !c.site || c.site.got > 0 || c.site.state === 'served'
      || c.worldX > c.site.x + 1500
      || (s.altitude >= c.site.bandLo - 1 && s.altitude <= c.site.bandHi + 3),
  },
  {
    id: 'release',
    title: 'Release',
    text: c => c.touch
      ? 'The pin shows where a crate would land if you let go right now. When it turns green over them, tap DROP.'
      : 'The pin shows where a crate would land if you let go right now. When it turns green over them, press SPACE.',
    keys: ['SPACE'], touchKeys: ['📦 DROP'],
    done: (_s, c) => !c.site || c.site.got > 0 || c.site.state === 'served' || c.worldX > c.site.x + 1500,
  },
  {
    id: 'rifles',
    title: 'Raider ground',
    text: () => 'Riflemen hold the next stretch. They reach about 75 m. Climb back into the green band and they cannot touch you.',
    guide: () => ABOVE_RIFLES,
    done: (_s, c) => c.worldX > c.zone[1],
  },
  {
    id: 'approach',
    title: 'Approach',
    text: c => c.touch
      ? 'Home field ahead. Pull the lever back to about a third, FLAP down, and bring her down gently toward the strip.'
      : 'Home field ahead. Throttle back to about a third with S, flaps down with F, and bring her down gently toward the strip.',
    keys: ['S', 'F'], touchKeys: ['LEVER ▼', 'FLAP'],
    done: (s, c) => (s.flapsDeployed && s.altitude < 45 && s.throttle < 0.6) || c.landed,
  },
  {
    id: 'land',
    title: 'Touch down',
    text: () => 'Hold her just off the strip and let the speed bleed away. Raise the nose a touch as the wheels meet the ground.',
    done: (_s, c) => c.landed,
  },
];

export class TrainingFlight {
  private index = 0;
  private stepT = 0;
  private bandT = 0;
  private finishedAll = false;
  /** Distance out, km, at which the approach lesson starts. */
  private readonly approachAtKm = 2.8;

  get finished(): boolean { return this.finishedAll; }
  get total(): number { return STEPS.length; }

  /** Seconds-accurate walk through the steps. Returns what to show, or null when done. */
  update(dt: number, s: FlightState, c: TrainingContext): TrainingView | null {
    if (this.finishedAll) return null;
    let guard = 0;
    while (this.index < STEPS.length && guard++ <= STEPS.length) {
      const step = STEPS[this.index];
      // The approach lesson waits for the home stretch even if you are
      // already low and slow from the drop
      if (step.id === 'approach' && c.remainingKm > this.approachAtKm) break;
      const g = step.guide?.(c) ?? null;
      if (g && s.altitude >= g.lo && s.altitude <= g.hi) this.bandT += dt; else this.bandT = 0;
      if (step.skip?.(s, c) || step.done(s, c, this.stepT, this.bandT)) {
        this.index++;
        this.stepT = 0;
        this.bandT = 0;
        continue;
      }
      break;
    }
    if (this.index >= STEPS.length) {
      this.finishedAll = true;
      return null;
    }
    this.stepT += dt;
    const step = STEPS[this.index];
    // Between the rifles and the approach there is nothing new to teach —
    // hold the rifles step's advice (stay high) until the home stretch.
    const shown = step.id === 'approach' && c.remainingKm > this.approachAtKm
      ? STEPS[this.index - 1] : step;
    return {
      step: this.index + 1,
      total: STEPS.length,
      title: shown.title,
      text: shown.text(c),
      keys: (c.touch ? shown.touchKeys : shown.keys) ?? [],
      guide: shown.guide?.(c) ?? null,
    };
  }
}
