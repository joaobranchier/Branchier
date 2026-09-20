/**
 * engine.js — AudioContext lifecycle, the master chain, and the iOS
 * workarounds that make any of this audible on an iPhone.
 *
 * Signal flow:
 *
 *   voice ─► its own radiator stage ─► panelBus ─┬─► dry ──────────────┐
 *                                                └─► send ─► convolver ┤
 *   guide preview ─────────────────► previewBus ─┬─► dry ──────────────┤
 *                                                └─► send ─► convolver ┤
 *                                                                      ▼
 *                        tone stack (HIGH / BASS) ─► master ─► limiter ─► ceiling ─► out
 *
 * Two things that used to be here are gone. A 6:1 compressor sat across the
 * whole mix and pumped in step with every sweep, and a tanh stage sat
 * downstream of two detuned carriers, so it generated intermodulation
 * between them rather than the grit it was meant to. Distortion now happens
 * inside each voice, where a driver actually distorts, and the master chain
 * only shapes tone and guards the ceiling.
 */

import { makeCeilingCurve } from './waves.js';
import { renderStreetIR, renderClick } from './render.js';

/** HIGH and BASS select one of four voicings. Pure tone shaping: the horn
 *  and driver response belong to the voice now, not to the master bus. */
const VOICINGS = {
  '00': { low: 0,   high: 0,   label: 'FLAT' },
  '10': { low: -6,  high: 5.5, label: 'HIGH' },
  '01': { low: 9,   high: -3,  label: 'BASS' },
  '11': { low: 6,   high: 4,   label: 'FULL' },
};

