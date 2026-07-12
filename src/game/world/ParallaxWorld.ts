import Phaser from 'phaser';
import type { WeatherCondition } from '../../types';

/**
 * The whole flight environment, drawn procedurally every frame:
 * layered parallax terrain, weather-tinted palettes, runway zones with
 * threshold stripes and pulsing edge lights, a windsock, bird flocks,
 * and an altitude camera that "sinks" the world once the aircraft climbs
 * past the linear band so high altitude actually reads as high.
 */

export const ALT_BAND = 250;       // metres of altitude mapped linearly to screen
export const PLANE_MIN_Y = 160;    // screen y the aircraft pins to above the band

interface Palette {
  skyTop: number; skyBot: number; glow: number;
  far: number;
  mountain: number; mountainDark: number; snow: number;
  hill: number; hillLight: number;
  scrub: number;
  groundTop: number; ground: number; groundLine: number; dash: number;
}

const BASE: Palette = {
  skyTop: 0x1a3050, skyBot: 0xc88830, glow: 0xd07820,
  far: 0x1c2836,
  mountain: 0x28384a, mountainDark: 0x1a2838, snow: 0xc8d8e8,
  hill: 0x304020, hillLight: 0x3a5028,
  scrub: 0x241a0c,
  groundTop: 0x362614, ground: 0x2a1e0e, groundLine: 0x6a4820, dash: 0xa89050,
};

const WEATHER_PALETTES: Record<WeatherCondition, Partial<Palette>> = {
  clear: {},
  cloudy: { skyTop: 0x2a3648, skyBot: 0x8a8068, glow: 0x907048, snow: 0xb0bcc8 },
  strong_winds: { skyTop: 0x243244, skyBot: 0xb08858, glow: 0xb87838 },
  dust_storm: {
    skyTop: 0x6a4418, skyBot: 0xb87828, glow: 0xc88830,
    far: 0x5a3c1a, mountain: 0x6b4a24, mountainDark: 0x50361a, snow: 0x9a7a4a,
    hill: 0x5e4420, hillLight: 0x6e5228, scrub: 0x3a280e,
    groundTop: 0x4a3418, ground: 0x3a2810,
  },
  thunderstorm: {
    skyTop: 0x10141c, skyBot: 0x3a4250, glow: 0x40485a,
    far: 0x141a24, mountain: 0x1e2833, mountainDark: 0x131a22, snow: 0x8a98a8,
    hill: 0x1e2818, hillLight: 0x24301c, groundTop: 0x241a10, ground: 0x1c140a,
  },
  fog: {
    skyTop: 0x5a636b, skyBot: 0x8a9098, glow: 0x8a9098,
    far: 0x707880, mountain: 0x68727b, mountainDark: 0x5c666e, snow: 0x9aa4ac,
    hill: 0x5c665a, hillLight: 0x646e60, scrub: 0x4a4a42,
    groundTop: 0x565049, ground: 0x484440,
  },
  blizzard: {
    skyTop: 0x3a4654, skyBot: 0x8a98a8, glow: 0x8a98a8,
    far: 0x4c5a68, mountain: 0x5a6a7a, mountainDark: 0x48586a, snow: 0xe8eef4,
    hill: 0x6a7684, hillLight: 0x7c8894, scrub: 0x4a505a,
    groundTop: 0x707a86, ground: 0x5a6470, groundLine: 0x8a94a0, dash: 0x606a76,
  },
};

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

function resolve(c: WeatherCondition): Palette {
  return { ...BASE, ...WEATHER_PALETTES[c] };
}

