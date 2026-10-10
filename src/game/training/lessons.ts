import type { FlightState, LandingQuality, PlayerStats } from '../../types';
import type { ControlAction } from '../utils/controls';

/**
 * Flight school, as short lessons.
 *
 * It used to be one thirteen-kilometre flight that taught about fifteen
 * things in a row — the start-up, the take-off, flaps, a mast, power lines, a
 * drop over a town, a gun zone, the landing — each a paragraph in a panel
 * competing with everything else on the screen. Nobody remembered the first
 * thing by the time the last one came round.
 *
 * Now each lesson is a minute or two with one job, taught one goal at a time,
 * graded with stars, and replayable. Every lesson has to be passed before the
 * contract board opens.
 *
 * Lessons are data. LessonRunner walks the goals; FlightScene flies them.
 */

export type LessonId = 'takeoff' | 'speed' | 'landing' | 'drop' | 'threats';
export const LESSON_ORDER: LessonId[] = ['takeoff', 'speed', 'landing', 'drop', 'threats'];

/** HUD parts a lesson can show. The cautions (stall and the rest) always show. */
export type HudPart = 'speed' | 'alt' | 'thr' | 'fuel' | 'arr' | 'flaps' | 'gear' | 'route' | 'drop';

/** What the scene knows that the flight state does not. */
export interface LessonCtx {
  engineRunning: boolean;
  /** Rotation, clean stall and book cruise speeds for this airframe, km/h. */
  vrKmh: number;
  stallKmh: number;
  cruiseKmh: number;
  retractableGear: boolean;
  heading: 1 | -1;
  /** A 180 is in progress. */
  turning: boolean;
  /** The stall warning is sounding. */
  stall: boolean;
  /** The wheels have met the ground after flying. */
  landed: boolean;
  /** Rolled to a stop after landing. */
  stopped: boolean;
  onRunway: boolean;
  landing: LandingQuality | null;
  /** Top speed for each flap notch, km/h, indexed by notch. */
  flapLimitKmh: number[];
  /** Integrity lost since the lesson began. */
  damage: number;
}

/** Where the current goal stands. */
export interface GoalClock {
  /** Seconds on this goal. */
  t: number;
  /** Speed and heading when the goal began. */
  startSpeedKmh: number;
  startHeading: 1 | -1;
}

export interface GoalDef {
  id: string;
  /** One line: on the card and over the radio. */
  text: (c: LessonCtx) => string;
  keys?: ControlAction[];
  /** The HUD part this goal is about — it glows. */
  focus?: HudPart;
  /** A height band drawn across the sky, m. */
  guide?: { lo: number; hi: number };
  /** A speed band shown under the speed, km/h. */
  speedBand?: (c: LessonCtx) => { lo: number; hi: number };
  /** Finished when this is true… */
  done?: (s: FlightState, c: LessonCtx, g: GoalClock) => boolean;
  /** …or when this has held for `seconds` without a break. */
  hold?: { when: (s: FlightState, c: LessonCtx) => boolean; seconds: number };
  /** Left out entirely when it does not apply (no retractable gear, say). */
  skip?: (c: LessonCtx) => boolean;
}

/** What a lesson is graded on. */
export interface LessonMetrics {
  seconds: number;
  stalled: boolean;
  damage: number;
  landing: LandingQuality | null;
  onRunway: boolean;
}

export type LessonStart =
  | { kind: 'strip' }
  | {
    kind: 'air';
    /** Distance along the route, km — or back from its end when negative. */
    atKm: number;
    altitude: number;
    /** Speed as a multiple of the clean stall, or of the book cruise. */
    overStall?: number;
    ofCruise?: number;
    throttle: number;
  };

export interface LessonDef {
  id: LessonId;
  n: number;
  title: string;
  /** One line for the Flight School screen. */
  blurb: string;
  routeKm: number;
  start: LessonStart;
  autoFlaps: boolean;
  hud: HudPart[];
  /** What stands on the circuit. */
  /** What the route has on it; `drop` puts people on the ground to drop to. */
  world: { mast?: boolean; town?: boolean; guns?: boolean; drop?: boolean };
  goals: GoalDef[];
  /** The first star: passing. */
  passText: string;
  /** The second and third stars. */
  stars: [{ text: string; met: (m: LessonMetrics) => boolean }, { text: string; met: (m: LessonMetrics) => boolean }];
  /** Ends the lesson as failed when it returns a reason. */
  failIf?: (s: FlightState, c: LessonCtx) => string | null;
  /** What to take away, said over the debrief. */
  takeaway?: string;
}

