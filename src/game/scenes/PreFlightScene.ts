import Phaser from 'phaser';
import { SaveService } from '../../services/SaveService';
import { EconomyService } from '../../services/EconomyService';
import { EventBus } from '../utils/EventBus';
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
        this.scene.start('MapScene');
      });

    // "Fly" button — enabled only when a contract is active
    this.buildFlyButton(cx, height - 40);
  }

  private buildFlyButton(cx: number, y: number): void {
    const text = this.add.text(cx, y, 'Select a contract first', {
      fontSize: '22px',
      color: '#4a4030',
      fontFamily: 'monospace',
      fontStyle: 'bold',
    }).setOrigin(0.5, 1);

    let enabled = false;
    const enable = (): void => {
      if (enabled) return;
      enabled = true;
      text.setText('FLY →').setStyle({ color: '#ffd080' });
      text.setInteractive({ useHandCursor: true });
      text.on('pointerover', () => text.setStyle({ color: '#ffffff' }));
      text.on('pointerout',  () => text.setStyle({ color: '#ffd080' }));
      text.on('pointerdown', () => {
        const s = SaveService.get();
        if (!s.player.activeContractId) return;
        EventBus.emit('scene:start-flight', { contractId: s.player.activeContractId });
        this.scene.start('FlightScene', { contractId: s.player.activeContractId });
      });
    };

    if (SaveService.get().player.activeContractId !== null) enable();

    // React enables the button after contract acceptance; guard against
    // stacking duplicate pointer handlers on repeated accepts.
    const unsubAccepted = EventBus.on('contract:accepted', enable);
    this.events.once('shutdown', unsubAccepted);
  }
}
