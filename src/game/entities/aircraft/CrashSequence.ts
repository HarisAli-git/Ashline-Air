import Phaser from 'phaser';
import { SoundEngine } from '../../audio/SoundEngine';
import type { AircraftSprite } from './AircraftSprite';

/**
 * What happens when you put it into the ground.
 *
 * A crash used to be a white flash and an immediate cut to the results screen,
 * which is the one moment in the whole flight the player most wants to watch.
 * This plays it out: the airframe hits, sheds a wing and its propeller, throws
 * dirt and burning debris, cartwheels along the ground shedding speed, and
 * comes to rest as a burning wreck with a smoke column — and only then does
 * the report come up.
 *
 * The sequence owns its own timeline and calls back when the wreck has
 * settled, so FlightScene just hands over and waits.
 */

interface CrashOptions {
  /** Horizontal speed at impact, m/s — drives how far it cartwheels. */
  speed: number;
  /** Vertical speed at impact, m/s (positive number) — drives the violence. */
  verticalSpeed: number;
  /** Belly landing: more sparks, less bounce. */
  gearUp: boolean;
}

interface Chunk {
  img: Phaser.GameObjects.Image;
  vx: number; vy: number; spin: number;
}

export class CrashSequence {
  private readonly scene: Phaser.Scene;
  private readonly aircraft: AircraftSprite;
  private readonly groundY: number;

