import Phaser from 'phaser';
import { isTouchDevice } from '../utils/device';
import type { ApproachKind, WeatherCondition } from '../../types';
import { Hazards } from './Hazards';
import { Raiders, MAX_ENGAGEMENT_M, type RaiderFireReport } from './Raiders';
import { AirTraffic } from './AirTraffic';
import { AirMass } from './AirMass';
import { WeatherField, type WeatherCell } from './WeatherField';
import { drawUndead, drawCorpse, drawHorde, undeadKindFor, type CrowdStyle } from './Crowds';
import {
  drawFighter, drawMuzzleFlash, drawWireFence, drawBarrier, garrisonPalette, RAIDER_PALETTE,
} from './Figures';
import { blendBiome, dominantBiome, BIOMES, type BiomeId, type BiomeShape } from './Biomes';
import { SupplyDrops, type DropGuide } from './SupplyDrops';
import { routeSpanPx, originStripPx, destStripPx } from './RoutePreview';
import { CloudSprites, ensureSkyTextures, GLOW_TEX } from './CloudSprites';

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

/**
 * Runway geometry, in screen px, shared by the strip and everything beside it.
 *
 * The deck straddles the aircraft's contact line: RUNWAY_FAR of it lies beyond
 * the wheels, the rest in front. Anything that stands BESIDE the runway —
 * hangar, towers, wire, the crew — therefore belongs on the far apron, above
 * the deck's far edge. When the deck was moved to straddle the line those
 * structures kept their old base at the contact line and ended up standing in
 * the middle of the tarmac.
 */
export const RUNWAY_DECK = 34;
export const RUNWAY_FAR = Math.round(RUNWAY_DECK * 0.38);
/** Depth of the packed-earth apron beyond the far edge that structures stand on. */
export const RUNWAY_APRON = 10;
/**
 * Depth of ground drawn BEHIND the line everything stands on, in px.
 *
 * The hills, the mountains and the distant ruins all used to stand directly
 * on the ground line, so there was no ground behind anything — the world was
 * a stage flat with scenery glued to its back edge, and a roof or a side wall
 * given any depth hung out over the hills with nothing under it. This band is
 * the plain receding from the action line to the foot of the hills.
 */
export const BACK_BAND = 40;

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

/** Smooth lattice noise, 0..1 — the notches and crags a sum of sines cannot make. */
function vnoise(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const a = propRand(i * 1.37 + seed * 31.7), b = propRand((i + 1) * 1.37 + seed * 31.7);
  return a + (b - a) * f * f * (3 - 2 * f);
}

/**
 * Multi-octave ridge profile, continuous in world space — no tiling, no
 * repeating triangles. Returns roughly -1..1.
 */
