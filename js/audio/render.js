/**
 * render.js — the sound sources, computed sample by sample.
 *
 * Each function returns raw source material. The horn/driver colouration and
 * the room are applied afterwards in the graph, shared by every voice, which
 * keeps a pitch-shifted voice (the manual wail) from dragging the horn's
 * fixed resonances around with it.
 *
 * Returned shape:
 *   { data, loopStart, release? }   — `data` is attack-then-loop in one
 *   buffer, `loopStart` is the sample the loop returns to, and `release` is
 *   a separate one-shot for tones that ring out under their own physics.
 */

import {
  TAU, rng, pinkNoise, drift, harmonicSum, pulseHarmonics, squareHarmonics,
  normalize, fadeEdges, crossfadeLoop, sealLoopTail, lowpass, highpass, bandpass, chain,
} from './dsp.js';

const MAX_H = 48;

/* ------------------------------------------------------------------ *
 * Sweep shape
 * ------------------------------------------------------------------ */

/** Normalised 0..1 sweep position at phase `ph` (0..1) of the cycle. */
function sweepAt(ph, shape, rise) {
  if (shape === 'sq') return ph < 0.5 ? 1 : 0;
  return ph < rise ? ph / rise : 1 - (ph - rise) / (1 - rise);
}

/**
 * Picks a loop length whose total carrier phase is a whole number of cycles.
 *
 * A swept tone cannot be looped by cutting it at a zero crossing — the
 * waveform is at a different point in its cycle at the end than at the
 * start, and the joint clicks on every repeat. Nudging the period by well
 * under a tenth of a percent makes the accumulated phase land exactly on a
 * cycle boundary, and then the loop is seamless by construction.
 */
function phaseExactPeriod(spec, sr) {
  const shape = spec.shape ?? 'tri';
  const rise = shape === 'ramp' ? (spec.riseRatio ?? 0.68) : 0.5;
  const nominal = Math.max(64, Math.round(sr / spec.rateHz));

  let cycles = 0;
  for (let i = 0; i < nominal; i++) {
    const k = sweepAt(i / nominal, shape, rise);
    cycles += (spec.lo + k * (spec.hi - spec.lo)) / sr;
  }
  const target = Math.max(1, Math.round(cycles));
  return { n: Math.max(64, Math.round(nominal * target / cycles)), shape, rise };
}

/* ------------------------------------------------------------------ *
 * Electronic siren head
 * ------------------------------------------------------------------ */

/**
 * A PA300-class siren is a tone generator driving a power amplifier into a
 * compression driver. The drive waveform is squared off, not sinusoidal,
 * which is where the strong third harmonic that siren detectors key on comes
 * from. Harmonics are summed explicitly and dropped as they pass Nyquist, so
 * the sweep never folds anything back down as a wrong note.
 */
export function renderSiren(spec, sr) {
  const { n, shape, rise } = phaseExactPeriod(spec, sr);

  // Enough whole sweep cycles to make a loop of reasonable length. A phaser
  // cycle is 46 ms; looping one of those alone would need a crossfade longer
  // than the cycle itself.
  const reps = Math.max(1, Math.ceil((sr * 0.45) / n));
  const L = n * reps;
  // 20 ms of overlap: long enough to hide the fact that a swept waveform
  // can never line up with itself, short enough to be inaudible as a fade.
  const xf = Math.min(Math.round(sr * 0.020), L >> 3);

  const warm = 2 * n;               // let the tone settle before the loop starts
  const total = warm + L + xf;
  const raw = new Float32Array(L + xf);

  const amps = squareHarmonics(MAX_H);
  // A touch of even harmonics: the driver is not symmetric, and a pure odd
  // series sounds hollow in a way real siren heads do not.
  amps[2] = 0.22; amps[4] = 0.08; amps[6] = 0.04;

  const nyq = sr * 0.5;
  const rand = rng(0x5117e2);
  const wobble = drift(rand, 3.2, sr, 0.0016);   // the head's own tiny instability

  let ph = 0;
  for (let i = 0; i < total; i++) {
    const k = sweepAt((i % n) / n, shape, rise);
    const f = (spec.lo + k * (spec.hi - spec.lo)) * (1 + wobble());
    ph += TAU * f / sr;
    if (ph > TAU) ph -= TAU;

    if (i >= warm) {
      // Amplitude tracks the driver's efficiency, which falls at the bottom
      // of the sweep — a real head is quieter down low, and flattening that
      // out is part of what made the first version sound mechanical.
      raw[i - warm] = harmonicSum(ph, amps, f, nyq) * (0.78 + 0.22 * k);
    }
  }

  if (spec.gate) applyGate(raw, spec.gate, sr, L);
  // The tail past L is blended onto the head, so the buffer keeps its exact
  // period and the joint is inaudible even though a swept waveform can never
  // line up perfectly with itself.
  return { data: normalize(crossfadeLoop(raw, sr, (xf / sr) * 1000), 0.85), loopStart: 0 };
}

