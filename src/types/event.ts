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
  | 'add_reputation'
  /**
   * Something the FLIGHT actually does — see `FlightAction`.
   *
   * Everything above only pokes a number. That is why choices like "Divert to
   * the nearest settlement" and "Detour around the storm" read as doing
   * nothing: the label described a manoeuvre and the game quietly adjusted a
   * stat and carried on exactly as before. A choice that names an action has
   * to perform it.
   */
  | 'action';

/** Actions a flight event choice can actually carry out. */
export type FlightAction =
  /** Break off and put down short: the report reads DIVERTED, contract stays. */
  | 'divert'
  /** You got above/around it — the current weather actually stops. */
  | 'clear_weather'
  /** Going around costs distance: the route really does get longer. */
  | 'extend_route'
  /** Firewall it — the throttle lever actually moves. */
  | 'full_power'
  /** Put it on the deck: a real, immediate descent. */
  | 'descend';
