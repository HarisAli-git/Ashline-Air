import Phaser from 'phaser';
import { SoundEngine } from '../../audio/SoundEngine';
import type { AircraftSprite } from './AircraftSprite';
import { PUFF_TEX, ensureSharedTextures } from './render/AircraftPainter';
import { GLOW_TEX, ensureSkyTextures } from '../../world/CloudSprites';

/**
 * What happens when it goes in.
 *
 * The crash used to be one effect for every crash: the scene handed it the
 * speed after it had been zeroed for the panel, so a crop duster flopping
 * onto a field and a transport going in at 250 km/h played the same small
 * nudge. Its "slow motion" set a clock nothing on screen ran on, and the
 * gouges and debris were pinned to the screen while the ground slid away
 * under them.
 *
 * Now it is a short film of the impact that was actually flown:
 *
 *   FALL   Ending in the air — a midair, a mast — it falls, trailing fire and
 *          smoke, and the camera follows it down to the ground.
 *   HIT    A hit-stop, then slow motion easing back to real time, a punch of
 *          the camera, and the fuel going up: a white bloom, a fireball rolling
 *          up into black smoke, dirt thrown into the air, a shockwave over the
 *          ground, sparks, shrapnel, and the big pieces tumbling away trailing
 *          smoke, a wheel bouncing off on its own.
 *   SLIDE  It ploughs on, slowing, cutting a furrow and throwing dirt, pitching
 *          over its nose as it goes — onto its nose, or right over onto its
 *          back — and comes to rest sitting ON the ground, not through it.
 *   BURN   The tanks go a moment after it stops, and it burns.
 *
 *   or, in the water:
 *   SPLASH A column of spray, rings spreading, a short skate to a stop; then it
 *          settles nose first and goes under, and what was in it comes up as
 *          bubbles and a slick of oil.
 *
 * Everything that happens in the world stays where it happened while the
 * camera follows the wreck: the crater, the furrow, the debris and every puff
 * of smoke move with the ground each frame.
 */

export interface CrashOptions {
  /** Speed along the route when it ended, m/s. */
  speed: number;
  /** Sink rate when it ended, m/s (positive down). */
  verticalSpeed: number;
  /** Height above the ground when it ended, m. */
  altitude?: number;
  /** Belly landing: more sparks. */
  gearUp: boolean;
  /** Which way it was flying: the wreck is thrown forward, the debris back. */
  dir?: 1 | -1;
  /** The world's camera: screen y for a height above the ground. */
  altToY?: (m: number) => number;
  /** What it comes down on, asked at the moment it does. */
  surfaceAt?: () => { water: boolean; color: number };
  /** Along-track wind, m/s — the smoke leans with it. */
  windX?: number;
}

interface Chunk {
  img: Phaser.GameObjects.Image;
  vx: number; vy: number; spin: number;
  grounded: boolean;
  trail: Phaser.GameObjects.Particles.ParticleEmitter | null;
  wheel: boolean;
}

interface Ring { x: number; y: number; age: number; life: number; size: number; water: boolean }
interface Glow { img: Phaser.GameObjects.Image; age: number; life: number; size: number }

type Phase = 'fall' | 'slide' | 'rest' | 'sink' | 'sunk';

const FRAMES = ['p0', 'p1', 'p2', 'p3'];

/**
 * A streak that turns along its own path. A spark is a line in the direction
 * it flies; left at one angle, a shower of them reads as dashes hanging in
 * the air. (The angle is set each step, once the velocity exists.)
 */
const ALONG = {
  onEmit: (): number => 0,
  onUpdate: (p: Phaser.GameObjects.Particles.Particle): number => Math.atan2(p.velocityY, p.velocityX) * 57.29578,
};

export class CrashSequence {
  private readonly scene: Phaser.Scene;
  private readonly aircraft: AircraftSprite;
  private readonly groundY: number;

  /** Crater, furrow, shockwaves and water rings: on the ground, over the wreck. */
  private readonly gfx: Phaser.GameObjects.Graphics;
  /** Foam and bubbles on the water's surface, over the hulk. */
  private readonly surface: Phaser.GameObjects.Graphics;
  /**
   * Everything above the water, as a stencil: the airframe is clipped to it,
   * so what has gone under is simply not there and the lake shows through.
   * (A painted cover was tried first; no flat colour matches a lake graded
   * from the sky's reflection to the murk under the camera.)
   */
  private clipShape: Phaser.GameObjects.Graphics | null = null;
  private clip: Phaser.Display.Masks.GeometryMask | null = null;
  private chunks: Chunk[] = [];
  private emitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  private scars: Array<{ x: number; w: number }> = [];
  private rings: Ring[] = [];
  private glows: Glow[] = [];
  private slick: { x: number; age: number } | null = null;

  private running = false;
  private phase: Phase = 'fall';
  private t = 0;
  private severity = 1;
  private dir: 1 | -1 = 1;
  private opts: CrashOptions | null = null;
  private done: (() => void) | null = null;
  private doneAt = Infinity;

