import Phaser from 'phaser';

/**
 * Other people are still flying out here.
 *
 * Traffic is deliberately sparse — a handful of encounters across a route, not
 * a stream — because the point of it is the decision it forces, not the
 * scenery. Two thirds of it is co-directional: a slower hauler plodding along
 * your track that you close on over several seconds and have to step over or
 * under. The rest is head-on and fast, and for those the advisory is the
 * warning, exactly like the real instrument: you get relative altitude and a
 * direction to go, and you act on it before you ever see them.
 *
 * A midair takes both aircraft down. Theirs rolls inverted and spirals in
 * trailing fire; yours loses most of its airframe and its engine with it.
 *
 * Everything here is positioned with the SAME altitude→pixel mapping the
 * player's aircraft uses (`groundScreenY - alt * pxPerM`), so what you see is
 * exactly what you collide with at every altitude, in both camera bands.
 */

export type TrafficKind = 'hauler' | 'courier' | 'ultralight' | 'gunship';

export interface TrafficPlane {
  wx: number;        // world px
  alt: number;       // metres
  vx: number;        // world px/s, signed
  vAlt: number;      // m/s
  kind: TrafficKind;
  seed: number;
  dir: 1 | -1;       // which way the nose points
  bank: number;      // radians, visual only
  /** Seconds since the midair, or null while it is flying normally. */
  doom: number | null;
  /** Smoke/fire trail left behind once it is going down. */
  trail: Array<{ wx: number; alt: number; age: number }>;
  warned: boolean;
}

interface Wreck { wx: number; age: number; }

/** Collision box, matched to the drawn silhouette. */
const HALF_W_PX = 52;
const HALF_ALT_M = 5.2;

/** Conflict alerting: how far ahead in time we call traffic out. */
const ADVISORY_SECONDS = 9;
const ADVISORY_ALT_M = 26;

const MAX_CONCURRENT = 2;

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export interface TrafficAdvisory {
  /** Their altitude minus yours, metres. Negative = they are below you. */
  dAltM: number;
  /** Seconds until closest approach. */
  seconds: number;
  /** +1 = climb to clear, -1 = descend to clear. */
  avoid: 1 | -1;
}

export class AirTraffic {
  private list: TrafficPlane[] = [];
  private wrecks: Wreck[] = [];
  private cooldown = 16;
  private seed = 1;
  private elapsed = 0;

  reset(seed: number): void {
    this.list = [];
    this.wrecks = [];
    this.seed = seed;
    this.cooldown = 14 + rnd(seed) * 14;
    this.elapsed = 0;
  }

  get planes(): readonly TrafficPlane[] { return this.list; }

  /** Bring the next encounter forward — DEV testing hook. */
  provoke(): void { this.cooldown = 0; }

  // ── Simulation ────────────────────────────────────────────────────────────

