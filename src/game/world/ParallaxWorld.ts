import Phaser from 'phaser';
import type { WeatherCondition } from '../../types';
import { Hazards } from './Hazards';
import { Raiders, MAX_ENGAGEMENT_M, type RaiderFireReport } from './Raiders';
import { AirTraffic } from './AirTraffic';
import { drawUndead, drawCorpse, drawHorde, undeadKindFor, type CrowdStyle } from './Crowds';
import {
  drawFighter, drawMuzzleFlash, drawWireFence, drawBarrier, garrisonPalette,
} from './Figures';
import { blendBiome, type BiomeId, type BiomeShape } from './Biomes';

/**
 * The whole flight environment, drawn procedurally every frame:
 * layered parallax terrain, weather-tinted palettes, runway zones with
 * threshold stripes and pulsing edge lights, a windsock, bird flocks,
 * and an altitude camera that "sinks" the world once the aircraft climbs
 * past the linear band so high altitude actually reads as high.
 */

// Metres of altitude mapped linearly to the usable screen height. Sized so
// the number on the gauge matches what you SEE: at 90 m the aircraft is near
// the top of frame, at 10 m it is just off the deck. These are low-level
// cargo runs, not airliner cruise.
export const ALT_BAND = 70;
/**
 * World altitudes (m) of the stacked cloud decks. Spaced so at least one is
 * always crossing the frame — they are the vertical motion reference once the
 * ground has dropped out of sight.
 */
