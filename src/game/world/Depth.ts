import type Phaser from 'phaser';

function mix(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * u) << 16) | (Math.round(ag + (bg - ag) * u) << 8) | Math.round(ab + (bb - ab) * u);
}

/**
 * Depth for things that were drawn as flat fronts.
 *
 * The world is a side view, and every building, tank and container in it was
 * a single face standing on the ground line — a stage flat. Here each one gets
 * the rest of its volume: its outline is carried back into the scene toward a
 * vanishing point at the middle of the screen and slightly lifted, so you look
 * down onto roofs and along whichever wall faces the middle. As the world
 * scrolls, a building on the right shows its left wall, passes under you
 * showing only its roof, and leaves showing its right wall — which is the one
 * cue that tells the eye these are solids and not scenery.
 *
 * Only the look changes. Collision, drop targets and clearance all answer to
 * the front face, exactly as before.
 */

/** How strongly depth converges on the middle of the screen. Larger = flatter. */
const FOCAL = 1400;
/** How far up the back of a thing appears, per pixel of depth: the camera is above. */
const LIFT = 0.28;
/** The same low sun, on the left, that throws every shadow to the right. */
const SUN_X = -0.55, SUN_Y = -0.83;

export interface DepthOffset {
  ox: number;
  oy: number;
}

/** Where the back of a thing `depthPx` deep appears, relative to its front. */
export function depthOffset(sx: number, centreX: number, depthPx: number): DepthOffset {
  return { ox: ((centreX - sx) * depthPx) / FOCAL, oy: -depthPx * LIFT };
}

/** A vertex of a front outline; `roof` marks the edge from here to the next. */
export interface OutlinePt {
  x: number;
  y: number;
  roof?: boolean;
}

/**
 * Carry an outline back by `o` and fill the faces that can be seen: the ones
 * whose outward side points the way the back has moved. Lit by the sun on the
 * left, with the tops picking up a little of the sky.
 *
 * Faces are laid down back to front across the outline, so a stepped
 * roofline (a sawtooth, a church tower over its nave) overlaps itself the
 * right way round.
 */
export function extrude(
  g: Phaser.GameObjects.Graphics, pts: ReadonlyArray<OutlinePt>, o: DepthOffset,
  wall: number, roof: number, sky: number, alpha = 1,
): void {
  const n = pts.length;
  if (n < 2 || (Math.abs(o.ox) < 0.2 && Math.abs(o.oy) < 0.2)) return;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    area += p.x * q.y - q.x * p.y;
  }
  const sgn = area >= 0 ? 1 : -1;
  const faces: Array<{ key: number; i: number; color: number }> = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const nx = (sgn * dy) / len, ny = (-sgn * dx) / len;
    if (nx * o.ox + ny * o.oy <= 0.05) continue;
    const base = p.roof ? roof : wall;
    const light = Math.max(0, nx * SUN_X + ny * SUN_Y);
    let c = mix(0x000000, base, 0.52 + 0.46 * light);
    if (ny < -0.6) c = mix(c, sky, 0.12);
    const key = ((p.x + q.x) / 2) * Math.sign(o.ox || 1) + (p.y + q.y) / 2;
    faces.push({ key, i, color: c });
  }
  faces.sort((a, b) => a.key - b.key);
  for (const f of faces) {
    const p = pts[f.i], q = pts[(f.i + 1) % n];
    g.fillStyle(f.color, alpha);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(q.x, q.y);
    g.lineTo(q.x + o.ox, q.y + o.oy);
    g.lineTo(p.x + o.ox, p.y + o.oy);
    g.closePath();
    g.fillPath();
  }
}

/** A plain box standing on `baseY`, `x0`..`x1` wide, `h` tall. */
export function extrudeBox(
  g: Phaser.GameObjects.Graphics, x0: number, x1: number, baseY: number, h: number,
  o: DepthOffset, wall: number, sky: number, roof = wall,
): void {
  extrude(g, [
    { x: x0, y: baseY }, { x: x0, y: baseY - h, roof: true }, { x: x1, y: baseY - h }, { x: x1, y: baseY },
  ], o, wall, roof, sky);
}

/**
 * The visible side wall of a box as a strip at height `y`, for floor lines
 * and windows running back along it. Returns the front x of that wall, or
 * null when neither side wall shows (the thing is dead ahead).
 */
export function sideWallX(x0: number, x1: number, o: DepthOffset): number | null {
  if (o.ox > 0.6) return x1;
  if (o.ox < -0.6) return x0;
  return null;
}