  update(
    dt: number,
    ctx: {
      planeWorldX: number;
      planeAlt: number;
      planeSpeedPx: number;   // player's ground speed in world px/s
      airborne: boolean;
      routeEndPx: number;
    },
  ): void {
    this.elapsed += dt;

    for (const p of this.list) {
      if (p.doom === null) {
        p.wx += p.vx * dt;
        p.alt = Math.max(0, p.alt + p.vAlt * dt);
        // A lazy wander so they never look like they are on rails
        p.bank = Math.sin(this.elapsed * 0.6 + p.seed) * 0.05;
        p.vAlt += (Math.sin(this.elapsed * 0.31 + p.seed * 2) * 0.5 - p.vAlt) * dt * 0.5;
      } else {
        // Going down: roll off, nose drops, speed bleeds into the descent
        p.doom += dt;
        p.bank += dt * (2.6 + p.doom * 1.5);
        p.vx *= Math.exp(-dt * 0.55);
        p.vAlt -= 17 * dt;
        p.alt += p.vAlt * dt;
        p.wx += p.vx * dt;
        // Lay down the burning trail
        const last = p.trail[p.trail.length - 1];
        if (!last || Math.abs(last.wx - p.wx) > 26) p.trail.push({ wx: p.wx, alt: p.alt, age: 0 });
        if (p.alt <= 0) {
          p.alt = 0;
          this.wrecks.push({ wx: p.wx, age: 0 });
        }
      }
      for (const s of p.trail) s.age += dt;
      while (p.trail.length > 46) p.trail.shift();
    }

    // Retire: off the back of the world, or burned out on the ground
    this.list = this.list.filter(p => {
      if (p.doom !== null && p.alt <= 0 && p.doom > 3.5) return false;
      return Math.abs(p.wx - ctx.planeWorldX) < 14000;
    });
    for (const w of this.wrecks) w.age += dt;
    this.wrecks = this.wrecks.filter(w => w.age < 14 && Math.abs(w.wx - ctx.planeWorldX) < 6000);

    // ── Spawning ──────────────────────────────────────────────────────────
    if (!ctx.airborne || ctx.planeAlt < 22) return;
    // Nothing new joins the party once you are on the approach — a traffic
    // conflict thrown at you while you are configured to land is not a
    // decision, it is an ambush.
    if (ctx.routeEndPx - ctx.planeWorldX < 3000) return;
    this.cooldown -= dt;
    if (this.cooldown > 0 || this.list.length >= MAX_CONCURRENT) return;
    this.cooldown = 26 + rnd(this.seed + this.elapsed * 0.37) * 34;
    this.spawn(ctx);
  }

