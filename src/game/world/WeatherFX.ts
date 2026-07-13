import Phaser from 'phaser';
import type { WeatherCondition } from '../../types';

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
  private readonly width: number;
  private readonly height: number;

  private readonly overlay: Phaser.GameObjects.Rectangle;
  private readonly flash: Phaser.GameObjects.Rectangle;
  private readonly fogGfx: Phaser.GameObjects.Graphics;
  private readonly rain: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private readonly snow: Phaser.GameObjects.Particles.ParticleEmitter;

  private current: ConditionFX = FX.clear;
  private previous: ConditionFX = FX.clear;
  private blend = 1;

  private t = 0;
  private nextLightningIn = 4;
  private flashLeft = 0;

  constructor(scene: Phaser.Scene, width: number, height: number) {
    this.scene = scene;
    this.width = width;
    this.height = height;

    this.rain = scene.add.particles(0, 0, 'px_streak', {
      x: { min: -100, max: width + 100 },
      y: -12,
      lifespan: 1300,
      speedY: { min: 520, max: 640 },
      speedX: { min: -60, max: -30 },
      rotate: 79,
      scaleX: 0.9,
      scaleY: 0.5,
      alpha: { start: 0.45, end: 0.15 },
      tint: 0x9ab4cc,
      frequency: 7,
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
      x: { min: -100, max: width + 100 },
      y: -12,
      lifespan: 2600,
      speedY: { min: 160, max: 260 },
      speedX: { min: -260, max: -140 },
      scale: { min: 0.08, max: 0.22 },
      alpha: { start: 0.8, end: 0.3 },
      tint: 0xf0f6fc,
      frequency: 6,
      emitting: false,
    }).setDepth(FX_DEPTH);

    this.fogGfx = scene.add.graphics().setDepth(FX_DEPTH);

    this.overlay = scene.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0)
      .setDepth(FX_DEPTH + 0.5);
    this.flash = scene.add.rectangle(width / 2, height / 2, width, height, 0xffffff, 0)
      .setDepth(FX_DEPTH + 0.6);
  }

  setCondition(condition: WeatherCondition): void {
    this.previous = this.mixed();
    this.current = FX[condition];
    this.blend = 0;

    if (this.current.rain) this.rain.start(); else this.rain.stop();
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

  update(dt: number): void {
    this.t += dt;
    this.blend = Math.min(1, this.blend + dt / BLEND_SECONDS);

    // Visibility overlay
    const alpha = Phaser.Math.Linear(this.previous.overlayAlpha, this.current.overlayAlpha, this.blend);
    this.overlay.setFillStyle(this.current.overlayColor, alpha);

    // Drifting fog banks
    this.fogGfx.clear();
    if (this.current.fogBanks) {
      const a = this.blend * 0.22;
      for (let i = 0; i < 3; i++) {
        const fx = ((this.t * (12 + i * 7) + i * 400) % (this.width + 600)) - 300;
        const fy = this.height * (0.3 + i * 0.22) + Math.sin(this.t * 0.4 + i * 2) * 16;
        this.fogGfx.fillStyle(0xc2cad0, a);
        this.fogGfx.fillEllipse(this.width - fx, fy, 460, 70 + i * 24);
        this.fogGfx.fillEllipse(this.width - fx + 180, fy + 22, 320, 50);
      }
    }

    // Lightning — brief and soft; it should read as distant weather, not strobe
    if (this.current.lightning) {
      this.nextLightningIn -= dt;
      if (this.nextLightningIn <= 0) {
        this.flashLeft = 0.1;
        this.nextLightningIn = 4 + Math.random() * 9;
        this.scene.cameras.main.shake(120, 0.003);
      }
    }
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      this.flash.setFillStyle(0xffffff, Math.max(0, this.flashLeft / 0.1) * 0.3);
    } else if (this.flash.fillAlpha > 0) {
      this.flash.setFillStyle(0xffffff, 0);
    }
  }

  destroy(): void {
    this.rain.destroy();
    this.dust.destroy();
    this.snow.destroy();
    this.fogGfx.destroy();
    this.overlay.destroy();
    this.flash.destroy();
  }
}
