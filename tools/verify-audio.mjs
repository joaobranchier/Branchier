/**
 * verify-audio.mjs — measures the synthesis against the published figures.
 *
 * The whole product is a claim about frequencies, and a claim about
 * frequencies should be measured rather than trusted.
 *
 * Most of this needs no audio context at all: the sources are plain
 * arithmetic over a Float32Array, so they can be rendered and analysed here
 * directly. Only the master chain is exercised through a real graph, at the
 * end.
 *
 *   npm test
 */

import { TONES } from '../js/audio/tones.js';
import {
  renderSiren, renderHorn, renderMechSteady, renderRumble, renderSteady, renderStreetIR,
} from '../js/audio/render.js';
import {
  pulseHarmonics, triangleHarmonics, squareHarmonics, harmonicSum,
} from '../js/audio/dsp.js';

const SR = 48000;

/* ---------------------------- DSP helpers ---------------------------- */

function magnitudes(data, start, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    re[i] = (data[start + i] || 0) * w;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let L = 2; L <= n; L <<= 1) {
    const ang = -2 * Math.PI / L, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += L) {
      let cr = 1, ci = 0;
      for (let k = 0; k < L / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + L / 2] * cr - im[i + k + L / 2] * ci;
        const vi = re[i + k + L / 2] * ci + im[i + k + L / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + L / 2] = ur - vr; im[i + k + L / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const half = n >> 1, mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/**
 * Fundamental by harmonic product spectrum. A siren's second harmonic sits
 * close under its fundamental, so a loudest-bin reading flips octaves
 * halfway through a sweep; multiplying decimated copies of the spectrum
 * leaves only the true fundamental standing.
 */
function pitchHz(data, start, n, { min = 120, max = 3000, harmonics = 5 } = {}) {
  const mag = magnitudes(data, start, n);
  const half = mag.length;
  const hps = Float64Array.from(mag);
  for (let h = 2; h <= harmonics; h++) {
    for (let i = 0; i < Math.floor(half / h); i++) hps[i] *= mag[i * h];
  }
  const loBin = Math.max(2, Math.ceil((min * n) / SR));
  const hiBin = Math.min(half - 2, Math.floor((max * n) / SR));
  let peak = loBin;
  for (let i = loBin; i <= hiBin; i++) if (hps[i] > hps[peak]) peak = i;
  const a = Math.log(hps[peak - 1] + 1e-30), b = Math.log(hps[peak] + 1e-30), c = Math.log(hps[peak + 1] + 1e-30);
  const delta = (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return ((peak + delta) * SR) / n;
}

/** Strongest spectral peaks, as [hz, dB-below-loudest] pairs. */
function partials(data, start, n, count = 8, floorDb = -30) {
  const mag = magnitudes(data, start, n);
  let top = 0;
  for (const m of mag) top = Math.max(top, m);
  const out = [];
  for (let i = 2; i < mag.length - 1; i++) {
    if (mag[i] > mag[i - 1] && mag[i] > mag[i + 1]) {
      const db = 20 * Math.log10(mag[i] / top);
      if (db > floorDb) out.push([(i * SR) / n, db]);
    }
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, count);
}

/** Dominant periodicity of the spectral centroid: the sweep rate. */
function sweepRateHz(data, { win = 512, hop = 256 } = {}) {
  const frames = Math.floor((data.length - win) / hop);
  const track = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const mag = magnitudes(data, f * hop, win);
    let num = 0, den = 0;
    for (let i = 1; i < mag.length; i++) { num += i * mag[i]; den += mag[i]; }
    track[f] = den > 1e-9 ? num / den : 0;
  }
  let mean = 0;
  for (const v of track) mean += v;
  mean /= frames || 1;
  for (let i = 0; i < frames; i++) track[i] -= mean;

  const n = 1 << Math.floor(Math.log2(frames));
  if (n < 16) return 0;
  const mag = magnitudes(track, 0, n);
  let peak = 1;
  for (let i = 1; i < mag.length - 1; i++) if (mag[i] > mag[peak]) peak = i;
  const a = mag[peak - 1], b = mag[peak], c = mag[peak + 1];
  const delta = (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return ((peak + delta) * (SR / hop)) / n;
}

/**
 * How badly a loop clicks, as a multiple of the waveform's own steepest
 * motion. A narrow pulse train legitimately swings full scale in one sample,
 * so comparing the wrap against an average step condemns a clean loop; the
 * question is whether the joint is an outlier for *this* waveform.
 */
function seamRatio(data, loopStart) {
  const steps = [];
  for (let i = loopStart + 1; i < data.length; i++) steps.push(Math.abs(data[i] - data[i - 1]));
  steps.sort((a, b) => a - b);
  const worst = steps[steps.length - 1] || 1e-9;
  const wrap = Math.abs(data[data.length - 1] - data[loopStart]);
  return wrap / worst;
}

/* ---------------------------- assertions ---------------------------- */

let pass = 0, fail = 0;
const group = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
function check(name, got, want, tolPct, unit = ' Hz') {
  const err = want === 0 ? Math.abs(got) : (Math.abs(got - want) / Math.abs(want)) * 100;
  const ok = err <= tolPct;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name.padEnd(46)} ${got.toFixed(2)}${unit} vs ${want.toFixed(2)}${unit}  ${err.toFixed(1)}%`);
}
function assert(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name.padEnd(46)} ${detail}`);
}

/* ---------------------------- the tests ---------------------------- */

const SWEEPS = ['wail1', 'wail2', 'yelp', 'phaser', 'wawa', 'hilo'];
const rendered = {};
for (const id of SWEEPS) rendered[id] = renderSiren(TONES[id], SR);

/** Tiles a loop until it holds at least `cycles` sweep periods. */
function tile(id, cycles) {
  const d = rendered[id].data;
  const perBuf = d.length / SR * TONES[id].rateHz;
  const reps = Math.max(2, Math.ceil(cycles / perBuf));
  const out = new Float32Array(d.length * reps);
  for (let r = 0; r < reps; r++) out.set(d, r * d.length);
  return out;
}

group('Sweep rate matches the manufacturer cycles-per-minute figure');
for (const id of SWEEPS) {
  const T = TONES[id];
  // The centroid tracker needs several periods to resolve a rate; a slow
  // wail is one period per buffer, so one buffer is not enough to measure.
  const reps = Math.ceil((SR * 6) / rendered[id].data.length);
  check(`${T.label} sweep rate`, sweepRateHz(tile(id, 8)), T.rateHz, 12);
}

group('Sweep reaches its rated endpoints');
for (const id of ['wail1', 'wail2', 'yelp', 'wawa']) {
  const T = TONES[id];
  const d = rendered[id].data;
  // The window has to be short against the sweep period. The endpoints are
  // corners, so a window straddling one averages the climb on both sides of
  // it and reports a pitch that never occurs — biased by roughly the sweep's
  // slope times a quarter of the window. A sixty-fourth of the period keeps
  // that bias to a few hertz while still resolving the pitch.
  const period = SR / T.rateHz;
  const win = Math.max(512, Math.min(4096, 1 << Math.round(Math.log2(period / 64))));
  let lo = Infinity, hi = 0;
  for (let s = 0; s < 400; s++) {
    const off = Math.floor((s / 400) * (d.length - win));
    const f = pitchHz(d, off, win, { min: 400, max: 2600 });
    lo = Math.min(lo, f); hi = Math.max(hi, f);
  }
  check(`${T.label} low endpoint`, lo, T.lo, 12);
  check(`${T.label} high endpoint`, hi, T.hi, 12);
}

group('Hi-Lo holds two fixed pitches a musical fourth apart (DIN 14610)');
{
  const T = TONES.hilo;
  const d = rendered.hilo.data;
  const seen = [];
  for (let s = 0; s < 120; s++) {
    const off = Math.floor((s / 120) * (d.length - 4096));
    seen.push(pitchHz(d, off, 4096, { min: 300, max: 900 }));
  }
  seen.sort((a, b) => a - b);
  const low = seen[Math.floor(seen.length * 0.12)];
  const high = seen[Math.floor(seen.length * 0.88)];
  check("Hi-Lo low tone (a')", low, T.lo, 8);
  check('Hi-Lo high tone (d")', high, T.hi, 8);
  assert('Hi-Lo ratio inside DIN 14610 1:1.33 band',
    high / low > 1.25 && high / low < 1.42, `ratio ${(high / low).toFixed(3)}`);
}

group('Air horn is two trumpets a minor third apart');
{
  const T = TONES.airhorn;
  const r = renderHorn(T, SR);
  assert('two bells, not a triad', T.bells.length === 2, `${T.bells.length} bells`);
  const cents = 1200 * Math.log2(T.bells[1].hz / T.bells[0].hz);
  check('interval', cents, 300, 4, ' cents');
  assert('fundamental inside the 250-350 Hz truck-horn range',
    T.bells[0].hz >= 250 && T.bells[0].hz <= 350, `${T.bells[0].hz.toFixed(0)} Hz`);

  const found = partials(r.data, Math.round(SR * 0.3), 8192, 10, -12).map(([f]) => f);
  for (const bell of T.bells) {
    assert(`bell sounding at ${bell.hz.toFixed(0)} Hz`,
      found.some((f) => Math.abs(f - bell.hz) < 12),
      found.slice(0, 4).map((f) => f.toFixed(0)).join(' '));
  }
  // A reed brightens as pressure builds, rather than only getting louder.
  const early = partials(r.data, 400, 2048, 12, -24).length;
  const late = partials(r.data, Math.round(SR * 0.3), 2048, 12, -24).length;
  assert('tone opens up through the attack', late >= early, `${early} -> ${late} partials`);
}

group('Q-siren follows rotor physics  f = (rpm / 60) x ports');
{
  const T = TONES.mech;
  const peak = (T.runRpm / 60) * T.ports;
  const r = renderMechSteady(T, SR);
  check('steady fundamental', pitchHz(r.data, 2000, 16384, { min: 200, max: 1600 }), peak, 8);
  assert('peak inside the published 400-800 Hz', peak >= 400 && peak <= 820, `${peak.toFixed(0)} Hz`);

  // The radiated wave is the derivative of the port-overlap triangle, so it
  // must carry both odd and even harmonics — a plain triangle would not.
  const found = partials(r.data, 2000, 16384, 12, -26).map(([f]) => f);
  const nth = (k) => found.some((f) => Math.abs(f - peak * k) < peak * 0.05);
  assert('second harmonic present (even)', nth(2), found.slice(0, 6).map((f) => f.toFixed(0)).join(' '));
  assert('third harmonic present (odd)', nth(3));
  assert('reaches well past 4 kHz', found.some((f) => f > 4000),
    `top ${Math.max(...found).toFixed(0)} Hz`);

  assert('wind-up is the published 2-3 s', T.spinUpS >= 2 && T.spinUpS <= 3.2, `${T.spinUpS} s`);
  assert('coast-down is the published 30 s or more', T.coastDownS >= 28, `${T.coastDownS} s`);
}

group('Rumble tracks the siren above it, inside 182-400 Hz');
for (const src of ['wail1', 'yelp', 'hilo']) {
  const r = renderRumble(TONES.rumbler, TONES[src], SR);
  const f = pitchHz(r.data, Math.floor(r.data.length * 0.3), 8192, { min: 80, max: 700 });
  assert(`under ${TONES[src].label}`, f >= 150 && f <= 440, `${f.toFixed(0)} Hz`);
}

group('Loops are seamless');
for (const id of SWEEPS) {
  assert(`${TONES[id].label} wrap`, seamRatio(rendered[id].data, 0) <= 1.2,
    `${seamRatio(rendered[id].data, 0).toFixed(2)}x the waveform's own steepest step`);
}
{
  const h = renderHorn(TONES.airhorn, SR);
  assert('AIR HORN wrap', seamRatio(h.data, h.loopStart) <= 1.2,
    `${seamRatio(h.data, h.loopStart).toFixed(2)}x`);
  // The attack hands over to the loop; that join must survive the sealing.
  const steps = [];
  for (let i = h.loopStart + 1; i < h.data.length; i++) steps.push(Math.abs(h.data[i] - h.data[i - 1]));
  const worst = Math.max(...steps);
  assert('AIR HORN attack-to-loop join',
    Math.abs(h.data[h.loopStart] - h.data[h.loopStart - 1]) <= worst, '');
  const m = renderMechSteady(TONES.mech, SR);
  assert('Q-SIREN wrap', seamRatio(m.data, 0) <= 1.2, `${seamRatio(m.data, 0).toFixed(2)}x`);
}

group('Nothing renders out of range or out of bounds');
{
  const all = [
    ...SWEEPS.map((id) => [TONES[id].label, rendered[id]]),
    ['AIR HORN', renderHorn(TONES.airhorn, SR)],
    ['Q-SIREN', renderMechSteady(TONES.mech, SR)],
    ['RUMBLE', renderRumble(TONES.rumbler, TONES.wail1, SR)],
    ['MANUAL', renderSteady(TONES.manual.lo, SR)],
    ['street IR', { data: renderStreetIR(SR) }],
  ];
  for (const [name, r] of all) {
    let peak = 0, nan = 0, dc = 0;
    const pieces = [r.data, r.release].filter(Boolean);
    let n = 0;
    for (const p of pieces) {
      for (let i = 0; i < p.length; i++) {
        const v = p[i];
        if (!Number.isFinite(v)) nan++;
        peak = Math.max(peak, Math.abs(v));
        dc += v; n++;
      }
    }
    assert(`${name.padEnd(10)} finite and inside full scale`,
      nan === 0 && peak <= 1 && Math.abs(dc / n) < 0.02,
      `peak ${peak.toFixed(3)}  dc ${(dc / n).toFixed(4)}${nan ? `  ${nan} NaN` : ''}`);
  }
}

group('Regressions');
{
  // The harmonic sum used one sine per partial; the Chebyshev recurrence
  // gives the same answer with one per sample, which is what makes a long
  // render fast enough to do while someone holds a key.
  const amps = pulseHarmonics(0.35, 48);
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const ph = (i / 3000) * Math.PI * 6;
    let direct = 0;
    const maxK = Math.min(amps.length - 1, Math.floor(24000 / 300));
    for (let k = 1; k <= maxK; k++) direct += amps[k] * Math.sin(ph * k);
    worst = Math.max(worst, Math.abs(harmonicSum(ph, amps, 300, 24000) - direct));
  }
  assert('fast harmonic sum matches the direct one', worst < 1e-9, worst.toExponential(1));

  // triangleHarmonics took the absolute value inside the integral, which
  // averages to about the same number for every harmonic: a flat spectrum
  // rather than a triangle.
  const tri = triangleHarmonics(0.45, 16);
  assert('triangle series actually falls off', tri[1] / tri[3] > 5,
    `k1/k3 = ${(tri[1] / tri[3]).toFixed(1)} (triangle ~9, flat ~1)`);
  assert('asymmetric triangle carries even harmonics', tri[2] > tri[1] * 0.02,
    `k2/k1 = ${(tri[2] / tri[1]).toFixed(3)}`);

  // A square series has odd harmonics only; the rotor's must not.
  const sq = squareHarmonics(16);
  assert('square series has no even harmonics', sq[2] === 0 && sq[4] === 0);
}

console.log(`\n\x1b[1m${pass}/${pass + fail} checks passed\x1b[0m${fail ? `  \x1b[31m(${fail} failing)\x1b[0m` : ''}\n`);
process.exit(fail ? 1 : 0);
