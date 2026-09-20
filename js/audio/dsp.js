/**
 * dsp.js — sample-level building blocks.
 *
 * The first version of this app built its sirens out of OscillatorNodes and
 * BiquadFilterNodes wired together in the audio graph. That approach cannot
 * express the things that actually make these sounds recognisable: an air
 * horn is a reed chopping an airstream, a Q-siren is a rotor chopping air,
 * and both are nonlinear systems whose noise is modulated by the very flow
 * that drives the tone. You cannot wire that; you have to compute it.
 *
 * So everything here works on a Float32Array, sample by sample, and the
 * result is handed to the graph as a finished buffer. That also makes the
 * synthesis pure functions of a spec, which can be measured in a test with
 * no audio context at all.
 */

export const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Biquad filters, applied in place
 * ------------------------------------------------------------------ */

/**
 * Direct-form-I biquad. Coefficients follow the Audio EQ Cookbook, which is
 * what BiquadFilterNode implements, so a filter tuned here behaves the same
 * as one tuned in the graph.
 */
class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  run(buf) {
    for (let i = 0; i < buf.length; i++) buf[i] = this.step(buf[i]);
    return buf;
  }
}

const norm = (b0, b1, b2, a0, a1, a2) =>
  new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);

export function lowpass(sr, f, q = 0.707) {
  const w = TAU * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
}

export function highpass(sr, f, q = 0.707) {
  const w = TAU * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
}

export function bandpass(sr, f, q = 1) {
  const w = TAU * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm(al, 0, -al, 1 + al, -2 * cs, 1 - al);
}

export function peaking(sr, f, q, dbGain) {
  const A = Math.pow(10, dbGain / 40);
  const w = TAU * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
}

/** Runs a chain of filters over a buffer, in order. */
export const chain = (buf, ...filters) => {
  for (const f of filters) f.run(buf);
  return buf;
};

/* ------------------------------------------------------------------ *
 * Band-limited periodic sources
 * ------------------------------------------------------------------ */

/**
 * Harmonic amplitudes for a pulse train of a given duty cycle.
 *
 * A reed or a rotor port does not produce a sine: it opens and shuts, which
 * is a rectangular pressure pulse. Its spectrum is |sin(pi*k*duty)| / k, and
 * a narrow duty puts real energy in the high harmonics — which is exactly
 * the "abundant higher harmonics" a chopped airstream is described as
 * producing, and why a horn cuts through traffic.
 */
export function pulseHarmonics(duty, count) {
  const amps = new Float64Array(count + 1);
  for (let k = 1; k <= count; k++) {
    amps[k] = Math.abs(Math.sin(Math.PI * k * duty)) / k;
  }
  return amps;
}

/**
 * Harmonics of a triangular pulse peaking at `r` of the period.
 *
 * This is the shape a siren rotor actually produces: its ports and the
 * stator's are the same width, so the open area grows and shrinks linearly
 * as they sweep past each other. A symmetric triangle would have only odd
 * harmonics, but the real thing is described as rich in odd *and* even ones,
 * which is what a slightly asymmetric peak gives.
 *
 * Derived by integrating the waveform rather than from a closed form: the
 * usual sine-only series is for a symmetric triangle and puts the peak in
 * the wrong place once `r` moves off centre.
 */
export function triangleHarmonics(r, count, samples = 2048) {
  const re = new Float64Array(count + 1);
  const im = new Float64Array(count + 1);
  const scale = 2 / samples;

  for (let i = 0; i < samples; i++) {
    const ph = i / samples;
    const v = (ph < r ? ph / r : 1 - (ph - r) / (1 - r)) * 2 - 1;
    for (let k = 1; k <= count; k++) {
      const a = TAU * k * ph;
      re[k] += v * Math.cos(a) * scale;
      im[k] += v * Math.sin(a) * scale;
    }
  }

  // Magnitude of the accumulated coefficient. Taking the absolute value
  // inside the sum instead would average |v·sin| over the period, which
  // lands on roughly the same number for every harmonic — a flat spectrum,
  // not a triangle.
  const amps = new Float64Array(count + 1);
  for (let k = 1; k <= count; k++) amps[k] = Math.hypot(re[k], im[k]);
  return amps;
}

/** Square wave: odd harmonics at 1/k. */
export function squareHarmonics(count) {
  const amps = new Float64Array(count + 1);
  for (let k = 1; k <= count; k += 2) amps[k] = 1 / k;
  return amps;
}

/**
 * Evaluates a harmonic series at a phase, dropping anything above Nyquist.
 *
 * Summing harmonics explicitly instead of reading a wavetable is what keeps
 * a swept tone free of aliasing: the harmonic count falls as the fundamental
 * rises, so nothing ever folds back down into the audible band as a wrong
 * note, which is a large part of why naive digital sirens sound cheap.
 */
