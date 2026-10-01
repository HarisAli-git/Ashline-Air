import type { FlightState } from '../../types';
import type { DropZoneStatus } from '../utils/EventBus';

/**
 * Teaching the game while you play it.
 *
 * There used to be two separate things: a one-line hint strip on a save's
 * first flight that covered the controls and nothing else, and a flight
 * school that taught the world — masts, cables, raiders, drops — but only if
 * you went and chose it. Most players never did, so they met their first
 * supply drop with no idea what the card, the band or the meter meant.
 *
 * Now there is one coach. It knows two kinds of lesson:
 *
 *   basics   start, take off, clean up, climb. Run in order, on flight school
 *            and on a save's first flight.
 *   moments  one per mechanic — an obstacle, a power line, raider ground, a
 *            drop call, the descent, the release, weather, traffic, the
 *            approach. Each fires the FIRST time you actually meet the thing,
 *            on any flight, and is remembered on the save so it never repeats.
 *
 * Flight school is the same coach on a hand-laid route that guarantees every
 * moment comes up, in a sensible order, with nothing else going on.
 */

export interface CoachContext {
  touch: boolean;
  retractableGear: boolean;
  engineRunning: boolean;
  loadingLeft: number;
  landed: boolean;
  timeWarp: number;
  remainingKm: number;
  /** Rotation speed for this airframe, km/h. */
  vrKmh: number;
  /** A structure ahead that you are not clear of, if any. */
  obstacle: { label: string; heightM: number; pylon: boolean } | null;
  /** Raider guns ahead that out-reach your height, if any. */
  threat: { label: string; ceilingM: number } | null;
  /** The drop card, as the HUD shows it. */
  drop: DropZoneStatus | null;
  /** Crates delivered so far this flight — a change means one just landed. */
  crateHits: number;
  weatherAhead: { kind: string; km: number } | null;
  traffic: boolean;
  /** Flew past the destination strip and still heading away from it. */
  overshot: boolean;
}

export interface CoachView {
  title: string;
  text: string;
  keys: string[];
  /** A height band to draw across the sky, metres. */
  guide: { lo: number; hi: number } | null;
  /** Basics are a numbered sequence; moments are not. */
  step?: number;
  total?: number;
}

interface Lesson {
  id: string;
  title: string;
  text: (c: CoachContext) => string;
  keys?: string[];
  touchKeys?: string[];
  guide?: (c: CoachContext) => { lo: number; hi: number } | null;
  /** Moments only: is the situation happening now? */
  when?: (s: FlightState, c: CoachContext) => boolean;
  /** Done — or plainly moved past. `t` is seconds on screen, `band` seconds in its guide band. */
  done: (s: FlightState, c: CoachContext, t: number, band: number) => boolean;
  /** Moments only: which one wins when several are happening. */
  priority?: number;
}

const CRUISE = { lo: 90, hi: 140 };

const BASICS: Lesson[] = [
  {
    id: 'load', title: 'Loading',
    text: () => 'The crew is putting your cargo aboard. The engine cannot start until they are clear.',
    done: (_s, c) => c.loadingLeft <= 0,
  },
  {
    id: 'start', title: 'Start the engine',
    text: () => 'Turn it over. It coughs for a couple of seconds before it catches.',
    keys: ['E'], touchKeys: ['▶ START'],
    done: (_s, c) => c.engineRunning,
  },
  {
    id: 'throttle', title: 'Full power',
    text: c => c.touch
      ? 'Push the throttle lever on the left all the way up.'
      : 'Hold W until the throttle is all the way open — THR, bottom right.',
    keys: ['W'], touchKeys: ['LEVER ▲'],
    // Or you are already rolling fast or flying: a step that can never come
    // true must not hold the rest of the lesson
    done: s => s.throttle > 0.85 || s.altitude > 5,
  },
  {
    id: 'takeoff', title: 'Take off',
    text: c => `Let her roll. Once you pass ${c.vrKmh} km/h, raise the nose and she will fly.`,
    keys: ['A'], touchKeys: ['NOSE UP'],
    done: s => s.altitude > 20,
  },
  {
    id: 'clean', title: 'Clean up',
    text: c => c.retractableGear
      ? 'Gear and flaps up. They got you off the ground; now they are only drag.'
      : 'Flaps up. They got you off the ground; now they are only drag.',
    keys: ['F'], touchKeys: ['FLAP'],
    done: (s, c, t) => (!s.flapsDeployed && (!c.retractableGear || !s.gearDown)) || t > 25,
  },
  {
    id: 'climb', title: 'Climb to cruise',
    text: c => c.touch
      ? 'Climb into the green band, then ease the nose down to level off in it. Less throttle, less speed — at a quarter you will sink.'
      : 'Climb into the green band, then ease the nose down with D to level off. Less throttle, less speed — at a quarter you will sink.',
    guide: () => CRUISE,
    done: (_s, _c, t, band) => band > 1.5 || t > 30,
  },
  {
    id: 'warp', title: 'Speed up time',
    text: () => 'Quiet stretches can be flown faster. Time warp turns itself off the moment something needs you.',
    keys: ['T'], touchKeys: ['TIME ⏩'],
    done: (_s, c, t) => c.timeWarp > 1 || t > 9,
  },
];

