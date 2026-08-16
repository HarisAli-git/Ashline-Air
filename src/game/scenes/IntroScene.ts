import Phaser from 'phaser';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import { drawUndead, drawCorpse, drawHorde, undeadKindFor, type CrowdStyle } from '../world/Crowds';
import { drawFighter, drawMuzzleFlash, garrisonPalette, RAIDER_PALETTE } from '../world/Figures';
import { isTouchDevice } from '../utils/device';

/**
 * How the world got like this.
 *
 * Four beats, each a moving procedural tableau with a line of narration over
 * it: the dead arrive, the living fracture instead of banding together,
 * warlords take the roads, and the cargo goes up into the air because that is
 * the only lane left. It is the setup for every mechanic in the flight scene —
 * the walls, the gun trucks, the AA batteries and the reason anybody pays a
 * pilot at all — so it is worth the ninety seconds.
 *
 * Everything is drawn in code, reusing the same crowd renderer the flight
 * scene uses, so the horde in the intro is literally the horde you overfly.
 * ENTER or click advances a beat; ESC skips out.
 */

interface Beat {
  /** Seconds this beat runs before auto-advancing. */
  hold: number;
  lines: string[];
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

function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class IntroScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
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

  constructor() { super({ key: 'IntroScene' }); }

  init(data: { next?: string }): void {
    this.nextScene = data?.next ?? 'MapScene';
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
    this.titleText.setText(`${this.index + 1} / ${this.beats.length}`).setAlpha(0);
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
    beat.draw(this.gfx, this.total, k);

    if (this.t > beat.hold + 2.4 && !this.advancing) this.next();
  }

  // ── The beats ─────────────────────────────────────────────────────────────

