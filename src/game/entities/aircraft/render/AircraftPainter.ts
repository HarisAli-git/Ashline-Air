import Phaser from 'phaser';
import type { AircraftVisualSpec } from './AircraftVisualSpec';

/**
 * Bakes every part of a procedurally drawn aircraft into textures, once.
 *
 * Static parts that never articulate (hull, wings, canopy, damage overlays)
 * share ONE canvas size anchored at the fuselage datum, so the sprite can
 * place them all at (0,0) with origin 0.5 and they self-align.
 * Articulated parts (prop, gear, flap, nacelle) get their own small canvases.
 *
 * Everything is drawn at SS× resolution and displayed at 1/SS scale for
 * cheap anti-aliasing.
 */

export const SS = 2; // supersample factor

export interface AircraftTexKeys {
  hull: string;
  wingNear: string;
  wingFar: string;
  canopy: string;
  damage: [string, string, string, string];
  nacelle: string;
  propBlade: string;
  propDisc: string;
  propDiscBlur: string;
  gearStrut: string;
  wheel: string;
  gearDoor: string;
  flap: string;
  /** Shared canvas size of the hull-family textures (design units). */
  bodyW: number;
  bodyH: number;
}

// ── Deterministic RNG so weathering details are stable per aircraft ──────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ── Tiny drawing helper: datum-centred coords, SS-scaled ─────────────────────
class P {
  readonly g: Phaser.GameObjects.Graphics;
  private readonly ox: number;
  private readonly oy: number;

  constructor(g: Phaser.GameObjects.Graphics, ox: number, oy: number) {
    this.g = g;
    this.ox = ox;
    this.oy = oy;
  }

  private X(x: number): number { return (x + this.ox) * SS; }
  private Y(y: number): number { return (y + this.oy) * SS; }

  poly(pts: Array<[number, number]>, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillPoints(pts.map(([x, y]) => new Phaser.Geom.Point(this.X(x), this.Y(y))), true);
    return this;
  }
  rrect(x: number, y: number, w: number, h: number, r: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillRoundedRect(this.X(x), this.Y(y), w * SS, h * SS, Math.max(1, r * SS));
    return this;
  }
  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillRect(this.X(x), this.Y(y), w * SS, h * SS);
    return this;
  }
  ellipse(cx: number, cy: number, w: number, h: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillEllipse(this.X(cx), this.Y(cy), w * SS, h * SS);
    return this;
  }
  strokeEllipse(cx: number, cy: number, w: number, h: number, lw: number, color: number, alpha = 1): this {
    this.g.lineStyle(lw * SS, color, alpha);
    this.g.strokeEllipse(this.X(cx), this.Y(cy), w * SS, h * SS);
    return this;
  }
  circle(cx: number, cy: number, r: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillCircle(this.X(cx), this.Y(cy), r * SS);
    return this;
  }
  line(x1: number, y1: number, x2: number, y2: number, lw: number, color: number, alpha = 1): this {
    this.g.lineStyle(lw * SS, color, alpha);
    this.g.lineBetween(this.X(x1), this.Y(y1), this.X(x2), this.Y(y2));
    return this;
  }
  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillTriangle(this.X(x1), this.Y(y1), this.X(x2), this.Y(y2), this.X(x3), this.Y(y3));
    return this;
  }
}

function bake(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  ox: number,
  oy: number,
  draw: (p: P) => void,
): void {
  if (scene.textures.exists(key)) return;
  // add + destroy within the same tick — the graphics object is never rendered
  const g = scene.add.graphics();
  draw(new P(g, ox, oy));
  g.generateTexture(key, Math.ceil(w * SS), Math.ceil(h * SS));
  g.destroy();
}

