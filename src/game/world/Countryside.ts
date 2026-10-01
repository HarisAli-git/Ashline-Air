import Phaser from 'phaser';
import { mix, type ObstacleStyle } from './Obstacles';
import type { BiomeId } from './Biomes';
import { depthOffset, extrude, extrudeBox, type DepthOffset } from './Depth';

/**
 * The land between the towns.
 *
 * With towns and power lines in, the stretches between them were still bare
 * ground with the odd mast — nothing that said who had lived here or what
 * happened to them. Each country now has its own leftovers: farms and
 * windpumps on the basin, nodding oil pumps in the red rock, tank farms and
 * container stacks round the works, boats rotting on the marsh, cabins in
 * the high country, and everywhere the traffic that never made it out.
 *
 * All of it is low and none of it is solid — it is there to be flown over,
 * to say where you are, and to make low flying feel like flying over
 * somewhere rather than over a floor.
 */

export type PropKind =
  | 'farm' | 'windpump' | 'pumpjack' | 'car' | 'bus' | 'convoy' | 'tanks'
  | 'containers' | 'boat' | 'cabin' | 'crashed_plane' | 'billboard' | 'graves';

export interface Prop {
  x: number;
  kind: PropKind;
  seed: number;
  biome: BiomeId;
}

const M = 9;

