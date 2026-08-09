// Runtime flight state — not persisted, rebuilt each flight
export interface FlightState {
  throttle: number;       // 0–1
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
