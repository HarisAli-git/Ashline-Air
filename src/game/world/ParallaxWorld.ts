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
/** World px per metre flown — high so speed genuinely reads on screen. */
export const WORLD_PX_PER_M = 6;

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

/**
 * Multi-octave ridge profile, continuous in world space — no tiling, no
 * repeating triangles. Returns roughly -1..1.
 */
function ridge(x: number, seed: number): number {
  return (
    Math.sin(x * 0.0019 + seed) * 0.45 +
    Math.sin(x * 0.0047 + seed * 2.7) * 0.30 +
    Math.sin(x * 0.0113 + seed * 5.1) * 0.16 +
    Math.sin(x * 0.0257 + seed * 9.3) * 0.09
  );
}

export interface WorldFrame {
  scrollX: number;      // world px travelled
  altitude: number;     // metres
  windX: number;        // along-track wind, m/s (+ = tailwind)
  routeTotalKm: number; // contract distance; destination runway lives there
  condition: WeatherCondition;
  minutesOfDay: number; // world-clock minutes 0–1439, drives the day/night cycle
  visibility: number;   // 0–1 from weather, dims the sun/moon
}

/** 0 = deep night, 1 = full day. Dawn 05:00–07:00, dusk 18:00–20:00. */
function daylight(minutes: number): number {
  const m = ((minutes % 1440) + 1440) % 1440;
  if (m < 300 || m >= 1200) return 0;
  if (m < 420) return (m - 300) / 120;
  if (m < 1080) return 1;
  return 1 - (m - 1080) / 120;
}