/** The cruise band every lesson climbs into, m. */
const BAND = { lo: 90, hi: 140 };
/** Where the climb counts as done: well inside the band, so levelling off has room. */
const BAND_IN = BAND.lo + 15;
const inBand = (s: FlightState): boolean => s.altitude >= BAND.lo && s.altitude <= BAND.hi;
const kmh = (s: FlightState): number => s.speed * 3.6;

export const LESSONS: Partial<Record<LessonId, LessonDef>> = {
  takeoff: {
    id: 'takeoff', n: 1, title: 'Take off & climb',
    blurb: 'Start the engine, get off the ground and level off at cruise height.',
    routeKm: 8,
    start: { kind: 'strip' },
    autoFlaps: true,
    hud: ['speed', 'alt', 'thr', 'gear'],
    world: { mast: false, town: false, guns: false },
    goals: [
      { id: 'start', text: () => 'Start the engine', keys: ['engine'], focus: 'thr',
        done: (_s, c) => c.engineRunning },
      { id: 'power', text: () => 'Throttle all the way up', keys: ['throttleUp'], focus: 'thr',
        done: s => s.throttle > 0.95 },
      { id: 'rotate', text: c => `Let her roll — at ${c.vrKmh} km/h, ease the nose up`, keys: ['noseUp'], focus: 'speed',
        done: s => s.altitude > 6 },
      // Left down, the wheels drag her back and get torn at speed
      { id: 'gearUp', text: () => 'Climbing away — gear up', keys: ['gear'], focus: 'gear',
        skip: c => !c.retractableGear, done: s => !s.gearDown },
      { id: 'climb', text: () => 'Climb into the middle of the green band — the flaps come up by themselves', focus: 'alt',
        guide: BAND, done: s => s.altitude >= BAND_IN },
      { id: 'level', text: () => 'Ease the nose down and hold her in the band', keys: ['noseDown'], focus: 'alt',
        guide: BAND, hold: { when: s => inBand(s), seconds: 5 } },
    ],
    passText: 'Off the ground and level in the band',
    stars: [
      { text: 'No stall warning', met: m => !m.stalled },
      { text: 'Done inside 90 seconds', met: m => m.seconds <= 90 },
    ],
    failIf: (_s, c) => (c.landed ? 'Back on the ground before the lesson was done' : null),
    takeaway: 'The flaps were set for the take-off and came up on their own once you were flying.',
  },

  speed: {
    id: 'speed', n: 2, title: 'Speed control',
    blurb: 'Slow down and speed up with the throttle, brake with the airbrakes, turn round.',
    // Long enough that a fast aeroplane never reaches the far strip mid-lesson
    routeKm: 30,
    start: { kind: 'air', atKm: 1.2, altitude: 250, ofCruise: 0.9, throttle: 0.85 },
    autoFlaps: true,
    hud: ['speed', 'alt', 'thr'],
    world: { mast: false, town: false, guns: false },
    goals: [
      { id: 'slow', text: c => `Throttle back — bring her to ${Math.round(c.stallKmh * 2)}–${Math.round(c.stallKmh * 2.4)} km/h`,
        keys: ['throttleDown'], focus: 'speed',
        speedBand: c => ({ lo: Math.round(c.stallKmh * 2), hi: Math.round(c.stallKmh * 2.4) }),
        hold: { when: (s, c) => kmh(s) >= c.stallKmh * 2 && kmh(s) <= c.stallKmh * 2.4, seconds: 3 } },
      { id: 'fast', text: c => `Full power — back up past ${Math.round(c.cruiseKmh * 0.85)} km/h`,
        keys: ['throttleUp'], focus: 'speed',
        done: (s, c) => kmh(s) >= c.cruiseKmh * 0.85 },
      { id: 'brake', text: () => 'Airbrakes out — feel her slow', keys: ['airbrake'], focus: 'speed',
        done: (s, _c, g) => (s.airbrake ?? 0) > 0.9 && kmh(s) <= g.startSpeedKmh - 25 },
      { id: 'stow', text: () => 'Airbrakes away', keys: ['airbrake'],
        done: s => (s.airbrake ?? 0) < 0.1 },
      { id: 'turn', text: () => 'Turn round', keys: ['turn'],
        done: (_s, c, g) => c.heading !== g.startHeading && !c.turning },
    ],
    passText: 'Slowed, sped up, braked and turned',
    stars: [
      { text: 'No stall warning', met: m => !m.stalled },
      { text: 'Done inside 100 seconds', met: m => m.seconds <= 100 },
    ],
    failIf: (_s, c) => (c.landed ? 'Down on the ground before the lesson was done' : null),
    takeaway: 'Throttle sets your speed; the airbrakes are for when you need it gone quickly.',
  },

  landing: {
    id: 'landing', n: 3, title: 'Landing & flaps',
    blurb: 'Work the flaps yourself, ride the glide path and put her down on the strip.',
    routeKm: 6,
    start: { kind: 'air', atKm: -2.8, altitude: 180, overStall: 1.9, throttle: 0.6 },
    autoFlaps: false,
    hud: ['speed', 'alt', 'thr', 'flaps', 'gear'],
    world: { mast: false, town: false, guns: false },
    goals: [
      { id: 'power', text: () => 'Power back to about a third', keys: ['throttleDown'], focus: 'thr',
        done: s => s.throttle <= 0.4 },
      { id: 'flap1', text: c => `Flaps: first notch — it comes out below ${c.flapLimitKmh[1]} km/h; the gauge shows the limit`,
        keys: ['flaps'], focus: 'flaps', done: s => (s.flapStage ?? 0) >= 1 },
      { id: 'flap2', text: c => `Second notch below ${c.flapLimitKmh[2]} km/h`, keys: ['flaps'], focus: 'flaps',
        done: s => (s.flapStage ?? 0) >= 2 },
      { id: 'gear', text: () => 'Gear down', keys: ['gear'], focus: 'gear',
        skip: c => !c.retractableGear, done: s => s.gearDown },
      { id: 'full', text: c => `Full flap below ${c.flapLimitKmh[3]} km/h — the last notch is mostly drag`,
        keys: ['flaps'], focus: 'flaps', done: s => (s.flapStage ?? 0) >= 3 },
      { id: 'path', text: () => 'Ride the dotted path down — two white, two red lights', focus: 'alt',
        done: (s, c) => s.altitude < 12 || c.landed },
      { id: 'flare', text: () => 'Just before the wheels touch, ease the nose up', keys: ['noseUp'],
        done: (_s, c) => c.landed },
      { id: 'stop', text: () => 'Let her roll to a stop', done: (_s, c) => c.stopped },
    ],
    passText: 'Down and stopped on the strip',
    stars: [
      { text: 'A good landing or better', met: m => m.landing === 'good' || m.landing === 'perfect' },
      { text: 'A perfect landing', met: m => m.landing === 'perfect' },
    ],
    failIf: (_s, c) => (c.landed && !c.onRunway ? 'Down, but not on the strip' : null),
    takeaway: 'On contracts the flaps set themselves — F and V take them over any time.',
  },
};