export function harmonicSum(phase, amps, f0, nyquist) {
  const maxK = Math.min(amps.length - 1, Math.floor(nyquist / Math.max(1, f0)));
  if (maxK < 1) return 0;

  // Chebyshev recurrence: sin(k.p) = 2cos(p).sin((k-1)p) - sin((k-2)p).
  // One sine and one cosine per sample instead of one sine per harmonic,
  // which is what makes rendering a thirty-second coast-down with fifty
  // partials fast enough to do on a phone while someone holds a key.
  const c2 = 2 * Math.cos(phase);
  let prev = 0;
  let cur = Math.sin(phase);
  let acc = amps[1] * cur;
  for (let k = 2; k <= maxK; k++) {
    const next = c2 * cur - prev;
    prev = cur;
    cur = next;
    acc += amps[k] * cur;
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * Noise
 * ------------------------------------------------------------------ */

/** Deterministic PRNG, so a rendered buffer is reproducible for tests. */
export function rng(seed = 0x2f6e2b1) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff * 2 - 1;
  };
}

/** Pink-ish noise: air movement has far more energy low down than hiss does. */
export function pinkNoise(rand) {
  let b0 = 0, b1 = 0, b2 = 0;
  return () => {
    const w = rand();
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.3;
  };
}

/**
 * A slow random walk, for the small instabilities that separate a real
 * sounding object from a synthesiser. Nothing mechanical holds a pitch
 * perfectly, and the ear notices when something does.
 */
export function drift(rand, rateHz, sr, depth) {
  const a = Math.exp(-TAU * rateHz / sr);
  let v = 0;
  return () => {
    v = a * v + (1 - a) * rand();
    return v * depth;
  };
}

/* ------------------------------------------------------------------ *
 * Nonlinearity
 * ------------------------------------------------------------------ */

/**
 * Asymmetric soft clip, modelling a driver pushed hard.
 *
 * Asymmetric on purpose: a diaphragm's suspension is stiffer one way than
 * the other, so it generates even harmonics as well as odd. A symmetric
 * clipper only ever adds odd ones, which is part of why the first version
 * sounded synthetic.
 */
export function driverClip(x, drive = 1.6, asym = 0.18) {
  const b = x * drive + asym;
  const y = b / (1 + Math.abs(b));
  return (y - asym / (1 + Math.abs(asym))) * (1 + Math.abs(asym));
}

/* ------------------------------------------------------------------ *
 * Utility
 * ------------------------------------------------------------------ */

/** Peak-normalises a buffer to `peak`. */
export function normalize(buf, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  if (m < 1e-9) return buf;
  const g = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/** Short fade in and out, so a one-shot never starts or ends on a step. */
export function fadeEdges(buf, sr, ms = 4) {
  const n = Math.min(Math.floor(sr * ms / 1000), buf.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
  return buf;
}

/**
 * Seals the wrap of a buffer that has an unlooped attack in front of it.
 *
 * Blending the loop's own head, as `crossfadeLoop` does, is wrong here: it
 * changes the first sample of the loop and so breaks the join where the
 * attack hands over to it — which is audible as a click on every note, not
 * just on every repeat.
 *
 * The sampler technique instead fades the material immediately *before*
 * loopStart in over the loop's last samples. The attack's own join is left
 * untouched, and the wrap becomes as smooth as that join already was, since
 * both were rendered as one continuous pass.
 */
export function sealLoopTail(buf, loopStart, n) {
  if (loopStart < n || buf.length - loopStart < n * 2) return buf;
  const end = buf.length;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const out = Math.cos(t * Math.PI / 2);
    const inc = Math.sin(t * Math.PI / 2);
    buf[end - n + i] = buf[end - n + i] * out + buf[loopStart - n + i] * inc;
  }
  return buf;
}

/**
 * Equal-power crossfade of the buffer's tail onto its head, so that looping
 * it is inaudible even when the waveform does not line up exactly.
 * Returns the shortened, loopable buffer. Only for buffers looped whole,
 * with no attack in front — otherwise use sealLoopTail.
 */
export function crossfadeLoop(buf, sr, ms = 18) {
  const n = Math.min(Math.floor(sr * ms / 1000), buf.length >> 2);
  if (n < 8) return buf;
  const out = buf.slice(0, buf.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = Math.cos(t * Math.PI / 2);   // outgoing tail
    const b = Math.sin(t * Math.PI / 2);   // incoming head
    out[i] = buf[buf.length - n + i] * a + buf[i] * b;
  }
  return out;
}
