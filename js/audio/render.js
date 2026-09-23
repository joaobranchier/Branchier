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
  TAU, rng, pinkNoise, drift, harmonicSum, pulseHarmonics, squareHarmonics, triangleHarmonics,
  normalize, fadeEdges, crossfadeLoop, sealLoopTail, lowpass, highpass, peaking, chain,
} from './dsp.js';

const MAX_H = 48;

/**
 * Harmonic tables for a range of duty cycles, computed once.
 *
 * The reed's open fraction changes continuously with pressure, and building
 * a fresh table every sample meant fifty sines per sample purely to describe
 * the shape. Quantising the duty into small steps is inaudible — the change
 * across one step is far below what the ear resolves — and takes the render
 * from two hundred milliseconds to ten.
 */
const DUTY_STEPS = 128;
const dutyTables = [];
function dutyHarmonics(duty) {
  const i = Math.max(0, Math.min(DUTY_STEPS - 1, Math.round(duty * DUTY_STEPS)));
  return dutyTables[i] ?? (dutyTables[i] = pulseHarmonics(i / DUTY_STEPS, MAX_H));
}

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
  //
  // `cycle` is the length of one sweep in samples. The voice needs it to know
  // where in the sweep it is, so that MOD can hand over to a faster or slower
  // buffer at the same point instead of starting the sweep again from the
  // bottom.
  return {
    data: normalize(crossfadeLoop(raw, sr, (xf / sr) * 1000), 0.85),
    loopStart: 0,
    cycle: n,
  };
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
  // The spec has declared an attack all along and this used a fixed sixty
  // milliseconds regardless, so the number in the tone table was decoration.
  const attackS = (spec.attackMs ?? 60) / 1000;
  const loopS = 0.5;
  const releaseS = (spec.releaseMs ?? 180) / 1000 + 0.12;

  const nA = Math.round(sr * attackS);
  const nL = Math.round(sr * loopS);
  const nR = Math.round(sr * releaseS);

  const body = new Float32Array(nA + nL);
  const rel = new Float32Array(nR);
  const nyq = sr * 0.5;

  const pressureAt = (t) => (t >= attackS ? 1 : Math.min(1, 1.1 * (1 - Math.exp(-6.5 * t / attackS))));
  const scoop = Math.pow(2, -(spec.scoopSemis ?? 0.5) / 12);

  spec.bells.forEach((bell, bi) => {
    const rand = rng(0x1a2b3c + bi * 7919);
    const noise = pinkNoise(rand);
    const pitchDrift = drift(rand, 5.5, sr, 0.0035);
    const jitter = rng(0xbeef + bi * 131);

    let ph = 0;

    const run = (buf, releasing) => {
      for (let i = 0; i < buf.length; i++) {
        const p = releasing
          ? Math.max(0, 1 - (i / nR) * 1.25)
          : pressureAt(i / sr);

        // Pitch pulls into tune as pressure builds, sags as it bleeds away.
        const f = bell.hz * (scoop + (1 - scoop) * p) * (1 + pitchDrift());
        // The reed shuts harder the more pressure is behind it, so the open
        // fraction narrows and the tone brightens through the attack rather
        // than merely getting louder. A horn asked to be steady rather than
        // to bark does less of this.
        const duty = 0.5 - (spec.bite ?? 0.16) * p;
        const amps = dutyHarmonics(duty);

        // The reed is never quite periodic, and that is the rasp.
        ph += (TAU * f / sr) * (1 + jitter() * (spec.rasp ?? 0.003));
        if (ph > TAU) ph -= TAU;

        const tone = harmonicSum(ph, amps, f, nyq);
        // Turbulence rides the airflow: loud while the reed is open, gone
        // while it is shut. Gated by the ideal opening rather than by the
        // band-limited tone, which rings past the edges.
        const open = (ph / TAU) < duty ? 1 : 0.12;
        const air = noise() * open * p * (spec.airNoise ?? 0.25) * 1.6;

        buf[i] += (tone * 0.68 + air) * p * bell.gain;
      }
    };

    run(body, false);
    run(rel, true);
  });

  // The flare's own resonances, placed relative to the note the horn is
  // tuned to rather than at fixed frequencies. A horn that plays lower is a
  // bigger horn, and a bigger horn's resonances are lower too — pinning them
  // in hertz meant that retuning the bells left the body behind, with the
  // high-pass climbing onto the fundamental of anything deep.
  const f0 = Math.min(...spec.bells.map((b) => b.hz));
  const voice = (b) => chain(b,
    highpass(sr, f0 * 0.48, 0.7),
    peaking(sr, f0 * 1.8, 1.1, 3.5),
    peaking(sr, f0 * 3.7, 1.4, 2.8),
    peaking(sr, f0 * 7.4, 1.8, 2.2),
    lowpass(sr, spec.topHz ?? 6800, 0.7));
  voice(body);
  voice(rel);

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
 * past a stator, and each alignment lets a slug of air through. The air
 * being chopped is as much of the sound as the pitch is, which is why it
 * reads as a machine moving air rather than as a loudspeaker.
 *
 * Only the steady state is rendered. The wind-up and the long coast-down are
 * playback-rate ramps over this loop, which is both cheaper — a thirty
 * second coast would otherwise be a six megabyte buffer — and truer, since
 * on a real siren every part of the spectrum scales with rotor speed
 * together, which is exactly what changing the playback rate does.
 */
