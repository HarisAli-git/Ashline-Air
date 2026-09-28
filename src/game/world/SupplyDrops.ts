import Phaser from 'phaser';
import { drawFighter, type FighterPalette } from './Figures';

/**
 * Something to DO in the cruise.
 *
 * Every earlier attempt at fixing the empty middle of a flight added
 * CONSEQUENCE — a fuel projection that drifts, an engine that runs hot up
 * high — and none of it added ACTIVITY. Once you were clear of the guns there
 * was still nothing to press and nothing to aim at between the climb-out and
 * the approach.
 *
 * Survivors are scattered along every route. As you close on one they put up
 * a flare, and if you can put a crate on them it pays. Three things make it
 * worth doing rather than decoration:
 *
 *   1. It is optional. Fly past and nothing bad happens; you just did not help.
 *   2. It pulls AGAINST the safe altitude. A crate dropped from 300 m lands
 *      half a kilometre downrange and nowhere near anyone; to hit you have to
 *      come down to where the guns can reach you. "Climb and wait" finally has
 *      an opportunity cost.
 *   3. It is learnable. A reticle on the ground shows where a crate released
 *      RIGHT NOW would land, using exactly the same physics as the real drop,
 *      so a miss teaches you something instead of feeling like the dice.
 */

export type DropResult = 'bullseye' | 'good' | 'close' | 'miss';

export interface DropSite {
  /** Centre of the camp, world px. */
  x: number;
  seed: number;
  /** How many people are here — drives the drawing and the radio call. */
  people: number;
  state: 'waiting' | 'signalled' | 'served';
  /** Seconds since the flare went up; -1 before. */
  flareT: number;
  /** How it went, once served. */
  result: DropResult | null;
  /** Seconds since it was served, for the floating result marker. */
  resultT: number;
}

export interface Crate {
  wx: number;
  alt: number;
  vx: number;    // world px / s
  vAlt: number;  // m / s, up positive
  /** Sideways push from gusts, world px / s. Unknowable at release. */
  drift: number;
  spin: number;
  age: number;
  landed: boolean;
  /** Seconds since touchdown, for the dust puff. */
  landedT: number;
}

/** What happened this frame, for FlightScene to act on. */
export interface DropEvents {
  signalled: DropSite | null;
  landed: Array<{ site: DropSite | null; result: DropResult; distM: number }>;
}

const WORLD_PX_PER_M = 9;
const GRAVITY = 9.81;
/**
 * Horizontal drag on a falling crate, per second — a drogue chute.
 *
 * At 0.32 a crate carried 90-245 m downrange, which on a 1067 px canvas with
 * the aircraft at x=300 put the impact point OFF THE RIGHT EDGE of the screen:
 * you were releasing blind and never saw it land. With the drogue the crate
 * sheds its forward speed in a second or two and comes down within ~50 m,
 * on screen, where you can watch it arrive.
 */
const CRATE_DRAG = 1.5;
/**
 * Gust drift, m/s of sideways velocity per metre of drop height.
 *
 * This is the risk/reward. With the drogue, accuracy no longer depended on
 * height, so there was no reason to come down into gun range to drop. Wind is
 * stronger higher up (the flight model already says so), so a crate released
 * high gets pushed about by gusts the reticle cannot know — from 30 m it goes
 * where you aimed, from 300 m it goes roughly there.
 */
const DRIFT_BASE = 1.2;
const DRIFT_PER_M = 0.045;
/** Survivors put a flare up this far ahead of you. */
const SIGNAL_AHEAD_PX = 2600 * WORLD_PX_PER_M / 9;
/** Scoring rings, metres from the camp centre. */
const RING_BULLSEYE = 22;
const RING_GOOD = 55;
const RING_CLOSE = 110;

/** Survivors: patched civilian clothes, no weapons worth the name. */
const SURVIVOR_PALETTE: FighterPalette = {
  cloth: 0x4a3f2c, skin: 0x2a1f16, head: 0x5a4a34, accent: 0x8a6a3a, metal: 0x2a2418,
};

