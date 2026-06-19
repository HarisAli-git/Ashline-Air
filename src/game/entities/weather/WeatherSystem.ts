import Phaser from 'phaser';
import type { WeatherState, WeatherCondition } from '../../../types';
import { randomBetween, clamp } from '../../utils/math';
import { EventBus } from '../../utils/EventBus';

const CHANGE_INTERVAL_SECONDS = 120; // time between potential weather shifts

export class WeatherSystem {
  private scene: Phaser.Scene;
  private state: WeatherState;
  private timeSinceChange = 0;
  private particles: Phaser.GameObjects.Particles.ParticleEmitter | null = null;

  constructor(scene: Phaser.Scene, initial?: Partial<WeatherState>) {
    this.scene = scene;
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

  update(delta: number): void {
    this.timeSinceChange += delta / 1000;

    if (this.timeSinceChange >= CHANGE_INTERVAL_SECONDS && Math.random() < 0.15) {
      this.changeWeather();
      this.timeSinceChange = 0;
    }

    // Drift wind
    this.state.windSpeed = clamp(
      this.state.windSpeed + randomBetween(-0.5, 0.5),
      0, 25
    );
    this.state.windDirection = (this.state.windDirection + randomBetween(-2, 2) + 360) % 360;
  }

  private changeWeather(): void {
    const options: WeatherCondition[] = ['clear', 'cloudy', 'dust_storm', 'strong_winds'];
    const weights = [0.5, 0.25, 0.15, 0.1];

    const roll = Math.random();
    let cumulative = 0;
    let chosen: WeatherCondition = 'clear';
    for (let i = 0; i < options.length; i++) {
      cumulative += weights[i];
      if (roll < cumulative) { chosen = options[i]; break; }
    }

    if (chosen === this.state.condition) return;

    this.state.condition = chosen;
    this.state.visibility = this.getVisibility(chosen);
    this.state.turbulenceIntensity = this.getTurbulence(chosen);

    EventBus.emit('ui:show-notification', {
      message: `Weather changing: ${chosen.replace('_', ' ')}`,
      type: chosen === 'dust_storm' ? 'warning' : 'info',
    });

    EventBus.emit('flight:event-triggered', {
      // trigger external weather events
      event: { id: '__weather__', trigger: 'on_weather_change' } as any,
    });
  }

  private getVisibility(condition: WeatherCondition): number {
    const map: Record<WeatherCondition, number> = {
      clear: 1, cloudy: 0.8, dust_storm: 0.3, thunderstorm: 0.5,
      fog: 0.2, blizzard: 0.15, strong_winds: 0.9,
    };
    return map[condition];
  }

  private getTurbulence(condition: WeatherCondition): number {
    const map: Record<WeatherCondition, number> = {
      clear: 0, cloudy: 0.1, dust_storm: 0.6, thunderstorm: 0.8,
      fog: 0.1, blizzard: 0.7, strong_winds: 0.5,
    };
    return map[condition];
  }

  /** Returns wind force vector in m/s components */
  windVector(): { x: number; y: number } {
    const rad = (this.state.windDirection * Math.PI) / 180;
    return {
      x: Math.cos(rad) * this.state.windSpeed,
      y: Math.sin(rad) * this.state.windSpeed,
    };
  }
}
