/**
 * voices.js — one playing voice per sounding tone.
 *
 * The sound itself is computed in render.js as plain arithmetic over a
 * Float32Array; a voice's job is to put that buffer into the graph, give it
 * the radiator it belongs to, and drive its envelope.
 *
 * What lives where matters here. The things a real object does per sample —
 * a reed's jitter, turbulence gated by the airflow, band-limited harmonics
 * that drop partials as they pass Nyquist — are baked into the buffer. The
 * things that are just a filter — the horn's fixed resonances, the driver's
 * distortion — stay in the graph, so a voice whose pitch is driven by
 * playback rate does not drag them around with it.
 */

import { driverClip } from './dsp.js';
import {
  renderSiren, renderHorn, renderMechSteady, renderSteady, renderRumble,
} from './render.js';

/* ------------------------------------------------------------------ *
 * Radiator voicings
 * ------------------------------------------------------------------ */

/**
 * One per family, because these are not the same object. A siren head is a
 * compression driver on a horn. An air horn is a flaring trumpet whose
 * fundamental is the whole point. A Q is a rotor in a steel housing. Running
 * all three through the siren-speaker curve — which an earlier version did —
 * filtered a trumpet tuned to 311 Hz away from its own fundamental.
 *
 * The siren curve below was rebuilt after the rendered output was measured
 * rather than described. It had been doing three things wrong at once:
 *
 *  - a 4 dB dip at 700 Hz, right on the bottom of every wail's sweep, which
 *    duplicated an amplitude tilt renderSiren already applies for the same
 *    physical reason (a driver is less efficient low down) and so charged
 *    the fundamental twice for it;
 *  - boosts of 5.5 and 4 dB at 1250 and 2600 Hz, which sat on the harmonics
 *    rather than the fundamental. Measured over a whole sweep, 54% of a
 *    wail's energy landed above 1250 Hz and only 34% below it;
 *  - a low-pass at 7800 Hz, which let a mathematically perfect square's
 *    harmonic stack through to a place no compression driver can radiate.
 *
 * What replaces it is the same device heard where you would actually hear
 * it. A re-entrant siren horn is sharply directional up high, so from down
 * the street and off its axis the top falls away while the fundamental does
 * not — that is why a real siren outdoors is rounder than a siren aimed at
 * your face. The shelf is that slope. And the destination is a phone
 * speaker, which reproduces nothing under about 500 Hz and exaggerates
 * 2–5 kHz, so the harshness had to come out of exactly the band the
 * old curve was boosting. Same sweep now measures 57% below 1250 Hz and 4%
 * above 2500.
 *
 * How far to tilt it was settled by ear against four candidates rendered
 * through this exact chain, which is the only instrument that can answer
 * it — the curve that measures most faithfully and the curve that sounds
 * like the thing are not the same curve, because a phone at arm's length is
 * not a hundred-decibel horn on a roof, and the ear's own response is not
 * the same at those two levels.
 *
 * It fixes the gain staging as a side effect: one siren used to arrive at
 * the master limiter already above its threshold, so the limiter ran
 * constantly and squashed the crest factor by 2 dB. A single voice now peaks
 * at 0.72 and the limiter is back to being protection against MIX stacking
 * rather than a compressor that is always on.
 */
export const VOICING = {
  siren:  { drive: 1.22, lowCut: 200, lowQ: 0.7, highCut: 3000, highQ: 0.6,
            tilt: [900, -7.5], trim: 1.8,
            bands: [[2800, 1.0, -6]] },
  horn:   { drive: 1.15, lowCut: 130, highCut: 6800,
            bands: [[480, 1.0, 3], [1400, 1.3, 2]] },
  mech:   { drive: 1.3,  lowCut: 190, highCut: 8200,
            bands: [[900, 0.9, 3], [2000, 1.4, 2]] },
  rumble: { drive: 1.1,  lowCut: 70,  highCut: 1200,
            bands: [[160, 0.9, 3]] },
};

/** Shaper curves are identical per family, so they are built once. */
const curveCache = new Map();
function driveCurve(drive) {
  let c = curveCache.get(drive);
  if (!c) {
    const n = 2048;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = driverClip((i / (n - 1)) * 2 - 1, drive);
    curveCache.set(drive, c);
  }
  return c;
}

/* ------------------------------------------------------------------ *
 * Rendered buffer cache
 * ------------------------------------------------------------------ */

const bufferCache = new Map();

