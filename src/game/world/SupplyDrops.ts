import Phaser from 'phaser';
import { drawFighter, type FighterPalette } from './Figures';
import { drawUndead, undeadKindFor, type CrowdStyle } from './Crowds';
import { DROP_RUN_BEFORE_PX, DROP_RUN_AFTER_PX, DROP_BAND_RUN_PX, GUN_REACH_PX, type Town } from './Towns';
import type { Hazard } from './Hazards';
import { depthOffset, extrude, extrudeBox } from './Depth';

/**
 * Something to DO in the cruise.
 *
 * Every earlier attempt at fixing the empty middle of a flight added
 * CONSEQUENCE — a fuel projection that drifts, an engine that runs hot up
 * high — and none of it added ACTIVITY. Once you were clear of the guns there
 * was still nothing to press and nothing to aim at between the climb-out and
 * the approach.
 *
 * People are scattered along every route: a camp in the open, a crowd in a
 * town square, a family holding out on a roof with the dead in the street
 * below. They call you on the radio well before you get there — early enough
 * to plan a descent — and put up a flare as you close. Put crates on them and
 * it pays. Three things make it worth doing rather than decoration:
 *
 *   1. It is optional. Fly past and nothing bad happens; you just did not help.
 *   2. It pulls AGAINST the safe altitude. A crate dropped from 300 m lands
 *      nowhere near anyone; to hit you have to come down among the roofs,
 *      the wires and the guns. "Climb and wait" finally has a cost.
 *   3. It is learnable. A reticle shows where a crate released RIGHT NOW would
 *      land, using exactly the same physics as the real drop, and a green
 *      band shows the height to do it from.
 */

export type DropResult = 'bullseye' | 'good' | 'close' | 'miss';

/**
 * Where the people are, which decides how you have to fly it.
 *
 *   camp     open ground, nothing around it. The easy one.
 *   square   the middle of a town — roofs, a tower block, wires across the
 *            street at eight metres. They need several crates.
 *   rooftop  holed up on a flat roof with the dead below. The crate has to
 *            land ON the roof; one in the street is one they cannot reach.
 */
export type SiteKind = 'camp' | 'square' | 'rooftop';

export interface DropSite {
  /** Where the crates should land, world px. */
  x: number;
  seed: number;
  people: number;
  kind: SiteKind;
  /** Town name, or a description of the camp — what the radio calls it. */
  place: string;
  /** Height of what they are standing on: 0 for the ground, the roof otherwise. */
  surfaceM: number;
  /** The roof itself, for a rooftop — a crate only counts if it lands on it. */
  roof: { x: number; halfWidth: number } | null;
  /** Inside raider-held ground: pays more, and you will be shot at. */
  besieged: boolean;
  /** Crates they need, and crates they have had. */
  need: number;
  got: number;
  /**
   * The drop window, metres: high enough to clear everything around the site,
   * low enough that the gusts do not carry the crate off it. This is the
   * answer to "when do I bring it down, and to what?".
   */
  bandLo: number;
  bandHi: number;
  state: 'waiting' | 'inbound' | 'signalled' | 'served';
  /** Seconds since the first call; -1 before. */
  inboundT: number;
  /** Seconds since the flare went up; -1 before. */
  flareT: number;
  /** Best crate so far. */
  result: DropResult | null;
  /** Seconds since the last crate landed on them, for the marker. */
  resultT: number;
  earned: number;
  /** People out fetching crates that landed near them. */
  fetches: Fetch[];
}

export interface Crate {
  wx: number;
  alt: number;
  vx: number;    // world px / s
  vAlt: number;  // m / s, up positive
  /** Sideways push from gusts, world px / s. Unknowable at release. */
  drift: number;
  spin: number;
  age: number;
  landed: boolean;
  /** Seconds since touchdown, for the dust puff. */
  landedT: number;
  /** The roof it came to rest on, if any. */
  onRoofX: number | null;
  /** Somebody has carried it off — stop drawing it on the ground. */
  taken?: boolean;
}

/** Somebody running out to a crate and carrying it back. */
interface Fetch {
  crate: Crate;
  from: number;
  t: number;
  run: number;
  seed: number;
}

export interface CrateLanding {
  site: DropSite | null;
  result: DropResult;
  distM: number;
  money: number;
  rep: number;
  /** It landed near them but where they cannot get to it — a street full of the dead. */
  unreachable?: boolean;
}

/** What happened this frame, for FlightScene to act on. */
export interface DropEvents {
  /** First radio call, well out — time to plan the descent. */
  inbound: DropSite | null;
  /** Flare up, close in. */
  signalled: DropSite | null;
  landed: CrateLanding[];
  /** Sites that just got everything they asked for, with the bonus paid. */
  completed: Array<{ site: DropSite; bonus: number }>;
}

/**
 * The drop window to fly into, and — while descending or climbing to it —
 * the path from the aircraft to where the band begins, in world coordinates.
 */
export interface DropGuide {
  lo: number;
  hi: number;
  fade: number;
  path?: { x0: number; alt0: number; x1: number; alt1: number } | null;
  /** Which way the aircraft is flying, so the band runs ahead of it. */
  dir?: 1 | -1;
}

/** What the drops need to know about the route they are laid along. */
export interface DropWorld {
  towns: ReadonlyArray<Town>;
  zones: ReadonlyArray<[number, number]>;
  tallestBetween(x0: number, x1: number): number;
  surfaceAt(worldX: number): { altM: number; on: Hazard | null };
  /** Camp positions the layout reserved — when given, camps go exactly here. */
  camps?: ReadonlyArray<number>;
}

