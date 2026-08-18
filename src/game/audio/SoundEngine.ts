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

class SoundEngineClass {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private volume = 0.55;

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

  // ── Weather bed: rain, dust, the roar of a cell ───────────────────────────
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
  private beatOsc: OscillatorNode | null = null;
  private beatGain: GainNode | null = null;

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

        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(comp).connect(this.ctx.destination);

        // Sub-buses. The engine sits BELOW everything else by default — it is
        // continuous, so it does not need to be loud to be present, and the
        // things you actually have to react to need the headroom.
        this.busEngine = this.ctx.createGain();
        this.busEngine.gain.value = 0.50;
        this.busWorld = this.ctx.createGain();
        this.busWorld.gain.value = 0.85;
        this.busAlert = this.ctx.createGain();
        this.busAlert.gain.value = 2.1;
        this.busEngine.connect(this.master);
        this.busWorld.connect(this.master);
        this.busAlert.connect(this.master);

        // 2 s of white noise, looped by every noise-based source
        const len = this.ctx.sampleRate * 2;
        this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      } catch {
        this.ctx = null;
      }
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

  /** Filtered noise burst — thumps, chirps, impacts, gunfire. */
  private noiseBurst(
    durationS: number, freq: number, gain: number,
    type: BiquadFilterType = 'lowpass', q = 1, sweepTo?: number,
  ): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
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
    src.connect(filter).connect(g).connect(this.busAlert ?? this.master);
    src.start(t, Math.random());
    src.stop(t + durationS + 0.05);
  }

  /** Tone blip, optionally pitch-swept and/or delayed. */
  private blip(
    freq: number, durationS: number, gain: number,
    type: OscillatorType = 'sine', sweepTo?: number, delayS = 0,
  ): void {
    if (!this.ctx || !this.master) return;
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
    osc.connect(g).connect(this.busAlert ?? this.master);
    osc.start(t);
    osc.stop(t + durationS + 0.05);
  }

  // ── Continuous flight loop ────────────────────────────────────────────────

  startFlightLoop(): void {
    if (!this.ctx || !this.master || this.flightLoopOn || !this.noiseBuffer) return;
    this.flightLoopOn = true;
    const ctx = this.ctx;

    // ── Engine: harmonic stack → lowpass → prop-chop tremolo ──────────────
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 300;
    this.engineFilter.Q.value = 3;

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
    this.engineFilter.connect(this.chopGain).connect(this.engineGain)
      .connect(this.busEngine ?? this.master);

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

    // ── Exhaust hiss ──────────────────────────────────────────────────────
    const ex = this.loopNoise('bandpass', 900, 0.8, this.busEngine);
    if (ex) { this.exhaustSrc = ex.src; this.exhaustFilter = ex.filter; this.exhaustGain = ex.gain; }

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
      this.engineOsc.frequency.setTargetAtTime(f, t, 0.07);
      const h = P.kind === 'radial' ? 1.5 : 2.02;
      this.engineOsc2.frequency.setTargetAtTime(f * (h + s.roughness * 0.22), t, 0.07);
      this.engineGain.gain.setTargetAtTime(s.rpm > 0.01 ? 0.075 + s.throttle * 0.10 : 0, t, 0.12);
      this.engineFilter.frequency.setTargetAtTime(240 + s.throttle * 620 + s.rpm * 320, t, 0.1);
    }
    if (this.chopLfo && this.chopDepth) {
      // Blade-pass rate = rpm × blades × engines. A four-engine three-blade
      // heavy chops far faster than a single two-blade duster, and that ratio
      // is most of what tells the two apart by ear.
      const chop = (8 + s.rpm * 24) * P.blades * Math.min(2, P.count) * warp * P.pitch;
      this.chopLfo.frequency.setTargetAtTime(chop, t, 0.07);
      // A turboprop's blades are much less lumpy than a radial's
      const depth = (P.kind === 'radial' ? 0.30 : 0.14) + s.roughness * 0.3;
      this.chopDepth.gain.setTargetAtTime(depth, t, 0.15);
    }
    if (this.turbineOsc && this.turbineFilter) {
      // The whine climbs with rpm — the sound of a turboprop spooling
      this.turbineOsc.frequency.setTargetAtTime((420 + s.rpm * 900) * warp, t, 0.12);
      this.turbineFilter.frequency.setTargetAtTime(1800 + s.rpm * 2200, t, 0.12);
    }
    if (this.exhaustGain && this.exhaustFilter) {
      this.exhaustGain.gain.setTargetAtTime(s.rpm * (0.020 + s.throttle * 0.030), t, 0.12);
      this.exhaustFilter.frequency.setTargetAtTime(700 + s.throttle * 900, t, 0.12);
    }
    if (this.windGain && this.windFilter) {
      // Gear and flaps hanging out add real buffet
      const drag = 1 + (s.gearDown ? 0.35 : 0) + (s.flapsDeployed ? 0.4 : 0);
      const gust = 1 + s.turbulence * 0.5 * (0.6 + 0.4 * Math.sin(t * 3.1));
      this.windGain.gain.setTargetAtTime(s.speedFrac * s.speedFrac * 0.15 * drag * gust, t, 0.14);
      this.windFilter.frequency.setTargetAtTime(340 + s.speedFrac * 1000, t, 0.14);
    }
    if (this.rumbleGain && this.rumbleFilter) {
      const rolling = s.onGround ? Math.min(1, s.speedFrac * 3) : 0;
      this.rumbleGain.gain.setTargetAtTime(rolling * 0.11, t, 0.08);
      this.rumbleFilter.frequency.setTargetAtTime(150 + rolling * 260, t, 0.1);
    }
  }

  /** Continuous stall warning horn. */
  setStallWarning(on: boolean): void {
    if (!this.ctx || !this.hornGain || on === this.hornOn) return;
    this.hornOn = on;
    this.hornGain.gain.setTargetAtTime(on ? 0.05 : 0, this.ctx.currentTime, 0.05);
  }

  stopFlightLoop(): void {
    if (!this.ctx || !this.flightLoopOn) return;
    this.flightLoopOn = false;
    this.hornOn = false;
    const t = this.ctx.currentTime;
    for (const g of [this.engineGain, this.exhaustGain, this.windGain, this.rumbleGain, this.hornGain]) {
      g?.gain.setTargetAtTime(0, t, 0.08);
    }
    const nodes = [
      this.engineOsc, this.engineOsc2, this.chopLfo, this.hornOsc, this.hornOsc2,
      this.exhaustSrc, this.windSrc, this.rumbleSrc,
    ];
    setTimeout(() => {
      for (const n of nodes) { try { n?.stop(); n?.disconnect(); } catch { /* already stopped */ } }
    }, 500);
    this.engineOsc = this.engineOsc2 = this.chopLfo = this.hornOsc = this.hornOsc2 = null;
    this.exhaustSrc = this.windSrc = this.rumbleSrc = null;
  }

  // ── Ambient bed (menu / map) ──────────────────────────────────────────────

  startAmbient(): void {
    if (!this.ctx || !this.master || this.ambientSrc || !this.noiseBuffer) return;
    const amb = this.loopNoise('lowpass', 320, 0.7);
    if (!amb) return;
    this.ambientSrc = amb.src;
    this.ambientGain = amb.gain;
    this.ambientGain.gain.setTargetAtTime(0.035, this.ctx.currentTime, 1.5);
  }

  stopAmbient(): void {
    if (!this.ctx || !this.ambientSrc) return;
    this.ambientGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    const src = this.ambientSrc;
    this.ambientSrc = null;
    setTimeout(() => { try { src.stop(); src.disconnect(); } catch { /* gone */ } }, 800);
  }

  // ── One-shots ─────────────────────────────────────────────────────────────

  /** Starter grind, catch, then settle. */
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

  /** Wheels meeting the runway: tyre chirp + suspension thump. */
  touchdown(vSpeed: number): void {
    const k = Math.min(1, Math.abs(vSpeed) / 6);
    this.noiseBurst(0.1 + k * 0.06, 2600, 0.16 + k * 0.2, 'bandpass', 4, 900); // chirp
    this.noiseBurst(0.28 + k * 0.22, 170 + k * 120, 0.22 + k * 0.45);          // thump
    this.blip(64, 0.2, 0.16 + k * 0.22, 'triangle', 44);
  }

  crash(): void {
    this.noiseBurst(1.3, 150, 0.95, 'lowpass', 1, 50);
    this.blip(44, 0.85, 0.5, 'triangle', 20);
    // Metal debris scattering after the impact
    for (let i = 0; i < 7; i++) {
      setTimeout(
        () => this.noiseBurst(0.13, 1800 + Math.random() * 2200, 0.1, 'bandpass', 6),
        120 + i * 90 + Math.random() * 80,
      );
    }
  }

  /** Gear cycling: electric motor whine, then a locking clunk. */
  gearMove(down = true): void {
    this.noiseBurst(1.0, down ? 380 : 300, 0.07, 'bandpass', 3, down ? 620 : 240);
    this.blip(down ? 200 : 260, 0.9, 0.045, 'sawtooth', down ? 320 : 170);
    setTimeout(() => {
      this.noiseBurst(0.16, 260, 0.22);
      this.blip(88, 0.14, 0.13, 'square');
    }, 1050);
  }

  flapMove(): void {
    this.noiseBurst(0.6, 340, 0.06, 'bandpass', 3, 460);
    this.blip(230, 0.55, 0.035, 'sawtooth', 300);
  }

  /** Airframe buffet as the wing lets go. */
  stallBuffet(): void {
    this.noiseBurst(0.16, 110, 0.17);
  }

  /** Master caution — two-tone. */
  warn(): void {
    this.blip(760, 0.12, 0.10, 'square');
    this.blip(560, 0.14, 0.10, 'square', undefined, 0.16);
  }

  /** Sharp repeating alarm for imminent danger (obstacle ahead). */
  alarm(): void {
    this.blip(980, 0.08, 0.11, 'square');
    this.blip(980, 0.08, 0.11, 'square', undefined, 0.13);
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
    this.noiseBurst(1.8, 260, 0.32, 'lowpass', 1, 60);
    setTimeout(() => this.noiseBurst(1.1, 180, 0.2, 'lowpass', 1, 45), 260);
  }

  /** Impact with a structure. */
  impact(): void {
    this.noiseBurst(0.5, 320, 0.6, 'lowpass', 1, 90);
    this.blip(70, 0.35, 0.3, 'triangle', 34);
  }

  click(): void {
    this.blip(620, 0.05, 0.07, 'triangle');
  }

  chime(): void {
    this.blip(660, 0.12, 0.07);
    this.blip(880, 0.16, 0.07, 'sine', undefined, 0.11);
    this.blip(1320, 0.22, 0.04, 'sine', undefined, 0.22);
  }

  /** Contract paid / success flourish. */
  success(): void {
    this.blip(523, 0.14, 0.07, 'triangle');
    this.blip(659, 0.14, 0.07, 'triangle', undefined, 0.12);
    this.blip(784, 0.3, 0.07, 'triangle', undefined, 0.24);
  }

  /** Failure sting. */
  failure(): void {
    this.blip(300, 0.3, 0.09, 'sawtooth', 160);
    this.blip(200, 0.5, 0.08, 'sawtooth', 90, 0.18);
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
  radio(text: string, opts: { urgency?: number; pitch?: number } = {}): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    // Never let two transmissions talk over each other — a radio is one channel
    const start = Math.max(ctx.currentTime, this.radioBusyUntil) + 0.02;

    const urgency = Math.min(1, Math.max(0, opts.urgency ?? 0.3));
    // Rough syllable count from the words, clamped so nothing drones on
    const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
    const syllables = Math.min(16, Math.max(3, Math.round(words * 1.35)));
    // An urgent call is clipped and higher; a routine one is slower and flatter
    const rate = 0.115 - urgency * 0.03;
    const basePitch = (opts.pitch ?? 105) * (1 + urgency * 0.22);

    const bus = ctx.createGain();
    // Comms are the most important thing in the aeroplane; mixed to sit on top.
    bus.gain.value = 3.4;
    // Radio band-limiting: this pair is most of why it sounds like a speaker
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 320;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2900;
    // A little drive so it sounds squashed the way comms audio is
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 2.6);
    }
    shaper.curve = curve;
    bus.connect(hp).connect(lp).connect(shaper).connect(this.busAlert ?? this.master);

    // ── Squelch open ──────────────────────────────────────────────────────
    this.burstInto(bus, start, 0.035, 2400, 0.26, 'bandpass', 3);

    // ── Static bed under the whole transmission ───────────────────────────
    const total = syllables * rate + 0.16;
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer;
    hiss.loop = true;
    const hissF = ctx.createBiquadFilter();
    hissF.type = 'bandpass'; hissF.frequency.value = 1500; hissF.Q.value = 0.6;
    const hissG = ctx.createGain();
    hissG.gain.setValueAtTime(0.0001, start);
    hissG.gain.linearRampToValueAtTime(0.020, start + 0.03);
    hissG.gain.setValueAtTime(0.020, start + total - 0.05);
    hissG.gain.linearRampToValueAtTime(0.0001, start + total);
    hiss.connect(hissF).connect(hissG).connect(bus);
    hiss.start(start);
    hiss.stop(start + total + 0.1);

    // ── The voice: pulse carrier through three moving formants ────────────
    for (let i = 0; i < syllables; i++) {
      const t0 = start + 0.05 + i * rate;
      const dur = rate * (0.62 + Math.random() * 0.24);
      // Sentence melody: drifts down, lifts on the last syllable like a query
      const droop = 1 - (i / syllables) * 0.18;
      const f0 = basePitch * droop * (0.92 + Math.random() * 0.16);

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.linearRampToValueAtTime(f0 * (0.94 + Math.random() * 0.12), t0 + dur);

      // Three formants ≈ a vowel. Moving them between syllables is what stops
      // it sounding like a buzzer and starts it sounding like a mouth.
      const vowel = [
        [700, 1220, 2600], [400, 1900, 2550], [320, 900, 2400],
        [640, 1200, 2400], [500, 1700, 2500],
      ][Math.floor(Math.random() * 5)];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.26, t0 + dur * 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      let node: AudioNode = osc;
      for (let k = 0; k < 3; k++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(vowel[k], t0);
        bp.frequency.linearRampToValueAtTime(vowel[k] * (0.9 + Math.random() * 0.2), t0 + dur);
        bp.Q.value = 6 - k * 1.4;
        node = node.connect(bp);
      }
      node.connect(g).connect(bus);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    // ── Squelch close ─────────────────────────────────────────────────────
    this.burstInto(bus, start + total, 0.05, 1200, 0.13, 'bandpass', 2);
    this.radioBusyUntil = start + total + 0.12;
    // Step the bed back for the whole transmission plus a beat, so the voice
    // is not competing with the engine it is being heard over.
    this.duck((start - ctx.currentTime) + total + 0.25, 1.0);
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
    if (!this.ctx || !this.master || this.wxHissSrc || !this.noiseBuffer) return;
    const hiss = this.loopNoise('highpass', 1400, 0.7, this.busWorld);
    const roar = this.loopNoise('lowpass', 300, 0.9, this.busWorld);
    if (!hiss || !roar) return;
    this.wxHissSrc = hiss.src; this.wxHissGain = hiss.gain; this.wxHissFilter = hiss.filter;
    this.wxRoarSrc = roar.src; this.wxRoarGain = roar.gain; this.wxRoarFilter = roar.filter;
  }

  /**
   * Per-frame weather sound.
   *
   * `intensity` is the cell's local strength at the aircraft — so the sound
   * builds as you fly into a cell and falls away as you leave it, which is the
   * whole point of weather being a place rather than a global condition.
   */
  setWeather(condition: string, intensity: number, dt: number): void {
    if (!this.ctx) return;
    this.ensureWeatherBed();
    if (!this.wxHissGain || !this.wxRoarGain || !this.wxHissFilter || !this.wxRoarFilter) return;
    const t = this.ctx.currentTime;
    const i = Math.min(1, Math.max(0, intensity));

    // hiss gain, hiss cutoff, roar gain, roar cutoff — one row per condition
    const V: Record<string, [number, number, number, number]> = {
      clear:        [0.000, 1400, 0.000, 300],
      cloudy:       [0.004, 1100, 0.010, 220],
      strong_winds: [0.030,  900, 0.045, 260],
      dust_storm:   [0.055, 1150, 0.060, 210],
      thunderstorm: [0.070, 2000, 0.075, 180],
      blizzard:     [0.060, 1700, 0.040, 200],
      fog:          [0.006,  700, 0.014, 160],
    };
    const row = V[condition] ?? V.clear;

    this.wxHissGain.gain.setTargetAtTime(row[0] * i, t, 0.35);
    this.wxHissFilter.frequency.setTargetAtTime(row[1], t, 0.5);
    this.wxRoarGain.gain.setTargetAtTime(row[2] * i, t, 0.4);
    this.wxRoarFilter.frequency.setTargetAtTime(row[3], t, 0.5);

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
    if (n > 0.6) {
      // Close enough to hear the initial crack before the roll
      this.noiseBurst(0.10, crackF * 1.6, 0.16 * n, 'bandpass', 2, 500);
    }
    this.noiseBurst(1.4 + (1 - n) * 1.6, crackF, 0.10 + n * 0.30, 'lowpass', 1, 55);
    setTimeout(
      () => this.noiseBurst(1.0 + (1 - n), 150 + n * 120, 0.06 + n * 0.18, 'lowpass', 1, 42),
      180 + (1 - n) * 420,
    );
  }

  stopWeatherBed(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wxHissGain?.gain.setTargetAtTime(0, t, 0.2);
    this.wxRoarGain?.gain.setTargetAtTime(0, t, 0.2);
    const nodes = [this.wxHissSrc, this.wxRoarSrc];
    setTimeout(() => {
      for (const n of nodes) { try { n?.stop(); n?.disconnect(); } catch { /* gone */ } }
    }, 600);
    this.wxHissSrc = this.wxRoarSrc = null;
    this.wxHissGain = this.wxRoarGain = null;
    this.wxHissFilter = this.wxRoarFilter = null;
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
  gunshot(kind: 'small' | 'marksman' | 'heavy' | 'aa', dist: number): void {
    const d = Math.min(1, Math.max(0, dist));
    // Close fire ducks the bed; distant fire does not need to.
    this.duck(0.35, 0.5 * (1 - d));
    const near = 1 - d;
    // Air absorption: the top of the spectrum goes first
    const bright = 0.25 + near * 0.75;
    const vol = 0.05 + near * 0.20;

    switch (kind) {
      case 'small':
        // A light crack, doubled — small arms are never a single shot
        for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
          this.noiseBurst(0.05 + d * 0.05, (1700 + Math.random() * 700) * bright,
            vol * 0.8, 'bandpass', 4 + near * 3, 380);
        }
        break;
      case 'marksman':
        // One deliberate shot, more body than the rifles
        this.noiseBurst(0.07 + d * 0.06, 1250 * bright, vol, 'bandpass', 5, 300);
        this.blip(150 + near * 60, 0.09, vol * 0.5, 'triangle', 70);
        break;
      case 'heavy':
        // Belt-fed: a hammering thump under the crack
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            this.noiseBurst(0.07 + d * 0.05, 900 * bright, vol * 1.1, 'bandpass', 3, 220);
            this.blip(95 + near * 45, 0.12, vol * 0.7, 'square', 48);
          }, i * 95);
        }
        break;
      case 'aa':
        // A big low boom, then the shell going away from you
        this.noiseBurst(0.16 + d * 0.10, 520 * bright, vol * 1.5, 'lowpass', 1, 110);
        this.blip(70, 0.30, vol * 0.9, 'triangle', 32);
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
    const shift = 1 + Math.max(-0.35, Math.min(0.35, doppler)) * 0.18;

    this.trafGain.gain.setTargetAtTime(p * p * 0.085, t, 0.18);
    this.trafOsc.frequency.setTargetAtTime(62 * shift, t, 0.12);
    this.trafOsc2.frequency.setTargetAtTime(93 * shift, t, 0.12);
    this.trafChop.frequency.setTargetAtTime(44 * shift, t, 0.12);
    // Distance eats the top end here too
    this.trafFilter.frequency.setTargetAtTime(240 + p * 520, t, 0.2);
  }

  stopTraffic(): void {
    if (!this.ctx) return;
    this.trafGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
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
    // Faster and higher the stronger the lift — the classic vario response
    this.varioNext = 0.42 - strength * 0.30;
    this.blip(620 + strength * 900, 0.07 + strength * 0.04, 0.035, 'sine');
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
    this.busEngine.gain.setTargetAtTime(0.50 * (1 - d * 0.86), t, timeConstant);
    this.busWorld.gain.setTargetAtTime(0.85 * (1 - d * 0.60), t, timeConstant);
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
    this.engineOsc.type = P.kind === 'radial' ? 'sawtooth' : 'triangle';
    this.engineOsc2.type = P.kind === 'radial' ? 'square' : 'sawtooth';
    this.engineFilter.Q.value = P.kind === 'radial' ? 4.2 : 1.5;
    // A radial is all thump; a turboprop's drone sits back and lets the
    // whine carry it, which is the difference you actually hear.
    if (this.chopGain) {
      this.chopGain.gain.value = P.kind === 'radial' ? 0.80 : 0.42;
    }

    this.ensureTurbine();
    if (this.turbineGain && this.ctx) {
      // Only a turboprop has a compressor whine over the propeller
      // The whine IS the turboprop. At 0.02 it was inaudible under the
      // propeller and every aeroplane still sounded like the same radial.
      this.turbineGain.gain.setTargetAtTime(
        P.kind === 'turboprop' ? 0.075 + P.count * 0.018 : 0, this.ctx.currentTime, 0.3,
      );
    }
    if (this.beatGain && this.ctx) {
      // Two or more engines beat against one another; a single does not
      this.beatGain.gain.setTargetAtTime(P.count > 1 ? 0.30 : 0, this.ctx.currentTime, 0.3);
    }
    if (this.beatOsc && this.ctx) {
      this.beatOsc.frequency.setTargetAtTime(0.7 + P.count * 0.5, this.ctx.currentTime, 0.3);
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

    // Slow beat between engines, modulating the main engine gain
    this.beatOsc = ctx.createOscillator();
    this.beatOsc.type = 'sine';
    this.beatOsc.frequency.value = 1.2;
    this.beatGain = ctx.createGain();
    this.beatGain.gain.value = 0;
    if (this.engineGain) this.beatOsc.connect(this.beatGain).connect(this.engineGain.gain);
    this.beatOsc.start();
  }
}

export const SoundEngine = new SoundEngineClass();
