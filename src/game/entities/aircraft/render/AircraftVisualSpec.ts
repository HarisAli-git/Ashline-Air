/**
 * Per-aircraft geometry + palette for the procedural renderer.
 *
 * Everything is in local "design units" (≈ on-screen pixels at scale 1),
 * with the aircraft NOSE FACING RIGHT and the origin at the fuselage datum
 * (centre of the fuselage at the wing root). Positive y is DOWN (screen space).
 */

export type WingLayout = 'low' | 'high' | 'biplane';
export type CanopyStyle = 'bubble' | 'windows';

export interface EngineSpec {
  x: number;        // cowl centre x (datum-relative)
  y: number;        // cowl centre y
  cowlLen: number;  // nacelle length
  cowlH: number;    // nacelle height
  far?: boolean;    // rendered behind the fuselage, darker
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
  tail: { finHeight: number; finSweep: number; stabLen: number };
  canopy: { style: CanopyStyle; x: number; w: number };
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
  };
  flap: { maxDeflectDeg: number };
  beacon: { x: number; y: number };  // usually the fin tip
  exhaust: { x: number; y: number }; // exhaust stack / stain origin
  /** Distance from datum to wheel-bottom with gear down (container ground offset). */
  groundContactY: number;
  /**
   * Taildraggers rest nose-high on their tail wheel; this is the parked
   * attitude in degrees. The tail lifts as the takeoff roll gains speed.
   */
  groundStanceDeg?: number;
}

/** Hinge point of the trailing-edge flap, derived from the wing. */
export function flapHinge(spec: AircraftVisualSpec): { x: number; y: number } {
  const w = spec.wing;
  return { x: w.rootX - w.chord * 0.45 + 1, y: w.y + w.drop * 0.3 + 1 };
}

