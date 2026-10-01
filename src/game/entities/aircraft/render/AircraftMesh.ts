import Phaser from 'phaser';
import { stabRoot, type AircraftVisualSpec } from './AircraftVisualSpec';

/**
 * The aeroplane as a solid, for the moments a side view cannot show.
 *
 * Every airframe is drawn as a flat side-on picture, which is right for a
 * side-scroller right up until it has to turn round. Flipping a picture reads
 * as exactly that — a paper cut-out spun on a pin — and crossfading to a
 * separate tail-on drawing only moved the seam. So each aircraft also has a
 * low-poly 3D model, lofted from the same numbers the painter draws the side
 * view from: the fuselage profile (tail cone, cabin, nose), the wing layout,
 * the fin and tailplane, the nacelles, the gear. During a turn the model is
 * rotated, banked and lit, and you see what a real 180 looks like: the wings
 * swinging round, the fuselage shortening as the nose goes away from you, the
 * far wing dropping into the turn, the tail coming round.
 *
 * Deliberately plain — flat-shaded facets, no textures. It is on screen for a
 * few seconds at a time and has to read as the SAME aeroplane as the detailed
 * side view either side of it, which a busier model would not.
 *
 * Coordinates are design units in the painter's own frame: x forward (nose
 * +x), y DOWN, z toward the camera. The side the camera sees at yaw 0 is +z.
 */

type V3 = [number, number, number];

interface Face {
  v: number[];            // vertex indices
  color: number;
  alpha: number;
  /** Closed-surface facets are culled when facing away; thin plates are not. */
  twoSided: boolean;
  /** Only drawn while the gear is down. */
  gear?: boolean;
}

export interface AircraftMesh {
  verts: V3[];
  faces: Face[];
}

function mix(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * u) << 16) | (Math.round(ag + (bg - ag) * u) << 8) | Math.round(ab + (bb - ab) * u);
}

/** Real wingspan as a fraction of length — a side view never shows it. */
function spanRatio(spec: AircraftVisualSpec): number {
  if (spec.wing.layout === 'biplane') return 1.3;
  return spec.engines.some(e => !e.nose) ? (spec.engines.length > 2 ? 1.3 : 1.05) : 1.35;
}

