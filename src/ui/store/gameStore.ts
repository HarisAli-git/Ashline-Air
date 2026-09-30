import { useState, useEffect } from 'react';
import { EventBus, type DropZoneStatus } from '../../game/utils/EventBus';
import { SaveService } from '../../services/SaveService';
import type { FlightState, FlightEventDefinition } from '../../types';
import type { TutorialPayload } from '../components/hud/TrainingPanel';

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

/** The current tutorial line, or null. First flight of a save only. */
/** The current teaching line — or, in flight school, the whole step. */
export function useTutorial(): TutorialPayload | null {
  const [lesson, setLesson] = useState<TutorialPayload | null>(null);
  useEffect(() => EventBus.on('flight:tutorial', p => setLesson(p.text ? { ...p, text: p.text } : null)), []);
  return lesson;
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
  obstacleLabel: string | null;
  trafficDeltaM: number | null;
  trafficAvoid: 1 | -1 | null;
  /** Projected fuel fraction left in the tank on arrival. See FlightScene. */
  fuelAtArrival: number;
  retractableGear: boolean;
  dropReady: boolean;
  cratesLeft: number;
  dropZone: DropZoneStatus | null;
  overshot: boolean;
  canTurn: boolean;
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

export interface Note {
  id: number;
  message: string;
  type: string;
  /** How many times this exact line has arrived while it was showing. */
  count: number;
  born: number;
  ttl: number;
}

const NOTE_RANK: Record<string, number> = { info: 0, success: 1, warning: 2, danger: 3 };

/** Long enough to read, and more for the things that matter. */
function noteTtl(type: string, message: string): number {
  const base = ({ info: 3200, success: 3600, warning: 4600, danger: 6000 } as Record<string, number>)[type] ?? 3600;
  return base + Math.max(0, message.length - 48) * 35;
}

/**
 * The message queue.
 *
 * It was one slot with a fixed four-second timer per message, and the timers
 * were never cancelled — a message arriving three seconds after another was
 * wiped by the FIRST one's timer a second later, so anything that came in a
 * burst (and in a fight everything does) flashed up and vanished unread.
 *
 * Now each line has its own lifetime, a repeat bumps a counter instead of
 * stacking a copy, and when the stack is full the least important line goes
 * first — a routine radio call never pushes a stall warning off the screen.
 */
export function useNotifications(max: number): Note[] {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    let seq = 0;
    const off = EventBus.on('ui:show-notification', ({ message, type }) => {
      const now = performance.now();
      setNotes(list => {
        const same = list.find(n => n.message === message);
        if (same) {
          return list.map(n => n === same
            ? { ...n, count: n.count + 1, born: now, ttl: noteTtl(type, message) } : n);
        }
        const next = [...list, { id: ++seq, message, type, count: 1, born: now, ttl: noteTtl(type, message) }];
        while (next.length > max) {
          let victim = 0;
          for (let i = 1; i < next.length; i++) {
            if ((NOTE_RANK[next[i].type] ?? 0) < (NOTE_RANK[next[victim].type] ?? 0)) victim = i;
          }
          next.splice(victim, 1);
        }
        return next;
      });
    });
    const timer = setInterval(() => {
      const now = performance.now();
      setNotes(list => {
        const kept = list.filter(n => now - n.born < n.ttl);
        return kept.length === list.length ? list : kept;
      });
    }, 200);
    return () => { off(); clearInterval(timer); };
  }, [max]);
  return notes;
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
