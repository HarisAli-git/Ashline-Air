import Phaser from 'phaser';
import type { WeatherCondition } from '../../types';
import { SoundEngine } from '../audio/SoundEngine';
import { ensureSharedTextures, PUFF_TEX } from '../entities/aircraft/render/AircraftPainter';

/**
 * Screen-space weather visuals: precipitation emitters, drifting fog banks,
 * dust bands, lightning, and a full-screen visibility overlay. Everything
 * lerps in/out over ~4 s on condition changes. Renders above the world and
 * aircraft, below the in-canvas HUD (depth 8 vs HUD depth 10).
 */

const FX_DEPTH = 8;
const BLEND_SECONDS = 4;

interface ConditionFX {
  overlayColor: number;
  overlayAlpha: number; // at full intensity
  rain: boolean;
  dust: boolean;
  snow: boolean;
  fogBanks: boolean;
  lightning: boolean;
}

const FX: Record<WeatherCondition, ConditionFX> = {
  clear:        { overlayColor: 0x000000, overlayAlpha: 0,    rain: false, dust: false, snow: false, fogBanks: false, lightning: false },
  cloudy:       { overlayColor: 0x30363e, overlayAlpha: 0.08, rain: false, dust: false, snow: false, fogBanks: false, lightning: false },
  strong_winds: { overlayColor: 0x9a7848, overlayAlpha: 0.06, rain: false, dust: true,  snow: false, fogBanks: false, lightning: false },
  dust_storm:   { overlayColor: 0xa06a20, overlayAlpha: 0.34, rain: false, dust: true,  snow: false, fogBanks: false, lightning: false },
  thunderstorm: { overlayColor: 0x10141c, overlayAlpha: 0.28, rain: true,  dust: false, snow: false, fogBanks: false, lightning: true },
  fog:          { overlayColor: 0xaab2b8, overlayAlpha: 0.42, rain: false, dust: false, snow: false, fogBanks: true,  lightning: false },
  blizzard:     { overlayColor: 0xc8d4de, overlayAlpha: 0.30, rain: false, dust: false, snow: true,  fogBanks: false, lightning: false },
};

export class WeatherFX {
  private readonly scene: Phaser.Scene;
  private width: number;   // mutable: see resize()
  private height: number;   // mutable: see resize()

  private readonly overlay: Phaser.GameObjects.Rectangle;
  private readonly flash: Phaser.GameObjects.Rectangle;
  private readonly fogGfx: Phaser.GameObjects.Graphics;
  private readonly rain: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly rainNear: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly snow: Phaser.GameObjects.Particles.ParticleEmitter;

  private current: ConditionFX = FX.clear;
  private previous: ConditionFX = FX.clear;
  private blend = 1;

  private t = 0;
  private nextLightningIn = 4;
  private flashLeft = 0;
  private boltGfx!: Phaser.GameObjects.Graphics;
  private bolt: Array<[number, number]> = [];
  private boltBranches: Array<Array<[number, number]>> = [];
  /**
   * How fast the world is sliding past, screen px/s (+ = flying right), low-
   * passed. Precipitation is in the air the aeroplane is moving through, so it
   * streams past at the aeroplane's speed: rain slants back across the screen
   * when you are quick and falls nearly straight when you are slow.
   */
  private flow = 0;
  /** Soft drifting fog banks; empty without a canvas to paint them. */
  private readonly fogBanks: Phaser.GameObjects.Image[] = [];
  /** Distance the air has streamed past, px — moves the fog with the flight. */
  private fogScroll = 0;

  /** Re-fit to a new canvas size; all effects are drawn per frame from these. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  constructor(scene: Phaser.Scene, width: number, height: number) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    ensureSharedTextures(scene);

    /*
     * Rain in two sheets. Every drop is emitted from wherever it has to start
     * to fall through the screen with the slant the current airspeed gives it,
     * and is turned to point the way it is falling. (The streaks used to lean
     * the opposite way to their own motion, and were the solid bar the sparks
     * use — at rain size, falling sticks.)
     */
    const sheet = (vy: [number, number], drift: number, base: number, life: number) => ({
      x: { onEmit: (): number => {
        const vx = -(base + this.flow * drift);
        const reach = -vx * (life / 1000);
        const lo = Math.min(-100, -100 + reach), hi = Math.max(width + 100, width + 100 + reach);
        return lo + Math.random() * (hi - lo);
      } },
      speedX: { onEmit: (): number => -(base + this.flow * drift) * (0.9 + Math.random() * 0.2) },
      speedY: { min: vy[0], max: vy[1] },
      rotate: { onEmit: (): number => Phaser.Math.RadToDeg(Math.atan2((vy[0] + vy[1]) / 2, -(base + this.flow * drift))) },
    });
    this.rain = scene.add.particles(0, 0, 'px_rain', {
      ...sheet([520, 640], 0.45, 40, 1300),
      y: -12,
      lifespan: 1300,
      scaleX: { min: 0.42, max: 0.62 },
      scaleY: 0.55,
      alpha: { start: 0.34, end: 0.12 },
      tint: 0x9ab4cc,
      frequency: 5,
      emitting: false,
    }).setDepth(FX_DEPTH);

