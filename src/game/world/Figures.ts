import Phaser from 'phaser';

/**
 * Living, armed people.
 *
 * Deliberately built to read as *alive* at a glance — upright spine, squared
 * shoulders, helmet, weapon held in two hands — so there is never a question
 * about which figures on the ground are the dead and which are not.
 *
 * The same renderer draws warlord militia and settlement garrison; only the
 * palette changes. That is the point: from the air, the man at the wire and
 * the man behind the gun truck look like the same species of problem, and the
 * only thing that tells you which is which is whose ground you are over.
 */

export type FighterPose = 'aimUp' | 'aimSide' | 'stand' | 'crouch' | 'work' | 'patrol';

export interface FighterPalette {
  /** Fatigues and webbing. */
  cloth: number;
  /** Exposed skin, in shadow. */
  skin: number;
  /** Helmet or hood. */
  head: number;
  /** Face wrap / armband — the faction's colour. */
  accent: number;
  /** Weapon metal. */
  metal: number;
}

/** Warlord militia: scavenged browns with a red rag over the face. */
export const RAIDER_PALETTE: FighterPalette = {
  cloth: 0x241c12, skin: 0x171009, head: 0x2e2416, accent: 0x6a1c14, metal: 0x1a1610,
};

/** Settlement garrison: darker uniform kit, faction colour on the arm. */
export function garrisonPalette(factionColor: number): FighterPalette {
  return { cloth: 0x1e2420, skin: 0x171009, head: 0x2a3230, accent: factionColor, metal: 0x14120e };
}

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * One armed figure standing on `groundY`.
 * `aim` is only used by the `aimUp` pose (radians, screen space, up = negative).
 */
/** Blend two packed colours — used for shaded limbs and rim light. */
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((ar + (br - ar) * t) << 16 | (ag + (bg - ag) * t) << 8 | (ab + (bb - ab) * t)) & 0xffffff;
}

