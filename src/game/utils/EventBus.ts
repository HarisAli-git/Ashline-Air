import type { FlightState, LandingResult, Contract, FlightEventDefinition, WeatherState } from '../../types';

/**
 * Typed event map for all cross-system communication.
 * Adding a new event: declare it here, then emit/on with full type safety.
 */
export interface GameEvents {
  // Scene transitions
  'scene:start-flight': { contractId: string };
  'scene:flight-complete': { result: LandingResult; contractId: string };
  'scene:return-to-map': void;
  'scene:open-preflight': { settlementId: string };

  // Flight runtime
  'flight:state-update': FlightState;
  'flight:event-triggered': { event: FlightEventDefinition };
  'flight:event-choice': { eventId: string; choiceId: string };
  'flight:apply-event-choice': { choiceId: string };
  'flight:fuel-critical': { fuelRemaining: number };
  'flight:gear-toggled': { down: boolean };
  'flight:flaps-toggled': { deployed: boolean };

  // Weather
  'weather:changed': { state: WeatherState };

  // Cargo
  'flight:cargo-update': { average: number; count: number };

  // Economy
  'economy:tick': { gameTimestamp: number };
  'economy:price-changed': { settlementId: string; goodId: string; newPrice: number };

  // Contracts
  'contract:accepted': { contract: Contract };
  'contract:completed': { contractId: string };
  'contract:failed': { contractId: string; reason: string };
  'contract:board-refreshed': void;

  // Player
  'player:money-changed': { amount: number; delta: number };
  'player:reputation-changed': { factionId: string; delta: number; total: number };
  'player:aircraft-damaged': { delta: number; newIntegrity: number };

  // Save
  'save:saved': void;
  'save:loaded': void;

  // UI
  'ui:show-notification': { message: string; type: 'info' | 'warning' | 'danger' | 'success' };
  'ui:show-event-modal': { event: FlightEventDefinition };
  'ui:close-event-modal': void;
}

type EventHandler<T> = T extends void ? () => void : (payload: T) => void;

class TypedEventBus {
  private listeners = new Map<string, Set<Function>>();

  on<K extends keyof GameEvents>(event: K, handler: EventHandler<GameEvents[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof GameEvents>(event: K, handler: EventHandler<GameEvents[K]>): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit<K extends keyof GameEvents>(
    event: K,
    ...args: GameEvents[K] extends void ? [] : [GameEvents[K]]
  ): void {
    this.listeners.get(event)?.forEach(h => h(...args));
  }

  once<K extends keyof GameEvents>(event: K, handler: EventHandler<GameEvents[K]>): void {
    const wrapper = (...args: any[]) => {
      (handler as Function)(...args);
      this.off(event, wrapper as EventHandler<GameEvents[K]>);
    };
    this.on(event, wrapper as EventHandler<GameEvents[K]>);
  }
}

// Singleton — one bus for the entire application lifetime
export const EventBus = new TypedEventBus();
