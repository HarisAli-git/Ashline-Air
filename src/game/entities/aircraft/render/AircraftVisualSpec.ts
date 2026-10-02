/**
 * Per-aircraft geometry + palette for the procedural renderer.
 *
 * Everything is in local "design units" (≈ on-screen pixels at scale 1),
 * with the aircraft NOSE FACING RIGHT and the origin at the fuselage datum
 * (centre of the fuselage at the wing root). Positive y is DOWN (screen space).
 */

import type { GearStyle } from './GearArt';

export type WingLayout = 'low' | 'high' | 'biplane';
export type CanopyStyle = 'bubble' | 'windows';
/**
 * A fat radial piston cowl (bristling with cylinder heads and cooling gills)
 * or a long slim turboprop nacelle. Drawing every aeroplane in the fleet with
 * the same radial cowl is what made a modern freighter look like a 1940s
 * bomber with the wrong paint on it.
 */
export type EngineStyle = 'radial' | 'turboprop';

/**
 * Camera throw at the wingtip, as a fraction of span. The camera sits slightly
 * above the aircraft, so a wing running toward the viewer walks DOWN the
 * screen and one running away walks up it; the far wing is further off and
 * foreshortens harder, so it throws less. Shared with the painter and with
 * engine mounting so the nacelles always sit on the wing that is drawn.
 */
export const NEAR_THROW = 0.13;
export const FAR_THROW = 0.09;

/** An engine as authored: hung off the wing at a spanwise station. */
export interface EngineMount {
  /** Spanwise station, 0 = wing root, 1 = tip. Ignored when `nose` is set. */
  frac: number;
  cowlLen: number;  // nacelle length
  cowlH: number;    // nacelle height
  far?: boolean;    // rendered behind the fuselage, darker
  /** Single-engine tractor: the cowl IS the front of the fuselage. */
  nose?: boolean;
  /** Fine vertical trim on the resolved position. */
  dy?: number;
}

/** An engine as resolved: absolute position on the wing it hangs from. */
export interface EngineSpec extends EngineMount {
  x: number;        // cowl centre x (datum-relative)
  y: number;        // cowl centre y
}

