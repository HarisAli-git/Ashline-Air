import Phaser from 'phaser';
import type { Hazard } from './Hazards';
import { mix, type ObstacleStyle } from './Obstacles';
import { drawWireFence } from './Figures';

/**
 * Where people actually live, and the wires that feed them.
 *
 * The route between two airfields used to be empty country with a mast or a
 * crane every few hundred metres, and the pylons carried cables that ran
 * a hundred pixels out into the sky and stopped. Nothing was connected to
 * anything, so nothing looked like it had ever been built for a reason.
 *
 * Towns change what low flying means. A supply drop pulls you down to thirty
 * metres, and a town at thirty metres is a street of roofs with a tower block
 * in the middle of it, wires strung between the poles at eight metres, and a
 * power line coming in from the substation at twice that. Every one of those
 * is solid. The whole point is that the drop is worth making AND that getting
 * down to where you can make it is a piece of flying in its own right.
 *
 * Everything is laid out once per route from the seed, like the rest of the
 * route furniture: fly a leg twice and the towns are where you left them.
 */

/** World px per metre — the same scale ParallaxWorld uses. */
const M = 9;

export type BuildingKind =
  | 'shack' | 'house' | 'block' | 'warehouse' | 'highrise'
  | 'church' | 'silo' | 'watertower' | 'substation';

const BUILDING_KINDS = new Set<string>([
  'shack', 'house', 'block', 'warehouse', 'highrise', 'church', 'silo', 'watertower', 'substation',
]);

export function isBuilding(kind: string): kind is BuildingKind {
  return BUILDING_KINDS.has(kind);
}

/** What the collision call names it — "STRUCK A BLOCK" meant nothing. */
export const STRUCTURE_NAME: Record<string, string> = {
  mast: 'RADIO MAST', tower: 'RUINED TOWER', crane: 'CRANE', turbine: 'WIND TURBINE',
  pylon: 'PYLON', stack: 'CHIMNEY', shack: 'SHACK', house: 'HOUSE', block: 'BUILDING',
  warehouse: 'WAREHOUSE', highrise: 'TOWER BLOCK', church: 'CHURCH SPIRE', silo: 'GRAIN SILO',
  watertower: 'WATER TOWER', substation: 'SUBSTATION',
};

/** A wooden pole along the street, or the heavier one a feeder ends on. */
export interface Pole {
  x: number;
  heightM: number;
  /** The end of the line: heavier, stayed, and carrying a transformer. */
  terminal: boolean;
  seed: number;
}

/**
 * One run of cable between two supports.
 *
 * Stored as its two anchors rather than as points, so the sag is the same
 * curve for the renderer and for the collision test.
 */
export interface Span {
  /** Support centres, world px, a < b. */
  a: number;
  b: number;
  /** How far the cross-arm reaches out from each support, px. */
  armA: number;
  armB: number;
  /** Height of the top conductor at each end, metres. */
  topA: number;
  topB: number;
  /** Vertical spacing of the conductors at each end, metres. */
  gapA: number;
  gapB: number;
  strands: number;
  /** Metres of droop at mid-span. */
  sag: number;
  kind: 'power' | 'street';
  seed: number;
  /** Seconds since an aeroplane went through it; undefined while intact. */
  cutT?: number;
  cutX?: number;
}

export interface Town {
  name: string;
  x0: number;
  x1: number;
  seed: number;
  /** The open square in the middle of it, world px. */
  squareX: number;
  squareHalf: number;
  buildings: Hazard[];
  /** A flat roof people have retreated to, if there is one fit for it. */
  refuge: Hazard | null;
  poles: Pole[];
}

export interface Substation {
  x: number;
  seed: number;
  hazard: Hazard;
}

export interface RouteSettlements {
  towns: Town[];
  pylons: Hazard[];
  spans: Span[];
  substations: Substation[];
  /** World-px ranges already built on, so isolated obstacles keep clear. */
  reserved: Array<[number, number]>;
}

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const TOWN_NAMES = [
  'Millbrook', 'Dry Fork', 'Hollow Creek', 'Rustwater', 'Kettle Hill', 'Gallows Bend',
  "Tinker's Rest", 'Copperhead', 'Lowmarsh', 'Bitterwell', 'Stillwater', 'Harrow',
  'Red Quarry', 'Brackwater', 'Emberfield', 'Cold Spring', 'Widow Hill', 'Morrow',
  'Sandgate', 'Pale Ford', 'Holloway', 'Crowfoot', 'Deacon', 'Longmire',
];

/** Half-width in px and height band in metres, by kind. */
const FOOTPRINT: Record<BuildingKind, { hw: [number, number]; h: [number, number] }> = {
  // Sized against the aircraft, not against the metre: the plane is drawn
  // far larger than its true span, and buildings at true width read as a
  // model village a long way below rather than a street you are flying down.
  shack:      { hw: [26, 34], h: [4, 7] },
  house:      { hw: [32, 44], h: [8, 13] },
  block:      { hw: [44, 62], h: [14, 24] },
  warehouse:  { hw: [60, 84], h: [9, 14] },
  highrise:   { hw: [36, 48], h: [32, 54] },
  church:     { hw: [34, 40], h: [26, 38] },
  silo:       { hw: [18, 24], h: [20, 30] },
  watertower: { hw: [22, 26], h: [22, 32] },
  substation: { hw: [60, 60], h: [13, 13] },
};

/** Flat roofs a crate — or a family — can sit on. */
const FLAT_ROOF = new Set<BuildingKind>(['shack', 'block', 'warehouse', 'highrise', 'substation']);