const RAMP = 0.035;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.ready = false;
    this._silentEl = null;
    this._volume = 0.85;
    this._high = false;
    this._bass = false;
    this._onStateChange = null;
    this._unlocking = null;
  }

  async unlock() {
    // Two keys pressed together both call this before either resolves, and
    // without the shared promise that builds a second AudioContext.
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

    // Claim the 'playback' audio session BEFORE the context is created.
    // Without this Safari files a bare AudioContext under 'ambient', which
    // the hardware ring/silent switch mutes outright. Safari 16.4+.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported — the silent-element fallback below covers it */ }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API indisponível neste navegador.');

    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this._startSilentKeepalive();
    await this.ctx.resume().catch(() => {});
    this._buildChain();

    this.ctx.addEventListener?.('statechange', () => {
      this._onStateChange?.(this.ctx.state);
    });

    this.ready = true;
    return this.ctx;
  }

  onStateChange(fn) { this._onStateChange = fn; }

  /**
   * Builds the chain around a context handed in from outside.
   *
   * The point is an OfflineAudioContext: it renders this exact graph — the
   * radiator, the reflections, the tone stack, the limiter and the ceiling —
   * to a buffer that can be looked at. Everything downstream of a voice used
   * to be describable only in prose, and prose is how a master chain ends up
   * quietly changing the timbre of every tone in the app.
   */
  attachContext(ctx) {
    this.ctx = ctx;
    this._buildChain();
    this.ready = true;
    return ctx;
  }

  _startSilentKeepalive() {
    if (this._silentEl) return;
    const el = document.createElement('audio');
    el.setAttribute('playsinline', '');
    el.loop = true;
    el.volume = 0.001; // not 0: some iOS builds skip processing a muted element
    el.src = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQ4AAAAAAAAAAAAAAAAAAAAAAA==';
    el.play().catch(() => {});
    this._silentEl = el;
  }

  _buildChain() {
    const ctx = this.ctx;

    this.voiceSum = ctx.createGain();

    // --- street reflections ------------------------------------------
    // Nothing outdoors is heard dry. A siren in a street arrives with a
    // handful of hard reflections off buildings and road; adding even a
    // little does more for believability than any spectral tweak, because a
    // perfectly dry tone is the one thing a real one never is.
    this.convolver = ctx.createConvolver();
    const ir = renderStreetIR(ctx.sampleRate, 0.45);
    const irBuf = ctx.createBuffer(1, ir.length, ctx.sampleRate);
    irBuf.getChannelData(0).set(ir);
    this.convolver.buffer = irBuf;
    this.convolver.normalize = false;

    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.convolver.connect(this.wet).connect(this.voiceSum);

    // --- two source buses, each with its own dry and send -------------
    // Ducking a bus takes its reflections with it, which is what the guide's
    // preview needs: the faceplate has to disappear completely, not linger
    // as a reverb tail under the tone being auditioned.
    const makeBus = () => {
      const bus = ctx.createGain();
      const dry = ctx.createGain();
      const send = ctx.createGain();
      dry.gain.value = 1;
      send.gain.value = 0.32;
      bus.connect(dry).connect(this.voiceSum);
      bus.connect(send).connect(this.convolver);
      return bus;
    };
    this.panelBus = makeBus();
    this.previewBus = makeBus();

    // --- HIGH / BASS ---------------------------------------------------
    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 240;

    this.highShelf = ctx.createBiquadFilter();
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 3200;

    this.master = ctx.createGain();
    this.master.gain.value = this._volume;

    // A fast brickwall so layering — MIX, or siren plus rumble plus horn —
    // can never clip the DAC.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.06;

    // The compressor above is a limiter, not a brickwall: a fast transient
    // slips past its attack. This guarantees the sample itself stays in range.
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = makeCeilingCurve();
    this.ceiling.oversample = '2x';

    // --- the panel's own noise ------------------------------------------
    // Joined to the master directly, past voiceSum and the tone stack. Two
    // reasons: a key click is not a siren and has no business being shaped
    // like one, and STOP mutes voiceSum for a moment — which would have
    // swallowed the click of the very key that did it.
    this.ui = ctx.createGain();
    this.ui.gain.value = 0.3;
    this.ui.connect(this.master);

    const toBuffer = (r) => {
      const b = ctx.createBuffer(1, r.data.length, ctx.sampleRate);
      b.getChannelData(0).set(r.data);
      return b;
    };
    this._clicks = {
      down: toBuffer(renderClick(ctx.sampleRate, 'down')),
      up: toBuffer(renderClick(ctx.sampleRate, 'up')),
    };

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;

    this.voiceSum
      .connect(this.lowShelf).connect(this.highShelf)
      .connect(this.master).connect(this.limiter)
      .connect(this.ceiling).connect(ctx.destination);

    this.ceiling.connect(this.analyser);
    this._applyVoicing(0);
  }

  /** Where a faceplate voice connects. */
  get bus() { return this.panelBus; }

  /** Where a tone being auditioned in the guide connects. */
  get preview() { return this.previewBus; }

  /** Fades the faceplate out while the guide auditions a tone. */
  duckPanel(on) {
    if (!this.ready) return;
    this.panelBus.gain.setTargetAtTime(on ? 0 : 1, this.now, 0.03);
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  setVolume(v) {
    // A corrupt stored preference used to arrive here as NaN, and an
    // AudioParam given NaN throws rather than ignoring it.
    this._volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
    if (this.ready) this.master.gain.setTargetAtTime(this._volume, this.now, 0.02);
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
    set(this.lowShelf.gain, v.low);
    set(this.highShelf.gain, v.high);
  }

  /**
   * A key click. `down` on the way in, `up` for a momentary key letting go.
   *
   * Deliberately fire-and-forget: it must never be able to throw into a key
   * press, and it must never wait for anything, because the whole value of
   * the sound is that it lands at the same instant as the finger.
   */
  click(kind = 'down') {
    if (!this.ready || !this._clicks?.[kind]) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this._clicks[kind];
      src.connect(this.ui);
      src.start();
    } catch { /* a click is never worth interrupting a siren for */ }
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
   * anything that escaped its bookkeeping.
   */
  panic() {
    if (!this.ready) return;
    const t = this.now;
    this.panelBus.gain.cancelScheduledValues(t);
    this.panelBus.gain.setValueAtTime(1, t);
    this.voiceSum.gain.cancelScheduledValues(t);
    this.voiceSum.gain.setValueAtTime(this.voiceSum.gain.value, t);
    this.voiceSum.gain.linearRampToValueAtTime(0, t + 0.012);
    this.voiceSum.gain.setValueAtTime(1, t + 0.08);
  }
}