function toAudioBuffer(ctx, rendered) {
  const buf = ctx.createBuffer(1, rendered.data.length, ctx.sampleRate);
  buf.getChannelData(0).set(rendered.data);
  const out = { buffer: buf, loopStart: (rendered.loopStart ?? 0) / ctx.sampleRate };
  if (rendered.release) {
    const rel = ctx.createBuffer(1, rendered.release.length, ctx.sampleRate);
    rel.getChannelData(0).set(rendered.release);
    out.release = rel;
  }
  if (rendered.peakHz) out.peakHz = rendered.peakHz;
  return out;
}

/**
 * Renders a tone, or returns the copy made earlier. Keyed by sample rate as
 * well as by tone: a phone that opens at 44.1 kHz and a desktop at 48 kHz
 * need different buffers, and an AudioBuffer at the wrong rate plays at the
 * wrong pitch.
 */
export function getBuffers(engine, spec, opts = {}) {
  const sr = engine.ctx.sampleRate;
  const key = `${spec.id}:${sr}:${opts.rate ?? 1}:${opts.sourceId ?? ''}`;
  let hit = bufferCache.get(key);
  if (hit) return hit;

  let rendered;
  switch (spec.kind) {
    case 'sweep':
    case 'twotone':
      rendered = renderSiren({ ...spec, rateHz: spec.rateHz * (opts.rate ?? 1) }, sr);
      break;
    case 'horn':       rendered = renderHorn(spec, sr); break;
    case 'mechanical': rendered = renderMechSteady(spec, sr); break;
    case 'manual':     rendered = renderSteady(spec.lo, sr); break;
    case 'rumble':     rendered = renderRumble(spec, opts.source, sr); break;
    default: throw new Error(`Tipo de voz desconhecido: ${spec.kind}`);
  }

  hit = toAudioBuffer(engine.ctx, rendered);
  bufferCache.set(key, hit);
  return hit;
}

/**
 * Yields to the browser between tones. requestIdleCallback takes an options
 * object as its second argument, not a delay — passing setTimeout's number
 * throws, and since this runs inside the audio unlock, that exception took
 * the first key press down with it.
 */
const whenIdle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 250 })
  : setTimeout(fn, 1));

/** Renders everything ahead of time, a tone per idle slice. */
export function prewarm(engine, tones, sourceForRumble) {
  const list = Object.values(tones);
  let i = 0;
  const step = () => {
    if (i >= list.length) return;
    const spec = list[i++];
    try {
      getBuffers(engine, spec, spec.kind === 'rumble' ? { source: sourceForRumble } : {});
    } catch { /* a tone that cannot be pre-rendered will render on demand */ }
    whenIdle(step);
  };
  whenIdle(step);
}

/* ------------------------------------------------------------------ *
 * Voice
 * ------------------------------------------------------------------ */

class Voice {
  constructor(engine, spec, family, opts = {}) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.spec = spec;
    this.family = family;
    this.startedAt = 0;
    this.stopped = false;
    this.killed = false;
    this.rateFactor = 1;
    this._nodes = [];

    const ctx = this.ctx;
    const v = VOICING[family];

    this.out = ctx.createGain();
    this.out.gain.value = 0;

    /**
     * How loud this voice ends up. The tone's own gain, times the family's
     * trim — which exists so that changing a radiator's response does not
     * silently change how loud that family is, and so the gain staging into
     * the master limiter can be set deliberately rather than inherited from
     * whatever the filters happened to do.
     */
    this.level = (spec.gain ?? 1) * (v.trim ?? 1);

    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(v.drive);
    shaper.oversample = '2x';

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = v.lowCut; hp.Q.value = v.lowQ ?? 0.72;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = v.highCut; lp.Q.value = v.highQ ?? 0.7;

    let node = shaper;
    node.connect(hp);
    node = hp;

    // The spectral tilt of the thing doing the radiating, as distinct from
    // the resonances: a horn in a street heard off its axis is not a horn
    // pointed at your face, and the difference is a slope, not a bump.
    //
    // Written as a shelf that takes the top down rather than one that lifts
    // the bottom. The two are the same curve to within a constant, but a
    // boost adds gain, and gain here is headroom taken away from the master
    // limiter — the tilt would have quietly put the limiter back to work on
    // every single tone, which is the thing it was just got off.
    if (v.tilt) {
      const sh = ctx.createBiquadFilter();
      sh.type = 'highshelf';
      sh.frequency.value = v.tilt[0];
      sh.gain.value = v.tilt[1];
      node.connect(sh);
      node = sh;
      this._nodes.push(sh);
    }

