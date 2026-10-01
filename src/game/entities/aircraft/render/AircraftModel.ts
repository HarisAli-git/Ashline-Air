import Phaser from 'phaser';
import { stabRoot, type AircraftVisualSpec } from './AircraftVisualSpec';

/**
 * The aeroplane as a lit 3D model — what you see in flight.
 *
 * It used to be a painted side view, and however good the paint, a side view
 * is a cut-out: it cannot bank, it cannot show the wing it is turning on, and
 * its flaps were a little rectangle that rotated. "It looks like a prop being
 * flown" was exactly right. This builds a real model from the same design data
 * the painter used — the fuselage profile, the wing and tail geometry, the
 * engine stations, the undercarriage — and draws it every frame:
 *
 *  - SMOOTH SHADING. Each triangle carries a colour per corner, lit from that
 *    corner's own normal, so a fuselage reads as a curved tube with a sheen
 *    running along it rather than a stack of flat facets.
 *  - THE SAME LIGHT AS THE WORLD. Sun from the low left (the one every shadow
 *    in the world is thrown from), the sky's colour from above, the ground's
 *    from below, a specular glint, and the haze of whatever weather it is in.
 *  - MOVING PARTS. Flaps, ailerons, elevator and rudder are separate hinged
 *    pieces; the propeller is real blades when it turns slowly and a blurred
 *    disc when it does not; the gear folds away.
 *  - AN ATTITUDE. Pitch, roll and yaw are applied to the model, so turbulence
 *    rocks the wings and a turn is flown, not flipped.
 *
 * Coordinates: design units in the painter's frame — x forward (nose +x),
 * y DOWN, z toward the camera, which is the aircraft's right-hand side.
 */

type V3 = [number, number, number];

export interface ModelLight {
  /** Ambient from above. */
  sky: number;
  /** Bounce light from below. */
  ground: number;
  /** Direct sunlight colour. */
  sun: number;
  /** 0 = night … 1 = full day. */
  daylight: number;
  /** 0 = clear air … 1 = fogged right out. */
  haze: number;
  hazeColor: number;
}

export interface ModelPose {
  yaw: number;
  roll: number;
  pitch: number;
  flapDeg: number;
  /** Aileron deflection, radians: positive drops the right (+z) aileron. */
  aileron: number;
  /** Elevator command −1 … 1, positive = trailing edge up. */
  elevator: number;
  rudder: number;
  /** 1 = gear down and locked … 0 = stowed. */
  gear: number;
  propAngle: number;
  /** 0 … 1 spooled rpm. */
  propSpeed: number;
  damage: number;
  ice: number;
  /** 0 … 1 beacon strobe. */
  beacon: number;
  landingLight: boolean;
  /** After a crash: the props are gone. */
  shed: boolean;
}

interface Material {
  color: number;
  /** Specular strength and shininess. */
  spec: number;
  shine: number;
  alpha: number;
  /** Ignore lighting (lamps, the dark of an intake). */
  flat?: boolean;
}

interface Part {
  pivot: V3;
  axis: V3;
  /** Rotation that drives the panel TRAILING EDGE DOWN for a positive angle. */
  sign: number;
  angle: number;
  /** Translation applied as `offset * slide` (gear stowing into a sponson). */
  offset: V3;
  slide: number;
  hidden: boolean;
  kind: string;
}

const MAT = {
  hull: 0, belly: 1, accent: 2, top: 3, glass: 4, metal: 5, dark: 6, tyre: 7, hub: 8,
  wingTop: 9, wingBot: 10, prop: 11, disc: 12, rust: 13, intake: 14, soot: 15, line: 16, strut: 17, glow: 18,
} as const;

