import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { ProgressionService } from '../../services/ProgressionService';
import { DevService } from '../../services/DevService';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { ensureSharedTextures } from '../entities/aircraft/render/AircraftPainter';
import { SoundEngine } from '../audio/SoundEngine';
import { distance, pixelsToKm } from '../utils/math';
import type { SettlementDefinition } from '../../types';

const KM_PER_PIXEL = 0.5;

interface Mote { x: number; y: number; alpha: number; sz: number; vx: number; vy: number; }

/**
 * The wasteland chart: hand-drawn-style terrain, faction territory glows,
 * dashed trade routes with distances, pulsing settlement markers, a compass
 * rose and a live header (funds, world clock, aircraft status).
 */
export class MapScene extends Phaser.Scene {
  private routeGfx!: Phaser.GameObjects.Graphics;
  private animGfx!: Phaser.GameObjects.Graphics;
  private motes: Mote[] = [];
  private t = 0;

  constructor() {
    super({ key: 'MapScene' });
  }

  create(): void {
    const { width, height } = this.cameras.main;
    this.cameras.main.setBackgroundColor('#0e0b06');
    fadeIn(this);
    SoundEngine.startAmbient();
    ensureSharedTextures(this);
    this.motes = [];
    this.t = 0;

    const save = SaveService.get();
    const settlements: SettlementDefinition[] = window.gameData.settlements;
    const unlocked = save.player.unlockedSettlementIds;

    this.drawTerrain(width, height);
    this.drawTerritories(settlements, unlocked);

    // Trade routes (animated dashes drawn per frame)
    this.routeGfx = this.add.graphics();
    this.drawRouteLabels(settlements, unlocked);

    for (const settlement of settlements) {
      this.createMarker(settlement, unlocked.includes(settlement.id));
    }

    this.drawChrome(width, height, save.world.gameTimestamp);
    this.seedMotes(width, height);
    this.animGfx = this.add.graphics();

    // The chart is built once in create() from the save, so anything that
    // changes the save behind it — buying an aircraft, servicing, the dev
    // unlock — leaves stale markers, a stale header and settlements still
    // showing LOCKED. Rebuild when the hangar hands control back.
    const rebuild = (): void => {
      if (this.scene.isActive()) this.scene.restart();
    };
    const unsubs = [
      EventBus.on('ui:close-hangar', rebuild),
      EventBus.on('player:settlement-unlocked', rebuild),
    ];
    this.events.once('shutdown', () => unsubs.forEach(u => u()));
  }

  update(_time: number, delta: number): void {
    this.t += delta / 1000;
    const { width, height } = this.cameras.main;
    const save = SaveService.get();
    const settlements: SettlementDefinition[] = window.gameData.settlements;
    const unlocked = save.player.unlockedSettlementIds;

    // Animated dashed routes. The legs you can actually fly right now — the
    // ones leaving your current field — are drawn live; the rest are faint,
    // so the chart reads as "here is where you can go from here".
    this.routeGfx.clear();
    const offset = (this.t * 14) % 16;
    const hereId = save.player.currentLocationId;
    const pairs = this.routePairs(settlements, unlocked);
    for (const [a, b] of pairs) {
      const flyable = a.id === hereId || b.id === hereId;
      this.dashedLine(
        this.routeGfx, a.position.x, a.position.y, b.position.x, b.position.y,
        7, 9, offset, flyable,
      );
    }

    // Drifting dust motes
    this.animGfx.clear();
    for (const m of this.motes) {
      m.x += m.vx; m.y += m.vy;
      if (m.x < 0) m.x += width; else if (m.x > width) m.x -= width;
      if (m.y < 40) m.y = height - 20; else if (m.y > height) m.y = 40;
      this.animGfx.fillStyle(0xdd9944, m.alpha);
      this.animGfx.fillRect(m.x, m.y, m.sz, m.sz);
    }
  }

  // ── Terrain & decoration ───────────────────────────────────────────────────

