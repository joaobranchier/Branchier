/**
 * voices.js — one synthesis class per family of siren.
 *
 * The sweeping tones are built the analogue way: a low-frequency oscillator
 * modulating the carrier's frequency AudioParam through a gain node whose
 * value is the sweep depth in hertz. That is glitch-free and runs forever
 * without a scheduler, which matters because a siren is held down for
 * minutes, not milliseconds.
 *
 *   LFO ─► depth (Hz) ─┬─► carrierA.frequency   (base = centre)
 *                      └─► carrierB.frequency   (base = centre + detune)
 *
 * Two carriers a few hertz apart reproduce the beating of a real two-driver
 * speaker pair. It is a small detail that does a lot of the realism.
 */

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * LFO shape tables
 * ------------------------------------------------------------------ */

/**
 * Asymmetric triangle: rises over `r` of the period, falls over the rest.
 *
 * The closed-form sine-only series for this shape is wrong here — an
 * asymmetric triangle is not an odd function, so it needs cosine terms too.
 * Integrating the exact waveform numerically gets both, and it is done once
 * per distinct shape at startup, so the cost never shows up while playing.
 */
const _waveCache = new Map();

function asymTriangleWave(ctx, r, harmonics = 64, samples = 2048) {
  const key = `${r}:${harmonics}`;
  const cached = _waveCache.get(key);
  if (cached && cached.ctx === ctx) return cached.wave;

  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const scale = 2 / samples;

  for (let i = 0; i < samples; i++) {
    const ph = i / samples;
    // -1 .. +1, peaking at phase r
    const v = (ph < r ? ph / r : 1 - (ph - r) / (1 - r)) * 2 - 1;
    for (let n = 1; n <= harmonics; n++) {
      const a = TAU * n * ph;
      real[n] += v * Math.cos(a) * scale;
      imag[n] += v * Math.sin(a) * scale;
    }
  }

  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  _waveCache.set(key, { ctx, wave });
  return wave;
}

/** Base class: owns an output gain and the bookkeeping to tear itself down. */
class Voice {
  constructor(engine, spec) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.spec = spec;
    this.nodes = [];
    this.out = this.ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(engine.bus);
    this.startedAt = 0;
    this.rateFactor = 1;
    this.stopped = false;
  }

  _track(node) { this.nodes.push(node); return node; }

  _osc(type, freq) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type);
    o.frequency.value = freq;
    return this._track(o);
  }

  _gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return this._track(g);
  }

  /** Pink-noise source for air rush / rotor turbulence. */
  _noise(level, filterHz) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = filterHz;
    bp.Q.value = 0.8;
    const g = this._gain(level);
    src.connect(bp).connect(g);
    this._track(src);
    this._track(bp);
    return { src, gain: g, filter: bp };
  }

  fadeIn(t, seconds = 0.03, to = 1) {
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(to * (this.spec.gain ?? 1), t + seconds);
  }

  /** Rate trim from the MOD button. Overridden where a rate exists. */
  setRate(factor) { this.rateFactor = factor; }

  /** Current fundamental in Hz, for the LCD. Overridden per family. */
  frequency() { return 0; }

  stop(when) {
    if (this.stopped) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    const rel = (this.spec.releaseMs ?? 40) / 1000;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + rel);
    this._teardown(t + rel + 0.05);
  }

  _teardown(at) {
    for (const n of this.nodes) {
      try { n.stop?.(at); } catch { /* already stopped */ }
    }
    setTimeout(() => {
      for (const n of this.nodes) { try { n.disconnect(); } catch {} }
      try { this.out.disconnect(); } catch {}
      this.nodes.length = 0;
    }, Math.max(0, (at - this.ctx.currentTime) * 1000) + 120);
  }
}

/* ------------------------------------------------------------------ *
 * Sweeping and two-tone sirens (wail, yelp, phaser, wa-wa, hi-lo)
 * ------------------------------------------------------------------ */