  private buildBeats(width: number, height: number): Beat[] {
    const horizon = height * 0.44;
    /** Bottom of the drawable tableau — nothing may cross into the text band. */
    const floor = height * TEXT_BAND;

    /** Dead city skyline — the same broken towers the flight scene draws. */
    const skyline = (g: Phaser.GameObjects.Graphics, t: number, alpha: number, drift: number): void => {
      for (let i = 0; i < 22; i++) {
        const bx = ((i * 74 + rnd(i) * 30 - drift) % (width + 160)) - 80;
        const bw = 30 + rnd(i + 3) * 34;
        const bh = 60 + rnd(i + 7) * 150;
        g.fillStyle(0x0b0a0e, alpha);
        g.beginPath();
        g.moveTo(bx, horizon);
        g.lineTo(bx, horizon - bh + rnd(i + 11) * 14);
        g.lineTo(bx + bw * 0.4, horizon - bh);
        g.lineTo(bx + bw, horizon - bh + rnd(i + 13) * 12);
        g.lineTo(bx + bw, horizon);
        g.closePath();
        g.fillPath();
        // A few windows still lit, fewer as the beats go on
        if (rnd(i + 21) < 0.5) {
          g.fillStyle(0xd8a044, alpha * 0.5 * (0.4 + 0.6 * Math.abs(Math.sin(t * 0.4 + i))));
          g.fillRect(bx + 6 + rnd(i) * 10, horizon - bh + 22 + rnd(i + 2) * 40, 3.5, 5);
        }
      }
    };

    // Dusty ground catching the light off the sky. It has to be clearly
    // LIGHTER than the figures standing on it or the crowd disappears.
    const ground = (g: Phaser.GameObjects.Graphics): void => {
      g.fillStyle(0x584734, 1);
      g.fillRect(0, horizon, width, floor - horizon);
      g.fillStyle(0x463829, 1);
      g.fillRect(0, horizon + 54, width, floor - horizon - 54);
      g.fillStyle(0x35291d, 1);
      g.fillRect(0, horizon + 120, width, Math.max(0, floor - horizon - 120));
      // Hot haze right along the horizon, so silhouettes read against it
      g.fillStyle(0xc08040, 0.22);
      g.fillRect(0, horizon - 16, width, 26);
      g.lineStyle(1.5, 0x6e5a3c, 1);
      g.lineBetween(0, horizon, width, horizon);
    };

    /** Low red sky with drifting smoke. */
    const sky = (g: Phaser.GameObjects.Graphics, t: number, top: number, bot: number): void => {
      g.fillGradientStyle(top, top, bot, bot, 1);
      g.fillRect(0, 0, width, horizon + 2);
      for (let i = 0; i < 7; i++) {
        const sx = ((i * 220 + t * (7 + i * 3)) % (width + 400)) - 200;
        g.fillStyle(0x120e0c, 0.20);
        g.fillEllipse(sx, horizon - 120 - (i % 3) * 60, 300 + i * 40, 44);
      }
    };

    return [
      // ── 1. The dead ──────────────────────────────────────────────────────
      {
        hold: 7,
        lines: [
          'The dead came first.',
          'Not as an army. As a season — one that never ended.',
        ],
        draw: (g, t, k) => {
          sky(g, t, 0x1a1016, 0x4a2418);
          skyline(g, t, 0.95, t * 4);
          ground(g);
          // A crowd walking out of the ruins, thickening as the beat runs
          const n = Math.round(7 + k * 17);
          for (let i = 0; i < n; i++) {
            const lane = i % 4;
            // Nearer lanes are bigger and lower down the ground plane
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
        lines: [
          'What was left of us did not band together.',
          'The convoys were the first thing worth taking — and the men with',
          'guns worked that out before anyone thought to share the road.',
        ],
        draw: (g, t, k) => {
          sky(g, t, 0x1c1410, 0x5c2c14);
          skyline(g, t, 0.9, t * 4 + 300);
          ground(g);
          // A burning convoy: wrecked trucks, fire, smoke going up
          for (let v = 0; v < 3; v++) {
            const vx = 170 + v * 300;
            const s = 2.0;
            const gyv = horizon + 70 + v * 26;
            g.fillStyle(0x171a14, 1);
            g.fillRect(vx - 46 * s, gyv - 16 * s, 92 * s, 14 * s);
            g.fillRect(vx + 18 * s, gyv - 30 * s, 34 * s, 16 * s);
            for (const wx of [vx - 30 * s, vx + 30 * s]) {
              g.fillStyle(0x0a0806, 1);
              g.fillCircle(wx, gyv, 8 * s);
            }
            // Fire licking out of the cab, and its glow on the ground
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
                g.fillEllipse(vx + 26 * s + Math.sin(t * 0.6 + sm) * (6 + sm * 5), yy,
                  38 + sm * 20, 26 + sm * 12);
              }
            }
          }
          // Silhouettes picking over the wreck
          for (let i = 0; i < 5; i++) {
            const x = 120 + i * 190 + Math.sin(t * 0.5 + i) * 12;
            drawUndead(g, x, floor - 14, t, 900 + i * 5, 1.9, i % 2 ? 1 : -1, 'shambler', CROWD, 1);
          }
        },
      },

      // ── 3. The warlords ──────────────────────────────────────────────────
      {
        hold: 8,
        lines: [
          'They call themselves factions now. They hold ground, fly colours,',
          'and put anti-aircraft guns on the ridgelines, because the roads',
          'were never the only way through.',
        ],
        draw: (g, t, k) => {
          sky(g, t, 0x140f14, 0x50241a);
          ground(g);
          // A ridge of banners and gun positions, rising into frame
          const rise = (1 - k) * 90;
          for (let i = 0; i < 5; i++) {
            const bx = 120 + i * 190;
            const by = horizon + 22 + rise;
            // Banner on a pole
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
            // Crew holding the position, in their own colours
            const pal = garrisonPalette([0x7a1a12, 0x2a4a6a, 0x3a6a2a, 0x7a5a18, 0x5a2a5a][i]);
            for (let m = 0; m < 3; m++) {
              drawFighter(g, bx + 26 + m * 20, by, t, i * 17 + m * 3, 1.05,
                m === 1 ? -1 : 1, m === 2 ? 'patrol' : 'stand', 0, 0.4, pal);
            }
          }
          // An AA gun in the foreground, barrels tracking something overhead
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
          // Gun crew: layer and loader, working it
          drawFighter(g, gx + 62, gy, t, 71, 1.25, -1, 'crouch', aim, 0.4, RAIDER_PALETTE);
          drawFighter(g, gx + 92, gy, t, 73, 1.3, -1, 'work', 0, 0.4, RAIDER_PALETTE);

          // It fires, and the muzzle flash lights the whole tableau
          const shoot = (t * 0.7) % 3 < 0.09;
          if (shoot) {
            const mx = gx + Math.cos(aim) * 92, my = gy - 46 + Math.sin(aim) * 92;
            drawMuzzleFlash(g, mx, my, aim, 1, 9);
            g.fillStyle(0xffd070, 0.05); g.fillRect(0, 0, width, height * TEXT_BAND);
          }
        },
      },

      // ── 4. You ───────────────────────────────────────────────────────────
      {
        hold: 9,
        lines: [
          'So the cargo went up.',
          '',
          'You fly it. Over the horde, over the guns, into strips ringed with',
          'wire and men who shoot first. Nobody else will.',
        ],
        draw: (g, t, k) => {
          sky(g, t, 0x101a2c, 0x8a5a26);
          // Sun low on the horizon
          g.fillStyle(0xffb060, 0.16); g.fillCircle(width * 0.74, horizon - 74, 96);
          g.fillStyle(0xffd08a, 0.85); g.fillCircle(width * 0.74, horizon - 74, 34);
          skyline(g, t, 0.85, t * 3 + 700);
          ground(g);
          // The wire and the guarded gate the flight scene now draws for real
          g.lineStyle(2.5, 0x1e1810, 1);
          for (let i = 0; i < 26; i++) {
            const px = 20 + i * 40;
            g.lineBetween(px, horizon + 54, px, horizon + 2);
          }
          for (let r = 0; r < 3; r++) {
            g.lineStyle(1.2, 0x2a2218, 0.9);
            g.lineBetween(0, horizon + 6 + r * 11, width, horizon + 10 + r * 11);
          }
          drawHorde(g, width * 0.16, floor - 18, 300, 14, t, 41, CROWD, 1, 1.7);
          // Garrison on the inside of the wire
          for (let i = 0; i < 4; i++) {
            const mx = width * 0.60 + i * 78;
            drawFighter(g, mx, floor - 16, t, 200 + i * 11, 1.35,
              -1, i % 2 ? 'patrol' : 'stand', 0, 0.4, garrisonPalette(0x4a90d9));
          }
          // The aircraft crossing the sun, climbing away
          const px = -120 + k * (width + 260);
          const py = horizon - 110 - Math.sin(k * Math.PI) * 70;
          this.drawPlane(g, px, py, 1.9, t);
        },
      },
    ];
  }

