/**
 * engine.js — AudioContext lifecycle, the master signal chain, and the iOS
 * workarounds that make any of this audible on an iPhone.
 *
 * Signal flow:
 *
 *   voices ─► voiceBus ─► horn HPF ─► presence peak ─► air LPF
 *                           └─ speaker simulation ─┘
 *          ─► bass shelf ─► treble shelf ─► saturator ─► compressor
 *          ─► master gain ─► limiter ─► ceiling ─► destination
 *
 * The speaker simulation is what separates this from a synthesizer playing
 * a sweep: a real siren speaker is a horn-loaded compression driver that
 * reproduces roughly 300 Hz–6 kHz with a hard presence peak near 1.6 kHz.
 * Passing the tone through that shape is most of the realism.
 */

import { buildWaves, makeSaturationCurve, makeNoiseBuffer, makeCeilingCurve } from './waves.js';

/** HIGH and BASS on the faceplate select one of four voicings. */
const VOICINGS = {
  // key: `${high?1:0}${bass?1:0}`
  '00': { hp: 260, peak: 4.0, peakHz: 1500, lowShelf: 0,   highShelf: 0,   lp: 7000, label: 'FLAT' },
  '10': { hp: 480, peak: 7.5, peakHz: 2400, lowShelf: -6,  highShelf: 5.5, lp: 9000, label: 'HIGH' },
  '01': { hp: 95,  peak: 2.5, peakHz: 1200, lowShelf: 9,   highShelf: -3,  lp: 5200, label: 'BASS' },
  '11': { hp: 130, peak: 6.0, peakHz: 1800, lowShelf: 6,   highShelf: 4,   lp: 9000, label: 'FULL' },
};

