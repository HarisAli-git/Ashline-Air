/**
 * On-screen flight controls → the flight model.
 *
 * The controls themselves are React (they need to be crisp, hit-testable DOM
 * with safe-area awareness), but FlightScene must not know that. This module is
 * the seam: React writes, the scene reads, and the scene's input line stays a
 * plain OR against the keyboard so both work at once — a tablet with a
 * Bluetooth keyboard is not an either/or.
 */

export type HeldControl = 'pitchUp' | 'pitchDown' | 'throttleUp' | 'throttleDown';
export type PulseControl = 'engine' | 'gear' | 'flaps' | 'time' | 'mute' | 'abort';

const held: Record<HeldControl, boolean> = {
  pitchUp: false, pitchDown: false, throttleUp: false, throttleDown: false,
};

/** Pulses are consumed exactly once, the same contract as `JustDown`. */
const pulses = new Set<PulseControl>();

/**
 * Absolute throttle demand from the slider, or null when the player is not
 * touching it. FlightScene converts this into the same up/down the keyboard
 * produces, so the engine still spools at its own rate rather than snapping —
 * the lever moves instantly, the engine does not.
 */
let throttleTarget: number | null = null;

export const TouchInput = {
  setHeld(control: HeldControl, down: boolean): void { held[control] = down; },
  isHeld(control: HeldControl): boolean { return held[control]; },

  pulse(control: PulseControl): void { pulses.add(control); },
  /** True once per pulse, then false until the control is pressed again. */
  consume(control: PulseControl): boolean {
    if (!pulses.has(control)) return false;
    pulses.delete(control);
    return true;
  },

  setThrottleTarget(v: number | null): void {
    throttleTarget = v === null ? null : Math.min(1, Math.max(0, v));
  },
  getThrottleTarget(): number | null { return throttleTarget; },

  /** Called when a flight ends, so a held button cannot leak into the next one. */
  reset(): void {
    (Object.keys(held) as HeldControl[]).forEach(k => { held[k] = false; });
    pulses.clear();
    throttleTarget = null;
  },
};
