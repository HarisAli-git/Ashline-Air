import type { AircraftDefinition } from '../types/aircraft';
import type { SettlementDefinition } from '../types/settlement';
import { distance } from '../game/utils/math';

/**
 * How long a route is, and who can actually fly it.
 *
 * This used to be nobody's job. `KM_PER_PIXEL` was declared separately in
 * MapScene and ContractService, the gameplay route length was computed inline
 * in FlightScene, and no part of the game had any concept of an aircraft's
 * RANGE at all - every airframe carried ten to thirteen minutes of fuel
 * against a longest route of five kilometres, so nothing could ever run out
 * and nothing was ever out of reach.
 *
 * That is why six aircraft felt like six skins: cargo capacity was the only
 * axis that did anything. Range and runway are now real constraints, and they
 * are the reason four aircraft cover more ground than six did.
 */

/** Map pixels to lore kilometres. The map is drawn at this scale. */
export const KM_PER_PIXEL = 0.5;

/**
 * How much of a lore kilometre you actually fly.
 *
 * The old route formula was `clamp(1.8 + loreKm / 110, 1.8, 5)` and the 1.8 km
 * floor was more than half of most routes, so a 111 km hop and a 356 km haul
 * came out as 2.8 km and 5.0 km of flying - the longest flight in the game was
 * forty-three seconds in the fastest aircraft. Every route felt the same
 * length because nearly every route WAS the same length.
 *
 * A straight proportion instead, with the divisor set so the shortest hop is
 * about two and a half minutes in the aircraft that flies it and the longest
 * haul is about eight in the only aircraft that can reach the far end.
 */
export const GAMEPLAY_KM_PER_LORE_KM = 1 / 5.6;

/**
 * Fuel you are expected to still have when you arrive.
 *
 * A route is only offered if it fits inside this much of the tank. Arriving on
 * fumes should be the consequence of flying it badly - a headwind, a detour
 * around a cell, an overheating engine held at full throttle - not the
 * baseline the contract board hands you.
 */
export const FUEL_RESERVE = 0.22;

/** Lore distance between two settlements, km. */
export function loreKmBetween(a: SettlementDefinition, b: SettlementDefinition): number {
  return distance(a.position.x, a.position.y, b.position.x, b.position.y) * KM_PER_PIXEL;
}

/** How far you actually fly between two settlements, in gameplay km. */
export function routeKmBetween(a: SettlementDefinition, b: SettlementDefinition): number {
  return Math.max(4, loreKmBetween(a, b) * GAMEPLAY_KM_PER_LORE_KM);
}

/**
 * Still-air range in gameplay km, derived from the fuel the aircraft carries.
 *
 * Derived rather than authored so there is ONE source of truth: the gauge on
 * the panel and the reach on the map can never disagree, because they are the
 * same number. `fuelBurnRate` is litres per minute at full throttle.
 */
export function rangeKm(def: AircraftDefinition): number {
  const s = def.stats;
  if (s.fuelBurnRate <= 0) return Infinity;
  const enduranceMin = s.fuelCapacity / s.fuelBurnRate;
  return (s.cruiseSpeed / 60) * enduranceMin;
}

/** The longest route this aircraft may be offered, keeping the reserve. */
export function maxRouteKm(def: AircraftDefinition): number {
  return rangeKm(def) * (1 - FUEL_RESERVE);
}

/** Why an aircraft cannot fly a given route, or null if it can. */
export type RouteBlock =
  | { reason: 'range'; needKm: number; haveKm: number }
  | { reason: 'runway'; needM: number; haveM: number; where: string }
  | null;

/**
 * Can this aircraft serve this route?
 *
 * Both ends are checked, because a runway you can leave is not necessarily one
 * you can come back to. A 430 m mountain strip will never take a freighter,
 * and no amount of money changes that - which is exactly why the small fields
 * stay a light-aircraft business however rich you get.
 */
export function routeBlock(
  def: AircraftDefinition, origin: SettlementDefinition, dest: SettlementDefinition,
): RouteBlock {
  const need = def.stats.runwayM;
  for (const s of [origin, dest]) {
    const have = s.field?.runwayM ?? 600;
    if (have < need) {
      return { reason: 'runway', needM: need, haveM: have, where: s.name };
    }
  }
  const routeKm = routeKmBetween(origin, dest);
  const max = maxRouteKm(def);
  if (routeKm > max) {
    return { reason: 'range', needKm: routeKm, haveKm: max };
  }
  return null;
}

/** One line explaining a block, for the contract board and the hangar. */
export function describeBlock(block: NonNullable<RouteBlock>): string {
  return block.reason === 'runway'
    ? `${block.where} has ${block.haveM} m of runway — you need ${block.needM} m`
    : `${Math.round(block.needKm)} km — beyond your ${Math.round(block.haveKm)} km range`;
}
