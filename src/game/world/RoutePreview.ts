import { Hazards } from './Hazards';
import { SupplyDrops } from './SupplyDrops';

/**
 * What is waiting along a route, known before you fly it.
 *
 * Every route is laid out deterministically from its contract, so the board
 * can run the same layout the flight will and say "two towns calling, one
 * under fire" before you commit. Without it the drops were a surprise you
 * could not plan fuel, time or an aircraft around.
 */

const M = 9;

/** The seed a contract's route is laid out from. FlightScene uses the same. */
export function routeSeed(contractId: string): number {
  let h = 2166136261;
  for (let i = 0; i < contractId.length; i++) { h ^= contractId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/** Where route furniture may go, world px: clear of both airfields. */
export function routeSpanPx(routeKm: number): [number, number] {
  const destPx = Math.max(2000 * M, routeKm * 1000 * M);
  return [450 * M, destPx - 300 * M];
}

export interface DropPreview {
  sites: number;
  towns: number;
  besieged: number;
}

const cache = new Map<string, DropPreview>();

export function previewDrops(contractId: string, routeKm: number): DropPreview {
  const key = `${contractId}|${routeKm.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const seed = routeSeed(contractId);
  const hz = new Hazards();
  const [a, b] = routeSpanPx(routeKm);
  hz.generate(a, b, seed);
  const drops = new SupplyDrops();
  drops.layout(routeKm * 1000 * M, seed, 1, {
    towns: hz.towns,
    zones: hz.zones,
    tallestBetween: (x0, x1) => hz.tallestBetween(x0, x1),
    surfaceAt: x => hz.surfaceAt(x),
  });
  const out: DropPreview = {
    sites: drops.sites.length,
    towns: hz.towns.length,
    besieged: drops.sites.filter(s => s.besieged).length,
  };
  cache.set(key, out);
  return out;
}
