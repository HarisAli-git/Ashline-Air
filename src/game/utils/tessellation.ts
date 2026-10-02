import Phaser from 'phaser';

/**
 * Circles and ellipses, traced only as finely as the eye can see.
 *
 * Phaser records every fillCircle as an arc stepped at 1% of a turn — a
 * hundred vertices whether it is a sun or a one-pixel pebble — and every
 * fillEllipse as 32 points, and both are rebuilt and re-triangulated every
 * frame. The world draws thousands of them (the scree on every ridge, every
 * sandbag, every head in a crowd), and tracing them was the largest single
 * cost in a frame when profiled on 2026-10-02.
 *
 * The count here is the smallest that keeps the outline within a twentieth
 * of a pixel of the true curve — finer than antialiasing can show — and never
 * more than Phaser used, so nothing is drawn coarser than the eye resolves
 * or finer than it was.
 */

/**
 * Largest gap allowed between the true curve and its polygon, px. A quarter
 * pixel flipped ~70x more edge pixels than the rasteriser's own noise in a
 * side-by-side test; at 0.05 the difference is ~10x the noise and invisible.
 */
const MAX_ERROR_PX = 0.05;
const MIN_SEGMENTS = 8;
/** Phaser's own counts: its arc steps 1% of a turn; fillEllipse defaults to 32. */
const CIRCLE_MAX = 100;
const ELLIPSE_MAX = 32;

export function segmentsFor(radius: number, max: number): number {
  const c = 1 - MAX_ERROR_PX / Math.max(radius, 1e-6);
  const n = Math.ceil(Math.PI / Math.acos(Math.max(-1, c)));
  return Math.max(MIN_SEGMENTS, Math.min(max, n));
}

/** One buffer for every call — fillPoints copies the numbers out of it. */
const ring: Array<{ x: number; y: number }> = [];

function trace(cx: number, cy: number, rx: number, ry: number, n: number): typeof ring {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const p = ring[i] ?? (ring[i] = { x: 0, y: 0 });
    p.x = cx + Math.cos(a) * rx;
    p.y = cy + Math.sin(a) * ry;
  }
  ring.length = n;
  return ring;
}

let installed = false;

/** Swap Phaser's tracing for the adaptive one. Call once, before the game boots. */
export function installAdaptiveTessellation(): void {
  if (installed) return;
  installed = true;
  const proto = Phaser.GameObjects.Graphics.prototype;
  proto.fillCircle = function (this: Phaser.GameObjects.Graphics, x: number, y: number, radius: number) {
    return this.fillPoints(trace(x, y, radius, radius, segmentsFor(radius, CIRCLE_MAX)), true);
  };
  proto.fillEllipse = function (
    this: Phaser.GameObjects.Graphics, x: number, y: number, width: number, height: number, smoothness?: number,
  ) {
    const n = smoothness ?? segmentsFor(Math.max(width, height) / 2, ELLIPSE_MAX);
    return this.fillPoints(trace(x, y, width / 2, height / 2, n), true);
  };
}
