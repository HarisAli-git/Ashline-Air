import Phaser from 'phaser';

/**
 * The dead.
 *
 * These used to be five line segments in a trench coat — a hip, a stick torso
 * and two twigs — which at flight distance read as a smudge rather than a
 * threat. Every figure here is built from an actual skeleton: hip, hunched
 * spine, shoulder, head with a hanging jaw, and four limbs each solved through
 * an elbow or a knee, all driven by a walk cycle. That is what makes a crowd
 * at a settlement wall look like a crowd of *people* instead of tally marks.
 *
 * Four archetypes, because a horde of identical walkers is its own tell:
 *   shambler — the default lurch, one leg dragging, arms reaching
 *   crawler  — dragging itself along on its elbows, legs trailing dead
 *   runner   — the fast ones; deep forward lean, arms trailing behind
 *   bloated  — heavy, slow, distended; parts the crowd around it
 *
 * Everything is deterministic in `seed`, so a given stretch of ground is
 * populated the same way every time you fly it.
 */

export type UndeadKind = 'shambler' | 'crawler' | 'runner' | 'bloated';

export interface CrowdStyle {
  /** Flesh/silhouette fill. */
  body: number;
  /** Torn clothing — a shade off the body so the figure isn't one blob. */
  rag: number;
  /** Edge light picked up off the sky, along the leading side. */
  rim: number;
  /** 0 = deep night (eyes catch the light), 1 = full day. */
  daylight: number;
}

export const DEFAULT_CROWD_STYLE: CrowdStyle = {
  body: 0x120e08, rag: 0x1e1810, rim: 0x6a6250, daylight: 1,
};

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Stroke a jointed limb as one path so the elbow/knee joins are mitred. */
function bone(
  g: Phaser.GameObjects.Graphics,
  w: number, col: number, a: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
): void {
  g.lineStyle(w, col, a);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.lineTo(x2, y2);
  g.strokePath();
}

/** Pick an archetype from a seed — runners and crawlers stay rare. */
export function undeadKindFor(seed: number): UndeadKind {
  const r = rnd(seed * 3.77 + 9.1);
  if (r < 0.10) return 'runner';
  if (r < 0.24) return 'crawler';
  if (r < 0.36) return 'bloated';
  return 'shambler';
}

/**
 * One figure, standing on `groundY` at screen x.
 * `scale` 1 ≈ 22 px tall; `face` is the direction it is stumbling.
 */
