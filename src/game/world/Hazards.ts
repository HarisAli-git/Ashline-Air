import Phaser from 'phaser';

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

export type HazardKind = 'mast' | 'tower' | 'crane';

export interface Hazard {
  x: number;          // world px
  kind: HazardKind;
  heightM: number;    // metres — compared directly against aircraft altitude
  halfWidth: number;  // world px, collision half-width
  seed: number;
}

/** Below this altitude (m) raiders in a hostile stretch open fire. */
export const GROUND_FIRE_CEILING = 50;

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
      const r = hash(i++);
      const kind: HazardKind = r < 0.45 ? 'mast' : r < 0.78 ? 'tower' : 'crane';
      const heightM =
        kind === 'mast' ? 26 + hash(i++) * 34 :
        kind === 'tower' ? 17 + hash(i++) * 22 :
        15 + hash(i++) * 16;
      this.list.push({
        x,
        kind,
        heightM,
        halfWidth: kind === 'crane' ? 26 : kind === 'tower' ? 20 : 10,
        seed: i,
      });
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
    daylight: number,
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
      if (sx < -80 || sx > width + 80) continue;
      const topY = baseY - h.heightM * pxPerM;
      const bodyH = baseY - topY;
      if (bodyH <= 2) continue;

      switch (h.kind) {
        case 'mast': {
          // Guyed lattice radio mast with an aircraft warning light
          g.lineStyle(1, 0x2a2620, 0.75);
          g.lineBetween(sx, baseY, sx - bodyH * 0.32, baseY);
          g.lineBetween(sx, baseY - bodyH * 0.55, sx - bodyH * 0.32, baseY);
          g.lineBetween(sx, baseY, sx + bodyH * 0.32, baseY);
          g.lineBetween(sx, baseY - bodyH * 0.55, sx + bodyH * 0.32, baseY);

          g.lineStyle(2.2, 0x33302a, 1);
          g.lineBetween(sx - 4, baseY, sx - 1, topY);
          g.lineBetween(sx + 4, baseY, sx + 1, topY);
          g.lineStyle(1, 0x33302a, 0.9);
          const rungs = Math.max(4, Math.floor(bodyH / 14));
          for (let r = 1; r < rungs; r++) {
            const y = baseY - (bodyH * r) / rungs;
            const w = 4 - (3 * r) / rungs;
            g.lineBetween(sx - w, y, sx + w, y);
          }
          // Strobe on top — the thing you should be looking for at night
          const on = Math.sin(t * 3) > 0;
          if (on) {
            g.fillStyle(0xff3020, 0.95);
            g.fillCircle(sx, topY - 2, 2.6);
            g.fillStyle(0xff3020, 0.25 + (1 - daylight) * 0.25);
            g.fillCircle(sx, topY - 2, 8);
          }
          break;
        }
        case 'tower': {
          // Ruined concrete tower, jagged top, dead windows
          g.fillStyle(0x1a1713, 1);
          g.beginPath();
          g.moveTo(sx - h.halfWidth, baseY);
          g.lineTo(sx - h.halfWidth, topY + 8);
          g.lineTo(sx - h.halfWidth * 0.3, topY);
          g.lineTo(sx + h.halfWidth * 0.4, topY + 5);
          g.lineTo(sx + h.halfWidth, topY + 12);
          g.lineTo(sx + h.halfWidth, baseY);
          g.closePath();
          g.fillPath();
          g.fillStyle(0x000000, 0.5);
          for (let wy = topY + 18; wy < baseY - 8; wy += 15) {
            for (let wx = sx - h.halfWidth + 5; wx < sx + h.halfWidth - 4; wx += 10) {
              if (hash(wx + wy + h.seed) < 0.6) g.fillRect(wx, wy, 4, 6);
            }
          }
          break;
        }
        default: {
          // Gantry crane, cable and hook swinging in the wind
          const legSpread = h.halfWidth;
          g.lineStyle(2.4, 0x3a3128, 1);
          g.lineBetween(sx - legSpread, baseY, sx - 3, topY);
          g.lineBetween(sx + legSpread, baseY, sx + 3, topY);
          g.lineBetween(sx - 3, topY, sx + legSpread * 1.6, topY - 4);
          g.lineStyle(1.2, 0x3a3128, 0.9);
          g.lineBetween(sx + legSpread * 1.6, topY - 4, sx + 3, topY - 14);
          g.lineBetween(sx + 3, topY - 14, sx - 3, topY);
          const swing = Math.sin(t * 0.8 + h.seed) * 6;
          g.lineStyle(1, 0x2a241c, 0.9);
          g.lineBetween(sx + legSpread * 1.3, topY - 3, sx + legSpread * 1.3 + swing, topY + 26);
          g.fillStyle(0x2a241c, 1);
          g.fillRect(sx + legSpread * 1.3 + swing - 3, topY + 26, 6, 5);
          break;
        }
      }
    }
  }

}
