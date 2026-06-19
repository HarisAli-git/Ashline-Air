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
  choices: EventChoice[];
  tags: string[];               // e.g. ['engine', 'weather', 'passenger']
}

export interface EventChoice {
  id: string;
  label: string;
  consequences: EventConsequence[];
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
