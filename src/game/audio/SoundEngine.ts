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
        comp.threshold.value = -18;
        comp.knee.value = 24;
        comp.ratio.value = 6;
        comp.attack.value = 0.004;
        comp.release.value = 0.22;

        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(comp).connect(this.ctx.destination);

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

  private loopNoise(filterType: BiquadFilterType, freq: number, q = 1):
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
    src.connect(filter).connect(gain).connect(this.master);
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
    src.connect(filter).connect(g).connect(this.master);
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
    osc.connect(g).connect(this.master);
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
    this.engineFilter.connect(this.chopGain).connect(this.engineGain).connect(this.master);

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
    const ex = this.loopNoise('bandpass', 900, 0.8);
    if (ex) { this.exhaustSrc = ex.src; this.exhaustFilter = ex.filter; this.exhaustGain = ex.gain; }

    // ── Wind rush ─────────────────────────────────────────────────────────
    const wind = this.loopNoise('bandpass', 500, 0.6);
    if (wind) { this.windSrc = wind.src; this.windFilter = wind.filter; this.windGain = wind.gain; }

    // ── Tyre rumble on the runway ─────────────────────────────────────────
    const rum = this.loopNoise('lowpass', 220, 1.4);
    if (rum) { this.rumbleSrc = rum.src; this.rumbleFilter = rum.filter; this.rumbleGain = rum.gain; }

    // ── Stall warning horn (classic warbling reed) ────────────────────────
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.master);
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
    const warp = 1 + (s.timeScale - 1) * 0.015; // faint pitch-up under time warp

    if (this.engineOsc && this.engineOsc2 && this.engineGain && this.engineFilter) {
      const f = (30 + s.rpm * 88) * warp;
      // Roughness detunes the second oscillator — a sick engine sounds sick
      this.engineOsc.frequency.setTargetAtTime(f, t, 0.07);
      this.engineOsc2.frequency.setTargetAtTime(f * (1.5 + s.roughness * 0.22), t, 0.07);
      this.engineGain.gain.setTargetAtTime(s.rpm > 0.01 ? 0.10 + s.throttle * 0.14 : 0, t, 0.12);
      this.engineFilter.frequency.setTargetAtTime(240 + s.throttle * 620 + s.rpm * 320, t, 0.1);
    }
    if (this.chopLfo && this.chopDepth) {
      // Blade-pass rate tracks rpm; the chop deepens as the engine roughens
      this.chopLfo.frequency.setTargetAtTime((26 + s.rpm * 74) * warp, t, 0.07);
      this.chopDepth.gain.setTargetAtTime(0.26 + s.roughness * 0.3, t, 0.15);
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
}

export const SoundEngine = new SoundEngineClass();
