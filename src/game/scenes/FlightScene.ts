import Phaser from 'phaser';
import { AircraftController, type FlightInput } from '../entities/aircraft/AircraftController';
import { WeatherSystem } from '../entities/weather/WeatherSystem';
import { FlightEventService } from '../../services/FlightEventService';
import { SaveService } from '../../services/SaveService';
import { EventBus } from '../utils/EventBus';
import type { FlightState, AircraftDefinition, LandingQuality, LandingResult } from '../../types';
import { clamp } from '../utils/math';
import { findById } from '../utils/DataLoader';

const GROUND_Y_OFFSET = 80; // pixels from bottom of screen to ground line

interface FlightSceneData {
  contractId: string;
}

export class FlightScene extends Phaser.Scene {
  private controller!: AircraftController;
  private weather!: WeatherSystem;
  private state!: FlightState;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  private aircraftSprite!: Phaser.GameObjects.Container;
  private groundLine!: Phaser.GameObjects.Graphics;
  private terrainGraphics!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private contractId!: string;
  private landed = false;
  private hasBeenAirborne = false;
  private gearToggleCooldown = 0;
  private flapsToggleCooldown = 0;

  constructor() {
    super({ key: 'FlightScene' });
  }

  init(data: FlightSceneData): void {
    this.contractId = data.contractId;
    this.landed = false;
    this.hasBeenAirborne = false;
  }