    for (const [f, q, g] of v.bands) {
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking'; pk.frequency.value = f; pk.Q.value = q; pk.gain.value = g;
      node.connect(pk);
      node = pk;
      this._nodes.push(pk);
    }
    node.connect(lp).connect(this.out);
    this.out.connect(opts.bus ?? engine.bus);

    this.head = shaper;
    this._nodes.push(shaper, hp, lp, this.out);
  }

  _source(buffers, loop = true) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffers.buffer;
    if (loop) {
      src.loop = true;
      src.loopStart = buffers.loopStart;
      src.loopEnd = buffers.buffer.duration;
    }
    src.connect(this.head);
    this._sources = this._sources || [];
    this._sources.push(src);
    return src;
  }

  fadeIn(t, seconds = 0.02) {
    const g = this.level;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(g, t + seconds);
  }

  /**
   * Immediate silence — what STOP and the power key need. Deliberately not
   * guarded on `stopped`: a voice in its release tail is exactly what this
   * is for, and a Q's tail is half a minute long.
   */
  kill(when) {
    if (this.killed) return;
    this.killed = true;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.012);
    this._teardown(t + 0.06);
  }

  stop(when) {
    if (this.stopped || this.killed) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    const rel = (this.spec.releaseMs ?? 40) / 1000;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + rel);
    this._teardown(t + rel + 0.05);
  }

  _teardown(at) {
    for (const s of this._sources ?? []) {
      try { s.stop(at); } catch { /* already stopped */ }
    }
    setTimeout(() => {
      for (const s of this._sources ?? []) { try { s.disconnect(); } catch {} }
      for (const n of this._nodes) { try { n.disconnect(); } catch {} }
      this._nodes.length = 0;
      this._sources = [];
    }, Math.max(0, (at - this.ctx.currentTime) * 1000) + 120);
  }

  /**
   * How long this voice stays audible after an ordinary release.
   *
   * The voice knows, and the spec does not always: a horn's release is a
   * rendered buffer whose length is a property of the render, not a number
   * anyone wrote down. The controller arms its watchdog from this, so a
   * value that is too small cuts a release short and one that is too large
   * delays the backstop — it is worth asking the object itself.
   */
  get tailS() { return (this.spec.releaseMs ?? 40) / 1000; }

  setRate(factor) { this.rateFactor = factor; }
  frequency() { return 0; }
}

/* ------------------------------------------------------------------ *
 * Sweeping and two-tone sirens
 * ------------------------------------------------------------------ */

class SweepVoice extends Voice {
  constructor(engine, spec, opts) {
    super(engine, spec, 'siren', opts);
    this.opts = opts;
    this.buffers = getBuffers(engine, spec, { rate: 1 });
    this.src = this._source(this.buffers);
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.src.start(t);
    this.fadeIn(t, 0.03);
  }

  /**
   * MOD trims the sweep rate, which means a different buffer rather than a
   * different playback rate — resampling would carry the pitch with it and
   * a wail swept faster is not a wail transposed up.
   */
  setRate(factor) {
    if (factor === this.rateFactor || this.killed || this.stopped) return;
    this.rateFactor = factor;
    const t = this.ctx.currentTime;
    const next = getBuffers(this.engine, this.spec, { rate: factor });
    const src = this._source(next);
    const old = this.src;
    this.src = src;
    this.buffers = next;
    // Swapped under a short crossfade so the change is heard as a change of
    // rate and not as a gap.
    src.start(t);
    try { old.stop(t + 0.05); } catch {}
    this.startedAt = t;
  }

  frequency() {
    const s = this.spec;
    const rate = s.rateHz * this.rateFactor;
    const phase = ((this.ctx.currentTime - this.startedAt) * rate) % 1;
    if (s.shape === 'sq') return phase < 0.5 ? s.hi : s.lo;
    const r = s.shape === 'ramp' ? (s.riseRatio ?? 0.68) : 0.5;
    const tri = phase < r ? phase / r : 1 - (phase - r) / (1 - r);
    return s.lo + tri * (s.hi - s.lo);
  }
}

/* ------------------------------------------------------------------ *
 * Air horn
 * ------------------------------------------------------------------ */

class HornVoice extends Voice {
  constructor(engine, spec, opts) {
    super(engine, spec, 'horn', opts);
    this.buffers = getBuffers(engine, spec);
    this.src = this._source(this.buffers);
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.src.start(t);
    // The buffer carries its own attack, so the gain only needs to arrive.
    this.out.gain.setValueAtTime(this.level, t);
  }

