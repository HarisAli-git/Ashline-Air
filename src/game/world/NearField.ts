import Phaser from 'phaser';
import { SpritePool } from './SpritePool';

/**
 * The ground right under the camera, out of focus.
 *
 * The near field is the strongest speed cue in the game — things a few metres
 * from the lens whipping past at twice the terrain's rate — and it was drawn as
 * hard black triangles, sticks and rectangles along the bottom of the screen.
 * At that distance nothing is sharp. These are silhouettes of what is actually
 * lying about in a wasteland (grass, rocks, scrub, rubble with rebar, a stump,
 * a tyre, a fence post), painted once and blurred, so the nearer and larger a
 * thing is drawn the softer it is — which is how a lens sees it.
 */

export const FORE_TEX = 'px_fore';
const CW = 128, CH = 96;
const COLS = 4, ROWS = 2;
const GROUND = 88;      // where each silhouette stands in its cell
export const FORE_VARIANTS = COLS * ROWS;

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A colour taken `k` of the way to black. */
function darken(c: number, k: number): number {
  const f = 1 - Math.max(0, Math.min(1, k));
  return (Math.round(((c >> 16) & 255) * f) << 16) | (Math.round(((c >> 8) & 255) * f) << 8) | Math.round((c & 255) * f);
}

type Paint = (ctx: CanvasRenderingContext2D, v: number) => void;

/** A blade of grass: a thin curved wedge from the ground to its tip. */
function blade(ctx: CanvasRenderingContext2D, x: number, h: number, lean: number, w: number): void {
  ctx.beginPath();
  ctx.moveTo(x - w, GROUND);
  ctx.quadraticCurveTo(x + lean * 0.3, GROUND - h * 0.6, x + lean, GROUND - h);
  ctx.quadraticCurveTo(x + lean * 0.3 + w * 0.6, GROUND - h * 0.6, x + w, GROUND);
  ctx.closePath();
  ctx.fill();
}