/** Only structures you might genuinely fly into get the klaxon. */
const WARN_ABOVE_M = 16;

/**
 * Where a pylon's conductors hang, as fractions of its height.
 * The drawing in Obstacles.ts puts the cross-arms at 0.9 / 0.7 / 0.5 of the
 * height with insulators 0.06 long, so the cables leave from exactly here.
 */
export function pylonAnchor(heightM: number, halfWidth: number): { top: number; gap: number; arm: number } {
  return { top: heightM * 0.84, gap: heightM * 0.2, arm: halfWidth * 1.5 };
}

/** Terminal pole: where a feeder comes down into the street. */
const TERMINAL = { heightM: 11, top: 10.4, gap: 1.0, arm: 8, street: 8.4 };
/** The gantry a substation hands the line out on. */
const GANTRY = { top: 12.5, gap: 2.0, arm: 26 };

// ── Geometry ────────────────────────────────────────────────────────────────

/** Where strand `k` leaves each support, px. */
function strandEnds(s: Span, k: number): [number, number] {
  const shrink = 1 - 0.12 * k;
  return [s.a + s.armA * shrink, s.b - s.armB * shrink];
}

/** Height of strand `k` at `x`, metres, or null if `x` is off the span. */
export function strandAt(s: Span, k: number, x: number): number | null {
  const [x0, x1] = strandEnds(s, k);
  if (x < x0 || x > x1 || x1 <= x0) return null;
  const u = (x - x0) / (x1 - x0);
  const ha = s.topA - k * s.gapA;
  const hb = s.topB - k * s.gapB;
  return ha + (hb - ha) * u - s.sag * 4 * u * (1 - u);
}

/**
 * The band of cable at `x`: lowest conductor to highest, metres.
 * Null off the span, or once it has been cut.
 */
export function spanBand(s: Span, x: number): [number, number] | null {
  if (s.cutT !== undefined) return null;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < s.strands; k++) {
    const h = strandAt(s, k, x);
    if (h === null) continue;
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return lo === Infinity ? null : [lo, hi];
}

// ── Layout ──────────────────────────────────────────────────────────────────

function makeStructure(x: number, kind: BuildingKind, seed: number, hwBias = 0): Hazard {
  const f = FOOTPRINT[kind];
  const halfWidth = f.hw[0] + hash(seed) * (f.hw[1] - f.hw[0]) + hwBias;
  const heightM = f.h[0] + hash(seed + 1) * (f.h[1] - f.h[0]);
  return {
    x, kind, heightM, halfWidth, seed,
    roofM: FLAT_ROOF.has(kind) ? heightM : null,
    warn: heightM >= WARN_ABOVE_M,
  };
}

function buildTown(x0: number, x1: number, seed: number, name: string): Town {
  const width = x1 - x0;
  const squareHalf = (24 + hash(seed + 3) * 12) * M;
  const squareX = x0 + width * (0.32 + hash(seed + 4) * 0.36);
  const mid = (x0 + x1) / 2;
  const buildings: Hazard[] = [];

  let x = x0;
  let k = 0;
  let hasChurch = false, hasWater = false;
  let sinceStreet = 0;
  let nextStreet = 3 + Math.floor(hash(seed + 9) * 3);
  while (x < x1 && k < 400) {
    const s = seed * 7 + k * 13;
    const centre = 1 - Math.min(1, Math.abs(x - mid) / (width / 2));
    const r = hash(s);
    let kind: BuildingKind;
    if (!hasChurch && centre > 0.3 && hash(s + 2) < 0.07) { kind = 'church'; hasChurch = true; }
    else if (!hasWater && hash(s + 3) < 0.05) { kind = 'watertower'; hasWater = true; }
    else if (centre < 0.35 && hash(s + 4) < 0.1) kind = 'silo';
    else if (centre > 0.4 && r < 0.14) kind = 'highrise';
    else if (r < 0.40) kind = centre > 0.25 ? 'block' : 'house';
    else if (r < 0.52) kind = 'warehouse';
    else if (r < 0.80) kind = 'house';
    else kind = 'shack';
    if (centre < 0.2 && r > 0.55) kind = 'shack';

    const f = FOOTPRINT[kind];
    const hw = f.hw[0] + hash(s + 5) * (f.hw[1] - f.hw[0]);
    // Keep the square open — that is where people gather to be found
    if (x + hw * 2 > squareX - squareHalf && x < squareX + squareHalf) {
      x = squareX + squareHalf + 14;
      k++;
      continue;
    }
    if (x + hw * 2 > x1) break;
    const b = makeStructure(x + hw, kind, s + 5);
    b.halfWidth = hw;
    buildings.push(b);
    x += hw * 2 + 6 + hash(s + 6) * 16;
    // A street every few buildings, so it reads as a town and not a wall
    if (++sinceStreet >= nextStreet) {
      x += 90 + hash(s + 7) * 90;
      sinceStreet = 0;
      nextStreet = 3 + Math.floor(hash(s + 8) * 3);
    }
    k++;
  }

  /*
   * A roof to hold out on: the flat roof nearest the middle that is wide
   * enough to land a crate on. Widened a little — people who have lived up
   * there for a month have cleared every inch of it.
   */
  let refuge: Hazard | null = null;
  let best = Infinity;
  for (const b of buildings) {
    if (b.kind !== 'block' && b.kind !== 'highrise') continue;
    const d = Math.abs(b.x - mid);
    if (d < best) { best = d; refuge = b; }
  }
  if (refuge) refuge.halfWidth = Math.max(refuge.halfWidth, 58);

  // Street poles from one end of town to the other, with a terminal at each
  const poles: Pole[] = [];
  const pa = x0 - 26, pb = x1 + 26;
  const nPoles = Math.max(2, Math.round((pb - pa) / 430) + 1);
  for (let i = 0; i < nPoles; i++) {
    const terminal = i === 0 || i === nPoles - 1;
    poles.push({
      x: pa + ((pb - pa) * i) / (nPoles - 1),
      heightM: terminal ? TERMINAL.heightM : 8.2 + hash(seed + i * 3) * 1.2,
      terminal,
      seed: seed + i * 17,
    });
  }

  return { name, x0, x1, seed, squareX, squareHalf, buildings, refuge, poles };
}