  stop(when) {
    if (this.stopped || this.killed) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    // The release was rendered as a continuation of the same reed, so the
    // pressure bleeds off and the pitch sags exactly as it was computed.
    if (this.buffers.release) {
      const rel = this.ctx.createBufferSource();
      rel.buffer = this.buffers.release;
      rel.connect(this.head);
      this._sources.push(rel);
      rel.start(t);
      try { this.src.stop(t + 0.004); } catch {}
      this._teardown(t + this.buffers.release.duration + 0.05);
    } else {
      super.stop(when);
    }
  }

  get tailS() {
    return this.buffers.release ? this.buffers.release.duration : super.tailS;
  }

  frequency() { return this.spec.bells[0].hz; }
}

/* ------------------------------------------------------------------ *
 * Mechanical siren
 * ------------------------------------------------------------------ */

/**
 * Only the steady state is rendered; the wind-up and the coast-down are
 * playback-rate ramps over that loop. On a real siren everything scales with
 * rotor speed at once — pitch, the harmonics above it, and the rate at which
 * the air is chopped — which is precisely what changing the playback rate
 * does, and it is also why a thirty-second coast costs no memory.
 */
class MechVoice extends Voice {
  constructor(engine, spec, opts) {
    super(engine, spec, 'mech', opts);
    this.buffers = getBuffers(engine, spec);
    this.peak = this.buffers.peakHz ?? (spec.runRpm / 60) * spec.ports;
    this.src = this._source(this.buffers);
    this.startRate = 70 / this.peak;
    this.floorRate = 90 / this.peak;
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    const s = this.spec;
    this.src.playbackRate.setValueAtTime(this.startRate, t);
    // Two to three seconds of wind-up, per the published figure. A motor has
    // most of its torque at stall, so it gains speed fast and then tapers.
    this.src.playbackRate.exponentialRampToValueAtTime(0.72, t + s.spinUpS * 0.42);
    this.src.playbackRate.exponentialRampToValueAtTime(1, t + s.spinUpS);
    this.src.start(t);
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(this.level * 0.5, t + 0.25);
    this.out.gain.linearRampToValueAtTime(this.level, t + s.spinUpS * 0.7);
    this.phase = 'up';
  }

  stop(when) {
    if (this.stopped || this.killed) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    const s = this.spec;
    this.coastFrom = this.frequency(t);
    this.phase = 'down';
    this.phaseStart = t;

    // The coaster clutch is the whole point of a Q: power comes off and it
    // freewheels down for the better part of a minute.
    const from = Math.max(this.floorRate, this.coastFrom / this.peak);
    this.src.playbackRate.cancelScheduledValues(t);
    this.src.playbackRate.setValueAtTime(from, t);
    this.src.playbackRate.exponentialRampToValueAtTime(this.floorRate, t + s.coastDownS);

    // A coasting Q gets quieter as it slows. The old envelope held full
    // volume for thirteen seconds and then approached zero asymptotically,
    // so it was still at about a tenth of full level when teardown cut it —
    // loud enough to bury whatever came next, and a click at the end.
    const g0 = Math.max(0.0002, this.out.gain.value);
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(g0, t);
    this.out.gain.setValueAtTime(g0, t + s.coastDownS * 0.12);
    this.out.gain.exponentialRampToValueAtTime(g0 * 0.0016, t + s.coastDownS * 0.96);
    // exponentialRampToValueAtTime cannot reach zero; this last hair of a
    // ramp is what makes the end silence rather than a step.
    this.out.gain.linearRampToValueAtTime(0, t + s.coastDownS);
    this._teardown(t + s.coastDownS + 0.1);
  }

  get tailS() { return this.spec.coastDownS; }

  frequency(at) {
    const s = this.spec;
    const now = at ?? this.ctx.currentTime;
    if (this.phase === 'down') {
      const k = Math.min(1, Math.max(0, (now - this.phaseStart) / s.coastDownS));
      const from = Math.max(90, this.coastFrom ?? this.peak);
      return from * Math.pow(90 / from, k);
    }
    const el = now - this.startedAt;
    const knee = s.spinUpS * 0.42;
    const start = 70;
    if (el <= 0) return start;
    if (el <= knee) return start * Math.pow(this.peak * 0.72 / start, el / knee);
    if (el < s.spinUpS) {
      return this.peak * 0.72 * Math.pow(1 / 0.72, (el - knee) / (s.spinUpS - knee));
    }
    return this.peak;
  }
}