  // ── The wreck ─────────────────────────────────────────────────────────────
  private alt = 0;          // m above the ground
  private vs = 0;           // m/s, down
  private v = 0;            // m/s along the route
  private v0 = 1;           // speed just after the impact
  private rot = 0;
  private rot0 = 0;         // attitude at the impact
  private spin = 0;
  private restPose = 0;
  private anchorX = 0;      // where the camera holds it, screen x
  private offset = 0;       // how far ahead of that it has run, px
  private hop = 0;          // px above the ground while it skips
  private hopV = 0;
  private hopRot = 0;       // extra pitch picked up in the air
  private lift = 0;         // px the airframe is raised so it sits on the ground
  private sinkPx = 0;
  private water = false;
  private waterColor = 0x2e3a30;
  private trail: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  private plough: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private spray: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private fireGlow: Phaser.GameObjects.Image | null = null;
  private restAt = 0;
  private blewTanks = false;
  private furrowFrom: number | null = null;

  // ── Time ──────────────────────────────────────────────────────────────────
  private hitStop = 0;      // real seconds of near-freeze left
  private slow = 1;         // slow-motion factor, eases back to 1

  constructor(scene: Phaser.Scene, aircraft: AircraftSprite, groundY: number) {
    this.scene = scene;
    this.aircraft = aircraft;
    this.groundY = groundY;
    this.gfx = scene.add.graphics().setDepth(6.5);
    this.surface = scene.add.graphics().setDepth(0.5);
    ensureSharedTextures(scene);
    ensureSkyTextures(scene);
  }

  get isRunning(): boolean { return this.running; }

  /** How fast the scene should run the world: a hit-stop, then slow motion. */
  get timeScale(): number {
    if (!this.running) return 1;
    return this.hitStop > 0 ? 0.04 : this.slow;
  }

  /** Height of the wreck above the ground, m — the world's camera follows it down. */
  get altitudeM(): number { return Math.max(0, this.alt); }

  /** Spray the colour of the water it came out of: a tailings pit splashes rust. */
  private wet(c: number, k: number): number {
    const w = this.waterColor;
    const ch = (sh: number): number => {
      const a = (c >> sh) & 255, b = (w >> sh) & 255;
      return Math.round(a + (b - a) * k) << sh;
    };
    return ch(16) | ch(8) | ch(0);
  }

  /** How fast the world should still scroll, m/s: the wreck's own speed. */
  slideSpeed(): number {
    if (!this.running) return 0;
    return this.phase === 'fall' || this.phase === 'slide' ? this.v : 0;
  }

  play(opts: CrashOptions, done: () => void): void {
    if (this.running) return;
    this.running = true;
    this.opts = opts;
    this.done = done;
    this.t = 0;
    this.dir = opts.dir ?? 1;
    const c = this.aircraft.container;
    this.anchorX = c.x;
    this.rot = c.rotation;
    this.v = Math.max(4, opts.speed);
    this.vs = Math.max(1.5, opts.verticalSpeed);
    this.alt = Math.max(0, opts.altitude ?? 0);
    // Whatever happens, the report comes
    this.doneAt = 14;

    if (this.alt > 2.5) {
      // Still in the air: it falls, burning, the nose dropping
      this.phase = 'fall';
      this.spin = this.dir * (0.25 + Math.random() * 0.3);
      this.startTrail();
    } else {
      this.alt = 0;
      this.impact();
    }
  }

  // ── The moment it hits ────────────────────────────────────────────────────