function mixC(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * u) << 16) | (Math.round(ag + (bg - ag) * u) << 8) | Math.round(ab + (bb - ab) * u);
}

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rodrigues: rotate v about unit axis k by θ. */
function rotAxis(v: V3, k: V3, c: number, s: number): V3 {
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** Real wingspan as a fraction of length — a side view never shows it. */
function spanRatio(spec: AircraftVisualSpec): number {
  if (spec.wing.layout === 'biplane') return 1.3;
  return spec.engines.some(e => !e.nose) ? (spec.engines.length > 2 ? 1.3 : 1.05) : 1.35;
}

// ── Building ────────────────────────────────────────────────────────────────

class Builder {
  readonly pos: number[] = [];
  readonly vpart: number[] = [];
  readonly tris: number[] = [];
  readonly tmat: number[] = [];
  /** bit 0: cull back faces · bit 1: decal (drawn over what it sits on) */
  readonly tflag: number[] = [];
  readonly parts: Part[] = [{ pivot: [0, 0, 0], axis: [0, 0, 1], sign: 1, angle: 0, offset: [0, 0, 0], slide: 0, hidden: false, kind: 'body' }];
  part = 0;

  v(p: V3): number {
    this.pos.push(p[0], p[1], p[2]);
    this.vpart.push(this.part);
    return this.vpart.length - 1;
  }
  P(i: number): V3 { return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]; }

  /** A triangle, wound so its normal points away from `inside` (when given). */
  tri(a: number, b: number, c: number, mat: number, flags = 1, inside?: V3): void {
    if (inside) {
      const A = this.P(a), B = this.P(b), C = this.P(c);
      const n = cross(sub(C, A), sub(B, A));
      const m = scl(add(add(A, B), C), 1 / 3);
      if (dot(n, sub(m, inside)) < 0) { const t = b; b = c; c = t; }
    }
    this.tris.push(a, b, c);
    this.tmat.push(mat);
    this.tflag.push(flags);
  }
  quad(a: number, b: number, c: number, d: number, mat: number, flags = 1, inside?: V3): void {
    this.tri(a, b, c, mat, flags, inside);
    this.tri(a, c, d, mat, flags, inside);
  }

  newPart(p: Omit<Part, 'angle' | 'slide' | 'hidden'>): number {
    this.parts.push({ ...p, angle: 0, slide: 0, hidden: false });
    this.part = this.parts.length - 1;
    return this.part;
  }

  /**
   * Loft closed rings into a skin. Shared vertices along the skin give smooth
   * normals; `matFor` paints each face. Caps close the ends when asked.
   */
  loft(rings: V3[][], matFor: (s: number, k: number) => number, opts: { capStart?: number; capEnd?: number; flags?: number } = {}): number[][] {
    const idx = rings.map(r => r.map(p => this.v(p)));
    const n = rings[0].length;
    const centroid = (r: V3[]): V3 => scl(r.reduce((a, p) => add(a, p), [0, 0, 0] as V3), 1 / r.length);
    for (let s = 0; s + 1 < rings.length; s++) {
      const inside = scl(add(centroid(rings[s]), centroid(rings[s + 1])), 0.5);
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        this.quad(idx[s][k], idx[s][k2], idx[s + 1][k2], idx[s + 1][k], matFor(s, k), opts.flags ?? 1, inside);
      }
    }
    const cap = (ring: V3[], next: V3[], mat: number): void => {
      const c = centroid(ring);
      const ci = this.v(c);
      const away = centroid(next);
      const vi = ring.map(p => this.v(p));
      for (let k = 0; k < ring.length; k++) this.tri(ci, vi[k], vi[(k + 1) % ring.length], mat, opts.flags ?? 1, away);
    };
    if (opts.capStart !== undefined) cap(rings[0], rings[1], opts.capStart);
    if (opts.capEnd !== undefined) cap(rings[rings.length - 1], rings[rings.length - 2], opts.capEnd);
    return idx;
  }

  /** A body of revolution about an axis parallel to x. */
  revolve(profile: Array<[number, number]>, cy: number, cz: number, segs: number, mat: number, squash = 1, opts: { capStart?: number; capEnd?: number } = {}): void {
    const rings = profile.map(([x, r]) => {
      const ring: V3[] = [];
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        ring.push([x, cy + Math.sin(a) * r * squash, cz + Math.cos(a) * r]);
      }
      return ring;
    });
    this.loft(rings, () => mat, opts);
  }

  ellipsoid(c: V3, rx: number, ry: number, rz: number, mat: number, upperOnly = false, segs = 12, rows = 6): void {
    const rings: V3[][] = [];
    const v0 = upperOnly ? 0 : -Math.PI / 2;
    for (let i = 1; i < rows; i++) {
      const v = v0 + ((Math.PI / 2 - v0) * i) / rows;  // latitude from bottom (or equator) up
      const ring: V3[] = [];
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        ring.push([c[0] + Math.cos(a) * Math.cos(v) * rx, c[1] - Math.sin(v) * ry, c[2] + Math.sin(a) * Math.cos(v) * rz]);
      }
      rings.push(ring);
    }
    const idx = this.loft(rings, () => mat);
    // Close the pole on top (and the bottom pole when whole)
    const top = this.v([c[0], c[1] - ry, c[2]]);
    const last = idx[idx.length - 1];
    for (let k = 0; k < segs; k++) this.tri(top, last[k], last[(k + 1) % segs], mat, 1, c);
    if (!upperOnly) {
      const bot = this.v([c[0], c[1] + ry, c[2]]);
      const first = idx[0];
      for (let k = 0; k < segs; k++) this.tri(bot, first[(k + 1) % segs], first[k], mat, 1, c);
    }
  }

  /** A square-section beam between two points (struts, legs, wires). */
  beam(p0: V3, p1: V3, w: number, mat: number): void {
    const d = norm(sub(p1, p0));
    const up: V3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const a = scl(norm(cross(d, up)), w / 2);
    const b = scl(norm(cross(d, a)), w / 2);
    const ring = (p: V3): V3[] => [add(add(p, a), b), add(sub(p, a), b), sub(sub(p, a), b), sub(add(p, a), b)];
    this.loft([ring(p0), ring(p1)], () => mat, { capStart: mat, capEnd: mat });
  }

  /** A wheel: a tyre with its axle along z, and a hub on the outer face. */
  wheel(c: V3, r: number, w: number, outward: number): void {
    const segs = 14;
    const rings: V3[][] = [];
    for (const [dz, rr] of [[-w / 2, r * 0.82], [-w / 2 + w * 0.12, r], [w / 2 - w * 0.12, r], [w / 2, r * 0.82]] as Array<[number, number]>) {
      const ring: V3[] = [];
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        ring.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr, c[2] + dz]);
      }
      rings.push(ring);
    }
    this.loft(rings, () => MAT.tyre, { capStart: MAT.hub, capEnd: MAT.hub });
    // Hub boss on the outer face
    const hz = c[2] + outward * (w / 2 + 0.3);
    const hub: V3[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      hub.push([c[0] + Math.cos(a) * r * 0.4, c[1] + Math.sin(a) * r * 0.4, hz]);
    }
    const hc = this.v([c[0], c[1], hz + outward * 0.4]);
    const hi = hub.map(p => this.v(p));
    for (let k = 0; k < 8; k++) this.tri(hc, hi[k], hi[(k + 1) % 8], MAT.metal, 1, [c[0], c[1], c[2]]);
  }
}

/**
 * A wing section between chordwise stations x0 … x1 (0 = leading edge, 1 =
 * trailing edge), NACA-style thickness with a little camber.
 */
function section(le: V3, chordDir: V3, thickDir: V3, c: number, t: number, x0: number, x1: number, camber = 0.03): V3[] {
  const xsBase = [0, 0.015, 0.05, 0.12, 0.22, 0.35, 0.5, 0.64, 0.74, 0.86, 1];
  const xs = [x0, ...xsBase.filter(x => x > x0 + 0.005 && x < x1 - 0.005), x1];
  const yt = (x: number): number => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const p = 0.4;
  const yc = (x: number): number => (x < p ? (camber / (p * p)) * (2 * p * x - x * x) : (camber / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x));
  const pt = (x: number, s: number): V3 => add(add(le, scl(chordDir, x * c)), scl(thickDir, (yc(x) + s * Math.max(yt(x), 0.002)) * c));
  const upper = [...xs].reverse().map(x => pt(x, 1));
  const lower = xs.map(x => pt(x, -1));
  // At the leading edge the two surfaces meet: drop the duplicate
  if (x0 < 0.001) lower.shift();
  return [...upper, ...lower];
}

export interface ModelData {
  pos: Float32Array;
  vpart: Int16Array;
  norms: Float32Array;
  tris: Uint32Array;
  tmat: Uint8Array;
  tflag: Uint8Array;
  parts: Part[];
  mats: Material[];
  /** Named parts, for the pose to drive. */
  named: Record<string, number[]>;
  lights: { beacon: V3; navL: V3; navR: V3; land: V3 };
}

