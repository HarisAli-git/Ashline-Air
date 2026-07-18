import Phaser from 'phaser';
import { AircraftController, type FlightInput } from '../entities/aircraft/AircraftController';
import { AircraftSprite } from '../entities/aircraft/AircraftSprite';
import { WeatherSystem } from '../entities/weather/WeatherSystem';
import { ParallaxWorld, WORLD_PX_PER_M } from '../world/ParallaxWorld';
import { WeatherFX } from '../world/WeatherFX';
import { FlightEventService } from '../../services/FlightEventService';
import { SaveService } from '../../services/SaveService';
import { CargoHold } from '../entities/CargoHold';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene, flashToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import type { FlightState, FlightEventDefinition, LandingQuality, LandingResult, WeatherCondition } from '../../types';
import { clamp, distance, pixelsToKm } from '../utils/math';

// ─── Layout constants ────────────────────────────────────────────────────────
const GROUND_Y_OFFSET = 110;  // px from screen bottom to ground line
// TU-46 camera: the aircraft holds a fixed screen position and the WORLD does
// all the moving — speed reads through scroll, never by sliding the sprite.
const AIRCRAFT_X      = 300;

interface FlightSceneData { contractId: string; }

const DEV_WEATHER_KEYS: Record<string, WeatherCondition> = {
  '1': 'clear', '2': 'cloudy', '3': 'strong_winds', '4': 'dust_storm',
  '5': 'fog', '6': 'thunderstorm', '7': 'blizzard',
};

export class FlightScene extends Phaser.Scene {
  // ── Physics ───────────────────────────────────────────────────────────────
  private controller!: AircraftController;
  private weather!: WeatherSystem;
  private state!: FlightState;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  // ── Visuals ───────────────────────────────────────────────────────────────
  private world!: ParallaxWorld;
  private fx!: WeatherFX;
  private aircraft!: AircraftSprite;
  private engineRunning = true;

  // ── In-canvas HUD (approach guidance only — gauges live in React) ────────
  private approachText!: Phaser.GameObjects.Text;

  // ── Scene state ───────────────────────────────────────────────────────────
  private contractId!: string;
  private routeKm = 6;          // gameplay-scale route length to the destination
  private destinationName = 'destination';
  private cargo!: CargoHold;
  private lastCargoEmit = 0;
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
  private scrollX       = 0;     // cumulative world scroll (world px)
  private shakeDuration = 0;
  private gustTimer     = 0;
  private notifiedApproach = false;
  private notifiedArrival  = false;

  // ── Time warp ─────────────────────────────────────────────────────────────
  private timeScale = 1;
  private warpText!: Phaser.GameObjects.Text;
  private baseTimestamp = 480; // world clock at takeoff (minutes)


