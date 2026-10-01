import Phaser from 'phaser';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import { EventBus } from '../utils/EventBus';
import { drawUndead, drawCorpse, drawHorde, undeadKindFor, type CrowdStyle } from '../world/Crowds';
import { drawFighter, drawMuzzleFlash, garrisonPalette, RAIDER_PALETTE } from '../world/Figures';
import { isTouchDevice } from '../utils/device';
import { drawBuilding, drawBuildingDepth } from '../world/Towns';
import type { Hazard } from '../world/Hazards';
import type { FighterPalette } from '../world/Figures';
import { AircraftModel, type ModelLight } from '../entities/aircraft/render/AircraftModel';
import { specFor } from '../entities/aircraft/render/AircraftVisualSpec';

/**
 * How the world got like this, and what you are for.
 *
 * Six beats, each a moving tableau with a line of narration over it: the dead
 * arrive, the living fracture, warlords take the roads — and then the part
 * the game is actually about: the towns that held out behind their wire, the
 * supplies that can only reach them from the sky, and the aeroplane that
 * brings them. The story used to end at "the cargo went up", which was the
 * game three versions ago; drops, towns and survivors are the heart of it now.
 *
 * Everything is drawn with the flight scene's own renderers — the horde, the
 * town buildings with their roofs and walls, the figures, and the lit 3D
 * aircraft model — so the intro shows the world you are about to fly in.
 * ENTER or click advances a beat; ESC skips out.
 */

interface Beat {
  /** Seconds this beat runs before auto-advancing. */
  hold: number;
  /** Chapter mark. "1 / 4" told the reader nothing they needed. */
  title: string;
  lines: string[];
  /** Where the fire is, 0–1 across the frame. Drives every light cue. */
  fire: number;
  draw: (g: Phaser.GameObjects.Graphics, t: number, k: number) => void;
}

/** Fraction of the frame given to the tableau; narration owns the rest. */
const TEXT_BAND = 0.72;

// Near-black figures against deliberately LIGHTER dirt. The flight scene can
// afford low-contrast crowds because they are moving past at speed; a static
// tableau cannot — at the first pass these read as smudges on the ground.
const CROWD: CrowdStyle = {
  body: 0x08060a, rag: 0x171016, rim: 0xb09060, daylight: 0.35,
};

/** People in a town that has held out. */
const TOWNSFOLK: FighterPalette = {
  cloth: 0x3c4a4e, skin: 0x2a1f16, head: 0x4a3a2a, accent: 0x9a5a2a, metal: 0x2a2418,
};

