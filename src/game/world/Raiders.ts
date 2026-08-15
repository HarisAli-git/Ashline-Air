import Phaser from 'phaser';
import { drawUndead, drawCorpse, undeadKindFor, type CrowdStyle } from './Crowds';
import { drawFighter, drawMuzzleFlash, RAIDER_PALETTE, type FighterPose } from './Figures';

/**
 * Rebel-held ground.
 *
 * The people shooting at you are not the dead — they are living militia who
 * have taken a stretch of the route and hold it, and they need to look like
 * it. Every hostile zone is laid out as an actual position: scrap walls,
 * sandbag nests, a gun truck, a wheeled autocannon, a lookout tower, tents
 * and burn barrels, with crews visibly manning each weapon. The barrels track
 * your aircraft in real time and the tracers leave the muzzles they are drawn
 * coming out of, rather than materialising near the plane.
 *
 * And they are not having a good day either: the dead press at the back wall
 * the whole time, the militia shoot down at them between passes, and the
 * bodies pile up where they fall. Flying over a raider camp should look like
 * flying over a fight that was already happening before you arrived.
 */

export type EmplacementKind = 'nest' | 'technical' | 'aa' | 'tower' | 'camp';

interface Emplacement {
  x: number;            // world px
  kind: EmplacementKind;
  seed: number;
  aim: number;          // barrel angle, radians (screen space, up = negative)
  flash: number;        // seconds of muzzle flash remaining
  recoil: number;       // 0–1, decays
  cool: number;         // seconds until this weapon can fire again
}

/**
 * What each weapon can actually do to you.
 *
 * The whole point of the spread is that "how high do I need to be?" has a
 * different answer over different ground. Small arms are a nuisance you clear
 * by not being on the deck; a heavy gun truck pushes you to a proper cruise
 * height; an AA battery reaches most of the way to the ceiling and makes you
 * choose between a long fuel-burning climb and taking real damage. Everything
 * you can see below you tells you which of those you are dealing with.
 */
export interface WeaponProfile {
  /** Nothing above this altitude (m) can be touched by this weapon. */
  ceilingM: number;
  /** Horizontal reach, world px. */
  rangePx: number;
  rounds: number;
  /**
   * Aiming error in radians at point-blank, scaled up with your height. This
   * is the ONLY thing that decides whether a round connects — there is no
   * separate hit roll. See the note on hit detection below.
   */
  spread: number;
  /** Integrity damage per round that actually strikes the airframe. */
  damage: number;
  /** Seconds between bursts. */
  cadence: number;
  /** Airbursting shells instead of tracer — the gun may be off-screen. */
  flak: boolean;
  /** Shown on the annunciator. */
  label: string;
}

/**
 * Fewer rounds, each of which matters.
 *
 * The old table threw three or four rounds per weapon per burst and then
 * decided damage with a private dice roll that had nothing to do with where
 * those rounds were drawn. The result was a sky full of tracer that you could
 * fly straight through without consequence, while damage arrived from rounds
 * that visibly missed. Now each weapon fires one or two aimed rounds and the
 * drawn round IS the hit test, so the volume of fire on screen is exactly the
 * volume of fire you have to avoid.
 */
export const WEAPONS: Record<EmplacementKind, WeaponProfile | null> = {
  // Rifles and a belt-fed over sandbags. Only dangerous down low.
  nest:      { ceilingM: 75,  rangePx: 1700, rounds: 2, spread: 0.030, damage: 3.0, cadence: 0.85, flak: false, label: 'SMALL ARMS' },
  // A marksman with height and time — one round, but it is aimed.
  tower:     { ceilingM: 110, rangePx: 2300, rounds: 1, spread: 0.018, damage: 6.0, cadence: 1.60, flak: false, label: 'MARKSMAN' },
  // Pintle-mounted heavy MG. Reaches a normal cruise height.
  technical: { ceilingM: 165, rangePx: 2500, rounds: 2, spread: 0.034, damage: 4.5, cadence: 1.10, flak: false, label: 'HEAVY MG' },
  // Wheeled twin autocannon with fused shells. This is the one you climb for.
  aa:        { ceilingM: 340, rangePx: 3200, rounds: 2, spread: 0.026, damage: 9.0, cadence: 1.60, flak: true,  label: 'AA BATTERY' },
  camp:      null,
};

/**
 * How many weapons may engage at once. Kept low deliberately: the complaint
 * was never that there was too little fire, it was that there was far too much
 * of it and none of it meant anything.
 */
const MAX_SIMULTANEOUS = 2;

/**
 * The aircraft's hit box for incoming rounds, in px — matched to the drawn
 * sprite (~90 px long, ~30 px tall) so what looks like a near miss is one.
 */
const HIT_HALF_W = 40;
const HIT_HALF_H = 13;

/** Weapons further out than this do not set the "climb above" bar. */
const COMMITTED_RANGE_PX = 2600;

/** Highest ceiling of anything that shoots — the "you are safe" altitude. */
export const MAX_ENGAGEMENT_M = Math.max(
  ...Object.values(WEAPONS).filter((w): w is WeaponProfile => w !== null).map(w => w.ceilingM),
);