export function renderMechSteady(spec, sr) {
  const peak = (spec.runRpm / 60) * spec.ports;

  // A whole number of rotor revolutions, so the loop closes on itself.
  const revs = Math.max(8, Math.round(0.35 * peak));
  const n = Math.round((revs * sr) / peak);
  const xf = Math.min(Math.round(sr * 0.008), n >> 3);

  const raw = new Float32Array(n + xf);
  const nyq = sr * 0.5;
  const rand = rng(0x9f1c33);
  const noise = pinkNoise(rand);

  // A Q has 14 ports on the rotor and 14 on the stator, the same width, so
  // the open area grows and shrinks linearly as they sweep past each other:
  // a triangle, asymmetric because the rotor only turns one way.
  //
  // But the radiated sound is not that triangle. Sound pressure comes from
  // the rate of change of volume flow, and the derivative of a triangle is a
  // square — asymmetric here, so rich in both odd and even harmonics, which
  // is exactly how the real thing is described. Rendering the triangle
  // itself gave a fundamental and almost nothing above it, and a Q is not a
  // soft sound. The triangle still gates the air, because that part is the
  // flow rather than the pressure.
  const R = 0.35;
  const amps = pulseHarmonics(R, MAX_H);
  const openAt = (phase) => {
    const u = phase / TAU;
    return u < R ? u / R : 1 - (u - R) / (1 - R);
  };

  let ph = 0;
  for (let i = 0; i < raw.length; i++) {
    ph += TAU * peak / sr;
    if (ph > TAU) ph -= TAU;
    // The rotor chops a continuous airstream, so the turbulence is gated at
    // the port rate rather than sitting underneath as a steady hiss. That
    // chopped air is most of what makes a Q sound like a machine moving air
    // instead of a loudspeaker playing a note.
    raw[i] = harmonicSum(ph, amps, peak, nyq) + noise() * openAt(ph) * spec.airNoise * 1.6;
  }

  chain(raw, highpass(sr, 180, 0.7));
  return {
    data: normalize(crossfadeLoop(raw, sr, (xf / sr) * 1000), 0.86),
    loopStart: 0,
    peakHz: peak,
  };
}

/* ------------------------------------------------------------------ *
 * Steady tone for the manual wail
 * ------------------------------------------------------------------ */

/**
 * The manual wail follows a finger, so it cannot be a fixed sweep. A steady
 * tone is rendered once and the pitch is driven by playback rate, which is
 * what a siren head does anyway: the same generator, run faster.
 *
 * `topHz` is the highest pitch it will be played at. Running a buffer faster
 * moves every harmonic in it up by the same factor, and the ones pushed past
 * Nyquist do not vanish — they fold back down as faint whistles that fall
 * while the siren rises. So only the harmonics that stay below Nyquist at the
 * top of the travel are rendered. What that leaves out at the bottom lives
 * above 8 kHz, where the siren's own radiator has already taken it away.
 */