const PAINTERS: Paint[] = [
  // A clump of dry grass
  (ctx, v) => {
    for (let i = 0; i < 22; i++) {
      const x = 64 + (rnd(v * 31 + i) - 0.5) * 60;
      blade(ctx, x, 22 + rnd(v * 7 + i) * 40, (rnd(v * 13 + i) - 0.45) * 26, 1.6);
    }
  },
  // A boulder, flat where it sits
  (ctx, v) => {
    ctx.beginPath();
    const n = 11;
    for (let i = 0; i <= n; i++) {
      const a = Math.PI + (i / n) * Math.PI;
      const r = 1 + (rnd(v * 5 + i) - 0.5) * 0.25;
      const x = 64 + Math.cos(a) * 40 * r, y = GROUND - 4 + Math.sin(a) * 30 * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(104, GROUND); ctx.lineTo(24, GROUND);
    ctx.closePath(); ctx.fill();
    // A smaller stone leaning on it
    ctx.beginPath();
    ctx.ellipse(98, GROUND - 6, 13, 9, -0.3, 0, Math.PI * 2);
    ctx.fill();
  },
  // Dead scrub: a tangle of twigs
  (ctx, v) => {
    ctx.lineCap = 'round';
    const twig = (x: number, y: number, a: number, len: number, w: number, depth: number, s: number): void => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      if (depth <= 0) return;
      twig(x2, y2, a - 0.45 - rnd(s) * 0.3, len * 0.7, w * 0.7, depth - 1, s * 3 + 1);
      twig(x2, y2, a + 0.4 + rnd(s + 1) * 0.3, len * 0.66, w * 0.7, depth - 1, s * 3 + 2);
    };
    for (let k = 0; k < 4; k++) twig(52 + k * 8, GROUND, -Math.PI / 2 + (k - 1.5) * 0.35, 20 + rnd(v + k) * 8, 3, 3, v * 10 + k);
  },
  // Rubble: a broken slab with the rebar out of it
  (ctx, v) => {
    ctx.beginPath();
    ctx.moveTo(20, GROUND); ctx.lineTo(28, GROUND - 26); ctx.lineTo(70, GROUND - 38);
    ctx.lineTo(84, GROUND - 22); ctx.lineTo(106, GROUND - 14); ctx.lineTo(110, GROUND);
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const x = 40 + k * 12;
      ctx.beginPath(); ctx.moveTo(x, GROUND - 30);
      ctx.quadraticCurveTo(x + 4, GROUND - 52 - rnd(v + k) * 10, x + (k % 2 ? 14 : -10), GROUND - 62 - rnd(v * 3 + k) * 14);
      ctx.stroke();
    }
    for (let k = 0; k < 6; k++) {
      ctx.beginPath(); ctx.arc(14 + k * 18, GROUND - 3, 3 + rnd(v * 9 + k) * 4, 0, Math.PI * 2); ctx.fill();
    }
  },
  // A stump with one broken limb
  (ctx) => {
    ctx.beginPath();
    ctx.moveTo(50, GROUND); ctx.lineTo(53, GROUND - 46); ctx.lineTo(58, GROUND - 52); ctx.lineTo(62, GROUND - 44);
    ctx.lineTo(66, GROUND - 55); ctx.lineTo(72, GROUND - 47); ctx.lineTo(76, GROUND);
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(70, GROUND - 32); ctx.lineTo(96, GROUND - 58); ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(88, GROUND - 50); ctx.lineTo(96, GROUND - 46); ctx.stroke();
    // Roots
    ctx.beginPath(); ctx.moveTo(40, GROUND); ctx.quadraticCurveTo(48, GROUND - 8, 54, GROUND - 10); ctx.lineTo(56, GROUND); ctx.fill();
    ctx.beginPath(); ctx.moveTo(86, GROUND); ctx.quadraticCurveTo(78, GROUND - 8, 72, GROUND - 10); ctx.lineTo(70, GROUND); ctx.fill();
  },
  // A tyre, half buried
  (ctx) => {
    ctx.lineWidth = 13;
    ctx.beginPath(); ctx.arc(64, GROUND + 4, 30, Math.PI * 1.02, Math.PI * 1.98); ctx.stroke();
    for (let k = 0; k < 5; k++) blade(ctx, 30 + k * 16, 14 + (k % 2) * 8, (k - 2) * 4, 1.5);
  },
  // A fence post with a strand of wire still on it
  (ctx, v) => {
    ctx.save();
    ctx.translate(54, GROUND);
    ctx.rotate(-0.12);
    ctx.fillRect(-4, -70, 8, 70);
    ctx.restore();
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(60, GROUND - 52); ctx.quadraticCurveTo(92, GROUND - 34, 128, GROUND - 44); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(58, GROUND - 32); ctx.quadraticCurveTo(90, GROUND - 16, 128, GROUND - 22); ctx.stroke();
    for (let k = 0; k < 9; k++) blade(ctx, 36 + (rnd(v + k) - 0.5) * 40, 12 + rnd(v * 4 + k) * 18, (rnd(k) - 0.5) * 10, 1.4);
  },
  // Tall wisps of seeded grass
  (ctx, v) => {
    for (let i = 0; i < 12; i++) {
      const x = 64 + (rnd(v * 17 + i) - 0.5) * 70;
      blade(ctx, x, 40 + rnd(v * 3 + i) * 44, (rnd(v * 11 + i) - 0.4) * 36, 1.2);
    }
  },
];