  /**
   * The chart as a physical object: a survey sheet lying on a hangar table
   * under one lamp.
   *
   * It used to be a flat wash plus a grid plus a handful of chevrons at
   * hardcoded coordinates — which, now that the canvas is device-shaped, also
   * meant the "mountains" bunched into a corner on a wide screen and fell off
   * the edge on a narrow one. Everything here is derived from width/height and
   * from one seeded RNG, so the same chart is drawn at any size.
   *
   * The direction is a single warm light source. A lamp pool sits off-centre,
   * everything falls into shadow toward the corners, and — the part that makes
   * it read as PAPER rather than a dark rectangle — the grid, the ink and the
   * grain all fade with distance from that lamp. Flat lighting is what made it
   * look like a screen; one light makes it look like a thing on a table.
   */
  private drawTerrain(width: number, height: number): void {
    const g = this.add.graphics();
    const rnd = mulberry32(0x5eed); // one seed: the wasteland is always the same

    // The lamp: off-centre, high and left, the way a task lamp actually sits.
    const lampX = width * 0.34, lampY = height * 0.30;
    const lampR = Math.hypot(width, height) * 0.62;
    /** 1 in the middle of the pool, 0 out in the corners. */
    const lit = (x: number, y: number): number =>
      Phaser.Math.Clamp(1 - Math.hypot(x - lampX, y - lampY) / lampR, 0, 1);

    // ── Paper ────────────────────────────────────────────────────────────
    g.fillStyle(0x151009, 1);
    g.fillRect(0, 0, width, height);
    // Lamp pool, built from concentric ellipses so it is a real gradient
    for (let i = 26; i >= 1; i--) {
      const t = i / 26;
      g.fillStyle(0x8a7038, 0.052 * (1 - t) + 0.005);
      g.fillEllipse(lampX, lampY, lampR * 2.05 * t, lampR * 1.62 * t);
    }
    // A hot core right under the bulb, or the pool reads as a flat wash
    for (let i = 8; i >= 1; i--) {
      g.fillStyle(0xc9a45a, 0.020);
      g.fillEllipse(lampX, lampY, lampR * 0.30 * (i / 8), lampR * 0.23 * (i / 8));
    }

    // Paper grain — coarse in the light, lost in the shadow
    for (let i = 0; i < 1500; i++) {
      const x = rnd() * width, y = rnd() * height;
      const l = lit(x, y);
      if (l < 0.06) continue;
      g.fillStyle(rnd() < 0.5 ? 0x6f5f3c : 0x0d0a05, 0.05 + l * 0.09);
      g.fillRect(x, y, 1.3, 1.3);
    }

    // ── Fold creases: the signature. A crease is a dark valley with a lit
    // ridge beside it, which is the whole reason it reads as folded paper.
    const crease = (x1: number, y1: number, x2: number, y2: number): void => {
      const steps = 34;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps, t1 = (i + 1) / steps;
        const ax = x1 + (x2 - x1) * t0, ay = y1 + (y2 - y1) * t0;
        const bx = x1 + (x2 - x1) * t1, by = y1 + (y2 - y1) * t1;
        const l = lit((ax + bx) / 2, (ay + by) / 2);
        g.lineStyle(2.2, 0x080603, 0.16 + l * 0.20);
        g.lineBetween(ax, ay, bx, by);
        g.lineStyle(1.1, 0xa08f63, 0.05 + l * 0.16);
        g.lineBetween(ax + 1.6, ay + 1.2, bx + 1.6, by + 1.2);
      }
    };
    crease(width * 0.335, 0, width * 0.352, height);
    crease(width * 0.678, 0, width * 0.661, height);
    crease(0, height * 0.507, width, height * 0.492);

    // ── Survey grid, lit ─────────────────────────────────────────────────
    const step = 54;
    for (let x = step; x < width; x += step) {
      for (let y = 0; y < height; y += 18) {
        const l = lit(x, y + 9);
        if (l < 0.04) continue;
        g.lineStyle(1, 0x544323, 0.08 + l * 0.50);
        g.lineBetween(x, y, x, y + 18);
      }
    }
    for (let y = step; y < height; y += step) {
      for (let x = 0; x < width; x += 18) {
        const l = lit(x + 9, y);
        if (l < 0.04) continue;
        g.lineStyle(1, 0x544323, 0.08 + l * 0.50);
        g.lineBetween(x, y, x + 18, y);
      }
    }

