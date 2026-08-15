import Phaser from 'phaser';
import { SoundEngine } from '../../audio/SoundEngine';
import type { AircraftSprite } from './AircraftSprite';

/**
 * What happens when you put it into the ground.
 *
 * A crash used to be a white flash and an immediate cut to the results screen.
 * The first attempt at fixing that tweened the airframe to a gentle 18° lean
 * and let it sit there burning, which the pilot fairly described as "the plane
 * just stands there" — a tween to a resting pose is a pose, not a crash.
 *
 * So the wreck is simulated instead of tweened: it carries velocity and spin,
 * it bounces off the ground and loses energy on each impact, it cartwheels
 * through whole rotations while it still has the speed for it, and it throws
 * dirt, sparks and burning debris at every bounce. It only stops when it has
 * actually run out of energy, and it stops in a broken attitude — nose buried
 * or on its back — never level.
 */

interface CrashOptions {
  /** Horizontal speed at impact, m/s. */
  speed: number;
  /** Vertical speed at impact, m/s (positive number). */
  verticalSpeed: number;
  /** Belly landing: more sparks, less bounce. */
  gearUp: boolean;
}

interface Chunk {
  img: Phaser.GameObjects.Image;
  vx: number; vy: number; spin: number; grounded: boolean;
}

/** Screen-space motion of the airframe itself. */
interface Wreck {
  x: number; y: number;
  vx: number; vy: number;
  rot: number; spin: number;
  bounces: number;
  settled: boolean;
  restPose: number;
}

export class CrashSequence {
  private readonly scene: Phaser.Scene;
  private readonly aircraft: AircraftSprite;
  private readonly groundY: number;

  private readonly gfx: Phaser.GameObjects.Graphics;
  private chunks: Chunk[] = [];
  private emitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  private scars: Array<{ x: number; w: number }> = [];

  private wreck: Wreck | null = null;
  private t = 0;
  private running = false;
  private severity = 1;
  private baseSlide = 0;

  constructor(scene: Phaser.Scene, aircraft: AircraftSprite, groundY: number) {
    this.scene = scene;
    this.aircraft = aircraft;
    this.groundY = groundY;
    this.gfx = scene.add.graphics().setDepth(6.5);
  }

  get isRunning(): boolean { return this.running; }

  /**
   * How fast the world should still scroll, m/s. Tracks the wreck's own
   * horizontal speed so the ground and the wreckage agree about how fast
   * everything is still moving.
   */
  slideSpeed(): number {
    if (!this.wreck || this.wreck.settled) return 0;
    return Math.max(0, this.baseSlide * Math.exp(-this.t * 0.85));
  }

