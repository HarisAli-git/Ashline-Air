import Phaser from 'phaser';

/**
 * The things sticking up out of the ground that will end your flight.
 *
 * These were three near-black stick figures: a ladder, a box with holes in it
 * and a couple of crossed lines. They are the reason low cruise is a decision
 * rather than a free ride, so they have to read from a distance, tell you how
 * tall they are at a glance, and look like they belong to the world that
 * produced the ruined cities and the raider camps.
 *
 * Six kinds now, each built out of real structure rather than outline: tapered
 * lattice with X-bracing and guy wires anchored to the ground, concrete with
 * its floor slabs and rebar showing at the break, a gantry crane with a
 * counterweight and a hook block, a wind turbine with a snapped blade, a
 * transmission pylon carrying catenary cables, and a brick chimney stack.
 *
 * Everything is drawn to the SAME `topY` the collision test uses, so what you
 * see is still exactly what you hit.
 */

export type ObstacleKind = 'mast' | 'tower' | 'crane' | 'turbine' | 'pylon' | 'stack';

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function mix(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * u) << 16) |
    (Math.round(ag + (bg - ag) * u) << 8) |
    Math.round(ab + (bb - ab) * u)
  );
}

/** Structural steel, in decreasing order of light. */
const STEEL = 0x3a352c;
const STEEL_DARK = 0x1e1b16;
const RUST = 0x6a3a1c;
const CONCRETE = 0x2a2822;

export interface ObstacleStyle {
  /** Sky colour the silhouette is lit by — drives the rim highlight. */
  rim: number;
  /** 0 = night, 1 = day. */
  daylight: number;
}

/**
 * A tapered lattice column: two rails plus X-bracing, narrowing with height.
 * This is the shape that makes a mast read as a mast rather than a ladder.
 */
function lattice(
  g: Phaser.GameObjects.Graphics,
  x: number, yBot: number, yTop: number,
  wBot: number, wTop: number,
  col: number, rail: number, braceEvery: number,
): void {
  const h = yBot - yTop;
  if (h <= 2) return;
  const n = Math.max(2, Math.round(h / braceEvery));
  const at = (k: number): { y: number; w: number } => {
    const t = k / n;
    return { y: yBot - h * t, w: wBot + (wTop - wBot) * t };
  };
  // X-bracing between each pair of bays
  g.lineStyle(rail * 0.55, col, 0.85);
  for (let k = 0; k < n; k++) {
    const a = at(k), b = at(k + 1);
    g.lineBetween(x - a.w, a.y, x + b.w, b.y);
    g.lineBetween(x + a.w, a.y, x - b.w, b.y);
    g.lineBetween(x - b.w, b.y, x + b.w, b.y);   // horizontal tie
  }
  // Main rails last so they sit on top of the bracing
  g.lineStyle(rail, col, 1);
  g.lineBetween(x - wBot, yBot, x - wTop, yTop);
  g.lineBetween(x + wBot, yBot, x + wTop, yTop);
}

/** Guy wires out to anchor blocks in the dirt. */
function guys(
  g: Phaser.GameObjects.Graphics,
  x: number, baseY: number, attachY: number, reach: number, col: number,
): void {
  for (const dir of [-1, 1]) {
    const ax = x + dir * reach;
    g.lineStyle(0.9, col, 0.5);
    g.lineBetween(x, attachY, ax, baseY);
    // Anchor block
    g.fillStyle(STEEL_DARK, 0.9);
    g.fillRect(ax - 3, baseY - 3, 6, 3);
  }
}

/** Aircraft warning light: a strobe with a halo that carries at night. */
function warnLight(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, t: number, phase: number, dl: number, size = 2.6,
): void {
  if (Math.sin(t * 2.4 + phase) <= 0.1) return;
  g.fillStyle(0xff3020, 0.95);
  g.fillCircle(x, y, size);
  g.fillStyle(0xff3020, 0.22 + (1 - dl) * 0.3);
  g.fillCircle(x, y, size * 3.2);
}

/** Rust weeping down a steel structure. */
function rustStreaks(
  g: Phaser.GameObjects.Graphics,
  x: number, yTop: number, yBot: number, w: number, seed: number, n = 4,
): void {
  for (let i = 0; i < n; i++) {
    const rx = x + (hash(seed + i * 3) - 0.5) * w * 2;
    const y0 = yTop + hash(seed + i * 7) * (yBot - yTop) * 0.6;
    const len = 8 + hash(seed + i * 11) * 26;
    g.lineStyle(1.2, RUST, 0.28);
    g.lineBetween(rx, y0, rx, Math.min(yBot, y0 + len));
  }
}