function rnd(i: number): number {
  const x = Math.sin(i * 91.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
}

export class SupplyDrops {
  sites: DropSite[] = [];
  crates: Crate[] = [];
  cratesLeft = 3;

  /**
   * One camp per ~7 km of route, clear of both airfields.
   *
   * Deterministic from the route seed like the rest of the route furniture,
   * so a leg you fly twice has the same people in the same places.
   */
  layout(routeEndPx: number, seed: number, crates: number): void {
    this.sites = [];
    this.crates = [];
    this.cratesLeft = crates;
    const PER = 7 * 1000 * WORLD_PX_PER_M;
    const n = Math.max(1, Math.round(routeEndPx / PER));
    const start = routeEndPx * 0.14, span = routeEndPx * 0.72;
    for (let i = 0; i < n; i++) {
      const slice = span / n;
      const x = start + slice * (i + 0.2 + rnd(seed * 13 + i) * 0.6);
      this.sites.push({
        x, seed: seed * 31 + i * 7,
        people: 2 + Math.floor(rnd(seed + i * 5) * 3),
        state: 'waiting', flareT: -1, result: null, resultT: 0,
      });
    }
  }

  /** The next camp you have not dealt with yet, ahead or just behind you. */
  activeSite(planeWorldX: number): DropSite | null {
    let best: DropSite | null = null;
    for (const s of this.sites) {
      if (s.state !== 'signalled') continue;
      // Still worth aiming at until it is well behind you
      if (s.x < planeWorldX - 1400) continue;
      if (!best || Math.abs(s.x - planeWorldX) < Math.abs(best.x - planeWorldX)) best = s;
    }
    return best;
  }

  /**
   * Put a crate out of the door.
   *
   * It leaves with the aircraft's ground speed and no vertical speed — which is
   * the whole trick of a supply drop, and why the reticle leads the aircraft.
   */
  release(planeWorldX: number, planeAlt: number, groundSpeedMs: number): boolean {
    if (this.cratesLeft <= 0 || planeAlt < 4) return false;
    this.cratesLeft--;
    // Box-Muller: a gust you cannot predict, larger the higher you let go
    const u = Math.max(1e-6, Math.random()), v = Math.random();
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const sigma = DRIFT_BASE + planeAlt * DRIFT_PER_M;
    this.crates.push({
      wx: planeWorldX, alt: planeAlt,
      vx: groundSpeedMs * WORLD_PX_PER_M, vAlt: 0,
      drift: gauss * sigma * WORLD_PX_PER_M,
      spin: (Math.random() - 0.5) * 6, age: 0, landed: false, landedT: 0,
    });
    return true;
  }

  /**
   * How far off the reticle a crate could plausibly land, metres (≈2σ).
   *
   * Drawn as the reticle's width, so height costs you visibly: low down the
   * ring is a tight mark on the camp, up high it is a wide faint smear that
   * honestly says "somewhere around here".
   */
  spreadM(planeAlt: number): number {
    const fall = Math.sqrt(2 * Math.max(0, planeAlt) / GRAVITY);
    return 2 * (DRIFT_BASE + planeAlt * DRIFT_PER_M) * fall;
  }

  /**
   * Where a crate released now would land, world px.
   *
   * Integrates the SAME step as update() rather than a closed-form guess, so
   * the reticle and the real crate can never disagree — a reticle that lies
   * would be worse than none.
   */
  predictImpactX(planeWorldX: number, planeAlt: number, groundSpeedMs: number): number {
    let x = planeWorldX, alt = planeAlt, vx = groundSpeedMs * WORLD_PX_PER_M, vAlt = 0;
    const dt = 1 / 30;
    for (let i = 0; i < 900 && alt > 0; i++) {
      vAlt -= GRAVITY * dt;
      vx *= Math.exp(-CRATE_DRAG * dt);
      x += vx * dt;
      alt += vAlt * dt;
    }
    return x;
  }

  update(dt: number, planeWorldX: number, airborne: boolean): DropEvents {
    const ev: DropEvents = { signalled: null, landed: [] };

    for (const s of this.sites) {
      if (s.flareT >= 0) s.flareT += dt;
      if (s.state === 'served') s.resultT += dt;
      if (s.state === 'waiting' && airborne) {
        const ahead = s.x - planeWorldX;
        if (ahead > 0 && ahead < SIGNAL_AHEAD_PX) {
          s.state = 'signalled';
          s.flareT = 0;
          if (!ev.signalled) ev.signalled = s;
        }
      }
      // Flew clean past without dropping: they are left to wait for the next one
      if (s.state === 'signalled' && s.x < planeWorldX - 4200) {
        s.state = 'served';
        s.result = null;
      }
    }

    for (const c of this.crates) {
      c.age += dt;
      if (c.landed) { c.landedT += dt; continue; }
      c.vAlt -= GRAVITY * dt;
      c.vx *= Math.exp(-CRATE_DRAG * dt);
      c.wx += (c.vx + c.drift) * dt;
      c.alt += c.vAlt * dt;
      if (c.alt <= 0) {
        c.alt = 0;
        c.landed = true;
        ev.landed.push(this.score(c));
      }
    }
    // Keep the ground tidy: a landed crate lingers long enough to be seen
    this.crates = this.crates.filter(c => !c.landed || c.landedT < 9);
    return ev;
  }

  /** Nearest camp still waiting for something, and how close this crate got. */
  private score(c: Crate): { site: DropSite | null; result: DropResult; distM: number } {
    let site: DropSite | null = null;
    let best = Infinity;
    for (const s of this.sites) {
      if (s.state === 'served' && s.result !== null) continue;
      const d = Math.abs(s.x - c.wx) / WORLD_PX_PER_M;
      if (d < best) { best = d; site = s; }
    }
    const result: DropResult =
      best <= RING_BULLSEYE ? 'bullseye'
        : best <= RING_GOOD ? 'good'
          : best <= RING_CLOSE ? 'close' : 'miss';
    if (site && result !== 'miss') {
      site.state = 'served';
      site.result = result;
      site.resultT = 0;
    }
    return { site: result === 'miss' ? null : site, result, distM: best };
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  /** The camps themselves — on the ground layer, with the raiders. */
  drawCamps(
    g: Phaser.GameObjects.Graphics, scrollX: number, groundY: number,
    width: number, t: number, dl: number,
  ): void {
    for (const s of this.sites) {
      const sx = s.x - scrollX;
      if (sx < -160 || sx > width + 160) continue;

      /*
       * A signal panel laid out flat on the ground.
       *
       * This is how people on the ground actually attract an aircraft, and it
       * does two jobs: it makes the camp readable against dark earth (the
       * figures alone vanished into it), and it IS the bullseye — a crate on
       * the cloth is a crate on target.
       */
      const panel = s.state === 'served' ? 0x8a7a5a : 0xe8e0d0;
      g.fillStyle(0x000000, 0.25);
      g.fillEllipse(sx, groundY + 2, 52, 9);
      g.fillStyle(panel, s.state === 'served' ? 0.55 : 0.95);
      g.fillRect(sx - 22, groundY - 1, 44, 4);        // the long arm
      g.fillRect(sx - 4, groundY - 3, 8, 7);          // the crossing
      if (s.state === 'signalled') {
        g.fillStyle(0xff5a2a, 0.9);                   // orange strip across it
        g.fillRect(sx - 22, groundY + 0.5, 44, 1.2);
      }

      // A lean-to and a tarp, and the fire they have been keeping going
      g.fillStyle(0x2c241a, 1);
      g.beginPath();
      g.moveTo(sx - 34, groundY); g.lineTo(sx - 20, groundY - 17); g.lineTo(sx - 4, groundY);
      g.closePath(); g.fillPath();
      g.fillStyle(0x3a6a8a, 0.95);                    // a blue tarp — nothing else out here is blue
      g.fillRect(sx + 10, groundY - 11, 22, 11);
      g.fillStyle(0x1a140c, 1);
      g.fillRect(sx + 10, groundY - 12, 22, 2);
      const flick = 0.7 + Math.sin(t * 11 + s.seed) * 0.3;
      g.fillStyle(0xff8a2a, 0.55 * flick);
      g.fillCircle(sx - 2, groundY - 3, 4.5);
      g.fillStyle(0xffd070, 0.8 * flick);
      g.fillCircle(sx - 2, groundY - 3, 2);

      // The people. They wave once they have seen you and stop when served.
      const waving = s.state === 'signalled';
      for (let i = 0; i < s.people; i++) {
        const px = sx - 16 + i * 11;
        const hop = waving ? Math.abs(Math.sin(t * 5 + i * 1.7)) * 2.4 : 0;
        drawFighter(
          g, px, groundY - hop, t, s.seed + i * 3, 0.9,
          i % 2 ? 1 : -1, waving ? 'aimUp' : 'stand',
          waving ? -1.3 - Math.sin(t * 6 + i) * 0.5 : -1.2, dl, SURVIVOR_PALETTE,
        );
      }

      // A crate that landed on target, sitting in the middle of them
      if (s.result && s.result !== 'miss') {
        g.fillStyle(0x6a5430, 1);
        g.fillRect(sx - 5, groundY - 9, 11, 9);
        g.lineStyle(1, 0x2a2010, 0.9);
        g.strokeRect(sx - 5, groundY - 9, 11, 9);
      }
    }
  }

  /**
   * Flares, falling crates, and the reticle — above the world, with traffic.
   *
   * @param reticleX  predicted impact, world px, or null to hide it
   */
  drawAir(
    g: Phaser.GameObjects.Graphics, scrollX: number, groundY: number, pxPerM: number,
    width: number, t: number, reticleX: number | null, reticleOnTarget: boolean,
    reticleSpreadM = 10,
  ): void {
    // ── Flares: up fast, then hang and drift down under a smoke trail ──────
    for (const s of this.sites) {
      if (s.flareT < 0 || s.flareT > 14) continue;
      const sx = s.x - scrollX;
      if (sx < -80 || sx > width + 80) continue;
      const ft = s.flareT;
      const rise = Math.min(ft, 1.6);
      const altM = rise * 95 - Math.max(0, ft - 1.6) * 6;
      const fy = groundY - Math.max(0, altM) * pxPerM;
      const fx = sx + Math.sin(ft * 0.7 + s.seed) * 10;
      // Smoke column from the ground up to the flare
      for (let i = 0; i < 9; i++) {
        const k = i / 8;
        g.fillStyle(0xd8c8b8, 0.10 * (1 - k * 0.6));
        g.fillCircle(sx + (fx - sx) * k, groundY + (fy - groundY) * k, 3 + k * 5);
      }
      const pulse = 0.75 + Math.sin(t * 22 + s.seed) * 0.25;
      const fade = ft > 11 ? Math.max(0, 1 - (ft - 11) / 3) : 1;
      g.fillStyle(0xff4a1a, 0.20 * pulse * fade);
      g.fillCircle(fx, fy, 22);
      g.fillStyle(0xff6a2a, 0.45 * pulse * fade);
      g.fillCircle(fx, fy, 9);
      g.fillStyle(0xfff0d0, 0.98 * fade);
      g.fillCircle(fx, fy, 3.6);
    }

    // ── The reticle: where a crate released now would land ────────────────
    if (reticleX !== null) {
      const rx = reticleX - scrollX;
      if (rx > -40 && rx < width + 40) {
        const col = reticleOnTarget ? 0x9fe8b0 : 0xffd080;
        const pulse = 0.65 + Math.sin(t * 7) * 0.2;
        // The ring IS the uncertainty — wide and faint when you are too high.
        // Certainty is judged in METRES: the first version used pixel width, so
        // even a tight ±15 m drop from 35 m drew at 25% and could not be seen.
        const w = Math.max(30, reticleSpreadM * 2 * WORLD_PX_PER_M);
        const sure = Phaser.Math.Clamp(1 - (reticleSpreadM - 12) / 150, 0.25, 1);
        // Foreshortened hard: the ground recedes almost edge-on in this view,
        // and at 0.22 the ring stood up off the ground like a hoop.
        const h = Math.max(7, w * 0.075);
        g.fillStyle(col, 0.10 * sure);
        g.fillEllipse(rx, groundY - 1, w, h);
        g.lineStyle(2, col, pulse * sure);
        g.strokeEllipse(rx, groundY - 1, w, h);
        // A pin standing on the aim point — the thing you actually line up
        g.lineStyle(2.5, 0x000000, 0.5);
        g.lineBetween(rx, groundY - 26, rx, groundY - 4);
        g.lineStyle(2, col, 0.95);
        g.lineBetween(rx, groundY - 26, rx, groundY - 4);
        g.fillStyle(col, 1);
        g.fillTriangle(rx - 6, groundY - 30, rx + 6, groundY - 30, rx, groundY - 22);
        g.fillCircle(rx, groundY - 1, 3);
      }
    }

    // ── Crates in the air, and a puff where they come down ────────────────
    for (const c of this.crates) {
      const sx = c.wx - scrollX;
      if (sx < -60 || sx > width + 60) continue;
      const cy = groundY - c.alt * pxPerM;
      if (c.landed) {
        if (c.landedT < 1.2) {
          const k = c.landedT / 1.2;
          g.fillStyle(0xcab89a, 0.4 * (1 - k));
          g.fillEllipse(sx, groundY - 3, 14 + k * 34, 6 + k * 12);
        }
        g.fillStyle(0x6a5430, 1);
        g.fillRect(sx - 5, groundY - 9, 11, 9);
        continue;
      }
      // Tumbling box
      const a = c.age * c.spin;
      const co = Math.cos(a), si = Math.sin(a);
      const pts = [[-5, -4.5], [5, -4.5], [5, 4.5], [-5, 4.5]].map(([x, y]) => ({
        x: sx + x * co - y * si, y: cy + x * si + y * co,
      }));
      g.fillStyle(0x6a5430, 1);
      g.fillPoints(pts, true);
      g.lineStyle(1, 0x2a2010, 0.9);
      g.strokePoints(pts, true);
    }

    // ── A number over the camp, so the result reads without the toast ─────
    for (const s of this.sites) {
      if (!s.result || s.resultT > 2.6) continue;
      const sx = s.x - scrollX;
      if (sx < -80 || sx > width + 80) continue;
      const k = s.resultT / 2.6;
      const col = s.result === 'bullseye' ? 0x9fe8b0 : s.result === 'good' ? 0xffd080 : 0xc8b888;
      g.fillStyle(col, 1 - k);
      g.fillCircle(sx, groundY - 44 - k * 30, 4 - k * 2);
    }
  }
}

/** What each result is worth. Deliberately generous — this is the fun part. */
export const DROP_REWARD: Record<DropResult, { money: number; rep: number; line: string }> = {
  bullseye: { money: 950, rep: 3, line: 'Right on them' },
  good:     { money: 600, rep: 2, line: "They'll get it" },
  close:    { money: 250, rep: 1, line: 'A short walk for them' },
  miss:     { money: 0,   rep: 0, line: 'Missed — it went into the scrub' },
};

/** Crates carried, by hold size. A heavy can afford to miss a few. */
export function cratesFor(cargoKg: number): number {
  return Phaser.Math.Clamp(3 + Math.floor(cargoKg / 1500), 3, 6);
}
