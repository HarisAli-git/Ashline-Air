import Phaser from 'phaser';
import { drawObstacle, drawObstacleDepth, type ObstacleKind, type ObstacleStyle } from './Obstacles';
import { layoutCountryside, drawProp, type Prop } from './Countryside';
import type { BiomeId } from './Biomes';
import {
  layoutSettlements, layoutTrainingSettlements, isBuilding, spanBand, townStyleFor,
  DROP_RUN_BEFORE_PX, DROP_RUN_AFTER_PX, GUN_REACH_PX, drawBuilding, drawBuildingDepth, drawTownGround, drawPole, drawSpan,
  type BuildingKind, type Span, type Town,
} from './Towns';

/** Clear air after the departure strip, world px (1.2 km). */
const CLIMB_OUT_PX = 1200 * 9;
/** Clear air before the destination's approach starts, world px (1.2 km). */
const APPROACH_PX = 1200 * 9;

/*
 * The surfaces nothing solid may stand above, rising from each runway.
 *
 * Lone masts went anywhere in the route span, which starts 350 m past the
 * departure strip and stops 900 m short of the destination (RoutePreview's
 * routeSpanPx) — so a 78 m mast could stand a kilometre out on final, right
 * where the 4-degree glide-path guide puts you at about 70 m. Following the
 * guide flew you into it. Now the climb-out has a 4-degree surface and the
 * approach a 2.6-degree one, both well under what you actually fly.
 */
const SPAN_AFTER_ORIGIN_M = 350;
const SPAN_BEFORE_DEST_M = 900;
const CLIMB_SURFACE = Math.tan((4 * Math.PI) / 180);
const APPROACH_SURFACE = Math.tan((2.6 * Math.PI) / 180);

/**
 * Everything along the route that can actually hurt you.
 *
 * Obstacles (radio masts, ruined towers, gantry cranes) are solid: they are
 * drawn with the same altitude→pixel mapping the aircraft uses, so what you
 * see is exactly what you collide with. Hostile stretches are raider ground
 * held territory — fly low over one and they shoot at you.
 *
 * This turns cruise from "hold altitude and wait" into a running decision:
 * staying low is fast and cheap but runs you through masts and gunfire;
 * climbing is safe but costs fuel, time and airspeed.
 */

export type HazardKind = ObstacleKind | BuildingKind;

export interface Hazard {
  x: number;          // world px
  kind: HazardKind;
  heightM: number;    // metres — compared directly against aircraft altitude
  halfWidth: number;  // world px, collision half-width
  seed: number;
  /**
   * How badly this structure has been hit, 0–1.
   *
   * Flying a mast off its guys used to leave the mast standing there
   * untouched while the aeroplane took 45 points of damage — the collision
   * was entirely one-sided, which makes the world feel like scenery rather
   * than something you are moving through. A struck obstacle now buckles,
   * loses its top and burns.
   */
  damage?: number;
  /** Seconds since it was struck, for the fire and the smoke column. */
  hitAge?: number;
  /** A flat roof a crate can land on, metres; null for a pitched or domed top. */
  roofM?: number | null;
  /** How a building is built where it stands — adobe, timber, stilts, brick. */
  look?: import('./Towns').TownStyle;
  /**
   * Whether it gets the OBSTACLE AHEAD klaxon. A town is forty buildings;
   * sounding the alarm for every shed on the way through would make the one
   * call that matters — the tower block in front of you — unhearable.
   */
  warn?: boolean;
}

/*
 * Engagement altitudes now live per-weapon in Raiders.ts (WEAPONS): a rifle
 * over sandbags and a wheeled autocannon do not share a ceiling, and the
 * whole point of the hostile zones is that you have to read which is which.
 */

/** Height range in metres for each obstacle, and its collision footprint. */
const HEIGHT_BAND: Record<ObstacleKind, [number, number]> = {
  mast:    [34, 78],   // the one that genuinely makes you climb
  turbine: [36, 68],
  stack:   [26, 54],
  tower:   [18, 40],
  pylon:   [22, 38],
  crane:   [16, 34],
};

