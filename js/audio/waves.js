/**
 * waves.js — harmonic tables for the oscillators.
 *
 * A siren is never a sine wave. Electronic siren heads drive a compression
 * driver with a squared-off tone, air horns are brass instruments with energy
 * past 5 kHz, and a mechanical siren is a rotor chopping air into a pulse
 * train. Each table below is the harmonic series that gives that character.
 *
 * Tables are amplitude-only (all cosine terms zero), which is fine here:
 * phase is inaudible for steady tones and zero-phase keeps the peak amplitude
 * predictable so the limiter is not surprised.
 */

/** Amplitude of harmonic 1..n. Index 0 is DC and must stay 0. */
const TABLES = {
  /**
   * Electronic siren head. Buzzy and mid-forward — close to a soft sawtooth
   * with the 2nd and 3rd emphasised, which is what the driver's own response
   * does to a squarewave drive signal.
   */
  siren: [
    0, 1.00, 0.55, 0.42, 0.22, 0.18, 0.12, 0.09,
    0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.015, 0.012, 0.01,
  ],

  /**
   * Air horn / European trumpet. Brass: a slow harmonic rolloff that keeps
   * real energy high up, which is why a horn cuts through glass and engine
   * noise the way a sine never could.
   */
  horn: [
    0, 1.00, 0.80, 0.65, 0.50, 0.42, 0.35, 0.28, 0.22,
    0.18, 0.15, 0.125, 0.105, 0.088, 0.074, 0.062, 0.052,
    0.044, 0.037, 0.031, 0.026, 0.022, 0.018, 0.015, 0.013,
  ],

  /**
   * Mechanical (Q-siren) rotor. A 14-port rotor chopping airflow is nearly a
   * pulse train, so the series decays very slowly — that is the source of the
   * Q's famous scream.
   */
  mech: [
    0, 1.00, 0.88, 0.76, 0.66, 0.58, 0.51, 0.45, 0.40,
    0.35, 0.31, 0.27, 0.24, 0.21, 0.185, 0.16, 0.14,
    0.12, 0.105, 0.09, 0.078, 0.067, 0.058, 0.05, 0.043,
    0.037, 0.032, 0.027, 0.023, 0.02, 0.017, 0.014,
  ],

  /**
   * Low-frequency companion. Mostly fundamental with just enough 2nd and 3rd
   * to survive a phone speaker, which reproduces nothing below ~500 Hz — the
   * upper harmonics are what carry the illusion of the missing bass.
   */
  rumble: [
    0, 1.00, 0.48, 0.30, 0.16, 0.10, 0.06, 0.04, 0.025, 0.015,
  ],
};

/**
 * Builds the PeriodicWave objects once per AudioContext and memoises them.
 * @param {BaseAudioContext} ctx
 * @returns {Record<string, PeriodicWave>}
 */
export function buildWaves(ctx) {
  const waves = {};
  for (const [name, harmonics] of Object.entries(TABLES)) {
    const real = new Float32Array(harmonics.length); // all zero: no cosine terms
    const imag = Float32Array.from(harmonics);
    // disableNormalization:false lets the browser scale each table to unit
    // peak, so swapping timbres does not change perceived loudness.
    waves[name] = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }
  return waves;
}

/**
 * Soft-clip transfer curve. Real siren amplifiers are driven into compression;
 * tanh gives that grit without the harsh aliasing of hard clipping.
 * @param {number} drive  1 = almost clean, 4 = pushed hard
 */
export function makeSaturationCurve(drive = 2.2, n = 2048) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

/**
 * Final safety ceiling. A DynamicsCompressor is a limiter, not a brickwall:
 * a fast transient (three air-horn bells hitting together) slips past its
 * attack and lands above full scale, which a DAC reproduces as a click.
 * This stays perfectly linear under 0.70 and soft-knees to a hard asymptote
 * just under 1.0, so the output can never exceed full scale no matter how
 * many voices MIX mode stacks up.
 */
export function makeCeilingCurve(n = 4096, knee = 0.70, ceil = 0.985) {
  const curve = new Float32Array(n);
  const span = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = a <= knee
      ? x
      : Math.sign(x) * (knee + span * Math.tanh((a - knee) / span));
  }
  return curve;
}

/**
 * A band of noise for the air rush of a horn or the turbulence of a rotor.
 * Two seconds is long enough that the loop is not audible as a pattern.
 */
export function makeNoiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Pink-ish noise (Voss-McCartney style running sum) — flat white noise reads
  // as hiss, whereas real air movement has more energy down low.
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.28;
  }
  return buf;
}