export interface AircraftVisualSpec {
  /** Overall world scale of the assembled container. */
  scale: number;
  /** Fuselage length / height in design units. */
  length: number;
  height: number;
  palette: {
    hull: number;        // base coat
    hullShade: number;   // belly / far-side shade
    hullLight: number;   // top highlight
    accent: number;      // trim stripe / mismatched panel
    rust: number;        // corrosion streaks
    canopy: number;      // glass
    canopyGlint: number; // glass highlight
    prop: number;        // blade colour
    metal: number;       // struts, gear, hubs
  };
  wing: {
    layout: WingLayout;
    rootX: number;  // wing root centre x
    y: number;      // wing root y (near wing)
    chord: number;  // root chord
    span: number;   // projected 2D length toward the tip
    sweep: number;  // rearward tip offset
    drop: number;   // vertical tip offset for the NEAR wing (+ = down)
  };
  /**
   * Fuselage silhouette. Every airframe used to share one profile, so a
   * four-engine freighter and a crop duster were the same tube at different
   * scales. These are the four numbers that actually separate them.
   */
  fuselage: {
    /** Where the tail cone starts pinching in, as a fraction of length. */
    taperStart: number;
    /** Half-height left at the very tail tip, as a fraction of the cabin's. */
    tailDepth: number;
    /** How hard the tail sweeps up, as a fraction of height. Ramp-door
     *  freighters swing up sharply to clear the loading ramp. */
    upsweep: number;
    /** Half-height at the nose tip: 1 = a blunt radome, 0.25 = a fine cone. */
    noseFull: number;
    /** 0 = a round belly, 1 = a squared-off freight floor. */
    bellyFlat: number;
    /**
     * How far the nose drops below the cabin's centreline, as a fraction of
     * height. A transport's nose is not a cone on the axis: the roof slopes
     * down into the windscreen and the floor runs nearly straight to the
     * radome, which is where the flight deck gets its shape.
     */
    noseDroop?: number;
  };
  tail: {
    finHeight: number;
    finSweep: number;
    /** Total tailplane chord — fixed stabiliser plus hinged elevator. */
    stabLen: number;
    /** Tailplane carried on TOP of the fin instead of on the fuselage. */
    tTail?: boolean;
  };
  canopy: {
    style: CanopyStyle;
    /**
     * Bubble canopies: the forward edge of the glasshouse, `w` long.
     * Window strips: the AFT end of the cabin window run — the flight deck
     * itself is placed from the nose profile so the glass lands on the skin.
     */
    x: number;
    w: number;
    /**
     * Flight-deck glazing, pane by pane: [u0, u1, a0, a1, rake?] in the
     * hull's own coordinates — u along the length (0 tail, 1 nose), a round
     * the section (-π/2 the roof, 0 the side, +π/2 the belly). `rake` moves
     * the lower edge forward, so a windscreen leans back like one. The gaps
     * between panes are the frames. Without it a transport got two slots.
     */
    deck?: Array<[number, number, number, number, number?]>;
  };
  engineStyle: EngineStyle;
  engines: EngineSpec[];
  prop: { r: number; bladePairs: 1 | 2 };
  gear: {
    fixed: boolean;          // true = non-retractable (always down, no doors)
    /** What the legs are — see GearArt. Defaults to a plain oleo. */
    style?: GearStyle;
    /** How far forward of the hinge the axle sits (negative = trailing), units. */
    rake?: number;
    /** Tundra tyres: fat sidewalls, a small hub. */
    tyre?: 'standard' | 'tundra';
    mainX: number;
    noseX: number | null;    // null = taildragger
    tailWheelX: number | null;
    strutLen: number;
    wheelR: number;
    hingeY: number;          // strut hinge y (just inside the belly)
    /**
     * Wheels in TANDEM on each main leg — one behind the other, as on a C-130
     * or a widebody body-gear. This is the only arrangement that shows as more
     * than one wheel in a side view, so it is the only thing that should ever
     * add a silhouette.
     */
    mainWheels?: number;
    /**
     * The main axle carries a PAIR side by side.
     *
     * This is what most twins actually have, and in a side view a side-by-side
     * pair is ONE wheel — you are looking straight down the axle. Drawing the
     * pair fore-and-aft (which is what counting them did) put a row of wheels
     * along the belly of every transport in the fleet, which is not something
     * any of them have.
     */
    mainDual?: boolean;
    /** The nose axle carries a pair side by side — again, one silhouette. */
    noseDual?: boolean;
    /** Nose wheel radius, if smaller than the mains (it usually is). */
    noseWheelR?: number;
    /**
     * High-wing transports have nowhere in the wing to put the gear, so it
     * folds into a blister on the side of the fuselage. Drawn into the hull.
     */
    sponson?: { x: number; w: number; h: number };
  };
  flap: { maxDeflectDeg: number };
  beacon: { x: number; y: number };  // usually the fin tip
  exhaust: { x: number; y: number }; // exhaust stack / stain origin
  /**
   * Distance from datum to wheel-bottom with gear down. DERIVED from the gear
   * geometry, never authored: the sprite computes the same value to place the
   * airframe on the runway, and an authored copy silently drifted out of step
   * with it every time a leg changed, hanging the exhaust plume in mid-air.
   */
  groundContactY: number;
  /**
   * Taildraggers rest nose-high on their tail wheel; this is the parked
   * attitude in degrees. The tail lifts as the takeoff roll gains speed.
   */
  groundStanceDeg?: number;
}

/**
 * Where the tailplane is carried, in body coords. A T-tail sits on top of the
 * fin; everything else grows out of the tail cone. The painter draws the fixed
 * stabiliser here and the sprite hinges the moving elevator to the same point,
 * so the two can never come apart.
 */
