import Phaser from 'phaser';

/**
 * Landing gear, drawn per airframe.
 *
 * Every aircraft used to stand on the same part: one straight chrome oleo
 * with a spoked wheel on the bottom, which is a nose leg off an airliner
 * scaled up or down. On a fabric ag-biplane and on a four-engine freighter
 * alike it read as a toy — the legs were sticks, the wheels were cart wheels,
 * and nothing about the gear said what KIND of aeroplane it was.
 *
 * Real gear is one of the most characteristic things about an airframe from
 * the side, so each style here follows a real family:
 *
 *   spatted   ag-biplane (Stearman, Ag-Cat): a faired leg raked forward, a
 *             drag brace back to the belly, and a streamlined spat over the
 *             top of the wheel.
 *   bungee    bush plane (Super Cub, Beaver): two tubes in a V meeting at the
 *             axle, shock cord wrapped round the top, fat tundra tyres.
 *   trailing  regional turboprop (ATR, Dash 8): a short oleo out of the
 *             fuselage fairing and a trailing arm back to the axle.
 *   sponson   military transport (C-130): wheels in tandem tucked half up
 *             inside the fairing on stubby legs — it sits low on purpose.
 *
 * Coordinates are design units with the leg hinge at (0, 0) and the axle at
 * (rake, len). Graphics rather than baked textures, because a leg is a few
 * lines and stays crisp at any camera zoom.
 */

export type GearStyle = 'strut' | 'spatted' | 'bungee' | 'trailing' | 'sponson';