function lerpC(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * u) << 16) | (Math.round(ag + (bg - ag) * u) << 8) | Math.round(ab + (bb - ab) * u);
}

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class IntroScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
  private tableau!: Phaser.GameObjects.Container;
  /** The aeroplane in the last two beats — the same model you fly. */
  private model!: AircraftModel;
  private titleText!: Phaser.GameObjects.Text;
  private bodyText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private beats: Beat[] = [];
  private index = 0;
  private t = 0;          // time within the current beat
  private total = 0;      // absolute time, for continuous animation
  private advancing = false;
  /** Where to go when the intro ends — MenuScene replay vs. a new game. */
  private nextScene = 'MapScene';
  /** Straight into flight school afterwards — a new game's first flight. */
  private training = false;

  constructor() { super({ key: 'IntroScene' }); }

  init(data: { next?: string; training?: boolean }): void {
    this.nextScene = data?.next ?? 'MapScene';
    this.training = !!data?.training;
    this.index = 0;
    this.t = 0;
    this.total = 0;
    this.advancing = false;
  }

  create(): void {
    const { width, height } = this.cameras.main;
    this.cameras.main.setBackgroundColor('#07050a');
    fadeIn(this, 700);
    SoundEngine.startAmbient();

    this.gfx = this.add.graphics();
    // The tableau lives in its own container so the beat can PUSH IN on it
    // without dragging the letterbox and the narration along with it. A static
    // frame is most of why the sequence felt like slides rather than film.
    this.tableau = this.add.container(0, 0, [this.gfx]);
    const maskG = this.make.graphics({}, false);
    maskG.fillStyle(0xffffff, 1);
    maskG.fillRect(0, 0, width, height * TEXT_BAND);
    this.tableau.setMask(maskG.createGeometryMask());
    const spec = specFor('crop_duster');
    const gear = spec.gear;
    this.model = new AircraftModel(this, spec, gear.hingeY + gear.strutLen + gear.wheelR);
    this.tableau.add([this.model.gfx, this.model.lamps]);
    this.model.setVisible(false);
    this.beats = this.buildBeats(width, height);

    // Letterbox: the art lives above this line, the narration below it, so a
    // four-line beat can never end up drawn through the tableau.
    const band = this.add.graphics();
    band.fillStyle(0x000000, 1);
    band.fillRect(0, height * TEXT_BAND, width, height * (1 - TEXT_BAND));
    band.lineStyle(1, 0x2a2216, 0.8);
    band.lineBetween(0, height * TEXT_BAND, width, height * TEXT_BAND);

    // Anchored to the BOTTOM and grown upward, so line count never shifts it
    this.bodyText = this.add.text(width / 2, height - 34, '', {
      fontSize: '19px', color: '#e8d5b7', fontFamily: 'monospace',
      align: 'center', lineSpacing: 9, wordWrap: { width: width - 180 },
    }).setOrigin(0.5, 1).setAlpha(0);

    this.titleText = this.add.text(width / 2, height * TEXT_BAND + 12, '', {
      fontSize: '12px', color: '#8a6a3a', fontFamily: 'monospace', letterSpacing: 5,
    }).setOrigin(0.5, 0).setAlpha(0);

    this.hintText = this.add.text(width - 16, height - 14,
      isTouchDevice()
        ? 'TAP — continue'
        : 'ENTER / CLICK — continue      ESC — skip', {
      fontSize: '11px', color: '#4a4030', fontFamily: 'monospace',
    }).setOrigin(1, 1);

    this.input.keyboard!.on('keydown-ENTER', () => this.next());
    this.input.keyboard!.on('keydown-SPACE', () => this.next());
    this.input.keyboard!.on('keydown-ESC', () => this.finish());
    this.input.on('pointerdown', () => this.next());

    this.showBeat();
  }

  // ── Flow ──────────────────────────────────────────────────────────────────

  private showBeat(): void {
    const beat = this.beats[this.index];
    this.t = 0;
    this.titleText.setText(`${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][this.index] ?? ''}   ${beat.title}`).setAlpha(0);
    this.bodyText.setText(beat.lines.join('\n')).setAlpha(0);
    this.tweens.add({ targets: [this.titleText], alpha: 0.7, duration: 500, delay: 250 });
    this.tweens.add({ targets: [this.bodyText], alpha: 1, duration: 700, delay: 350 });
    SoundEngine.click();
  }

  private next(): void {
    if (this.advancing) return;
    if (this.index >= this.beats.length - 1) { this.finish(); return; }
    this.advancing = true;
    this.tweens.add({
      targets: [this.titleText, this.bodyText],
      alpha: 0, duration: 260,
      onComplete: () => { this.index++; this.advancing = false; this.showBeat(); },
    });
  }

  private finish(): void {
    if (this.advancing) return;
    this.advancing = true;
    this.hintText.setAlpha(0);
    if (this.training) {
      // The HUD has to be up before the flight's first frame reports in
      EventBus.emit('scene:start-flight', { contractId: '' });
      fadeToScene(this, 'FlightScene', { contractId: '', training: true });
      return;
    }
    fadeToScene(this, this.nextScene);
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.05);
    this.t += dt;
    this.total += dt;

    const beat = this.beats[this.index];
    // 0 → 1 across the beat, so each tableau can build rather than just loop
    const k = Phaser.Math.Clamp(this.t / beat.hold, 0, 1);

    this.gfx.clear();
    this.setFire(beat.fire);
    beat.draw(this.gfx, this.total, k);
    // Drawn over the tableau, inside the same push, so the ash has depth too
    this.foregroundFx(this.gfx);
    this.airborneFx(this.gfx, this.total);

    // Slow push-in, easing out, re-anchored on the fire so the shot drifts
    // toward what it is about.
    const push = 1 + 0.075 * (1 - Math.pow(1 - k, 2));
    const { width: W, height: H } = this.cameras.main;
    const fx = W * beat.fire, fy = H * TEXT_BAND * 0.62;
    this.tableau.setScale(push);
    this.tableau.setPosition(fx - fx * push, fy - fy * push);

    if (this.t > beat.hold + 2.4 && !this.advancing) this.next();
  }

  // ── The beats ─────────────────────────────────────────────────────────────

  /** Set per beat; the shared helpers all read it. */
  private setFire!: (x01: number) => void;
  private airborneFx!: (g: Phaser.GameObjects.Graphics, t: number) => void;
  private foregroundFx!: (g: Phaser.GameObjects.Graphics) => void;

  private buildBeats(width: number, height: number): Beat[] {
    const horizon = height * 0.44;
    /** Bottom of the drawable tableau — nothing may cross into the text band. */
    const floor = height * TEXT_BAND;

    /**
     * Where the light is coming from, per beat. Everything below reads from
     * this: the sky bloom, the haze on the horizon, which side of a figure is
     * rim-lit, and which way the shadows fall.
     */
    let fireX = width * 0.72;
    this.setFire = (x01: number): void => { fireX = width * x01; };

    /**
     * Dead city skyline, in THREE layers with atmospheric perspective: the far
     * towers pale and hazy, only the nearest properly black. Haze lies between
     * the layers as a gradient, so there is no band edge for the eye to catch.
     */
    const skyline = (g: Phaser.GameObjects.Graphics, t: number, alpha: number, drift: number): void => {
      const layers = [
        { z: 0.30, tint: 0x3b2b2c, a: 0.55, scale: 0.55, count: 26, par: 0.35 },
        { z: 0.62, tint: 0x1d1519, a: 0.80, scale: 0.78, count: 22, par: 0.65 },
        { z: 1.00, tint: 0x0b0a0e, a: 1.00, scale: 1.00, count: 18, par: 1.00 },
      ];
      for (const L of layers) {
        for (let i = 0; i < L.count; i++) {
          const seed = i + L.count;
          const bx = ((i * 74 + rnd(seed) * 30 - drift * L.par) % (width + 160)) - 80;
          const bw = (30 + rnd(seed + 3) * 34) * L.scale;
          const bh = (60 + rnd(seed + 7) * 150) * L.scale;
          g.fillStyle(L.tint, alpha * L.a);
          g.beginPath();
          g.moveTo(bx, horizon);
          g.lineTo(bx, horizon - bh + rnd(seed + 11) * 14);
          g.lineTo(bx + bw * 0.4, horizon - bh);
          g.lineTo(bx + bw, horizon - bh + rnd(seed + 13) * 12);
          g.lineTo(bx + bw, horizon);
          g.closePath();
          g.fillPath();
          if (L.z > 0.5) {
            const facing = bx + bw / 2 < fireX ? bx + bw : bx;
            g.lineStyle(1.4, 0xc07038, alpha * L.a * 0.30);
            g.lineBetween(facing, horizon - bh + 8, facing, horizon);
          }
          if (L.z > 0.5 && rnd(seed + 21) < 0.42) {
            g.fillStyle(0xd8a044, alpha * L.a * 0.55 * (0.4 + 0.6 * Math.abs(Math.sin(t * 0.4 + i))));
            g.fillRect(bx + 6 + rnd(seed) * 10, horizon - bh + 22 + rnd(seed + 2) * 40, 3.5, 5);
          }
        }
        const top = horizon - 150 * L.scale;
        g.fillGradientStyle(0x6a3a24, 0x6a3a24, 0x6a3a24, 0x6a3a24, 0, 0, 0.18, 0.18);
        g.fillRect(0, top, width, horizon - top);
      }
    };

    /**
     * The ground as a plane in perspective: warm and pale at the horizon,
     * cold at the near edge, with stones and dry grass that grow as they come
     * toward the camera. Flat bands read as lino; this reads as distance.
     */
    const ground = (g: Phaser.GameObjects.Graphics): void => {
      const depth = floor - horizon;
      g.fillGradientStyle(0x7a5f3a, 0x7a5f3a, 0x3a2c1e, 0x3a2c1e, 1, 1, 1, 1);
      g.fillRect(0, horizon, width, depth * 0.4);
      g.fillGradientStyle(0x3a2c1e, 0x3a2c1e, 0x1c150f, 0x1c150f, 1, 1, 1, 1);
      g.fillRect(0, horizon + depth * 0.4, width, depth * 0.6 + 2);
      // The fire's pool on the dirt, brightest directly below it
      for (let i = 10; i >= 1; i--) {
        g.fillStyle(0xd08040, 0.03);
        g.fillEllipse(fireX, horizon + depth * 0.1, width * 0.95 * (i / 10), depth * 0.85 * (i / 10));
      }
      // Ground cover in rows of depth
      for (let row = 0; row < 9; row++) {
        const tr = (row + 0.5) / 9;
        const y = horizon + depth * Math.pow(tr, 1.6);
        const z = 0.35 + tr * 2.1;
        const n = Math.round(26 / z);
        for (let i = 0; i < n; i++) {
          const x = ((i + rnd(row * 31 + i) * 0.8) / n) * width;
          const c = lerpC(0x2a2016, 0x6a5434, (1 - tr) * 0.5);
          if (rnd(row * 7 + i) < 0.5) {
            g.lineStyle(Math.max(0.7, z * 0.8), c, 0.9);
            g.lineBetween(x, y, x - 2 * z, y - 4 * z);
            g.lineBetween(x, y, x + 0.4 * z, y - 5 * z);
            g.lineBetween(x, y, x + 2.4 * z, y - 3.6 * z);
          } else {
            g.fillStyle(c, 1);
            g.fillEllipse(x, y - z, 5 * z, 3 * z);
          }
        }
      }
      // Hot haze along the horizon, as a gradient both ways
      g.fillGradientStyle(0xe09048, 0xe09048, 0xe09048, 0xe09048, 0, 0, 0.3, 0.3);
      g.fillRect(0, horizon - 20, width, 20);
      g.fillGradientStyle(0xe09048, 0xe09048, 0xe09048, 0xe09048, 0.3, 0.3, 0, 0);
      g.fillRect(0, horizon, width, 14);
    };

    /** A cumulus lit from the low sun, puffs piled on a shadowed base. */
    const cloud = (g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, body: number, shade: number, a: number, seed: number): void => {
      const h = w * 0.32;
      g.fillStyle(shade, a * 0.9);
      g.fillEllipse(x, y + h * 0.2, w * 0.95, h * 0.4);
      for (let i = 0; i < 7; i++) {
        const t0 = i / 6;
        const dome = Math.sin(t0 * Math.PI);
        const r = h * (0.32 + dome * 0.4) * (0.85 + rnd(seed + i) * 0.3);
        g.fillStyle(lerpC(shade, body, 0.75), a);
        g.fillCircle(x + (t0 - 0.5) * w * 0.8, y - dome * h * 0.24, r);
      }
      g.fillStyle(body, a * 0.25);
      g.fillCircle(x - w * 0.1, y - h * 0.3, h * 0.45);
    };

    /** Low sky with a real bloom where the world is burning, and drifting cloud. */
    const sky = (g: Phaser.GameObjects.Graphics, t: number, top: number, bot: number): void => {
      g.fillGradientStyle(top, top, bot, bot, 1);
      g.fillRect(0, 0, width, horizon + 2);
      for (let i = 14; i >= 1; i--) {
        const f = i / 14;
        g.fillStyle(0xc85a20, 0.028 * (1 - f) + 0.006);
        g.fillEllipse(fireX, horizon + 10, width * 1.15 * f, height * 0.60 * f);
      }
      for (let i = 0; i < 5; i++) {
        const sx = ((i * 290 + t * (6 + i * 2)) % (width + 500)) - 250;
        cloud(g, sx, horizon - 140 - (i % 3) * 55, 180 + i * 40,
          lerpC(bot, 0xd8b090, 0.35), lerpC(top, 0x000000, 0.25), 0.5, i * 13);
      }
    };

    /**
     * A town that has held out: real buildings, drawn by the same renderer
     * the flight scene uses, with their roofs and side walls — and the wires
     * strung between them.
     */
    const town = (g: Phaser.GameObjects.Graphics, t: number, baseY: number, x0: number, scale: number): number[] => {
      const kinds: Array<[Hazard['kind'], number, number]> = [
        ['shack', 9, 30], ['house', 13, 34], ['church', 30, 46], ['house', 12, 32],
        ['block', 22, 40], ['warehouse', 14, 50], ['watertower', 26, 22], ['house', 11, 30],
      ];
      const pxPerM = 3.2 * scale;
      const style = { rim: 0xc07038, daylight: 0.45 };
      const list: Array<{ b: Hazard; sx: number }> = [];
      let x = x0;
      kinds.forEach(([kind, hM, hw], i) => {
        const half = hw * scale;
        x += half;
        list.push({ b: { x, kind, heightM: hM, halfWidth: half, seed: 300 + i * 17, look: 'plain' } as Hazard, sx: x });
        x += half + 10 * scale;
      });
      for (const { b, sx } of [...list].sort((a, c) => Math.abs(c.sx - width / 2) - Math.abs(a.sx - width / 2))) {
        drawBuildingDepth(g, b, sx, baseY, pxPerM, style, width / 2);
      }
      for (const { b, sx } of list) drawBuilding(g, b, sx, baseY, pxPerM, t, style);
      // Poles and the lines between them
      const poles = [x0 - 30 * scale, x0 + (x - x0) * 0.33, x0 + (x - x0) * 0.66, x + 30 * scale];
      const topY = baseY - 9 * pxPerM;
      g.lineStyle(2.4 * scale, 0x221a12, 1);
      for (const px of poles) {
        g.lineBetween(px, baseY, px, topY);
        g.lineBetween(px - 7 * scale, topY + 3, px + 7 * scale, topY + 3);
      }
      g.lineStyle(1, 0x140f0a, 0.85);
      for (let i = 0; i + 1 < poles.length; i++) {
        for (const dy of [3, 7]) {
          const a = poles[i], b = poles[i + 1];
          let px = a, py = topY + dy;
          for (let k = 1; k <= 12; k++) {
            const u = k / 12;
            const nx = a + (b - a) * u, ny = topY + dy + Math.sin(u * Math.PI) * 9 * scale;
            g.lineBetween(px, py, nx, ny);
            px = nx; py = ny;
          }
        }
      }
      return list.map(({ sx }) => sx);
    };

    /** A rooftop flare: what a camp burns when it hears an engine. */
    const flare = (g: Phaser.GameObjects.Graphics, x: number, y: number, t: number): void => {
      const fl = 0.7 + Math.sin(t * 17) * 0.3;
      g.fillStyle(0xff3a20, 0.18 * fl); g.fillCircle(x, y, 26);
      g.fillStyle(0xff6a40, 0.9); g.fillCircle(x, y, 3.2);
      for (let k = 0; k < 9; k++) {
        const up = (t * 22 + k * 13) % 110;
        g.fillStyle(0xd06060, 0.2 * (1 - up / 110));
        g.fillEllipse(x + Math.sin(t * 0.8 + k) * (3 + up * 0.15) + up * 0.25, y - 6 - up, 8 + up * 0.25, 6 + up * 0.18);
      }
    };

    /** Ash on the wind and embers off the fires, drawn over everything. */
    const airborne = (g: Phaser.GameObjects.Graphics, t: number): void => {
      for (let i = 0; i < 90; i++) {
        const sp = 6 + rnd(i) * 26;
        const x = ((rnd(i + 5) * width + t * sp) % (width + 60)) - 30;
        const y = ((rnd(i + 9) * floor + t * (3 + rnd(i) * 7)) % floor);
        g.fillStyle(0x9a8a78, 0.10 + rnd(i + 3) * 0.16);
        g.fillCircle(x, y, 0.6 + rnd(i + 2) * 1.5);
      }
      for (let i = 0; i < 26; i++) {
        const life = (t * (0.16 + rnd(i) * 0.2) + rnd(i + 7)) % 1;
        const x = fireX + (rnd(i + 1) - 0.5) * width * 0.45 + Math.sin(t * 1.4 + i) * 14;
        const y = horizon + 14 - life * (horizon * 0.85);
        g.fillStyle(0xff9a3c, (1 - life) * 0.55);
        g.fillCircle(x, y, 0.8 + (1 - life) * 1.5);
      }
    };

    /** Near-field frame: out-of-focus rubble across the bottom of the shot. */
    const foreground = (g: Phaser.GameObjects.Graphics): void => {
      g.fillStyle(0x0a0807, 1);
      g.beginPath();
      g.moveTo(0, floor + 2);
      for (let x = 0; x <= width; x += 26) {
        g.lineTo(x, floor - 10 - Math.abs(Math.sin(x * 0.013 + 1.7)) * 26 - rnd(x) * 8);
      }
      g.lineTo(width, floor + 2);
      g.closePath();
      g.fillPath();
    };

    this.airborneFx = airborne;
    this.foregroundFx = foreground;

    const dusk: ModelLight = { sky: 0x8a5a48, ground: 0x3a2a1a, sun: 0xffb478, daylight: 0.55, haze: 0.06, hazeColor: 0x8a5a26 };
    /** The aeroplane — the real model, lit by the tableau's own light. */
    const plane = (x: number, y: number, s: number, pitch: number, roll: number, t: number): void => {
      this.model.setVisible(true);
      this.model.render(x, y, 0, s, 1, {
        yaw: -0.14, roll, pitch, flapDeg: 0, aileron: 0, elevator: 0, rudder: 0, gear: 1,
        propAngle: t * 40, propSpeed: 1, damage: 0, ice: 0,
        beacon: (t * 1.2) % 1 < 0.08 ? 1 : 0, landingLight: false, shed: false,
      }, dusk);
    };
    const noPlane = (): void => this.model.setVisible(false);

    return [
      // ── 1. The dead ──────────────────────────────────────────────────────
      {
        hold: 7,
        title: 'THE SEASON',
        fire: 0.74,
        lines: [
          'The dead came first.',
          'Not as an army. As a season — one that never ended.',
        ],
        draw: (g, t, k) => {
          noPlane();
          sky(g, t, 0x1a1016, 0x4a2418);
          skyline(g, t, 0.95, t * 4);
          ground(g);
          const n = Math.round(7 + k * 17);
          for (let i = 0; i < n; i++) {
            const lane = i % 4;
            const scale = 1.05 + lane * 0.55;
            const y = horizon + 18 + lane * ((floor - horizon - 30) / 3.4);
            const speed = 9 + lane * 7;
            const x = ((i * 137 + rnd(i) * 300 + t * speed) % (width + 240)) - 120;
            drawUndead(g, x, y, t, i * 13 + 1, scale, 1, undeadKindFor(i * 13), CROWD, 1);
          }
          for (let i = 0; i < 4; i++) {
            drawCorpse(g, 90 + i * 260 + rnd(i) * 60, horizon + 84, i * 7, 1.5, CROWD);
          }
        },
      },

      // ── 2. The fracture ──────────────────────────────────────────────────
      {
        hold: 8,
        title: 'THE FRACTURE',
        fire: 0.3,
        lines: [
          'What was left of us did not band together.',
          'The convoys were the first thing worth taking — and the men with',
          'guns worked that out before anyone thought to share the road.',
        ],
        draw: (g, t, k) => {
          noPlane();
          sky(g, t, 0x1c1410, 0x5c2c14);
          skyline(g, t, 0.9, t * 4 + 300);
          ground(g);
          for (let v = 0; v < 3; v++) {
            const vx = 170 + v * 300;
            const s = 2.0;
            const gyv = horizon + 70 + v * 26;
            g.fillStyle(0x171a14, 1);
            g.fillRect(vx - 46 * s, gyv - 16 * s, 92 * s, 14 * s);
            g.fillRect(vx + 18 * s, gyv - 30 * s, 34 * s, 16 * s);
            // The far side of each wreck, so they stand as solids
            g.fillStyle(0x0e100c, 1);
            g.fillRect(vx - 40 * s, gyv - 20 * s, 92 * s, 4 * s);
            for (const wx of [vx - 30 * s, vx + 30 * s]) {
              g.fillStyle(0x0a0806, 1);
              g.fillCircle(wx, gyv, 8 * s);
            }
            const fl = 0.55 + Math.sin(t * 9 + v * 2) * 0.45;
            const burn = Phaser.Math.Clamp(k * 2.2 - v * 0.35, 0, 1);
            if (burn > 0) {
              g.fillStyle(0xff6a1e, 0.55 * fl * burn);
              g.fillEllipse(vx + 26 * s, gyv - 34 * s, 52, 60);
              g.fillStyle(0xffc250, 0.7 * fl * burn);
              g.fillEllipse(vx + 26 * s, gyv - 30 * s, 24, 34);
              g.fillStyle(0xff8a30, 0.14 * fl * burn);
              g.fillCircle(vx + 26 * s, gyv - 16, 140);
              for (let sm = 0; sm < 7; sm++) {
                const yy = gyv - 66 * s - sm * 34 - ((t * 26) % 34);
                g.fillStyle(0x14110d, 0.32 * burn * (1 - sm / 8));
                g.fillEllipse(vx + 26 * s + Math.sin(t * 0.6 + sm) * (6 + sm * 5), yy, 38 + sm * 20, 26 + sm * 12);
              }
            }
          }
          for (let i = 0; i < 5; i++) {
            const x = 120 + i * 190 + Math.sin(t * 0.5 + i) * 12;
            drawUndead(g, x, floor - 14, t, 900 + i * 5, 1.9, i % 2 ? 1 : -1, 'shambler', CROWD, 1);
          }
        },
      },

      // ── 3. The warlords ──────────────────────────────────────────────────
      {
        hold: 8,
        title: 'THE WARLORDS',
        fire: 0.6,
        lines: [
          'They call themselves factions now. They hold ground, fly colours,',
          'and put anti-aircraft guns on the ridgelines, because the roads',
          'were never the only way through.',
        ],
        draw: (g, t, k) => {
          noPlane();
          sky(g, t, 0x140f14, 0x50241a);
          ground(g);
          const rise = (1 - k) * 90;
          for (let i = 0; i < 5; i++) {
            const bx = 120 + i * 190;
            const by = horizon + 22 + rise;
            g.lineStyle(3, 0x241c12, 1);
            g.lineBetween(bx, by, bx, by - 86);
            const wave = Math.sin(t * 2.6 + i) * 5;
            g.fillStyle([0x7a1a12, 0x2a4a6a, 0x3a6a2a, 0x7a5a18, 0x5a2a5a][i], 0.95);
            g.beginPath();
            g.moveTo(bx, by - 86);
            g.lineTo(bx + 44, by - 80 + wave);
            g.lineTo(bx + 44, by - 50 + wave);
            g.lineTo(bx, by - 44);
            g.closePath();
            g.fillPath();
            const pal = garrisonPalette([0x7a1a12, 0x2a4a6a, 0x3a6a2a, 0x7a5a18, 0x5a2a5a][i]);
            for (let m = 0; m < 3; m++) {
              drawFighter(g, bx + 26 + m * 20, by, t, i * 17 + m * 3, 1.05,
                m === 1 ? -1 : 1, m === 2 ? 'patrol' : 'stand', 0, 0.4, pal);
            }
          }
          const gx = width * 0.5, gy = floor - 16;
          const aim = -1.35 + Math.sin(t * 0.55) * 0.34;
          g.fillStyle(0x0e0c08, 1);
          for (const wx of [gx - 40, gx + 40]) g.fillCircle(wx, gy - 10, 13);
          g.lineStyle(7, 0x2b2a22, 1);
          g.lineBetween(gx - 52, gy - 4, gx + 52, gy - 4);
          g.fillStyle(0x2b2a22, 1);
          g.fillRect(gx - 22, gy - 46, 44, 32);
          for (const off of [-8, 8]) {
            const ox = -Math.sin(aim) * off, oy = Math.cos(aim) * off;
            g.lineStyle(6, 0x191610, 1);
            g.lineBetween(gx + ox, gy - 46 + oy, gx + ox + Math.cos(aim) * 88, gy - 46 + oy + Math.sin(aim) * 88);
          }
          drawFighter(g, gx + 62, gy, t, 71, 1.25, -1, 'crouch', aim, 0.4, RAIDER_PALETTE);
          drawFighter(g, gx + 92, gy, t, 73, 1.3, -1, 'work', 0, 0.4, RAIDER_PALETTE);
          const shoot = (t * 0.7) % 3 < 0.09;
          if (shoot) {
            const mx = gx + Math.cos(aim) * 92, my = gy - 46 + Math.sin(aim) * 92;
            drawMuzzleFlash(g, mx, my, aim, 1, 9);
            g.fillStyle(0xffd070, 0.05); g.fillRect(0, 0, width, height * TEXT_BAND);
          }
        },
      },

      // ── 4. The holdouts ──────────────────────────────────────────────────
      {
        hold: 9,
        title: 'THE HOLDOUTS',
        fire: 0.18,
        lines: [
          'Not everyone ran. Towns dug in behind their wire — a church tower',
          'for a lookout, a substation still humming, a few hundred people',
          'who cannot leave, and cannot be reached by road.',
        ],
        draw: (g, t, k) => {
          noPlane();
          sky(g, t, 0x121424, 0x6a3a22);
          skyline(g, t, 0.6, t * 2 + 900);
          ground(g);
          const baseY = horizon + 58;
          const xs = town(g, t, baseY, width * 0.22, 1.25);
          // Lamps coming on as the light goes
          for (let i = 0; i < 6; i++) {
            const lx = xs[i % xs.length] + (rnd(i) - 0.5) * 30;
            g.fillStyle(0xe8a848, (0.4 + 0.4 * Math.sin(t * 0.7 + i)) * Math.min(1, k * 2));
            g.fillRect(lx, baseY - 18 - rnd(i + 3) * 18, 3.5, 4.5);
          }
          // The wire, and the dead pressing at it
          g.lineStyle(2, 0x1e1810, 1);
          for (let i = 0; i < 9; i++) g.lineBetween(width * 0.13 + i * 9, baseY + 40, width * 0.13 + i * 9 - 2, baseY - 4);
          for (let r = 0; r < 3; r++) {
            g.lineStyle(1.1, 0x2a2218, 0.9);
            g.lineBetween(width * 0.12, baseY + 2 + r * 12, width * 0.21, baseY + 6 + r * 12);
          }
          drawHorde(g, width * 0.06, floor - 18, 160, 9, t, 77, CROWD, 1, 1.6);
          // Someone on the church roof, watching the sky
          drawFighter(g, xs[2] + 8, baseY - 12 * 3.2 * 1.25 * 0.36, t, 501, 1.0, 1, 'stand', 0, 0.4, TOWNSFOLK);
        },
      },

      // ── 5. The drop ──────────────────────────────────────────────────────
      {
        hold: 9,
        title: 'THE DROP',
        fire: 0.8,
        lines: [
          'So the supplies come down out of the sky.',
          'Low over the roofs, between the wires, under the guns —',
          'and a crate put where they can reach it.',
        ],
        draw: (g, t, k) => {
          sky(g, t, 0x141a2a, 0x8a4a22);
          skyline(g, t, 0.5, t * 2 + 1400);
          ground(g);
          const baseY = horizon + 70;
          const xs = town(g, t, baseY, width * 0.08, 1.35);
          // A flare on the warehouse roof — they heard the engine
          const roofX = xs[5], roofY = baseY - 14 * 3.2 * 1.35 + 10;
          flare(g, roofX - 20, roofY, t);
          for (let i = 0; i < 3; i++) {
            drawFighter(g, roofX + i * 14, roofY + 2, t, 600 + i * 7, 0.95, -1,
              i === 1 ? 'aimUp' : 'stand', -1.2, 0.4, TOWNSFOLK);
          }
          // Tracers arcing up from a far ridge, well behind the drop
          for (let i = 0; i < 5; i++) {
            const life = (t * 0.9 + i * 0.37) % 1;
            const x0 = width * 0.92, y0 = horizon - 6;
            const x = x0 - life * 240 - i * 12, y = y0 - life * 210 + life * life * 60;
            g.lineStyle(2, 0xffd070, 0.7 * (1 - life));
            g.lineBetween(x, y, x + 10, y + 7);
          }
          // The aeroplane low over the roofs, and the crate it just let go
          const px = -160 + k * (width + 320);
          const py = baseY - 150 + Math.sin(t * 1.3) * 4;
          plane(px, py, 1.25, 0.02, Math.sin(t * 0.9) * 0.05, t);
          const rel = width * 0.28;
          if (px > rel) {
            const fall = Math.min(1, (px - rel) / (width * 0.4));
            const cx = rel + 70 + fall * 50;
            const cy = py + 30 + fall * (roofY - py - 34);
            g.lineStyle(0.9, 0xd8c8a8, 0.8);
            g.lineBetween(cx - 5, cy - 4, cx - 2, cy - 20);
            g.lineBetween(cx + 5, cy - 4, cx + 2, cy - 20);
            g.fillStyle(0xd8c8a8, 0.92);
            g.fillEllipse(cx, cy - 22, 20, 8);
            g.fillStyle(0x6a5430, 1);
            g.fillRect(cx - 6, cy - 5, 12, 10);
            g.fillStyle(0x7e6440, 1);
            g.fillRect(cx - 6 + 2, cy - 8, 12, 3);
          }
        },
      },

      // ── 6. You ───────────────────────────────────────────────────────────
      {
        hold: 10,
        title: 'ASHLINE AIR',
        fire: 0.74,
        lines: [
          'One aeroplane, a strip of dirt, and people somewhere out there',
          'listening for an engine.',
          '',
          'You fly it. Your first lesson starts on the runway.',
        ],
        draw: (g, t, k) => {
          sky(g, t, 0x101a2c, 0x8a5a26);
          g.fillStyle(0xffb060, 0.16); g.fillCircle(width * 0.74, horizon - 74, 96);
          g.fillStyle(0xffd08a, 0.85); g.fillCircle(width * 0.74, horizon - 74, 34);
          skyline(g, t, 0.7, t * 3 + 700);
          ground(g);
          // The strip: a dark deck with its lights, and the hangar beside it
          const ry = horizon + 46;
          g.fillGradientStyle(0x3a352c, 0x3a352c, 0x15130f, 0x15130f, 1, 1, 1, 1);
          g.fillRect(0, ry - 8, width, 22);
          for (let i = 0; i < 18; i++) {
            const lx = (i * 72 + 20) % width;
            g.fillStyle(0xffd080, 0.6 + 0.4 * Math.sin(t * 2 + i));
            g.fillCircle(lx, ry + 13, 2);
          }
          g.fillStyle(0x1a1610, 1);
          g.fillRect(width * 0.06, ry - 52, 120, 44);
          g.fillStyle(0x24201a, 1);
          g.fillTriangle(width * 0.06 - 6, ry - 52, width * 0.06 + 60, ry - 74, width * 0.06 + 126, ry - 52);
          g.fillStyle(0xe8a848, 0.5);
          g.fillRect(width * 0.06 + 40, ry - 30, 40, 22);
          // Garrison by the wire
          for (let i = 0; i < 4; i++) {
            drawFighter(g, width * 0.6 + i * 78, floor - 16, t, 200 + i * 11, 1.35,
              -1, i % 2 ? 'patrol' : 'stand', 0, 0.4, garrisonPalette(0x4a90d9));
          }
          // The aeroplane climbing away into the low sun
          const px = width * 0.12 + k * (width * 0.9);
          const py = ry - 30 - k * k * 170;
          plane(px, py, 1.5 - k * 0.4, 0.14 * (1 - k * 0.4), -0.08, t);
        },
      },
    ];
  }
}