/** Amplitude pulsing locked to the sweep, for the phaser and wa-wa. */
function applyGate(buf, gate, sr, loopLen) {
  const depth = gate.depth;
  // Rounded so a whole number of pulses fits the loop. Left as specified it
  // would be cut mid-pulse and click on every repeat; the adjustment is a
  // fraction of a percent.
  const cycles = Math.max(1, Math.round((gate.rateHz * loopLen) / sr));
  const rate = (cycles * sr) / loopLen;
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= 1 - depth / 2 + (depth / 2) * Math.sin(TAU * rate * i / sr);
  }
}

/* ------------------------------------------------------------------ *
 * Air horn — a reed chopping an airstream
 * ------------------------------------------------------------------ */

/**
 * The part the first version got wrong outright.
 *
 * An air horn is not three smooth brass-like tones. It is a reed being
 * slammed open and shut by air pressure, chopping the stream into pressure
 * pulses — "an approximate square waveform", with abundant high harmonics.
 * Three things follow from that, and all three are audible:
 *
 *  - The duty cycle narrows as pressure builds, so the tone brightens
 *    through the attack instead of just getting louder.
 *  - The reed does not repeat perfectly. Per-period jitter is the rasp.
 *  - Turbulence is strongest while the reed is open, so the air noise is
 *    modulated by the pulse itself rather than sitting underneath it.
 */
export function renderHorn(spec, sr) {
  const attackS = 0.11;
  const loopS = 0.5;
  const releaseS = (spec.releaseMs ?? 180) / 1000 + 0.12;

  const nA = Math.round(sr * attackS);
  const nL = Math.round(sr * loopS);
  const nR = Math.round(sr * releaseS);

  const body = new Float32Array(nA + nL);
  const rel = new Float32Array(nR);
  const nyq = sr * 0.5;

  // Pressure over time: rises fast, overshoots slightly, settles.
  const pressureAt = (t) => {
    if (t >= attackS) return 1;
    const k = t / attackS;
    return Math.min(1, 1.12 * (1 - Math.exp(-4.2 * k)));
  };

  spec.bells.forEach((bell, bi) => {
    const rand = rng(0x1a2b3c + bi * 7919);
    const noise = pinkNoise(rand);
    const pitchDrift = drift(rand, 5.5, sr, 0.004);
    const jitter = rng(0xbeef + bi * 131);

    let ph = 0;
    let lastPh = 0;

    const run = (buf, offset, releasing) => {
      for (let i = 0; i < buf.length; i++) {
        const t = (offset + i) / sr;
        const p = releasing
          ? Math.max(0, 1 - (i / nR) * 1.25)
          : pressureAt(t);

        // Pitch rises into tune as pressure builds and sags as it bleeds off.
        const f = bell.hz * (1 - (1 - p) * 0.06) * (1 + pitchDrift());
        // The reed shuts harder the more pressure is behind it.
        const duty = 0.5 - 0.17 * p;
        const amps = pulseHarmonics(duty, MAX_H);

        // Per-period jitter: the reed is never quite periodic, and this is
        // what is heard as rasp rather than as a clean tone.
        const inc = TAU * f / sr * (1 + jitter() * 0.0025);
        ph += inc;
        if (ph > TAU) { ph -= TAU; lastPh = ph; }

        const pulse = harmonicSum(ph, amps, f, nyq);
        // Open-reed gate: turbulence rides the airflow, not the silence.
        const open = 0.5 + 0.5 * Math.sign(pulse) * Math.min(1, Math.abs(pulse));
        const air = noise() * (0.10 + 0.34 * open) * p * (spec.airNoise ?? 0.25);

        buf[i] += (pulse * 0.72 + air) * p * bell.gain;
      }
    };

    run(body, 0, false);
    run(rel, nA + nL, true);
  });

  // The trumpet's own resonances: fixed by its bore, so they colour every
  // bell the same way rather than following each one's pitch.
  chain(body, highpass(sr, 150, 0.8), bandpass(sr, 900, 0.55));
  chain(rel, highpass(sr, 150, 0.8), bandpass(sr, 900, 0.55));

  const out = body.slice(0, nA + nL);
  sealLoopTail(out, nA, Math.round(sr * 0.006));
  normalize(out, 0.88);
  normalize(rel, 0.55);
  for (let i = 0; i < Math.round(sr * 0.002); i++) out[i] *= i / Math.round(sr * 0.002);
  fadeEdges(rel, sr, 3);

  return { data: out, loopStart: nA, release: rel };
}

