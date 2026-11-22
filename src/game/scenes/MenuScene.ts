import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { ProfileService } from '../../services/ProfileService';
import { EventBus } from '../utils/EventBus';
import { EconomyService } from '../../services/EconomyService';
import { ContractService } from '../../services/ContractService';
import { AircraftSprite } from '../entities/aircraft/AircraftSprite';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import { ensureSkyTextures, GLOW_TEX } from '../world/CloudSprites';
import type { FlightState } from '../../types';

interface Star   { x: number; y: number; r: number; phase: number; spd: number; }
interface Dust   { x: number; y: number; alpha: number; sz: number; vx: number; vy: number; }
interface Meteor { x: number; y: number; vx: number; vy: number; life: number; }

/** Deterministic 0…1 hash for the ridgelines. */
function hash01(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
/** Smooth lattice noise, 0…1. */
function vnoise(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const a = hash01(i * 1.37 + seed * 31.7), b = hash01((i + 1) * 1.37 + seed * 31.7);
  return a + (b - a) * f * f * (3 - 2 * f);
}
function mixC(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * u) << 16) | (Math.round(ag + (bg - ag) * u) << 8) | Math.round(ab + (bb - ab) * u);
}

/**
 * The menu's country, back to front: hazy ranges against the afterglow, then
 * darker and nearer. Each drifts at its own pace — a slow pan across the
 * wasteland at dusk, the parallax that says these are miles apart.
 */
const MENU_RIDGES: Array<{ base: number; amp: number; seed: number; drift: number; top: number; foot: number; rim: number }> = [
  { base: 0.020, amp: 0.15, seed: 3.1, drift: 2.2, top: 0x3a2420, foot: 0x23171a, rim: 0.30 },
  { base: 0.045, amp: 0.12, seed: 8.7, drift: 4.5, top: 0x1c1312, foot: 0x110c0c, rim: 0.18 },
  { base: 0.075, amp: 0.085, seed: 1.9, drift: 8.0, top: 0x0d0909, foot: 0x080606, rim: 0.10 },
];

export class MenuScene extends Phaser.Scene {
  private staticGfx!: Phaser.GameObjects.Graphics;
  /** Twinkling stars and meteors: behind the mountains, not over them. */
  private skyGfx!: Phaser.GameObjects.Graphics;
  /** The drifting ranges and the plain, redrawn each frame. */
  private ridgeGfx!: Phaser.GameObjects.Graphics;
  private animGfx!:   Phaser.GameObjects.Graphics;
  private stars:  Star[]  = [];
  private dust:   Dust[]  = [];
  private meteors: Meteor[] = [];
  private nextMeteorIn = 4;
  private menuPlane: AircraftSprite | null = null;
  private menuPlaneState!: FlightState;
  private t = 0;

  constructor() {
    super({ key: 'MenuScene' });
  }

