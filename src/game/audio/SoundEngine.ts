/**
 * Procedural sound engine — pure WebAudio, zero assets, zero dependencies.
 *
 * Continuous layers (engine drone, prop buzz, wind rush) are synthesized and
 * modulated every frame from flight state; one-shots (thump, crash, clunk,
 * beeps) are short envelope bursts. The AudioContext can only start after a
 * user gesture, so `unlock()` is called from the first pointer/key event.
 */

class SoundEngineClass {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  // Flight loop nodes
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private flightLoopOn = false;

  /** Call from any user gesture; safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);

        // 2 s of white noise, looped for wind/rumble sources
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
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  // ── Continuous flight loop ─────────────────────────────────────────────────

  startFlightLoop(): void {
    if (!this.ctx || !this.master || this.flightLoopOn || !this.noiseBuffer) return;
    this.flightLoopOn = true;
    const ctx = this.ctx;

    // Engine: saw fundamental + square sub-octave through a lowpass
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 300;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 40;
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'square';
    this.engineSub.frequency.value = 20;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.engineOsc.connect(this.engineFilter);
    this.engineSub.connect(subGain).connect(this.engineFilter);
    this.engineOsc.start();
    this.engineSub.start();

    // Wind: looped noise through a bandpass
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.noiseBuffer;
    this.windSrc.loop = true;
    this.windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.windSrc.start();
  }

  /** Per-frame modulation. rpm/throttle/speedFrac 0–1. */
  updateFlight(rpm: number, throttle: number, speedFrac: number, timeScale: number): void {
    if (!this.ctx || !this.flightLoopOn) return;
    const t = this.ctx.currentTime;
    const warp = 1 + (timeScale - 1) * 0.02; // subtle pitch-up in time warp

    if (this.engineOsc && this.engineSub && this.engineGain && this.engineFilter) {
      const f = (34 + rpm * 92) * warp;
      this.engineOsc.frequency.setTargetAtTime(f, t, 0.08);
      this.engineSub.frequency.setTargetAtTime(f / 2, t, 0.08);
      this.engineGain.gain.setTargetAtTime(rpm > 0.01 ? 0.05 + throttle * 0.1 : 0, t, 0.1);
      this.engineFilter.frequency.setTargetAtTime(220 + throttle * 500 + rpm * 300, t, 0.1);
    }
    if (this.windGain && this.windFilter) {
      this.windGain.gain.setTargetAtTime(speedFrac * speedFrac * 0.16, t, 0.15);
      this.windFilter.frequency.setTargetAtTime(350 + speedFrac * 900, t, 0.15);
    }
  }

  stopFlightLoop(): void {
    if (!this.ctx || !this.flightLoopOn) return;
    this.flightLoopOn = false;
    const t = this.ctx.currentTime;
    this.engineGain?.gain.setTargetAtTime(0, t, 0.1);
    this.windGain?.gain.setTargetAtTime(0, t, 0.1);
    const oldNodes = [this.engineOsc, this.engineSub, this.windSrc];
    setTimeout(() => {
      for (const n of oldNodes) { try { n?.stop(); n?.disconnect(); } catch { /* already gone */ } }
    }, 600);
    this.engineOsc = this.engineSub = null;
    this.windSrc = null;
  }

  // ── One-shots ──────────────────────────────────────────────────────────────

  /** Filtered noise burst — thumps, rumbles, impacts. */
  private noiseBurst(durationS: number, freq: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + durationS);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + durationS + 0.05);
  }

  /** Simple tone blip. */
  private blip(freq: number, durationS: number, gain: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + durationS);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + durationS + 0.05);
  }

  touchdown(vSpeed: number): void {
    const k = Math.min(1, Math.abs(vSpeed) / 6);
    this.noiseBurst(0.25 + k * 0.2, 180 + k * 120, 0.25 + k * 0.5);
    this.blip(70, 0.18, 0.2 + k * 0.25, 'triangle');
  }

  crash(): void {
    this.noiseBurst(1.1, 140, 0.9);
    this.blip(50, 0.7, 0.5, 'triangle');
    this.noiseBurst(0.5, 900, 0.3, 'bandpass');
  }

  gearMove(): void {
    this.noiseBurst(0.5, 420, 0.12, 'bandpass');
    this.blip(160, 0.4, 0.06, 'square');
  }

  flapMove(): void {
    this.noiseBurst(0.35, 300, 0.09, 'bandpass');
  }

  warn(): void {
    this.blip(880, 0.09, 0.12, 'square');
    setTimeout(() => this.blip(880, 0.09, 0.12, 'square'), 140);
  }

  click(): void {
    this.blip(600, 0.05, 0.08, 'triangle');
  }

  chime(): void {
    this.blip(660, 0.1, 0.08);
    setTimeout(() => this.blip(880, 0.14, 0.08), 110);
  }

  stallBuffet(): void {
    this.noiseBurst(0.12, 90, 0.14);
  }
}

export const SoundEngine = new SoundEngineClass();