  create(): void {
    const { width, height } = this.cameras.main;
    this.cameras.main.setBackgroundColor('#1a2a3a');

    const save = SaveService.get();
    const aircraft = save.player.ownedAircraft[parseInt(save.player.activeAircraftId)];
    const definition = findById<AircraftDefinition>(window.gameData.aircraft, aircraft.definitionId);

    this.controller = new AircraftController(definition);
    this.state = this.controller.initialState();
    this.state.fuel = aircraft.fuel;
    this.state.integrity = aircraft.integrity;
    this.state.engineTemp = aircraft.engineTemp;

    this.weather = new WeatherSystem(this);

    FlightEventService.reset();

    this.setupInput();
    this.buildScene(width, height);
    this.buildHUD(width, height);

    EventBus.emit('flight:state-update', this.state);
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = {
      W: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      S: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      A: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      D: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      G: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.G),
      F: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      ESC: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
    };
  }

  private buildScene(width: number, height: number): void {
    const groundY = height - GROUND_Y_OFFSET;

    // Sky gradient
    const sky = this.add.graphics();
    sky.fillGradientStyle(0x1a2a3a, 0x1a2a3a, 0x2a4a2a, 0x2a4a2a, 1);
    sky.fillRect(0, 0, width, groundY);

    // Scrolling terrain
    this.terrainGraphics = this.add.graphics();
    this.drawTerrain(groundY, width);

    // Ground line
    this.groundLine = this.add.graphics();
    this.groundLine.lineStyle(2, 0x5a4a2a, 1);
    this.groundLine.lineBetween(0, groundY, width, groundY);

    // Aircraft (procedural placeholder)
    this.aircraftSprite = this.buildAircraftSprite();
    this.aircraftSprite.setPosition(width * 0.2, groundY - 10);
  }

  private buildAircraftSprite(): Phaser.GameObjects.Container {
    const g = this.add.graphics();
    // Fuselage
    g.fillStyle(0xd4c4a0, 1);
    g.fillRect(-30, -6, 60, 12);
    // Wing
    g.fillStyle(0xb8a880, 1);
    g.fillRect(-15, -14, 30, 8);
    // Tail
    g.fillRect(20, -16, 12, 10);
    // Nose
    g.fillStyle(0xe8d5b7, 1);
    g.fillRect(30, -4, 10, 8);
    // Gear (drawn separately so it can be toggled)
    g.fillStyle(0x888888, 1);
    g.fillRect(-10, 6, 4, 8);
    g.fillRect(10, 6, 4, 8);

    const container = this.add.container(0, 0, [g]);
    return container;
  }

  private drawTerrain(groundY: number, width: number): void {
    this.terrainGraphics.clear();
    this.terrainGraphics.fillStyle(0x2a3a1a, 1);
    this.terrainGraphics.fillRect(0, groundY, width, 200);

    // Simple rolling hill silhouettes
    this.terrainGraphics.fillStyle(0x1e2e14, 1);
    this.terrainGraphics.fillTriangle(0, groundY, 120, groundY - 40, 240, groundY);
    this.terrainGraphics.fillTriangle(300, groundY, 480, groundY - 60, 660, groundY);
    this.terrainGraphics.fillTriangle(700, groundY, 850, groundY - 30, 1000, groundY);
  }

  private buildHUD(width: number, height: number): void {
    // Phaser-side HUD (critical numbers in-cockpit style)
    // React overlay handles the full HUD panel
    this.hudText = this.add.text(16, 16, '', {
      fontSize: '13px',
      color: '#00ff88',
      fontFamily: 'monospace',
      backgroundColor: '#00000088',
      padding: { x: 8, y: 6 },
    });

    // Controls reminder
    this.add.text(width - 16, height - 16,
      'W/S: Throttle   A: Nose Up   D: Nose Down   G: Gear   F: Flaps   ESC: Abort',
      {
        fontSize: '11px', color: '#6a7a6a', fontFamily: 'monospace',
        backgroundColor: '#00000066',
        padding: { x: 6, y: 4 },
      }
    ).setOrigin(1, 1);
  }

  update(time: number, delta: number): void {
    if (this.landed) return;

    this.gearToggleCooldown = Math.max(0, this.gearToggleCooldown - delta);
    this.flapsToggleCooldown = Math.max(0, this.flapsToggleCooldown - delta);

    const input: FlightInput = {
      throttleUp:   this.keys.W.isDown,
      throttleDown: this.keys.S.isDown,
      pitchUp:      this.keys.A.isDown,
      pitchDown:    this.keys.D.isDown,
      toggleGear:   false,
      toggleFlaps:  false,
    };

    // One-shot toggles with cooldown
    if (Phaser.Input.Keyboard.JustDown(this.keys.G) && this.gearToggleCooldown === 0) {
      this.state.gearDown = !this.state.gearDown;
      this.gearToggleCooldown = 500;
      EventBus.emit('flight:gear-toggled', { down: this.state.gearDown });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.F) && this.flapsToggleCooldown === 0) {
      this.state.flapsDeployed = !this.state.flapsDeployed;
      this.flapsToggleCooldown = 500;
      EventBus.emit('flight:flaps-toggled', { deployed: this.state.flapsDeployed });
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
      this.abortFlight();
      return;
    }

    this.state = this.controller.update(this.state, input);

    // Weather influence on turbulence
    this.weather.update(delta);
    const turbulence = this.weather.current.turbulenceIntensity;
    if (turbulence > 0 && this.state.altitude > 10) {
      this.state.altitude = clamp(
        this.state.altitude + (Math.random() - 0.5) * turbulence * 8,
        0, 10000
      );
      this.state.verticalSpeed += (Math.random() - 0.5) * turbulence * 2;
    }

    // Fuel-critical alert
    if (this.state.fuel < 10 && Math.floor(time / 5000) !== Math.floor((time - delta) / 5000)) {
      EventBus.emit('flight:fuel-critical', { fuelRemaining: this.state.fuel });
      EventBus.emit('ui:show-notification', {
        message: `WARNING: Fuel critical — ${this.state.fuel.toFixed(1)}L remaining`,
        type: 'danger',
      });
    }

    // Track first time we leave the ground
    if (this.state.altitude > 5) this.hasBeenAirborne = true;

    // Fuel exhausted on the ground after being airborne
    if (this.hasBeenAirborne && this.state.fuel <= 0 && this.state.altitude <= 0) {
      this.triggerLanding();
      return;
    }

    // Check flight events every ~1s
    if (Math.floor(this.state.elapsedSeconds) % 3 === 0) {
      FlightEventService.checkEvents(this.state);
    }

    this.updateVisuals();
    this.updateHUD();

    EventBus.emit('flight:state-update', this.state);

    // Auto-land once the aircraft has been airborne and returns to ground
    if (this.hasBeenAirborne && this.state.altitude <= 0 && this.state.speed < 10 && this.state.gearDown) {
      this.triggerLanding();
    }
  }

  private updateVisuals(): void {
    const { width, height } = this.cameras.main;
    const groundY = height - GROUND_Y_OFFSET;

    // Aircraft y position mapped from altitude
    const maxDisplayAlt = 800;
    const screenY = groundY - (this.state.altitude / maxDisplayAlt) * (groundY - 60);
    this.aircraftSprite.y = clamp(screenY, 60, groundY - 5);

    // Pitch tilt
    this.aircraftSprite.angle = -this.state.pitch * 0.5;

    // Parallax terrain scroll based on speed
    const scroll = this.state.speed * 2;
    this.terrainGraphics.x = ((this.terrainGraphics.x - scroll * 0.016) % width);
  }

  private updateHUD(): void {
    const s = this.state;
    const w = this.weather.current;
    this.hudText.setText([
      `ALT:  ${s.altitude.toFixed(0)} m`,
      `SPD:  ${(s.speed * 3.6).toFixed(0)} km/h`,
      `V/S:  ${s.verticalSpeed.toFixed(1)} m/s`,
      `THR:  ${(s.throttle * 100).toFixed(0)}%`,
      `FUEL: ${s.fuel.toFixed(1)} L`,
      `ENG:  ${(s.engineTemp * 100).toFixed(0)}%`,
      `INT:  ${s.integrity.toFixed(0)}%`,
      `GEAR: ${s.gearDown ? 'DOWN' : 'UP'}`,
      `FLAP: ${s.flapsDeployed ? 'ON' : 'OFF'}`,
      `WX:   ${w.condition.replace('_', ' ')}`,
    ]);
  }

  private triggerLanding(): void {
    if (this.landed) return;
    this.landed = true;

    const result = this.evaluateLanding();
    this.scene.start('PostFlightScene', { result, contractId: this.contractId });
  }

  private evaluateLanding(): LandingResult {
    const vSpeed = Math.abs(this.state.verticalSpeed);
    const hSpeed = this.state.speed;

    let quality: LandingQuality;
    let integrityDamage: number;
    let cargoDamage: number;

    if (!this.state.gearDown) {
      quality = 'crash';
      integrityDamage = 40;
      cargoDamage = 50;
    } else if (vSpeed < 1.5 && hSpeed < 30) {
      quality = 'perfect';
      integrityDamage = 0;
      cargoDamage = 0;
    } else if (vSpeed < 3.5 && hSpeed < 60) {
      quality = 'good';
      integrityDamage = 2;
      cargoDamage = 0;
    } else if (vSpeed < 6) {
      quality = 'hard';
      integrityDamage = 10;
      cargoDamage = 15;
    } else {
      quality = 'crash';
      integrityDamage = 30;
      cargoDamage = 40;
    }

    return {
      verticalSpeed: vSpeed,
      horizontalSpeed: hSpeed,
      gearDown: this.state.gearDown,
      quality,
      integrityDamage,
      cargoDamagePercent: cargoDamage,
    };
  }

  private abortFlight(): void {
    EventBus.emit('ui:show-notification', { message: 'Flight aborted.', type: 'warning' });
    this.scene.start('MapScene');
  }
}