/** Altitude the marker cumulus sits at — the top of the convective layer. */
const THERMAL_MARKER_M = 400;

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
  /** Usable runway at each end, in metres — from the settlements' profiles. */
  originRunwayM?: number;
  destRunwayM?: number;
  /** What each field is PAVED with, from its approach type. */
  originSurface?: ApproachKind;
  destSurface?: ApproachKind;
  condition: WeatherCondition;
  minutesOfDay: number; // world-clock minutes 0–1439, drives the day/night cycle
  visibility: number;   // 0–1 from weather, dims the sun/moon
  planeScreenX?: number; // for tracer fire aimed at the aircraft
  /** +1 flying down the route, -1 back up it — the drop guide runs ahead of it. */
  heading?: 1 | -1;
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
  private width: number;   // mutable: see resize()
  private height: number;   // mutable: see resize()
  private groundY: number;   // mutable: see resize()

  private readonly skyGfx: Phaser.GameObjects.Graphics;
  private readonly farGfx: Phaser.GameObjects.Graphics;
  private readonly mountainGfx: Phaser.GameObjects.Graphics;
  private readonly deckGfx: Phaser.GameObjects.Graphics;
  private readonly cloudGfx: Phaser.GameObjects.Graphics;
  /** Painted cumulus for the weather cells and the cloud decks (WebGL only). */
  private readonly cellClouds: CloudSprites | null = null;
  private readonly skyClouds: CloudSprites | null = null;
  /** The sun's glow, a soft falloff instead of three nested discs. */
  private readonly sunGlow: Phaser.GameObjects.Image | null = null;
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
  /** Survivors along the route, and the crates you put down to them. */
  readonly drops = new SupplyDrops();
  /**
   * Where a crate released right now would land, set by FlightScene each
   * frame while a site is signalling — null hides the reticle. `altM` is the
   * roof or ground it would come down on.
   */
  dropReticle: { x: number; altM: number; onTarget: boolean; spreadM: number } | null = null;
  /** The drop window to fly into, while a site is calling. */
  dropGuide: DropGuide | null = null;
  /**
   * The approach to fly, while one is being flown: the touchdown point on the
   * strip, the angle down to it, which way you are coming from, and how
   * strongly to draw it. Set by FlightScene; null hides it.
   */
  landingGuide: { aimX: number; angleDeg: number; dir: 1 | -1; fade: number } | null = null;
  /** A height band the training script wants you in. Drawn like the drop window. */
  trainGuide: { lo: number; hi: number; fade: number } | null = null;
  /** The moving air the aircraft actually flies through. */
  readonly air = new AirMass();
  /** Drifting weather cells — the weather is a place, not a global mood. */
  readonly weatherField = new WeatherField();

  private pal: Palette = resolve('clear');   // final: biome + weather + daylight

  /**
   * The light an object in the sky is lit by, from the same graded palette
   * the scenery uses: the sky's colour from above, the ground's from below,
   * the low sun's glow, and the murk of the weather. The aircraft model reads
   * this so it never looks pasted in front of the world it is flying through.
   */
  modelLight(visibility: number): { sky: number; ground: number; sun: number; daylight: number; haze: number; hazeColor: number } {
    const p = this.pal;
    return {
      sky: lerpColor(p.skyTop, p.skyBot, 0.55),
      ground: lerpColor(p.ground, p.hill, 0.5),
      sun: lerpColor(0xfff4e0, p.glow, 0.35),
      daylight: this.dl,
      haze: Math.max(0, Math.min(0.55, (1 - visibility) * 0.6)),
      hazeColor: p.skyBot,
    };
  }
  private shape: BiomeShape = blendBiome('ashland', 'ashland', 0).shape;
  /**
   * True while the aircraft is still on the apron being loaded.
   *
   * The departure used to begin with a fully laden aeroplane sitting on an
   * empty strip: the cargo you are paid to carry never physically existed and
   * nobody ever put it aboard. Set by FlightScene and cleared the moment the
   * engine turns over.
   */
  loading = false;

  /** Route seed, so the channels are in the same place every time you fly it. */
  private routeSeed = 1;
  private routeEndPx = 1;
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
  private readonly rsTop: number[] = [];
  private readonly rsMid: number[] = [];
  private readonly rsUp: number[] = [];
  /** WebGL can shade per corner; the canvas fallback gets flat fills. */
  private readonly webgl: boolean;
  /** How much ground cover to skip: a phone gets a sparser plain. */
  private readonly coverSkip = isTouchDevice() ? 0.62 : 0.4;

  /**
   * Re-fit the world to a new canvas size, in place.
   *
   * Everything here is drawn from scratch every frame against `width`/`height`,
   * so re-fitting is just updating them — no geometry is cached against the old
   * size. That is what lets FlightScene survive a window resize or a device
   * rotation without restarting and throwing away the flight in progress.
   */
  resize(width: number, height: number, groundY: number): void {
    this.width = width;
    this.height = height;
    this.groundY = groundY;
  }

  constructor(scene: Phaser.Scene, width: number, height: number, groundY: number) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    this.groundY = groundY;
    this.webgl = scene.sys.game.renderer.type === Phaser.WEBGL;

    // Creation order = draw order (back → front). Each sprite pool is made
    // straight after the layer it belongs to, so it draws at that depth.
    const painted = this.webgl && ensureSkyTextures(scene);
    this.skyGfx = scene.add.graphics();
    if (painted) this.sunGlow = scene.add.image(0, 0, GLOW_TEX).setVisible(false);
    this.farGfx = scene.add.graphics();
    this.mountainGfx = scene.add.graphics();
    this.deckGfx = scene.add.graphics();
    if (painted) this.cellClouds = new CloudSprites(scene, 120);
    this.cloudGfx = scene.add.graphics();
    if (painted) this.skyClouds = new CloudSprites(scene, 40);
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
    this.traffic.attachModels(scene, 5.05);
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
  setRoute(routeKm: number, seed: number, originRunwayM = 600, destRunwayM = 600, threat = 1): void {
    this.routeSeed = seed;
    this.routeEndPx = Math.max(1, routeKm * 1000 * WORLD_PX_PER_M);
    // The same span the dispatch board previews — see RoutePreview
    const [spanA, spanB] = routeSpanPx(routeKm, originRunwayM, destRunwayM);
    // The country each point is in, crossing over on the same S-curve as the land
    const from = this.biomeFrom, to = this.biomeTo, end = this.routeEndPx;
    this.hazards.generate(spanA, spanB, seed, x => dominantBiome(from, to, x / end));
    // The layout needs to know which positions are afloat, so a stretch over
    // the channels comes out as gun barges rather than sandbag nests.
    this.raiders.layout(this.hazards.zones, seed, x => this.waterAt(x) > 0.25, null, this.hazards.zoneWeapons, threat);
    // The air has to know what it is flowing around, or there is no rotor.
    this.air.reset(seed);
    // Only what is tall enough to shed a rotor — a town is forty sheds
    this.air.setObstacles(this.hazards.all
      .filter(h => h.heightM >= 14)
      .map(h => ({ x: h.x, heightM: h.heightM })));
    this.traffic.reset(seed);
  }

  /**
   * The training circuit: the same world, with its furniture placed by hand.
   * See Hazards.generateTraining.
   */
  setTrainingRoute(routeKm: number, townName: string): { mastX: number; lineEndX: number; zone: [number, number] } {
    const seed = 4242;
    this.routeSeed = seed;
    this.routeEndPx = Math.max(1, routeKm * 1000 * WORLD_PX_PER_M);
    const home = this.biomeFrom;
    const marks = this.hazards.generateTraining(routeKm, townName, () => home);
    this.raiders.layout(this.hazards.zones, seed, () => false, ['nest', 'technical']);
    this.air.reset(seed);
    this.air.setObstacles(this.hazards.all
      .filter(h => h.heightM >= 14)
      .map(h => ({ x: h.x, heightM: h.heightM })));
    this.traffic.reset(seed);
    return marks;
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
    this.planeScreenYForGuide = f.planeScreenY ?? null;

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
    this.drawThermals(f.scrollX, sink, f.altitude);
    this.drawWeatherCells(f.scrollX, sink);
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
      this.drops.drawSites(this.hazardGfx, f.scrollX, gy, this.pxPerM, this.width, this.t, this.dl, this.crowdStyle);
    }

    this.tracerGfx.clear();
    this.raiders.drawTracers(this.tracerGfx, f.scrollX, this.width);

    // Other aircraft ride the SAME altitude mapping as the player's, so a
    // conflict on screen is a conflict in the collision test.
    this.trafficGfx.clear();
    this.traffic.draw(this.trafficGfx, f.scrollX, gy, this.pxPerM, this.width, this.t, this.dl,
      this.modelLight(f.visibility));
    if (this.landingGuide) this.drawLandingGuide(this.trafficGfx, f.scrollX, gy, f.planeWorldX ?? 0);
    this.drops.drawAir(
      this.trafficGfx, f.scrollX, gy, this.pxPerM, this.width, this.t,
      this.dropReticle, this.dropGuide ?? this.trainGuide, f.planeScreenX ?? 300,
    );
  }

  /**
   * Let every weapon within reach take its shot, and report what happened.
   * The ground datum is recomputed here from the aircraft's own altitude so
   * the muzzles the rounds leave from are exactly where they are drawn, even
   * once the ground itself has sunk off the bottom of the frame.
   */
  raiderFire(
    dt: number, planeWorldX: number, planeScreenY: number, altitude: number,
    pressure = 0.5,
  ): RaiderFireReport {
    const gy = this.groundY + Math.max(0, (altitude - ALT_BAND) * this.pxPerM);
    return this.raiders.engage(
      dt, gy, { worldX: planeWorldX, screenY: planeScreenY, altM: altitude }, pressure,
    );
  }

  /** Worst weapon in the stretch ahead, so the climb can start in time. */
  threatAhead(
    worldX: number, rangePx: number, dir: 1 | -1 = 1,
  ): { label: string; ceilingM: number; distancePx: number } | null {
    return this.raiders.threatAhead(worldX, rangePx, dir);
  }

  /**
   * The glide path, drawn in the sky where it is.
   *
   * Landings were the part of every mission testers could not finish: the
   * strip is a few hundred metres long and there was nothing to say whether
   * the descent you were on would put you onto it, short of it or a
   * kilometre past it — the only cue was your sink rate. This is what real
   * fields give a pilot: a path to sit on and lights that tell you if you are
   * on it. Dashes run back up the approach at the angle to fly, chevrons point
   * at the touchdown point, and four lamps by the threshold (a PAPI) show two
   * white and two red when you are on the path — more white too high, more
   * red too low.
   */
  private drawLandingGuide(g: Phaser.GameObjects.Graphics, scrollX: number, gy: number, planeX: number): void {
    const G = this.landingGuide!;
    const tanA = Math.tan((G.angleDeg * Math.PI) / 180);
    const ppm = this.pxPerM;
    const aimSx = G.aimX - scrollX;
    const a = G.fade;
    // Dashes from the touchdown point back up the approach
    for (let d = 10; d < 3200; d += 9) {
      const wx = G.aimX - G.dir * d * WORLD_PX_PER_M;
      const sx = wx - scrollX;
      if (sx < -60 || sx > this.width + 60) continue;
      const y = gy - d * tanA * ppm;
      // Brightest ahead of the aeroplane, fading behind it
      const ahead = G.dir * (wx - planeX) > 0 ? 1 : 0.3;
      const k = G.dir;
      // A dash along the path's own slope
      // (further from the runway is higher: the slope is the path's own)
      const dx = 22, slope = (tanA * ppm) / WORLD_PX_PER_M;
      g.lineStyle(2.4, 0x9fe8b0, 0.75 * a * ahead);
      g.lineBetween(sx - k * dx, y - slope * dx, sx + k * dx * 0.2, y + slope * dx * 0.2);
      // A chevron every few dashes, pointing at the runway
      if (Math.round(d / 9) % 4 === 0) {
        g.lineStyle(2, 0xcff8d8, 0.8 * a * ahead);
        g.lineBetween(sx - k * 8, y - 8, sx + k * 2, y);
        g.lineBetween(sx - k * 8, y + 8, sx + k * 2, y);
      }
    }
    // The touchdown point itself
    if (aimSx > -40 && aimSx < this.width + 40) {
      g.lineStyle(2, 0x9fe8b0, 0.8 * a);
      g.lineBetween(aimSx - 12, gy - 9, aimSx - 12, gy - 2);
      g.lineBetween(aimSx + 12, gy - 9, aimSx + 12, gy - 2);
      g.lineBetween(aimSx - 12, gy - 9, aimSx - 6, gy - 9);
      g.lineBetween(aimSx + 12, gy - 9, aimSx + 6, gy - 9);
    }
    // PAPI: four lamps beside the threshold, white above the path, red below
    const papiX = aimSx - G.dir * 30;
    if (papiX > -40 && papiX < this.width + 40) {
      const altM = Math.max(0, (gy - (this.planeScreenYForGuide ?? gy)) / ppm);
      const distM = Math.max(1, G.dir * (G.aimX - planeX) / WORLD_PX_PER_M);
      const ang = (Math.atan2(altM, distM) * 180) / Math.PI;
      const thresholds = [G.angleDeg + 0.9, G.angleDeg + 0.3, G.angleDeg - 0.3, G.angleDeg - 0.9];
      for (let i = 0; i < 4; i++) {
        const lit = ang > thresholds[i];
        const lx = papiX - G.dir * (i * 9);
        const ly = gy - RUNWAY_FAR - 5 - i * 1.2;
        g.fillStyle(0x14120e, 0.9);
        g.fillRect(lx - 3.5, ly - 1, 7, 5);
        const col = lit ? 0xfff4e0 : 0xff3a28;
        g.fillStyle(col, 0.25 * a);
        g.fillCircle(lx, ly + 1.5, 6);
        g.fillStyle(col, 0.95 * a);
        g.fillCircle(lx, ly + 1.5, 2.1);
      }
    }
  }
  /** The aircraft's screen y, for the PAPI's sight line — set each frame. */
  planeScreenYForGuide: number | null = null;

  /** Highest gun ceiling that covers any of a stretch, 0 if none. */
  gunsReach(x0: number, x1: number): number {
    return this.raiders.gunsReach(x0, x1);
  }

  destroy(): void {
    for (const g of [this.skyGfx, this.farGfx, this.mountainGfx, this.deckGfx,
      this.cloudGfx, this.hillGfx, this.scrubGfx, this.groundGfx, this.hazardGfx,
      this.foreGfx, this.vignetteGfx]) g.destroy();
    this.cellClouds?.destroy();
    this.skyClouds?.destroy();
    this.sunGlow?.destroy();
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

    // A dark, out-of-focus lip across the very bottom of the frame. It frames
    // the shot and gives the near ground somewhere to end, instead of the
    // speckle simply running off the edge of the screen.
    {
      const lipTop = this.height - 26;
      g.fillStyle(lerpColor(this.pal.ground, 0x000000, 0.78), 1);
      g.beginPath();
      g.moveTo(0, this.height + 4);
      for (let x = 0; x <= this.width; x += 22) {
        const w = x + scroll * 0.35;
        g.lineTo(x, lipTop - Math.abs(Math.sin(w * 0.006)) * 12 - propRand(Math.floor(w / 22)) * 7);
      }
      g.lineTo(this.width, this.height + 4);
      g.closePath();
      g.fillPath();
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

  /**
   * Soft cinematic vignette — drawn once, purely framing.
   *
   * It was 26 stacked hard-edged rectangles from each side, and the eye
   * found their edges as a pair of pale vertical bands framing the picture.
   * Four alpha gradients have no edge to find.
   */
  private drawVignette(): void {
    const g = this.vignetteGfx;
    g.clear();
    const W = this.width, H = this.height;
    const k = 0x000000;
    if (this.webgl) {
      const side = W * 0.16, top = H * 0.14;
      g.fillGradientStyle(k, k, k, k, 0.22, 0, 0.22, 0);
      g.fillRect(0, 0, side, H);
      g.fillGradientStyle(k, k, k, k, 0, 0.22, 0, 0.22);
      g.fillRect(W - side, 0, side, H);
      g.fillGradientStyle(k, k, k, k, 0.16, 0.16, 0, 0);
      g.fillRect(0, 0, W, top);
      g.fillGradientStyle(k, k, k, k, 0, 0, 0.2, 0.2);
      g.fillRect(0, H - top, W, top);
    } else {
      g.fillStyle(k, 0.06);
      g.fillRect(0, 0, W * 0.05, H);
      g.fillRect(W * 0.95, 0, W * 0.05, H);
    }
  }

  /**
   * A cumulus: a flat, shadowed base with domed puffs piled on it, each lit on
   * the side facing the low sun. Clouds were three flat ellipses and a
   * highlight, which is a cartoon of a cloud; this is a lump of water vapour
   * with light falling on it.
   */
  private softCloud(
    g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, seed: number,
    alpha: number, body: number, shade: number, hi: number,
  ): void {
    /*
     * Near-opaque puffs, lowest first, each a little brighter the higher it
     * sits — light comes from above, and the base of a cumulus is in its own
     * shadow. Translucent puffs read as soap bubbles: every overlap drew its
     * own ring. Distance is carried by COLOUR (the caller mixes toward the
     * sky), not by seeing through the cloud.
     */
    const n = 6 + Math.floor(propRand(seed) * 4);
    const puffs: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const dome = Math.sin(t * Math.PI);
      const r = h * (0.3 + dome * 0.42) * (0.85 + propRand(seed + i * 3) * 0.3);
      const px = x + (t - 0.5) * w * 0.8 + (propRand(seed + i) - 0.5) * w * 0.08;
      const py = y - dome * h * 0.24 + (propRand(seed + i * 5) - 0.5) * h * 0.12;
      puffs.push([px, py, r]);
    }
    puffs.sort((p, q) => q[1] - p[1]);
    // A soft fringe all round, then the flat dark base
    for (const [px, py, r] of puffs) {
      g.fillStyle(body, alpha * 0.16);
      g.fillCircle(px, py, r * 1.16);
    }
    g.fillStyle(shade, alpha * 0.92);
    g.fillEllipse(x, y + h * 0.2, w * 0.96, h * 0.42);
    const top = y - h * 0.5, span = h * 0.9;
    // One body colour for the whole mass, so no puff draws its own outline…
    const mass = lerpColor(shade, body, 0.8);
    for (const [px, py, r] of puffs) {
      g.fillStyle(mass, alpha * 0.94);
      g.fillCircle(px, py, r);
    }
    // …then the light: faint, overlapping, strongest on the high puffs
    for (const [px, py, r] of puffs) {
      const lift = Phaser.Math.Clamp(1 - (py + r * 0.4 - top) / span, 0, 1);
      g.fillStyle(lerpColor(body, hi, 0.4), alpha * 0.16 * lift);
      g.fillCircle(px - r * 0.18, py - r * 0.22, r * 0.72);
    }
    // and the underside in its own shadow
    g.fillStyle(shade, alpha * 0.3);
    g.fillEllipse(x + w * 0.04, y + h * 0.14, w * 0.86, h * 0.3);
  }

  /** A cumulus: the painted sprite when there is a pool, the Graphics one if not. */
  private cumulus(
    pool: CloudSprites | null, g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number,
    seed: number, alpha: number, body: number, shade: number, hi: number,
  ): void {
    if (!pool) {
      this.softCloud(g, x, y, w, h, seed, alpha, body, shade, hi);
      return;
    }
    // A touch more solid than the discs were: the painted edge is already soft
    pool.draw(x, y, w, h, seed, Math.min(1, alpha * 1.12), lerpColor(body, hi, 0.5), lerpColor(body, shade, 0.2), this.width);
  }

  /**
   * A rectangle of haze with no edges: alpha fades top to bottom, and the
   * left and right ends fade out over `edge` pixels. For rain curtains, dust
   * walls and fog banks — anything that used to be a hard box.
   */
  private softRect(
    g: Phaser.GameObjects.Graphics, x0: number, x1: number, y0: number, y1: number,
    color: number, aTop: number, aBot: number, edge: number,
  ): void {
    if (x1 - x0 <= 2 * edge || y1 <= y0) return;
    if (!this.webgl) {
      g.fillStyle(color, (aTop + aBot) / 2);
      g.fillRect(x0 + edge, y0, x1 - x0 - 2 * edge, y1 - y0);
      return;
    }
    const c = color;
    g.fillGradientStyle(c, c, c, c, 0, aTop, 0, aBot);
    g.fillRect(x0, y0, edge, y1 - y0);
    g.fillGradientStyle(c, c, c, c, aTop, aTop, aBot, aBot);
    g.fillRect(x0 + edge, y0, x1 - x0 - 2 * edge, y1 - y0);
    g.fillGradientStyle(c, c, c, c, aTop, 0, aBot, 0);
    g.fillRect(x1 - edge, y0, edge, y1 - y0);
  }

  /** A slanted curtain (rain), fading from the cloud base to the ground. */
  private curtain(
    g: Phaser.GameObjects.Graphics, xTop: number, yTop: number, xBot: number, yBot: number, w: number,
    color: number, aTop: number, aBot: number,
  ): void {
    if (!this.webgl) {
      g.fillStyle(color, (aTop + aBot) / 2);
      g.fillTriangle(xTop, yTop, xTop + w, yTop, xBot, yBot);
      return;
    }
    const c = color;
    g.fillGradientStyle(c, c, c, c, aTop, aTop, aBot, aBot);
    g.fillTriangle(xTop, yTop, xTop + w, yTop, xBot, yBot);
    g.fillGradientStyle(c, c, c, c, aTop, aBot, aBot, aBot);
    g.fillTriangle(xTop + w, yTop, xBot + w, yBot, xBot, yBot);
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
      if (this.sunGlow) {
        this.sunGlow.setPosition(sx, sy).setDisplaySize(260, 260).setTint(sunCol)
          .setAlpha(Math.min(1, sa)).setVisible(true);
      } else {
        g.fillStyle(sunCol, 0.08 * sa); g.fillCircle(sx, sy, 52);
        g.fillStyle(sunCol, 0.16 * sa); g.fillCircle(sx, sy, 32);
        g.fillStyle(sunCol, 0.9 * sa);  g.fillCircle(sx, sy, 16);
      }
    } else {
      this.sunGlow?.setVisible(false);
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
      /** Surface marks — scrub, rock, scree — scaled by how near the layer is, 0 = none. */
      texture?: number;
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
        /*
         * Flat tops, SLOPED risers.
         *
         * Rounding to the nearest step made every riser a vertical cliff, so
         * mesa country read as a stack of boxes. A smoothstep across the
         * middle of each band keeps the tops flat — which is what makes it
         * sandstone — and gives the faces the talus slope real ones have.
         */
        const stepH = Math.max(12, ampBase * 0.42);
        const band = h / stepH;
        const lo = Math.floor(band);
        const f = band - lo;
        const e = Math.max(0, Math.min(1, (f - 0.3) / 0.4));
        const terraced = (lo + e * e * (3 - 2 * e)) * stepH;
        h = h + (terraced - h) * sh.plateau;
      }
      /*
       * Rock does not come in sine waves. Two octaves of lattice noise break
       * the crest into shoulders, notches and crags — the silhouette detail
       * that separates a mountain from a smooth blob. Mesa tops stay flat.
       */
      const rk = (ampBase + ampVar) * (0.045 + sh.roughness * 0.035);
      h += (vnoise(wx / 84, seed) - 0.5) * rk * 2 * (1 - sh.plateau * 0.8)
        + (vnoise(wx / 30, seed + 17) - 0.5) * rk * (1 - sh.plateau * 0.6);
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

    /*
     * ── The face, lit by the same low sun as everything else ─────────────
     *
     * The layers used to be one flat colour with four nested darker
     * silhouettes laid over it — hard-edged bands that read as stacked paper.
     * Now each column of the ridge is filled with its own vertical gradient:
     * the crest takes the light according to which way that bit of slope
     * faces (the sun is low on the left, so a face rising to the right is
     * lit and one falling away is in shadow), the body darkens down the face,
     * and the foot dissolves into the haze lying in the valley. The result
     * is relief — gullies, spurs and shoulders — instead of a cut-out.
     */
    const alpha = opts.alpha ?? 1;
    const lit = opts.highlight ?? lerpColor(color, 0xffffff, 0.22);
    const dark = opts.shade ?? lerpColor(color, 0x000000, 0.3);
    const hazeFoot = lerpColor(color, this.pal.skyBot, 0.42);
    const texK = opts.texture ?? 0;
    const vegTint = lerpColor(this.pal.hill, this.pal.scrub, 0.35);
    if (this.webgl) {
      // Light per VERTEX from the slope either side of it, so neighbouring
      // columns share their edge colours and the shading flows instead of
      // striping column by column.
      /*
       * Two scales of light. The crags in the crest catch it bit by bit, but
       * only for the top of the face; below that the face is lit by the broad
       * shape of the mountain. Carrying each crag's light all the way down
       * striped the face into curtains.
       */
      const tops = this.rsTop, mids = this.rsMid, ups = this.rsUp;
      tops.length = 0; mids.length = 0; ups.length = 0;
      for (let i = 0; i < n; i++) {
        const a = hs[Math.max(0, i - 1)], b = hs[Math.min(n - 1, i + 1)];
        const slope = (b - a) / (2 * step);
        const ia = Math.max(0, i - 4), ib = Math.min(n - 1, i + 4);
        const broad = ib > ia ? (hs[ib] - hs[ia]) / ((ib - ia) * step) : 0;
        const k = Phaser.Math.Clamp(0.45 + slope * 0.9, 0, 1);
        const kb = Phaser.Math.Clamp(0.45 + broad * 0.9, 0, 1);
        const wxv = (i0 + i) * step;
        const veg = 0.5 + 0.5 * Math.sin(wxv * 0.0042 + seed) * Math.sin(wxv * 0.0013 + seed * 1.7);
        tops.push(lerpColor(lerpColor(dark, lit, k), vegTint, veg * 0.18 * texK));
        ups.push(lerpColor(lerpColor(lerpColor(dark, lit, kb), color, 0.35), vegTint, veg * 0.26 * texK));
        mids.push(lerpColor(lerpColor(color, dark, 0.35 + (1 - kb) * 0.25), vegTint, veg * 0.38 * texK));
      }
      const yb = baseY + 60;
      for (let i = 0; i + 1 < n; i++) {
        const x0 = xs[i], x1 = xs[i + 1];
        const y0 = baseY - hs[i], y1 = baseY - hs[i + 1];
        const yu0 = baseY - hs[i] * 0.84, yu1 = baseY - hs[i + 1] * 0.84;
        const ym0 = baseY - hs[i] * 0.45, ym1 = baseY - hs[i + 1] * 0.45;
        const t0 = tops[i], t1 = tops[i + 1], m0 = mids[i], m1 = mids[i + 1];
        const u0 = ups[i], u1 = ups[i + 1];
        // crest → just under it: the crags' own light
        g.fillGradientStyle(t0, t1, u0, u0, alpha, alpha, alpha, alpha);
        g.fillTriangle(x0, y0, x1, y1, x0, yu0);
        g.fillGradientStyle(t1, u1, u0, u0, alpha, alpha, alpha, alpha);
        g.fillTriangle(x1, y1, x1, yu1, x0, yu0);
        // → mid-face, lit by the mountain's broad shape
        g.fillGradientStyle(u0, u1, m0, m0, alpha, alpha, alpha, alpha);
        g.fillTriangle(x0, yu0, x1, yu1, x0, ym0);
        g.fillGradientStyle(u1, m1, m0, m0, alpha, alpha, alpha, alpha);
        g.fillTriangle(x1, yu1, x1, ym1, x0, ym0);
        // mid-face → hazy foot
        g.fillGradientStyle(m0, m1, hazeFoot, hazeFoot, alpha, alpha, alpha, alpha);
        g.fillTriangle(x0, ym0, x1, ym1, x0, yb);
        g.fillGradientStyle(m1, hazeFoot, hazeFoot, hazeFoot, alpha, alpha, alpha, alpha);
        g.fillTriangle(x1, ym1, x1, yb, x0, yb);
      }
    } else {
      g.fillStyle(color, alpha);
      g.beginPath();
      g.moveTo(xs[0], baseY + 60);
      for (let i = 0; i < n; i++) g.lineTo(xs[i], baseY - hs[i]);
      g.lineTo(xs[n - 1], baseY + 60);
      g.closePath();
      g.fillPath();
    }

    /*
     * ── What the land is made of ─────────────────────────────────────────
     *
     * A smooth gradient on a smooth silhouette is a CG mesh with no texture
     * on it — "an unfinished 3D model" was exactly right. Real hillsides are
     * broken up: scrub and trees gathered in the folds, bare rock on the
     * shoulders catching the sun, scree under the crags. Marks are scattered
     * per column from the world position (so they scroll with the land and
     * never shimmer), sized by how near the layer is, and coloured from the
     * layer's own palette so they sit in it rather than on it.
     */
    if (texK > 0) {
      const rockLit = lerpColor(lit, 0xffffff, 0.12);
      const rockDark = lerpColor(dark, 0x000000, 0.3);
      const scrubCol = lerpColor(vegTint, 0x000000, 0.35);
      const marks = Math.max(1, Math.round(1 + texK * 2.2));
      for (let i = 0; i + 1 < n; i++) {
        const wx = (i0 + i) * step;
        const veg = 0.5 + 0.5 * Math.sin(wx * 0.0042 + seed) * Math.sin(wx * 0.0013 + seed * 1.7);
        const slope = (hs[i + 1] - hs[i]) / step;
        for (let k = 0; k < marks; k++) {
          const r1 = propRand(wx * 0.37 + k * 13.1 + seed);
          const r2 = propRand(wx * 0.11 + k * 7.3 + seed * 3);
          const fy = 0.06 + r1 * 0.82;               // how far down the face
          const h = hs[i] + (hs[i + 1] - hs[i]) * r2;
          const x = xs[i] + r2 * step;
          const y = baseY - h * (1 - fy);
          if (fy > 0.4 && veg > 0.45) {
            // Scrub and trees in the folds, thinning out into the haze
            const sz = (1 + r2 * 1.8) * (0.45 + texK * 0.8);
            g.fillStyle(lerpColor(lerpColor(scrubCol, color, 0.3), hazeFoot, (fy - 0.4) * 0.9), 0.5 * alpha);
            g.fillEllipse(x, y, sz * 2.4, sz * 1.5);
            if (r1 > 0.6) g.fillEllipse(x + sz * 1.3, y + sz * 0.3, sz * 1.8, sz * 1.2);
          } else if (fy < 0.55) {
            // Rock: lit on the faces that look at the sun, dark on the rest
            const lw = Math.max(0.7, 1.2 * texK);
            g.lineStyle(lw, slope > 0 ? rockLit : rockDark, 0.32 * alpha);
            g.lineBetween(x, y, x + (2 + r1 * 5) * (0.5 + texK), y + (1.5 + r2 * 4) * (0.5 + texK));
          } else {
            // Scree: a scatter of pale grit down the lower slope
            g.fillStyle(lerpColor(color, rockLit, 0.4), 0.25 * alpha);
            g.fillCircle(x, y, 0.8 + r2 * texK);
          }
        }
      }
    }

    if (opts.shade !== undefined) {
      /*
       * Gullies: erosion runs straight down the fall line from the crest, so
       * a few dark strokes from the high points down the face are what turn a
       * smooth ridge into rock.
       */
      const ga = 0.2 + this.shape.roughness * 0.06;
      if (this.webgl) {
        /*
         * Wedges, not wires: a gully is widest where it bites into the crest
         * and fades out down the face, and the spur beside it catches the
         * sun. A dark stroke of constant width read as a seam in a mesh.
         */
        const sc = opts.shade, lc = lit;
        for (let i = 1; i + 1 < n; i++) {
          if (hs[i] < hs[i - 1] || hs[i] < hs[i + 1]) continue;   // off the local highs
          const r1 = propRand(i0 + i), r2 = propRand(i0 + i + 7);
          if (r1 < 0.2) continue;
          const len = hs[i] * (0.3 + r1 * 0.35);
          const lean = (r2 - 0.5) * 14;
          const w = 2 + r1 * 3;
          const x = xs[i], y = baseY - hs[i] + 1;
          g.fillGradientStyle(sc, sc, sc, sc, ga, ga, 0, 0);
          g.fillTriangle(x - w * 0.2, y, x + w, y + 2, x + lean, y + len);
          g.fillGradientStyle(lc, lc, lc, lc, ga * 0.35, ga * 0.35, 0, 0);
          g.fillTriangle(x - w * 1.3, y + 2, x - w * 0.3, y, x - w * 0.5 + lean * 0.6, y + len * 0.55);
        }
      } else {
        g.lineStyle(1.2, opts.shade, ga);
        for (let i = 2; i + 2 < n; i += 2) {
          if (hs[i] < hs[i - 2] || hs[i] < hs[i + 2]) continue;
          const len = hs[i] * (0.35 + propRand(i0 + i) * 0.3);
          const lean = (propRand(i0 + i + 7) - 0.5) * 10;
          g.lineBetween(xs[i], baseY - hs[i] + 2, xs[i] + lean, baseY - hs[i] + len);
        }
      }
      /*
       * Strata. Broken contour lines at fixed fractions of the local height,
       * so they follow the land. On sandstone they are bedding planes, on
       * the high ridges they are rock bands, and either way they are the
       * surface detail the layer never had. Broken deterministically so they
       * read as rock, not as a ruled line.
       */
      const strata = 0.07 + sh.plateau * 0.10 + sh.roughness * 0.03;
      for (const frac of [0.88, 0.7, 0.52]) {
        g.lineStyle(1, opts.shade, strata);
        let open = false;
        for (let i = 0; i < n; i++) {
          const keep = Math.sin((i0 + i) * 1.7 + frac * 40 + seed) > -0.35;
          const x = xs[i], y = baseY - hs[i] * frac;
          if (keep && !open) { g.beginPath(); g.moveTo(x, y); open = true; }
          else if (keep && open) g.lineTo(x, y);
          else if (!keep && open) { g.strokePath(); open = false; }
        }
        if (open) g.strokePath();
      }
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
      if (this.webgl) {
        /*
         * A cap, not a line: deepest over the high points, thinning to
         * nothing at the snow line, ragged where it runs down into the
         * gullies. A stroke along the crest read as a wire laid on the hill.
         */
        const sm = opts.snowMin, sc = opts.snow;
        const depth = (k: number): number => {
          const over = hs[k] - sm;
          // Ragged along the range, but on a scale of tens of metres — a
          // random depth per vertex striped the face like a curtain
          return over <= 0 ? 0
            : Math.min(hs[k] * 0.3, over * 0.6 + 3, 34) * (0.6 + vnoise((i0 + k) * step / 46, seed + 5) * 0.8);
        };
        for (let i = 0; i + 1 < n; i++) {
          const d0 = depth(i), d1 = depth(i + 1);
          if (d0 <= 0 && d1 <= 0) continue;
          const a0 = d0 > 0 ? 0.92 : 0, a1 = d1 > 0 ? 0.92 : 0;
          const y0 = baseY - hs[i], y1 = baseY - hs[i + 1];
          const b0 = y0 + Math.max(1, d0), b1 = y1 + Math.max(1, d1);
          g.fillGradientStyle(sc, sc, sc, sc, a0, a1, 0, 0);
          g.fillTriangle(xs[i], y0, xs[i + 1], y1, xs[i], b0);
          g.fillGradientStyle(sc, sc, sc, sc, a1, 0, 0, 0);
          g.fillTriangle(xs[i + 1], y1, xs[i + 1], b1, xs[i], b0);
        }
      } else {
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
    }

    // Tree silhouettes planted on the surface — nature returning, but a lot
    // of it burned: a mix of live conifers and dead snags
    if (opts.trees !== undefined) {
      // Trees stand in stands, not in a picket line: a slow pattern decides
      // where the woods are, and inside a wood they are close together
      const spacing = 22;
      const first = Math.floor((off - 40) / spacing);
      const density = Phaser.Math.Clamp(this.shape.trees, 0, 1);
      for (let i = first; i < first + Math.ceil(this.width / spacing) + 2; i++) {
        const wood = 0.5 + 0.5 * Math.sin(i * spacing * 0.0031 + seed * 2.1) * Math.sin(i * spacing * 0.0009 + seed);
        if (propRand(i + 400) > density * (wood > 0.55 ? 1.6 : 0.25)) continue;
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
        /**
         * A dead city block, not a black rectangle.
         *
         * These were one of two flat fills, so a skyline was a paper cut-out
         * pasted on the haze. Each block now gets a sunward face and a shade
         * face, a grid of blown-out windows, and floor slabs showing through
         * where the front has come off — which is what says "this was a
         * building" rather than "this is a shape".
         */
        // Out at the foot of the hills: they take on the colour of distance
        const base = lerpColor(propRand(c + b) > 0.5 ? 0x171310 : 0x1d1813, this.pal.far, 0.42);
        const col = base;
        const litFace = lerpColor(base, this.pal.glow, 0.16);
        const darkFace = lerpColor(base, 0x000000, 0.45);

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

        // Sunward face and shade face: two rectangles, and the block stops
        // being a cut-out and starts being a solid with a side to it.
        g.fillStyle(litFace, 0.85);
        g.fillRect(bx, baseY - bh + 12, bw * 0.30, bh - 12);
        g.fillStyle(darkFace, 0.75);
        g.fillRect(bx + bw * 0.62, baseY - bh + 10, bw * 0.38, bh - 10);

        // Floor slabs showing through where the frontage has come away —
        // the detail that reads as a BUILDING rather than a shape.
        g.fillStyle(0x0a0806, 0.55);
        for (let fy = baseY - bh + 20; fy < baseY - 10; fy += 15) {
          if (propRand(fy + c + b) < 0.45) continue;
          g.fillRect(bx + bw * 0.22, fy, bw * 0.56, 2.2);
        }

        // Dead windows, brighter on the lit face, black on the shaded one
        for (let wy = baseY - bh + 14; wy < baseY - 8; wy += 12) {
          for (let wx = bx + 5; wx < bx + bw - 4; wx += 9) {
            if (propRand(wx + wy + c) >= 0.55) continue;
            const onLit = wx < bx + bw * 0.34;
            g.fillStyle(onLit ? 0x2a221a : 0x000000, onLit ? 0.65 : 0.55);
            g.fillRect(wx, wy, 3.5, 5);
          }
        }
        // Scorch up the face from whatever burned inside
        g.fillStyle(0x0a0806, 0.6);
        g.fillRect(bx + bw * 0.3, baseY - bh + 8, 4, bh * 0.4);
        // Rebar spraying from the broken roofline
        g.lineStyle(1, 0x0d0b08, 0.7);
        for (let k = 0; k < 4; k++) {
          const rx = bx + bw * (0.3 + k * 0.16);
          g.lineBetween(rx, baseY - bh + 2, rx + (k % 2 ? 3 : -3), baseY - bh - 5 - (k % 3) * 4);
        }
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
    const baseY = this.groundY + sink - BACK_BAND;

    // Two overlapping far ranges for a deep horizon, the further one paler
    const a = this.shape.ridgeAmp;
    const farPale = lerpColor(this.pal.far, this.pal.skyBot, 0.35);
    this.drawRidgeLayer(g, scrollX, 0.022, baseY, 42 * hMult * a, 55 * hMult * a, 13.4, farPale, { alpha: 0.75 });
    this.drawRidgeLayer(g, scrollX, 0.038, baseY, 55 * hMult * a, 70 * hMult * a, 1.7, this.pal.far, { alpha: 0.9, texture: 0.25 });
    this.hazeBand(g, baseY - 150, baseY + 4, 0.22);
  }

  /**
   * Air lying in front of a distant layer: transparent at the top, thickest
   * at the foot where the light has the most air to cross. A gradient, so
   * there is no edge for the eye to catch — the stacked rectangles this
   * replaces were visible as steps.
   */
  private hazeBand(g: Phaser.GameObjects.Graphics, top: number, bottom: number, maxAlpha: number): void {
    const c = this.pal.skyBot;
    if (this.webgl) {
      g.fillGradientStyle(c, c, c, c, 0, 0, maxAlpha, maxAlpha);
      g.fillRect(0, top, this.width, bottom - top);
    } else {
      g.fillStyle(c, maxAlpha * 0.4);
      g.fillRect(0, (top + bottom) / 2, this.width, (bottom - top) / 2);
    }
  }

  private drawMountains(scrollX: number, sink: number, hMult: number): void {
    const g = this.mountainGfx;
    g.clear();
    const baseY = this.groundY + sink - BACK_BAND;

    const amp = this.shape.ridgeAmp;
    this.drawRidgeLayer(
      g, scrollX, 0.08, baseY, 85 * hMult * amp, 115 * hMult * amp, 4.2, this.pal.mountain, {
        shade: this.pal.mountainDark,
        highlight: lerpColor(this.pal.mountain, 0xffffff, 0.35),
        snow: this.pal.snow,
        snowMin: (this.shape.caps > 0.4 ? 150 : 1e9) * hMult * amp,
        texture: 0.55,
      },
    );

    // Haze lying in the valleys at the mountain feet
    this.hazeBand(g, baseY - 80, baseY + 4, 0.16);
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
  /**
   * Where the lift is, drawn where the lift is.
   *
   * A field of invisible vertical air is not a mechanic, it is a random
   * altitude wobble — the player has to be able to SEE a thermal to decide to
   * fly through it. Every cue here sits at the column's own world x at 1:1, so
   * what you steer at is what you get: dust lifting off the ground at the
   * base, debris and birds turning in the column, and a scrap of cumulus
   * marking the top. That is exactly how a real pilot reads the sky.
   */
  private drawThermals(scrollX: number, sink: number, altitudeM: number): void {
    const g = this.scrubGfx;
    const gy = this.groundY + sink;
    // Cued off the same field the physics reads, so they cannot disagree
    const SPACING = 2400;
    const first = Math.floor((scrollX - 400) / SPACING);
    for (let i = first; i <= first + Math.ceil(this.width / SPACING) + 1; i++) {
      const core = this.air.thermalCoreNear(i * SPACING);
      const sx = core.x - scrollX;
      if (sx < -220 || sx > this.width + 220) continue;
      // Sample the real field so a dead (overcast, night) column draws nothing
      const strength = this.air.sample(core.x, Math.max(60, altitudeM)).vertical;
      if (strength < 0.6) continue;
      const a = Phaser.Math.Clamp(strength / 6, 0.12, 0.75);

      // Dust picked up off the deck and drawn up into the column
      for (let k = 0; k < 9; k++) {
        const climb = ((this.t * (26 + k * 5) + k * 61 + i * 37) % 260);
        const y = gy - climb;
        if (y < gy - 300 || y > gy) continue;
        const spread = 6 + climb * 0.17;
        g.fillStyle(lerpColor(this.pal.ground, 0xffffff, 0.30), a * 0.30 * (1 - climb / 260));
        g.fillEllipse(sx + Math.sin(this.t * 1.4 + k * 2.1) * spread, y, 10 + climb * 0.10, 5 + climb * 0.05);
      }

      // A dust devil rotating at the base — the unmistakable tell
      if (strength > 3.4) {
        g.lineStyle(1.4, lerpColor(this.pal.ground, 0xffffff, 0.45), a * 0.5);
        g.beginPath();
        for (let k = 0; k <= 22; k++) {
          const t0 = k / 22;
          const y = gy - t0 * 90;
          const x = sx + Math.sin(this.t * 3.4 + t0 * 7) * (4 + t0 * 13);
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.strokePath();
      }

      // Scraps of cumulus marking the top of the column. This is the cue you
      // read from a distance and steer at.
      const topY = gy - (THERMAL_MARKER_M - altitudeM) * this.pxPerM;
      if (topY > -60 && topY < this.height) {
        for (let k = 0; k < 3; k++) {
          const ox = (k - 1) * 26 + Math.sin(this.t * 0.3 + i + k) * 6;
          g.fillStyle(0xf0ece4, a * 0.5);
          g.fillEllipse(sx + ox, topY + (k % 2) * 5, 44 - k * 6, 20 - k * 3);
        }
        g.fillStyle(0x9a9086, a * 0.35);
        g.fillEllipse(sx, topY + 11, 78, 10);
      }
    }
  }

  /**
   * Weather you can see coming.
   *
   * This is what turns a cell from a status effect into a decision. A storm
   * stands on the horizon as a dark column with rain shafts under it, a dust
   * cell as a wall rolling along the deck — and because both are drawn at the
   * cell's own world x at 1:1, the thing you are looking at is exactly the
   * thing you will fly into. Deciding to go over, round, or straight through
   * is only a decision if you can see it in time to make it.
   */
  private drawWeatherCells(scrollX: number, sink: number): void {
    const g = this.deckGfx;
    const gy = this.groundY + sink;
    const dl = this.dl;
    this.cellClouds?.begin();
    for (const c of this.weatherField.all) {
      const strength = this.weatherField.strength(c);
      if (strength < 0.05) continue;
      const sx = c.x - scrollX;
      const r = c.radius;
      if (sx + r < -260 || sx - r > this.width + 260) continue;

      const a = strength;
      const seed = Math.floor(c.x * 0.01);
      switch (c.kind) {
        case 'thunderstorm': {
          // A towering cell: dark, rain-laden base, cauliflower tower, anvil
          const baseY = gy - 150 * this.pxPerM * 0.55;
          const topY = gy - 470 * this.pxPerM * 0.55;
          // Rain first, falling out of the base and leaning with the wind
          const lean = 46 + Math.sin(this.t * 0.2 + seed) * 10;
          for (let k = 0; k < 7; k++) {
            const x0 = sx + (k / 6 - 0.5) * r * 1.3 + Math.sin(this.t * 0.3 + k * 1.7) * 10;
            const w = r * (0.16 + propRand(seed + k) * 0.12);
            this.curtain(g, x0, baseY + 10, x0 + lean, gy, w, 0x252a34, a * 0.38, a * 0.08);
          }
          g.lineStyle(1, 0x8a96a8, a * 0.16);
          for (let k = 0; k < 26; k++) {
            const x0 = sx + (propRand(seed + k * 3) - 0.5) * r * 1.5;
            const y0 = baseY + 20 + ((this.t * 220 + k * 37) % Math.max(40, gy - baseY - 20));
            g.lineBetween(x0, y0, x0 + 9, y0 + 26);
          }
          const body = lerpColor(lerpColor(0x4a505c, this.pal.skyBot, 0.25), 0x1a1d24, 1 - dl);
          const lit = lerpColor(body, lerpColor(0xffffff, this.pal.glow, 0.35), 0.45 * dl);
          const dark = lerpColor(body, 0x0a0c10, 0.55);
          const steps = 8;
          for (let k = 0; k < steps; k++) {
            const t0 = k / (steps - 1);
            const y = baseY - (baseY - topY) * t0;
            // Narrowing up the tower, then spreading into the anvil at the top
            const wFrac = t0 < 0.72 ? 1.25 - t0 * 0.55 : 0.85 + (t0 - 0.72) * 3.2;
            const ox = Math.sin(k * 1.3 + seed) * r * 0.08 + (t0 > 0.72 ? (t0 - 0.72) * r * 1.2 : 0);
            this.cumulus(this.cellClouds, g, sx + ox, y, r * wFrac * 1.6, 70 + (1 - t0) * 30, seed * 7 + k,
              Math.min(1, a * 1.1), lerpColor(body, lit, t0), k === 0 ? dark : lerpColor(body, dark, 0.25), lit);
          }
          // The flat, black underside the rain falls from
          this.softRect(g, sx - r * 1.05, sx + r * 1.05, baseY - 6, baseY + 22, dark, a * 0.55, a * 0.1, r * 0.3);
          break;
        }
        case 'dust_storm': {
          // A wall rolling along the deck: billows at the front, a haze of
          // suspended grit thinning upward behind them
          const h = 240;
          const dust = lerpColor(0x8a5a2c, this.pal.glow, 0.25);
          const dustDark = lerpColor(dust, 0x2a1a0c, 0.45);
          const dustLit = lerpColor(dust, 0xffe0b0, 0.3 * dl + 0.05);
          this.softRect(g, sx - r * 1.1, sx + r * 1.1, gy - h * 1.1, gy + 4, dust, 0, a * 0.42, r * 0.35);
          for (let k = 0; k < 9; k++) {
            const t0 = k / 8;
            const roll = Math.sin(this.t * 0.6 + k * 1.3) * 16;
            this.cumulus(this.cellClouds, g, sx + (t0 - 0.5) * r * 1.8 + roll,
              gy - h * (0.18 + Math.sin(t0 * Math.PI) * 0.42), r * 0.62, h * 0.55,
              seed * 5 + k, a * 0.62, dust, dustDark, dustLit);
          }
          break;
        }
        case 'blizzard':
        case 'fog': {
          const col = c.kind === 'fog' ? 0x8a8f96 : 0xc4ccd4;
          this.softRect(g, sx - r * 1.1, sx + r * 1.1, gy - 300, gy + 6, col, 0, a * 0.34, r * 0.45);
          for (let k = 0; k < 5; k++) {
            this.cumulus(this.cellClouds, g, sx + (k / 4 - 0.5) * r * 1.6, gy - 120 - (k % 2) * 40, r * 0.7, 80,
              seed * 3 + k, a * 0.3, col, lerpColor(col, 0x404850, 0.3), lerpColor(col, 0xffffff, 0.4));
          }
          break;
        }
        default: {
          // Cloudy / windy: a broad grey mass with a darker base
          const y = gy - 300 * this.pxPerM * 0.5;
          const col = lerpColor(0x6a707a, 0x1a1e24, 1 - dl);
          this.cumulus(this.cellClouds, g, sx, y, r * 1.8, 90, seed, a * 0.6, col, lerpColor(col, 0x000000, 0.35), lerpColor(col, 0xffffff, 0.35));
          break;
        }
      }
    }
    this.cellClouds?.end();
  }

  private drawClouds(scrollX: number, alt: number): void {
    const g = this.cloudGfx;
    g.clear();

    const groundScreenY = this.groundY + Math.max(0, (alt - ALT_BAND) * this.pxPerM);
    const body = lerpColor(0x2a3240, lerpColor(0xf4f0ea, this.pal.skyBot, 0.18), this.dl);
    const shade = lerpColor(0x141a24, lerpColor(0x8a96a4, this.pal.skyTop, 0.3), this.dl);
    const hi = lerpColor(body, lerpColor(0xffffff, this.pal.glow, 0.4), 0.55 * this.dl);

    this.skyClouds?.begin();
    for (let layer = 0; layer < CLOUD_LAYER_ALTS.length; layer++) {
      const layerAlt = CLOUD_LAYER_ALTS[layer];
      const baseY = groundScreenY - layerAlt * this.pxPerM;
      if (baseY < -200 || baseY > this.height + 200) continue;

      // Higher decks drift more slowly, and sit further back in the haze
      const drift = 0.05 / (1 + layer * 0.5);
      const alpha = 0.82 - layer * 0.08;
      const seedOff = layer * 137;
      const far = Math.min(0.5, 0.12 + layer * 0.08);
      const lb = lerpColor(body, this.pal.skyBot, far), ls = lerpColor(shade, this.pal.skyBot, far);
      const lh = lerpColor(hi, this.pal.skyBot, far);

      for (let i = 0; i < this.cloudOffsets.length; i++) {
        const span = this.width + 400;
        const ox = ((this.cloudOffsets[i] + seedOff - scrollX * drift) % span + span) % span - 200;
        const oy = baseY + ((i + layer) % 3) * 34;
        const w = (110 + ((i + layer) % 3) * 55) * (1 - layer * 0.06);
        this.cumulus(this.skyClouds, g, ox, oy, w, w * 0.34, i * 31 + layer * 7, alpha, lb, ls, lh);
      }
    }
    this.skyClouds?.end();
  }

  private drawHills(scrollX: number, sink: number, f: WorldFrame): void {
    const g = this.hillGfx;
    g.clear();
    const baseY = this.groundY + sink - BACK_BAND;

    this.drawRidgeLayer(
      g, scrollX, 0.22, baseY, 26 * this.shape.hillAmp, 46 * this.shape.hillAmp, 8.9, this.pal.hill, {
        shade: lerpColor(this.pal.hill, 0x000000, 0.35),
        highlight: this.pal.hillLight,
        trees: lerpColor(this.pal.hill, 0x000000, 0.5),
        texture: 1,
      },
    );
    this.hazeBand(g, baseY - 40, baseY + 2, 0.12);

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
    // The far edge of the plain: ruins and smoke stand out there, not on the
    // line the aeroplane lands on
    const baseY = this.groundY + sink - BACK_BAND + 6;
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
      // Out at the far edge of the plain, so small
      const s = (0.7 + propRand(i + 90) * 0.7) * 0.55;

      // Cast shadow first, stretched away from the low sun. Without one the
      // rocks and snags read as stickers laid over the ground rather than
      // things standing on it — the cheapest depth cue there is.
      g.fillStyle(0x000000, 0.26);
      g.fillEllipse(sx + 9 * s, baseY + 1.5, 30 * s, 5.5 * s);

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

  /**
   * How much standing water is at a point on the route, 0 = dry, 1 = mid-channel.
   *
   * The drowned coast is the only country with a real amount of it (`water`
   * 0.62), and because the biome blends along the route the channels thin out
   * and disappear as you leave it — you fly out of the marsh rather than off
   * the edge of a texture.
   *
   * Two octaves so the channels vary in width, and deterministic from the
   * route seed so the same leg has the same coastline every time.
   */
  waterAt(worldX: number): number {
    /*
     * Coverage comes from where this POINT is on the route, not from the
     * camera's current blend. Water is a property of the place — the raider
     * layout runs once at the start of the flight and has to agree with what
     * the ground layer will draw minutes later.
     *
     * Only the water term is blended; running the full palette lerp a couple
     * of hundred times a frame to read one number would be absurd.
     */
    const p = Math.min(1, Math.max(0, worldX / this.routeEndPx));
    const wMid = Math.sin(Math.PI * p) * 0.16;
    const wA = (1 - p) * (1 - wMid), wB = p * (1 - wMid);
    const cover = (
      BIOMES[this.biomeFrom].shape.water * wA
      + BIOMES[this.biomeTo].shape.water * wB
      + BIOMES.ashland.shape.water * wMid
    ) / Math.max(1e-6, wA + wB + wMid);
    if (cover <= 0.02) return 0;
    /*
     * Channel wavelength ~330 m, broken up by a ~80 m ripple.
     *
     * The first version used frequencies ten times lower, which put a full
     * cycle every 3.3 km — so a screen showed five percent of one and the
     * marsh came out as huge solid expanses of either water or land rather
     * than as a maze of channels. You want two or three crossings in view.
     */
    const k = this.routeSeed * 0.37;
    const n =
      0.55 + 0.30 * Math.sin(worldX * 0.0021 + k)
           + 0.15 * Math.sin(worldX * 0.0087 + k * 2.7);
    // Water wherever the field dips below the biome's coverage. The distance
    // below the threshold becomes depth, which is what shades the shoreline.
    const d = (cover * 1.15) - n;
    return d <= 0 ? 0 : Math.min(1, d / 0.30);
  }

  private drawGround(scrollX: number, sink: number, f: WorldFrame): void {
    const g = this.groundGfx;
    g.clear();
    const gy = this.groundY + sink;
    if (gy - BACK_BAND > this.height + 10) return;

    /*
     * ── The ground is a plane, seen in perspective ───────────────────────
     *
     * It was a stack of horizontal bands with ruled lines across it — a
     * backdrop, not a place. Now it is a surface with depth on BOTH sides of
     * the line things stand on: a plain receding behind it to the foot of the
     * hills, and ground running toward the camera in front of it. Everything
     * on it moves at the rate its distance says it should — the far edge of
     * the plain drifts at under a third of the speed of the action line, the
     * ground under the camera rushes past at more than twice it — and that
     * motion parallax is the strongest depth cue a moving picture has.
     */
    const W = this.width, H = this.height;
    const by = gy - BACK_BAND;
    const cx = W / 2;
    const S_FAR = 0.3, S_NEAR = 2.4;
    const nearDepth = Math.max(1, H - gy);
    const sAt = (y: number): number => (y <= gy
      ? S_FAR + (1 - S_FAR) * Math.max(0, (y - by) / BACK_BAND)
      : 1 + (S_NEAR - 1) * Math.min(1, (y - gy) / nearDepth));
    const xAt = (wx: number, sc: number): number => cx + (wx - scrollX - cx) * sc;
    const wxAt = (sx: number, sc: number): number => scrollX + cx + (sx - cx) / sc;

    // Soil: hazy and pale at the foot of the hills, sunlit at the line, cold
    // in the shadow under the camera
    const farSoil = lerpColor(lerpColor(this.pal.groundTop, this.pal.skyBot, 0.5), this.pal.hill, 0.18);
    const lineSoil = lerpColor(this.pal.groundTop, this.pal.glow, 0.26);
    const midSoil = lerpColor(this.pal.groundTop, this.pal.ground, 0.6);
    const deep = lerpColor(this.pal.ground, 0x05060a, 0.62);
    const grad = (y0: number, y1: number, c0: number, c1: number): void => {
      if (y1 <= y0) return;
      if (this.webgl) {
        g.fillGradientStyle(c0, c0, c1, c1, 1, 1, 1, 1);
        g.fillRect(0, y0, W, y1 - y0 + 1);
      } else {
        g.fillStyle(lerpColor(c0, c1, 0.5), 1);
        g.fillRect(0, y0, W, y1 - y0 + 1);
      }
    };
    grad(by, gy, farSoil, lineSoil);
    grad(gy, gy + nearDepth * 0.35, lineSoil, midSoil);
    grad(gy + nearDepth * 0.35, H + 2, midSoil, deep);

    // ── Water, receding: channels cross the plain into the distance ──────
    if (BIOMES[this.biomeFrom].shape.water > 0.02 || BIOMES[this.biomeTo].shape.water > 0.02) {
      const skyRefl = lerpColor(lerpColor(this.pal.skyBot, 0x2e7d92, 0.62), 0x0a1622, 0.18);
      const deepWater = 0x0b2430;
      const strips: Array<[number, number]> = [];
      for (let y = by; y < gy; y += 5) strips.push([y, Math.min(gy, y + 5)]);
      for (let y = gy; y < H;) {
        const hgt = Math.max(5, (y - gy) * 0.18 + 5);
        strips.push([y, Math.min(H, y + hgt)]);
        y += hgt;
      }
      for (const [y0, y1] of strips) {
        const sc = sAt((y0 + y1) / 2);
        const depthT = y0 < gy ? (gy - y0) / BACK_BAND : 0;
        const col = lerpColor(
          lerpColor(skyRefl, deepWater, y0 >= gy ? Math.min(1, (y0 - gy) / 90) : 0.2),
          this.pal.skyBot, depthT * 0.5,
        );
        let run = -1;
        for (let x = -12; x <= W + 12; x += 12) {
          const wet = this.waterAt(wxAt(x, sc)) > 0;
          if (wet && run < 0) run = x;
          if ((!wet || x >= W) && run >= 0) {
            g.fillStyle(col, 0.94);
            g.fillRect(run, y0, x - run + 1, y1 - y0 + 0.5);
            // The bright wet bank at each end of the run
            g.fillStyle(lerpColor(this.pal.glow, 0xffffff, 0.3), 0.35);
            g.fillRect(run - 1, y0, 2, y1 - y0);
            g.fillRect(x - 1, y0, 2, y1 - y0);
            run = -1;
          }
        }
      }
    }

    // ── Dirt tracks running off into the distance ────────────────────────
    {
      const [oA, oB] = originStripPx(f.originRunwayM ?? 600);
      const [dA, dB] = destStripPx(f.routeTotalKm, f.destRunwayM ?? 600);
      const SP = 2600;
      const lo = Math.floor(wxAt(-400, S_FAR) / SP), hi = Math.ceil(wxAt(W + 400, S_FAR) / SP);
      for (let k = lo; k <= hi; k++) {
        if (propRand(k * 3.1 + 7) > 0.42) continue;
        const wx = k * SP + propRand(k + 2) * SP * 0.6;
        if ((wx > oA - 300 && wx < oB + 300) || (wx > dA - 300 && wx < dB + 300)) continue;
        const hw = 10 + propRand(k + 5) * 8;
        const lean = (propRand(k + 9) - 0.5) * 260;      // tracks do not run straight at you
        const pts: Array<[number, number, number]> = [[by, S_FAR, lean * -0.6], [gy, 1, 0], [H, S_NEAR, lean]];
        const Lx: number[] = [], Rx: number[] = [], Ys: number[] = [];
        for (const [y, sc, off] of pts) {
          Lx.push(xAt(wx + off - hw, sc));
          Rx.push(xAt(wx + off + hw, sc));
          Ys.push(y);
        }
        if (Math.max(...Lx, ...Rx) < -40 || Math.min(...Lx, ...Rx) > W + 40) continue;
        const dust = lerpColor(lineSoil, 0xd8c8a0, 0.18);
        g.fillStyle(dust, 0.3);
        g.beginPath();
        g.moveTo(Lx[0], Ys[0]); g.lineTo(Lx[1], Ys[1]); g.lineTo(Lx[2], Ys[2]);
        g.lineTo(Rx[2], Ys[2]); g.lineTo(Rx[1], Ys[1]); g.lineTo(Rx[0], Ys[0]);
        g.closePath(); g.fillPath();
        // Two wheel ruts down it
        g.lineStyle(1.2, lerpColor(this.pal.ground, 0x000000, 0.45), 0.38);
        for (const f2 of [0.3, 0.7]) {
          g.beginPath();
          for (let i = 0; i < 3; i++) {
            const x = Lx[i] + (Rx[i] - Lx[i]) * f2;
            if (i === 0) g.moveTo(x, Ys[i]); else g.lineTo(x, Ys[i]);
          }
          g.strokePath();
        }
      }
    }

    // ── Rows of ground cover, each at its own distance ───────────────────
    const rowsBack = [0.1, 0.3, 0.52, 0.72, 0.9];
    const rowsFront = [0.05, 0.15, 0.3, 0.48, 0.7];
    const rows: Array<{ y: number; sc: number; gap: number; far: number }> = [];
    rowsBack.forEach((t, i) => rows.push({
      y: by + t * BACK_BAND, sc: sAt(by + t * BACK_BAND),
      gap: BACK_BAND * ((rowsBack[i + 1] ?? 1) - t), far: 1 - t,
    }));
    rowsFront.forEach((t, i) => rows.push({
      y: gy + 4 + t * (nearDepth - 4), sc: sAt(gy + 4 + t * (nearDepth - 4)),
      gap: (nearDepth - 4) * ((rowsFront[i + 1] ?? 0.9) - t), far: 0,
    }));
    const scrubCol = this.pal.scrub;
    const tuft = lerpColor(this.pal.hill, scrubCol, 0.45);
    const pale = lerpColor(lineSoil, 0xe0d0a8, 0.22);
    const dark = lerpColor(this.pal.ground, 0x000000, 0.3);
    for (let r = 0; r < rows.length; r++) {
      const { y, sc, gap, far } = rows[r];
      const haze = (c: number): number => lerpColor(c, farSoil, far * 0.7);
      // Patches of different ground — dry, dark, overgrown — flattened by distance
      {
        const SP = 300 / sc;
        const k0 = Math.floor(wxAt(-300, sc) / SP), k1 = Math.ceil(wxAt(W + 300, sc) / SP);
        for (let k = k0; k <= k1; k++) {
          const h1 = propRand(k * 1.7 + r * 31);
          const wx = k * SP + h1 * SP * 0.7;
          const x = xAt(wx, sc);
          const w = (150 + propRand(k + r * 7) * 240) * sc;
          const which = propRand(k * 2.3 + r);
          const col = which < 0.4 ? pale : which < 0.75 ? dark : tuft;
          g.fillStyle(haze(col), 0.16 + propRand(k + r) * 0.12);
          g.fillEllipse(x, y, w, Math.max(2, gap * 1.6));
        }
      }
      // Tufts, stones and brush — small at the back, big in front
      {
        const SP = 54 / sc;
        const k0 = Math.floor(wxAt(-40, sc) / SP), k1 = Math.ceil(wxAt(W + 40, sc) / SP);
        for (let k = k0; k <= k1; k++) {
          const h1 = propRand(k * 3.3 + r * 17);
          if (h1 < this.coverSkip) continue;
          const wx = k * SP + propRand(k + r * 5) * SP;
          const x = xAt(wx, sc);
          const yy = y + (propRand(k * 1.3 + r) - 0.5) * gap;
          const z = sc * (0.7 + propRand(k + 11 * r) * 0.6);
          const kind = Math.floor(propRand(k * 7.7 + r * 3) * 5);
          if (z > 1.1) {
            g.fillStyle(0x000000, 0.18);
            g.fillEllipse(x + 3 * z, yy + 0.6 * z, 8 * z, 1.8 * z);
          }
          switch (kind) {
            case 0:   // a tuft of dry grass
            case 1:
              g.lineStyle(Math.max(0.6, 0.9 * z), haze(tuft), 0.85);
              g.lineBetween(x, yy, x - 2 * z, yy - 4.5 * z);
              g.lineBetween(x, yy, x + 0.5 * z, yy - 5.5 * z);
              g.lineBetween(x, yy, x + 2.5 * z, yy - 4 * z);
              break;
            case 2:   // a stone, lit on the sun side
              g.fillStyle(haze(lerpColor(scrubCol, 0x8a8070, 0.35)), 1);
              g.fillEllipse(x, yy - 1.2 * z, 5 * z, 3 * z);
              g.fillStyle(haze(lerpColor(scrubCol, 0xd0c4a8, 0.4)), 0.7);
              g.fillEllipse(x - 0.9 * z, yy - 1.8 * z, 2.4 * z, 1.4 * z);
              break;
            case 3:   // brush
              g.fillStyle(haze(lerpColor(tuft, 0x000000, 0.2)), 0.95);
              g.fillCircle(x - 1.6 * z, yy - 1.8 * z, 2 * z);
              g.fillCircle(x + 1.4 * z, yy - 2.2 * z, 2.3 * z);
              g.fillCircle(x, yy - 3.4 * z, 1.8 * z);
              break;
            default:  // a dead stick
              g.lineStyle(Math.max(0.6, 0.8 * z), haze(scrubCol), 0.9);
              g.lineBetween(x, yy, x + 1 * z, yy - 7 * z);
              g.lineBetween(x + 0.6 * z, yy - 4 * z, x + 3 * z, yy - 5.5 * z);
          }
        }
      }
    }

    // A soft seam of haze where the plain meets the hills
    if (this.webgl) {
      const c = this.pal.skyBot;
      g.fillGradientStyle(c, c, c, c, 0, 0, 0.35, 0.35);
      g.fillRect(0, by - 10, W, 12);
      g.fillGradientStyle(c, c, c, c, 0.35, 0.35, 0, 0);
      g.fillRect(0, by + 2, W, 10);
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
      const oS = originStripPx(f.originRunwayM ?? 600), dS = destStripPx(f.routeTotalKm, f.destRunwayM ?? 600);
      const zoneA: [number, number] = [oS[0] - 900, oS[1] + 900];
      const zoneB: [number, number] = [dS[0] - 900, dS[1] + 900];
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
    // A long field is still longer than a short one, but no strip is drawn
    // at its full published length any more — see RoutePreview.stripM.
    const [oriFrom, oriTo] = originStripPx(f.originRunwayM ?? 600);
    const [dstFrom, dstTo] = destStripPx(f.routeTotalKm, f.destRunwayM ?? 600);
    this.drawRunway(g, oriFrom, oriTo, scrollX, gy, f, f.originSurface ?? 'open');
    this.drawRunway(g, dstFrom, dstTo, scrollX, gy, f, f.destSurface ?? 'open');
    // Origin airfield sits just behind the spawn point (aircraft spawns at
    // screen/world ~300) so the field is on screen from the first frame; the
    // destination's is at its strip entrance, overflown on approach.
    // The fortifications face open country: outbound from the origin field,
    // back down the route from the destination's.
    // The field stands beside the strip, so on the far apron — see RUNWAY_FAR.
    const apronY = gy - RUNWAY_FAR - 2;
    this.drawAirfield(g, 10, scrollX, apronY, 1);
    if (this.loading) this.drawLoading(g, 10, scrollX, apronY, gy);
    this.drawAirfield(g, dstFrom + 60, scrollX, apronY, -1);
    this.drawSettlement(g, oriFrom - 60, scrollX, gy, -1);
    this.drawSettlement(g, dstTo + 60, scrollX, gy, 1);
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
  /**
   * A crew walking your cargo out to the aeroplane.
   *
   * Runs only while the engine is off on the apron, and the pile shrinks as
   * the loop goes round — so the pre-flight is a thing you WATCH happening
   * rather than a loading bar, and starting the engine is visibly the moment
   * you decide they are done.
   */
  /**
   * @param gy     the apron line the pallets sit on
   * @param planeY the aircraft's contact line on the strip — the loaders walk
   *               across from one to the other, so they are visibly crossing
   *               to the aeroplane rather than pacing a line beside it
   */
  private drawLoading(
    g: Phaser.GameObjects.Graphics, startPx: number, scrollX: number, gy: number,
    planeY: number = gy,
  ): void {
    if (startPx - scrollX < -400) return;
    const t = this.t;
    const dl = this.dl;

    /*
     * Anchored to the AEROPLANE, not to the airfield gate.
     *
     * The crew has to walk to the thing they are loading. Anchoring the stack
     * to the field's start put them shuttling back and forth two hundred
     * pixels away from the aircraft, loading nothing.
     */
    const planeX = 300;              // AIRCRAFT_X — the parked aircraft's screen x
    const sx = planeX - 52;          // the cargo door, aft of the wing
    const stackX = sx - 104;         // pallets stacked clear of the propeller
    const carried = Math.floor(t / 3.4) % 5;      // how many have gone so far
    const left = 6 - carried;
    for (let i = 0; i < left; i++) {
      const row = Math.floor(i / 3), col = i % 3;
      const cx = stackX + col * 15;
      const cy = gy - 9 - row * 12;
      g.fillStyle(lerpColor(0x5a4526, 0x000000, 0.35 * (1 - dl)), 1);
      g.fillRect(cx, cy, 13, 11);
      g.fillStyle(lerpColor(0x7a6136, 0xffffff, 0.10 * dl), 1);
      g.fillRect(cx + 1, cy + 1, 11, 3);
      g.lineStyle(1, 0x2a2010, 0.8);
      g.strokeRect(cx, cy, 13, 11);
    }

    /*
     * Two loaders shuttling between the stack and the hold, half a cycle
     * apart so there is always one of them walking each way.
     */
    for (let k = 0; k < 2; k++) {
      const phase = ((t / 3.4) + k * 0.5) % 1;
      // Out to the stack empty, back to the aeroplane loaded
      const outbound = phase < 0.5;   // empty toward the pallets, loaded back
      const p2 = outbound ? phase * 2 : (1 - phase) * 2;
      const px = sx + (stackX - sx) * p2;
      const bob = Math.abs(Math.sin(t * 5 + k * 2)) * 1.6;
      // Feet on the apron at the pallets, on the strip at the aircraft
      const fy = planeY + (gy - planeY) * p2;
      // The crate on his shoulder, only on the way back
      if (!outbound) {
        g.fillStyle(0x5a4526, 1);
        g.fillRect(px - 6, fy - 26 - bob, 12, 9);
        g.lineStyle(1, 0x2a2010, 0.8);
        g.strokeRect(px - 6, fy - 26 - bob, 12, 9);
      }
      drawFighter(
        g, px, fy - bob, t, 900 + k * 31, 0.95,
        outbound ? 1 : -1, outbound ? 'patrol' : 'work', -1.2, dl, RAIDER_PALETTE,
      );
    }
  }

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
    surface: ApproachKind = 'open',
  ): void {
    const x0 = fromM - scrollX;
    const x1 = toM - scrollX;
    if (x1 < -60 || x0 > this.width + 60) return;

    const sx0 = Math.max(-60, x0);
    const sx1 = Math.min(this.width + 60, x1);

    /**
     * Every field used to be the same 13-px black stripe, which is why one
     * landing looked like every other. The surface is what a place IS: a
     * nomad strip is scraped dirt, a pre-war freight apron is cracked
     * concrete, a coastal causeway is salt-bleached. Driven by the same
     * approach type that gates which aircraft can use the field.
     */
    const SURFACES: Record<ApproachKind, {
      deck: number; near: number; far: number; mark: number; loose: boolean;
    }> = {
      open:       { deck: 0x24231f, near: 0x171613, far: 0x393730, mark: 0xc8c0a8, loose: false },
      industrial: { deck: 0x33322c, near: 0x1d1c18, far: 0x4a473d, mark: 0xd6cfb4, loose: false },
      coastal:    { deck: 0x2b2b28, near: 0x1a1a18, far: 0x484a44, mark: 0xbfc4bb, loose: false },
      canyon:     { deck: 0x5a4227, near: 0x332413, far: 0x74582f, mark: 0xa08a5c, loose: true  },
      mountain:   { deck: 0x4e4438, near: 0x2c261e, far: 0x675944, mark: 0x9c9078, loose: true },
    };
    const S = SURFACES[surface] ?? SURFACES.open;

    // ── The strip as a surface in perspective ────────────────────────────
    //
    // It was a stack of horizontal bands with square ends, which is a road
    // painted on the picture plane — "too 2D for the environment" was fair.
    // The deck now lies on the same ground plane as everything else: its far
    // edge drifts slower than its near edge, so the ends of the strip and
    // every bar painted across it slant toward the horizon, the lights and
    // markings shrink with distance, and the whole slab reads as something
    // you could walk out onto.
    const DECK = RUNWAY_DECK;
    const FAR = RUNWAY_FAR;
    const top = gy - FAR;
    const bottom = top + DECK;
    const by = gy - BACK_BAND;
    const cxs = this.width / 2;
    const nearDepth = Math.max(1, this.height - gy);
    const sAt = (y: number): number => (y <= gy
      ? 0.3 + 0.7 * Math.max(0, (y - by) / BACK_BAND)
      : 1 + 1.4 * Math.min(1, (y - gy) / nearDepth));
    const X = (wx: number, y: number): number => cxs + (wx - scrollX - cxs) * sAt(y);
    // A world-x span between two screen depths, split at the line where the
    // perspective changes rate, so straight edges stay straight
    const quad = (wa: number, wb: number, ya: number, yb: number, color: number, alpha: number): void => {
      const ys = ya < gy && yb > gy ? [ya, gy, yb] : [ya, yb];
      g.fillStyle(color, alpha);
      for (let i = 0; i + 1 < ys.length; i++) {
        const y0 = ys[i], y1 = ys[i + 1];
        const pts = [
          { x: X(wa, y0), y: y0 }, { x: X(wb, y0), y: y0 }, { x: X(wb, y1), y: y1 }, { x: X(wa, y1), y: y1 },
        ];
        if (Math.max(pts[0].x, pts[1].x, pts[2].x, pts[3].x) < -40 || Math.min(pts[0].x, pts[1].x, pts[2].x, pts[3].x) > this.width + 40) continue;
        g.fillPoints(pts, true);
      }
    };
    const gradQuad = (wa: number, wb: number, ya: number, yb: number, c0: number, c1: number): void => {
      const ys = ya < gy && yb > gy ? [ya, gy, yb] : [ya, yb];
      for (let i = 0; i + 1 < ys.length; i++) {
        const y0 = ys[i], y1 = ys[i + 1];
        const k0 = (y0 - ya) / (yb - ya), k1 = (y1 - ya) / (yb - ya);
        const ca = lerpColor(c0, c1, k0), cb = lerpColor(c0, c1, k1);
        const ax = X(wa, y0), bx = X(wb, y0), cx2 = X(wb, y1), dx = X(wa, y1);
        if (this.webgl) {
          g.fillGradientStyle(ca, ca, cb, cb, 1, 1, 1, 1);
          g.fillTriangle(ax, y0, bx, y0, dx, y1);
          g.fillGradientStyle(ca, cb, cb, cb, 1, 1, 1, 1);
          g.fillTriangle(bx, y0, cx2, y1, dx, y1);
        } else {
          g.fillStyle(lerpColor(ca, cb, 0.5), 1);
          g.fillPoints([{ x: ax, y: y0 }, { x: bx, y: y0 }, { x: cx2, y: y1 }, { x: dx, y: y1 }], true);
        }
      }
    };
    const span = (wx: number, y: number): boolean => {
      const x = X(wx, y);
      return x > -40 && x < this.width + 40;
    };

    // The far apron: packed earth between the strip and the field's buildings
    quad(fromM - 40, toM + 40, top - RUNWAY_APRON, top, lerpColor(this.pal.groundTop ?? 0x6b5c38, 0x000000, 0.22), 1);
    // Graded dirt shoulders either side of the hard surface
    quad(fromM - 30, toM + 30, top - 3, top, lerpColor(S.deck, this.pal.ground ?? 0x4a3d28, 0.55), 0.9);
    quad(fromM - 30, toM + 30, bottom, bottom + 5, lerpColor(S.deck, this.pal.ground ?? 0x4a3d28, 0.6), 0.9);
    // The deck: lighter at the far edge where the sky is in it, dark near you
    gradQuad(fromM, toM, top, bottom, S.far, S.near);
    quad(fromM, toM, bottom, bottom + 3, 0x000000, 0.3);

    /*
     * Joints between the slabs, or ruts in the dirt. A slab joint runs across
     * the strip from the far edge to the near one, so in perspective each one
     * leans toward the middle of the picture — a fan of lines that slides as
     * you roll, which is what makes the deck read as a surface you are on
     * rather than a stripe you are in front of.
     */
    if (!S.loose) {
      const SLAB = 22 * WORLD_PX_PER_M;
      const k0 = Math.ceil(Math.max(fromM, scrollX - 900) / SLAB), k1 = Math.floor(Math.min(toM, scrollX + this.width + 900) / SLAB);
      g.lineStyle(1, 0x000000, 0.22);
      for (let k = k0; k <= k1; k++) {
        const wx = k * SLAB;
        const xa = X(wx, top + 1), xb = X(wx, gy), xc = X(wx, bottom - 1);
        if (Math.max(xa, xc) < -20 || Math.min(xa, xc) > this.width + 20) continue;
        g.lineBetween(xa, top + 1, xb, gy);
        g.lineBetween(xb, gy, xc, bottom - 1);
      }
      // …and the seams down its length, closer together toward the far edge
      g.lineStyle(1, 0x000000, 0.16);
      for (const f2 of [0.18, 0.4, 0.66]) {
        const y = top + DECK * f2;
        g.lineBetween(X(fromM, y), y, X(toM, y), y);
      }
    } else {
      // Wheel ruts worn down the length of a dirt strip
      for (const [f2, w] of [[0.3, 2.2], [0.42, 2.2], [0.62, 3], [0.76, 3]] as Array<[number, number]>) {
        const y = top + DECK * f2;
        g.lineStyle(w * sAt(y), lerpColor(S.near, 0x000000, 0.3), 0.35);
        g.lineBetween(X(fromM, y), y, X(toM, y), y);
      }
    }

    // Painted edge lines, far and near
    g.lineStyle(1.2, S.mark, S.loose ? 0.10 : 0.34);
    g.lineBetween(X(fromM, top + 1.4), top + 1.4, X(toM, top + 1.4), top + 1.4);
    g.lineBetween(X(fromM, bottom - 1.2), bottom - 1.2, X(toM, bottom - 1.2), bottom - 1.2);

    // Patched and cracked surface, at its own depth so it slides with it
    {
      const sp = 40;
      const first = Math.floor((Math.max(fromM, scrollX - 200)) / sp);
      const last = Math.floor(Math.min(toM, scrollX + this.width + 200) / sp);
      for (let i = first; i <= last; i++) {
        const wx = i * sp + propRand(i + 21) * 26;
        if (wx < fromM + 6 || wx > toM - 12) continue;
        const y = top + 3 + propRand(i + 8) * (DECK - 7);
        if (!span(wx, y)) continue;
        const repair = propRand(i + 55) > 0.62;
        quad(wx, wx + (repair ? 14 + propRand(i) * 20 : 3 + propRand(i) * 6), y, y + (repair ? 3.5 : 1.4),
          repair ? lerpColor(S.deck, 0x000000, 0.25) : (propRand(i + 9) > 0.5 ? 0x000000 : 0x5a5a52), repair ? 0.55 : 0.22);
      }
    }

    // Threshold piano keys at both ends — slanting with the deck
    for (const endX of [fromM + 14, toM - 96]) {
      for (let i = 0; i < 6; i++) {
        const wx = endX + i * 15;
        if (!span(wx, gy)) continue;
        quad(wx, wx + 7, top + 4, bottom - 4, 0xc8c0a8, S.loose ? 0.3 : 0.72);
      }
    }
    // Threshold bars across the full deck
    for (const [wx, dir] of [[fromM + 6, 1], [toM - 6, -1]] as Array<[number, number]>) {
      quad(dir > 0 ? wx : wx - 6, dir > 0 ? wx + 6 : wx, top + 2, bottom - 1, S.mark, S.loose ? 0.22 : 0.55);
    }
    // Aiming-point blocks past each threshold, either side of the centreline
    for (const ax of [fromM + 190, toM - 228]) {
      quad(ax, ax + 38, top + DECK * 0.22, top + DECK * 0.36, 0xd8d0b8, 0.6);
      quad(ax, ax + 38, top + DECK * 0.62, top + DECK * 0.78, 0xd8d0b8, 0.6);
    }
    // Rubber laid down where traffic touches
    for (const [endX, dir] of [[fromM + 150, 1], [toM - 210, -1]] as Array<[number, number]>) {
      for (let i = 0; i < 7; i++) {
        const rx = endX + dir * (i * 26 + propRand(i + 61) * 18);
        const y = top + 6 + propRand(i + 31) * (DECK - 14);
        quad(rx, rx + 16 + propRand(i + 41) * 22, y, y + 2.6, 0x0c0a08, 0.42);
      }
    }
    // Centreline dashes
    for (let wx = fromM + 120; wx < toM - 110; wx += 60) {
      if (!span(wx, gy)) continue;
      quad(wx, wx + 26, top + DECK * 0.47, top + DECK * 0.47 + 3, this.pal.dash, 0.62);
    }

    /*
     * Edge lighting, both shoulders, sized by distance: the far row is a
     * string of small points, the near row big warm lamps. At night they are
     * the runway, and the perspective of the two rows is what tells you how
     * wide it is.
     */
    {
      const spacing = 62;
      const glow = 0.18 + (1 - this.dl) * 0.82;
      const first = Math.floor(Math.max(fromM, scrollX - 200) / spacing);
      const last = Math.floor(Math.min(toM, scrollX + this.width + 200) / spacing);
      for (let i = first; i <= last; i++) {
        const wx = i * spacing;
        if (wx < fromM + 10 || wx > toM - 10) continue;
        for (const ly of [top - 2.5, bottom + 2.5]) {
          const z = sAt(ly);
          const lx = X(wx, ly);
          if (lx < -20 || lx > this.width + 20) continue;
          g.fillStyle(0xffb34a, 0.10 + glow * 0.28);
          g.fillCircle(lx, ly, 3.6 * z);
          g.fillStyle(0xffd9a0, 0.45 + glow * 0.55);
          g.fillCircle(lx, ly, 1.4 * z);
        }
      }
    }

    // Distance-remaining boards down the near shoulder
    {
      const every = 200 * WORLD_PX_PER_M / 9;
      const y = bottom + 7;
      const z = sAt(y);
      for (let wx = fromM + every; wx < toM - every * 0.4; wx += every) {
        const dx = X(wx, y);
        if (dx < -30 || dx > this.width + 30) continue;
        g.fillStyle(0x12100c, 0.9);
        g.fillRect(dx - 4 * z, y - 2 * z, 8 * z, 6.5 * z);
        g.fillStyle(0xd8cfa8, 0.8);
        g.fillRect(dx - 2.8 * z, y - 0.8 * z, 5.6 * z, 1.3 * z);
        g.lineStyle(1, 0x12100c, 0.9);
        g.lineBetween(dx, y + 4.5 * z, dx, y + 7 * z);
      }
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