/** Three passes of a box blur over the alpha channel: close to a gaussian. */
function blurAlpha(img: ImageData, radius: number): void {
  const { width: w, height: h, data } = img;
  let a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3];
  let b = new Float32Array(w * h);
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean): void => {
    const n = horizontal ? w : h, m = horizontal ? h : w;
    const win = radius * 2 + 1;
    for (let j = 0; j < m; j++) {
      let acc = 0;
      const at = (i: number): number => {
        const c = Math.max(0, Math.min(n - 1, i));
        return horizontal ? src[j * w + c] : src[c * w + j];
      };
      for (let i = -radius; i <= radius; i++) acc += at(i);
      for (let i = 0; i < n; i++) {
        if (horizontal) dst[j * w + i] = acc / win; else dst[i * w + j] = acc / win;
        acc += at(i + radius + 1) - at(i - radius);
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(a, b, true); [a, b] = [b, a];
    pass(a, b, false); [a, b] = [b, a];
  }
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.min(255, a[i]);
  }
}

/** Paint the sheet of near-field silhouettes. False without a canvas. */
export function ensureForeTexture(scene: Phaser.Scene): boolean {
  if (scene.textures.exists(FORE_TEX)) return true;
  const tex = scene.textures.createCanvas(FORE_TEX, CW * COLS, CH * ROWS);
  if (!tex) return false;
  const ctx = tex.getContext();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  for (let v = 0; v < FORE_VARIANTS; v++) {
    const ox = (v % COLS) * CW, oy = Math.floor(v / COLS) * CH;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, CW, CH); ctx.clip();
    ctx.translate(ox, oy);
    PAINTERS[v](ctx, v + 1);
    ctx.restore();
  }
  // Each cell blurred on its own, so nothing bleeds into its neighbour
  for (let v = 0; v < FORE_VARIANTS; v++) {
    const ox = (v % COLS) * CW, oy = Math.floor(v / COLS) * CH;
    const img = ctx.getImageData(ox, oy, CW, CH);
    blurAlpha(img, 2);
    ctx.putImageData(img, ox, oy);
    tex.add(`f${v}`, 0, ox, oy, CW, CH);
  }
  tex.refresh();
  return true;
}

/**
 * The near-field sprites: one pool at the near field's depth, claimed and
 * placed each frame from the world scroll.
 */
export class NearField {
  private readonly pool: SpritePool;

  constructor(scene: Phaser.Scene, depth: number) {
    this.pool = new SpritePool(scene, 44, FORE_TEX, 'f0');
    this.pool.forEach(img => img.setDepth(depth).setOrigin(0.5, GROUND / CH));
  }

  /**
   * @param scroll    the near field's own scroll, px (it runs ahead of the land)
   * @param bandTop   the top of the strip, screen y
   * @param shade     the colour of the ground in shadow, nearly black
   * @param speedFrac 0…1, stretches the nearest things into motion blur
   */
  draw(scroll: number, bandTop: number, width: number, height: number, shade: number, speedFrac: number): void {
    this.pool.begin();
    if (bandTop < height) {
      const spacing = 46;
      const first = Math.floor((scroll - 160) / spacing);
      const count = Math.ceil(width / spacing) + 5;
      for (let i = first; i < first + count; i++) {
        // Not everywhere: clumps, with bare ground between
        if (rnd(i * 2.3 + 5) < 0.28) continue;
        const sx = i * spacing - scroll + rnd(i * 3.7) * 60;
        if (sx < -120 || sx > width + 120) continue;
        const depth = 0.3 + rnd(i + 12) * 0.7;              // how close to the lens
        const y = bandTop + 6 + depth * (height - bandTop) * 0.95;
        const s = 0.32 + depth * 0.95;
        const img = this.pool.next();
        if (!img) break;
        const v = Math.floor(rnd(i + 41) * FORE_VARIANTS) % FORE_VARIANTS;
        // The nearer, the darker — and the more it smears with speed
        img.setFrame(`f${v}`)
          .setPosition(sx, y)
          .setScale(s * (1 + speedFrac * depth * 0.45) * (rnd(i + 7) > 0.5 ? 1 : -1), s)
          .setTint(darken(shade, depth * 0.45))
          .setAlpha(0.92);
      }
    }
    this.pool.end();
  }

  destroy(): void { this.pool.destroy(); }
}
