export type EventTrigger =
  | 'on_altitude_low'
  | 'on_altitude_high'
  | 'on_speed_low'
  | 'on_speed_high'
  | 'on_engine_temp_high'
  | 'on_fuel_low'
  | 'on_time_elapsed'
  | 'on_weather_change'
  | 'random';

export interface FlightEventDefinition {
  id: string;
  title: string;
  description: string;
  trigger: EventTrigger;
  triggerThreshold?: number;    // value for threshold triggers
  probability: number;          // 0–1, checked when trigger fires
  cooldownSeconds: number;      // minimum seconds between same event
  outcome: EventOutcome;
  tags: string[];               // e.g. ['engine', 'weather', 'passenger']
}

/**
 * What an event does. One fixed result, no menu: the events used to stop the
 * flight and ask, and almost every answer was "lose some hull". Now the thing
 * just happens, and a caution chip says what it cost.
 */
export interface EventOutcome {
  consequences: EventConsequence[];
  /** The caution chip's text. */
  caution: string;
  /** How long the chip stays up, seconds. 0 = for the rest of the flight. */
  cautionSeconds: number;
}

export interface EventConsequence {
  type: ConsequenceType;
  target: string;  // which stat/variable is affected
  value: number;   // delta or absolute, depending on type
  description: string;
}

export type ConsequenceType =
  | 'delta'      // add value to current
  | 'multiply'   // multiply current by value
  | 'set'        // set to exact value
  | 'add_cargo_damage'
  | 'add_money'
  | 'add_reputation';
