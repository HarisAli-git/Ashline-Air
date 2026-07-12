import Phaser from 'phaser';
import { AircraftController, type FlightInput } from '../entities/aircraft/AircraftController';
import { AircraftSprite } from '../entities/aircraft/AircraftSprite';
import { WeatherSystem } from '../entities/weather/WeatherSystem';
import { FlightEventService } from '../../services/FlightEventService';
import { SaveService } from '../../services/SaveService';
import { EventBus } from '../utils/EventBus';
import type { FlightState, LandingQuality, LandingResult } from '../../types';
import { clamp } from '../utils/math';

// ─── Layout constants ────────────────────────────────────────────────────────
const GROUND_Y_OFFSET = 110;  // px from screen bottom to ground line
const AIRCRAFT_X      = 240;  // fixed screen x (world scrolls past it)
const MAX_DISPLAY_ALT = 800;  // m of altitude that maps to full usable screen height

interface FlightSceneData { contractId: string; }

export class FlightScene extends Phaser.Scene {
  // ── Physics ───────────────────────────────────────────────────────────────
  private controller!: AircraftController;
  private weather!: WeatherSystem;
  private state!: FlightState;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  // ── Visual layers (back → front) ─────────────────────────────────────────
  private skyGfx!: Phaser.GameObjects.Graphics;
  private cloudGfx!: Phaser.GameObjects.Graphics;
  private mountainGfx!: Phaser.GameObjects.Graphics;
  private hillGfx!: Phaser.GameObjects.Graphics;
  private groundGfx!: Phaser.GameObjects.Graphics;

  // ── Aircraft ──────────────────────────────────────────────────────────────
  private aircraft!: AircraftSprite;
  private engineRunning = true;

  // ── HUD ───────────────────────────────────────────────────────────────────
  private throttleBarGfx!: Phaser.GameObjects.Graphics;
  private speedText!: Phaser.GameObjects.Text;
  private altText!: Phaser.GameObjects.Text;
  private approachText!: Phaser.GameObjects.Text;

  // ── Scene state ───────────────────────────────────────────────────────────
  private contractId!: string;
  private landed      = false;
  private hasBeenAirborne = false;
  private gearToggleCooldown  = 0;
  private flapsToggleCooldown = 0;
  private eventModalOpen   = false;
  private lastEventCheckAt = 0;
  private eventUnsubs: Array<() => void> = [];

  // ── Landing state ─────────────────────────────────────────────────────────
  private pendingTouchdown: { vs: number; speed: number } | null = null;
  private rollout = false;
  private rolloutResult: LandingResult | null = null;

  // ── Animation state ───────────────────────────────────────────────────────
  private scrollX       = 0;     // cumulative world scroll (m)
  private lastSkyAlt    = -999;
  private shakeDuration = 0;
  private cloudOffsets  = [0, 200, 450, 700, 900];