/**
 * A line of pylons between two supports, and the spans that hang off it.
 * Pylons are pushed as hazards — they are the solid part of a power line.
 */
function runLine(
  out: RouteSettlements,
  xa: number, anchorA: { top: number; gap: number; arm: number },
  xb: number, anchorB: { top: number; gap: number; arm: number },
  seed: number,
): void {
  if (xb < xa) {
    runLine(out, xb, anchorB, xa, anchorA, seed);
    return;
  }
  const dist = xb - xa;
  const nSpans = Math.max(2, Math.round(dist / (135 * M)));
  const step = dist / nSpans;
  const baseH = 27 + hash(seed) * 8;
  let prevX = xa, prev = anchorA;
  for (let i = 1; i <= nSpans; i++) {
    let x: number, anchor: { top: number; gap: number; arm: number };
    if (i === nSpans) {
      x = xb;
      anchor = anchorB;
    } else {
      x = xa + step * i + (hash(seed + i) - 0.5) * step * 0.12;
      const heightM = baseH + (hash(seed + i * 3) - 0.5) * 3;
      const halfWidth = 20;
      out.pylons.push({ x, kind: 'pylon', heightM, halfWidth, seed: seed + i * 11, warn: true });
      anchor = pylonAnchor(heightM, halfWidth);
    }
    const lenM = (x - prevX) / M;
    out.spans.push({
      a: prevX, b: x, armA: prev.arm, armB: anchor.arm,
      topA: prev.top, topB: anchor.top, gapA: prev.gap, gapB: anchor.gap,
      strands: 3, sag: Math.min(9, lenM * 0.045), kind: 'power', seed: seed + i * 29,
    });
    prevX = x;
    prev = anchor;
  }
}

function overlaps(list: ReadonlyArray<[number, number]>, a: number, b: number): boolean {
  return list.some(([p, q]) => a < q && b > p);
}

/**
 * Towns, the substations that feed them, and the power lines between.
 *
 * One town per ~8.5 km, each inside its own slice of the route so they never
 * pile up, and kept well clear of both airfields — nobody wants a tower block
 * on the approach.
 */
export function layoutSettlements(startPx: number, endPx: number, seed: number): RouteSettlements {
  const out: RouteSettlements = { towns: [], pylons: [], spans: [], substations: [], reserved: [] };
  const a = startPx + 2000 * M;
  const b = endPx - 2400 * M;
  if (b - a < 700 * M) return out;
  // Anything built has to stay inside these, so feeders cannot reach the runways
  const lo = startPx + 900 * M, hi = endPx - 1500 * M;

  const n = Phaser.Math.Clamp(Math.round((b - a) / (8500 * M)), 1, 9);
  const slice = (b - a) / n;
  const firstName = Math.floor(hash(seed * 3 + 1) * TOWN_NAMES.length);
  for (let i = 0; i < n; i++) {
    const s = seed * 53 + i * 101;
    const width = Math.min(slice * 0.42, (360 + hash(s) * 420) * M);
    const room = Math.max(0, slice - width) * 0.5;
    const c = a + slice * (i + 0.5) + (hash(s + 1) - 0.5) * room;
    const name = TOWN_NAMES[(firstName + i * 7) % TOWN_NAMES.length];
    const town = buildTown(c - width / 2, c + width / 2, s, name);
    out.towns.push(town);
    out.reserved.push([town.x0 - 80, town.x1 + 80]);
  }

  // ── Feeders: substation → pylons → the terminal pole at the edge of town ──
  for (let i = 0; i < out.towns.length; i++) {
    const t = out.towns[i];
    const s = t.seed * 3 + 7;
    const first: 1 | -1 = hash(s) < 0.5 ? -1 : 1;
    const length = (480 + hash(s + 1) * 360) * M;
    for (const side of [first, -first] as Array<1 | -1>) {
      const edge = side < 0 ? t.poles[0].x : t.poles[t.poles.length - 1].x;
      const subX = edge + side * length;
      const r0 = Math.min(edge, subX) - 70, r1 = Math.max(edge, subX) + 70;
      const clear = subX - 60 > lo && subX + 60 < hi
        && !overlaps(out.reserved.filter(r => !(r[0] === t.x0 - 80 && r[1] === t.x1 + 80)), r0, r1);
      if (!clear) continue;
      const sub = makeStructure(subX, 'substation', s + 3);
      sub.warn = false;
      out.substations.push({ x: subX, seed: s + 3, hazard: sub });
      runLine(
        out, subX, GANTRY,
        edge, { top: TERMINAL.top, gap: TERMINAL.gap, arm: TERMINAL.arm }, s + 5,
      );
      out.reserved.push([r0, r1]);
      break;
    }
  }

  // ── Tie lines: two towns close enough to share a line do ──────────────────
  for (let i = 0; i + 1 < out.towns.length; i++) {
    const A = out.towns[i], B = out.towns[i + 1];
    const xa = A.poles[A.poles.length - 1].x, xb = B.poles[0].x;
    if (xb - xa > 2800 * M) continue;
    if (overlaps(out.reserved, xa + 90, xb - 90)) continue;
    const term = { top: TERMINAL.top, gap: TERMINAL.gap, arm: TERMINAL.arm };
    runLine(out, xa, term, xb, term, A.seed * 5 + 1);
    out.reserved.push([xa, xb]);
  }

  for (const t of out.towns) streetWires(out, t);
  return out;
}