    this.dust = scene.add.particles(0, 0, 'px_soft', {
      x: width + 40,
      y: { min: 0, max: height },
      lifespan: 1600,
      speedX: { min: -720, max: -420 },
      speedY: { min: -40, max: 40 },
      scale: { min: 0.5, max: 1.6 },
      alpha: { start: 0.16, end: 0 },
      tint: 0xb08040,
      frequency: 9,
      emitting: false,
    }).setDepth(FX_DEPTH);

    this.snow = scene.add.particles(0, 0, 'px_soft', {
      x: { onEmit: (): number => {
        const reach = (200 + this.flow * 0.55) * 2.6;
        const lo = Math.min(-100, -100 + reach), hi = Math.max(width + 100, width + 100 + reach);
        return lo + Math.random() * (hi - lo);
      } },
      y: -12,
      lifespan: 2600,
      speedY: { min: 160, max: 260 },
      speedX: { onEmit: (): number => -(140 + Math.random() * 120 + this.flow * 0.55) },
      scale: { min: 0.08, max: 0.22 },
      alpha: { start: 0.8, end: 0.3 },
      tint: 0xf0f6fc,
      frequency: 6,
      emitting: false,
    }).setDepth(FX_DEPTH);

    // Near sheet — longer, faster, brighter: gives the rain real depth
    this.rainNear = scene.add.particles(0, 0, 'px_rain', {
      ...sheet([780, 950], 0.85, 70, 900),
      y: -16,
      lifespan: 900,
      scaleX: { min: 0.8, max: 1.1 },
      scaleY: 0.8,
      alpha: { start: 0.42, end: 0.16 },
      tint: 0xc2d6e8,
      frequency: 9,
      emitting: false,
    }).setDepth(FX_DEPTH + 0.4);

    this.fogGfx = scene.add.graphics().setDepth(FX_DEPTH);
    if (scene.textures.exists(PUFF_TEX)) {
      for (let i = 0; i < 7; i++) {
        this.fogBanks.push(scene.add.image(0, 0, PUFF_TEX, `p${i % 4}`)
          .setDepth(FX_DEPTH).setTint(0xc2cad0).setVisible(false));
      }
    }
    this.boltGfx = scene.add.graphics().setDepth(FX_DEPTH + 0.55);