const HALF_WIDTH: Record<ObstacleKind, number> = {
  mast: 11, turbine: 14, stack: 15, tower: 22, pylon: 20, crane: 30,
};

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class Hazards {
  private list: Hazard[] = [];
  private hostile: Array<[number, number]> = [];
  /** Per zone, the only weapons allowed in it (null = anything). */
  private hostileOnly: Array<ReadonlyArray<string> | null> = [];
  private spanList: Span[] = [];
  private townList: Town[] = [];
  /**
   * Where the open-country drop camps go, world px. Chosen BEFORE the guns
   * and the lone obstacles, so both have to keep clear of them — camps used
   * to be placed last, into whatever gun-free gaps were left, and on a short
   * route there usually were none.
   */
  private camps: number[] = [];
  private props: Prop[] = [];

  /**
   * Lay out towns, power lines, obstacles and hostile ground between the two
   * airfields. `biomeAt` only decides how things LOOK — adobe or timber, a
   * pumpjack or a barn — never where anything solid goes, so the dispatch
   * board's preview (which does not pass it) lays out the same route.
   */
  generate(startPx: number, endPx: number, seed: number, biomeAt?: (x: number) => BiomeId): void {
    this.list = [];
    this.props = [];
    this.hostile = [];
    this.hostileOnly = [];
    this.spanList = [];
    this.townList = [];
    this.camps = [];
    const span = endPx - startPx;
    if (span <= 0) return;

    // Towns and the lines that feed them go down first; everything else
    // has to find room around them.
    const built = layoutSettlements(startPx, endPx, seed);
    this.townList = built.towns;
    this.spanList = built.spans;

    /*
     * Then the camps. Every route gets at least two places to drop to — a
     * route with one town gets a camp as well, a route with none gets two —
     * plus roughly one more per twelve kilometres. Each camp sits in its own
     * slice, clear of the towns, and its run-in is reserved the same way a
     * town's is, so nothing tall and no gun can take it back.
     */
    {
      const M = 9;
      const wanted = Math.max(2 - Math.min(2, built.towns.length), Math.round(span / (12000 * M)));
      const lo = startPx + 900 * M, hi = endPx - 600 * M;
      const clearOfTowns = (x: number): boolean =>
        built.towns.every(t => x < t.x0 - 700 * M || x > t.x1 + 700 * M);
      const clearOfCamps = (x: number): boolean =>
        this.camps.every(c => Math.abs(c - x) > DROP_RUN_BEFORE_PX + DROP_RUN_AFTER_PX);
      if (wanted > 0 && hi > lo) {
        const slice = (hi - lo) / wanted;
        for (let i = 0; i < wanted; i++) {
          const ideal = lo + slice * (i + 0.3 + hash(seed * 19 + i) * 0.4);
          // Nearest spot to the ideal that is clear of towns and other camps
          let pick: number | null = null;
          for (let k = 0; k <= 40 && pick === null; k++) {
            for (const sgn of [1, -1]) {
              const x = ideal + sgn * k * 150 * M;
              if (x < lo || x > hi) continue;
              if (clearOfTowns(x) && clearOfCamps(x)) { pick = x; break; }
            }
          }
          if (pick !== null) this.camps.push(pick);
        }
        this.camps.sort((a, b) => a - b);
      }
      for (const c of this.camps) built.reserved.push([c - DROP_RUN_BEFORE_PX, c + DROP_RUN_AFTER_PX]);
    }
    for (const t of built.towns) this.list.push(...t.buildings);
    for (const s of built.substations) this.list.push(s.hazard);
    this.list.push(...built.pylons);

    // Obstacles: spaced with a guaranteed gap so the route is always flyable.
    // These are WORLD PIXELS — at 9 px/m a 2400 px gap is ~270 m of flying.
    const minGap = 2400;
    let x = startPx + 1800;
    let i = seed * 31;
    while (x < endPx - 400) {
      // Weighted so the tall ones — the masts and turbines that actually force
      // a climb — stay uncommon, and the low clutter is what you meet most.
      // No lone pylons: a pylon with nothing either side of it was the
      // "wires connected to air" problem. They only come in lines now.
      const r = hash(i++);
      const kind: ObstacleKind =
        r < 0.26 ? 'mast' :
        r < 0.50 ? 'tower' :
        r < 0.69 ? 'crane' :
        r < 0.87 ? 'stack' : 'turbine';
      const band = HEIGHT_BAND[kind];
      const heightM = band[0] + hash(i++) * (band[1] - band[0]);
      const half = HALF_WIDTH[kind];
      // Nothing tall in a town's descent corridor either — the glide path
      // down to a drop has to be clear of more than just guns
      const corridors = built.towns.map(t => [t.x0 - DROP_RUN_BEFORE_PX, t.x1 + DROP_RUN_AFTER_PX] as [number, number]);
      const clear = ![...built.reserved, ...corridors].some(([ra, rb]) => x + half + 200 > ra && x - half - 200 < rb);
      // …and nothing poking up through the climb-out or the final approach
      const pastRunwayM = (x - startPx) / 9 + SPAN_AFTER_ORIGIN_M;
      const shortOfRunwayM = (endPx - x) / 9 + SPAN_BEFORE_DEST_M;
      const ceilingM = Math.min((pastRunwayM + 150) * CLIMB_SURFACE, shortOfRunwayM * APPROACH_SURFACE - 6);
      if (clear && heightM <= ceilingM) this.list.push({ x, kind, heightM, halfWidth: half, seed: i, warn: true });
      x += minGap + hash(i++) * 3000;
    }
    this.list.sort((p, q) => p.x - q.x);
    if (biomeAt) {
      for (const h of this.list) if (isBuilding(h.kind)) h.look = townStyleFor(biomeAt(h.x));
      this.props = layoutCountryside(startPx, endPx, seed, built.reserved, biomeAt);
    }

    /*
     * Hostile stretches: raider-held bands wide enough to be a real crossing
     * (~600-900 m), not a sliver you clear before the warning lands.
     *
     * Density is a FRACTION OF THE ROUTE, not a count. A flat 1-2 zones was
     * fine at five kilometres - it covered a fifth to a half of the leg - but
     * the same rule on a sixty-kilometre haul covered six percent, and the
     * guns effectively vanished from the game. One stretch per ~4.5 km keeps
     * a crossing every half-minute or so whatever the aircraft.
     */
    // 2.6 km: denser than the old 3.2, because the drop runs now take their
    // share of the route and a zone that cannot fit in its slice is dropped
    const PX_PER_ZONE = 2.6 * 1000 * 9;
    const zoneCount = Math.max(2, Math.min(24, Math.round(span / PX_PER_ZONE)));

    /*
     * And they must be SPREAD. The previous version fed `z` to the hash but
     * not to the position, so every stretch landed somewhere in the middle 44%
     * of the route and they piled up on each other - a long haul was one messy
     * knot of guns and then nothing at all either side.
     *
     * One zone per slice of the route, jittered inside its own slice, so they
     * are irregular without ever clumping or leaving a huge dead run.
     */
    /*
     * ...and they must keep their guns off the drop runs.
     *
     * A drop pulls you down to rooftop height for the last kilometre, and the
     * zones were laid out with no idea where the towns were — so the people
     * you came down to help were routinely sitting inside a heavy MG's reach
     * and the drop was a free kill. Every town's run-in and climb-out is now
     * out of range of everything, and a zone that cannot fit in its slice
     * without breaking that is dropped rather than squeezed in.
     *
     * The exception is deliberate: on a route with a few towns, one may be
     * BESIEGED — riflemen dug in around it, and the drop card says so before
     * you commit. That one is a choice with a bigger payout, not an ambush.
     */
    const towns = built.towns;
    const runOf = (t: { x0: number; x1: number }): [number, number] =>
      [t.x0 - DROP_RUN_BEFORE_PX - GUN_REACH_PX, t.x1 + DROP_RUN_AFTER_PX + GUN_REACH_PX];
    const siegeOf = (t: { x0: number; x1: number }): [number, number] => [t.x0 - 220 * 9, t.x1 + 220 * 9];
    let besieged = towns.length >= 2 && hash(seed * 91 + 7) < 0.55
      ? towns[1 + Math.floor(hash(seed * 93 + 1) * (towns.length - 1))]
      : null;
    // The riflemen round a besieged town must not reach a neighbour's run
    if (besieged) {
      const [a, b] = siegeOf(besieged);
      const safe = towns.every(t => t === besieged || runOf(t)[1] <= a || runOf(t)[0] >= b)
        && this.camps.every(c => c + DROP_RUN_AFTER_PX + GUN_REACH_PX <= a || c - DROP_RUN_BEFORE_PX - GUN_REACH_PX >= b);
      if (!safe) besieged = null;
    }
    if (besieged) besieged.besieged = true;
    const keepOut: Array<[number, number]> = towns.filter(t => t !== besieged).map(runOf);
    // The camps' run-ins are kept out of gun range exactly like the towns'
    for (const c of this.camps) {
      keepOut.push([c - DROP_RUN_BEFORE_PX - GUN_REACH_PX, c + DROP_RUN_AFTER_PX + GUN_REACH_PX]);
    }
    /*
     * The climb-out and the final approach are nobody's ground.
     *
     * Furniture could start 350 m past the end of the strip, and a raider
     * zone with it — so a new pilot, still at forty metres with the flaps out
     * and no speed, was inside the reach of every gun on the route. That is
     * not a decision, it is a tax on taking off. The first and last 1.2 km
     * are kept clear of anything that shoots, guns' reach included.
     *
     * It was three and two and a half: on a twelve-kilometre hop that left
     * room for half a zone, and the short routes went quiet altogether.
     */
    keepOut.push([startPx - GUN_REACH_PX, startPx + CLIMB_OUT_PX + GUN_REACH_PX]);
    keepOut.push([endPx - APPROACH_PX - GUN_REACH_PX, endPx + GUN_REACH_PX]);
    const clashes = (a: number, b: number): boolean => keepOut.some(([p, q]) => a < q && b > p);

    const slice = span / zoneCount;
    const zones: Array<{ z: [number, number]; only: ReadonlyArray<string> | null }> = [];
    for (let z = 0; z < zoneCount; z++) {
      const half = 2700 + hash(seed * 17 + z) * 1400;
      // Keep the jitter inside the slice, and clear of both airfields
      const room = Math.max(0, slice / 2 - half);
      const ideal = startPx + slice * (z + 0.5) + (hash(seed * 13 + z) - 0.5) * 2 * room;
      const lo = startPx + slice * z + half, hi = startPx + slice * (z + 1) - half;
      const candidates = [ideal];
      if (hi > lo) for (let k = 0; k <= 8; k++) candidates.push(lo + ((hi - lo) * k) / 8);
      candidates.sort((p, q) => Math.abs(p - ideal) - Math.abs(q - ideal));
      const centre = candidates.find(c => !clashes(c - half, c + half));
      if (centre === undefined) continue;
      zones.push({ z: [centre - half, centre + half], only: null });
    }
    if (besieged) {
      const z = siegeOf(besieged);
      // Riflemen only, and nothing else overlapping them
      for (let i = zones.length - 1; i >= 0; i--) {
        if (zones[i].z[0] < z[1] + GUN_REACH_PX && zones[i].z[1] > z[0] - GUN_REACH_PX) zones.splice(i, 1);
      }
      zones.push({ z, only: ['nest'] });
    }
    zones.sort((p, q) => p.z[0] - q.z[0]);
    this.hostile = zones.map(z => z.z);
    this.hostileOnly = zones.map(z => z.only);
  }

  /** Per zone, the only weapon kinds it may field (aligned with `zones`). */
  get zoneWeapons(): ReadonlyArray<ReadonlyArray<string> | null> { return this.hostileOnly; }

  /**
   * The training circuit, laid out by hand in the order the lesson needs:
   * one mast, then a power line into a town with people waiting in it, then
   * a short stretch of raider ground held by rifles only.
   *
   * Returns where each lesson lives, so the script can tell when it is done.
   */
  generateTraining(
    routeKm: number, townName: string, biomeAt?: (x: number) => BiomeId,
  ): { mastX: number; lineEndX: number; zone: [number, number] } {
    const M = 9;
    const km = (k: number): number => k * 1000 * M;
    this.list = [];
    this.hostile = [];
    const mastX = km(Math.min(3.1, routeKm * 0.24));
    this.list.push({ x: mastX, kind: 'mast', heightM: 46, halfWidth: HALF_WIDTH.mast, seed: 77, warn: true });
    const t0 = km(routeKm * 0.44), t1 = t0 + km(0.5);
    const built = layoutTrainingSettlements(t0, t1, 4242, townName);
    this.townList = built.towns;
    this.spanList = built.spans;
    for (const t of built.towns) this.list.push(...t.buildings);
    for (const s of built.substations) this.list.push(s.hazard);
    this.list.push(...built.pylons);
    this.list.sort((p, q) => p.x - q.x);
    if (biomeAt) {
      for (const h of this.list) if (isBuilding(h.kind)) h.look = townStyleFor(biomeAt(h.x));
      this.props = layoutCountryside(km(0.9), km(routeKm - 1.4), 4242,
        [...built.reserved, [mastX - 900, mastX + 900]], biomeAt);
    } else {
      this.props = [];
    }
    // Long enough, and armed well enough, that the cruise height you were
    // taught does NOT keep you out of it: machine guns reach 165 m, so the
    // lesson is the real one — climb above them or get shot at.
    const zone: [number, number] = [km(routeKm * 0.62), km(routeKm * 0.62 + 1.1)];
    this.hostile.push(zone);
    this.hostileOnly = [['nest', 'technical']];
    this.camps = [];
    const lineEndX = built.towns[0].poles[0].x;
    return { mastX, lineEndX, zone };
  }

  /** The obstacle the aircraft is currently inside, if any. */
  /** Every structure on the route — the air flows around all of them. */
  get all(): ReadonlyArray<Hazard> { return this.list; }

  /** Structures within reach of a point — used to wreck whatever a crash lands on. */
  near(worldX: number, extraPx: number): Hazard[] {
    return this.list.filter(h => Math.abs(h.x - worldX) <= h.halfWidth + extraPx);
  }

  /** Mark a structure as struck; the renderer takes it from there. */
  damageAt(h: Hazard, amount: number): void {
    h.damage = Math.min(1, (h.damage ?? 0) + amount);
    h.hitAge = 0;
    // Taking the top off a tall structure lowers what you can then hit — the
    // hole you punched through it is a real hole.
    h.heightM *= 1 - 0.34 * amount;
  }

  /** Advance the burn on anything that has been hit, and the swing of cut wires. */
  tickDamage(dt: number): void {
    for (const h of this.list) if (h.damage) h.hitAge = (h.hitAge ?? 0) + dt;
    for (const s of this.spanList) if (s.cutT !== undefined) s.cutT += dt;
  }

  collisionAt(worldX: number, altitudeM: number): Hazard | null {
    for (const h of this.list) {
      if (Math.abs(worldX - h.x) <= h.halfWidth && altitudeM <= h.heightM) return h;
    }
    return null;
  }

  /**
   * Did the aircraft fly through a cable between the last frame and this one?
   *
   * A crossing test rather than a proximity test: a wire is a line with no
   * thickness worth speaking of, and at 150 m/s with a warp on, a point test
   * steps straight over it. Being inside the band of conductors counts, and so
   * does ending up on the other side of it from where you started.
   */
  wireStrike(prevX: number, prevAlt: number, worldX: number, altM: number): Span | null {
    const MARGIN = 1.2;
    const side = (band: [number, number] | null, alt: number): number | null => {
      if (!band) return null;
      if (alt > band[1] + MARGIN) return 1;
      if (alt < band[0] - MARGIN) return -1;
      return 0;
    };
    for (const s of this.spanList) {
      if (s.cutT !== undefined) continue;
      if (worldX < s.a - 40 || worldX > s.b + 40) continue;
      const now = side(spanBand(s, worldX), altM);
      if (now === null) continue;
      if (now === 0) return s;
      const before = side(spanBand(s, prevX), prevAlt);
      if (before !== null && before !== now) return s;
    }
    return null;
  }

  /** An aeroplane went through it: the span parts and hangs from its supports. */
  cutSpan(s: Span, atX: number): void {
    s.cutT = 0;
    s.cutX = atX;
  }

  /**
   * The highest surface a falling crate would come to rest on at `worldX`:
   * a roof if there is a building under it, otherwise the ground.
   */
  surfaceAt(worldX: number): { altM: number; on: Hazard | null } {
    let best: { altM: number; on: Hazard | null } = { altM: 0, on: null };
    /*
     * The list is sorted by x and nothing is wider than ~60 px either side,
     * so a binary search to the left edge and a short scan is enough. The
     * reticle calls this ninety times a frame; a full scan of a town was not
     * going to survive that on a phone.
     */
    const from = worldX - 90;
    let lo = 0, hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid].x < from) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < this.list.length; i++) {
      const h = this.list[i];
      if (h.x > worldX + 90) break;
      if (!isBuilding(h.kind) || h.kind === 'substation') continue;
      if (Math.abs(worldX - h.x) > h.halfWidth) continue;
      const roof = h.roofM ?? h.heightM * 0.82;
      if (roof > best.altM) best = { altM: roof, on: h };
    }
    return best;
  }

  /**
   * The tallest thing between two points, metres — buildings,
   * pylons and cables alike. Used to tell the pilot how low they can safely
   * come for a drop.
   */
  tallestBetween(x0: number, x1: number): number {
    let top = 0;
    for (const h of this.list) {
      if (h.x + h.halfWidth >= x0 && h.x - h.halfWidth <= x1) top = Math.max(top, h.heightM);
    }
    for (const s of this.spanList) {
      if (s.cutT !== undefined || s.b < x0 || s.a > x1) continue;
      top = Math.max(top, s.topA, s.topB);
    }
    return top;
  }

  /**
   * Nearest obstacle ahead worth a warning at this altitude.
   *
   * Skips what we are already comfortably above, so the klaxon names the
   * thing we would actually hit rather than the shed in front of it.
   */
  ahead(
    worldX: number, rangePx: number, altM = -Infinity, dir: 1 | -1 = 1,
  ): { hazard: Hazard; distancePx: number } | null {
    let best: { hazard: Hazard; distancePx: number } | null = null;
    for (const h of this.list) {
      if (h.warn === false) continue;
      // "Ahead" is whichever way the aeroplane is pointing — it can turn back
      const d = (h.x - worldX) * dir;
      if (d <= 0 || d >= rangePx) continue;
      if (altM > h.heightM + 12) continue;
      if (!best || d < best.distancePx) best = { hazard: h, distancePx: d };
    }
    return best;
  }

  /** The town under a point, or starting within `aheadPx` of it. */
  townAt(worldX: number, aheadPx = 0): Town | null {
    for (const t of this.townList) {
      if (worldX >= t.x0 - aheadPx && worldX <= t.x1) return t;
    }
    return null;
  }

  get towns(): ReadonlyArray<Town> { return this.townList; }
  /** Open-country drop camps, world px — see generate. */
  get campAnchors(): ReadonlyArray<number> { return this.camps; }
  get spans(): ReadonlyArray<Span> { return this.spanList; }

  isHostile(worldX: number): boolean {
    return this.hostile.some(([a, b]) => worldX >= a && worldX <= b);
  }

  /** The raider-held stretches, so their occupants can be placed inside them. */
  get zones(): ReadonlyArray<[number, number]> { return this.hostile; }

  /** Distance to the start of the next hostile stretch, or null. */
  hostileAhead(worldX: number, rangePx: number): number | null {
    let best: number | null = null;
    for (const [a] of this.hostile) {
      const d = a - worldX;
      if (d > 0 && d < rangePx && (best === null || d < best)) best = d;
    }
    return best;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  draw(
    g: Phaser.GameObjects.Graphics,
    scrollX: number,
    baseY: number,
    pxPerM: number,
    width: number,
    t: number,
    style: ObstacleStyle,
  ): void {
    // Hostile ground: a dirty haze band with raider camp markers
    for (const [a, b] of this.hostile) {
      const x0 = a - scrollX, x1 = b - scrollX;
      if (x1 < -60 || x0 > width + 60) continue;
      const sx0 = Math.max(-60, x0), sx1 = Math.min(width + 60, x1);
      g.fillStyle(0x5a1408, 0.10);
      g.fillRect(sx0, baseY - 34, sx1 - sx0, 34);
      // Tattered marker poles along the boundary
      for (const px of [x0, x1]) {
        if (px < -20 || px > width + 20) continue;
        g.lineStyle(2, 0x2a1008, 1);
        g.lineBetween(px, baseY, px, baseY - 26);
        g.fillStyle(0x8a1c10, 0.85);
        const flap = Math.sin(t * 4 + px * 0.01) * 2;
        g.fillTriangle(px, baseY - 26, px + 14, baseY - 22 + flap, px, baseY - 15);
      }
    }

    const centreX = width / 2;
    // The leftovers in the open country, first — everything else stands in front
    for (const p of this.props) {
      const sx = p.x - scrollX;
      if (sx > -120 && sx < width + 120) drawProp(g, p, sx, baseY, pxPerM, t, style, centreX);
    }
    // Towns: the road and barricades, then the buildings standing on them
    for (const town of this.townList) {
      if (town.x1 - scrollX < -200 || town.x0 - scrollX > width + 200) continue;
      drawTownGround(g, town, scrollX, baseY, width, style);
    }
    /*
     * Depth before any fronts: every roof and side wall in view, from the
     * edges of the screen inward, so a building nearer the middle covers the
     * wall of the one beside it — and every front then covers the depth of
     * whatever stands behind it.
     */
    const inView = this.list.filter(h => h.x - scrollX > -140 && h.x - scrollX < width + 140);
    inView.sort((a, b) => Math.abs(b.x - scrollX - centreX) - Math.abs(a.x - scrollX - centreX));
    for (const h of inView) {
      const sx = h.x - scrollX;
      if (isBuilding(h.kind)) drawBuildingDepth(g, h, sx, baseY, pxPerM, style, centreX);
      else drawObstacleDepth(g, h.kind, sx, baseY, baseY - h.heightM * pxPerM, h.halfWidth, h.seed, style, centreX);
    }
    for (const h of this.list) {
      const sx = h.x - scrollX;
      if (sx < -140 || sx > width + 140) continue;
      const topY = baseY - h.heightM * pxPerM;
      if (isBuilding(h.kind)) drawBuilding(g, h, sx, baseY, pxPerM, t, style);
      else drawObstacle(g, h.kind, sx, baseY, topY, h.halfWidth, h.seed, t, style);
      if (h.damage) this.drawStruck(g, h, sx, baseY, topY, t);
    }
    // Poles, then every cable last so a conductor sits in front of its support
    for (const town of this.townList) {
      if (town.x1 - scrollX < -200 || town.x0 - scrollX > width + 200) continue;
      for (const p of town.poles) {
        const sx = p.x - scrollX;
        if (sx > -30 && sx < width + 30) drawPole(g, p, sx, baseY, pxPerM, style.daylight);
      }
    }
    for (const s of this.spanList) drawSpan(g, s, scrollX, baseY, pxPerM, width, t, style);
  }

  /**
   * What a structure looks like after an aeroplane went through it: the top
   * sheared away, torn metal at the break, fire in the wound and a smoke
   * column climbing off it.
   */
  private drawStruck(
    g: Phaser.GameObjects.Graphics,
    h: Hazard, sx: number, baseY: number, topY: number, t: number,
  ): void {
    const d = h.damage ?? 0;
    const age = h.hitAge ?? 0;
    const w = h.halfWidth;

    // Sheared, blackened stub where the aircraft came through
    g.fillStyle(0x14100c, 0.85 * d);
    g.fillRect(sx - w * 0.9, topY - 4, w * 1.8, 10);
    g.lineStyle(2, 0x0a0806, 0.9 * d);
    for (let i = -2; i <= 2; i++) {
      const jx = sx + i * w * 0.34;
      g.lineBetween(jx, topY + 4, jx + (i % 2 ? 4 : -5), topY - 9 - ((i * 7) % 9));
    }

    // Fire in the wound, dying back over about twelve seconds
    const fire = Math.max(0, 1 - age / 12) * d;
    if (fire > 0.02) {
      const fl = 0.55 + Math.sin(t * 9 + h.seed) * 0.45;
      g.fillStyle(0xff6a20, 0.5 * fire * fl);
      g.fillEllipse(sx, topY + 2, w * 1.5, 20);
      g.fillStyle(0xffc250, 0.55 * fire * fl);
      g.fillEllipse(sx, topY, w * 0.8, 12);
    }

    // Smoke climbing off it — this is what you see from a distance
    const smoke = Math.max(0, 1 - age / 26) * d;
    for (let k = 0; k < 7; k++) {
      const drift = (t * 16 + k * 34 + h.seed * 7) % 190;
      g.fillStyle(0x191512, 0.26 * smoke * (1 - k / 8));
      g.fillEllipse(sx + Math.sin(t * 0.5 + k) * (5 + k * 5) + drift * 0.22,
        topY - 12 - drift, 16 + k * 9, 12 + k * 6);
    }

    // Debris scattered at the foot of it
    g.fillStyle(0x120f0b, 0.7 * d);
    for (let k = 0; k < 5; k++) {
      const dx = sx + ((k * 37) % 90) - 45;
      g.fillRect(dx, baseY - 3 - (k % 2), 7 + (k % 3) * 4, 3);
    }
  }
}