  play(opts: CrashOptions, done: () => void): void {
    if (this.running) return;
    this.running = true;
    this.t = 0;

    const c = this.aircraft.container;
    this.severity = Phaser.Math.Clamp(0.5 + opts.verticalSpeed / 9 + opts.speed / 90, 0.5, 1.5);
    const sev = this.severity;
    this.baseSlide = Math.max(8, opts.speed * 0.75);

    // ── The hit ───────────────────────────────────────────────────────────
    SoundEngine.crash();
    SoundEngine.impact();
    const cam = this.scene.cameras.main;
    cam.shake(600 * sev, 0.014 * sev);
    cam.flash(140, 255, 210, 150);
    this.scene.time.timeScale = 0.4;
    this.scene.time.delayedCall(240, () => { this.scene.time.timeScale = 1; });

    // ── The airframe comes apart ──────────────────────────────────────────
    this.aircraft.shedParts();
    const tex = this.aircraft.textureKeys;
    const chunk = (key: string, scale: number, vx: number, vy: number, spin: number): void => {
      const img = this.scene.add.image(c.x, c.y - 18, key)
        .setScale(scale).setDepth(6.6).setRotation(Math.random() * Math.PI);
      this.chunks.push({ img, vx, vy, spin, grounded: false });
    };
    chunk(tex.wingNear, 0.5 * sev, -150 - Math.random() * 120, -230 * sev, 7);
    chunk(tex.propBlade, 0.42, -240 - Math.random() * 160, -180 * sev, 14);
    if (sev > 0.8) chunk(tex.gearDoor, 0.4, -90 - Math.random() * 80, -160, -9);
    if (sev > 1.1) chunk(tex.flap, 0.45, -60 - Math.random() * 90, -210, 11);

    // ── The wreck itself: given real motion, not a tween ──────────────────
    // Thrown forward and up off the first impact, spinning hard. Everything
    // after this is integrated in update().
    this.wreck = {
      x: c.x, y: c.y,
      vx: 40 + opts.speed * 1.1,
      vy: -(120 + 190 * sev) * (opts.gearUp ? 0.45 : 1),
      rot: c.rotation,
      spin: (Math.random() < 0.5 ? -1 : 1) * (3.2 + sev * 4.5),
      bounces: 0,
      settled: false,
      // Comes to rest broken: nose buried, or over onto its back
      restPose: Math.random() < 0.5 ? 1.05 + Math.random() * 0.3 : -(2.5 + Math.random() * 0.5),
    };

    this.burstAt(c.x, this.groundY, sev, opts.gearUp);

    if (sev > 0.75) {
      const fire = this.scene.add.particles(c.x, c.y - 10, 'px_soft', {
        lifespan: { min: 400, max: 900 },
        speedX: { min: -180, max: 140 }, speedY: { min: -260, max: -40 },
        scale: { start: 1.0, end: 2.8 }, alpha: { start: 0.95, end: 0 },
        tint: [0xffe070, 0xff8a20, 0xd03a08],
        blendMode: Phaser.BlendModes.ADD, emitting: false,
      }).setDepth(6.8);
      fire.explode(Math.round(34 * sev));
      this.emitters.push(fire);
      cam.flash(220, 255, 150, 60);
    }

    this.scene.time.delayedCall(4200, () => { this.running = false; done(); });
  }

  /** Dirt, sparks and debris thrown out at a ground impact. */
  private burstAt(x: number, y: number, sev: number, gearUp: boolean): void {
    const dirt = this.scene.add.particles(x, y, 'px_soft', {
      lifespan: { min: 600, max: 1500 },
      speedX: { min: -340, max: 80 }, speedY: { min: -320 * sev, max: -60 },
      scale: { start: 0.5, end: 2.1 }, alpha: { start: 0.6, end: 0 },
      tint: [0xb08a50, 0x8a6a3a, 0x6a5230], gravityY: 260, emitting: false,
    }).setDepth(6.4);
    dirt.explode(Math.round(34 * sev));

    const sparks = this.scene.add.particles(x, y - 6, 'px_streak', {
      lifespan: { min: 260, max: 700 },
      speedX: { min: -500, max: -60 }, speedY: { min: -250, max: 40 },
      scale: { start: 0.7, end: 0.1 }, alpha: { start: 1, end: 0 },
      tint: [0xffe090, 0xffa030], gravityY: 430,
      blendMode: Phaser.BlendModes.ADD, emitting: false,
    }).setDepth(6.7);
    sparks.explode(gearUp ? 52 : 30);

    const debris = this.scene.add.particles(x, y - 14, 'px_streak', {
      lifespan: { min: 700, max: 1700 },
      speedX: { min: -430, max: 140 }, speedY: { min: -330 * sev, max: -40 },
      rotate: { min: 0, max: 360 },
      scale: { start: 0.9, end: 0.25 }, alpha: { start: 1, end: 0.2 },
      tint: [0x3a3128, 0x8a6a4a, 0x1a1610], gravityY: 320, emitting: false,
    }).setDepth(6.6);
    debris.explode(Math.round(20 * sev));
    this.emitters.push(dirt, sparks, debris);
    this.scars.push({ x, w: 40 + 90 * sev });
  }

