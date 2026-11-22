import type { BiomeId } from './Biomes';

/**
 * Standing water that was not always dead.
 *
 * The world had rivers of a sort (the drowned coast's channels) but no lake,
 * and a lake is one of the strongest things a landscape can show you: a big
 * flat mirror that should be the most alive place in the country and is the
 * most obviously dead. Two kinds, one per country that keeps one:
 *
 *   reservoir   Ashford's basin — the last of the dammed water in a dried
 *               river basin, sunk to a fraction of itself, ringed with the
 *               pale line of where it used to stand, grey-green and still.
 *   tailings    Irongate's flooded spoil pit — rust-orange, scummed with
 *               foam, with the machinery that dug it half under.
 *
 * Everything here is PURE: the flight and the dispatch board's route preview
 * both call `lakeFor`, so the towns and guns the preview counts are laid out
 * around the same water the flight draws.
 *
 * Geometry: the lake is an oval on the ground plane. Along the route it runs
 * `half` either side of its centre at the line the action happens on; in depth
 * it runs from just short of the far edge of the plain (d = −1 is the foot of
 * the hills) to past the bottom of the screen (d = +1). Its shores wander.
 */

export type LakeKind = 'reservoir' | 'tailings';

export interface Lake {
  kind: LakeKind;
  /** Centre along the route at the action line, world px. */
  cx: number;
  /** Half its length along the route at the action line, world px. */
  half: number;
  seed: number;
}

/** Which countries keep a lake. */
export const LAKE_BIOMES: Partial<Record<BiomeId, LakeKind>> = {
  basin: 'reservoir',
  industrial: 'tailings',
};

const M = 9;
/** The far tip and the near reach of the oval, in depth (−1 far … +1 near). */
export const LAKE_D_FAR = -0.72;
export const LAKE_D_NEAR = 1.22;

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** The oval's half-width at a depth, 0 … 1 of `half`, before the shore wanders. */
function ovalAt(d: number): number {
  const dc = (LAKE_D_FAR + LAKE_D_NEAR) / 2, r = (LAKE_D_NEAR - LAKE_D_FAR) / 2;
  const u = (d - dc) / r;
  return u <= -1 || u >= 1 ? 0 : Math.sqrt(1 - u * u);
}

/**
 * Where the two shores are at a depth, world px, as [left, right]. Null
 * outside the lake's depth. The same function draws the shore and decides
 * where the water starts for everything that cares (guns, crates, ditching).
 */
export function shoresAt(l: Lake, d: number): [number, number] | null {
  const w = ovalAt(d);
  if (w <= 0.001) return null;
  const p = hash(l.seed + 1) * 6.28, q = hash(l.seed + 2) * 6.28, s = hash(l.seed + 3) * 6.28;
  const wl = w * (1 + 0.1 * Math.sin(d * 5.3 + p) + 0.05 * Math.sin(d * 11.7 + q));
  const wr = w * (1 + 0.09 * Math.sin(d * 4.6 + q) + 0.05 * Math.sin(d * 13.1 + s));
  // The lake lies a little askew across the plain rather than square to it
  const skew = (hash(l.seed + 4) - 0.5) * 0.5;
  const c = l.cx + l.half * skew * d;
  return [c - l.half * wl, c + l.half * wr];
}

/** The stretch of route the water covers at the action line, world px. */
export function lakeSpan(l: Lake): [number, number] {
  return shoresAt(l, 0) ?? [l.cx, l.cx];
}

/**
 * The lake on a route, if either end is in country that has one.
 *
 * It sits well inside that end's country (the first or last third of the leg)
 * and clear of the climb-out and the approach, and it is long enough to be a
 * crossing — a kilometre or more of open water — not a pond.
 *
 * @param span where route furniture may go, world px (see RoutePreview)
 */
export function lakeFor(
  span: [number, number], seed: number, from: BiomeId | null, to: BiomeId | null,
): Lake | null {
  const kFrom = from ? LAKE_BIOMES[from] : undefined;
  const kTo = to ? LAKE_BIOMES[to] : undefined;
  if (!kFrom && !kTo) return null;
  const useFrom = !!kFrom && (!kTo || hash(seed * 11 + 5) < 0.5);
  const kind = (useFrom ? kFrom : kTo)!;
  const [a, b] = span;
  const half = (470 + hash(seed * 7 + 3) * 260) * M;
  // Keep the climb-out, the approach and a ring of shore clear
  const lo = a + 1450 * M + half * 1.1, hi = b - 1700 * M - half * 1.1;
  if (hi <= lo) return null;
  const t = useFrom ? 0.06 + hash(seed * 13 + 1) * 0.16 : 0.74 + hash(seed * 17 + 2) * 0.14;
  const cx = Math.min(hi, Math.max(lo, a + (b - a) * t));
  return { kind, cx, half, seed: seed % 9973 };
}

/**
 * The water at a point on the action line, signed like the channels' field:
 * above zero is water (and how far in from the shore), below is land.
 */
export function lakeField(l: Lake | null, worldX: number): number {
  if (!l) return -1;
  const [lo, hi] = lakeSpan(l);
  return Math.min(worldX - lo, hi - worldX) / 2400;
}
