import { isTouchDevice } from './device';

/**
 * How to name a control in text, for whatever the player is actually holding.
 *
 * Messages used to say "press E" and "hold E to restart" everywhere — on a
 * phone there is no E, and on a tablet the HUD still said HOLD E because the
 * wording keyed off screen size rather than input. (It was not even right on
 * a keyboard: the starter is a single press.) Every line that names a control
 * goes through here, so a finger gets told about the button it can see.
 */
export type ControlAction = 'engine' | 'drop' | 'time' | 'flaps' | 'flapsUp' | 'gear' | 'airbrake' | 'turn' | 'throttleUp' | 'throttleDown' | 'noseUp' | 'noseDown';

const NAMES: Record<ControlAction, [key: string, touch: string]> = {
  engine: ['E', 'START'],
  drop: ['SPACE', 'DROP'],
  time: ['T', 'TIME'],
  flaps: ['F', 'FLAP ▼'],
  flapsUp: ['V', 'FLAP ▲'],
  gear: ['G', 'GEAR'],
  airbrake: ['B', 'AIRBRAKE'],
  turn: ['R', 'TURN'],
  throttleUp: ['W', 'the lever up'],
  throttleDown: ['S', 'the lever down'],
  noseUp: ['A', 'NOSE UP'],
  noseDown: ['D', 'NOSE DN'],
};

/** The key, or the on-screen button, for an action. */
export function ctl(action: ControlAction): string {
  return isTouchDevice() ? NAMES[action][1] : NAMES[action][0];
}

/** "press E" / "tap START". */
export function press(action: ControlAction): string {
  return `${isTouchDevice() ? 'tap' : 'press'} ${ctl(action)}`;
}
