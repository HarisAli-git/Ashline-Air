import type Phaser from 'phaser';
import { shoresAt, LAKE_D_FAR, type Lake } from './Lakes';

/**
 * What is left in a dead lake.
 *
 * A lake reads as dead by what is IN it: trees that drowned standing up and
 * were bleached grey, the roofs of cars that were on a road when the water
 * came, a bus on its side, the tail of an airliner that came down short, boats
 * floating upside down, drums, the telegraph poles of a road that now runs
 * straight into the water and out the other side, and a jetty that nobody has
 * walked down for years. A reservoir drowned a village to be made: its roofs
 * still break the surface, and the church spire stands up out of the middle
 * of it. Nothing moves except what floats.
 *
 * Laid out once per route from the lake's own seed, each piece at a depth on
 * the water, and drawn back to front with the lake's perspective.
 */

export type JunkKind =
  | 'snag' | 'car' | 'bus' | 'tail' | 'hull' | 'drum' | 'pole' | 'jetty' | 'arm' | 'sign'
  | 'roof' | 'spire' | 'pipe';

export interface Junk {
  kind: JunkKind;
  /** World x at its own depth. */
  wx: number;
  /** Depth on the plain, −1 far … +1 near. */
  d: number;
  seed: number;
  /** For the drowned road's poles: which way it leans. */
  lean?: number;
}

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function mix(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * u) << 16) | (Math.round(ag + (bg - ag) * u) << 8) | Math.round(ab + (bb - ab) * u);
}

