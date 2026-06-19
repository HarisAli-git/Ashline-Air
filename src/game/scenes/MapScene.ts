import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { EventBus } from '../utils/EventBus';
import type { SettlementDefinition } from '../../types';

const MAP_WIDTH  = 1000;
const MAP_HEIGHT = 600;

export class MapScene extends Phaser.Scene {
  private settlementMarkers: Phaser.GameObjects.Container[] = [];

  constructor() {
    super({ key: 'MapScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0d1a0d');

    const save = SaveService.get();
    const settlements: SettlementDefinition[] = window.gameData.settlements;

    this.drawMap(settlements, save.player.unlockedSettlementIds);

    // UI: player money in top-right — stays in sync with earnings from flights
    const moneyText = this.add.text(this.cameras.main.width - 16, 16,
      `₢ ${save.player.money.toLocaleString()}`, {
        fontSize: '18px', color: '#ffd080', fontFamily: 'monospace',
      }
    ).setOrigin(1, 0);

    const unsubMoney = EventBus.on('player:money-changed', ({ amount }) => {
      moneyText.setText(`₢ ${amount.toLocaleString()}`);
    });
    this.events.once('shutdown', unsubMoney);
  }

  private drawMap(
    settlements: SettlementDefinition[],
    unlockedIds: string[]
  ): void {
    const { width, height } = this.cameras.main;

    // Simple grid background to suggest terrain
    const graphics = this.add.graphics();
    graphics.lineStyle(1, 0x1a2a1a, 0.4);
    for (let x = 0; x < width; x += 50) {
      graphics.lineBetween(x, 0, x, height);
    }
    for (let y = 0; y < height; y += 50) {
      graphics.lineBetween(0, y, width, y);
    }

    // Draw settlement markers
    for (const settlement of settlements) {
      const unlocked = unlockedIds.includes(settlement.id);
      const container = this.createMarker(settlement, unlocked);
      this.settlementMarkers.push(container);
    }
  }

  private createMarker(
    settlement: SettlementDefinition,
    unlocked: boolean
  ): Phaser.GameObjects.Container {
    const { x, y } = settlement.position;
    const container = this.add.container(x, y);

    // Faction colour lookup
    const faction = window.gameData.factions.find(f => f.id === settlement.factionId);
    const colorHex = faction ? parseInt(faction.color.replace('#', ''), 16) : 0x888888;

    // Dot
    const dot = this.add.graphics();
    dot.fillStyle(unlocked ? colorHex : 0x444444, 1);
    dot.fillCircle(0, 0, 10);
    dot.lineStyle(2, 0xffffff, unlocked ? 0.6 : 0.2);
    dot.strokeCircle(0, 0, 10);

    // Label
    const label = this.add.text(0, 16, settlement.name, {
      fontSize: '12px',
      color: unlocked ? '#e8d5b7' : '#4a4030',
      fontFamily: 'monospace',
    }).setOrigin(0.5, 0);

    container.add([dot, label]);

    if (unlocked) {
      container.setInteractive(
        new Phaser.Geom.Circle(0, 0, 18),
        Phaser.Geom.Circle.Contains
      );

      container.on('pointerover', () => {
        dot.clear();
        dot.fillStyle(0xffd080, 1);
        dot.fillCircle(0, 0, 12);
        this.showTooltip(settlement);
      });

      container.on('pointerout', () => {
        dot.clear();
        dot.fillStyle(colorHex, 1);
        dot.fillCircle(0, 0, 10);
        dot.lineStyle(2, 0xffffff, 0.6);
        dot.strokeCircle(0, 0, 10);
        this.hideTooltip();
      });

      container.on('pointerdown', () => {
        EventBus.emit('scene:open-preflight', { settlementId: settlement.id });
        this.scene.start('PreFlightScene', { settlementId: settlement.id });
      });
    }

    return container;
  }

  private tooltip: Phaser.GameObjects.Container | null = null;

  private showTooltip(settlement: SettlementDefinition): void {
    this.hideTooltip();
    const faction = window.gameData.factions.find(f => f.id === settlement.factionId);
    const lines = [
      settlement.name,
      `Faction: ${faction?.name ?? 'Unknown'}`,
      `Population: ${settlement.population.toLocaleString()}`,
      `Security: ${settlement.securityLevel}/10`,
    ];

    const { width, height } = this.cameras.main;
    const tx = Math.min(settlement.position.x + 24, width - 160);
    const ty = Math.min(settlement.position.y - 20, height - 100);

    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.8);
    bg.fillRect(0, 0, 150, lines.length * 18 + 12);

    const texts = lines.map((line, i) =>
      this.add.text(8, 6 + i * 18, line, {
        fontSize: '12px',
        color: '#e8d5b7',
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
