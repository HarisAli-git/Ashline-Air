export type WeatherCondition =
  | 'clear'
  | 'cloudy'
  | 'dust_storm'
  | 'thunderstorm'
  | 'fog'
  | 'blizzard'
  | 'strong_winds';

export interface WeatherState {
  condition: WeatherCondition;
  windSpeed: number;        // m/s
  windDirection: number;    // degrees, 0=right, 90=up
  visibility: number;       // 0–1
  turbulenceIntensity: number; // 0–1
}
