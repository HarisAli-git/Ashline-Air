import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { EconomyService } from '../../services/EconomyService';
import { ContractService } from '../../services/ContractService';
import { EventBus } from '../utils/EventBus';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' });
  }

  create(): void {
    const { width, height } = this.cameras.main;
    const cx = width / 2;

    // Background
    this.cameras.main.setBackgroundColor('#1a1208');

    // Title
    this.add
      .text(cx, height * 0.25, 'ASHLINE AIR', {
        fontSize: '56px',
        color: '#e8d5b7',
        fontFamily: 'monospace',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, height * 0.35, 'Cargo pilots at the end of the world', {
        fontSize: '18px',
        color: '#8a7a5a',
        fontFamily: 'monospace',
        fontStyle: 'italic',
      })
      .setOrigin(0.5);

    // New Game button — builds a fresh save and goes straight to the map
    this.makeButton(cx, height * 0.52, 'NEW GAME', () => {
      SaveService.deleteSave();
      const save = SaveService.load();
      save.world.settlements = EconomyService.initialise(window.gameData.settlements);
      save.world.availableContracts = ContractService.refreshBoard(
        window.gameData.settlements,
        save.player.unlockedSettlementIds,
        save.player.reputation,
        save.world.gameTimestamp
      );
      SaveService.save(save.player, save.world);
      this.scene.start('MapScene');
    });

    // Continue button — only enabled when a save exists
    if (SaveService.hasSave()) {
      this.makeButton(cx, height * 0.62, 'CONTINUE', () => {
        EventBus.emit('scene:return-to-map');
        this.scene.start('MapScene');
      });
    } else {
      this.add
        .text(cx, height * 0.62, 'CONTINUE', {
          fontSize: '22px',
          color: '#4a4030',
          fontFamily: 'monospace',
        })
        .setOrigin(0.5);
    }

    // Version tag
    this.add
      .text(width - 12, height - 12, 'v0.1.0 MVP', {
        fontSize: '12px',
        color: '#4a4030',
        fontFamily: 'monospace',
      })
      .setOrigin(1, 1);
  }

  private makeButton(x: number, y: number, label: string, onClick: () => void): Phaser.GameObjects.Text {
    const text = this.add
      .text(x, y, label, {
        fontSize: '22px',
        color: '#e8d5b7',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    text.on('pointerover', () => text.setStyle({ color: '#ffd080' }));
    text.on('pointerout',  () => text.setStyle({ color: '#e8d5b7' }));
    text.on('pointerdown', onClick);

    return text;
  }
}