function hash(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** What each country leaves lying about, by relative weight. */
const TABLE: Record<BiomeId, Partial<Record<PropKind, number>>> = {
  basin:      { farm: 0.30, windpump: 0.20, car: 0.12, convoy: 0.10, graves: 0.10, billboard: 0.10, crashed_plane: 0.08 },
  redrock:    { pumpjack: 0.34, car: 0.14, convoy: 0.16, billboard: 0.14, crashed_plane: 0.10, graves: 0.12 },
  industrial: { tanks: 0.28, containers: 0.28, pumpjack: 0.10, bus: 0.16, billboard: 0.10, car: 0.08 },
  ashland:    { car: 0.18, bus: 0.18, convoy: 0.20, crashed_plane: 0.12, graves: 0.16, billboard: 0.16 },
  saltmarsh:  { boat: 0.40, cabin: 0.22, windpump: 0.12, car: 0.12, graves: 0.14 },
  cinder:     { tanks: 0.22, pumpjack: 0.20, containers: 0.20, bus: 0.18, crashed_plane: 0.20 },
  highreach:  { cabin: 0.36, graves: 0.16, car: 0.14, crashed_plane: 0.16, windpump: 0.18 },
};

/**
 * One prop every ~250-500 m, kept out of the towns and the power corridors
 * so it never fights them for the same ground.
 */
export function layoutCountryside(
  startPx: number, endPx: number, seed: number,
  reserved: ReadonlyArray<[number, number]>, biomeAt: (x: number) => BiomeId,
): Prop[] {
  const out: Prop[] = [];
  let x = startPx + 1200 * M * hash(seed + 3);
  let i = 0;
  while (x < endPx - 200 * M && i < 600) {
    const s = seed * 131 + i * 17;
    const free = !reserved.some(([a, b]) => x > a - 60 && x < b + 60);
    if (free) {
      const biome = biomeAt(x);
      const table = TABLE[biome];
      const total = Object.values(table).reduce((a, b) => a + (b ?? 0), 0);
      let r = hash(s) * total;
      let kind: PropKind = 'car';
      for (const [k, w] of Object.entries(table) as Array<[PropKind, number]>) {
        r -= w;
        if (r <= 0) { kind = k; break; }
      }
      out.push({ x, kind, seed: s, biome });
    }
    x += (250 + hash(s + 1) * 250) * M;
    i++;
  }
  return out;
}

const DARK = 0x16120e;
const RUST = 0x6a3a1c;

/**
 * How much larger than true scale the props are drawn. Like the buildings,
 * they are judged against the aircraft sprite, which is drawn far larger than
 * its real span — at true size a barn was a red dot on the horizon. None of
 * this is solid, so there is no collision to keep in step with.
 */
const PROP_SCALE = 1.45;

/** One prop standing on `baseY`. */
export function drawProp(
  g: Phaser.GameObjects.Graphics, p: Prop, sx: number, baseY: number, pxPerM: number,
  t: number, style: ObstacleStyle, centreX = sx,
): void {
  g.save();
  g.translateCanvas(sx, baseY);
  g.scaleCanvas(PROP_SCALE, PROP_SCALE);
  // Depth is worked out on screen, then brought into the prop's own frame
  const view = (depthPx: number): DepthOffset => {
    const o = depthOffset(sx, centreX, depthPx * PROP_SCALE);
    return { ox: o.ox / PROP_SCALE, oy: o.oy / PROP_SCALE };
  };
  drawPropAt(g, p, 0, 0, pxPerM, t, style, view);
  g.restore();
}

/** The prop in its own frame: standing on (sx, baseY), heights in metres. */
function drawPropAt(
  g: Phaser.GameObjects.Graphics, p: Prop, sx: number, baseY: number, pxPerM: number,
  t: number, style: ObstacleStyle, view: (depthPx: number) => DepthOffset,
): void {
  const m = (v: number): number => v * pxPerM;
  const h = (i: number): number => hash(p.seed + i);
  const dl = style.daylight;
  const lit = (c: number): number => mix(c, style.rim, 0.14);
  const snowy = p.biome === 'highreach';

  // Contact shadow so nothing floats
  g.fillStyle(0x000000, 0.18 + dl * 0.08);
  g.fillEllipse(sx + 6, baseY + 1, 70, 6);

  switch (p.kind) {
    case 'farm': {
      // A barn with a gambrel roof, a fence line, and a ploughed field long dead
      const bw = 58, bh = m(6.5);
      extrude(g, [
        { x: sx - bw / 2, y: baseY }, { x: sx - bw / 2, y: baseY - bh * 0.6 },
        { x: sx - bw / 2 - 3, y: baseY - bh * 0.6, roof: true }, { x: sx - bw * 0.32, y: baseY - bh * 0.9, roof: true },
        { x: sx, y: baseY - bh, roof: true }, { x: sx + bw * 0.32, y: baseY - bh * 0.9, roof: true },
        { x: sx + bw / 2 + 3, y: baseY - bh * 0.6 }, { x: sx + bw / 2, y: baseY - bh * 0.6 }, { x: sx + bw / 2, y: baseY },
      ], view(46), lit(0x5a2e22), snowy ? 0xe8eef0 : lit(0x3a2a22), style.rim);
      g.fillStyle(lit(0x5a2e22), 1);
      g.fillRect(sx - bw / 2, baseY - bh * 0.62, bw, bh * 0.62);
      g.fillStyle(lit(0x3a2a22), 1);
      g.fillPoints([
        new Phaser.Geom.Point(sx - bw / 2 - 3, baseY - bh * 0.6), new Phaser.Geom.Point(sx - bw * 0.32, baseY - bh * 0.9),
        new Phaser.Geom.Point(sx, baseY - bh), new Phaser.Geom.Point(sx + bw * 0.32, baseY - bh * 0.9),
        new Phaser.Geom.Point(sx + bw / 2 + 3, baseY - bh * 0.6),
      ], true);
      g.lineStyle(1.2, 0xc8b8a0, 0.6);
      g.strokeRect(sx - 9, baseY - bh * 0.5, 18, bh * 0.5);
      g.lineBetween(sx - 9, baseY - bh * 0.5, sx + 9, baseY);
      g.lineBetween(sx + 9, baseY - bh * 0.5, sx - 9, baseY);
      // Furrows and a sagging fence
      g.lineStyle(1, 0x2a2016, 0.5);
      for (let k = 0; k < 6; k++) g.lineBetween(sx + bw / 2 + 10 + k * 14, baseY, sx + bw / 2 + 18 + k * 14, baseY - 1.5);
      g.lineStyle(1, 0x2a2016, 0.9);
      for (let k = 0; k < 7; k++) g.lineBetween(sx - bw / 2 - 70 + k * 10, baseY, sx - bw / 2 - 70 + k * 10, baseY - 7);
      g.lineBetween(sx - bw / 2 - 70, baseY - 5, sx - bw / 2 - 10, baseY - 4 - h(2) * 2);
      if (snowy) { g.lineStyle(2, 0xe8eef0, 0.9); g.lineBetween(sx - bw * 0.32, baseY - bh * 0.9, sx, baseY - bh); g.lineBetween(sx, baseY - bh, sx + bw * 0.32, baseY - bh * 0.9); }
      break;
    }
    case 'windpump': {
      // Farm windpump: lattice tower, tail vane, a wheel of blades turning slowly
      const th = m(9);
      g.lineStyle(1.3, lit(0x3a352c), 1);
      g.lineBetween(sx - 7, baseY, sx - 2, baseY - th);
      g.lineBetween(sx + 7, baseY, sx + 2, baseY - th);
      for (let k = 1; k < 5; k++) {
        const y = baseY - (th * k) / 5, w = 7 - (5 * k) / 5;
        g.lineBetween(sx - w, y, sx + w, y - th / 5);
      }
      const hy = baseY - th - 2;
      const spin = t * (1.2 + h(3)) + h(4) * 6;
      g.lineStyle(1.4, lit(0x5a554a), 1);
      for (let k = 0; k < 12; k++) {
        const a = spin + (k / 12) * Math.PI * 2;
        g.lineBetween(sx, hy, sx + Math.cos(a) * 3.2, hy + Math.sin(a) * 11);
      }
      g.fillStyle(lit(0x3a352c), 1);
      g.fillTriangle(sx - 2, hy, sx - 18, hy - 5, sx - 18, hy + 4);
      // Stock tank at the foot
      extrudeBox(g, sx + 8, sx + 24, baseY, 5, view(10), lit(0x4a4a44), style.rim);
      g.fillStyle(lit(0x4a4a44), 1);
      g.fillRect(sx + 8, baseY - 5, 16, 5);
      break;
    }
    case 'pumpjack': {
      // Nodding donkey, still pumping for someone
      const nod = Math.sin(t * 1.6 + h(1) * 6) * 0.28;
      g.fillStyle(lit(0x3a3028), 1);
      g.fillRect(sx - 26, baseY - 3, 52, 3);
      g.lineStyle(2, lit(0x4a4030), 1);
      g.lineBetween(sx - 6, baseY, sx, baseY - m(5.5));
      g.lineBetween(sx + 6, baseY, sx, baseY - m(5.5));
      const px0 = sx, py0 = baseY - m(5.5);
      const bx = Math.cos(nod) * 24, by = Math.sin(nod) * 24;
      g.lineStyle(3, lit(0x6a4a24), 1);
      g.lineBetween(px0 - bx, py0 - by, px0 + bx, py0 + by);
      // Horse head at the front, counterweight at the back
      g.fillStyle(lit(0x6a4a24), 1);
      g.fillRect(px0 + bx - 2, py0 + by - 5, 7, 10);
      g.lineStyle(1, 0x1a1612, 1);
      g.lineBetween(px0 + bx + 4, py0 + by + 4, sx + 24, baseY - 3);
      g.fillStyle(lit(0x3a3028), 1);
      g.fillCircle(sx - 16, baseY - 9, 6);
      break;
    }
    case 'car': {
      drawCar(g, sx, baseY, h(1), style, false, view(10));
      if (h(2) > 0.5) drawCar(g, sx + 30, baseY, h(3), style, true, view(10));
      break;
    }
    case 'bus': {
      const bw = 50, bh = m(3);
      const tilt = (h(1) - 0.5) * 0.08;
      extrude(g, [
        { x: sx - bw / 2, y: baseY - 2 }, { x: sx - bw / 2, y: baseY - bh + tilt * 30, roof: true },
        { x: sx + bw / 2 - 3, y: baseY - bh - tilt * 30 }, { x: sx + bw / 2, y: baseY - 2 },
      ], view(11), lit(0x6a5a2a), lit(0x7a6a3a), style.rim);
      g.fillStyle(lit(0x6a5a2a), 1);
      g.fillPoints([
        new Phaser.Geom.Point(sx - bw / 2, baseY - 2), new Phaser.Geom.Point(sx - bw / 2, baseY - bh + tilt * 30),
        new Phaser.Geom.Point(sx + bw / 2 - 3, baseY - bh - tilt * 30), new Phaser.Geom.Point(sx + bw / 2, baseY - 2),
      ], true);
      g.fillStyle(DARK, 0.9);
      for (let k = 0; k < 6; k++) g.fillRect(sx - bw / 2 + 4 + k * 7.5, baseY - bh + 2.5, 5, bh * 0.35);
      g.fillStyle(RUST, 0.5);
      g.fillRect(sx - bw / 2, baseY - bh * 0.45, bw, 2);
      g.fillStyle(0x0c0a08, 1);
      g.fillCircle(sx - bw / 2 + 9, baseY - 1, 3);
      g.fillCircle(sx + bw / 2 - 9, baseY - 1, 3);
      break;
    }
    case 'convoy': {
      // The ones that did not get out: a truck, cars nose to tail, one burnt
      extrudeBox(g, sx - 30, sx, baseY - 2, m(2.6) - 2, view(10), lit(0x3e4232), style.rim);
      extrudeBox(g, sx, sx + 11, baseY - 2, m(1.9) - 2, view(9), lit(0x3e4232), style.rim);
      g.fillStyle(lit(0x3e4232), 1);
      g.fillRect(sx - 30, baseY - m(2.6), 30, m(2.6) - 2);
      g.fillRect(sx, baseY - m(1.9), 11, m(1.9) - 2);
      g.fillStyle(0x0c0a08, 1);
      g.fillCircle(sx - 24, baseY - 1, 3); g.fillCircle(sx - 10, baseY - 1, 3); g.fillCircle(sx + 5, baseY - 1, 3);
      drawCar(g, sx + 30, baseY, h(1), style, false, view(10));
      drawCar(g, sx + 58, baseY, h(2), style, true, view(10));
      drawCar(g, sx - 56, baseY, h(3), style, false, view(10));
      break;
    }
    case 'tanks': {
      // Fuel storage: two squat tanks with a catwalk and a rust bloom
      for (const [dx, r, th] of [[-22, 18, 7], [20, 14, 5.5]] as Array<[number, number, number]>) {
        const top = baseY - m(th);
        g.fillStyle(lit(0x7a756a), 1);
        g.fillRect(sx + dx - r, top, r * 2, baseY - top);
        g.fillEllipse(sx + dx, top, r * 2, 5);
        g.fillStyle(0x000000, 0.25);
        g.fillRect(sx + dx + r * 0.3, top, r * 0.7, baseY - top);
        g.fillStyle(RUST, 0.45);
        g.fillRect(sx + dx - r * 0.6, top + 4, 3, (baseY - top) * 0.6);
        g.lineStyle(1, DARK, 0.6);
        g.lineBetween(sx + dx - r, top + (baseY - top) * 0.5, sx + dx + r, top + (baseY - top) * 0.5);
      }
      g.lineStyle(1, DARK, 0.9);
      g.lineBetween(sx - 4, baseY - m(6.2), sx + 6, baseY - m(5.2));
      break;
    }
    case 'containers': {
      const cols = [0x6a2a1c, 0x2a4a5a, 0x5a5a2a, 0x3a3a3a, 0x7a4a1c];
      const ch = m(2.6), cw = 34;
      // Every box's depth before any box's front, outermost first, the
      // stacked row last — they stand close enough to hide each other's sides
      const o = view(14);
      const order = [0, 1, 2, 3, 4].sort((a, b) =>
        ((a < 3 ? 0 : 1e6) + (a % 3) * Math.sign(o.ox || 1)) - ((b < 3 ? 0 : 1e6) + (b % 3) * Math.sign(o.ox || 1)));
      for (const k of order) {
        const row = k < 3 ? 0 : 1;
        const cx = sx - 50 + (k % 3) * (cw + 2) + row * 18;
        const top = baseY - ch * (row + 1);
        extrudeBox(g, cx, cx + cw, top + ch - 0.5, ch - 0.5, o, lit(cols[Math.floor(h(k) * cols.length)]), style.rim);
      }
      for (let k = 0; k < 5; k++) {
        const row = k < 3 ? 0 : 1;
        const cx = sx - 50 + (k % 3) * (cw + 2) + row * 18;
        const top = baseY - ch * (row + 1);
        g.fillStyle(lit(cols[Math.floor(h(k) * cols.length)]), 1);
        g.fillRect(cx, top, cw, ch - 0.5);
        g.lineStyle(0.8, DARK, 0.5);
        for (let r = 4; r < cw; r += 4) g.lineBetween(cx + r, top + 1, cx + r, top + ch - 1.5);
      }
      break;
    }
    case 'boat': {
      // A fishing boat hauled out and left, listing on its keel
      const lean = (h(1) - 0.5) * 0.25;
      g.fillStyle(lit(0x4a5a5a), 1);
      g.fillPoints([
        new Phaser.Geom.Point(sx - 26, baseY - m(2.4)), new Phaser.Geom.Point(sx + 28, baseY - m(2.6) + lean * 20),
        new Phaser.Geom.Point(sx + 18, baseY), new Phaser.Geom.Point(sx - 18, baseY),
      ], true);
      g.fillStyle(lit(0xc8c0a8), 0.9);
      g.fillRect(sx - 20, baseY - m(2.4) - 1, 44, 2);
      g.fillStyle(lit(0x5a4a3a), 1);
      g.fillRect(sx - 4, baseY - m(4.2), 14, m(1.8));
      g.lineStyle(1.3, lit(0x3a3028), 1);
      g.lineBetween(sx + 2, baseY - m(4.2), sx + 2 + lean * 20, baseY - m(8.5));
      g.lineStyle(0.7, 0x3a3028, 0.7);
      g.lineBetween(sx + 2 + lean * 20, baseY - m(8.5), sx + 26, baseY - m(2.6));
      break;
    }
    case 'cabin': {
      const onStilts = p.biome === 'saltmarsh';
      const lift = onStilts ? m(2.2) : 0;
      const cw = 40, ch = m(3.4), roof = m(2.6);
      const base = baseY - lift;
      if (onStilts) {
        g.lineStyle(1.8, lit(0x3a3028), 1);
        for (const dx of [-16, -4, 8, 17]) g.lineBetween(sx + dx, baseY, sx + dx, base);
      }
      extrude(g, [
        { x: sx - cw / 2, y: base }, { x: sx - cw / 2, y: base - ch }, { x: sx - cw / 2 - 4, y: base - ch, roof: true },
        { x: sx, y: base - ch - roof, roof: true }, { x: sx + cw / 2 + 4, y: base - ch }, { x: sx + cw / 2, y: base - ch },
        { x: sx + cw / 2, y: base },
      ], view(30), lit(snowy ? 0x4a3424 : 0x4a4038), snowy ? 0xe8eef0 : lit(0x2c2420), style.rim);
      g.fillStyle(lit(snowy ? 0x4a3424 : 0x4a4038), 1);
      g.fillRect(sx - cw / 2, base - ch, cw, ch);
      g.lineStyle(0.8, DARK, 0.45);
      for (let y = base - ch + 3; y < base; y += 3) g.lineBetween(sx - cw / 2, y, sx + cw / 2, y);
      g.fillStyle(lit(0x2c2420), 1);
      g.fillTriangle(sx - cw / 2 - 4, base - ch, sx, base - ch - roof, sx + cw / 2 + 4, base - ch);
      if (snowy) {
        g.lineStyle(2.4, 0xe8eef0, 0.95);
        g.lineBetween(sx - cw / 2 - 4, base - ch, sx, base - ch - roof);
        g.lineBetween(sx, base - ch - roof, sx + cw / 2 + 4, base - ch);
      }
      g.fillStyle(dl < 0.5 ? 0xe8a848 : DARK, dl < 0.5 ? 0.8 : 0.9);
      g.fillRect(sx - 12, base - ch + 4, 6, 5);
      g.fillStyle(DARK, 1);
      g.fillRect(sx + 6, base - ch * 0.75, 7, ch * 0.75);
      // Woodsmoke
      for (let k = 0; k < 4; k++) {
        const d = (t * 8 + k * 10 + p.seed) % 36;
        g.fillStyle(0x3a3530, 0.14 * (1 - k / 5));
        g.fillEllipse(sx + 10 + d * 0.4, base - ch - roof - d, 5 + k * 3, 4 + k * 2);
      }
      break;
    }
    case 'crashed_plane': {
      // An old airliner that came down short: fuselage broken, tail standing
      g.fillStyle(lit(0x8a8a82), 1);
      g.fillPoints([
        new Phaser.Geom.Point(sx - 44, baseY - 2), new Phaser.Geom.Point(sx - 40, baseY - m(3.2)),
        new Phaser.Geom.Point(sx + 4, baseY - m(3.4)), new Phaser.Geom.Point(sx + 8, baseY - 1),
      ], true);
      g.fillStyle(lit(0x7a7a72), 1);
      g.fillPoints([
        new Phaser.Geom.Point(sx + 14, baseY - 1), new Phaser.Geom.Point(sx + 16, baseY - m(2.8)),
        new Phaser.Geom.Point(sx + 44, baseY - m(2.2)), new Phaser.Geom.Point(sx + 48, baseY - 1),
      ], true);
      g.fillStyle(lit(0x6a6a62), 1);
      g.fillTriangle(sx + 34, baseY - m(2.4), sx + 46, baseY - m(2.3), sx + 44, baseY - m(6.2));
      g.fillStyle(DARK, 0.85);
      for (let k = 0; k < 5; k++) g.fillRect(sx - 36 + k * 7, baseY - m(2.6), 3, 3);
      g.fillStyle(0x0a0806, 0.6);
      g.fillRect(sx + 4, baseY - m(3.4), 12, m(3.4));
      g.lineStyle(1.4, lit(0x5a5a52), 1);
      g.lineBetween(sx - 20, baseY - 2, sx - 6, baseY - m(1.2));
      break;
    }
    case 'billboard': {
      const bh = m(7), bw = 50;
      g.lineStyle(2, lit(0x3a3028), 1);
      g.lineBetween(sx - 16, baseY, sx - 16, baseY - bh);
      g.lineBetween(sx + 16, baseY, sx + 16, baseY - bh);
      const board = [0x8a6a3a, 0x3a5a6a, 0x7a3a2a][Math.floor(h(1) * 3)];
      extrudeBox(g, sx - bw / 2, sx + bw / 2, baseY - bh, m(2.8), view(3), lit(0x3a3028), style.rim);
      g.fillStyle(lit(board), 1);
      g.fillRect(sx - bw / 2, baseY - bh - m(2.8), bw, m(2.8));
      // Peeled panels and a slogan nobody can read now
      g.fillStyle(lit(0xc8b890), 0.65);
      g.fillRect(sx - bw / 2 + 4, baseY - bh - m(2.2), bw * 0.5, 2.5);
      g.fillRect(sx - bw / 2 + 4, baseY - bh - m(1.2), bw * 0.32, 2);
      g.fillStyle(DARK, 0.8);
      g.fillTriangle(sx + bw / 2 - 12, baseY - bh - m(2.8), sx + bw / 2, baseY - bh - m(2.8), sx + bw / 2, baseY - bh - m(1));
      break;
    }
    case 'graves': {
      // A roadside cemetery — crosses, some fresh
      g.lineStyle(1.3, lit(0x4a4030), 1);
      for (let k = 0; k < 7; k++) {
        const gx = sx - 30 + k * 10 + (h(k) - 0.5) * 3;
        const gh = 5 + h(k + 9) * 2;
        g.lineBetween(gx, baseY, gx, baseY - gh);
        g.lineBetween(gx - 2.5, baseY - gh + 1.8, gx + 2.5, baseY - gh + 1.8);
        g.fillStyle(0x2a2016, 0.6);
        g.fillEllipse(gx, baseY + 0.5, 7, 2.5);
      }
      break;
    }
  }
}

function drawCar(
  g: Phaser.GameObjects.Graphics, x: number, baseY: number, r: number, style: ObstacleStyle, burnt = false,
  o: DepthOffset = { ox: 0, oy: 0 },
): void {
  const body = burnt ? 0x1c1712 : mix([0x5a3a2a, 0x3a4a5a, 0x5a5a4a, 0x6a2a22][Math.floor(r * 4)], style.rim, 0.12);
  const tip = r > 0.8;   // one in five on its side
  if (tip) extrudeBox(g, x - 6, x + 3, baseY, 12, o, body, style.rim);
  else {
    extrude(g, [
      { x: x - 11, y: baseY - 1.5 }, { x: x - 11, y: baseY - 6, roof: true }, { x: x - 6, y: baseY - 6 },
      { x: x - 6, y: baseY - 9.5, roof: true }, { x: x + 6, y: baseY - 9.5 }, { x: x + 6, y: baseY - 6, roof: true },
      { x: x + 11, y: baseY - 6 }, { x: x + 11, y: baseY - 1.5 },
    ], o, body, mix(body, 0xffffff, 0.08), style.rim);
  }
  g.fillStyle(body, 1);
  if (tip) {
    g.fillRect(x - 6, baseY - 12, 9, 12);
    g.fillStyle(0x0c0a08, 1);
    g.fillCircle(x + 4, baseY - 3, 2.4);
    g.fillCircle(x + 4, baseY - 10, 2.4);
    return;
  }
  g.fillRect(x - 11, baseY - 6, 22, 4.5);
  g.fillRect(x - 6, baseY - 9.5, 12, 4);
  g.fillStyle(0x0c0a08, 0.85);
  g.fillRect(x - 5, baseY - 9, 4, 3);
  g.fillRect(x + 1, baseY - 9, 4, 3);
  g.fillCircle(x - 6, baseY - 1.5, 2.4);
  g.fillCircle(x + 6, baseY - 1.5, 2.4);
}
