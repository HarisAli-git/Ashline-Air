/**
 * Flaps that set themselves.
 *
 * Four notches, a limit speed for each and a "held back" state are a lot to
 * hand someone on their first flight, and getting them wrong is how a new
 * pilot floats off the end of the strip. So by default the flaps do what a
 * good first officer would: the take-off notch on the runway, up once the
 * aeroplane is clear of the ground and flying, and all the way down on the
 * approach — where the flap model's load relief lets each notch out only as
 * the speed comes off, which is the notch-by-notch schedule for free.
 *
 * Touching F or V hands them back to the pilot (see FlightScene).
 */

/** How far out the approach begins, km, and the height below which it counts. */
const APPROACH_KM = 2.5;
const APPROACH_TOP_M = 200;
/** Clean up above this height, once faster than CLEAN_UP_SPEED × clean stall. */
const CLEAN_UP_M = 25;
const CLEAN_UP_SPEED = 1.35;

export interface AutoFlapInput {
  onGround: boolean;
  /** Has left the ground at least once this flight. */
  hasFlown: boolean;
  altitude: number;
  /** Equivalent airspeed over the clean 1g stall speed. */
  speedRatio: number;
  verticalSpeed: number;
  throttle: number;
  /** Distance to the destination strip, km. */
  stripKm: number;
  towardStrip: boolean;
  takeoffStage: number;
  stage: number;
}

/** The flap notch the aeroplane should be on now. */
export function autoFlapStage(i: AutoFlapInput): number {
  if (i.onGround) return i.hasFlown ? i.stage : i.takeoffStage;
  const approach = i.stripKm <= APPROACH_KM && i.towardStrip && i.altitude < APPROACH_TOP_M;
  if (approach) {
    // Going around: power on and climbing — take some off, keep some lift
    const goingAround = i.throttle > 0.85 && i.verticalSpeed > 1;
    return goingAround ? 1 : 3;
  }
  if (i.altitude > CLEAN_UP_M && i.speedRatio > CLEAN_UP_SPEED) return 0;
  return i.stage;
}
