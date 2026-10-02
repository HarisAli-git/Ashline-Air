import type { FlightState, LandingResult, Contract, FlightEventDefinition, WeatherState, FlightAction } from '../../types';

/**
 * Typed event map for all cross-system communication.
 * Adding a new event: declare it here, then emit/on with full type safety.
 */
/** What the HUD needs to show about the next drop site. */
export interface DropZoneStatus {
  place: string;
  kind: 'camp' | 'square' | 'rooftop';
  /** Distance to it, km. */
  km: number;
  need: number;
  got: number;
  /** The drop window, metres. */
  lo: number;
  hi: number;
  besieged: boolean;
  /**
   * hold     too early to start down
   * descend  start down now
   * window   in the band
   * release  in the band and the pin is on them
   * low      below the band — the roofs and wires are up here with you
   * late     the aim point is already past them
   * away     a crate has just gone out to them — watch it down
   * behind   flown past with crates still wanted — turn round for another pass
   */
  cue: 'hold' | 'descend' | 'window' | 'release' | 'low' | 'late' | 'away' | 'behind';
  /** How far until you should start down, km — the edge of the gun-free corridor. */
  descendInKm: number;
  /** While descending: the sink rate that reaches the band in time, m/s. */
  descentRate: number;
  /** Crates still aboard. */
  aboard: number;
  /** Coming at it from the far side, where guns cover the run-in. */
  covered?: boolean;
  /**
   * The drop meter, once the flare is up: metres from where a crate would
   * land now to the people (positive = still ahead of it), the half-width of
   * the "on them" window, and seconds until the two meet.
   */
  gapM: number | null;
  windowM: number;
  releaseIn: number | null;
  /** SPACE pressed on the run-in: the crate goes by itself on the mark. */
  armed?: boolean;
  /** Door bundles from a light aircraft, or pallets from a transport. */
  method?: 'bundle' | 'pallet';
}

export interface GameEvents {
  // Scene transitions
  /**
   * The dispatch board has committed to a job.
   *
   * Separate from `scene:start-flight` because the BOARD decides and the
   * SCENE transitions — the button lives in React now, so the two halves
   * have to talk rather than one owning both.
   */
  'scene:depart': { contractId: string };
  'scene:start-flight': { contractId: string };
  'scene:flight-complete': { result: LandingResult; contractId: string };
  'scene:return-to-map': void;
  'scene:open-preflight': { settlementId: string };

  // Flight runtime
  'flight:state-update': FlightState;
  'flight:event-triggered': { event: FlightEventDefinition };
  'flight:event-choice': { eventId: string; choiceId: string };
  'flight:apply-event-choice': { choiceId: string };
  /** A choice that DOES something; FlightScene carries it out. */
  'flight:event-action': { action: FlightAction; value: number };
  'flight:fuel-critical': { fuelRemaining: number };
  'flight:gear-toggled': { down: boolean };
  'flight:flaps-toggled': { deployed: boolean; stage?: number };

  // Weather
  'weather:changed': { state: WeatherState };

  // Cargo
  'flight:cargo-update': { average: number; count: number };

  // Route (emitted once when a flight starts)
  'flight:route-info': { routeKm: number; destinationName: string };