/**
 * Draw one obstacle. `topY` is authoritative — it is the same value the
 * collision test derives from `heightM`, so the drawing can never disagree
 * with what the aircraft actually hits.
 */
export function drawObstacle(
  g: Phaser.GameObjects.Graphics,
  kind: ObstacleKind,
  sx: number,
  baseY: number,
  topY: number,
  halfWidth: number,
  seed: number,
  t: number,
  style: ObstacleStyle,
): void {
  const h = baseY - topY;
  if (h <= 2) return;
  const dl = style.daylight;
  // Distant structures pick up the sky along their lit edge; without it they
  // are flat black cut-outs pasted over the terrain.
  const rim = mix(STEEL, style.rim, 0.45);

  // A little haze pooled at the foot ties it to the ground plane
  g.fillStyle(style.rim, 0.05 + dl * 0.05);
  g.fillEllipse(sx, baseY - 2, halfWidth * 3.2, 10);

  switch (kind) {
    // ── Guyed lattice radio mast ─────────────────────────────────────────
    case 'mast': {
      guys(g, sx, baseY, topY + h * 0.30, h * 0.42, STEEL);
      guys(g, sx, baseY, topY + h * 0.62, h * 0.26, STEEL);
      lattice(g, sx, baseY, topY, 5.5, 2.2, STEEL, 2.0, 13);
      rustStreaks(g, sx, topY, baseY, 4, seed);

      // Antenna hardware near the top: a drum, a dish and a whip
      const dy = topY + h * 0.18;
      g.fillStyle(STEEL_DARK, 1);
      g.fillRect(sx - 5, dy, 10, 7);
      g.fillStyle(mix(STEEL, style.rim, 0.3), 1);
      g.fillEllipse(sx + 9, dy + 3, 11, 9);         // dish
      g.lineStyle(1.2, STEEL, 1);
      g.lineBetween(sx + 4, dy + 3, sx + 9, dy + 3);
      g.lineBetween(sx, topY, sx, topY - 9);        // whip above the tip
      // Lit edge
      g.lineStyle(1, rim, 0.5);
      g.lineBetween(sx + 5.5, baseY, sx + 2.2, topY);

      warnLight(g, sx, topY - 10, t, seed, dl);
      warnLight(g, sx, topY + h * 0.45, t, seed + 1.6, dl, 1.9);
      break;
    }

    // ── Ruined concrete tower ────────────────────────────────────────────
    case 'tower': {
      const w = halfWidth;
      const lean = (hash(seed) - 0.5) * 0.12;      // a few degrees off vertical
      const tx = (y: number): number => sx + (baseY - y) * lean;

      // Body, with a torn-off top
      g.fillStyle(CONCRETE, 1);
      g.beginPath();
      g.moveTo(sx - w, baseY);
      g.lineTo(tx(topY + 10) - w, topY + 10);
      g.lineTo(tx(topY) - w * 0.25, topY);
      g.lineTo(tx(topY + 6) + w * 0.5, topY + 6);
      g.lineTo(tx(topY + 14) + w, topY + 14);
      g.lineTo(sx + w, baseY);
      g.closePath();
      g.fillPath();

      // Floor slabs showing through the open face
      g.lineStyle(1.4, mix(CONCRETE, 0x000000, 0.45), 0.9);
      for (let fy = topY + 20; fy < baseY - 6; fy += 16) {
        g.lineBetween(tx(fy) - w + 2, fy, tx(fy) + w - 2, fy);
      }
      // Rebar bristling out of the break
      g.lineStyle(1, 0x6a6258, 0.75);
      for (let i = 0; i < 5; i++) {
        const bx = tx(topY) - w * 0.25 + i * (w * 0.4);
        const bend = (hash(seed + i) - 0.5) * 6;
        g.lineBetween(bx, topY + 3, bx + bend, topY - 5 - hash(seed + i * 2) * 5);
      }
      // Dead windows
      g.fillStyle(0x000000, 0.55);
      for (let wy = topY + 24; wy < baseY - 10; wy += 16) {
        for (let wx = -w + 6; wx < w - 5; wx += 11) {
          if (hash(wx + wy + seed) < 0.62) g.fillRect(tx(wy) + wx, wy, 4.5, 7);
        }
      }
      // Scorch above one opening, and scrub taking the ledges back
      g.fillStyle(0x0a0806, 0.4);
      g.fillRect(tx(topY + 30) - w * 0.2, topY + 26, 8, 22);
      g.fillStyle(0x2c3a1e, 0.7);
      for (let i = 0; i < 3; i++) {
        const gy = topY + 22 + i * 26;
        if (gy > baseY - 8) break;
        g.fillEllipse(tx(gy) + (hash(seed + i * 5) - 0.5) * w * 1.4, gy - 1, 9, 4);
      }
      // Lit edge down the sunward corner
      g.lineStyle(1.4, rim, 0.4);
      g.lineBetween(tx(topY + 14) + w, topY + 14, sx + w, baseY);
      break;
    }

    // ── Gantry crane ─────────────────────────────────────────────────────
    case 'crane': {
      const spread = halfWidth;
      const jib = spread * 1.9;

      // A-frame legs with cross bracing
      lattice(g, sx - spread * 0.55, baseY, topY + 4, 4, 2.5, STEEL, 2.0, 15);
      g.lineStyle(2.2, STEEL, 1);
      g.lineBetween(sx + spread, baseY, sx + 2, topY + 4);
      g.lineStyle(1, STEEL, 0.8);
      for (let i = 1; i < 4; i++) {
        const yy = baseY - (h * i) / 4;
        g.lineBetween(sx - spread * 0.55, yy, sx + spread - (spread * i) / 4.2, yy);
      }

      // Horizontal jib as a lattice beam, with a counterweight behind
      const jy = topY + 2;
      g.lineStyle(2.0, STEEL, 1);
      g.lineBetween(sx - spread * 0.9, jy + 6, sx + jib, jy - 2);
      g.lineBetween(sx - spread * 0.9, jy, sx + jib, jy - 8);
      g.lineStyle(0.9, STEEL, 0.75);
      for (let i = 0; i <= 8; i++) {
        const k = i / 8;
        const x0 = sx - spread * 0.9 + (jib + spread * 0.9) * k;
        g.lineBetween(x0, jy + 6 - 8 * k, x0, jy - 8 * k);
      }
      g.fillStyle(STEEL_DARK, 1);
      g.fillRect(sx - spread * 1.25, jy - 2, 12, 12);      // counterweight

      // Operator cab under the pivot
      g.fillStyle(mix(STEEL_DARK, RUST, 0.25), 1);
      g.fillRect(sx - 4, jy + 8, 13, 10);
      g.fillStyle(0x86a0aa, 0.35);
      g.fillRect(sx - 1, jy + 10, 7, 5);

      // Trolley and hook block, swinging
      const swing = Math.sin(t * 0.7 + seed) * 7;
      const trolleyX = sx + jib * 0.62;
      g.fillStyle(STEEL_DARK, 1);
      g.fillRect(trolleyX - 4, jy - 6, 9, 5);
      g.lineStyle(0.9, 0x2a241c, 0.9);
      g.lineBetween(trolleyX, jy - 1, trolleyX + swing, jy + h * 0.55);
      g.lineBetween(trolleyX + 3, jy - 1, trolleyX + swing + 3, jy + h * 0.55);
      g.fillStyle(0x241f18, 1);
      g.fillRect(trolleyX + swing - 4, jy + h * 0.55, 9, 7);
      g.lineStyle(1.4, 0x241f18, 1);
      g.lineBetween(trolleyX + swing, jy + h * 0.55 + 7, trolleyX + swing, jy + h * 0.55 + 12);

      rustStreaks(g, sx, topY, baseY, spread * 0.5, seed, 3);
      g.lineStyle(1, rim, 0.4);
      g.lineBetween(sx - spread * 0.9, jy, sx + jib, jy - 8);
      warnLight(g, sx + jib, jy - 10, t, seed, dl, 2.2);
      break;
    }

    // ── Wind turbine, one blade gone ─────────────────────────────────────
    case 'turbine': {
      // The hub sits a blade-length BELOW topY, so a blade at twelve o'clock
      // reaches exactly the height the collision test uses. Sizing the blades
      // off the full tower height instead put the tip well above the quoted
      // altitude — you would have hit nothing where a blade clearly was.
      const bladeLen = h * 0.30;
      const hubY = topY + bladeLen;

      // Tapered tower up to the nacelle
      g.fillStyle(mix(CONCRETE, 0xb8b4a8, 0.35), 1);
      g.beginPath();
      g.moveTo(sx - 6, baseY);
      g.lineTo(sx - 2.6, hubY + 4);
      g.lineTo(sx + 2.6, hubY + 4);
      g.lineTo(sx + 6, baseY);
      g.closePath();
      g.fillPath();
      g.lineStyle(1.2, rim, 0.45);
      g.lineBetween(sx + 6, baseY, sx + 2.6, hubY + 4);
      g.fillStyle(0x000000, 0.22);
      g.fillRect(sx - 6, baseY - 14, 5, 14);

      // Nacelle and hub
      g.fillStyle(STEEL_DARK, 1);
      g.fillRect(sx - 6, hubY - 3.5, 14, 7);
      g.fillEllipse(sx + 8, hubY, 7, 7);

      // Two blades left of three, still turning. Seen from the side the rotor
      // disc is nearly edge-on, so they sweep as tall narrow ellipses.
      const spin = t * 0.32 + seed;
      const hx = sx + 8;
      g.lineStyle(2.6, mix(CONCRETE, 0xd0ccc0, 0.5), 0.92);
      for (const k of [0, 1]) {
        const a = spin + k * (Math.PI * 2 / 3);
        g.lineBetween(hx, hubY, hx + Math.cos(a) * bladeLen * 0.32, hubY + Math.sin(a) * bladeLen);
      }
      // The third snapped off at the root…
      const stub = spin + (Math.PI * 4 / 3);
      g.lineBetween(hx, hubY, hx + Math.cos(stub) * 5, hubY + Math.sin(stub) * 14);
      // …and is lying in the dirt where it fell
      g.lineStyle(2.4, mix(CONCRETE, 0xd0ccc0, 0.4), 0.7);
      g.lineBetween(sx - halfWidth * 1.9, baseY - 2, sx - halfWidth * 0.4, baseY - 8);

      warnLight(g, sx + 2, hubY - 6, t, seed, dl, 2.2);
      break;
    }

    // ── Transmission pylon with sagging catenaries ───────────────────────
    case 'pylon': {
      const w = halfWidth;
      lattice(g, sx, baseY, topY, w * 0.75, w * 0.22, STEEL, 1.8, 12);
      // Cross-arms
      const arms = [topY + h * 0.10, topY + h * 0.30, topY + h * 0.50];
      for (let i = 0; i < arms.length; i++) {
        const ay = arms[i];
        const aw = w * (1.5 - i * 0.18);
        g.lineStyle(1.8, STEEL, 1);
        g.lineBetween(sx - aw, ay, sx + aw, ay);
        g.lineStyle(0.9, STEEL, 0.8);
        g.lineBetween(sx - aw, ay, sx, ay - 7);
        g.lineBetween(sx + aw, ay, sx, ay - 7);
        // Insulator strings and the cables they carry, sagging away both ways
        for (const dir of [-1, 1]) {
          const ix = sx + dir * aw;
          g.lineStyle(1, 0x4a4640, 0.9);
          g.lineBetween(ix, ay, ix, ay + 6);
          g.lineStyle(0.9, STEEL_DARK, 0.7);
          g.beginPath();
          g.moveTo(ix, ay + 6);
          for (let k = 1; k <= 6; k++) {
            const kt = k / 6;
            const cx2 = ix + dir * 120 * kt;
            const sag = Math.sin(kt * Math.PI) * 22;
            g.lineTo(cx2, ay + 6 + sag);
          }
          g.strokePath();
        }
      }
      rustStreaks(g, sx, topY, baseY, w * 0.6, seed, 3);
      warnLight(g, sx, topY - 3, t, seed, dl, 2.0);
      break;
    }

    // ── Brick chimney stack ──────────────────────────────────────────────
    default: {
      const wb = halfWidth * 0.8, wt = halfWidth * 0.42;
      g.fillStyle(mix(0x4a3226, 0x000000, 0.25), 1);
      g.beginPath();
      g.moveTo(sx - wb, baseY);
      g.lineTo(sx - wt, topY);
      g.lineTo(sx + wt, topY);
      g.lineTo(sx + wb, baseY);
      g.closePath();
      g.fillPath();
      // Banding every few metres, and a broken lip
      g.lineStyle(1.4, mix(0x4a3226, 0x000000, 0.5), 0.8);
      for (let k = 1; k < 6; k++) {
        const yy = baseY - (h * k) / 6;
        const ww = wb + (wt - wb) * (k / 6);
        g.lineBetween(sx - ww, yy, sx + ww, yy);
      }
      g.fillStyle(mix(0x4a3226, 0xc8b8a0, 0.35), 1);
      g.fillRect(sx - wt - 1.5, topY, wt * 2 + 3, 3);
      g.fillStyle(0x14100c, 0.9);
      g.fillEllipse(sx, topY + 1, wt * 1.6, 3);      // the flue, seen slightly from below
      g.lineStyle(1.2, rim, 0.4);
      g.lineBetween(sx + wb, baseY, sx + wt, topY);
      rustStreaks(g, sx, topY, baseY, wb * 0.7, seed, 5);
      guys(g, sx, baseY, topY + h * 0.25, h * 0.3, STEEL);
      warnLight(g, sx - wt * 0.5, topY - 2, t, seed, dl, 2.0);
      break;
    }
  }
}
