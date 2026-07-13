import type { FlightEventDefinition, FlightState, EventConsequence, AircraftDefinition } from '../types';
import { EventBus } from '../game/utils/EventBus';
import { SaveService } from './SaveService';
import { clamp } from '../game/utils/math';

interface ActiveEvent {
  event: FlightEventDefinition;
  lastFiredAt: number; // elapsed seconds in flight
}

class FlightEventServiceClass {
  private definitions: FlightEventDefinition[] = [];
  private activeEvents: ActiveEvent[] = [];
  private pendingChoice: FlightEventDefinition | null = null;

  // Active aircraft stats so triggers scale to the airframe being flown
  private fuelCapacity = 80;
  private vCruise = 36;  // m/s
  private vMax = 50;     // m/s

  /** FlightScene calls this when an event damages the cargo hold. */
  onCargoDamage: ((amount: number) => void) | null = null;

  initialise(definitions: FlightEventDefinition[]): void {
    this.definitions = definitions;
  }

  reset(def?: AircraftDefinition): void {
    this.activeEvents = [];
    this.pendingChoice = null;
    this.onCargoDamage = null;
    if (def) {
      this.fuelCapacity = def.stats.fuelCapacity;
      this.vCruise = def.stats.cruiseSpeed / 3.6;
      this.vMax = def.stats.maxSpeed / 3.6;
    }
  }

  checkEvents(state: FlightState): FlightEventDefinition | null {
    if (this.pendingChoice) return null; // one event at a time

    for (const def of this.definitions) {
      if (def.trigger === 'on_weather_change') continue; // fired via checkWeatherEvents
      if (!this.shouldTrigger(def, state)) continue;
      if (Math.random() > def.probability) continue;
      if (this.tryFire(def, state.elapsedSeconds)) return def;
    }

    return null;
  }

  /** Called when the WeatherSystem announces a condition change. */
  checkWeatherEvents(state: FlightState): FlightEventDefinition | null {
    if (this.pendingChoice) return null;

    for (const def of this.definitions) {
      if (def.trigger !== 'on_weather_change') continue;
      if (Math.random() > def.probability) continue;
      if (this.tryFire(def, state.elapsedSeconds)) return def;
    }

    return null;
  }

  /** Cooldown-gated firing shared by all trigger paths. */
  private tryFire(def: FlightEventDefinition, elapsed: number): boolean {
    const tracked = this.activeEvents.find(e => e.event.id === def.id);
    if (tracked && elapsed - tracked.lastFiredAt < def.cooldownSeconds) return false;

    if (tracked) {
      tracked.lastFiredAt = elapsed;
    } else {
      this.activeEvents.push({ event: def, lastFiredAt: elapsed });
    }

    this.pendingChoice = def;
    // FlightScene listens for this, plays the event's visual cinematic
    // (bird flock, fuel mist, …), then opens the modal itself.
    EventBus.emit('flight:event-triggered', { event: def });
    return true;
  }

  applyChoice(choiceId: string, state: FlightState): FlightState {
    if (!this.pendingChoice) return state;

    const choice = this.pendingChoice.choices.find(c => c.id === choiceId);
    if (!choice) return state;

    const eventId = this.pendingChoice.id;
    this.pendingChoice = null;

    let next = { ...state };
    for (const consequence of choice.consequences) {
      next = this.applyConsequence(next, consequence);
    }

    EventBus.emit('flight:event-choice', { eventId, choiceId });
    EventBus.emit('ui:close-event-modal');
    return next;
  }

  private shouldTrigger(def: FlightEventDefinition, state: FlightState): boolean {
    switch (def.trigger) {
      case 'random':
        // Checked once per second; probability is already low
        return true;
      case 'on_engine_temp_high':
        return state.engineTemp >= (def.triggerThreshold ?? 0.8);
      case 'on_fuel_low':
        return state.fuel <= (def.triggerThreshold ?? 0.4) * this.fuelCapacity;
      case 'on_speed_low':
        return state.speed <= (def.triggerThreshold ?? 0.5) * this.vCruise;
      case 'on_speed_high':
        return state.speed >= (def.triggerThreshold ?? 0.9) * this.vMax;
      case 'on_altitude_low':
        return state.altitude <= (def.triggerThreshold ?? 100);
      case 'on_altitude_high':
        return state.altitude >= (def.triggerThreshold ?? 3000);
      case 'on_weather_change':
        return false; // fired externally by WeatherSystem
      case 'on_time_elapsed':
        return state.elapsedSeconds >= (def.triggerThreshold ?? 60);
      default:
        return false;
    }
  }

  private applyConsequence(state: FlightState, c: EventConsequence): FlightState {
    const next = { ...state, modifiers: { ...state.modifiers } };

    // Consequences that act on the player/world rather than the flight state
    if (c.type === 'add_money') {
      const save = SaveService.get();
      save.player.money = Math.max(0, save.player.money + c.value);
      SaveService.save(save.player, save.world);
      EventBus.emit('player:money-changed', { amount: save.player.money, delta: c.value });
      return next;
    }
    if (c.type === 'add_reputation') {
      const save = SaveService.get();
      const rep = save.player.reputation.find(r => r.factionId === c.target);
      if (rep) {
        rep.points = clamp(rep.points + c.value, 0, 1000);
        SaveService.save(save.player, save.world);
        EventBus.emit('player:reputation-changed', {
          factionId: c.target, delta: c.value, total: rep.points,
        });
      }
      return next;
    }
    if (c.type === 'add_cargo_damage') {
      this.onCargoDamage?.(c.value);
      return next;
    }

    // fuelBurnRate isn't part of FlightState — it routes to the burn multiplier
    if (c.target === 'fuelBurnRate') {
      switch (c.type) {
        case 'multiply': next.modifiers.fuelBurnMult *= c.value; break;
        case 'delta':    next.modifiers.fuelBurnMult += c.value; break;
        case 'set':      next.modifiers.fuelBurnMult  = c.value; break;
      }
      next.modifiers.fuelBurnMult = clamp(next.modifiers.fuelBurnMult, 0.2, 5);
      return next;
    }

    const target = c.target as keyof FlightState;
    if (!(target in next)) return next;

    const current = next[target];
    if (typeof current !== 'number') return next;

    const numericNext = next as unknown as Record<string, number>;

    switch (c.type) {
      case 'delta':    numericNext[target as string] = current + c.value; break;
      case 'multiply': numericNext[target as string] = current * c.value; break;
      case 'set':      numericNext[target as string] = c.value;           break;
    }

    // Clamp common fields
    if (target === 'engineTemp') next.engineTemp = clamp(next.engineTemp, 0, 1);
    if (target === 'integrity')  next.integrity  = clamp(next.integrity, 0, 100);
    if (target === 'fuel')       next.fuel        = clamp(next.fuel, 0, Infinity);
    if (target === 'throttle')   next.throttle    = clamp(next.throttle, 0, 1);

    return next;
  }
}

export const FlightEventService = new FlightEventServiceClass();