  private impact(): void {
    const surf = this.opts?.surfaceAt?.() ?? { water: false, color: 0x2e3a30 };
    this.water = surf.water;
    this.waterColor = surf.color;
    // How hard, from what it was actually doing when it met the ground
    this.severity = Phaser.Math.Clamp(0.45 + this.vs / 10 + this.v / 85, 0.5, 1.6);
    const sev = this.severity;
    const c = this.aircraft.container;
    const x = c.x, y = this.groundY;
    const cam = this.scene.cameras.main;
    this.doneAt = this.t + 9;

    // The beat: everything nearly stops, then runs slow and catches up
    this.hitStop = 0.07 + sev * 0.03;
    this.slow = 0.28;
    cam.shake(520 + 420 * sev, 0.010 + 0.008 * sev, true);
    cam.zoomTo(1.045, 90, 'Sine.easeOut', true);
    this.scene.time.delayedCall(160, () => { if (this.running) cam.zoomTo(1, 900, 'Sine.easeInOut', true); });

    this.aircraft.shedParts();
    for (const e of this.trail) e.stop();
    this.rot0 = this.rot;
    this.hopRot = 0;

    if (this.water) {
      // The water line: the airframe is drawn only above it from here on
      if (this.scene.sys.game.renderer.type === Phaser.WEBGL) {
        this.clipShape = this.scene.make.graphics({}, false);
        this.clip = this.clipShape.createGeometryMask();
        this.aircraft.setClip(this.clip);
      }
      cam.flash(120, 220, 230, 235);
      SoundEngine.splash(sev);
      this.splashAt(x, y, sev);
      this.throwParts(x, y - 12, sev * 0.7);
      // Water stops an aeroplane far harder than dirt does
      this.v *= 0.55;
      this.v0 = Math.max(1, this.v);
      this.phase = 'slide';
      this.hopV = this.v > 18 ? -(90 + 60 * sev) : 0;
      this.spin = this.dir * (1.2 + sev);
      this.restPose = this.dir * (0.35 + Math.random() * 0.25);
      return;
    }

    cam.flash(160, 255, 200, 130);
    SoundEngine.crash();
    SoundEngine.fireball(sev);
    this.fireballAt(x, y - 6, sev);
    this.dirtAt(x, y, sev, this.opts?.gearUp ?? false);
    this.rings.push({ x, y, age: 0, life: 0.5, size: 170 * sev, water: false });
    this.scars.push({ x, w: 40 + 70 * sev });
    this.throwParts(x, y - 14, sev);
    this.v0 = Math.max(1, this.v);
    this.phase = 'slide';
    // Skips once if it came in hard enough, then ploughs
    this.hopV = this.vs > 6 || this.v > 45 ? -(110 + 120 * sev) : 0;
    this.spin = this.dir * (0.9 + sev * 1.2);
    // It comes to rest broken: nose buried, or pitched right over its nose
    // onto its back. A light aeroplane goes over easily; sixty tonnes of
    // transport does not balance on its nose or somersault — it digs in
    // shallow and stays the right way up.
    const hb = this.aircraft.hitBox;
    // On-screen half-length: crop duster and bush plane ~75 px, the
    // freighter ~95, the transport ~107
    const heavy = hb.valid ? Phaser.Math.Clamp((hb.rx - 75) / 30, 0, 1) : 0;
    const flips = sev >= 0.7 && Math.random() < 0.45 * (1 - heavy);
    this.restPose = this.dir * (flips
      ? 2.55 + Math.random() * 0.4
      : (0.55 + Math.random() * 0.35) * (1 - 0.5 * heavy));
    SoundEngine.scrape(Math.min(3, Math.log(Math.max(1.2, this.v / 2.5)) / 1.4 + 0.3), sev);
    this.furrowFrom = x;
  }