export function drawFighter(
  g: Phaser.GameObjects.Graphics,
  x: number, groundY: number, t: number, seed: number,
  scale: number, face: 1 | -1,
  pose: FighterPose,
  aim: number,
  dl: number,
  pal: FighterPalette,
): void {
  const s = scale;
  const { cloth, skin, metal } = pal;
  const r = rnd(seed);
  const idle = Math.sin(t * 1.6 + seed) * 0.6 * s;

  const crouch = pose === 'crouch' || pose === 'work';
  const legLen = (crouch ? 5.4 : 9.2) * s;
  const torso = 8.4 * s;
  const hipY = groundY - legLen;
  const lean = pose === 'aimUp' ? -0.16 : pose === 'work' ? 0.34 : 0.06;
  const shX = x + face * lean * torso;
  const shY = hipY - torso + idle * 0.3;

  // A patrolling sentry walks his beat instead of standing like furniture
  const stride = pose === 'patrol' ? Math.sin(t * 2.1 + seed) * 2.6 * s : 0;

  /**
   * A limb with THICKNESS, tapering along its length.
   *
   * Every arm and leg here used to be a 1.9 px stroked polyline, which is the
   * literal definition of a stick figure — no mass, no silhouette, and it read
   * as a scratch on the background rather than a person standing in the
   * world. A thigh is thicker than a calf and an upper arm than a forearm;
   * that taper is most of what makes a limb look like a limb at this size.
   */
  const limb = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, w0: number, w1: number, col: number,
  ): void => {
    const seg = (px: number, py: number, qx: number, qy: number, pw: number, qw: number): void => {
      const dx = qx - px, dy = qy - py;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      g.fillStyle(col, 1);
      g.fillPoints([
        new Phaser.Geom.Point(px + nx * pw, py + ny * pw),
        new Phaser.Geom.Point(qx + nx * qw, qy + ny * qw),
        new Phaser.Geom.Point(qx - nx * qw, qy - ny * qw),
        new Phaser.Geom.Point(px - nx * pw, py - ny * pw),
      ], true);
    };
    const wMid = (w0 + w1) * 0.5;
    seg(ax, ay, bx, by, w0, wMid);
    seg(bx, by, cx, cy, wMid, w1);
    // Joint cap, so the knee/elbow does not show a notch
    g.fillStyle(col, 1);
    g.fillCircle(bx, by, wMid);
  };

  // Cast shadow — the same low sun everything else on the ground answers to.
  g.fillStyle(0x000000, 0.30);
  g.fillEllipse(x + face * 5 * s, groundY + 1, 20 * s, 3.6 * s);

  // ── Legs: braced apart, with knees and boots ────────────────────────────
  const kneeBack = { x: x - face * 1.6 * s + stride * 0.4, y: hipY + legLen * 0.55 };
  const footBack = { x: x - face * 3.4 * s + stride, y: groundY };
  const kneeFwd  = { x: x + face * 2.0 * s - stride * 0.4, y: hipY + legLen * 0.55 };
  const footFwd  = { x: x + face * 3.2 * s - stride, y: groundY };
  const legBack = mix(cloth, 0x000000, 0.30);   // far leg sits in its own shade
  limb(x, hipY, kneeBack.x, kneeBack.y, footBack.x, footBack.y, 1.9 * s, 1.25 * s, legBack);
  limb(x, hipY, kneeFwd.x, kneeFwd.y, footFwd.x, footFwd.y, 2.1 * s, 1.35 * s, cloth);
  // Boots: a heavy foot is what plants a figure on the ground
  g.fillStyle(mix(cloth, 0x000000, 0.55), 1);
  g.fillRect(footBack.x - face * 2.4 * s, groundY - 1.6 * s, face * 4.2 * s, 1.8 * s);
  g.fillRect(footFwd.x - face * 2.6 * s, groundY - 1.7 * s, face * 4.6 * s, 1.9 * s);

  // Torso: webbing and a plate carrier make a blockier shape than the dead
  g.fillStyle(cloth, 1);
  g.beginPath();
  g.moveTo(x - 2.4 * s, hipY + 0.6 * s);
  g.lineTo(x + 2.4 * s, hipY + 0.6 * s);
  g.lineTo(shX + 3.0 * s, shY);
  g.lineTo(shX - 3.0 * s, shY);
  g.closePath();
  g.fillPath();
  // Chest rig
  g.fillStyle(0x3a2a16, 1);
  g.fillRect(shX - 2.4 * s, shY + 2.2 * s, 4.8 * s, 2.6 * s);
  // Faction armband
  g.fillStyle(pal.accent, 0.9);
  g.fillRect(shX + face * 2.2 * s, shY + 1.4 * s, 1.6 * s, 2.2 * s);

  // Head with a helmet or a wrapped face
  const hdY = shY - 3.2 * s;
  g.fillStyle(skin, 1);
  g.fillCircle(shX + face * 0.6 * s, hdY, 2.3 * s);
  g.fillStyle(pal.head, 1);
  if (r > 0.5) {
    // Helmet
    g.fillEllipse(shX + face * 0.6 * s, hdY - 1.1 * s, 5.6 * s, 3.4 * s);
    g.fillRect(shX + face * 0.6 * s - 2.8 * s, hdY - 0.8 * s, 5.6 * s, 1.1 * s);
  } else {
    // Hood + face wrap in the faction's colour
    g.fillEllipse(shX + face * 0.2 * s, hdY - 0.6 * s, 6.2 * s, 5.0 * s);
    g.fillStyle(pal.accent, 1);
    g.fillRect(shX + face * 0.2 * s - 2.2 * s, hdY + 0.5 * s, 4.4 * s, 1.2 * s);
  }

  // Rim light down the sunward edge. At this size a figure is mostly
  // silhouette, and a single lit edge is what lifts it off the ground behind
  // it — the same low sun the terrain and the scrub answer to.
  g.lineStyle(1.1 * s, mix(pal.head, 0xffd9a0, 0.55), 0.55);
  g.beginPath();
  g.moveTo(shX + face * 3.0 * s, shY);
  g.lineTo(x + face * 2.4 * s, hipY + 0.6 * s);
  g.strokePath();
  g.fillStyle(mix(cloth, 0xffd9a0, 0.35), 0.35);
  g.fillRect(shX + face * 2.2 * s, shY, face * 0.9 * s, (hipY - shY) * 0.9);

  // Arms + weapon
  const a = pose === 'aimUp' ? aim
    : pose === 'aimSide' ? (face > 0 ? 0 : Math.PI)
    : 0.5;
  if (pose === 'work') {
    // Hauling an ammo can
    limb(shX, shY + 1 * s,
      shX + face * 2.6 * s, shY + 4 * s,
      shX + face * 3.4 * s, shY + 7 * s, 1.6 * s, 1.05 * s, cloth);
    g.fillStyle(0x2f3a24, 1);
    g.fillRect(shX + face * 2.2 * s, shY + 7 * s, 4.6 * s, 3.4 * s);
  } else if (pose === 'patrol' || pose === 'stand') {
    // Weapon slung across the chest, muzzle down
    limb(shX, shY + 1.4 * s,
      shX + face * 1.3 * s, shY + 2.9 * s,
      shX + face * 2.2 * s, shY + 4.2 * s, 1.6 * s, 1.05 * s, cloth);
    g.lineStyle(1.5 * s, metal, 1);
    g.lineBetween(shX + face * 3.4 * s, shY + 0.6 * s, shX - face * 1.2 * s, shY + 7.4 * s);
  } else {
    const gunLen = 9 * s;
    const mx = shX + face * 2.2 * s, my = shY + 1.6 * s;
    const ex = mx + Math.cos(a) * gunLen;
    const ey = my + Math.sin(a) * gunLen;
    // Both hands on the weapon
    g.lineStyle(1.6 * s, cloth, 1);
    g.beginPath();
    g.moveTo(shX, shY + 1.4 * s);
    g.lineTo(shX + face * 1.4 * s, shY + 3.4 * s);
    g.lineTo(mx + Math.cos(a) * 3 * s, my + Math.sin(a) * 3 * s);
    g.strokePath();
    // Rifle
    g.lineStyle(1.5 * s, metal, 1);
    g.lineBetween(mx - Math.cos(a) * 3 * s, my - Math.sin(a) * 3 * s, ex, ey);
    g.fillStyle(metal, 1);
    g.fillRect(mx - 1.2 * s, my - 0.6 * s, 2.4 * s, 2.6 * s); // magazine
  }

  // Night: a headlamp or a cigarette ember — signs of life
  if (dl < 0.5 && r > 0.7) {
    g.fillStyle(0xffb060, 0.7 * (1 - dl));
    g.fillCircle(shX + face * 2.4 * s, hdY, 0.9 * s);
  }
}

