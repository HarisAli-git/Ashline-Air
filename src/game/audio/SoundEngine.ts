/**
 * Procedural sound engine — pure WebAudio, zero assets, zero dependencies.
 *
 * Continuous layers (engine, prop chop, exhaust hiss, wind rush, ground
 * rumble, stall horn) are synthesized once and modulated every frame from
 * flight state. One-shots (tire chirp, clunks, thunder, gunfire) are short
 * envelope bursts. Everything runs through a compressor so stacked events
 * never clip.
 *
 * The AudioContext can only start after a user gesture, so `unlock()` is
 * called from the first pointer/key event.
 */

export interface FlightAudioState {
  rpm: number;          // 0–1 spooled engine speed
  throttle: number;     // 0–1
  speedFrac: number;    // 0–1 airspeed vs a nominal max
  onGround: boolean;
  gearDown: boolean;
  flapsDeployed: boolean;
  turbulence: number;   // 0–1
  roughness: number;    // 0–1 engine distress (heat + damage)
  timeScale: number;    // 1, 4, 8 …
  /** Frame delta in seconds — drives the ducking envelope. */
  dt: number;
}

/*
 * Bus levels, in one place.
 *
 * These used to live as literals inside unlock() AND again inside applyDuck(),
 * which is a duplication that silently undoes itself: ducking restored the
 * engine to a hardcoded 0.50 regardless of what the bus was actually set to.
 */
/*
 * Rebalanced, measured through the real master chain (see the headless mix
 * probe): the engine at cruise was -16.6 dBFS RMS and every weather bed sat
 * BELOW it on its own (-19 to -27) — so a sandstorm, which should be the
 * loudest thing in the sky, was a hiss under the drone, and the drone kept
 * the shared compressor working so hard that everything else was pushed
 * down with it. The engine now sits well under the world: present, not
 * dominant.
 */
const BUS_ENGINE = 0.55;
const BUS_WORLD  = 1.00;
const BUS_ALERT  = 1.00;
/**
 * Cockpit cues — the gear, the flaps, the drop ticks, the chimes, the
 * warnings, the vario. Measured over the cruise bed they came out between
 * −1 and +3 dB: the same level as the drone they were meant to cut through,
 * so in practice they were not heard. Their own bus puts them a clear
 * +9 dB up without touching the radio, the gunfire or the thunder.
 */
const BUS_CUE    = 2.8;

/**
 * Makeup gain after the compressor.
 *
 * A WebAudio DynamicsCompressorNode has NO automatic makeup gain - it only
 * ever takes level away. Without this stage the whole game played roughly
 * 15 dB below where it should: a cruising engine measured -34 dBFS RMS, which
 * is why it was barely audible at full speaker volume.
 */
const MAKEUP = 2.6;

/**
 * What kind of call is coming over the radio.
 *
 * These are four different CONSTRUCTIONS, not one sound at four pitches — see
 * the note on `radio()`. Nothing else in the game distinguishes a routine
 * advisory from an aircraft going down, so the radio has to.
 */
export type RadioKind = 'control' | 'warning' | 'traffic' | 'mayday';

class SoundEngineClass {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** The mix compressor, kept so a probe can read how hard it is working. */
  private comp: DynamicsCompressorNode | null = null;
  /** Post-compressor makeup. See MAKEUP. */
  private makeup: GainNode | null = null;
  /** Final node before the speakers, exposed for measurement. */
  private out: AudioNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private volume = 0.9;

  // ── Continuous flight nodes ───────────────────────────────────────────────
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private chopLfo: OscillatorNode | null = null;
  private chopDepth: GainNode | null = null;
  private chopGain: GainNode | null = null;

  private exhaustSrc: AudioBufferSourceNode | null = null;
  private exhaustGain: GainNode | null = null;
  private exhaustFilter: BiquadFilterNode | null = null;

  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  private rumbleSrc: AudioBufferSourceNode | null = null;
  private rumbleGain: GainNode | null = null;
  private rumbleFilter: BiquadFilterNode | null = null;

  private hornOsc: OscillatorNode | null = null;
  private hornOsc2: OscillatorNode | null = null;
  private hornGain: GainNode | null = null;
  private hornOn = false;

  private ambientSrc: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  /** The slow LFOs that make the ambient wind gust rather than hiss. */
  private ambientLfos: OscillatorNode[] = [];
  /**
   * A scene asked for the ambient bed before the browser allowed audio. The
   * menu does exactly that on every cold start, so the wind used to stay
   * silent until the next scene change; unlock() starts it instead.
   */
  private ambientWanted = false;

  // ── Weather bed: rain, dust, the roar of a cell ───────────────────────────
  /** Wind whistle/howl for gales and blizzards: a narrow band that wanders. */
  private wxHowlSrc: AudioBufferSourceNode | null = null;
  private wxHowlGain: GainNode | null = null;
  private wxHowlFilter: BiquadFilterNode | null = null;
  /** How much the weather should drown the engine, 0-1 — see setWeather. */
  private wxMask = 0;
  private wxGritTimer = 0;
  /** The gust envelope: where it is, where it is heading, and for how long. */
  private wxGust = 0.5;
  private wxGustTarget = 0.5;
  private wxGustTimer = 0;
  /** Both sides of the wide hiss. */
  private wxHissSrcs: AudioBufferSourceNode[] = [];
  private wxHissFilters: BiquadFilterNode[] = [];
  private wxHissSrc: AudioBufferSourceNode | null = null;
  private wxHissGain: GainNode | null = null;
  private wxHissFilter: BiquadFilterNode | null = null;
  private wxRoarSrc: AudioBufferSourceNode | null = null;
  private wxRoarGain: GainNode | null = null;
  private wxRoarFilter: BiquadFilterNode | null = null;
  private wxThunderTimer = 0;

  // ── Other traffic: a second engine that passes you ────────────────────────
  private trafOsc: OscillatorNode | null = null;
  private trafOsc2: OscillatorNode | null = null;
  private trafGain: GainNode | null = null;
  private trafFilter: BiquadFilterNode | null = null;
  private trafChop: OscillatorNode | null = null;
  private trafChopDepth: GainNode | null = null;
  private trafChopGain: GainNode | null = null;

  // ── Audio variometer ──────────────────────────────────────────────────────
  private varioOn = false;
  private varioNext = 0;

  // ── Radio ─────────────────────────────────────────────────────────────────
  /** Wall-clock of the last transmission, so calls queue instead of pile up. */
  private radioBusyUntil = 0;

  /**
   * Three mix buses instead of everything landing on `master`.
   *
   * With one bus the engine simply drowned the game: gunfire, thunder, radio
   * and the vario were all fighting a continuous drone at the same level and
   * losing. Splitting the mix is what makes ducking possible at all.
   *
   *   engine — our own powerplant, the loudest continuous thing
   *   world  — wind, rumble, weather, other traffic
   *   alert  — radio, warnings, gunfire, thunder, vario: things that MATTER
   */
  private busEngine: GainNode | null = null;
  private busWorld: GainNode | null = null;
  private busAlert: GainNode | null = null;
  /** Cockpit cues, a step above everything continuous. See BUS_CUE. */
  private busCue: GainNode | null = null;
  /** Seconds of ducking left; while > 0 the engine and world sit down. */
  private duckLeft = 0;
  private duckDepth = 0;

  /** Per-aircraft engine voicing — see setEngineProfile(). */
  private engProfile = {
    kind: 'radial' as 'radial' | 'turboprop',
    /** Fundamental multiplier: a big radial turns slower than a turboprop. */
    pitch: 1,
    /** Blade passes per revolution × engine count — sets the chop rate. */
    blades: 2,
    /** How many engines are turning; more = thicker, with a beat between them. */
    count: 1,
  };
  private turbineOsc: OscillatorNode | null = null;
  private turbineGain: GainNode | null = null;
  private turbineFilter: BiquadFilterNode | null = null;
  /** The whine's level at full rpm for this airframe; 0 on a radial. */
  private turbineLevel = 0;
  private beatOsc: OscillatorNode | null = null;
  private beatGain: GainNode | null = null;
  /**
   * Unity-gain stage after the engine's own gain, which the twin-engine beat
   * modulates. The beat used to be summed straight into the engine gain at a
   * fixed ±0.30 — several times the engine's whole level (0.05–0.11), which
   * would have swung it through zero twice a second.
   */
  private beatStage: GainNode | null = null;

  private flightLoopOn = false;

  /** Call from any user gesture; safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      try {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();

        // Compressor keeps stacked one-shots from clipping
        const comp = this.ctx.createDynamicsCompressor();
        // Gentler than before. At -18/6:1 the compressor was flattening the
        // very transients the mix is trying to expose — a gunshot and the
        // engine came out of it at the same level.
        comp.threshold.value = -10;
        comp.knee.value = 18;
        comp.ratio.value = 3.5;
        comp.attack.value = 0.004;
        comp.release.value = 0.22;
        this.comp = comp;

        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;

        // Put back what the compressor took. See MAKEUP.
        this.makeup = this.ctx.createGain();
        this.makeup.gain.value = MAKEUP;

        /*
         * A true brickwall after the makeup, so restoring the level cannot
         * clip. This is a LIMITER, not a second compressor: 20:1 above -1.5 dB
         * with a hard knee and a fast attack. The compressor above shapes the
         * mix; this one only stops it going over the edge.
         */
        const limiter = this.ctx.createDynamicsCompressor();
        limiter.threshold.value = -1.5;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.12;