export function stabRoot(spec: AircraftVisualSpec): { x: number; y: number } {
  const { length: L, height: H, tail: t } = spec;
  return t.tTail
    ? { x: -L / 2 + t.finSweep, y: -H / 2 - t.finHeight + 3 }
    : { x: -L * 0.32, y: -H * 0.22 };
}

/** Fixed stabiliser chord; the hinged elevator takes the rest of `stabLen`. */
export const STAB_FIXED_FRAC = 0.58;

/** Hinge point of the trailing-edge flap, derived from the wing. */
export function flapHinge(spec: AircraftVisualSpec): { x: number; y: number } {
  const w = spec.wing;
  return { x: w.rootX - w.chord * 0.45 + 1, y: w.y + w.drop * 0.3 + 1 };
}

/** The specs as authored: engines carry a spanwise station, not a position. */
type RawSpec = Omit<AircraftVisualSpec, 'engines' | 'groundContactY'>
  & { engines: EngineMount[] };

/**
 * Where a wing's leading edge is at a given spanwise station, in body coords.
 *
 * Nacelle positions used to be hand-authored, which meant they drifted off the
 * wing as soon as the wing moved and read as boxes parked beside the fuselage.
 * Deriving them keeps every engine bolted to the surface that carries it.
 */
export function wingStation(
  spec: RawSpec | AircraftVisualSpec, frac: number, far: boolean,
): { x: number; y: number } {
  const w = spec.wing;
  const throwY = far ? -w.span * FAR_THROW : w.span * NEAR_THROW;
  const fy = far ? (w.layout === 'high' ? w.y - 2 : w.y - 3) : w.y;
  const fdrop = far ? w.drop * 0.5 : w.drop;
  const rootX = far ? w.rootX - 6 : w.rootX;
  return {
    x: rootX + w.chord * 0.55 - (w.sweep + w.span * 0.42) * frac,
    y: fy + (fdrop + throwY) * frac,
  };
}

