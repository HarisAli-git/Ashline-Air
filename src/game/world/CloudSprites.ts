import Phaser from 'phaser';

/**
 * Cumulus drawn as pictures, not geometry.
 *
 * Graphics can only fill hard-edged shapes, so every cloud built from them was
 * a stack of discs: a ring wherever a translucent fringe overlapped, and a flat
 * grey plate where the shadowed base was painted on top. A cloud is a density
 * field lit from above, so it is painted that way, once per variant, on a 2D
 * canvas: radial falloffs for soft edges, each billow shading its own
 * underside, a crown that catches the sun and a flat condensation base. The
 * flight then places, scales and tints those like any sprite, with the tint
 * corners carrying the light: the lit colour across the top, the shade colour
 * underneath.
 */

export const CLOUD_TEX = 'ashline_cumulus';
export const GLOW_TEX = 'ashline_sunglow';
const COLS = 2;
const ROWS = 4;
const CW = 320;
const CH = 176;
const VARIANTS = COLS * ROWS;

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Paint the sheet of cloud variants and the sun's glow. False without a canvas. */
export function ensureSkyTextures(scene: Phaser.Scene): boolean {
  const tm = scene.textures;
  if (!tm.exists(CLOUD_TEX)) {
    const tex = tm.createCanvas(CLOUD_TEX, COLS * CW, ROWS * CH);
    if (!tex) return false;
    const ctx = tex.getContext();
    for (let v = 0; v < VARIANTS; v++) {
      const ox = (v % COLS) * CW, oy = Math.floor(v / COLS) * CH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, CW, CH);
      ctx.clip();
      ctx.translate(ox, oy);
      paintCumulus(ctx, CW, CH, v);
      ctx.restore();
      tex.add(`c${v}`, 0, ox, oy, CW, CH);
    }
    tex.refresh();
  }
  if (!tm.exists(GLOW_TEX)) {
    const S = 128;
    const tex = tm.createCanvas(GLOW_TEX, S, S);
    if (!tex) return false;
    const ctx = tex.getContext();
    const gr = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.12, 'rgba(255,255,255,1)');
    gr.addColorStop(0.15, 'rgba(255,255,255,0.55)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.18)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.05)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, S, S);
    tex.refresh();
  }
  return true;
}

function paintCumulus(ctx: CanvasRenderingContext2D, W: number, H: number, v: number): void {
  const R = (k: number): number => rnd(v * 101 + k);
  const base = H * 0.84;
  // Some variants long and low, some building upward
  const tall = 0.7 + R(1) * 0.45;
  const puffs: Array<[number, number, number]> = [];

  // The main mass: billows along a dome, biggest in the middle
  const n = 5 + Math.floor(R(2) * 3);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const dome = Math.pow(Math.sin(t * Math.PI), 0.7);
    const r = H * (0.12 + 0.16 * dome * tall) * (0.85 + R(10 + i) * 0.3);
    const cx = W * (0.16 + 0.68 * t) + (R(20 + i) - 0.5) * W * 0.05;
    const cy = base - r * 0.35 - dome * H * 0.14 * tall;
    puffs.push([cx, cy, r]);
  }
  // Turrets growing out of the upper side of the middle billows, where the
  // cloud is still building — attached, never floating free of the mass
  const m = 3 + Math.floor(R(3) * 4);
  for (let i = 0; i < m; i++) {
    const host = puffs[1 + Math.floor(R(30 + i) * (n - 2))];
    const th = (R(40 + i) - 0.5) * 2;
    const rr = host[2] * (0.42 + R(45 + i) * 0.2);
    puffs.push([host[0] + Math.sin(th) * host[2] * 0.68, host[1] - Math.cos(th) * host[2] * 0.68, rr]);
  }
  // Nothing may touch the edge of its cell, or it bleeds into the next one
  for (const p of puffs) {
    p[2] = Math.min(p[2], p[0] - 3, W - 3 - p[0], p[1] - 3);
  }

  // 1. Density: soft-edged billows, overlapping into one mass
  ctx.globalCompositeOperation = 'source-over';
  for (const [cx, cy, r] of puffs) {
    if (r <= 2) continue;
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.82, 'rgba(255,255,255,0.4)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  // …sitting on one broad, smooth lens of vapour rather than a row of beads
  ctx.save();
  ctx.translate(W * 0.5, base - H * 0.06);
  ctx.scale(1, 0.24);
  const lens = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.4);
  lens.addColorStop(0, 'rgba(255,255,255,1)');
  lens.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  lens.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = lens;
  ctx.fillRect(-W * 0.4, -W * 0.4, W * 0.8, W * 0.8);
  ctx.restore();

  // 2. The flat base, where the rising air reaches its condensation level
  ctx.globalCompositeOperation = 'destination-out';
  const cut = ctx.createLinearGradient(0, base - H * 0.03, 0, base + H * 0.02);
  cut.addColorStop(0, 'rgba(0,0,0,0)');
  cut.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = cut;
  ctx.fillRect(0, base - H * 0.03, W, H);

  // 3. Light from above: a bright crown going grey toward the base
  ctx.globalCompositeOperation = 'source-atop';
  let top = base;
  for (const [, cy, r] of puffs) top = Math.min(top, cy - r);
  const lg = ctx.createLinearGradient(0, top, 0, base);
  lg.addColorStop(0, '#ffffff');
  lg.addColorStop(0.45, '#eceef2');
  lg.addColorStop(1, '#8b94a3');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W, H);

  // 4. Each billow shades its own underside and catches the light on its crown
  for (const [cx, cy, r] of puffs) {
    if (r <= 2) continue;
    const sx = cx + r * 0.2, sy = cy + r * 0.55;
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 0.95);
    sg.addColorStop(0, 'rgba(58,68,86,0.26)');
    sg.addColorStop(1, 'rgba(58,68,86,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
  }
  for (const [cx, cy, r] of puffs) {
    if (r <= 2) continue;
    const hx = cx - r * 0.25, hy = cy - r * 0.4;
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.75);
    hg.addColorStop(0, 'rgba(255,255,255,0.6)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(hx - r, hy - r, 2 * r, 2 * r);
  }
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * A fixed pool of cloud sprites for one layer of the world. Created once,
 * right after that layer's Graphics, so every sprite sits at that layer's
 * place in the display list; each frame claims what it needs and hides the
 * rest.
 */
