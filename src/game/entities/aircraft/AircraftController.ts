import type { AircraftDefinition, FlightState } from '../../../types';
import { clamp, lerp } from '../../utils/math';

const GRAVITY = 9.81;        // m/s²
const AIR_DENSITY = 1.225;   // kg/m³ at sea level (simplified, non-varying)
const LIFT_COEFFICIENT = 0.4;
const DRAG_COEFFICIENT = 0.03;
const DT = 1 / 60;           // seconds per update tick (60 Hz)

// Controls input snapshot
export interface FlightInput {
  throttleUp: boolean;
  throttleDown: boolean;
  pitchUp: boolean;
  pitchDown: boolean;
  toggleGear: boolean;
  toggleFlaps: boolean;
}

export class AircraftController {
  private def: AircraftDefinition;

  constructor(definition: AircraftDefinition) {
    this.def = definition;
  }

  initialState(): FlightState {
    const { stats } = this.def;
    return {
      throttle: 0,
      pitch: 0,
      speed: 0,
      altitude: 0,
      verticalSpeed: 0,
      heading: 0,
      fuel: stats.fuelCapacity,
      engineTemp: 0.2,
      integrity: 100,
      gearDown: true,
      flapsDeployed: false,
      distanceTravelled: 0,
      elapsedSeconds: 0,
    };
  }

  update(state: FlightState, input: FlightInput): FlightState {
    const next = { ...state };
    const { stats } = this.def;

    // Throttle
    if (input.throttleUp)   next.throttle = clamp(state.throttle + 0.01, 0, 1);
    if (input.throttleDown) next.throttle = clamp(state.throttle - 0.01, 0, 1);

    // Pitch
    const pitchRate = 1.2; // degrees per tick
    if (input.pitchUp)   next.pitch = clamp(state.pitch - pitchRate, -30, 30);
    if (input.pitchDown) next.pitch = clamp(state.pitch + pitchRate, -30, 30);

    // Gear / flaps toggles are handled as one-shots in FlightScene

    // Effective thrust — degraded by engine temp damage and flaps drag
    const thrustForce = state.throttle * (stats.maxSpeed / 3.6) * (1 - state.engineTemp * 0.3);

    // Simplified lift/drag model
    const pitchRad = (state.pitch * Math.PI) / 180;
    const liftForce = LIFT_COEFFICIENT * state.speed * Math.sin(pitchRad + 0.1);
    const dragForce = DRAG_COEFFICIENT * state.speed ** 2;
    const flapsDrag = state.flapsDeployed ? 0.015 * state.speed ** 2 : 0;

    // Net acceleration (m/s²)
    const accel = thrustForce - dragForce - flapsDrag;
    next.speed = clamp(state.speed + accel * DT, 0, stats.maxSpeed / 3.6);

    // Vertical speed from lift vs gravity
    const netVertical = liftForce - GRAVITY;
    next.verticalSpeed = lerp(state.verticalSpeed, netVertical * 8, 0.05);
    next.altitude = clamp(state.altitude + next.verticalSpeed * DT, 0, stats.maxAltitude);

    // Stall: if below stall speed and airborne, drop faster
    const stallMs = stats.stallSpeed / 3.6;
    if (state.altitude > 0 && next.speed < stallMs) {
      next.verticalSpeed = Math.min(next.verticalSpeed - 2 * DT, -5);
      next.altitude = clamp(next.altitude + next.verticalSpeed * DT, 0, stats.maxAltitude);
    }

    // Fuel consumption
    const burnRate = stats.fuelBurnRate * state.throttle;
    next.fuel = clamp(state.fuel - (burnRate / 60) * DT, 0, stats.fuelCapacity);

    // Engine temp rises with throttle, falls over time
    const tempTarget = state.throttle * 0.9;
    next.engineTemp = lerp(state.engineTemp, tempTarget, 0.002);

    // Structural: overspeed and gear-down at speed damage integrity
    if (next.speed > (stats.maxSpeed / 3.6) * 0.95) {
      next.integrity = clamp(state.integrity - 0.05, 0, 100);
    }
    if (state.gearDown && next.speed > 100 / 3.6 && state.altitude > 5) {
      next.integrity = clamp(state.integrity - 0.02, 0, 100);
    }

    // Distance
    next.distanceTravelled = state.distanceTravelled + next.speed * DT / 1000;
    next.elapsedSeconds = state.elapsedSeconds + DT;

    return next;
  }
}
