// Runtime flight state — not persisted, rebuilt each flight
export interface FlightState {
  throttle: number;       // 0–1 — the LEVER position
  /**
   * Power the engine is actually delivering, 0–1, lagging the lever.
   *
   * A piston engine does not make full power the instant you shove the
   * throttle forward; it takes seconds to spool. Without this the model let
   * you dive, slam the lever and haul back with no penalty at all, which is
   * what made the aeroplane feel like a machine that could not be mishandled.
   */
  enginePower: number;
  /**
   * Wing loading in g, 1 = level flight. Read by the camera and the airframe
   * so a hard pull is something you can SEE, not just a number that changed.
   */
  loadFactor: number;
  pitch: number;          // degrees, positive = nose up
  pitchRate: number;      // deg/s — the nose has momentum, it is not a slider
  /**
   * Flight-path angle in RADIANS — the direction the aircraft is actually
   * travelling. This must be integrated as state: deriving it from vertical
   * speed and airspeed each frame makes a diving aircraft's path go
   * artificially shallow as it accelerates, which caps every descent.
   */
  flightPathAngle: number;
  speed: number;          // airspeed, m/s
  groundSpeed: number;    // m/s over ground (airspeed + wind component)
  altitude: number;       // metres
  verticalSpeed: number;  // m/s, positive = climbing
  heading: number;        // degrees
  fuel: number;           // litres remaining
  engineTemp: number;     // 0–1
  integrity: number;      // 0–100
  gearDown: boolean;
  flapsDeployed: boolean;
  distanceTravelled: number; // km
  elapsedSeconds: number;
  modifiers: FlightModifiers;
}

// Multipliers applied by in-flight events (fuel leaks, drag damage, …)
export interface FlightModifiers {
  fuelBurnMult: number;
  dragMult: number;
  /**
   * Multiplier on lift. Airframe icing drives this below 1, which raises the
   * stall speed without touching the airspeed indicator — the wing quietly
   * stops working at a speed that was comfortable a minute ago.
   */
  liftMult: number;
}

export interface LandingResult {
  verticalSpeed: number;  // m/s at touchdown
  horizontalSpeed: number;
  gearDown: boolean;
  quality: LandingQuality;
  integrityDamage: number;
  cargoDamagePercent: number;
}

export type LandingQuality = 'perfect' | 'good' | 'hard' | 'crash';