    this.overlay = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0)
      .setDepth(FX_DEPTH + 0.5);
    this.flash = scene.add.rectangle(width / 2, height / 2, width, height, 0xffffff, 0)
      .setDepth(FX_DEPTH + 0.6);
  }

  setCondition(condition: WeatherCondition): void {
    this.previous = this.mixed();
    this.current = FX[condition];
    this.blend = 0;

    if (this.current.rain) { this.rain.start(); this.rainNear.start(); }
    else { this.rain.stop(); this.rainNear.stop(); }
    if (this.current.dust) this.dust.start(); else this.dust.stop();
    if (this.current.snow) this.snow.start(); else this.snow.stop();
  }

  /** Effective FX values at the current blend point (for overlay lerping). */
  private mixed(): ConditionFX {
    const t = this.blend;
    return {
      ...this.current,
      overlayColor: this.current.overlayColor,
      overlayAlpha: Phaser.Math.Linear(this.previous.overlayAlpha, this.current.overlayAlpha, t),
    };
  }

  /**
   * @param scrollSpeed how fast the world is sliding past, screen px/s
   *                    (+ = the aeroplane flying right). Drives the slant.
   */
  update(dt: number, scrollSpeed = 0): void {
    this.t += dt;
    this.blend = Math.min(1, this.blend + dt / BLEND_SECONDS);
    // Eased, so a turn or a touchdown swings the slant round rather than snapping it
    this.flow += (Phaser.Math.Clamp(scrollSpeed, -900, 900) - this.flow) * Math.min(1, dt * 2.5);

    // Visibility overlay
    const alpha = Phaser.Math.Linear(this.previous.overlayAlpha, this.current.overlayAlpha, this.blend);
    this.overlay.setFillStyle(this.current.overlayColor, alpha);

    /*
     * Drifting fog banks. They were hard-edged ellipses at 22% — three pale
     * plates sliding across the screen. Now each bank is a few soft lumps of
     * mist, drifting at their own pace and streaming past with the airspeed
     * like everything else in the air.
     */
    this.fogGfx.clear();
    const fogA = this.current.fogBanks ? this.blend : this.previous.fogBanks ? 1 - this.blend : 0;
    if (this.fogBanks.length) {
      const span = this.width + 900;
      for (let i = 0; i < this.fogBanks.length; i++) {
        const img = this.fogBanks[i];
        if (fogA <= 0.01) { if (img.visible) img.setVisible(false); continue; }
        const lane = i % 3;
        const travel = this.t * (14 + lane * 9 + i * 2) + this.fogScroll * (0.5 + lane * 0.2) + i * 380;
        const fx = this.width + 450 - (((travel % span) + span) % span);
        const fy = this.height * (0.26 + lane * 0.24) + Math.sin(this.t * 0.35 + i * 1.7) * 18 + (i > 2 ? 26 : 0);
        img.setPosition(fx, fy)
          .setDisplaySize(420 + (i % 4) * 90, 110 + lane * 30)
          .setAlpha(fogA * (0.42 - lane * 0.06))
          .setVisible(true);
      }
    } else if (this.current.fogBanks) {
      const a = this.blend * 0.22;
      for (let i = 0; i < 3; i++) {
        const fx = ((this.t * (12 + i * 7) + i * 400) % (this.width + 600)) - 300;
        const fy = this.height * (0.3 + i * 0.22) + Math.sin(this.t * 0.4 + i * 2) * 16;
        this.fogGfx.fillStyle(0xc2cad0, a);
        this.fogGfx.fillEllipse(this.width - fx, fy, 460, 70 + i * 24);
        this.fogGfx.fillEllipse(this.width - fx + 180, fy + 22, 320, 50);
      }
    }
    this.fogScroll += this.flow * dt;

    // Lightning — brief and soft; it should read as distant weather, not strobe
    if (this.current.lightning) {
      this.nextLightningIn -= dt;
      if (this.nextLightningIn <= 0) {
        this.flashLeft = 0.16;
        this.nextLightningIn = 4 + Math.random() * 9;
        this.scene.cameras.main.shake(120, 0.003);
        SoundEngine.thunder();
        this.strike();
      }
    }
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      const k = Math.max(0, this.flashLeft / 0.16);
      this.flash.setFillStyle(0xffffff, k * 0.26);
      // Draw the bolt itself while the flash lasts
      this.boltGfx.clear();
      const a = Math.min(1, k * 1.6);
      this.boltGfx.lineStyle(4.5, 0xffffff, a * 0.25);
      this.strokePath(this.bolt);
      this.boltGfx.lineStyle(1.8, 0xf2f6ff, a);
      this.strokePath(this.bolt);
      this.boltGfx.lineStyle(1, 0xdfe8ff, a * 0.7);
      for (const b of this.boltBranches) this.strokePath(b);
    } else if (this.flash.fillAlpha > 0) {
      this.flash.setFillStyle(0xffffff, 0);
      this.boltGfx.clear();
    }
  }

  /** Build a jagged bolt with a couple of branches. */
  private strike(): void {
    const x0 = 80 + Math.random() * (this.width - 160);
    const yEnd = this.height * (0.55 + Math.random() * 0.3);
    this.bolt = [[x0, -10]];
    let x = x0, y = -10;
    while (y < yEnd) {
      y += 18 + Math.random() * 26;
      x += (Math.random() - 0.5) * 46;
      this.bolt.push([x, y]);
    }
    this.boltBranches = [];
    for (let b = 0; b < 2; b++) {
      const i = 1 + Math.floor(Math.random() * Math.max(1, this.bolt.length - 2));
      let [bx, by] = this.bolt[i];
      const branch: Array<[number, number]> = [[bx, by]];
      const dir = Math.random() < 0.5 ? -1 : 1;
      for (let s = 0; s < 3; s++) {
        bx += dir * (10 + Math.random() * 24);
        by += 12 + Math.random() * 20;
        branch.push([bx, by]);
      }
      this.boltBranches.push(branch);
    }
  }

  private strokePath(pts: Array<[number, number]>): void {
    if (pts.length < 2) return;
    this.boltGfx.beginPath();
    this.boltGfx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i][0], pts[i][1]);
    this.boltGfx.strokePath();
  }

  destroy(): void {
    this.boltGfx.destroy();
    this.rain.destroy();
    this.rainNear.destroy();
    this.dust.destroy();
    this.snow.destroy();
    this.fogGfx.destroy();
    for (const f of this.fogBanks) f.destroy();
    this.fogBanks.length = 0;
    this.overlay.destroy();
    this.flash.destroy();
  }
}