/** What is currently able to reach the aircraft. */
export interface RaiderFireReport {
  /** True while at least one weapon has the aircraft inside its envelope. */
  engaged: boolean;
  /** The most dangerous thing shooting at you right now. */
  label: string | null;
  /** Climb above this and everything within horizontal range loses you. */
  clearAltitudeM: number;
  /** Bursts that went off this frame — for the sound engine. */
  shots: number;
  /** Integrity damage taken this frame. */
  damage: number;
  /** True if any round connected, so the camera can be kicked. */
  hit: boolean;
}

/** An AA shell that went off near the aircraft. */
interface Flak { wx: number; y: number; age: number; big: boolean; }

interface Tracer {
  wx: number;           // world px
  y: number;            // screen y
  vx: number;           // world px/s
  vy: number;           // screen px/s
  life: number;
  hot: number;          // starting life, for fade
  /** Integrity this round takes off if it strikes the airframe. */
  damage: number;
}

interface Spark { x: number; y: number; vx: number; vy: number; life: number; }

/** A round that went home — a bright flash on the skin where it struck. */
interface Impact { x: number; y: number; age: number; }

const TRACER_SPEED = 1500;   // world px/s along the line of fire
const MAX_TRACERS = 64;

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Barrel pivot, in local px relative to (emplacement screen x, ground y). */
function pivotOf(kind: EmplacementKind): { x: number; y: number; len: number } {
  switch (kind) {
    case 'nest':      return { x: 3,  y: -18, len: 14 };  // on top of the parapet
    case 'technical': return { x: 4,  y: -23, len: 17 };
    case 'aa':        return { x: 0,  y: -15, len: 23 };
    case 'tower':     return { x: 1,  y: -37, len: 13 };
    default:          return { x: 0,  y: -6,  len: 0 };
  }
}

