import type { WeatherState, WeatherCondition } from '../../../types';
import { randomBetween, clamp } from '../../utils/math';
import { EventBus } from '../../utils/EventBus';

const MIN_CHANGE_INTERVAL = 45;   // s before the weather can shift
const CHANGE_CHANCE_PER_SECOND = 0.012;

const WEIGHTS: Array<[WeatherCondition, number]> = [
  ['clear', 0.35],
  ['cloudy', 0.20],
  ['strong_winds', 0.12],
  ['dust_storm', 0.12],
  ['fog', 0.08],
  ['thunderstorm', 0.08],
  ['blizzard', 0.05],
];

const VISIBILITY: Record<WeatherCondition, number> = {
  clear: 1, cloudy: 0.8, dust_storm: 0.3, thunderstorm: 0.5,
  fog: 0.2, blizzard: 0.15, strong_winds: 0.9,
};

const TURBULENCE: Record<WeatherCondition, number> = {
  clear: 0, cloudy: 0.1, dust_storm: 0.6, thunderstorm: 0.8,
  fog: 0.1, blizzard: 0.7, strong_winds: 0.5,
};

/**
 * Pure weather model — visuals live in WeatherFX/ParallaxWorld, which react
 * to the typed 'weather:changed' event. Wind drift is accumulated per second
 * so it is frame-rate independent.
 */
export class WeatherSystem {
  private state: WeatherState;
  private timeSinceChange = 0;
  private driftAccum = 0;

  constructor(initial?: Partial<WeatherState>) {
    this.state = {
      condition: 'clear',
      windSpeed: randomBetween(0, 5),
      windDirection: randomBetween(0, 360),
      visibility: 1,
      turbulenceIntensity: 0,
      ...initial,
    };
  }

  get current(): WeatherState {
    return this.state;
  }

  /** Along-track wind component in m/s (+ = tailwind pushing the aircraft). */
  windX(): number {
    const rad = (this.state.windDirection * Math.PI) / 180;
    return Math.cos(rad) * this.state.windSpeed;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    this.timeSinceChange += dt;
    this.driftAccum += dt;

    // Wind drifts once per accumulated second — same rate at any frame rate
    while (this.driftAccum >= 1) {
      this.driftAccum -= 1;
      this.state.windSpeed = clamp(this.state.windSpeed + randomBetween(-0.5, 0.5), 0, 25);
      this.state.windDirection = (this.state.windDirection + randomBetween(-2, 2) + 360) % 360;

      if (this.timeSinceChange >= MIN_CHANGE_INTERVAL && Math.random() < CHANGE_CHANCE_PER_SECOND) {
        this.changeWeather();
        this.timeSinceChange = 0;
      }
    }
  }

  /** DEV helper — jump straight to a condition (weather debug keys). */
  forceCondition(condition: WeatherCondition): void {
    this.applyCondition(condition);
  }

  private changeWeather(): void {
    const roll = Math.random();
    let cumulative = 0;
    let chosen: WeatherCondition = 'clear';
    for (const [condition, weight] of WEIGHTS) {
      cumulative += weight;
      if (roll < cumulative) { chosen = condition; break; }
    }
    if (chosen === this.state.condition) return;
    this.applyCondition(chosen);
  }

  private applyCondition(condition: WeatherCondition): void {
    this.state.condition = condition;
    this.state.visibility = VISIBILITY[condition];
    this.state.turbulenceIntensity = TURBULENCE[condition];

    // Storms whip the wind up immediately
    if (condition === 'dust_storm' || condition === 'thunderstorm' || condition === 'strong_winds' || condition === 'blizzard') {
      this.state.windSpeed = clamp(this.state.windSpeed + randomBetween(4, 12), 0, 25);
    }

    EventBus.emit('ui:show-notification', {
      message: `Weather changing: ${condition.replace('_', ' ')}`,
      type: TURBULENCE[condition] >= 0.5 ? 'warning' : 'info',
    });
    EventBus.emit('weather:changed', { state: { ...this.state } });
  }
}