export class CloudSprites {
  private readonly pool: Phaser.GameObjects.Image[] = [];
  private used = 0;

  constructor(scene: Phaser.Scene, size: number) {
    for (let i = 0; i < size; i++) {
      this.pool.push(scene.add.image(0, 0, CLOUD_TEX, 'c0').setOrigin(0.5, 0.66).setVisible(false));
    }
  }

  begin(): void {
    this.used = 0;
  }

  /**
   * The same footprint the Graphics cumulus had: centred on x, the crown about
   * two-thirds of `h` above y and the flat base a fifth of `h` below it. A
   * long mass — a storm several screens wide — becomes a row of clouds, and
   * only the ones on screen are placed.
   */
  draw(
    x: number, y: number, w: number, h: number, seed: number, alpha: number,
    topCol: number, baseCol: number, viewW: number,
  ): void {
    const seg = Math.max(40, Math.min(w, h * 3.2));
    const k = Math.max(1, Math.round(w / seg));
    const step = w / k;
    const x0 = x - w / 2;
    const dw = k > 1 ? step * 1.5 : w * 1.2;
    const j0 = Math.max(0, Math.floor((-60 - dw / 2 - x0) / step));
    const j1 = Math.min(k - 1, Math.ceil((viewW + 60 + dw / 2 - x0) / step));
    for (let j = j0; j <= j1; j++) {
      if (this.used >= this.pool.length) return;
      const cx = x0 + (j + 0.5) * step;
      const r0 = rnd(seed * 3.1 + j * 7.7);
      const img = this.pool[this.used++];
      img.setFrame(`c${Math.floor(r0 * VARIANTS) % VARIANTS}`);
      img.setFlipX(rnd(seed + j * 11.3) > 0.5);
      img.setPosition(cx, y + (k > 1 ? (rnd(seed + j * 5.9) - 0.5) * h * 0.18 : 0));
      // Near the painting's own proportions: squashing it flat is what made
      // the turrets look like they were floating above the cloud
      img.setDisplaySize(dw, Math.max(h * 1.3, dw * (CH / CW) * 0.9) * (0.9 + r0 * 0.2));
      img.setTint(topCol, topCol, baseCol, baseCol);
      img.setAlpha(alpha);
      img.setVisible(true);
    }
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      if (this.pool[i].visible) this.pool[i].setVisible(false);
    }
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.pool.length = 0;
  }
}