        /*
         * The true ceiling.
         *
         * A DynamicsCompressorNode cannot brickwall: its 2 ms attack lets the
         * leading edge of a transient straight through, which measured as
         * +0.7 dBFS peaks on a radio call - over full scale, so the DAC
         * clips and you hear it crackle. A WaveShaper is sample-accurate and
         * has no attack time at all, so it physically cannot overshoot.
         *
         * The curve is linear below 0.7 (-3.1 dBFS) and only bends above it,
         * so the engine bed passes through untouched and only the peaks are
         * rounded off - which is what analogue gear does, and is inaudible on
         * a transient.
         */
        const clip = this.ctx.createWaveShaper();
        const KNEE = 0.7;
        const curve = new Float32Array(1025);
        for (let i = 0; i < curve.length; i++) {
          const x = (i / (curve.length - 1)) * 2 - 1;
          const a = Math.abs(x);
          const y = a <= KNEE ? a : KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
          curve[i] = Math.sign(x) * y;
        }
        clip.curve = curve;
        clip.oversample = '4x';

        this.master.connect(comp).connect(this.makeup).connect(limiter)
          .connect(clip).connect(this.ctx.destination);
        // Exposed so a headless probe can measure what actually reaches the
        // speakers rather than an upper bound taken before the compressor.
        this.out = clip;

        // Sub-buses. The engine sits BELOW everything else by default — it is
        // continuous, so it does not need to be loud to be present, and the
        // things you actually have to react to need the headroom.
        this.busEngine = this.ctx.createGain();
        this.busEngine.gain.value = BUS_ENGINE;
        this.busWorld = this.ctx.createGain();
        this.busWorld.gain.value = BUS_WORLD;
        this.busAlert = this.ctx.createGain();
        this.busAlert.gain.value = BUS_ALERT;
        this.busCue = this.ctx.createGain();
        this.busCue.gain.value = BUS_CUE;
        this.busEngine.connect(this.master);
        this.busWorld.connect(this.master);
        this.busAlert.connect(this.master);
        this.busCue.connect(this.master);

