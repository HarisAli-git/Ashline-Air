import Phaser from 'phaser';
import { drawUndead, drawCorpse, undeadKindFor, type CrowdStyle } from './Crowds';

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
}

interface Tracer {
  wx: number;           // world px
  y: number;            // screen y
  vx: number;           // world px/s
  vy: number;           // screen px/s
  life: number;
  hot: number;          // starting life, for fade
  hit: boolean;
}

interface Spark { x: number; y: number; vx: number; vy: number; life: number; }

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

  /** Lay out positions inside each hostile stretch. Deterministic per route. */
  layout(zones: ReadonlyArray<readonly [number, number]>, seed: number): void {
    this.list = [];
    this.tracers = [];
    this.sparks = [];

    for (let z = 0; z < zones.length; z++) {
      const [a, b] = zones[z];
      const span = b - a;
      // One position roughly every 700 px of zone, 4–9 per zone.
      const n = Phaser.Math.Clamp(Math.round(span / 700), 4, 9);
      for (let i = 0; i < n; i++) {
        const id = seed * 977 + z * 131 + i * 29;
        const r = rnd(id);
        // The camp furniture anchors each end; weapons fill the middle.
        let kind: EmplacementKind;
        if (i === 0 || i === n - 1) kind = 'camp';
        else if (r < 0.34) kind = 'nest';
        else if (r < 0.60) kind = 'technical';
        else if (r < 0.82) kind = 'aa';
        else kind = 'tower';
        this.list.push({
          x: a + span * ((i + 0.5) / n) + (rnd(id + 3) - 0.5) * (span / n) * 0.5,
          kind, seed: id, aim: -1.2, flash: 0, recoil: 0,
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
    scrollX: number,
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

    // Rounds in flight
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.wx += tr.vx * dt;
      tr.y += tr.vy * dt;
      tr.vy += 90 * dt;               // they do drop off at the top of the arc
      tr.life -= dt;
      if (tr.life <= 0) this.tracers.splice(i, 1);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 320 * dt;
      s.life -= dt;
      if (s.life <= 0) this.sparks.splice(i, 1);
    }
  }

  /**
   * A burst goes off. The nearest weapons that can bear open up together;
   * `hit` decides whether one of the rounds is solved onto the aircraft.
   */
  burst(baseY: number, target: { worldX: number; screenY: number }, hit: boolean): void {
    // Whoever is closest and actually has a weapon does the shooting
    const firing = this.list
      .filter(e => e.kind !== 'camp' && Math.abs(e.x - target.worldX) < 2200)
      .sort((a, b) => Math.abs(a.x - target.worldX) - Math.abs(b.x - target.worldX))
      .slice(0, 3);
    if (firing.length === 0) return;

    let solved = false;
    for (const e of firing) {
      const p = pivotOf(e.kind);
      const mx = e.x + p.x + Math.cos(e.aim) * p.len;
      const my = baseY + p.y + Math.sin(e.aim) * p.len;
      e.flash = 0.07;
      e.recoil = 1;

      const rounds = e.kind === 'aa' ? 3 : e.kind === 'technical' ? 2 : 2;
      for (let k = 0; k < rounds; k++) {
        // One round per burst is allowed to be the one that connects
        const solve = hit && !solved && k === 0;
        if (solve) solved = true;
        const dxw = target.worldX - mx;
        const dys = target.screenY - my;
        const len = Math.max(1, Math.hypot(dxw, dys));
        // Misses are thrown wide; the near ones are what make it feel close
        const spread = solve ? 0 : (Math.random() - 0.5) * 0.16;
        const ca = Math.cos(spread), sa = Math.sin(spread);
        const ux = (dxw * ca - dys * sa) / len;
        const uy = (dxw * sa + dys * ca) / len;
        const tof = len / TRACER_SPEED;
        this.tracers.push({
          wx: mx, y: my,
          vx: ux * TRACER_SPEED, vy: uy * TRACER_SPEED,
          life: solve ? tof : tof * (1.5 + Math.random() * 0.7),
          hot: solve ? tof : tof * 2,
          hit: solve,
        });
        if (solve) {
          // Schedule the impact sparks for where the round arrives
          this.pendingImpact = { x: target.worldX, y: target.screenY, in: tof };
        }
      }
      if (this.tracers.length > MAX_TRACERS) {
        this.tracers.splice(0, this.tracers.length - MAX_TRACERS);
      }
    }
  }

  private pendingImpact: { x: number; y: number; in: number } | null = null;

  /** Called from update via draw time — spawns sparks when a round lands. */
  private tickImpact(dt: number): void {
    if (!this.pendingImpact) return;
    this.pendingImpact.in -= dt;
    if (this.pendingImpact.in > 0) return;
    const { x, y } = this.pendingImpact;
    this.pendingImpact = null;
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 150;
      this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.18 + Math.random() * 0.22 });
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

  /** Rounds in the air and the sparks where they land. Drawn above the world. */
  drawTracers(g: Phaser.GameObjects.Graphics, scrollX: number, width: number): void {
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
  }

  // ── Individual positions ──────────────────────────────────────────────────

  /**
   * An armed militiaman. Deliberately built to read as *alive* at a glance —
   * upright spine, squared shoulders, helmet, weapon held in two hands — so
   * there is never a question about which figures on the ground are which.
   */
  private rebel(
    g: Phaser.GameObjects.Graphics,
    x: number, groundY: number, t: number, seed: number,
    scale: number, face: 1 | -1,
    pose: 'aimUp' | 'aimSide' | 'stand' | 'crouch' | 'work',
    aim: number,
    dl: number,
  ): void {
    const s = scale;
    const cloth = 0x241c12;
    const skin = 0x171009;
    const r = rnd(seed);
    const idle = Math.sin(t * 1.6 + seed) * 0.6 * s;

    const crouch = pose === 'crouch' || pose === 'work';
    const legLen = (crouch ? 5.4 : 9.2) * s;
    const torso = 8.4 * s;
    const hipY = groundY - legLen;
    const lean = pose === 'aimUp' ? -0.16 : pose === 'work' ? 0.34 : 0.06;
    const shX = x + face * lean * torso;
    const shY = hipY - torso + idle * 0.3;

    // Legs — braced apart, not walking
    g.lineStyle(1.9 * s, cloth, 1);
    g.beginPath();
    g.moveTo(x, hipY);
    g.lineTo(x - face * 1.6 * s, hipY + legLen * 0.55);
    g.lineTo(x - face * 3.4 * s, groundY);
    g.strokePath();
    g.beginPath();
    g.moveTo(x, hipY);
    g.lineTo(x + face * 2.0 * s, hipY + legLen * 0.55);
    g.lineTo(x + face * 3.2 * s, groundY);
    g.strokePath();

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

    // Head with a helmet or a wrapped face
    const hdY = shY - 3.2 * s;
    g.fillStyle(skin, 1);
    g.fillCircle(shX + face * 0.6 * s, hdY, 2.3 * s);
    g.fillStyle(r > 0.5 ? 0x2e2416 : 0x3a2010, 1);
    if (r > 0.5) {
      // Helmet
      g.fillEllipse(shX + face * 0.6 * s, hdY - 1.1 * s, 5.6 * s, 3.4 * s);
      g.fillRect(shX + face * 0.6 * s - 2.8 * s, hdY - 0.8 * s, 5.6 * s, 1.1 * s);
    } else {
      // Hood + face wrap
      g.fillEllipse(shX + face * 0.2 * s, hdY - 0.6 * s, 6.2 * s, 5.0 * s);
      g.fillStyle(0x6a1c14, 1);
      g.fillRect(shX + face * 0.2 * s - 2.2 * s, hdY + 0.5 * s, 4.4 * s, 1.2 * s);
    }

    // Arms + weapon
    const a = pose === 'aimUp' ? aim : pose === 'aimSide' ? (face > 0 ? 0 : Math.PI) : 0.5;
    if (pose === 'work') {
      // Hauling an ammo can
      g.lineStyle(1.6 * s, cloth, 1);
      g.beginPath();
      g.moveTo(shX, shY + 1 * s);
      g.lineTo(shX + face * 2.6 * s, shY + 4 * s);
      g.lineTo(shX + face * 3.4 * s, shY + 7 * s);
      g.strokePath();
      g.fillStyle(0x2f3a24, 1);
      g.fillRect(shX + face * 2.2 * s, shY + 7 * s, 4.6 * s, 3.4 * s);
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
      g.lineStyle(1.5 * s, 0x1a1610, 1);
      g.lineBetween(mx - Math.cos(a) * 3 * s, my - Math.sin(a) * 3 * s, ex, ey);
      g.fillStyle(0x1a1610, 1);
      g.fillRect(mx - 1.2 * s, my - 0.6 * s, 2.4 * s, 2.6 * s); // magazine
    }

    // Night: a headlamp or a cigarette ember — signs of life
    if (dl < 0.5 && r > 0.7) {
      g.fillStyle(0xffb060, 0.7 * (1 - dl));
      g.fillCircle(shX + face * 2.4 * s, hdY, 0.9 * s);
    }
  }

  /** Muzzle flash: a hot star along the bore plus the light it throws. */
  private flash(g: Phaser.GameObjects.Graphics, x: number, y: number, a: number, k: number, size: number): void {
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