/* ------------------------------------------------------------------ *
 * Mechanical siren — a rotor chopping air
 * ------------------------------------------------------------------ */

/**
 * A Q-siren has no electronics in it at all: a motor spins a 14-port rotor
 * past a stator, and each port lines up once per revolution to let a slug of
 * air through. So the tone is a very narrow pulse train, and the air being
 * chopped is as much of the sound as the pitch is — which is why it reads as
 * a machine moving air rather than as a loudspeaker.
 */
export function renderMech(spec, sr) {
  const peak = (spec.runRpm / 60) * spec.ports;
  const idle = (60 / 60) * spec.ports;
  const spin = spec.spinUpS;
  const coast = spec.coastDownS;

  const nA = Math.round(sr * spin);
  // Whole rotor revolutions at full speed, so the steady loop closes cleanly.
  const nL = Math.round(Math.round((0.6 * peak)) * sr / peak);
  const nR = Math.round(sr * coast);
  const xf = Math.round(sr * 0.006);

  const body = new Float32Array(nA + nL + xf);
  const rel = new Float32Array(nR);
  const nyq = sr * 0.5;
  const rand = rng(0x9f1c33);
  const noise = pinkNoise(rand);

  // The rotor is narrow-ported, so the duty cycle is small and the series
  // runs long — that dense harmonic stack is the Q's scream.
  const amps = pulseHarmonics(0.16, MAX_H);

  const rpmCurve = (t) => {
    const knee = spin * 0.42;
    if (t <= knee) return idle * Math.pow(peak * 0.72 / idle, t / knee);
    if (t < spin) return peak * 0.72 * Math.pow(peak / (peak * 0.72), (t - knee) / (spin - knee));
    return peak;
  };

  let ph = 0;
  for (let i = 0; i < body.length; i++) {
    const f = rpmCurve(i / sr);
    ph += TAU * f / sr;
    if (ph > TAU) ph -= TAU;
    const pulse = harmonicSum(ph, amps, f, nyq);
    const speed = Math.min(1, f / peak);
    // Air first, tone second: at low rotor speed a Q is mostly the sound of
    // a lot of air being shifted, and the pitch only takes over at speed.
    const air = noise() * (0.55 - 0.30 * speed) * spec.airNoise;
    body[i] = (pulse * (0.25 + 0.75 * speed) + air * (0.4 + 0.6 * speed)) * Math.min(1, 0.25 + i / (sr * 0.8));
  }

  for (let i = 0; i < rel.length; i++) {
    const k = i / rel.length;
    const f = Math.max(idle * 0.5, peak * Math.pow((40 / 60) * spec.ports / peak, k));
    ph += TAU * f / sr;
    if (ph > TAU) ph -= TAU;
    const pulse = harmonicSum(ph, amps, f, nyq);
    const speed = Math.min(1, f / peak);
    const air = noise() * (0.55 - 0.30 * speed) * spec.airNoise;
    const env = Math.pow(1 - k, 0.7);
    rel[i] = (pulse * (0.25 + 0.75 * speed) + air * (0.4 + 0.6 * speed)) * env;
  }

  chain(body, highpass(sr, 180, 0.7));
  chain(rel, highpass(sr, 180, 0.7));

  // Seal only the wrap; the spin-up ahead of it is played once and its join
  // into the loop must stay exactly as it was rendered.
  const out = body.slice(0, nA + nL);
  sealLoopTail(out, nA, xf);
  normalize(out, 0.86);
  normalize(rel, 0.7);
  fadeEdges(rel, sr, 6);
  for (let i = 0; i < Math.round(sr * 0.003); i++) out[i] *= i / Math.round(sr * 0.003);

  return { data: out, loopStart: nA, release: rel };
}