const MOMENTS: Lesson[] = [
  {
    id: 'drop-again', title: 'Go round again', priority: 92,
    text: c => (c.touch
      ? 'You flew past them with crates still aboard. Tap TURN, come back round, and make another pass.'
      : 'You flew past them with crates still aboard. Press R, come back round, and make another pass.')
      + ' Each pass is another chance at the green.',
    keys: ['R'], touchKeys: ['↺ TURN'],
    when: (_s, c) => !!c.drop && c.drop.cue === 'behind',
    done: (_s, c, t) => !c.drop || c.drop.cue !== 'behind' || t > 14,
  },
  {
    id: 'turn', title: 'Missed it? Turn round', priority: 95,
    text: c => (c.touch
      ? 'You flew past the strip. Tap TURN — the aeroplane comes round in a few seconds'
      : 'You flew past the strip. Press R — the aeroplane comes round in a few seconds')
      + ' and bleeds some speed doing it. Then line up and try again.',
    keys: ['R'], touchKeys: ['↺ TURN'],
    when: (_s, c) => c.overshot,
    done: (_s, c, t) => !c.overshot || t > 15,
  },
  {
    id: 'drop-release', title: 'Release', priority: 100,
    text: c => (c.touch
      ? 'Under the card: the dot is them, the line is where a crate lands now. Tap DROP when the dot reaches the green.'
      : 'Under the card: the dot is them, the line is where a crate lands now. Press SPACE when the dot reaches the green.')
      + ' The ticks count you in.',
    keys: ['SPACE'], touchKeys: ['📦 DROP'],
    when: (_s, c) => !!c.drop && c.drop.gapM !== null && (c.drop.cue === 'window' || c.drop.cue === 'release'),
    done: (_s, c, t) => !c.drop || c.drop.gapM === null || c.drop.got > 0 || c.drop.cue === 'late' || t > 20,
  },
  {
    id: 'obstacle', title: 'Obstacle ahead', priority: 90,
    text: c => `A ${c.obstacle?.label.toLowerCase() ?? 'structure'}, ${Math.round(c.obstacle?.heightM ?? 0)} m tall. `
      + 'The chip at the top names what is ahead and how tall it is. Climb above it.',
    when: (_s, c) => !!c.obstacle && !c.obstacle.pylon,
    done: (_s, c, t) => !c.obstacle || t > 12,
  },
  {
    id: 'traffic', title: 'Traffic', priority: 85,
    text: () => 'Another aircraft on your level. The TRAFFIC chip says which way to go — climb or descend and let them pass.',
    when: (_s, c) => c.traffic,
    done: (_s, c) => !c.traffic,
  },
  {
    id: 'raiders', title: 'Raider ground', priority: 80,
    text: c => `${c.threat?.label ?? 'Guns'} ahead — they reach ${Math.round(c.threat?.ceilingM ?? 0)} m. `
      + 'Climb above that, or keep changing height so they cannot range you.',
    when: (_s, c) => !!c.threat,
    done: (_s, c, t) => !c.threat || t > 14,
  },
  {
    id: 'power', title: 'Power lines', priority: 75,
    text: () => 'Pylons ahead, with cables strung between them. The cables are as solid as the pylons — stay above the tops.',
    when: (_s, c) => !!c.obstacle && c.obstacle.pylon,
    done: (_s, c, t) => !c.obstacle || !c.obstacle.pylon || t > 12,
  },
  {
    id: 'drop-descend', title: 'Start down', priority: 70,
    text: () => 'You are past the guns now. Follow the arrows down into the green band and hold it there.',
    when: (_s, c) => !!c.drop && c.drop.cue === 'descend',
    done: (_s, c, t) => !c.drop || c.drop.cue !== 'descend' || t > 18,
  },
  {
    id: 'drop-more', title: 'They need more', priority: 65,
    text: c => `${c.drop ? c.drop.need - c.drop.got : 'More'} more crate${c.drop && c.drop.need - c.drop.got === 1 ? '' : 's'} `
      + 'for them. Drop them close together — each lands a little further on.',
    when: (_s, c) => !!c.drop && c.drop.got > 0 && c.drop.got < c.drop.need,
    done: (_s, c, t) => !c.drop || c.drop.got >= c.drop.need || t > 7,
  },
  {
    id: 'approach', title: 'Approach', priority: 60,
    text: c => c.touch
      ? 'Home stretch. Pull the lever back to about a third, FLAP down, and bring her down gently toward the strip.'
      : 'Home stretch. Throttle back to about a third with S, flaps down with F, and bring her down gently toward the strip.',
    keys: ['S', 'F'], touchKeys: ['LEVER ▼', 'FLAP'],
    when: (_s, c) => c.remainingKm < 2.8 && !c.landed,
    done: (s, c) => (s.flapsDeployed && s.altitude < 45 && s.throttle < 0.6) || c.landed,
  },
  {
    id: 'land', title: 'Touch down', priority: 55,
    text: () => 'Hold her just off the strip and let the speed bleed away. Raise the nose a touch as the wheels meet the ground.',
    when: (s, c) => c.remainingKm < 1.2 && s.altitude < 45 && !c.landed,
    done: (_s, c) => c.landed,
  },
  {
    id: 'drop-call', title: 'People need supplies', priority: 50,
    text: () => 'The card top left says where they are, how far, and how many crates they need. '
      + 'Hold your height until it tells you to start down — the guns are between you and them until then.',
    when: (_s, c) => !!c.drop && c.drop.cue === 'hold',
    done: (_s, c, t) => !c.drop || c.drop.cue !== 'hold' || t > 12,
  },
  {
    id: 'weather', title: 'Weather ahead', priority: 40,
    text: c => `${WEATHER_WORD[c.weatherAhead?.kind ?? ''] ?? 'Weather'} ahead. `
      + 'Storms ice you up and knock out instruments; sand chokes the engine. Go over, go round, or push through fast.',
    when: (_s, c) => !!c.weatherAhead && c.weatherAhead.kind !== 'cloudy',
    done: (_s, _c, t) => t > 8,
  },
];