  constructor() { super({ key: 'FlightScene' }); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(data: FlightSceneData): void {
    this.contractId          = data.contractId;
    this.landed              = false;
    this.hasBeenAirborne     = false;
    this.scrollX             = 0;
    this.shakeDuration       = 0;
    this.gearToggleCooldown  = 0;
    this.flapsToggleCooldown = 0;
    this.engineRunning       = true;
    this.eventModalOpen      = false;
    this.lastEventCheckAt    = 0;
    this.pendingTouchdown    = null;
    this.rollout             = false;
    this.rolloutResult       = null;
    this.gustTimer           = 0;
    this.notifiedApproach    = false;
    this.notifiedArrival     = false;
    this.timeScale           = 1;
  }

  create(): void {
    const { width, height } = this.cameras.main;
    const groundY = height - GROUND_Y_OFFSET;
    fadeIn(this);

    // ── Physics init ──────────────────────────────────────────────────────
    const { owned, def: definition } = SaveService.getActiveAircraft();

    this.controller = new AircraftController(definition);
    this.state      = this.controller.initialState();
    this.state.fuel        = owned.fuel;
    this.state.integrity   = owned.integrity;
    this.state.engineTemp  = owned.engineTemp;

    // Stall buffet shakes the camera; touchdown captures true impact values
    this.controller.onBuffet = () => {
      if (this.shakeDuration < 50) SoundEngine.stallBuffet();
      this.shakeDuration = Math.max(this.shakeDuration, 150);
      this.disengageWarp('stall warning');
    };
    this.controller.onTouchdown = (vs, speed) => { this.pendingTouchdown = { vs, speed }; };

    this.baseTimestamp = SaveService.get().world.gameTimestamp;

    this.weather = new WeatherSystem();
    FlightEventService.reset(definition);

    // ── Route length (gameplay scale, from the contract's settlements) ─────
    const save = SaveService.get();
    const contract = save.world.availableContracts.find(c => c.id === this.contractId);
    let destinationName = 'destination';
    if (contract) {
      const origin = window.gameData.settlements.find(s => s.id === contract.originId);
      const dest   = window.gameData.settlements.find(s => s.id === contract.destinationId);
      if (origin && dest) {
        const loreKm = pixelsToKm(
          distance(origin.position.x, origin.position.y, dest.position.x, dest.position.y), 0.5,
        );
        this.routeKm = clamp(2.5 + loreKm / 60, 2.5, 10);
        destinationName = dest.name;
      }
    }
    this.destinationName = destinationName;
    EventBus.emit('flight:route-info', { routeKm: this.routeKm, destinationName });

    // ── Cargo hold: what's riding in the back ─────────────────────────────
    this.cargo = new CargoHold(contract ?? null, window.gameData.goods);
    this.lastCargoEmit = 0;
    FlightEventService.onCargoDamage = amount => this.cargo.applyDamage(amount);

    // ── Build scene (back → front) ────────────────────────────────────────
    this.world    = new ParallaxWorld(this, width, height, groundY);
    this.aircraft = new AircraftSprite(this, AIRCRAFT_X, groundY, definition);
    this.fx       = new WeatherFX(this, width, height);

    // ── In-canvas approach indicator ──────────────────────────────────────
    this.approachText = this.add.text(width / 2, height / 2 - 30, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#00000099', padding: { x: 14, y: 6 },
    }).setOrigin(0.5).setDepth(10).setAlpha(0);

    this.add.text(width - 12, height - 12,
      'W/S: Throttle   A/D: Pitch   F: Flaps   G: Gear   E: Engine   T: Time ×4/×8   M: Mute   ESC: Abort',
      { fontSize: '11px', color: '#5a6a5a', fontFamily: 'monospace',
        backgroundColor: '#00000055', padding: { x: 6, y: 4 } }
    ).setOrigin(1, 1).setDepth(10);

    this.warpText = this.add.text(14, 14, '»» TIME ×4', {
      fontSize: '15px', color: '#ffd080', fontFamily: 'monospace', fontStyle: 'bold',
      backgroundColor: '#00000088', padding: { x: 8, y: 4 },
    }).setDepth(10).setVisible(false);

    // ── Input ─────────────────────────────────────────────────────────────
    this.keys = {
      W:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      S:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      A:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      D:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      E:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      G:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.G),
      F:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      T:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.T),
      M:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.M),
      ESC: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
    };

    // DEV: number keys force weather conditions for testing
    if (import.meta.env.DEV) {
      this.input.keyboard!.on('keydown', (ev: KeyboardEvent) => {
        const condition = DEV_WEATHER_KEYS[ev.key];
        if (condition) this.weather.forceCondition(condition);
      });
    }

    // ── Event wiring ──────────────────────────────────────────────────────
    // Physics pauses while a flight-event modal is up; the chosen consequence
    // is applied to the authoritative state here (React only reports the choice).
    this.eventUnsubs = [
      EventBus.on('ui:show-event-modal',  () => { this.eventModalOpen = true; }),
      EventBus.on('ui:close-event-modal', () => { this.eventModalOpen = false; }),
      EventBus.on('flight:apply-event-choice', ({ choiceId }) => {
        this.state = FlightEventService.applyChoice(choiceId, this.state);
      }),
      EventBus.on('weather:changed', ({ state: weather }) => {
        this.world.setWeather(weather.condition);
        this.fx.setCondition(weather.condition);
        this.disengageWarp('weather changing');
        FlightEventService.checkWeatherEvents(this.state);
      }),
      // Events play their visual cinematic first, then the modal opens
      EventBus.on('flight:event-triggered', ({ event }) => {
        this.disengageWarp(event.title.toLowerCase());
        this.playEventCinematic(event, () => EventBus.emit('ui:show-event-modal', { event }));
      }),
    ];
    this.events.once('shutdown', () => {
      this.eventUnsubs.forEach(u => u());
      this.eventUnsubs = [];
      SoundEngine.stopFlightLoop();
    });
    SoundEngine.unlock();
    SoundEngine.startFlightLoop();

    // ── First draw ────────────────────────────────────────────────────────
    this.world.update(0, {
      scrollX: 0, altitude: 0, windX: 0,
      routeTotalKm: this.routeKm, condition: this.weather.current.condition,
      minutesOfDay: this.baseTimestamp % 1440,
      visibility: this.weather.current.visibility,
    });
    EventBus.emit('flight:state-update', this.state);
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  update(time: number, delta: number): void {
    if (this.landed || this.eventModalOpen) return;

    const dt = delta / 1000;
    const { height } = this.cameras.main;
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
        SoundEngine.gearMove();
        EventBus.emit('flight:gear-toggled', { down: this.state.gearDown });
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.M)) {
      const muted = SoundEngine.toggleMute();
      EventBus.emit('ui:show-notification', { message: muted ? 'Sound muted.' : 'Sound on.', type: 'info' });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.F) && this.flapsToggleCooldown === 0) {
      this.state.flapsDeployed = !this.state.flapsDeployed;
      this.flapsToggleCooldown = 500;
      SoundEngine.flapMove();
      EventBus.emit('flight:flaps-toggled', { deployed: this.state.flapsDeployed });
      EventBus.emit('ui:show-notification', {
        message: this.state.flapsDeployed
          ? 'Flaps DOWN — extra lift and a lower stall speed for takeoff/landing, at the cost of drag.'
          : 'Flaps UP — clean wing for cruise.',
        type: 'info',
      });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.T)) {
      if (this.timeScale === 4) {
        this.timeScale = 8;
        this.warpText.setText('»» TIME ×8').setVisible(true);
        EventBus.emit('ui:show-notification', { message: '»» Time warp ×8.', type: 'info' });
      } else if (this.timeScale > 4) {
        this.timeScale = 1;
        this.warpText.setVisible(false);
        EventBus.emit('ui:show-notification', { message: 'Time warp off.', type: 'info' });
      } else if (this.state.altitude > 60 && !this.rollout) {
        this.timeScale = 4;
        this.warpText.setText('»» TIME ×4').setVisible(true);
        EventBus.emit('ui:show-notification', { message: '»» Time warp ×4 — press T again for ×8. Auto-disengages when something needs you.', type: 'info' });
      } else {
        EventBus.emit('ui:show-notification', { message: 'Time warp needs stable flight above 60 m.', type: 'warning' });
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
      EventBus.emit('scene:return-to-map');
      EventBus.emit('ui:show-notification', { message: 'Flight aborted.', type: 'warning' });
      fadeToScene(this, 'MapScene');
      return;
    }

    // ── Time warp: everything below advances on scaled time ───────────────
    const sdt = dt * this.timeScale;

    // ── Weather → wind ─────────────────────────────────────────────────────
    this.weather.update(delta * this.timeScale);
    const windX = this.weather.windX() * 0.4;

    // ── Physics (fixed-step, frame-rate independent) ───────────────────────
    this.state = this.controller.update(this.state, input, sdt, windX);

    // ── Turbulence: gusts nudge the aircraft, dt-scaled so a storm is rough
    //    but flyable (previously this was per-frame and slammed you down) ────
    const turbulence = this.weather.current.turbulenceIntensity;
    if (turbulence > 0 && this.state.altitude > 25) {
      this.state.verticalSpeed += (Math.random() - 0.5) * turbulence * 7 * sdt;
      this.state.pitch = clamp(this.state.pitch + (Math.random() - 0.5) * turbulence * 9 * sdt, -30, 30);
      this.gustTimer -= sdt;
      if (turbulence > 0.3 && this.gustTimer <= 0) {
        this.gustTimer = 0.8 + Math.random() * 1.4;
        this.cameras.main.shake(200, 0.003 + turbulence * 0.005);
      }
    }

    // ── Warp auto-disengage: anything needing attention hands control back ─
    if (this.timeScale > 1) {
      const remaining = this.routeKm - this.state.distanceTravelled;
      if (this.state.engineTemp >= 0.85)      this.disengageWarp('engine overheating');
      else if (this.state.fuel < 15)          this.disengageWarp('fuel critical');
      else if (remaining <= 1.8)              this.disengageWarp('destination ahead');
      else if (this.state.altitude < 60)      this.disengageWarp('low altitude');
      else if (this.state.integrity < 30)     this.disengageWarp('airframe critical');
    }

    // Fuel warning (every 5s)
    if (this.state.fuel < 15 && Math.floor(time / 5000) !== Math.floor((time - delta) / 5000)) {
      SoundEngine.warn();
      EventBus.emit('ui:show-notification', {
        message: `⚠ FUEL CRITICAL: ${this.state.fuel.toFixed(0)} L remaining`,
        type: 'danger',
      });
    }

    // Engine overheat warning
    if (this.state.engineTemp > 0.85 && Math.floor(time / 8000) !== Math.floor((time - delta) / 8000)) {
      SoundEngine.warn();
      EventBus.emit('ui:show-notification', {
        message: 'ENGINE OVERHEATING — reduce throttle',
        type: 'warning',
      });
    }

    // ── Airborne tracking ──────────────────────────────────────────────────
    if (this.state.altitude > 5) this.hasBeenAirborne = true;

    // ── Cargo condition ────────────────────────────────────────────────────
    if (this.cargo.hasCargo) {
      this.cargo.update(sdt, turbulence);
      if (this.state.elapsedSeconds - this.lastCargoEmit >= 1) {
        this.lastCargoEmit = this.state.elapsedSeconds;
        EventBus.emit('flight:cargo-update', {
          average: this.cargo.averageCondition(),
          count: this.cargo.slots.length,
        });
      }
    }

    // ── Touchdown: grade the exact moment the wheels meet the ground ──────
    if (this.pendingTouchdown && this.hasBeenAirborne && !this.rollout) {
      const { vs, speed } = this.pendingTouchdown;
      const result = this.evaluateLanding(vs, speed);
      this.aircraft.notifyTouchdown(vs);
      SoundEngine.touchdown(vs);
      this.world.addSkidMark(this.scrollX + AIRCRAFT_X);
      this.cargo.applyDamage(result.cargoDamagePercent);

      if (result.quality === 'crash') {
        this.cameras.main.shake(600, 0.014);
        this.finishFlight(result);
        return;
      }
      if (result.quality === 'hard') this.cameras.main.shake(450, 0.008);
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
        this.state.speed = Math.max(0, this.state.speed - 6 * sdt);
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

    // ── Approach / arrival callouts ────────────────────────────────────────
    const remainingKm = this.routeKm - this.state.distanceTravelled;
    if (!this.notifiedApproach && remainingKm <= 1.5 && this.hasBeenAirborne) {
      this.notifiedApproach = true;
      EventBus.emit('ui:show-notification', {
        message: `${this.destinationName} ahead — begin your approach`, type: 'info',
      });
    }
    if (!this.notifiedArrival && remainingKm <= 0.15 && this.hasBeenAirborne) {
      this.notifiedArrival = true;
      EventBus.emit('ui:show-notification', {
        message: `Runway below — land now to deliver`, type: 'success',
      });
    }

    // Flight events — only once airborne, at most one check every 3 seconds
    if (this.hasBeenAirborne && this.state.elapsedSeconds - this.lastEventCheckAt >= 3) {
      this.lastEventCheckAt = this.state.elapsedSeconds;
      FlightEventService.checkEvents(this.state);
    }

    // ── World & weather visuals ────────────────────────────────────────────
    this.scrollX += this.state.groundSpeed * sdt * WORLD_PX_PER_M;
    this.world.update(sdt, {
      scrollX: this.scrollX,
      altitude: this.state.altitude,
      windX,
      routeTotalKm: this.routeKm,
      condition: this.weather.current.condition,
      minutesOfDay: (this.baseTimestamp + this.state.elapsedSeconds) % 1440,
      visibility: this.weather.current.visibility,
    });
    this.fx.update(sdt);

    // ── Aircraft ───────────────────────────────────────────────────────────
    this.aircraft.setTurbulence(turbulence);
    this.aircraft.container.setY(this.world.altitudeToScreenY(this.state.altitude));
    this.aircraft.update(sdt, this.state);

    // ── Camera shake (stall buffet) ────────────────────────────────────────
    if (this.shakeDuration > 0) {
      this.shakeDuration -= delta;
      this.cameras.main.shake(80, 0.003);
    }

    // ── Approach guidance ──────────────────────────────────────────────────
    this.updateApproachIndicator();

    // ── Audio: engine drone + wind rush follow the flight state ───────────
    const rpm = this.engineRunning ? 0.15 + this.state.throttle * 0.85 : 0;
    SoundEngine.updateFlight(
      rpm,
      this.state.throttle,
      clamp(this.state.speed / 60, 0, 1),
      this.timeScale,
    );

    // ── Events to React ────────────────────────────────────────────────────
    EventBus.emit('flight:state-update', this.state);
  }

  // ── Approach indicator ─────────────────────────────────────────────────────

  private updateApproachIndicator(): void {
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
      label = '▼  SINKING FAST — PULL UP';
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

  /** Drop out of time warp with a reason the player can act on. */
  private disengageWarp(reason: string): void {
    if (this.timeScale === 1) return;
    this.timeScale = 1;
    this.warpText.setVisible(false);
    EventBus.emit('ui:show-notification', { message: `Time warp off — ${reason}.`, type: 'warning' });
  }

  // ── Event cinematics ──────────────────────────────────────────────────────
  // Physics keeps running during these (the modal hasn't opened yet), so the
  // player sees the event HAPPEN before being asked what to do about it.

  private playEventCinematic(event: FlightEventDefinition, done: () => void): void {
    switch (event.id) {
      case 'bird_strike':        this.cinematicBirdStrike(done); return;
      case 'fuel_leak':          this.cinematicFuelLeak(done); return;
      case 'engine_overheating': this.cinematicOverheat(done); return;
      default:                   this.time.delayedCall(350, done); return;
    }
  }

  /** A flock crosses the screen; one hits the nose in a burst of feathers. */
  private cinematicBirdStrike(done: () => void): void {
    const { width } = this.cameras.main;
    const py = this.aircraft.nosePoint().y;

    for (let i = 0; i < 7; i++) {
      const b = this.add.image(width + 30 + i * 34, py - 28 + (i % 3) * 18, 'px_streak')
        .setTint(0x181209).setScale(1.5, 0.9).setDepth(6);
      this.tweens.add({
        targets: b,
        x: -80,
        y: b.y + (Math.random() * 26 - 13),
        duration: 950 + i * 70,
        ease: 'Linear',
        onComplete: () => b.destroy(),
      });
      this.tweens.add({ targets: b, scaleY: 0.3, duration: 95, yoyo: true, repeat: 10 });
    }

    this.time.delayedCall(480, () => {
      const nose = this.aircraft.nosePoint();
      const feathers = this.add.particles(nose.x, nose.y, 'px_streak', {
        lifespan: { min: 400, max: 900 },
        speed: { min: 50, max: 190 },
        angle: { min: 0, max: 360 },
        rotate: { min: 0, max: 360 },
        scale: { start: 0.6, end: 0.15 },
        alpha: { start: 0.95, end: 0 },
        tint: [0xd8d0c0, 0x8a6a4a, 0x4a3a28],
        gravityY: 120,
        emitting: false,
      }).setDepth(7);
      feathers.explode(20);
      this.cameras.main.shake(260, 0.007);
      this.time.delayedCall(1100, () => feathers.destroy());
    });

    this.time.delayedCall(1250, done);
  }

  /** White mist bursts from the wing and keeps streaming for the flight. */
  private cinematicFuelLeak(done: () => void): void {
    const wing = this.aircraft.wingPoint();
    const burst = this.add.particles(wing.x, wing.y, 'px_soft', {
      lifespan: { min: 300, max: 700 },
      speed: { min: 30, max: 120 },
      angle: { min: 120, max: 240 },
      scale: { start: 0.3, end: 0.05 },
      alpha: { start: 0.7, end: 0 },
      tint: 0xcfe8f2,
      emitting: false,
    }).setDepth(7);
    burst.explode(12);
    this.aircraft.setFuelLeak(true);
    this.time.delayedCall(900, () => burst.destroy());
    this.time.delayedCall(700, done);
  }

  /** Dark smoke coughs out of the cowl with a shudder. */
  private cinematicOverheat(done: () => void): void {
    const eng = this.aircraft.enginePoint();
    const smoke = this.add.particles(eng.x, eng.y, 'px_soft', {
      lifespan: { min: 500, max: 1100 },
      speedX: { min: -120, max: -40 },
      speedY: { min: -50, max: 10 },
      scale: { start: 0.4, end: 1.0 },
      alpha: { start: 0.6, end: 0 },
      tint: [0x2a2622, 0x413a30],
      emitting: false,
    }).setDepth(7);
    smoke.explode(14);
    this.cameras.main.shake(180, 0.004);
    this.time.delayedCall(1100, () => smoke.destroy());
    this.time.delayedCall(650, done);
  }

  // ── Landing ───────────────────────────────────────────────────────────────

  private finishFlight(result: LandingResult): void {
    if (this.landed) return;
    this.landed = true;
    const data = {
      result,
      contractId: this.contractId,
      finalState: this.state,
      cargoSlots: this.cargo.slots,
      reachedDestination: this.state.distanceTravelled >= this.routeKm * 0.9,
    };
    if (result.quality === 'crash') SoundEngine.crash(); else SoundEngine.chime();
    if (result.quality === 'crash') {
      flashToScene(this, 'PostFlightScene', data);
    } else {
      fadeToScene(this, 'PostFlightScene', data);
    }
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