/** Push a palette colour toward deep night blue as daylight fades. */
function applyDaylight(c: number, dl: number): number {
  const night = lerpColor(c, 0x070a14, 0.82);
  return lerpColor(night, c, 0.22 + 0.78 * dl);
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
  private weatherPal: Palette = resolve('clear'); // weather-blended, daylight-agnostic
  private pal: Palette = resolve('clear');        // final: weather + time of day
  private blendT = 1;
  private dl = 1; // current daylight factor

  private t = 0;
  private readonly cloudOffsets = [0, 200, 450, 700, 900];
  private readonly skids: number[] = []; // world-px of touchdown tire marks

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
    this.fromPal = { ...this.weatherPal };
    this.toPal = resolve(condition);
    this.blendT = 0;
  }

  /** Leave a persistent tire mark on the ground where the wheels touched. */
  addSkidMark(worldPx: number): void {
    this.skids.push(worldPx);
    if (this.skids.length > 24) this.skids.shift();
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

    // Weather palette blend, then day/night grading on top
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / 4);
      const p = {} as Palette;
      for (const k of Object.keys(this.toPal) as Array<keyof Palette>) {
        p[k] = lerpColor(this.fromPal[k], this.toPal[k], this.blendT);
      }
      this.weatherPal = p;
    }
    this.dl = daylight(f.minutesOfDay);
    const graded = {} as Palette;
    for (const k of Object.keys(this.weatherPal) as Array<keyof Palette>) {
      graded[k] = applyDaylight(this.weatherPal[k], this.dl);
    }
    this.pal = graded;

    // Above the linear band the world sinks away beneath the aircraft
    const sink = Phaser.Math.Clamp((f.altitude - ALT_BAND) * 0.35, 0, 420);
    const hMult = Phaser.Math.Linear(1, 0.55, Phaser.Math.Clamp((f.altitude - ALT_BAND) / 2200, 0, 1));

    this.drawSky(f);
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

  private drawSky(f: WorldFrame): void {
    const g = this.skyGfx;
    const alt = f.altitude;
    const dl = this.dl;
    g.clear();

    // Altitude darkens the sky toward near-space navy
    const hiT = Phaser.Math.Clamp(alt / 3500, 0, 1);
    const top = lerpColor(this.pal.skyTop, 0x030710, hiT);
    const bot = lerpColor(this.pal.skyBot, 0x122436, hiT * 0.85);

    g.fillGradientStyle(top, top, bot, bot, 1);
    g.fillRect(0, 0, this.width, this.height);

    // Sun arcs across the sky through the day, dimmed by bad weather
    const vis = Phaser.Math.Clamp(f.visibility, 0.12, 1);
    if (dl > 0.04) {
      const sunT = Phaser.Math.Clamp((f.minutesOfDay - 300) / 900, 0, 1);
      const sx = this.width * (0.08 + 0.84 * sunT);
      const sy = this.groundY - Math.sin(sunT * Math.PI) * (this.groundY - 110) - 16;
      const sa = dl * vis;
      // Low sun is redder
      const lowSun = 1 - Math.sin(sunT * Math.PI);
      const sunCol = lerpColor(0xfff2cc, 0xff9a50, lowSun * 0.8);
      g.fillStyle(sunCol, 0.08 * sa); g.fillCircle(sx, sy, 52);
      g.fillStyle(sunCol, 0.16 * sa); g.fillCircle(sx, sy, 32);
      g.fillStyle(sunCol, 0.9 * sa);  g.fillCircle(sx, sy, 16);
    }

    // Moon rides the night arc, with a crescent bite
    if (dl < 0.5) {
      const m = f.minutesOfDay;
      const nm = m >= 1200 ? m - 1200 : m + 240; // 0..540 across 20:00–05:00
      const mT = Phaser.Math.Clamp(nm / 540, 0, 1);
      const mx = this.width * (0.1 + 0.8 * mT);
      const my = this.groundY - Math.sin(mT * Math.PI) * (this.groundY - 130) - 20;
      const ma = (1 - dl * 2) * vis;
      if (ma > 0.02) {
        g.fillStyle(0xd8e2ec, 0.12 * ma); g.fillCircle(mx, my, 26);
        g.fillStyle(0xe8eef6, 0.9 * ma);  g.fillCircle(mx, my, 12);
        g.fillStyle(top, 0.95 * ma);      g.fillCircle(mx + 5, my - 3, 10);
      }
    }

    // Warm horizon band, fading with altitude and daylight
    const glowAlpha = Math.max(0, 1 - alt / 260) * 0.4 * (0.2 + 0.8 * dl);
    if (glowAlpha > 0.01) {
      g.fillStyle(this.pal.glow, glowAlpha);
      g.fillRect(0, this.groundY - 80, this.width, 80);
    }

    // Stars: out at night, and again near the edge of the sky when very high
    const starA = Math.max(hiT > 0.55 ? (hiT - 0.55) / 0.45 : 0, (1 - dl) * vis);
    if (starA > 0.03) {
      for (let i = 0; i < 54; i++) {
        const sx = (propRand(i) * this.width * 1.3 + i * 37) % this.width;
        const sy = propRand(i + 100) * this.height * 0.55;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(this.t * (0.5 + propRand(i + 200)) + i));
        g.fillStyle(0xfff4e0, starA * tw * 0.55);
        g.fillRect(sx, sy, 1.5, 1.5);
      }
    }
  }

  /**
   * Fills a continuous ridgeline silhouette sampled from world-space noise,
   * with optional shading mass, crest highlight, snow line and conifers.
   */
  private drawRidgeLayer(
    g: Phaser.GameObjects.Graphics,
    scrollX: number,
    factor: number,
    baseY: number,
    ampBase: number,
    ampVar: number,
    seed: number,
    color: number,
    opts: {
      alpha?: number; shade?: number; highlight?: number;
      snow?: number; snowMin?: number; trees?: number;
    } = {},
  ): void {
    const step = 14;
    const heightAt = (sx: number): number => {
      const r = ridge(sx + scrollX * factor, seed);
      const sharp = Math.sign(r) * Math.pow(Math.abs(r), 0.85); // peakier crests
      return Math.max(6, ampBase + sharp * ampVar);
    };

    // Silhouette
    g.fillStyle(color, opts.alpha ?? 1);
    g.beginPath();
    g.moveTo(-20, baseY + 60);
    for (let sx = -20; sx <= this.width + 20; sx += step) g.lineTo(sx, baseY - heightAt(sx));
    g.lineTo(this.width + 20, baseY + 60);
    g.closePath();
    g.fillPath();

    // Darker lower mass — reads as valley shadow and gives the range depth
    if (opts.shade !== undefined) {
      g.fillStyle(opts.shade, 0.55);
      g.beginPath();
      g.moveTo(-20, baseY + 60);
      for (let sx = -20; sx <= this.width + 20; sx += step) g.lineTo(sx, baseY - heightAt(sx) * 0.55);
      g.lineTo(this.width + 20, baseY + 60);
      g.closePath();
      g.fillPath();
    }

    // Lit crest line
    if (opts.highlight !== undefined) {
      g.lineStyle(1.4, opts.highlight, 0.45 * this.dl + 0.1);
      g.beginPath();
      g.moveTo(-20, baseY - heightAt(-20));
      for (let sx = -20; sx <= this.width + 20; sx += step) g.lineTo(sx, baseY - heightAt(sx));
      g.strokePath();
    }

    // Snow along the high crests
    if (opts.snow !== undefined && opts.snowMin !== undefined) {
      g.lineStyle(2.6, opts.snow, 0.8);
      let open = false;
      for (let sx = -20; sx <= this.width + 20; sx += step) {
        const h = heightAt(sx);
        if (h > opts.snowMin) {
          if (!open) { g.beginPath(); g.moveTo(sx, baseY - h); open = true; }
          else g.lineTo(sx, baseY - h);
        } else if (open) { g.strokePath(); open = false; }
      }
      if (open) g.strokePath();
    }

    // Tree silhouettes planted on the surface — nature returning, but a lot
    // of it burned: a mix of live conifers and dead snags
    if (opts.trees !== undefined) {
      const spacing = 64;
      const first = Math.floor((scrollX * factor - 40) / spacing);
      for (let i = first; i < first + Math.ceil(this.width / spacing) + 2; i++) {
        if (propRand(i + 400) < 0.4) continue;
        const sx = i * spacing + propRand(i) * 40 - scrollX * factor;
        if (sx < -20 || sx > this.width + 20) continue;
        const ty = baseY - heightAt(sx);
        const s = 0.7 + propRand(i + 77) * 0.8;
        if (propRand(i + 555) < 0.35) {
          // Burnt snag
          g.lineStyle(1.6 * s, opts.trees, 0.9);
          g.lineBetween(sx, ty + 2, sx, ty - 12 * s);
          g.lineBetween(sx, ty - 7 * s, sx + 4 * s, ty - 10 * s);
          g.lineBetween(sx, ty - 4 * s, sx - 3 * s, ty - 7 * s);
        } else {
          g.fillStyle(opts.trees, 0.9);
          g.fillTriangle(sx - 4 * s, ty + 2, sx, ty - 10 * s, sx + 4 * s, ty + 2);
          g.fillTriangle(sx - 3 * s, ty - 5 * s, sx, ty - 14 * s, sx + 3 * s, ty - 5 * s);
        }
      }
    }
  }

  /**
   * A shambling figure — the reason every settlement has walls. Lurches
   * forward with a dragging gait; `face` = which way it's stumbling.
   */
  private drawShambler(
    g: Phaser.GameObjects.Graphics,
    x: number,
    groundLine: number,
    i: number,
    scale = 1,
    face: 1 | -1 = 1,
  ): void {
    const s = scale;
    const ph = i * 1.7;
    const lean = (0.14 + Math.sin(this.t * 0.9 + ph) * 0.05) * face;
    const step = Math.sin(this.t * 2.4 + ph);
    const col = 0x110d07;

    const hipX = x, hipY = groundLine - 8 * s;
    g.lineStyle(1.8 * s, col, 0.95);
    g.lineBetween(hipX, hipY, hipX + step * 3 * s, groundLine);
    g.lineBetween(hipX, hipY, hipX - step * 2.4 * s, groundLine);

    const shX = hipX + lean * 11 * s, shY = hipY - 7 * s;
    g.lineStyle(2.4 * s, col, 0.95);
    g.lineBetween(hipX, hipY, shX, shY);
    g.fillStyle(col, 0.95);
    g.fillCircle(shX + 1.5 * s * face, shY - 2.5 * s, 2.2 * s);

    // Arms out, reaching
    const armDrop = Math.sin(this.t * 1.8 + ph) * 1.6;
    g.lineStyle(1.5 * s, col, 0.95);
    g.lineBetween(shX, shY, shX + 6 * s * face, shY + 3 * s + armDrop);
    g.lineBetween(shX, shY, shX + 5 * s * face, shY + 5.5 * s - armDrop);
  }

  /** Dead city blocks to overfly: broken towers with jagged tops, a leaning
   *  high-rise, rubble mounds — the world that was. */
  private drawRuinedCities(g: Phaser.GameObjects.Graphics, scrollX: number, baseY: number): void {
    const cellW = 3600;
    const factor = 0.55;
    const first = Math.floor((scrollX * factor - 400) / cellW);
    for (let c = first; c <= first + Math.ceil(this.width / cellW) + 1; c++) {
      if (propRand(c + 71) < 0.45) continue;
      const cx = c * cellW + propRand(c + 5) * 1400 - scrollX * factor;
      if (cx < -400 || cx > this.width + 400) continue;

      const n = 4 + Math.floor(propRand(c + 13) * 3);
      for (let b = 0; b < n; b++) {
        const bx = cx + b * (46 + propRand(c * 7 + b) * 26);
        const bw = 26 + propRand(c + b * 3) * 18;
        const bh = 42 + propRand(c + b * 11) * 78;
        const col = propRand(c + b) > 0.5 ? 0x171310 : 0x1d1813;

        if (b === 2 && propRand(c + 99) > 0.5) {
          // One tower leans, mid-collapse
          g.fillStyle(col, 1);
          g.beginPath();
          g.moveTo(bx, baseY);
          g.lineTo(bx + bw * 0.28, baseY - bh);
          g.lineTo(bx + bw * 1.28, baseY - bh * 0.92);
          g.lineTo(bx + bw, baseY);
          g.closePath();
          g.fillPath();
        } else {
          // Jagged broken top: a polygon whose roofline steps down and up
          const notchL = 10 + propRand(b + c) * 8;
          const notchR = 6 + propRand(b * 2 + c) * 9;
          g.fillStyle(col, 1);
          g.beginPath();
          g.moveTo(bx, baseY);
          g.lineTo(bx, baseY - bh + notchL);
          g.lineTo(bx + bw * 0.34, baseY - bh);
          g.lineTo(bx + bw * 0.6, baseY - bh);
          g.lineTo(bx + bw, baseY - bh + notchR);
          g.lineTo(bx + bw, baseY);
          g.closePath();
          g.fillPath();
        }

        // Dead windows, a couple of scorch streaks
        g.fillStyle(0x000000, 0.5);
        for (let wy = baseY - bh + 14; wy < baseY - 8; wy += 12) {
          for (let wx = bx + 5; wx < bx + bw - 4; wx += 9) {
            if (propRand(wx + wy + c) < 0.55) g.fillRect(wx, wy, 3.5, 5);
          }
        }
        g.fillStyle(0x0a0806, 0.6);
        g.fillRect(bx + bw * 0.3, baseY - bh + 8, 4, bh * 0.4);
      }
      // Rubble mounds at the feet
      g.fillStyle(0x14100b, 1);
      g.fillEllipse(cx + 40, baseY - 3, 90, 12);
      g.fillEllipse(cx + 150, baseY - 2, 70, 9);
    }
  }

  /** Distant smoke columns — something is always burning out there. */
  private drawSmokeColumns(g: Phaser.GameObjects.Graphics, scrollX: number, baseY: number): void {
    const cellW = 2400;
    const factor = 0.55;
    const first = Math.floor((scrollX * factor - 300) / cellW);
    for (let c = first; c <= first + Math.ceil(this.width / cellW) + 1; c++) {
      if (propRand(c + 7) < 0.45) continue;
      const cx = c * cellW + propRand(c) * 1200 - scrollX * factor;
      if (cx < -80 || cx > this.width + 80) continue;

      const colH = 90 + propRand(c + 11) * 70;
      for (let k = 0; k < 7; k++) {
        const yy = baseY - (k / 7) * colH;
        const sway = Math.sin(this.t * 0.7 + k * 0.8 + c) * (2 + k * 2.4);
        const r = 4 + k * 2.8;
        g.fillStyle(0x17140f, 0.30 * (1 - k / 8.5));
        g.fillEllipse(cx + sway + k * 3, yy, r * 2, r * 1.3);
      }
      // Half of them still burn at the base
      if (propRand(c + 3) < 0.5) {
        const fl = 0.5 + Math.sin(this.t * 7 + c * 2) * 0.3;
        g.fillStyle(0xff7726, 0.30 * fl);
        g.fillEllipse(cx, baseY - 3, 14, 7);
        g.fillStyle(0xffb040, 0.22 * fl);
        g.fillEllipse(cx, baseY - 5, 7, 4);
      }
    }
  }

  private drawFar(scrollX: number, sink: number, hMult: number): void {
    const g = this.farGfx;
    g.clear();
    const baseY = this.groundY + sink;

    // Two overlapping far ranges for a deep horizon
    this.drawRidgeLayer(g, scrollX, 0.022, baseY, 42 * hMult, 55 * hMult, 13.4, this.pal.far, { alpha: 0.6 });
    this.drawRidgeLayer(g, scrollX, 0.038, baseY, 55 * hMult, 70 * hMult, 1.7, this.pal.far, { alpha: 0.85 });

    // Atmospheric distance haze over the far range
    for (let i = 0; i < 3; i++) {
      g.fillStyle(this.pal.skyBot, 0.07 - i * 0.018);
      g.fillRect(0, baseY - 130 + i * 44, this.width, 130 - i * 44);
    }
  }

  private drawMountains(scrollX: number, sink: number, hMult: number): void {
    const g = this.mountainGfx;
    g.clear();
    const baseY = this.groundY + sink;

    this.drawRidgeLayer(
      g, scrollX, 0.08, baseY, 85 * hMult, 115 * hMult, 4.2, this.pal.mountain, {
        shade: this.pal.mountainDark,
        highlight: lerpColor(this.pal.mountain, 0xffffff, 0.35),
        snow: this.pal.snow,
        snowMin: 150 * hMult,
      },
    );

    // Light haze at the mountain feet
    for (let i = 0; i < 2; i++) {
      g.fillStyle(this.pal.skyBot, 0.05 - i * 0.02);
      g.fillRect(0, baseY - 70 + i * 34, this.width, 70 - i * 34);
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

    const alpha = Math.min(alt / 200, 0.85) * 0.16;
    const body = lerpColor(0x1e2632, 0xffffff, this.dl);           // night clouds go dark
    const shade = lerpColor(0x141a24, 0x9aa8b4, this.dl);

    const baseY = this.groundY * 0.35;
    for (let i = 0; i < this.cloudOffsets.length; i++) {
      const span = this.width + 300;
      const ox = ((this.cloudOffsets[i] - scrollX * 0.05) % span + span) % span - 150;
      const oy = baseY + (i % 3) * 40;
      const w = 80 + (i % 3) * 40;
      // Shaded underside first, then the sunlit body
      g.fillStyle(shade, alpha * 0.8);
      g.fillEllipse(ox + 4, oy + 7, w * 0.95, 20);
      g.fillStyle(body, alpha);
      g.fillEllipse(ox, oy, w, 28);
      g.fillEllipse(ox + 30, oy - 12, w * 0.7, 22);
      g.fillEllipse(ox - 20, oy - 8, w * 0.5, 18);
      g.fillStyle(lerpColor(body, 0xffffff, 0.4), alpha * 0.5);
      g.fillEllipse(ox + 8, oy - 14, w * 0.4, 10);
    }
  }

  private drawHills(scrollX: number, sink: number, f: WorldFrame): void {
    const g = this.hillGfx;
    g.clear();
    const baseY = this.groundY + sink;

    this.drawRidgeLayer(
      g, scrollX, 0.22, baseY, 26, 46, 8.9, this.pal.hill, {
        shade: lerpColor(this.pal.hill, 0x000000, 0.35),
        highlight: this.pal.hillLight,
        trees: lerpColor(this.pal.hill, 0x000000, 0.5),
      },
    );

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

  /** Near-foreground strip of seeded wasteland props: rocks, wrecks, walkers. */
  private drawScrub(scrollX: number, sink: number): void {
    const g = this.scrubGfx;
    g.clear();
    const baseY = this.groundY + sink;
    if (baseY > this.height + 30) return;

    this.drawSmokeColumns(g, scrollX, baseY);
    this.drawRuinedCities(g, scrollX, baseY);

    const spacing = 240;
    const scroll = scrollX * 0.55;
    const first = Math.floor((scroll - 100) / spacing);
    for (let i = first; i < first + Math.ceil(this.width / spacing) + 2; i++) {
      const sx = i * spacing - scroll + (propRand(i) - 0.5) * 120;
      if (sx < -60 || sx > this.width + 60) continue;
      const kind = Math.floor(propRand(i + 50) * 6);
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
        case 3: { // abandoned car, doors hanging open
          g.fillRect(sx - 11 * s, baseY - 6 * s, 22 * s, 5 * s);
          g.fillRect(sx - 6 * s, baseY - 9 * s, 12 * s, 4 * s);
          g.lineStyle(1.4 * s, this.pal.scrub, 1);
          g.lineBetween(sx + 11 * s, baseY - 6 * s, sx + 15 * s, baseY - 2 * s); // sprung door
          break;
        }
        case 4: { // walkers — one to three, drifting through the waste
          const n = 1 + Math.floor(propRand(i + 31) * 3);
          const face: 1 | -1 = propRand(i + 44) > 0.5 ? 1 : -1;
          for (let z = 0; z < n; z++) {
            const wander = Math.sin(this.t * 0.35 + i + z * 2.1) * 7;
            this.drawShambler(g, sx + z * 12 * s + wander, baseY, i * 3 + z, 0.85 * s, face);
          }
          break;
        }
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

    // Ground body with a subtle depth gradient
    g.fillStyle(this.pal.ground, 1);
    g.fillRect(0, gy, this.width, this.height - gy + 10);
    g.fillStyle(lerpColor(this.pal.ground, 0x000000, 0.35), 1);
    g.fillRect(0, gy + 60, this.width, this.height - gy - 50);
    g.fillStyle(this.pal.groundTop, 1);
    g.fillRect(0, gy, this.width, 18);
    g.lineStyle(2, this.pal.groundLine, 1);
    g.lineBetween(0, gy, this.width, gy);

    // Texture lines + scrolling dirt speckle so the ground itself shows motion
    g.lineStyle(1, lerpColor(this.pal.ground, 0xffffff, 0.08), 0.3);
    for (let i = 1; i <= 3; i++) g.lineBetween(0, gy + i * 22, this.width, gy + i * 22);
    {
      const sp = 26;
      const first = Math.floor((scrollX - 20) / sp);
      for (let i = first; i < first + Math.ceil(this.width / sp) + 2; i++) {
        const sx = i * sp + propRand(i) * 20 - scrollX;
        if (sx < -4 || sx > this.width + 4) continue;
        const dy = 8 + propRand(i + 3) * 52;
        g.fillStyle(propRand(i + 9) > 0.5 ? 0x000000 : 0xffffff, 0.06);
        g.fillRect(sx, gy + dy, 2.5, 1.6);
      }
    }

    // Touchdown tire marks left by this flight's landings
    for (const wx of this.skids) {
      const sx = wx - scrollX;
      if (sx < -60 || sx > this.width + 60) continue;
      g.fillStyle(0x0a0806, 0.55);
      g.fillRect(sx - 40, gy + 2.5, 40, 2.2);
      g.fillRect(sx - 30, gy + 6, 26, 1.6);
    }

    // Lone walkers in the open between the settlements — full-parallax, same
    // plane as the aircraft: real danger on a forced landing out here
    {
      const PXM2 = WORLD_PX_PER_M;
      const dPx = Math.max(2000 * PXM2, f.routeTotalKm * 1000 * PXM2);
      const zoneA: [number, number] = [-150 * PXM2 - 900, 450 * PXM2 + 900];
      const zoneB: [number, number] = [dPx - 300 * PXM2 - 900, dPx + 300 * PXM2 + 900];
      const cellW = 760;
      const first = Math.floor((scrollX - 100) / cellW);
      for (let c = first; c <= first + Math.ceil(this.width / cellW) + 1; c++) {
        if (propRand(c + 313) < 0.55) continue;
        const wx = c * cellW + propRand(c + 17) * 500;
        if (wx > zoneA[0] && wx < zoneA[1]) continue;
        if (wx > zoneB[0] && wx < zoneB[1]) continue;
        const sx = wx - scrollX;
        if (sx < -30 || sx > this.width + 30) continue;
        const face: 1 | -1 = propRand(c + 91) > 0.5 ? 1 : -1;
        this.drawShambler(g, sx + Math.sin(this.t * 0.3 + c) * 9, gy + 1, c, 1.2, face);
      }
    }

    // Runway zones — origin at world 0, destination at the contract distance.
    // Compact ~600 m strips with the airfield buildings right on them and the
    // settlements beyond.
    const PXM = WORLD_PX_PER_M;
    const destPx = Math.max(2000 * PXM, f.routeTotalKm * 1000 * PXM);
    const oriFrom = -150 * PXM, oriTo = 450 * PXM;
    const dstFrom = destPx - 300 * PXM, dstTo = destPx + 300 * PXM;
    this.drawRunway(g, oriFrom, oriTo, scrollX, gy, f);
    this.drawRunway(g, dstFrom, dstTo, scrollX, gy, f);
    // Origin airfield sits just behind the spawn point (aircraft spawns at
    // screen/world ~300) so the field is on screen from the first frame; the
    // destination's is at its strip entrance, overflown on approach.
    this.drawAirfield(g, 10, scrollX, gy);
    this.drawAirfield(g, dstFrom + 60, scrollX, gy);
    this.drawSettlement(g, oriFrom - 60, scrollX, gy, -1);
    this.drawSettlement(g, dstTo + 60, scrollX, gy, 1);

    // Cracks / ruts between runways so open terrain isn't sterile
    const spacing = 170;
    const first = Math.floor((scrollX - 60) / spacing);
    for (let i = first; i < first + Math.ceil(this.width / spacing) + 1; i++) {
      const wx = i * spacing + propRand(i + 13) * 80;
      if (wx > oriFrom - 500 && wx < oriTo + 500) continue;
      if (wx > dstFrom - 500 && wx < dstTo + 500) continue;
      const sx = wx - scrollX;
      if (sx < -40 || sx > this.width + 40) continue;
      g.lineStyle(1.5, 0x000000, 0.18);
      g.lineBetween(sx, gy + 6 + propRand(i + 7) * 10, sx + 26 + propRand(i) * 30, gy + 8 + propRand(i + 3) * 12);
    }
  }

  /** Airfield buildings along the strip: hangar, control tower, fuel drums.
   *  Drawn behind the aircraft so the field reads as a real place. */
  private drawAirfield(
    g: Phaser.GameObjects.Graphics,
    startPx: number,
    scrollX: number,
    gy: number,
  ): void {
    const sx = startPx - scrollX;
    if (sx < -600 || sx > this.width + 600) return;

    const dark = 0x15100a;
    const mid = 0x241b10;

    // Hangar: arched roof over a box, door cracked open
    const hx = sx + 20;
    g.fillStyle(mid, 1);
    g.fillRect(hx, gy - 34, 92, 34);
    g.fillStyle(dark, 1);
    g.fillEllipse(hx + 46, gy - 34, 92, 26);
    g.fillStyle(0x0a0805, 1);
    g.fillRect(hx + 30, gy - 24, 32, 24); // open door gap
    g.lineStyle(1, 0x4a3a22, 0.7);
    for (let i = 0; i < 4; i++) g.lineBetween(hx + 8 + i * 22, gy - 32, hx + 8 + i * 22, gy - 2);

    // Control tower: legs, cab, blinking light
    const tx = sx + 160;
    g.lineStyle(2.5, dark, 1);
    g.lineBetween(tx - 8, gy, tx - 4, gy - 34);
    g.lineBetween(tx + 8, gy, tx + 4, gy - 34);
    g.fillStyle(dark, 1);
    g.fillRect(tx - 14, gy - 50, 28, 17);
    g.fillStyle(0x86a0aa, 0.55);
    g.fillRect(tx - 11, gy - 47, 22, 8); // glazing
    if (Math.sin(this.t * 5) > 0) {
      g.fillStyle(0x30ff70, 0.9);
      g.fillCircle(tx, gy - 53, 1.8);
    }

    // Fuel drums + stack of crates
    const dx = sx + 220;
    g.fillStyle(0x3a2c18, 1);
    for (let i = 0; i < 3; i++) g.fillRect(dx + i * 9, gy - 10, 7, 10);
    g.fillStyle(mid, 1);
    g.fillRect(dx + 34, gy - 8, 10, 8);
    g.fillRect(dx + 38, gy - 15, 10, 8);
  }

  /** Fortified settlement silhouette beyond a runway: buildings, water tower,
   *  antenna with a blinking beacon, perimeter wall. `dir` = which way it extends. */
  private drawSettlement(
    g: Phaser.GameObjects.Graphics,
    anchorPx: number,
    scrollX: number,
    gy: number,
    dir: 1 | -1,
  ): void {
    const sx0 = anchorPx - scrollX;
    if (sx0 < -700 || sx0 > this.width + 700) return;

    const dark = 0x120d06;
    const wall = 0x1c1509;

    // Perimeter wall with a gate gap
    g.fillStyle(wall, 1);
    g.fillRect(sx0, gy - 12, dir * 460, 12);
    g.fillRect(sx0 + dir * 60, gy - 20, dir * 6, 20); // gate post
    g.fillRect(sx0 + dir * 110, gy - 20, dir * 6, 20);

    // Buildings
    const heights = [34, 58, 26, 70, 42, 30];
    for (let i = 0; i < heights.length; i++) {
      const bx = sx0 + dir * (40 + i * 72);
      const bw = 46 + (i % 3) * 12;
      const bh = heights[i];
      g.fillStyle(dark, 1);
      g.fillRect(Math.min(bx, bx + dir * bw), gy - bh, bw, bh);
      // Lit windows
      g.fillStyle(0xd08a30, 0.8);
      for (let wy = gy - bh + 8; wy < gy - 8; wy += 14) {
        for (let wxo = 8; wxo < bw - 6; wxo += 14) {
          if (propRand(i * 31 + wy + wxo) < 0.45) {
            g.fillRect(Math.min(bx, bx + dir * bw) + wxo, wy, 4, 5);
          }
        }
      }
    }

    // Water tower
    const wtx = sx0 + dir * 250;
    g.lineStyle(2.5, dark, 1);
    g.lineBetween(wtx - 10, gy, wtx - 4, gy - 42);
    g.lineBetween(wtx + 10, gy, wtx + 4, gy - 42);
    g.fillStyle(dark, 1);
    g.fillEllipse(wtx, gy - 50, 34, 20);

    // Antenna mast with blinking beacon
    const ax = sx0 + dir * 400;
    g.lineStyle(2, dark, 1);
    g.lineBetween(ax, gy, ax, gy - 88);
    g.lineBetween(ax - 12, gy, ax, gy - 60);
    g.lineBetween(ax + 12, gy, ax, gy - 60);
    if (Math.sin(this.t * 3.5) > 0.2) {
      g.fillStyle(0xff4030, 0.9);
      g.fillCircle(ax, gy - 90, 2.5);
      g.fillStyle(0xff4030, 0.25);
      g.fillCircle(ax, gy - 90, 6);
    }

    // Why the walls exist: a knot of the dead pressing at the perimeter
    const hordeN = 4 + Math.floor(propRand(Math.round(anchorPx)) * 3);
    for (let z = 0; z < hordeN; z++) {
      const hx = sx0 - dir * (16 + z * 11 + propRand(z + 5) * 8);
      const push = Math.abs(Math.sin(this.t * 1.1 + z)) * 3;
      this.drawShambler(g, hx + dir * push, gy + 1, z * 7 + 3, 0.95 + propRand(z) * 0.25, dir);
    }

    // Quarantine sign on the approach
    const qx = sx0 - dir * 150;
    g.lineStyle(2, 0x6a6458, 1);
    g.lineBetween(qx, gy, qx, gy - 22);
    g.fillStyle(0xa88a28, 0.9);
    g.fillTriangle(qx - 8, gy - 22, qx + 8, gy - 22, qx, gy - 36);
    g.fillStyle(0x111111, 0.95);
    g.fillCircle(qx, gy - 27.5, 2.6);
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

    // Slab with edge line and worn shoulders
    g.fillStyle(0x1c1c1a, 0.95);
    g.fillRect(sx0, gy + 1, sx1 - sx0, 13);
    g.fillStyle(0x2a2a26, 0.9);
    g.fillRect(sx0, gy + 1, sx1 - sx0, 2);
    g.lineStyle(1, 0xb8b0a0, 0.35);
    g.lineBetween(sx0, gy + 1.5, sx1, gy + 1.5); // painted edge line
    g.lineStyle(1, 0x3a3a36, 0.8);
    g.lineBetween(sx0, gy + 14, sx1, gy + 14);

    // Asphalt patchwork speckle
    {
      const sp = 34;
      const first = Math.floor((Math.max(fromM, scrollX - 40)) / sp);
      const last = Math.floor(Math.min(toM, scrollX + this.width + 40) / sp);
      for (let i = first; i <= last; i++) {
        const wx = i * sp + propRand(i + 21) * 26;
        if (wx < fromM + 6 || wx > toM - 6) continue;
        const dx = wx - scrollX;
        g.fillStyle(propRand(i + 55) > 0.5 ? 0x000000 : 0x4a4a44, 0.25);
        g.fillRect(dx, gy + 3 + propRand(i + 8) * 8, 3 + propRand(i) * 5, 1.4);
      }
    }

    // Threshold piano keys at both ends
    for (const endX of [x0 + 14, x1 - 96]) {
      for (let i = 0; i < 6; i++) {
        const tx = endX + i * 15;
        if (tx < -20 || tx > this.width + 20) continue;
        g.fillStyle(0xc8c0a8, 0.75);
        g.fillRect(tx, gy + 3, 7, 9);
      }
    }

    // Aiming-point bars past each threshold
    for (const ax of [x0 + 190, x1 - 265]) {
      if (ax > -60 && ax < this.width + 60) {
        g.fillStyle(0xd8d0b8, 0.6);
        g.fillRect(ax, gy + 4.5, 34, 5);
      }
    }

    // Rubber smudges where traffic touches down
    for (const [endX, dir] of [[x0 + 150, 1], [x1 - 210, -1]] as Array<[number, number]>) {
      for (let i = 0; i < 5; i++) {
        const rx = endX + dir * (i * 26 + propRand(i + 61) * 18);
        if (rx < -40 || rx > this.width + 40) continue;
        g.fillStyle(0x0c0a08, 0.4);
        g.fillRect(rx, gy + 5 + propRand(i + 31) * 5, 16 + propRand(i + 41) * 14, 1.8);
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

    // Sequenced approach strobes leading in to the threshold ("the rabbit")
    {
      const seq = Math.floor(this.t * 9) % 7;
      const litK = seq <= 4 ? 4 - seq : -1; // sweeps toward the threshold, then pauses
      for (let k = 0; k < 5; k++) {
        const lx = x0 - 55 - k * 62;
        if (lx < -30 || lx > this.width + 30) continue;
        g.fillStyle(0xffffff, 0.18);
        g.fillCircle(lx, gy + 1, 1.4);
        if (k === litK) {
          g.fillStyle(0xffffff, 0.9);
          g.fillCircle(lx, gy + 1, 2.2);
          g.fillStyle(0xffffff, 0.2);
          g.fillCircle(lx, gy + 1, 6);
        }
      }
    }

    // Pulsing edge lights — brighter and haloed at night
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3.2);
    const night = 1 - this.dl;
    for (let wx = fromM + 30; wx < toM - 20; wx += 92) {
      const lx = wx - scrollX;
      if (lx < -10 || lx > this.width + 10) continue;
      if (night > 0.2) {
        g.fillStyle(0xffb350, (0.12 + pulse * 0.1) * night);
        g.fillCircle(lx, gy + 2, 5);
      }
      g.fillStyle(0xffb350, 0.35 + pulse * 0.45 + night * 0.2);
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
