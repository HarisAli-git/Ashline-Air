import Phaser from 'phaser';
import { AircraftController, type FlightInput } from '../entities/aircraft/AircraftController';
import { AircraftSprite } from '../entities/aircraft/AircraftSprite';
import { CrashSequence } from '../entities/aircraft/CrashSequence';
import { WeatherSystem } from '../entities/weather/WeatherSystem';
import { WeatherHazards } from '../entities/weather/WeatherHazards';
import { ParallaxWorld, WORLD_PX_PER_M } from '../world/ParallaxWorld';
import { biomeFor } from '../world/Biomes';
import { WeatherFX } from '../world/WeatherFX';
import { FlightEventService } from '../../services/FlightEventService';
import { SaveService } from '../../services/SaveService';
import { CargoHold } from '../entities/CargoHold';
import { EventBus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import type { FlightState, FlightEventDefinition, LandingQuality, LandingResult, WeatherCondition } from '../../types';
import { clamp, distance, pixelsToKm } from '../utils/math';
import type { ApproachKind, FlightAction } from '../../types';
import { isTouchDevice } from '../utils/device';
import { CameraRig } from './CameraRig';
import { TouchInput } from '../utils/touchInput';

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
  private readonly hazards = new WeatherHazards();
  private state!: FlightState;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;

  // ── Visuals ───────────────────────────────────────────────────────────────
  private world!: ParallaxWorld;
  private fx!: WeatherFX;
  private aircraft!: AircraftSprite;
  /** Framing that makes the physics visible — see CameraRig. */
  private rig!: CameraRig;
  private crash!: CrashSequence;
  private crashing = false;
  private engineRunning = true;

  // ── In-canvas HUD (approach guidance only — gauges live in React) ────────
  private approachText!: Phaser.GameObjects.Text;

  // ── Scene state ───────────────────────────────────────────────────────────
  private contractId!: string;
  private routeKm = 6;          // gameplay-scale route length to the destination
  private destinationName = 'destination';
  /** Usable runway at each end, metres — from the settlements' field profiles. */
  private originRunwayM = 600;
  private destRunwayM = 600;
  /** Surface each field is paved with — drives how the runway is drawn. */
  private originSurface: ApproachKind = 'open';
  private destSurface: ApproachKind = 'open';
  private originBiome = biomeFor(undefined);
  private destBiome = biomeFor(undefined);
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
  private smoothDt      = 1 / 60; // low-passed frame delta, kills scroll judder
  private shakeDuration = 0;
  private gustTimer     = 0;
  /** Slow wave driving sustained gusts and downdraughts. */
  private gustPhase = 0;
  /** Traffic passed inside 30 m without hitting it — paid out on delivery. */
  private closeCalls = 0;
  private notifiedApproach = false;
  private notifiedArrival  = false;

  // ── Threat / systems state ────────────────────────────────────────────────
  private stallWarning   = false;
  private underFire      = false;
  private hazardAlertAt  = -99;   // last obstacle klaxon
  private overspeedWarnAt = -99;
  private trafficAlertAt = -99;   // last traffic advisory
  private threatAlertAt  = -99;   // last "hostile ground ahead" call
  /** What is shooting at us and the altitude that clears it. */
  private groundThreat: { label: string; clearM: number } | null = null;
  private threatHold = 0;         // keeps the caution readable between bursts
  /** Current weather caution text, or null. */
  private weatherCaution: string | null = null;
  private iceLoad = 0;
  private avionicsOut = false;
  private trafficAdvisory: number | null = null; // their height minus ours, m
  private trafficAvoid: 1 | -1 | null = null;    // +1 climb, -1 descend
  private engineFailed   = false;
  private failureCheckAt = 0;
  private restartHoldFor = 0;     // seconds of cranking left

  // ── Time warp ─────────────────────────────────────────────────────────────
  private timeScale = 1;
  private warpText!: Phaser.GameObjects.Text;
  private baseTimestamp = 480; // world clock at takeoff (minutes)


  constructor() { super({ key: 'FlightScene' }); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(data: FlightSceneData): void {
    this.contractId          = data.contractId;
    this.landed              = false;
    this.crashing            = false;
    this.hasBeenAirborne     = false;
    this.scrollX             = 0;
    this.smoothDt            = 1 / 60;
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
    this.stallWarning        = false;
    this.underFire           = false;
    this.hazardAlertAt       = -99;
    this.overspeedWarnAt     = -99;
    this.trafficAlertAt      = -99;
    this.threatAlertAt       = -99;
    this.groundThreat        = null;
    this.threatHold          = 0;
    this.weatherCaution      = null;
    this.iceLoad             = 0;
    this.avionicsOut         = false;
    this.trafficAdvisory     = null;
    this.trafficAvoid        = null;
    this.engineFailed        = false;
    this.failureCheckAt      = 0;
    this.restartHoldFor      = 0;
  }

  /** Kept so it can be repositioned on resize and hidden on touch devices. */
  private keyHintText!: Phaser.GameObjects.Text;

  /**
   * Re-fit to a new design canvas without restarting — a flight in progress
   * must survive a window resize or a device rotation.
   *
   * Only the WIDTH ever changes (`DESIGN_H` is fixed, see GameSize.ts), so the
   * ground line, the altitude bands and every physics-facing constant are
   * untouched; this is purely the horizontal furniture.
   */
  relayout(width: number, height: number): void {
    const groundY = height - GROUND_Y_OFFSET;
    this.cameras.resize(width, height);
    this.world?.resize(width, height, groundY);
    this.fx?.resize(width, height);
    this.approachText?.setPosition(width / 2, height / 2 - 30);
    this.keyHintText?.setPosition(width - 12, 12);
  }

  create(): void {
    const { width, height } = this.cameras.main;
    const groundY = height - GROUND_Y_OFFSET;
    fadeIn(this);
    // A button still held when the last flight ended must not leak into this one
    TouchInput.reset();

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
    this.hazards.reset();
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
        this.routeKm = clamp(1.8 + loreKm / 110, 1.8, 5);
        destinationName = dest.name;
        this.originRunwayM = origin.field?.runwayM ?? 600;
        this.destRunwayM = dest.field?.runwayM ?? 600;
        this.originSurface = origin.field?.approach ?? 'open';
        this.destSurface = dest.field?.approach ?? 'open';
      }
    }
    this.destinationName = destinationName;
    this.originBiome = biomeFor(contract?.originId);
    this.destBiome = biomeFor(contract?.destinationId);
    EventBus.emit('flight:route-info', { routeKm: this.routeKm, destinationName });

    // ── Cargo hold: what's riding in the back ─────────────────────────────
    this.cargo = new CargoHold(contract ?? null, window.gameData.goods);
    this.lastCargoEmit = 0;
    FlightEventService.onCargoDamage = amount => this.cargo.applyDamage(amount);

    // ── Build scene (back → front) ────────────────────────────────────────
    this.world    = new ParallaxWorld(this, width, height, groundY);
    // Obstacles and raider ground are deterministic per contract, so a route
    // you have flown before hands you the same threats.
    this.world.setRoute(this.routeKm, this.hashRoute(this.contractId));

    // ── The frequency is not empty ────────────────────────────────────────
    // Other pilots call their intentions before they fly them, so a conflict
    // has a voice attached to it rather than being a silent number on the HUD.
    this.world.traffic.onRadio = msg => {
      EventBus.emit('ui:show-notification', { message: `📻 ${msg}`, type: 'info' });
      SoundEngine.click();
    };
    // Threading a needle is the most satisfying thing in the flight, so it is
    // recognised and paid for. Anything under 30 m counts; under 12 m is a
    // genuinely fine piece of flying.
    this.world.traffic.onNearMiss = (sep) => {
      this.closeCalls++;
      const tight = sep < 12;
      EventBus.emit('ui:show-notification', {
        message: tight
          ? `⚡ THREADED IT — ${Math.round(sep)} m separation. That was flying.`
          : `✈ Close call — ${Math.round(sep)} m. Both of you saw it coming.`,
        type: tight ? 'success' : 'info',
      });
      SoundEngine.chime();
    };
    // The land itself changes between the two settlements
    this.world.setBiomes(this.originBiome, this.destBiome);
    // The garrison at both fields flies the destination faction's colours
    const destSettlement = window.gameData.settlements.find(s => s.id === contract?.destinationId);
    const faction = window.gameData.factions.find(f => f.id === destSettlement?.factionId);
    if (faction) this.world.setFactionColor(parseInt(faction.color.replace('#', ''), 16));
    this.aircraft = new AircraftSprite(this, AIRCRAFT_X, groundY, definition);
    this.rig = new CameraRig(this.cameras.main, this.controller.vStall, this.controller.vMax);
    this.crash    = new CrashSequence(this, this.aircraft, groundY);
    this.fx       = new WeatherFX(this, width, height);

    // ── In-canvas approach indicator ──────────────────────────────────────
    this.approachText = this.add.text(width / 2, height / 2 - 30, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#00000099', padding: { x: 14, y: 6 },
    }).setOrigin(0.5).setDepth(10).setAlpha(0);

    // Keyboard legend, TOP right. The bottom of the canvas belongs to the
    // React instrument panel, whose height in design units varies with the
    // display scale — anything anchored to the bottom edge disappears behind
    // it on some screens and not others. The top-right corner is always free.
    this.keyHintText = this.add.text(width - 12, 12,
      'W/S: Throttle   A/D: Pitch   F: Flaps   G: Gear   E: Engine/Restart   T: Time   M: Mute   ESC: Abort',
      { fontSize: '11px', color: '#5a6a5a', fontFamily: 'monospace',
        backgroundColor: '#00000055', padding: { x: 6, y: 4 } }
    ).setOrigin(1, 0).setDepth(10).setVisible(!isTouchDevice());

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

    // DEV: number keys force weather conditions, 0 pulls the next traffic
    // encounter forward so conflicts can be exercised without waiting them out
    if (import.meta.env.DEV) {
      this.input.keyboard!.on('keydown', (ev: KeyboardEvent) => {
        const condition = DEV_WEATHER_KEYS[ev.key];
        if (condition) this.weather.forceCondition(condition);
        if (ev.key === '0') this.world.traffic.provoke();
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
      // A choice that names a manoeuvre has to FLY it. Stat pokes alone are
      // why "Divert to the nearest settlement" read as doing nothing at all.
      EventBus.on('flight:event-action', ({ action, value }) => this.runEventAction(action, value)),
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
      this.rig?.reset();
      this.eventUnsubs.forEach(u => u());
      this.eventUnsubs = [];
      SoundEngine.stopFlightLoop();
      this.crash.destroy();
    });
    SoundEngine.unlock();
    SoundEngine.stopAmbient();
    SoundEngine.startFlightLoop();

    // ── First draw ────────────────────────────────────────────────────────
    this.world.update(0, {
      scrollX: 0, altitude: 0, windX: 0,
      routeTotalKm: this.routeKm,
      originRunwayM: this.originRunwayM,
      destRunwayM: this.destRunwayM,
      originSurface: this.originSurface,
      destSurface: this.destSurface, condition: this.weather.current.condition,
      minutesOfDay: this.baseTimestamp % 1440,
      visibility: this.weather.current.visibility,
      progress: 0,
    });
    EventBus.emit('flight:state-update', this.state);
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  update(time: number, delta: number): void {
    if (this.crashing) { this.updateCrashSlide(delta / 1000); return; }
    if (this.landed || this.eventModalOpen) return;

    // Browsers hand out jittery frame deltas — ±2 ms is normal even on a
    // locked 60 Hz display, and a tab hiccup gives one 40 ms frame followed by
    // a 4 ms one. The physics runs on a fixed-step accumulator so it doesn't
    // care, but the world scroll is a straight dt multiply: unsmoothed, that
    // jitter becomes ±1–2 px of scroll variance every single frame, which is
    // exactly the judder you see in the terrain. A light low-pass keeps the
    // long-run total honest while handing the renderer an even cadence.
    const rawDt = Math.min(delta / 1000, 0.05);
    this.smoothDt += (rawDt - this.smoothDt) * 0.2;
    const dt = this.smoothDt;
    const { height } = this.cameras.main;
    const groundY = height - GROUND_Y_OFFSET;

    // ── Cooldowns ──────────────────────────────────────────────────────────
    this.gearToggleCooldown  = Math.max(0, this.gearToggleCooldown  - delta);
    this.flapsToggleCooldown = Math.max(0, this.flapsToggleCooldown - delta);

    // ── Input ──────────────────────────────────────────────────────────────
    // Keyboard OR on-screen control — a tablet with a keyboard attached is not
    // an either/or, so the two sources are simply combined.
    const input: FlightInput = {
      throttleUp:   this.keys.W.isDown || TouchInput.isHeld('throttleUp'),
      throttleDown: this.keys.S.isDown || TouchInput.isHeld('throttleDown'),
      pitchUp:      this.keys.A.isDown || TouchInput.isHeld('pitchUp'),
      pitchDown:    this.keys.D.isDown || TouchInput.isHeld('pitchDown'),
      engineOn:     this.engineRunning,
    };

    // The touch throttle is a LEVER: it gives an absolute demand, which is
    // turned back into the same up/down the keyboard produces so the engine
    // still spools at its own rate. Snapping the throttle straight to the
    // slider position would let a finger flick bypass the spool entirely.
    const demand = TouchInput.getThrottleTarget();
    if (demand !== null) {
      input.throttleUp   = this.state.throttle < demand - 0.015;
      input.throttleDown = this.state.throttle > demand + 0.015;
    }

    if ((Phaser.Input.Keyboard.JustDown(this.keys.E) || TouchInput.consume('engine'))) {
      if (this.engineFailed) {
        // A failed engine needs cranking — it does not just snap back on
        if (this.restartHoldFor <= 0) {
          this.restartHoldFor = 2.2;
          SoundEngine.engineSputter();
          EventBus.emit('ui:show-notification', { message: 'Cranking…', type: 'warning' });
        }
      } else {
        this.engineRunning = !this.engineRunning;
        if (this.engineRunning) {
          this.aircraft.startEngine();
          SoundEngine.engineStart();
          EventBus.emit('ui:show-notification', { message: 'Engine started.', type: 'success' });
        } else {
          this.aircraft.stopEngine();
          SoundEngine.engineStop();
          EventBus.emit('ui:show-notification', { message: 'Engine shut down.', type: 'warning' });
        }
      }
    }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.G) || TouchInput.consume('gear')) && this.gearToggleCooldown === 0) {
      if (!this.aircraft.hasRetractableGear) {
        EventBus.emit('ui:show-notification', { message: 'This aircraft has fixed landing gear.', type: 'info' });
        this.gearToggleCooldown = 500;
      } else {
        this.state.gearDown = !this.state.gearDown;
        this.aircraft.setGearDown(this.state.gearDown);
        this.gearToggleCooldown = 500;
        SoundEngine.gearMove(this.state.gearDown);
        EventBus.emit('flight:gear-toggled', { down: this.state.gearDown });
      }
    }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.M) || TouchInput.consume('mute'))) {
      const muted = SoundEngine.toggleMute();
      EventBus.emit('ui:show-notification', { message: muted ? 'Sound muted.' : 'Sound on.', type: 'info' });
    }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.F) || TouchInput.consume('flaps')) && this.flapsToggleCooldown === 0) {
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
    if ((Phaser.Input.Keyboard.JustDown(this.keys.T) || TouchInput.consume('time'))) {
      if (this.timeScale === 4) {
        this.timeScale = 8;
        this.warpText.setText('»» TIME ×8').setVisible(true);
        EventBus.emit('ui:show-notification', { message: '»» Time warp ×8.', type: 'info' });
      } else if (this.timeScale > 4) {
        this.timeScale = 1;
        this.warpText.setVisible(false);
        EventBus.emit('ui:show-notification', { message: 'Time warp off.', type: 'info' });
      } else if (this.state.altitude > 30 && !this.rollout) {
        this.timeScale = 4;
        this.warpText.setText('»» TIME ×4').setVisible(true);
        EventBus.emit('ui:show-notification', { message: `»» Time warp ×4 — ${isTouchDevice() ? 'tap TIME again' : 'press T again'} for ×8. Auto-disengages when something needs you.`, type: 'info' });
      } else {
        EventBus.emit('ui:show-notification', { message: 'Time warp needs stable flight above 30 m.', type: 'warning' });
      }
    }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.ESC) || TouchInput.consume('abort'))) {
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

    // ── Weather with teeth ────────────────────────────────────────────────
    // Icing, lightning and sand ingestion, each with its own answer. Applied
    // before turbulence so the degraded lift is what the gusts act on.
    this.applyWeatherHazards(sdt);

    // ── Turbulence: gusts nudge the aircraft, dt-scaled so a storm is rough
    //    but flyable (previously this was per-frame and slammed you down) ────
    const turbulence = this.weather.current.turbulenceIntensity;

    // Rough air makes the aeroplane HARDER TO FLY, not merely bumpy: the tail
    // is working in disturbed flow, so the airframe stops holding an attitude
    // for you and the controls go vague.
    this.state.modifiers.stabilityMult = clamp(1 - turbulence * 0.55, 0.35, 1);

    // Sustained gusts and downdraughts, layered UNDER the white noise. A storm
    // that only jitters reads as vibration; what actually catches a pilot out
    // is air that pushes the aeroplane one way for several seconds — which is
    // why this is a slow wave, not another random number.
    if (turbulence > 0 && this.state.altitude > 8) {
      this.gustPhase += sdt * (0.35 + turbulence * 0.5);
      const shear = Math.sin(this.gustPhase) * Math.sin(this.gustPhase * 0.37 + 1.1);
      this.state.verticalSpeed += shear * turbulence * 9 * sdt;
      this.state.pitchRate += shear * turbulence * 14 * sdt;
    }

    if (turbulence > 0 && this.state.altitude > 12) {
      this.state.verticalSpeed += (Math.random() - 0.5) * turbulence * 7 * sdt;
      // Gusts shove the airframe and its own stability rides it out — far more
      // alive than teleporting the pitch angle.
      this.state.pitchRate += (Math.random() - 0.5) * turbulence * 46 * sdt;
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
      else if (this.state.altitude < 30)      this.disengageWarp('low altitude');
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
        this.controller.braking = false;
      } else {
        this.controller.braking = true;
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
    if (this.hasBeenAirborne && this.state.elapsedSeconds - this.lastEventCheckAt >= 9) {
      this.lastEventCheckAt = this.state.elapsedSeconds;
      FlightEventService.checkEvents(this.state);
    }

    // ── Hazards: obstacles are solid, raider ground is hostile ────────────
    const worldX = this.scrollX + AIRCRAFT_X;
    this.updateHazards(worldX, sdt);

    // ── Other traffic: advisories, then the midair if you ignored them ────
    this.updateTraffic(worldX, sdt);
    if (this.landed) return;

    // ── World & weather visuals ────────────────────────────────────────────
    this.scrollX += this.state.groundSpeed * sdt * WORLD_PX_PER_M;
    this.world.update(sdt, {
      scrollX: this.scrollX,
      altitude: this.state.altitude,
      windX,
      routeTotalKm: this.routeKm,
      originRunwayM: this.originRunwayM,
      destRunwayM: this.destRunwayM,
      originSurface: this.originSurface,
      destSurface: this.destSurface,
      condition: this.weather.current.condition,
      minutesOfDay: (this.baseTimestamp + this.state.elapsedSeconds) % 1440,
      visibility: this.weather.current.visibility,
      planeScreenX: AIRCRAFT_X,
      planeScreenY: this.world.altitudeToScreenY(this.state.altitude),
      planeWorldX: worldX,
      speedFrac: clamp(this.state.groundSpeed / 55, 0, 1),
      progress: clamp(this.state.distanceTravelled / Math.max(0.1, this.routeKm), 0, 1),
    });
    this.fx.update(sdt);

    // ── Aircraft ───────────────────────────────────────────────────────────
    this.aircraft.setTurbulence(turbulence);
    this.aircraft.setElevator((input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0));
    this.aircraft.setIceLoad(this.iceLoad);
    // The rig offsets the airframe INSIDE its zone in response to g-load,
    // pitch rate and flight path, so a manoeuvre is something you can see
    // rather than a number that changed. It never slides with airspeed.
    this.rig.update(sdt, this.state, turbulence, this.state.altitude <= 0.5);
    this.aircraft.container.setX(AIRCRAFT_X + this.rig.offsetX);
    this.aircraft.container.setY(
      this.world.altitudeToScreenY(this.state.altitude) + this.rig.offsetY,
    );
    this.aircraft.update(sdt, this.state);

    // ── Camera shake (stall buffet) ────────────────────────────────────────
    if (this.shakeDuration > 0) {
      this.shakeDuration -= delta;
      this.cameras.main.shake(80, 0.003);
    }

    // ── Approach guidance ──────────────────────────────────────────────────
    this.updateApproachIndicator();

    // ── Audio: every continuous layer follows the flight state ────────────
    const rpm = this.engineRunning ? 0.15 + this.state.throttle * 0.85 : 0;
    const roughness = clamp(
      Math.max((this.state.engineTemp - 0.7) / 0.3, (60 - this.state.integrity) / 60), 0, 1,
    );
    SoundEngine.updateFlight({
      rpm,
      throttle: this.engineRunning ? this.state.throttle : 0,
      speedFrac: clamp(this.state.speed / 60, 0, 1),
      onGround: this.state.altitude <= 0.5,
      gearDown: this.state.gearDown,
      flapsDeployed: this.state.flapsDeployed,
      turbulence,
      roughness,
      timeScale: this.timeScale,
    });
    SoundEngine.setStallWarning(this.stallWarning);

    // ── Events to React ────────────────────────────────────────────────────
    EventBus.emit('flight:state-update', this.state);
  }

  /**
   * While the wreck is tumbling: no physics, no input, but the world keeps
   * scrolling — decelerating with the wreckage — so the crash reads as coming
   * to a stop rather than the whole scene freezing at the moment of impact.
   */
  private updateCrashSlide(dt: number): void {
    const sdt = Math.min(dt, 0.05);
    this.crash.update(sdt);
    this.scrollX += this.crash.slideSpeed() * sdt * WORLD_PX_PER_M;
    this.world.update(sdt, {
      scrollX: this.scrollX,
      altitude: 0,
      windX: 0,
      routeTotalKm: this.routeKm,
      originRunwayM: this.originRunwayM,
      destRunwayM: this.destRunwayM,
      originSurface: this.originSurface,
      destSurface: this.destSurface,
      condition: this.weather.current.condition,
      minutesOfDay: (this.baseTimestamp + this.state.elapsedSeconds) % 1440,
      visibility: this.weather.current.visibility,
      planeScreenX: AIRCRAFT_X,
      planeScreenY: this.world.altitudeToScreenY(0),
      planeWorldX: this.scrollX + AIRCRAFT_X,
      speedFrac: 0,
      progress: clamp(this.state.distanceTravelled / Math.max(0.1, this.routeKm), 0, 1),
    });
    this.fx.update(sdt);
  }

  /** True when the given world position is on either airfield's asphalt. */
  private isOnRunway(worldX: number): boolean {
    const PXM = WORLD_PX_PER_M;
    const destPx = Math.max(2000 * PXM, this.routeKm * 1000 * PXM);
    // Same lengths the world draws — the strip you can see IS the strip you
    // have to stop on.
    const oL = this.originRunwayM * PXM, dL = this.destRunwayM * PXM;
    const onOrigin = worldX > -oL * 0.28 && worldX < oL * 0.72;
    const onDest   = worldX > destPx - dL * 0.5 && worldX < destPx + dL * 0.5;
    return onOrigin || onDest;
  }

  /** Stable numeric seed from a contract id. */
  private hashRoute(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 100000;
  }

  // ── Threats: obstacles, raider fire, engine reliability ───────────────────

  /**
   * The cruise decision loop: staying low is fast and cheap but runs you
   * through masts and gunfire; climbing is safe but costs fuel and time.
   */
  private updateHazards(worldX: number, sdt: number): void {
    const hz = this.world.hazards;
    const alt = this.state.altitude;

    // ── Solid obstacles ───────────────────────────────────────────────────
    hz.tickDamage(sdt);
    const hit = hz.collisionAt(worldX, alt);
    if (hit && this.hasBeenAirborne) {
      // The structure takes it too. A one-sided collision — 45 points off the
      // airframe and the mast standing there untouched — is what makes the
      // world read as scenery instead of something you are moving through.
      hz.damageAt(hit, 0.75);
      this.spawnImpactDebris(AIRCRAFT_X, this.world.altitudeToScreenY(alt), 30);
      SoundEngine.impact();
      this.cameras.main.shake(500, 0.012);
      this.state.integrity = clamp(this.state.integrity - 45, 0, 100);
      this.state.speed *= 0.55;
      this.cargo.applyDamage(30);
      EventBus.emit('ui:show-notification', {
        message: `⚠ STRUCK A ${hit.kind.toUpperCase()} — airframe critical`,
        type: 'danger',
      });
      this.disengageWarp('collision');
      if (this.state.integrity <= 0) {
        this.finishFlight({
          verticalSpeed: Math.abs(this.state.verticalSpeed),
          horizontalSpeed: this.state.speed,
          gearDown: this.state.gearDown,
          quality: 'crash',
          integrityDamage: 100,
          cargoDamagePercent: 100,
        });
        return;
      }
      // Shove the aircraft clear so a single structure can't register twice
      this.scrollX += hit.halfWidth * 2 + 40;
    }

    // Klaxon for a tall obstacle we are not currently above. The range is set
    // so the call always lands with enough room to out-climb the obstacle.
    // Range set so the call always lands with room to out-climb the tallest
    // obstacle in the mix (masts now reach 78 m).
    const ahead = hz.ahead(worldX, 3600);
    if (ahead && alt < ahead.hazard.heightM + 12 &&
        this.state.elapsedSeconds - this.hazardAlertAt > 2.5) {
      this.hazardAlertAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
      EventBus.emit('ui:show-notification', {
        message: `▲ OBSTACLE AHEAD — ${Math.round(ahead.hazard.heightM)} m — CLIMB`,
        type: 'warning',
      });
      this.disengageWarp('obstacle ahead');
    }

    // ── Warlord ground fire ───────────────────────────────────────────────
    // Every weapon on the ground has its own reach. Small arms are a nuisance
    // you clear by not being on the deck; an AA battery reaches 340 m and
    // turns "how high do I cruise?" into a decision with a fuel bill attached.
    const fire = this.world.raiderFire(sdt, worldX, this.world.altitudeToScreenY(alt), alt);
    // Hold the caution up briefly after the last round. Weapons drift in and
    // out of range as you cross a zone, and a light that strobes on and off
    // every frame is one the player cannot read.
    if (fire.engaged && fire.label) {
      this.groundThreat = { label: fire.label, clearM: fire.clearAltitudeM };
      this.threatHold = 2.2;
    } else if (this.threatHold > 0) {
      this.threatHold -= sdt;
      if (this.threatHold <= 0) this.groundThreat = null;
    }

    const nowUnderFire = this.groundThreat !== null;
    if (nowUnderFire !== this.underFire) {
      this.underFire = nowUnderFire;
      if (fire.engaged) {
        SoundEngine.warn();
        EventBus.emit('ui:show-notification', {
          message: `⚠ ${fire.label} ENGAGING — CLIMB ABOVE ${Math.round(fire.clearAltitudeM)} m`,
          type: 'danger',
        });
        this.disengageWarp('taking ground fire');
      }
    }
    if (fire.shots > 0) SoundEngine.gunfire();
    if (fire.hit) {
      SoundEngine.bulletHit();
      this.aircraft.notifyHit();
      this.state.integrity = clamp(this.state.integrity - fire.damage, 0, 100);
      this.cameras.main.shake(120, 0.004 + Math.min(0.006, fire.damage * 0.0012));
      if (Math.random() < 0.2) this.cargo.applyDamage(4);
    }

    // Advance call on the next stretch, so there is room to climb over it.
    // Only worth saying if their guns actually out-reach our current height.
    const threat = this.world.threatAhead(worldX, 5200);
    if (threat && alt < threat.ceilingM &&
        this.state.elapsedSeconds - this.threatAlertAt > 8) {
      this.threatAlertAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
      EventBus.emit('ui:show-notification', {
        message: `▲ ${threat.label} AHEAD — CLEAR ALTITUDE ${Math.round(threat.ceilingM)} m`,
        type: 'warning',
      });
      this.disengageWarp('hostile ground ahead');
    }

    // ── Engine reliability: tired engines quit, and you can restart them ──
    if (this.hasBeenAirborne && this.state.elapsedSeconds - this.failureCheckAt >= 5) {
      this.failureCheckAt = this.state.elapsedSeconds;
      if (this.engineRunning && !this.engineFailed) {
        const { def } = SaveService.getActiveAircraft();
        // Heat, damage and a worn airframe all raise the odds
        const risk =
          (1 - def.stats.engineReliability) * 0.05 +
          Math.max(0, this.state.engineTemp - 0.8) * 0.5 +
          Math.max(0, (40 - this.state.integrity) / 40) * 0.06;
        if (Math.random() < risk) {
          this.engineFailed = true;
          this.engineRunning = false;
          this.aircraft.stopEngine();
          SoundEngine.engineSputter();
          EventBus.emit('ui:show-notification', {
            message: '✖ ENGINE FAILURE — hold E to restart, trade height for speed',
            type: 'danger',
          });
          this.disengageWarp('engine failure');
        }
      }
    }
    if (this.restartHoldFor > 0) {
      this.restartHoldFor -= sdt;
      if (this.restartHoldFor <= 0) {
        this.engineFailed = false;
        this.engineRunning = true;
        this.aircraft.startEngine();
        this.state.engineTemp = Math.max(0, this.state.engineTemp - 0.15);
        SoundEngine.engineStart();
        EventBus.emit('ui:show-notification', { message: 'Engine caught — power restored.', type: 'success' });
      }
    }

    // Stall horn tracks the WING — how close the angle of attack is to the
    // critical angle — not raw airspeed. The old speed test screamed STALL at
    // an aeroplane that was flying perfectly well, and stayed silent through
    // a real accelerated stall.
    this.stallWarning = alt > 3 &&
      (this.controller.stallIntensity > 0.02 || this.controller.stallMargin < 0.16);

    // Above ~95% of Vne the airframe is being torn up — the player was losing
    // integrity here with nothing on the panel to explain it.
    const vMax = SaveService.getActiveAircraft().def.stats.maxSpeed / 3.6;
    const overspeed = this.state.speed > vMax * 0.95;
    if (overspeed && this.state.elapsedSeconds - this.overspeedWarnAt > 3) {
      this.overspeedWarnAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
    }

    // Annunciator panel state for the React HUD
    EventBus.emit('flight:status', {
      engineFailed: this.engineFailed,
      underFire: this.underFire,
      groundThreat: this.groundThreat,
      rangedOn: this.world.raiders.rangedOn,
      weatherCaution: this.weatherCaution,
      iceLoad: this.iceLoad,
      avionicsOut: this.avionicsOut,
      stall: this.stallWarning,
      overspeed,
      obstacleAheadM: ahead && alt < ahead.hazard.heightM + 18 ? ahead.hazard.heightM : null,
      trafficDeltaM: this.trafficAdvisory,
      trafficAvoid: this.trafficAvoid,
    });
  }

  // ── Weather that costs you something ──────────────────────────────────────

  /**
   * Ice, lightning and grit. Each hazard degrades the aircraft over time, is
   * announced before it becomes critical, and has one specific action that
   * fixes it — descend out of the icing, restart after a strike, climb out of
   * the sand. Storms are no longer scenery.
   */
  private applyWeatherHazards(sdt: number): void {
    const rep = this.hazards.update(
      sdt, this.weather.current.condition, this.state, this.engineRunning && !this.engineFailed,
    );

    if (rep.damage > 0) {
      this.state.integrity = clamp(this.state.integrity - rep.damage, 0, 100);
    }

    // ── Lightning ─────────────────────────────────────────────────────────
    if (rep.struck) {
      // A bolt that hits YOUR AEROPLANE has to be drawn hitting your
      // aeroplane. It used to be a white screen flash indistinguishable from
      // the ambient storm flicker, which is why a strike read as scenery.
      this.drawLightningStrike();
      this.cameras.main.flash(320, 255, 255, 255);
      this.cameras.main.shake(520, 0.013);
      SoundEngine.thunder();
      SoundEngine.impact();
      this.aircraft.notifyHit();
      // …and it throws the aeroplane about. A strike is a physical event.
      this.state.pitchRate += (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 26);
      this.state.verticalSpeed -= 3 + Math.random() * 4;
      this.disengageWarp('lightning strike');
      EventBus.emit('ui:show-notification', {
        message: '⚡ LIGHTNING STRIKE — engine out, instruments gone. Hold E to restart.',
        type: 'danger',
      });
    }

    // ── Anything that kills the engine ────────────────────────────────────
    if (rep.killEngine && this.engineRunning && !this.engineFailed) {
      this.engineFailed = true;
      this.engineRunning = false;
      this.aircraft.stopEngine();
      SoundEngine.engineSputter();
      this.disengageWarp('engine out');
      if (!rep.struck) {
        EventBus.emit('ui:show-notification', {
          message: '✖ SAND HAS KILLED THE ENGINE — hold E to restart',
          type: 'danger',
        });
      }
    }

    // ── Announce a caution once, when it first appears ────────────────────
    if (rep.caution !== this.weatherCaution) {
      const rising = rep.caution !== null
        && (this.weatherCaution === null || rep.caution.length > this.weatherCaution.length);
      this.weatherCaution = rep.caution;
      if (rep.caution && rising) {
        SoundEngine.warn();
        EventBus.emit('ui:show-notification', { message: `⚠ ${rep.caution}`, type: 'warning' });
        this.disengageWarp(rep.caution.toLowerCase());
      }
    }
    this.iceLoad = rep.iceLoad;
    this.avionicsOut = rep.blackout > 0;
  }

  // ── Other traffic ─────────────────────────────────────────────────────────

  /**
   * Sparse traffic sharing the airspace. Most encounters are set up to
   * conflict, so cruise is no longer "hold altitude and wait" — you get an
   * advisory with a direction to go, and if you sit there you meet them.
   */
  private updateTraffic(worldX: number, sdt: number): void {
    const speedPx = this.state.groundSpeed * WORLD_PX_PER_M;
    const traffic = this.world.traffic;
    traffic.update(sdt, {
      planeWorldX: worldX,
      planeAlt: this.state.altitude,
      planeSpeedPx: speedPx,
      airborne: this.hasBeenAirborne && !this.rollout,
      routeEndPx: this.routeKm * 1000 * WORLD_PX_PER_M,
    });

    // ── Advisory: relative height and which way to go, like the real box ──
    const ra = traffic.advisory(worldX, this.state.altitude, speedPx);
    this.trafficAdvisory = ra ? Math.round(ra.dAltM) : null;
    this.trafficAvoid = ra ? ra.avoid : null;
    if (ra && this.state.elapsedSeconds - this.trafficAlertAt > 5) {
      this.trafficAlertAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
      const where = ra.dAltM >= 0 ? 'ABOVE' : 'BELOW';
      EventBus.emit('ui:show-notification', {
        message: `✈ TRAFFIC — ${Math.abs(Math.round(ra.dAltM))} m ${where} — ${ra.avoid > 0 ? 'CLIMB' : 'DESCEND'}`,
        type: 'warning',
      });
      this.disengageWarp('traffic conflict');
    }

    // ── Midair ────────────────────────────────────────────────────────────
    const other = traffic.collision(worldX, this.state.altitude);
    if (!other || !this.hasBeenAirborne) return;
    traffic.doom(other);
    // Debris at THEIR airframe as well, not only off your wing. Without it the
    // other aeroplane simply starts descending and the collision looks like it
    // only happened to one of you.
    const theirY = this.world.altitudeToScreenY(other.alt);
    this.spawnImpactDebris(other.wx - this.scrollX, theirY, 40);
    this.midair();
  }

  /**
   * A burst of torn structure at a point on screen. Used for both halves of a
   * collision, so whatever you hit is visibly damaged by hitting you.
   */
  private spawnImpactDebris(sx: number, sy: number, count: number): void {
    const debris = this.add.particles(sx, sy, 'px_streak', {
      lifespan: { min: 450, max: 1500 },
      speed: { min: 80, max: 400 },
      angle: { min: 0, max: 360 },
      rotate: { min: 0, max: 360 },
      scale: { start: 0.9, end: 0.15 },
      alpha: { start: 1, end: 0 },
      tint: [0xd8c8a0, 0x8a6a4a, 0x3a3128, 0xff9a40],
      gravityY: 300,
      emitting: false,
    }).setDepth(7);
    debris.explode(count);
    this.time.delayedCall(1700, () => debris.destroy());
  }

  /**
   * The bolt itself: a jagged discharge from the cloud base down onto the
   * airframe, with a burnt-in afterimage and sparks off the skin. Drawn in
   * screen space at the aircraft, held for a few frames.
   */
  private drawLightningStrike(): void {
    const ax = AIRCRAFT_X + this.rig.offsetX;
    const ay = this.world.altitudeToScreenY(this.state.altitude) + this.rig.offsetY;
    const g = this.add.graphics().setDepth(9);

    const bolt = (width: number, colour: number, alpha: number, jitter: number): void => {
      g.lineStyle(width, colour, alpha);
      g.beginPath();
      let x = ax + (Math.random() - 0.5) * 40;
      let y = -20;
      g.moveTo(x, y);
      while (y < ay) {
        y += 16 + Math.random() * 22;
        x += (Math.random() - 0.5) * jitter;
        // Home in on the airframe as it gets close, so it clearly hits YOU
        const pull = Phaser.Math.Clamp((y - ay * 0.4) / Math.max(1, ay * 0.6), 0, 1);
        x = Phaser.Math.Linear(x, ax, pull * 0.55);
        g.lineTo(x, Math.min(y, ay));
      }
      g.strokePath();
    };

    bolt(7, 0x9fd0ff, 0.30, 52);   // outer glow
    bolt(3, 0xdcefff, 0.85, 44);   // core
    bolt(1.4, 0xffffff, 1, 38);    // hot centre

    // Discharge blooming off the airframe
    g.fillStyle(0xdcefff, 0.5);
    g.fillCircle(ax, ay, 16);
    g.fillStyle(0xffffff, 0.85);
    g.fillCircle(ax, ay, 7);

    const sparks = this.add.particles(ax, ay, 'px_streak', {
      lifespan: { min: 200, max: 700 },
      speed: { min: 60, max: 300 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.7, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [0xdcefff, 0x9fd0ff, 0xffffff],
      gravityY: 120,
      emitting: false,
    }).setDepth(9);
    sparks.explode(26);

    // Two quick re-strikes, the way a real discharge flickers
    this.time.delayedCall(60, () => { g.clear(); bolt(2.5, 0xdcefff, 0.7, 40); });
    this.time.delayedCall(130, () => g.clear());
    this.time.delayedCall(220, () => g.destroy());
    this.time.delayedCall(900, () => sparks.destroy());
  }

  /** Two aircraft, one piece of sky. Neither of you is landing on a runway. */
  private midair(): void {
    SoundEngine.impact();
    SoundEngine.crash();
    this.cameras.main.shake(900, 0.02);
    this.cameras.main.flash(220, 255, 220, 160);
    this.disengageWarp('midair collision');

    // Debris off the wing where they clipped you
    const wing = this.aircraft.wingPoint();
    const debris = this.add.particles(wing.x, wing.y, 'px_streak', {
      lifespan: { min: 500, max: 1400 },
      speed: { min: 90, max: 420 },
      angle: { min: 0, max: 360 },
      rotate: { min: 0, max: 360 },
      scale: { start: 0.9, end: 0.2 },
      alpha: { start: 1, end: 0 },
      tint: [0xd8c8a0, 0x8a6a4a, 0x3a3128, 0xff9a40],
      gravityY: 260,
      emitting: false,
    }).setDepth(7);
    debris.explode(34);
    this.time.delayedCall(1600, () => debris.destroy());

    // You do not walk away from this one intact: the airframe is wrecked and
    // the engine goes with it. What is left is a glide to somewhere flat.
    this.state.integrity = clamp(this.state.integrity - 62, 0, 100);
    this.state.speed *= 0.62;
    this.state.pitchRate -= 55;
    this.cargo.applyDamage(45);
    this.engineFailed = true;
    this.engineRunning = false;
    this.aircraft.stopEngine();
    this.aircraft.setFuelLeak(true);

    EventBus.emit('ui:show-notification', {
      message: '✖ MIDAIR COLLISION — engine out, airframe critical — put it down NOW',
      type: 'danger',
    });

    if (this.state.integrity <= 0) {
      this.finishFlight({
        verticalSpeed: Math.abs(this.state.verticalSpeed),
        horizontalSpeed: this.state.speed,
        gearDown: this.state.gearDown,
        quality: 'crash',
        integrityDamage: 100,
        cargoDamagePercent: 100,
      });
    }
  }

  // ── Approach indicator ─────────────────────────────────────────────────────

  private updateApproachIndicator(): void {
    // Only on an actual approach. Any descent below 90 m used to light up
    // "GOOD APPROACH" — including a routine level-off three kilometres out,
    // which is guidance about a runway that is nowhere near you.
    const remainingKm = this.routeKm - this.state.distanceTravelled;
    if (!this.hasBeenAirborne || this.state.altitude > 90 || remainingKm > 1.2) {
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

  /**
   * Carry out what a flight-event choice actually promised.
   *
   * Every one of these is visible from the cockpit within a second or two —
   * that is the whole point. A choice whose only effect is a number in the
   * save file is indistinguishable from closing the box.
   */
  private runEventAction(action: FlightAction, value: number): void {
    switch (action) {
      case 'divert': {
        // Break off and put it down. `reachedDestination` is false this far
        // out, so the report reads DIVERTED and the contract stays live.
        EventBus.emit('ui:show-notification', {
          message: 'Breaking off — putting her down short of the destination.',
          type: 'warning',
        });
        this.finishFlight({
          verticalSpeed: -1.4,
          horizontalSpeed: this.state.speed,
          gearDown: this.state.gearDown,
          quality: 'good',
          integrityDamage: 0,
          cargoDamagePercent: 0,
        });
        break;
      }
      case 'clear_weather':
        // You got above it / around it — so the weather genuinely stops.
        this.weather.forceCondition('clear');
        this.iceLoad = 0;
        EventBus.emit('ui:show-notification', {
          message: 'Clear air — you are above the worst of it.', type: 'success',
        });
        break;
      case 'extend_route': {
        // Going around is longer. The route strip and the distance readout
        // both move, so the cost is on screen for the rest of the flight.
        this.routeKm += value;
        EventBus.emit('flight:route-info', {
          routeKm: this.routeKm, destinationName: this.destinationName,
        });
        EventBus.emit('ui:show-notification', {
          message: `Routing around it — ${value.toFixed(1)} km added to the leg.`,
          type: 'warning',
        });
        break;
      }
      case 'full_power':
        this.state.throttle = Math.min(1, this.state.throttle + value);
        break;
      case 'descend':
        this.state.altitude = Math.max(12, this.state.altitude + value);
        this.state.flightPathAngle = Math.min(this.state.flightPathAngle, -0.05);
        break;
    }
  }

  private finishFlight(result: LandingResult): void {
    if (this.landed) return;
    this.landed = true;
    const data = {
      result,
      contractId: this.contractId,
      finalState: this.state,
      cargoSlots: this.cargo.slots,
      reachedDestination: this.state.distanceTravelled >= this.routeKm * 0.9,
      landedOnRunway: this.isOnRunway(this.scrollX + AIRCRAFT_X),
      closeCalls: this.closeCalls,
    };
    if (result.quality !== 'crash') {
      SoundEngine.chime();
      fadeToScene(this, 'PostFlightScene', data);
      return;
    }

    // A crash is the one moment of the flight worth watching. Play it out —
    // impact, break-up, the gouging slide, burning wreck — and only then show
    // the report. `crashing` keeps update() alive so the world still scrolls
    // to a stop underneath the wreckage instead of freezing mid-slide.
    this.crashing = true;

    // Whatever it comes down on gets wrecked too. Sixty tonnes of aeroplane
    // arriving at a lattice mast is not something the mast walks away from.
    const crashX = this.scrollX + AIRCRAFT_X;
    for (const h of this.world.hazards.near(crashX, 70)) {
      this.world.hazards.damageAt(h, 0.9);
    }
    SoundEngine.stopFlightLoop();
    // Silence the panel: nothing is overspeeding or being shot at any more,
    // and leaving "CLIMB 340 m" flashing over a burning wreck is absurd.
    this.groundThreat = null;
    this.trafficAdvisory = null;
    EventBus.emit('flight:status', {
      engineFailed: false, underFire: false, groundThreat: null, rangedOn: 0, stall: false,
      overspeed: false, obstacleAheadM: null, trafficDeltaM: null, trafficAvoid: null,
      weatherCaution: null, iceLoad: 0, avionicsOut: false,
    });
    this.state.speed = 0;
    this.state.verticalSpeed = 0;
    this.state.throttle = 0;
    EventBus.emit('flight:state-update', this.state);
    this.crash.play(
      {
        speed: this.state.speed,
        verticalSpeed: Math.abs(result.verticalSpeed),
        gearUp: !this.state.gearDown,
      },
      () => fadeToScene(this, 'PostFlightScene', data),
    );
  }

  /** Grades the landing from the impact values captured at touchdown. */
  private evaluateLanding(vSpeedAtImpact: number, hSpeedAtImpact: number): LandingResult {
    const vSpeed = Math.abs(vSpeedAtImpact);
    const hSpeed = hSpeedAtImpact;

    let quality: LandingQuality;
    let integrityDamage: number;
    let cargoDamage: number;

    /**
     * Touchdown speed is graded against THIS AIRCRAFT'S stall speed, not an
     * absolute number.
     *
     * The old bar was a flat 25 m/s for a perfect landing. Stall speeds across
     * the fleet run 60 → 130 km/h, so four of the six aircraft could not touch
     * down that slowly without already being in a stall: a perfect landing was
     * literally unreachable in anything bigger than the bush plane, and the
     * player had no way to know why. Grading against 1.35× stall asks the same
     * SKILL of every aeroplane — cross the fence slow and put it down gently —
     * which is the thing the player is actually learning.
     */
    const vRef = this.controller.vStall;

    if (!this.state.gearDown) {
      quality = 'crash'; integrityDamage = 45; cargoDamage = 60;
    } else if (vSpeed < 1.4 && hSpeed < vRef * 1.35) {
      quality = 'perfect'; integrityDamage = 0; cargoDamage = 0;
    } else if (vSpeed < 2.8 && hSpeed < vRef * 1.75) {
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