        // 2 s of white noise, looped by every noise-based source
        const len = this.ctx.sampleRate * 2;
        this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      } catch {
        this.ctx = null;
      }
      if (this.ctx && this.ambientWanted && !this.flightLoopOn) this.startAmbient();
    }
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyMasterGain();
    return this.muted;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private applyMasterGain(): void {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.04);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private loopNoise(filterType: BiquadFilterType, freq: number, q = 1, bus?: GainNode | null):
    { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null {
    if (!this.ctx || !this.master || !this.noiseBuffer) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(bus ?? this.master);
    src.start();
    return { src, filter, gain };
  }

  /** The last target written to each continuously driven param. See `ramp`. */
  private readonly lastTarget = new WeakMap<AudioParam, number>();

  /**
   * setTargetAtTime, skipped when the target has not really moved.
   *
   * The flight loop rewrote some thirty params every frame — about a thousand
   * automation events a second, most of them the value already there
   * (profiled 2026-10-02). A change of 0.3% is far below anything audible.
   * Every write to these params goes through here, the stops included, so the
   * remembered target is never stale.
   */
  private ramp(p: AudioParam, v: number, t: number, tc: number): void {
    const last = this.lastTarget.get(p);
    if (last !== undefined && Math.abs(v - last) <= Math.max(1e-4, Math.abs(last) * 0.003)) return;
    this.lastTarget.set(p, v);
    p.setTargetAtTime(v, t, tc);
  }

  /**
   * Where a one-shot goes: a bus (the alert bus by default), through a stereo
   * panner when it comes from one side. Everything used to sit dead centre on
   * top of the engine, which is the other half of why small sounds vanished —
   * a sound with a place of its own is heard through a bed it would otherwise
   * be lost in.
   */
  private dest(o: { bus?: AudioNode | null; pan?: number } = {}): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    const bus = o.bus ?? this.busAlert ?? this.master;
    const pan = o.pan ?? 0;
    if (Math.abs(pan) < 0.02 || typeof this.ctx.createStereoPanner !== 'function') return bus;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(bus);
    return p;
  }

  /** Filtered noise burst — thumps, chirps, impacts, gunfire. */
  private noiseBurst(
    durationS: number, freq: number, gain: number,
    type: BiquadFilterType = 'lowpass', q = 1, sweepTo?: number,
    o: { bus?: AudioNode | null; pan?: number; delayS?: number } = {},
  ): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const out = this.dest(o);
    if (!out) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (o.delayS ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    filter.Q.value = q;
    if (sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + durationS);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, durationS * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + durationS);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + durationS + 0.05);
  }

  /** Tone blip, optionally pitch-swept and/or delayed. */
  private blip(
    freq: number, durationS: number, gain: number,
    type: OscillatorType = 'sine', sweepTo?: number, delayS = 0,
    o: { bus?: AudioNode | null; pan?: number } = {},
  ): void {
    if (!this.ctx || !this.master) return;
    const out = this.dest(o);
    if (!out) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delayS;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + durationS);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, durationS * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + durationS);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + durationS + 0.05);
  }

  /** The cue bus, for the cockpit sounds that have to be heard. */
  private get cue(): { bus: AudioNode | null } { return { bus: this.busCue }; }

  // ── Continuous flight loop ────────────────────────────────────────────────

  startFlightLoop(): void {
    if (!this.ctx || !this.master || this.flightLoopOn || !this.noiseBuffer) return;
    this.flightLoopOn = true;
    const ctx = this.ctx;

    // ── Engine: harmonic stack → lowpass → prop-chop tremolo ──────────────
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 300;
    // A resonant peak on a sawtooth is what made it buzz like a synth pad;
    // a real engine heard from the cockpit is a thick, rounded rumble
    this.engineFilter.Q.value = 0.9;

    // The chop gain is driven by an LFO at blade-pass rate. This tremolo is
    // what makes a synth tone read as a PROPELLER rather than a flat drone.
    this.chopGain = ctx.createGain();
    this.chopGain.gain.value = 0.65;
    this.chopLfo = ctx.createOscillator();
    this.chopLfo.type = 'sawtooth';
    this.chopLfo.frequency.value = 40;
    this.chopDepth = ctx.createGain();
    this.chopDepth.gain.value = 0.3;
    this.chopLfo.connect(this.chopDepth).connect(this.chopGain.gain);
    this.chopLfo.start();

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.beatStage = ctx.createGain();
    this.beatStage.gain.value = 1;
    this.engineFilter.connect(this.chopGain).connect(this.engineGain)
      .connect(this.beatStage).connect(this.busEngine ?? this.master);

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 40;
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc.start();

    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.frequency.value = 60;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.32;
    this.engineOsc2.connect(o2g).connect(this.engineFilter);
    this.engineOsc2.start();

    // ── Exhaust: noise that PULSES with the firing, not a steady hiss ──────
    // Fed through the same chop tremolo as the tone, so each blade-pass is a
    // puff of combustion — the "putt" that makes a radial a radial.
    if (this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.chopGain);
      src.start();
      this.exhaustSrc = src; this.exhaustFilter = f; this.exhaustGain = g;
    }

    // ── Wind rush ─────────────────────────────────────────────────────────
    const wind = this.loopNoise('bandpass', 500, 0.6, this.busWorld);
    if (wind) { this.windSrc = wind.src; this.windFilter = wind.filter; this.windGain = wind.gain; }

    // ── Tyre rumble on the runway ─────────────────────────────────────────
    const rum = this.loopNoise('lowpass', 220, 1.4);
    if (rum) { this.rumbleSrc = rum.src; this.rumbleFilter = rum.filter; this.rumbleGain = rum.gain; }

    // ── Stall warning horn (classic warbling reed) ────────────────────────
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.busAlert ?? this.master);
    this.hornOsc = ctx.createOscillator();
    this.hornOsc.type = 'square';
    this.hornOsc.frequency.value = 400;
    this.hornOsc2 = ctx.createOscillator();
    this.hornOsc2.type = 'square';
    this.hornOsc2.frequency.value = 404; // beats against the first = warble
    const hg = ctx.createGain();
    hg.gain.value = 0.5;
    this.hornOsc.connect(hg).connect(this.hornGain);
    this.hornOsc2.connect(hg);
    this.hornOsc.start();
    this.hornOsc2.start();

    /*
     * Voice it for THIS aeroplane. FlightScene sets the profile before it
     * starts the loop, and setEngineProfile only applies it to a loop that is
     * already running — so the per-airframe voice (the turboprop whine, the
     * twin beat, the rounder oscillators) never reached a single flight.
     */
    this.applyEngineProfile();
  }

  /** Per-frame modulation of every continuous layer. */
  updateFlight(s: FlightAudioState): void {
    if (!this.ctx || !this.flightLoopOn) return;
    const t = this.ctx.currentTime;
    this.tickDuck(s.dt);
    const warp = 1 + (s.timeScale - 1) * 0.015; // faint pitch-up under time warp

    const P = this.engProfile;
    if (this.engineOsc && this.engineOsc2 && this.engineGain && this.engineFilter) {
      // A big radial turns slowly and thumps; a turboprop sits higher and
      // smoother. `pitch` carries that straight from the airframe's spec.
      const f = (30 + s.rpm * 88) * warp * P.pitch;
      // Roughness detunes the second oscillator — a sick engine sounds sick
      this.ramp(this.engineOsc.frequency, f, t, 0.07);
      const h = P.kind === 'radial' ? 1.5 : 2.02;
      this.ramp(this.engineOsc2.frequency, f * (h + s.roughness * 0.22), t, 0.07);
      // Quieter, and quieter still inside a storm that ought to drown it
      const mask = 1 - this.wxMask * 0.35;
      this.ramp(this.engineGain.gain, s.rpm > 0.01 ? (0.05 + s.throttle * 0.06) * mask : 0, t, 0.12);
      this.ramp(this.engineFilter.frequency, 200 + s.throttle * 480 + s.rpm * 260, t, 0.1);
    }
    if (this.chopLfo && this.chopDepth) {
      // Blade-pass rate = rpm × blades × engines. A four-engine three-blade
      // heavy chops far faster than a single two-blade duster, and that ratio
      // is most of what tells the two apart by ear.
      const chop = (8 + s.rpm * 24) * P.blades * Math.min(2, P.count) * warp * P.pitch;
      this.ramp(this.chopLfo.frequency, chop, t, 0.07);
      // A turboprop's blades are much less lumpy than a radial's
      const depth = (P.kind === 'radial' ? 0.30 : 0.14) + s.roughness * 0.3;
      this.ramp(this.chopDepth.gain, depth, t, 0.15);
    }
    if (this.turbineOsc && this.turbineFilter && this.turbineGain) {
      // The whine climbs with rpm — the sound of a turboprop spooling
      this.ramp(this.turbineOsc.frequency, (420 + s.rpm * 900) * warp, t, 0.12);
      this.ramp(this.turbineFilter.frequency, 1800 + s.rpm * 2200, t, 0.12);
      // …and it is the ENGINE's sound: silent with the engine stopped, low at
      // idle, full at power, and buried by a storm like the rest of it
      const spool = s.rpm > 0.01 ? 0.3 + 0.7 * Math.min(1, s.rpm) : 0;
      this.ramp(this.turbineGain.gain, this.turbineLevel * spool * (1 - this.wxMask * 0.45), t, 0.15);
    }
    if (this.exhaustGain && this.exhaustFilter) {
      // Relative to the tone (it shares the engine's gain stage now)
      this.ramp(this.exhaustGain.gain, s.rpm * (0.25 + s.throttle * 0.35), t, 0.12);
      this.ramp(this.exhaustFilter.frequency, 420 + s.throttle * 600, t, 0.12);
    }
    if (this.windGain && this.windFilter) {
      // The air going past is the sound of SPEED — with the engine pulled back
      // it is what tells you how fast you are going. Gear and flaps hanging
      // out add buffet.
      const drag = 1 + (s.gearDown ? 0.35 : 0) + (s.flapsDeployed ? 0.4 : 0);
      const gust = 1 + s.turbulence * 0.6 * (0.6 + 0.4 * Math.sin(t * 3.1));
      // Steeper with speed and darker than it was: a soft rush at cruise that
      // you only really notice when you are going fast — it was a constant
      // mid-band wash sitting right where the cockpit cues are
      this.ramp(this.windGain.gain, Math.pow(s.speedFrac, 2.6) * 0.15 * drag * gust, t, 0.14);
      this.ramp(this.windFilter.frequency, 320 + s.speedFrac * 1100, t, 0.14);
    }
    if (this.rumbleGain && this.rumbleFilter) {
      // Tyres on a patched strip: loud, and lumpy rather than a smooth hum
      const rolling = s.onGround ? Math.min(1, s.speedFrac * 3) : 0;
      const bumps = 0.8 + 0.2 * Math.sin(t * 19) * Math.sin(t * 7.3);
      this.ramp(this.rumbleGain.gain, rolling * 0.30 * bumps, t, 0.05);
      this.ramp(this.rumbleFilter.frequency, 140 + rolling * 320, t, 0.1);
    }
  }

  /** Continuous stall warning horn. */
  setStallWarning(on: boolean): void {
    if (!this.ctx || !this.hornGain || on === this.hornOn) return;
    this.hornOn = on;
    this.ramp(this.hornGain.gain, on ? 0.05 : 0, this.ctx.currentTime, 0.05);
  }

  stopFlightLoop(): void {
    if (!this.ctx || !this.flightLoopOn) return;
    this.flightLoopOn = false;
    this.hornOn = false;
    const t = this.ctx.currentTime;
    for (const g of [this.engineGain, this.exhaustGain, this.windGain, this.rumbleGain, this.hornGain, this.turbineGain]) {
      if (g) this.ramp(g.gain, 0, t, 0.08);
    }
    /*
     * The turbine and the twin beat go with the rest. They were built once and
     * never stopped, so a turboprop's whine carried on over the chart after
     * landing, and every later flight's beat stayed wired to the FIRST
     * flight's (long disconnected) engine gain.
     */
    const nodes = [
      this.engineOsc, this.engineOsc2, this.chopLfo, this.hornOsc, this.hornOsc2,
      this.exhaustSrc, this.windSrc, this.rumbleSrc, this.turbineOsc, this.beatOsc,
    ];
    setTimeout(() => {
      for (const n of nodes) { try { n?.stop(); n?.disconnect(); } catch { /* already stopped */ } }
    }, 500);
    this.engineOsc = this.engineOsc2 = this.chopLfo = this.hornOsc = this.hornOsc2 = null;
    this.exhaustSrc = this.windSrc = this.rumbleSrc = null;
    this.turbineOsc = this.beatOsc = null;
    this.turbineGain = this.beatGain = null;
    this.turbineFilter = null;
    this.beatStage = null;
  }

  // ── Ambient bed (menu / map) ──────────────────────────────────────────────

  /**
   * Wind over the wasteland, for the menu and the chart.
   *
   * It was one band of low noise at a fixed level — a hum, not weather. Two
   * slow, unrelated LFOs now move its level and its colour, so it comes in
   * long gusts that swell and brighten and die back, never quite repeating.
   */
  startAmbient(): void {
    this.ambientWanted = true;
    if (!this.ctx || !this.master || this.ambientSrc || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.7;
    // The gusts move a unity stage; the fade below it takes everything down
    // together, LFOs included
    const gust = ctx.createGain();
    gust.gain.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gust).connect(gain).connect(this.master);
    src.start(0, Math.random() * 1.5);
    gain.gain.setTargetAtTime(0.035, ctx.currentTime, 1.5);
    this.ambientSrc = src;
    this.ambientGain = gain;
    const lfo = (hz: number, depth: number, param: AudioParam): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const d = ctx.createGain();
      d.gain.value = depth;
      o.connect(d).connect(param);
      o.start();
      return o;
    };
    this.ambientLfos = [
      // Level: ±40% over about eleven seconds, with a faster flutter on top
      lfo(0.09, 0.38, gust.gain),
      lfo(0.23, 0.12, gust.gain),
      // Colour: the gusts brighten as they build
      lfo(0.07, 110, filter.frequency),
    ];
  }

  stopAmbient(): void {
    this.ambientWanted = false;
    if (!this.ctx || !this.ambientSrc) return;
    this.ambientGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    const nodes: AudioScheduledSourceNode[] = [this.ambientSrc, ...this.ambientLfos];
    this.ambientSrc = null;
    this.ambientLfos = [];
    setTimeout(() => {
      for (const n of nodes) { try { n.stop(); n.disconnect(); } catch { /* gone */ } }
    }, 800);
  }

  // ── One-shots ─────────────────────────────────────────────────────────────

  /** Starter grind, catch, then settle. */
  /**
   * The starter motor turning over, before anything catches.
   *
   * A big radial does not simply switch on: the starter whines up, the
   * prop drags round, a cylinder or two fires and misses, and only then does
   * it settle. Played as a loop the scene can stop the moment it catches, so
   * the sound and the two and a half seconds of cranking are the same event
   * rather than a sample laid over a timer.
   */
  engineCrank(seconds: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const bus = this.busEngine ?? this.master;

    // Starter motor: a whine that climbs as it takes up the load
    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.setValueAtTime(210, t0);
    whine.frequency.linearRampToValueAtTime(430, t0 + seconds * 0.8);
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass'; wf.frequency.value = 900; wf.Q.value = 3.5;
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t0);
    wg.gain.exponentialRampToValueAtTime(0.09, t0 + 0.12);
    wg.gain.setValueAtTime(0.09, t0 + seconds - 0.15);
    wg.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    whine.connect(wf).connect(wg).connect(bus);
    whine.start(t0); whine.stop(t0 + seconds + 0.05);

    /*
     * Compression pulses — the prop being dragged over. They speed up through
     * the crank, which is the single cue that says "it is about to catch"
     * rather than "this is a loop that will play for ever".
     */
    let t = t0 + 0.18;
    let gap = 0.30;
    while (t < t0 + seconds - 0.1) {
      this.burstInto(bus, t, 0.09, 90 + Math.random() * 40, 0.16, 'lowpass', 1.4);
      t += gap;
      gap = Math.max(0.11, gap * 0.86);
    }
  }

  /** It catches: one big cough and the engine picks up. */
  engineStart(): void {
    this.noiseBurst(0.55, 260, 0.14, 'bandpass', 2);
    this.blip(48, 0.5, 0.10, 'sawtooth', 96);
    this.blip(120, 0.18, 0.05, 'square', 70, 0.28);
  }

  engineStop(): void {
    this.blip(90, 0.9, 0.09, 'sawtooth', 24);
    this.noiseBurst(0.5, 200, 0.06);
  }

  /** Engine coughs — reliability sputters and failures. */
  engineSputter(): void {
    for (let i = 0; i < 3; i++) {
      this.noiseBurst(0.09, 300 - i * 60, 0.16, 'bandpass', 3);
      this.blip(70 - i * 8, 0.1, 0.09, 'square', undefined, i * 0.11);
    }
  }

  /**
   * Wheels meeting the runway.
   *
   * It was one short chirp and a soft thump — a landing, the moment every
   * flight builds to, went by almost unheard. A real one is layered: the two
   * mains screech a beat apart as the tyres spin up, the oleos slam, the
   * airframe rattles, and a firm one squeals.
   */
  touchdown(vSpeed: number): void {
    const k = Math.min(1, Math.abs(vSpeed) / 6);
    this.duck(0.5, 0.35);
    // Tyre screech, left main then right main — a beat apart and a side apart
    this.noiseBurst(0.2 + k * 0.12, 3100, 0.30 + k * 0.30, 'bandpass', 6, 1500, { pan: -0.3 });
    this.noiseBurst(0.16 + k * 0.1, 2800, 0.24 + k * 0.28, 'bandpass', 6, 1400, { pan: 0.3, delayS: 0.07 });
    // A firm arrival squeals
    if (k > 0.25) this.blip(1320, 0.16, 0.05 * k, 'triangle', 980);
    // Oleo slam and the airframe taking the load
    this.noiseBurst(0.34 + k * 0.28, 180 + k * 140, 0.42 + k * 0.5);
    this.blip(72, 0.3, 0.28 + k * 0.32, 'triangle', 40);
    // Gear and fittings rattle
    this.noiseBurst(0.1, 1100, 0.10 + k * 0.14, 'bandpass', 3, undefined, { delayS: 0.04 });
  }

  crash(): void {
    this.noiseBurst(1.3, 150, 0.95, 'lowpass', 1, 50);
    this.blip(44, 0.85, 0.5, 'triangle', 20);
    // Metal debris scattering after the impact, all round
    for (let i = 0; i < 7; i++) {
      this.noiseBurst(0.13, 1800 + Math.random() * 2200, 0.1, 'bandpass', 6, undefined,
        { pan: (Math.random() - 0.5) * 1.6, delayS: 0.12 + i * 0.09 + Math.random() * 0.08 });
    }
  }

  /**
   * The fuel going up: a deep whump you feel more than hear, the rush of the
   * fireball, and a crackle running on behind it.
   * @param size 0.5 … 1.5, how much went up
   */
  fireball(size = 1): void {
    const s = Math.min(1.5, Math.max(0.4, size));
    this.duck(1.4, 0.55);
    this.noiseBurst(1.6 + s * 0.6, 120, 0.7 * s, 'lowpass', 1.2, 40);
    this.blip(52, 0.9, 0.42 * s, 'sine', 26);
    this.noiseBurst(0.9, 900, 0.22 * s, 'bandpass', 0.8, 160, { delayS: 0.04 });
    for (let i = 0; i < 10; i++) {
      this.noiseBurst(0.03 + Math.random() * 0.05, 1800 + Math.random() * 3000, 0.05 * s, 'bandpass', 5, undefined,
        { pan: (Math.random() - 0.5) * 1.4, delayS: 0.25 + Math.random() * 1.6 });
    }
  }

  /** Metal grinding along the ground, for as long as the wreck slides. */
  scrape(seconds: number, strength = 1): void {
    if (seconds <= 0.05) return;
    const n = Math.max(3, Math.round(seconds / 0.09));
    for (let i = 0; i < n; i++) {
      const f = 1 - i / n;
      this.noiseBurst(0.08 + Math.random() * 0.08, 700 + Math.random() * 1200, (0.05 + Math.random() * 0.06) * strength * f,
        'bandpass', 3.5, undefined, { delayS: (i / n) * seconds });
    }
  }

  /**
   * A wreck burning: a low roar under it and a crackle that thins as the fire
   * settles. Scheduled out to its end, so nothing has to stop it.
   */
  fireCrackle(seconds: number): void {
    if (!this.ctx || !this.noiseBuffer || !this.busWorld) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.4);
    g.gain.setValueAtTime(0.09, t0 + seconds * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    src.connect(f).connect(g).connect(this.busWorld);
    src.start(t0, Math.random());
    src.stop(t0 + seconds + 0.1);
    const pops = Math.round(seconds * 7);
    for (let i = 0; i < pops; i++) {
      this.noiseBurst(0.015 + Math.random() * 0.03, 2000 + Math.random() * 3500, 0.03 + Math.random() * 0.04, 'bandpass', 6,
        undefined, { bus: this.busWorld, pan: (Math.random() - 0.5) * 0.9, delayS: Math.random() * seconds * 0.9 });
    }
  }

  /**
   * Going into the water: a slap and a heavy crash of spray, the water coming
   * back down, and then the sound of it going under.
   * @param size 0.5 … 1.5
   */
  splash(size = 1): void {
    const s = Math.min(1.5, Math.max(0.4, size));
    this.duck(1.6, 0.6);
    // The slap
    this.noiseBurst(0.12, 1400, 0.4 * s, 'bandpass', 0.9, 500);
    this.blip(70, 0.35, 0.35 * s, 'sine', 34);
    // The column of spray going up and roaring
    this.noiseBurst(1.3, 2600, 0.24 * s, 'bandpass', 0.6, 700, { delayS: 0.03 });
    this.noiseBurst(1.1, 300, 0.3 * s, 'lowpass', 0.8, 90, { delayS: 0.02 });
    // …and falling back as rain on the water
    for (let i = 0; i < 26; i++) {
      this.noiseBurst(0.02 + Math.random() * 0.03, 3000 + Math.random() * 3500, 0.025 * s, 'bandpass', 4, undefined,
        { pan: (Math.random() - 0.5) * 1.6, delayS: 0.5 + Math.random() * 1.6 });
    }
    // Going under: air coming out of the hulk
    for (let i = 0; i < 9; i++) {
      const at = 1.6 + i * 0.28 + Math.random() * 0.2;
      this.blip(160 + Math.random() * 220, 0.09, 0.05, 'sine', 420 + Math.random() * 300, at,
        { pan: (Math.random() - 0.5) * 0.6 });
    }
  }

  /**
   * Gear cycling: the motor whine, then the locks going home. On the cue bus
   * with a little bite added above the engine (a hydraulic hiss), so it is
   * heard in the cockpit rather than inferred from the HUD. The clunk is
   * scheduled on the audio clock, not a timer, so it lands exactly as the
   * legs lock and cannot fire into the next scene.
   */
  gearMove(down = true): void {
    const c = this.cue;
    this.noiseBurst(1.0, down ? 380 : 300, 0.07, 'bandpass', 3, down ? 620 : 240, c);
    this.noiseBurst(0.9, 2600, 0.025, 'bandpass', 1.5, 1800, c);
    this.blip(down ? 200 : 260, 0.9, 0.045, 'sawtooth', down ? 320 : 170, 0, c);
    this.noiseBurst(0.16, 260, 0.22, 'lowpass', 1, undefined, { ...c, delayS: 1.05 });
    this.noiseBurst(0.07, 1500, 0.08, 'bandpass', 3, undefined, { ...c, delayS: 1.05 });
    this.blip(88, 0.14, 0.13, 'square', undefined, 1.05, c);
  }

  flapMove(): void {
    const c = this.cue;
    this.noiseBurst(0.6, 340, 0.06, 'bandpass', 3, 460, c);
    this.blip(230, 0.55, 0.035, 'sawtooth', 300, 0, c);
  }

  /** Coolant venting: a valve thunk and a long hiss of steam off the cowl. */
  steamVent(): void {
    this.blip(140, 0.08, 0.08, 'square');
    this.noiseBurst(1.2, 4200, 0.16, 'highpass', 0.7, 2400);
  }

  /**
   * Airframe buffet as the wing lets go. A thump alone sat at 110 Hz, right
   * under the engine, and measured below the bed it was meant to cut through;
   * the rattle of the airframe on top of it is what you actually hear.
   */
  stallBuffet(): void {
    const c = this.cue;
    this.noiseBurst(0.16, 140, 0.24, 'lowpass', 1, undefined, c);
    this.noiseBurst(0.12, 820, 0.1, 'bandpass', 2.2, 520, c);
  }

  /**
   * Master caution — a soft falling pair.
   *
   * These were square waves at 760/560 Hz and 980 Hz: the harshest timbre in
   * the synth at the pitch the ear is most sensitive to, fired every few
   * seconds for as long as a condition held. Rounded tones still read as
   * "look" without grating on the twentieth repeat — now a fifth above the
   * engine's band rather than inside it, where they were masked.
   */
  warn(): void {
    const c = this.cue;
    this.blip(880, 0.16, 0.07, 'triangle', undefined, 0, c);
    this.blip(660, 0.2, 0.065, 'triangle', undefined, 0.17, c);
  }

  /** Imminent danger (obstacle, traffic, overspeed): two quick rising notes. */
  alarm(): void {
    const c = this.cue;
    this.blip(780, 0.09, 0.08, 'triangle', 1050, 0, c);
    this.blip(780, 0.09, 0.08, 'triangle', 1050, 0.14, c);
  }

  /** Rounds coming up from the ground. */
  gunfire(): void {
    for (let i = 0; i < 3; i++) {
      this.noiseBurst(0.07, 1500 + Math.random() * 900, 0.09, 'bandpass', 5, 400);
    }
  }

  /** A round finding the airframe. */
  bulletHit(): void {
    this.noiseBurst(0.1, 2200, 0.2, 'bandpass', 5, 600);
    this.blip(180, 0.12, 0.12, 'square', 90);
  }

  /** Distant rolling thunder. */
  thunder(): void {
    // From one side, rolling across to the other
    const side = Math.random() < 0.5 ? -0.5 : 0.5;
    this.noiseBurst(1.8, 260, 0.32, 'lowpass', 1, 60, { pan: side });
    this.noiseBurst(1.1, 180, 0.2, 'lowpass', 1, 45, { pan: -side * 0.6, delayS: 0.26 });
  }

  /** Impact with a structure. */
  impact(): void {
    this.noiseBurst(0.5, 320, 0.6, 'lowpass', 1, 90);
    this.blip(70, 0.35, 0.3, 'triangle', 34);
  }

  /** A crisp tick: a short tone above the engine's band, with a transient. */
  click(): void {
    const c = this.cue;
    this.blip(1240, 0.045, 0.05, 'sine', undefined, 0, c);
    this.noiseBurst(0.018, 2800, 0.045, 'bandpass', 2, undefined, c);
  }

  /**
   * The drop run-in: a short tick each second out, and a higher double tone
   * the moment the crate would land on them. Timing a release by eye alone
   * is a one-frame job at cruise speed; timing it by ear is a skill — which
   * it was not, while the ticks sat an octave down inside the engine's band.
   */
  dropTick(final = false): void {
    const c = this.cue;
    if (final) {
      this.blip(1480, 0.1, 0.045, 'sine', undefined, 0, c);
      this.blip(1976, 0.16, 0.045, 'sine', undefined, 0.1, c);
    } else {
      this.blip(1320, 0.05, 0.055, 'sine', undefined, 0, c);
    }
  }

  /** A reward: soft, bright, and only for things that earned one. */
  chime(): void {
    const c = this.cue;
    this.blip(1047, 0.14, 0.035, 'sine', undefined, 0, c);
    this.blip(1568, 0.22, 0.03, 'sine', undefined, 0.12, c);
  }

  /** Contract paid / success flourish. */
  success(): void {
    const c = this.cue;
    this.blip(523, 0.14, 0.045, 'triangle', undefined, 0, c);
    this.blip(659, 0.14, 0.045, 'triangle', undefined, 0.12, c);
    this.blip(784, 0.3, 0.045, 'triangle', undefined, 0.24, c);
  }

  /** Failure sting. */
  failure(): void {
    const c = this.cue;
    this.blip(300, 0.3, 0.06, 'sawtooth', 160, 0, c);
    this.blip(200, 0.5, 0.055, 'sawtooth', 90, 0.18, c);
  }

  // ══ RADIO ═══════════════════════════════════════════════════════════════
  //
  // The game already prints radio calls — traffic announcing a break, storm
  // warnings, the tower. With nothing behind them they read as UI toasts. A
  // recorded voice is out of the question (this whole engine is procedural,
  // zero assets), so the voice is SYNTHESISED: a pulse carrier through three
  // sweeping bandpass formants, band-limited to the 300–3000 Hz a radio
  // actually passes, with squelch at both ends and static underneath.
  //
  // It is not intelligible speech and is not meant to be — the caption carries
  // the words. What it carries is CADENCE and URGENCY, which is what makes a
  // call feel like a person rather than a notification.

  /**
   * One transmission.
   *
   * `text` only sets the rhythm: its length decides how many syllables get
   * spoken, so a short call is clipped and a long one runs on, matching the
   * caption on screen.
   */
  /**
   * A radio call.
   *
   * This used to try to synthesise a human voice — a glottal source through
   * formant resonators. It never got past sounding like a distorted buzz, and
   * a bad fake voice is worse than no voice: it reads as a broken speaker
   * rather than as a person, and it grates on every repeat.
   *
   * So it does not pretend any more. The caption on screen carries the words;
   * the radio carries WHO is calling and WHAT KIND of call it is — and those
   * are four genuinely different sounds, not one sound at four pitches:
   *
   *   control   a formal station. SELCAL, aviation's real selective-calling
   *             chime: two two-tone chords from a fixed sixteen-tone alphabet.
   *   warning   the same station with its hair on fire — upper register, an
   *             attention pip in front, and the code sent twice.
   *   traffic   another pilot's handheld. Deliberately NOT SELCAL, because a
   *             pilot does not selective-call you: a keyed mic, a rough
   *             carrier and a couple of clicks. No musical tone at all, which
   *             is what makes it unmistakable against the other three.
   *   mayday    an emergency locator. A descending siren warble under heavy
   *             static. You will know it the first time you hear it.
   *
   * Because the SELCAL code is seeded from the station name, each caller keeps
   * one permanent signature you come to recognise before reading the caption.
   *
   * @param text        the words, shown on screen; seeds the code if no
   *                    station is given
   * @param opts.kind   which of the four constructions to use
   * @param opts.station the calling station, so its code stays constant
   */
  radio(text: string, opts: { kind?: RadioKind; station?: string } = {}): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    // Never let two transmissions talk over each other — a radio is one channel
    const start = Math.max(ctx.currentTime, this.radioBusyUntil) + 0.02;
    const kind: RadioKind = opts.kind ?? 'control';

    const bus = ctx.createGain();
    // Measured -7.6 dBFS RMS — louder than anything else in the mix, and it
    // fires often. Still clear over the engine at this level.
    bus.gain.value = 0.28;
    /*
     * Radio band-limiting: this pair is most of why it sounds like a speaker
     * rather than like a synthesiser patched into the mix. The band itself is
     * part of the characterisation — a handheld is narrower and more nasal
     * than a panel set, and an emergency beacon is wider than either.
     */
    const band: Record<RadioKind, [number, number]> = {
      control: [300, 3000],
      warning: [300, 3000],
      traffic: [450, 2400],
      mayday:  [250, 3400],
    };
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = band[kind][0];
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = band[kind][1];
    bus.connect(hp).connect(lp).connect(this.busAlert ?? this.master);

    // ── Squelch open ──────────────────────────────────────────────────────
    this.burstInto(bus, start, 0.035, 2400, 0.22, 'bandpass', 3);

    let total: number;
    let hiss: number;
    switch (kind) {
      case 'traffic':
        total = this.radioHandheld(bus, start);
        hiss = 0.055;   // a cheap set is a noisy set
        break;
      case 'mayday':
        total = this.radioBeacon(bus, start);
        hiss = 0.075;
        break;
      default:
        total = this.radioSelcal(bus, start, kind === 'warning', opts.station ?? text);
        hiss = 0.024;
        break;
    }

    // ── Static bed under the whole transmission ───────────────────────────
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 1500; nf.Q.value = 0.6;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, start);
    ng.gain.linearRampToValueAtTime(hiss, start + 0.03);
    ng.gain.setValueAtTime(hiss, start + total - 0.05);
    ng.gain.linearRampToValueAtTime(0.0001, start + total);
    noise.connect(nf).connect(ng).connect(bus);
    noise.start(start);
    noise.stop(start + total + 0.1);

    // ── Squelch close ─────────────────────────────────────────────────────
    this.burstInto(bus, start + total, 0.05, 1200, 0.13, 'bandpass', 2);
    this.radioBusyUntil = start + total + 0.12;
    // Step the bed back for the transmission plus a beat, so the call is not
    // competing with the engine it is being heard over. Shallower than the
    // voice version needed: a tone cuts through where a mumble did not.
    // A mayday clears the most room, because nothing matters more.
    this.duck((start - ctx.currentTime) + total + 0.20, kind === 'mayday' ? 0.9 : 0.75);
  }

  /**
   * SELCAL: a formal station calling you.
   *
   * The tone alphabet is the real one, in real hertz. Deliberately not an
   * equal-tempered scale — the intervals are slightly "wrong" to a musical
   * ear, which is precisely what makes the chime read as equipment rather
   * than as music.
   *
   * @returns the length of the transmission in seconds
   */
  private radioSelcal(bus: AudioNode, start: number, urgent: boolean, seedText: string): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const TONES = [
      312.6, 346.7, 384.6, 426.6, 473.2, 524.8, 582.1, 645.7,
      716.1, 794.3, 881.0, 977.2, 1083.9, 1202.3, 1333.5, 1479.1,
    ];

    // A station's code is a stable hash of its name, so the same caller always
    // sounds the same and you learn the difference without being told.
    let h = 2166136261;
    for (let i = 0; i < seedText.length; i++) {
      h ^= seedText.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // A warning sits in the top of the alphabet where the ear is most
    // sensitive; a routine call sits low and stays out of the way.
    const floor = urgent ? 6 : 0;
    const span = TONES.length - floor;
    const code: number[] = [];
    for (let i = 0; i < 4; i++) {
      let idx = floor + ((h >>> (i * 5)) % span);
      // Distinct tones only — a repeat collapses the chord to a single note
      while (code.includes(idx)) idx = floor + ((idx + 5 - floor) % span);
      code.push(idx);
    }

    let t = start + 0.05;
    // An attention pip in front of a warning. Two fast high blips: the ear
    // reads a doubled transient as "listen" before it has parsed anything.
    if (urgent) {
      for (let i = 0; i < 2; i++) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = 1720;
        const g = ctx.createGain();
        const t0 = t + i * 0.09;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);
        o.connect(g).connect(bus);
        o.start(t0); o.stop(t0 + 0.07);
      }
      t += 0.24;
    }

    // Timing is FIXED and short. An earlier version scaled with the word count
    // and could drone for three seconds on a long sentence.
    const chord = urgent ? 0.30 : 0.40;
    const gap = 0.10;
    const reps = urgent ? 2 : 1;   // a warning sends its code twice
    const cycle = chord * 2 + gap;

    for (let r = 0; r < reps; r++) {
      const base = t + r * (cycle + 0.22);
      for (let pair = 0; pair < 2; pair++) {
        const t0 = base + pair * (chord + gap);
        for (let v = 0; v < 2; v++) {
          const o = ctx.createOscillator();
          // Sine, not sawtooth. The harshness in the old voice came from
          // running rich waveforms through resonant filters; a transmitter
          // sends clean tones and the receiver is what colours them.
          o.type = 'sine';
          o.frequency.value = TONES[code[pair * 2 + v]];
          const g = ctx.createGain();
          const peak = v === 0 ? 0.30 : 0.22;
          // Soft edges: a hard gate on a sine is an audible click
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(peak, t0 + 0.022);
          g.gain.setValueAtTime(peak, t0 + chord - 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + chord);
          o.connect(g).connect(bus);
          o.start(t0); o.stop(t0 + chord + 0.02);
        }
      }
    }
    return (t - start) + cycle * reps + 0.22 * (reps - 1) + 0.08;
  }

  /**
   * Another pilot on a handheld.
   *
   * No tones at all, and that is the whole design: against three tonal calls,
   * the one with no pitch in it is instantly identifiable. What you hear is
   * somebody keying a mic — the click, the carrier coming up, the set's own
   * hum, a fumble halfway through, and the release.
   *
   * @returns the length of the transmission in seconds
   */
  private radioHandheld(bus: AudioNode, start: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const dur = 0.62 + Math.random() * 0.28;

    // The set's own hum under the carrier. Very low, but it is the difference
    // between "a radio" and "a hiss".
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 88;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, start);
    hg.gain.exponentialRampToValueAtTime(0.055, start + 0.04);
    hg.gain.setValueAtTime(0.055, start + dur - 0.06);
    hg.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    hum.connect(hg).connect(bus);
    hum.start(start); hum.stop(start + dur + 0.02);

    // Carrier: narrow band noise that breathes, so it is not a flat wash
    const car = ctx.createBufferSource();
    car.buffer = this.noiseBuffer;
    car.loop = true;
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass'; cf.frequency.value = 1100; cf.Q.value = 1.6;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, start);
    cg.gain.linearRampToValueAtTime(0.10, start + 0.05);
    // A few level steps across the call: somebody moving while they talk
    for (let i = 1; i < 5; i++) {
      cg.gain.linearRampToValueAtTime(
        0.05 + Math.random() * 0.08, start + dur * (i / 5),
      );
    }
    cg.gain.linearRampToValueAtTime(0.0001, start + dur);
    car.connect(cf).connect(cg).connect(bus);
    car.start(start, Math.random());
    car.stop(start + dur + 0.05);

    // Mic clicks — the fumble that makes it a person and not a transmitter
    this.burstInto(bus, start + dur * 0.42, 0.012, 2600, 0.10, 'bandpass', 4);
    if (Math.random() < 0.6) {
      this.burstInto(bus, start + dur * 0.71, 0.010, 3100, 0.08, 'bandpass', 4);
    }
    return dur + 0.06;
  }

  /**
   * An emergency locator beacon — somebody is going down.
   *
   * The descending warble is the real ELT sound and it exists precisely
   * because it is impossible to mistake for anything else on a busy
   * frequency. Sweeping DOWN matters: a rising tone reads as a machine
   * spooling up, a falling one reads as something failing.
   *
   * @returns the length of the transmission in seconds
   */
  private radioBeacon(bus: AudioNode, start: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const sweeps = 3;
    const each = 0.42;

    for (let i = 0; i < sweeps; i++) {
      const t0 = start + 0.04 + i * each;
      const o = ctx.createOscillator();
      // Sawtooth: a beacon is a cheap oscillator screaming, not a flute
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(1650, t0);
      o.frequency.exponentialRampToValueAtTime(320, t0 + each * 0.86);
      // Band-pass follows the sweep down so the harmonics do not turn to grit
      const bp = ctx.createBiquadFilter();
      bp.type = 'lowpass';
      bp.frequency.setValueAtTime(3200, t0);
      bp.frequency.exponentialRampToValueAtTime(900, t0 + each * 0.86);
      bp.Q.value = 1.1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.setValueAtTime(0.22, t0 + each * 0.72);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + each * 0.9);
      o.connect(bp).connect(g).connect(bus);
      o.start(t0); o.stop(t0 + each);
    }
    return sweeps * each + 0.1;
  }

  /** Noise burst routed into a specific bus at an absolute time. */
  private burstInto(
    bus: AudioNode, at: number, durationS: number, freq: number, gain: number,
    type: BiquadFilterType = 'lowpass', q = 1,
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + durationS);
    src.connect(f).connect(g).connect(bus);
    src.start(at, Math.random());
    src.stop(at + durationS + 0.05);
  }

  // ══ WEATHER BED ═════════════════════════════════════════════════════════
  //
  // Weather was silent. A dust storm you can see rolling across the deck and a
  // thunderstorm standing on the horizon both sounded exactly like clear air,
  // which undoes most of the work the weather cells do — you had to read the
  // HUD to know you were in one.
  //
  // Two layers: a HISS (rain on the skin, sand on the windscreen) and a ROAR
  // (the low body of a cell). Every condition is a different balance of the
  // two, and both scale with how deep into the cell you are.

  private ensureWeatherBed(): void {
    if (!this.ctx || !this.master || this.wxHissSrc || !this.noiseBuffer || !this.busWorld) return;
    const ctx = this.ctx;
    /*
     * The hiss is WIDE: two loops of the noise, from different points in it,
     * panned apart. Rain and grit are all round the cockpit; laid dead centre
     * it was a sheet of noise sitting exactly where the engine and every cue
     * were trying to be heard.
     */
    this.wxHissGain = ctx.createGain();
    this.wxHissGain.gain.value = 0;
    this.wxHissGain.connect(this.busWorld);
    this.wxHissFilters = [];
    this.wxHissSrcs = [];
    for (const side of [-1, 1]) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1400; hp.Q.value = 0.7;
      // Nothing fizzing above 6 kHz: that top end was what made it grate
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 6000; lp.Q.value = 0.5;
      let tail: AudioNode = lp;
      if (typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = side * 0.75;
        lp.connect(p);
        tail = p;
      }
      src.connect(hp).connect(lp);
      tail.connect(this.wxHissGain);
      src.start(0, side < 0 ? 0 : 1.0);
      this.wxHissFilters.push(hp);
      this.wxHissSrcs.push(src);
    }
    this.wxHissSrc = this.wxHissSrcs[0];
    this.wxHissFilter = this.wxHissFilters[0];
    const roar = this.loopNoise('lowpass', 300, 0.9, this.busWorld);
    const howl = this.loopNoise('bandpass', 600, 7, this.busWorld);
    if (!roar) return;
    if (howl) { this.wxHowlSrc = howl.src; this.wxHowlGain = howl.gain; this.wxHowlFilter = howl.filter; }
    this.wxRoarSrc = roar.src; this.wxRoarGain = roar.gain; this.wxRoarFilter = roar.filter;
  }

  /**
   * Per-frame weather sound.
   *
   * `intensity` is the cell's local strength at the aircraft — so the sound
   * builds as you fly into a cell and falls away as you leave it, which is the
   * whole point of weather being a place rather than a global condition.
   *
   * Measured, it had become the loudest thing in the game: inside a storm the
   * hiss stood up to 8 dB OVER the engine, cells cover a third of a leg, and
   * every cockpit cue was buried under it — the weather read as a constant
   * background roar rather than as weather. So it is a good deal milder (about
   * 11 dB), it is quiet at a cell's edge and only full in the core, wind comes
   * and goes in gusts with lulls between them, and cloud and fog — which make
   * no sound — are silent.
   */
  setWeather(condition: string, intensity: number, dt: number): void {
    if (!this.ctx) return;
    this.ensureWeatherBed();
    if (!this.wxHissGain || !this.wxRoarGain || !this.wxHissFilter || !this.wxRoarFilter) return;
    const t = this.ctx.currentTime;
    const i = Math.min(1, Math.max(0, intensity));
    // The edge of a cell is nearly quiet; the core is where it roars
    const k = Math.pow(i, 1.8);

    // hiss gain, hiss cutoff, roar gain, roar cutoff, howl gain
    const V: Record<string, [number, number, number, number, number]> = {
      clear:        [0.000, 1400, 0.000, 300, 0.000],
      cloudy:       [0.000, 1100, 0.012, 200, 0.000],
      strong_winds: [0.040, 1000, 0.080, 240, 0.065],
      dust_storm:   [0.056, 1500, 0.080, 220, 0.026],
      thunderstorm: [0.068, 1800, 0.058, 170, 0.000],
      blizzard:     [0.052, 1600, 0.064, 190, 0.072],
      fog:          [0.000,  900, 0.000, 160, 0.000],
    };
    const row = V[condition] ?? V.clear;

    /*
     * Gusts, not a drone. Wind is a sequence of events: it builds, blows, and
     * drops away to a lull, at irregular intervals. A sum of three sines kept
     * it between 70 and 100% for ever, which is exactly what "constant
     * background noise" is. Gusts build quickly and die slowly.
     */
    const gusty = condition === 'dust_storm' || condition === 'strong_winds' || condition === 'blizzard';
    this.wxGustTimer -= dt;
    if (this.wxGustTimer <= 0) {
      const r = Math.random();
      this.wxGustTarget = r < 0.35 ? 0.1 + Math.random() * 0.15
        : r < 0.8 ? 0.45 + Math.random() * 0.3 : 0.85 + Math.random() * 0.15;
      this.wxGustTimer = 1.2 + Math.random() * 3.6;
    }
    this.wxGust += (this.wxGustTarget - this.wxGust) * Math.min(1, dt * (this.wxGustTarget > this.wxGust ? 1.8 : 0.55));
    // Rain comes in heavier and lighter bands rather than as one even sheet
    const gust = gusty ? this.wxGust : condition === 'thunderstorm' ? 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.23)) : 1;

    const side = this.wxHissSrcs.length > 1 ? Math.SQRT1_2 : 1;   // two decorrelated sides
    this.ramp(this.wxHissGain.gain, row[0] * k * gust * side, t, 0.6);
    for (const f of this.wxHissFilters) this.ramp(f.frequency, row[1] * (0.9 + gust * 0.15), t, 0.8);
    this.ramp(this.wxRoarGain.gain, row[2] * k * gust, t, 0.8);
    this.ramp(this.wxRoarFilter.frequency, row[3], t, 0.8);
    if (this.wxHowlGain && this.wxHowlFilter) {
      // A narrow band that wanders up and down: the wind moaning in the rigging
      this.ramp(this.wxHowlGain.gain, row[4] * k * gust, t, 0.5);
      this.ramp(this.wxHowlFilter.frequency, 420 + 380 * (0.5 + 0.5 * Math.sin(t * 0.6)) * gust, t, 0.5);
    }
    // The storm takes the edge off the engine — a little, not a drowning
    const drowns = condition === 'dust_storm' || condition === 'thunderstorm' || condition === 'blizzard' ? 0.55 : 0.15;
    this.wxMask += (k * drowns - this.wxMask) * Math.min(1, dt * 1.5);

    // Grit rattling on the windscreen in a sandstorm: sparse, from either
    // side, and only when a gust carries it
    if (condition === 'dust_storm' && k > 0.15 && this.wxGust > 0.4) {
      this.wxGritTimer -= dt;
      if (this.wxGritTimer <= 0) {
        this.wxGritTimer = 0.12 + Math.random() * 0.4 / Math.max(0.2, k * this.wxGust);
        this.noiseBurst(0.025 + Math.random() * 0.035, 3200 + Math.random() * 2400, 0.012 + k * 0.02, 'bandpass', 4,
          undefined, { bus: this.busWorld, pan: (Math.random() - 0.5) * 1.6 });
      }
    }

    // Thunder rolls on its own inside a live cell, more often the deeper in
    if (condition === 'thunderstorm' && i > 0.25) {
      this.wxThunderTimer -= dt;
      if (this.wxThunderTimer <= 0) {
        this.wxThunderTimer = 7 + Math.random() * 14 * (1.3 - i);
        this.thunderAt(0.35 + i * 0.65);
      }
    } else {
      this.wxThunderTimer = 3;
    }
  }

  /**
   * Thunder at a distance.
   *
   * `near` 0 is a distant rumble over the horizon, 1 is directly overhead. The
   * difference is not just volume: distance eats the high end and stretches the
   * tail, which is what tells you whether the cell is a problem yet.
   */
  thunderAt(near: number): void {
    const n = Math.min(1, Math.max(0, near));
    this.duck(1.2 + n * 1.2, 0.35 + n * 0.4);
    const crackF = 220 + n * 900;
    // From somewhere: a strike is off to one side, and rolls across
    const side = Math.random() < 0.5 ? -1 : 1;
    const o = { pan: side * (0.25 + (1 - n) * 0.45) };
    if (n > 0.6) {
      // Close enough to hear the initial crack before the roll
      this.noiseBurst(0.10, crackF * 1.6, 0.16 * n, 'bandpass', 2, 500, o);
    }
    this.noiseBurst(1.4 + (1 - n) * 1.6, crackF, 0.10 + n * 0.30, 'lowpass', 1, 55, o);
    this.noiseBurst(1.0 + (1 - n), 150 + n * 120, 0.06 + n * 0.18, 'lowpass', 1, 42,
      { pan: -o.pan * 0.6, delayS: 0.18 + (1 - n) * 0.42 });
  }

  stopWeatherBed(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of [this.wxHissGain, this.wxRoarGain, this.wxHowlGain]) {
      if (g) this.ramp(g.gain, 0, t, 0.2);
    }
    this.wxMask = 0;
    const nodes = [...this.wxHissSrcs, this.wxRoarSrc, this.wxHowlSrc];
    setTimeout(() => {
      for (const n of nodes) { try { n?.stop(); n?.disconnect(); } catch { /* gone */ } }
    }, 600);
    this.wxHissSrc = this.wxRoarSrc = this.wxHowlSrc = null;
    this.wxHissGain = this.wxRoarGain = this.wxHowlGain = null;
    this.wxHissFilter = this.wxRoarFilter = this.wxHowlFilter = null;
    this.wxHissSrcs = [];
    this.wxHissFilters = [];
  }

  // ══ GUNFIRE ═════════════════════════════════════════════════════════════
  //
  // Every weapon fired the same three identical noise bursts regardless of what
  // it was or how far away it stood — a rifle over sandbags and a wheeled
  // autocannon three kilometres out were the same sound, so you could not tell
  // by ear what was shooting at you.
  //
  // Two things fix that. Weapons get their own voices, and DISTANCE is modelled
  // properly: air eats the high frequencies, so a close gun is a sharp crack and
  // the same gun far away is a dull thump. That is a real gameplay signal — you
  // can hear how much trouble you are in.

  /**
   * @param kind which weapon is firing
   * @param dist 0 = right underneath you, 1 = at the limit of its range
   */
  /**
   * @param pan where it is relative to you, −1 behind/left … +1 ahead/right.
   *   Gunfire with a direction is gunfire you can place without looking.
   */
  gunshot(kind: 'small' | 'marksman' | 'heavy' | 'aa', dist: number, pan = 0): void {
    const d = Math.min(1, Math.max(0, dist));
    // Close fire ducks the bed; distant fire does not need to.
    this.duck(0.35, 0.5 * (1 - d));
    const near = 1 - d;
    // Air absorption: the top of the spectrum goes first
    const bright = 0.25 + near * 0.75;
    /*
     * Another ~5 dB. Small arms at mid-range measured +0.6 dB over the cruise
     * bed — being shot at was something you saw on the HUD, not heard. A gun
     * further off is also further to one side, so it is placed there.
     */
    const vol = (0.05 + near * 0.20) * 2.8;
    const o = { pan: pan * (0.35 + d * 0.5) };

    switch (kind) {
      case 'small': {
        // A short burst, not a single crack: the rounds a beat apart
        const n = 2 + Math.floor(Math.random() * 2);
        // A crack is broadband: a filter this narrow (Q 4–7) was throwing
        // away nearly all of it, which is why rifles were quieter than the drone
        for (let i = 0; i < n; i++) {
          this.noiseBurst(0.05 + d * 0.05, (1700 + Math.random() * 700) * bright,
            vol * 0.8, 'bandpass', 1.3 + near * 1.4, 380, { ...o, delayS: i * (0.07 + Math.random() * 0.03) });
        }
        break;
      }
      case 'marksman':
        // One deliberate shot, more body than the rifles
        this.noiseBurst(0.07 + d * 0.06, 1250 * bright, vol, 'bandpass', 2.2, 300, o);
        this.blip(150 + near * 60, 0.09, vol * 0.5, 'triangle', 70, 0, o);
        break;
      case 'heavy':
        // Belt-fed: a hammering thump under the crack
        for (let i = 0; i < 3; i++) {
          this.noiseBurst(0.07 + d * 0.05, 900 * bright, vol * 1.1, 'bandpass', 1.6, 220, { ...o, delayS: i * 0.095 });
          this.blip(95 + near * 45, 0.12, vol * 0.7, 'square', 48, i * 0.095, o);
        }
        break;
      case 'aa':
        // A big low boom, then the shell going away from you
        this.noiseBurst(0.16 + d * 0.10, 520 * bright, vol * 1.5, 'lowpass', 1, 110, o);
        this.blip(70, 0.30, vol * 0.9, 'triangle', 32, 0, o);
        break;
    }
  }

  /** A flak shell bursting near the aircraft — sharp, close, and rattling. */
  flakBurst(near: number): void {
    const n = Math.min(1, Math.max(0, near));
    this.noiseBurst(0.22, 700 + n * 900, 0.10 + n * 0.26, 'bandpass', 1.6, 160);
    this.blip(60, 0.26, 0.08 + n * 0.16, 'square', 28);
  }

  // ══ OTHER TRAFFIC ═══════════════════════════════════════════════════════
  //
  // Another aeroplane crossing a few hundred metres away made no sound at all,
  // so the only warning was the HUD. An engine you can HEAR coming — rising as
  // it closes, dropping in pitch as it goes past — is the oldest and best
  // traffic alert there is.

  private ensureTraffic(): void {
    if (!this.ctx || !this.master || this.trafOsc) return;
    const ctx = this.ctx;
    this.trafFilter = ctx.createBiquadFilter();
    this.trafFilter.type = 'lowpass';
    this.trafFilter.frequency.value = 420;
    this.trafFilter.Q.value = 2;

    // Same prop-chop trick as our own engine, or it reads as a synth pad
    this.trafChopGain = ctx.createGain();
    this.trafChopGain.gain.value = 0.7;
    this.trafChop = ctx.createOscillator();
    this.trafChop.type = 'sine';
    this.trafChop.frequency.value = 44;
    this.trafChopDepth = ctx.createGain();
    this.trafChopDepth.gain.value = 0.3;
    this.trafChop.connect(this.trafChopDepth).connect(this.trafChopGain.gain);
    this.trafChop.start();

    this.trafGain = ctx.createGain();
    this.trafGain.gain.value = 0;

    this.trafOsc = ctx.createOscillator();
    this.trafOsc.type = 'sawtooth';
    this.trafOsc.frequency.value = 62;
    this.trafOsc2 = ctx.createOscillator();
    this.trafOsc2.type = 'triangle';
    this.trafOsc2.frequency.value = 93;
    this.trafOsc.connect(this.trafFilter);
    this.trafOsc2.connect(this.trafFilter);
    this.trafFilter.connect(this.trafChopGain).connect(this.trafGain)
      .connect(this.busWorld ?? this.master);
    this.trafOsc.start();
    this.trafOsc2.start();
  }

  /**
   * @param proximity 0 = out of earshot, 1 = right on top of you
   * @param doppler   closure as a fraction: + coming at you, − going away
   */
  setTraffic(proximity: number, doppler: number): void {
    if (!this.ctx) return;
    if (proximity <= 0.001 && !this.trafOsc) return;
    this.ensureTraffic();
    if (!this.trafGain || !this.trafOsc || !this.trafOsc2 || !this.trafFilter || !this.trafChop) return;
    const t = this.ctx.currentTime;
    const p = Math.min(1, Math.max(0, proximity));
    // Doppler: approaching pitches up, receding drops. The drop as it goes by
    // is the moment the whole effect exists for.
    const shift = 1 + Math.max(-0.35, Math.min(0.35, doppler)) * 0.3;

    /*
     * Audible. At 0.085 peak — and squared, so it collapsed the moment they
     * were not right on top of you — another aeroplane passing close by made
     * essentially no sound, which is a strange thing in a game whose whole
     * traffic mechanic is about noticing them. Raised, and eased to p^1.5 so
     * it carries further out before fading.
     */
    this.ramp(this.trafGain.gain, Math.pow(p, 1.3) * 0.25, t, 0.18);
    this.ramp(this.trafOsc.frequency, 62 * shift, t, 0.12);
    this.ramp(this.trafOsc2.frequency, 93 * shift, t, 0.12);
    this.ramp(this.trafChop.frequency, 44 * shift, t, 0.12);
    // Distance eats the top end here too
    this.ramp(this.trafFilter.frequency, 300 + p * 900, t, 0.2);
  }

  stopTraffic(): void {
    if (!this.ctx) return;
    if (this.trafGain) this.ramp(this.trafGain.gain, 0, this.ctx.currentTime, 0.15);
    const nodes = [this.trafOsc, this.trafOsc2, this.trafChop];
    setTimeout(() => {
      for (const n of nodes) { try { n?.stop(); n?.disconnect(); } catch { /* gone */ } }
    }, 500);
    this.trafOsc = this.trafOsc2 = this.trafChop = null;
    this.trafGain = null; this.trafFilter = null;
    this.trafChopDepth = this.trafChopGain = null;
  }

  // ══ AUDIO VARIOMETER ════════════════════════════════════════════════════
  //
  // Every glider has one, and it is the single instrument that makes invisible
  // air playable: a rising beep that quickens as the lift strengthens, so you
  // can hunt a thermal BY EAR while looking where you are going. Silent in
  // sink, because a vario that chirps constantly is a vario you switch off.

  setVario(airVertical: number, dt: number): void {
    if (!this.ctx) return;
    if (airVertical < 0.6) { this.varioNext = 0; return; }
    this.varioNext -= dt;
    if (this.varioNext > 0) return;
    const strength = Math.min(1, (airVertical - 0.6) / 5);
    // Faster and higher the stronger the lift — the classic vario response,
    // pitched clear of the engine so it can actually be hunted by ear
    this.varioNext = 0.42 - strength * 0.30;
    this.blip(900 + strength * 1100, 0.07 + strength * 0.04, 0.045, 'sine', undefined, 0, this.cue);
  }

  // ══ DUCKING ═════════════════════════════════════════════════════════════
  //
  // The engine is a continuous drone and everything else is transient, so on a
  // flat mix the drone always wins — gunfire, thunder and the radio were all
  // technically playing and none of them could be MADE OUT.
  //
  // Broadcast solves this by ducking: when something important speaks, the bed
  // steps back for exactly as long as it takes, then comes back up. That keeps
  // the engine present without letting it bury the things you have to react to.

  /**
   * Push the engine and world beds down for `seconds`.
   * @param depth 0 = no duck, 1 = duck hard (used by the radio)
   */
  duck(seconds: number, depth = 0.6): void {
    this.duckLeft = Math.max(this.duckLeft, seconds);
    this.duckDepth = Math.max(this.duckDepth, Math.min(1, Math.max(0, depth)));
    this.applyDuck(0.05);
  }

  private applyDuck(timeConstant: number): void {
    if (!this.ctx || !this.busEngine || !this.busWorld) return;
    const t = this.ctx.currentTime;
    const d = this.duckLeft > 0 ? this.duckDepth : 0;
    // The engine ducks hardest; the world bed only steps back a little, so the
    // aeroplane never goes eerily silent underneath a transmission.
    this.ramp(this.busEngine.gain, BUS_ENGINE * (1 - d * 0.86), t, timeConstant);
    this.ramp(this.busWorld.gain, BUS_WORLD * (1 - d * 0.60), t, timeConstant);
  }

  /** Drive the duck envelope. Called once per frame from the flight loop. */
  private tickDuck(dt: number): void {
    if (this.duckLeft <= 0) return;
    this.duckLeft -= dt;
    if (this.duckLeft <= 0) {
      this.duckLeft = 0;
      this.duckDepth = 0;
      this.applyDuck(0.28);   // come back up gently, the way a real desk does
    }
  }

  // ══ PER-AIRCRAFT ENGINE VOICE ═══════════════════════════════════════════
  //
  // Every aeroplane in the fleet sounded identical, which is absurd when they
  // range from a single radial crop duster to a four-engine turboprop heavy.
  // The airframe already knows what it has — engine style, engine count and
  // blade count all live in its visual spec — so the sound is derived from the
  // same data the picture is.
  //
  //   radial     slow, lumpy, strong chop, rough harmonics
  //   turboprop  faster, smoother, with a turbine WHINE over the top
  //
  // Multiple engines add a slow beat between them, which is the unmistakable
  // sound of a twin slightly out of sync.

  setEngineProfile(profile: {
    kind: 'radial' | 'turboprop';
    blades: number;
    count: number;
    pitch: number;
  }): void {
    this.engProfile = {
      kind: profile.kind,
      blades: Math.max(2, profile.blades),
      count: Math.max(1, profile.count),
      pitch: Math.max(0.5, Math.min(2, profile.pitch)),
    };
    if (!this.ctx || !this.flightLoopOn) return;
    this.applyEngineProfile();
  }

  private applyEngineProfile(): void {
    if (!this.ctx || !this.engineOsc || !this.engineOsc2 || !this.engineFilter) return;
    const P = this.engProfile;
    // A radial is all low-order harmonics and lumps; a turboprop is cleaner
    // and sits higher, so the two oscillator shapes swap over.
    // Rounder than before (it was sawtooth + square with a resonant peak):
    // enough edge to be an engine, not so much it buzzes over everything
    this.engineOsc.type = 'triangle';
    this.engineOsc2.type = P.kind === 'radial' ? 'sawtooth' : 'triangle';
    this.engineFilter.Q.value = P.kind === 'radial' ? 1.1 : 0.8;
    // A radial is all thump; a turboprop's drone sits back and lets the
    // whine carry it, which is the difference you actually hear.
    if (this.chopGain) {
      this.chopGain.gain.value = P.kind === 'radial' ? 0.80 : 0.42;
    }

    this.ensureTurbine();
    // Only a turboprop has a compressor whine over the propeller. The whine
    // IS the turboprop; updateFlight scales it with rpm, so it spools up from
    // the start and dies with the engine.
    this.turbineLevel = P.kind === 'turboprop' ? 0.03 + P.count * 0.006 : 0;
    if (this.beatGain && this.ctx) {
      // Two or more engines beat against one another; a single does not. A
      // tenth or so of the level either way: a slow "wow", not a tremolo.
      this.beatGain.gain.setTargetAtTime(P.count > 1 ? 0.09 + Math.min(4, P.count) * 0.012 : 0, this.ctx.currentTime, 0.3);
    }
    if (this.beatOsc && this.ctx) {
      this.beatOsc.frequency.setTargetAtTime(0.55 + P.count * 0.22, this.ctx.currentTime, 0.3);
    }
  }

  private ensureTurbine(): void {
    if (!this.ctx || !this.busEngine || this.turbineOsc) return;
    const ctx = this.ctx;
    // The whine: a high, thin tone shaped by a narrow bandpass
    this.turbineFilter = ctx.createBiquadFilter();
    this.turbineFilter.type = 'bandpass';
    this.turbineFilter.frequency.value = 2400;
    this.turbineFilter.Q.value = 4;
    this.turbineGain = ctx.createGain();
    this.turbineGain.gain.value = 0;
    this.turbineOsc = ctx.createOscillator();
    this.turbineOsc.type = 'sawtooth';
    this.turbineOsc.frequency.value = 620;
    this.turbineOsc.connect(this.turbineFilter).connect(this.turbineGain).connect(this.busEngine);
    this.turbineOsc.start();

    // Slow beat between engines, on the unity stage after the engine gain so
    // its depth is a fraction of whatever the engine is doing
    this.beatOsc = ctx.createOscillator();
    this.beatOsc.type = 'sine';
    this.beatOsc.frequency.value = 1.2;
    this.beatGain = ctx.createGain();
    this.beatGain.gain.value = 0;
    if (this.beatStage) this.beatOsc.connect(this.beatGain).connect(this.beatStage.gain);
    this.beatOsc.start();
  }
}

export const SoundEngine = new SoundEngineClass();
