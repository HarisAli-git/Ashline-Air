import Phaser from 'phaser';
import { loadAllGameData, type GameData } from '../utils/DataLoader';
import { SaveService } from '../../services/SaveService';
import { EconomyService } from '../../services/EconomyService';
import { ContractService } from '../../services/ContractService';
import { FlightEventService } from '../../services/FlightEventService';

declare global {
  interface Window {
    gameData: GameData;
  }
}

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  // All aircraft/world art is generated procedurally at runtime — no image
  // assets to preload. Shared effect textures are baked lazily by the
  // renderer (ensureSharedTextures / ensureAircraftTextures, guarded by
  // textures.exists so React StrictMode double-mounts are safe).

  async create(): Promise<void> {
    this.add
      .text(this.cameras.main.centerX, this.cameras.main.centerY, 'Loading...', {
        fontSize: '24px',
        color: '#e8d5b7',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);

    try {
      const gameData = await loadAllGameData();

      // React StrictMode mounts, unmounts, and remounts the game; if this
      // instance was destroyed while data was in flight, silently bail out.
      if (!this.sys.game || !this.scene?.manager) return;

      // Make data globally accessible for services and scenes
      window.gameData = gameData;

      // Boot services in order
      ContractService.initialise(gameData.goods);
      FlightEventService.initialise(gameData.events);

      const save = SaveService.load();

      // Build settlement runtime states if missing from save
      if (save.world.settlements.length === 0) {
        save.world.settlements = EconomyService.initialise(gameData.settlements);
      }

      // Generate initial contract board if empty
      if (save.world.availableContracts.length === 0) {
        save.world.availableContracts = ContractService.refreshBoard(
          gameData.settlements,
          save.player.unlockedSettlementIds,
          save.player.reputation,
          save.world.gameTimestamp
        );
      }

      this.scene.start('MenuScene');
    } catch (err) {
      if (!this.sys.game || !this.scene?.manager) return; // destroyed mid-boot
      console.error('[BootScene] Failed to initialise:', err);
      this.add
        .text(this.cameras.main.centerX, this.cameras.main.centerY + 40, 'Failed to load game data.\nCheck console.', {
          fontSize: '18px',
          color: '#ff4444',
          fontFamily: 'monospace',
          align: 'center',
        })
        .setOrigin(0.5);
    }
  }
}
