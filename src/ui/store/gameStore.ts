import { useState, useEffect } from 'react';
import { EventBus } from '../../game/utils/EventBus';
import { SaveService } from '../../services/SaveService';
import type { FlightState, FlightEventDefinition } from '../../types';

/**
 * Lightweight reactive store built on plain React hooks + EventBus.
 * No external state library needed at this scale; add Zustand or Jotai
 * if this grows beyond ~10 top-level pieces of state.
 */

export function useFlightState(): FlightState | null {
  const [state, setState] = useState<FlightState | null>(null);
  useEffect(() => EventBus.on('flight:state-update', setState), []);
  return state;
}

/**
 * Is a flight actually on screen right now?
 *
 * Needed because the two halves of the interface want opposite things from
 * the same strip of screen: in flight the top belongs to the radio strip and
 * the bottom centre is clear, while on the pre-flight and map screens the
 * bottom centre is where the primary action button lives. A toast pinned to
 * one of them is guaranteed to cover the other.
 */
export function useInFlight(): boolean {
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    const offs = [
      EventBus.on('scene:start-flight', () => setFlying(true)),
      EventBus.on('scene:flight-complete', () => setFlying(false)),
      EventBus.on('scene:return-to-map', () => setFlying(false)),
    ];
    return () => offs.forEach(off => off?.());
  }, []);
  return flying;
}

export function useMoney(): number {
  const [money, setMoney] = useState<number>(() => SaveService.get().player.money);
  useEffect(() => {
    return EventBus.on('player:money-changed', ({ amount }) => setMoney(amount));
  }, []);
  return money;
}

export function useRouteInfo(): { routeKm: number; destinationName: string } | null {
  const [info, setInfo] = useState<{ routeKm: number; destinationName: string } | null>(null);
  useEffect(() => {
    const u1 = EventBus.on('flight:route-info', setInfo);
    const u2 = EventBus.on('scene:flight-complete', () => setInfo(null));
    return () => { u1(); u2(); };
  }, []);
  return info;
}

export interface FlightStatus {
  engineFailed: boolean;
  underFire: boolean;
  groundThreat: { label: string; clearM: number } | null;
  /** How well the gunners have read your flying, 0–1. */
  rangedOn: number;
  /** Vertical speed of the AIR, m/s, positive up. */
  airVertical: number;
  inThermal: boolean;
  weatherAhead: { kind: string; km: number } | null;
  stall: boolean;
  overspeed: boolean;
  obstacleAheadM: number | null;
  trafficDeltaM: number | null;
  trafficAvoid: 1 | -1 | null;
  /** Projected fuel fraction left in the tank on arrival. See FlightScene. */
  fuelAtArrival: number;
  weatherCaution: string | null;
  iceLoad: number;
  avionicsOut: boolean;
}

export function useFlightStatus(): FlightStatus | null {
  const [status, setStatus] = useState<FlightStatus | null>(null);
  useEffect(() => {
    const u1 = EventBus.on('flight:status', setStatus);
    const u2 = EventBus.on('scene:flight-complete', () => setStatus(null));
    return () => { u1(); u2(); };
  }, []);
  return status;
}

export function useCargo(): { average: number; count: number } | null {
  const [cargo, setCargo] = useState<{ average: number; count: number } | null>(null);
  useEffect(() => {
    const u1 = EventBus.on('flight:cargo-update', c => setCargo(c.count > 0 ? c : null));
    const u2 = EventBus.on('scene:flight-complete', () => setCargo(null));
    return () => { u1(); u2(); };
  }, []);
  return cargo;
}

export function useNotification(): { message: string; type: string } | null {
  const [note, setNote] = useState<{ message: string; type: string } | null>(null);
  useEffect(() => {
    return EventBus.on('ui:show-notification', ({ message, type }) => {
      setNote({ message, type });
      setTimeout(() => setNote(null), 4000);
    });
  }, []);
  return note;
}

export function useEventModal(): FlightEventDefinition | null {
  const [event, setEvent] = useState<FlightEventDefinition | null>(null);
  useEffect(() => {
    const unsub1 = EventBus.on('ui:show-event-modal', ({ event }) => setEvent(event));
    const unsub2 = EventBus.on('ui:close-event-modal', () => setEvent(null));
    return () => { unsub1(); unsub2(); };
  }, []);
  return event;
}

export function useGearFlaps(): { gearDown: boolean; flapsDeployed: boolean } {
  const [gearDown, setGearDown] = useState(true);
  const [flapsDeployed, setFlapsDeployed] = useState(false);
  useEffect(() => {
    const u1 = EventBus.on('flight:gear-toggled',  ({ down }) => setGearDown(down));
    const u2 = EventBus.on('flight:flaps-toggled', ({ deployed }) => setFlapsDeployed(deployed));
    return () => { u1(); u2(); };
  }, []);
  return { gearDown, flapsDeployed };
}