export const AIRCRAFT_SPECS: Record<string, AircraftVisualSpec> = {
  crop_duster: {
    scale: 1.0,
    length: 132,
    height: 30,
    palette: {
      hull: 0x96502f, hullShade: 0x62341f, hullLight: 0xb56b45,
      accent: 0xc9a44a, rust: 0x59301c,
      canopy: 0x27333b, canopyGlint: 0x9fc4d0,
      prop: 0x2a2622, metal: 0x8f8a80,
    },
    wing:  { layout: 'biplane', rootX: 8, y: 8, chord: 40, span: 46, sweep: 12, drop: 8 },
    tail:  { finHeight: 24, finSweep: 10, stabLen: 30 },
    canopy: { style: 'bubble', x: 8, w: 26 },
    engines: [{ x: 52, y: 0, cowlLen: 24, cowlH: 24 }],
    prop:  { r: 20, bladePairs: 1 },
    gear:  { fixed: true, mainX: 18, noseX: null, tailWheelX: -58, strutLen: 16, wheelR: 7, hingeY: 12 },
    flap:  { maxDeflectDeg: 30 },
    beacon: { x: -58, y: -36 },
    exhaust: { x: 40, y: 10 },
    groundContactY: 38,
    groundStanceDeg: 11,
  },

  bush_plane: {
    scale: 1.0,
    length: 140,
    height: 30,
    palette: {
      hull: 0x6b6f43, hullShade: 0x45492b, hullLight: 0x898d58,
      accent: 0xb08a50, rust: 0x5c3a22,
      canopy: 0x27333b, canopyGlint: 0x9fc4d0,
      prop: 0x2a2622, metal: 0x8f8a80,
    },
    wing:  { layout: 'high', rootX: 6, y: -16, chord: 46, span: 60, sweep: 10, drop: -6 },
    tail:  { finHeight: 26, finSweep: 12, stabLen: 32 },
    canopy: { style: 'windows', x: 30, w: 34 },
    engines: [{ x: 58, y: 2, cowlLen: 22, cowlH: 24 }],
    prop:  { r: 21, bladePairs: 1 },
    gear:  { fixed: true, mainX: 22, noseX: null, tailWheelX: -60, strutLen: 20, wheelR: 9, hingeY: 12 },
    flap:  { maxDeflectDeg: 35 },
    beacon: { x: -62, y: -38 },
    exhaust: { x: 44, y: 12 },
    groundContactY: 44,
    groundStanceDeg: 11,
  },

  old_cargo_aircraft: {
    scale: 0.95,
    length: 185,
    height: 42,
    palette: {
      hull: 0x8f8d84, hullShade: 0x615f57, hullLight: 0xaba99e,
      accent: 0x7a4a2e, rust: 0x6b3a20,
      canopy: 0x2b3740, canopyGlint: 0x9fc4d0,
      prop: 0x26231f, metal: 0x7d7970,
    },
    wing:  { layout: 'low', rootX: 4, y: 10, chord: 56, span: 74, sweep: 22, drop: 9 },
    tail:  { finHeight: 34, finSweep: 16, stabLen: 40 },
    canopy: { style: 'windows', x: 62, w: 40 },
    engines: [
      { x: 34, y: 14, cowlLen: 34, cowlH: 22 },
      { x: 22, y: 6,  cowlLen: 34, cowlH: 22, far: true },
    ],
    prop:  { r: 24, bladePairs: 2 },
    gear:  { fixed: false, mainX: 30, noseX: null, tailWheelX: -78, strutLen: 26, wheelR: 11, hingeY: 16 },
    flap:  { maxDeflectDeg: 35 },
    beacon: { x: -84, y: -52 },
    exhaust: { x: 22, y: 22 },
    groundContactY: 58,
    groundStanceDeg: 9,
  },

  twin_turboprop: {
    scale: 0.95,
    length: 190,
    height: 34,
    palette: {
      hull: 0x5d6b74, hullShade: 0x3e4950, hullLight: 0x7c8c96,
      accent: 0xc9a44a, rust: 0x54402c,
      canopy: 0x222e36, canopyGlint: 0xaed4e0,
      prop: 0x23201d, metal: 0x8f8a80,
    },
    wing:  { layout: 'low', rootX: 2, y: 8, chord: 50, span: 78, sweep: 26, drop: 8 },
    tail:  { finHeight: 36, finSweep: 20, stabLen: 38 },
    canopy: { style: 'windows', x: 66, w: 38 },
    engines: [
      { x: 30, y: 10, cowlLen: 38, cowlH: 18 },
      { x: 18, y: 3,  cowlLen: 38, cowlH: 18, far: true },
    ],
    prop:  { r: 22, bladePairs: 2 },
    gear:  { fixed: false, mainX: 26, noseX: 74, tailWheelX: null, strutLen: 24, wheelR: 9, hingeY: 14 },
    flap:  { maxDeflectDeg: 40 },
    beacon: { x: -88, y: -54 },
    exhaust: { x: 14, y: 16 },
    groundContactY: 50,
  },

  military_transport: {
    scale: 0.9,
    length: 215,
    height: 48,
    palette: {
      hull: 0x5c6653, hullShade: 0x3d4437, hullLight: 0x76816a,
      accent: 0x8a8556, rust: 0x5c3a22,
      canopy: 0x252f28, canopyGlint: 0x9fc4b0,
      prop: 0x23201d, metal: 0x716d64,
    },
    wing:  { layout: 'high', rootX: 4, y: -22, chord: 62, span: 92, sweep: 26, drop: -6 },
    tail:  { finHeight: 44, finSweep: 18, stabLen: 46 },
    canopy: { style: 'windows', x: 78, w: 44 },
    engines: [
      { x: 48, y: -10, cowlLen: 34, cowlH: 18 },
      { x: 10, y: -12, cowlLen: 34, cowlH: 18 },
      { x: 36, y: -16, cowlLen: 32, cowlH: 16, far: true },
      { x: -2, y: -18, cowlLen: 32, cowlH: 16, far: true },
    ],
    prop:  { r: 22, bladePairs: 2 },
    gear:  { fixed: false, mainX: 22, noseX: 86, tailWheelX: null, strutLen: 26, wheelR: 11, hingeY: 20 },
    flap:  { maxDeflectDeg: 40 },
    beacon: { x: -98, y: -70 },
    exhaust: { x: 34, y: -4 },
    groundContactY: 62,
  },
};

/** Fallback so an unknown aircraft id never crashes the renderer. */
export function specFor(aircraftId: string): AircraftVisualSpec {
  return AIRCRAFT_SPECS[aircraftId] ?? AIRCRAFT_SPECS.crop_duster;
}