export interface GearPalette {
  hull: number;
  hullShade: number;
  hullLight: number;
  accent: number;
  metal: number;
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

const DARK_METAL = 0x2a2620;
const CHROME = 0xd8d4c8;

/** The main leg, hinge to axle. */
export function drawMainLeg(
  g: Phaser.GameObjects.Graphics, style: GearStyle, len: number, rake: number, r: number, pal: GearPalette,
): void {
  const metal = pal.metal;
  const metalDark = mix(metal, 0x000000, 0.45);
  switch (style) {
    case 'spatted': {
      // Drag brace from the belly back to the axle fitting
      g.lineStyle(1.1, metalDark, 1);
      g.lineBetween(-10, 0.5, rake - 1, len - r * 0.6);
      // The faired leg itself, painted like the airframe it belongs to
      g.fillStyle(pal.hull, 1);
      g.fillPoints([
        new Phaser.Geom.Point(-2.8, 0), new Phaser.Geom.Point(2.4, 0),
        new Phaser.Geom.Point(rake + 1.8, len - r * 0.7), new Phaser.Geom.Point(rake - 2.2, len - r * 0.7),
      ], true);
      g.lineStyle(0.8, pal.hullLight, 0.8);
      g.lineBetween(2.4, 0, rake + 1.8, len - r * 0.7);
      g.lineStyle(0.8, mix(pal.hullShade, 0x000000, 0.4), 0.9);
      g.lineBetween(-2.8, 0, rake - 2.2, len - r * 0.7);
      break;
    }
    case 'bungee': {
      // Rear tube, then the front one over it
      g.lineStyle(1.9, metalDark, 1);
      g.lineBetween(-12, 0.5, rake, len);
      g.lineStyle(2.1, metal, 1);
      g.lineBetween(5, 0, rake, len);
      g.lineStyle(0.7, mix(metal, 0xffffff, 0.35), 0.8);
      g.lineBetween(5.6, 0.4, rake + 0.6, len - 0.6);
      // Shock cord wrapped round the top of the front tube
      for (let k = 0; k < 3; k++) {
        const t = 0.12 + k * 0.07;
        const x = 5 + (rake - 5) * t, y = len * t;
        g.fillStyle(0x1a1814, 1);
        g.fillEllipse(x, y, 4.2, 1.8);
      }
      // Axle fitting
      g.fillStyle(DARK_METAL, 1);
      g.fillCircle(rake, len, 2.2);
      break;
    }
    case 'trailing': {
      const knee = len * 0.5;
      // Oleo out of the fairing, polished lower half
      g.lineStyle(3, metal, 1);
      g.lineBetween(0, 0, 0, knee);
      g.lineStyle(1.8, CHROME, 0.9);
      g.lineBetween(0, knee * 0.45, 0, knee);
      // Trailing arm back to the axle
      g.lineStyle(2.6, metalDark, 1);
      g.lineBetween(0, knee, rake, len);
      g.fillStyle(DARK_METAL, 1);
      g.fillCircle(0, knee, 1.8);
      g.fillCircle(rake, len, 2.2);
      break;
    }
    case 'sponson': {
      // Stubby and mostly hidden — the fairing hangs down over it
      g.lineStyle(3.4, metalDark, 1);
      g.lineBetween(0, 0, rake, len);
      g.lineStyle(1.6, CHROME, 0.7);
      g.lineBetween(0.4, len * 0.35, rake + 0.4, len * 0.8);
      break;
    }
    default: {
      g.lineStyle(3, metal, 1);
      g.lineBetween(0, 0, rake, len);
      g.lineStyle(1.8, CHROME, 0.85);
      g.lineBetween(rake * 0.5, len * 0.55, rake * 0.95, len * 0.92);
    }
  }
}

/** A steerable nose leg: oleo, polished piston, torque link, taxi light. */
export function drawNoseLeg(g: Phaser.GameObjects.Graphics, len: number, rake: number, r: number, pal: GearPalette): void {
  const metal = pal.metal;
  const up = len * 0.55;
  const ux = rake * 0.55;
  g.lineStyle(3, metal, 1);
  g.lineBetween(0, 0, ux, up);
  g.lineStyle(2, CHROME, 0.95);
  g.lineBetween(ux, up, rake, len - r * 0.55);
  // Torque link on the trailing side
  g.lineStyle(1, mix(metal, 0x000000, 0.4), 1);
  g.lineBetween(ux - 1.2, up - 1, ux - 3.2, up + (len - up) * 0.4);
  g.lineBetween(ux - 3.2, up + (len - up) * 0.4, rake - 1.2, len - r * 0.7);
  // Fork over the wheel
  g.fillStyle(DARK_METAL, 1);
  g.fillRoundedRect(rake - 2.4, len - r - 1.2, 4.8, 3, 1);
  // Taxi light
  g.fillStyle(0xfff2c8, 0.95);
  g.fillCircle(ux * 0.6 + 1.6, up * 0.6, 1.1);
}

/** A leaf-spring tail wheel leg, bowing aft. */
export function drawTailSpring(g: Phaser.GameObjects.Graphics, len: number, pal: GearPalette): { ax: number } {
  const ax = -Math.max(3, len * 0.5);
  g.lineStyle(1.8, mix(pal.metal, 0x000000, 0.35), 1);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(-0.8, len * 0.35);
  g.lineTo(ax * 0.55, len * 0.72);
  g.lineTo(ax, len);
  g.strokePath();
  g.fillStyle(DARK_METAL, 1);
  g.fillCircle(ax, len, 1.4);
  return { ax };
}

/**
 * A streamlined spat over the top of the wheel, painted in the airframe's
 * colours with its trim stripe. It does not turn — only the tyre below it
 * does, which is exactly how a spatted wheel looks rolling.
 */
export function drawSpat(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number, pal: GearPalette): void {
  const P = (x: number, y: number): Phaser.Geom.Point => new Phaser.Geom.Point(cx + x * r, cy + y * r);
  const outline = [
    P(1.12, 0.05), P(1.0, -0.5), P(0.62, -0.92), P(0, -1.12), P(-0.8, -0.98),
    P(-1.5, -0.62), P(-1.95, -0.2), P(-1.5, 0.1), P(-0.8, 0.3), P(0.3, 0.34), P(0.95, 0.28),
  ];
  g.fillStyle(pal.hull, 1);
  g.fillPoints(outline, true);
  g.fillStyle(mix(pal.hullShade, 0x000000, 0.2), 0.9);
  g.fillPoints([P(-1.5, 0.1), P(-0.8, 0.3), P(0.3, 0.34), P(0.95, 0.28), P(1.1, 0.1), P(-1.6, -0.05)], true);
  g.lineStyle(1.1, pal.accent, 0.95);
  g.lineBetween(cx - 1.6 * r, cy - 0.32 * r, cx + 1.02 * r, cy - 0.32 * r);
  g.lineStyle(0.8, pal.hullLight, 0.8);
  g.beginPath();
  g.moveTo(cx + 0.95 * r, cy - 0.5 * r);
  g.lineTo(cx + 0.6 * r, cy - 0.92 * r);
  g.lineTo(cx, cy - 1.1 * r);
  g.lineTo(cx - 0.8 * r, cy - 0.96 * r);
  g.strokePath();
}