export function buildAircraftMesh(spec: AircraftVisualSpec, contactY: number): AircraftMesh {
  const verts: V3[] = [];
  const faces: Face[] = [];
  const pal = spec.palette;
  const L = spec.length, H = spec.height;
  const f = spec.fuselage;
  const add = (p: V3): number => { verts.push(p); return verts.length - 1; };
  const quad = (a: number, b: number, c: number, d: number, color: number, twoSided = false, gear = false): void => {
    faces.push({ v: [a, b, c, d], color, alpha: 1, twoSided, gear });
  };
  const strutColor = mix(pal.metal, 0x000000, 0.3);

  // ── Fuselage: the painter's own profile, lofted into rings ──────────────
  const kNose = (1 - f.noseFull * f.noseFull) / 0.907;
  const halfH = (u: number): number => {
    const s0 = u < f.taperStart
      ? f.tailDepth + (1 - f.tailDepth) * Math.pow(u / f.taperStart, 0.7)
      : u < 0.70 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.70) / 0.315, 2) * kNose));
    return (H / 2) * s0;
  };
  const camber = (u: number): number =>
    -H * f.upsweep * Math.max(0, (f.taperStart + 0.08 - u) / (f.taperStart + 0.08));
  const stations = [0, 0.04, 0.1, 0.18, 0.26, 0.36, 0.46, 0.56, 0.66, 0.74, 0.82, 0.89, 0.95, 0.985];
  const RING = 12;
  const rings: number[][] = [];
  const canopyU0 = (spec.canopy.x - spec.canopy.w * 0.2 + L / 2) / L;
  const canopyU1 = (spec.canopy.x + spec.canopy.w + L / 2) / L;
  // Narrower than it is deep, and squarer the more freight it carries
  const widthK = 0.74 + f.bellyFlat * 0.12;
  for (const u of stations) {
    const x = -L / 2 + u * L;
    const hh = Math.max(0.6, halfH(u));
    const yc = camber(u);
    const ring: number[] = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      let sy = Math.sin(a);
      let cz = Math.cos(a);
      // A freight floor squares the lower half off
      if (sy > 0 && f.bellyFlat > 0) {
        sy = Math.pow(sy, 1 - f.bellyFlat * 0.6);
        cz = Math.sign(cz) * Math.pow(Math.abs(cz), 1 - f.bellyFlat * 0.5);
      }
      ring.push(add([x, yc + hh * sy, hh * widthK * cz]));
    }
    rings.push(ring);
  }
  for (let s = 0; s + 1 < rings.length; s++) {
    const uMid = (stations[s] + stations[s + 1]) / 2;
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      const sMid = Math.sin(((k + 0.5) / RING) * Math.PI * 2);
      let color = sMid > 0.45 ? pal.hullShade : sMid < -0.6 ? pal.hullLight : pal.hull;
      // Glass over the cockpit; a trim stripe down each side of the cabin
      if (sMid < -0.3 && uMid > canopyU0 && uMid < canopyU1) color = pal.canopy;
      else if (Math.abs(sMid) < 0.3 && sMid < 0 && uMid > 0.22 && uMid < 0.68) color = pal.accent;
      quad(rings[s][k], rings[s][k2], rings[s + 1][k2], rings[s + 1][k], color);
    }
  }
  // Nose cap — the cowl on a single, the radome on a transport
  const noseTip = add([L / 2, camber(1), 0]);
  const last = rings[rings.length - 1];
  const noseColor = spec.engines.some(e => e.nose) ? mix(pal.metal, pal.hullShade, 0.45) : pal.hullShade;
  for (let k = 0; k < RING; k++) faces.push({ v: [last[k], last[(k + 1) % RING], noseTip], color: noseColor, alpha: 1, twoSided: false });
  const tailTip = add([-L / 2 - 1, camber(0), 0]);
  for (let k = 0; k < RING; k++) faces.push({ v: [rings[0][(k + 1) % RING], rings[0][k], tailTip], color: pal.hullShade, alpha: 1, twoSided: false });

  // ── A lifting surface: split spanwise so depth sorting stays honest ──────
  const surface = (
    rootLE: V3, rootTE: V3, tipLE: V3, tipTE: V3, tRoot: number, tTip: number,
    top: number, bottom: number, segs: number,
  ): void => {
    const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const edge = mix(top, 0xffffff, 0.1);
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const th0 = tRoot + (tTip - tRoot) * t0, th1 = tRoot + (tTip - tRoot) * t1;
      const le0 = lerp(rootLE, tipLE, t0), le1 = lerp(rootLE, tipLE, t1);
      const te0 = lerp(rootTE, tipTE, t0), te1 = lerp(rootTE, tipTE, t1);
      const a = add([le0[0], le0[1] - th0 / 2, le0[2]]), b = add([le1[0], le1[1] - th1 / 2, le1[2]]);
      const c = add([te1[0], te1[1] - th1 / 3, te1[2]]), d = add([te0[0], te0[1] - th0 / 3, te0[2]]);
      const e = add([le0[0], le0[1] + th0 / 2, le0[2]]), g = add([le1[0], le1[1] + th1 / 2, le1[2]]);
      const h = add([te1[0], te1[1] + th1 / 3, te1[2]]), j = add([te0[0], te0[1] + th0 / 3, te0[2]]);
      quad(a, b, c, d, top, true);
      quad(e, j, h, g, bottom, true);
      quad(a, e, g, b, edge, true);
      quad(d, c, h, j, bottom, true);
      if (i === segs - 1) quad(b, g, h, c, bottom, true);
    }
  };

  // ── Wings ────────────────────────────────────────────────────────────────
  const w = spec.wing;
  const S = (L * spanRatio(spec)) / 2;
  const upperY = -H / 2 - 14;   // the painter's biplane upper plane
  const wingYs = w.layout === 'biplane' ? [upperY, w.y] : [w.y];
  const tRoot = Math.max(3, w.chord * 0.1);
  const dihedral = w.layout === 'low' ? 0.07 : w.layout === 'biplane' ? 0.04 : 0.02;
  const wingTipY = (wy: number): number => wy - S * dihedral;
  for (const wy of wingYs) {
    const le = w.rootX + w.chord * 0.5, te = w.rootX - w.chord * 0.5;
    const tipChord = w.chord * (w.layout === 'biplane' ? 0.92 : 0.62);
    const tipLE = le - w.sweep, tipTE = tipLE - tipChord;
    for (const side of [1, -1]) {
      surface([le, wy, 0], [te, wy, 0], [tipLE, wingTipY(wy), side * S], [tipTE, wingTipY(wy), side * S],
        tRoot, tRoot * 0.55, pal.hullLight, pal.hullShade, 3);
    }
  }
  const post = (x: number, y0: number, z0: number, y1: number, z1: number, wdt = 1.6): void => {
    const a = add([x + wdt, y0, z0]), b = add([x - wdt, y0, z0]);
    const c = add([x - wdt, y1, z1]), d = add([x + wdt, y1, z1]);
    quad(a, b, c, d, strutColor, true);
  };
  // Biplane: interplane struts, and the cabane struts holding the top wing up
  if (w.layout === 'biplane') {
    for (const side of [1, -1]) {
      const z = side * S * 0.66, x = w.rootX - w.sweep * 0.66;
      post(x, upperY - S * dihedral * 0.66, z, w.y - S * dihedral * 0.66, z, 2);
      post(w.rootX, upperY, side * 5, -H * 0.45, side * H * 0.3);
    }
  }
  // Braced high wing: a lift strut each side down to the fuselage
  if (w.layout === 'high' && !spec.engines.some(e => !e.nose)) {
    for (const side of [1, -1]) post(w.rootX, w.y + 2, side * S * 0.48, H * 0.3, side * H * 0.34, 1.4);
  }

  // ── Tailplane and fin ────────────────────────────────────────────────────
  const t = spec.tail;
  const finTop = -H / 2 - t.finHeight;
  const sr = stabRoot(spec);
  const sLE = sr.x + 2, sTE = sr.x - t.stabLen;
  const stabSpan = S * (t.tTail ? 0.3 : 0.34);
  for (const side of [1, -1]) {
    surface([sLE, sr.y, 0], [sTE, sr.y, 0], [sLE - t.stabLen * 0.38, sr.y - 1, side * stabSpan],
      [sTE + 3, sr.y - 1, side * stabSpan], 2.4, 1.4, pal.hullLight, pal.hullShade, 2);
  }
  {
    const th = 1.1;
    const pts: V3[] = [[-L * 0.33, -H * 0.42, 0], [-L / 2 + t.finSweep, finTop, 0], [-L / 2, finTop, 0], [-L / 2 + 1, -H * 0.08, 0]];
    const near = pts.map(p => add([p[0], p[1], th])), far = pts.map(p => add([p[0], p[1], -th]));
    quad(near[0], near[1], near[2], near[3], pal.hull, true);
    quad(far[3], far[2], far[1], far[0], pal.hull, true);
    quad(near[0], near[1], far[1], far[0], pal.hullLight, true);
    quad(near[1], near[2], far[2], far[1], pal.hullLight, true);
    quad(near[2], near[3], far[3], far[2], pal.hullShade, true);
    // Tail band near the top, on both faces
    const band = (z: number): void => {
      const y0 = finTop + 3, y1 = -H / 2 - t.finHeight * 0.55;
      // Leading edge of the fin at height y, so the band follows its sweep
      const xAt = (y: number): number => -L * 0.33 + (-L / 2 + t.finSweep + L * 0.33) * ((y + H * 0.42) / (finTop + H * 0.42));
      quad(add([xAt(y0) - 1, y0, z]), add([-L / 2 + 0.5, y0, z]), add([-L / 2 + 0.5, y1, z]), add([xAt(y1) - 1, y1, z]), pal.accent, true);
    };
    band(th + 0.25);
    band(-th - 0.25);
  }

  // ── Engines: nacelles on the wing, every propeller a spinning disc ───────
  const disc = (cx: number, cy: number, cz: number, r: number): void => {
    const idx: number[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      idx.push(add([cx, cy + Math.sin(a) * r, cz + Math.cos(a) * r]));
    }
    faces.push({ v: idx, color: 0xd0d6dc, alpha: 0.2, twoSided: true });
  };
  const byStation = new Map<number, AircraftVisualSpec['engines'][number]>();
  for (const e of spec.engines) {
    const key = Math.round(e.frac * 100);
    if (!e.nose && !byStation.has(key)) byStation.set(key, e);
  }
  const nacelleColor = mix(pal.hull, pal.hullShade, 0.25);
  for (const [fr, e] of byStation) {
    const r = e.cowlH / 2;
    const frac = fr / 100;
    const wy = wingYs[0] + (wingTipY(wingYs[0]) - wingYs[0]) * frac;
    for (const side of [1, -1]) {
      const z = side * S * frac;
      const leAt = w.rootX + w.chord * 0.5 - w.sweep * frac;
      const front = leAt + e.cowlLen * 0.4, back = front - e.cowlLen;
      // Slung under a high wing, carried on the chord line of a low one
      const cy = w.layout === 'high' ? wy + r * 0.7 : wy;
      const ringAt = (x: number, rr: number): number[] => {
        const out: number[] = [];
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          out.push(add([x, cy + Math.sin(a) * rr, z + Math.cos(a) * rr * 0.9]));
        }
        return out;
      };
      const r0 = ringAt(front, r * 0.8), r1 = ringAt(front - e.cowlLen * 0.28, r), r2 = ringAt(back, r * 0.5);
      for (const [ra, rb] of [[r0, r1], [r1, r2]] as Array<[number[], number[]]>) {
        for (let k = 0; k < 8; k++) quad(ra[(k + 1) % 8], ra[k], rb[k], rb[(k + 1) % 8], nacelleColor);
      }
      faces.push({ v: [...r0], color: 0x1c1a17, alpha: 1, twoSided: false });
      faces.push({ v: [...r2].reverse(), color: 0x2a2621, alpha: 1, twoSided: false });
      disc(front + 1.5, cy, z, spec.prop.r);
    }
  }
  if (spec.engines.some(e => e.nose)) disc(L / 2 + 2, camber(1), 0, spec.prop.r);

  // ── Gear, drawn only while it is down ────────────────────────────────────
  const g = spec.gear;
  const wheel = (x: number, cy: number, z: number, r: number, wdt: number): void => {
    const N = 10;
    const a: number[] = [], b: number[] = [];
    for (let k = 0; k < N; k++) {
      const ang = (k / N) * Math.PI * 2;
      a.push(add([x + Math.cos(ang) * r, cy + Math.sin(ang) * r, z + wdt / 2]));
      b.push(add([x + Math.cos(ang) * r, cy + Math.sin(ang) * r, z - wdt / 2]));
    }
    faces.push({ v: a, color: 0x2a2724, alpha: 1, twoSided: true, gear: true });
    faces.push({ v: [...b].reverse(), color: 0x2a2724, alpha: 1, twoSided: true, gear: true });
    for (let k = 0; k < N; k++) quad(a[k], a[(k + 1) % N], b[(k + 1) % N], b[k], 0x171513, true, true);
  };
  const leg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    const a = add([x0 + 1.3, y0, z0]), b = add([x0 - 1.3, y0, z0]), c = add([x1 - 1.3, y1, z1]), d = add([x1 + 1.3, y1, z1]);
    quad(a, b, c, d, strutColor, true, true);
  };
  const tundra = g.tyre === 'tundra';
  const tyreW = g.wheelR * (tundra ? 0.95 : 0.6);
  // Taildraggers splay their legs wide; tricycle transports keep a narrow track
  const track = g.tailWheelX !== null ? H * 1.05 : g.sponson ? H * 0.55 : H * 0.7;
  const wheelY = contactY - g.wheelR;
  const mainAx = g.mainX + (g.rake ?? 0);
  for (const side of [1, -1]) {
    leg(g.mainX, g.hingeY - 2, side * H * 0.28, mainAx, wheelY, side * track);
    const n = g.mainWheels ?? 1;
    for (let i = 0; i < n; i++) {
      const dx = n > 1 ? (i - (n - 1) / 2) * g.wheelR * 2.1 : 0;
      wheel(mainAx + dx, wheelY, side * track, g.wheelR, tyreW);
      if (g.mainDual) wheel(mainAx + dx, wheelY, side * (track + tyreW + 1), g.wheelR, tyreW);
    }
  }
  if (g.noseX !== null) {
    const nr = g.noseWheelR ?? g.wheelR * 0.7;
    leg(g.noseX, g.hingeY - 2, 0, g.noseX + 2, contactY - nr, 0);
    if (g.noseDual) {
      wheel(g.noseX + 2, contactY - nr, nr * 0.45, nr, nr * 0.55);
      wheel(g.noseX + 2, contactY - nr, -nr * 0.45, nr, nr * 0.55);
    } else {
      wheel(g.noseX + 2, contactY - nr, 0, nr, nr * 0.6);
    }
  }
  if (g.tailWheelX !== null) {
    const tr = g.wheelR * 0.45;
    const u = (g.tailWheelX + L / 2) / L;
    const belly = camber(u) + halfH(u);
    leg(g.tailWheelX + 3, belly - 1, 0, g.tailWheelX, belly + tr * 1.6, 0);
    wheel(g.tailWheelX, belly + tr * 1.6, 0, tr, tr * 0.8);
  }

  return { verts, faces };
}