const CLOUD_LAYER_ALTS = [110, 190, 280, 385, 505, 650];
export const PLANE_MIN_Y = 250;    // screen y the aircraft pins to above the band
/** World px per metre flown — high so speed genuinely reads on screen. */
export const WORLD_PX_PER_M = 9;

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
  planeScreenX?: number; // for tracer fire aimed at the aircraft
  planeScreenY?: number;
  planeWorldX?: number;  // world px, so the guns can lay on a real position
  speedFrac?: number;   // 0–1 airspeed, drives near-field blur and streaks
  progress?: number;    // 0–1 along the route, blends origin country into destination
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
  private readonly hazardGfx: Phaser.GameObjects.Graphics;
  /** Other aircraft — above the player's plane so a conflict reads clearly. */
  private readonly trafficGfx: Phaser.GameObjects.Graphics;
  /** Rounds in flight, drawn over everything they pass. */
  private readonly tracerGfx: Phaser.GameObjects.Graphics;
  /** Near field, scrolls FASTER than the ground — the main speed cue. */
  private readonly foreGfx: Phaser.GameObjects.Graphics;
  private readonly vignetteGfx: Phaser.GameObjects.Graphics;

  /** Solid obstacles + raider-held ground along the route. */
  readonly hazards = new Hazards();
  /** The militia holding that ground, and everything they are shooting at. */
  readonly raiders = new Raiders();
  /** Other traffic sharing the airspace. */
  readonly traffic = new AirTraffic();

  private pal: Palette = resolve('clear');   // final: biome + weather + daylight
  private shape: BiomeShape = blendBiome('ashland', 'ashland', 0).shape;
  private prevWeather: WeatherCondition = 'clear';
  private curWeather: WeatherCondition = 'clear';
  private blendT = 1;
  private dl = 1; // current daylight factor
  private biomeFrom: BiomeId = 'ashland';
  private biomeTo: BiomeId = 'ashland';
  /** Colours flown by the garrison holding the airfields on this route. */
  private factionColor = 0x4a90d9;

  private t = 0;
  private readonly cloudOffsets = [0, 200, 450, 700, 900];
  private readonly skids: number[] = []; // world-px of touchdown tire marks
  /** Scratch buffers for ridge sampling — reused so no per-frame allocation. */
  private readonly rsX: number[] = [];
  private readonly rsH: number[] = [];

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
    // Hazards render in front of the terrain but behind the aircraft, which
    // is created after this class — so the plane passes in front of them.
    this.hazardGfx = scene.add.graphics();
    // Traffic and tracers sit ABOVE the player's aircraft (which the scene
    // creates after this class, at depth 0). A conflicting aeroplane that
    // passes behind your own tail is a conflict you never see coming.
    this.trafficGfx = scene.add.graphics().setDepth(5);
    this.tracerGfx = scene.add.graphics().setDepth(5.5);
    // Near-field strip and vignette sit ABOVE the aircraft; they occupy the
    // bottom edge only, so they frame the shot without hiding the plane.
    this.foreGfx = scene.add.graphics().setDepth(6);
    this.vignetteGfx = scene.add.graphics().setDepth(7);
    this.drawVignette();
  }

  /** Metres of altitude per screen pixel — shared by hazards so what you
   *  see is exactly what you collide with. */
  private get pxPerM(): number {
    return (this.groundY - PLANE_MIN_Y) / ALT_BAND;
  }

  /** Lay out the route's obstacles, hostile stretches and the militia in them. */
  setRoute(routeKm: number, seed: number): void {
    const destPx = Math.max(2000 * WORLD_PX_PER_M, routeKm * 1000 * WORLD_PX_PER_M);
    this.hazards.generate(450 * WORLD_PX_PER_M, destPx - 300 * WORLD_PX_PER_M, seed);
    this.raiders.layout(this.hazards.zones, seed);
    this.traffic.reset(seed);
  }

  /** Crowd colouring, tied to the current palette so figures sit in the scene. */
  private get crowdStyle(): CrowdStyle {
    return {
      body: lerpColor(this.pal.scrub, 0x000000, 0.55),
      rag: lerpColor(this.pal.scrub, 0x000000, 0.28),
      rim: this.pal.hillLight,
      daylight: this.dl,
    };
  }

  /** Blend the palette toward a weather condition over ~4 s. */
  setWeather(condition: WeatherCondition): void {
    this.prevWeather = this.curWeather;
    this.curWeather = condition;
    this.blendT = 0;
  }

  /** The country at each end of this route. */
  setBiomes(from: BiomeId, to: BiomeId): void {
    this.biomeFrom = from;
    this.biomeTo = to;
  }

  /** Whose flag flies over the airfields on this route. */
  setFactionColor(color: number): void {
    this.factionColor = color;
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

    // Palette pipeline: regional biome → weather tint → time of day.
    // The biome is the base, so crossing from basin into red rock changes the
    // land itself while weather and daylight still read on top of it.
    this.blendT = Math.min(1, this.blendT + dt / 4);
    const biome = blendBiome(this.biomeFrom, this.biomeTo, f.progress ?? 0);
    this.shape = biome.shape;
    this.dl = daylight(f.minutesOfDay);

    const wPrev = WEATHER_PALETTES[this.prevWeather];
    const wCur = WEATHER_PALETTES[this.curWeather];
    const graded = {} as Palette;
    for (const k of Object.keys(biome.palette) as Array<keyof Palette>) {
      const base = biome.palette[k];
      const a = wPrev[k] ?? base;
      const b = wCur[k] ?? base;
      graded[k] = applyDaylight(lerpColor(a, b, this.blendT), this.dl);
    }
    this.pal = graded;

    // Above the linear band the world sinks away beneath the aircraft
    // Above the band the aircraft holds its screen position and the WORLD
    // drops away beneath it, at the same scale it was climbing at. Climb high
    // enough and the ground genuinely leaves the bottom of the screen.
    const sink = Math.max(0, (f.altitude - ALT_BAND) * this.pxPerM);
    const hMult = Phaser.Math.Linear(1, 0.6, Phaser.Math.Clamp((f.altitude - ALT_BAND) / 600, 0, 1));

    this.drawSky(f);
    this.drawFar(f.scrollX, sink * 0.30, hMult);
    this.drawMountains(f.scrollX, sink * 0.55, hMult);
    this.drawCloudDeck(f.altitude, f.scrollX);
    this.drawClouds(f.scrollX, f.altitude);
    this.drawHills(f.scrollX, sink * 0.8, f);
    this.drawScrub(f.scrollX, sink);
    this.drawGround(f.scrollX, sink, f);

    this.drawNearField(f.scrollX, sink, f.speedFrac ?? 0);

    // ── Hazards, the militia holding the ground, and other traffic ─────────
    const gy = this.groundY + sink;

    // Guns only bother tracking something they could plausibly reach; above
    // that they sit at rest rather than pointing uselessly at the stratosphere.
    const inReach = f.planeWorldX !== undefined && f.planeScreenY !== undefined
      && f.altitude < MAX_ENGAGEMENT_M + 60;
    this.raiders.update(
      dt, gy,
      inReach ? { worldX: f.planeWorldX!, screenY: f.planeScreenY! } : null,
    );

    this.hazardGfx.clear();
    if (gy < this.height + 40) {
      // Obstacles are lit by the sky they stand against, so they get the
      // current horizon colour rather than being flat black cut-outs.
      this.hazards.draw(this.hazardGfx, f.scrollX, gy, this.pxPerM, this.width, this.t, {
        rim: this.pal.skyBot, daylight: this.dl,
      });
      this.raiders.draw(this.hazardGfx, f.scrollX, gy, this.width, this.t, this.dl, this.crowdStyle, dt);
    }

    this.tracerGfx.clear();
    this.raiders.drawTracers(this.tracerGfx, f.scrollX, this.width);

    // Other aircraft ride the SAME altitude mapping as the player's, so a
    // conflict on screen is a conflict in the collision test.
    this.trafficGfx.clear();
    this.traffic.draw(this.trafficGfx, f.scrollX, gy, this.pxPerM, this.width, this.t, this.dl);
  }

  /**
   * Let every weapon within reach take its shot, and report what happened.
   * The ground datum is recomputed here from the aircraft's own altitude so
   * the muzzles the rounds leave from are exactly where they are drawn, even
   * once the ground itself has sunk off the bottom of the frame.
   */
  raiderFire(
    dt: number, planeWorldX: number, planeScreenY: number, altitude: number,
  ): RaiderFireReport {
    const gy = this.groundY + Math.max(0, (altitude - ALT_BAND) * this.pxPerM);
    return this.raiders.engage(dt, gy, { worldX: planeWorldX, screenY: planeScreenY, altM: altitude });
  }

  /** Worst weapon in the stretch ahead, so the climb can start in time. */
  threatAhead(worldX: number, rangePx: number): { label: string; ceilingM: number; distancePx: number } | null {
    return this.raiders.threatAhead(worldX, rangePx);
  }

  destroy(): void {
    for (const g of [this.skyGfx, this.farGfx, this.mountainGfx, this.deckGfx,
      this.cloudGfx, this.hillGfx, this.scrubGfx, this.groundGfx, this.hazardGfx,
      this.foreGfx, this.vignetteGfx]) g.destroy();
  }

  // ── Layers ─────────────────────────────────────────────────────────────────

  /**
   * The near field: ground detail at the very bottom of the screen scrolling
   * ~1.9x the terrain rate. Objects whipping past close to the camera are what
   * actually sell speed — distant parallax layers barely move by definition.
   */
  private drawNearField(scrollX: number, sink: number, speedFrac: number): void {
    const g = this.foreGfx;
    g.clear();
    const bandTop = this.groundY + sink + 34;
    if (bandTop > this.height) return;

    const scroll = scrollX * 1.9;
    const spacing = 52;
    const first = Math.floor((scroll - 120) / spacing);
    for (let i = first; i < first + Math.ceil(this.width / spacing) + 3; i++) {
      const sx = i * spacing - scroll + propRand(i * 3.7) * 70;
      if (sx < -70 || sx > this.width + 70) continue;
      const depth = 0.35 + propRand(i + 12) * 0.65;      // how close to camera
      const y = bandTop + depth * (this.height - bandTop) * 0.9;
      const s = 0.9 + depth * 2.2;
      const shade = lerpColor(this.pal.ground, 0x000000, 0.62 + depth * 0.3);
      const kind = Math.floor(propRand(i + 41) * 4);

      g.fillStyle(shade, 1);
      if (kind === 0) {
        g.fillTriangle(sx - 6 * s, y, sx - 1 * s, y - 5 * s, sx + 6 * s, y);
      } else if (kind === 1) {
        g.lineStyle(1.4 * s, shade, 0.95);
        for (let b = -1; b <= 1; b++) {
          g.lineBetween(sx + b * 2.5 * s, y, sx + b * 4.5 * s, y - (5 + propRand(i + b) * 5) * s);
        }
      } else if (kind === 2) {
        g.fillRect(sx - 1.2 * s, y - 9 * s, 2.4 * s, 9 * s);
      } else {
        g.fillRect(sx - 4 * s, y - 1.6 * s, 8 * s, 1.8 * s);
      }
    }

    // Motion streaks along the very bottom once genuinely quick
    if (speedFrac > 0.35) {
      const a = (speedFrac - 0.35) / 0.65;
      for (let i = 0; i < 7; i++) {
        const y = this.height - 6 - propRand(i + 71) * 46;
        const phase = ((this.t * (900 + i * 120) + i * 337) % (this.width + 400)) - 200;
        const len = 60 + a * 190;
        g.lineStyle(1.6, lerpColor(this.pal.ground, 0xffffff, 0.35), 0.10 + a * 0.22);
        g.lineBetween(this.width - phase, y, this.width - phase + len, y);
      }
    }
  }

  /** Soft cinematic vignette — drawn once, purely framing. */
  private drawVignette(): void {
    const g = this.vignetteGfx;
    g.clear();
    // Many thin bands rather than a few thick ones, so the falloff is smooth
    const steps = 26;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const a = 0.016 * (1 - t) * (1 - t);
      g.fillStyle(0x000000, a);
      const vBand = 54 * (1 - t);
      const hBand = 88 * (1 - t);
      g.fillRect(0, 0, this.width, vBand);
      g.fillRect(0, this.height - vBand, this.width, vBand);
      g.fillRect(0, 0, hBand, this.height);
      g.fillRect(this.width - hBand, 0, hBand, this.height);
    }
  }

  private drawSky(f: WorldFrame): void {
    const g = this.skyGfx;
    const alt = f.altitude;
    const dl = this.dl;
    g.clear();

    // Altitude darkens the sky toward near-space navy
    const hiT = Phaser.Math.Clamp(alt / 1400, 0, 1);
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
   *
   * The vertices are anchored to a WORLD grid, never to screen positions.
   * That distinction is the whole difference between terrain that glides and
   * terrain that crawls: sampling a fixed set of screen x's re-evaluates the
   * noise at a new world point every frame, so the polyline never translates —
   * it MORPHS in place. Peaks pump up and down as they pass between samples
   * and mesa terraces jump a full step at a time (measured: up to 29 px of
   * vertical pop in one frame). Anchored to world space the same polyline
   * simply slides left, with zero per-frame shape change.
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
    const step = 12;
    const sh = this.shape;
    const heightAt = (wx: number): number => {
      const r = ridge(wx, seed) + (sh.roughness - 1) * 0.16 * Math.sin(wx * 0.021 + seed);
      const sharp = Math.sign(r) * Math.pow(Math.abs(r), 0.85); // peakier crests
      let h = Math.max(6, ampBase + sharp * ampVar);
      // Sandstone country: terrace the silhouette into flat-topped mesas
      if (sh.plateau > 0.02) {
        const stepH = Math.max(12, ampBase * 0.42);
        const terraced = Math.round(h / stepH) * stepH;
        h = h + (terraced - h) * sh.plateau;
      }
      return Math.max(6, h);
    };

    // One sampling pass, reused by every stroke below — the noise is four
    // sines per point and the layer used to evaluate it five times over.
    const off = scrollX * factor;
    const i0 = Math.floor((off - 40) / step);
    const i1 = Math.ceil((off + this.width + 40) / step);
    const xs = this.rsX, hs = this.rsH;
    xs.length = 0; hs.length = 0;
    for (let i = i0; i <= i1; i++) {
      xs.push(i * step - off);
      hs.push(heightAt(i * step));
    }
    const n = xs.length;
    if (n < 2) return;

    /** Ridge height at an arbitrary screen x, read off the drawn polyline so
     *  props planted on the surface sit exactly on it. */
    const surfaceAt = (sx: number): number => {
      const k = Phaser.Math.Clamp((sx - xs[0]) / step, 0, n - 1.0001);
      const a = Math.floor(k);
      return hs[a] + (hs[a + 1] - hs[a]) * (k - a);
    };

    // Silhouette
    g.fillStyle(color, opts.alpha ?? 1);
    g.beginPath();
    g.moveTo(xs[0], baseY + 60);
    for (let i = 0; i < n; i++) g.lineTo(xs[i], baseY - hs[i]);
    g.lineTo(xs[n - 1], baseY + 60);
    g.closePath();
    g.fillPath();

    // Darker lower mass — reads as valley shadow and gives the range depth
    if (opts.shade !== undefined) {
      g.fillStyle(opts.shade, 0.55);
      g.beginPath();
      g.moveTo(xs[0], baseY + 60);
      for (let i = 0; i < n; i++) g.lineTo(xs[i], baseY - hs[i] * 0.55);
      g.lineTo(xs[n - 1], baseY + 60);
      g.closePath();
      g.fillPath();
    }

    // Lit crest line
    if (opts.highlight !== undefined) {
      g.lineStyle(1.2, opts.highlight, 0.16 * this.dl + 0.04);
      g.beginPath();
      g.moveTo(xs[0], baseY - hs[0]);
      for (let i = 1; i < n; i++) g.lineTo(xs[i], baseY - hs[i]);
      g.strokePath();
    }

    // Snow along the high crests
    if (opts.snow !== undefined && opts.snowMin !== undefined) {
      g.lineStyle(2.6, opts.snow, 0.8);
      let open = false;
      for (let i = 0; i < n; i++) {
        if (hs[i] > opts.snowMin) {
          if (!open) { g.beginPath(); g.moveTo(xs[i], baseY - hs[i]); open = true; }
          else g.lineTo(xs[i], baseY - hs[i]);
        } else if (open) { g.strokePath(); open = false; }
      }
      if (open) g.strokePath();
    }

    // Tree silhouettes planted on the surface — nature returning, but a lot
    // of it burned: a mix of live conifers and dead snags
    if (opts.trees !== undefined) {
      const spacing = 64;
      const first = Math.floor((off - 40) / spacing);
      const density = Phaser.Math.Clamp(this.shape.trees, 0, 1);
      for (let i = first; i < first + Math.ceil(this.width / spacing) + 2; i++) {
        if (propRand(i + 400) > density) continue;
        const sx = i * spacing + propRand(i) * 40 - off;
        if (sx < -20 || sx > this.width + 20) continue;
        const ty = baseY - surfaceAt(sx);
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
   * One of the dead, on the ground line. The anatomy, gait and archetype all
   * live in Crowds — this just picks a variant from the position's own seed so
   * a given patch of ground is populated the same way every flight.
   */
  private drawWalker(
    g: Phaser.GameObjects.Graphics,
    x: number,
    groundLine: number,
    i: number,
    scale = 1,
    face: 1 | -1 = 1,
  ): void {
    drawUndead(g, x, groundLine, this.t, i, scale, face, undeadKindFor(i), this.crowdStyle);
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
    const a = this.shape.ridgeAmp;
    this.drawRidgeLayer(g, scrollX, 0.022, baseY, 42 * hMult * a, 55 * hMult * a, 13.4, this.pal.far, { alpha: 0.6 });
    this.drawRidgeLayer(g, scrollX, 0.038, baseY, 55 * hMult * a, 70 * hMult * a, 1.7, this.pal.far, { alpha: 0.85 });

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

    const amp = this.shape.ridgeAmp;
    this.drawRidgeLayer(
      g, scrollX, 0.08, baseY, 85 * hMult * amp, 115 * hMult * amp, 4.2, this.pal.mountain, {
        shade: this.pal.mountainDark,
        highlight: lerpColor(this.pal.mountain, 0xffffff, 0.35),
        snow: this.pal.snow,
        snowMin: (this.shape.caps > 0.4 ? 150 : 1e9) * hMult * amp,
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
    const a = Phaser.Math.Clamp((alt - 170) / 220, 0, 1) * 0.5;
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

  /**
   * Cloud strata stacked up through the sky at fixed world altitudes.
   *
   * Above ALT_BAND the aircraft holds a fixed screen position and the ground
   * has long since dropped away, so without these there is NOTHING on screen
   * that moves when you climb or descend — a 50 m glide changed only the
   * number on the gauge. These layers slide vertically past you at every
   * altitude, so gaining and losing height is always legible.
   */
  private drawClouds(scrollX: number, alt: number): void {
    const g = this.cloudGfx;
    g.clear();

    const groundScreenY = this.groundY + Math.max(0, (alt - ALT_BAND) * this.pxPerM);
    const body = lerpColor(0x1e2632, 0xffffff, this.dl);           // night clouds go dark
    const shade = lerpColor(0x141a24, 0x9aa8b4, this.dl);
    const hi = lerpColor(body, 0xffffff, 0.4);

    for (let layer = 0; layer < CLOUD_LAYER_ALTS.length; layer++) {
      const layerAlt = CLOUD_LAYER_ALTS[layer];
      const baseY = groundScreenY - layerAlt * this.pxPerM;
      if (baseY < -160 || baseY > this.height + 160) continue;

      // Higher decks drift more slowly and thin out
      const drift = 0.05 / (1 + layer * 0.5);
      const alpha = 0.17 * (1 - layer * 0.11);
      const seedOff = layer * 137;

      for (let i = 0; i < this.cloudOffsets.length; i++) {
        const span = this.width + 300;
        const ox = ((this.cloudOffsets[i] + seedOff - scrollX * drift) % span + span) % span - 150;
        const oy = baseY + ((i + layer) % 3) * 34;
        const w = (80 + ((i + layer) % 3) * 40) * (1 - layer * 0.06);
        g.fillStyle(shade, alpha * 0.8);
        g.fillEllipse(ox + 4, oy + 7, w * 0.95, 20);
        g.fillStyle(body, alpha);
        g.fillEllipse(ox, oy, w, 28);
        g.fillEllipse(ox + 30, oy - 12, w * 0.7, 22);
        g.fillEllipse(ox - 20, oy - 8, w * 0.5, 18);
        g.fillStyle(hi, alpha * 0.5);
        g.fillEllipse(ox + 8, oy - 14, w * 0.4, 10);
      }
    }
  }

  private drawHills(scrollX: number, sink: number, f: WorldFrame): void {
    const g = this.hillGfx;
    g.clear();
    const baseY = this.groundY + sink;

    this.drawRidgeLayer(
      g, scrollX, 0.22, baseY, 26 * this.shape.hillAmp, 46 * this.shape.hillAmp, 8.9, this.pal.hill, {
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
            this.drawWalker(g, sx + z * 12 * s + wander, baseY, i * 3 + z, 0.85 * s, face);
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

    // Layered strata so the near ground reads as dirt, not a flat fill
    for (let i = 0; i < 4; i++) {
      const y0 = gy + 16 + i * 22;
      if (y0 > this.height) break;
      g.fillStyle(lerpColor(this.pal.ground, 0x000000, 0.12 + i * 0.13), 1);
      g.fillRect(0, y0, this.width, 22);
    }
    // Wheel ruts running the length of the strip
    g.lineStyle(2, lerpColor(this.pal.ground, 0x000000, 0.45), 0.5);
    g.lineBetween(0, gy + 30, this.width, gy + 30);
    g.lineBetween(0, gy + 52, this.width, gy + 52);

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
      const zoneA: [number, number] = [-50 * PXM2 - 900, 130 * PXM2 + 900];
      const zoneB: [number, number] = [dPx - 90 * PXM2 - 900, dPx + 90 * PXM2 + 900];
      const cellW = 760;
      const first = Math.floor((scrollX - 100) / cellW);
      for (let c = first; c <= first + Math.ceil(this.width / cellW) + 1; c++) {
        if (propRand(c + 313) < 0.55) continue;
        const wx = c * cellW + propRand(c + 17) * 500;
        if (wx > zoneA[0] && wx < zoneA[1]) continue;
        if (wx > zoneB[0] && wx < zoneB[1]) continue;
        const sx = wx - scrollX;
        if (sx < -60 || sx > this.width + 60) continue;
        const face: 1 | -1 = propRand(c + 91) > 0.5 ? 1 : -1;
        // Usually one drifting alone; now and then a knot of them together,
        // which is how they actually move once they have caught a scent.
        const n = propRand(c + 205) > 0.62 ? 2 + Math.floor(propRand(c + 61) * 3) : 1;
        for (let z = 0; z < n; z++) {
          const wander = Math.sin(this.t * 0.3 + c + z * 1.9) * 9;
          this.drawWalker(g, sx + z * 15 + wander, gy + 1, c * 5 + z, 1.15, face);
        }
      }
    }

    // Runway zones — origin at world 0, destination at the contract distance.
    // Compact ~600 m strips with the airfield buildings right on them and the
    // settlements beyond.
    const PXM = WORLD_PX_PER_M;
    const destPx = Math.max(2000 * PXM, f.routeTotalKm * 1000 * PXM);
    // Short bush strips — a runway should read as a strip, not a motorway
    const oriFrom = -50 * PXM, oriTo = 130 * PXM;
    const dstFrom = destPx - 90 * PXM, dstTo = destPx + 90 * PXM;
    this.drawRunway(g, oriFrom, oriTo, scrollX, gy, f);
    this.drawRunway(g, dstFrom, dstTo, scrollX, gy, f);
    // Origin airfield sits just behind the spawn point (aircraft spawns at
    // screen/world ~300) so the field is on screen from the first frame; the
    // destination's is at its strip entrance, overflown on approach.
    // The fortifications face open country: outbound from the origin field,
    // back down the route from the destination's.
    this.drawAirfield(g, 10, scrollX, gy, 1);
    this.drawAirfield(g, dstFrom + 60, scrollX, gy, -1);
    this.drawSettlement(g, oriFrom - 60, scrollX, gy, -1);
    this.drawSettlement(g, dstTo + 60, scrollX, gy, 1);

    // Cracks / ruts between runways so open terrain isn't sterile
    const spacing = 170;
    const first = Math.floor((scrollX - 60) / spacing);
    for (let i = first; i < first + Math.ceil(this.width / spacing) + 1; i++) {
      const wx = i * spacing + propRand(i + 13) * 80;
      if (wx > oriFrom - 400 && wx < oriTo + 400) continue;
      if (wx > dstFrom - 400 && wx < dstTo + 400) continue;
      const sx = wx - scrollX;
      if (sx < -40 || sx > this.width + 40) continue;
      g.lineStyle(1.5, 0x000000, 0.18);
      g.lineBetween(sx, gy + 6 + propRand(i + 7) * 10, sx + 26 + propRand(i) * 30, gy + 8 + propRand(i + 3) * 12);
    }
  }

  /**
   * A working airfield in a world that has none of the conditions for one.
   *
   * Hangar, control tower and fuel are the easy part; the rest is why the
   * strip still exists — wire, blast barriers, a sandbagged gate with a
   * vehicle checkpoint, watchtowers with lights and guns, and a garrison that
   * is visibly on shift. The dead are always at the wire, and the garrison is
   * always dealing with it, because that is the standing condition here.
   *
   * `dir` points from the airfield toward open country: the fortifications
   * face that way, and so do the guards.
   */
  private drawAirfield(
    g: Phaser.GameObjects.Graphics,
    startPx: number,
    scrollX: number,
    gy: number,
    dir: 1 | -1 = 1,
  ): void {
    const sx = startPx - scrollX;
    if (sx < -700 || sx > this.width + 700) return;

    const dark = 0x15100a;
    const mid = 0x241b10;
    const garrison = garrisonPalette(this.factionColor);
    const night = 1 - this.dl;

    // ── Perimeter: barriers, then wire running out toward open country ────
    const perimX = sx + dir * 300;
    drawBarrier(g, perimX - 22, gy, 44, 24, 3);
    drawBarrier(g, perimX + dir * 30 - 16, gy, 32, 19, 9);
    drawWireFence(g, Math.min(perimX + dir * 56, perimX + dir * 250),
      Math.max(perimX + dir * 56, perimX + dir * 250), gy, 30, 17);

    // Gate: two posts, a lifted boom, and a checkpoint hut
    const gateX = sx + dir * 250;
    g.fillStyle(0x1c1810, 1);
    g.fillRect(gateX - 3, gy - 40, 6, 40);
    g.fillRect(gateX + dir * 54 - 3, gy - 40, 6, 40);
    g.lineStyle(3, 0x8a7430, 0.95);                       // raised boom
    g.lineBetween(gateX + 2, gy - 34, gateX + dir * 40, gy - 52);
    g.fillStyle(dark, 1);
    g.fillRect(gateX + dir * 62, gy - 26, 24, 26);
    g.fillStyle(0x86a0aa, 0.4);
    g.fillRect(gateX + dir * 66, gy - 22, 15, 9);
    if (night > 0.3) {                                     // gate floodlight
      g.fillStyle(0xffe0a0, 0.10 * night);
      g.fillTriangle(gateX, gy - 44, gateX + dir * 130, gy, gateX - dir * 40, gy);
      g.fillStyle(0xfff0c0, 0.9);
      g.fillCircle(gateX, gy - 44, 2);
    }

    // ── Watchtowers: one over the gate, one at the far end of the strip ───
    for (const [twX, twSeed] of [[sx + dir * 210, 5], [sx - dir * 40, 11]] as Array<[number, number]>) {
      const h = 46;
      g.lineStyle(2.6, 0x241b11, 1);
      g.lineBetween(twX - 13, gy, twX - 5, gy - h);
      g.lineBetween(twX + 13, gy, twX + 5, gy - h);
      g.lineStyle(1.4, 0x241b11, 0.9);
      for (let i = 1; i < 4; i++) {
        const y0 = gy - (h * i) / 4, y1 = gy - (h * (i - 1)) / 4;
        const w0 = 13 - (8 * i) / 4, w1 = 13 - (8 * (i - 1)) / 4;
        g.lineBetween(twX - w0, y0, twX + w1, y1);
        g.lineBetween(twX - w0, y0, twX + w0, y0);
      }
      g.fillStyle(0x1c1610, 1);
      g.fillRect(twX - 15, gy - h - 16, 30, 16);           // cab
      g.fillRect(twX - 17, gy - h - 4, 34, 4);             // platform
      g.fillStyle(0x86a0aa, 0.35);
      g.fillRect(twX - 12, gy - h - 13, 24, 7);
      // Sentry on the platform, weapon over the rail
      drawFighter(g, twX + dir * 4, gy - h - 4, this.t, twSeed, 0.62, dir, 'stand', 0, this.dl, garrison);
      // Searchlight sweeping the approach at night
      if (night > 0.35) {
        const sweep = Math.sin(this.t * 0.45 + twSeed);
        g.fillStyle(0xffefc8, 0.09 * night);
        g.fillTriangle(twX, gy - h - 8,
          twX + dir * 230, gy - 70 + sweep * 60,
          twX + dir * 230, gy + 10 + sweep * 60);
        g.fillStyle(0xfff4d8, 0.9);
        g.fillCircle(twX, gy - h - 8, 2.2);
      }
    }

    // ── Hangar: arched roof over a box, door cracked open ─────────────────
    const hx = sx + 20;
    g.fillStyle(mid, 1);
    g.fillRect(hx, gy - 34, 92, 34);
    g.fillStyle(dark, 1);
    g.fillEllipse(hx + 46, gy - 34, 92, 26);
    g.fillStyle(0x0a0805, 1);
    g.fillRect(hx + 30, gy - 24, 32, 24); // open door gap
    g.lineStyle(1, 0x4a3a22, 0.7);
    for (let i = 0; i < 4; i++) g.lineBetween(hx + 8 + i * 22, gy - 32, hx + 8 + i * 22, gy - 2);
    // Faction colours flying over the hangar
    g.lineStyle(1.8, 0x2a2218, 1);
    g.lineBetween(hx + 84, gy - 40, hx + 84, gy - 76);
    const wave = Math.sin(this.t * 2.4) * 3;
    g.fillStyle(this.factionColor, 0.92);
    g.beginPath();
    g.moveTo(hx + 84, gy - 76);
    g.lineTo(hx + 112, gy - 72 + wave);
    g.lineTo(hx + 112, gy - 58 + wave);
    g.lineTo(hx + 84, gy - 54);
    g.closePath();
    g.fillPath();

    // ── Control tower: legs, cab, blinking light ──────────────────────────
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

    // ── Fuel drums, crates, and the ground crew working them ──────────────
    const dx = sx + 220;
    g.fillStyle(0x3a2c18, 1);
    for (let i = 0; i < 3; i++) g.fillRect(dx + i * 9, gy - 10, 7, 10);
    g.fillStyle(mid, 1);
    g.fillRect(dx + 34, gy - 8, 10, 8);
    g.fillRect(dx + 38, gy - 15, 10, 8);
    drawFighter(g, dx + 58, gy, this.t, 23, 0.72, -1, 'work', 0, this.dl, garrison);

    // ── The garrison on shift: two sentries walking the strip ─────────────
    for (let i = 0; i < 2; i++) {
      const beat = Math.sin(this.t * 0.32 + i * 2.1) * 44;
      drawFighter(g, sx + 120 + i * 110 + beat, gy, this.t, 31 + i * 7, 0.76,
        beat > 0 ? 1 : -1, 'patrol', 0, this.dl, garrison);
    }

    // ── And the standing problem: the dead at the wire, being dealt with ──
    const wireX = perimX + dir * 250;
    drawHorde(g, wireX + dir * 30, gy, dir * 120, 9, this.t,
      Math.round(startPx) + 57, this.crowdStyle, -dir as 1 | -1, 0.9);
    for (let i = 0; i < 2; i++) {
      drawCorpse(g, wireX + dir * (14 + i * 26), gy, i * 13 + 3, 0.8, this.crowdStyle);
    }
    // A guard on the barrier putting rounds into them
    const shooterX = perimX + dir * 8;
    const firing = Math.sin(this.t * 4.2) > 0.6;
    drawFighter(g, shooterX, gy - 24, this.t, 47, 0.7, dir, 'aimSide', 0, this.dl, garrison);
    if (firing) {
      const a = dir > 0 ? 0.12 : Math.PI - 0.12;
      drawMuzzleFlash(g, shooterX + dir * 9, gy - 30, a, 1, 2.6);
      g.lineStyle(1.2, 0xffe07a, 0.7);
      g.lineBetween(shooterX + dir * 10, gy - 30, shooterX + dir * 70, gy - 18);
    }
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

    // ── Back row: smaller, hazier, sets the depth ──
    for (let i = 0; i < 7; i++) {
      const bx = sx0 + dir * (26 + i * 62) - dir * 18;
      const bw = 34 + (i % 3) * 10;
      const bh = 22 + propRand(i + 61) * 26;
      g.fillStyle(lerpColor(dark, this.pal.skyBot, 0.28), 1);
      g.fillRect(Math.min(bx, bx + dir * bw), gy - bh, bw, bh);
    }

    // ── Front row ──
    const heights = [34, 58, 26, 70, 42, 30];
    for (let i = 0; i < heights.length; i++) {
      const bx = sx0 + dir * (40 + i * 72);
      const bw = 46 + (i % 3) * 12;
      const bh = heights[i];
      const left = Math.min(bx, bx + dir * bw);
      g.fillStyle(dark, 1);
      g.fillRect(left, gy - bh, bw, bh);

      // Roofline varies: pitched, flat with parapet, or a shed slope
      const roof = Math.floor(propRand(i + 7) * 3);
      if (roof === 0) {
        g.fillTriangle(left - 3, gy - bh, left + bw / 2, gy - bh - 13, left + bw + 3, gy - bh);
      } else if (roof === 1) {
        g.fillRect(left - 2, gy - bh - 4, bw + 4, 4);
      } else {
        g.fillTriangle(left - 2, gy - bh, left + bw + 2, gy - bh - 10, left + bw + 2, gy - bh);
      }

      // Chimney with smoke drifting off it
      if (propRand(i + 19) > 0.45) {
        const chx = left + bw * 0.7;
        g.fillStyle(dark, 1);
        g.fillRect(chx, gy - bh - 14, 5, 14);
        for (let s2 = 0; s2 < 4; s2++) {
          const sway = Math.sin(this.t * 0.8 + s2 + i) * (2 + s2 * 2);
          g.fillStyle(0x1c1812, 0.16 * (1 - s2 / 5));
          g.fillEllipse(chx + 2 + sway - s2 * 2, gy - bh - 20 - s2 * 9, 9 + s2 * 4, 6 + s2 * 2);
        }
      }

      // Lit windows + the warm spill they throw on the ground
      let anyLit = false;
      g.fillStyle(0xe0a040, 0.85);
      for (let wy = gy - bh + 10; wy < gy - 8; wy += 14) {
        for (let wxo = 7; wxo < bw - 6; wxo += 13) {
          if (propRand(i * 31 + wy + wxo) < 0.45) {
            g.fillRect(left + wxo, wy, 4.5, 5.5);
            anyLit = true;
          }
        }
      }
      if (anyLit) {
        const spill = 0.10 + (1 - this.dl) * 0.14;
        g.fillStyle(0xe0a040, spill);
        g.fillEllipse(left + bw / 2, gy + 1, bw * 1.5, 13);
      }
    }

    // Watchtowers on the wall, with a light sweeping the approach at night
    for (const wx of [sx0 + dir * 14, sx0 + dir * 430]) {
      g.fillStyle(dark, 1);
      g.fillRect(wx - 5, gy - 40, 10, 40);
      g.fillRect(wx - 9, gy - 48, 18, 9);
      if (this.dl < 0.6) {
        const sweep = Math.sin(this.t * 0.5 + wx * 0.01);
        g.fillStyle(0xffe8b0, 0.10 * (1 - this.dl));
        g.fillTriangle(wx, gy - 44, wx - dir * 150, gy - 90 + sweep * 55, wx - dir * 150, gy - 30 + sweep * 55);
        g.fillStyle(0xffe8b0, 0.85);
        g.fillCircle(wx, gy - 44, 2);
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

    // Why the walls exist: a press of the dead three deep at the perimeter,
    // laid out in depth rows so it reads as a crowd with volume behind it.
    // `spread` is a magnitude; the horde lays itself out along `-dir`, i.e.
    // outside the wall, facing in toward the settlement.
    drawHorde(
      g, sx0 - dir * 16, gy + 1, -dir * 150, 15, this.t,
      Math.round(anchorPx) * 7 + 3, this.crowdStyle, dir, 1.05,
    );

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