    // ── Relief: inked hachures, the way a survey sheet shows high ground ──
    const ranges = 7;
    for (let r = 0; r < ranges; r++) {
      const rx = width * (0.06 + rnd() * 0.88);
      const ry = height * (0.10 + rnd() * 0.78);
      const len = 5 + Math.floor(rnd() * 5);
      const slope = (rnd() - 0.5) * 0.7;
      const spacing = width * 0.026;
      for (let i = 0; i < len; i++) {
        const cx = rx + i * spacing;
        const cy = ry + i * slope * spacing;
        if (cx < 8 || cx > width - 8) continue;
        const h = 8 + ((i * 7) % 7);
        const l = lit(cx, cy);
        // Peak chevron
        g.lineStyle(1.7, 0x7a5f28, 0.34 + l * 0.66);
        g.lineBetween(cx - 9, cy, cx, cy - h);
        g.lineBetween(cx, cy - h, cx + 9, cy);
        // Hachures down the shaded flank — this is what gives the range mass
        g.lineStyle(1, 0x4a3a18, 0.20 + l * 0.46);
        for (let k = 1; k < 5; k++) {
          const hx = cx + k * 2.1;
          g.lineBetween(hx, cy - h + k * (h / 5), hx + 3.4, cy + 1);
        }
      }
    }

    // ── Dry riverbed, drawn across whatever width the chart happens to be ──
    const riverY = height * 0.70;
    const amp = height * 0.075;
    for (const [off, w, a] of [[0, 2, 0.85], [7, 1, 0.45]] as const) {
      g.beginPath();
      g.moveTo(-10, riverY + off);
      for (let x = -10; x <= width + 10; x += 22) {
        const y = riverY + off + Math.sin(x * 0.011) * amp + Math.sin(x * 0.031) * amp * 0.3;
        g.lineTo(x, y);
      }
      g.lineStyle(w, 0x33280f, a * (0.4 + lit(width / 2, riverY) * 0.6));
      g.strokePath();
    }

    // Salt flat
    g.fillStyle(0x2b2212, 0.45);
    g.fillEllipse(width * 0.63, height * 0.88, width * 0.26, height * 0.11);

    // ── Irradiated zone: hatched and ringed, pinned to the top-right ──────
    const zx = width - Math.min(140, width * 0.13), zy = height * 0.17;
    const zr = Math.min(56, height * 0.11);
    g.lineStyle(1, 0x6a3a14, 0.42);
    for (let i = -6; i <= 6; i++) {
      const o = i * 13;
      g.lineBetween(zx - zr + o, zy - zr, zx + zr + o, zy + zr);
    }
    g.lineStyle(1.4, 0x7a4a1c, 0.7);
    g.strokeCircle(zx, zy, zr);