/** The lessons that exist, in order. */
export function lessonList(): LessonDef[] {
  return LESSON_ORDER.map(id => LESSONS[id]).filter((l): l is LessonDef => !!l);
}

export function nextLessonId(id: LessonId): LessonId | null {
  const list = lessonList();
  const i = list.findIndex(l => l.id === id);
  return i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
}

/** A lesson opens once the one before it has a star. */
export function lessonUnlocked(id: LessonId, stars: Record<string, number>): boolean {
  const list = lessonList();
  const i = list.findIndex(l => l.id === id);
  return i <= 0 || (stars[list[i - 1].id] ?? 0) > 0;
}

/**
 * Contracts open once every lesson has a star. A pilot who was already
 * flying contracts before flight school changed is not sent back to school.
 */
export function schoolDone(stats: PlayerStats): boolean {
  if (stats.totalFlights > 0 || stats.trainingDone) return true;
  const stars = stats.lessonStars ?? {};
  return lessonList().every(l => (stars[l.id] ?? 0) > 0);
}

/** Keep the best result; a lesson pays once, the first time it is passed. */
export function recordLesson(
  prev: Record<string, number>, id: LessonId, stars: number,
): { stars: Record<string, number>; firstPass: boolean } {
  const had = prev[id] ?? 0;
  return { stars: { ...prev, [id]: Math.max(had, stars) }, firstPass: had === 0 && stars > 0 };
}