  create(): void {
    const { width, height } = this.cameras.main;
    const cx = width / 2;
    const horizonY = Math.round(height * 0.62);
    fadeIn(this, 400);
    SoundEngine.startAmbient();
    this.stars = [];
    this.dust = [];
    this.meteors = [];

    // ── Static scene layers ─────────────────────────────────────────────────
    this.staticGfx = this.add.graphics();
    this.drawStatic(width, height, horizonY);
    this.seedStars(width, horizonY);
    this.seedDust(width, height, horizonY);
    // The sun just gone down behind the ranges: its light still on the sky
    if (this.sys.game.renderer.type === Phaser.WEBGL && ensureSkyTextures(this)) {
      this.add.image(width * 0.68, horizonY + 14, GLOW_TEX)
        .setDisplaySize(width * 0.9, height * 0.55).setTint(0xff7428).setAlpha(0.7);
    }
    this.skyGfx = this.add.graphics();
    this.ridgeGfx = this.add.graphics();
    this.drawRidges(width, height, horizonY);

    // Animated overlay (cleared + redrawn every frame)
    this.animGfx = this.add.graphics();

    // ── Procedural aircraft crossing behind the title ───────────────────────
    const def = window.gameData.aircraft.find(a => a.id === 'crop_duster') ?? window.gameData.aircraft[0];
    this.menuPlane = new AircraftSprite(this, -180, height * 0.44, def);
    this.menuPlane.container.setScale(0.6);
    this.menuPlane.container.setAlpha(0.55);
    this.menuPlaneState = {
      throttle: 0.65, enginePower: 0.65, loadFactor: 1, pitch: 1.5, pitchRate: 0, flightPathAngle: 0, speed: 30, groundSpeed: 30, altitude: 400, verticalSpeed: 0,
      heading: 0, fuel: 60, engineTemp: 0.35, integrity: 100,
      gearDown: true, flapsDeployed: false, flapStage: 0, flapAngle: 0, distanceTravelled: 0, elapsedSeconds: 0,
      modifiers: { fuelBurnMult: 1, dragMult: 1, liftMult: 1, stabilityMult: 1 },
    };

    this.tweens.add({
      targets: this.menuPlane.container,
      x: width + 200,
      duration: 22000,
      ease: 'Linear',
      repeat: -1,
      onRepeat: () => {
        this.menuPlane?.container.setY(Phaser.Math.FloatBetween(height * 0.30, height * 0.54));
      },
    });

    // ── Typography ──────────────────────────────────────────────────────────
    const title = this.add.text(cx, height * 0.185, 'ASHLINE AIR', {
      fontSize: '60px',
      color: '#ffd080',
      fontFamily: 'monospace',
      fontStyle: 'bold',
      shadow: { offsetX: 0, offsetY: 0, color: '#cc5500', blur: 28, fill: true },
      // Room for the glow: without it the blur is cut off at the edge of the
      // text's own texture and shows as a dark box behind each word
      padding: { x: 36, y: 30 },
    }).setOrigin(0.5);

    // Slow amber pulse on the title
    this.tweens.add({
      targets: title,
      alpha: { from: 1.0, to: 0.80 },
      duration: 3200,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    this.add.text(cx, height * 0.295, '— Cargo pilots at the end of the world —', {
      fontSize: '14px',
      color: '#6a5a3a',
      fontFamily: 'monospace',
      fontStyle: 'italic',
    }).setOrigin(0.5);

    // Decorative horizontal rule
    const ruleGfx = this.add.graphics();
    ruleGfx.lineStyle(1, 0x5a4a20, 0.45);
    ruleGfx.lineBetween(cx - 160, height * 0.368, cx + 160, height * 0.368);

    // ── Buttons ─────────────────────────────────────────────────────────────
    this.makeButton(cx, height * 0.45, 'NEW GAME', () => {
      SaveService.deleteSave();
      const save = SaveService.load();
      save.world.settlements = EconomyService.initialise(window.gameData.settlements);
      ContractService.maintainBoard(save);
      SaveService.save(save.player, save.world);
      // The backstory runs before the first flight — it is the setup for the
      // walls, the gun trucks and why anyone pays a pilot at all — and then
      // flight school, so the first contract is not also the first lesson.
      fadeToScene(this, 'IntroScene', { next: 'FlightScene', lessonId: 'takeoff' });
    });

    if (SaveService.hasSave()) {
      this.makeButton(cx, height * 0.54, 'CONTINUE', () => {
        fadeToScene(this, 'MapScene');
      });
      // Replayable any time: the lessons are worth having again after a break
      this.makeButton(cx, height * 0.63, 'FLIGHT SCHOOL', () => {
        EventBus.emit('ui:open-flight-school');
      });
    } else {
      // Not available yet — but still legible, and still the same shape as a
      // button, rather than dark text lost against the mountains
      for (const [y, label] of [[0.54, 'CONTINUE'], [0.63, 'FLIGHT SCHOOL']] as const) {
        this.makeButton(cx, height * y, label, null);
      }
    }

    // Replayable, so the setup is never lost behind a one-time cutscene
    this.makeButton(cx, height * 0.72, 'THE STORY SO FAR', () => {
      fadeToScene(this, 'IntroScene', { next: 'MenuScene' });
    });

    // Whose progress this is. Several people can share a browser.
    const pilot = ProfileService.ensureActive();
    this.makeButton(cx, height * 0.81, `PILOT: ${pilot.name.toUpperCase()}`, () => {
      EventBus.emit('ui:open-profiles');
    });

    // ── Bottom status bar ───────────────────────────────────────────────────
    const barGfx = this.add.graphics();
    barGfx.fillStyle(0x5a4a20, 0.18);
    barGfx.fillRect(0, height - 30, width, 30);
    barGfx.lineStyle(1, 0x5a4a20, 0.35);
    barGfx.lineBetween(0, height - 30, width, height - 30);

    this.add.text(14, height - 15, 'ASHLINE AIR  ·  POST-APOCALYPTIC CARGO SIMULATION', {
      fontSize: '10px', color: '#6a5a3a', fontFamily: 'monospace',
    }).setOrigin(0, 0.5);

    this.add.text(width - 14, height - 15, 'v0.2.0', {
      fontSize: '10px', color: '#6a5a3a', fontFamily: 'monospace',
    }).setOrigin(1, 0.5);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * The dusk sky the ranges stand against.
   *
   * The horizon glow was seven stacked rectangles, which showed as seven
   * stripes, and the mountains were a row of triangles at fixed x positions
   * that ran out two-thirds of the way across a widescreen menu. The sky is
   * now graded in three smooth bands from night overhead to the afterglow,
   * and the ranges are drawn across whatever width the screen is (see
   * drawRidges).
   */
  private drawStatic(width: number, height: number, horizonY: number): void {
    const g = this.staticGfx;
    const top = 0x03050b, mid = 0x110d1a, low = 0x351a14, hor = 0x7a3214;
    const y1 = horizonY * 0.42, y2 = horizonY * 0.78;
    g.fillGradientStyle(top, top, mid, mid, 1);
    g.fillRect(0, 0, width, y1);
    g.fillGradientStyle(mid, mid, low, low, 1);
    g.fillRect(0, y1, width, y2 - y1);
    g.fillGradientStyle(low, low, hor, hor, 1);
    g.fillRect(0, y2, width, horizonY + 24 - y2);
    // The plain under everything — the ranges and the near ground cover it
    g.fillStyle(0x060404, 1);
    g.fillRect(0, horizonY + 24, width, height - horizonY - 24);
  }

  /**
   * Three ranges, hazy and warm at the back, near-black in front, each
   * drifting at its own speed and edged with the afterglow behind it.
   */
  private drawRidges(width: number, height: number, horizonY: number): void {
    const g = this.ridgeGfx;
    g.clear();
    const step = 8;
    const n = Math.ceil(width / step) + 1;
    for (const L of MENU_RIDGES) {
      const off = this.t * L.drift;
      const baseY = horizonY + height * L.base;
      const amp = height * L.amp;
      const hAt = (x: number): number => {
        const wx = x + off;
        const r = Math.sin(wx * 0.0062 + L.seed) * 0.42 + Math.sin(wx * 0.0141 + L.seed * 2.3) * 0.24
          + Math.sin(wx * 0.031 + L.seed * 4.1) * 0.1 + (vnoise(wx / 38, L.seed) - 0.5) * 0.3;
        return amp * (0.55 + r * 0.62);
      };
      const footY = horizonY + height * 0.2;
      let px = 0, py = baseY - hAt(0);
      for (let i = 1; i <= n; i++) {
        const x = i * step, y = baseY - hAt(x);
        // Vertex order for a gradient triangle is TL, TR, BL
        g.fillGradientStyle(L.top, L.top, L.foot, L.foot, 1);
        g.fillTriangle(px, py, x, y, px, footY);
        g.fillGradientStyle(L.top, L.foot, L.foot, L.foot, 1);
        g.fillTriangle(x, y, x, footY, px, footY);
        px = x; py = y;
      }
      // Backlit crest
      g.lineStyle(1, 0xff9a52, L.rim);
      g.beginPath();
      g.moveTo(0, baseY - hAt(0));
      for (let i = 1; i <= n; i++) g.lineTo(i * step, baseY - hAt(i * step));
      g.strokePath();
    }
    // The near plain, fading into the dark at the foot of the screen
    const py0 = horizonY + height * 0.11;
    g.fillGradientStyle(0x0c0908, 0x0c0908, 0x030202, 0x030202, 1);
    g.fillRect(0, py0, width, height - py0);
  }

  private seedStars(width: number, horizonY: number): void {
    for (let i = 0; i < 130; i++) {
      const x   = Phaser.Math.Between(0, width);
      const y   = Phaser.Math.Between(2, horizonY - 24);
      const r   = Phaser.Math.FloatBetween(0.6, 2.0);
      const ph  = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const spd = Phaser.Math.FloatBetween(0.25, 1.1);
      this.stars.push({ x, y, r, phase: ph, spd });

      // Static base dot so stars are always slightly visible
      this.staticGfx.fillStyle(0xfff4e0, Phaser.Math.FloatBetween(0.08, 0.22));
      this.staticGfx.fillRect(x, y, r, r);
    }
  }

  private seedDust(width: number, height: number, horizonY: number): void {
    for (let i = 0; i < 40; i++) {
      this.dust.push({
        x:     Phaser.Math.FloatBetween(0, width),
        y:     Phaser.Math.FloatBetween(horizonY - 40, height - 30),
        alpha: Phaser.Math.FloatBetween(0.025, 0.10),
        sz:    Phaser.Math.FloatBetween(1, 3),
        vx:    Phaser.Math.FloatBetween(-0.12, 0.12),
        vy:    Phaser.Math.FloatBetween(-0.06, -0.28),
      });
    }
  }

  update(_time: number, delta: number): void {
    const { width, height } = this.cameras.main;
    const horizonY = Math.round(height * 0.62);
    this.t += delta / 1000;

    // Keep the fly-by plane animated (spinning prop, beacon, exhaust)
    this.menuPlaneState.elapsedSeconds = this.t;
    this.menuPlane?.update(delta / 1000, this.menuPlaneState);

    // The ranges drift; the stars and meteors are behind them, the dust in front
    this.drawRidges(width, height, horizonY);
    const sky = this.skyGfx;
    sky.clear();
    const g = this.animGfx;
    g.clear();

    // Twinkling stars
    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(this.t * s.spd + s.phase);
      sky.fillStyle(0xfff4e0, tw * 0.45);
      sky.fillRect(s.x, s.y, s.r, s.r);
    }

    // Occasional meteor streaking down the night sky
    this.nextMeteorIn -= delta / 1000;
    if (this.nextMeteorIn <= 0) {
      this.nextMeteorIn = 5 + Math.random() * 9;
      this.meteors.push({
        x: Phaser.Math.FloatBetween(width * 0.2, width),
        y: Phaser.Math.FloatBetween(10, horizonY * 0.4),
        vx: -Phaser.Math.FloatBetween(240, 420),
        vy: Phaser.Math.FloatBetween(90, 160),
        life: 1,
      });
    }
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.x += m.vx * (delta / 1000);
      m.y += m.vy * (delta / 1000);
      m.life -= delta / 900;
      if (m.life <= 0 || m.y > horizonY) { this.meteors.splice(i, 1); continue; }
      // Tail trails opposite the velocity vector
      const tail = 26 * m.life;
      sky.lineStyle(1.5, 0xffe0b0, 0.7 * m.life);
      sky.lineBetween(m.x, m.y, m.x - (m.vx / 420) * tail, m.y - (m.vy / 420) * tail);
      sky.fillStyle(0xfff4e0, 0.9 * m.life);
      sky.fillCircle(m.x, m.y, 1.4);
    }

    // Floating dust
    for (const d of this.dust) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < horizonY - 60) {
        d.y = Phaser.Math.FloatBetween(height - 30, height);
        d.x = Phaser.Math.FloatBetween(0, width);
      }
      if (d.x < 0) d.x += width;
      else if (d.x > width) d.x -= width;
      g.fillStyle(0xdd8833, d.alpha);
      g.fillRect(d.x, d.y, d.sz, d.sz);
    }
  }

  /**
   * A menu button: a dark plate with a fine amber edge, so it reads over the
   * sky, the glow or the mountains alike. `onClick` null draws it disabled.
   * The whole plate is the target, not just the letters, and it lifts a
   * little when the pointer is on it.
   */
  private makeButton(x: number, y: number, label: string, onClick: (() => void) | null): void {
    const bw = Math.max(210, label.length * 14 + 40), bh = 40;
    const bx = x - bw / 2, by = y - bh / 2;
    const enabled = onClick !== null;

    const boxGfx = this.add.graphics();
    const drawBox = (hover: boolean): void => {
      boxGfx.clear();
      boxGfx.fillStyle(0x070504, enabled ? 0.62 : 0.45);
      boxGfx.fillRect(bx, by, bw, bh);
      if (hover) {
        boxGfx.fillStyle(0xffd080, 0.08);
        boxGfx.fillRect(bx, by, bw, bh);
        boxGfx.lineStyle(1, 0xffd080, 0.8);
      } else {
        boxGfx.lineStyle(1, enabled ? 0x7a6230 : 0x3a3220, enabled ? 0.6 : 0.5);
      }
      boxGfx.strokeRect(bx, by, bw, bh);
      // Corner ticks — the instrument-panel look the rest of the UI has
      if (enabled) {
        boxGfx.lineStyle(1.5, hover ? 0xffd080 : 0xa88848, hover ? 1 : 0.7);
        for (const [cx2, cy2, sx, sy] of [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]] as const) {
          boxGfx.lineBetween(cx2, cy2, cx2 + sx * 7, cy2);
          boxGfx.lineBetween(cx2, cy2, cx2, cy2 + sy * 7);
        }
      }
    };
    drawBox(false);

    const text = this.add.text(x, y, label, {
      fontSize: '22px',
      color: enabled ? '#c8b888' : '#5a5038',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    if (!enabled) return;

    const hit = this.add.zone(x, y, bw, bh).setInteractive({ useHandCursor: true });
    hit.on('pointerover', () => {
      drawBox(true);
      text.setStyle({ color: '#ffd080' });
      this.tweens.add({ targets: text, scale: 1.04, duration: 120, ease: 'Sine.easeOut' });
    });
    hit.on('pointerout', () => {
      drawBox(false);
      text.setStyle({ color: '#c8b888' });
      this.tweens.add({ targets: text, scale: 1, duration: 160, ease: 'Sine.easeOut' });
    });
    hit.on('pointerdown', () => { SoundEngine.click(); onClick(); });
  }
}