// ── Shared particle / effect textures ────────────────────────────────────────
export function ensureSharedTextures(scene: Phaser.Scene): void {
  bake(scene, 'px_soft', 32, 32, 16, 16, p => {
    const steps: Array<[number, number]> = [[15, 0.05], [12, 0.09], [9, 0.14], [6, 0.22], [3.5, 0.34]];
    for (const [r, a] of steps) p.circle(0, 0, r, 0xffffff, a);
  });
  bake(scene, 'px_streak', 12, 4, 6, 2, p => {
    p.rrect(-6, -1.5, 12, 3, 1.5, 0xffffff, 1);
  });
  bake(scene, 'px_shadow', 96, 24, 48, 12, p => {
    const steps: Array<[number, number, number]> = [[46, 11, 0.10], [38, 9, 0.14], [28, 7, 0.18], [18, 5, 0.22]];
    for (const [w, h, a] of steps) p.ellipse(0, 0, w * 2, h * 2, 0x000000, a);
  });
}

// ── Wing planform helper ─────────────────────────────────────────────────────
function wingQuad(
  rootX: number, y: number, chord: number, span: number, sweep: number, drop: number,
): Array<[number, number]> {
  const tipC = chord * 0.58;
  const tipDX = -(sweep + span * 0.4);
  const leadRoot: [number, number]  = [rootX + chord * 0.55, y];
  const trailRoot: [number, number] = [rootX - chord * 0.45, y + 1];
  const trailTip: [number, number]  = [rootX - chord * 0.45 + tipDX + (chord - tipC) * 0.5, y + drop + 1];
  const leadTip: [number, number]   = [rootX + chord * 0.55 + tipDX - (chord - tipC) * 0.5, y + drop];
  return [leadRoot, trailRoot, trailTip, leadTip];
}

