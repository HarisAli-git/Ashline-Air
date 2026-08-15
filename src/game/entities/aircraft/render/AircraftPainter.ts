import Phaser from 'phaser';
import {
  NEAR_THROW, FAR_THROW, stabRoot, STAB_FIXED_FRAC, type AircraftVisualSpec,
} from './AircraftVisualSpec';

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
  elevator: string;
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

/** Blend two packed RGB colours — used for form shading across the airframe. */
function mixHex(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * u) << 16) |
    (Math.round(ag + (bg - ag) * u) << 8) |
    Math.round(ab + (bb - ab) * u)
  );
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

/**
 * The wing as it projects into a side view.
 *
 * The camera sits a little above the aircraft, so a horizontal wing running
 * TOWARD the viewer walks down the screen and one running away walks up it.
 * Which way the throw goes is a property of the CAMERA, not of the aeroplane,
 * so it is passed in explicitly: positive (down) for the near wing, negative
 * for the far one. Deriving it from the sign of `drop` instead sent both wings
 * of a high-wing transport sweeping upward, which drew a sail over the
 * fuselage rather than a wing beside it. `drop` now only adds the aircraft's
 * own dihedral on top of the camera throw.
 */
function wingQuad(
  rootX: number, y: number, chord: number, span: number, sweep: number,
  drop: number, throwY: number,
): Array<[number, number]> {
  const tipC = chord * 0.5;
  const tipDX = -(sweep + span * 0.42);
  const tipDY = drop + throwY;
  const leadRoot: [number, number]  = [rootX + chord * 0.55, y];
  const trailRoot: [number, number] = [rootX - chord * 0.45, y + 2];
  const trailTip: [number, number]  = [rootX - chord * 0.45 + tipDX + (chord - tipC) * 0.5, y + tipDY + 2];
  const leadTip: [number, number]   = [rootX + chord * 0.55 + tipDX - (chord - tipC) * 0.5, y + tipDY];
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

  /**
   * Fuselage side profile, as a fraction of the half-height, along the body
   * from tail tip (u = 0) to nose tip (u = 1). A thin upswept tail cone, a
   * constant-section cabin, and a rounded nose — the shape that makes a
   * fuselage read as a fuselage rather than a lozenge.
   */
  const f = spec.fuselage;
  // Bluntness constant solved so `noseFull` really is the half-height left at
  // the very tip: a fine cone at 0.25, a radome at 0.7.
  const kNose = (1 - f.noseFull * f.noseFull) / 0.907;
  const halfH = (u: number): number => {
    const s0 = u < f.taperStart
      ? f.tailDepth + (1 - f.tailDepth) * Math.pow(u / f.taperStart, 0.7)  // tail cone
      : u < 0.70
        ? 1                                                                 // cabin
        : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.70) / 0.315, 2) * kNose)); // nose
    return (H / 2) * s0;
  };
  /** Centreline: fuselages sweep up toward the tail. */
  const camber = (u: number): number =>
    -H * f.upsweep * Math.max(0, (f.taperStart + 0.08 - u) / (f.taperStart + 0.08));

  // ── Hull: fuselage + fin + stabiliser + weathering ─────────────────────────
  bake(scene, k('hull'), bodyW, bodyH, ox, oy, p => {
    const t = spec.tail;

    // Fin (swept vertical stabiliser). Drawn BEFORE the tailplane on a T-tail,
    // so the tailplane sits on top of it rather than behind it.
    p.poly([
      [-L * 0.33, -H * 0.42],
      [-L / 2 + t.finSweep, -H / 2 - t.finHeight],
      [-L / 2, -H / 2 - t.finHeight],
      [-L / 2 + 1, -H * 0.08],
    ], pal.hull, 1);

    // Fixed stabiliser only — the elevator behind it is a separate, hinged
    // part so the aircraft is not one rigid lump when you move the stick.
    const sr = stabRoot(spec);
    const sl = t.stabLen * STAB_FIXED_FRAC;
    p.poly([
      [sr.x, sr.y], [sr.x - sl, sr.y - H * 0.04],
      [sr.x - sl, sr.y + H * 0.06], [sr.x, sr.y + H * 0.08],
    ], pal.hullShade, 0.95);
    p.line(sr.x - 1, sr.y, sr.x - sl, sr.y - H * 0.035, 1, pal.hullLight, 0.5);
    // Hinge line
    p.line(sr.x - sl, sr.y - H * 0.045, sr.x - sl, sr.y + H * 0.07, 0.8, 0x000000, 0.3);
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

    // ── Fuselage: one continuous profile, shaded along its own outline ─────
    //
    // This used to be a rounded-rect "centre body" with an ellipse nose and a
    // polygon tail stuck on either end, and then the cylinder shading was laid
    // over it as flat RECTANGLES. The silhouette was round and the shading was
    // square, so the seams showed and the whole thing read as a slab with bits
    // glued on. The body is now sampled as a real profile — pointed nose,
    // constant-section cabin, upswept tapering tail cone — and shaded column
    // by column so the light wraps around the tube it is actually drawn on.
    // It is baked once into a texture, so the per-column work is free.
    const fuseTop = (u: number): number => camber(u) - halfH(u);
    /**
     * A freighter is a box with a rounded top, not a tube: the cargo floor
     * runs flat from behind the nose gear back to the ramp. `bellyFlat` pulls
     * the lower line onto that floor over exactly that stretch, which is most
     * of what separates a cargo hold from a fat cigar.
     */
    const fuseBot = (u: number): number => {
      const round = camber(u) + halfH(u);
      if (f.bellyFlat <= 0) return round;
      // The floor runs from the ramp hinge forward to where the nose starts
      // curving up, and NOWHERE else. Extending it forward inflated the nose
      // into a whale head; extending it aft flattened out the ramp entirely.
      const ramp = f.taperStart * 0.8;
      const zone = Phaser.Math.Clamp((u - ramp) / 0.07, 0, 1)
                 * Phaser.Math.Clamp((0.70 - u) / 0.07, 0, 1);
      return round + (H / 2 - round) * f.bellyFlat * zone;
    };
    const xOf = (u: number): number => -L / 2 + u * L;

    const COLS = Math.max(60, Math.round(L));
    const BANDS = 10;
    for (let c = 0; c < COLS; c++) {
      const u = c / (COLS - 1);
      const x = xOf(u);
      const top = fuseTop(u), bot = fuseBot(u);
      const span = bot - top;
      if (span <= 0.5) continue;
      const w = L / (COLS - 1) + 0.8;      // slight overlap, no seams
      for (let b = 0; b < BANDS; b++) {
        const t0 = b / BANDS, t1 = (b + 1) / BANDS;
        // Brightest just below the crown, darkest at the keel
        const shade = Math.cos((t0 - 0.28) * Math.PI * 0.95);
        let col = shade > 0
          ? mixHex(pal.hull, pal.hullLight, shade * 0.55)
          : mixHex(pal.hull, pal.hullShade, Math.min(1, -shade * 1.25));
        // The nose and tail turn away from the light as well as the belly
        const endFade = Math.min(1, Math.min(u, 1 - u) / 0.16);
        if (endFade < 1) col = mixHex(col, pal.hullShade, (1 - endFade) * 0.45);
        p.rect(x, top + span * t0, w, span * (t1 - t0) + 0.5, col, 1);
      }
    }

    // Outline: a dark edge top and bottom, and a specular crown just inside it
    for (let c = 0; c < COLS - 1; c++) {
      const u0 = c / (COLS - 1), u1 = (c + 1) / (COLS - 1);
      if (fuseBot(u0) - fuseTop(u0) <= 0.5) continue;
      p.line(xOf(u0), fuseTop(u0), xOf(u1), fuseTop(u1), 1.4, mixHex(pal.hullShade, 0x000000, 0.55), 0.85);
      p.line(xOf(u0), fuseBot(u0), xOf(u1), fuseBot(u1), 1.6, mixHex(pal.hullShade, 0x000000, 0.7), 0.9);
      if (u0 > 0.14 && u0 < 0.88) {
        p.line(xOf(u0), fuseTop(u0) + 1.6, xOf(u1), fuseTop(u1) + 1.6,
          1.5, mixHex(pal.hullLight, 0xffffff, 0.35), 0.55);
      }
    }

    // Gear sponson: a high-wing transport has nowhere in the wing to fold the
    // gear, so it lives in a blister on the fuselage side. Without it the legs
    // appear to sprout straight out of a smooth belly.
    const sp = spec.gear.sponson;
    if (sp) {
      const top = H * 0.10, bot = top + sp.h;
      p.poly([
        [sp.x - sp.w / 2, top],
        [sp.x + sp.w / 2, top],
        [sp.x + sp.w / 2 - sp.h * 0.55, bot],
        [sp.x - sp.w / 2 + sp.h * 0.7, bot],
      ], mixHex(pal.hull, pal.hullShade, 0.35), 1);
      p.line(sp.x - sp.w / 2 + sp.h * 0.7, bot, sp.x + sp.w / 2 - sp.h * 0.55, bot,
        1.4, mixHex(pal.hullShade, 0x000000, 0.55), 0.9);
      p.line(sp.x - sp.w / 2, top + 1, sp.x + sp.w / 2, top + 1,
        1.1, mixHex(pal.hullLight, 0xffffff, 0.2), 0.4);
      // Bay door seam along the bottom
      p.line(sp.x - sp.w * 0.3, bot - 1.5, sp.x + sp.w * 0.3, bot - 1.5, 0.8, 0x000000, 0.3);
    }

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

  // ── Elevator: hinged at the stabiliser's trailing edge ─────────────────────
  // Drawn in its own tiny canvas with the hinge at the RIGHT edge, so the
  // sprite can rotate it about origin (1, 0.5) and it swings like a real one.
  const elevLen = spec.tail.stabLen * (1 - STAB_FIXED_FRAC);
  bake(scene, k('elevator'), elevLen + 6, H * 0.5, elevLen + 3, H * 0.25, p => {
    p.poly([
      [0, -H * 0.045], [-elevLen, -H * 0.075],
      [-elevLen - 2, H * 0.035], [0, H * 0.045],
    ], pal.hullShade, 1);
    p.line(0, -H * 0.045, -elevLen, -H * 0.075, 1, pal.hullLight, 0.5);
    p.line(0, H * 0.045, -elevLen - 2, H * 0.035, 0.8, 0x000000, 0.25);
  });

  // ── Wings ──────────────────────────────────────────────────────────────────
  const w = spec.wing;
  bake(scene, k('wingNear'), bodyW, bodyH, ox, oy, p => {
    const q = wingQuad(w.rootX, w.y, w.chord, w.span, w.sweep, w.drop, w.span * NEAR_THROW);
    p.poly(q, pal.hull, 1);
    // Spanwise shading — the wing is lit along the leading edge and falls
    // into shadow toward the trailing edge
    p.poly([q[1], q[2], [q[2][0] + 3, q[2][1] - 3], [q[1][0] + 3, q[1][1] - 3]],
      mixHex(pal.hull, pal.hullShade, 0.65), 0.8);
    p.line(q[0][0], q[0][1], q[3][0], q[3][1], 1.8,
      mixHex(pal.hullLight, 0xffffff, 0.3), 0.85);                        // leading edge
    p.line(q[1][0], q[1][1], q[2][0], q[2][1], 1, 0x000000, 0.25);        // trailing edge
    // Rib stitching across the chord
    for (let r = 1; r < 6; r++) {
      const t = r / 6;
      const xa = q[0][0] + (q[3][0] - q[0][0]) * t, ya = q[0][1] + (q[3][1] - q[0][1]) * t;
      const xb = q[1][0] + (q[2][0] - q[1][0]) * t, yb = q[1][1] + (q[2][1] - q[1][1]) * t;
      p.line(xa, ya, xb, yb, 0.7, 0x000000, 0.16);
    }
    // Aileron hint near the tip
    const ax = (q[1][0] + q[2][0]) / 2, ay = (q[1][1] + q[2][1]) / 2;
    p.line(ax, ay, q[2][0], q[2][1], 0.8, 0x000000, 0.2);
    // Root fairing: the wing has to grow out of the fuselage, not sit on it
    p.ellipse(w.rootX, w.y + 1, w.chord * 0.82, 9, pal.hull, 1);
    p.ellipse(w.rootX, w.y - 1, w.chord * 0.7, 5, mixHex(pal.hull, pal.hullLight, 0.4), 0.7);
    p.line(w.rootX + w.chord * 0.42, w.y - 2, w.rootX - w.chord * 0.4, w.y + 1,
      1, mixHex(pal.hullShade, 0x000000, 0.4), 0.5);

    // Each engine is carried by the wing — draw the pylon that holds it there,
    // or the nacelles read as boxes floating alongside the fuselage.
    for (const e of spec.engines.filter(en => !en.far)) {
      if (Math.abs(e.y - w.y) < 4) continue;         // already on the wing line
      p.rect(e.x - 4, Math.min(e.y, w.y), 9, Math.abs(e.y - w.y) + 2,
        mixHex(pal.hull, pal.hullShade, 0.5), 1);
      p.line(e.x - 4, Math.min(e.y, w.y), e.x - 4, Math.max(e.y, w.y),
        1, mixHex(pal.hullShade, 0x000000, 0.5), 0.7);
    }
    // Wing weathering
    p.rect(w.rootX - w.chord * 0.1, w.y + w.drop * 0.4, 7, 4, pal.hullShade, 0.5);
  });

  bake(scene, k('wingFar'), bodyW, bodyH, ox, oy, p => {
    let fy = w.y - 3, fdrop = w.drop * 0.5, chord = w.chord;
    // A biplane's "far" wing is really its UPPER wing — a parallel plane above
    // the fuselage, so it takes the same downward camera throw as the lower one.
    let throwY = -w.span * FAR_THROW;
    if (w.layout === 'biplane') { fy = -H / 2 - 14; fdrop = -2; throwY = w.span * NEAR_THROW * 0.9; }
    else if (w.layout === 'high') { fy = w.y - 2; }
    const q = wingQuad(w.rootX - 6, fy, chord, w.span, w.sweep, fdrop, throwY);
    p.poly(q, pal.hullShade, 1);
    // Spanwise shading, ribs and a lit leading edge — without these the upper
    // wing of a biplane reads as a flat plank laid across the aeroplane.
    p.poly([q[1], q[2], [q[2][0] + 3, q[2][1] - 3], [q[1][0] + 3, q[1][1] - 3]],
      mixHex(pal.hullShade, 0x000000, 0.35), 0.7);
    p.line(q[0][0], q[0][1], q[3][0], q[3][1], 1.6, mixHex(pal.hullLight, 0xffffff, 0.25), 0.75);
    p.line(q[1][0], q[1][1], q[2][0], q[2][1], 0.9, 0x000000, 0.3);
    for (let r = 1; r < 6; r++) {
      const t = r / 6;
      const xa = q[0][0] + (q[3][0] - q[0][0]) * t, ya = q[0][1] + (q[3][1] - q[0][1]) * t;
      const xb = q[1][0] + (q[2][0] - q[1][0]) * t, yb = q[1][1] + (q[2][1] - q[1][1]) * t;
      p.line(xa, ya, xb, yb, 0.6, 0x000000, 0.20);
    }

    // Biplane: real interplane struts and crossed bracing wires between the
    // two wings, which is most of what makes a biplane read as a biplane.
    if (w.layout === 'biplane') {
      const upperY = fy + fdrop * 0.35;
      const lowerY = w.y + w.drop * 0.35;
      const s1 = w.rootX + w.chord * 0.30, s2 = w.rootX - w.chord * 0.34;
      p.line(s1, upperY, s1 + 2, lowerY, 2.0, pal.hullShade, 1);
      p.line(s2, upperY, s2 + 2, lowerY, 2.0, pal.hullShade, 1);
      p.line(s1 - 16, upperY + 3, s1 - 14, lowerY + 2, 1.7, pal.hullShade, 0.95);
      // Crossed flying wires
      p.line(s1, upperY, s2 + 2, lowerY, 0.7, pal.hullLight, 0.45);
      p.line(s2, upperY, s1 + 2, lowerY, 0.7, pal.hullLight, 0.45);
      // Cabane struts up to the fuselage centreline
      p.line(w.rootX + 6, upperY, w.rootX + 3, -H * 0.42, 1.6, pal.hullShade, 0.95);
      p.line(w.rootX - 8, upperY, w.rootX - 5, -H * 0.42, 1.6, pal.hullShade, 0.95);
    }
  });

  // ── Canopy / cockpit glazing ───────────────────────────────────────────────
  bake(scene, k('canopy'), bodyW, bodyH, ox, oy, p => {
    const c = spec.canopy;
    if (c.style === 'bubble') {
      // Glass
      p.poly([
        [c.x, -H / 2 + 1],
        [c.x + c.w * 0.25, -H / 2 - 9],
        [c.x + c.w * 0.7, -H / 2 - 9],
        [c.x + c.w, -H / 2 + 1],
      ], pal.canopy, 1);
      // Somebody is actually flying this thing — head and shoulders inside
      const px = c.x + c.w * 0.46, py = -H / 2 - 1.5;
      p.ellipse(px - 3, py + 3.5, 11, 6, 0x2b2118, 0.95);        // shoulders
      p.circle(px + 1.5, py - 1, 3.1, 0x6b4a33, 1);              // head
      p.circle(px + 2.4, py - 1.8, 3.0, 0x241c14, 0.85);         // flight cap
      p.rrect(px + 2.6, py - 2.2, 3.2, 1.6, 0.8, 0x8fb0bd, 0.9); // goggles
      // Glass tint over the occupant, then frame and glare
      p.poly([
        [c.x, -H / 2 + 1],
        [c.x + c.w * 0.25, -H / 2 - 9],
        [c.x + c.w * 0.7, -H / 2 - 9],
        [c.x + c.w, -H / 2 + 1],
      ], pal.canopy, 0.4);
      p.line(c.x + c.w * 0.25, -H / 2 - 9, c.x + c.w * 0.32, -H / 2 + 1, 1, pal.metal, 0.8);
      p.line(c.x + c.w * 0.7, -H / 2 - 9, c.x + c.w * 0.78, -H / 2 + 1, 1, pal.metal, 0.6);
      p.line(c.x + c.w * 0.28, -H / 2 - 6.8, c.x + c.w * 0.55, -H / 2 - 4.2, 1.6, pal.canopyGlint, 0.75);
      p.line(c.x + c.w * 0.3, -H / 2 - 4.4, c.x + c.w * 0.44, -H / 2 - 3.2, 1, pal.canopyGlint, 0.4);
    } else {
      // The flight deck is SEATED ON THE NOSE, at stations taken from the
      // fuselage profile. Authored x + w put the windscreen — and the crew
      // silhouette inside it — several pixels out in front of the nose tip on
      // the long aircraft, drawing a floating brown wedge ahead of the radome.
      const skinTop = (u: number): number => camber(u) - halfH(u);
      const uF = 0.905, uA = 0.775;
      const xF = -L / 2 + uF * L, xA = -L / 2 + uA * L;
      const yF = skinTop(uF), yA = skinTop(uA);

      // Raised flight-deck roof: the crown steps up over the cockpit
      p.poly([
        [xA - 6, yA + 1], [xA + 4, yA - H * 0.10],
        [xF - 2, yF - H * 0.05], [xF + 2, yF + 2],
      ], mixHex(pal.hull, pal.hullLight, 0.25), 1);
      p.line(xA + 4, yA - H * 0.10, xF - 2, yF - H * 0.05, 1.2,
        mixHex(pal.hullLight, 0xffffff, 0.3), 0.5);

      // Slanted windscreen down the front of it
      p.poly([
        [xA + 3, yA - H * 0.08], [xF - 3, yF - H * 0.03],
        [xF - 1, yF + H * 0.16], [xA + 1, yA + H * 0.12],
      ], pal.canopy, 1);
      p.line(xA + 5, yA - H * 0.04, xF - 4, yF + H * 0.03, 1.2, pal.canopyGlint, 0.6);
      // Centre post between the two windscreen panels
      const mx = (xA + xF) / 2, my = (yA + yF) / 2;
      p.line(mx, my - H * 0.05, mx + 1, my + H * 0.14, 0.9, pal.metal, 0.7);
      // Crew silhouette behind the glass
      p.ellipse(xA + 8, yA + H * 0.14, 7, 5, 0x2b2118, 0.9);
      p.circle(xA + 9.5, yA + H * 0.04, 2.4, 0x6b4a33, 0.95);
      // Side window in the cockpit door
      p.rrect(xA - 7, yA + H * 0.10, 6, 5, 1.5, pal.canopy, 1);

      // …then a strip of square cabin windows running aft along the shoulder
      const strip = xA - 10 - c.x;
      const n = Math.max(0, Math.floor(strip / 11));
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
    const turbine = spec.engineStyle === 'turboprop';
    // A nacelle is painted in the airframe's colours, not left bare — drawn in
    // raw `metal` it read as a white crate bolted to the side of the aircraft.
    const skin = mixHex(pal.hull, pal.metal, 0.4);

    if (turbine) {
      // A turboprop nacelle is a long slim tube that tapers to a small intake
      // and runs back into a fairing over the wing — nothing like a radial's
      // fat cowl, and drawing it as one made every modern aircraft in the
      // fleet read as a 1940s bomber.
      p.poly([
        [-cl / 2, -ch * 0.30], [cl * 0.18, -ch / 2], [cl / 2 - 2, -ch * 0.34],
        [cl / 2 - 2, ch * 0.34], [cl * 0.18, ch / 2], [-cl / 2, ch * 0.34],
      ], skin, 1);
    } else {
      p.rrect(-cl / 2, -ch / 2, cl, ch, ch * 0.35, skin, 1);
    }

    // Wrapped shading to match the fuselage
    for (let i = 0; i < 5; i++) {
      const t0 = i / 5, y0 = -ch / 2 + ch * t0;
      const sh = Math.cos((t0 - 0.28) * Math.PI);
      const col = sh > 0 ? mixHex(skin, pal.hullLight, sh * 0.55)
                         : mixHex(skin, 0x000000, Math.min(1, -sh * 0.5));
      const inset = turbine ? ch * 0.16 * Math.abs(t0 - 0.5) * 2 : 0;
      p.rect(-cl / 2 + 0.5, y0 + inset, cl - 1, ch / 5 + 0.5 - inset, col, 0.9);
    }

    if (turbine) {
      // Chin oil-cooler intake and the exhaust stub that vents over the wing
      p.rrect(cl * 0.10, ch * 0.10, cl * 0.26, ch * 0.34, 2, mixHex(skin, 0x000000, 0.5), 0.95);
      p.rrect(cl * 0.12, ch * 0.14, cl * 0.20, ch * 0.20, 1.5, 0x14120d, 0.85);
      p.rrect(-cl * 0.30, -ch * 0.10, cl * 0.20, ch * 0.24, 2, mixHex(skin, 0x000000, 0.35), 1);
      p.rrect(-cl * 0.36, -ch * 0.06, cl * 0.09, ch * 0.16, 1.2, 0x0d0b08, 1);
      // Access-panel seams down the length
      for (let i = 1; i < 4; i++) {
        const x = -cl / 2 + (cl * i) / 4;
        p.line(x, -ch * 0.30, x, ch * 0.30, 0.7, 0x000000, 0.22);
      }
      p.rrect(-cl / 2 + 2, -ch * 0.40, cl - 6, 2.2, 1.1, pal.hullLight, 0.5);
      // Small annular intake, then a long pointed spinner
      p.strokeEllipse(cl / 2 - 2, 0, ch * 0.34, ch * 0.42, 1.4, 0x191610, 0.9);
      p.ellipse(cl / 2 - 2, 0, ch * 0.20, ch * 0.28, 0x14120d, 0.8);
      p.tri(cl / 2 - 2, -3.4, cl / 2 + 12, 0, cl / 2 - 2, 3.4, mixHex(pal.accent, 0x000000, 0.3), 1);
      p.tri(cl / 2 - 2, -3.4, cl / 2 + 12, 0, cl / 2 - 2, -0.3, mixHex(pal.accent, 0xffffff, 0.5), 1);
      p.line(cl / 2 - 1, -2.2, cl / 2 + 9, -0.5, 0.9, 0xffffff, 0.55);
    } else {
      // Radial cylinder heads poking out of the cowl
      for (let i = 0; i < 4; i++) {
        const cy = -ch / 2 + 3 + i * (ch - 6) / 3;
        p.rrect(cl * 0.12, cy - 1.4, cl * 0.3, 2.8, 1.2, mixHex(skin, 0x000000, 0.45), 0.9);
      }
      p.rrect(-cl / 2 + 1, -ch / 2 + 1, cl - 2, 2.5, 1.2, pal.hullLight, 0.55);
      // Cooling gills
      for (let i = 0; i < 3; i++) p.line(-cl * 0.1 + i * 4, -ch * 0.3, -cl * 0.1 + i * 4, ch * 0.3, 0.8, 0x000000, 0.25);
      // Cowl mouth: a slim ring, not a big black disc (that read as a blob
      // sitting behind the propeller)
      p.strokeEllipse(cl / 2 - 1, 0, ch * 0.52, ch * 0.62, 1.6, 0x191610, 0.9);
      p.ellipse(cl / 2 - 1, 0, ch * 0.34, ch * 0.44, 0x14120d, 0.75);
      // Spinner: a narrow nose cone, lit from above
      p.tri(cl / 2 - 1, -3.0, cl / 2 + 7, 0, cl / 2 - 1, 3.0, mixHex(pal.accent, 0x000000, 0.3), 1);
      p.tri(cl / 2 - 1, -3.0, cl / 2 + 7, 0, cl / 2 - 1, -0.3, mixHex(pal.accent, 0xffffff, 0.5), 1);
      p.line(cl / 2, -1.8, cl / 2 + 5, -0.5, 0.9, 0xffffff, 0.55);
      // Exhaust stack with a heat-stained mouth
      p.rrect(-cl * 0.30, ch * 0.40, 6.5, 3, 1.2, 0x2a231a, 1);
      p.rrect(-cl * 0.34, ch * 0.42, 2.6, 2.4, 1, 0x0d0b08, 1);
      p.rrect(-cl * 0.12, ch * 0.40, 5, 2.6, 1, 0x241e16, 1);
    }
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
    const R = gr.wheelR;
    p.circle(0, 0, R, 0x1d1b18, 1);                                  // tyre
    // Tread blocks around the circumference — these are what actually read as
    // rotation once the wheel is turning
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      p.line(c * R * 0.82, s * R * 0.82, c * (R - 0.4), s * (R - 0.4), 1.5, 0x35312b, 0.95);
    }
    p.strokeEllipse(0, 0, R * 2 - 1.4, R * 2 - 1.4, 0.8, 0x3c382f, 1);
    // Hub with spokes
    p.circle(0, 0, R * 0.52, mixHex(pal.metal, 0x000000, 0.25), 1);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      p.line(0, 0, Math.cos(a) * R * 0.48, Math.sin(a) * R * 0.48, 1.3, mixHex(pal.metal, 0xffffff, 0.35), 0.95);
    }
    p.circle(0, 0, R * 0.2, 0x14120e, 1);                            // axle
    p.circle(-R * 0.14, -R * 0.14, R * 0.08, 0xffffff, 0.35);        // hub glint
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
    elevator: k('elevator'),
    flap: k('flap'),
    bodyW,
    bodyH,
  };
}