  /** The fuel going up: a bloom, a fireball, then the black smoke it becomes. */
  private fireballAt(x: number, y: number, sev: number): void {
    this.glow(x, y - 8, 0xffe0a0, 2.6 * sev, 0.32);
    // Every puff cools as it rises — white-hot, orange, red, out — so the
    // fireball rolls up as one thing rather than a handful of orange balls
    const fire = this.scene.add.particles(x, y, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 480, max: 1100 },
      speed: { min: 40, max: 210 * sev },
      angle: { min: 195, max: 345 },
      gravityY: -70,
      scale: { start: 0.36 * sev, end: 1.4 * sev },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.85, end: 0 },
      color: [0xfff6d8, 0xffc860, 0xff7a24, 0xb8300c, 0x300a02],
      colorEase: 'Quad.easeOut',
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    }).setDepth(6.85);
    fire.explode(Math.round(30 + 22 * sev));
    // Lit from under by the fire at first, then black
    const smoke = this.scene.add.particles(x, y - 10, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 1600, max: 3400 },
      speed: { min: 30, max: 150 * sev },
      angle: { min: 200, max: 340 },
      gravityY: -55,
      scale: { start: 0.35 * sev, end: 2.1 * sev },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.78, end: 0 },
      color: [0x6a4428, 0x2a221c, 0x1a1714],
      emitting: false,
    }).setDepth(6.8);
    smoke.explode(Math.round(18 + 14 * sev));
    this.emitters.push(fire, smoke);
  }

  /** Dirt, sparks and shrapnel thrown out at a ground impact. */
  private dirtAt(x: number, y: number, sev: number, gearUp: boolean): void {
    const d = this.dir;
    const dirt = this.scene.add.particles(x, y, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 700, max: 1500 },
      speedX: d > 0 ? { min: -260, max: 140 } : { min: -140, max: 260 },
      speedY: { min: -380 * sev, max: -80 },
      gravityY: 640,
      scale: { start: 0.18 * sev, end: 0.75 * sev },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.9, end: 0 },
      tint: [0x8a6a3a, 0x6a5230, 0x4a3a24],
      emitting: false,
    }).setDepth(6.6);
    dirt.explode(Math.round(16 + 14 * sev));
    const sparks = this.scene.add.particles(x, y - 6, 'px_streak', {
      lifespan: { min: 260, max: 750 },
      speedX: d > 0 ? { min: -520, max: -40 } : { min: 40, max: 520 },
      speedY: { min: -260, max: 40 },
      scale: { start: 0.7, end: 0.1 },
      alpha: { start: 1, end: 0 },
      tint: [0xffe090, 0xffa030],
      rotate: ALONG,
      gravityY: 440,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    }).setDepth(6.7);
    sparks.explode(gearUp ? 48 : 28);
    const shrapnel = this.scene.add.particles(x, y - 14, 'px_streak', {
      lifespan: { min: 700, max: 1700 },
      speedX: d > 0 ? { min: -440, max: 160 } : { min: -160, max: 440 },
      speedY: { min: -340 * sev, max: -40 },
      rotate: { min: 0, max: 360 },
      scale: { start: 0.9, end: 0.25 },
      alpha: { start: 1, end: 0.2 },
      tint: [0x3a3128, 0x8a6a4a, 0x1a1610],
      gravityY: 320,
      emitting: false,
    }).setDepth(6.6);
    shrapnel.explode(Math.round(14 + 12 * sev));
    this.emitters.push(dirt, sparks, shrapnel);
  }

  /** Spray, a mist hanging over it, and rings across the water. */
  private splashAt(x: number, y: number, sev: number): void {
    const spray = this.scene.add.particles(x, y, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 900, max: 1700 },
      speedX: { min: -140, max: 140 },
      speedY: { min: -560 * sev, max: -180 },
      gravityY: 720,
      scale: { start: 0.22 * sev, end: 1.0 * sev },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.95, end: 0 },
      tint: [this.wet(0xf2f6f6, 0.15), this.wet(0xd8e2e6, 0.3), this.wet(0xbfccd2, 0.45)],
      emitting: false,
    }).setDepth(6.6);
    spray.explode(Math.round(26 + 18 * sev));
    // Droplets thrown out in a fan: round, not streaks — a streak that
    // cannot turn along its path reads as a dash hanging in the air
    const fan = this.scene.add.particles(x, y - 2, 'px_soft', {
      lifespan: { min: 500, max: 1100 },
      speed: { min: 180, max: 520 },
      angle: { min: 200, max: 340 },
      gravityY: 820,
      scale: { start: 0.16, end: 0.05 },
      alpha: { start: 0.95, end: 0 },
      tint: [this.wet(0xffffff, 0.1), this.wet(0xdfe8ec, 0.3)],
      emitting: false,
    }).setDepth(6.7);
    fan.explode(Math.round(36 + 20 * sev));
    const mist = this.scene.add.particles(x, y - 10, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 2200, max: 3600 },
      speedX: { min: -40, max: 40 }, speedY: { min: -40, max: -10 },
      scale: { start: 0.6 * sev, end: 2.4 * sev },
      alpha: { start: 0.42, end: 0 },
      tint: this.wet(0xe6ecee, 0.25),
      emitting: false,
    }).setDepth(6.55);
    mist.explode(12);
    this.emitters.push(spray, fan, mist);
    for (let k = 0; k < 3; k++) {
      this.rings.push({ x, y, age: -k * 0.45, life: 2.6, size: (160 + k * 50) * sev, water: true });
    }
  }

  /** The big pieces: thrown, tumbling, each trailing its own smoke. */
  private throwParts(x: number, y: number, sev: number): void {
    const tex = this.aircraft.textureKeys;
    const d = this.dir;
    const part = (key: string, scale: number, vx: number, vy: number, spin: number, wheel = false): void => {
      const img = this.scene.add.image(x, y, key).setScale(scale).setDepth(6.62)
        .setRotation(Math.random() * Math.PI).setTint(wheel ? 0xffffff : 0x7a726a);
      let trail: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
      if (!wheel && !this.water) {
        trail = this.scene.add.particles(0, 0, 'px_soft', {
          lifespan: { min: 380, max: 820 },
          speedX: { min: -20, max: 20 }, speedY: { min: -30, max: -5 },
          scale: { start: 0.35, end: 1.2 },
          alpha: { start: 0.5, end: 0 },
          tint: [0x1e1a16, 0x302a24],
          frequency: 40,
        }).setDepth(6.58);
        trail.startFollow(img);
        this.emitters.push(trail);
      }
      this.chunks.push({ img, vx, vy, spin, grounded: false, trail, wheel });
    };
    part(tex.wingNear, 0.5 * sev, d * (-150 - Math.random() * 140), -260 * sev, 7 * d);
    part(tex.propBlade, 0.42, d * (-260 - Math.random() * 170), -220 * sev, 15 * d);
    part(tex.wheel, 0.5, d * (120 + Math.random() * 120), -170 * sev, 9 * d, true);
    if (sev > 0.8) part(tex.gearDoor, 0.42, d * (-90 - Math.random() * 90), -190, -9 * d);
    if (sev > 1.05) part(tex.flap, 0.46, d * (-60 - Math.random() * 100), -240, 11 * d);
  }

  /** A soft bloom of light that swells and fades. */
  private glow(x: number, y: number, tint: number, size: number, life: number): void {
    const img = this.scene.add.image(x, y, GLOW_TEX).setDepth(6.9)
      .setBlendMode(Phaser.BlendModes.ADD).setTint(tint).setDisplaySize(60, 60);
    this.glows.push({ img, age: 0, life, size });
  }

  /** Fire and smoke pouring off the airframe as it falls. */
  private startTrail(): void {
    const c = this.aircraft.container;
    const smoke = this.scene.add.particles(0, 0, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 900, max: 1800 },
      speedX: { min: -30, max: 30 }, speedY: { min: -40, max: 0 },
      scale: { start: 0.2, end: 1.1 },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.7, end: 0 },
      tint: [0x1a1612, 0x2a241e],
      frequency: 28,
    });
    // Behind the airframe, but in front of the sky and the land
    smoke.setDepth(this.aircraft.bodyLayer.depth).setBelow(this.aircraft.bodyLayer);
    smoke.startFollow(c, 0, -12);
    const fire = this.scene.add.particles(0, 0, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 160, max: 360 },
      speedX: { min: -40, max: 40 }, speedY: { min: -60, max: -10 },
      scale: { start: 0.22, end: 0.05 },
      alpha: { start: 0.95, end: 0 },
      tint: [0xffd070, 0xff7a20, 0xd03a10],
      blendMode: Phaser.BlendModes.ADD,
      frequency: 22,
    }).setDepth(0.6);
    fire.startFollow(c, 0, -12);
    this.trail = [smoke, fire];
    this.emitters.push(smoke, fire);
  }

  /** It has stopped. The tanks go a moment later, and it burns. */
  private comeToRest(): void {
    this.phase = 'rest';
    this.restAt = this.t;
    this.v = 0;
    this.scene.tweens.add({ targets: this, rot: this.restPose, duration: 520, ease: 'Sine.easeOut' });
    const c = this.aircraft.container;
    const lean = Phaser.Math.Clamp((this.opts?.windX ?? 0) / 8, -1, 1) * 30;
    const fire = this.scene.add.particles(c.x, this.groundY - 10, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 320, max: 760 },
      speedX: { min: -40, max: 40 }, speedY: { min: -150, max: -55 },
      scale: { start: 0.32, end: 0.06 },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.95, end: 0 },
      color: [0xffe8a0, 0xff9a30, 0xd8461a, 0x501404],
      blendMode: Phaser.BlendModes.ADD,
      frequency: 22,
    }).setDepth(6.8);
    const smoke = this.scene.add.particles(c.x, this.groundY - 24, PUFF_TEX, {
      frame: FRAMES,
      lifespan: { min: 2400, max: 4400 },
      speedX: { min: lean - 30, max: lean + 10 }, speedY: { min: -90, max: -40 },
      scale: { start: 0.3, end: 2.6 },
      rotate: { min: 0, max: 360 },
      alpha: { start: 0.62, end: 0 },
      tint: [0x16130f, 0x241e19, 0x342c25],
      frequency: 60,
    }).setDepth(6.5);
    this.emitters.push(fire, smoke);
    // The fire lights everything round it — most of all at night
    this.fireGlow = this.scene.add.image(c.x, this.groundY - 16, GLOW_TEX).setDepth(6.45)
      .setBlendMode(Phaser.BlendModes.ADD).setTint(0xff7a28).setDisplaySize(220, 160).setAlpha(0.5);
    // Fading as the report comes up, not running on under it
    SoundEngine.fireCrackle(4.2);
    this.doneAt = Math.min(this.doneAt, this.t + 2.9);
  }

  /** The fuel tanks letting go, a beat after it stopped. */
  private secondary(): void {
    this.blewTanks = true;
    const c = this.aircraft.container;
    this.fireballAt(c.x + this.dir * 6, this.groundY - 8, this.severity * 0.5);
    this.rings.push({ x: c.x, y: this.groundY, age: 0, life: 0.4, size: 110 * this.severity, water: false });
    this.scene.cameras.main.shake(360, 0.010, true);
    this.scene.cameras.main.flash(160, 255, 170, 80);
    SoundEngine.fireball(this.severity * 0.6);
  }

  // ── Frame by frame ────────────────────────────────────────────────────────

  /**
   * @param realDt   real seconds since last frame (the crash runs its own clock)
   * @param scrollPx how far the world scrolled this frame, px — everything on
   *                 the ground moves back by it, so it stays where it fell
   */
  update(realDt: number, scrollPx = 0): void {
    if (!this.running) return;
    const dt = realDt * this.timeScale;
    this.hitStop = Math.max(0, this.hitStop - realDt);
    if (this.hitStop <= 0) this.slow += (1 - this.slow) * Math.min(1, realDt * 1.6);
    this.t += realDt;
    for (const e of this.emitters) e.timeScale = this.timeScale;

    // Everything in the world keeps its place as the camera follows the wreck
    if (scrollPx !== 0) {
      for (const s of this.scars) s.x -= scrollPx;
      for (const r of this.rings) r.x -= scrollPx;
      if (this.furrowFrom !== null) this.furrowFrom -= scrollPx;
      if (this.slick) this.slick.x -= scrollPx;
      for (const ch of this.chunks) ch.img.x -= scrollPx;
      for (const e of this.emitters) e.forEachAlive(p => { p.x -= scrollPx; }, null);
      for (const g of this.glows) g.img.x -= scrollPx;
    }

    this.updateWreck(dt);
    this.updateChunks(dt);
    this.updateGlows(realDt);
    this.draw(dt);

    if (this.phase === 'rest' && !this.blewTanks && this.t - this.restAt > 0.55) this.secondary();
    if (this.fireGlow) {
      const fl = 0.42 + Math.sin(this.t * 19) * 0.06 + Math.sin(this.t * 7.3) * 0.05;
      this.fireGlow.setAlpha(fl).setPosition(this.aircraft.container.x, this.groundY - 16);
    }
    if (this.t >= this.doneAt && this.done) {
      const cb = this.done;
      this.done = null;
      cb();
    }
  }

  private updateWreck(dt: number): void {
    const c = this.aircraft.container;
    const toY = this.opts?.altToY ?? ((m: number) => this.groundY - m * 3.4);

    if (this.phase === 'fall') {
      // Falling, faster the higher it started, so a long fall stays a few
      // seconds; drag on the forward speed, and the nose going over
      this.vs += (14 + Math.max(0, this.alt - 60) * 0.4) * dt;
      this.alt -= this.vs * dt;
      this.v *= Math.exp(-dt * 0.25);
      const nose = this.dir * 0.6;
      this.rot += (nose - this.rot) * Math.min(1, dt * 1.4) + this.spin * dt * 0.2;
      c.setPosition(this.anchorX, toY(Math.max(0, this.alt)));
      c.setRotation(this.rot);
      this.aircraft.placeShadow(c.x, this.alt);
      if (this.alt <= 0) {
        this.alt = 0;
        this.impact();
      }
      return;
    }

    if (this.phase === 'slide') {
      // Skipping off the surface once, then ploughing
      if (this.hopV !== 0) {
        this.hopV += 1500 * dt;
        this.hop += this.hopV * dt;
        this.hopRot += this.spin * dt;
        if (this.hop >= 0) {
          this.hop = 0;
          if (this.hopV > 60) {
            if (this.water) {
              this.splashAt(c.x, this.groundY, this.severity * 0.5);
              SoundEngine.splash(this.severity * 0.5);
            } else {
              // The second hit: smaller, but the airframe takes it
              this.dirtAt(c.x, this.groundY, this.severity * 0.55, true);
              this.rings.push({ x: c.x, y: this.groundY, age: 0, life: 0.35, size: 90 * this.severity, water: false });
              this.scars.push({ x: c.x, w: 30 + 40 * this.severity });
              this.scene.cameras.main.shake(240, 0.007, true);
              SoundEngine.impact();
            }
          }
          this.hopV = 0;
        }
      }
      const grounded = this.hopV === 0;
      // Dirt is friction; water is a wall
      const drag = this.water ? 2.6 : 1.4;
      this.v *= Math.exp(-dt * (grounded ? drag : 0.3));
      // Pitching over as it slows: the further it has slid, the nearer the
      // pose it ends in. The pitch picked up in the air settles back.
      if (grounded) this.hopRot *= Math.exp(-dt * 4);
      const p = Phaser.Math.Clamp(1 - this.v / this.v0, 0, 1);
      const e = 1 - (1 - p) * (1 - p);
      const shudder = Math.sin(this.t * 31) * 0.05 * (this.v / this.v0);
      const want = this.rot0 + (this.restPose - this.rot0) * e + this.hopRot + shudder;
      this.rot += (want - this.rot) * Math.min(1, dt * 9);
      // The camera lags it a little, so it runs forward on screen as it goes
      this.offset += (this.dir * 46 - this.offset) * Math.min(1, dt * 1.2);
      if (grounded) {
        // A rooster tail of dirt (or spray) while it is still moving
        if (this.v > 6 && Math.random() < 0.55) {
          if (this.water) this.splashSpray(c.x, this.groundY);
          else this.ploughSpray(c.x, this.groundY);
        }
        if (this.v < (this.water ? 3 : 2.5)) {
          if (this.water) this.startSinking(); else this.comeToRest();
        }
      }
    }

    if (this.phase === 'sink') {
      // Settling nose first, slowly at first, then going
      const k = this.t - this.restAt;
      this.sinkPx += (6 + 10 * k) * dt;
      const hb = this.aircraft.hitBox;
      if (this.sinkPx > Math.max(30, (hb.valid ? hb.ry : 20) * 2.6)) this.endSink();
    }

    this.sitOnGround(dt);
    c.setPosition(this.anchorX + this.offset, this.groundY + this.hop - this.lift + this.sinkPx);
    c.setRotation(this.rot);
    this.aircraft.placeShadow(c.x, this.hop / -20, !this.water);
  }

  /**
   * Keep the wreck ON the ground. The airframe pivots about its wheels, so a
   * wreck nosed over or on its back would swing half of itself under the
   * ground line. The lowest point of the picture is kept just into the dirt —
   * a little deeper the steeper it is, so a buried nose reads as buried.
   */
  private sitOnGround(dt: number): void {
    const hb = this.aircraft.hitBox;
    const c = this.aircraft.container;
    if (!hb.valid) return;
    // The model's box is its own, unrotated: find the bottom of it as turned
    const r = c.rotation;
    const sn = Math.abs(Math.sin(r)), cs = Math.abs(Math.cos(r));
    const lowest = hb.cy + hb.rx * sn + hb.ry * cs;
    const dig = 4 + hb.ry * (0.25 + 0.5 * sn);
    const want = Phaser.Math.Clamp(lowest - c.y - dig, -24, 220);
    this.lift += (want - this.lift) * Math.min(1, dt * 10);
  }

  /** Dirt thrown off the furrow as the wreck ploughs on. */
  private ploughSpray(x: number, y: number): void {
    if (!this.plough) {
      this.plough = this.scene.add.particles(0, 0, PUFF_TEX, {
        frame: FRAMES,
        lifespan: { min: 500, max: 1000 },
        speedX: this.dir > 0 ? { min: -160, max: 20 } : { min: -20, max: 160 },
        speedY: { min: -200, max: -60 },
        gravityY: 560,
        scale: { start: 0.12, end: 0.45 },
        alpha: { start: 0.85, end: 0 },
        tint: [0x8a6a3a, 0x6a5230, 0x4a3a24],
        emitting: false,
      }).setDepth(6.6);
      this.emitters.push(this.plough);
    }
    this.plough.explode(3, x - this.dir * 8, y - 2);
  }

  /** Spray thrown up as the hulk skates to a stop. */
  private splashSpray(x: number, y: number): void {
    if (!this.spray) {
      this.spray = this.scene.add.particles(0, 0, PUFF_TEX, {
        frame: FRAMES,
        lifespan: { min: 500, max: 1000 },
        speedX: this.dir > 0 ? { min: -140, max: 60 } : { min: -60, max: 140 },
        speedY: { min: -260, max: -80 },
        gravityY: 700,
        scale: { start: 0.14, end: 0.55 },
        alpha: { start: 0.9, end: 0 },
        tint: [this.wet(0xf2f6f6, 0.2), this.wet(0xd8e2e6, 0.35)],
        emitting: false,
      }).setDepth(6.6);
      this.emitters.push(this.spray);
    }
    this.spray.explode(3, x + this.dir * 10, y - 2);
  }

  private startSinking(): void {
    this.phase = 'sink';
    this.v = 0;
    this.restAt = this.t;
    this.scene.tweens.add({ targets: this, rot: this.dir * 0.42, duration: 2600, ease: 'Sine.easeInOut' });
    this.slick = { x: this.aircraft.container.x, age: 0 };
    this.doneAt = Math.min(this.doneAt, this.t + 5.5);
  }

  private endSink(): void {
    this.phase = 'sunk';
    this.aircraft.container.setVisible(false);
    this.rings.push({ x: this.aircraft.container.x, y: this.groundY, age: 0, life: 2.2, size: 120, water: true });
    this.doneAt = Math.min(this.doneAt, this.t + 1.8);
  }

  private updateChunks(dt: number): void {
    for (const ch of this.chunks) {
      if (ch.grounded) {
        if (ch.wheel && Math.abs(ch.vx) > 4 && ch.img.visible) {
          // A wheel keeps rolling a while
          ch.img.x += ch.vx * dt;
          ch.img.rotation += (ch.vx / 9) * dt;
          ch.vx *= Math.exp(-dt * 1.3);
        }
        continue;
      }
      ch.vy += 1100 * dt;
      ch.img.x += ch.vx * dt;
      ch.img.y += ch.vy * dt;
      ch.img.rotation += ch.spin * dt;
      if (ch.img.y > this.groundY - 4) {
        ch.img.y = this.groundY - 4;
        if (this.water) {
          // In the water a part just goes under
          this.rings.push({ x: ch.img.x, y: this.groundY, age: 0, life: 1.4, size: 46, water: true });
          ch.img.setVisible(false);
          ch.grounded = true;
          ch.trail?.stop();
          continue;
        }
        ch.vy = -ch.vy * (ch.wheel ? 0.45 : 0.28);
        ch.vx *= ch.wheel ? 0.8 : 0.5;
        ch.spin *= 0.35;
        if (Math.abs(ch.vy) < 34) {
          ch.grounded = true; ch.vy = 0; ch.spin = 0;
          if (!ch.wheel) ch.vx = 0;
          ch.trail?.stop();
        }
      }
    }
  }

  private updateGlows(dt: number): void {
    for (let i = this.glows.length - 1; i >= 0; i--) {
      const g = this.glows[i];
      g.age += dt;
      const k = g.age / g.life;
      if (k >= 1) { g.img.destroy(); this.glows.splice(i, 1); continue; }
      const s = 60 + g.size * 120 * Math.sqrt(k);
      g.img.setDisplaySize(s, s * 0.8).setAlpha(1 - k);
    }
  }

  private draw(dt: number): void {
    const g = this.gfx;
    g.clear();
    const c = this.aircraft.container;
    const gy = this.groundY;
    // Where it hit: a crater, torn dirt round a dark hole
    for (const s of this.scars) {
      g.fillStyle(0x3a2c1a, 0.55);
      g.fillEllipse(s.x, gy, s.w * 1.25, 9);
      g.fillStyle(0x120e08, 0.75);
      g.fillEllipse(s.x, gy + 1.5, s.w, 6);
    }
    // The furrow torn out behind the wreck while it ploughs
    if (this.furrowFrom !== null && !this.water) {
      const a = this.furrowFrom, b = c.x;
      g.fillStyle(0x120e08, 0.62);
      g.fillRect(Math.min(a, b), gy + 1, Math.abs(b - a), 4);
      g.fillStyle(0x3a2c1a, 0.5);
      g.fillRect(Math.min(a, b), gy - 1.5, Math.abs(b - a), 2.5);
      // Earth heaped up in a berm round where it stopped
      if (this.phase === 'rest') {
        g.fillStyle(0x2a2014, 0.9);
        g.fillEllipse(b + this.dir * 10, gy + 1, 60, 12);
        g.fillStyle(0x3e3020, 0.7);
        g.fillEllipse(b + this.dir * 12, gy - 2, 40, 6);
      }
    }
    // Shockwaves across the ground, rings across the water
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age < 0) continue;
      const k = r.age / r.life;
      if (k >= 1) { this.rings.splice(i, 1); continue; }
      const rad = r.size * (r.water ? Math.sqrt(k) : 1 - (1 - k) * (1 - k));
      if (r.water) {
        g.lineStyle(1.6, 0xe8eef0, 0.5 * (1 - k));
        g.strokeEllipse(r.x, r.y + 2, rad * 2, rad * 0.26);
        g.lineStyle(1, 0xe8eef0, 0.3 * (1 - k));
        g.strokeEllipse(r.x, r.y + 2, rad * 1.4, rad * 0.18);
      } else {
        g.lineStyle(2.4, 0xfff0d0, 0.45 * (1 - k));
        g.strokeEllipse(r.x, r.y - 2, rad * 2, rad * 0.3);
        g.lineStyle(1.2, 0xffe8c0, 0.2 * (1 - k));
        g.strokeCircle(r.x, r.y - 20, rad * 0.7);
      }
    }
    // What came up when it went under: a slick of oil spreading
    if (this.slick) {
      this.slick.age += dt;
      const s = Math.min(1, this.slick.age / 4);
      for (const [col, off] of [[0x6a4a8a, -10], [0x3a8a8a, 0], [0x9a7a3a, 12]] as const) {
        g.fillStyle(col, 0.16 * s);
        g.fillEllipse(this.slick.x + off * s, gy + 3, 40 + s * 150, 4 + s * 9);
      }
    }
    this.drawWater();
  }

  /**
   * The water line. The airframe is clipped to what is above it (`clip`), so
   * the lake itself shows where the hulk has gone under; where it meets the
   * surface there is foam, and as it goes, bubbles.
   */
  private drawWater(): void {
    const m = this.surface;
    m.clear();
    if (!this.water || this.phase === 'fall' || this.phase === 'rest') return;
    const hb = this.aircraft.hitBox;
    const top = this.groundY + 1;
    const hidden = this.phase === 'sunk';
    if (this.clipShape) {
      const s = this.clipShape;
      s.clear();
      s.fillStyle(0xffffff, 1);
      s.fillRect(-400, -3000, this.scene.scale.width + 800, top + 3000);
    }
    if (!hidden && hb.valid && this.hop > -2) {
      // Foam where the water meets the hulk: broken, across its width
      const r = this.aircraft.container.rotation;
      const sn = Math.abs(Math.sin(r)), cs = Math.abs(Math.cos(r));
      const hx = (hb.rx * cs + hb.ry * sn) * 0.75;
      for (let k = 0; k < 7; k++) {
        const u = -1 + (k + 0.5) * (2 / 7);
        const fx = hb.cx + u * hx + Math.sin(this.t * 5 + k * 1.7) * 2;
        m.fillStyle(0xe8eef0, 0.55 - Math.abs(u) * 0.3);
        m.fillEllipse(fx, top + 0.5, 9 + (k % 3) * 4, 2.4);
      }
    }
    // Bubbles coming up where it is going, and where it went
    if (this.phase === 'sink' || hidden) {
      const cx = this.slick ? this.slick.x : hb.cx;
      const w = Math.max(16, hb.rx * 0.6);
      const n = hidden ? 5 : 8;
      for (let k = 0; k < n; k++) {
        const ph = ((this.t * (0.9 + k * 0.13)) + k * 0.37) % 1;
        const bx = cx + Math.sin(k * 2.3 + this.t * 0.7) * w;
        m.fillStyle(0xe8f0f2, 0.5 * (1 - ph));
        m.fillCircle(bx, top - 1 - ph * 6, 1 + ph * 1.6);
      }
    }
  }

  destroy(): void {
    this.gfx.destroy();
    this.surface.destroy();
    this.clip?.destroy();
    this.clipShape?.destroy();
    this.clip = null;
    this.clipShape = null;
    for (const ch of this.chunks) ch.img.destroy();
    for (const e of this.emitters) e.destroy();
    for (const g of this.glows) g.img.destroy();
    this.fireGlow?.destroy();
    this.chunks = [];
    this.emitters = [];
    this.trail = [];
    this.scars = [];
    this.rings = [];
    this.glows = [];
    this.running = false;
    // At shutdown the cameras may already be gone
    this.scene.cameras?.main?.setZoom(1);
  }
}
