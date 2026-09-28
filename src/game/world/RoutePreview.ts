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

/**
 * How long a field's strip is DRAWN, metres.
 *
 * Fields were drawn at their full published length — 430 to 1800 m — and at
 * nine pixels a metre an 1800 m apron was fourteen screens of tarmac for an
 * aeroplane that lifts off in 85 m. Worse, the furniture layout started at a
 * fixed 450 m, so on every long field masts, raider camps and wrecks stood on
 * the runway itself.
 *
 * A strip is now drawn at a fraction of its length, with a floor. Measured
 * against the flight model (braked landing roll, and lift-off with flaps from
 * where the aeroplane is parked): every aircraft that is allowed onto a field
 * still gets off it and stops on it, with room to spare but not a runway
 * that takes a minute to taxi down.
 */
export function stripM(runwayM: number): number {
  return Math.round(130 + runwayM * 0.22);
}

/** Destination centre, world px — the end of the route. */
export function destCentrePx(routeKm: number): number {
  return Math.max(2000 * M, routeKm * 1000 * M);
}

/** The origin strip, world px. The aircraft is parked 33 m in from its start. */
export function originStripPx(runwayM: number): [number, number] {
  const from = -30 * M;
  return [from, from + stripM(runwayM) * M];
}

/** The destination strip, world px, centred on the end of the route. */
export function destStripPx(routeKm: number, runwayM: number): [number, number] {
  const c = destCentrePx(routeKm), half = (stripM(runwayM) * M) / 2;
  return [c - half, c + half];
}

/**
 * Where route furniture may go, world px: past the origin strip and a clear
 * climb-out, and short of the destination with a clear approach.
 */
export function routeSpanPx(routeKm: number, originRunwayM = 600, destRunwayM = 600): [number, number] {
  return [originStripPx(originRunwayM)[1] + 350 * M, destStripPx(routeKm, destRunwayM)[0] - 900 * M];
}

export interface DropPreview {
  sites: number;
  /** Crates wanted along the whole route. */
  crates: number;
  towns: number;
  besieged: number;
}

const cache = new Map<string, DropPreview>();

export function previewDrops(
  contractId: string, routeKm: number, originRunwayM = 600, destRunwayM = 600,
): DropPreview {
  const key = `${contractId}|${routeKm.toFixed(2)}|${originRunwayM}|${destRunwayM}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const seed = routeSeed(contractId);
  const hz = new Hazards();
  const [a, b] = routeSpanPx(routeKm, originRunwayM, destRunwayM);
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
    crates: drops.sites.reduce((n, s) => n + s.need, 0),
    towns: hz.towns.length,
    besieged: drops.sites.filter(s => s.besieged).length,
  };
  cache.set(key, out);
  return out;
}
