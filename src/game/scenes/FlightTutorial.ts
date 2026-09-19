import type { FlightState } from '../../types';

/**
 * The first flight, taught by flying it.
 *
 * A new player was dropped onto an apron with a cold engine, a throttle lever,
 * a stick, gear, flaps, a time warp and a fuel projection, and told none of it.
 * The keyboard legend along the bottom lists the keys but explains nothing
 * about WHEN to use any of them, which is the part that actually matters.
 *
 * So this is not a wall of text before the game: it is one line at a time,
 * each tied to a real condition, and it advances only when you have actually
 * done the thing. Nothing is on a timer and nothing can be failed — if you
 * ignore a step it simply waits, and if you do the next thing first it skips
 * ahead. It runs once, on the first flight of a save.
 */

export interface TutorialStep {
  id: string;
  /** What to tell the player. Keep it to one line. */
  text: string;
  /** Same thing for a touch device, where the keys do not exist. */
  touch?: string;
  /** True once the player has done it. */
  done: (s: FlightState, ctx: TutorialContext) => boolean;
  /** Optional: skip the step entirely when it does not apply. */
  skip?: (s: FlightState, ctx: TutorialContext) => boolean;
}

export interface TutorialContext {
  /** False on the crop duster and the bush plane — both sit on fixed legs. */
  retractableGear: boolean;
  engineRunning: boolean;
  loadingLeft: number;
  remainingKm: number;
  underFire: boolean;
  airborne: boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'loading',
    text: 'The crew are loading your cargo. Give them a moment.',
    done: (_s, c) => c.loadingLeft <= 0,
  },
  {
    id: 'start',
    text: 'Press E to turn the engine over. It takes a couple of seconds to catch.',
    touch: 'Tap ▶ START. The engine takes a couple of seconds to catch.',
    done: (_s, c) => c.engineRunning,
  },
  {
    id: 'throttle',
    text: 'Hold W to open the throttle all the way.',
    touch: 'Drag the throttle lever on the left all the way up.',
    done: s => s.throttle > 0.9,
  },
  {
    id: 'rotate',
    text: 'Let her build speed, then hold S to raise the nose and fly her off.',
    touch: 'Let her build speed, then hold NOSE UP to fly her off.',
    done: s => s.altitude > 25,
  },
  {
    /*
     * Two versions, because two of the four aircraft are on fixed legs.
     * Telling a crop-duster pilot to raise the gear is telling them to do
     * something the aeroplane physically cannot do — and it is the first
     * instruction a new player is ever given, so it teaches them that the
     * game does not know what it is talking about.
     */
    id: 'clean',
    text: 'Flaps up with F once you are climbing away — they are pure drag now.',
    touch: 'Tap FLAP to bring them up once you are climbing away — pure drag now.',
    done: s => !s.flapsDeployed,
    skip: (_s, c) => c.retractableGear,
  },
  {
    id: 'clean-retract',
    text: 'Gear up with G and flaps up with F — both are pure drag once you are flying.',
    touch: 'Tap GEAR and FLAP to bring them up — both are pure drag once you are flying.',
    done: s => !s.gearDown && !s.flapsDeployed,
    skip: (_s, c) => !c.retractableGear,
  },
  {
    id: 'cruise',
    text: 'Ease the nose down and hold about 150 m. Watch ARR: that is the fuel you will land with.',
    touch: 'Ease the nose down and hold about 150 m. Watch ARR: that is the fuel you will land with.',
    // Level-ish flight at a sensible height, for a moment
    done: s => s.altitude > 90 && s.altitude < 320 && Math.abs(s.verticalSpeed) < 4,
  },
  {
    id: 'threats',
    text: 'Raiders hold stretches of this route. Climb above their guns, or keep changing height so they cannot range you.',
    touch: 'Raiders hold stretches of this route. Climb above their guns, or keep changing height.',
    // Only worth saying if they are actually going to meet some
    done: (_s, c) => c.remainingKm < 6,
    skip: (_s, c) => c.remainingKm < 6,
  },
  {
    id: 'approach',
    text: 'Destination ahead. Throttle back, gear down with G, flaps with F, and aim to touch down gently on the strip.',
    touch: 'Destination ahead. Throttle back, GEAR down, FLAP down, and touch down gently on the strip.',
    done: s => s.gearDown && s.altitude < 40,
    skip: (_s, c) => !c.retractableGear,
  },
  {
    id: 'approach-fixed',
    text: 'Destination ahead. Throttle back, flaps down with F, and aim to touch down gently on the strip.',
    touch: 'Destination ahead. Throttle back, FLAP down, and touch down gently on the strip.',
    done: s => s.altitude < 40,
    skip: (_s, c) => c.retractableGear,
  },
];

/**
 * Walks the step list. Deliberately forgiving: a step whose condition is
 * already true when it comes up is passed over immediately, so a player who
 * works it out for themselves never gets nagged about something they have
 * already done.
 */
export class FlightTutorial {
  private index = 0;
  private finished = false;

  get active(): boolean { return !this.finished; }

  /** The line to show right now, or null when there is nothing to say. */
  update(s: FlightState, ctx: TutorialContext, touch: boolean): string | null {
    if (this.finished) return null;
    // Advance past everything already satisfied — including steps the player
    // completed out of order.
    let guard = 0;
    while (this.index < TUTORIAL_STEPS.length && guard++ < TUTORIAL_STEPS.length + 1) {
      const step = TUTORIAL_STEPS[this.index];
      if (step.skip?.(s, ctx) || step.done(s, ctx)) { this.index++; continue; }
      return (touch && step.touch) || step.text;
    }
    this.finished = true;
    return null;
  }
}