/** Lay out a lake's dead furniture. Deterministic from the lake. */
export function layoutJunk(l: Lake): Junk[] {
  const out: Junk[] = [];
  const s = l.seed * 7 + 11;
  /** A point on the water at depth d, `t` of the way across (0 left shore … 1 right). */
  const on = (d: number, t: number): number | null => {
    const sh = shoresAt(l, d);
    if (!sh) return null;
    return sh[0] + (sh[1] - sh[0]) * t;
  };
  const push = (kind: JunkKind, d: number, t: number, seed: number, lean?: number): void => {
    const wx = on(d, t);
    if (wx !== null) out.push({ kind, wx, d, seed, lean });
  };
  const span = (a: number, b: number, k: number): number => a + (b - a) * hash(s + k);

  // How much there is goes with how much lake there is: a wide one is not an
  // emptier one
  const widthKm = (l.half * 2) / 9 / 1000;
  const per = (perKm: number): number => Math.max(1, Math.round(widthKm * perKm));

  // Drowned trees in the shallows along both shores, some standing on the bank
  const shoreSnags = per(16);
  for (let i = 0; i < shoreSnags; i++) {
    const d = span(LAKE_D_FAR + 0.08, 1.0, i * 3);
    const left = hash(s + i * 5 + 1) < 0.5;
    const t = left ? span(-0.02, 0.1, i * 7 + 2) : span(0.9, 1.02, i * 7 + 2);
    push('snag', d, t, s + i * 13);
  }
  // A drowned wood: a stand of them out in the water, where the valley floor
  // was forest before it was flooded
  const stands = widthKm > 1.1 ? 2 : 1;
  for (let k = 0; k < stands; k++) {
    const t0 = k === 0 ? span(0.08, 0.3, 400) : span(0.7, 0.9, 401);
    const d0 = span(-0.35, 0.6, 402 + k);
    const n = 9 + Math.floor(hash(s + 403 + k) * 6);
    for (let i = 0; i < n; i++) {
      const a = hash(s + 410 + k * 40 + i) * 6.283, r = Math.sqrt(hash(s + 411 + k * 40 + i));
      push('snag', d0 + Math.sin(a) * r * 0.2, t0 + Math.cos(a) * r * 0.07, s + 420 + k * 40 + i);
    }
  }
  // A road that went into the water: its poles marching straight across
  {
    const d = span(0.22, 0.55, 91);
    const n = 6 + Math.floor(hash(s + 92) * 3);
    for (let i = 0; i < n; i++) {
      push('pole', d + (hash(s + 100 + i) - 0.5) * 0.03, 0.04 + (0.92 * i) / (n - 1), s + 200 + i,
        (hash(s + 300 + i) - 0.5) * 0.7);
    }
  }
  // A jetty out from the near shore, pointing out over the water
  {
    const fromLeft = hash(s + 42) < 0.5;
    push('jetty', span(0.45, 0.72, 41), fromLeft ? 0.0 : 1.0, s + 43, fromLeft ? 1 : -1);
  }
  // Wrecks out on the water
  for (let i = 0; i < per(3); i++) push('car', span(-0.35, 0.85, 50 + i), span(0.15, 0.85, 60 + i), s + 70 + i);
  for (let i = 0; i < per(2); i++) push('hull', span(-0.4, 0.9, 80 + i), span(0.2, 0.8, 85 + i), s + 88 + i);
  for (let i = 0; i < per(9); i++) push('drum', span(-0.5, 1.0, 110 + i), span(0.06, 0.94, 120 + i), s + 130 + i);
  if (l.kind === 'reservoir') {
    push('bus', span(-0.2, 0.6, 140), hash(s + 141) < 0.5 ? span(0.12, 0.22, 142) : span(0.78, 0.88, 142), s + 143);
    push('tail', span(-0.45, 0.2, 150), span(0.35, 0.65, 151), s + 152);
    // The village the reservoir drowned: roofs breaking the surface round
    // the church, its spire standing up out of the middle
    const t0 = span(0.34, 0.62, 500), d0 = span(-0.3, 0.35, 501);
    push('spire', d0, t0, s + 502);
    const roofs = 5 + Math.floor(hash(s + 503) * 3);
    for (let i = 0; i < roofs; i++) {
      const a = (i / roofs) * 6.283 + hash(s + 504 + i), r = 0.45 + hash(s + 505 + i) * 0.55;
      push('roof', d0 + Math.sin(a) * r * 0.16, t0 + Math.cos(a) * r * 0.06, s + 510 + i);
    }
  } else {
    // The pit's own machinery, and the warnings round it
    push('arm', span(-0.3, 0.5, 160), span(0.2, 0.4, 161), s + 162);
    push('arm', span(0.0, 0.8, 163), span(0.6, 0.8, 164), s + 165);
    for (let i = 0; i < 3; i++) push('sign', span(-0.5, 0.9, 170 + i), hash(s + 175 + i) < 0.5 ? -0.03 : 1.03, s + 180 + i);
    // The outfall that filled it, still stained where it ran
    const fromLeft = hash(s + 190) >= 0.5;
    push('pipe', span(0.05, 0.6, 191), fromLeft ? 0.0 : 1.0, s + 192, fromLeft ? 1 : -1);
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

export interface JunkStyle {
  /** 0 night … 1 day. */
  daylight: number;
  /** The water's own colour where the piece sits, for its reflection. */
  water: number;
  /** Haze to fade distant pieces into. */
  haze: number;
  t: number;
}

/**
 * One piece, standing on the water at (x, y) with scale z (1 at the action
 * line, smaller toward the hills, bigger toward the camera). `far` 0 … 1 is
 * how much distance haze it takes.
 */
export function drawJunk(
  g: Phaser.GameObjects.Graphics, j: Junk, x: number, y: number, z: number, far: number, st: JunkStyle,
): void {
  const dark = (c: number): number => mix(mix(c, 0x05070a, (1 - st.daylight) * 0.55), st.haze, far * 0.55);
  const bob = Math.sin(st.t * 1.1 + j.seed) * 0.8 * z;
  const ripple = (w: number, a = 0.22): void => {
    g.lineStyle(Math.max(0.6, z * 0.8), mix(st.haze, 0xd8dcd0, 0.4), a * (0.5 + st.daylight * 0.5));
    g.strokeEllipse(x, y + 1 * z, w * z, Math.max(1.5, w * 0.12 * z));
  };
  const reflect = (w: number, h: number): void => {
    g.fillStyle(mix(st.water, 0x000000, 0.45), 0.4);
    g.fillEllipse(x, y + h * 0.35 * z, w * z, h * z);
  };
  switch (j.kind) {
    case 'snag': {
      // A tree drowned standing: bleached grey, the bark long gone, a few
      // limbs left — and its reflection hanging under it
      const h = (18 + hash(j.seed) * 22) * z;
      const col = dark(mix(0x8a857a, 0x5a564e, hash(j.seed + 1) * 0.6));
      const lean = (hash(j.seed + 2) - 0.5) * 0.25;
      const tx = x + lean * h;
      g.lineStyle(Math.max(1, 2.4 * z), mix(st.water, 0x000000, 0.4), 0.3);
      g.lineBetween(x, y + 1, x - lean * h * 0.6, y + h * 0.55);
      g.lineStyle(Math.max(1, 2.6 * z), col, 1);
      g.lineBetween(x, y, tx, y - h);
      g.lineStyle(Math.max(0.8, 1.4 * z), col, 1);
      for (let k = 0; k < 3; k++) {
        const f = 0.35 + k * 0.2;
        const bx = x + (tx - x) * f, byy = y - h * f;
        const side = (k + (hash(j.seed + 3) > 0.5 ? 0 : 1)) % 2 ? 1 : -1;
        g.lineBetween(bx, byy, bx + side * (5 + hash(j.seed + k) * 6) * z, byy - (4 + k * 2) * z);
      }
      ripple(14);
      break;
    }
    case 'pole': {
      // A telegraph pole of the drowned road, leaning, a cross-arm, a wire
      const h = 26 * z;
      const lean = j.lean ?? 0;
      const tx = x + Math.sin(lean) * h, ty = y - Math.cos(lean) * h;
      const col = dark(0x3a3026);
      g.lineStyle(Math.max(1, 2.2 * z), col, 1);
      g.lineBetween(x, y + 1, tx, ty);
      g.lineStyle(Math.max(0.8, 1.4 * z), col, 1);
      const ax = Math.cos(lean) * 6 * z, ay = Math.sin(lean) * 6 * z;
      g.lineBetween(tx - ax + (x - tx) * 0.1, ty - ay + (y - ty) * 0.1, tx + ax + (x - tx) * 0.1, ty + ay + (y - ty) * 0.1);
      // A broken wire trailing down into the water
      g.lineStyle(Math.max(0.5, 0.7 * z), dark(0x1a1612), 0.8);
      g.lineBetween(tx + ax * 0.8, ty + ay + (y - ty) * 0.1, tx + ax * 2.5 + 8 * z, y + 1);
      ripple(10, 0.16);
      break;
    }
    case 'jetty': {
      // Planks on posts, half of them gone, ending in nothing
      const len = 70 * z;
      const dir = j.lean ?? 1;
      const col = dark(0x3e3226);
      for (let k = 0; k < 7; k++) {
        const px = x + dir * (k / 6) * len;
        g.lineStyle(Math.max(1, 1.6 * z), col, 1);
        g.lineBetween(px, y - 5 * z, px + dir * 1 * z, y + 2 * z);
        if (k < 6 && hash(j.seed + k * 3) > 0.28) {
          g.fillStyle(dark(k % 2 ? 0x4a3c2c : 0x3a2e22), 1);
          g.fillRect(Math.min(px, px + dir * len / 6), y - 6.5 * z + (k > 4 ? 1.5 * z : 0), len / 6 - 1, 2.2 * z);
        }
      }
      ripple(len / z * 0.9, 0.14);
      break;
    }
    case 'car': {
      // A roof and the tops of the windows, the rest under
      const w = 20 * z, h = 6 * z;
      reflect(26, 5);
      g.fillStyle(dark(mix(0x5a3826, 0x3a3a3c, hash(j.seed))), 1);
      g.fillRoundedRect(x - w / 2, y - h + bob * 0.2, w, h, Math.min(3 * z, h / 2));
      g.fillStyle(dark(0x101418), 0.9);
      g.fillRect(x - w * 0.34, y - h * 0.55, w * 0.28, h * 0.4);
      g.fillRect(x + w * 0.06, y - h * 0.55, w * 0.28, h * 0.4);
      ripple(30);
      break;
    }
    case 'bus': {
      // On its side, long, windows in a row, rust running off it
      const w = 62 * z, h = 13 * z;
      reflect(70, 8);
      g.fillStyle(dark(0x6a5a2a), 1);
      g.fillRect(x - w / 2, y - h, w, h);
      g.fillStyle(dark(0x2a2a26), 1);
      g.fillRect(x - w / 2, y - h, w, 2.5 * z);
      g.fillStyle(dark(0x0e1216), 0.9);
      for (let k = 0; k < 7; k++) g.fillRect(x - w / 2 + 4 * z + k * 8.3 * z, y - h + 4 * z, 6 * z, 5 * z);
      g.fillStyle(dark(0x6a3a1c), 0.6);
      for (let k = 0; k < 5; k++) g.fillRect(x - w / 2 + 6 * z + k * 12 * z, y - h + 9 * z, 1.6 * z, h - 9 * z);
      ripple(80);
      break;
    }
    case 'tail': {
      // The fin of something big that came down short, standing out of the
      // water at an angle, its stripe faded to nothing
      const h = 44 * z;
      reflect(40, 9);
      g.fillStyle(dark(0x8a8a84), 1);
      g.beginPath();
      g.moveTo(x - 16 * z, y); g.lineTo(x - 4 * z, y - h); g.lineTo(x + 8 * z, y - h);
      g.lineTo(x + 18 * z, y); g.closePath(); g.fillPath();
      g.fillStyle(dark(0x7a2a1c), 0.65);
      g.beginPath();
      g.moveTo(x - 9 * z, y - h * 0.45); g.lineTo(x - 5 * z, y - h * 0.62);
      g.lineTo(x + 11 * z, y - h * 0.62); g.lineTo(x + 13 * z, y - h * 0.45);
      g.closePath(); g.fillPath();
      // The stub of the fuselage and the tailplane, just awash
      g.fillStyle(dark(0x6a6a64), 1);
      g.fillRect(x - 26 * z, y - 4 * z, 52 * z, 4 * z);
      ripple(70);
      break;
    }
    case 'hull': {
      // A boat floating upside down, keel to the sky
      const w = 30 * z;
      reflect(34, 5);
      g.fillStyle(dark(0x2c3a3a), 1);
      g.beginPath();
      g.moveTo(x - w / 2, y); g.lineTo(x - w * 0.38, y - 6 * z + bob * 0.3);
      g.lineTo(x + w * 0.42, y - 6 * z + bob * 0.3); g.lineTo(x + w / 2, y);
      g.closePath(); g.fillPath();
      g.lineStyle(Math.max(0.8, 1.2 * z), dark(0x5a6a62), 0.9);
      g.lineBetween(x - w * 0.36, y - 6 * z + bob * 0.3, x + w * 0.4, y - 6 * z + bob * 0.3);
      ripple(40);
      break;
    }
    case 'drum': {
      // An oil drum, rolling on the swell
      const r = 3.4 * z;
      g.fillStyle(dark(hash(j.seed) < 0.5 ? 0x6a3a1c : 0x3a4a3a), 1);
      g.fillRoundedRect(x - r * 1.3, y - r + bob, r * 2.6, r * 1.7, r * 0.5);
      g.lineStyle(Math.max(0.5, 0.7 * z), dark(0x1e140c), 0.9);
      g.lineBetween(x - r * 0.4, y - r + bob, x - r * 0.4, y + r * 0.6 + bob);
      g.lineBetween(x + r * 0.5, y - r + bob, x + r * 0.5, y + r * 0.6 + bob);
      ripple(12, 0.18);
      break;
    }
    case 'arm': {
      // An excavator's boom and dipper, the cab long under, standing out of
      // the pit like a bent finger
      const h = 38 * z;
      const dir = hash(j.seed) < 0.5 ? 1 : -1;
      const col = dark(0x8a6a22);
      g.lineStyle(Math.max(1.6, 5 * z), col, 1);
      const kx = x + dir * 14 * z, ky = y - h;
      g.lineBetween(x - dir * 8 * z, y + 1, kx, ky);
      g.lineStyle(Math.max(1.2, 3.6 * z), col, 1);
      g.lineBetween(kx, ky, kx + dir * 18 * z, y - h * 0.35);
      // The bucket, hanging
      g.fillStyle(dark(0x4a3a1c), 1);
      g.fillTriangle(kx + dir * 14 * z, y - h * 0.4, kx + dir * 24 * z, y - h * 0.36, kx + dir * 18 * z, y - h * 0.18);
      ripple(28);
      break;
    }
    case 'roof': {
      // The roof of a house the water came up over: the long slope of it,
      // tiles gone in patches so the rafters show, a chimney stub
      const w = (24 + hash(j.seed) * 14) * z, h = (8 + hash(j.seed + 1) * 5) * z;
      const side = hash(j.seed + 2) < 0.5 ? 1 : -1;
      reflect(w / z + 8, 6);
      g.fillStyle(dark(mix(0x6a3a2a, 0x4a4440, hash(j.seed + 3))), 1);
      g.beginPath();
      g.moveTo(x - w / 2, y + 1); g.lineTo(x - w / 2 + h * 0.9, y - h);
      g.lineTo(x + w / 2 - h * 0.9, y - h); g.lineTo(x + w / 2, y + 1);
      g.closePath(); g.fillPath();
      g.lineStyle(Math.max(0.6, 0.9 * z), dark(0x2a2420), 1);
      g.lineBetween(x - w / 2 + h * 0.9, y - h, x + w / 2 - h * 0.9, y - h);
      const holes = 1 + Math.floor(hash(j.seed + 4) * 2);
      for (let k = 0; k < holes; k++) {
        const hw = (4 + hash(j.seed + 7 + k) * 5) * z;
        const hx = x - w * 0.28 + hash(j.seed + 5 + k) * (w * 0.56 - hw);
        g.fillStyle(dark(0x14100c), 0.95);
        g.fillRect(hx, y - h * 0.78, hw, h * 0.55);
        g.lineStyle(Math.max(0.5, 0.7 * z), dark(0x4a3a2a), 1);
        for (let r = 1; r < 3; r++) g.lineBetween(hx + (hw * r) / 3, y - h * 0.78, hx + (hw * r) / 3, y - h * 0.23);
      }
      g.fillStyle(dark(0x5a3a2c), 1);
      g.fillRect(x + side * w * 0.22 - 2 * z, y - h - 5 * z, 4 * z, 5 * z + 1);
      ripple(w / z + 12);
      break;
    }
    case 'spire': {
      // The church: the top of its tower and the spire, still standing up out
      // of the middle of the water where the village was
      const tw = 12 * z, th = 16 * z, sh = 34 * z;
      reflect(18, 16);
      g.fillStyle(dark(0x8a8478), 1);
      g.fillRect(x - tw / 2, y - th, tw, th + 1);
      g.fillStyle(dark(0x101214), 1);
      g.fillRect(x - tw * 0.32, y - th * 0.85, tw * 0.22, th * 0.38);
      g.fillRect(x + tw * 0.1, y - th * 0.85, tw * 0.22, th * 0.38);
      g.fillStyle(dark(0x3a3e44), 1);
      g.fillTriangle(x - tw * 0.6, y - th, x + tw * 0.6, y - th, x + 0.6 * z, y - th - sh);
      // A few slates gone near the top, and the cross bent over
      g.fillStyle(dark(0x14161a), 1);
      g.fillTriangle(x - 1.2 * z, y - th - sh * 0.5, x + 1.4 * z, y - th - sh * 0.5, x + 0.2 * z, y - th - sh * 0.62);
      const tx = x + 0.6 * z, ty = y - th - sh;
      g.lineStyle(Math.max(0.6, 0.9 * z), dark(0x2a2a26), 1);
      g.lineBetween(tx, ty, tx + 1.4 * z, ty - 6 * z);
      g.lineBetween(tx - 2 * z, ty - 3.6 * z, tx + 3.8 * z, ty - 3 * z);
      ripple(26);
      break;
    }
    case 'pipe': {
      // The outfall: a pipe out over the pit on trestles, stained where it
      // used to run
      const len = 90 * z;
      const dir = j.lean ?? 1;
      const py = y - 9 * z;
      g.lineStyle(Math.max(0.8, 1.2 * z), dark(0x3a3024), 1);
      for (let k = 0; k < 4; k++) {
        const tx = x + dir * (k + 0.5) * (len / 4);
        g.lineBetween(tx - 3 * z, y + 1, tx + 3 * z, py);
        g.lineBetween(tx + 3 * z, y + 1, tx - 3 * z, py);
      }
      g.lineStyle(Math.max(1.4, 3.4 * z), dark(0x5a4a3a), 1);
      g.lineBetween(x, py, x + dir * len, py);
      const mx = x + dir * len;
      g.fillStyle(dark(0x1a1410), 1);
      g.fillCircle(mx, py, 1.9 * z);
      g.fillStyle(dark(0xa86a20), 0.55);
      g.fillRect(mx - 1.5 * z, py + 1.5 * z, 3 * z, y - py);
      g.fillStyle(dark(0xc88a30), 0.35);
      g.fillEllipse(mx, y + 1 * z, 26 * z, 4 * z);
      ripple(30, 0.12);
      break;
    }
    case 'sign': {
      // KEEP OUT, on a post at the edge of the pit
      const h = 18 * z;
      g.lineStyle(Math.max(1, 1.6 * z), dark(0x3a3024), 1);
      g.lineBetween(x, y, x, y - h);
      g.fillStyle(dark(0xc8a030), 1);
      g.fillTriangle(x - 6 * z, y - h + 9 * z, x + 6 * z, y - h + 9 * z, x, y - h - 2 * z);
      g.fillStyle(dark(0x1a1610), 1);
      g.fillCircle(x, y - h + 4.4 * z, 1.4 * z);
      g.fillRect(x - 0.6 * z, y - h + 0.2 * z, 1.2 * z, 3 * z);
      break;
    }
  }
}
