import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import type { SettlementDefinition, SettlementState, Contract } from '../../types';

interface PreFlightSceneData {
  settlementId: string;
}

export class PreFlightScene extends Phaser.Scene {
  private settlement!: SettlementDefinition;
  private settlementState!: SettlementState;

  constructor() {
    super({ key: 'PreFlightScene' });
  }

  init(data: PreFlightSceneData): void {
    this.settlement = window.gameData.settlements.find(s => s.id === data.settlementId)!;
    const save = SaveService.get();
    this.settlementState = save.world.settlements.find(s => s.definitionId === data.settlementId)!;
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#100c04');
    fadeIn(this);
    const { width, height } = this.cameras.main;
    const cx = width / 2;

    // Header
    this.add.text(cx, 24, this.settlement.name.toUpperCase(), {
      fontSize: '28px', color: '#ffd080', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5, 0);

    const faction = window.gameData.factions.find(f => f.id === this.settlement.factionId);
    this.add.text(cx, 60, `${faction?.name ?? '—'} Territory`, {
      fontSize: '14px', color: '#8a7a5a', fontFamily: 'monospace',
    }).setOrigin(0.5, 0);

    // Tabs: Contracts | Refuel | Market
    // For MVP, we drive React UI for contracts and market;
    // Phaser shows the scene shell and "Fly" button.
    // React overlays the actual interactive panels on top.
    this.add.text(24, height - 40, '← Back to Map', {
      fontSize: '16px', color: '#8a7a5a', fontFamily: 'monospace',
    }).setInteractive({ useHandCursor: true })
      .on('pointerover', function(this: Phaser.GameObjects.Text) { this.setStyle({ color: '#e8d5b7' }); })
      .on('pointerout',  function(this: Phaser.GameObjects.Text) { this.setStyle({ color: '#8a7a5a' }); })
      .on('pointerdown', () => {
        EventBus.emit('scene:return-to-map');
        fadeToScene(this, 'MapScene');
      });

    // "Fly" button — enabled only when a contract is active
    this.wireDeparture();
  }

  /*
   * The FLY control used to live here, as a Phaser text object at the bottom
   * of the canvas — underneath the React panel that lists the contracts. It
   * was covered on every screen size, which is why it kept being reported.
   *
   * It is now the "Depart" button inside the dispatch board itself, a sibling
   * of the list rather than a layer beneath it, so it cannot be occluded. All
   * this scene does is listen for the board's decision.
   */
  private wireDeparture(): void {
    const off = EventBus.on('scene:depart', ({ contractId }) => {
      EventBus.emit('scene:start-flight', { contractId });
      fadeToScene(this, 'FlightScene', { contractId });
    });
    this.events.once('shutdown', off);
  }

}