const RAW_SPECS: Record<string, RawSpec> = {
  crop_duster: {
    scale: 1.0,
    length: 132,
    height: 26,
    palette: {
      hull: 0x96502f, hullShade: 0x62341f, hullLight: 0xb56b45,
      accent: 0xc9a44a, rust: 0x59301c,
      canopy: 0x27333b, canopyGlint: 0x9fc4d0,
      prop: 0x2a2622, metal: 0x8f8a80,
    },
    wing:  { layout: 'biplane', rootX: 8, y: 8, chord: 40, span: 46, sweep: 12, drop: 8 },
    // Fabric-and-tube ag-plane: a round tube with a deep radial cowl and a
    // tail that tapers away to almost nothing.
    fuselage: { taperStart: 0.19, tailDepth: 0.28, upsweep: 0.16, noseFull: 0.62, bellyFlat: 0 },
    tail:  { finHeight: 24, finSweep: 10, stabLen: 30 },
    canopy: { style: 'bubble', x: 8, w: 26 },
    engineStyle: 'radial',
    engines: [{ frac: 0, nose: true, cowlLen: 24, cowlH: 24 }],
    prop:  { r: 20, bladePairs: 1 },
    // Ag-biplane: fat low-pressure mains on faired legs, small tailwheel.
    gear:  { fixed: true, style: 'spatted', rake: 4, mainX: 18, noseX: null, tailWheelX: -58,
             strutLen: 15.5, wheelR: 8.5, hingeY: 11 },
    flap:  { maxDeflectDeg: 30 },
    beacon: { x: -58, y: -36 },
    exhaust: { x: 40, y: 10 },
    groundStanceDeg: 11,
  },

  bush_plane: {
    scale: 1.0,
    length: 140,
    height: 26,
    palette: {
      hull: 0x6b6f43, hullShade: 0x45492b, hullLight: 0x898d58,
      accent: 0xb08a50, rust: 0x5c3a22,
      canopy: 0x27333b, canopyGlint: 0x9fc4d0,
      prop: 0x2a2622, metal: 0x8f8a80,
    },
    wing:  { layout: 'high', rootX: 6, y: -16, chord: 46, span: 60, sweep: 10, drop: -6 },
    // Slab-sided STOL cabin: a squarish body with a flat floor so freight and
    // passengers load off the strip, and a long tapering tail boom.
    fuselage: { taperStart: 0.22, tailDepth: 0.26, upsweep: 0.19, noseFull: 0.58, bellyFlat: 0.30 },
    tail:  { finHeight: 26, finSweep: 12, stabLen: 32 },
    canopy: { style: 'windows', x: 22, w: 34 },
    engineStyle: 'radial',
    engines: [{ frac: 0, nose: true, dy: 2, cowlLen: 22, cowlH: 24 }],
    prop:  { r: 21, bladePairs: 1 },
    /*
     * STOL bush ship: sprung steel legs, tailwheel, tundra tyres.
     *
     * The tyre was wheelR 12 against a crop duster's 8 — half again as big on
     * an airframe that is nowhere near half again as large — and it read as
     * a cartoon wheel bolted to an aeroplane. What actually characterises a
     * bush machine (a Super Cub, a Helio Courier) is not enormous tyres but
     * LONG LEGS: deep prop clearance and a lot of travel to soak up a gravel
     * bar. So the tyre comes down and the strut goes up.
     *
     * Too far up: at 23 the gear hung 1.2 fuselage-heights below the belly —
     * stilts, not legs. A Super Cub's wheels sit about 0.8 of the cabin's
     * depth below it, which is what the crop duster already does; 15 matches
     * that and still clears the prop by two-thirds of its radius, tail up.
     */
    gear:  { fixed: true, style: 'bungee', rake: 4, tyre: 'tundra', mainX: 22, noseX: null,
             tailWheelX: -60, strutLen: 15, wheelR: 9, hingeY: 11 },
    flap:  { maxDeflectDeg: 35 },
    beacon: { x: -62, y: -38 },
    exhaust: { x: 44, y: 12 },
    groundStanceDeg: 11,
  },


  // High-wing regional freighter — the ATR-shaped workhorse of the fleet:
  // a long slab-sided fuselage, a big T-tail, and the wing carried on the
  // roof so the cabin floor sits low enough to load off a truck bed.
  regional_freighter: {
    scale: 0.88,
    length: 200,
    height: 30,
    palette: {
      hull: 0x8c8a80, hullShade: 0x5e5d56, hullLight: 0xb4b2a6,
      accent: 0x2f6fa8, rust: 0x6a4a30,
      canopy: 0x1e2a33, canopyGlint: 0xbfe0ec,
      prop: 0x201d1a, metal: 0x9a958a,
    },
    wing:  { layout: 'high', rootX: 6, y: -16, chord: 46, span: 84, sweep: 10, drop: -4 },
    // Slab-sided freight tube: a flat cabin floor low to the ground, a blunt
    // weather-radar nose and a tail cone swept up to clear the loading door.
    fuselage: { taperStart: 0.15, tailDepth: 0.20, upsweep: 0.24, noseFull: 0.4, bellyFlat: 0.55, noseDroop: 0.25 },
    tail:  { finHeight: 46, finSweep: 24, stabLen: 30, tTail: true },
    // The ATR flight deck: a two-pane windscreen raked down the nose, the
    // side screens, the sliding direct-vision window and a small one behind
    canopy: { style: 'windows', x: -54, w: 40, deck: [
      [0.900, 0.940, -1.50, -0.95, 0.030],
      [0.872, 0.905, -1.35, -0.62, 0.020],
      [0.846, 0.868, -1.22, -0.60, 0.008],
    ] },
    engineStyle: 'turboprop',
    engines: [
      { frac: 0.30, dy: 4, cowlLen: 40, cowlH: 19 },
      { frac: 0.30, dy: 2, cowlLen: 40, cowlH: 19, far: true },
    ],
    prop:  { r: 26, bladePairs: 2 },
    // High wing, so the mains live in sponsons on the fuselage sides: twin
    // wheels on each leg, twin nose wheels, short legs close to the ground
    // for truck-bed loading.
    // Short trailing-arm legs out of the fairings: the ATR sits LOW, which is
    // the point of it — the cabin floor is at truck-bed height.
    //
    // It did not. Main tyres half the height of the fuselage and nose wheels
    // nearly as big, on a leg that stood the nose up like a stilt: the real
    // mains are about a third of the fuselage's height, the nose pair a
    // sixth, and the belly clears the ground by about a third. Re-drawn to
    // those proportions.
    gear:  { fixed: false, style: 'trailing', rake: -4, mainX: 2, noseX: 84, tailWheelX: null, strutLen: 6, wheelR: 5.4,
             hingeY: 13, mainDual: true, noseDual: true, noseWheelR: 3.5,
             sponson: { x: 2, w: 46, h: 13 } },
    flap:  { maxDeflectDeg: 38 },
    beacon: { x: -94, y: -62 },
    exhaust: { x: 16, y: 6 },
  },


  military_transport: {
    scale: 0.9,
    length: 215,
    height: 36,
    palette: {
      hull: 0x5c6653, hullShade: 0x3d4437, hullLight: 0x76816a,
      accent: 0x8a8556, rust: 0x5c3a22,
      canopy: 0x252f28, canopyGlint: 0x9fc4b0,
      prop: 0x23201d, metal: 0x716d64,
    },
    wing:  { layout: 'high', rootX: 4, y: -19, chord: 62, span: 92, sweep: 26, drop: -6 },
    // The ramp-door heavy. Its silhouette is the whole point: a deep
    // flat-floored cargo hold that runs full-section almost to the tail, then
    // swings up hard into the ramp, under a blunt radome nose.
    fuselage: { taperStart: 0.30, tailDepth: 0.56, upsweep: 0.36, noseFull: 0.5, bellyFlat: 0.85, noseDroop: 0.21 },
    tail:  { finHeight: 52, finSweep: 22, stabLen: 46 },
    // The Hercules flight deck is a glasshouse: windscreen, eyebrow windows
    // over it, two side windows, and the chin windows low down by the nose
    // gear that let the crew see the ground on a drop
    canopy: { style: 'windows', x: 8, w: 44, deck: [
      [0.898, 0.936, -1.52, -1.00, 0.030],
      [0.870, 0.902, -1.36, -0.64, 0.020],
      [0.862, 0.893, -1.57, -1.42],
      [0.842, 0.864, -1.25, -0.62, 0.008],
      [0.906, 0.936, -0.36, 0.04],
    ] },
    engineStyle: 'turboprop',
    // Four turboprops on the leading edge: inboard and outboard on each side.
    // In a side view the outboard pair sits further aft (wing sweep) and lower
    // on the near side / higher on the far side, which is what makes four
    // engines read as four rather than as one grey smear.
    engines: [
      { frac: 0.30, dy: 4, cowlLen: 36, cowlH: 18 },
      { frac: 0.60, dy: 4, cowlLen: 34, cowlH: 17 },
      { frac: 0.30, dy: 2, cowlLen: 34, cowlH: 17, far: true },
      { frac: 0.60, dy: 2, cowlLen: 32, cowlH: 16, far: true },
    ],
    prop:  { r: 22, bladePairs: 2 },
    // Four-engine heavy: the mains are a TANDEM PAIR each side, tucked into
    // fuselage sponsons, with twin nose wheels forward. A freighter this
    // size standing on one wheel per side is what made it look like a toy.
    // The one genuine TANDEM bogie in the fleet: two wheels one behind the
    // other on each main leg, which is why it is the only aircraft here that
    // shows more than one main wheel from the side.
    // Stubby legs with the tandem pair tucked half up inside the sponson,
    // the way a C-130 actually squats on the ramp.
    // Re-proportioned like the ATR: a C-130's tyres are about a third of the
    // fuselage's height, mostly hidden in the sponsons, and the belly sits
    // about a metre off the ramp.
    gear:  { fixed: false, style: 'sponson', rake: 0, mainX: 6, noseX: 92, tailWheelX: null, strutLen: 4, wheelR: 6.6,
             hingeY: 15, mainWheels: 2, noseDual: true, noseWheelR: 4.2,
             sponson: { x: 6, w: 62, h: 15 } },
    flap:  { maxDeflectDeg: 40 },
    beacon: { x: -98, y: -78 },
    exhaust: { x: 34, y: -4 },
  },
  /*
   * ── Other people's aeroplanes ─────────────────────────────────────────
   *
   * Traffic was drawn as flat outlined polygons that looked like modern
   * airliners sketched in a margin. These are the aeroplanes that would
   * actually still be flying at the end of the world: things old enough to
   * be fixed with hand tools. Never for sale — they only fly past you.
   */

  // A DC-3: the freighter that outlived everything. Bare metal gone dull,
  // a red cheat line, two radials and a tail wheel.
  traffic_hauler: {
    scale: 1,
    length: 200,
    height: 26,
    palette: {
      hull: 0x9a9a90, hullShade: 0x66665e, hullLight: 0xc2c2b8,
      accent: 0x8a2a1c, rust: 0x6a4a30,
      canopy: 0x1e2a33, canopyGlint: 0xbfe0ec,
      prop: 0x201d1a, metal: 0x9a958a,
    },
    wing:  { layout: 'low', rootX: 16, y: 9, chord: 46, span: 70, sweep: 14, drop: 6 },
    fuselage: { taperStart: 0.22, tailDepth: 0.2, upsweep: 0.12, noseFull: 0.56, bellyFlat: 0 },
    tail:  { finHeight: 34, finSweep: 24, stabLen: 30 },
    canopy: { style: 'windows', x: -40, w: 40 },
    engineStyle: 'radial',
    engines: [
      { frac: 0.3, dy: 2, cowlLen: 30, cowlH: 22 },
      { frac: 0.3, dy: 1, cowlLen: 30, cowlH: 22, far: true },
    ],
    prop:  { r: 20, bladePairs: 1 },
    gear:  { fixed: false, mainX: 22, noseX: null, tailWheelX: -86, strutLen: 14, wheelR: 9, hingeY: 10 },
    flap:  { maxDeflectDeg: 30 },
    beacon: { x: -96, y: -48 },
    exhaust: { x: 20, y: 8 },
  },

  // A Norseman: a big high-wing single on fixed legs, the bush workhorse.
  traffic_courier: {
    scale: 1,
    length: 150,
    height: 28,
    palette: {
      hull: 0xa8862e, hullShade: 0x6e5820, hullLight: 0xc8a852,
      accent: 0x2a4a7a, rust: 0x6a4a28,
      canopy: 0x27333b, canopyGlint: 0x9fc4d0,
      prop: 0x2a2622, metal: 0x8f8a80,
    },
    wing:  { layout: 'high', rootX: 8, y: -17, chord: 44, span: 62, sweep: 8, drop: -6 },
    fuselage: { taperStart: 0.22, tailDepth: 0.26, upsweep: 0.18, noseFull: 0.62, bellyFlat: 0.25 },
    tail:  { finHeight: 26, finSweep: 12, stabLen: 30 },
    canopy: { style: 'windows', x: 20, w: 32 },
    engineStyle: 'radial',
    engines: [{ frac: 0, nose: true, dy: 1, cowlLen: 22, cowlH: 25 }],
    prop:  { r: 21, bladePairs: 1 },
    gear:  { fixed: true, style: 'bungee', rake: 4, mainX: 22, noseX: null, tailWheelX: -64, strutLen: 18, wheelR: 8.5, hingeY: 11 },
    flap:  { maxDeflectDeg: 30 },
    beacon: { x: -66, y: -40 },
    exhaust: { x: 46, y: 11 },
  },

  // A Cub: the smallest thing in the sky, fabric over tube, yellow once.
  traffic_ultralight: {
    scale: 1,
    length: 104,
    height: 20,
    palette: {
      hull: 0xc09a34, hullShade: 0x7a6224, hullLight: 0xdab854,
      accent: 0x1a1816, rust: 0x6a4a28,
      canopy: 0x27333b, canopyGlint: 0x9fc4d0,
      prop: 0x2a2622, metal: 0x8f8a80,
    },
    wing:  { layout: 'high', rootX: 6, y: -12, chord: 34, span: 50, sweep: 4, drop: -4 },
    fuselage: { taperStart: 0.2, tailDepth: 0.24, upsweep: 0.16, noseFull: 0.6, bellyFlat: 0 },
    tail:  { finHeight: 18, finSweep: 10, stabLen: 24 },
    canopy: { style: 'windows', x: 14, w: 24 },
    engineStyle: 'radial',
    engines: [{ frac: 0, nose: true, cowlLen: 16, cowlH: 17 }],
    prop:  { r: 15, bladePairs: 1 },
    gear:  { fixed: true, style: 'bungee', rake: 3, mainX: 16, noseX: null, tailWheelX: -46, strutLen: 13, wheelR: 6.5, hingeY: 8 },
    flap:  { maxDeflectDeg: 20 },
    beacon: { x: -48, y: -30 },
    exhaust: { x: 32, y: 8 },
  },

  // A Ju 52: three radials, spatted wheels, a gunner in the door. Whoever
  // flies this one is not hauling freight.
  traffic_gunship: {
    scale: 1,
    length: 190,
    height: 32,
    palette: {
      hull: 0x4c5242, hullShade: 0x30362a, hullLight: 0x666e56,
      accent: 0x7a5420, rust: 0x5c3a22,
      canopy: 0x252f28, canopyGlint: 0x9fc4b0,
      prop: 0x23201d, metal: 0x716d64,
    },
    wing:  { layout: 'low', rootX: 14, y: 10, chord: 54, span: 72, sweep: 10, drop: 6 },
    fuselage: { taperStart: 0.24, tailDepth: 0.22, upsweep: 0.14, noseFull: 0.7, bellyFlat: 0.2 },
    tail:  { finHeight: 34, finSweep: 20, stabLen: 34 },
    canopy: { style: 'windows', x: -30, w: 44 },
    engineStyle: 'radial',
    engines: [
      { frac: 0, nose: true, cowlLen: 22, cowlH: 26 },
      { frac: 0.3, dy: 2, cowlLen: 26, cowlH: 20 },
      { frac: 0.3, dy: 1, cowlLen: 26, cowlH: 20, far: true },
    ],
    prop:  { r: 19, bladePairs: 1 },
    gear:  { fixed: true, style: 'spatted', rake: 2, mainX: 20, noseX: null, tailWheelX: -84, strutLen: 16, wheelR: 9.5, hingeY: 12 },
    flap:  { maxDeflectDeg: 30 },
    beacon: { x: -90, y: -56 },
    exhaust: { x: 40, y: 8 },
  },

};

/**
 * Resolve every authored engine mount onto the wing it hangs from. The nacelle
 * straddles the leading edge, protruding forward of it by about a third of its
 * own length, which is where a real one sits.
 */
export const AIRCRAFT_SPECS: Record<string, AircraftVisualSpec> = Object.fromEntries(
  Object.entries(RAW_SPECS).map(([id, raw]) => [id, {
    ...raw,
    groundContactY: raw.gear.hingeY + raw.gear.strutLen + raw.gear.wheelR,
    engines: raw.engines.map((e): EngineSpec => {
      if (e.nose) {
        return { ...e, x: raw.length * 0.5 - e.cowlLen * 0.42, y: e.dy ?? 0 };
      }
      const st = wingStation(raw, e.frac, !!e.far);
      return { ...e, x: st.x + e.cowlLen * 0.30, y: st.y + (e.dy ?? 0) };
    }),
  }]),
);

/** Fallback so an unknown aircraft id never crashes the renderer. */
export function specFor(aircraftId: string): AircraftVisualSpec {
  return AIRCRAFT_SPECS[aircraftId] ?? AIRCRAFT_SPECS.crop_duster;
}