export function drawUndead(
  g: Phaser.GameObjects.Graphics,
  x: number,
  groundY: number,
  t: number,
  seed: number,
  scale: number,
  face: 1 | -1,
  kind: UndeadKind,
  style: CrowdStyle,
  alpha = 1,
): void {
  const s = scale;
  if (s < 0.15) return;
  const r1 = rnd(seed), r2 = rnd(seed + 17), r3 = rnd(seed + 43);

  if (kind === 'crawler') { drawCrawler(g, x, groundY, t, seed, s, face, style, alpha); return; }

  // ── Gait parameters per archetype ───────────────────────────────────────
  let rate: number, lean: number, stride: number, reach: number, girth: number;
  switch (kind) {
    case 'runner':
      rate = 7.4 + r1 * 1.6; lean = 0.72; stride = 5.4; reach = -7.0; girth = 1.9;
      break;
    case 'bloated':
      rate = 1.15 + r1 * 0.3; lean = 0.10; stride = 1.9; reach = 4.2; girth = 3.6;
      break;
    default:
      rate = 1.9 + r1 * 0.7; lean = 0.30 + r2 * 0.12; stride = 3.1; reach = 6.2; girth = 2.3;
  }

  const legLen = (8.6 + r2 * 1.4) * s;
  const torso  = (7.8 + r3 * 1.6) * s;
  const headR  = (2.5 + r1 * 0.5) * s;
  const p = t * rate + seed * 2.399;

  // Near leg leads; the far leg is deliberately NOT half a cycle behind —
  // that offset is what reads as a drag rather than a march.
  const swA = Math.sin(p);
  const swB = Math.sin(p + (kind === 'runner' ? Math.PI : 2.35));
  const bob = Math.abs(Math.cos(p)) * (kind === 'runner' ? 1.9 : 1.0) * s;

  const hipX = x;
  const hipY = groundY - legLen - bob;
  const shX  = hipX + face * lean * torso;
  const shY  = hipY - torso;
  const hdX  = shX + face * 1.7 * s;
  const hdY  = shY - (2.9 + r3 * 0.6) * s;

  const legW = 1.7 * s * (kind === 'bloated' ? 1.35 : 1);
  const armW = 1.45 * s * (kind === 'bloated' ? 1.3 : 1);
  const dark = style.body;

  const foot = (sw: number): [number, number, number, number] => {
    const fx = hipX + face * sw * stride * s;
    const fy = groundY - Math.max(0, sw) * 1.7 * s;
    return [fx, fy, (hipX + fx) / 2 + face * 1.5 * s, (hipY + fy) / 2];
  };

  // ── Far side first: limbs behind the body, dimmed only enough to separate
  //    them. Dropped much lower and they stop reading as the same creature.
  const [fbx, fby, fbkx, fbky] = foot(swB);
  bone(g, legW, dark, alpha * 0.74, hipX, hipY, fbkx, fbky, fbx, fby);

  const armP = p * 0.85 + 1.9;
  const farHandX = shX + face * reach * 0.85 * s;
  const farHandY = shY + (3.4 + Math.sin(armP + 1.2) * 1.5) * s;
  bone(g, armW, dark, alpha * 0.66,
    shX, shY,
    shX + face * reach * 0.5 * s, shY + (1.5 + Math.sin(armP) * 0.9) * s,
    farHandX, farHandY);

  // ── Torso: hunched, the back edge bulging away from the direction of travel
  const back = -face;
  const midX = (hipX + shX) / 2 + back * 1.15 * s;
  const midY = (hipY + shY) / 2;
  const gw = girth * s;
  g.fillStyle(dark, alpha);
  g.beginPath();
  g.moveTo(hipX + face * gw * 0.8, hipY + 0.6 * s);
  g.lineTo(midX + face * gw, midY);
  g.lineTo(shX + face * gw * 0.85, shY);
  g.lineTo(shX + back * gw * 0.9, shY - 0.4 * s);
  g.lineTo(midX + back * gw * 1.15, midY);
  g.lineTo(hipX + back * gw * 0.85, hipY + 0.6 * s);
  g.closePath();
  g.fillPath();

  // Bloated ones carry a distended gut that hangs over the hips
  if (kind === 'bloated') {
    g.fillStyle(dark, alpha);
    g.fillEllipse(midX + face * 0.8 * s, midY + 1.6 * s, gw * 2.6, torso * 0.78);
  }

  // ── Torn coat: hangs DOWN off the hips with a ragged hem. Hung off the
  //    shoulders and splayed backwards it read as a cape, not as clothing.
  const hemY = hipY + (3.0 + r2 * 2.4) * s;
  g.fillStyle(style.rag, alpha * 0.95);
  g.beginPath();
  g.moveTo(midX + back * gw * 1.0, midY + 0.5 * s);
  g.lineTo(midX + face * gw * 0.9, midY + 0.5 * s);
  for (let k = 0; k <= 3; k++) {
    const fx = midX + face * gw * 0.9 + ((back * gw * 1.9) * k) / 3;
    const flap = Math.sin(t * 2.6 + k * 1.7 + seed) * 0.8 * s;
    g.lineTo(fx, hemY - (k % 2) * 2.2 * s + flap);
  }
  g.closePath();
  g.fillPath();

  // ── Near side: the limbs that read ──────────────────────────────────────
  const [fax, fay, fakx, faky] = foot(swA);
  bone(g, legW, dark, alpha, hipX, hipY, fakx, faky, fax, fay);

  // Runners throw their arms back and LOW. Swept back at shoulder height they
  // simply vanish behind the torso, which is why the fast ones read as armless.
  const armDrop = kind === 'runner' ? 6.4 : 3.2;
  const handX = shX + face * reach * s;
  const handY = shY + (armDrop + Math.sin(armP) * 1.6) * s;
  bone(g, armW, dark, alpha,
    shX, shY,
    shX + face * reach * 0.55 * s, shY + (armDrop * 0.45 + Math.sin(armP + 0.7) * 1.0) * s,
    handX, handY);
  // Grasping hand
  g.fillStyle(dark, alpha);
  g.fillCircle(handX, handY, armW * 0.7);

  // ── Head: lolls with the gait, jaw hanging slack ────────────────────────
  const loll = Math.sin(p * 0.7) * 0.5 * s;
  g.fillStyle(dark, alpha);
  g.fillCircle(hdX + loll, hdY, headR);
  // A short wedge dropping from the chin — long and horizontal it turned into
  // a beak, which is not the read we want.
  g.fillTriangle(
    hdX + loll + face * headR * 0.1, hdY + headR * 0.3,
    hdX + loll + face * headR * 0.95, hdY + headR * 0.6,
    hdX + loll + face * headR * 0.35, hdY + headR * 1.55,
  );
  // Neck
  g.lineStyle(1.3 * s, dark, alpha);
  g.lineBetween(shX, shY, hdX + loll, hdY + headR * 0.7);

  // ── Rim light along the leading edge: without it a crowd is one dark mass
  if (s > 0.55) {
    g.lineStyle(0.9 * s, style.rim, alpha * (0.16 + 0.2 * style.daylight));
    g.beginPath();
    g.moveTo(hdX + loll + face * headR * 0.8, hdY - headR * 0.4);
    g.lineTo(shX + face * gw * 0.9, shY + 0.4 * s);
    g.lineTo(midX + face * gw, midY);
    g.strokePath();
  }

  // ── Eye-shine: at night the crowd looks back at you ─────────────────────
  if (style.daylight < 0.6 && s > 0.6) {
    g.fillStyle(0xbcd8c4, alpha * (0.65 - style.daylight) * 1.3);
    g.fillRect(hdX + loll + face * headR * 0.35, hdY - headR * 0.35, 1.05 * s, 0.95 * s);
  }

  // ── One dark stain apiece — the wound that turned them ──────────────────
  if (r3 > 0.55 && s > 0.7) {
    g.fillStyle(0x40100a, alpha * 0.85);
    g.fillEllipse(midX + face * gw * 0.4, midY + (r1 - 0.5) * 3 * s, 2.4 * s, 3.2 * s);
  }
}