  // Threat / systems status for the HUD annunciator panel
  /**
   * The current tutorial instruction, or null once there is nothing to say.
   * Only ever populated on a save's first flight.
   */
  'flight:tutorial': {
    text: string | null;
    /** Flight school only: the step's heading, where it is, and the keys. */
    title?: string;
    step?: number;
    total?: number;
    keys?: string[];
    training?: boolean;
    /** From the coach — shown as a lesson panel rather than a one-line hint. */
    coach?: boolean;
  };
  /** Flight school's debrief: how it went, and what it paid. */
  'flight:training-complete': {
    passed: boolean;
    reward: number;
    landing: string;
    onRunway: boolean;
    crates: number;
  };
  /** The debrief's two buttons. */
  'flight:training-exit': { again: boolean };
  'flight:skip-training': void;
  /** Stop the coach on a real flight — the player knows what they are doing. */
  'flight:hide-tips': void;
  'flight:status': {
    engineFailed: boolean;
    underFire: boolean;
    /** What is shooting, and the altitude that puts you out of its reach. */
    groundThreat: { label: string; clearM: number } | null;
    /**
     * How well the gunners have read your flying, 0–1.
     *
     * Surfaced because the counterplay has to be legible: they get more
     * accurate the longer you hold one altitude, and the answer is to change
     * it. A hidden accuracy modifier would just feel like bad luck.
     */
    rangedOn: number;
    /**
     * Vertical speed of the AIR, m/s, positive up — a variometer reading.
     *
     * This is the instrument the whole air-mass system needs to be playable:
     * lift is invisible, and without a needle telling you the air is going up
     * the player can only ever notice that their altitude changed for no
     * apparent reason. With it, hunting a thermal becomes a skill.
     */
    airVertical: number;
    /** True while inside a working thermal core. */
    inThermal: boolean;
    /**
     * Weather cell ahead: what it is and how far to its leading edge, in km.
     *
     * Without this the cells are just a nastier random condition. The whole
     * point is the decision — over it, round it, or straight through — and a
     * decision needs enough warning to act on.
     */
    weatherAhead: { kind: string; km: number } | null;
    stall: boolean;
    overspeed: boolean;
    obstacleAheadM: number | null;
    /** What it is — "TOWER BLOCK", "POWER LINES" — for the caution chip. */
    obstacleLabel: string | null;
    /** Conflicting traffic's height minus ours, metres. Null when clear. */
    trafficDeltaM: number | null;
    /** Which way to go to miss it: +1 climb, -1 descend. */
    trafficAvoid: 1 | -1 | null;
    /**
     * Fuel fraction projected to remain on arrival, 0-1.
     *
     * The cruise instrument. Level flight had no feedback of any kind, so once
     * you were above the guns there was nothing to read and nothing to do —
     * this answers "am I winning right now?" every second, and throttle,
     * altitude, wind and the air mass all move it.
     */
    fuelAtArrival: number;
    /** False for the two fixed-gear aircraft — no GEAR control should appear. */
    retractableGear: boolean;
    /** A survivor camp is signalling and a crate could be dropped on it. */
    dropReady: boolean;
    cratesLeft: number;
    /**
     * The next site that has called in: where, how far, the height band to
     * drop from, and what to do about it right now. Null when nobody is
     * calling or the hold is empty.
     */
    dropZone: DropZoneStatus | null;
    /** Flew past the destination strip, still heading away from it. */
    overshot: boolean;
    /** Airborne, high enough and not already turning — the TURN control is live. */
    canTurn: boolean;
    /**
     * The flap lever's notches in degrees, the limit speed for where the
     * flaps are now and for the next notch down, and whether they are out
     * too fast right now.
     */
    flaps: { stops: number[]; limitKmh: number | null; nextLimitKmh: number | null; overspeed: boolean; blownBack?: boolean } | null;
    /** 1g stall speed in the current configuration and air. */
    stallKmh: number;
    /** Climb left at this height as a fraction of sea level — 0 at the ceiling. */
    climbReserve: number;
    /** Icing / sand / avionics caution from the weather, or null. */
    weatherCaution: string | null;
    /** 0–1 ice on the airframe, for the gauge. */
    iceLoad: number;
    /** Instruments blanked by a lightning strike. */
    avionicsOut: boolean;
  };

  // Economy
  'economy:tick': { gameTimestamp: number };
  'economy:price-changed': { settlementId: string; goodId: string; newPrice: number };

  // Contracts
  'contract:accepted': { contract: Contract };
  'contract:completed': { contractId: string };
  'contract:failed': { contractId: string; reason: string };
  'contract:board-refreshed': void;

  // Player
  'player:location-changed': { settlementId: string };
  'player:settlement-unlocked': { settlementId: string; name: string };
  'player:money-changed': { amount: number; delta: number };
  'player:fleet-changed': { definitionId: string };
  'profile:changed': { id: string; name: string };
  'ui:open-hangar': void;
  'ui:open-profiles': void;
  'ui:close-profiles': void;
  'ui:close-hangar': void;
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
