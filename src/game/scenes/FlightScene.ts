import Phaser from 'phaser';
import { AircraftController, type FlightInput } from '../entities/aircraft/AircraftController';
import { AircraftSprite } from '../entities/aircraft/AircraftSprite';
import { specFor } from '../entities/aircraft/render/AircraftVisualSpec';
import { CrashSequence } from '../entities/aircraft/CrashSequence';
import { WeatherSystem } from '../entities/weather/WeatherSystem';
import { WeatherHazards } from '../entities/weather/WeatherHazards';
import { ParallaxWorld, WORLD_PX_PER_M } from '../world/ParallaxWorld';
import { biomeFor, climateAt } from '../world/Biomes';
import { WeatherFX } from '../world/WeatherFX';
import { FlightEventService } from '../../services/FlightEventService';
import { SaveService } from '../../services/SaveService';
import { CargoHold } from '../entities/CargoHold';
import { EventBus, type DropZoneStatus } from '../utils/EventBus';
import { fadeIn, fadeToScene } from '../utils/transitions';
import { SoundEngine } from '../audio/SoundEngine';
import type { FlightState, FlightEventDefinition, LandingQuality, LandingResult, WeatherCondition } from '../../types';
import { clamp, distance, pixelsToKm } from '../utils/math';
import type { ApproachKind } from '../../types';
import { isTouchDevice } from '../utils/device';
import { CameraRig } from './CameraRig';
import { routeKmBetween } from '../../services/RouteService';
import { Director } from '../ai/Director';
import { FlightCoach, type CoachView } from './FlightCoach';
import { DROP_REWARD, cratesFor, siteReply, type DropSite, dropMethodFor } from '../world/SupplyDrops';
import { STRUCTURE_NAME, DROP_RUN_BEFORE_PX, DROP_BAND_RUN_PX } from '../world/Towns';
import { routeSeed, originStripPx, destStripPx } from '../world/RoutePreview';
import { press } from '../utils/controls';
import { tryDumpCoolant } from '../entities/aircraft/Coolant';
import { destStripPx as destStripOf } from '../world/RoutePreview';

/** The approach angle the landing guide draws and the call reads against. */
const GLIDE_DEG = 4;
import { PilotModel } from '../ai/PilotModel';
import { TouchInput } from '../utils/touchInput';

// ─── Layout constants ────────────────────────────────────────────────────────
const GROUND_Y_OFFSET = 110;  // px from screen bottom to ground line
// TU-46 camera: the aircraft holds a fixed screen position and the WORLD does
// all the moving — speed reads through scroll, never by sliding the sprite.
const AIRCRAFT_X      = 300;

interface FlightSceneData {
  contractId: string;
  /** Flight school: the hand-laid circuit from home and back. See FlightCoach. */
  training?: boolean;
}

/** Gameplay length of the training circuit, km. */
const TRAINING_KM = 13;
/** Paid once, the first time the circuit is flown to the end. */
const TRAINING_REWARD = 1000;

const DEV_WEATHER_KEYS: Record<string, WeatherCondition> = {
  '1': 'clear', '2': 'cloudy', '3': 'strong_winds', '4': 'dust_storm',
  '5': 'fog', '6': 'thunderstorm', '7': 'blizzard',
};

/**
 * An alert that stops nagging.
 *
 * Every caution in the flight fired on a flat interval for as long as its
 * condition held — obstacle every 2.5 s, overspeed every 3, traffic every 5 —
 * so flying toward a mast for fifteen seconds meant six identical klaxons.
 * The first one is information; the sixth is just noise, and it trains the
 * player to stop hearing all of them.
 *
 * So each repeat waits longer than the last, and the moment the condition
 * clears the whole thing resets. You get told promptly, reminded once or
 * twice, and then left to fly the aeroplane.
 */
class Nag {
  private nextAt = -1e9;
  private step = 0;
  private readonly base: number;
  private readonly max: number;
  constructor(base: number, max = 4) { this.base = base; this.max = max; }

  /** True if it is time to speak up again. */
  due(now: number): boolean {
    if (now < this.nextAt) return false;
    this.nextAt = now + this.base * Math.pow(1.9, Math.min(this.step, this.max));
    this.step++;
    return true;
  }

