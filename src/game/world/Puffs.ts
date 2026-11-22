import type Phaser from 'phaser';
import type { SpritePool } from './SpritePool';

/**
 * Smoke, steam and signal smoke, wherever in the world they are drawn.
 *
 * Every plume in the game — a struck mast burning, the green smoke a drop site
 * puts up, a chimney, a flare's trail — was a stack of hard-edged ellipses at
 * low opacity, and read as a pile of discs. Those plumes are drawn deep inside
 * the hazard, town and drop-site painters, which only ever see a Graphics.
 * Rather than thread a sprite pool through every one of them, the world opens
 * a pool for the duration of its hazard layer (`withPuffs`) and `puff()` draws
 * a soft sprite into it; outside one — or without WebGL — it falls back to
 * the ellipse it always was.
 *
 * Puffs sit just in front of the layer they belong to, which is where smoke
 * rising off a roof or a fire wants to be anyway.
 */
let sink: SpritePool | null = null;

/** Run `draw` with soft puffs going into `pool`. */
export function withPuffs(pool: SpritePool | null, draw: () => void): void {
  const prev = sink;
  sink = pool;
  try {
    draw();
  } finally {
    sink = prev;
  }
}

/**
 * One puff of smoke, `w`×`h` with its centre at (x, y), at the opacity the old
 * ellipse had. `seed` picks the lump and its turn, so a column keeps its shape.
 */
export function puff(
  g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number,
  color: number, alpha: number, seed = 0,
): void {
  if (alpha <= 0.004 || w <= 0 || h <= 0) return;
  const img = sink?.next();
  if (img) {
    // The puff texture peaks near 0.5 and dissolves outward, so it is laid a
    // little larger and denser to carry the same weight as the hard ellipse
    img.setFrame(`p${(seed >>> 0) & 3}`)
      .setPosition(x, y)
      .setDisplaySize(w * 1.4, h * 1.4)
      .setRotation(seed * 1.37)
      .setTint(color)
      .setAlpha(Math.min(1, alpha * 1.7));
    return;
  }
  g.fillStyle(color, alpha);
  g.fillEllipse(x, y, w, h);
}