export function buildAircraftModel(spec: AircraftVisualSpec, contactY: number, detail: 'high' | 'low' = 'high'): ModelData {
  const B = new Builder();
  const pal = spec.palette;
  const L = spec.length, H = spec.height;
  const f = spec.fuselage;
  const named: Record<string, number[]> = {};
  const name = (k: string, i: number): void => { (named[k] ??= []).push(i); };

  const mats: Material[] = [];
  const setMat = (i: number, m: Material): void => { mats[i] = m; };
  setMat(MAT.hull, { color: pal.hull, spec: 0.28, shine: 18, alpha: 1 });
  setMat(MAT.belly, { color: mixC(pal.hullShade, pal.hull, 0.25), spec: 0.22, shine: 14, alpha: 1 });
  setMat(MAT.accent, { color: pal.accent, spec: 0.32, shine: 20, alpha: 1 });
  setMat(MAT.top, { color: mixC(pal.hull, pal.hullLight, 0.45), spec: 0.3, shine: 18, alpha: 1 });
  setMat(MAT.glass, { color: mixC(pal.canopy, 0x0a1218, 0.3), spec: 1.1, shine: 60, alpha: 1 });
  setMat(MAT.metal, { color: mixC(pal.metal, 0x5a5650, 0.2), spec: 0.7, shine: 30, alpha: 1 });
  setMat(MAT.dark, { color: 0x1d1b18, spec: 0.15, shine: 10, alpha: 1 });
  setMat(MAT.tyre, { color: 0x1c1a17, spec: 0.08, shine: 6, alpha: 1 });
  setMat(MAT.hub, { color: 0x2c2a26, spec: 0.3, shine: 16, alpha: 1 });
  setMat(MAT.wingTop, { color: mixC(pal.hull, pal.hullLight, 0.2), spec: 0.3, shine: 16, alpha: 1 });
  setMat(MAT.wingBot, { color: mixC(pal.hullShade, pal.hull, 0.4), spec: 0.15, shine: 10, alpha: 1 });
  setMat(MAT.prop, { color: mixC(pal.prop, 0x000000, 0.1), spec: 0.4, shine: 20, alpha: 1 });
  setMat(MAT.disc, { color: 0xd8dde2, spec: 0, shine: 1, alpha: 0.18, flat: true });
  setMat(MAT.rust, { color: mixC(pal.hull, pal.rust, 0.65), spec: 0.08, shine: 8, alpha: 1 });
  setMat(MAT.intake, { color: 0x0e0c0a, spec: 0, shine: 1, alpha: 1, flat: true });
  setMat(MAT.soot, { color: 0x1a1612, spec: 0, shine: 1, alpha: 0.5, flat: true });
  setMat(MAT.line, { color: mixC(pal.hull, 0x000000, 0.45), spec: 0, shine: 1, alpha: 0.45, flat: true });
  setMat(MAT.strut, { color: mixC(pal.metal, 0x000000, 0.3), spec: 0.4, shine: 18, alpha: 1 });
  setMat(MAT.glow, { color: 0xfff0c0, spec: 0, shine: 1, alpha: 1, flat: true });

  // ── Fuselage, lofted from the painter's own side profile ────────────────
  const kNose = (1 - f.noseFull * f.noseFull) / 0.907;
  const halfH = (u: number): number => {
    const s0 = u < f.taperStart
      ? f.tailDepth + (1 - f.tailDepth) * Math.pow(u / f.taperStart, 0.7)
      : u < 0.70 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.70) / 0.315, 2) * kNose));
    return Math.max(0.5, (H / 2) * s0);
  };
  const camber = (u: number): number =>
    -H * f.upsweep * Math.max(0, (f.taperStart + 0.08 - u) / (f.taperStart + 0.08));
  const noseEngine = spec.engines.some(e => e.nose);
  const widthAt = (u: number): number => {
    const base = 0.74 + f.bellyFlat * 0.12;
    // A radial cowl is round, whatever the cabin behind it
    const round = noseEngine ? Math.max(0, (u - 0.72) / 0.2) : 0;
    return base + (0.96 - base) * Math.min(1, round);
  };
  // A phone gets a twelve-sided fuselage; nobody can count facets at that size
  const RING = detail === 'low' ? 12 : 18;
  const step = (Math.PI * 2) / RING;
  const surf = (u: number, a: number, out = 0): V3 => {
    const hh = halfH(u);
    let sy = Math.sin(a), cz = Math.cos(a);
    if (sy > 0 && f.bellyFlat > 0) {
      sy = Math.pow(sy, 1 - f.bellyFlat * 0.6);
      cz = Math.sign(cz) * Math.pow(Math.abs(cz), 1 - f.bellyFlat * 0.5);
    }
    const r: V3 = [-L / 2 + u * L, camber(u) + hh * sy, hh * widthAt(u) * cz];
    if (out === 0) return r;
    const nrm = norm([0, Math.sin(a), Math.cos(a)]);
    return add(r, scl(nrm, out));
  };
  const stations = [0, 0.02, 0.05, 0.09, 0.14, 0.2, 0.27, 0.35, 0.43, 0.51, 0.59, 0.66, 0.72, 0.78, 0.83, 0.875, 0.915, 0.95, 0.975, 0.99];
  const uEnd = noseEngine ? 0.975 : 0.99;
  const st = stations.filter(u => u <= uEnd);
  const rings = st.map(u => {
    const ring: V3[] = [];
    for (let k = 0; k < RING; k++) ring.push(surf(u, k * step - step / 2));
    return ring;
  });
  B.loft(rings, (s, k) => {
    const uMid = (st[s] + st[s + 1]) / 2;
    const sMid = Math.sin(k * step);
    const side = Math.abs(sMid) < 0.2;
    if (noseEngine && uMid > 0.86) return MAT.metal;                 // the cowl
    if (side && uMid > 0.14 && uMid < 0.8) return MAT.accent;         // the cheat line
    if (hash(s * 31 + k * 7 + L) < 0.045 && uMid > 0.1 && uMid < 0.85) return MAT.rust;
    if (sMid > 0.35) return MAT.belly;
    if (sMid < -0.7) return MAT.top;
    return MAT.hull;
  });
  // Tail cone tip
  {
    const tip = B.v([-L / 2 - 1, camber(0), 0]);
    const r0 = rings[0].map(p => B.v(p));
    for (let k = 0; k < RING; k++) B.tri(tip, r0[(k + 1) % RING], r0[k], MAT.hull, 1, [-L / 2 + 4, camber(0.02), 0]);
  }
  // Nose: a radome on a transport, the open front of the cowl on a radial
  const lastRing = rings[rings.length - 1];
  const noseC: V3 = [-L / 2 + uEnd * L, camber(uEnd), 0];
  if (noseEngine) {
    const inner = lastRing.map(p => add(scl(sub(p, noseC), 0.62), noseC));
    const li = lastRing.map(p => B.v(p)), ii = inner.map(p => B.v(add(p, [0.6, 0, 0])));
    for (let k = 0; k < RING; k++) B.quad(li[k], li[(k + 1) % RING], ii[(k + 1) % RING], ii[k], MAT.metal, 1, add(noseC, [-6, 0, 0]));
    const c = B.v(add(noseC, [0.2, 0, 0]));
    for (let k = 0; k < RING; k++) B.tri(c, ii[k], ii[(k + 1) % RING], MAT.intake, 1, add(noseC, [-6, 0, 0]));
  } else {
    const tip = B.v([L / 2, camber(1), 0]);
    const li = lastRing.map(p => B.v(p));
    for (let k = 0; k < RING; k++) B.tri(tip, li[k], li[(k + 1) % RING], MAT.belly, 1, add(noseC, [-6, 0, 0]));
  }

  // ── Decals on the skin: windows, panel lines, soot ──────────────────────
  const decal = (u0: number, u1: number, a0: number, a1: number, mat: number, out = 0.35): void => {
    const p = [surf(u0, a0, out), surf(u1, a0, out), surf(u1, a1, out), surf(u0, a1, out)].map(q => B.v(q));
    const c = surf((u0 + u1) / 2, (a0 + a1) / 2, -2);
    B.quad(p[0], p[1], p[2], p[3], mat, 3, c);
  };
  for (const side of [1, -1]) {
    const A = (a: number): number => (side > 0 ? a : Math.PI - a);
    // Flight deck glazing
    if (spec.canopy.style === 'windows') {
      decal(0.8, 0.9, A(-0.95), A(-0.42), MAT.glass, 0.4);
      decal(0.905, 0.94, A(-0.85), A(-0.45), MAT.glass, 0.4);
      // A row of cabin windows down the side
      const n = Math.round(L / 22);
      for (let i = 0; i < n; i++) {
        const u = 0.36 + (0.38 * i) / Math.max(1, n - 1);
        decal(u, u + 0.014, A(-0.42), A(-0.18), MAT.glass, 0.4);
      }
      // A cargo door outline aft
      decal(0.24, 0.245, A(-0.5), A(0.55), MAT.line, 0.4);
      decal(0.31, 0.315, A(-0.5), A(0.55), MAT.line, 0.4);
    }
    // Panel joints round the fuselage
    for (const u of detail === 'low' ? [] : [0.27, 0.43, 0.59, 0.72]) {
      for (let k = 0; k < 9; k++) {
        const a0 = -Math.PI / 2 + (k / 9) * Math.PI, a1 = -Math.PI / 2 + ((k + 1) / 9) * Math.PI;
        decal(u, u + 0.004, A(a0), A(a1), MAT.line, 0.3);
      }
    }
    // Exhaust soot streaking back from the stacks of a radial
    if (noseEngine) {
      const ex = (spec.exhaust.x + L / 2) / L;
      decal(ex - 0.16, ex, A(0.15), A(0.42), MAT.soot, 0.38);
    }
  }

  // ── Canopy ─────────────────────────────────────────────────────────────
  if (spec.canopy.style === 'bubble') {
    const u = (spec.canopy.x + spec.canopy.w * 0.5 + L / 2) / L;
    const cx = -L / 2 + u * L;
    const topY = camber(u) - halfH(u);
    B.ellipsoid([cx, topY + 1.5, 0], spec.canopy.w * 0.55, H * 0.36, halfH(u) * widthAt(u) * 0.78, MAT.glass, true, 14, 5);
    // The frame down its middle and at the windscreen
    B.beam([cx - spec.canopy.w * 0.2, topY - H * 0.33, 0], [cx + spec.canopy.w * 0.45, topY - H * 0.05, 0], 0.9, MAT.metal);
  }

  // ── Wings ──────────────────────────────────────────────────────────────
  const w = spec.wing;
  const S = (L * spanRatio(spec)) / 2;
  const upperY = -H / 2 - 14;
  const dihedral = w.layout === 'low' ? 0.07 : w.layout === 'biplane' ? 0.04 : 0.02;
  const flapFrac = 0.27;      // flap chord fraction
  const wingDef = (wy: number, withFlaps: boolean, tag: string): void => {
    const c0 = w.chord, c1 = w.chord * (w.layout === 'biplane' ? 0.92 : 0.62);
    const le0 = w.rootX + w.chord * 0.5;
    const sweep = w.sweep * 0.85;
    for (const side of [1, -1]) {
      const at = (fz: number): { le: V3; c: number; t: number } => ({
        le: [le0 - sweep * fz, wy - S * dihedral * fz, side * S * fz],
        c: c0 + (c1 - c0) * fz,
        t: 0.15 - 0.04 * fz,
      });
      const sec = (fz: number, x0: number, x1: number): V3[] => {
        const a = at(fz);
        return section(a.le, [-1, 0, 0], [0, -1, 0], a.c, a.t, x0, x1);
      };
      const panel = (f0: number, f1: number, x0: number, x1: number, matTop: number, matBot: number, capEnd = false): void => {
        const r0 = sec(f0, x0, x1), r1 = sec(f1, x0, x1);
        const n = r0.length;
        const upCount = Math.ceil(n / 2);
        B.loft([r0, r1], (_s, k) => (k < upCount - 1 ? matTop : matBot), capEnd ? { capEnd: matBot } : {});
      };
      const cut = 1 - flapFrac - 0.02;
      B.part = 0;
      const stationsZ = [0, 0.14, 0.58, 0.62, 0.96, 1];
      panel(0, 0.14, 0, 1, MAT.wingTop, MAT.wingBot);
      panel(0.14, 0.58, 0, withFlaps ? cut : 1, MAT.wingTop, MAT.wingBot);
      panel(0.58, 0.62, 0, 1, MAT.wingTop, MAT.wingBot);
      panel(0.62, 0.96, 0, cut, MAT.wingTop, MAT.wingBot);
      panel(0.96, 1, 0, 1, MAT.wingTop, MAT.wingBot, true);
      void stationsZ;
      // Hinged surfaces: a flap inboard, an aileron outboard
      const hinged = (f0: number, f1: number, kind: string): void => {
        const a0 = at(f0), a1 = at(f1);
        const hx = 1 - flapFrac;
        const piv0 = add(a0.le, [-hx * a0.c, a0.c * 0.02, 0]);
        const piv1 = add(a1.le, [-hx * a1.c, a1.c * 0.02, 0]);
        const axis = norm(sub(piv1, piv0));
        const pi = B.newPart({ pivot: piv0, axis, sign: 1, offset: [0, 0, 0], kind });
        name(`${kind}${side > 0 ? 'R' : 'L'}${tag}`, pi);
        const r0 = sec(f0, hx, 1), r1 = sec(f1, hx, 1);
        const upCount = Math.ceil(r0.length / 2);
        B.loft([r0, r1], (_s, k) => (k < upCount - 1 ? MAT.wingTop : MAT.wingBot), { capStart: MAT.wingBot, capEnd: MAT.wingBot });
        // Which way is trailing-edge down?
        const te = add(a0.le, [-a0.c, 0, 0]);
        const rot = add(rotAxis(sub(te, piv0), axis, Math.cos(0.3), Math.sin(0.3)), piv0);
        B.parts[pi].sign = rot[1] > te[1] ? 1 : -1;
        B.part = 0;
      };
      if (withFlaps) hinged(0.14, 0.58, 'flap');
      hinged(0.62, 0.96, 'ail');
    }
  };
  if (w.layout === 'biplane') {
    wingDef(upperY, false, 'U');
    wingDef(w.y, true, '');
    // Interplane struts, cabane struts and flying wires
    for (const side of [1, -1]) {
      const z = side * S * 0.66;
      const x = w.rootX - w.sweep * 0.56;
      const yU = upperY - S * dihedral * 0.66, yL = w.y - S * dihedral * 0.66;
      B.beam([x + 4, yU + 1, z], [x + 4, yL - 1, z], 1.6, MAT.strut);
      B.beam([x - w.chord * 0.45, yU + 1, z], [x - w.chord * 0.45, yL - 1, z], 1.6, MAT.strut);
      B.beam([w.rootX + 4, upperY + 1, side * 5], [w.rootX + 6, -H * 0.45, side * H * 0.3], 1.2, MAT.strut);
      B.beam([w.rootX - 10, upperY + 1, side * 5], [w.rootX - 8, -H * 0.45, side * H * 0.3], 1.2, MAT.strut);
      B.beam([x, yU + 1, z], [w.rootX, w.y + 2, side * H * 0.35], 0.35, MAT.dark);
      B.beam([x, yL - 1, z], [w.rootX, upperY + 2, side * 6], 0.35, MAT.dark);
    }
  } else {
    wingDef(w.y, true, '');
  }
  // Lift struts on a braced high wing
  if (w.layout === 'high' && noseEngine) {
    for (const side of [1, -1]) {
      B.beam([w.rootX + 3, w.y + 2, side * S * 0.48], [w.rootX + 1, H * 0.3, side * H * 0.36], 1.5, MAT.strut);
      B.beam([w.rootX - 12, w.y + 2, side * S * 0.46], [w.rootX - 6, H * 0.3, side * H * 0.36], 1.3, MAT.strut);
    }
  }

  // ── Tail ───────────────────────────────────────────────────────────────
  const t = spec.tail;
  const finTop = -H / 2 - t.finHeight;
  {
    // Fin: lofted UP from inside the tail cone, rudder hinged at its back
    const rootY = camber(0.1) - halfH(0.1) * 0.4;
    const rootLE: V3 = [-L * 0.33, rootY, 0], rootTE: V3 = [-L / 2 + 1, rootY, 0];
    const tipLE: V3 = [-L / 2 + t.finSweep, finTop, 0], tipTE: V3 = [-L / 2, finTop, 0];
    const cRoot = rootLE[0] - rootTE[0], cTip = tipLE[0] - tipTE[0];
    const rud = 0.68;
    const finSec = (le: V3, c: number, x0: number, x1: number): V3[] => section(le, [-1, 0, 0], [0, 0, 1], c, 0.1, x0, x1, 0);
    const r0 = finSec(rootLE, cRoot, 0, rud - 0.02), r1 = finSec(tipLE, cTip, 0, rud - 0.02);
    const half = 0;
    // The tail band: the top third of the fin in the accent colour
    void half;
    B.loft([r0, r0.map((p, i) => lerp3(p, r1[i], 0.62)), r1], (s) => (s === 1 ? MAT.accent : MAT.hull), { capEnd: MAT.accent });
    const hr0 = add(rootLE, [-cRoot * rud, 0, 0]), hr1 = add(tipLE, [-cTip * rud, 0, 0]);
    const axis = norm(sub(hr1, hr0));
    const pi = B.newPart({ pivot: hr0, axis, sign: 1, offset: [0, 0, 0], kind: 'rudder' });
    name('rudder', pi);
    const q0 = finSec(rootLE, cRoot, rud, 1), q1 = finSec(tipLE, cTip, rud, 1);
    B.loft([q0, q0.map((p, i) => lerp3(p, q1[i], 0.62)), q1], (s) => (s === 1 ? MAT.accent : MAT.hull), { capEnd: MAT.accent });
    B.part = 0;
  }
  {
    const sr = stabRoot(spec);
    const stabSpan = S * (t.tTail ? 0.3 : 0.34);
    const chord0 = t.stabLen, chord1 = t.stabLen * 0.62;
    const le0: V3 = [sr.x + 2, sr.y, 0];
    const elev = 0.6;
    const pi = B.newPart({ pivot: add(le0, [-chord0 * elev, 0, 0]), axis: [0, 0, 1], sign: 1, offset: [0, 0, 0], kind: 'elevator' });
    B.part = 0;
    for (const side of [1, -1]) {
      const at = (fz: number): { le: V3; c: number } => ({ le: [le0[0] - t.stabLen * 0.38 * fz, sr.y - 1 * fz, side * stabSpan * fz], c: chord0 + (chord1 - chord0) * fz });
      const sec = (fz: number, x0: number, x1: number): V3[] => { const a = at(fz); return section(a.le, [-1, 0, 0], [0, -1, 0], a.c, 0.1, x0, x1, 0); };
      B.part = 0;
      const a0 = sec(0, 0, elev - 0.02), a1 = sec(1, 0, elev - 0.02);
      const up = Math.ceil(a0.length / 2);
      B.loft([a0, a1], (_s, k) => (k < up - 1 ? MAT.wingTop : MAT.wingBot), { capEnd: MAT.wingBot });
      B.part = pi;
      const e0 = sec(0, elev, 1), e1 = sec(1, elev, 1);
      const up2 = Math.ceil(e0.length / 2);
      B.loft([e0, e1], (_s, k) => (k < up2 - 1 ? MAT.wingTop : MAT.wingBot), { capEnd: MAT.wingBot });
    }
    // Which way is trailing-edge down for the elevator?
    const te = add(le0, [-chord0, 0, 0]);
    const piv = B.parts[pi].pivot;
    const rot = add(rotAxis(sub(te, piv), [0, 0, 1], Math.cos(0.3), Math.sin(0.3)), piv);
    B.parts[pi].sign = rot[1] > te[1] ? 1 : -1;
    name('elevator', pi);
    B.part = 0;
  }

  // ── Engines and propellers ─────────────────────────────────────────────
  const propAt = (hub: V3, r: number, blades: number): void => {
    const pi = B.newPart({ pivot: hub, axis: [1, 0, 0], sign: 1, offset: [0, 0, 0], kind: 'prop' });
    name('prop', pi);
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2;
      const dir: V3 = [0, Math.sin(a), Math.cos(a)];
      const side: V3 = [0, Math.cos(a), -Math.sin(a)];
      const p = (rr: number, cw: number, twist: number): V3 => add(add(hub, scl(dir, rr)), add(scl(side, cw), [twist, 0, 0]));
      const root0 = p(r * 0.12, r * 0.06, 0.6), root1 = p(r * 0.12, -r * 0.06, -0.6);
      const tip0 = p(r, r * 0.035, 1.2), tip1 = p(r, -r * 0.05, -0.4);
      const mid0 = p(r * 0.55, r * 0.09, 0.9), mid1 = p(r * 0.55, -r * 0.08, -0.6);
      const v = [root0, mid0, tip0, tip1, mid1, root1].map(q => B.v(q));
      B.quad(v[0], v[1], v[4], v[5], MAT.prop, 0);
      B.quad(v[1], v[2], v[3], v[4], MAT.prop, 0);
    }
    const dpi = B.newPart({ pivot: hub, axis: [1, 0, 0], sign: 1, offset: [0, 0, 0], kind: 'disc' });
    name('disc', dpi);
    const ring: number[] = [];
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      ring.push(B.v(add(hub, [0.3, Math.sin(a) * r, Math.cos(a) * r])));
    }
    const c = B.v(add(hub, [0.3, 0, 0]));
    for (let k = 0; k < 20; k++) B.tri(c, ring[k], ring[(k + 1) % 20], MAT.disc, 0);
    B.part = 0;
  };
  const blades = spec.prop.bladePairs * 2;
  if (noseEngine) {
    const hub: V3 = [-L / 2 + uEnd * L + 2.5, camber(1), 0];
    const sr = halfH(uEnd) * 0.42;
    B.revolve([[hub[0] - 2, sr], [hub[0] + 1, sr * 0.95], [hub[0] + 4, sr * 0.6], [hub[0] + 6.5, sr * 0.12]], hub[1], 0, 12, MAT.metal, 1, { capStart: MAT.metal });
    propAt(add(hub, [1.5, 0, 0]), spec.prop.r, blades);
  }
  const byStation = new Map<number, AircraftVisualSpec['engines'][number]>();
  for (const e of spec.engines) {
    const key = Math.round(e.frac * 100);
    if (!e.nose && !byStation.has(key)) byStation.set(key, e);
  }
  for (const [fr, e] of byStation) {
    const frac = fr / 100;
    const r = e.cowlH / 2;
    const wy = w.y - S * dihedral * frac;
    for (const side of [1, -1]) {
      const z = side * S * frac;
      const leAt = w.rootX + w.chord * 0.5 - w.sweep * 0.85 * frac;
      const front = leAt + e.cowlLen * 0.42, back = front - e.cowlLen;
      const cy = w.layout === 'high' ? wy + r * 0.75 : wy + r * 0.1;
      const turbo = spec.engineStyle === 'turboprop';
      B.revolve([
        [back, r * 0.25], [back + e.cowlLen * 0.2, r * 0.75], [back + e.cowlLen * 0.55, r], [front - 2, r * (turbo ? 0.86 : 1)], [front, r * (turbo ? 0.62 : 0.9)],
      ], cy, z, 14, MAT.hull, 1.05, { capStart: MAT.dark, capEnd: MAT.intake });
      const hub: V3 = [front + 1, cy, z];
      B.revolve([[front, r * 0.42], [front + 2.5, r * 0.36], [front + 5.5, r * 0.06]], cy, z, 10, MAT.metal, 1, { capStart: MAT.metal });
      propAt(add(hub, [2, 0, 0]), spec.prop.r, blades);
    }
  }

  // ── Undercarriage ──────────────────────────────────────────────────────
  const g = spec.gear;
  const wheelY = contactY - g.wheelR;
  const tundra = g.tyre === 'tundra';
  const tyreW = g.wheelR * (tundra ? 0.95 : 0.62);
  const track = g.tailWheelX !== null ? H * 1.05 : g.sponson ? H * 0.5 : H * 0.7;
  const mainAx = g.mainX + (g.rake ?? 0);
  const retract = !g.fixed;
  const sponson = !!g.sponson;
  if (g.sponson) {
    for (const side of [1, -1]) {
      const u = (g.sponson.x + L / 2) / L;
      B.ellipsoid([g.sponson.x, H / 2 - g.sponson.h * 0.35, side * halfH(u) * widthAt(u) * 0.86],
        g.sponson.w / 2, g.sponson.h / 2, H * 0.2, MAT.belly, false, 12, 5);
    }
  }
  for (const side of [1, -1]) {
    const hinge: V3 = [g.mainX, g.hingeY - 2, side * (sponson ? H * 0.42 : H * 0.28)];
    const axle: V3 = [mainAx, wheelY, side * track];
    const pi = retract
      ? B.newPart({ pivot: hinge, axis: [0, 0, 1], sign: 1, offset: [0, -(wheelY - g.hingeY) - g.wheelR * 0.6, 0], kind: sponson ? 'gearSlide' : 'gear' })
      : 0;
    if (retract) name('gear', pi);
    B.part = pi;
    B.beam(hinge, axle, tundra ? 1.6 : 2.2, MAT.strut);
    const n = g.mainWheels ?? 1;
    for (let i = 0; i < n; i++) {
      const dx = n > 1 ? (i - (n - 1) / 2) * g.wheelR * 2.15 : 0;
      B.wheel(add(axle, [dx, 0, 0]), g.wheelR, tyreW, side);
      if (g.mainDual) B.wheel(add(axle, [dx, 0, -side * (tyreW + 1)]), g.wheelR, tyreW, -side);
    }
    if (g.style === 'spatted') {
      // A teardrop fairing over the top of the wheel, the tyre showing below it
      B.ellipsoid(add(axle, [0.8, -g.wheelR * 0.42, 0]), g.wheelR * 1.45, g.wheelR * 0.7, tyreW * 0.78, MAT.belly, false, 12, 5);
    }
    B.part = 0;
    if (retract && !sponson) {
      // Fold the leg forward and up
      const test = add(rotAxis(sub(axle, hinge), [0, 0, 1], Math.cos(0.3), Math.sin(0.3)), hinge);
      B.parts[pi].sign = test[0] > axle[0] ? 1 : -1;
    }
  }
  if (g.noseX !== null) {
    const nr = g.noseWheelR ?? g.wheelR * 0.7;
    const hinge: V3 = [g.noseX, g.hingeY - 2, 0];
    const axle: V3 = [g.noseX + 2, contactY - nr, 0];
    const pi = retract ? B.newPart({ pivot: hinge, axis: [0, 0, 1], sign: 1, offset: [0, -(axle[1] - hinge[1]) - nr * 0.5, 0], kind: sponson ? 'gearSlide' : 'gear' }) : 0;
    if (retract) name('gear', pi);
    B.part = pi;
    B.beam(hinge, axle, 1.8, MAT.strut);
    if (g.noseDual) {
      B.wheel(add(axle, [0, 0, nr * 0.5]), nr, nr * 0.55, 1);
      B.wheel(add(axle, [0, 0, -nr * 0.5]), nr, nr * 0.55, -1);
    } else {
      B.wheel(axle, nr, nr * 0.62, 1);
    }
    B.part = 0;
    if (retract && !sponson) {
      const test = add(rotAxis(sub(axle, hinge), [0, 0, 1], Math.cos(0.3), Math.sin(0.3)), hinge);
      B.parts[pi].sign = test[0] > axle[0] ? 1 : -1;
    }
  }
  if (g.tailWheelX !== null) {
    const u = (g.tailWheelX + L / 2) / L;
    const belly = camber(u) + halfH(u);
    const tr = g.wheelR * 0.45;
    B.beam([g.tailWheelX + 4, belly - 1, 0], [g.tailWheelX, belly + tr * 1.5, 0], 1.1, MAT.strut);
    B.wheel([g.tailWheelX, belly + tr * 1.5, 0], tr, tr * 0.8, 1);
  }

  // ── Small things that make it real ─────────────────────────────────────
  {
    const u = 0.62;
    const top = camber(u) - halfH(u);
    B.beam([-L / 2 + u * L, top + 0.5, 0], [-L / 2 + u * L - 3, top - H * 0.32, 0], 0.7, MAT.dark);
  }

  // ── Normals: shared vertices average their faces, so skins read smooth ──
  const nv = B.vpart.length;
  const norms = new Float32Array(nv * 3);
  for (let i = 0; i < B.tris.length; i += 3) {
    const a = B.P(B.tris[i]), b = B.P(B.tris[i + 1]), c = B.P(B.tris[i + 2]);
    const n = cross(sub(c, a), sub(b, a));
    for (const v of [B.tris[i], B.tris[i + 1], B.tris[i + 2]]) {
      norms[v * 3] += n[0]; norms[v * 3 + 1] += n[1]; norms[v * 3 + 2] += n[2];
    }
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(norms[v * 3], norms[v * 3 + 1], norms[v * 3 + 2]) || 1;
    norms[v * 3] /= l; norms[v * 3 + 1] /= l; norms[v * 3 + 2] /= l;
  }

  const finTipX = -L / 2 + t.finSweep * 0.5;
  return {
    pos: new Float32Array(B.pos),
    vpart: new Int16Array(B.vpart),
    norms,
    tris: new Uint32Array(B.tris),
    tmat: new Uint8Array(B.tmat),
    tflag: new Uint8Array(B.tflag),
    parts: B.parts,
    mats,
    named,
    lights: {
      beacon: [finTipX, finTop - 1.5, 0],
      navL: [w.rootX + w.chord * 0.5 - w.sweep * 0.85 - 2, w.y - S * dihedral, -S - 0.5],
      navR: [w.rootX + w.chord * 0.5 - w.sweep * 0.85 - 2, w.y - S * dihedral, S + 0.5],
      land: [w.rootX + w.chord * 0.5 - w.sweep * 0.2, w.y + 1, S * 0.25],
    },
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** The camera looks down on the aeroplane a little, as the painter's does. */
const ELEVATION = 0.16;
const FOCAL = 760;

export class AircraftModel {
  readonly gfx: Phaser.GameObjects.Graphics;
  readonly lamps: Phaser.GameObjects.Graphics;
  private readonly d: ModelData;
  private readonly webgl: boolean;
  // Scratch buffers, allocated once
  private readonly mx: Float32Array; private readonly my: Float32Array; private readonly mz: Float32Array;
  private readonly nx: Float32Array; private readonly ny: Float32Array; private readonly nz: Float32Array;
  private readonly vz: Float32Array; private readonly px: Float32Array; private readonly py: Float32Array;
  private readonly lr: Float32Array; private readonly lg: Float32Array; private readonly lb: Float32Array;
  private readonly ndh: Float32Array; private readonly fres: Float32Array;
  private readonly keys: Float32Array;
  private readonly order: number[];

  constructor(scene: Phaser.Scene, spec: AircraftVisualSpec, contactY: number, detail: 'high' | 'low' = 'high') {
    this.d = buildAircraftModel(spec, contactY, detail);
    this.gfx = scene.add.graphics();
    this.lamps = scene.add.graphics().setBlendMode(Phaser.BlendModes.ADD);
    this.webgl = scene.sys.game.renderer.type === Phaser.WEBGL;
    const n = this.d.vpart.length;
    this.mx = new Float32Array(n); this.my = new Float32Array(n); this.mz = new Float32Array(n);
    this.nx = new Float32Array(n); this.ny = new Float32Array(n); this.nz = new Float32Array(n);
    this.vz = new Float32Array(n); this.px = new Float32Array(n); this.py = new Float32Array(n);
    this.lr = new Float32Array(n); this.lg = new Float32Array(n); this.lb = new Float32Array(n);
    this.ndh = new Float32Array(n); this.fres = new Float32Array(n);
    const nt = this.d.tris.length / 3;
    this.keys = new Float32Array(nt);
    this.order = [];
  }

  /** Triangle count, for budgeting. */
  get triangles(): number { return this.d.tris.length / 3; }

  setDepth(d: number): void {
    this.gfx.setDepth(d);
    this.lamps.setDepth(d + 0.01);
  }

  setVisible(v: boolean): void {
    this.gfx.setVisible(v);
    this.lamps.setVisible(v);
  }

  destroy(): void {
    this.gfx.destroy();
    this.lamps.destroy();
  }

  /**
   * Draw the model at a screen position. `rotation` is a screen-space roll of
   * the whole picture (a tumbling wreck); the attitude is in `pose`.
   */
  render(x: number, y: number, rotation: number, scale: number, alpha: number, pose: ModelPose, light: ModelLight): void {
    const d = this.d;
    const g = this.gfx;
    g.clear();
    this.lamps.clear();
    g.setPosition(x, y).setRotation(rotation).setScale(scale).setAlpha(alpha);
    this.lamps.setPosition(x, y).setRotation(rotation).setScale(scale).setAlpha(alpha);

    // ── Drive the moving parts ──
    const flapRad = (pose.flapDeg * Math.PI) / 180;
    for (let i = 1; i < d.parts.length; i++) {
      const p = d.parts[i];
      p.hidden = false;
      p.slide = 0;
      switch (p.kind) {
        case 'flap': p.angle = flapRad; break;
        case 'ail': p.angle = 0; break;
        case 'elevator': p.angle = -pose.elevator * 0.4; break;
        case 'rudder': p.angle = pose.rudder; break;
        case 'gear': p.angle = (1 - pose.gear) * 1.62; p.hidden = pose.gear < 0.04; break;
        case 'gearSlide': p.angle = 0; p.slide = 1 - pose.gear; p.hidden = pose.gear < 0.08; break;
        case 'prop': p.angle = pose.propAngle; p.hidden = pose.shed; break;
        case 'disc': p.angle = 0; p.hidden = pose.shed || pose.propSpeed < 0.25; break;
      }
    }
    for (const [k, list] of Object.entries(d.named)) {
      if (k.startsWith('ail')) {
        for (const pi of list) d.parts[pi].angle = (k.includes('R') ? 1 : -1) * pose.aileron;
      }
    }
    // Blades blur into the disc as the engine winds up
    const blur = Math.min(1, Math.max(0, (pose.propSpeed - 0.25) / 0.35));
    d.mats[MAT.prop].alpha = 1 - blur * 0.82;
    d.mats[MAT.disc].alpha = 0.06 + blur * 0.16;

    // Part transforms as 3×3 matrices (Rodrigues), so the vertex loop allocates nothing
    const pm: number[][] = d.parts.map(p => {
      const a = p.angle * p.sign, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
      const [x, y, z] = p.axis;
      return [
        t * x * x + c, t * x * y - s * z, t * x * z + s * y,
        t * x * y + s * z, t * y * y + c, t * y * z - s * x,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c,
      ];
    });
    // Rodrigues with k×v as written in rotAxis is the transpose of the usual
    // right-handed form; keep the two consistent by building the same rotation:
    for (let i = 1; i < pm.length; i++) {
      const m = pm[i];
      const probe = rotAxis([1, 0.3, -0.2], d.parts[i].axis, Math.cos(d.parts[i].angle * d.parts[i].sign), Math.sin(d.parts[i].angle * d.parts[i].sign));
      const mv = [m[0] + m[1] * 0.3 - m[2] * 0.2, m[3] + m[4] * 0.3 - m[5] * 0.2, m[6] + m[7] * 0.3 - m[8] * 0.2];
      if (Math.abs(mv[0] - probe[0]) + Math.abs(mv[1] - probe[1]) + Math.abs(mv[2] - probe[2]) > 1e-4) {
        // transpose
        pm[i] = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
      }
    }

    // ── Pose ──
    const cyw = Math.cos(pose.yaw), syw = Math.sin(pose.yaw);
    const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const ce = Math.cos(ELEVATION), se = Math.sin(ELEVATION);
    const xf = (x0: number, y0: number, z0: number): V3 => {
      const y1 = y0 * cr - z0 * sr, z1 = y0 * sr + z0 * cr;
      const x2 = x0 * cp + y1 * sp, y2 = -x0 * sp + y1 * cp;
      const x3 = x2 * cyw + z1 * syw, z3 = -x2 * syw + z1 * cyw;
      return [x3, y2 * ce + z3 * se, -y2 * se + z3 * ce];
    };

    // ── Light, in view space ──
    const L = norm([-0.5, -0.72, 0.5]);
    const Hh = norm([L[0], L[1], L[2] + 1]);
    const day = 0.3 + 0.7 * light.daylight;
    const sun = light.sun, sky = light.sky, grd = light.ground;
    const sR = ((sun >> 16) & 255) / 255 * day, sG = ((sun >> 8) & 255) / 255 * day, sB = (sun & 255) / 255 * day;
    const kR = ((sky >> 16) & 255) / 255, kG = ((sky >> 8) & 255) / 255, kB = (sky & 255) / 255;
    const gR = ((grd >> 16) & 255) / 255, gG = ((grd >> 8) & 255) / 255, gB = (grd & 255) / 255;
    const amb = 0.42 + 0.18 * light.daylight;

    const n = d.vpart.length;
    const P = d.pos, N = d.norms;
    for (let i = 0; i < n; i++) {
      let x0 = P[i * 3], y0 = P[i * 3 + 1], z0 = P[i * 3 + 2];
      let n0 = N[i * 3], n1 = N[i * 3 + 1], n2 = N[i * 3 + 2];
      const pi = d.vpart[i];
      if (pi > 0) {
        const p = d.parts[pi];
        const m = pm[pi];
        const dx = x0 - p.pivot[0], dy = y0 - p.pivot[1], dz = z0 - p.pivot[2];
        x0 = m[0] * dx + m[1] * dy + m[2] * dz + p.pivot[0] + p.offset[0] * p.slide;
        y0 = m[3] * dx + m[4] * dy + m[5] * dz + p.pivot[1] + p.offset[1] * p.slide;
        z0 = m[6] * dx + m[7] * dy + m[8] * dz + p.pivot[2] + p.offset[2] * p.slide;
        const a0 = m[0] * n0 + m[1] * n1 + m[2] * n2;
        const a1 = m[3] * n0 + m[4] * n1 + m[5] * n2;
        const a2 = m[6] * n0 + m[7] * n1 + m[8] * n2;
        n0 = a0; n1 = a1; n2 = a2;
      }
      // roll → pitch → yaw → camera elevation, for the point…
      let y1 = y0 * cr - z0 * sr, z1 = y0 * sr + z0 * cr;
      let x2 = x0 * cp + y1 * sp, y2 = -x0 * sp + y1 * cp;
      let x3 = x2 * cyw + z1 * syw, z3 = -x2 * syw + z1 * cyw;
      const vx = x3, vy = y2 * ce + z3 * se, vz = -y2 * se + z3 * ce;
      this.mx[i] = vx; this.my[i] = vy; this.mz[i] = vz;
      const k = FOCAL / (FOCAL - vz);
      this.px[i] = vx * k; this.py[i] = vy * k; this.vz[i] = vz;
      // …and for its normal
      y1 = n1 * cr - n2 * sr; z1 = n1 * sr + n2 * cr;
      x2 = n0 * cp + y1 * sp; y2 = -n0 * sp + y1 * cp;
      x3 = x2 * cyw + z1 * syw; z3 = -x2 * syw + z1 * cyw;
      const qx = x3, qy = y2 * ce + z3 * se, qz = -y2 * se + z3 * ce;
      this.nx[i] = qx; this.ny[i] = qy; this.nz[i] = qz;
      // Wrapped diffuse from the sun, a sky/ground hemisphere, a glint, a rim
      const ndl = qx * L[0] + qy * L[1] + qz * L[2];
      const diff = Math.max(0, (ndl + 0.2) / 1.2);
      const hemi = 0.5 - qy * 0.5;   // 1 facing up, 0 facing down
      this.lr[i] = amb * (gR + (kR - gR) * hemi) + diff * sR * 0.95;
      this.lg[i] = amb * (gG + (kG - gG) * hemi) + diff * sG * 0.95;
      this.lb[i] = amb * (gB + (kB - gB) * hemi) + diff * sB * 0.95;
      this.ndh[i] = Math.max(0, qx * Hh[0] + qy * Hh[1] + qz * Hh[2]);
      const facing = Math.max(0, qz);
      this.fres[i] = (1 - facing) * (1 - facing) * (1 - facing);
    }

    // ── Faces: cull, key, sort ──
    const order = this.order;
    order.length = 0;
    const nt = d.tris.length / 3;
    for (let t = 0; t < nt; t++) {
      const a = d.tris[t * 3], b = d.tris[t * 3 + 1], c = d.tris[t * 3 + 2];
      const pa = d.vpart[a];
      if (pa > 0 && d.parts[pa].hidden) continue;
      const mat = d.mats[d.tmat[t]];
      if (mat.alpha <= 0.01) continue;
      const flags = d.tflag[t];
      if (flags & 1) {
        // Outward normal is w × u in this left-handed frame
        const ux = this.mx[b] - this.mx[a], uy = this.my[b] - this.my[a];
        const wx = this.mx[c] - this.mx[a], wy = this.my[c] - this.my[a];
        if (wx * uy - wy * ux < 0) continue;
      }
      this.keys[t] = (this.vz[a] + this.vz[b] + this.vz[c]) / 3 + (flags & 2 ? 1.2 : 0);
      order.push(t);
    }
    const keys = this.keys;
    order.sort((p, q) => keys[p] - keys[q]);

    const hz = light.haze;
    const hR = (light.hazeColor >> 16) & 255, hG = (light.hazeColor >> 8) & 255, hB = light.hazeColor & 255;
    const colorAt = (v: number, mat: Material, cR: number, cG: number, cB: number): number => {
      let r: number, gg: number, b: number;
      if (mat.flat) { r = cR * 0.8; gg = cG * 0.8; b = cB * 0.8; } else {
        const spec = Math.pow(this.ndh[v], mat.shine) * mat.spec * 255 * day;
        const rim = this.fres[v] * 0.22 * 255;
        r = cR * this.lr[v] + spec * sR + rim * kR;
        gg = cG * this.lg[v] + spec * sG + rim * kG;
        b = cB * this.lb[v] + spec * sB + rim * kB;
      }
      if (hz > 0) { r += (hR - r) * hz; gg += (hG - gg) * hz; b += (hB - b) * hz; }
      return (Math.min(255, Math.max(0, r)) << 16) | (Math.min(255, Math.max(0, gg)) << 8) | Math.min(255, Math.max(0, b));
    };

    const iceTint = pose.ice;
    for (const t of order) {
      const a = d.tris[t * 3], b = d.tris[t * 3 + 1], c = d.tris[t * 3 + 2];
      const mi = d.tmat[t];
      const mat = d.mats[mi];
      let col = mat.color;
      // Damage scorches the skin; ice frosts the wings
      if (pose.damage >= 2 && (mi === MAT.hull || mi === MAT.top || mi === MAT.belly || mi === MAT.wingTop)) {
        const h = hash(t * 1.7);
        if (h < 0.05 * pose.damage) col = mixC(col, 0x14100c, 0.55 + h * 4);
      }
      if (iceTint > 0.05 && (mi === MAT.wingTop || mi === MAT.wingBot)) col = mixC(col, 0xe8f0f4, iceTint * 0.55);
      const cR = (col >> 16) & 255, cG = (col >> 8) & 255, cB = col & 255;
      const ca = colorAt(a, mat, cR, cG, cB), cb = colorAt(b, mat, cR, cG, cB), cc = colorAt(c, mat, cR, cG, cB);
      if (this.webgl) {
        g.fillGradientStyle(ca, cb, cc, cc, mat.alpha, mat.alpha, mat.alpha, mat.alpha);
      } else {
        g.fillStyle(ca, mat.alpha);
      }
      g.fillTriangle(this.px[a], this.py[a], this.px[b], this.py[b], this.px[c], this.py[c]);
    }

    // ── Lamps: beacon, wingtip navigation lights, landing light ──
    const lamp = (p: V3, color: number, r: number, a: number): void => {
      const v = xf(p[0], p[1], p[2]);
      const k = FOCAL / (FOCAL - v[2]);
      this.lamps.fillStyle(color, a * 0.35);
      this.lamps.fillCircle(v[0] * k, v[1] * k, r * 2.6);
      this.lamps.fillStyle(color, a);
      this.lamps.fillCircle(v[0] * k, v[1] * k, r);
    };
    const night = 1 - light.daylight;
    if (pose.beacon > 0.01) lamp(d.lights.beacon, 0xff3020, 1.6, pose.beacon);
    lamp(d.lights.navL, 0xff2a20, 1.1, 0.35 + night * 0.6);
    lamp(d.lights.navR, 0x30ff70, 1.1, 0.35 + night * 0.6);
    if (pose.landingLight) lamp(d.lights.land, 0xfff2d0, 1.4, 0.4 + night * 0.6);
  }
}