  /** A cargo aircraft in silhouette, prop turning, trailing exhaust. */
  private drawPlane(g: Phaser.GameObjects.Graphics, cx: number, cy: number, s: number, t: number): void {
    const hull = 0x100d09;
    const P = (lx: number, ly: number): { x: number; y: number } => ({ x: cx + lx * s, y: cy + ly * s });
    const poly = (pts: Array<[number, number]>, col: number, a = 1): void => {
      g.fillStyle(col, a);
      g.fillPoints(pts.map(([lx, ly]) => P(lx, ly)), true);
    };

    for (let e = 1; e <= 4; e++) {
      const p = P(-40 - e * 12, -1);
      g.fillStyle(0x2a2620, 0.14 / e);
      g.fillEllipse(p.x, p.y, (14 + e * 9) * s, (7 + e * 4) * s);
    }
    poly([[-26, -3], [-46, -8], [-46, -4], [-26, 1]], hull);            // tailplane
    poly([[-28, -6], [-38, -30], [-27, -29], [-20, -6]], hull);         // fin
    poly([
      [34, 0], [29, -6], [6, -9], [-20, -8], [-33, -4],
      [-35, 1], [-17, 7], [9, 7], [28, 4],
    ], hull);                                                           // fuselage
    poly([[10, -9], [-14, -14], [-27, -11], [-3, -6]], hull);           // high wing
    poly([[28, -5], [16, -8], [15, -3], [27, -2]], 0x6a8a9a, 0.7);      // glazing
    for (const ex of [0, -13]) {
      poly([[ex + 14, -11], [ex + 2, -12.5], [ex - 1, -8.5], [ex + 13, -7]], 0x080706);
      const at = P(ex + 15.5, -9.5), r = 13 * s;
      g.fillStyle(0xc8d0d8, 0.1);
      g.fillEllipse(at.x, at.y, r * 0.5, r * 1.9);
      const a = t * 42 + ex;
      g.lineStyle(1.2, 0xdfe6ec, 0.25);
      g.lineBetween(at.x, at.y, at.x + Math.cos(a) * r * 0.26, at.y + Math.sin(a) * r * 0.95);
    }
    // Navigation strobe
    if ((t * 1.2) % 1 < 0.06) {
      const f = P(-36, -30);
      g.fillStyle(0xffffff, 0.9); g.fillCircle(f.x, f.y, 2.4 * s);
      g.fillStyle(0xffffff, 0.22); g.fillCircle(f.x, f.y, 9 * s);
    }
  }
}