/** Dragging itself forward on its elbows, legs trailing behind, useless. */
function drawCrawler(
  g: Phaser.GameObjects.Graphics,
  x: number, groundY: number, t: number, seed: number,
  s: number, face: 1 | -1, style: CrowdStyle, alpha: number,
): void {
  const p = t * 1.5 + seed * 2.399;
  const pull = Math.sin(p);
  const dark = style.body;
  const bodyY = groundY - 2.4 * s;
  const hipX = x - face * 3.2 * s;

  // Trailing legs, limp — they scrape rather than push
  g.lineStyle(1.5 * s, dark, alpha * 0.75);
  g.beginPath();
  g.moveTo(hipX, bodyY + 0.6 * s);
  g.lineTo(hipX - face * 5 * s, groundY - 0.6 * s + Math.sin(p * 0.8) * 0.5 * s);
  g.lineTo(hipX - face * 9.5 * s, groundY);
  g.strokePath();
  g.lineStyle(1.4 * s, dark, alpha * 0.55);
  g.beginPath();
  g.moveTo(hipX, bodyY + 1.2 * s);
  g.lineTo(hipX - face * 4.4 * s, groundY);
  g.lineTo(hipX - face * 8.6 * s, groundY - 0.4 * s);
  g.strokePath();

  // Torso flat to the dirt, shoulders heaving with each pull
  const heave = Math.max(0, pull) * 0.9 * s;
  g.fillStyle(dark, alpha);
  g.fillEllipse(x - face * 0.6 * s, bodyY - heave * 0.5, 11 * s, 4.4 * s);
  g.fillStyle(style.rag, alpha * 0.9);
  g.fillEllipse(hipX + face * 0.8 * s, bodyY + 0.5 * s, 6.6 * s, 3.4 * s);

  // The reaching arm — planted ahead, hauling the body after it
  const reachX = x + face * (5.5 + pull * 3.2) * s;
  bone(g, 1.5 * s, dark, alpha,
    x + face * 2.4 * s, bodyY - heave,
    x + face * 4.4 * s, bodyY + 0.8 * s,
    reachX, groundY - 0.4 * s);
  g.fillStyle(dark, alpha);
  g.fillCircle(reachX, groundY - 0.4 * s, 1.1 * s);
  // The other arm, tucked under and pushing
  bone(g, 1.35 * s, dark, alpha * 0.7,
    x + face * 1.8 * s, bodyY + 0.4 * s,
    x + face * 3.0 * s, bodyY + 1.8 * s,
    x + face * 4.6 * s, groundY);

  // Head up, watching the sky
  const hx = x + face * 5.2 * s, hy = bodyY - (1.9 + heave) * s;
  g.fillStyle(dark, alpha);
  g.fillCircle(hx, hy, 2.2 * s);
  g.fillTriangle(hx, hy + 0.6 * s, hx + face * 3.2 * s, hy + 1.4 * s, hx + face * 0.8 * s, hy + 2.4 * s);
  if (style.daylight < 0.6 && s > 0.6) {
    g.fillStyle(0xbcd8c4, alpha * (0.65 - style.daylight) * 1.3);
    g.fillRect(hx + face * 0.8 * s, hy - 0.4 * s, 1.0 * s, 0.9 * s);
  }
}

