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

export function useMoney(): number {
  const [money, setMoney] = useState<number>(() => SaveService.get().player.money);
  useEffect(() => {
    return EventBus.on('player:money-changed', ({ amount }) => setMoney(amount));
  }, []);
  return money;
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
