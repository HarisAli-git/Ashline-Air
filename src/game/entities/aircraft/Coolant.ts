import type { FlightState } from '../../../types';
import { clamp } from '../../utils/math';

/**
 * The emergency coolant charge.
 *
 * It used to be one answer in a popup that stopped the flight to ask — the
 * one answer anybody ever wanted. Now it is the pilot's own call: one charge
 * a flight, fired whenever the engine is cooking, and it costs a little
 * plumbing every time.
 */

/** Engine temperature above which the charge does anything — and the ENG readout shows. */
export const COOLANT_HOT = 0.72;
const COOLED_TO = 0.4;
const HULL_COST = 2;

export function tryDumpCoolant(
  state: FlightState, left: number,
): { state: FlightState; left: number; result: 'dumped' | 'not-hot' | 'empty' } {
  if (left <= 0) return { state, left: 0, result: 'empty' };
  // Never wasted on a cool engine: it is the one charge you get
  if (state.engineTemp <= COOLANT_HOT) return { state, left, result: 'not-hot' };
  return {
    state: { ...state, engineTemp: COOLED_TO, integrity: clamp(state.integrity - HULL_COST, 0, 100) },
    left: left - 1,
    result: 'dumped',
  };
}