const WORLD_PX_PER_M = 9;
/** Crate wood, and the sky it picks up on its top face. */
const CRATE = 0x6a5430;
const CRATE_SKY = 0xc8b890;
const GRAVITY = 9.81;
/**
 * Horizontal drag on a falling crate, per second — a drogue chute.
 *
 * At 0.32 a crate carried 90-245 m downrange, which on a 1067 px canvas with
 * the aircraft at x=300 put the impact point OFF THE RIGHT EDGE of the screen:
 * you were releasing blind and never saw it land. With the drogue the crate
 * sheds its forward speed in a second or two and comes down within ~50 m,
 * on screen, where you can watch it arrive.
 */
const CRATE_DRAG = 1.5;
/**
 * Gust drift, m/s of sideways velocity per metre of drop height.
 *
 * This is the risk/reward. With the drogue, accuracy no longer depended on
 * height, so there was no reason to come down into gun range to drop. Wind is
 * stronger higher up (the flight model already says so), so a crate released
 * high gets pushed about by gusts the reticle cannot know — from 30 m it goes
 * where you aimed, from 300 m it goes roughly there.
 */
const DRIFT_BASE = 1.2;
const DRIFT_PER_M = 0.045;
/** Scoring rings, metres from the target. */
const RING_BULLSEYE = 22;
const RING_GOOD = 55;
const RING_CLOSE = 110;

/** Pay multiplier by how hard the site is to reach. */
const SITE_PAY: Record<SiteKind, number> = { camp: 1, square: 1.2, rooftop: 1.5 };
const BESIEGED_PAY = 1.5;
/** Extra for giving a site everything it asked for, per crate needed. */
const COMPLETE_BONUS = 180;

/** Survivors: patched civilian clothes, no weapons worth the name. */
const SURVIVOR_PALETTE: FighterPalette = {
  cloth: 0x4a3f2c, skin: 0x2a1f16, head: 0x5a4a34, accent: 0x8a6a3a, metal: 0x2a2418,
};
/** Townsfolk: a little better off, a little more colour. */
const TOWNSFOLK_PALETTE: FighterPalette = {
  cloth: 0x3c4a4e, skin: 0x2a1f16, head: 0x4a3a2a, accent: 0x9a5a2a, metal: 0x2a2418,
};
/** The people keeping a besieged site alive. */
const DEFENDER_PALETTE: FighterPalette = {
  cloth: 0x2a3024, skin: 0x1f160e, head: 0x33382c, accent: 0x7a8a4a, metal: 0x14120e,
};

const CAMP_NAMES = ['a roadside camp', 'a caravan', 'a farmstead', 'a quarry camp', 'a well-head camp'];