export interface MeshPose {
  /** 0 = nose right (the side view), π = nose left, π/2 = nose away from the camera. */
  yaw: number;
  /** Bank about the body axis; positive drops the wing on the −z side. */
  roll: number;
  /** Nose up, radians. */
  pitch: number;
  gearDown: boolean;
}

/** The camera looks down on the aeroplane a little, as the painter's does. */
const ELEVATION = 0.17;
const FOCAL = 720;
/** Toward the light: above, slightly toward the camera, from ahead-left. */
const LIGHT: V3 = (() => {
  const v: V3 = [-0.28, -0.82, 0.5];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
})();

/**
 * Draw the model into `gfx`, centred on its datum. Painter's algorithm over
 * flat-lit facets, with a touch of perspective so the near wing reads nearer.
 */
export function renderAircraftMesh(gfx: Phaser.GameObjects.Graphics, mesh: AircraftMesh, o: MeshPose): void {
  gfx.clear();
  const cy = Math.cos(o.yaw), sy = Math.sin(o.yaw);
  const cr = Math.cos(o.roll), sr = Math.sin(o.roll);
  const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
  const ce = Math.cos(ELEVATION), se = Math.sin(ELEVATION);
  const n = mesh.verts.length;
  const vx = new Float32Array(n), vy = new Float32Array(n), vz = new Float32Array(n);
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = mesh.verts[i];
    // Roll about the body x axis, then pitch, then yaw about the vertical.
    // Yaw π/2 sends the nose (+x) to −z: away from the camera.
    const y1 = y * cr - z * sr, z1 = y * sr + z * cr;
    const x2 = x * cp + y1 * sp, y2 = -x * sp + y1 * cp;
    const x3 = x2 * cy + z1 * sy, z3 = -x2 * sy + z1 * cy;
    // Camera elevation: the top turns toward the camera, near things sit lower
    const y4 = y2 * ce + z3 * se;
    const z4 = -y2 * se + z3 * ce;
    vx[i] = x3; vy[i] = y4; vz[i] = z4;
    const k = FOCAL / (FOCAL - z4);
    px[i] = x3 * k;
    py[i] = y4 * k;
  }
  const drawn: Array<{ z: number; f: Face; shade: number }> = [];
  for (const f of mesh.faces) {
    if (f.gear && !o.gearDown) continue;
    const a = f.v[0], b = f.v[1], c = f.v[2];
    const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
    const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
    // The frame is left-handed (y down), so the outward normal is w × u
    let nx = wy * uz - wz * uy, ny = wz * ux - wx * uz, nz = wx * uy - wy * ux;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) continue;
    nx /= len; ny /= len; nz /= len;
    if (!f.twoSided && nz < -0.02) continue;          // closed surface facing away
    if (f.twoSided && nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    let zsum = 0;
    for (const i of f.v) zsum += vz[i];
    drawn.push({ z: zsum / f.v.length, f, shade: 0.5 + 0.62 * lit });
  }
  drawn.sort((p, q) => p.z - q.z);
  const pts: Phaser.Types.Math.Vector2Like[] = [];
  for (const d of drawn) {
    pts.length = 0;
    for (const i of d.f.v) pts.push({ x: px[i], y: py[i] });
    const color = d.shade >= 1 ? mix(d.f.color, 0xffffff, (d.shade - 1) * 0.6) : mix(0x000000, d.f.color, d.shade);
    gfx.fillStyle(color, d.f.alpha);
    gfx.fillPoints(pts, true);
    if (d.f.alpha >= 1) {
      gfx.lineStyle(0.6, color, 1);   // seals the hairline gaps between facets
      gfx.strokePoints(pts, true);
    }
  }
}