/** Street wires, pole to pole through a town. */
function streetWires(out: RouteSettlements, t: Town): void {
  for (let i = 0; i + 1 < t.poles.length; i++) {
    const p = t.poles[i], q = t.poles[i + 1];
    const hp = p.terminal ? TERMINAL.street : p.heightM - 0.4;
    const hq = q.terminal ? TERMINAL.street : q.heightM - 0.4;
    out.spans.push({
      a: p.x, b: q.x, armA: 6, armB: 6, topA: hp, topB: hq, gapA: 0.9, gapB: 0.9,
      strands: 2, sag: 1.1 + hash(p.seed) * 0.6, kind: 'street', seed: p.seed,
    });
  }
}

/**
 * The training circuit's one town: placed by hand rather than rolled, with a
 * feeder coming in from a substation on the approach so the lesson meets a
 * power line before it meets the roofs.
 *
 * Kept low — no tower blocks — so the first drop anyone makes is about the
 * drop, not about threading a fifty-metre building on the way down.
 */
export function layoutTrainingSettlements(x0: number, x1: number, seed: number, name: string): RouteSettlements {
  const out: RouteSettlements = { towns: [], pylons: [], spans: [], substations: [], reserved: [] };
  const town = buildTown(x0, x1, seed, name);
  for (const b of town.buildings) {
    if (b.kind === 'highrise' || b.kind === 'church' || b.kind === 'watertower') {
      b.kind = 'block';
      b.heightM = 12 + hash(b.seed + 9) * 6;
      b.roofM = b.heightM;
      b.warn = false;
    }
  }
  town.refuge = null;
  out.towns.push(town);
  out.reserved.push([town.x0 - 80, town.x1 + 80]);
  const edge = town.poles[0].x;
  const subX = edge - 640 * M;
  const sub = makeStructure(subX, 'substation', seed + 3);
  sub.warn = false;
  out.substations.push({ x: subX, seed: seed + 3, hazard: sub });
  runLine(out, subX, GANTRY, edge, { top: TERMINAL.top, gap: TERMINAL.gap, arm: TERMINAL.arm }, seed + 5);
  out.reserved.push([subX - 70, edge + 70]);
  streetWires(out, town);
  return out;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const WALLS = [0x40392f, 0x48392c, 0x3b3934, 0x4b3e30, 0x36312b, 0x4a3326];
const TRIM = 0x15110d;
const LAMP = 0xe8a848;

/** Palette for one building, pulled toward the sky so distance reads. */
function wallFor(seed: number, style: ObstacleStyle): number {
  return mix(WALLS[Math.floor(hash(seed + 31) * WALLS.length)], style.rim, 0.10);
}

/** Lit face, shade face: the two rectangles that turn a shape into a solid. */
function faces(
  g: Phaser.GameObjects.Graphics, x0: number, y0: number, w: number, h: number, style: ObstacleStyle,
): void {
  g.fillStyle(style.rim, 0.10 + style.daylight * 0.08);
  g.fillRect(x0, y0, w * 0.36, h);
  g.fillStyle(0x000000, 0.22);
  g.fillRect(x0 + w * 0.66, y0, w * 0.34, h);
}

/**
 * A grid of windows. By day they are holes; after dark a few of them glow,
 * because people live here — that is the difference between a town and the
 * dead cities on the skyline.
 */
function windows(
  g: Phaser.GameObjects.Graphics,
  x0: number, x1: number, yTop: number, yBot: number,
  seed: number, night: number, dx = 10, dy = 11, ww = 4.5, wh = 5.5, litChance = 0.22,
): void {
  for (let y = yTop; y + wh < yBot; y += dy) {
    for (let x = x0; x + ww < x1; x += dx) {
      const r = hash(seed + x * 0.37 + y * 1.3);
      if (r < 0.12) continue;                      // bricked up
      const lit = night > 0.35 && r > 1 - litChance;
      if (lit) {
        g.fillStyle(LAMP, 0.55 + night * 0.4);
        g.fillRect(x, y, ww, wh);
      } else {
        g.fillStyle(TRIM, 0.75);
        g.fillRect(x, y, ww, wh);
      }
    }
  }
}

/** One building, standing on `baseY`, drawn to the same top the collision uses. */
export function drawBuilding(
  g: Phaser.GameObjects.Graphics,
  b: Hazard, sx: number, baseY: number, pxPerM: number, t: number, style: ObstacleStyle,
): void {
  const top = baseY - b.heightM * pxPerM;
  const h = baseY - top;
  const hw = b.halfWidth;
  const L = sx - hw, R = sx + hw;
  const wall = wallFor(b.seed, style);
  const dark = mix(wall, 0x000000, 0.45);
  const night = 1 - style.daylight;
  const seed = b.seed;

  // Cast shadow away from the low sun, like every other structure
  g.fillStyle(0x000000, 0.2 + style.daylight * 0.1);
  g.fillEllipse(sx + h * 0.28, baseY + 1, hw * 2.1 + h * 0.5, 8 + hw * 0.18);

  switch (b.kind) {
    case 'shack': {
      const eave = top + h * 0.28;
      g.fillStyle(wall, 1);
      g.fillRect(L, eave, hw * 2, baseY - eave);
      // Corrugated lean-to roof, higher at the back
      g.fillStyle(mix(0x5a3a22, style.rim, 0.12), 1);
      g.beginPath();
      g.moveTo(L - 3, eave + 2); g.lineTo(L - 3, top + h * 0.12);
      g.lineTo(R + 3, top); g.lineTo(R + 3, eave + 2);
      g.closePath(); g.fillPath();
      g.lineStyle(1, TRIM, 0.45);
      for (let x = L; x < R; x += 4) g.lineBetween(x, eave + 1, x, top + (h * 0.12) * (1 - (x - L) / (hw * 2)));
      // Patches of whatever was to hand
      g.fillStyle(mix(wall, 0x6a5a3a, 0.5), 0.8);
      g.fillRect(L + hw * 0.3, eave + 3, hw * 0.5, (baseY - eave) * 0.4);
      g.fillStyle(TRIM, 1);
      g.fillRect(sx + hw * 0.2, baseY - Math.min(h * 0.62, 12), 6, Math.min(h * 0.62, 12));
      // Stovepipe
      g.fillStyle(TRIM, 1);
      g.fillRect(R - 7, top - 6, 3, 8);
      faces(g, L, eave, hw * 2, baseY - eave, style);
      break;
    }

    case 'house': {
      const eave = top + h * 0.38;
      g.fillStyle(wall, 1);
      g.fillRect(L, eave, hw * 2, baseY - eave);
      const apex = sx - hw * 0.08;
      const roof = mix(0x2c2420, style.rim, 0.08);
      g.fillStyle(roof, 1);
      g.fillTriangle(L - 4, eave + 1, apex, top, R + 4, eave + 1);
      // Some roofs have fallen in
      if (hash(seed + 2) < 0.3) {
        g.fillStyle(TRIM, 0.95);
        g.fillTriangle(apex + 3, top + h * 0.12, R - 2, eave + 1, apex + hw * 0.35, eave + 1);
      }
      g.lineStyle(1, style.rim, 0.25);
      g.lineBetween(L - 4, eave + 1, apex, top);
      // Chimney
      g.fillStyle(dark, 1);
      g.fillRect(apex + hw * 0.4, top + h * 0.08, 5, h * 0.22);
      windows(g, L + 5, R - 4, eave + 5, baseY - 6, seed, night, 12, 10, 5, 6, 0.35);
      g.fillStyle(TRIM, 1);
      g.fillRect(sx - 3, baseY - Math.min(12, h * 0.5), 6, Math.min(12, h * 0.5));
      faces(g, L, eave, hw * 2, baseY - eave, style);
      break;
    }

    case 'block':
    case 'highrise': {
      // Broken roofline on the old towers; the refuges and blocks stay flat
      const ruined = b.kind === 'highrise' && hash(seed + 3) < 0.7;
      g.fillStyle(wall, 1);
      if (ruined) {
        const nL = h * (0.04 + hash(seed + 4) * 0.08);
        const nR = h * (0.02 + hash(seed + 5) * 0.1);
        g.beginPath();
        g.moveTo(L, baseY); g.lineTo(L, top + nL);
        g.lineTo(L + hw * 0.6, top); g.lineTo(R - hw * 0.5, top + 2);
        g.lineTo(R, top + nR); g.lineTo(R, baseY);
        g.closePath(); g.fillPath();
      } else {
        g.fillRect(L, top, hw * 2, h);
        g.fillStyle(mix(wall, style.rim, 0.3), 1);
        g.fillRect(L - 1.5, top - 2, hw * 2 + 3, 3);      // parapet
      }
      // Floor slabs, then windows
      g.fillStyle(TRIM, 0.35);
      for (let y = top + 11; y < baseY - 4; y += 11) g.fillRect(L, y, hw * 2, 1.2);
      windows(g, L + 5, R - 4, top + 5, baseY - 6, seed, night,
        b.kind === 'highrise' ? 9 : 10, 11, 4, 5.5, b.kind === 'highrise' ? 0.08 : 0.2);
      if (ruined) {
        // Rebar bristling off the break, and scorch up the face
        g.lineStyle(1, TRIM, 0.8);
        for (let k = 0; k < 5; k++) {
          const rx = L + hw * (0.3 + k * 0.3);
          g.lineBetween(rx, top + 3, rx + (k % 2 ? 3 : -3), top - 4 - (k % 3) * 3);
        }
        g.fillStyle(0x0a0806, 0.5);
        g.fillRect(sx - hw * 0.2, top + 6, 5, h * 0.35);
      } else if (hash(seed + 6) < 0.5) {
        // Roof clutter: a tank on legs or an aerial
        g.fillStyle(dark, 1);
        if (hash(seed + 7) < 0.5) {
          g.fillRect(sx + hw * 0.2, top - 9, 12, 6);
          g.lineStyle(1, dark, 1);
          g.lineBetween(sx + hw * 0.2 + 2, top - 3, sx + hw * 0.2 + 2, top);
          g.lineBetween(sx + hw * 0.2 + 10, top - 3, sx + hw * 0.2 + 10, top);
        } else {
          g.lineStyle(1.2, dark, 1);
          g.lineBetween(sx - hw * 0.4, top, sx - hw * 0.4, top - 14);
          g.lineBetween(sx - hw * 0.4 - 5, top - 10, sx - hw * 0.4 + 5, top - 10);
        }
      }
      faces(g, L, top, hw * 2, h, style);
      g.lineStyle(1, style.rim, 0.3);
      g.lineBetween(L, top + 2, L, baseY);
      break;
    }

    case 'warehouse': {
      const eave = top + h * 0.3;
      g.fillStyle(wall, 1);
      g.fillRect(L, eave, hw * 2, baseY - eave);
      // Sawtooth north-light roof
      const teeth = Math.max(2, Math.round(hw / 14));
      const tw = (hw * 2) / teeth;
      g.fillStyle(mix(0x33302a, style.rim, 0.1), 1);
      for (let i = 0; i < teeth; i++) {
        const x = L + i * tw;
        g.fillTriangle(x, eave + 1, x + tw * 0.8, top, x + tw, eave + 1);
        g.fillStyle(mix(0x8a9a9a, style.rim, 0.3), 0.35 + night * 0.2);
        g.fillRect(x + tw * 0.8 - 1.5, top + 2, 1.5, eave - top - 1);
        g.fillStyle(mix(0x33302a, style.rim, 0.1), 1);
      }
      // Roller doors and a loading dock
      g.fillStyle(TRIM, 0.9);
      const doors = Math.max(1, Math.round(hw / 22));
      for (let i = 0; i < doors; i++) {
        const dx = L + (hw * 2 * (i + 0.5)) / doors;
        g.fillRect(dx - 7, baseY - Math.min(16, (baseY - eave) * 0.7), 14, Math.min(16, (baseY - eave) * 0.7));
      }
      g.lineStyle(1, 0x6a3a1c, 0.35);
      for (let i = 0; i < 4; i++) {
        const rx = L + hash(seed + i) * hw * 2;
        g.lineBetween(rx, eave + 2, rx, eave + 8 + hash(seed + i * 3) * 12);
      }
      faces(g, L, eave, hw * 2, baseY - eave, style);
      break;
    }

    case 'church': {
      const naveTop = baseY - h * 0.36;
      g.fillStyle(wall, 1);
      g.fillRect(L, naveTop, hw * 2, baseY - naveTop);
      g.fillStyle(mix(0x2c2420, style.rim, 0.08), 1);
      g.fillTriangle(L - 3, naveTop + 1, sx + hw * 0.2, naveTop - h * 0.12, R + 3, naveTop + 1);
      // The tower, then the spire on it
      const tw = hw * 0.36;
      const tx = L + tw + 2;
      const towerTop = baseY - h * 0.72;
      g.fillStyle(mix(wall, 0x000000, 0.12), 1);
      g.fillRect(tx - tw, towerTop, tw * 2, baseY - towerTop);
      g.fillStyle(mix(0x2c2420, style.rim, 0.1), 1);
      g.fillTriangle(tx - tw - 1.5, towerTop, tx, top, tx + tw + 1.5, towerTop);
      g.lineStyle(1.2, dark, 1);
      g.lineBetween(tx, top, tx, top - 7);
      g.lineBetween(tx - 3, top - 4.5, tx + 3, top - 4.5);
      // Belfry opening and the rose window
      g.fillStyle(TRIM, 1);
      g.fillRect(tx - tw * 0.4, towerTop + 5, tw * 0.8, 8);
      g.fillStyle(night > 0.4 ? LAMP : TRIM, night > 0.4 ? 0.7 : 0.8);
      g.fillCircle(sx + hw * 0.35, naveTop + (baseY - naveTop) * 0.35, 3.5);
      faces(g, L, naveTop, hw * 2, baseY - naveTop, style);
      g.lineStyle(1, style.rim, 0.3);
      g.lineBetween(tx - tw - 1.5, towerTop, tx, top);
      break;
    }

    case 'silo': {
      const shoulder = top + hw * 0.9;
      g.fillStyle(mix(0x5a5448, style.rim, 0.14), 1);
      g.fillRect(L, shoulder, hw * 2, baseY - shoulder);
      g.fillEllipse(sx, shoulder, hw * 2, hw * 1.8);
      g.lineStyle(1, TRIM, 0.35);
      for (let y = shoulder + 8; y < baseY; y += 9) g.lineBetween(L, y, R, y);
      // Conveyor leg up to the top, and a small shed at its foot
      g.lineStyle(1.6, dark, 1);
      g.lineBetween(R + 16, baseY - 6, sx + 2, top + 3);
      g.fillStyle(dark, 1);
      g.fillRect(R + 10, baseY - 10, 14, 10);
      g.fillStyle(0x000000, 0.25);
      g.fillRect(sx + hw * 0.2, shoulder, hw * 0.8, baseY - shoulder);
      g.fillStyle(style.rim, 0.12 + style.daylight * 0.08);
      g.fillRect(L, shoulder, hw * 0.6, baseY - shoulder);
      break;
    }

    case 'watertower': {
      const tankBot = baseY - h * 0.62;
      const tankTop = baseY - h * 0.9;
      g.lineStyle(1.8, dark, 1);
      g.lineBetween(L + 2, baseY, sx - hw * 0.55, tankBot);
      g.lineBetween(R - 2, baseY, sx + hw * 0.55, tankBot);
      g.lineStyle(1, dark, 0.8);
      g.lineBetween(L + 4, baseY - (baseY - tankBot) * 0.5, R - 4, baseY - (baseY - tankBot) * 0.5);
      g.lineBetween(L + 3, baseY, R - 5, tankBot + 2);
      g.lineBetween(R - 3, baseY, L + 5, tankBot + 2);
      g.fillStyle(mix(0x4a4a44, style.rim, 0.14), 1);
      g.fillRect(L, tankTop, hw * 2, tankBot - tankTop);
      g.fillTriangle(L - 2, tankTop + 1, sx, top, R + 2, tankTop + 1);
      g.fillStyle(0x6a3a1c, 0.5);
      g.fillRect(L, tankTop + (tankBot - tankTop) * 0.45, hw * 2, 3);
      g.fillStyle(0x000000, 0.25);
      g.fillRect(sx + hw * 0.25, tankTop, hw * 0.75, tankBot - tankTop);
      break;
    }

    case 'substation': {
      // A fenced yard: transformers, the gantry the line leaves from, a hut
      drawWireFence(g, L, R, baseY, 2.2 * pxPerM, seed);
      const gantryH = GANTRY.top * pxPerM + 5;
      for (const gx of [sx - GANTRY.arm, sx + GANTRY.arm]) {
        g.lineStyle(1.6, 0x3a352c, 1);
        g.lineBetween(gx - 3, baseY, gx - 1.5, baseY - gantryH);
        g.lineBetween(gx + 3, baseY, gx + 1.5, baseY - gantryH);
        for (let y = baseY - 8; y > baseY - gantryH; y -= 8) {
          g.lineStyle(0.8, 0x3a352c, 0.8);
          g.lineBetween(gx - 3, y, gx + 3, y - 8);
        }
      }
      g.lineStyle(2, 0x3a352c, 1);
      for (let k = 0; k < 3; k++) {
        const y = baseY - (GANTRY.top - k * GANTRY.gap) * pxPerM - 4;
        g.lineBetween(sx - GANTRY.arm - 4, y, sx + GANTRY.arm + 4, y);
      }
      // Transformers with their cooling fins and bushings
      for (let i = -1; i <= 1; i += 2) {
        const tx = sx + i * 14;
        g.fillStyle(mix(0x4a4a3a, style.rim, 0.1), 1);
        g.fillRect(tx - 8, baseY - 14, 16, 14);
        g.lineStyle(1, TRIM, 0.5);
        for (let f = -6; f <= 6; f += 3) g.lineBetween(tx + f, baseY - 13, tx + f, baseY - 2);
        g.lineStyle(1.4, 0x8a7a60, 0.9);
        g.lineBetween(tx - 4, baseY - 14, tx - 4, baseY - 21);
        g.lineBetween(tx + 4, baseY - 14, tx + 4, baseY - 21);
      }
      g.fillStyle(dark, 1);
      g.fillRect(R - 20, baseY - 11, 16, 11);
      // A hazard board on the fence
      g.fillStyle(0xb89a2a, 0.9);
      g.fillTriangle(L + 8, baseY - 3, L + 16, baseY - 3, L + 12, baseY - 11);
      break;
    }

    default:
      break;
  }

  // A few chimneys smoke even now: somebody is cooking
  if ((b.kind === 'house' || b.kind === 'shack') && hash(seed + 13) < 0.35) {
    for (let k = 0; k < 4; k++) {
      const drift = (t * 9 + k * 11 + seed) % 44;
      g.fillStyle(0x2a2520, 0.16 * (1 - k / 5));
      g.fillEllipse(sx + hw * 0.4 + drift * 0.4, top - 6 - drift, 6 + k * 3, 4 + k * 2);
    }
  }
}

/**
 * The ground a town stands on: a packed road through it, rubble, a burnt-out
 * car or two, and barricades across the road at each end.
 */
export function drawTownGround(
  g: Phaser.GameObjects.Graphics, town: Town, scrollX: number, baseY: number,
  width: number, style: ObstacleStyle,
): void {
  const x0 = Math.max(-40, town.x0 - scrollX - 60);
  const x1 = Math.min(width + 40, town.x1 - scrollX + 60);
  if (x1 < x0) return;
  g.fillStyle(mix(0x3a342a, style.rim, 0.12), 0.55);
  g.fillRect(x0, baseY - 1, x1 - x0, 3);
  // The square: paved once, still lighter than the dirt around it
  const qx = town.squareX - scrollX;
  if (qx + town.squareHalf > -40 && qx - town.squareHalf < width + 40) {
    g.fillStyle(mix(0x5a5244, style.rim, 0.2), 0.45);
    g.fillRect(qx - town.squareHalf * 0.8, baseY - 1, town.squareHalf * 1.6, 3);
  }
  // Barricades at both ends — cars on their sides and sheet metal
  for (const ex of [town.x0 - scrollX - 50, town.x1 - scrollX + 50]) {
    if (ex < -60 || ex > width + 60) continue;
    g.fillStyle(0x221d17, 1);
    g.fillRect(ex - 18, baseY - 7, 36, 7);
    g.fillStyle(0x3a2a1c, 1);
    g.fillRect(ex - 12, baseY - 12, 14, 6);
    g.lineStyle(1.2, 0x1a150f, 1);
    g.lineBetween(ex - 20, baseY - 2, ex - 10, baseY - 14);
    g.lineBetween(ex + 18, baseY - 1, ex + 8, baseY - 12);
  }
  // Wrecked cars along the road
  for (let k = 0; k < 6; k++) {
    const wx = town.x0 + (town.x1 - town.x0) * hash(town.seed + k * 5) - scrollX;
    if (wx < -30 || wx > width + 30) continue;
    if (Math.abs(wx + scrollX - town.squareX) < town.squareHalf * 0.8) continue;
    g.fillStyle(0x1c1712, 1);
    g.fillRect(wx - 9, baseY - 5, 18, 4);
    g.fillRect(wx - 5, baseY - 8, 9, 3);
    g.fillStyle(0x0c0a08, 1);
    g.fillCircle(wx - 5, baseY - 1, 2);
    g.fillCircle(wx + 5, baseY - 1, 2);
  }
}

/** A wooden pole: a cross-arm, insulators, and on a terminal, a transformer. */
export function drawPole(
  g: Phaser.GameObjects.Graphics, p: Pole, sx: number, baseY: number, pxPerM: number, dl: number,
): void {
  const top = baseY - p.heightM * pxPerM;
  const wood = 0x2a2016;
  g.lineStyle(p.terminal ? 3 : 2.2, wood, 1);
  g.lineBetween(sx, baseY, sx + 0.6, top);
  const armY = baseY - (p.terminal ? TERMINAL.street : p.heightM - 0.4) * pxPerM;
  g.lineStyle(1.6, wood, 1);
  g.lineBetween(sx - 7, armY - 1, sx + 7, armY - 1);
  g.fillStyle(0x6a6a5a, 0.9);
  g.fillCircle(sx - 6, armY, 1.1);
  g.fillCircle(sx + 6, armY, 1.1);
  if (p.terminal) {
    // The feeder's own arm at the top, and the can that steps it down
    const fy = top + 2;
    g.lineStyle(2, wood, 1);
    g.lineBetween(sx - TERMINAL.arm - 2, fy, sx + TERMINAL.arm + 2, fy);
    g.fillStyle(0x3a3a34, 1);
    g.fillRect(sx + 2, armY - 12, 7, 9);
    g.lineStyle(0.9, 0x2a2a24, 0.7);
    g.lineBetween(sx, top + 4, sx - 16, baseY);
  }
  // A street lamp on every other pole, lit after dark
  if (!p.terminal && hash(p.seed) < 0.5) {
    g.lineStyle(1.2, wood, 1);
    g.lineBetween(sx, armY + 6, sx + 7, armY + 4);
    if (dl < 0.55) {
      g.fillStyle(LAMP, 0.85);
      g.fillCircle(sx + 7, armY + 6, 1.8);
      g.fillStyle(LAMP, 0.10 * (1 - dl));
      g.fillTriangle(sx + 7, armY + 6, sx - 6, baseY, sx + 20, baseY);
    }
  }
}

/**
 * The cables. Drawn after everything they hang from, so a conductor sits in
 * front of the pylon it leaves. A cut span hangs from both ends in the dirt
 * and spits sparks for a few seconds.
 */
export function drawSpan(
  g: Phaser.GameObjects.Graphics, s: Span, scrollX: number, baseY: number,
  pxPerM: number, width: number, t: number, style: ObstacleStyle,
): void {
  const l = s.a - scrollX, r = s.b - scrollX;
  if (r < -60 || l > width + 60) return;
  const col = s.kind === 'power' ? mix(0x1a1814, style.rim, 0.12) : 0x16120e;
  const thick = s.kind === 'power' ? 1.1 : 0.9;
  const yOf = (m: number): number => baseY - m * pxPerM;

  for (let k = 0; k < s.strands; k++) {
    const [xs0, xs1] = strandEnds(s, k);
    if (s.cutT === undefined) {
      g.lineStyle(thick, col, 0.9);
      g.beginPath();
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const x = xs0 + ((xs1 - xs0) * i) / n;
        const h = strandAt(s, k, x) ?? 0;
        if (i === 0) g.moveTo(x - scrollX, yOf(h));
        else g.lineTo(x - scrollX, yOf(h));
      }
      g.strokePath();
    } else {
      // Two tails hanging off the supports, swinging to a stop
      const cut = s.cutX ?? (xs0 + xs1) / 2;
      const swing = Math.sin(s.cutT * 3 + k) * 10 * Math.exp(-s.cutT * 0.6);
      const ha = s.topA - k * s.gapA, hb = s.topB - k * s.gapB;
      const lenA = Math.min(cut - xs0, ha * pxPerM * 1.1);
      const lenB = Math.min(xs1 - cut, hb * pxPerM * 1.1);
      g.lineStyle(thick, col, 0.9);
      g.beginPath();
      g.moveTo(xs0 - scrollX, yOf(ha));
      g.lineTo(xs0 - scrollX + lenA * 0.25 + swing * 0.3, yOf(ha * 0.45));
      g.lineTo(xs0 - scrollX + lenA * 0.35 + swing, baseY - 1);
      g.strokePath();
      g.beginPath();
      g.moveTo(xs1 - scrollX, yOf(hb));
      g.lineTo(xs1 - scrollX - lenB * 0.25 - swing * 0.3, yOf(hb * 0.45));
      g.lineTo(xs1 - scrollX - lenB * 0.35 - swing, baseY - 1);
      g.strokePath();
      if (s.cutT < 4 && s.kind === 'power') {
        const fl = 0.5 + Math.sin(t * 40 + k * 2) * 0.5;
        for (const ex of [xs0 - scrollX + lenA * 0.35 + swing, xs1 - scrollX - lenB * 0.35 - swing]) {
          g.fillStyle(0xbfe0ff, 0.8 * fl * (1 - s.cutT / 4));
          g.fillCircle(ex, baseY - 2, 2.5);
          g.fillStyle(0xffe890, 0.6 * fl);
          for (let j = 0; j < 3; j++) {
            g.fillCircle(ex + Math.sin(t * 17 + j * 2) * 7, baseY - 3 - Math.abs(Math.cos(t * 13 + j)) * 8, 1);
          }
        }
      }
    }
  }
}