  private spawn(ctx: { planeWorldX: number; planeAlt: number; planeSpeedPx: number; routeEndPx: number }): void {
    const id = this.seed * 7919 + Math.floor(this.elapsed * 13);
    const r = rnd(id);
    const headOn = r < 0.4;
    const kindRoll = rnd(id + 5);
    const kind: TrafficKind =
      kindRoll < 0.44 ? 'hauler' : kindRoll < 0.72 ? 'courier' : kindRoll < 0.9 ? 'ultralight' : 'gunship';

    // Most encounters are set up to conflict — that is the whole point of them —
    // but a clear pass now and then keeps the advisory meaningful.
    const conflicting = rnd(id + 11) < 0.68;
    const offset = conflicting
      ? (rnd(id + 13) - 0.5) * 9
      : (rnd(id + 13) > 0.5 ? 1 : -1) * (32 + rnd(id + 17) * 40);
    const alt = Math.max(14, ctx.planeAlt + offset);

    let wx: number, vx: number, dir: 1 | -1;
    if (headOn) {
      // Well beyond the screen, so the advisory lands before they are visible
      wx = ctx.planeWorldX + 5200 + rnd(id + 19) * 2600;
      vx = -(300 + rnd(id + 23) * 230);
      dir = -1;
    } else {
      // Same direction, slower: you run them down over several seconds
      const slower = Phaser.Math.Clamp(ctx.planeSpeedPx * (0.55 + rnd(id + 29) * 0.28), 140, 420);
      wx = ctx.planeWorldX + 2600 + rnd(id + 31) * 2200;
      vx = slower;
      dir = 1;
    }

    this.list.push({
      wx, alt, vx, vAlt: (rnd(id + 37) - 0.5) * 0.7,
      kind, seed: id, dir, bank: 0, doom: null, trail: [], warned: false,
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** The aircraft we are currently occupying the same air as, if any. */
  collision(planeWorldX: number, planeAlt: number): TrafficPlane | null {
    for (const p of this.list) {
      if (p.doom !== null) continue;
      if (Math.abs(p.wx - planeWorldX) <= HALF_W_PX && Math.abs(p.alt - planeAlt) <= HALF_ALT_M) return p;
    }
    return null;
  }

  /** Closest conflicting traffic, for the HUD advisory. */
  advisory(planeWorldX: number, planeAlt: number, planeSpeedPx: number): TrafficAdvisory | null {
    let best: TrafficAdvisory | null = null;
    for (const p of this.list) {
      if (p.doom !== null) continue;
      const dx = p.wx - planeWorldX;
      const closure = planeSpeedPx - p.vx;     // px/s we are eating the gap at
      if (closure <= 20 || dx <= 0) continue;
      const seconds = dx / closure;
      if (seconds > ADVISORY_SECONDS) continue;
      const dAlt = p.alt - planeAlt;
      if (Math.abs(dAlt) > ADVISORY_ALT_M) continue;
      if (best && best.seconds < seconds) continue;
      best = { dAltM: dAlt, seconds, avoid: dAlt >= 0 ? -1 : 1 };
    }
    return best;
  }

  /** Knock one out of the sky — used when we hit it. */
  doom(p: TrafficPlane): void {
    if (p.doom !== null) return;
    p.doom = 0;
    p.vAlt = -6;
    p.trail.push({ wx: p.wx, alt: p.alt, age: 0 });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  draw(
    g: Phaser.GameObjects.Graphics,
    scrollX: number,
    groundScreenY: number,
    pxPerM: number,
    width: number,
    t: number,
    dl: number,
  ): void {
    // Burning wrecks on the ground, where they came down
    for (const w of this.wrecks) {
      const sx = w.wx - scrollX;
      if (sx < -140 || sx > width + 140 || groundScreenY > 3000) continue;
      const fade = Phaser.Math.Clamp(1 - w.age / 14, 0, 1);
      g.fillStyle(0x0d0a07, 0.85 * fade);
      g.fillEllipse(sx, groundScreenY - 2, 62, 11);
      const fl = 0.55 + Math.sin(t * 8 + w.wx) * 0.45;
      g.fillStyle(0xff6a20, 0.5 * fade * fl);
      g.fillEllipse(sx, groundScreenY - 8, 34, 20);
      g.fillStyle(0xffc250, 0.6 * fade * fl);
      g.fillEllipse(sx, groundScreenY - 11, 16, 13);
      for (let k = 0; k < 6; k++) {
        const yy = groundScreenY - 18 - k * 13 - (w.age * 12) % 13;
        g.fillStyle(0x16120d, 0.34 * fade * (1 - k / 7));
        g.fillEllipse(sx + Math.sin(t * 0.7 + k) * (3 + k * 3), yy, 16 + k * 8, 11 + k * 5);
      }
    }

    for (const p of this.list) {
      // Burning trail first, so the aircraft sits on top of its own smoke
      for (const s of p.trail) {
        const sx = s.wx - scrollX;
        if (sx < -120 || sx > width + 120) continue;
        const sy = groundScreenY - s.alt * pxPerM;
        const a = Phaser.Math.Clamp(1 - s.age / 3.2, 0, 1);
        g.fillStyle(0x181410, 0.4 * a);
        g.fillEllipse(sx, sy, 12 + s.age * 22, 9 + s.age * 16);
        if (s.age < 0.5) {
          g.fillStyle(0xff8a30, 0.5 * (1 - s.age / 0.5));
          g.fillEllipse(sx, sy, 9, 7);
        }
      }

      const sx = p.wx - scrollX;
      if (sx < -160 || sx > width + 160) continue;
      const sy = groundScreenY - p.alt * pxPerM;
      if (sy < -140 || sy > 4000) continue;
      this.drawPlane(g, sx, sy, p, t, dl);
    }
  }

  /** One aircraft, drawn in its own local frame then banked into place. */
  private drawPlane(
    g: Phaser.GameObjects.Graphics,
    cx: number, cy: number,
    p: TrafficPlane,
    t: number,
    dl: number,
  ): void {
    const kind = p.kind;
    // Traffic shares the player's altitude plane, so it has to share the
    // player's SCALE. It was drawn at roughly half size — measured against the
    // smallest aircraft in the fleet, a courier came out 55% of a crop duster
    // and half a military transport — which is what made other aeroplanes read
    // as toys hanging in the sky rather than something you might hit.
    const s = kind === 'ultralight' ? 1.35 : kind === 'courier' ? 1.85 : kind === 'gunship' ? 2.05 : 2.0;
    const dir = p.dir;
    // Going down: the nose drops as it spirals
    const pitch = p.doom === null ? 0 : Phaser.Math.Clamp(-p.doom * 0.35, -1.0, 0);
    const rot = p.bank * 0.35 + pitch * dir;
    const c = Math.cos(rot), sn = Math.sin(rot);
    // The roll shows as the airframe squashing through the vertical
    const squash = p.doom === null ? 1 : Math.abs(Math.cos(p.bank)) * 0.75 + 0.25;

    const P = (lx: number, ly: number): { x: number; y: number } => {
      const rx = lx * dir * s;
      const ry = ly * s * squash;
      return { x: cx + rx * c - ry * sn, y: cy + rx * sn + ry * c };
    };
    // An aircraft a few hundred metres out is mostly silhouette, so every
    // major surface gets a dark outline stroke before it is filled. Without
    // it the shapes merge into one grey smudge and you cannot tell a wing
    // from a tailplane — or, when it matters, which way the thing is pointing.
    const OUTLINE = 0x0b0d09;
    const poly = (pts: Array<[number, number]>, col: number, a = 1, edge = 2.2): void => {
      const q = pts.map(([lx, ly]) => P(lx, ly));
      if (edge > 0) { g.lineStyle(edge, OUTLINE, 0.92); g.strokePoints(q, true); }
      g.fillStyle(col, a);
      g.fillPoints(q, true);
    };
    const line = (x0: number, y0: number, x1: number, y1: number, w: number, col: number, a = 1): void => {
      const A = P(x0, y0), B = P(x1, y1);
      g.lineStyle(w, col, a);
      g.lineBetween(A.x, A.y, B.x, B.y);
    };

    // Palettes: everything out here is faded, patched and sun-bleached
    const pal = kind === 'gunship'
      ? { hull: 0x3c4433, hi: 0x59634a, dark: 0x1a1e16, trim: 0x7a5420 }
      : kind === 'courier'
        ? { hull: 0x6a6152, hi: 0x8d8270, dark: 0x2a261e, trim: 0xa8641e }
        : kind === 'ultralight'
          ? { hull: 0x6e5b3a, hi: 0x8f7749, dark: 0x2e2718, trim: 0x9c3c18 }
          : { hull: 0x585d4e, hi: 0x787f68, dark: 0x22241e, trim: 0x9a6c22 };

    if (kind === 'ultralight') {
      // Exposed tube frame, fabric wing over the top, pusher prop behind
      line(-26, -2, 16, 2, 2.4, OUTLINE);
      line(-26, -2, -8, -14, 2.0, OUTLINE);
      poly([[-30, -4], [-38, -16], [-29, -15], [-25, -4]], pal.hull);       // fin
      poly([[-24, -4], [-40, -7], [-40, -4], [-24, -1]], pal.dark);         // tailplane
      poly([[-20, -16], [16, -18], [20, -13.5], [-18, -11.5]], pal.hull);   // wing
      poly([[-18, -16], [14, -17.6], [15, -15.6], [-17, -14]], pal.hi, 0.6, 0); // sunlit top
      poly([[-5, -11], [11, -11], [13, -1], [-7, -1]], pal.dark);           // pod
      poly([[-2, -9.5], [9, -9.5], [10, -4], [-2, -4]], 0x9ec0cc, 0.5, 0);  // screen
      for (const wx of [-3, 9]) {
        line(wx, 0, wx - 1, 5, 1.6, pal.dark);
        const w = P(wx - 1, 6.5); g.fillStyle(0x0e0c08, 1); g.fillCircle(w.x, w.y, 2.4 * s);
      }
      this.prop(g, P(-11, -6), t, p.seed, 11 * s, p.doom === null);
    } else {
      const long = kind === 'courier' ? 1 : 1.1;
      const L = (v: number): number => v * long;

      // High wing on the haulers, low wing on the courier — the single
      // clearest cue for telling one silhouette from another at distance.
      const high = kind !== 'courier';
      const wy = high ? -9.5 : 4.5;
      const wDrop = high ? -5 : 5;

      // ── Far side, dimmed: one cheap move that gives the airframe depth ──
      poly([[L(-24), -3], [L(-38), -7], [L(-38), -4.2], [L(-24), 0]], pal.dark, 0.7, 1.4);
      poly([[L(6), wy], [L(-16), wy + wDrop], [L(-24), wy + wDrop * 0.6], [L(-2), wy + 1.8]],
        pal.dark, 0.7, 1.4);

      // ── Fin: tall and clearly its own shape ─────────────────────────────
      // Fin height is ~1.2× the fuselage depth, as on a real transport. At 22
      // units against a 13.6-unit body it was half again taller than anything
      // that flies, and that single proportion is most of the "weird".
      poly([[L(-26), -6], [L(-34), -21], [L(-24.5), -20.4], [L(-18), -6]], pal.hull);
      poly([[L(-34), -21], [L(-29), -20.6], [L(-27.5), -12], [L(-32.5), -12]], pal.trim, 0.9, 0);

      // ── Fuselage ────────────────────────────────────────────────────────
      poly([
        [L(32), 0.5], [L(27), -5], [L(6), -7.8], [L(-18), -6.8], [L(-31), -3.6],
        [L(-33), 1.2], [L(-16), 5.8], [L(8), 5.8], [L(26), 3.8],
      ], pal.hull);
      // Sun-lit upper surface and belly shadow, no outline of their own
      poly([[L(26), -4.4], [L(6), -7.1], [L(-18), -6.1], [L(-30), -3.3], [L(-28), -1.4], [L(6), -4.6], [L(25), -2.4]],
        pal.hi, 0.6, 0);
      poly([[L(-16), 5.7], [L(8), 5.7], [L(25), 3.7], [L(24), 2.2], [L(7), 4.1], [L(-15), 4.1]], pal.dark, 0.85, 0);

      // ── Near tailplane, over the fuselage ───────────────────────────────
      poly([[L(-22), -2], [L(-39), -6.2], [L(-39), -3], [L(-22), 1.4]], pal.hull);

      // ── Cockpit ─────────────────────────────────────────────────────────
      poly([[L(26), -4.6], [L(14), -7], [L(13), -2.4], [L(25), -1.4]], 0x9ec0cc, 0.6, 1.2);
      poly([[L(24), -4.2], [L(18), -5.6], [L(18), -3.4], [L(24), -2.6]], 0xe4f0f6, 0.4, 0);

      // Cabin windows
      g.fillStyle(0x0d100b, 0.9);
      for (let i = 0; i < (kind === 'courier' ? 3 : 5); i++) {
        const w = P(L(6 - i * 6), -2.6);
        g.fillCircle(w.x, w.y, 1.35 * s);
      }

      // ── Near wing, clear of the fuselage so it reads as a wing ──────────
      if (high) {
        // Cabane struts tying the wing down to the cabin roof
        line(L(4), -7.4, L(3), wy + 1, 1.6, OUTLINE);
        line(L(-10), -7, L(-9), wy + wDrop * 0.6, 1.6, OUTLINE);
      }
      poly([[L(10), wy], [L(-13), wy + wDrop], [L(-25), wy + wDrop * 0.55], [L(-3), wy + 2.2]], pal.dark);
      poly([[L(10), wy], [L(-13), wy + wDrop], [L(-15), wy + wDrop - 1.3], [L(8), wy - 1.3]], pal.hi, 0.7, 0);
      // Fuselage stripe
      poly([[L(22), -1.2], [L(-29), -1.8], [L(-29), -0.2], [L(22), 0.4]], pal.trim, 0.6, 0);

      // ── Engines: nacelles hung on the wing, props clear of the leading edge
      if (kind === 'hauler' || kind === 'gunship') {
        for (const ex of [0, -13]) {
          const ny = wy - 1.5;
          poly([[L(ex + 14), ny], [L(ex + 2), ny - 1.6], [L(ex - 1), ny + 2.6], [L(ex + 13), ny + 3.8]], pal.dark);
          poly([[L(ex + 14), ny], [L(ex + 4), ny - 1.3], [L(ex + 4), ny], [L(ex + 14), ny + 1.2]], pal.hi, 0.55, 0);
          this.prop(g, P(L(ex + 15.5), ny + 1.6), t, p.seed + ex, 13 * s, p.doom === null);
        }
      } else {
        poly([[L(32), 0.5], [L(25), -5.4], [L(25), 4.4]], pal.dark);
        this.prop(g, P(L(33), -0.4), t, p.seed, 14 * s, p.doom === null);
      }

      // Gunships carry pylons and a chin gun
      if (kind === 'gunship') {
        line(L(-8), -7, L(-8), -14, 2.0, pal.dark);
        poly([[L(-3), -16], [L(-14), -16], [L(-14), -12.6], [L(-3), -12.6]], pal.dark, 1, 1.4);
        line(L(27), 3, L(35), 3, 2.0, 0x14120e);
      }

      // Fixed gear on the slow hauler; the others tuck theirs away
      if (kind === 'hauler') {
        for (const wx of [8, -6]) {
          line(wx, 5, wx - 1, 9, 1.6, OUTLINE);
          const w = P(wx - 1, 10.5);
          g.fillStyle(0x0e0c08, 1);
          g.fillCircle(w.x, w.y, 2.3 * s);
        }
      }
    }

    // ── Lights: a double-flash strobe and steady nav lamps ─────────────────
    if (p.doom === null) {
      const cycle = (t * 1.1 + p.seed) % 1;
      const strobe = cycle < 0.05 || (cycle > 0.11 && cycle < 0.16);
      if (strobe) {
        const f = P(-34, -26);
        g.fillStyle(0xffffff, 0.95); g.fillCircle(f.x, f.y, 1.9);
        g.fillStyle(0xffffff, 0.24); g.fillCircle(f.x, f.y, 7);
      }
      // Nav light on the WINGTIP, where one actually lives, and sized with the
      // airframe. Pinned at a fixed radius near the wing root it stayed put
      // while everything else doubled, and read as a green lamp bolted to the
      // fuselage. It is a point of light, not a feature of the aeroplane.
      const nav = P(-22, kind === 'courier' ? 7.5 : -13.5);
      const navCol = dir > 0 ? 0x30ff70 : 0xff3030;
      g.fillStyle(navCol, 0.85); g.fillCircle(nav.x, nav.y, 0.9 * s);
      g.fillStyle(navCol, 0.14 + (1 - dl) * 0.20); g.fillCircle(nav.x, nav.y, 2.6 * s);
    } else {
      // Engine fire licking back over the wing
      const fl = 0.6 + Math.sin(t * 17 + p.seed) * 0.4;
      const f = P(6, -8);
      g.fillStyle(0xff6a20, 0.7 * fl); g.fillEllipse(f.x, f.y, 22, 13);
      g.fillStyle(0xffd070, 0.85 * fl); g.fillEllipse(f.x, f.y, 10, 7);
    }

    // A thin exhaust smudge, kept tight — a wide one just fogs the silhouette
    if (p.doom === null && kind !== 'ultralight') {
      for (let k = 1; k <= 2; k++) {
        const e = P(-38 - k * 8, -1);
        g.fillStyle(0x24211b, 0.13 / k);
        g.fillEllipse(e.x, e.y, 10 + k * 5, 5 + k * 2);
      }
    }
  }

  /** Prop disc: a translucent arc with two blade smears turning inside it. */
  private prop(
    g: Phaser.GameObjects.Graphics,
    at: { x: number; y: number },
    t: number, seed: number, r: number, spinning: boolean,
  ): void {
    if (spinning) {
      // Kept faint: a bright disc at this size reads as a hole in the aeroplane
      g.fillStyle(0xb8c0c8, 0.085);
      g.fillEllipse(at.x, at.y, r * 0.5, r * 1.9);
      const a = t * 46 + seed;
      for (let b = 0; b < 2; b++) {
        const ang = a + b * Math.PI;
        g.lineStyle(1.1, 0xdfe6ec, 0.2);
        g.lineBetween(at.x, at.y, at.x + Math.cos(ang) * r * 0.26, at.y + Math.sin(ang) * r * 0.95);
      }
    } else {
      // Windmilling / stopped — you can see the blades
      const a = t * 2 + seed;
      for (let b = 0; b < 2; b++) {
        const ang = a + b * Math.PI;
        g.lineStyle(1.6, 0x1a1710, 0.9);
        g.lineBetween(at.x, at.y, at.x + Math.cos(ang) * r * 0.3, at.y + Math.sin(ang) * r);
      }
    }
  }
}