export class SweepVoice extends Voice {
  constructor(engine, spec) {
    super(engine, spec);
    const ctx = this.ctx;
    const s = spec;
    const wave = engine.waves[s.wave] || engine.waves.siren;

    this.centre = (s.lo + s.hi) / 2;
    this.depth = (s.hi - s.lo) / 2;

    // --- the two carriers -------------------------------------------
    this.carrierA = this._osc(wave, this.centre);
    this.carrierB = this._osc(wave, this.centre + (s.detune ?? 0));
    const mixA = this._gain(0.58);
    const mixB = this._gain(0.42);
    this.carrierA.connect(mixA);
    this.carrierB.connect(mixB);

    // --- the sweep LFO ------------------------------------------------
    this.lfo = ctx.createOscillator();
    this._track(this.lfo);
    this.lfo.frequency.value = s.rateHz;

    if (s.shape === 'sq') {
      // Hi-Lo does not sweep: it jumps. A square LFO through a lowpass gives
      // the few milliseconds of glide a real trumpet pair actually takes.
      this.lfo.type = 'square';
      const glide = ctx.createBiquadFilter();
      glide.type = 'lowpass';
      glide.frequency.value = 1000 / (TAU * (s.glideMs ?? 18));
      glide.Q.value = 0.707;
      this.depthNode = this._gain(this.depth);
      this.lfo.connect(glide).connect(this.depthNode);
      this._track(glide);
    } else {
      this.lfo.setPeriodicWave(asymTriangleWave(ctx, s.shape === 'ramp' ? (s.riseRatio ?? 0.68) : 0.5));
      this.depthNode = this._gain(this.depth);
      this.lfo.connect(this.depthNode);
    }

    // One modulation signal, both carriers — they stay in lockstep and keep
    // their fixed offset, which is exactly how a two-speaker rig behaves.
    this.depthNode.connect(this.carrierA.frequency);
    this.depthNode.connect(this.carrierB.frequency);

    // --- optional amplitude gate (phaser, wa-wa) ------------------------
    let tail = this._gain(1);
    mixA.connect(tail);
    mixB.connect(tail);

    if (s.gate) {
      const gateGain = this._gain(1 - s.gate.depth / 2);
      this.gateLfo = ctx.createOscillator();
      this._track(this.gateLfo);
      this.gateLfo.type = 'sine';
      this.gateLfo.frequency.value = s.gate.rateHz;
      const gateDepth = this._gain(s.gate.depth / 2);
      this.gateLfo.connect(gateDepth).connect(gateGain.gain);
      tail.connect(gateGain);
      tail = gateGain;
    }

    tail.connect(this.out);
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.carrierA.start(t);
    this.carrierB.start(t);
    this.lfo.start(t);
    this.gateLfo?.start(t);
    this.fadeIn(t, 0.04);
  }

  setRate(factor) {
    this.rateFactor = factor;
    const t = this.ctx.currentTime;
    this.lfo.frequency.setTargetAtTime(this.spec.rateHz * factor, t, 0.05);
    this.gateLfo?.frequency.setTargetAtTime(this.spec.gate.rateHz * factor, t, 0.05);
  }

  /** Re-derives the LFO position from elapsed time so the LCD tracks the tone. */
  frequency() {
    const s = this.spec;
    const phase = ((this.ctx.currentTime - this.startedAt) * s.rateHz * this.rateFactor) % 1;
    if (s.shape === 'sq') return phase < 0.5 ? s.hi : s.lo;
    const r = s.shape === 'ramp' ? (s.riseRatio ?? 0.68) : 0.5;
    const tri = phase < r ? phase / r : 1 - (phase - r) / (1 - r);
    return s.lo + tri * (s.hi - s.lo);
  }
}

/* ------------------------------------------------------------------ *
 * Air horn
 * ------------------------------------------------------------------ */

