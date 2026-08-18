import type { WeatherState, WeatherCondition } from '../../../types';
import { randomBetween, clamp } from '../../utils/math';
import { EventBus } from '../../utils/EventBus';
import type { WeatherField } from '../../world/WeatherField';

const MIN_CHANGE_INTERVAL = 25;   // s before the weather can shift
const CHANGE_CHANCE_PER_SECOND = 0.035;
const SQUALL_CHANCE = 0.45;       // a change may be a short violent burst…
const SQUALL_CONDITIONS: WeatherCondition[] = ['dust_storm', 'strong_winds', 'thunderstorm', 'blizzard'];

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
  private squallLeft = 0;                       // seconds of squall remaining
  private preSquall: WeatherCondition | null = null;

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

  /**
   * The field of drifting cells that decides what the weather IS.
   *
   * When one is attached, this class stops rolling a global condition on a
   * timer and becomes a reader: it reports whatever the cell field says at the
   * aircraft's own position. Everything downstream — WeatherFX, the palettes,
   * WeatherHazards, the HUD — keeps consuming `current` exactly as before, so
   * the change is confined to where the condition COMES FROM.
   */
  private field: WeatherField | null = null;
  private forced: WeatherCondition | null = null;

  attachField(field: WeatherField): void {
    this.field = field;
    this.forced = null;
  }

  /**
   * @param pressure the Director's pacing budget, 0-1, handed straight to the
   *   cell field. Nothing else in the weather reads it.
   */
  update(deltaMs: number, worldX?: number, pressure?: number): void {
    const dt = deltaMs / 1000;
    this.timeSinceChange += dt;
    this.driftAccum += dt;

    // ── Field-driven: the weather is a place, and we are reading it ───────
    if (this.field && worldX !== undefined) {
      this.field.update(dt, worldX, pressure);
      while (this.driftAccum >= 1) {
        this.driftAccum -= 1;
        this.state.windSpeed = clamp(this.state.windSpeed + randomBetween(-0.5, 0.5), 0, 25);
        this.state.windDirection = (this.state.windDirection + randomBetween(-2, 2) + 360) % 360;
      }
      if (this.forced !== null) return;

      const s = this.field.sample(worldX);
      if (s.condition !== this.state.condition) this.applyCondition(s.condition);
      // Intensity scales the bite: the edge of a cell is not its middle.
      this.state.turbulenceIntensity = TURBULENCE[s.condition] * (0.35 + s.intensity * 0.65);
      this.state.visibility = 1 - (1 - VISIBILITY[s.condition]) * s.intensity;
      return;
    }

    // Wind drifts once per accumulated second — same rate at any frame rate
    while (this.driftAccum >= 1) {
      this.driftAccum -= 1;
      this.state.windSpeed = clamp(this.state.windSpeed + randomBetween(-0.5, 0.5), 0, 25);
      this.state.windDirection = (this.state.windDirection + randomBetween(-2, 2) + 360) % 360;

      // Squalls blow over on their own
      if (this.squallLeft > 0) {
        this.squallLeft -= 1;
        if (this.squallLeft <= 0 && this.preSquall !== null) {
          const back = this.preSquall;
          this.preSquall = null;
          this.applyCondition(back);
          EventBus.emit('ui:show-notification', { message: 'The squall blows itself out.', type: 'info' });
        }
        continue; // no new change while a squall is running
      }

      if (this.timeSinceChange >= MIN_CHANGE_INTERVAL && Math.random() < CHANGE_CHANCE_PER_SECOND) {
        if (Math.random() < SQUALL_CHANCE) {
          // …a sudden burst of violent weather that lasts seconds, not minutes
          const squall = SQUALL_CONDITIONS[Math.floor(Math.random() * SQUALL_CONDITIONS.length)];
          if (squall !== this.state.condition) {
            this.preSquall = this.state.condition;
            this.squallLeft = 9 + Math.random() * 10;
            this.applyCondition(squall);
          }
        } else {
          this.changeWeather();
        }
        this.timeSinceChange = 0;
      }
    }
  }

  /**
   * DEV helper — jump straight to a condition (weather debug keys).
   * Resets the change clock and cancels any squall, otherwise the natural
   * roll can flip straight back out of the forced condition a second later
   * and a debug key becomes a coin toss.
   */
  forceCondition(condition: WeatherCondition): void {
    // A forced condition must survive the field overwriting it every frame.
    this.forced = condition === 'clear' && this.field ? null : condition;
    this.squallLeft = 0;
    this.preSquall = null;
    this.timeSinceChange = 0;
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