export class Raiders {
  private list: Emplacement[] = [];
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];
  private impacts: Impact[] = [];
  /** Damage from rounds that struck since the last engage() — see update(). */
  private pendingDamage = 0;
  private pendingHits = 0;

  /**
   * Swept test of one round's step against the aircraft's box. Sampled along
   * the segment because a round covers ~25 px per frame and would otherwise
   * tunnel clean through a 26 px-tall aeroplane.
   */
  private strikes(
    x0: number, y0: number, x1: number, y1: number,
    target: { worldX: number; screenY: number },
  ): boolean {
    for (let i = 0; i <= 4; i++) {
      const k = i / 4;
      const dx = (x0 + (x1 - x0) * k - target.worldX) / HIT_HALF_W;
      const dy = (y0 + (y1 - y0) * k - target.screenY) / HIT_HALF_H;
      if (dx * dx + dy * dy <= 1) return true;
    }
    return false;
  }

  /** Lay out positions inside each hostile stretch. Deterministic per route. */
  layout(zones: ReadonlyArray<readonly [number, number]>, seed: number): void {
    this.list = [];
    this.tracers = [];
    this.sparks = [];
    this.impacts = [];
    this.pendingDamage = 0;
    this.pendingHits = 0;

    for (let z = 0; z < zones.length; z++) {
      const [a, b] = zones[z];
      const span = b - a;
      // Positions are sparser than they were: one every ~1100 px, 3–6 a zone.
      const n = Phaser.Math.Clamp(Math.round(span / 1100), 3, 6);

      // An AA battery is a real piece of ordnance, not standard kit. At most
      // ONE per zone and only in some zones — previously every middle
      // emplacement had a 22% chance of being one, so a typical zone fielded
      // two batteries whose 4.4 km reach overlapped the entire stretch. That
      // is what made it feel like AA was everywhere.
      const aaZone = rnd(seed * 53 + z * 17) < 0.45;
      const aaSlot = aaZone ? 1 + Math.floor(rnd(seed * 71 + z) * Math.max(1, n - 2)) : -1;

      for (let i = 0; i < n; i++) {
        const id = seed * 977 + z * 131 + i * 29;
        const r = rnd(id);
        // The camp furniture anchors each end; weapons fill the middle.
        let kind: EmplacementKind;
        if (i === 0 || i === n - 1) kind = 'camp';
        else if (i === aaSlot) kind = 'aa';
        else if (r < 0.45) kind = 'nest';
        else if (r < 0.78) kind = 'technical';
        else kind = 'tower';
        this.list.push({
          x: a + span * ((i + 0.5) / n) + (rnd(id + 3) - 0.5) * (span / n) * 0.5,
          kind, seed: id, aim: -1.2, flash: 0, recoil: 0, cool: rnd(id + 7) * 0.8,
        });
      }
    }
  }

  get emplacementCount(): number { return this.list.length; }

  // ── Simulation ────────────────────────────────────────────────────────────

  /**
   * Track the aircraft with every barrel in range and advance rounds already
   * in the air. `target` is null when the aircraft is out of reach.
   */
  update(
    dt: number,
    baseY: number,
    target: { worldX: number; screenY: number } | null,
  ): void {
    for (const e of this.list) {
      e.flash = Math.max(0, e.flash - dt);
      e.recoil = Math.max(0, e.recoil - dt * 6);
      if (e.kind === 'camp') continue;

      const p = pivotOf(e.kind);
      let want: number;
      if (target && Math.abs(target.worldX - e.x) < 2600) {
        // Lay the gun on the aircraft
        want = Math.atan2(target.screenY - (baseY + p.y), target.worldX - (e.x + p.x));
      } else {
        // Idle: rested at a shallow elevation, drifting
        want = -0.9 + Math.sin(rnd(e.seed) * 6.28) * 0.25;
      }
      // Traverse rate — heavy weapons swing slowly, which is why a fast pass
      // at low level is survivable and loitering is not.
      const rate = e.kind === 'aa' ? 2.2 : e.kind === 'technical' ? 3.4 : 4.4;
      let d = want - e.aim;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      e.aim += Phaser.Math.Clamp(d, -rate * dt, rate * dt);
    }

    // ── Rounds in flight, and whether they hit ────────────────────────────
    // The drawn round IS the hit test. Previously damage came from a private
    // dice roll at the moment of firing, so a wall of tracer could pass
    // straight through the aircraft for nothing while damage arrived from
    // rounds that visibly missed. Now flying through the stream hurts and
    // getting out of it works, because they are the same thing.
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      const px = tr.wx, py = tr.y;
      tr.wx += tr.vx * dt;
      tr.y += tr.vy * dt;
      tr.vy += 90 * dt;               // they do drop off at the top of the arc
      tr.life -= dt;

      if (target && this.strikes(px, py, tr.wx, tr.y, target)) {
        this.pendingDamage += tr.damage;
        this.pendingHits++;
        this.impacts.push({ x: target.worldX, y: target.screenY, age: 0 });
        for (let k = 0; k < 7; k++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 50 + Math.random() * 170;
          this.sparks.push({
            x: target.worldX, y: target.screenY,
            vx: Math.cos(a) * sp - 120, vy: Math.sin(a) * sp - 40,
            life: 0.2 + Math.random() * 0.25,
          });
        }
        this.tracers.splice(i, 1);
        continue;
      }
      if (tr.life <= 0) this.tracers.splice(i, 1);
    }
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      this.impacts[i].age += dt;
      if (this.impacts[i].age > 0.35) this.impacts.splice(i, 1);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 320 * dt;
      s.life -= dt;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }
  }

  /**
   * Everything that can currently reach the aircraft opens up on it, each
   * weapon on its own cadence and inside its own envelope.
   *
   * This is where "how high do I have to be?" gets answered: a weapon only
   * engages if the aircraft is inside BOTH its horizontal range and its
   * altitude ceiling, and its accuracy falls off across that ceiling — so the
   * last few metres of a climb genuinely buy you something.
   */
  engage(
    dt: number,
    baseY: number,
    target: { worldX: number; screenY: number; altM: number },
  ): RaiderFireReport {
    let engaged = false;
    let worst: WeaponProfile | null = null;
    let clearAlt = 0;
    let shots = 0;
    let damage = 0;
    let hit = false;

    // Only the nearest few weapons that can actually bear get to shoot; the
    // rest of the zone keeps tracking but holds fire.
    const inPlay: Array<{ e: Emplacement; w: WeaponProfile; d: number }> = [];
    for (const e of this.list) {
      const w = WEAPONS[e.kind];
      if (!w) continue;
      const d = Math.abs(e.x - target.worldX);
      if (d > w.rangePx) continue;

      // Weapons close enough to matter set the bar for how high is high
      // enough, whether or not they can touch you at your present height.
      if (d <= COMMITTED_RANGE_PX) clearAlt = Math.max(clearAlt, w.ceilingM);
      if (target.altM > w.ceilingM || target.altM < 2) continue;

      // Anything actually shooting at us counts too, however far out it is —
      // otherwise the panel can read "CLIMB 0 m" while a battery at 3 km is
      // putting shells through the wing.
      clearAlt = Math.max(clearAlt, w.ceilingM);
      engaged = true;
      if (!worst || w.ceilingM > worst.ceilingM) worst = w;
      inPlay.push({ e, w, d });
    }
    inPlay.sort((a, b) => a.d - b.d);

    for (const { e, w } of inPlay.slice(0, MAX_SIMULTANEOUS)) {
      e.cool -= dt;
      if (e.cool > 0) continue;
      e.cool = w.cadence * (0.75 + Math.random() * 0.5);

      // Height is the whole defence, and it works by spoiling their aim: on
      // the deck the rounds go where they are pointed, near the ceiling they
      // scatter. No hit roll — whether it connects is settled in update() by
      // where the round actually goes.
      const exposure = 1 - target.altM / w.ceilingM;
      const scatter = w.spread * (1 + (1 - exposure) * 3.2);
      shots++;
      this.fire(e, w, baseY, target, scatter);
    }

    // Damage banked by rounds that struck the airframe since the last call
    damage = this.pendingDamage;
    hit = this.pendingHits > 0;
    this.pendingDamage = 0;
    this.pendingHits = 0;

    return { engaged, label: worst?.label ?? null, clearAltitudeM: clearAlt, shots, damage, hit };
  }

  /** One weapon lets go a burst at the aircraft. */
  private fire(
    e: Emplacement,
    w: WeaponProfile,
    baseY: number,
    target: { worldX: number; screenY: number },
    scatter: number,
  ): void {
    const p = pivotOf(e.kind);
    const mx = e.x + p.x + Math.cos(e.aim) * p.len;
    const my = baseY + p.y + Math.sin(e.aim) * p.len;
    e.flash = 0.07;
    e.recoil = 1;

    for (let k = 0; k < w.rounds; k++) {
      const dxw = target.worldX - mx;
      const dys = target.screenY - my;
      const len = Math.max(1, Math.hypot(dxw, dys));
      // Aim error is all there is: some of these will pass through the
      // aircraft and some will not, and update() finds out which.
      const err = (Math.random() - 0.5) * 2 * scatter;
      const ca = Math.cos(err), sa = Math.sin(err);
      const ux = (dxw * ca - dys * sa) / len;
      const uy = (dxw * sa + dys * ca) / len;
      const tof = len / TRACER_SPEED;

      if (w.flak) {
        // Fused shells burst at the target's height rather than flying past.
        // At an AA ceiling the gun itself is usually below the bottom of the
        // frame, so the burst IS the thing you see — and it has to read on its
        // own, at any altitude.
        this.pendingFlak.push({
          wx: mx + ux * TRACER_SPEED * tof,
          y: my + uy * TRACER_SPEED * tof,
          in: tof, big: k === 0,
        });
      }

      this.tracers.push({
        wx: mx, y: my,
        vx: ux * TRACER_SPEED, vy: uy * TRACER_SPEED,
        life: tof * (1.35 + Math.random() * 0.5),
        hot: tof * 1.8,
        damage: w.damage,
      });
    }
    if (this.tracers.length > MAX_TRACERS) {
      this.tracers.splice(0, this.tracers.length - MAX_TRACERS);
    }
  }

  /**
   * The worst weapon in the next hostile stretch, so the aircraft can be told
   * to start climbing while there is still room to do it.
   */
  threatAhead(worldX: number, rangePx: number): { label: string; ceilingM: number; distancePx: number } | null {
    let best: { label: string; ceilingM: number; distancePx: number } | null = null;
    for (const e of this.list) {
      const w = WEAPONS[e.kind];
      if (!w) continue;
      const d = e.x - worldX;
      if (d <= 0 || d > rangePx) continue;
      if (!best || w.ceilingM > best.ceilingM) {
        best = { label: w.label, ceilingM: w.ceilingM, distancePx: d };
      }
    }
    return best;
  }

  private pendingFlak: Array<{ wx: number; y: number; in: number; big: boolean }> = [];
  private flak: Flak[] = [];

  /** Called at draw time — detonates shells whose fuse has run out. */
  private tickImpact(dt: number): void {
    for (let i = this.pendingFlak.length - 1; i >= 0; i--) {
      const f = this.pendingFlak[i];
      f.in -= dt;
      if (f.in > 0) continue;
      this.pendingFlak.splice(i, 1);
      this.flak.push({ wx: f.wx, y: f.y, age: 0, big: f.big });
      if (this.flak.length > 22) this.flak.shift();
    }
    for (let i = this.flak.length - 1; i >= 0; i--) {
      this.flak[i].age += dt;
      if (this.flak[i].age > 2.4) this.flak.splice(i, 1);
    }
  }

  /**
   * Flak bursts. Drawn with the tracers because at an AA ceiling the gun that
   * fired them is well below the bottom of the frame — the black puffs
   * opening around you are the only thing telling you what is happening.
   */
  private drawFlak(g: Phaser.GameObjects.Graphics, scrollX: number, width: number): void {
    for (const f of this.flak) {
      const sx = f.wx - scrollX;
      if (sx < -120 || sx > width + 120) continue;
      const a = f.age;
      const s = f.big ? 1 : 0.68;

      // The detonation itself: a hard, brief flash
      if (a < 0.14) {
        const k = 1 - a / 0.14;
        g.fillStyle(0xfff0c0, 0.95 * k);
        g.fillCircle(sx, f.y, (7 + a * 60) * s);
        g.fillStyle(0xff9a30, 0.55 * k);
        g.fillCircle(sx, f.y, (14 + a * 110) * s);
        // Splinters thrown out of the burst
        g.lineStyle(1.4, 0xffd070, 0.8 * k);
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2 + f.wx;
          const r0 = 6 * s, r1 = (16 + a * 150) * s;
          g.lineBetween(sx + Math.cos(ang) * r0, f.y + Math.sin(ang) * r0,
                        sx + Math.cos(ang) * r1, f.y + Math.sin(ang) * r1);
        }
      }

      // The puff it leaves, drifting back and thinning out
      const fade = Phaser.Math.Clamp(1 - a / 2.4, 0, 1);
      const grow = (10 + a * 26) * s;
      g.fillStyle(0x191614, 0.42 * fade);
      g.fillEllipse(sx - a * 26, f.y, grow * 2.1, grow * 1.7);
      g.fillStyle(0x2e2a26, 0.3 * fade);
      g.fillEllipse(sx - a * 26 + grow * 0.3, f.y - grow * 0.25, grow * 1.2, grow * 0.9);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Everything on the ground: positions, crews, camp, and the fight at the wall. */
  draw(
    g: Phaser.GameObjects.Graphics,
    scrollX: number,
    baseY: number,
    width: number,
    t: number,
    dl: number,
    style: CrowdStyle,
    dt: number,
  ): void {
    this.tickImpact(dt);

    for (const e of this.list) {
      const sx = e.x - scrollX;
      if (sx < -180 || sx > width + 180) continue;
      switch (e.kind) {
        case 'camp':      this.drawCamp(g, sx, baseY, t, e.seed, dl, style); break;
        case 'nest':      this.drawNest(g, sx, baseY, t, e, dl); break;
        case 'technical': this.drawTechnical(g, sx, baseY, t, e, dl); break;
        case 'aa':        this.drawAA(g, sx, baseY, t, e, dl); break;
        case 'tower':     this.drawTower(g, sx, baseY, t, e, dl); break;
      }
    }
  }

  /** Rounds in the air, flak bursts and impact sparks. Drawn above the world. */
  drawTracers(g: Phaser.GameObjects.Graphics, scrollX: number, width: number): void {
    this.drawFlak(g, scrollX, width);
    for (const tr of this.tracers) {
      const sx = tr.wx - scrollX;
      if (sx < -200 || sx > width + 200) continue;
      const k = Phaser.Math.Clamp(tr.life / Math.max(0.001, tr.hot), 0, 1);
      // The streak is the round's own travel over the last few milliseconds
      const bx = sx - tr.vx * 0.035, by = tr.y - tr.vy * 0.035;
      g.lineStyle(3.2, 0xff9a30, 0.16 * k);
      g.lineBetween(bx, by, sx, tr.y);
      g.lineStyle(1.5, 0xffe07a, 0.9 * k);
      g.lineBetween(bx, by, sx, tr.y);
      g.fillStyle(0xfff2c0, 0.95 * k);
      g.fillCircle(sx, tr.y, 1.5);
    }
    for (const s of this.sparks) {
      const a = Phaser.Math.Clamp(s.life / 0.4, 0, 1);
      g.fillStyle(0xffd070, a);
      g.fillRect(s.x - scrollX, s.y, 1.8, 1.8);
    }
    // Strike flash on the skin. With so few rounds in the air now, the one
    // that connects has to be unmistakable.
    for (const im of this.impacts) {
      const k = 1 - im.age / 0.35;
      const sx = im.x - scrollX;
      g.fillStyle(0xffffff, 0.9 * k);
      g.fillCircle(sx, im.y, 3 + (1 - k) * 5);
      g.fillStyle(0xffb040, 0.5 * k);
      g.fillCircle(sx, im.y, 8 + (1 - k) * 16);
    }
  }

  // ── Individual positions ──────────────────────────────────────────────────

  /**
   * An armed militiaman. The renderer is shared with the settlement garrison
   * (Figures.ts) — only the palette differs, which is exactly right: from the
   * air both read as armed people, and whose ground it is decides everything.
   */
  private rebel(
    g: Phaser.GameObjects.Graphics,
    x: number, groundY: number, t: number, seed: number,
    scale: number, face: 1 | -1,
    pose: FighterPose,
    aim: number,
    dl: number,
  ): void {
    drawFighter(g, x, groundY, t, seed, scale, face, pose, aim, dl, RAIDER_PALETTE);
  }

  /** Muzzle flash — shared with the garrison so every gun flashes alike. */
  private flash(g: Phaser.GameObjects.Graphics, x: number, y: number, a: number, k: number, size: number): void {
    drawMuzzleFlash(g, x, y, a, k, size);
  }

  /** Sandbag machine-gun nest with a two-man crew. */
  private drawNest(
    g: Phaser.GameObjects.Graphics, sx: number, baseY: number,
    t: number, e: Emplacement, dl: number,
  ): void {
    const p = pivotOf('nest');
    const kick = e.recoil * 1.6;
    const px = sx + p.x - Math.cos(e.aim) * kick;
    const py = baseY + p.y - Math.sin(e.aim) * kick;

    // Crew behind the parapet
    this.rebel(g, sx - 16, baseY, t, e.seed + 1, 0.75, 1, 'crouch', e.aim, dl);
    this.rebel(g, sx - 26, baseY, t, e.seed + 2, 0.72, 1, 'work', 0, dl);

    // Sandbags first, so the gun sits on the parapet rather than behind it.
    // Alternating tones with a lit top edge — a stack of one flat colour just
    // reads as a rock.
    for (let row = 0; row < 3; row++) {
      const w = 46 - row * 9;
      const yy = baseY - 5 - row * 5;
      const n = 5 - row;
      for (let i = 0; i < n; i++) {
        const bx = sx - w / 2 + i * (w / n) + (row % 2) * 3 + 5;
        g.fillStyle((i + row) % 2 ? 0x3a3122 : 0x2a2418, 1);
        g.fillEllipse(bx, yy, 13, 6.6);
        g.fillStyle(0x4e4430, 0.55);
        g.fillEllipse(bx, yy - 1.8, 9.5, 2.6);
      }
    }

    // Gun on its bipod, laid on the target
    g.lineStyle(2.4, 0x14110c, 1);
    g.lineBetween(px, py, px + Math.cos(e.aim) * p.len, py + Math.sin(e.aim) * p.len);
    g.lineStyle(1.2, 0x4a4436, 0.85);
    g.lineBetween(px, py - 1, px + Math.cos(e.aim) * p.len * 0.75, py + Math.sin(e.aim) * p.len * 0.75 - 1);
    g.lineStyle(1.8, 0x14110c, 1);
    g.lineBetween(px, py, px - 3, baseY - 6);
    g.lineBetween(px, py, px + 4, baseY - 6);
    g.fillStyle(0x2b251a, 1);
    g.fillRect(px - 4, py - 2.8, 8, 5.6);
    // Belt of ammunition drooping out of the feed tray
    g.lineStyle(1.3, 0x7a6832, 0.95);
    g.lineBetween(px - 2, py + 2, px - 8, baseY - 9);

    this.flash(g, px + Math.cos(e.aim) * p.len, py + Math.sin(e.aim) * p.len, e.aim, e.flash / 0.07, 3.4);
  }

  /** Gun truck: pickup with a heavy weapon on a pintle in the bed. */
  private drawTechnical(
    g: Phaser.GameObjects.Graphics, sx: number, baseY: number,
    t: number, e: Emplacement, dl: number,
  ): void {
    const face: 1 | -1 = rnd(e.seed + 9) > 0.5 ? 1 : -1;
    const body = 0x232a20;
    const shadow = 0x14180f;
    const bounce = Math.sin(t * 2.3 + e.seed) * 0.4 + e.recoil * 1.2;
    const y = baseY - bounce;

    // Wheels first so the body sits on them
    for (const wx of [sx - 20, sx + 18]) {
      g.fillStyle(0x0e0c08, 1);
      g.fillCircle(wx, y - 5, 5.6);
      g.fillStyle(0x2c2820, 1);
      g.fillCircle(wx, y - 5, 2.4);
    }

    // Bed + cab
    g.fillStyle(body, 1);
    g.fillRect(sx - 30, y - 15, 58, 8);
    g.fillRect(sx - 30 + (face > 0 ? 34 : 0), y - 25, 24, 11);   // cab
    g.fillStyle(0x5c6a70, 0.5);
    g.fillRect(sx - 27 + (face > 0 ? 34 : 0), y - 23, 9, 6);      // windscreen
    g.fillStyle(shadow, 1);
    g.fillRect(sx - 30, y - 8, 58, 2.5);
    // Bed side rail and a scrap-plate shield
    g.fillStyle(shadow, 1);
    g.fillRect(sx - 30 + (face > 0 ? 0 : 34), y - 21, 22, 6);
    // Bullet holes in the door
    g.fillStyle(0x0a0906, 0.9);
    for (let i = 0; i < 3; i++) {
      g.fillCircle(sx - 24 + (face > 0 ? 34 : 0) + i * 6 + rnd(e.seed + i) * 3, y - 20 + rnd(e.seed + i * 3) * 5, 0.9);
    }

    // The pintle stands in the middle of the bed, with the gunner right behind
    // it — the bed is on the opposite end from the cab.
    const bedX = sx - face * 18;
    this.rebel(g, bedX - face * 7, y - 15, t, e.seed + 4, 0.8, face, 'aimUp', e.aim, dl);

    const p = pivotOf('technical');
    const kick = e.recoil * 2.2;
    const px = bedX - Math.cos(e.aim) * kick;
    const py = y - 26 - Math.sin(e.aim) * kick;
    g.lineStyle(2.0, 0x14110c, 1);
    g.lineBetween(bedX, y - 15, bedX, py);            // pintle post
    g.lineStyle(3.0, 0x14110c, 1);
    g.lineBetween(px, py, px + Math.cos(e.aim) * p.len, py + Math.sin(e.aim) * p.len);
    g.lineStyle(1.4, 0x4a4436, 0.9);                  // lit top edge of the barrel
    g.lineBetween(px, py - 1, px + Math.cos(e.aim) * p.len * 0.8, py + Math.sin(e.aim) * p.len * 0.8 - 1);
    g.fillStyle(0x2b251a, 1);
    g.fillRect(px - 4.5, py - 3.5, 9, 7);             // receiver
    // Ammunition can hanging off the feed side
    g.fillStyle(0x2f3a24, 1);
    g.fillRect(px + face * 4, py + 1.5, 6, 5);

    // Headlights burning at night
    if (dl < 0.55) {
      const hx = sx + face * 28;
      g.fillStyle(0xffe0a0, 0.10 * (1 - dl));
      g.fillTriangle(hx, y - 18, hx + face * 90, y - 34, hx + face * 90, y + 2);
      g.fillStyle(0xffeec0, 0.9);
      g.fillCircle(hx, y - 18, 1.8);
    }

    this.flash(g, px + Math.cos(e.aim) * p.len, py + Math.sin(e.aim) * p.len, e.aim, e.flash / 0.07, 4.4);
  }

  /** Wheeled twin autocannon — the one that will actually reach you. */
  private drawAA(
    g: Phaser.GameObjects.Graphics, sx: number, baseY: number,
    t: number, e: Emplacement, dl: number,
  ): void {
    const p = pivotOf('aa');
    const kick = e.recoil * 3;
    const px = sx + p.x - Math.cos(e.aim) * kick * 0.4;
    const py = baseY + p.y - Math.sin(e.aim) * kick * 0.4;
    const metal = 0x2b2a22;

    // Carriage: two road wheels and a splayed trail
    for (const wx of [sx - 13, sx + 13]) {
      g.fillStyle(0x100e0a, 1);
      g.fillCircle(wx, baseY - 4, 4.4);
      g.fillStyle(0x35322a, 1);
      g.fillCircle(wx, baseY - 4, 1.8);
    }
    g.lineStyle(2.4, metal, 1);
    g.lineBetween(sx - 16, baseY - 1, sx + 16, baseY - 1);
    g.lineBetween(sx, baseY - 6, sx - 22, baseY);
    g.lineBetween(sx, baseY - 6, sx + 22, baseY);
    g.fillStyle(metal, 1);
    g.fillRect(sx - 7, baseY - 15, 14, 10);          // turntable + gun shield
    g.fillStyle(0x3c3a30, 1);
    g.fillRect(sx - 10, baseY - 20, 7, 9);

    // Twin barrels on the trunnion
    const ca = Math.cos(e.aim), sa = Math.sin(e.aim);
    for (const off of [-2.2, 2.2]) {
      const ox = -sa * off, oy = ca * off;
      g.lineStyle(2.0, 0x191610, 1);
      g.lineBetween(px + ox, py + oy, px + ox + ca * p.len, py + oy + sa * p.len);
    }
    g.fillStyle(0x191610, 1);
    g.fillCircle(px, py, 3.4);

    // Gunner in the seat, loader beside with a fresh clip
    this.rebel(g, sx + 11, baseY, t, e.seed + 5, 0.72, -1, 'crouch', e.aim, dl);
    this.rebel(g, sx + 24, baseY, t, e.seed + 6, 0.76, -1, 'work', 0, dl);
    g.fillStyle(0x2f3a24, 1);
    g.fillRect(sx - 30, baseY - 5, 10, 5);
    g.fillRect(sx - 19, baseY - 4, 9, 4);

    const k = e.flash / 0.07;
    this.flash(g, px - sa * -2.2 + ca * p.len, py + ca * -2.2 + sa * p.len, e.aim, k, 5.2);
    this.flash(g, px - sa * 2.2 + ca * p.len, py + ca * 2.2 + sa * p.len, e.aim, k, 5.2);
  }

  /** Scrap lookout tower with a marksman and a searchlight. */
  private drawTower(
    g: Phaser.GameObjects.Graphics, sx: number, baseY: number,
    t: number, e: Emplacement, dl: number,
  ): void {
    const h = 40;
    const wood = 0x241b11;
    // Splayed legs with cross-bracing
    g.lineStyle(2.4, wood, 1);
    g.lineBetween(sx - 12, baseY, sx - 5, baseY - h);
    g.lineBetween(sx + 12, baseY, sx + 5, baseY - h);
    g.lineStyle(1.3, wood, 0.9);
    for (let i = 1; i < 4; i++) {
      const y0 = baseY - (h * i) / 4, y1 = baseY - (h * (i - 1)) / 4;
      const w0 = 12 - (7 * i) / 4, w1 = 12 - (7 * (i - 1)) / 4;
      g.lineBetween(sx - w0, y0, sx + w1, y1);
      g.lineBetween(sx - w0, y0, sx + w0, y0);
    }
    // Platform with a sandbag lip
    g.fillStyle(wood, 1);
    g.fillRect(sx - 13, baseY - h - 4, 26, 4);
    for (let i = 0; i < 3; i++) {
      g.fillStyle(0x322a1c, 1);
      g.fillEllipse(sx - 9 + i * 9, baseY - h - 6, 11, 5);
    }

    const p = pivotOf('tower');
    const px = sx + p.x, py = baseY + p.y;
    this.rebel(g, sx + 4, baseY - h - 4, t, e.seed + 7, 0.66, -1, 'aimUp', e.aim, dl);
    g.lineStyle(1.4, 0x171310, 1);
    g.lineBetween(px, py, px + Math.cos(e.aim) * p.len, py + Math.sin(e.aim) * p.len);

    // Searchlight sweeping the approach after dark
    if (dl < 0.6) {
      const beam = e.aim;
      g.fillStyle(0xfff0c0, 0.09 * (1 - dl));
      g.fillTriangle(
        px, py,
        px + Math.cos(beam - 0.14) * 260, py + Math.sin(beam - 0.14) * 260,
        px + Math.cos(beam + 0.14) * 260, py + Math.sin(beam + 0.14) * 260,
      );
      g.fillStyle(0xfff4d0, 0.9);
      g.fillCircle(px, py, 2.4);
    }

    this.flash(g, px + Math.cos(e.aim) * p.len, py + Math.sin(e.aim) * p.len, e.aim, e.flash / 0.07, 2.6);
  }

  /**
   * The camp itself — and the fight it is permanently losing at the back wall.
   * This is the chaos: militia on the parapet shooting DOWN into a press of
   * the dead, bodies stacked where they fell, everything lit by burn barrels.
   */
  private drawCamp(
    g: Phaser.GameObjects.Graphics, sx: number, baseY: number,
    t: number, seed: number, dl: number, style: CrowdStyle,
  ): void {
    const face: 1 | -1 = rnd(seed + 2) > 0.5 ? 1 : -1;

    // ── Scrap wall: mismatched panels, leaning, spikes along the top ──────
    for (let i = 0; i < 9; i++) {
      const px = sx + (i - 4) * 13;
      const ph = 20 + rnd(seed + i * 7) * 13;
      const tilt = (rnd(seed + i) - 0.5) * 3;
      g.fillStyle(i % 2 ? 0x241d14 : 0x1d1811, 1);
      g.beginPath();
      g.moveTo(px - 6, baseY);
      g.lineTo(px - 6 + tilt, baseY - ph);
      g.lineTo(px + 6 + tilt, baseY - ph);
      g.lineTo(px + 6, baseY);
      g.closePath();
      g.fillPath();
      // Rust streaks and a spike
      g.lineStyle(1, 0x3a2a16, 0.5);
      g.lineBetween(px - 2 + tilt, baseY - ph + 3, px - 2, baseY - 4);
      g.lineStyle(1.4, 0x2e2820, 1);
      g.lineBetween(px + tilt, baseY - ph, px + tilt + 2, baseY - ph - 5);
    }

    // ── Burn barrel: flame, ember spit, smoke ────────────────────────────
    const bx = sx + face * 46;
    g.fillStyle(0x2a231a, 1);
    g.fillRect(bx - 5, baseY - 11, 10, 11);
    g.fillStyle(0x1a150f, 1);
    g.fillRect(bx - 5, baseY - 11, 10, 1.6);
    const fl = 0.6 + Math.sin(t * 9 + seed) * 0.4;
    g.fillStyle(0xff6a1e, 0.75);
    g.fillTriangle(bx - 4, baseY - 11, bx, baseY - 11 - 11 * fl, bx + 4, baseY - 11);
    g.fillStyle(0xffc250, 0.85);
    g.fillTriangle(bx - 2, baseY - 11, bx + 0.5, baseY - 11 - 6.5 * fl, bx + 2.5, baseY - 11);
    g.fillStyle(0xff8a30, 0.14 * fl);
    g.fillCircle(bx, baseY - 14, 22);
    for (let i = 0; i < 4; i++) {
      const ey = ((t * 26 + i * 19 + seed * 7) % 46);
      g.fillStyle(0xffb050, 0.5 * (1 - ey / 46));
      g.fillRect(bx + Math.sin(t * 2 + i) * 5, baseY - 13 - ey, 1.4, 1.4);
    }

    // ── Tents and stores ─────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const tx = sx - face * (30 + i * 26);
      g.fillStyle(0x2a2418, 1);
      g.fillTriangle(tx - 11, baseY, tx, baseY - 15, tx + 11, baseY);
      g.fillStyle(0x181309, 1);
      g.fillTriangle(tx + 1, baseY, tx + 4, baseY - 9, tx + 8, baseY);
    }
    g.fillStyle(0x33291a, 1);
    for (let i = 0; i < 3; i++) g.fillRect(sx + face * (60 + i * 8), baseY - 7, 7, 7);

    // ── Banner: their mark, flying over the position ─────────────────────
    const ax = sx - face * 60;
    g.lineStyle(1.8, 0x2a2218, 1);
    g.lineBetween(ax, baseY, ax, baseY - 46);
    const wave = Math.sin(t * 3 + seed) * 3;
    g.fillStyle(0x7a1a12, 0.95);
    g.beginPath();
    g.moveTo(ax, baseY - 46);
    g.lineTo(ax + face * 22, baseY - 44 + wave);
    g.lineTo(ax + face * 22, baseY - 32 + wave);
    g.lineTo(ax, baseY - 30);
    g.closePath();
    g.fillPath();
    g.fillStyle(0xd8c8a0, 0.8);
    g.fillRect(ax + face * 8, baseY - 41, 5, 5);

    // ── The fight at the wall ────────────────────────────────────────────
    // Dead pressing in from outside…
    const hordeSide = -face;
    for (let i = 0; i < 7; i++) {
      const zx = sx + hordeSide * (66 + i * 13 + rnd(seed + i * 5) * 9);
      const push = Math.abs(Math.sin(t * 1.05 + i * 0.9)) * 3.4;
      drawUndead(
        g, zx - hordeSide * push, baseY, t, seed + i * 23,
        0.82 + rnd(seed + i) * 0.3, face,
        undeadKindFor(seed + i * 23), style, 0.95,
      );
    }
    // …bodies where the last wave was stopped…
    for (let i = 0; i < 3; i++) {
      drawCorpse(g, sx + hordeSide * (52 + i * 17), baseY, seed + i * 11, 0.8, style);
    }
    // …and two on the parapet putting rounds into them.
    for (let i = 0; i < 2; i++) {
      const gx = sx + hordeSide * (14 + i * 20);
      const firing = Math.sin(t * (5.5 + i * 1.7) + seed + i * 2) > 0.72;
      this.rebel(g, gx, baseY - 22, t, seed + 30 + i, 0.72, hordeSide as 1 | -1, 'aimSide', 0, dl);
      if (firing) {
        const a = hordeSide > 0 ? 0.25 : Math.PI - 0.25;
        this.flash(g, gx + hordeSide * 8, baseY - 27, a, 1, 2.4);
        g.lineStyle(1.2, 0xffe07a, 0.7);
        g.lineBetween(gx + hordeSide * 9, baseY - 27, gx + hordeSide * 40, baseY - 12);
      }
    }
  }
}