export class HornVoice extends Voice {
  constructor(engine, spec) {
    super(engine, spec);
    const s = spec;
    const wave = engine.waves[s.wave] || engine.waves.horn;
    this.bells = [];

    for (const bell of s.bells) {
      const osc = this._osc(wave, bell.hz);
      osc.detune.value = bell.detune * 100 * 0.01; // cents of shimmer between trumpets
      // The three bells sum, so each is scaled to leave the chord under unity.
      const g = this._gain(bell.gain * 0.38);
      osc.connect(g).connect(this.out);
      this.bells.push({ osc, gain: g, hz: bell.hz });
    }

    // The hiss of air escaping the diaphragm, brightest at the onset.
    this.air = this._noise(0, s.bells[0].hz * 3);
    this.air.gain.connect(this.out);
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    const s = this.spec;
    const atk = s.attackMs / 1000;

    for (const b of this.bells) {
      b.osc.start(t);
      // Pressure builds: the bell starts flat and pulls up into tune.
      const from = b.hz * Math.pow(2, -s.scoopSemis / 12);
      b.osc.frequency.setValueAtTime(from, t);
      b.osc.frequency.exponentialRampToValueAtTime(b.hz, t + atk * 2.4);
    }

    this.air.src.start(t);
    // A burst of air at the start, then it settles to a steady hiss.
    this.air.gain.gain.setValueAtTime(0, t);
    this.air.gain.gain.linearRampToValueAtTime(this.spec.airNoise, t + atk * 0.5);
    this.air.gain.gain.setTargetAtTime(this.spec.airNoise * 0.32, t + atk, 0.12);

    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(this.spec.gain, t + atk);
  }

  stop(when) {
    if (this.stopped) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    const rel = this.spec.releaseMs / 1000;

    // Air bleeds out, so the pitch sags as the note dies.
    for (const b of this.bells) {
      const to = b.hz * Math.pow(2, -this.spec.droopSemis / 12);
      b.osc.frequency.cancelScheduledValues(t);
      b.osc.frequency.setValueAtTime(b.osc.frequency.value, t);
      b.osc.frequency.exponentialRampToValueAtTime(to, t + rel);
    }
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + rel);
    this._teardown(t + rel + 0.05);
  }

  frequency() { return this.spec.bells[0].hz; }
}

/* ------------------------------------------------------------------ *
 * Mechanical (Federal Signal Q-siren)
 * ------------------------------------------------------------------ */

export class MechanicalVoice extends Voice {
  constructor(engine, spec) {
    super(engine, spec);
    const wave = engine.waves[spec.wave] || engine.waves.mech;
    this.carrier = this._osc(wave, 1);
    this.carrierGain = this._gain(0);
    this.carrier.connect(this.carrierGain).connect(this.out);

    // Rotor turbulence: a rotating chopper moves a lot of air, and the noise
    // rises with speed just like the tone does.
    this.air = this._noise(0, 900);
    this.air.gain.connect(this.out);

    this.phase = 'idle';
    this.phaseStart = 0;
  }

  /** f = (rotor rpm / 60) × ports — the actual physics of a ported rotor. */
  _hzFor(rpm) { return Math.max(1, (rpm / 60) * this.spec.ports); }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    const s = this.spec;
    this.startedAt = t;
    this.phase = 'up';
    this.phaseStart = t;

    this.carrier.start(t);
    this.air.src.start(t);

    const peak = this._hzFor(s.runRpm);
    const idle = this._hzFor(60);
    this.carrier.frequency.setValueAtTime(idle, t);
    // A loaded motor accelerates fast then tapers, which an exponential ramp
    // in frequency models closely enough to be convincing.
    this.carrier.frequency.exponentialRampToValueAtTime(peak * 0.72, t + s.spinUpS * 0.42);
    this.carrier.frequency.exponentialRampToValueAtTime(peak, t + s.spinUpS);