function rnd(i: number): number {
  const x = Math.sin(i * 91.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
}

const RANK: Record<DropResult, number> = { miss: 0, close: 1, good: 2, bullseye: 3 };

export class SupplyDrops {
  sites: DropSite[] = [];
  crates: Crate[] = [];
  cratesLeft = 3;
  private world: DropWorld | null = null;

  /**
   * One site in most towns, and camps in the open country between them.
   *
   * Deterministic from the route seed like the rest of the route furniture,
   * so a leg you fly twice has the same people in the same places.
   */
  layout(
    routeEndPx: number, seed: number, crates: number, world: DropWorld | null = null,
    opts: { squaresOnly?: boolean; camps?: boolean } = {},
  ): void {
    this.sites = [];
    this.crates = [];
    this.cratesLeft = crates;
    this.world = world;
    const M = WORLD_PX_PER_M;
    const towns = world?.towns ?? [];

    towns.forEach((t, i) => {
      const s = seed * 17 + i * 29;
      // Not every town is calling for help — some are doing fine. A town
      // under siege always is, and on a route with only a couple of towns
      // they all are: every route must have at least two places to drop to.
      if (towns.length > 2 && !t.besieged && rnd(s) < 0.22) return;
      if (t.refuge && !opts.squaresOnly && rnd(s + 1) < 0.45) {
        const r = t.refuge;
        this.sites.push(this.site(r.x, s, 'rooftop', t.name, r.roofM ?? r.heightM,
          { x: r.x, halfWidth: r.halfWidth }, 3 + Math.floor(rnd(s + 2) * 3),
          1 + (rnd(s + 3) < 0.4 ? 1 : 0)));
      } else {
        const people = 4 + Math.floor(rnd(s + 2) * 4);
        this.sites.push(this.site(t.squareX, s, 'square', t.name, 0, null, people,
          2 + (people > 5 ? 1 : 0)));
      }
    });

    // Camps out in the open, clear of the towns
    const PER = 7.5 * 1000 * M;
    const n = Math.max(1, Math.round(routeEndPx / PER));
    const start = routeEndPx * 0.14, span = routeEndPx * 0.72;
    const nearTown = (x: number): boolean =>
      // Never on top of an airfield, whatever the route length
      x < 1200 * M || x > routeEndPx - 1500 * M
      || towns.some(t => x > t.x0 - 700 * M && x < t.x1 + 700 * M)
      // A camp is never put where a gun can reach its drop run
      || (world?.zones ?? []).some(([a, b]) =>
        x > a - GUN_REACH_PX - DROP_RUN_AFTER_PX && x < b + GUN_REACH_PX + DROP_RUN_BEFORE_PX)
      // ...and nothing tall standing in the way of the descent to it
      || (!!world && world.tallestBetween(x - DROP_RUN_BEFORE_PX, x + 90 * M) > 40);
    // Reserved camps: placed by the route layout, already clear of guns
    if (world?.camps && opts.camps !== false) {
      world.camps.forEach((x, i) => {
        const s = seed * 31 + i * 7;
        this.sites.push(this.site(x, s, 'camp', CAMP_NAMES[Math.floor(rnd(s + 4) * CAMP_NAMES.length)],
          0, null, 2 + Math.floor(rnd(seed + i * 5) * 3), 1));
      });
    }
    for (let i = 0; i < (opts.camps === false || world?.camps ? 0 : n); i++) {
      const slice = span / n;
      let x = start + slice * (i + 0.2 + rnd(seed * 13 + i) * 0.6);
      if (nearTown(x)) x = start + slice * (i + 0.5);
      if (nearTown(x)) continue;
      const s = seed * 31 + i * 7;
      this.sites.push(this.site(x, s, 'camp', CAMP_NAMES[Math.floor(rnd(s + 4) * CAMP_NAMES.length)],
        0, null, 2 + Math.floor(rnd(seed + i * 5) * 3), 1));
    }
    // Every route has somebody to help. If the rolls left nobody, the first
    // town calls; failing that, a camp in the first spot no gun can reach.
    if (this.sites.length === 0) {
      const t = towns[0];
      if (t) {
        this.sites.push(this.site(t.squareX, seed, 'square', t.name, 0, null, 5, 2));
      } else {
        let x = routeEndPx * 0.5;
        for (let k = 0; k <= 24; k++) {
          const c = routeEndPx * (0.2 + (k / 24) * 0.6);
          if (!nearTown(c)) { x = c; break; }
        }
        this.sites.push(this.site(x, seed, 'camp', CAMP_NAMES[0], 0, null, 3, 1));
      }
    }
    this.sites.sort((a, b) => a.x - b.x);

    for (const s of this.sites) {
      s.besieged = (world?.zones ?? []).some(([a, b]) => s.x > a - 100 * M && s.x < b + 100 * M);
      /*
       * The window. The floor clears everything around the release point and
       * the site itself — roofs, pylons, the cable tops — with a margin. The
       * ceiling is where the gust spread stops being a crate on them and
       * starts being a crate in the next street.
       */
      // The run-in and the site, not the far side: once the crates are out
      // the obstacle calls take over again
      const top = world ? world.tallestBetween(s.x - DROP_BAND_RUN_PX, s.x + 90 * M) : 0;
      s.bandLo = Math.round(Math.max(s.surfaceM + 14, top + 7, 18));
      s.bandHi = s.bandLo + 24;
    }
  }

  private site(
    x: number, seed: number, kind: SiteKind, place: string, surfaceM: number,
    roof: DropSite['roof'], people: number, need: number,
  ): DropSite {
    return {
      x, seed, people, kind, place, surfaceM, roof, besieged: false, need, got: 0,
      bandLo: 18, bandHi: 42, state: 'waiting', inboundT: -1, flareT: -1,
      result: null, resultT: 99, earned: 0, fetches: [],
    };
  }

  /** The site the reticle aims at: signalling, ahead or just behind you. */
  activeSite(planeWorldX: number, dir: 1 | -1 = 1): DropSite | null {
    let best: DropSite | null = null;
    for (const s of this.sites) {
      if (s.state !== 'signalled') continue;
      if ((s.x - planeWorldX) * dir < -1400) continue;
      if (!best || Math.abs(s.x - planeWorldX) < Math.abs(best.x - planeWorldX)) best = s;
    }
    return best;
  }

  /** The next site that has called in and is still waiting, for the HUD card. */
  nextCalling(planeWorldX: number, dir: 1 | -1 = 1): DropSite | null {
    let best: DropSite | null = null;
    let bestAhead = Infinity;
    for (const s of this.sites) {
      if (s.state !== 'inbound' && s.state !== 'signalled') continue;
      const ahead = (s.x - planeWorldX) * dir;
      if (ahead < -1400 || ahead >= bestAhead) continue;
      best = s;
      bestAhead = ahead;
    }
    return best;
  }

  /**
   * Put a crate out of the door.
   *
   * It leaves with the aircraft's ground speed and no vertical speed — which is
   * the whole trick of a supply drop, and why the reticle leads the aircraft.
   */
  release(planeWorldX: number, planeAlt: number, groundSpeedMs: number, dir: 1 | -1 = 1): boolean {
    if (this.cratesLeft <= 0 || planeAlt < 4) return false;
    this.cratesLeft--;
    // Box-Muller: a gust you cannot predict, larger the higher you let go
    const u = Math.max(1e-6, Math.random()), v = Math.random();
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const sigma = DRIFT_BASE + planeAlt * DRIFT_PER_M;
    this.crates.push({
      wx: planeWorldX, alt: planeAlt,
      vx: dir * groundSpeedMs * WORLD_PX_PER_M, vAlt: 0,
      drift: gauss * sigma * WORLD_PX_PER_M,
      spin: (Math.random() - 0.5) * 6, age: 0, landed: false, landedT: 0, onRoofX: null,
    });
    return true;
  }

  /**
   * How far off the reticle a crate could plausibly land, metres (≈2σ).
   *
   * Drawn as the reticle's width, so height costs you visibly: low down the
   * ring is a tight mark on the camp, up high it is a wide faint smear that
   * honestly says "somewhere around here".
   */
  spreadM(planeAlt: number): number {
    const fall = Math.sqrt(2 * Math.max(0, planeAlt) / GRAVITY);
    return 2 * (DRIFT_BASE + planeAlt * DRIFT_PER_M) * fall;
  }

  private surface(x: number): { altM: number; on: Hazard | null } {
    return this.world ? this.world.surfaceAt(x) : { altM: 0, on: null };
  }

  /**
   * Where a crate released now would land: world px, and the height of the
   * roof or ground it comes down on.
   *
   * Integrates the SAME step as update() rather than a closed-form guess, so
   * the reticle and the real crate can never disagree — a reticle that lies
   * would be worse than none.
   */
  predictImpact(
    planeWorldX: number, planeAlt: number, groundSpeedMs: number, dir: 1 | -1 = 1,
  ): { x: number; altM: number } {
    let x = planeWorldX, alt = planeAlt, vx = dir * groundSpeedMs * WORLD_PX_PER_M, vAlt = 0;
    const dt = 1 / 30;
    let floor = 0;
    for (let i = 0; i < 900; i++) {
      vAlt -= GRAVITY * dt;
      vx *= Math.exp(-CRATE_DRAG * dt);
      x += vx * dt;
      alt += vAlt * dt;
      floor = this.surface(x).altM;
      if (alt <= floor) break;
    }
    return { x, altM: floor };
  }

  /**
   * @param inboundPx  how far out a site makes its first call
   * @param signalPx   how far out it puts the flare up
   */
  update(
    dt: number, planeWorldX: number, airborne: boolean, inboundPx = 30000, signalPx = 9000, dir: 1 | -1 = 1,
  ): DropEvents {
    const ev: DropEvents = { inbound: null, signalled: null, landed: [], completed: [] };

    for (const s of this.sites) {
      for (const f of s.fetches) {
        f.t += dt;
        if (f.t > f.run) f.crate.taken = true;
      }
      s.fetches = s.fetches.filter(f => f.t < f.run * 2 + 0.5);
      if (s.inboundT >= 0) s.inboundT += dt;
      if (s.flareT >= 0) s.flareT += dt;
      s.resultT += dt;
      const ahead = (s.x - planeWorldX) * dir;
      if (airborne && s.state === 'waiting' && ahead > 0 && ahead < inboundPx) {
        s.state = 'inbound';
        s.inboundT = 0;
        if (!ev.inbound) ev.inbound = s;
      }
      if (airborne && s.state === 'inbound' && ahead < signalPx) {
        s.state = 'signalled';
        s.flareT = 0;
        if (!ev.signalled) ev.signalled = s;
      }
      // Flying past no longer writes them off: the aeroplane can turn round
      // and come back. A site simply drops out of the card while it is
      // behind you (see nextCalling), and is there again if you turn.
    }

    for (const c of this.crates) {
      c.age += dt;
      if (c.landed) { c.landedT += dt; continue; }
      c.vAlt -= GRAVITY * dt;
      c.vx *= Math.exp(-CRATE_DRAG * dt);
      c.wx += (c.vx + c.drift) * dt;
      c.alt += c.vAlt * dt;
      const surf = this.surface(c.wx);
      if (c.alt <= surf.altM) {
        c.alt = surf.altM;
        c.landed = true;
        c.onRoofX = surf.on ? surf.on.x : null;
        const landing = this.score(c);
        ev.landed.push(landing);
        const site = landing.site;
        if (site && site.got >= site.need && site.state !== 'served') {
          site.state = 'served';
          const bonus = Math.round(COMPLETE_BONUS * site.need * this.payMult(site) / 10) * 10;
          site.earned += bonus;
          ev.completed.push({ site, bonus });
        }
      }
    }
    // Keep the ground tidy: a landed crate lingers long enough to be seen,
    // unless somebody is out fetching it
    this.crates = this.crates.filter(c =>
      !c.landed || c.landedT < 9 || this.sites.some(s => s.fetches.some(f => f.crate === c)));
    return ev;
  }

  private payMult(s: DropSite): number {
    return SITE_PAY[s.kind] * (s.besieged ? BESIEGED_PAY : 1);
  }

  /** Which site this crate was meant for, how close it got, and what it earns. */
  private score(c: Crate): CrateLanding {
    let site: DropSite | null = null;
    let best = Infinity;
    for (const s of this.sites) {
      if (s.state === 'served') continue;
      const d = Math.abs(s.x - c.wx) / WORLD_PX_PER_M;
      if (d < best) { best = d; site = s; }
    }
    let result: DropResult;
    if (site?.kind === 'rooftop' && site.roof) {
      // On the roof or it does not really count — the street is full of the dead
      const onRoof = c.onRoofX !== null && Math.abs(c.onRoofX - site.roof.x) < 1;
      result = onRoof ? 'bullseye' : best <= RING_GOOD ? 'close' : 'miss';
    } else {
      result = best <= RING_BULLSEYE ? 'bullseye'
        : best <= RING_GOOD ? 'good'
          : best <= RING_CLOSE ? 'close' : 'miss';
      // Stuck on somebody's roof: they will get it down, eventually
      if (c.onRoofX !== null && (result === 'bullseye' || result === 'good')) result = 'close';
    }
    if (!site || result === 'miss') return { site: null, result: 'miss', distM: best, money: 0, rep: 0 };
    // On a rooftop, near is not good enough: a crate in the street is a
    // crate they cannot reach, so it neither pays nor counts
    if (site.kind === 'rooftop' && c.onRoofX === null) {
      return { site, result: 'close', distM: best, money: 0, rep: 0, unreachable: true };
    }

    site.got++;
    if (!site.result || RANK[result] > RANK[site.result]) site.result = result;
    // Somebody runs out for it — unless it is in a street full of the dead
    const reachable = site.kind !== 'rooftop' || c.onRoofX !== null;
    if (reachable) {
      const from = site.x + (c.wx > site.x ? 10 : -10);
      site.fetches.push({
        crate: c, from, t: 0, seed: site.seed + site.got * 13,
        run: Phaser.Math.Clamp(Math.abs(c.wx - from) / 70, 0.8, 5),
      });
    }
    site.resultT = 0;
    const base = DROP_REWARD[result];
    const money = Math.round(base.money * this.payMult(site) / 10) * 10;
    site.earned += money;
    return { site, result, distM: best, money, rep: base.rep + (site.besieged ? 1 : 0) };
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  /** The people and what they have — on the ground layer, with the raiders. */
  drawSites(
    g: Phaser.GameObjects.Graphics, scrollX: number, groundY: number, pxPerM: number,
    width: number, t: number, dl: number, crowd: CrowdStyle | null = null,
  ): void {
    const centreX = width / 2;
    for (const s of this.sites) {
      const sx = s.x - scrollX;
      if (sx < -200 || sx > width + 200) continue;
      const calling = s.state === 'inbound' || s.state === 'signalled';
      if (s.kind === 'rooftop') this.drawRooftop(g, s, sx, groundY, pxPerM, t, dl, calling, crowd);
      else if (s.kind === 'square') this.drawSquare(g, s, sx, groundY, t, dl, calling);
      else this.drawCamp(g, s, sx, groundY, t, dl, calling);
      if (s.besieged) this.drawDefences(g, s, sx, groundY - s.surfaceM * pxPerM, t, dl);
      // Runners: out to the crate, then back with it on their shoulder
      for (const f of s.fetches) {
        const out = f.t < f.run;
        const k = out ? f.t / f.run : Math.min(1, (f.t - f.run) / f.run);
        const x = out ? f.from + (f.crate.wx - f.from) * k : f.crate.wx + (f.from - f.crate.wx) * k;
        const fx = x - scrollX;
        const fy = groundY - f.crate.alt * pxPerM;
        const face: 1 | -1 = (out ? f.crate.wx > f.from : f.from > f.crate.wx) ? 1 : -1;
        drawFighter(g, fx, fy, t * 1.8, f.seed, 0.9, face, 'patrol', -1.2, dl,
          s.kind === 'square' ? TOWNSFOLK_PALETTE : SURVIVOR_PALETTE);
        if (!out) {
          g.fillStyle(0x6a5430, 1);
          g.fillRect(fx - 5, fy - 27, 11, 8);
          g.lineStyle(1, 0x2a2010, 0.9);
          g.strokeRect(fx - 5, fy - 27, 11, 8);
        }
      }
      // Crates that made it, stacked where they can reach them
      const shown = Math.min(3, s.got);
      const baseY = groundY - s.surfaceM * pxPerM;
      for (let i = 0; i < shown; i++) {
        const cx = sx + 8 + i * 12;
        extrudeBox(g, cx - 5, cx + 6, baseY, 9, depthOffset(cx, centreX, 9), CRATE, CRATE_SKY);
        g.fillStyle(0x6a5430, 1);
        g.fillRect(cx - 5, baseY - 9, 11, 9);
        g.lineStyle(1, 0x2a2010, 0.9);
        g.strokeRect(cx - 5, baseY - 9, 11, 9);
      }
    }
  }

  /**
   * A signal panel laid flat on the ground.
   *
   * This is how people on the ground actually attract an aircraft, and it
   * does two jobs: it makes the site readable against dark earth (the figures
   * alone vanished into it), and it IS the bullseye.
   */
  private drawPanel(g: Phaser.GameObjects.Graphics, sx: number, y: number, w: number, s: DropSite, calling: boolean): void {
    const served = s.state === 'served';
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(sx, y + 2, w + 8, 9);
    g.fillStyle(served ? 0x8a7a5a : 0xe8e0d0, served ? 0.55 : 0.95);
    g.fillRect(sx - w / 2, y - 1, w, 4);
    g.fillRect(sx - 4, y - 3, 8, 7);
    if (calling) {
      g.fillStyle(0xff5a2a, 0.9);
      g.fillRect(sx - w / 2, y + 0.5, w, 1.2);
    }
  }

  private drawFire(g: Phaser.GameObjects.Graphics, x: number, y: number, t: number, seed: number): void {
    const flick = 0.7 + Math.sin(t * 11 + seed) * 0.3;
    g.fillStyle(0xff8a2a, 0.55 * flick);
    g.fillCircle(x, y - 3, 4.5);
    g.fillStyle(0xffd070, 0.8 * flick);
    g.fillCircle(x, y - 3, 2);
  }

  private drawPeople(
    g: Phaser.GameObjects.Graphics, s: DropSite, x0: number, spacing: number, y: number,
    t: number, dl: number, calling: boolean, pal: FighterPalette, scale = 0.9,
  ): void {
    for (let i = 0; i < s.people; i++) {
      const px = x0 + i * spacing;
      const hop = calling ? Math.abs(Math.sin(t * 5 + i * 1.7)) * 2.4 : 0;
      drawFighter(
        g, px, y - hop, t, s.seed + i * 3, scale,
        i % 2 ? 1 : -1, calling ? 'aimUp' : 'stand',
        calling ? -1.3 - Math.sin(t * 6 + i) * 0.5 : -1.2, dl, pal,
      );
    }
  }

  private drawCamp(
    g: Phaser.GameObjects.Graphics, s: DropSite, sx: number, groundY: number,
    t: number, dl: number, calling: boolean,
  ): void {
    this.drawPanel(g, sx, groundY, 44, s, calling);
    // A lean-to and a tarp, and the fire they have been keeping going
    g.fillStyle(0x2c241a, 1);
    g.beginPath();
    g.moveTo(sx - 34, groundY); g.lineTo(sx - 20, groundY - 17); g.lineTo(sx - 4, groundY);
    g.closePath(); g.fillPath();
    g.fillStyle(0x3a6a8a, 0.95);                    // a blue tarp — nothing else out here is blue
    g.fillRect(sx + 10, groundY - 11, 22, 11);
    g.fillStyle(0x1a140c, 1);
    g.fillRect(sx + 10, groundY - 12, 22, 2);
    this.drawFire(g, sx - 2, groundY, t, s.seed);
    this.drawPeople(g, s, sx - 16, 11, groundY, t, dl, calling, SURVIVOR_PALETTE);
  }

  /** A crowd in the town square, with what a town has that a camp does not. */
  private drawSquare(
    g: Phaser.GameObjects.Graphics, s: DropSite, sx: number, groundY: number,
    t: number, dl: number, calling: boolean,
  ): void {
    this.drawPanel(g, sx, groundY, 64, s, calling);
    // Market stalls under awnings, a handcart, oil-drum fires
    for (const k of [-1, 1]) {
      const ax = sx + k * 48;
      g.lineStyle(1.4, 0x2a2016, 1);
      g.lineBetween(ax - 10, groundY, ax - 10, groundY - 14);
      g.lineBetween(ax + 10, groundY, ax + 10, groundY - 14);
      g.fillStyle(k < 0 ? 0x8a3a2a : 0x3a6a5a, 0.95);
      g.fillTriangle(ax - 14, groundY - 12, ax, groundY - 19, ax + 14, groundY - 12);
      g.fillStyle(0x2c241a, 1);
      g.fillRect(ax - 9, groundY - 6, 18, 6);
    }
    g.fillStyle(0x2a2016, 1);
    g.fillRect(sx + 66, groundY - 7, 14, 5);
    g.lineStyle(1.2, 0x2a2016, 1);
    g.lineBetween(sx + 80, groundY - 5, sx + 90, groundY - 1);
    g.fillCircle(sx + 70, groundY - 1, 2.5);
    for (const fx of [sx - 70, sx + 30]) {
      g.fillStyle(0x2a2420, 1);
      g.fillRect(fx - 3.5, groundY - 8, 7, 8);
      this.drawFire(g, fx, groundY - 7, t, s.seed + fx);
    }
    this.drawPeople(g, s, sx - (s.people - 1) * 6.5, 13, groundY, t, dl, calling, TOWNSFOLK_PALETTE);
  }

  /**
   * People on a roof, a sheet over the parapet, and the reason they are up
   * there shuffling around the foot of the building.
   */
  private drawRooftop(
    g: Phaser.GameObjects.Graphics, s: DropSite, sx: number, groundY: number, pxPerM: number,
    t: number, dl: number, calling: boolean, crowd: CrowdStyle | null,
  ): void {
    const roofY = groundY - s.surfaceM * pxPerM;
    const hw = s.roof?.halfWidth ?? 30;
    // The sheet they hung out: white, with a red cross painted on it
    const sheetX = sx - hw + 6;
    const wave = Math.sin(t * 2.2 + s.seed) * 1.5;
    g.fillStyle(0xe8e0d0, s.state === 'served' ? 0.6 : 0.95);
    g.fillRect(sheetX, roofY + 1, 16, 20 + wave);
    g.fillStyle(0xc0301a, 0.9);
    g.fillRect(sheetX + 6.5, roofY + 4, 3, 14);
    g.fillRect(sheetX + 2.5, roofY + 9, 11, 3);
    // A fire barrel and a rain catcher on the roof
    g.fillStyle(0x2a2420, 1);
    g.fillRect(sx + hw - 16, roofY - 8, 7, 8);
    this.drawFire(g, sx + hw - 12.5, roofY - 7, t, s.seed);
    g.fillStyle(0x3a6a8a, 0.9);
    g.fillRect(sx - 6, roofY - 5, 14, 5);
    this.drawPeople(g, s, sx - (s.people - 1) * 5, 10, roofY, t, dl, calling, SURVIVOR_PALETTE, 0.8);

    // The dead in the street, pressed against the doors
    if (crowd) {
      for (let i = 0; i < 9; i++) {
        const ux = sx + (rnd(s.seed + i * 3) - 0.5) * (hw * 2 + 70);
        drawUndead(g, ux, groundY, t, s.seed + i * 7, 0.72, ux < sx ? 1 : -1,
          undeadKindFor(s.seed + i), crowd);
      }
    }
  }

  /** Sandbags and two people with rifles facing out — the ground is contested. */
  private drawDefences(
    g: Phaser.GameObjects.Graphics, s: DropSite, sx: number, y: number, t: number, dl: number,
  ): void {
    g.fillStyle(0x4a4030, 1);
    for (const k of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        g.fillEllipse(sx + k * (84 + i * 7), y - 2 - (i % 2) * 3, 10, 5);
      }
      drawFighter(g, sx + k * 96, y, t, s.seed + k * 9, 0.85, k as 1 | -1, 'aimSide', 0, dl, DEFENDER_PALETTE);
    }
  }

  /**
   * Flares, falling crates, the reticle, and the drop window — above the
   * world, with traffic.
   *
   * @param reticle  predicted impact, or null to hide it
   * @param guide    the drop window to fly into, or null
   */
  drawAir(
    g: Phaser.GameObjects.Graphics, scrollX: number, groundY: number, pxPerM: number,
    width: number, t: number,
    reticle: { x: number; altM: number; onTarget: boolean; spreadM: number } | null,
    guide: DropGuide | null,
    planeScreenX = 300,
  ): void {
    /*
     * The window, as a band across the sky ahead of the aircraft.
     *
     * The view ahead is under a second of flying at cruise, so the site itself
     * shows up far too late to plan a descent around. The band is drawn at the
     * real heights, on the same mapping as everything you can hit, so "get
     * into the green" means exactly the right altitude with nothing to read.
     */
    if (guide && guide.fade > 0.01) {
      const yHi = groundY - guide.hi * pxPerM;
      const yLo = groundY - guide.lo * pxPerM;
      // From just behind the aircraft to the edge of the screen it faces
      const back = guide.dir === -1;
      const x0 = back ? 0 : Math.max(0, planeScreenX - 60);
      const x1 = back ? Math.min(width, planeScreenX + 60) : width;
      const pulse = 0.75 + Math.sin(t * 3) * 0.25;
      g.fillStyle(0x9fe8b0, 0.07 * guide.fade);
      g.fillRect(x0, yHi, x1 - x0, yLo - yHi);
      g.lineStyle(1.5, 0x9fe8b0, 0.5 * guide.fade * pulse);
      for (let x = x0; x < x1; x += 22) {
        g.lineBetween(x, yHi, Math.min(x1, x + 12), yHi);
        g.lineBetween(x, yLo, Math.min(x1, x + 12), yLo);
      }
      // Chevrons on the leading edge pointing into it
      g.fillStyle(0x9fe8b0, 0.8 * guide.fade * pulse);
      const my = (yHi + yLo) / 2;
      if (back) g.fillTriangle(6, my, 16, my - 7, 16, my + 7);
      else g.fillTriangle(width - 6, my, width - 16, my - 7, width - 16, my + 7);

      /*
       * The way down: a dashed line from the aircraft to where the band
       * starts, with chevrons marching along it. Descending into a band you
       * cannot see the end of was guesswork; this is the slope to fly.
       */
      if (guide.path) {
        const p = guide.path;
        const ax = p.x0 - scrollX, ay = groundY - p.alt0 * pxPerM;
        const bx = p.x1 - scrollX, by = groundY - p.alt1 * pxPerM;
        const len = Math.hypot(bx - ax, by - ay);
        if (len > 10) {
          const ux = (bx - ax) / len, uy = (by - ay) / len;
          // How far along it stays on screen, whichever way it points
          const reach = Math.min(len, Math.max(0, ux >= 0 ? (width - ax) / Math.max(0.2, ux) : ax / Math.max(0.2, -ux)));
          g.lineStyle(2, 0xffd080, 0.55 * guide.fade);
          for (let d = 60; d < reach; d += 24) {
            g.lineBetween(ax + ux * d, ay + uy * d, ax + ux * Math.min(reach, d + 12), ay + uy * Math.min(reach, d + 12));
          }
          // Chevrons along the line, moving toward the band
          const march = (t * 90) % 110;
          g.fillStyle(0xffd080, 0.85 * guide.fade);
          for (let d = 90 + march; d < reach; d += 110) {
            const cx = ax + ux * d, cy = ay + uy * d;
            const nx = -uy, ny = ux;   // perpendicular
            g.fillTriangle(
              cx + ux * 9, cy + uy * 9,
              cx - ux * 5 + nx * 7, cy - uy * 5 + ny * 7,
              cx - ux * 5 - nx * 7, cy - uy * 5 - ny * 7,
            );
          }
        }
      }
    }

    // ── Green smoke once they have called, so the site is findable ────────
    for (const s of this.sites) {
      if (s.inboundT < 0 || s.state === 'served') continue;
      const sx = s.x - scrollX;
      if (sx < -80 || sx > width + 80) continue;
      const base = groundY - s.surfaceM * pxPerM;
      for (let i = 0; i < 8; i++) {
        const k = i / 7;
        const drift = Math.sin(t * 0.6 + i + s.seed) * (3 + k * 12) + k * 26;
        g.fillStyle(0x6ad08a, 0.16 * (1 - k * 0.7));
        g.fillEllipse(sx + 14 + drift, base - 6 - k * 120, 8 + k * 22, 6 + k * 14);
      }
    }

    // ── How many they need, hung over the site ──────────────────────────
    // The card says it too, but this is what you see when you look at them:
    // a crate for each one wanted, filled in as they arrive.
    for (const s of this.sites) {
      if (s.inboundT < 0 || s.state === 'served' && s.resultT > 3) continue;
      const sx = s.x - scrollX;
      if (sx < -80 || sx > width + 80) continue;
      const base = groundY - s.surfaceM * pxPerM;
      const y = base - 64;
      const w = s.need * 13 + 8;
      g.fillStyle(0x0c0a06, 0.72);
      g.fillRoundedRect(sx - w / 2, y - 8, w, 16, 3);
      g.lineStyle(1, 0x9fe8b0, 0.7);
      g.strokeRoundedRect(sx - w / 2, y - 8, w, 16, 3);
      for (let i = 0; i < s.need; i++) {
        const cx = sx - w / 2 + 6 + i * 13;
        if (i < s.got) {
          g.fillStyle(0x9fe8b0, 1);
          g.fillRect(cx, y - 4, 9, 8);
        } else {
          g.lineStyle(1.4, 0xffd080, 0.95);
          g.strokeRect(cx, y - 4, 9, 8);
        }
      }
      g.lineStyle(1, 0x9fe8b0, 0.5);
      g.lineBetween(sx, y + 8, sx, base - 20);
    }

    // ── Flares: up fast, then hang and drift down under a smoke trail ──────
    for (const s of this.sites) {
      if (s.flareT < 0 || s.flareT > 14) continue;
      const sx = s.x - scrollX;
      if (sx < -80 || sx > width + 80) continue;
      const base = groundY - s.surfaceM * pxPerM;
      const ft = s.flareT;
      const rise = Math.min(ft, 1.6);
      const altM = rise * 95 - Math.max(0, ft - 1.6) * 6;
      const fy = base - Math.max(0, altM) * pxPerM;
      const fx = sx + Math.sin(ft * 0.7 + s.seed) * 10;
      for (let i = 0; i < 9; i++) {
        const k = i / 8;
        g.fillStyle(0xd8c8b8, 0.10 * (1 - k * 0.6));
        g.fillCircle(sx + (fx - sx) * k, base + (fy - base) * k, 3 + k * 5);
      }
      const pulse = 0.75 + Math.sin(t * 22 + s.seed) * 0.25;
      const fade = ft > 11 ? Math.max(0, 1 - (ft - 11) / 3) : 1;
      g.fillStyle(0xff4a1a, 0.20 * pulse * fade);
      g.fillCircle(fx, fy, 22);
      g.fillStyle(0xff6a2a, 0.45 * pulse * fade);
      g.fillCircle(fx, fy, 9);
      g.fillStyle(0xfff0d0, 0.98 * fade);
      g.fillCircle(fx, fy, 3.6);
    }

    // ── The reticle: where a crate released now would land ────────────────
    if (reticle) {
      const rx = reticle.x - scrollX;
      const ry = groundY - reticle.altM * pxPerM;
      if (rx > -40 && rx < width + 40) {
        const col = reticle.onTarget ? 0x9fe8b0 : 0xffd080;
        const pulse = 0.65 + Math.sin(t * 7) * 0.2;
        // The ring IS the uncertainty — wide and faint when you are too high.
        // Certainty is judged in METRES: the first version used pixel width, so
        // even a tight ±15 m drop from 35 m drew at 25% and could not be seen.
        const w = Math.max(30, reticle.spreadM * 2 * WORLD_PX_PER_M);
        const sure = Phaser.Math.Clamp(1 - (reticle.spreadM - 12) / 150, 0.25, 1);
        // Foreshortened hard: the ground recedes almost edge-on in this view
        const h = Math.max(7, w * 0.075);
        g.fillStyle(col, 0.10 * sure);
        g.fillEllipse(rx, ry - 1, w, h);
        g.lineStyle(2, col, pulse * sure);
        g.strokeEllipse(rx, ry - 1, w, h);
        // A pin standing on the aim point — the thing you actually line up
        g.lineStyle(2.5, 0x000000, 0.5);
        g.lineBetween(rx, ry - 26, rx, ry - 4);
        g.lineStyle(2, col, 0.95);
        g.lineBetween(rx, ry - 26, rx, ry - 4);
        g.fillStyle(col, 1);
        g.fillTriangle(rx - 6, ry - 30, rx + 6, ry - 30, rx, ry - 22);
        g.fillCircle(rx, ry - 1, 3);
      }
    }

    // ── Crates in the air, and a puff where they come down ────────────────
    for (const c of this.crates) {
      const sx = c.wx - scrollX;
      if (sx < -60 || sx > width + 60) continue;
      const cy = groundY - c.alt * pxPerM;
      if (c.landed) {
        if (c.taken) continue;
        if (c.landedT < 1.2) {
          const k = c.landedT / 1.2;
          g.fillStyle(0xcab89a, 0.4 * (1 - k));
          g.fillEllipse(sx, cy - 3, 14 + k * 34, 6 + k * 12);
        }
        extrudeBox(g, sx - 5, sx + 6, cy, 9, depthOffset(sx, width / 2, 9), CRATE, CRATE_SKY);
        g.fillStyle(0x6a5430, 1);
        g.fillRect(sx - 5, cy - 9, 11, 9);
        continue;
      }
      // A drogue above it once it has had a moment to open
      if (c.age > 0.35) {
        g.lineStyle(0.8, 0xc8b8a0, 0.7);
        g.lineBetween(sx - 4, cy - 4, sx - 2, cy - 16);
        g.lineBetween(sx + 4, cy - 4, sx + 2, cy - 16);
        g.fillStyle(0xd8c8a8, 0.9);
        g.fillEllipse(sx, cy - 18, 14, 6);
      }
      const a = c.age * c.spin * Math.max(0.2, 1 - c.age * 0.5);
      const co = Math.cos(a), si = Math.sin(a);
      const pts = [[-5, -4.5], [5, -4.5], [5, 4.5], [-5, 4.5]].map(([x, y]) => ({
        x: sx + x * co - y * si, y: cy + x * si + y * co,
      }));
      // Tumbling, so the faces it shows change as it turns over
      extrude(g, pts, depthOffset(sx, width / 2, 9), CRATE, CRATE_SKY, CRATE_SKY);
      g.fillStyle(0x6a5430, 1);
      g.fillPoints(pts, true);
      g.lineStyle(1, 0x2a2010, 0.9);
      g.strokePoints(pts, true);
    }

    // ── A spark over the site, so the result reads without the toast ──────
    for (const s of this.sites) {
      if (!s.result || s.resultT > 2.6) continue;
      const sx = s.x - scrollX;
      if (sx < -80 || sx > width + 80) continue;
      const base = groundY - s.surfaceM * pxPerM;
      const k = s.resultT / 2.6;
      const col = s.result === 'bullseye' ? 0x9fe8b0 : s.result === 'good' ? 0xffd080 : 0xc8b888;
      g.fillStyle(col, 1 - k);
      g.fillCircle(sx, base - 44 - k * 30, 4 - k * 2);
    }
  }
}

/** What each result is worth before the site multiplier. Generous on purpose. */
export const DROP_REWARD: Record<DropResult, { money: number; rep: number; line: string }> = {
  bullseye: { money: 950, rep: 3, line: 'Right on them' },
  good:     { money: 600, rep: 2, line: "They'll get it" },
  close:    { money: 250, rep: 1, line: 'A short walk for them' },
  miss:     { money: 0,   rep: 0, line: 'Missed — it went into the scrub' },
};

/**
 * Crates carried, by hold size.
 *
 * Three was a token. A town square wants two or three, a route has several
 * sites, and a pass is one chance — so even the crop duster carries six, and a
 * heavy carries enough to work every site on a long haul and still miss some.
 */
export function cratesFor(cargoKg: number): number {
  return Phaser.Math.Clamp(Math.round(4 + Math.sqrt(Math.max(0, cargoKg)) / 7), 5, 14);
}

/**
 * What the people on the ground say when a crate lands — their voice, not a
 * score. Only the first crate at a site and the last one get a call, so the
 * radio does not narrate every box.
 */
export function siteReply(result: DropResult, kind: SiteKind, seed: number): string {
  const pick = (lines: string[]): string => lines[Math.abs(Math.floor(seed)) % lines.length];
  if (kind === 'rooftop' && result === 'close') {
    return pick(['It went in the street — we cannot get down to it!', 'Missed the roof. The dead are all over it.']);
  }
  switch (result) {
    case 'bullseye': return pick(['Right on us! Thank you, pilot!', 'Dead centre — we have it!', 'Landed at our feet. God bless.']);
    case 'good': return pick(['We see it — going out for it now.', 'Close enough, we are on it.', 'Got eyes on the crate, thank you!']);
    case 'close': return pick(['Long walk, but we will fetch it.', 'It is past the wire — we will manage.']);
    default: return 'Nothing here, pilot.';
  }
}