const WEATHER_WORD: Record<string, string> = {
  thunderstorm: 'A thunderstorm', dust_storm: 'A dust storm', blizzard: 'A blizzard',
  fog: 'Fog', strong_winds: 'Rough air',
};

export class FlightCoach {
  private basicIndex: number;
  private current: Lesson | null = null;
  private currentT = 0;
  private bandT = 0;
  private readonly seen: Set<string>;
  private readonly force: boolean;
  private readonly onSeen: (id: string) => void;

  /**
   * @param basics   run the takeoff sequence first
   * @param forceAll teach every moment even if the save has seen it (flight school)
   * @param seen     moments this save has already been taught
   * @param onSeen   told when a lesson has been taught, so it can be saved
   */
  constructor(opts: { basics: boolean; forceAll: boolean; seen: ReadonlyArray<string>; onSeen: (id: string) => void }) {
    this.basicIndex = opts.basics ? 0 : BASICS.length;
    this.force = opts.forceAll;
    this.seen = new Set(opts.forceAll ? [] : opts.seen);
    this.onSeen = opts.onSeen;
  }

  /** True while the takeoff sequence is still running. */
  get inBasics(): boolean { return this.basicIndex < BASICS.length; }

  /** Stop teaching entirely — the player asked for it. */
  hideAll(): void {
    this.basicIndex = BASICS.length;
    for (const m of MOMENTS) { this.seen.add(m.id); this.onSeen(m.id); }
    this.current = null;
  }

  update(dt: number, s: FlightState, c: CoachContext): CoachView | null {
    // ── Basics, strictly in order ─────────────────────────────────────────
    while (this.basicIndex < BASICS.length) {
      const step = BASICS[this.basicIndex];
      if (this.current !== step) { this.current = step; this.currentT = 0; this.bandT = 0; }
      this.tick(dt, s, c, step);
      if (step.done(s, c, this.currentT, this.bandT)) {
        this.basicIndex++;
        this.current = null;
        continue;
      }
      return this.view(step, c, this.basicIndex + 1, BASICS.length);
    }

    // ── Moments: the most urgent thing happening that has not been taught ──
    if (this.current) {
      this.tick(dt, s, c, this.current);
      if (this.current.done(s, c, this.currentT, this.bandT)) {
        this.mark(this.current.id);
        this.current = null;
      }
    }
    let best: Lesson | null = null;
    for (const m of MOMENTS) {
      if (this.seen.has(m.id) || !m.when?.(s, c)) continue;
      if (!best || (m.priority ?? 0) > (best.priority ?? 0)) best = m;
    }
    // Something more urgent pre-empts what is showing; the lesson it replaced
    // comes back if the situation is still on when this one is done.
    if (best && (!this.current || (best.priority ?? 0) > (this.current.priority ?? 0))) {
      if (best !== this.current) { this.current = best; this.currentT = 0; this.bandT = 0; }
    }
    return this.current ? this.view(this.current, c) : null;
  }

  private tick(dt: number, s: FlightState, c: CoachContext, l: Lesson): void {
    this.currentT += dt;
    const g = l.guide?.(c) ?? null;
    if (g && s.altitude >= g.lo && s.altitude <= g.hi) this.bandT += dt; else this.bandT = 0;
  }

  private mark(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.onSeen(id);
  }

  private view(l: Lesson, c: CoachContext, step?: number, total?: number): CoachView {
    return {
      title: l.title,
      text: l.text(c),
      keys: (c.touch ? l.touchKeys : l.keys) ?? [],
      guide: l.guide?.(c) ?? null,
      step, total,
    };
  }

  /** For the flight-school debrief: were the basics finished? */
  get forced(): boolean { return this.force; }
}
