import Phaser from 'phaser';
import type { AircraftVisualSpec } from './AircraftVisualSpec';

/**
 * The aeroplane seen from behind — the middle of a turn.
 *
 * A side-scroller can mirror a sprite, but a mirror is a flip, not a turn: the
 * aeroplane snaps from facing one way to the other in a frame. A real 180 goes
 * through the moment where it is pointing away from you and all you see is the
 * tail, the wings banked over, and the discs of the props. So the turn runs
 * the side view down to nothing, crossfades into this, banks it, and runs the
 * mirrored side view back up — and that middle beat is what sells it as an
 * aeroplane turning round rather than a picture being flipped.
 *
 * Built from the same visual spec as the side view, so each airframe's tail
 * view is its own: the biplane's two wings and struts, the bush plane's high
 * wing, the freighter's T-tail, the heavy's four engines. Design units,
 * centred on the fuselage datum, drawn once and redrawn only when the gear
 * moves.
 */

/** Real wingspan as a fraction of length — a side view never shows it. */
function spanRatio(spec: AircraftVisualSpec): number {
  if (spec.wing.layout === 'biplane') return 1.3;
  return spec.engines.some(e => !e.nose) ? (spec.engines.length > 2 ? 1.3 : 1.05) : 1.35;
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

const pt = (x: number, y: number): Phaser.Geom.Point => new Phaser.Geom.Point(x, y);

export function drawTailView(
  g: Phaser.GameObjects.Graphics, spec: AircraftVisualSpec, gearDown: boolean, contactY: number,
): void {
  g.clear();
  const pal = spec.palette;
  const H = spec.height;
  const half = (spec.length * spanRatio(spec)) / 2;
  const hull = pal.hull, shade = pal.hullShade, light = pal.hullLight;
  const dark = mix(shade, 0x000000, 0.45);
  const layout = spec.wing.layout;
  const wingYs = layout === 'biplane' ? [-H * 0.66, H * 0.3] : layout === 'high' ? [-H * 0.44] : [H * 0.26];
  const taildragger = spec.gear.tailWheelX !== null;

  // ── Gear, behind everything else ────────────────────────────────────────
  if (gearDown) {
    const r = spec.gear.wheelR;
    const floor = contactY;                        // wheels rest here
    const mainX = taildragger ? H * 1.05 : H * 0.62;
    g.lineStyle(2.2, mix(pal.metal, 0x000000, 0.3), 1);
    for (const s of [-1, 1]) {
      g.lineBetween(s * H * 0.3, H * 0.42, s * mainX, floor - r);
      if (taildragger) g.lineBetween(s * H * 0.2, wingYs[wingYs.length - 1] + 2, s * mainX, floor - r * 1.2);
      g.fillStyle(0x1b1916, 1);
      g.fillRoundedRect(s * mainX - r * 0.5, floor - r * 2, r, r * 2, r * 0.45);
      g.fillStyle(mix(pal.metal, 0x000000, 0.2), 1);
      g.fillRect(s * mainX - r * 0.18, floor - r * 1.2, r * 0.36, r * 0.4);
    }
    // Nose or tail wheel on the centreline, small and far away
    const cr = r * (taildragger ? 0.5 : 0.7);
    g.lineStyle(1.6, mix(pal.metal, 0x000000, 0.3), 1);
    g.lineBetween(0, H * 0.4, 0, floor - cr * 2);
    g.fillStyle(0x1b1916, 1);
    g.fillRoundedRect(-cr * 0.5, floor - cr * 2, cr, cr * 2, cr * 0.4);
  }

  // ── A propeller disc seen end on is a full circle ───────────────────────
  const noseEngine = spec.engines.find(e => e.nose);
  if (noseEngine) {
    const pr = spec.prop.r * 1.02;
    g.fillStyle(0xd8dde2, 0.07);
    g.fillCircle(0, 0, pr);
    g.lineStyle(1.2, 0xe8ecef, 0.22);
    g.strokeCircle(0, 0, pr);
  }

  // ── Wings: a long plank with a little dihedral, lit from above ──────────
  const nacelles = [...new Set(spec.engines.filter(e => !e.nose).map(e => Math.round(e.frac * 100)))];
  for (const [i, wy] of wingYs.entries()) {
    const tipRise = half * 0.05;
    const root = 3.4, tip = 2.2;
    g.fillStyle(hull, 1);
    g.fillPoints([
      pt(-half, wy - tipRise - tip / 2), pt(0, wy - root / 2), pt(half, wy - tipRise - tip / 2),
      pt(half, wy - tipRise + tip / 2), pt(0, wy + root / 2), pt(-half, wy - tipRise + tip / 2),
    ], true);
    g.lineStyle(0.9, light, 0.9);
    g.lineBetween(-half, wy - tipRise - tip / 2, 0, wy - root / 2);
    g.lineBetween(0, wy - root / 2, half, wy - tipRise - tip / 2);
    g.lineStyle(0.9, dark, 0.8);
    g.lineBetween(-half, wy - tipRise + tip / 2, 0, wy + root / 2);
    g.lineBetween(0, wy + root / 2, half, wy - tipRise + tip / 2);
    // Nav lights: red on the left tip, green on the right — seen from behind
    if (i === 0) {
      g.fillStyle(0xff3a2a, 1);
      g.fillCircle(-half, wy - tipRise, 1.8);
      g.fillStyle(0x6aff8a, 1);
      g.fillCircle(half, wy - tipRise, 1.8);
    }
  }
  // Biplane struts between the two wings
  if (layout === 'biplane') {
    g.lineStyle(1.3, dark, 1);
    for (const s of [-1, 1]) {
      g.lineBetween(s * half * 0.62, wingYs[0] - half * 0.03, s * half * 0.62, wingYs[1] - half * 0.03);
      g.lineBetween(s * half * 0.2, wingYs[0], s * half * 0.2, wingYs[1]);
    }
  }
  // High wing struts down to the fuselage
  if (layout === 'high' && !spec.engines.some(e => !e.nose)) {
    g.lineStyle(1.3, dark, 1);
    for (const s of [-1, 1]) g.lineBetween(s * half * 0.45, wingYs[0] + 1.5, s * H * 0.36, H * 0.3);
  }

  // ── Engines on the wing: nacelle, jet pipe, prop disc ───────────────────
  for (const f of nacelles) {
    const e = spec.engines.find(x => !x.nose && Math.round(x.frac * 100) === f)!;
    const rN = e.cowlH * 0.5;
    const wy = wingYs[0];
    for (const s of [-1, 1]) {
      const x = s * half * (f / 100) * 0.95;
      const y = wy + rN * 0.5;
      g.fillStyle(0xd8dde2, 0.06);
      g.fillCircle(x, y, spec.prop.r * 0.95);
      g.lineStyle(1, 0xe8ecef, 0.18);
      g.strokeCircle(x, y, spec.prop.r * 0.95);
      g.fillStyle(shade, 1);
      g.fillCircle(x, y, rN);
      g.fillStyle(light, 0.6);
      g.fillCircle(x - rN * 0.25, y - rN * 0.3, rN * 0.35);
      g.fillStyle(0x14120e, 1);
      g.fillCircle(x, y + rN * 0.1, rN * 0.42);
    }
  }

  // ── Fuselage, end on ────────────────────────────────────────────────────
  const fw = H * 0.8;
  g.fillStyle(hull, 1);
  g.fillEllipse(0, 0, fw, H);
  g.fillStyle(0x000000, 0.22);
  g.fillEllipse(fw * 0.14, H * 0.12, fw * 0.7, H * 0.75);
  g.fillStyle(light, 0.35);
  g.fillEllipse(-fw * 0.16, -H * 0.18, fw * 0.45, H * 0.4);
  // Gear sponsons on the transports
  if (spec.gear.sponson) {
    g.fillStyle(mix(hull, shade, 0.35), 1);
    for (const s of [-1, 1]) g.fillEllipse(s * fw * 0.48, H * 0.3, fw * 0.4, H * 0.42);
  }
  // Tail cone / exhaust of a nose engine, a dark ring at the centre
  g.fillStyle(dark, 0.9);
  g.fillCircle(0, H * 0.05, H * 0.12);

  // ── Tailplane and fin ───────────────────────────────────────────────────
  const finTop = -H * 0.5 - spec.tail.finHeight;
  const halfStab = half * 0.34;
  const stabY = spec.tail.tTail ? finTop + 2 : -H * 0.22;
  g.fillStyle(hull, 1);
  g.fillPoints([
    pt(-halfStab, stabY - 1.2), pt(halfStab, stabY - 1.2), pt(halfStab, stabY + 1.2), pt(-halfStab, stabY + 1.2),
  ], true);
  g.lineStyle(0.8, light, 0.8);
  g.lineBetween(-halfStab, stabY - 1.2, halfStab, stabY - 1.2);
  g.fillStyle(mix(hull, shade, 0.2), 1);
  g.fillPoints([pt(-2.4, -H * 0.3), pt(2.4, -H * 0.3), pt(1.4, finTop), pt(-1.4, finTop)], true);
  g.fillStyle(pal.accent, 0.9);
  g.fillRect(-1.6, finTop + 2, 3.2, spec.tail.finHeight * 0.22);
  // Tail light
  g.fillStyle(0xffffff, 0.9);
  g.fillCircle(0, finTop, 1.3);
}