/** One that isn't getting back up — put down and left where it fell. */
export function drawCorpse(
  g: Phaser.GameObjects.Graphics,
  x: number, groundY: number, seed: number, scale: number, style: CrowdStyle,
): void {
  const s = scale;
  const face: 1 | -1 = rnd(seed + 5) > 0.5 ? 1 : -1;
  g.fillStyle(style.body, 0.95);
  g.fillEllipse(x, groundY - 1.6 * s, 12 * s, 3.4 * s);
  g.fillCircle(x + face * 6.6 * s, groundY - 2.0 * s, 2.1 * s);
  g.lineStyle(1.4 * s, style.body, 0.9);
  g.lineBetween(x - face * 2 * s, groundY - 2.4 * s, x - face * 7.5 * s, groundY - 0.4 * s);
  g.lineBetween(x + face * 2 * s, groundY - 1.2 * s, x + face * 5 * s, groundY + 0.4 * s);
  // Pooled beneath
  g.fillStyle(0x2a0a06, 0.5);
  g.fillEllipse(x + face * 3 * s, groundY + 0.6 * s, 15 * s, 2.4 * s);
}

/**
 * A press of bodies — the reason every settlement has a wall.
 *
 * Laid out in depth rows: the back rows are smaller, dimmer and drawn first,
 * so the mass reads as a crowd with volume rather than a single rank.
 *
 * `spread` is SIGNED — it is the direction the queue tails off in — while
 * `face` is the direction they are all straining toward. At a settlement wall
 * those are opposites: the crowd stretches away from the gate and every one of
 * them is pushing back toward it.
 */
export function drawHorde(
  g: Phaser.GameObjects.Graphics,
  x0: number,
  groundY: number,
  spread: number,
  count: number,
  t: number,
  seedBase: number,
  style: CrowdStyle,
  face: 1 | -1,
  baseScale = 1,
): void {
  const rows = 3;
  for (let row = rows - 1; row >= 0; row--) {
    const depth = row / (rows - 1);            // 1 = furthest back
    const rs = baseScale * (1 - depth * 0.34);
    const a = 1 - depth * 0.42;
    const yOff = -depth * 2.4 * baseScale;
    const n = Math.max(1, Math.round(count / rows));
    for (let i = 0; i < n; i++) {
      const id = seedBase + row * 91 + i * 13;
      const sx = x0 + (i + rnd(id) * 0.7) * (spread / n);
      // The crowd surges as one, individuals fighting to be at the front
      const push = Math.abs(Math.sin(t * 0.9 + i * 0.8 + row)) * 3.2 * baseScale;
      drawUndead(
        g, sx + face * push, groundY + yOff, t, id,
        rs * (0.85 + rnd(id + 7) * 0.4), face,
        undeadKindFor(id), style, a,
      );
    }
  }
}
