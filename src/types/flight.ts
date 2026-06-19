// Runtime flight state — not persisted, rebuilt each flight
export interface FlightState {
  throttle: number;       // 0–1
  pitch: number;          // degrees, positive = nose up
  speed: number;          // m/s
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