  /** The wreck burns where it finally stopped. */
  private ignite(x: number): void {
    const wreckFire = this.scene.add.particles(x, this.groundY - 8, 'px_soft', {
      lifespan: { min: 380, max: 820 },
      speedX: { min: -50, max: 50 }, speedY: { min: -150, max: -55 },
      scale: { start: 0.8, end: 0.15 }, alpha: { start: 0.95, end: 0 },
      tint: [0xffc040, 0xff7018, 0xc03008], frequency: 18,
      blendMode: Phaser.BlendModes.ADD,
    }).setDepth(6.8);
    const smoke = this.scene.add.particles(x, this.groundY - 22, 'px_soft', {
      lifespan: { min: 1700, max: 3400 },
      speedX: { min: -80, max: -10 }, speedY: { min: -125, max: -45 },
      scale: { start: 0.8, end: 3.8 }, alpha: { start: 0.6, end: 0 },
      tint: [0x1a1712, 0x2e2820], frequency: 30,
    }).setDepth(6.5);
    this.emitters.push(wreckFire, smoke);
    // The tanks let go a moment after it stops
    this.scene.time.delayedCall(420, () => {
      const blast = this.scene.add.particles(x, this.groundY - 14, 'px_soft', {
        lifespan: { min: 350, max: 800 },
        speedX: { min: -220, max: 220 }, speedY: { min: -300, max: -60 },
        scale: { start: 1.1, end: 3.0 }, alpha: { start: 1, end: 0 },
        tint: [0xfff0a0, 0xff9020, 0xc02808],
        blendMode: Phaser.BlendModes.ADD, emitting: false,
      }).setDepth(6.9);
      blast.explode(26);
      this.emitters.push(blast);
      this.scene.cameras.main.shake(360, 0.010);
      this.scene.cameras.main.flash(180, 255, 170, 80);
      SoundEngine.impact();
    });
  }

  /** Integrate the wreckage. Called every frame from FlightScene. */
  update(dt: number): void {
    this.t += dt;

    // ── The airframe ──────────────────────────────────────────────────────
    const w = this.wreck;
    if (w && !w.settled) {
      w.vy += 1500 * dt;                 // heavy: it falls, it does not float
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.rot += w.spin * dt;
      // Air/ground drag on the tumble
      w.vx *= Math.exp(-dt * 1.1);

      if (w.y >= this.groundY) {
        w.y = this.groundY;
        w.bounces++;
        const impact = Math.abs(w.vy);
        if (impact > 90 && w.bounces < 4) {
          // Another cartwheel out of it
          w.vy = -impact * 0.42;
          w.vx *= 0.62;
          w.spin *= -0.72;
          this.burstAt(w.x, this.groundY, this.severity * 0.55, true);
          this.scene.cameras.main.shake(220, 0.007);
          SoundEngine.impact();
        } else {
          // Out of energy — it drops onto whatever is left of it
          w.vy = 0; w.vx = 0; w.spin = 0;
          w.settled = true;
          this.scene.tweens.add({
            targets: w, rot: w.restPose, duration: 620, ease: 'Bounce.easeOut',
          });
          this.burstAt(w.x, this.groundY, this.severity * 0.4, true);
          this.ignite(w.x);
        }
      }
      // A wreck cannot be below the deck
      if (w.y > this.groundY) w.y = this.groundY;
    }

    if (w) {
      const c = this.aircraft.container;
      c.setPosition(w.x, w.y);
      c.setRotation(w.rot);
    }

    // ── Loose parts ───────────────────────────────────────────────────────
    for (const ch of this.chunks) {
      if (ch.grounded) continue;
      ch.vy += 1100 * dt;
      ch.img.x += ch.vx * dt;
      ch.img.y += ch.vy * dt;
      ch.img.rotation += ch.spin * dt;
      if (ch.img.y > this.groundY - 4) {
        ch.img.y = this.groundY - 4;
        ch.vy = -ch.vy * 0.3;
        ch.vx *= 0.5;
        ch.spin *= 0.35;
        if (Math.abs(ch.vy) < 34) { ch.grounded = true; ch.vy = 0; ch.spin = 0; ch.vx = 0; }
      }
    }

    // ── Gouges torn out of the ground at every impact ─────────────────────
    this.gfx.clear();
    for (const s of this.scars) {
      this.gfx.fillStyle(0x120e08, 0.7);
      this.gfx.fillEllipse(s.x - s.w * 0.35, this.groundY + 2, s.w, 10);
      this.gfx.fillStyle(0x2e2418, 0.45);
      this.gfx.fillEllipse(s.x - s.w * 0.35, this.groundY - 2, s.w * 0.75, 5);
    }
  }

  destroy(): void {
    this.gfx.destroy();
    for (const ch of this.chunks) ch.img.destroy();
    for (const e of this.emitters) e.destroy();
    this.chunks = [];
    this.emitters = [];
    this.scars = [];
    this.wreck = null;
    this.scene.time.timeScale = 1;
  }
}
