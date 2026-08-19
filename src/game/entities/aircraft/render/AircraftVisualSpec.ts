/**
 * Per-aircraft geometry + palette for the procedural renderer.
 *
 * Everything is in local "design units" (≈ on-screen pixels at scale 1),
 * with the aircraft NOSE FACING RIGHT and the origin at the fuselage datum
 * (centre of the fuselage at the wing root). Positive y is DOWN (screen space).
 */

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
  };
  engineStyle: EngineStyle;
  engines: EngineSpec[];
  prop: { r: number; bladePairs: 1 | 2 };
  gear: {
    fixed: boolean;          // true = non-retractable (always down, no doors)
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
    gear:  { fixed: true, mainX: 18, noseX: null, tailWheelX: -58, strutLen: 16, wheelR: 8, hingeY: 11 },
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
    // STOL bush ship: oversize tundra tyres, sprung steel legs, tailwheel.
    gear:  { fixed: true, mainX: 22, noseX: null, tailWheelX: -60, strutLen: 18, wheelR: 12, hingeY: 11 },
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
    fuselage: { taperStart: 0.15, tailDepth: 0.20, upsweep: 0.24, noseFull: 0.42, bellyFlat: 0.55 },
    tail:  { finHeight: 46, finSweep: 24, stabLen: 30, tTail: true },
    canopy: { style: 'windows', x: -54, w: 40 },
    engineStyle: 'turboprop',
    engines: [
      { frac: 0.30, dy: 4, cowlLen: 40, cowlH: 19 },
      { frac: 0.30, dy: 2, cowlLen: 40, cowlH: 19, far: true },
    ],
    prop:  { r: 26, bladePairs: 2 },
    // High wing, so the mains live in sponsons on the fuselage sides: twin
    // wheels on each leg, twin nose wheels, short legs close to the ground
    // for truck-bed loading.
    gear:  { fixed: false, mainX: 2, noseX: 82, tailWheelX: null, strutLen: 18, wheelR: 8,
             hingeY: 13, mainDual: true, noseDual: true, noseWheelR: 6,
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
    fuselage: { taperStart: 0.30, tailDepth: 0.56, upsweep: 0.36, noseFull: 0.40, bellyFlat: 0.85 },
    tail:  { finHeight: 52, finSweep: 22, stabLen: 46 },
    canopy: { style: 'windows', x: 8, w: 44 },
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
    gear:  { fixed: false, mainX: 6, noseX: 90, tailWheelX: null, strutLen: 17, wheelR: 10,
             hingeY: 15, mainWheels: 2, noseDual: true, noseWheelR: 7,
             sponson: { x: 6, w: 62, h: 15 } },
    flap:  { maxDeflectDeg: 40 },
    beacon: { x: -98, y: -78 },
    exhaust: { x: 34, y: -4 },
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