  constructor() { super({ key: 'FlightScene' }); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(data: FlightSceneData): void {
    this.contractId          = data.contractId;
    this.landed              = false;
    this.hasBeenAirborne     = false;
    this.scrollX             = 0;
    this.lastSkyAlt          = -999;
    this.shakeDuration       = 0;
    this.gearToggleCooldown  = 0;
    this.flapsToggleCooldown = 0;
    this.engineRunning       = true;
    this.eventModalOpen      = false;
    this.lastEventCheckAt    = 0;
    this.pendingTouchdown    = null;
    this.rollout             = false;
    this.rolloutResult       = null;
  }

  create(): void {
    const { width, height } = this.cameras.main;
    const groundY = height - GROUND_Y_OFFSET;

    // ── Physics init ──────────────────────────────────────────────────────
    const { owned, def: definition } = SaveService.getActiveAircraft();

    this.controller = new AircraftController(definition);
    this.state      = this.controller.initialState();
    this.state.fuel        = owned.fuel;
    this.state.integrity   = owned.integrity;
    this.state.engineTemp  = owned.engineTemp;

    // Stall buffet shakes the camera; touchdown captures true impact values
    this.controller.onBuffet = () => { this.shakeDuration = Math.max(this.shakeDuration, 150); };
    this.controller.onTouchdown = (vs, speed) => { this.pendingTouchdown = { vs, speed }; };

    this.weather = new WeatherSystem(this);
    FlightEventService.reset();

    // ── Build scene (back → front) ────────────────────────────────────────
    this.skyGfx      = this.add.graphics();
    this.cloudGfx    = this.add.graphics();
    this.mountainGfx = this.add.graphics();
    this.hillGfx     = this.add.graphics();
    this.groundGfx   = this.add.graphics();
    // ── Procedural aircraft ──────────────────────────────────────────────
    this.aircraft = new AircraftSprite(this, AIRCRAFT_X, groundY, definition);

    // ── HUD ───────────────────────────────────────────────────────────────
    this.throttleBarGfx = this.add.graphics();

    this.speedText = this.add.text(width / 2, 12, '', {
      fontSize: '15px', color: '#e8d5b7', fontFamily: 'monospace',
      backgroundColor: '#00000088', padding: { x: 10, y: 4 },
    }).setOrigin(0.5, 0).setDepth(10);

    this.altText = this.add.text(width - 12, 12, '', {
      fontSize: '13px', color: '#00ff88', fontFamily: 'monospace',
      backgroundColor: '#00000088', padding: { x: 8, y: 4 },
    }).setOrigin(1, 0).setDepth(10);

    this.approachText = this.add.text(width / 2, height / 2 - 30, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#00000099', padding: { x: 14, y: 6 },
    }).setOrigin(0.5).setDepth(10).setAlpha(0);

    // Controls reminder
    this.add.text(width - 12, height - 12,
      'W/S: Throttle   A/D: Pitch   E: Engine   G: Gear   F: Flaps   ESC: Abort',
      { fontSize: '11px', color: '#5a6a5a', fontFamily: 'monospace',
        backgroundColor: '#00000055', padding: { x: 6, y: 4 } }
    ).setOrigin(1, 1).setDepth(10);

    // ── Input ─────────────────────────────────────────────────────────────
    this.keys = {
      W:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      S:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      A:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      D:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      E:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      G:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.G),
      F:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      ESC: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
    };

    // ── Event modal wiring ────────────────────────────────────────────────
    // Physics pauses while a flight-event modal is up; the chosen consequence
    // is applied to the authoritative state here (React only reports the choice).
    this.eventUnsubs = [
      EventBus.on('ui:show-event-modal',  () => { this.eventModalOpen = true; }),
      EventBus.on('ui:close-event-modal', () => { this.eventModalOpen = false; }),
      EventBus.on('flight:apply-event-choice', ({ choiceId }) => {
        this.state = FlightEventService.applyChoice(choiceId, this.state);
      }),
    ];
    this.events.once('shutdown', () => {
      this.eventUnsubs.forEach(u => u());
      this.eventUnsubs = [];
    });

    // ── First draw ────────────────────────────────────────────────────────
    this.drawSky(width, height, groundY, 0);
    this.drawClouds(width, groundY, 0);
    this.drawMountains(width, groundY, 0);
    this.drawHills(width, groundY, 0);
    this.drawGround(width, groundY, 0);

    EventBus.emit('flight:state-update', this.state);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private drawSky(width: number, height: number, groundY: number, alt: number): void {
    this.skyGfx.clear();
    let topColor: number;
    let botColor: number;

    if (alt < 80) {
      // Near ground: warm amber/dust atmosphere (matches aircraft image bg)
      topColor = 0x1a3050;
      botColor = 0xc88830;
    } else if (alt < 350) {
      // Low altitude: blue sky with warm horizon glow
      topColor = 0x0e2040;
      botColor = 0x5090a8;
    } else {
      // High altitude: deep navy
      topColor = 0x081428;
      botColor = 0x1a4060;
    }

    this.skyGfx.fillGradientStyle(topColor, topColor, botColor, botColor, 1);
    this.skyGfx.fillRect(0, 0, width, height);

    // Horizon glow band (warm, fades with altitude)
    const glowAlpha = Math.max(0, 1 - alt / 250) * 0.4;
    if (glowAlpha > 0.01) {
      this.skyGfx.fillStyle(0xd07820, glowAlpha);
      this.skyGfx.fillRect(0, groundY - 80, width, 80);
    }
  }