/* ------------------------------------------------------------------ *
 * Steady tone for the manual wail
 * ------------------------------------------------------------------ */

/**
 * The manual wail follows a finger, so it cannot be a fixed sweep. A steady
 * tone is rendered once and the pitch is driven by playback rate, which is
 * what a siren head does anyway: the same generator, run faster.
 */
export function renderSteady(baseHz, sr) {
  const cycles = 64;
  const n = Math.round(sr * cycles / baseHz);
  const out = new Float32Array(n);
  const amps = squareHarmonics(MAX_H);
  amps[2] = 0.20; amps[4] = 0.07;
  const nyq = sr * 0.5;

  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += TAU * baseHz / sr;
    if (ph > TAU) ph -= TAU;
    out[i] = harmonicSum(ph, amps, baseHz, nyq);
  }
  return { data: normalize(out, 0.85), loopStart: 0 };
}

/* ------------------------------------------------------------------ *
 * Low-frequency companion
 * ------------------------------------------------------------------ */

/** A sub layer that follows the siren above it, two octaves down. */
export function renderRumble(spec, source, sr) {
  const src = {
    lo: Math.max(spec.lo, (source?.lo ?? 725) / 4),
    hi: Math.min(spec.hi, Math.max((source?.hi ?? 1800) / 4, spec.lo + 1)),
    rateHz: source?.rateHz || 0.25,
    shape: source?.shape ?? 'tri',
    riseRatio: source?.riseRatio,
  };
  const { n, shape, rise } = phaseExactPeriod(src, sr);
  const nyq = sr * 0.5;
  // Mostly fundamental: this layer exists to be felt through a car body, and
  // a phone speaker reproduces none of it directly, so the low harmonics are
  // what carry the impression.
  const amps = new Float64Array(9);
  amps[1] = 1; amps[2] = 0.40; amps[3] = 0.22; amps[4] = 0.10;

  const xf = Math.min(Math.round(sr * 0.020), n >> 3);
  const raw = new Float32Array(n + xf);
  const warm = n;
  let ph = 0;
  for (let i = 0; i < warm + n + xf; i++) {
    const k = sweepAt((i % n) / n, shape, rise);
    const f = src.lo + k * (src.hi - src.lo);
    ph += TAU * f / sr;
    if (ph > TAU) ph -= TAU;
    if (i >= warm) raw[i - warm] = harmonicSum(ph, amps, f, nyq);
  }
  return { data: normalize(crossfadeLoop(raw, sr, (xf / sr) * 1000), 0.9), loopStart: 0 };
}

/* ------------------------------------------------------------------ *
 * Street reflections
 * ------------------------------------------------------------------ */

/**
 * A short impulse response. Nothing outdoors is heard dry: a siren in a
 * street arrives with a handful of hard early reflections off buildings and
 * road, and then very little tail. Adding even a small amount of this does
 * more for believability than any amount of spectral tweaking, because a
 * perfectly dry tone is the one thing a real one never is.
 */
export function renderStreetIR(sr, seconds = 0.5) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const rand = rng(0x51ee7);

  // Discrete early reflections, in milliseconds and relative level.
  const taps = [
    [11, 0.52], [17, -0.41], [26, 0.34], [38, -0.27],
    [53, 0.21], [71, -0.16], [96, 0.12], [128, -0.09],
  ];
  for (const [ms, g] of taps) {
    const i = Math.round(sr * ms / 1000);
    if (i < n) out[i] += g;
  }

  // A thin diffuse tail behind them.
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] += rand() * 0.16 * Math.exp(-t * 7.5);
  }

  // Reflections off brick and tarmac lose their top end.
  chain(out, lowpass(sr, 3800, 0.8), highpass(sr, 220, 0.7));
  return normalize(out, 0.5);
}