  private readonly gfx: Phaser.GameObjects.Graphics;
  private chunks: Chunk[] = [];
  private emitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];

  private t = 0;
  private running = false;
  private restX = 0;
  private severity = 1;

  constructor(scene: Phaser.Scene, aircraft: AircraftSprite, groundY: number) {
    this.scene = scene;
    this.aircraft = aircraft;
    this.groundY = groundY;
    // Above the world and the aircraft, below the weather layer
    this.gfx = scene.add.graphics().setDepth(6.5);
  }

  get isRunning(): boolean { return this.running; }

  /** How fast the wreck is still sliding, m/s — FlightScene scrolls the world by it. */
  slideSpeed(): number {
    if (!this.running) return 0;
    // Rapid deceleration: a cartwheeling airframe is not a sledge
    return Math.max(0, this.severity * 26 * Math.exp(-this.t * 1.9));
  }

  play(opts: CrashOptions, done: () => void): void {
    if (this.running) return;
    this.running = true;
    this.t = 0;

    const c = this.aircraft.container;
    const x = c.x;
    const y = c.y;
    // 0.4 (scraped it in) → 1.4 (drove it into the deck)
    this.severity = Phaser.Math.Clamp(
      0.4 + opts.verticalSpeed / 9 + opts.speed / 90, 0.4, 1.4,
    );
    const sev = this.severity;
    this.restX = x;

    // ── The hit ───────────────────────────────────────────────────────────
    SoundEngine.crash();
    SoundEngine.impact();
    const cam = this.scene.cameras.main;
    cam.shake(700 * sev, 0.012 * sev);
    cam.flash(140, 255, 210, 150);
    // A beat of slow motion so the impact registers before the tumble
    this.scene.time.timeScale = 0.35;
    this.scene.time.delayedCall(260, () => { this.scene.time.timeScale = 1; });

    // ── The airframe comes apart ──────────────────────────────────────────
    this.aircraft.shedParts();
    const tex = this.aircraft.textureKeys;
    const spawnChunk = (key: string, scale: number, vx: number, vy: number, spin: number): void => {
      const img = this.scene.add.image(x, y - 18, key)
        .setScale(scale)
        .setDepth(6.6)
        .setRotation(Math.random() * Math.PI);
      this.chunks.push({ img, vx, vy, spin });
    };
    // A wing and the prop go their own way
    spawnChunk(tex.wingNear, 0.5 * sev, -120 - Math.random() * 90, -190 * sev, 6);
    spawnChunk(tex.propBlade, 0.42, -190 - Math.random() * 120, -150 * sev, 12);
    if (sev > 0.8) spawnChunk(tex.gearDoor, 0.4, -70 - Math.random() * 60, -130, -8);

    // ── Dirt, sparks and burning debris ───────────────────────────────────
    const dirt = this.scene.add.particles(x, this.groundY, 'px_soft', {
      lifespan: { min: 600, max: 1500 },
      speedX: { min: -320, max: 60 }, speedY: { min: -300 * sev, max: -60 },
      scale: { start: 0.5, end: 2.0 }, alpha: { start: 0.55, end: 0 },
      tint: [0xb08a50, 0x8a6a3a, 0x6a5230], gravityY: 240, emitting: false,
    }).setDepth(6.4);
    dirt.explode(Math.round(40 * sev));

    const sparks = this.scene.add.particles(x, this.groundY - 6, 'px_streak', {
      lifespan: { min: 260, max: 700 },
      speedX: { min: -460, max: -60 }, speedY: { min: -220, max: 40 },
      scale: { start: 0.7, end: 0.1 }, alpha: { start: 1, end: 0 },
      tint: [0xffe090, 0xffa030], gravityY: 420,
      blendMode: Phaser.BlendModes.ADD, emitting: false,
    }).setDepth(6.7);
    sparks.explode(opts.gearUp ? 60 : 34);

    const debris = this.scene.add.particles(x, y - 14, 'px_streak', {
      lifespan: { min: 700, max: 1800 },
      speedX: { min: -420, max: 120 }, speedY: { min: -320 * sev, max: -40 },
      rotate: { min: 0, max: 360 },
      scale: { start: 0.9, end: 0.25 }, alpha: { start: 1, end: 0.2 },
      tint: [0x3a3128, 0x8a6a4a, 0x1a1610], gravityY: 300, emitting: false,
    }).setDepth(6.6);
    debris.explode(Math.round(26 * sev));
    this.emitters.push(dirt, sparks, debris);

    // ── The fireball, if it went in hard ──────────────────────────────────
    if (sev > 0.7) {
      const fire = this.scene.add.particles(x, y - 10, 'px_soft', {
        lifespan: { min: 400, max: 900 },
        speedX: { min: -160, max: 120 }, speedY: { min: -220, max: -30 },
        scale: { start: 0.9, end: 2.4 }, alpha: { start: 0.95, end: 0 },
        tint: [0xffe070, 0xff8a20, 0xd03a08],
        blendMode: Phaser.BlendModes.ADD, emitting: false,
      }).setDepth(6.8);
      fire.explode(Math.round(30 * sev));
      this.emitters.push(fire);
      cam.flash(220, 255, 150, 60);
    }

    // ── The airframe's own tumble ─────────────────────────────────────────
    const bounce = opts.gearUp ? 6 : 26 * sev;
    this.scene.tweens.add({
      targets: c, y: y - bounce, duration: 190, ease: 'Quad.easeOut', yoyo: true,
    });
    this.scene.tweens.add({
      targets: c,
      rotation: (Math.random() < 0.5 ? -1 : 1) * (0.5 + sev * 1.5),
      duration: 900 + sev * 500,
      ease: 'Quad.easeOut',
    });
    // Settle onto the wreck's final attitude, nose buried
    this.scene.tweens.add({
      targets: c, rotation: 0.32 + Math.random() * 0.25, delay: 950,
      duration: 700, ease: 'Bounce.easeOut',
    });

    // ── The wreck burns ───────────────────────────────────────────────────
    this.scene.time.delayedCall(900, () => {
      const wreckFire = this.scene.add.particles(c.x, this.groundY - 8, 'px_soft', {
        lifespan: { min: 380, max: 800 },
        speedX: { min: -40, max: 40 }, speedY: { min: -140, max: -50 },
        scale: { start: 0.7, end: 0.15 }, alpha: { start: 0.9, end: 0 },
        tint: [0xffc040, 0xff7018, 0xc03008], frequency: 22,
        blendMode: Phaser.BlendModes.ADD,
      }).setDepth(6.8);
      const smoke = this.scene.add.particles(c.x, this.groundY - 20, 'px_soft', {
        lifespan: { min: 1600, max: 3200 },
        speedX: { min: -70, max: -10 }, speedY: { min: -110, max: -40 },
        scale: { start: 0.7, end: 3.4 }, alpha: { start: 0.55, end: 0 },
        tint: [0x1a1712, 0x2e2820], frequency: 34,
      }).setDepth(6.5);
      this.emitters.push(wreckFire, smoke);
    });

    // ── Hand back once it has settled and burned for a moment ─────────────
    this.scene.time.delayedCall(3400, () => { this.running = false; done(); });
  }

  /** Advance the tumbling wreckage. Called from FlightScene's update. */
  update(dt: number): void {
    if (!this.running && this.chunks.length === 0) return;
    this.t += dt;

    // Loose parts fall, bounce once and lie still
    for (const ch of this.chunks) {
      ch.vy += 900 * dt;
      ch.img.x += ch.vx * dt;
      ch.img.y += ch.vy * dt;
      ch.img.rotation += ch.spin * dt;
      if (ch.img.y > this.groundY - 4) {
        ch.img.y = this.groundY - 4;
        ch.vy = -ch.vy * 0.28;
        ch.vx *= 0.55;
        ch.spin *= 0.4;
        if (Math.abs(ch.vy) < 30) { ch.vy = 0; ch.spin = 0; ch.vx = 0; }
      }
    }

    // Gouge torn out of the ground where the wreck came down
    this.gfx.clear();
    if (this.t > 0.1) {
      const w = Phaser.Math.Clamp(this.t * 90, 0, 190) * this.severity;
      this.gfx.fillStyle(0x120e08, 0.75);
      this.gfx.fillEllipse(this.restX - w * 0.4, this.groundY + 2, w, 9);
      this.gfx.fillStyle(0x2a2018, 0.5);
      this.gfx.fillEllipse(this.restX - w * 0.4, this.groundY - 1, w * 0.8, 5);
    }
  }

  destroy(): void {
    this.gfx.destroy();
    for (const ch of this.chunks) ch.img.destroy();
    for (const e of this.emitters) e.destroy();
    this.chunks = [];
    this.emitters = [];
    this.scene.time.timeScale = 1;
  }
}