  private drawClouds(width: number, groundY: number, scrollX: number): void {
    this.cloudGfx.clear();
    if (this.state?.altitude < 50) return; // no clouds visible near ground

    const alpha = Math.min((this.state?.altitude ?? 0) / 200, 0.85);
    this.cloudGfx.fillStyle(0xffffff, alpha * 0.15);

    const baseY = groundY * 0.35;
    for (let i = 0; i < this.cloudOffsets.length; i++) {
      const ox = ((this.cloudOffsets[i] - scrollX * 0.05) % (width + 300) + width + 300) % (width + 300) - 150;
      const oy = baseY + (i % 3) * 40;
      const w  = 80 + (i % 3) * 40;
      this.cloudGfx.fillEllipse(ox, oy, w, 28);
      this.cloudGfx.fillEllipse(ox + 30, oy - 12, w * 0.7, 22);
      this.cloudGfx.fillEllipse(ox - 20, oy - 8, w * 0.5, 18);
    }
  }

  private drawMountains(width: number, groundY: number, scrollX: number): void {
    this.mountainGfx.clear();

    const peaks = [
      { x: 0,    h: 100 }, { x: 160,  h: 170 }, { x: 310,  h: 115 },
      { x: 480,  h: 195 }, { x: 650,  h: 135 }, { x: 820,  h: 180 },
      { x: 980,  h: 100 }, { x: 1150, h: 155 },
    ];
    const period = 1200;

    for (let rep = -1; rep <= 2; rep++) {
      const baseX = rep * period + ((scrollX * 0.06) % period) * -1;
      for (const { x, h } of peaks) {
        const mx = baseX + x;
        if (mx < -120 || mx > width + 120) continue;
        // Main mountain body
        this.mountainGfx.fillStyle(0x28384a, 0.85);
        this.mountainGfx.fillTriangle(mx - 90, groundY, mx, groundY - h, mx + 90, groundY);
        // Darker face for depth
        this.mountainGfx.fillStyle(0x1a2838, 0.6);
        this.mountainGfx.fillTriangle(mx, groundY - h, mx + 90, groundY, mx + 10, groundY - h * 0.4);
        // Snow cap
        if (h > 120) {
          this.mountainGfx.fillStyle(0xc8d8e8, 0.55);
          this.mountainGfx.fillTriangle(mx - 22, groundY - h + 42, mx, groundY - h, mx + 22, groundY - h + 42);
        }
      }
    }
  }

  private drawHills(width: number, groundY: number, scrollX: number): void {
    this.hillGfx.clear();

    const hills = [
      { x: 0,   h: 55,  w: 160 }, { x: 220, h: 75,  w: 190 },
      { x: 450, h: 50,  w: 140 }, { x: 640, h: 85,  w: 210 },
      { x: 870, h: 60,  w: 170 }, { x: 1080,h: 70,  w: 180 },
    ];
    const period = 1200;

    for (let rep = -1; rep <= 2; rep++) {
      const baseX = rep * period + ((scrollX * 0.22) % period) * -1;
      for (const { x, h, w } of hills) {
        const mx = baseX + x;
        if (mx < -150 || mx > width + 150) continue;
        this.hillGfx.fillStyle(0x304020, 1);
        this.hillGfx.fillTriangle(mx - w / 2, groundY, mx, groundY - h, mx + w / 2, groundY);
        // Lighter ridge
        this.hillGfx.fillStyle(0x3a5028, 0.5);
        this.hillGfx.fillTriangle(mx - w * 0.15, groundY - h + 15, mx, groundY - h, mx + w * 0.15, groundY - h + 15);
      }
    }
  }

