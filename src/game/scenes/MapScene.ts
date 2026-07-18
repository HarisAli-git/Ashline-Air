import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
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
  }

  update(_time: number, delta: number): void {
    this.t += delta / 1000;
    const { width, height } = this.cameras.main;
    const save = SaveService.get();
    const settlements: SettlementDefinition[] = window.gameData.settlements;
    const unlocked = save.player.unlockedSettlementIds;

    // Animated dashed routes
    this.routeGfx.clear();
    const offset = (this.t * 14) % 16;
    const pairs = this.routePairs(settlements, unlocked);
    for (const [a, b] of pairs) {
      this.dashedLine(this.routeGfx, a.position.x, a.position.y, b.position.x, b.position.y, 7, 9, offset);
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

  private drawTerrain(width: number, height: number): void {
    const g = this.add.graphics();

    // Aged-chart background wash
    g.fillGradientStyle(0x14100a, 0x120e08, 0x0d0a05, 0x0f0c06, 1);
    g.fillRect(0, 0, width, height);

    // Fine survey grid
    g.lineStyle(1, 0x241c10, 0.5);
    for (let x = 0; x < width; x += 50) g.lineBetween(x, 0, x, height);
    for (let y = 0; y < height; y += 50) g.lineBetween(0, y, width, y);

    // Mountain ridge chains (chevron clusters)
    const ridges: Array<[number, number, number, number]> = [
      [80, 120, 7, 0], [430, 90, 5, 0.3], [720, 140, 6, -0.2],
      [150, 520, 5, 0.2], [560, 470, 4, -0.3], [880, 300, 6, 0.1],
      [340, 260, 4, 0.15],
    ];
    g.lineStyle(1.5, 0x3a2d18, 0.8);
    for (const [rx, ry, n, slope] of ridges) {
      for (let i = 0; i < n; i++) {
        const cx = rx + i * 26;
        const cy = ry + i * slope * 26;
        const h = 9 + ((i * 7) % 6);
        g.lineBetween(cx - 9, cy, cx, cy - h);
        g.lineBetween(cx, cy - h, cx + 9, cy);
      }
    }

    // Dry riverbed meandering across the chart
    g.lineStyle(2, 0x2c2312, 0.9);
    g.beginPath();
    g.moveTo(-10, 430);
    for (let x = 0; x <= width + 10; x += 24) {
      g.lineTo(x, 430 + Math.sin(x * 0.011) * 46 + Math.sin(x * 0.031) * 14);
    }
    g.strokePath();
    g.lineStyle(1, 0x2c2312, 0.5);
    g.beginPath();
    g.moveTo(-10, 438);
    for (let x = 0; x <= width + 10; x += 24) {
      g.lineTo(x, 438 + Math.sin(x * 0.011) * 46 + Math.sin(x * 0.031) * 14);
    }
    g.strokePath();

    // Salt flat + dune stipples
    g.fillStyle(0x261e10, 0.55);
    g.fillEllipse(640, 560, 260, 70);
    g.fillStyle(0x33270f, 0.5);
    for (let i = 0; i < 260; i++) {
      const sx = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const sy = (Math.sin(i * 78.233) * 12543.123) % 1;
      g.fillRect(Math.abs(sx) * width, 40 + Math.abs(sy) * (height - 80), 1.5, 1.5);
    }

    // Hazard hatching in the far corner (irradiated zone flavour)
    g.lineStyle(1, 0x4a2a10, 0.5);
    for (let i = 0; i < 14; i++) {
      g.lineBetween(width - 190 + i * 14, 40, width - 60 + i * 14, 170);
    }
    g.lineStyle(1, 0x5a3a18, 0.7);
    g.strokeCircle(width - 90, 105, 52);
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
  ): void {
    const len = Phaser.Math.Distance.Between(x1, y1, x2, y2);
    const nx = (x2 - x1) / len, ny = (y2 - y1) / len;
    g.lineStyle(1.5, 0x8a6a3a, 0.55);
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

    const label = this.add.text(0, 22, settlement.name, {
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