const RAMP = 0.035; // seconds — short enough to feel instant, long enough not to click

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.ready = false;
    this.waves = null;
    this.noiseBuffer = null;
    this._silentEl = null;
    this._volume = 0.85;
    this._high = false;
    this._bass = false;
    this._onStateChange = null;
  }

  /**
   * Must be called from inside a real user gesture (touchstart/pointerdown).
   * Safari will not start an AudioContext otherwise, and the audio session
   * category can only be claimed before the context exists.
   */
  async unlock() {
    // Two keys pressed together both call this before either resolves, and
    // without the shared promise that builds a second AudioContext — double
    // the CPU, and `ready` flapping between them.
    if (this._unlocking) return this._unlocking;
    if (!this.ready) {
      this._unlocking = this._unlock().finally(() => { this._unlocking = null; });
      return this._unlocking;
    }
    return this._unlock();
  }

  async _unlock() {
    if (this.ready) {
      // Safari suspends the context on interruptions (a call, Siri, the
      // ringer switch). Resuming on every gesture is cheap insurance.
      if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    // 1. Claim the 'playback' audio session BEFORE the context is created.
    //    Without this Safari files a bare AudioContext under 'ambient', which
    //    the hardware ring/silent switch mutes outright. Safari 16.4+.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported — the silent-element fallback below covers it */ }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API indisponível neste navegador.');

    // 'interactive' asks for the smallest output buffer the device allows,
    // which is what keeps the air horn feeling like a button and not a lag.
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    // 2. Fallback for iOS < 16.4: a looping silent media element keeps the
    //    session in a playback category the silent switch does not touch.
    this._startSilentKeepalive();

    await this.ctx.resume().catch(() => {});

    this.waves = buildWaves(this.ctx);
    this.noiseBuffer = makeNoiseBuffer(this.ctx);
    this._buildChain();

    this.ctx.addEventListener?.('statechange', () => {
      this._onStateChange?.(this.ctx.state);
    });

    this.ready = true;
    return this.ctx;
  }

  onStateChange(fn) { this._onStateChange = fn; }

  _startSilentKeepalive() {
    if (this._silentEl) return;
    const el = document.createElement('audio');
    el.setAttribute('playsinline', '');
    el.loop = true;
    el.volume = 0.001; // not 0: some iOS builds skip processing a truly muted element
    // 0.05 s of silent WAV, inline so it works with no network.
    el.src = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQ4AAAAAAAAAAAAAAAAAAAAAAA==';
    el.play().catch(() => {});
    this._silentEl = el;
  }

  _buildChain() {
    const ctx = this.ctx;

    // Everything a voice makes lands here.
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;

    // Two sub-buses, so the panel can be ducked under a tone being auditioned
    // in the guide without touching any individual voice's envelope. Reaching
    // into a voice's own gain would fight the Q-siren's nineteen-second
    // coast-down, which is scheduled on exactly that parameter.
    this.panelBus = ctx.createGain();
    this.previewBus = ctx.createGain();
    this.panelBus.connect(this.voiceBus);
    this.previewBus.connect(this.voiceBus);

    // --- speaker / horn simulation -----------------------------------
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.Q.value = 0.707;

    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.Q.value = 1.1;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.707;

    // --- HIGH / BASS tone stack ---------------------------------------
    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 240;

    this.highShelf = ctx.createBiquadFilter();
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 3200;

    // --- amplifier character -------------------------------------------
    this.sat = ctx.createWaveShaper();
    this.sat.curve = makeSaturationCurve(2.2);
    this.sat.oversample = '4x';

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = this._volume;

    // A second, fast compressor acting as a brickwall so that layering
    // (MIX mode, or siren + rumbler + horn at once) can never clip the DAC.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.06;

    // Absolute ceiling. The compressor above shapes the dynamics; this
    // guarantees the sample value itself never leaves [-1, 1].
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = makeCeilingCurve();
    this.ceiling.oversample = '2x';

    // Analyser tap for the on-screen level meter.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;

    this.voiceBus
      .connect(this.hp).connect(this.presence).connect(this.lp)
      .connect(this.lowShelf).connect(this.highShelf)
      .connect(this.sat).connect(this.comp)
      .connect(this.master).connect(this.limiter)
      .connect(this.ceiling).connect(ctx.destination);

    this.ceiling.connect(this.analyser);

    this._applyVoicing(0);
  }

  /** Where a faceplate voice connects. */
  get bus() { return this.panelBus; }

  /** Where a tone being auditioned in the guide connects. */
  get preview() { return this.previewBus; }

  /**
   * Fades the faceplate down while the guide auditions a tone, so two sirens
   * are never heard at once under a display that can only name one.
   */
  duckPanel(on) {
    if (!this.ready) return;
    this.panelBus.gain.setTargetAtTime(on ? 0 : 1, this.now, 0.03);
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  setVolume(v) {
    // A corrupt stored preference used to arrive here as NaN, and an
    // AudioParam given NaN throws outright rather than ignoring it.
    this._volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
    if (this.ready) {
      this.master.gain.setTargetAtTime(this._volume, this.now, 0.02);
    }
  }
  get volume() { return this._volume; }

  setTone({ high, bass }) {
    if (high !== undefined) this._high = high;
    if (bass !== undefined) this._bass = bass;
    if (this.ready) this._applyVoicing(RAMP);
    return this.voicingLabel;
  }

  get voicingLabel() {
    return VOICINGS[`${this._high ? 1 : 0}${this._bass ? 1 : 0}`].label;
  }

  _applyVoicing(ramp) {
    const v = VOICINGS[`${this._high ? 1 : 0}${this._bass ? 1 : 0}`];
    const t = this.now;
    const set = (param, value) =>
      ramp ? param.setTargetAtTime(value, t, ramp) : (param.value = value);

    set(this.hp.frequency, v.hp);
    set(this.presence.frequency, v.peakHz);
    set(this.presence.gain, v.peak);
    set(this.lp.frequency, v.lp);
    set(this.lowShelf.gain, v.lowShelf);
    set(this.highShelf.gain, v.highShelf);
  }

  /** Peak level 0..1, for the faceplate meter. */
  level() {
    if (!this.ready) return 0;
    const buf = this._lvlBuf ||= new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const d = Math.abs(buf[i] - 128);
      if (d > peak) peak = d;
    }
    return Math.min(1, peak / 110);
  }

  /**
   * Belt-and-braces mute for STOP. The controller kills each voice
   * individually, which is what actually stops the sound; this catches
   * anything that escaped its bookkeeping and covers the gap with a short
   * ramp rather than a click.
   */
  panic() {
    if (!this.ready) return;
    const t = this.now;
    this.panelBus.gain.cancelScheduledValues(t);
    this.panelBus.gain.setValueAtTime(1, t);
    this.voiceBus.gain.cancelScheduledValues(t);
    this.voiceBus.gain.setValueAtTime(this.voiceBus.gain.value, t);
    this.voiceBus.gain.linearRampToValueAtTime(0, t + 0.012);
    this.voiceBus.gain.setValueAtTime(1, t + 0.08);
  }
}