/** Muzzle flash: a hot star along the bore plus the light it throws. */
export function drawMuzzleFlash(
  g: Phaser.GameObjects.Graphics,
  x: number, y: number, a: number, k: number, size: number,
): void {
  if (k <= 0) return;
  const ca = Math.cos(a), sa = Math.sin(a);
  g.fillStyle(0xffcf70, 0.22 * k);
  g.fillCircle(x, y, size * 2.6);
  g.fillStyle(0xffe9a8, 0.95 * k);
  g.fillTriangle(
    x - sa * size * 0.55, y + ca * size * 0.55,
    x + sa * size * 0.55, y - ca * size * 0.55,
    x + ca * size * 2.3, y + sa * size * 2.3,
  );
  g.fillStyle(0xffffff, 0.9 * k);
  g.fillCircle(x, y, size * 0.55);
}

/** Chain-link perimeter fence with razor wire — the airstrip's outer skin. */
export function drawWireFence(
  g: Phaser.GameObjects.Graphics,
  x0: number, x1: number, groundY: number, heightPx: number,
  seed = 0,
): void {
  const top = groundY - heightPx;
  // Mesh: a coarse diagonal weave, cheap but it reads as chain-link
  g.lineStyle(1, 0x2c2a22, 0.55);
  for (let x = x0; x < x1; x += 9) {
    g.lineBetween(x, top + 4, Math.min(x1, x + 9), groundY);
    g.lineBetween(Math.min(x1, x + 9), top + 4, x, groundY);
  }
  // Posts
  g.lineStyle(2.6, 0x1c1a14, 1);
  for (let x = x0; x <= x1; x += 46) {
    g.lineBetween(x, groundY, x, top);
    // Angled outrigger carrying the wire
    g.lineStyle(1.8, 0x1c1a14, 1);
    g.lineBetween(x, top, x - 6, top - 7);
    g.lineStyle(2.6, 0x1c1a14, 1);
  }
  // Top rail
  g.lineStyle(1.6, 0x35322a, 1);
  g.lineBetween(x0, top, x1, top);
  // Razor coils along the top
  for (let x = x0; x < x1; x += 13) {
    const r = 4.5 + rnd(x + seed) * 1.6;
    g.lineStyle(1.1, 0x6a675c, 0.85);
    g.strokeCircle(x + 6, top - 8, r);
    g.lineBetween(x + 6 - r, top - 8, x + 6 + r, top - 8);
  }
}

/** Stacked HESCO/blast barriers — the hard bit of the perimeter. */
export function drawBarrier(
  g: Phaser.GameObjects.Graphics,
  x: number, groundY: number, w: number, h: number, seed = 0,
): void {
  g.fillStyle(0x3a3527, 1);
  g.fillRect(x, groundY - h, w, h);
  g.fillStyle(0x4a4433, 1);
  g.fillRect(x, groundY - h, w, 2.5);
  // Wire-cage ribs
  g.lineStyle(1, 0x22201a, 0.8);
  for (let i = 1; i < 4; i++) g.lineBetween(x + (w * i) / 4, groundY - h, x + (w * i) / 4, groundY);
  g.lineBetween(x, groundY - h * 0.5, x + w, groundY - h * 0.5);
  // Gravel spill at the foot
  g.fillStyle(0x2a2620, 0.9);
  g.fillEllipse(x + w / 2, groundY, w * 1.15, 5);
  // Stencilled hazard chevrons
  g.fillStyle(0x9a8a3a, 0.55);
  for (let i = 0; i < 3; i++) {
    g.fillRect(x + 4 + i * (w / 3), groundY - h * 0.42 + rnd(seed + i) * 2, (w / 3) * 0.45, 3);
  }
}