/* ------------------------------------------------------------------ *
 * Manual wail
 * ------------------------------------------------------------------ */

/** Pitch follows the finger, so the steady loop is driven by playback rate. */
class ManualVoice extends Voice {
  constructor(engine, spec, opts) {
    super(engine, spec, 'siren', opts);
    this.buffers = getBuffers(engine, spec);
    this.base = spec.lo;
    this.src = this._source(this.buffers);
    this.rampFrom = spec.lo;
    this.rampTo = spec.lo;
    this.rampS = 0;
    this.rampStart = 0;
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.src.playbackRate.setValueAtTime(1, t);
    this.src.start(t);
    this.fadeIn(t, 0.04);
    this.rise(t);
  }

  rise(when) { this._glide(this.spec.hi, this.spec.riseS, when); }

  /**
   * Release: the pitch falls away and the voice goes silent at the bottom.
   *
   * All of it is scheduled here, in one go, on the audio clock. The first
   * version let the pitch fall and then silenced the voice from a setTimeout
   * three and a half seconds later — and a JavaScript timer is not a
   * promise. iOS throttles and drops them in a backgrounded or idle web app,
   * and when that one was dropped the fall still happened, because the fall
   * is audio-thread automation, and the note then held its bottom note
   * forever with nothing coming to end it. "It sounds like it is about to
   * stop, and then it never does" is exactly that shape.
   *
   * Nothing in this path can be dropped now: once the automation is on the
   * AudioParam and stop() is on the source, the audio thread owns the rest
   * whatever the main thread does.
   */
  stop(when) {
    if (this.stopped || this.killed) return;
    this.stopped = true;
    const t = when ?? this.ctx.currentTime;
    const dur = this._glide(this.spec.lo, this.spec.fallS, t);

    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    // Full level through most of the fall — a manual wail is loud on the way
    // down — then out over the last fifth of it.
    g.setValueAtTime(g.value, t + dur * 0.8);
    g.linearRampToValueAtTime(0, t + dur);
    this._teardown(t + dur + 0.05);
  }

  /** @returns {number} how long the glide will take, in seconds. */
  _glide(to, seconds, when) {
    const t = when ?? this.ctx.currentTime;
    const from = this.frequency();
    // Scaled by how far there is left to travel, so a short tap does not
    // take the full time to come back down.
    const span = Math.abs(this.spec.hi - this.spec.lo);
    const dur = Math.max(0.08, seconds * (Math.abs(to - from) / span));
    this.rampFrom = from; this.rampTo = to; this.rampS = dur; this.rampStart = t;
    this.src.playbackRate.cancelScheduledValues(t);
    this.src.playbackRate.setValueAtTime(from / this.base, t);
    this.src.playbackRate.exponentialRampToValueAtTime(to / this.base, t + dur);
    return dur;
  }

  get tailS() { return this.spec.fallS; }

  frequency() {
    if (!this.rampS) return this.rampFrom;
    const k = Math.min(1, (this.ctx.currentTime - this.rampStart) / this.rampS);
    return this.rampFrom * Math.pow(this.rampTo / this.rampFrom, k);
  }
}

/* ------------------------------------------------------------------ *
 * Low-frequency companion
 * ------------------------------------------------------------------ */

class RumbleVoice extends Voice {
  constructor(engine, spec, source, opts) {
    super(engine, spec, 'rumble', opts);
    this.source = source;
    this.buffers = getBuffers(engine, spec, { source, sourceId: source?.id });
    this.src = this._source(this.buffers);
    this.mid = (spec.lo + spec.hi) / 2;
  }

  start(when) {
    const t = when ?? this.ctx.currentTime;
    this.startedAt = t;
    this.src.start(t);
    this.fadeIn(t, 0.1);
  }

  frequency() { return this.mid; }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createVoice(engine, spec, context = {}) {
  const opts = { bus: context.bus };
  switch (spec.kind) {
    case 'sweep':
    case 'twotone':    return new SweepVoice(engine, spec, opts);
    case 'horn':       return new HornVoice(engine, spec, opts);
    case 'mechanical': return new MechVoice(engine, spec, opts);
    case 'manual':     return new ManualVoice(engine, spec, opts);
    case 'rumble':     return new RumbleVoice(engine, spec, context.source, opts);
    default: throw new Error(`Tipo de voz desconhecido: ${spec.kind}`);
  }
}