// ── Main entry ───────────────────────────────────────────────────────────────
export function ensureAircraftTextures(
  scene: Phaser.Scene,
  id: string,
  spec: AircraftVisualSpec,
): AircraftTexKeys {
  ensureSharedTextures(scene);

  const k = (part: string): string => `proc_${id}_${part}`;
  const L = spec.length;
  const H = spec.height;
  const pal = spec.palette;
  const rng = mulberry32(hashId(id));

  // Shared canvas for the hull family — big enough for fin above and wings below.
  const bodyW = L + 70;
  const bodyH = (H / 2 + spec.tail.finHeight + 26) * 2;
  const ox = bodyW / 2;
  const oy = bodyH / 2;

  // ── Hull: fuselage + fin + stabiliser + weathering ─────────────────────────
  bake(scene, k('hull'), bodyW, bodyH, ox, oy, p => {
    const t = spec.tail;

    // Stabiliser (behind fuselage, slightly darker)
    p.poly([
      [-L * 0.32, -H * 0.22], [-L / 2 - 8, -H * 0.28],
      [-L / 2 - 10, -H * 0.18], [-L * 0.32, -H * 0.14],
    ], pal.hullShade, 0.95);
    p.line(-L * 0.33, -H * 0.22, -L / 2 - 8, -H * 0.27, 1, pal.hullLight, 0.5);

    // Fin (swept vertical stabiliser)
    p.poly([
      [-L * 0.33, -H * 0.42],
      [-L / 2 + t.finSweep, -H / 2 - t.finHeight],
      [-L / 2, -H / 2 - t.finHeight],
      [-L / 2 + 1, -H * 0.08],
    ], pal.hull, 1);
    // Rudder hinge line + fin leading-edge light
    p.line(-L / 2 + t.finSweep * 0.55, -H / 2 - t.finHeight + 2, -L / 2 + 4, -H * 0.14, 1, 0x000000, 0.22);
    p.line(-L * 0.33, -H * 0.42, -L / 2 + t.finSweep, -H / 2 - t.finHeight, 1.2, pal.hullLight, 0.55);
    // Faction-ish tail band
    p.poly([
      [-L / 2 + t.finSweep * 0.75, -H / 2 - t.finHeight + 3],
      [-L / 2 + t.finSweep * 0.35, -H / 2 - t.finHeight * 0.55],
      [-L / 2 + 1, -H / 2 - t.finHeight * 0.55],
      [-L / 2 + 1, -H / 2 - t.finHeight + 3],
    ], pal.accent, 0.75);

    // Tail cone
    p.poly([
      [-L / 2, -H * 0.30], [-L * 0.12, -H / 2],
      [-L * 0.12, H / 2], [-L / 2, H * 0.08],
    ], pal.hull, 1);
    // Centre body
    p.rrect(-L * 0.15, -H / 2, L * 0.55, H, H * 0.3, pal.hull, 1);
    // Nose
    p.ellipse(L * 0.37, 0, L * 0.26, H * 0.94, pal.hull, 1);
    p.circle(L * 0.46, 0, H * 0.29, pal.hull, 1);

    // Belly shade
    p.rrect(-L * 0.14, H * 0.06, L * 0.52, H * 0.40, 4, pal.hullShade, 0.9);
    p.tri(-L / 2 + 2, H * 0.06, -L * 0.12, H * 0.06, -L * 0.12, H * 0.46, pal.hullShade, 0.75);
    p.ellipse(L * 0.37, H * 0.18, L * 0.24, H * 0.5, pal.hullShade, 0.55);
    // Top highlight
    p.rrect(-L * 0.14, -H / 2 + 1, L * 0.52, 3, 1.5, pal.hullLight, 0.5);

    // Panel seams + rivet rows
    for (const fx of [-0.05, 0.12, 0.26]) {
      p.line(L * fx, -H / 2 + 2, L * fx, H / 2 - 2, 0.8, 0x000000, 0.14);
    }
    for (const ry of [-H * 0.25, H * 0.16]) {
      for (let x = -L * 0.42; x < L * 0.4; x += 8) p.circle(x, ry, 0.6, 0x000000, 0.16);
    }

    // Accent trim stripe with paint chips
    for (let x = -L * 0.1; x < L * 0.32; x += 7) {
      if (rng() < 0.82) p.rect(x, -H * 0.10, 6, 3.5, pal.accent, 0.8);
    }

    // Mismatched patch panels
    for (let i = 0; i < 3; i++) {
      const px = -L * 0.35 + rng() * L * 0.6;
      const py = -H * 0.3 + rng() * H * 0.5;
      const pw = 8 + rng() * 12;
      const ph = 5 + rng() * 6;
      p.rect(px, py, pw, ph, i % 2 ? pal.hullLight : pal.hullShade, 0.5);
      p.line(px, py, px + pw, py, 0.7, 0x000000, 0.2);
      p.line(px, py + ph, px + pw, py + ph, 0.7, 0x000000, 0.2);
    }

    // Rust streaks bleeding down from seams
    for (let i = 0; i < 5; i++) {
      const rx = -L * 0.4 + rng() * L * 0.75;
      const ry = -H * 0.2 + rng() * H * 0.35;
      p.rect(rx, ry, 1.2, 4 + rng() * 7, pal.rust, 0.35);
    }

    // Faint exhaust staining (present even at full health)
    for (let i = 0; i < 3; i++) {
      p.ellipse(spec.exhaust.x - 8 - i * 9, spec.exhaust.y + i, 14, 4, 0x1a1610, 0.09);
    }

    // Wing-to-body struts
    if (spec.wing.layout === 'biplane') {
      const upperY = -H / 2 - 14;
      p.line(spec.wing.rootX - 12, -H / 2 + 2, spec.wing.rootX - 15, upperY, 1.6, pal.metal, 0.95);
      p.line(spec.wing.rootX + 12, -H / 2 + 2, spec.wing.rootX + 9, upperY, 1.6, pal.metal, 0.95);
    } else if (spec.wing.layout === 'high' && L < 160) {
      p.line(spec.wing.rootX + 4, H * 0.3, spec.wing.rootX + 20, spec.wing.y + 3, 1.6, pal.metal, 0.9);
    }
  });

  // ── Wings ──────────────────────────────────────────────────────────────────
  const w = spec.wing;
  bake(scene, k('wingNear'), bodyW, bodyH, ox, oy, p => {
    const q = wingQuad(w.rootX, w.y, w.chord, w.span, w.sweep, w.drop);
    p.poly(q, pal.hull, 1);
    p.line(q[0][0], q[0][1], q[3][0], q[3][1], 1.4, pal.hullLight, 0.7);  // leading edge
    p.line(q[1][0], q[1][1], q[2][0], q[2][1], 1, 0x000000, 0.25);        // trailing edge
    // Aileron hint near the tip
    const ax = (q[1][0] + q[2][0]) / 2, ay = (q[1][1] + q[2][1]) / 2;
    p.line(ax, ay, q[2][0], q[2][1], 0.8, 0x000000, 0.2);
    // Root fairing
    p.ellipse(w.rootX, w.y + 1, w.chord * 0.7, 6, pal.hull, 1);
    // Wing weathering
    p.rect(w.rootX - w.chord * 0.1, w.y + w.drop * 0.4, 7, 4, pal.hullShade, 0.5);
  });

  bake(scene, k('wingFar'), bodyW, bodyH, ox, oy, p => {
    let fy = w.y - 3, fdrop = -w.drop * 0.8, chord = w.chord;
    if (w.layout === 'biplane') { fy = -H / 2 - 14; fdrop = -4; }
    else if (w.layout === 'high') { fy = w.y - 2; fdrop = w.drop - 7; }
    const q = wingQuad(w.rootX - 6, fy, chord, w.span, w.sweep, fdrop);
    p.poly(q, pal.hullShade, 1);
    p.line(q[0][0], q[0][1], q[3][0], q[3][1], 1.2, pal.hullLight, w.layout === 'biplane' ? 0.6 : 0.35);
  });

  // ── Canopy / cockpit glazing ───────────────────────────────────────────────
  bake(scene, k('canopy'), bodyW, bodyH, ox, oy, p => {
    const c = spec.canopy;
    if (c.style === 'bubble') {
      p.poly([
        [c.x, -H / 2 + 1],
        [c.x + c.w * 0.25, -H / 2 - 9],
        [c.x + c.w * 0.7, -H / 2 - 9],
        [c.x + c.w, -H / 2 + 1],
      ], pal.canopy, 1);
      p.line(c.x + c.w * 0.25, -H / 2 - 9, c.x + c.w * 0.32, -H / 2 + 1, 1, pal.metal, 0.7);
      p.line(c.x + c.w * 0.28, -H / 2 - 6.5, c.x + c.w * 0.52, -H / 2 - 4, 1.4, pal.canopyGlint, 0.65);
    } else {
      // Slanted windscreen at the front…
      p.poly([
        [c.x + c.w - 12, -H * 0.5 + 2],
        [c.x + c.w, -H * 0.14],
        [c.x + c.w - 7, -H * 0.12],
        [c.x + c.w - 16, -H * 0.5 + 2],
      ], pal.canopy, 1);
      p.line(c.x + c.w - 12, -H * 0.44, c.x + c.w - 4, -H * 0.18, 1, pal.canopyGlint, 0.6);
      // …then a strip of square cabin windows
      const n = Math.max(2, Math.floor((c.w - 18) / 11));
      for (let i = 0; i < n; i++) {
        const wx = c.x + i * 11;
        p.rrect(wx, -H * 0.34, 6.5, 5.5, 1.5, pal.canopy, 1);
        p.rect(wx + 1, -H * 0.32, 2, 1.6, pal.canopyGlint, 0.55);
      }
    }
  });

  // ── Damage overlays, 4 escalating tiers ────────────────────────────────────
  const drawTier = (p: P, tier: number, r: () => number): void => {
    // T1+: scuffs and a small scorch at the exhaust
    for (let i = 0; i < 4; i++) {
      const sx = -L * 0.38 + r() * L * 0.7;
      const sy = -H * 0.3 + r() * H * 0.55;
      p.line(sx, sy, sx + 4 + r() * 6, sy + 1 + r() * 2, 1.2, 0x14100c, 0.28);
    }
    p.circle(spec.exhaust.x - 4, spec.exhaust.y, 4, 0x14100c, 0.22);
    if (tier < 2) return;

    // T2+: dents with a light catch on the upper rim, oil streak from the engine
    for (let i = 0; i < 2; i++) {
      const dx = -L * 0.25 + r() * L * 0.5;
      const dy = -H * 0.2 + r() * H * 0.4;
      p.ellipse(dx, dy, 8, 5, 0x0e0c08, 0.38);
      p.line(dx - 3, dy - 2.5, dx + 3, dy - 2.5, 1, pal.hullLight, 0.5);
    }
    const e0 = spec.engines[0];
    for (let i = 0; i < 4; i++) {
      p.rect(e0.x - 6 - i * 5, e0.y + e0.cowlH * 0.3 + i * 2, 8, 2, 0x1c1408, 0.5);
    }
    if (tier < 3) return;

    // T3+: scorch fan behind the exhaust, torn panel
    for (let i = 0; i < 4; i++) {
      p.ellipse(spec.exhaust.x - 10 - i * 10, spec.exhaust.y + i * 1.5, 18, 6, 0x0c0a06, 0.32);
    }
    const tx = -L * 0.05, ty = -H * 0.15;
    p.tri(tx, ty, tx + 12, ty - 2, tx + 7, ty + 8, 0x0a0806, 0.6);
    p.line(tx + 2, ty + 1, tx + 9, ty + 5, 0.8, pal.hullLight, 0.45);
    if (tier < 4) return;

    // T4: heavy char, exposed airframe
    for (let i = 0; i < 5; i++) {
      const cx2 = -L * 0.4 + r() * L * 0.75;
      const cy2 = -H * 0.25 + r() * H * 0.5;
      p.ellipse(cx2, cy2, 12 + r() * 10, 6 + r() * 4, 0x080604, 0.42);
    }
    const fx = -L * 0.3, fy = -H * 0.1;
    p.rect(fx, fy, 22, 10, 0x060504, 0.65);
    for (let i = 0; i < 4; i++) p.line(fx + 3 + i * 5.5, fy + 1, fx + 3 + i * 5.5, fy + 9, 1, 0x8a8578, 0.5);
    p.line(fx + 1, fy + 5, fx + 21, fy + 5, 1, 0x8a8578, 0.5);
  };

  const damage: [string, string, string, string] = ['1', '2', '3', '4'].map(t => k(`damage${t}`)) as [string, string, string, string];
  for (let tier = 1; tier <= 4; tier++) {
    bake(scene, k(`damage${tier}`), bodyW, bodyH, ox, oy, p => drawTier(p, tier, mulberry32(hashId(id) + 7)));
  }

  // ── Nacelle (engine cowl, reused for near + far via tint) ──────────────────
  const eng = spec.engines[0];
  const nacW = eng.cowlLen + 14, nacH = eng.cowlH + 8;
  bake(scene, k('nacelle'), nacW, nacH, nacW / 2, nacH / 2, p => {
    const cl = eng.cowlLen, ch = eng.cowlH;
    p.rrect(-cl / 2, -ch / 2, cl, ch, ch * 0.35, pal.metal, 1);
    p.rrect(-cl / 2 + 1, ch * 0.05, cl - 2, ch * 0.4, 3, pal.hullShade, 0.75);
    p.rrect(-cl / 2 + 1, -ch / 2 + 1, cl - 2, 2.5, 1.2, pal.hullLight, 0.55);
    // Cooling gills
    for (let i = 0; i < 3; i++) p.line(-cl * 0.1 + i * 4, -ch * 0.3, -cl * 0.1 + i * 4, ch * 0.3, 0.8, 0x000000, 0.25);
    // Intake lip + spinner cone
    p.circle(cl / 2 - 1, 0, ch * 0.32, 0x16140f, 1);
    p.tri(cl / 2, -3.2, cl / 2 + 7, 0, cl / 2, 3.2, pal.metal, 1);
    p.tri(cl / 2, -3.2, cl / 2 + 7, 0, cl / 2, 0, pal.hullLight, 0.4);
    // Exhaust stubs
    p.rect(-cl * 0.28, ch * 0.42, 5, 2.4, 0x211c14, 1);
  });

  // ── Propeller: blade line, mid-rpm disc, full-rpm blur disc ────────────────
  const pr = spec.prop.r;
  bake(scene, k('propBlade'), 10, pr * 2 + 6, 5, pr + 3, p => {
    // A full blade pair through the hub reads as a 2-blade prop side-on
    p.poly([[-2, 0], [-1.2, -pr], [1.2, -pr], [2, 0]], pal.prop, 1);
    p.poly([[-2, 0], [-1.2, pr], [1.2, pr], [2, 0]], pal.prop, 1);
    p.rect(-1.6, -pr, 3.2, 2.4, pal.accent, 0.9);   // warning tip stripes
    p.rect(-1.6, pr - 2.4, 3.2, 2.4, pal.accent, 0.9);
    p.circle(0, 0, 3, pal.metal, 1);
    p.circle(0, 0, 1.2, 0x14120e, 1);
  });
  bake(scene, k('propDisc'), pr * 0.6 + 6, pr * 2 + 6, pr * 0.3 + 3, pr + 3, p => {
    p.ellipse(0, 0, pr * 0.44, pr * 2, 0xbfc4c9, 0.10);
    p.strokeEllipse(0, 0, pr * 0.44, pr * 2, 0.8, 0xd7dade, 0.25);
  });
  bake(scene, k('propDiscBlur'), pr * 0.7 + 6, pr * 2 + 6, pr * 0.35 + 3, pr + 3, p => {
    p.ellipse(0, 0, pr * 0.52, pr * 2, 0xc9cdd2, 0.16);
    p.strokeEllipse(0, 0, pr * 0.52, pr * 2, 1, 0xe2e5e8, 0.26);
    // Spinning warning-stripe arcs at the tips
    p.ellipse(0, -pr + 1.5, pr * 0.4, 3, pal.accent, 0.30);
    p.ellipse(0, pr - 1.5, pr * 0.4, 3, pal.accent, 0.30);
  });

  // ── Landing gear parts ─────────────────────────────────────────────────────
  const gr = spec.gear;
  bake(scene, k('gearStrut'), 12, gr.strutLen + 8, 6, 2, p => {
    p.rrect(-1.8, 0, 3.6, gr.strutLen, 1.5, pal.metal, 1);
    p.rrect(-1.2, gr.strutLen * 0.55, 2.4, gr.strutLen * 0.4, 1, 0xd8d4c8, 0.85); // polished oleo
    p.line(-1.5, gr.strutLen * 0.45, 2.8, gr.strutLen * 0.62, 1.2, pal.metal, 0.9); // torque link
    p.line(2.8, gr.strutLen * 0.62, -1.5, gr.strutLen * 0.8, 1.2, pal.metal, 0.9);
  });
  bake(scene, k('wheel'), gr.wheelR * 2 + 4, gr.wheelR * 2 + 4, gr.wheelR + 2, gr.wheelR + 2, p => {
    p.circle(0, 0, gr.wheelR, 0x1d1b18, 1);
    p.strokeEllipse(0, 0, gr.wheelR * 2 - 1.6, gr.wheelR * 2 - 1.6, 0.8, 0x33302b, 1);
    p.circle(0, 0, gr.wheelR * 0.45, pal.metal, 1);
    p.circle(0, 0, gr.wheelR * 0.16, 0x14120e, 1);
    p.line(0, -gr.wheelR * 0.4, 0, -gr.wheelR + 1, 1.2, 0x0c0b09, 0.9); // spin marker
  });
  bake(scene, k('gearDoor'), 20, 6, 1, 1, p => {
    p.rrect(0, 0, 18, 4, 1.5, pal.hullShade, 1);
    p.line(0, 0.8, 18, 0.8, 0.8, pal.hullLight, 0.4);
  });

  // ── Flap ───────────────────────────────────────────────────────────────────
  const flapLen = w.chord * 0.45;
  bake(scene, k('flap'), flapLen + 4, 9, flapLen + 2, 4.5, p => {
    p.poly([[0, -2.6], [-flapLen, -1.4], [-flapLen, 1.4], [0, 2.6]], pal.hullShade, 1);
    p.line(-1, -2.4, -1, 2.4, 1.2, pal.metal, 0.8); // hinge line
    p.line(0, -2.4, -flapLen, -1.2, 0.8, pal.hullLight, 0.5);
  });

  return {
    hull: k('hull'),
    wingNear: k('wingNear'),
    wingFar: k('wingFar'),
    canopy: k('canopy'),
    damage,
    nacelle: k('nacelle'),
    propBlade: k('propBlade'),
    propDisc: k('propDisc'),
    propDiscBlur: k('propDiscBlur'),
    gearStrut: k('gearStrut'),
    wheel: k('wheel'),
    gearDoor: k('gearDoor'),
    flap: k('flap'),
    bodyW,
    bodyH,
  };
}