export function renderSteady(baseHz, sr, topHz = baseHz) {
  const cycles = 64;
  const n = Math.round(sr * cycles / baseHz);
  // Tuned to the buffer rather than the other way round: a whole number of
  // cycles in a whole number of samples is a loop with no joint at all. The
  // correction is a few thousandths of a percent.
  const hz = (cycles * sr) / n;
  const out = new Float32Array(n);
  const amps = squareHarmonics(MAX_H);
  amps[2] = 0.20; amps[4] = 0.07;
  const nyq = sr * 0.5;
  const keep = Math.max(1, Math.floor((nyq * 0.98) / Math.max(topHz, baseHz)));
  for (let k = keep + 1; k < amps.length; k++) amps[k] = 0;

  for (let i = 0; i < n; i++) {
    out[i] = harmonicSum((TAU * hz * (i + 1)) / sr, amps, hz, nyq);
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

/**
 * The same layer as a steady tone, for riding under a voice whose pitch is
 * played rather than swept: the voice's own pitch control drives it, so all
 * it needs is the sound at one pitch. Same harmonic make-up as above, and a
 * whole number of cycles so it loops on itself.
 */
export function renderRumbleSteady(baseHz, sr) {
  const cycles = 32;
  const n = Math.round((sr * cycles) / baseHz);
  const hz = (cycles * sr) / n;
  const amps = new Float64Array(9);
  amps[1] = 1; amps[2] = 0.40; amps[3] = 0.22; amps[4] = 0.10;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = harmonicSum((TAU * hz * (i + 1)) / sr, amps, hz, sr * 0.5);
  return { data: normalize(out, 0.9), loopStart: 0 };
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

/* ------------------------------------------------------------------ *
 * The panel's own noise
 * ------------------------------------------------------------------ */

/**
 * The click a key makes, which is a different kind of sound from a siren.
 *
 * Nothing about it is a siren, so nothing about it goes through a siren's
 * radiator: it is a moulded key on a plastic case, and what you hear is the
 * case answering underneath, the cap's own short ring, and — the part that
 * makes it read as a thing touching a thing rather than as a beep — about
 * two milliseconds of contact scratch on top of both.
 *
 * Modal synthesis, because that is what this is: a handful of decaying
 * sinusoids is an exact description of a small rigid object that has just
 * been struck, and it costs a few thousand samples to render once.
 */
export function renderClick(sr, kind = 'down') {
  const firm = kind === 'down';
  const n = Math.round(sr * (firm ? 0.075 : 0.055));
  const out = new Float32Array(n);
  const noise = pinkNoise(rng(firm ? 0xc1ac : 0x70ac));

  // [hz, decay seconds, amplitude]. The release is duller and shorter: a key
  // coming back up is the spring, not the stop.
  const modes = firm
    ? [[196, 0.034, 0.50], [880, 0.018, 0.40], [1760, 0.009, 0.55], [3300, 0.004, 0.26]]
    : [[173, 0.026, 0.42], [760, 0.013, 0.30], [1500, 0.006, 0.28]];

  const scratchTau = firm ? 0.0016 : 0.0011;
  const scratchAmp = firm ? 0.55 : 0.30;

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const [f, tau, a] of modes) v += a * Math.exp(-t / tau) * Math.sin(TAU * f * t);
    out[i] = v + noise() * scratchAmp * Math.exp(-t / scratchTau);
  }

  // A phone speaker turns everything above this into hiss, and everything
  // below it into nothing at all.
  chain(out, highpass(sr, 110, 0.7), lowpass(sr, 7000, 0.7));
  fadeEdges(out, sr, 1.2);
  return { data: normalize(out, firm ? 0.9 : 0.5), loopStart: 0 };
}