  private drawGround(width: number, groundY: number, scrollX: number): void {
    this.groundGfx.clear();

    // Main ground fill — two-tone (near vs far)
    this.groundGfx.fillStyle(0x2a1e0e, 1);
    this.groundGfx.fillRect(0, groundY, width, 200);
    this.groundGfx.fillStyle(0x362614, 1);
    this.groundGfx.fillRect(0, groundY, width, 18);

    // Ground edge line
    this.groundGfx.lineStyle(2, 0x6a4820, 1);
    this.groundGfx.lineBetween(0, groundY, width, groundY);

    // Runway centre-line dashes (scroll with the world)
    const dashW   = 48;
    const dashGap = 80;
    const dashY   = groundY + 8;
    const phase   = ((scrollX * 1.0) % (dashW + dashGap));

    this.groundGfx.fillStyle(0xa89050, 0.65);
    for (let dx = -phase; dx < width + dashW; dx += dashW + dashGap) {
      this.groundGfx.fillRect(dx, dashY, dashW, 3);
    }

    // Distant ground texture lines (horizontal)
    this.groundGfx.lineStyle(1, 0x4a3218, 0.3);
    for (let i = 1; i <= 3; i++) {
      this.groundGfx.lineBetween(0, groundY + i * 22, width, groundY + i * 22);
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  private updateHUD(groundY: number): void {
    const s = this.state;
    const spd = (s.speed * 3.6).toFixed(0);
    const vspd = s.verticalSpeed.toFixed(1);
    const vsLabel = Number(vspd) >= 0 ? `+${vspd}` : vspd;

    this.speedText.setText(`${spd} km/h  ${vsLabel} m/s`);
    this.altText.setText(`${s.altitude.toFixed(0)} m  |  ${(s.throttle * 100).toFixed(0)}% THR  |  FUEL ${s.fuel.toFixed(0)}L`);

    // ── Throttle bar (left edge) ──
    this.throttleBarGfx.clear();
    const bx = 14, by = 20, bw = 10, bh = 120;
    this.throttleBarGfx.fillStyle(0x111111, 0.7);
    this.throttleBarGfx.fillRect(bx, by, bw, bh);

    const fillH = bh * s.throttle;
    const fillColor = s.throttle > 0.85 ? 0xff4444 : s.throttle > 0.6 ? 0xffd080 : 0x00cc66;
    this.throttleBarGfx.fillStyle(fillColor, 0.9);
    this.throttleBarGfx.fillRect(bx, by + bh - fillH, bw, fillH);

    // Bar border
    this.throttleBarGfx.lineStyle(1, 0x888888, 0.5);
    this.throttleBarGfx.strokeRect(bx, by, bw, bh);

    // ── Approach indicator ──
    this.updateApproachIndicator(groundY);
  }

  private updateApproachIndicator(groundY: number): void {
    if (!this.hasBeenAirborne || this.state.altitude > 250) {
      this.approachText.setAlpha(0);
      return;
    }

    const vSpeed = this.state.verticalSpeed;
    if (vSpeed >= -0.3) { this.approachText.setAlpha(0); return; }

    let label: string;
    let color: string;

    if (!this.state.gearDown) {
      label = '⚠  GEAR NOT DOWN  ⚠';
      color = '#ff4444';
    } else if (vSpeed < -6) {
      label = '▼  TOO FAST — PULL UP';
      color = '#ff4444';
    } else if (vSpeed < -3.5) {
      label = '▼  APPROACH STEEP';
      color = '#ffd080';
    } else {
      label = '✓  GOOD APPROACH';
      color = '#00ff88';
    }

    this.approachText.setText(label).setStyle({ color }).setAlpha(1);
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  update(time: number, delta: number): void {
    if (this.landed || this.eventModalOpen) return;

    const dt = delta / 1000;
    const { width, height } = this.cameras.main;
    const groundY = height - GROUND_Y_OFFSET;

    // ── Cooldowns ──────────────────────────────────────────────────────────
    this.gearToggleCooldown  = Math.max(0, this.gearToggleCooldown  - delta);
    this.flapsToggleCooldown = Math.max(0, this.flapsToggleCooldown - delta);

    // ── Input ──────────────────────────────────────────────────────────────
    const input: FlightInput = {
      throttleUp:   this.keys.W.isDown,
      throttleDown: this.keys.S.isDown,
      pitchUp:      this.keys.A.isDown,
      pitchDown:    this.keys.D.isDown,
      engineOn:     this.engineRunning,
    };

    if (Phaser.Input.Keyboard.JustDown(this.keys.E)) {
      this.engineRunning = !this.engineRunning;
      if (this.engineRunning) {
        this.aircraft.startEngine();
        EventBus.emit('ui:show-notification', { message: 'Engine started.', type: 'success' });
      } else {
        this.aircraft.stopEngine();
        EventBus.emit('ui:show-notification', { message: 'Engine shut down.', type: 'warning' });
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.G) && this.gearToggleCooldown === 0) {
      if (!this.aircraft.hasRetractableGear) {
        EventBus.emit('ui:show-notification', { message: 'This aircraft has fixed landing gear.', type: 'info' });
        this.gearToggleCooldown = 500;
      } else {
        this.state.gearDown = !this.state.gearDown;
        this.aircraft.setGearDown(this.state.gearDown);
        this.gearToggleCooldown = 500;
        EventBus.emit('flight:gear-toggled', { down: this.state.gearDown });
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.F) && this.flapsToggleCooldown === 0) {
      this.state.flapsDeployed = !this.state.flapsDeployed;
      this.flapsToggleCooldown = 500;
      EventBus.emit('flight:flaps-toggled', { deployed: this.state.flapsDeployed });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
      EventBus.emit('scene:return-to-map');
      EventBus.emit('ui:show-notification', { message: 'Flight aborted.', type: 'warning' });
      this.scene.start('MapScene');
      return;
    }

    // ── Physics (fixed-step, frame-rate independent) ───────────────────────
    this.state = this.controller.update(this.state, input, dt);

    // ── Weather ────────────────────────────────────────────────────────────
    this.weather.update(delta);
    const turbulence = this.weather.current.turbulenceIntensity;
    if (turbulence > 0 && this.state.altitude > 10) {
      this.state.altitude = clamp(
        this.state.altitude + (Math.random() - 0.5) * turbulence * 8, 0, 10000
      );
      this.state.verticalSpeed += (Math.random() - 0.5) * turbulence * 2;
      if (turbulence > 0.3) {
        this.shakeDuration = 400;
      }
    }

    // Fuel warning (every 5s)
    if (this.state.fuel < 15 && Math.floor(time / 5000) !== Math.floor((time - delta) / 5000)) {
      EventBus.emit('ui:show-notification', {
        message: `⚠ FUEL CRITICAL: ${this.state.fuel.toFixed(0)} L remaining`,
        type: 'danger',
      });
    }

    // Engine overheat warning
    if (this.state.engineTemp > 0.85 && Math.floor(time / 8000) !== Math.floor((time - delta) / 8000)) {
      EventBus.emit('ui:show-notification', {
        message: 'ENGINE OVERHEATING — reduce throttle',
        type: 'warning',
      });
    }

    // ── Airborne tracking ──────────────────────────────────────────────────
    if (this.state.altitude > 5) this.hasBeenAirborne = true;

    // ── Touchdown: grade the exact moment the wheels meet the ground ──────
    if (this.pendingTouchdown && this.hasBeenAirborne && !this.rollout) {
      const { vs, speed } = this.pendingTouchdown;
      const result = this.evaluateLanding(vs, speed);
      this.aircraft.notifyTouchdown(vs);

      if (result.quality === 'crash') {
        this.cameras.main.shake(600, 14);
        this.finishFlight(result);
        return;
      }
      if (result.quality === 'hard') this.cameras.main.shake(450, 7);
      this.rollout = true;
      this.rolloutResult = result;
    }
    this.pendingTouchdown = null;

    // ── Rollout: brake to a stop (throttling up again = touch-and-go) ─────
    if (this.rollout) {
      if (this.state.altitude > 0.5) {
        this.rollout = false;
        this.rolloutResult = null;
      } else {
        this.state.speed = Math.max(0, this.state.speed - 6 * dt);
        this.state.groundSpeed = this.state.speed;
        if (this.state.speed < 3) {
          this.finishFlight(this.rolloutResult!);
          return;
        }
      }
    }

    // Fuel exhausted and rolled to a stop without a graded touchdown
    if (this.hasBeenAirborne && this.state.fuel <= 0 && this.state.altitude <= 0 && this.state.speed < 1) {
      this.finishFlight(this.evaluateLanding(Math.abs(this.state.verticalSpeed), this.state.speed));
      return;
    }

    // Flight events — at most one check every 3 seconds
    if (this.state.elapsedSeconds - this.lastEventCheckAt >= 3) {
      this.lastEventCheckAt = this.state.elapsedSeconds;
      FlightEventService.checkEvents(this.state);
    }

    // ── Parallax scroll (ground speed: wind matters) ───────────────────────
    this.scrollX += this.state.groundSpeed * dt;

    // Sky redraws only on meaningful altitude change (expensive gradient)
    if (Math.abs(this.state.altitude - this.lastSkyAlt) > 40) {
      this.drawSky(width, height, groundY, this.state.altitude);
      this.lastSkyAlt = this.state.altitude;
    }

    this.drawClouds(width, groundY, this.scrollX);
    this.drawMountains(width, groundY, this.scrollX);
    this.drawHills(width, groundY, this.scrollX);
    this.drawGround(width, groundY, this.scrollX);

    // ── Aircraft visuals ───────────────────────────────────────────────────
    const altPixels = (this.state.altitude / MAX_DISPLAY_ALT) * (groundY - 100);
    const screenY   = clamp(groundY - altPixels, 80, groundY);
    this.aircraft.container.setY(screenY);
    this.aircraft.update(dt, this.state);

    // ── Camera shake ───────────────────────────────────────────────────────
    if (this.shakeDuration > 0) {
      this.shakeDuration -= delta;
      const mag = clamp(turbulence * 5, 1, 8);
      this.cameras.main.shake(80, mag);
    }

    // ── HUD ────────────────────────────────────────────────────────────────
    this.updateHUD(groundY);

    // ── Events to React ────────────────────────────────────────────────────
    EventBus.emit('flight:state-update', this.state);
  }

  // ── Landing ───────────────────────────────────────────────────────────────

  private finishFlight(result: LandingResult): void {
    if (this.landed) return;
    this.landed = true;
    this.scene.start('PostFlightScene', { result, contractId: this.contractId, finalState: this.state });
  }

  /** Grades the landing from the impact values captured at touchdown. */
  private evaluateLanding(vSpeedAtImpact: number, hSpeedAtImpact: number): LandingResult {
    const vSpeed = Math.abs(vSpeedAtImpact);
    const hSpeed = hSpeedAtImpact;

    let quality: LandingQuality;
    let integrityDamage: number;
    let cargoDamage: number;

    if (!this.state.gearDown) {
      quality = 'crash'; integrityDamage = 45; cargoDamage = 60;
    } else if (vSpeed < 1.5 && hSpeed < 25) {
      quality = 'perfect'; integrityDamage = 0; cargoDamage = 0;
    } else if (vSpeed < 3.0 && hSpeed < 55) {
      quality = 'good'; integrityDamage = 2; cargoDamage = 0;
    } else if (vSpeed < 5.5) {
      quality = 'hard'; integrityDamage = 12; cargoDamage = 20;
    } else {
      quality = 'crash'; integrityDamage = 35; cargoDamage = 45;
    }

    return { verticalSpeed: vSpeed, horizontalSpeed: hSpeed, gearDown: this.state.gearDown,
      quality, integrityDamage, cargoDamagePercent: cargoDamage };
  }
}