// Deterministic per-index randomness for scattered ground props
function propRand(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export interface WorldFrame {
  scrollX: number;      // metres travelled (1 m = 1 px at ground parallax)
  altitude: number;     // metres
  windX: number;        // along-track wind, m/s (+ = tailwind)
  routeTotalKm: number; // contract distance; destination runway lives there
  condition: WeatherCondition;
}

export class ParallaxWorld {
  private readonly scene: Phaser.Scene;
  private readonly width: number;
  private readonly height: number;
  private readonly groundY: number;

  private readonly skyGfx: Phaser.GameObjects.Graphics;
  private readonly farGfx: Phaser.GameObjects.Graphics;
  private readonly mountainGfx: Phaser.GameObjects.Graphics;
  private readonly deckGfx: Phaser.GameObjects.Graphics;
  private readonly cloudGfx: Phaser.GameObjects.Graphics;
  private readonly hillGfx: Phaser.GameObjects.Graphics;
  private readonly scrubGfx: Phaser.GameObjects.Graphics;
  private readonly groundGfx: Phaser.GameObjects.Graphics;

  private fromPal: Palette = resolve('clear');
  private toPal: Palette = resolve('clear');
  private pal: Palette = resolve('clear');
  private blendT = 1;

  private t = 0;
  private readonly cloudOffsets = [0, 200, 450, 700, 900];

  constructor(scene: Phaser.Scene, width: number, height: number, groundY: number) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    this.groundY = groundY;

    // Creation order = draw order (back → front)
    this.skyGfx = scene.add.graphics();
    this.farGfx = scene.add.graphics();
    this.mountainGfx = scene.add.graphics();
    this.deckGfx = scene.add.graphics();
    this.cloudGfx = scene.add.graphics();
    this.hillGfx = scene.add.graphics();
    this.scrubGfx = scene.add.graphics();
    this.groundGfx = scene.add.graphics();
  }

  /** Blend the palette toward a weather condition over ~4 s. */
  setWeather(condition: WeatherCondition): void {
    this.fromPal = { ...this.pal };
    this.toPal = resolve(condition);
    this.blendT = 0;
  }

  /** Screen y for a given altitude (two-band camera). */
  altitudeToScreenY(altitude: number): number {
    const pxPerM = (this.groundY - PLANE_MIN_Y) / ALT_BAND;
    return altitude <= ALT_BAND
      ? this.groundY - altitude * pxPerM
      : PLANE_MIN_Y;
  }

  update(dt: number, f: WorldFrame): void {
    this.t += dt;

    // Palette blend
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / 4);
      const p = {} as Palette;
      for (const k of Object.keys(this.toPal) as Array<keyof Palette>) {
        p[k] = lerpColor(this.fromPal[k], this.toPal[k], this.blendT);
      }
      this.pal = p;
    }

    // Above the linear band the world sinks away beneath the aircraft
    const sink = Phaser.Math.Clamp((f.altitude - ALT_BAND) * 0.35, 0, 420);
    const hMult = Phaser.Math.Linear(1, 0.55, Phaser.Math.Clamp((f.altitude - ALT_BAND) / 2200, 0, 1));

    this.drawSky(f.altitude);
    this.drawFar(f.scrollX, sink * 0.30, hMult);
    this.drawMountains(f.scrollX, sink * 0.55, hMult);
    this.drawCloudDeck(f.altitude, f.scrollX);
    this.drawClouds(f.scrollX, f.altitude);
    this.drawHills(f.scrollX, sink * 0.8, f);
    this.drawScrub(f.scrollX, sink);
    this.drawGround(f.scrollX, sink, f);
  }

  destroy(): void {
    for (const g of [this.skyGfx, this.farGfx, this.mountainGfx, this.deckGfx,
      this.cloudGfx, this.hillGfx, this.scrubGfx, this.groundGfx]) g.destroy();
  }

  // ── Layers ─────────────────────────────────────────────────────────────────

  private drawSky(alt: number): void {
    const g = this.skyGfx;
    g.clear();

    // Altitude darkens the sky toward near-space navy
    const hiT = Phaser.Math.Clamp(alt / 3500, 0, 1);
    const top = lerpColor(this.pal.skyTop, 0x050a18, hiT);
    const bot = lerpColor(this.pal.skyBot, 0x18304a, hiT * 0.85);

    g.fillGradientStyle(top, top, bot, bot, 1);
    g.fillRect(0, 0, this.width, this.height);

    // Warm horizon band, fading with altitude
    const glowAlpha = Math.max(0, 1 - alt / 260) * 0.4;
    if (glowAlpha > 0.01) {
      g.fillStyle(this.pal.glow, glowAlpha);
      g.fillRect(0, this.groundY - 80, this.width, 80);
    }

    // Stars fade in when very high
    if (hiT > 0.55) {
      const a = (hiT - 0.55) / 0.45;
      for (let i = 0; i < 40; i++) {
        const sx = (propRand(i) * this.width * 1.3 + i * 37) % this.width;
        const sy = propRand(i + 100) * this.height * 0.5;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(this.t * (0.5 + propRand(i + 200)) + i));
        g.fillStyle(0xfff4e0, a * tw * 0.5);
        g.fillRect(sx, sy, 1.5, 1.5);
      }
    }
  }

  private drawFar(scrollX: number, sink: number, hMult: number): void {
    const g = this.farGfx;
    g.clear();
    const baseY = this.groundY + sink;
    const period = 1600;
    const ridges = [
      { x: 0, h: 70 }, { x: 260, h: 110 }, { x: 520, h: 80 },
      { x: 800, h: 130 }, { x: 1100, h: 90 }, { x: 1380, h: 115 },
    ];
    for (let rep = -1; rep <= 2; rep++) {
      const bx = rep * period - ((scrollX * 0.03) % period);
      for (const { x, h } of ridges) {
        const mx = bx + x;
        if (mx < -200 || mx > this.width + 200) continue;
        g.fillStyle(this.pal.far, 0.75);
        g.fillTriangle(mx - 170, baseY, mx, baseY - h * hMult, mx + 170, baseY);
      }
    }
  }

  private drawMountains(scrollX: number, sink: number, hMult: number): void {
    const g = this.mountainGfx;
    g.clear();
    const baseY = this.groundY + sink;

    const peaks = [
      { x: 0, h: 100 }, { x: 160, h: 170 }, { x: 310, h: 115 },
      { x: 480, h: 195 }, { x: 650, h: 135 }, { x: 820, h: 180 },
      { x: 980, h: 100 }, { x: 1150, h: 155 },
    ];
    const period = 1200;

    for (let rep = -1; rep <= 2; rep++) {
      const baseX = rep * period - ((scrollX * 0.06) % period);
      for (const { x, h } of peaks) {
        const mx = baseX + x;
        if (mx < -120 || mx > this.width + 120) continue;
        const hh = h * hMult;
        g.fillStyle(this.pal.mountain, 0.85);
        g.fillTriangle(mx - 90, baseY, mx, baseY - hh, mx + 90, baseY);
        g.fillStyle(this.pal.mountainDark, 0.6);
        g.fillTriangle(mx, baseY - hh, mx + 90, baseY, mx + 10, baseY - hh * 0.4);
        if (h > 120) {
          g.fillStyle(this.pal.snow, 0.55);
          g.fillTriangle(mx - 22 * hMult, baseY - hh + 42 * hMult, mx, baseY - hh, mx + 22 * hMult, baseY - hh + 42 * hMult);
        }
      }
    }
  }

  /** High-altitude cloud deck: the tops of the weather layer, far below. */
  private drawCloudDeck(alt: number, scrollX: number): void {
    const g = this.deckGfx;
    g.clear();
    const a = Phaser.Math.Clamp((alt - 450) / 500, 0, 1) * 0.5;
    if (a <= 0.01) return;

    const y = this.groundY - 30;
    g.fillStyle(0xd8dce2, a * 0.5);
    g.fillRect(0, y + 26, this.width, this.height - y);
    const period = 900;
    for (let rep = -1; rep <= 2; rep++) {
      const bx = rep * period - ((scrollX * 0.12) % period);
      for (let i = 0; i < 5; i++) {
        const cx = bx + i * 180 + (i % 2) * 60;
        g.fillStyle(0xe4e8ee, a);
        g.fillEllipse(cx, y + 20 + (i % 3) * 8, 220, 30);
      }
    }
  }

  private drawClouds(scrollX: number, alt: number): void {
    const g = this.cloudGfx;
    g.clear();
    if (alt < 50) return;

    const alpha = Math.min(alt / 200, 0.85) * 0.15;
    g.fillStyle(0xffffff, alpha);

    const baseY = this.groundY * 0.35;
    for (let i = 0; i < this.cloudOffsets.length; i++) {
      const span = this.width + 300;
      const ox = ((this.cloudOffsets[i] - scrollX * 0.05) % span + span) % span - 150;
      const oy = baseY + (i % 3) * 40;
      const w = 80 + (i % 3) * 40;
      g.fillEllipse(ox, oy, w, 28);
      g.fillEllipse(ox + 30, oy - 12, w * 0.7, 22);
      g.fillEllipse(ox - 20, oy - 8, w * 0.5, 18);
    }
  }

  private drawHills(scrollX: number, sink: number, f: WorldFrame): void {
    const g = this.hillGfx;
    g.clear();
    const baseY = this.groundY + sink;

    const hills = [
      { x: 0, h: 55, w: 160 }, { x: 220, h: 75, w: 190 },
      { x: 450, h: 50, w: 140 }, { x: 640, h: 85, w: 210 },
      { x: 870, h: 60, w: 170 }, { x: 1080, h: 70, w: 180 },
    ];
    const period = 1200;

    for (let rep = -1; rep <= 2; rep++) {
      const baseX = rep * period - ((scrollX * 0.22) % period);
      for (const { x, h, w } of hills) {
        const mx = baseX + x;
        if (mx < -150 || mx > this.width + 150) continue;
        g.fillStyle(this.pal.hill, 1);
        g.fillTriangle(mx - w / 2, baseY, mx, baseY - h, mx + w / 2, baseY);
        g.fillStyle(this.pal.hillLight, 0.5);
        g.fillTriangle(mx - w * 0.15, baseY - h + 15, mx, baseY - h, mx + w * 0.15, baseY - h + 15);
      }
    }

    // Bird flocks in fair weather, low altitude
    if ((f.condition === 'clear' || f.condition === 'cloudy') && f.altitude > 20 && sink < 60) {
      const period2 = 1500;
      for (let rep = 0; rep <= 1; rep++) {
        const fx = ((rep * period2 + 400 - scrollX * 0.4) % (period2 * 2) + period2 * 2) % (period2 * 2) - 200;
        if (fx < -100 || fx > this.width + 100) continue;
        const fy = this.groundY - 250 + Math.sin(this.t * 0.6 + rep * 3) * 22;
        g.lineStyle(1.4, 0x14100c, 0.8);
        for (let b = 0; b < 5; b++) {
          const bx = fx + b * 14 + (b % 2) * 6;
          const by = fy + (b % 3) * 8;
          const flap = Math.sin(this.t * 7 + b) * 3;
          g.lineBetween(bx - 4, by - flap, bx, by + 2);
          g.lineBetween(bx, by + 2, bx + 4, by - flap);
        }
      }
    }
  }

  /** Near-foreground strip of seeded wasteland props: rocks, dead trees, wrecks. */
  private drawScrub(scrollX: number, sink: number): void {
    const g = this.scrubGfx;
    g.clear();
    const baseY = this.groundY + sink;
    if (baseY > this.height + 30) return;

    const spacing = 240;
    const scroll = scrollX * 0.55;
    const first = Math.floor((scroll - 100) / spacing);
    for (let i = first; i < first + Math.ceil(this.width / spacing) + 2; i++) {
      const sx = i * spacing - scroll + (propRand(i) - 0.5) * 120;
      if (sx < -60 || sx > this.width + 60) continue;
      const kind = Math.floor(propRand(i + 50) * 4);
      const s = 0.7 + propRand(i + 90) * 0.7;
      g.fillStyle(this.pal.scrub, 1);
      g.lineStyle(2 * s, this.pal.scrub, 1);
      switch (kind) {
        case 0: // rocks
          g.fillTriangle(sx - 10 * s, baseY, sx - 2 * s, baseY - 8 * s, sx + 6 * s, baseY);
          g.fillTriangle(sx, baseY, sx + 6 * s, baseY - 5 * s, sx + 13 * s, baseY);
          break;
        case 1: // dead tree
          g.lineBetween(sx, baseY, sx, baseY - 22 * s);
          g.lineBetween(sx, baseY - 14 * s, sx + 8 * s, baseY - 20 * s);
          g.lineBetween(sx, baseY - 9 * s, sx - 7 * s, baseY - 15 * s);
          break;
        case 2: // aircraft wreck silhouette
          g.fillRect(sx - 14 * s, baseY - 5 * s, 28 * s, 5 * s);
          g.fillTriangle(sx - 2 * s, baseY - 5 * s, sx + 8 * s, baseY - 14 * s, sx + 10 * s, baseY - 5 * s);
          break;
        default: // scrub brush
          for (let b = 0; b < 3; b++) {
            g.fillCircle(sx + (b - 1) * 5 * s, baseY - 3 * s, 3 * s);
          }
      }
    }
  }

  private drawGround(scrollX: number, sink: number, f: WorldFrame): void {
    const g = this.groundGfx;
    g.clear();
    const gy = this.groundY + sink;
    if (gy > this.height + 10) return;

    // Ground body
    g.fillStyle(this.pal.ground, 1);
    g.fillRect(0, gy, this.width, this.height - gy + 10);
    g.fillStyle(this.pal.groundTop, 1);
    g.fillRect(0, gy, this.width, 18);
    g.lineStyle(2, this.pal.groundLine, 1);
    g.lineBetween(0, gy, this.width, gy);

    // Texture lines
    g.lineStyle(1, lerpColor(this.pal.ground, 0xffffff, 0.08), 0.3);
    for (let i = 1; i <= 3; i++) g.lineBetween(0, gy + i * 22, this.width, gy + i * 22);

    // Runway zones — origin at world 0, destination at the contract distance
    const destM = Math.max(2000, f.routeTotalKm * 1000);
    this.drawRunway(g, -320, 760, scrollX, gy, f);
    this.drawRunway(g, destM - 460, destM + 620, scrollX, gy, f);

    // Cracks / ruts between runways so open terrain isn't sterile
    const spacing = 170;
    const first = Math.floor((scrollX - 60) / spacing);
    for (let i = first; i < first + Math.ceil(this.width / spacing) + 1; i++) {
      const wx = i * spacing + propRand(i + 13) * 80;
      if (wx > -320 && wx < 760) continue;
      if (wx > destM - 460 && wx < destM + 620) continue;
      const sx = wx - scrollX;
      if (sx < -40 || sx > this.width + 40) continue;
      g.lineStyle(1.5, 0x000000, 0.18);
      g.lineBetween(sx, gy + 6 + propRand(i + 7) * 10, sx + 26 + propRand(i) * 30, gy + 8 + propRand(i + 3) * 12);
    }
  }

  private drawRunway(
    g: Phaser.GameObjects.Graphics,
    fromM: number,
    toM: number,
    scrollX: number,
    gy: number,
    f: WorldFrame,
  ): void {
    const x0 = fromM - scrollX;
    const x1 = toM - scrollX;
    if (x1 < -60 || x0 > this.width + 60) return;

    const sx0 = Math.max(-60, x0);
    const sx1 = Math.min(this.width + 60, x1);

    // Slab
    g.fillStyle(0x1c1c1a, 0.9);
    g.fillRect(sx0, gy + 1, sx1 - sx0, 13);
    g.lineStyle(1, 0x3a3a36, 0.8);
    g.lineBetween(sx0, gy + 14, sx1, gy + 14);

    // Threshold stripes at both ends
    for (const endX of [x0 + 14, x1 - 96]) {
      for (let i = 0; i < 6; i++) {
        const tx = endX + i * 15;
        if (tx < -20 || tx > this.width + 20) continue;
        g.fillStyle(0xc8c0a8, 0.75);
        g.fillRect(tx, gy + 3, 7, 9);
      }
    }

    // Centreline dashes
    g.fillStyle(this.pal.dash, 0.65);
    const dashW = 26, gap = 34;
    for (let wx = fromM + 120; wx < toM - 110; wx += dashW + gap) {
      const dx = wx - scrollX;
      if (dx < -40 || dx > this.width + 40) continue;
      g.fillRect(dx, gy + 7, dashW, 2.5);
    }

    // Pulsing edge lights
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3.2);
    for (let wx = fromM + 30; wx < toM - 20; wx += 92) {
      const lx = wx - scrollX;
      if (lx < -10 || lx > this.width + 10) continue;
      g.fillStyle(0xffb350, 0.35 + pulse * 0.45);
      g.fillCircle(lx, gy + 2, 1.8);
    }

    // Windsock near the far threshold — the landing aid
    const sockX = x1 - 150;
    if (sockX > -20 && sockX < this.width + 20) {
      const poleTop = gy - 20;
      g.lineStyle(2, 0x8a8578, 1);
      g.lineBetween(sockX, gy + 1, sockX, poleTop);
      // Sock points downwind, droops when calm
      const wind = f.windX;
      const dir = wind >= 0 ? 1 : -1;
      const strength = Phaser.Math.Clamp(Math.abs(wind) / 12, 0, 1);
      const droop = Phaser.Math.Linear(14, 2, strength);
      const len = 16 + strength * 8;
      const flap = Math.sin(this.t * (4 + strength * 6)) * (2 - strength);
      g.fillStyle(0xc06030, 0.95);
      g.fillTriangle(
        sockX, poleTop,
        sockX, poleTop + 7,
        sockX + dir * len, poleTop + droop + flap,
      );
    }
  }
}