    // ── Edges: the lamp cannot reach the corners ─────────────────────────
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      g.lineStyle(3, 0x000000, 0.055 * (1 - t));
      g.strokeRect(t * 26, t * 26, width - t * 52, height - t * 52);
    }
  }

  private drawTerritories(settlements: SettlementDefinition[], unlocked: string[]): void {
    for (const s of settlements) {
      const faction = window.gameData.factions.find(f => f.id === s.factionId);
      const color = faction ? parseInt(faction.color.replace('#', ''), 16) : 0x888888;
      const img = this.add.image(s.position.x, s.position.y, 'px_soft')
        .setScale(unlocked.includes(s.id) ? 11 : 7)
        .setTint(color)
        .setAlpha(unlocked.includes(s.id) ? 0.10 : 0.05);
      // Slow territorial "breathing"
      this.tweens.add({
        targets: img,
        alpha: img.alpha * 0.6,
        duration: 2600 + Math.random() * 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  private routePairs(
    settlements: SettlementDefinition[],
    unlocked: string[],
  ): Array<[SettlementDefinition, SettlementDefinition]> {
    const open = settlements.filter(s => unlocked.includes(s.id));
    const pairs: Array<[SettlementDefinition, SettlementDefinition]> = [];
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) pairs.push([open[i], open[j]]);
    }
    return pairs;
  }

  private dashedLine(
    g: Phaser.GameObjects.Graphics,
    x1: number, y1: number, x2: number, y2: number,
    dash: number, gap: number, offset: number,
    active = false,
  ): void {
    const len = Phaser.Math.Distance.Between(x1, y1, x2, y2);
    const nx = (x2 - x1) / len, ny = (y2 - y1) / len;
    g.lineStyle(active ? 2 : 1.2, active ? 0xffd080 : 0x8a6a3a, active ? 0.8 : 0.3);
    for (let d = -offset; d < len; d += dash + gap) {
      const a = Math.max(0, d), b = Math.min(len, d + dash);
      if (b <= a) continue;
      g.lineBetween(x1 + nx * a, y1 + ny * a, x1 + nx * b, y1 + ny * b);
    }
  }

  private drawRouteLabels(settlements: SettlementDefinition[], unlocked: string[]): void {
    for (const [a, b] of this.routePairs(settlements, unlocked)) {
      const km = Math.round(pixelsToKm(
        distance(a.position.x, a.position.y, b.position.x, b.position.y), KM_PER_PIXEL,
      ));
      const mx = (a.position.x + b.position.x) / 2;
      const my = (a.position.y + b.position.y) / 2;
      this.add.text(mx, my - 10, `${km} km`, {
        fontSize: '10px', color: '#6a5a3a', fontFamily: 'monospace',
        backgroundColor: '#0e0b06',
        padding: { x: 4, y: 2 },
      }).setOrigin(0.5);
    }
  }

  // ── Markers ────────────────────────────────────────────────────────────────

  private createMarker(settlement: SettlementDefinition, unlocked: boolean): void {
    const { x, y } = settlement.position;
    const container = this.add.container(x, y);

    const faction = window.gameData.factions.find(f => f.id === settlement.factionId);
    const colorHex = faction ? parseInt(faction.color.replace('#', ''), 16) : 0x888888;
    const isHere = ProgressionService.canDepartFrom(settlement.id);

    // ── "You are here": the aircraft's actual position on the chart ────────
    if (isHere) {
      const halo = this.add.graphics();
      halo.lineStyle(2, 0xffd080, 0.9);
      halo.strokeCircle(0, 0, 26);
      halo.lineStyle(1, 0xffd080, 0.35);
      halo.strokeCircle(0, 0, 33);
      // Bracket ticks, like a targeting reticle
      halo.lineStyle(2, 0xffd080, 0.9);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
        halo.lineBetween(dx * 26, dy * 26, dx * 34, dy * 26);
        halo.lineBetween(dx * 26, dy * 26, dx * 26, dy * 34);
      }
      container.add(halo);
      this.tweens.add({
        targets: halo, alpha: 0.45, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });

      const youAreHere = this.add.text(0, -42, '✈  YOU ARE HERE', {
        fontSize: '11px', color: '#ffd080', fontFamily: 'monospace',
        fontStyle: 'bold', letterSpacing: 1,
        backgroundColor: '#0a0804', padding: { x: 6, y: 3 },
      }).setOrigin(0.5);
      container.add(youAreHere);
    }

    // Pulse ring (unlocked only)
    if (unlocked) {
      const ring = this.add.circle(0, 0, 11).setStrokeStyle(1.5, colorHex, 0.8);
      container.add(ring);
      this.tweens.add({
        targets: ring,
        scale: 2.1,
        alpha: 0,
        duration: 1800,
        repeat: -1,
        ease: 'Sine.easeOut',
      });
    }

    // Marker: fortified-town glyph — dot + wall ticks
    const dot = this.add.graphics();
    const drawDot = (hover: boolean): void => {
      dot.clear();
      dot.fillStyle(hover ? 0xffd080 : unlocked ? colorHex : 0x3a3a34, 1);
      dot.fillCircle(0, 0, hover ? 12 : 10);
      dot.lineStyle(2, 0xffffff, unlocked ? 0.6 : 0.15);
      dot.strokeCircle(0, 0, hover ? 12 : 10);
      // Wall ticks around the town
      dot.lineStyle(1.5, hover ? 0xffd080 : unlocked ? colorHex : 0x3a3a34, 0.8);
      for (let a = 0; a < 8; a++) {
        const rad = (a / 8) * Math.PI * 2;
        dot.lineBetween(
          Math.cos(rad) * 15, Math.sin(rad) * 15,
          Math.cos(rad) * 18, Math.sin(rad) * 18,
        );
      }
    };
    drawDot(false);

    // The position reticle reaches ±34, so the name has to clear it
    const label = this.add.text(0, isHere ? 38 : 22, settlement.name, {
      fontSize: '12px',
      color: unlocked ? '#e8d5b7' : '#4a4030',
      fontFamily: 'monospace',
    }).setOrigin(0.5, 0);

    container.add([dot, label]);

    if (!unlocked) {
      const lock = this.add.text(0, -24, 'LOCKED', {
        fontSize: '9px', color: '#4a4030', fontFamily: 'monospace', letterSpacing: 2,
      }).setOrigin(0.5);
      container.add(lock);
      return;
    }

    container.setInteractive(new Phaser.Geom.Circle(0, 0, 20), Phaser.Geom.Circle.Contains);
    container.on('pointerover', () => { drawDot(true); this.showTooltip(settlement); });
    container.on('pointerout', () => { drawDot(false); this.hideTooltip(); });
    container.on('pointerdown', () => {
      // Contracts leave from where the aircraft actually is. Clicking a
      // settlement you are not standing at used to silently teleport you
      // there and fly its board, which made the whole chart meaningless.
      if (!ProgressionService.canDepartFrom(settlement.id)) {
        SoundEngine.warn();
        const here = ProgressionService.currentLocation();
        EventBus.emit('ui:show-notification', {
          message: `Your aircraft is at ${here?.name ?? 'another field'} — fly a contract to ${settlement.name} to move it.`,
          type: 'warning',
        });
        return;
      }
      SoundEngine.click();
      EventBus.emit('scene:open-preflight', { settlementId: settlement.id });
      fadeToScene(this, 'PreFlightScene', { settlementId: settlement.id });
    });
  }

  // ── Chrome: header, compass, scale bar ─────────────────────────────────────

  private drawChrome(width: number, height: number, gameTimestamp: number): void {
    const save = SaveService.get();
    const { owned, def } = SaveService.getActiveAircraft();

    // Header bar
    const bar = this.add.graphics();
    bar.fillStyle(0x0a0804, 0.85);
    bar.fillRect(0, 0, width, 34);
    bar.lineStyle(1, 0x3a2a10, 1);
    bar.lineBetween(0, 34, width, 34);

    this.add.text(14, 17, 'WASTELAND CHART', {
      fontSize: '13px', color: '#ffd080', fontFamily: 'monospace', fontStyle: 'bold', letterSpacing: 3,
    }).setOrigin(0, 0.5);

    const day = Math.floor(gameTimestamp / 1440) + 1;
    const hh = String(Math.floor((gameTimestamp % 1440) / 60)).padStart(2, '0');
    const mm = String(gameTimestamp % 60).padStart(2, '0');
    this.add.text(width / 2, 17, `DAY ${day} · ${hh}:${mm}`, {
      fontSize: '12px', color: '#8a7a5a', fontFamily: 'monospace',
    }).setOrigin(0.5);

    const status = `${def.name}  ⛽${Math.round((owned.fuel / def.stats.fuelCapacity) * 100)}%  ⚙${Math.round(owned.integrity)}%`;
    this.add.text(width - 170, 17, status, {
      fontSize: '11px', color: '#8a7a5a', fontFamily: 'monospace',
    }).setOrigin(1, 0.5);

    const moneyText = this.add.text(width - 16, 17, `₢ ${save.player.money.toLocaleString()}`, {
      fontSize: '15px', color: '#ffd080', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0.5);
    const unsubMoney = EventBus.on('player:money-changed', ({ amount }) => {
      moneyText.setText(`₢ ${amount.toLocaleString()}`);
    });
    this.events.once('shutdown', unsubMoney);

    // Compass rose
    const cg = this.add.graphics();
    const cx = width - 60, cy = height - 70;
    cg.lineStyle(1, 0x5a4a20, 0.8);
    cg.strokeCircle(cx, cy, 26);
    cg.strokeCircle(cx, cy, 20);
    cg.lineStyle(1.5, 0x8a6a3a, 0.9);
    cg.lineBetween(cx, cy + 22, cx, cy - 22);
    cg.lineBetween(cx - 22, cy, cx + 22, cy);
    cg.fillStyle(0xffd080, 0.9);
    cg.fillTriangle(cx - 4, cy - 14, cx + 4, cy - 14, cx, cy - 26);
    this.add.text(cx, cy - 38, 'N', {
      fontSize: '11px', color: '#ffd080', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // ── Hangar: the only place the money you earn has to go ────────────────
    const hangarBtn = this.add.text(width - 16, 52, '⌂  HANGAR', {
      fontSize: '13px', color: '#ffd080', fontFamily: 'monospace',
      backgroundColor: '#1a1409', padding: { x: 10, y: 5 },
    }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
    hangarBtn.on('pointerover', () => hangarBtn.setStyle({ color: '#fff0c0' }));
    hangarBtn.on('pointerout',  () => hangarBtn.setStyle({ color: '#ffd080' }));
    hangarBtn.on('pointerdown', () => {
      SoundEngine.click();
      EventBus.emit('ui:open-hangar');
    });

    // DEV: grant everything, so the later content can be inspected without
    // playing thirty contracts to reach it.
    if (DevService.enabled) {
      const devBtn = this.add.text(width - 16, 78, 'DEV: UNLOCK ALL', {
        fontSize: '11px', color: '#88ccff', fontFamily: 'monospace',
        backgroundColor: '#0d1420', padding: { x: 8, y: 4 },
      }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
      devBtn.on('pointerdown', () => {
        SoundEngine.click();
        EventBus.emit('ui:show-notification', {
          message: DevService.unlockEverything(), type: 'success',
        });
        this.scene.restart();
      });
      this.input.keyboard?.on('keydown-U', () => {
        EventBus.emit('ui:show-notification', {
          message: DevService.unlockEverything(), type: 'success',
        });
        this.scene.restart();
      });
    }

    // Standing orders: where you are, and what the next destination wants
    const here = ProgressionService.currentLocation(save);
    this.add.text(20, 52, `POSITION:  ${(here?.name ?? 'UNKNOWN').toUpperCase()}`, {
      fontSize: '12px', color: '#ffd080', fontFamily: 'monospace', letterSpacing: 1,
    }).setOrigin(0, 0.5);
    const hint = ProgressionService.nextUnlockHint(save);
    this.add.text(20, 70, hint ? `LOCKED:  ${hint}` : 'All destinations open.', {
      fontSize: '11px', color: '#6a5a3a', fontFamily: 'monospace',
    }).setOrigin(0, 0.5);

    // Scale bar
    const sg = this.add.graphics();
    const sx = 20, sy = height - 28;
    const barPx = 100 / KM_PER_PIXEL / 2; // 100 km at map scale, halved to fit
    sg.lineStyle(2, 0x8a6a3a, 0.9);
    sg.lineBetween(sx, sy, sx + barPx, sy);
    sg.lineBetween(sx, sy - 4, sx, sy + 4);
    sg.lineBetween(sx + barPx, sy - 4, sx + barPx, sy + 4);
    this.add.text(sx + barPx / 2, sy - 8, '50 km', {
      fontSize: '10px', color: '#6a5a3a', fontFamily: 'monospace',
    }).setOrigin(0.5, 1);

    // Border frame
    const fg = this.add.graphics();
    fg.lineStyle(1, 0x3a2a10, 0.9);
    fg.strokeRect(6, 40, width - 12, height - 46);
  }

  private seedMotes(width: number, height: number): void {
    for (let i = 0; i < 26; i++) {
      this.motes.push({
        x: Phaser.Math.FloatBetween(0, width),
        y: Phaser.Math.FloatBetween(40, height),
        alpha: Phaser.Math.FloatBetween(0.03, 0.1),
        sz: Phaser.Math.FloatBetween(1, 2.5),
        vx: Phaser.Math.FloatBetween(0.05, 0.25),
        vy: Phaser.Math.FloatBetween(-0.08, 0.08),
      });
    }
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  private tooltip: Phaser.GameObjects.Container | null = null;

  private showTooltip(settlement: SettlementDefinition): void {
    this.hideTooltip();
    const save = SaveService.get();
    const faction = window.gameData.factions.find(f => f.id === settlement.factionId);
    const rep = save.player.reputation.find(r => r.factionId === settlement.factionId)?.points ?? 0;
    const contracts = save.world.availableContracts.filter(
      c => c.originId === settlement.id && c.status === 'available',
    ).length;
    const lines = [
      settlement.name.toUpperCase(),
      `${faction?.name ?? 'Unknown'} · rep ${rep}`,
      `Population: ${settlement.population.toLocaleString()}`,
      `Security: ${settlement.securityLevel}/10`,
      `Contracts: ${contracts}`,
      ProgressionService.canDepartFrom(settlement.id)
        ? '▸ YOUR AIRCRAFT IS HERE'
        : '· fly a contract here to move',
    ];

    const { width, height } = this.cameras.main;
    const tx = Math.min(settlement.position.x + 26, width - 190);
    const ty = Math.min(Math.max(settlement.position.y - 24, 44), height - 120);

    const bg = this.add.graphics();
    bg.fillStyle(0x0a0804, 0.92);
    bg.fillRect(0, 0, 178, lines.length * 17 + 12);
    bg.lineStyle(1, 0x5a4a20, 0.8);
    bg.strokeRect(0, 0, 178, lines.length * 17 + 12);

    const texts = lines.map((line, i) =>
      this.add.text(8, 6 + i * 17, line, {
        fontSize: '11px',
        color: i === 0 ? '#ffd080' : '#c8b888',
        fontFamily: 'monospace',
      })
    );

    this.tooltip = this.add.container(tx, ty, [bg, ...texts]);
  }

  private hideTooltip(): void {
    this.tooltip?.destroy();
    this.tooltip = null;
  }
}

/** Deterministic RNG: the wasteland is drawn the same way every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
