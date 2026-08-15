import Phaser from 'phaser';
import { drawObstacle, type ObstacleKind, type ObstacleStyle } from './Obstacles';

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

export type HazardKind = ObstacleKind;

export interface Hazard {
  x: number;          // world px
  kind: HazardKind;
  heightM: number;    // metres — compared directly against aircraft altitude
  halfWidth: number;  // world px, collision half-width
  seed: number;
}

/*
 * Engagement altitudes now live per-weapon in Raiders.ts (WEAPONS): a rifle
 * over sandbags and a wheeled autocannon do not share a ceiling, and the
 * whole point of the hostile zones is that you have to read which is which.
 */

/** Height range in metres for each obstacle, and its collision footprint. */
const HEIGHT_BAND: Record<HazardKind, [number, number]> = {
  mast:    [34, 78],   // the one that genuinely makes you climb
  turbine: [36, 68],
  stack:   [26, 54],
  tower:   [18, 40],
  pylon:   [22, 38],
  crane:   [16, 34],
};

const HALF_WIDTH: Record<HazardKind, number> = {
  mast: 11, turbine: 14, stack: 15, tower: 22, pylon: 20, crane: 30,
};

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class Hazards {
  private list: Hazard[] = [];
  private hostile: Array<[number, number]> = [];

  /** Lay out obstacles and hostile ground between the two airfields. */
  generate(startPx: number, endPx: number, seed: number): void {
    this.list = [];
    this.hostile = [];
    const span = endPx - startPx;
    if (span <= 0) return;

    // Obstacles: spaced with a guaranteed gap so the route is always flyable.
    // These are WORLD PIXELS — at 6 px/m a 2400 px gap is ~400 m of flying.
    const minGap = 2400;
    let x = startPx + 1800;
    let i = seed * 31;
    while (x < endPx - 400) {
      // Weighted so the tall ones — the masts and turbines that actually force
      // a climb — stay uncommon, and the low clutter is what you meet most.
      const r = hash(i++);
      const kind: HazardKind =
        r < 0.22 ? 'mast' :
        r < 0.42 ? 'tower' :
        r < 0.58 ? 'crane' :
        r < 0.74 ? 'pylon' :
        r < 0.89 ? 'stack' : 'turbine';
      const band = HEIGHT_BAND[kind];
      const heightM = band[0] + hash(i++) * (band[1] - band[0]);
      this.list.push({ x, kind, heightM, halfWidth: HALF_WIDTH[kind], seed: i });
      x += minGap + hash(i++) * 3000;
    }

    // Hostile stretches: raider-held bands wide enough to be a real crossing
    // (~800–1400 m), not a sliver you clear before the warning lands.
    const zoneCount = 1 + Math.floor(hash(seed * 7) * 2);
    for (let z = 0; z < zoneCount; z++) {
      const centre = startPx + span * (0.28 + 0.44 * hash(seed * 13 + z));
      const half = 2400 + hash(seed * 17 + z) * 1800;
      this.hostile.push([centre - half, centre + half]);
    }
  }

  /** The obstacle the aircraft is currently inside, if any. */
  collisionAt(worldX: number, altitudeM: number): Hazard | null {
    for (const h of this.list) {
      if (Math.abs(worldX - h.x) <= h.halfWidth && altitudeM <= h.heightM) return h;
    }
    return null;
  }

  /** Nearest obstacle ahead of the aircraft, for the HUD warning. */
  ahead(worldX: number, rangePx: number): { hazard: Hazard; distancePx: number } | null {
    let best: { hazard: Hazard; distancePx: number } | null = null;
    for (const h of this.list) {
      const d = h.x - worldX;
      if (d > 0 && d < rangePx && (!best || d < best.distancePx)) {
        best = { hazard: h, distancePx: d };
      }
    }
    return best;
  }

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

    for (const h of this.list) {
      const sx = h.x - scrollX;
      if (sx < -140 || sx > width + 140) continue;
      const topY = baseY - h.heightM * pxPerM;
      drawObstacle(g, h.kind, sx, baseY, topY, h.halfWidth, h.seed, t, style);
    }
  }

}
