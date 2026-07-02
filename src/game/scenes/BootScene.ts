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

  preload(): void {
    // Legacy composite used by MenuScene silhouette
    this.load.image('cargo_plane', '/assets/cargoPlane.png');

    // Individual layered parts for AircraftSprite
    const cp = (key: string, file: string) =>
      this.load.image(key, `/assets/cargo-plane/${file}`);

    cp('cp_fuselage',   'fuselage.png');
    cp('cp_wing',       'wing.png');
    cp('cp_tail',       'tail.png');
    cp('cp_cockpit',    'cockpit_glass.png');
    cp('cp_cargo_door', 'cargo_door.png');
    cp('cp_antenna',    'antenna.png');
    cp('cp_engine_l',   'engine_left.png');
    cp('cp_engine_r',   'engine_right.png');
    cp('cp_prop_l',     'propeller_left.png');
    cp('cp_prop_r',     'propeller_right.png');
    cp('cp_prop_f1',    'propeller_anim_f1.png');
    cp('cp_prop_f2',    'propeller_anim_f2.png');
    cp('cp_prop_f3',    'propeller_anim_f3.png');
    cp('cp_prop_f4',    'propeller_anim_f4.png');
    cp('cp_flaps_up',   'flaps_up.png');
    cp('cp_flaps_mid',  'flaps_mid.png');
    cp('cp_flaps_down', 'flaps_down.png');
    cp('cp_gear_open',  'gear_open.png');
    cp('cp_gear_mid',   'gear_open_mid.png');
    cp('cp_gear_closed','gear_closed.png');
    cp('cp_gear_front', 'landing_gear_front.png');
    cp('cp_gear_rear',  'landing_gear_rear.png');
    cp('cp_lights',     'lights.png');
    cp('cp_damage_0',   'damage_0.png');
    cp('cp_damage_1',   'damage_1.png');
    cp('cp_damage_2',   'damage_2.png');
    cp('cp_damage_3',   'damage_3.png');
    cp('cp_oil_leak',   'oil_leak.png');
    cp('cp_smoke',      'smoke.png');
    cp('cp_shadow',     'shadow.png');

    this.load.on('complete', () => console.log('[BootScene] All assets loaded'));
  }

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