  /** The condition went away — next time starts fresh. */
  clear(): void { this.step = 0; this.nextAt = -1e9; }
}

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
  /** Vertical speed of the air itself, m/s — shown on the variometer. */
  private airVertical = 0;
  private inThermal = false;
  private airTurb = 0;
  /** The cell standing in the way, for the annunciator. */
  private weatherAhead: { kind: string; km: number } | null = null;
  /** The cell we have already called on the radio, so it is warned once. */
  private warnedCell: unknown = null;
  /** Traffic passed inside 30 m without hitting it — paid out on delivery. */
  private closeCalls = 0;
  private notifiedApproach = false;
  private notifiedArrival  = false;

  // ── Threat / systems state ────────────────────────────────────────────────
  private stallWarning   = false;
  private underFire      = false;
  private hazardAlertAt  = -99;   // last obstacle klaxon
  private overspeedWarnAt = -99;
  private ceilingWarnAt  = -99;   // last service-ceiling caution
  // Cautions that back off rather than repeating forever. See Nag.
  private nagObstacle = new Nag(2.5);
  private nagFuel = new Nag(6);
  private nagHeat = new Nag(8);
  private nagThreat   = new Nag(8);
  private nagOverspeed = new Nag(3);
  private nagTraffic  = new Nag(5);
  /**
   * Seconds of loading left on the apron.
   *
   * The crew used to work in an endless loop until you started the engine,
   * which made it wallpaper — nothing was ever finished and nothing was
   * waited for. A short, finite load gives the departure a beat with a end to
   * it: they finish, they tell you, and then it is your aeroplane.
   */
  private loadingLeft = 3.2;
  /**
   * Teaches the game while you play it: the takeoff on a first flight, and
   * every mechanic the first time you meet it. See FlightCoach.
   */
  private coach: FlightCoach | null = null;
  /** Flight school, when this is the training circuit. */
  private training = false;
  private coachViewKey = '';
  private coachGuideFade = 0;
  /** What the coach needs to know about the next few seconds of route. */
  private coachObstacle: { label: string; heightM: number; pylon: boolean } | null = null;
  private coachThreat: { label: string; ceilingM: number } | null = null;
  /** Supply-drop tally for this flight, shown on the post-flight report. */
  private dropStats = { dropped: 0, hits: 0, earned: 0 };
  /** The drop window, faded in while a site is calling. */
  private dropGuideFade = 0;
  /** What the HUD card says about the next site. See updateDrops. */
  private dropZone: DropZoneStatus | null = null;
  /** Sites we have already told to start down, so it is said once. */
  private readonly descentCalled = new Set<DropSite>();
  /** Sites we have told you that you flew past, so it is said once per pass. */
  private readonly missedCalled = new Set<DropSite>();
  /** Slow-motion over the release, 1 = normal time. See updateDrops. */
  private dropSlow = 1;
  /** Last whole second of the run-in countdown that ticked. */
  private dropTickAt = 99;
  private dropWindowToned = false;
  /**
   * The site a crate is armed for: SPACE pressed on the run-in, and the crate
   * goes by itself the moment the aim point reaches them. A transport crosses
   * a roof in a fifth of a second; nobody times that by hand.
   */
  private dropArmed: DropSite | null = null;
  /** The airbrake switch. */
  private airbrakeOn = false;
  /** Throttle lever last frame — the go-around stow fires on the push, not the position. */
  private lastThrottle = 0;
  /** The site the last crate went to, and when — so a good release is not called late. */
  private dropAwayFor: DropSite | null = null;
  private dropAwayAt = -99;
  /** Departure settlement id — drop reputation is credited to its faction. */
  private originId = '';
  /**
   * Projected fuel in the tank when you arrive, 0-1. Smoothed.
   *
   * This is the number that gives the cruise something to do. Every decision
   * moves it — throttle, height, whether you are riding lift or grinding
   * through sink, how much you detoured around that cell — and it moves every
   * second, so there is always something to be getting on with between the
   * take-off and the approach.
   */
  private fuelAtArrival = 1;
  private arrivalWarnAt = -99;
  private trafficAlertAt = -99;   // last traffic advisory
  private threatAlertAt  = -99;   // last "hostile ground ahead" call
  /** What is shooting at us and the altitude that clears it. */
  private groundThreat: { label: string; clearM: number } | null = null;
  private threatHold = 0;         // keeps the caution readable between bursts
  /** Current weather caution text, or null. */
  private weatherCaution: string | null = null;
  /** The last flight event's chip and when it comes down (Infinity = stays). */
  private eventCaution: { text: string; until: number } | null = null;
  private iceLoad = 0;
  private avionicsOut = false;
  private trafficAdvisory: number | null = null; // their height minus ours, m
  private trafficAvoid: 1 | -1 | null = null;    // +1 climb, -1 descend
  private engineFailed   = false;
  private failureCheckAt = 0;
  /** Seconds the engine has spent at its redline — what actually breaks one. */
  private redlineSeconds = 0;
  private ceilingWarnAt2 = -99;
  private flapWarnAt = -99;
  private restartHoldFor = 0;     // seconds of cranking left
  /** Emergency coolant charges left — one a flight. See Coolant. */
  private coolantLeft = 1;

  // -- Pacing --------------------------------------------------------------
  /**
   * The Director shapes the crossing. It spawns nothing itself; it publishes
   * one budget that the weather, the traffic and the gunners each spend.
   */
  private director = new Director();
  /**
   * What the world has learned about this pilot across every previous flight.
   * Seeds the Director and the gunners, then records what today taught it.
   */
  private pilot = new PilotModel();
  /** Integrity at the last sample, so hull loss can be read as a RATE. */
  private lastIntegrity = 100;
  /** Smoothed hull loss, points per second. */
  private hullLostRate = 0;
  /** Decaying trace of rounds going past, 0-1. A burst is not a single frame. */
  private fireHeat = 0;
  /** Ground clearance under the aircraft, obstacles included, in metres. */
  private clearanceM = 999;
  /**
   * Where the aeroplane is along the route, world px — the one number every
   * system reads. The scroll is derived from it, never the other way round,
   * because the aeroplane can now turn round and the screen position it is
   * drawn at slides across to keep the view ahead of it.
   */
  private planeX = AIRCRAFT_X;
  /** +1 flying down the route, -1 flying back up it. */
  private heading: 1 | -1 = 1;
  /** Where the aircraft sits on screen; eases across during a turn. */
  private planeScreenX = AIRCRAFT_X;
  /** A 180 in progress: seconds into it, how long it takes, and from which way. */
  private turn: { t: number; dur: number; from: 1 | -1 } | null = null;
  private overshotCalled = false;
  /** Where the aircraft was last frame — a cable is crossed, not touched. */
  private prevHazardX = 0;
  private prevHazardAlt = 0;

  // ── Time warp ─────────────────────────────────────────────────────────────
  private timeScale = 1;
  private warpText!: Phaser.GameObjects.Text;
  private baseTimestamp = 480; // world clock at takeoff (minutes)


  constructor() { super({ key: 'FlightScene' }); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(data: FlightSceneData): void {
    this.contractId          = data.contractId;
    this.training            = !!data.training;
    this.coach               = null;
    this.coachViewKey        = '';
    this.coachGuideFade      = 0;
    this.coachObstacle       = null;
    this.coachThreat         = null;
    this.landed              = false;
    this.crashing            = false;
    this.hasBeenAirborne     = false;
    this.scrollX             = 0;
    this.planeX              = AIRCRAFT_X;
    this.heading             = 1;
    this.planeScreenX        = AIRCRAFT_X;
    this.turn                = null;
    this.overshotCalled      = false;
    this.smoothDt            = 1 / 60;
    this.shakeDuration       = 0;
    this.gearToggleCooldown  = 0;
    this.flapsToggleCooldown = 0;
    this.engineRunning       = true;
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
    this.eventCaution        = null;
    this.iceLoad             = 0;
    this.avionicsOut         = false;
    this.trafficAdvisory     = null;
    this.trafficAvoid        = null;
    this.engineFailed        = false;
    this.failureCheckAt      = 0;
    this.redlineSeconds      = 0;
    this.ceilingWarnAt2      = -99;
    this.flapWarnAt          = -99;
    this.restartHoldFor      = 0;
    this.coolantLeft         = 1;
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
    this.keyHintText?.setPosition(width / 2, this.cameras.main.height - 4);
    // Flying back up the route the aircraft sits on the right; keep it there
    if (!this.turn) this.planeScreenX = this.anchorFor(this.heading);
  }

  /** Where the aircraft sits on screen for a heading: a third in from the back. */
  private anchorFor(h: 1 | -1): number {
    return h === 1 ? AIRCRAFT_X : this.cameras.main.width - AIRCRAFT_X;
  }

  /**
   * Turn round.
   *
   * A 180 at a sensible bank: a few seconds, some speed spent on the way
   * round, and the aircraft keeps moving through it — forward progress runs
   * down to nothing and then builds the other way. The picture (see
   * AircraftSprite.applyTurn) and the camera (the aircraft slides across the
   * screen so there is room to see where you are now going) follow the same
   * clock.
   */
  private startTurn(): void {
    if (this.turn || this.landed || this.crashing) return;
    if (!this.hasBeenAirborne || this.state.altitude < 12) {
      EventBus.emit('ui:show-notification', { message: 'Get some height first — you need room to turn.', type: 'warning' });
      return;
    }
    if (this.state.speed < this.controller.vStall * 1.15) {
      EventBus.emit('ui:show-notification', { message: 'Too slow to turn — build some speed first.', type: 'warning' });
      return;
    }
    this.disengageWarp('turning');
    // A heavy takes longer to come round than a crop duster
    const dur = 3.2 + Math.min(1.6, (this.controller.vStall - 19) * 0.08);
    this.turn = { t: 0, dur, from: this.heading };
    SoundEngine.flapMove();
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

    /*
     * ── You start cold, with the flaps already set ────────────────────────
     *
     * The flight used to open with the engine running, so the most
     * characteristic sound an aeroplane makes was one the player only ever
     * heard by deliberately shutting down mid-air. Starting cold gives the
     * departure a beginning: starter, catch, run up, roll.
     *
     * The flaps, on the other hand, are set FOR you. A pilot walks out to an
     * aeroplane already configured for the departure, and making the player
     * remember a checkbox before every takeoff is admin, not gameplay — the
     * decision that matters is when to bring them UP.
     */
    this.engineRunning = false;
    this.state.flapStage = this.controller.takeoffFlap;
    this.state.flapAngle = this.controller.flapStops[this.controller.takeoffFlap];
    this.state.flapsDeployed = true;
    this.state.gearDown = true;

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
        this.routeKm = routeKmBetween(origin, dest);
        destinationName = dest.name;
        this.originRunwayM = origin.field?.runwayM ?? 600;
        this.destRunwayM = dest.field?.runwayM ?? 600;
        this.originSurface = origin.field?.approach ?? 'open';
        this.destSurface = dest.field?.approach ?? 'open';
      }
    }
    let homeId: string | undefined;
    if (this.training) {
      homeId = save.player.currentLocationId;
      const home = window.gameData.settlements.find(s => s.id === homeId);
      this.routeKm = TRAINING_KM;
      destinationName = home ? `${home.name} (home)` : 'home';
      this.originRunwayM = this.destRunwayM = home?.field?.runwayM ?? 600;
      this.originSurface = this.destSurface = home?.field?.approach ?? 'open';
      // A full tank for the lesson — and nothing here is written back
      this.state.fuel = definition.stats.fuelCapacity;
      this.state.integrity = 100;
    }
    this.destinationName = destinationName;
    this.originBiome = biomeFor(contract?.originId ?? homeId);
    this.originId = contract?.originId ?? homeId ?? '';
    this.destBiome = biomeFor(contract?.destinationId ?? homeId);
    EventBus.emit('flight:route-info', { routeKm: this.routeKm, destinationName });

    // ── Cargo hold: what's riding in the back ─────────────────────────────
    this.cargo = new CargoHold(contract ?? null, window.gameData.goods);
    this.lastCargoEmit = 0;
    FlightEventService.onCargoDamage = amount => this.cargo.applyDamage(amount);

    // ── Build scene (back → front) ────────────────────────────────────────
    this.world    = new ParallaxWorld(this, width, height, groundY);
    // Obstacles and raider ground are deterministic per contract, so a route
    // you have flown before hands you the same threats.
    /*
     * Biomes first: setRoute lays out the raiders, and a stretch over the
     * tidal channels has to come out as gun barges rather than sandbag nests.
     * The layout can only know that if it already knows what country it is in.
     */
    this.world.setBiomes(this.originBiome, this.destBiome);
    if (this.training) {
      this.world.setTrainingRoute(this.routeKm, 'Millbrook');
    } else {
      // The country gets more dangerous as the career goes on: mostly rifles
      // and heavy MGs at first, the full arsenal by the sixth contract. It
      // started at 0.15, which left the first contracts all but unguarded.
      const done = SaveService.get().player.completedContractIds?.length ?? 0;
      const threat = clamp(0.4 + done * 0.1, 0.4, 1);
      this.world.setRoute(this.routeKm, this.hashRoute(this.contractId), this.originRunwayM, this.destRunwayM, threat);
    }
    // The batteries reach most of the way to THIS aeroplane's ceiling
    this.world.raiders.setAircraftCeiling(definition.stats.maxAltitude);
    // Survivors along the route — something to do in the cruise. See SupplyDrops.
    // They live in the towns the route was just laid out with, so they go second.
    {
      const hz = this.world.hazards;
      // Transports drop pallets from a few hundred feet; light aircraft push
      // bundles out of the door low down. It decides every window and target.
      this.world.drops.method = dropMethodFor(SaveService.getActiveAircraft().def);
      this.world.drops.layout(
        this.routeKm * 1000 * WORLD_PX_PER_M, this.hashRoute(this.contractId),
        cratesFor(SaveService.getActiveAircraft().def.stats.cargoCapacity),
        {
          towns: hz.towns,
          zones: hz.zones,
          tallestBetween: (a, b) => hz.tallestBetween(a, b),
          surfaceAt: x => hz.surfaceAt(x),
          camps: hz.campAnchors,
        },
        // The lesson is one crowd in one square — rooftops come later
        this.training ? { squaresOnly: true, camps: false } : {},
      );
    }
    this.dropStats = { dropped: 0, hits: 0, earned: 0 };
    this.dropGuideFade = 0;
    this.dropZone = null;
    this.descentCalled.clear();
    this.missedCalled.clear();
    this.dropSlow = 1;
    this.dropTickAt = 99;
    this.dropWindowToned = false;
    this.dropArmed = null;
    this.airbrakeOn = false;
    this.lastThrottle = 0;
    this.dropAwayFor = null;
    this.dropAwayAt = -99;
    // Weather becomes a set of places on this route rather than a global mood,
    // and each place gets the weather of the country it is in.
    {
      const endPx = this.routeKm * 1000 * WORLD_PX_PER_M;
      const from = this.originBiome, to = this.destBiome;
      this.world.weatherField.setClimate(x => climateAt(from, to, x / endPx));
    }
    this.world.weatherField.reset(
      this.hashRoute(this.contractId), this.routeKm * 1000 * WORLD_PX_PER_M,
    );
    this.weather.attachField(this.world.weatherField);
    // The lesson flies in still air: one new thing at a time
    this.world.weatherField.setCalm(this.training);

    // -- Pacing, and what the world already knows about you ----------------
    this.pilot = new PilotModel(SaveService.get().player.pilot ?? null);
    this.pilot.beginFlight();
    // A veteran does not spend the first ten minutes of every crossing
    // re-proving themselves, and a creature of habit is expected before they
    // arrive. Both priors are beatable inside this flight - see PilotModel.
    this.director.reset(this.pilot.directorSeed());
    this.world.raiders.setPrior(this.pilot.raiderPrior());
    this.lastIntegrity = this.state.integrity;
    /*
     * A respite you cannot perceive is only a lull. Control says so on the
     * radio, which both makes the arc legible and gives the quiet stretch a
     * beginning rather than it merely being an absence of events.
     */
    this.director.onRespite = () => {
      if (!this.hasBeenAirborne || this.landed) return;
      const call = 'Ashline flight, nothing on the board ahead of you. Enjoy the quiet.';
      EventBus.emit('ui:show-notification', { message: `📻 ${call}`, type: 'info' });
      SoundEngine.radio(call, { kind: 'control', station: 'ASHLINE CONTROL' });
    };

    // ── The frequency is not empty ────────────────────────────────────────
    // Other pilots call their intentions before they fly them, so a conflict
    // has a voice attached to it rather than being a silent number on the HUD.
    this.world.traffic.onRadio = msg => {
      EventBus.emit('ui:show-notification', { message: `📻 ${msg}`, type: 'info' });
      // The caption carries the words; the radio carries who is calling.
      // Traffic keeps one tone signature for the whole flight, so a second
      // call from the circuit is recognisable before you have read it.
      SoundEngine.radio(msg, { kind: 'traffic' });
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
    // The garrison at both fields flies the destination faction's colours
    const destSettlement = window.gameData.settlements.find(s => s.id === contract?.destinationId);
    const faction = window.gameData.factions.find(f => f.id === destSettlement?.factionId);
    if (faction) this.world.setFactionColor(parseInt(faction.color.replace('#', ''), 16));
    this.aircraft = new AircraftSprite(this, AIRCRAFT_X, groundY, definition);
    // Cold and quiet on the apron — the prop is stopped until the player
    // turns it over. See the note where engineRunning is set false.
    this.world.loading = true;
    this.loadingLeft = 3.2;
    /*
     * The coach runs on every flight. On flight school and on a save's first
     * flight it starts with the takeoff; after that it only speaks up the
     * first time you meet something it has not taught you yet — so a player
     * who never chose flight school still gets taught the whole game.
     */
    const stats = SaveService.get().player.stats;
    this.coach = new FlightCoach({
      basics: this.training || (stats.totalFlights === 0 && !stats.trainingDone),
      forceAll: this.training,
      seen: stats.lessons ?? [],
      onSeen: id => {
        const save = SaveService.get();
        const list = save.player.stats.lessons ?? [];
        if (!list.includes(id)) {
          save.player.stats.lessons = [...list, id];
          SaveService.save(save.player, save.world);
        }
      },
    });
    // The HUD comes up on this event; a real flight gets it from the board
    if (this.training) EventBus.emit('scene:start-flight', { contractId: '' });
    this.aircraft.stopEngine();
    EventBus.emit('ui:show-notification', {
      message: '📦 Loading cargo — flaps and gear are set for departure',
      type: 'info',
    });
    this.rig = new CameraRig(this.cameras.main, this.controller.vStall, this.controller.vMax);

    // The engine you hear is the engine you can see. Style, count and blade
    // count all come from the airframe's own visual spec, so a single radial
    // crop duster and a four-engine turboprop heavy cannot sound the same.
    {
      const vs = specFor(definition.id);
      // ALL of them, not just the near-side ones: `far` is a DRAWING flag for
      // which engines render behind the fuselage, and filtering on it made
      // every twin in the fleet sound like a single.
      const engines = Math.max(1, vs.engines.length);
      SoundEngine.setEngineProfile({
        kind: vs.engineStyle,
        blades: vs.prop.bladePairs * 2,
        count: engines,
        // A bigger aeroplane swings a bigger, slower propeller, so it sits
        // lower. Keyed to stall speed as a proxy for size, and centred so the
        // fleet actually spreads across the range instead of piling up at the
        // clamp: 60 km/h → 1.45, 130 km/h → 0.70.
        pitch: Phaser.Math.Clamp(90 / Math.max(45, definition.stats.stallSpeed), 0.70, 1.45),
      });
    }
    this.crash    = new CrashSequence(this, this.aircraft, groundY);
    this.fx       = new WeatherFX(this, width, height);

    // ── In-canvas approach indicator ──────────────────────────────────────
    this.approachText = this.add.text(width / 2, height / 2 - 30, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#00000099', padding: { x: 14, y: 6 },
    }).setOrigin(0.5).setDepth(10).setAlpha(0);

    // Keyboard legend, bottom CENTRE. It moved to the top-right when the HUD
    // had an instrument panel along the bottom; now the panel is gone and the
    // top belongs to the radio strip, so the bottom edge is free again — and
    // the legend is reference text that should sit as far out of the way as
    // it can get.
    // G only appears for an aeroplane that actually has a retractable one.
    const keyLegend = this.aircraft.hasRetractableGear
      ? 'W/S: Throttle   A/D: Pitch   F/V: Flaps   B: Airbrake   G: Gear   E: Engine   C: Coolant   SPACE: Drop   R: Turn   T: Time   M: Mute   ESC: Abort'
      : 'W/S: Throttle   A/D: Pitch   F/V: Flaps   B: Airbrake   E: Engine   C: Coolant   SPACE: Drop   R: Turn   T: Time   M: Mute   ESC: Abort';
    this.keyHintText = this.add.text(width / 2, height - 4, keyLegend,
      { fontSize: '11px', color: '#5a6a5a', fontFamily: 'monospace',
        backgroundColor: '#00000055', padding: { x: 6, y: 4 } }
    ).setOrigin(0.5, 1).setDepth(10).setVisible(!isTouchDevice());

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
      B:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.B),
      C:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.C),
      F:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      V:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.V),
      T:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.T),
      R:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.R),
      M:   this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.M),
      ESC: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
      SPACE: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };

    // DEV: number keys force weather conditions, 0 pulls the next traffic
    // encounter forward so conflicts can be exercised without waiting them
    // out; 8 and 9 force a fuel leak and a bird strike.
    if (import.meta.env.DEV) {
      this.input.keyboard!.on('keydown', (ev: KeyboardEvent) => {
        const condition = DEV_WEATHER_KEYS[ev.key];
        if (condition) this.weather.forceCondition(condition);
        if (ev.key === '0') this.world.traffic.provoke();
        // 8 / 9 force the two flight events, which are otherwise rare rolls
        if (ev.key === '8') FlightEventService.force('fuel_leak');
        if (ev.key === '9') FlightEventService.force('bird_strike');
      });
    }

    // ── Event wiring ──────────────────────────────────────────────────────
    // Nothing in here pauses the flight: events play out and apply themselves.
    this.eventUnsubs = [
      EventBus.on('weather:changed', ({ state: weather }) => {
        this.world.setWeather(weather.condition);
        this.fx.setCondition(weather.condition);
        this.disengageWarp('weather changing');
        FlightEventService.checkWeatherEvents(this.state);
      }),
      // An event plays its cinematic, then simply happens — no question, no
      // pause. Its chip says what it cost.
      EventBus.on('flight:event-triggered', ({ event }) => {
        this.disengageWarp(event.title.toLowerCase());
        this.playEventCinematic(event, () => {
          // The flight can end while the birds are still in the air
          if (this.landed || this.crashing) return;
          this.state = FlightEventService.applyOutcome(event, this.state);
          const { caution, cautionSeconds } = event.outcome;
          this.eventCaution = {
            text: caution,
            until: cautionSeconds > 0 ? this.state.elapsedSeconds + cautionSeconds : Infinity,
          };
        });
      }),
      // Flight school's two exits: go again, or on to the map
      EventBus.on('flight:training-exit', ({ again }) => {
        if (!this.training) return;
        if (again) {
          fadeToScene(this, 'FlightScene', { contractId: '', training: true });
        } else {
          EventBus.emit('scene:return-to-map');
          fadeToScene(this, 'MapScene');
        }
      }),
      EventBus.on('flight:hide-tips', () => {
        this.coach?.hideAll();
        const save = SaveService.get();
        save.player.stats.trainingDone = true;
        SaveService.save(save.player, save.world);
        this.emitCoachView(null);
      }),
      EventBus.on('flight:skip-training', () => {
        if (!this.training) return;
        const save = SaveService.get();
        save.player.stats.trainingDone = true;
        SaveService.save(save.player, save.world);
        EventBus.emit('scene:return-to-map');
        fadeToScene(this, 'MapScene');
      }),
    ];
    this.events.once('shutdown', () => {
      this.rig?.reset();
      this.eventUnsubs.forEach(u => u());
      this.eventUnsubs = [];
      SoundEngine.stopFlightLoop();
    SoundEngine.stopWeatherBed();
    SoundEngine.stopTraffic();
      SoundEngine.stopWeatherBed();
      SoundEngine.stopTraffic();
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
    // ── Loading, on the apron ──────────────────────────────────────────────
    if (this.loadingLeft > 0) {
      this.loadingLeft -= delta / 1000;
      if (this.loadingLeft <= 0) {
        this.loadingLeft = 0;
        this.world.loading = false;
        EventBus.emit('ui:show-notification', {
          message: `📦 Cargo aboard — ${press('engine')} to start the engine`,
          type: 'success',
        });
      }
    }

    if (this.crashing) { this.updateCrashSlide(delta / 1000); return; }
    if (this.landed) return;

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
      airbrake:     this.airbrakeOn,
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
      if (this.loadingLeft > 0) {
        EventBus.emit('ui:show-notification', {
          message: `Still loading — ${this.loadingLeft.toFixed(1)}s`,
          type: 'warning',
        });
      } else if (this.engineFailed) {
        // A failed engine needs cranking — it does not just snap back on
        if (this.restartHoldFor <= 0) {
          this.restartHoldFor = 2.8;
          SoundEngine.engineCrank(2.8);
          EventBus.emit('ui:show-notification', { message: 'Cranking…', type: 'warning' });
        }
      } else if (!this.engineRunning) {
        /*
         * Starting is an EVENT, not a switch.
         *
         * The starter drags the prop round for a couple of seconds, a cylinder
         * or two fires and misses, and then it catches. Instant ignition made
         * the most characterful moment in the aeroplane into a light switch —
         * and it removed the one bit of pre-flight ritual the game had.
         */
        if (this.restartHoldFor <= 0) {
          this.restartHoldFor = 2.6;
          SoundEngine.engineCrank(2.6);
          EventBus.emit('ui:show-notification', { message: 'Starter engaged…', type: 'info' });
        }
      } else {
        this.engineRunning = false;
        {
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
    /*
     * Airbrakes. A fast aeroplane cannot be slowed by taking the power off
     * alone — that just makes it a glider — and every approach in a transport
     * was a fight to get below flap speed. B puts the panels up and leaves
     * them up; pushing the power to full stows them, as on a go-around.
     *
     * The stow is the PUSH through 85%, not the lever sitting above it. As a
     * position test it undid B in the same frame whenever the power was
     * already high — which is most of the flight — so the key did nothing.
     */
    if (Phaser.Input.Keyboard.JustDown(this.keys.B) || TouchInput.consume('airbrake')) {
      this.airbrakeOn = !this.airbrakeOn;
      SoundEngine.flapMove();
    }
    if (this.airbrakeOn && this.lastThrottle <= 0.85 && this.state.throttle > 0.85) {
      this.airbrakeOn = false;
      SoundEngine.flapMove();
      EventBus.emit('ui:show-notification', { message: 'Airbrakes stowed — full power.', type: 'info' });
    }
    this.lastThrottle = this.state.throttle;
    if (Phaser.Input.Keyboard.JustDown(this.keys.C) || TouchInput.consume('coolant')) this.dumpCoolant();
    if ((Phaser.Input.Keyboard.JustDown(this.keys.M) || TouchInput.consume('mute'))) {
      const muted = SoundEngine.toggleMute();
      EventBus.emit('ui:show-notification', { message: muted ? 'Sound muted.' : 'Sound on.', type: 'info' });
    }
    /*
     * The flap lever has notches: F takes it down one, V brings it up one.
     * The panels follow on their motor over a few seconds (the controller
     * drives `flapAngle`), and the HUD shows both the lever and where the
     * flaps actually are, so the setting is never a guess.
     */
    {
      const down = Phaser.Input.Keyboard.JustDown(this.keys.F) || TouchInput.consume('flaps');
      const up = Phaser.Input.Keyboard.JustDown(this.keys.V) || TouchInput.consume('flapsUp');
      if ((down || up) && this.flapsToggleCooldown === 0) {
        const was = this.state.flapStage;
        const next = clamp(was + (down ? 1 : 0) - (up ? 1 : 0), 0, 3);
        if (next !== was) {
          this.state.flapStage = next;
          this.flapsToggleCooldown = 220;
          SoundEngine.flapMove();
          EventBus.emit('flight:flaps-toggled', { deployed: next > 0, stage: next });
          // Asking for more flap than the speed allows is worth one word
          const limit = this.controller.flapLimitAt(next);
          if (down && this.state.altitude > 1 && this.state.speed * Math.sqrt(this.controller.sigma) > limit * 1.04) {
            EventBus.emit('ui:show-notification', {
              message: `Flap ${next === 3 ? 'FULL' : next} selected — it will come out as you slow below ${Math.round(limit * 3.6)} km/h`,
              type: 'info',
            });
          }
        }
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.R) || TouchInput.consume('turn')) this.startTurn();
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
    // Warp speeds the quiet stretches; the drop run slows the one moment
    // that is a matter of timing.
    const sdt = dt * this.timeScale * this.dropSlow;

    // ── Weather → wind ─────────────────────────────────────────────────────
    this.weather.update(
      delta * this.timeScale, this.planeX, this.director.pressure,
    );
    /*
     * Wind aloft.
     *
     * The second half of "there is no free altitude": the higher you go the
     * harder the air pushes back. Height buys you safety from the ground and
     * costs you ground speed, so the fast way across and the safe way across
     * are different altitudes and you have to keep choosing between them.
     *
     * Applied as a headwind component that grows with height — a tailwind at
     * altitude would just make climbing correct again.
     */
    const altFrac = Phaser.Math.Clamp(
      this.state.altitude / Math.max(1, SaveService.getActiveAircraft().def.stats.maxAltitude), 0, 1,
    );
    const windX = this.weather.windX() * 0.4 - altFrac * altFrac * 14;

    // ── The air the aeroplane is flying through ───────────────────────────
    // Sampled at the aircraft's own world position, then handed to the
    // controller as a vertical wind so the aerodynamics stay untouched: the
    // wing does not know it is in a thermal, it just goes up with the air.
    const airX = this.planeX;
    // Convection dies under cloud, and with the sun. An overcast route has
    // dead air and has to be flown on the engine.
    // Cloud over your head shuts the heating off — straight from the cell.
    const wx = this.world.weatherField.sample(airX, this.heading);
    const cover = wx.convection;
    const minutes = this.baseTimestamp + this.state.elapsedSeconds;
    const dayFrac = ((minutes / 60) % 24) / 24;
    const solar = Math.max(0, Math.sin((dayFrac - 0.25) * Math.PI * 2));
    this.world.air.setConditions(solar, cover);
    const air = this.world.air.sample(airX, this.state.altitude);
    // A cell's own updraught/outflow rides on top of the convective field.
    air.vertical += wx.draught;

    // What is standing between here and the destination, and how far off it is
    this.weatherAhead = wx.ahead && wx.distanceToEdge < 26000 && wx.ahead.kind !== 'clear'
      ? { kind: wx.ahead.kind, km: wx.distanceToEdge / (WORLD_PX_PER_M * 1000) }
      : null;

    // Somebody calls the weather ahead over the air, once per cell, while
    // there is still time to route around it. Silence about a storm you can
    // already see would be the strangest thing in the sky.
    if (wx.ahead && wx.ahead !== this.warnedCell
      && wx.distanceToEdge < 14000 && wx.distanceToEdge > 0
      && (wx.ahead.kind === 'thunderstorm' || wx.ahead.kind === 'dust_storm'
        || wx.ahead.kind === 'blizzard')) {
      this.warnedCell = wx.ahead;
      const km = (wx.distanceToEdge / (WORLD_PX_PER_M * 1000)).toFixed(1);
      const what = wx.ahead.kind === 'thunderstorm' ? 'a cell'
        : wx.ahead.kind === 'dust_storm' ? 'a dust wall' : 'a snow band';
      const call = `Ashline flight, ${what} on your nose, ${km} kilometres. Advise you go round it.`;
      EventBus.emit('ui:show-notification', { message: `📻 ${call}`, type: 'warning' });
      SoundEngine.radio(call, { kind: 'warning', station: 'ASHLINE CONTROL' });
    }
    this.airVertical = air.vertical;
    this.inThermal = air.inThermal;
    this.airTurb = air.turbulence;

    // ── Continuous audio: the weather you are inside, and the air itself ──
    SoundEngine.setWeather(this.weather.current.condition, Math.max(wx.intensity, 0.0), sdt);
    // Audio vario: hunt a thermal by ear while looking where you are going.
    SoundEngine.setVario(air.vertical, sdt);

    // ── Physics (fixed-step, frame-rate independent) ───────────────────────
    this.state = this.controller.update(this.state, input, sdt, windX, air.vertical);

    // ── Weather with teeth ────────────────────────────────────────────────
    // Icing, lightning and sand ingestion, each with its own answer. Applied
    // before turbulence so the degraded lift is what the gusts act on.
    this.applyWeatherHazards(sdt);

    // ── Turbulence: gusts nudge the aircraft, dt-scaled so a storm is rough
    //    but flyable (previously this was per-frame and slammed you down) ────
    const turbulence = Math.min(1, this.weather.current.turbulenceIntensity + this.airTurb);

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
      const remaining = Math.abs(this.routeKm - this.state.distanceTravelled);
      if (this.state.engineTemp >= 0.85)      this.disengageWarp('engine overheating');
      else if (this.state.fuel < 15)          this.disengageWarp('fuel critical');
      else if (remaining <= 1.8)              this.disengageWarp('destination ahead');
      else if (this.state.altitude < 30)      this.disengageWarp('low altitude');
      else if (this.state.integrity < 30)     this.disengageWarp('airframe critical');
    }

    // Fuel and heat warnings back off like every other caution — at a fixed
    // five seconds, the last ninety seconds of a thin tank were eighteen beeps.
    if (this.state.fuel >= 15) this.nagFuel.clear();
    if (this.state.fuel < 15 && this.nagFuel.due(this.state.elapsedSeconds)) {
      SoundEngine.warn();
      EventBus.emit('ui:show-notification', {
        message: `⚠ FUEL CRITICAL: ${this.state.fuel.toFixed(0)} L remaining`,
        type: 'danger',
      });
    }

    // Engine overheat warning
    if (this.state.engineTemp <= 0.84) this.nagHeat.clear();
    if (this.state.engineTemp > 0.9 && this.nagHeat.due(this.state.elapsedSeconds)) {
      SoundEngine.warn();
      EventBus.emit('ui:show-notification', {
        message: this.coolantLeft > 0
          ? `ENGINE HOT — ease the power, or ${press('coolant')} to dump coolant (once)`
          : 'ENGINE HOT — ease the power, or lower the nose so the air cools it',
        type: 'warning',
      });
    }
    // Flaps out above their limit speed: the panels are being torn off
    if (this.controller.flapOverspeed && this.state.elapsedSeconds - this.flapWarnAt > 6) {
      this.flapWarnAt = this.state.elapsedSeconds;
      SoundEngine.warn();
      EventBus.emit('ui:show-notification', {
        message: `⚠ FLAP SPEED — slow below ${Math.round(this.controller.flapLimit * 3.6)} km/h or ${press('flapsUp')} to raise them`,
        type: 'danger',
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
      this.world.addSkidMark(this.planeX);
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
    // A distance, whichever side of the field you are on — flying away from
    // it after an overshoot is not "runway below".
    const remainingKm = Math.abs(this.routeKm - this.state.distanceTravelled);
    const towardField = this.heading * (this.routeKm - this.state.distanceTravelled) >= -0.05;
    if (!this.notifiedApproach && remainingKm <= 1.5 && this.hasBeenAirborne) {
      this.notifiedApproach = true;
      EventBus.emit('ui:show-notification', {
        message: `${this.destinationName} ahead — begin your approach`, type: 'info',
      });
    }
    if (!this.notifiedArrival && remainingKm <= 0.15 && towardField && this.hasBeenAirborne) {
      this.notifiedArrival = true;
      EventBus.emit('ui:show-notification', {
        message: `Runway below — land now to deliver`, type: 'success',
      });
    }
    /*
     * Overshot. The strip is a few hundred metres long now, and missing it
     * used to leave you flying on into nowhere with no way back. Say so, and
     * say how to fix it: turn round and come back at it.
     */
    if (this.hasBeenAirborne && !this.landed && this.state.altitude > 3) {
      const [, stripEnd] = destStripOf(this.routeKm, this.destRunwayM);
      const past = this.heading === 1 && this.planeX > stripEnd + 120 * WORLD_PX_PER_M;
      if (past && !this.overshotCalled) {
        this.overshotCalled = true;
        SoundEngine.radio(`Ashline flight, you have overflown ${this.destinationName}. Come round and try again.`,
          { kind: 'control', station: 'ASHLINE CONTROL' });
        EventBus.emit('ui:show-notification', {
          message: `↺ Overshot ${this.destinationName} — ${press('turn')} to turn back`, type: 'warning',
        });
      }
      if (!past && this.heading === -1) this.overshotCalled = false;
    }

    // Flight events — only once airborne, at most one check every 3 seconds
    if (!this.training && this.hasBeenAirborne && this.state.elapsedSeconds - this.lastEventCheckAt >= 9) {
      this.lastEventCheckAt = this.state.elapsedSeconds;
      FlightEventService.checkEvents(this.state);
    }

    // ── Hazards: obstacles are solid, raider ground is hostile ────────────
    const worldX = this.planeX;
    this.updateHazards(worldX, sdt);

    // Another aeroplane you can HEAR closing is the oldest traffic alert there
    // is — and the pitch dropping as it goes past is the whole effect.
    {
      const near = this.world.traffic.nearest(worldX, this.state.altitude);
      SoundEngine.setTraffic(near.proximity, near.closure);
    }

    // ── Other traffic: advisories, then the midair if you ignored them ────
    // Nobody else is flying the training circuit.
    if (!this.training) this.updateTraffic(worldX, sdt);
    if (this.landed) return;

    // ── Moving along the route, either way ────────────────────────────────
    let along: number = this.heading;
    if (this.turn) {
      const tr = this.turn;
      tr.t += sdt;
      const p = clamp(tr.t / tr.dur, 0, 1);
      const eased = 0.5 - Math.cos(Math.PI * p) / 2;
      const psi = Math.PI * eased;
      // Progress along the route runs down through zero and builds the other way
      along = tr.from * Math.cos(psi);
      // A banked turn costs energy: bleed some speed, more in the middle
      this.state.speed = Math.max(this.controller.vStall * 1.05,
        this.state.speed - 2.6 * Math.sin(psi) * sdt);
      // The camera slides the aircraft across so the view opens up ahead
      const k = clamp((eased - 0.1) / 0.9, 0, 1);
      const kk = k * k * (3 - 2 * k);
      this.planeScreenX = this.anchorFor(tr.from) + (this.anchorFor((-tr.from) as 1 | -1) - this.anchorFor(tr.from)) * kk;
      this.aircraft.setTurn(eased, tr.from);
      if (p >= 1) {
        this.heading = (-tr.from) as 1 | -1;
        this.turn = null;
        this.aircraft.setTurn(null, tr.from);
        this.planeScreenX = this.anchorFor(this.heading);
      }
    }
    this.planeX += along * this.state.groundSpeed * sdt * WORLD_PX_PER_M;
    this.scrollX = this.planeX - this.planeScreenX;
    // Progress is where you ARE, not how far you have flown — the two part
    // company the moment you turn round
    this.state.distanceTravelled = (this.planeX - AIRCRAFT_X) / (WORLD_PX_PER_M * 1000);

    // ── World & weather visuals ────────────────────────────────────────────
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
      planeScreenX: this.planeScreenX,
      heading: this.heading,
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
    this.aircraft.setLighting(this.world.modelLight(this.weather.current.visibility));
    // The rig offsets the airframe INSIDE its zone in response to g-load,
    // pitch rate and flight path, so a manoeuvre is something you can see
    // rather than a number that changed. It never slides with airspeed.
    this.rig.update(sdt, this.state, turbulence, this.state.altitude <= 0.5);
    this.aircraft.container.setX(this.planeScreenX + this.heading * this.rig.offsetX);
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
      dt: sdt,
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
    this.planeX += this.heading * this.crash.slideSpeed() * sdt * WORLD_PX_PER_M;
    this.scrollX = this.planeX - this.planeScreenX;
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
      planeScreenX: this.planeScreenX,
      planeScreenY: this.world.altitudeToScreenY(0),
      planeWorldX: this.planeX,
      speedFrac: 0,
      progress: clamp(this.state.distanceTravelled / Math.max(0.1, this.routeKm), 0, 1),
    });
    this.fx.update(sdt);
  }

  /** True when the given world position is on either airfield's asphalt. */
  private isOnRunway(worldX: number): boolean {
    // Same strips the world draws — the strip you can see IS the strip you
    // have to stop on.
    const [oa, ob] = originStripPx(this.originRunwayM);
    const [da, db] = destStripPx(this.routeKm, this.destRunwayM);
    return (worldX > oa && worldX < ob) || (worldX > da && worldX < db);
  }

  /**
   * The nearest site behind the aircraft that still wants crates and is
   * close enough to be worth going back for.
   */
  private siteBehind(worldX: number, dir: 1 | -1): { site: DropSite } | null {
    let best: DropSite | null = null;
    let bestBack = Infinity;
    for (const s of this.world.drops.sites) {
      if (s.state === 'served' || s.state === 'waiting' || s.got >= s.need) continue;
      // A crate still coming down to them is not a miss — a pallet hangs
      // under its canopy for ten seconds and more, and calling "you went
      // straight over us" while it did, then "delivered" when it landed,
      // was the game contradicting itself
      if (this.world.drops.inFlightFor(s)) continue;
      const back = -dir * (s.x - worldX);
      if (back > 1400 && back < 5000 * WORLD_PX_PER_M && back < bestBack) { best = s; bestBack = back; }
    }
    return best ? { site: best } : null;
  }

  /** Stable numeric seed from a contract id — shared with the board's preview. */
  private hashRoute(id: string): number {
    return routeSeed(id);
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
      this.spawnImpactDebris(this.planeScreenX, this.world.altitudeToScreenY(alt), 30);
      SoundEngine.impact();
      this.cameras.main.shake(500, 0.012);
      this.state.integrity = clamp(this.state.integrity - 45, 0, 100);
      this.state.speed *= 0.55;
      this.cargo.applyDamage(30);
      EventBus.emit('ui:show-notification', {
        message: `⚠ STRUCK A ${STRUCTURE_NAME[hit.kind] ?? hit.kind.toUpperCase()} — airframe critical`,
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
      this.planeX += this.heading * (hit.halfWidth * 2 + 40);
    }

    /*
     * Wires. A power line strike is not a mast strike — the cable parts, it
     * does not stop you dead — but it wraps the prop and the gear, snatches
     * the nose down and costs a chunk of airframe. Street wires are lighter
     * again. Either way the span comes down behind you and stays down.
     */
    const wire = this.hasBeenAirborne && !this.landed
      ? hz.wireStrike(this.prevHazardX, this.prevHazardAlt, worldX, alt) : null;
    this.prevHazardX = worldX;
    this.prevHazardAlt = alt;
    if (wire) {
      const power = wire.kind === 'power';
      hz.cutSpan(wire, worldX);
      this.spawnImpactDebris(this.planeScreenX, this.world.altitudeToScreenY(alt), power ? 22 : 10);
      SoundEngine.impact();
      this.cameras.main.shake(power ? 380 : 220, power ? 0.01 : 0.006);
      if (power) this.cameras.main.flash(120, 190, 220, 255);
      this.aircraft.notifyHit();
      this.state.integrity = clamp(this.state.integrity - (power ? 24 : 10), 0, 100);
      this.state.speed *= power ? 0.8 : 0.9;
      this.state.pitchRate -= power ? 18 : 8;
      this.cargo.applyDamage(power ? 8 : 3);
      EventBus.emit('ui:show-notification', {
        message: power
          ? '⚡ WIRE STRIKE — you took a power line down with you'
          : '⚠ WIRE STRIKE — street cables across the prop',
        type: 'danger',
      });
      this.disengageWarp('wire strike');
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
    }

    // Klaxon for a tall obstacle we are not currently above. The range is set
    // so the call always lands with enough room to out-climb the obstacle.
    // Range set so the call always lands with room to out-climb the tallest
    // obstacle in the mix (masts now reach 78 m).
    /*
     * Look-ahead is a TIME, not a distance.
     *
     * A flat 3600 px gave the crop duster seven seconds to react and the heavy
     * transport under three at the same warning - the faster the aircraft, the
     * less warning it got, which is exactly backwards. Scaling by ground speed
     * gives every airframe the same seconds to do something about it.
     */
    const lookAhead = (seconds: number): number => Math.max(
      2200, this.state.groundSpeed * seconds * WORLD_PX_PER_M,
    );
    const ahead = hz.ahead(worldX, lookAhead(7), alt, this.heading);
    // Height over whatever is actually below, not over sea level. A mast in
    // the way means the ground has effectively risen to meet you, and that is
    // exactly how it should feel to the Director.
    this.clearanceM = ahead ? Math.max(0, alt - ahead.hazard.heightM) : alt;
    const obstacleThreat = ahead !== null && alt < ahead.hazard.heightM + 12;
    this.coachObstacle = obstacleThreat && ahead
      ? {
        label: ahead.hazard.kind === 'pylon' ? 'Power line' : STRUCTURE_NAME[ahead.hazard.kind] ?? 'Obstacle',
        heightM: ahead.hazard.heightM, pylon: ahead.hazard.kind === 'pylon',
      }
      : null;
    if (!obstacleThreat) this.nagObstacle.clear();
    if (obstacleThreat && this.nagObstacle.due(this.state.elapsedSeconds)) {
      this.hazardAlertAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
      // A pylon is the front of a whole line of them, and the call says so
      // The caution chip names it and pulses; a toast saying the same thing
      // underneath it was the same alert twice.
      this.disengageWarp('obstacle ahead');
    }

    // ── Warlord ground fire ───────────────────────────────────────────────
    // Every weapon on the ground has its own reach. Small arms are a nuisance
    // you clear by not being on the deck; an AA battery reaches 340 m and
    // turns "how high do I cruise?" into a decision with a fuel bill attached.
    const fire = this.world.raiderFire(
      sdt, worldX, this.world.altitudeToScreenY(alt), alt, this.director.pressure,
    );
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
        // The chip carries it ("HEAVY MG — CLIMB 165m"); the sound says now
        SoundEngine.warn();
        this.disengageWarp('taking ground fire');
      }
    }
    // Each weapon has its own voice and distance dulls it, so you can hear
    // what is shooting and roughly how far off it is.
    if (fire.shots > 0 && fire.firedKind) {
      SoundEngine.gunshot(fire.firedKind, fire.firedDist);
    }
    /*
     * How much fire is in the air, as one decaying number for the Director.
     * Rounds arrive in bursts with dead frames between them, so sampling
     * `fire.shots` on its own would read as calm most of the time. Close fire
     * counts for more than distant fire, which is the difference between
     * being shot at and hearing shooting.
     */
    this.fireHeat = Math.max(
      this.fireHeat - sdt * 0.5,
      fire.shots > 0 ? 0.35 + (1 - fire.firedDist) * 0.65 : 0,
    );
    if (fire.hit) {
      SoundEngine.bulletHit();
      this.aircraft.notifyHit();
      this.state.integrity = clamp(this.state.integrity - fire.damage, 0, 100);
      this.cameras.main.shake(120, 0.004 + Math.min(0.006, fire.damage * 0.0012));
      if (Math.random() < 0.2) this.cargo.applyDamage(4);
    }

    // Advance call on the next stretch, so there is room to climb over it.
    // Only worth saying if their guns actually out-reach our current height.
    // Ten seconds: a climb over an AA ceiling takes longer than a dodge.
    const threat = this.world.threatAhead(worldX, lookAhead(10), this.heading);
    this.coachThreat = threat && alt < threat.ceilingM ? { label: threat.label, ceilingM: threat.ceilingM } : null;
    if (threat && alt < threat.ceilingM &&
        this.nagThreat.due(this.state.elapsedSeconds)) {
      this.threatAlertAt = this.state.elapsedSeconds;
      const call = `Ashline flight, ${threat.label.toLowerCase()} in the next stretch. `
        + `Clear altitude ${Math.round(threat.ceilingM)} metres.`;
      // Control warns you about the ground the same way it warns you about
      // the weather, so the two threats arrive in the same voice.
      SoundEngine.radio(call, { kind: 'control', station: 'ASHLINE CONTROL' });
      EventBus.emit('ui:show-notification', {
        message: `▲ ${threat.label} AHEAD — CLEAR ALTITUDE ${Math.round(threat.ceilingM)} m`,
        type: 'warning',
      });
      this.disengageWarp('hostile ground ahead');
    }

    /*
     * ── The service ceiling ───────────────────────────────────────────────
     *
     * `maxAltitude` used to be a hard clamp inside the integrator: you slid
     * along it like a shelf, with everything else about the aeroplane exactly
     * as it was on the runway. Now the air genuinely thins (see densityRatio),
     * the climb dies away on its own approaching the ceiling, and past it the
     * engine starves.
     *
     * Announced twice - a caution in the last 6% and then the flame-out - so
     * it is a limit you fly into knowingly, not one that just happens to you.
     */
    {
      const ceiling = SaveService.getActiveAircraft().def.stats.maxAltitude;
      if (alt > ceiling * 0.94 && !this.engineFailed
          && this.state.elapsedSeconds - this.ceilingWarnAt > 8) {
        this.ceilingWarnAt = this.state.elapsedSeconds;
        SoundEngine.warn();
        EventBus.emit('ui:show-notification', {
          message: `▲ SERVICE CEILING ${Math.round(ceiling)} m — the air is too thin up here`,
          type: 'warning',
        });
        this.disengageWarp('service ceiling');
      }
      /*
       * There is no flame-out up here any more. A real engine does not stop
       * at the ceiling; it simply runs out of air to make power with, so the
       * climb fades to nothing and the controls go soft. The model does that
       * on its own now — this only says so once, when the climb has gone.
       */
      if (this.controller.climbReserve < 0.1 && this.state.verticalSpeed < 1
          && this.state.elapsedSeconds - this.ceilingWarnAt2 > 25) {
        this.ceilingWarnAt2 = this.state.elapsedSeconds;
        SoundEngine.radio('Ashline flight, you are at your ceiling. She will not climb any higher in this air.',
          { kind: 'control', station: 'ASHLINE CONTROL' });
      }
    }

    /*
     * ── Engine reliability ────────────────────────────────────────────────
     *
     * Engines quit far too often: a 5% roll every five seconds for a tired
     * one, plus heat odds that climbed the moment a normal full-power climb
     * warmed it up — several stoppages a flight. Now the random part is rare
     * (a worn engine might do it once in a dozen flights), and heat only
     * breaks an engine that has been held AT its redline: running hot costs
     * power first (the controller), and the warning comes long before this.
     */
    if (this.engineRunning && !this.engineFailed && this.state.engineTemp > 0.97) this.redlineSeconds += sdt;
    if (!this.training && this.hasBeenAirborne && this.state.elapsedSeconds - this.failureCheckAt >= 5) {
      this.failureCheckAt = this.state.elapsedSeconds;
      if (this.engineRunning && !this.engineFailed) {
        const { def } = SaveService.getActiveAircraft();
        const risk =
          (1 - def.stats.engineReliability) * 0.0025 +
          Math.max(0, this.redlineSeconds - 12) * 0.004 +
          Math.max(0, (35 - this.state.integrity) / 35) * 0.03;
        if (Math.random() < risk) {
          this.engineFailed = true;
          this.engineRunning = false;
          this.aircraft.stopEngine();
          SoundEngine.engineSputter();
          EventBus.emit('ui:show-notification', {
            message: `✖ ENGINE FAILURE — ${press('engine')} to restart, trade height for speed`,
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
        // The crew clear away the moment the prop turns
        this.world.loading = false;
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
    if (!overspeed) this.nagOverspeed.clear();
    if (overspeed && this.nagOverspeed.due(this.state.elapsedSeconds)) {
      this.overspeedWarnAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
    }

    /*
     * -- The Director ------------------------------------------------------
     *
     * Run once here, at the end of the systems pass, where every sense is
     * this frame's truth. The consumers read `director.pressure` earlier in
     * their own updates and are therefore one frame behind, which does not
     * matter in the least: pressure climbs at 0.055 per second, so a frame is
     * about one part in three hundred of a move.
     */
    {
      // Hull loss as a RATE. The Director cares about being hammered right
      // now, not about damage taken twenty minutes ago and flown off since.
      const lost = Math.max(0, this.lastIntegrity - this.state.integrity);
      this.lastIntegrity = this.state.integrity;
      const instant = sdt > 0 ? lost / sdt : 0;
      this.hullLostRate += (instant - this.hullLostRate) * Math.min(1, sdt / 1.5);

      /*
       * The career model watches the same frame the Director does, but on
       * time constants two orders of magnitude longer. The Director asks
       * "what is happening right now"; this asks "who is this pilot".
       */
      if (this.hasBeenAirborne && !this.landed) {
        this.pilot.observe(sdt, {
          altitudeM: alt,
          throttle: this.state.throttle,
          weatherStrength: this.weather.current.turbulenceIntensity,
          weatherAheadStrength: this.weatherAhead ? 0.6 : 0,
          competence: this.director.state.competence,
        });
      }

      /*
       * Fuel at arrival, from the burn you are ACTUALLY achieving right now —
       * not from a table. Sink, a headwind aloft and a heavy throttle all show
       * up in it within a second or two, which is what makes it worth
       * watching rather than a decoration.
       */
      {
        const def = SaveService.getActiveAircraft().def;
        const remainingKm = Math.abs(this.routeKm - this.state.distanceTravelled);
        const kmPerSec = Math.max(0.0005, this.state.groundSpeed / 1000);
        const burnPerSec = (def.stats.fuelBurnRate * this.state.throttle) / 60;
        const needed = (burnPerSec / kmPerSec) * remainingKm;
        const projected = clamp(
          (this.state.fuel - needed) / Math.max(1, def.stats.fuelCapacity), 0, 1,
        );
        // Heavily smoothed: this should read as a trend you can steer, not a
        // needle that twitches on every gust.
        this.fuelAtArrival += (projected - this.fuelAtArrival) * Math.min(1, sdt / 2.5);
        /*
         * Only call it in the CRUISE.
         *
         * The projection is computed from the burn you are achieving right
         * now, so a full-power climb always reads badly — that is honest, and
         * it is exactly what makes the number worth watching. But shouting
         * about it during every departure would be crying wolf, so the call
         * waits until you are a quarter of the way along and no longer
         * climbing hard.
         */
        const settled = this.state.verticalSpeed < 3
          && this.state.distanceTravelled > this.routeKm * 0.25;
        if (settled && this.hasBeenAirborne && !this.landed && this.fuelAtArrival < 0.04
            && this.state.elapsedSeconds - this.arrivalWarnAt > 25) {
          this.arrivalWarnAt = this.state.elapsedSeconds;
          SoundEngine.radio(
            'Ashline flight, our numbers say you do not have the fuel for this at that power setting.',
            { kind: 'warning', station: 'ASHLINE CONTROL' },
          );
          EventBus.emit('ui:show-notification', {
            message: '⚠ YOU WILL NOT MAKE IT AT THIS RATE — ease the power or find lift',
            type: 'danger',
          });
        }
      }

      this.director.update(sdt, {
        routeFrac: clamp(this.planeX / (this.routeKm * 1000 * WORLD_PX_PER_M), 0, 1),
        onGround: alt <= 0.5,
        hullLostRate: this.hullLostRate,
        roundsNear: this.fireHeat,
        stallMargin: this.controller.stallMargin,
        groundClearanceM: this.clearanceM,
        turbulence: this.airTurb,
        weatherStrength: this.weather.current.turbulenceIntensity,
        trafficConflict: this.trafficAdvisory !== null,
        engineFailed: this.engineFailed,
        integrityFrac: this.state.integrity / 100,
      });
    }

    // ── Supply drops ──────────────────────────────────────────────────────
    this.updateDrops(sdt);

    // ── The coach ─────────────────────────────────────────────────────────
    this.updateCoach(sdt);

    // Annunciator panel state for the React HUD
    EventBus.emit('flight:status', {
      engineFailed: this.engineFailed,
      underFire: this.underFire,
      groundThreat: this.groundThreat,
      rangedOn: this.world.raiders.rangedOn,
      airVertical: this.airVertical,
      inThermal: this.inThermal,
      weatherAhead: this.weatherAhead,
      weatherCaution: this.weatherCaution,
      iceLoad: this.iceLoad,
      avionicsOut: this.avionicsOut,
      stall: this.stallWarning,
      overspeed,
      obstacleAheadM: ahead && alt < ahead.hazard.heightM + 18 ? ahead.hazard.heightM : null,
      obstacleLabel: ahead && alt < ahead.hazard.heightM + 18
        ? (ahead.hazard.kind === 'pylon' ? 'POWER LINES' : STRUCTURE_NAME[ahead.hazard.kind] ?? 'OBSTACLE')
        : null,
      trafficDeltaM: this.trafficAdvisory,
      trafficAvoid: this.trafficAvoid,
      fuelAtArrival: this.fuelAtArrival,
      retractableGear: this.aircraft.hasRetractableGear,
      // A camp is signalling and there is something left to drop on it
      dropReady: this.world.dropReticle !== null,
      cratesLeft: this.world.drops.cratesLeft,
      dropZone: this.dropZone,
      overshot: this.overshotCalled && this.heading === 1,
      canTurn: this.hasBeenAirborne && !this.landed && this.state.altitude > 12 && this.turn === null,
      flaps: {
        stops: this.controller.flapStops,
        limitKmh: Number.isFinite(this.controller.flapLimit) ? Math.round(this.controller.flapLimit * 3.6) : null,
        nextLimitKmh: this.state.flapStage < 3 ? Math.round(this.controller.flapLimitAt(this.state.flapStage + 1) * 3.6) : null,
        overspeed: this.controller.flapOverspeed,
        blownBack: this.controller.flapBlownBack,
      },
      stallKmh: Math.round(this.controller.stallSpeedNow * 3.6),
      climbReserve: this.controller.climbReserve,
      eventCaution: this.eventCaution && this.state.elapsedSeconds < this.eventCaution.until
        ? this.eventCaution.text : null,
      coolantLeft: this.coolantLeft,
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
        message: `⚡ LIGHTNING STRIKE — engine out. ${press('engine')} to restart.`,
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
          message: `✖ SAND HAS KILLED THE ENGINE — ${press('engine')} to restart`,
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

  // ── Supply drops ──────────────────────────────────────────────────────────

  /**
   * Survivors, flares and crates — the cruise's one active thing to do.
   *
   * Runs the physics, raises the reticle while a camp is signalling, handles
   * the release, and pays out on landing. Money is credited the moment the
   * crate lands rather than at the end of the flight: it has been delivered,
   * and it should survive you crashing ten minutes later.
   */
  private updateDrops(sdt: number): void {
    const drops = this.world.drops;
    const worldX = this.planeX;
    const alt = this.state.altitude;
    const airborne = this.hasBeenAirborne && alt > 3 && !this.landed;
    const gs = Math.max(25, this.state.groundSpeed);
    /*
     * Calls are timed, not ranged.
     *
     * The flare used to go up 290 m out — five seconds in the crop duster and
     * under two in the transport, from a cruise at 150 m. Nobody can come down
     * 120 m in two seconds, so the drop was only ever possible if you happened
     * to be low already. Now the first call comes about forty seconds out,
     * which is a comfortable descent at any speed, and the flare at twelve.
     */
    const inboundPx = Math.max(2800, gs * 40) * WORLD_PX_PER_M;
    const signalPx = Math.max(900, gs * 12) * WORLD_PX_PER_M;
    const dir = this.heading;
    const ev = drops.update(sdt, worldX, airborne, inboundPx, signalPx, dir);
    const touch = isTouchDevice();
    const seen = SaveService.get().player.stats.supplyDrops ?? 0;

    if (ev.inbound && drops.cratesLeft > 0) {
      const site = ev.inbound;
      const km = Math.abs(site.x - worldX) / (WORLD_PX_PER_M * 1000);
      const pallet = drops.method === 'pallet';
      const where = site.kind === 'rooftop'
        ? (pallet ? `holed up in a block in ${site.place}` : `on a rooftop in ${site.place}`)
        : site.kind === 'square' ? `in ${site.place} square` : `at ${site.place}`;
      const crates = `${site.need} crate${site.need > 1 ? 's' : ''}`;
      SoundEngine.radio(
        `Any aircraft, ${site.people} of us ${where}. We need ${crates}.`
          + (pallet ? ' Drop zone is marked with orange panels.' : '')
          + (site.besieged ? ' Raiders all round us — watch the rifles.' : ''),
        { kind: 'traffic', station: site.place.toUpperCase() },
      );
      EventBus.emit('ui:show-notification', {
        // Hold, not descend: the guns are between you and them until the
        // card says otherwise
        message: seen < 3
          ? `📦 ${titleOf(site)} ${km.toFixed(1)} km — they need ${crates}. Hold your height until the card says descend`
          : `📦 ${titleOf(site)} · ${km.toFixed(1)} km · needs ${crates}${site.besieged ? ' · UNDER FIRE' : ''}`,
        type: 'info',
      });
      this.disengageWarp('supply drop ahead');
    }
    if (ev.signalled && drops.cratesLeft > 0) {
      const site = ev.signalled;
      EventBus.emit('ui:show-notification', {
        message: seen < 3
          ? `📦 Flare up over ${site.place} — ${touch ? 'tap DROP' : 'press SPACE'} on the run-in and the crate goes on the mark`
          : `📦 Flare up over ${site.place}`,
        type: 'info',
      });
    }

    // Reticle while there is someone to aim at
    const site = airborne ? drops.activeSite(worldX, dir) : null;
    let meter: { gapM: number; windowM: number; releaseIn: number } | null = null;
    if (site && drops.cratesLeft > 0) {
      const imp = drops.predictImpact(worldX, alt, this.state.groundSpeed, dir);
      const windowM = drops.targetHalfM(site);
      const gapM = dir * (site.x - imp.x) / WORLD_PX_PER_M;
      const roof = site.kind === 'rooftop' && drops.method === 'bundle' ? site.roof : null;
      const onTarget = roof
        ? Math.abs(imp.x - roof.x) <= roof.halfWidth && imp.altM > 1
        : Math.abs(gapM) <= windowM;
      this.world.dropReticle = {
        x: imp.x, altM: imp.altM, onTarget, spreadM: drops.spreadM(alt, imp.fallS),
      };
      meter = { gapM, windowM, releaseIn: (gapM - windowM * 0.4) / gs };
    } else {
      this.world.dropReticle = null;
    }

    /*
     * The run-in: ticks at three, two, one, and a tone on them — then a
     * moment of slow motion over the release itself.
     *
     * At cruise the people cross from the edge of the screen to the aim point
     * in about a second. That is a reflex test, not a drop, and on a phone it
     * was effectively impossible. The ticks let you time it by ear from
     * several seconds out; the slow motion (only while you are down in the
     * window, and only for those two seconds) gives the eye a fair chance.
     */
    let slowTarget = 1;
    if (meter && site) {
      const inBand = alt <= site.bandHi + 12;
      const whole = Math.ceil(meter.releaseIn);
      if (inBand && whole >= 1 && whole <= 3 && whole < this.dropTickAt) {
        this.dropTickAt = whole;
        SoundEngine.dropTick(false);
      }
      const inWindow = Math.abs(meter.gapM) <= meter.windowM;
      if (inBand && inWindow && !this.dropWindowToned) {
        this.dropWindowToned = true;
        SoundEngine.dropTick(true);
      }
      if (!inWindow && meter.gapM > meter.windowM) this.dropWindowToned = false;
      if (inBand && meter.releaseIn < 2.2 && meter.gapM > -meter.windowM * 1.4) slowTarget = 0.45;
    } else {
      this.dropTickAt = 99;
      this.dropWindowToned = false;
    }
    this.dropSlow += (slowTarget - this.dropSlow) * Math.min(1, (sdt / Math.max(0.05, this.dropSlow)) * 5);

    /*
     * The window, and when to start down into it.
     *
     * Every drop site has a corridor in front of it that no gun can reach —
     * the layout guarantees it (see Hazards.generate). Outside it, the card
     * says HOLD and there is no band: coming down early just means coming
     * down among the guns. At the corridor's edge it says DESCEND, the band
     * appears, and a path is drawn from the aircraft to where the band
     * starts, with the sink rate that gets you there.
     */
    const next = airborne && drops.cratesLeft > 0 ? drops.nextCalling(worldX, dir) : null;
    this.dropGuideFade = next
      ? Math.min(1, this.dropGuideFade + sdt / 1.2)
      : Math.max(0, this.dropGuideFade - sdt / 0.8);
    if (next) {
      const km = Math.max(0, dir * (next.x - worldX) / (WORLD_PX_PER_M * 1000));
      const corridorKm = DROP_RUN_BEFORE_PX / (WORLD_PX_PER_M * 1000) - 0.05;
      /*
       * The layout keeps the run-in out of gun range from the side you
       * normally come from. Turn round and come back at it from the other
       * side and there is no such promise, so ask the guns: if they cover
       * this approach the card says so and the band stays away.
       */
      const approachFrom = next.x - dir * DROP_RUN_BEFORE_PX;
      const covered = !next.besieged && dir === -1 && this.world.gunsReach(approachFrom, next.x) > 0;
      const inCorridor = km <= corridorKm && !covered;
      let cue: DropZoneStatus['cue'];
      // The crates carry forward as they fall, so once the aim point is past
      // them any crate out of the door now lands beyond them
      const aimPast = this.world.dropReticle !== null && next.state === 'signalled'
        && dir * (this.world.dropReticle.x - next.x) / WORLD_PX_PER_M > 30;
      if (!inCorridor) cue = 'hold';
      // Just let one go: the aim point is past them because the crate is on
      // its way, not because the pass was late
      else if (aimPast) {
        cue = this.dropAwayFor === next && (drops.inFlightFor(next) || this.state.elapsedSeconds - this.dropAwayAt < 3)
          ? 'away' : 'late';
      }
      else if (alt < next.bandLo - 2) cue = 'low';
      else if (alt <= next.bandHi + 3) cue = this.world.dropReticle?.onTarget ? 'release' : 'window';
      else cue = 'descend';
      // Where the band starts, and the sink rate that reaches it from here
      const bandStartX = next.x - dir * DROP_BAND_RUN_PX;
      const bandMid = (next.bandLo + next.bandHi) / 2;
      const secsToBand = Math.max(1, dir * (bandStartX - worldX) / WORLD_PX_PER_M / gs);
      const descentRate = cue === 'descend' ? Math.max(0, (alt - bandMid) / secsToBand) : 0;
      if (cue === 'descend' && !this.descentCalled.has(next)) {
        this.descentCalled.add(next);
        EventBus.emit('ui:show-notification', {
          message: `▼ Clear of the guns — start down to ${next.bandLo}–${next.bandHi} m`,
          type: 'info',
        });
      }
      this.dropZone = {
        place: next.place, kind: next.kind, km, need: next.need, got: next.got,
        lo: next.bandLo, hi: next.bandHi, besieged: next.besieged, cue,
        descendInKm: Math.max(0, km - corridorKm),
        covered,
        descentRate,
        aboard: drops.cratesLeft,
        gapM: meter && site === next ? meter.gapM : null,
        windowM: meter?.windowM ?? 30,
        releaseIn: meter && site === next ? meter.releaseIn : null,
        armed: this.dropArmed === next,
        method: drops.method,
      };
      // The band only once it is safe to use; the path only while getting to it
      const path = cue === 'descend' && dir * (bandStartX - worldX) > 0
        ? { x0: worldX, alt0: alt, x1: bandStartX, alt1: bandMid }
        : cue === 'low'
          ? { x0: worldX, alt0: alt, x1: worldX + dir * 260 * WORLD_PX_PER_M, alt1: bandMid }
          : null;
      this.world.dropGuide = cue === 'hold'
        ? null
        : { lo: next.bandLo, hi: next.bandHi, fade: this.dropGuideFade, path, dir };
    } else {
      this.dropZone = null;
      this.world.dropGuide = this.dropGuideFade > 0 && this.world.dropGuide
        ? { ...this.world.dropGuide, fade: this.dropGuideFade } : null;

      /*
       * Flew past them. They still need crates and there are crates aboard,
       * so this is not over — it is a second pass. Say so, once, from the
       * people on the ground and on the card, and point at the control that
       * does it. Turn round and they are ahead again and the card takes over.
       */
      const behind = airborne && drops.cratesLeft > 0 ? this.siteBehind(worldX, dir) : null;
      if (behind) {
        const back = -dir * (behind.site.x - worldX);
        if (!this.missedCalled.has(behind.site)) {
          this.missedCalled.add(behind.site);
          const want = behind.site.need - behind.site.got;
          // A site that has had crates from this pass was not missed — it
          // just wants more, and saying "missed" next to "right on them"
          // read as the game contradicting itself
          const had = behind.site.got > 0;
          SoundEngine.radio(had
            ? `${behind.site.place} here — got that one, thank you! We need ${want} more — come round again.`
            : `${behind.site.place} here — you went straight over us! Come round again.`,
          { kind: 'traffic', station: behind.site.place.toUpperCase() });
          EventBus.emit('ui:show-notification', {
            message: had
              ? `↺ ${titleOf(behind.site)} needs ${want} more — ${press('turn')} to go back`
              : `↺ Missed ${titleOf(behind.site)} — ${press('turn')} to go back · they still need ${want}`,
            type: had ? 'info' : 'warning',
          });
        }
        this.dropZone = {
          place: behind.site.place, kind: behind.site.kind, km: back / (WORLD_PX_PER_M * 1000),
          need: behind.site.need, got: behind.site.got, lo: behind.site.bandLo, hi: behind.site.bandHi,
          besieged: behind.site.besieged, cue: 'behind', descendInKm: 0, descentRate: 0,
          aboard: drops.cratesLeft, gapM: null, windowM: 30, releaseIn: null,
          method: drops.method,
        };
      }
    }
    // A fresh pass gets its own call if it is missed again
    for (const s of this.missedCalled) {
      if (dir * (s.x - worldX) > 0) this.missedCalled.delete(s);
    }

    // Release
    const pressed = Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || TouchInput.consume('drop');
    const letGo = (): void => {
      if (drops.release(worldX, alt, this.state.groundSpeed, dir, site)) {
        this.dropAwayFor = site;
        this.dropAwayAt = this.state.elapsedSeconds;
        this.dropStats.dropped++;
        SoundEngine.gearMove(false);    // the door and the thump of it going
      }
    };
    if (pressed && airborne) {
      if (drops.cratesLeft <= 0) {
        EventBus.emit('ui:show-notification', { message: 'No crates left aboard.', type: 'info' });
      } else if (this.dropArmed) {
        // A second press is "now", whatever the sight says
        this.dropArmed = null;
        letGo();
      } else if (meter && site && meter.gapM > meter.windowM * 0.5 && meter.releaseIn < 12) {
        /*
         * Pressed on the run-in: arm it, and the crate goes on the mark.
         *
         * This is how a transport actually drops — the release point is
         * computed and the load goes on the green light — and it is what
         * makes a rooftop thirteen metres wide, crossed in a fifth of a
         * second, a drop rather than a coin toss. Flying it there is still
         * the pilot's job: the height decides the spread, and a pass that is
         * too high puts the crate somewhere round them, not on them.
         */
        this.dropArmed = site;
        SoundEngine.dropTick(false);
      } else {
        letGo();
      }
    }
    if (this.dropArmed) {
      if (!meter || site !== this.dropArmed || drops.cratesLeft <= 0 || !airborne) {
        this.dropArmed = null;
      } else if (meter.gapM <= 0) {
        this.dropArmed = null;
        letGo();
      }
    }

    // Landings. Paid the moment they land: it has been delivered, and it should
    // survive you crashing ten minutes later.
    const pay = (money: number, rep: number): void => {
      // Practice crates: the lesson would otherwise be a money printer
      if (this.training) return;
      const save = SaveService.get();
      save.player.money += money;
      const origin = window.gameData.settlements.find(x => x.id === this.originId);
      const r = save.player.reputation.find(x => x.factionId === origin?.factionId);
      if (r) r.points += rep;
      SaveService.save(save.player, save.world);
      EventBus.emit('player:money-changed', { amount: save.player.money, delta: money });
      this.dropStats.earned += money;
    };
    for (const hit of ev.landed) {
      const r = DROP_REWARD[hit.result];
      if (hit.money > 0) {
        this.dropStats.hits++;
        SoundEngine.chime();
        if (!this.training) {
          const save = SaveService.get();
          save.player.stats.supplyDrops = (save.player.stats.supplyDrops ?? 0) + 1;
          pay(hit.money, hit.rep);
        }
      }
      // The people answer the first crate, in their own words — and a crate
      // they cannot reach, because that is worth knowing
      if (hit.site && ((hit.money > 0 && hit.site.got === 1) || hit.unreachable)) {
        SoundEngine.radio(siteReply(hit.result, hit.site.kind, hit.site.seed),
          { kind: 'traffic', station: hit.site.place.toUpperCase() });
      }
      const line = hit.unreachable ? 'In the street — they cannot reach it. Put it on the roof' : r.line;
      const left = hit.site && hit.site.got < hit.site.need
        ? ` · ${hit.site.need - hit.site.got} more wanted` : '';
      // A crate that lands a long way from anybody was not a near miss
      const wasted = hit.money === 0 && hit.distM > 300;
      EventBus.emit('ui:show-notification', {
        message: this.training && hit.money > 0
          ? `📦 ${line} — that is how it is done`
          : hit.money > 0
            ? `📦 ${line} — +₢${hit.money.toLocaleString()}${left}`
            : hit.unreachable ? `📦 ${line}`
            : wasted ? '📦 Nobody down there — that crate is gone'
              : `📦 ${line} (${Math.round(hit.distM)} m off)`,
        type: hit.result === 'bullseye' ? 'success' : hit.money > 0 ? 'info' : 'warning',
      });
    }
    for (const done of ev.completed) {
      if (this.training) continue;
      pay(done.bonus, 2);
      SoundEngine.radio(`${done.site.place} here. That is everything we asked for. God bless you, pilot.`,
        { kind: 'traffic', station: done.site.place.toUpperCase() });
      EventBus.emit('ui:show-notification', {
        message: `✔ ${titleOf(done.site)} supplied — +₢${done.bonus.toLocaleString()} bonus`,
        type: 'success',
      });
    }
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
      heading: this.heading,
      airborne: this.hasBeenAirborne && !this.rollout,
      routeEndPx: this.routeKm * 1000 * WORLD_PX_PER_M,
      pressure: this.director.pressure,
    });

    // ── Advisory: relative height and which way to go, like the real box ──
    const ra = traffic.advisory(worldX, this.state.altitude, speedPx, this.heading);
    this.trafficAdvisory = ra ? Math.round(ra.dAltM) : null;
    this.trafficAvoid = ra ? ra.avoid : null;
    if (!ra) this.nagTraffic.clear();
    if (ra && this.nagTraffic.due(this.state.elapsedSeconds)) {
      this.trafficAlertAt = this.state.elapsedSeconds;
      SoundEngine.alarm();
      // The TRAFFIC chip says how far and which way; the alarm says now
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
    const ax = this.planeScreenX + this.heading * this.rig.offsetX;
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
    // An ELT is exactly what follows a midair, and it is the one radio sound
    // in the game that means something has already gone wrong rather than
    // that something might.
    SoundEngine.radio('MAYDAY MAYDAY MAYDAY - midair, going down.', { kind: 'mayday' });
    EventBus.emit('ui:show-notification', {
      message: '📻 MAYDAY — emergency locator on the frequency.',
      type: 'danger',
    });
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

  /**
   * The approach call, read against the GLIDE PATH rather than the sink rate.
   *
   * It used to say GOOD APPROACH for any gentle descent — including one that
   * would have put you down a kilometre short or floated you off the far end,
   * which is how most failed deliveries actually ended. Now it knows where the
   * touchdown point is: high, on the path, low, flare, or floating, each with
   * the one thing to do about it. The world draws the same path (see
   * ParallaxWorld.drawLandingGuide), so the call and the picture agree.
   */
  private updateApproachIndicator(): void {
    const [da] = destStripPx(this.routeKm, this.destRunwayM);
    const [, db] = destStripPx(this.routeKm, this.destRunwayM);
    // Touch down a little past the threshold you are coming in over
    const aimX = this.heading === 1 ? da + 80 * WORLD_PX_PER_M : db - 80 * WORLD_PX_PER_M;
    const distM = this.heading * (aimX - this.planeX) / WORLD_PX_PER_M;
    const alt = this.state.altitude;
    const on = this.hasBeenAirborne && !this.landed && !this.rollout && distM > -500 && distM < 3200 && alt < 260;
    this.world.landingGuide = on ? { aimX, angleDeg: GLIDE_DEG, dir: this.heading, fade: clamp((3200 - distM) / 600, 0.3, 1) } : null;
    if (!on || distM > 2400) { this.approachText.setAlpha(0); return; }

    const vSpeed = this.state.verticalSpeed;
    const pathAlt = Math.max(0, distM) * Math.tan((GLIDE_DEG * Math.PI) / 180);
    let label: string;
    let color: string;
    if (!this.state.gearDown) {
      label = `⚠  GEAR NOT DOWN — ${press('gear').toUpperCase()}  ⚠`; color = '#ff4444';
    } else if (distM < 0 && alt > 1) {
      label = '↓  FLOATING — power off, let her settle'; color = '#ffd080';
    } else if (alt < 6) {
      label = vSpeed < -2.5 ? '▲  FLARE — ease the nose up' : '✓  HOLD IT OFF…'; color = vSpeed < -2.5 ? '#ffd080' : '#9fe8b0';
    } else if (vSpeed < -7) {
      label = '▼  SINKING FAST — power, nose up'; color = '#ff4444';
    } else if (alt > pathAlt + 12 + distM * 0.01) {
      label = '▲  HIGH — less power, steepen'; color = '#ffd080';
    } else if (alt < pathAlt - 10 - distM * 0.006) {
      label = '▼  LOW — more power'; color = alt < pathAlt * 0.5 ? '#ff6644' : '#ffd080';
    } else {
      label = '✓  ON THE GLIDE PATH'; color = '#00ff88';
    }
    this.approachText.setText(label).setStyle({ color }).setAlpha(1);
  }

  /** Fire the emergency coolant charge, if there is one and the engine needs it. */
  private dumpCoolant(): void {
    const r = tryDumpCoolant(this.state, this.coolantLeft);
    this.coolantLeft = r.left;
    if (r.result === 'empty') {
      EventBus.emit('ui:show-notification', { message: 'No coolant left this flight.', type: 'info' });
      return;
    }
    if (r.result === 'not-hot') {
      EventBus.emit('ui:show-notification', { message: 'Engine is not hot — coolant saved for when it is.', type: 'info' });
      return;
    }
    this.state = r.state;
    SoundEngine.steamVent();
    const eng = this.aircraft.enginePoint();
    const steam = this.add.particles(eng.x, eng.y, 'px_soft', {
      lifespan: { min: 500, max: 1200 },
      speedX: { min: -140, max: -40 },
      speedY: { min: -60, max: 10 },
      scale: { start: 0.35, end: 1.1 },
      alpha: { start: 0.65, end: 0 },
      tint: [0xe8f0f2, 0xcfd8dc],
      emitting: false,
    }).setDepth(7);
    steam.explode(18);
    this.time.delayedCall(1300, () => steam.destroy());
    EventBus.emit('ui:show-notification', { message: 'Coolant dumped — engine back to 40%.', type: 'success' });
  }

  /** Drop out of time warp with a reason the player can act on. */
  private disengageWarp(reason: string): void {
    if (this.timeScale === 1) return;
    this.timeScale = 1;
    this.warpText.setVisible(false);
    EventBus.emit('ui:show-notification', { message: `»» Warp off — ${reason}`, type: 'info' });
  }

  // ── Event cinematics ──────────────────────────────────────────────────────
  // Physics keeps running during these (the modal hasn't opened yet), so the
  // player sees the event HAPPEN before being asked what to do about it.

  private playEventCinematic(event: FlightEventDefinition, done: () => void): void {
    switch (event.id) {
      case 'bird_strike':        this.cinematicBirdStrike(done); return;
      case 'fuel_leak':          this.cinematicFuelLeak(done); return;
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

  // ── Landing ───────────────────────────────────────────────────────────────

  /**
   * The coach, each frame: tell it what is going on, draw any height band it
   * wants, and hand the HUD what to show.
   */
  private updateCoach(sdt: number): void {
    const coach = this.coach;
    if (!coach) return;
    // Lessons are read in REAL time — under a time warp a twelve-second
    // lesson used to be gone in three
    const realDt = sdt / Math.max(0.1, this.timeScale * this.dropSlow);
    const view = coach.update(realDt, this.state, {
      touch: isTouchDevice(),
      retractableGear: this.aircraft.hasRetractableGear,
      engineRunning: this.engineRunning,
      loadingLeft: this.loadingLeft,
      landed: this.landed,
      timeWarp: this.timeScale,
      remainingKm: Math.abs(this.routeKm - this.state.distanceTravelled),
      vrKmh: Math.round(this.controller.stallSpeedNow * 1.1 * 3.6),
      obstacle: this.coachObstacle,
      threat: this.coachThreat,
      drop: this.dropZone,
      crateHits: this.dropStats.hits,
      weatherAhead: this.weatherAhead,
      traffic: this.trafficAdvisory !== null,
      overshot: this.overshotCalled && this.heading === 1,
    });
    this.coachGuideFade = view?.guide
      ? Math.min(1, this.coachGuideFade + sdt / 1.2)
      : Math.max(0, this.coachGuideFade - sdt / 0.8);
    if (view?.guide) {
      this.world.trainGuide = { ...view.guide, fade: this.coachGuideFade };
    } else if (this.world.trainGuide) {
      this.world.trainGuide = this.coachGuideFade > 0
        ? { ...this.world.trainGuide, fade: this.coachGuideFade } : null;
    }
    this.emitCoachView(view);
  }

  private emitCoachView(view: CoachView | null): void {
    const key = view ? `${view.title}|${view.text}` : '';
    if (key === this.coachViewKey) return;
    this.coachViewKey = key;
    EventBus.emit('flight:tutorial', view
      ? {
        text: view.text, title: view.title, step: view.step, total: view.total, keys: view.keys,
        training: this.training, coach: true,
      }
      : { text: null });
    // The legend and the lesson share the bottom of the screen
    this.keyHintText?.setVisible(view === null);
  }

  /**
   * The end of the lesson. No contract, no post-flight report: a debrief
   * over the aeroplane where it stopped, paid once, and the choice to go
   * again or get on with it.
   */
  private finishTraining(result: LandingResult): void {
    this.emitCoachView(null);
    this.world.trainGuide = null;
    const crashed = result.quality === 'crash';
    const onRunway = this.isOnRunway(this.planeX);
    const passed = !crashed && onRunway;
    const save = SaveService.get();
    const firstTime = passed && !save.player.stats.trainingDone;
    if (passed) {
      save.player.stats.trainingDone = true;
      if (firstTime) save.player.money += TRAINING_REWARD;
      SaveService.save(save.player, save.world);
      if (firstTime) EventBus.emit('player:money-changed', { amount: save.player.money, delta: TRAINING_REWARD });
    }
    const debrief = (): void => {
      EventBus.emit('flight:training-complete', {
        passed,
        reward: firstTime ? TRAINING_REWARD : 0,
        landing: crashed ? 'crash' : result.quality,
        onRunway,
        crates: this.dropStats.hits,
      });
    };
    if (!crashed) {
      SoundEngine.chime();
      debrief();
      return;
    }
    this.crashing = true;
    SoundEngine.stopFlightLoop();
    this.state.speed = 0;
    this.state.verticalSpeed = 0;
    this.state.throttle = 0;
    this.crash.play(
      { speed: this.state.speed, verticalSpeed: Math.abs(result.verticalSpeed), gearUp: !this.state.gearDown, dir: this.heading },
      debrief,
    );
  }

  private finishFlight(result: LandingResult): void {
    if (this.landed) return;
    this.landed = true;
    // A flight can end halfway round a turn. Finish the turn where it stands,
    // so the wreck or the rollout is the side-on aeroplane and not the model.
    if (this.turn) {
      this.turn = null;
      this.aircraft.setFacing(this.heading);
    }

    if (this.training) {
      this.finishTraining(result);
      return;
    }

    /*
     * Fold this crossing into the career numbers and write them down.
     *
     * Done here rather than in PostFlightScene because BOTH exits pass through
     * this method - a good landing and a smoking hole teach the model equally
     * - and because a crash's cinematic runs for several seconds afterwards,
     * during which the scene could be torn down.
     */
    this.pilot.recordLanding(result.verticalSpeed);
    const profile = this.pilot.endFlight();
    const save = SaveService.get();
    SaveService.save({ ...save.player, pilot: profile }, save.world);

    const data = {
      result,
      contractId: this.contractId,
      finalState: this.state,
      cargoSlots: this.cargo.slots,
      reachedDestination: this.state.distanceTravelled >= this.routeKm * 0.9,
      landedOnRunway: this.isOnRunway(this.planeX),
      closeCalls: this.closeCalls,
      // What the world has worked out about you, in words. An adaptive system
      // nobody can see is indistinguishable from an unfair one.
      logbook: this.pilot.describe(),
      drops: this.dropStats,
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
    const crashX = this.planeX;
    for (const h of this.world.hazards.near(crashX, 70)) {
      this.world.hazards.damageAt(h, 0.9);
    }
    SoundEngine.stopFlightLoop();
    // Silence the panel: nothing is overspeeding or being shot at any more,
    // and leaving "CLIMB 340 m" flashing over a burning wreck is absurd.
    this.groundThreat = null;
    this.trafficAdvisory = null;
    EventBus.emit('flight:status', {
      engineFailed: false, underFire: false, groundThreat: null, rangedOn: 0, airVertical: 0, inThermal: false, weatherAhead: null, stall: false,
      overspeed: false, obstacleAheadM: null, obstacleLabel: null, trafficDeltaM: null, trafficAvoid: null,
      weatherCaution: null, iceLoad: 0, avionicsOut: false, fuelAtArrival: 1, retractableGear: true,
      dropReady: false, cratesLeft: 0, dropZone: null, overshot: false, canTurn: false,
      flaps: null, stallKmh: 0, climbReserve: 1, eventCaution: null, coolantLeft: 0,
    });
    this.state.speed = 0;
    this.state.verticalSpeed = 0;
    this.state.throttle = 0;
    EventBus.emit('flight:state-update', this.state);
    // Your own beacon. It fires under the wreck as the slide starts, which is
    // when a real ELT triggers - on the impact, not on the fireball.
    SoundEngine.radio('MAYDAY - Ashline flight is down.', { kind: 'mayday' });
    EventBus.emit('ui:show-notification', {
      message: '📻 Your locator beacon is transmitting.',
      type: 'danger',
    });
    this.crash.play(
      {
        speed: this.state.speed,
        verticalSpeed: Math.abs(result.verticalSpeed),
        gearUp: !this.state.gearDown,
        dir: this.heading,
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

/** "Millbrook rooftop", "a quarry camp" — what the call is about, in a few words. */
function titleOf(site: DropSite): string {
  const place = site.place.charAt(0).toUpperCase() + site.place.slice(1);
  return site.kind === 'rooftop' ? `${place} rooftop`
    : site.kind === 'square' ? `${place} square` : place;
}