    // The tone emerges out of the noise as the rotor comes up to speed: at
    // low rpm a real Q is mostly the sound of air being moved, and the
    // chopped tone only takes over once the ports are cutting fast enough.
    this.carrierGain.gain.setValueAtTime(0.12, t);
    this.carrierGain.gain.linearRampToValueAtTime(1, t + s.spinUpS * 0.75);

    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(s.gain * 0.35, t + 0.6);
    this.out.gain.linearRampToValueAtTime(s.gain, t + s.spinUpS * 0.8);

    // Turbulence rises in pitch with the rotor, same as the tone does.
    this.air.filter.frequency.setValueAtTime(idle * 6, t);
    this.air.filter.frequency.exponentialRampToValueAtTime(peak * 1.6, t + s.spinUpS);
    this.air.gain.gain.setValueAtTime(s.airNoise * 0.8, t);
    this.air.gain.gain.linearRampToValueAtTime(s.airNoise, t + s.spinUpS * 0.7);
  }

  /** Cut power: the coaster clutch lets it freewheel down for many seconds. */
  stop(when) {
    if (this.stopped) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    const s = this.spec;
    this.coastFrom = this.frequency();
    this.phase = 'down';
    this.phaseStart = t;

    const floor = this._hzFor(40);
    this.carrier.frequency.cancelScheduledValues(t);
    this.carrier.frequency.setValueAtTime(Math.max(floor, this.coastFrom), t);
    this.carrier.frequency.exponentialRampToValueAtTime(floor, t + s.coastDownS);

    this.carrierGain.gain.cancelScheduledValues(t);
    this.carrierGain.gain.setValueAtTime(this.carrierGain.gain.value, t);
    this.carrierGain.gain.linearRampToValueAtTime(0.1, t + s.coastDownS);

    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.setTargetAtTime(0, t + s.coastDownS * 0.45, s.coastDownS * 0.22);

    this.air.filter.frequency.cancelScheduledValues(t);
    this.air.filter.frequency.setValueAtTime(this.air.filter.frequency.value, t);
    this.air.filter.frequency.exponentialRampToValueAtTime(floor * 6, t + s.coastDownS);
    this.air.gain.gain.cancelScheduledValues(t);
    this.air.gain.gain.setValueAtTime(this.air.gain.gain.value, t);
    this.air.gain.gain.linearRampToValueAtTime(0, t + s.coastDownS * 0.9);

    this._teardown(t + s.coastDownS + 0.4);
  }

  frequency() {
    const s = this.spec;
    const el = this.ctx.currentTime - this.phaseStart;
    const peak = this._hzFor(s.runRpm);
    if (this.phase === 'up') {
      const k = Math.min(1, el / s.spinUpS);
      return this._hzFor(60) * Math.pow(peak / this._hzFor(60), k);
    }
    if (this.phase === 'down') {
      const k = Math.min(1, el / s.coastDownS);
      const from = Math.max(1, this.coastFrom ?? peak);
      return from * Math.pow(this._hzFor(40) / from, k);
    }
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Manual wail — pitch follows the button
 * ------------------------------------------------------------------ */

export class ManualVoice extends Voice {
  constructor(engine, spec) {
    super(engine, spec);
    const wave = engine.waves[spec.wave] || engine.waves.siren;
    this.a = this._osc(wave, spec.lo);
    this.b = this._osc(wave, spec.lo + (spec.detune ?? 0));
    const ga = this._gain(0.58);
    const gb = this._gain(0.42);
    this.a.connect(ga).connect(this.out);
    this.b.connect(gb).connect(this.out);
    this.target = spec.lo;
    this.rampStart = 0;
    this.rampFrom = spec.lo;
    this.rampTo = spec.lo;
    this.rampS = 0;
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.a.start(t);
    this.b.start(t);
    this.fadeIn(t, 0.05);
    this.rise(t);
  }

  /** Finger down — wind it up. */
  rise(when) {
    const t = when ?? this.ctx.currentTime;
    this._rampTo(this.spec.hi, this.spec.riseS, t);
  }

  /** Finger up — let it fall away. */
  fall(when) {
    const t = when ?? this.ctx.currentTime;
    this._rampTo(this.spec.lo, this.spec.fallS, t);
  }

  _rampTo(to, seconds, t) {
    const from = this.frequency();
    // Scale the time by how far there is left to travel, so a short tap
    // does not take the full rise time to come back down.
    const span = Math.abs(this.spec.hi - this.spec.lo);
    const dur = Math.max(0.08, seconds * (Math.abs(to - from) / span));
    this.rampFrom = from; this.rampTo = to; this.rampS = dur; this.rampStart = t;
    const d = this.spec.detune ?? 0;
    for (const [osc, off] of [[this.a, 0], [this.b, d]]) {
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(from + off, t);
      osc.frequency.exponentialRampToValueAtTime(to + off, t + dur);
    }
  }

  frequency() {
    if (!this.rampS) return this.rampFrom;
    const k = Math.min(1, (this.ctx.currentTime - this.rampStart) / this.rampS);
    return this.rampFrom * Math.pow(this.rampTo / this.rampFrom, k);
  }
}

/* ------------------------------------------------------------------ *
 * Rumbler — low-frequency companion layer
 * ------------------------------------------------------------------ */

export class RumbleVoice extends Voice {
  /**
   * @param source the spec of the siren currently running, so the rumble
   *               tracks it instead of droning at a fixed pitch.
   */
  constructor(engine, spec, source) {
    super(engine, spec);
    const wave = engine.waves[spec.wave] || engine.waves.rumble;
    const src = source ?? { lo: 725, hi: 1800, rateHz: 0.25, shape: 'tri' };

    // Pick the octave division that lands the tone inside the Rumbler's own
    // 182–400 Hz working band, whatever the parent siren is doing.
    const centre = (src.lo + src.hi) / 2;
    let div = 2;
    while (centre / div > 400 && div < 32) div *= 2;
    const lo = Math.max(spec.lo, src.lo / div);
    const hi = Math.min(spec.hi, src.hi / div);

    this.lo = lo; this.hi = hi; this.rate = src.rateHz ?? 0.25; this.shape = src.shape ?? 'tri';
    const mid = (lo + hi) / 2;

    this.carrier = this._osc(wave, mid);
    this.carrier.connect(this.out);

    if (hi - lo > 2) {
      this.lfo = this.ctx.createOscillator();
      this._track(this.lfo);
      this.lfo.frequency.value = this.rate;
      if (this.shape === 'sq') this.lfo.type = 'square';
      else this.lfo.setPeriodicWave(asymTriangleWave(this.ctx, this.shape === 'ramp' ? 0.68 : 0.5));
      const depth = this._gain((hi - lo) / 2);
      this.lfo.connect(depth).connect(this.carrier.frequency);
    }
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.carrier.start(t);
    this.lfo?.start(t);
    this.fadeIn(t, 0.12);
  }

  setRate(factor) {
    this.rateFactor = factor;
    this.lfo?.frequency.setTargetAtTime(this.rate * factor, this.ctx.currentTime, 0.05);
  }

  frequency() { return (this.lo + this.hi) / 2; }
}

/** Factory: picks the right class for a tone spec. */
export function createVoice(engine, spec, context = {}) {
  switch (spec.kind) {
    case 'sweep':
    case 'twotone':   return new SweepVoice(engine, spec);
    case 'horn':      return new HornVoice(engine, spec);
    case 'mechanical':return new MechanicalVoice(engine, spec);
    case 'manual':    return new ManualVoice(engine, spec);
    case 'rumble':    return new RumbleVoice(engine, spec, context.source);
    default: throw new Error(`Tipo de voz desconhecido: ${spec.kind}`);
  }
}
