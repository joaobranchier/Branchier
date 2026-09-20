/**
 * verify-audio.mjs — renders the synthesis engine offline and measures the
 * result against the published manufacturer figures in js/audio/tones.js.
 *
 * This is the test that matters for this project: the whole product is a
 * claim about frequencies, and a claim about frequencies should be measured
 * rather than trusted. Run with:  npm test
 *
 * Two measurements are used, because one is not enough:
 *   - pitch, via harmonic product spectrum. A siren's 2nd harmonic sits only
 *     ~2 dB under its fundamental, so a plain "loudest bin" reading flips
 *     octaves halfway through a sweep. HPS multiplies decimated copies of the
 *     spectrum so only the true fundamental survives.
 *   - sweep rate, via the spectral centroid track. The centroid rises and
 *     falls once per sweep, so the peak of its own spectrum IS the LFO rate.
 *     This works identically for a 0.25 Hz wail and a 21.7 Hz phaser.
 */

import { OfflineAudioContext, AudioContext } from 'node-web-audio-api';

globalThis.window = { AudioContext };
globalThis.document = { createElement: () => ({ setAttribute() {}, play: async () => {}, style: {} }) };

const HERE = new URL('../js/audio/', import.meta.url);
const { AudioEngine } = await import(new URL('engine.js', HERE));
const { createVoice } = await import(new URL('voices.js', HERE));
const { TONES } = await import(new URL('tones.js', HERE));
const { buildWaves, makeNoiseBuffer } = await import(new URL('waves.js', HERE));

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

/** Fundamental via harmonic product spectrum — immune to a dominant 2nd harmonic. */
function pitchHz(data, start, n, sr, { min = 120, max = 3000, harmonics = 5 } = {}) {
  const mag = magnitudes(data, start, n);
  const half = mag.length;
  const hps = Float64Array.from(mag);
  for (let h = 2; h <= harmonics; h++) {
    for (let i = 0; i < Math.floor(half / h); i++) hps[i] *= mag[i * h];
  }
  const loBin = Math.max(2, Math.ceil((min * n) / sr));
  const hiBin = Math.min(half - 2, Math.floor((max * n) / sr));
  let peak = loBin;
  for (let i = loBin; i <= hiBin; i++) if (hps[i] > hps[peak]) peak = i;
  const a = Math.log(hps[peak - 1] + 1e-30), b = Math.log(hps[peak] + 1e-30), c = Math.log(hps[peak + 1] + 1e-30);
  const delta = (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return ((peak + delta) * sr) / n;
}

/**
 * Measures how fast the tone sweeps, by tracking the spectral centroid over
 * time and finding the dominant periodicity of that track.
 */
function sweepRateHz(data, sr, { win = 512, hop = 256, skip = 0.35 } = {}) {
  const from = Math.floor(sr * skip);
  const frames = Math.floor((data.length - from - win) / hop);
  const track = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const mag = magnitudes(data, from + f * hop, win);
    let num = 0, den = 0;
    for (let i = 1; i < mag.length; i++) { num += i * mag[i]; den += mag[i]; }
    track[f] = den > 1e-9 ? num / den : 0;
  }
  let mean = 0;
  for (const v of track) mean += v;
  mean /= frames || 1;
  for (let i = 0; i < frames; i++) track[i] -= mean;

  const trackSr = sr / hop;
  const n = 1 << Math.floor(Math.log2(frames));
  if (n < 16) return 0;
  const mag = magnitudes(track, 0, n);
  let peak = 1;
  for (let i = 1; i < mag.length - 1; i++) if (mag[i] > mag[peak]) peak = i;
  const a = mag[peak - 1], b = mag[peak], c = mag[peak + 1];
  const delta = (0.5 * (a - c)) / (a - 2 * b + c || 1);
  return ((peak + delta) * trackSr) / n;
}

/* ---------------------------- render harness ---------------------------- */

async function render(toneId, seconds, opts = {}) {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
  const eng = new AudioEngine();
  eng.ctx = ctx;
  eng.waves = buildWaves(ctx);
  eng.noiseBuffer = makeNoiseBuffer(ctx);
  eng._buildChain();
  eng.ready = true;
  if (opts.tone) eng.setTone(opts.tone);
  const voice = createVoice(eng, TONES[toneId], { source: TONES[opts.sourceId ?? 'wail1'] });
  voice.start(0);
  if (opts.stopAt != null) voice.stop(opts.stopAt);
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

/* ---------------------------- assertions ---------------------------- */

let pass = 0, fail = 0;
const group = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
function check(name, got, want, tolPct, unit = ' Hz') {
  const err = want === 0 ? Math.abs(got) : (Math.abs(got - want) / Math.abs(want)) * 100;
  const ok = err <= tolPct;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name.padEnd(44)} ${got.toFixed(2)}${unit} vs ${want.toFixed(2)}${unit}  ${err.toFixed(1)}%`);
}
function assert(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name.padEnd(44)} ${detail}`);
}

/* ---------------------------- the tests ---------------------------- */

group('Sweep rate matches the manufacturer cycles-per-minute figure');
for (const id of ['wail1', 'wail2', 'yelp', 'phaser', 'wawa', 'hilo']) {
  const T = TONES[id];
  const secs = Math.min(24, Math.max(4, (1 / T.rateHz) * 8));
  const data = await render(id, secs);
  check(`${T.label} sweep rate`, sweepRateHz(data, SR), T.rateHz, 12);
}

group('Sweep reaches its rated endpoints (harmonic product spectrum)');
for (const id of ['wail1', 'wail2', 'yelp', 'wawa']) {
  const T = TONES[id];
  const period = 1 / T.rateHz;
  const secs = Math.min(20, Math.max(3, period * 4));
  const data = await render(id, secs);
  const win = 4096;
  let lo = Infinity, hi = 0;
  const steps = 160;
  const t0 = Math.floor(SR * (secs - period - 0.05));
  for (let s = 0; s < steps; s++) {
    const off = t0 + Math.floor((s / steps) * period * SR);
    if (off + win >= data.length || off < 0) continue;
    const f = pitchHz(data, off, win, SR, { min: 400, max: 2600 });
    lo = Math.min(lo, f); hi = Math.max(hi, f);
  }
  check(`${T.label} low endpoint`, lo, T.lo, 12);
  check(`${T.label} high endpoint`, hi, T.hi, 12);
}

group('Hi-Lo holds two fixed pitches a musical fourth apart (DIN 14610)');
{
  const T = TONES.hilo;
  const data = await render('hilo', 8);
  const win = 4096;
  const seen = [];
  for (let s = 0; s < 120; s++) {
    const off = Math.floor(SR * (4 + s * (1 / T.rateHz) / 120));
    seen.push(pitchHz(data, off, win, SR, { min: 300, max: 900 }));
  }
  seen.sort((a, b) => a - b);
  const low = seen[Math.floor(seen.length * 0.12)];
  const high = seen[Math.floor(seen.length * 0.88)];
  check("Hi-Lo low tone (a')", low, T.lo, 8);
  check('Hi-Lo high tone (d")', high, T.hi, 8);
  check('Hi-Lo interval ratio', high / low, T.hi / T.lo, 8, '');
  assert('Hi-Lo ratio inside DIN 14610 1:1.33 band',
    high / low > 1.25 && high / low < 1.42, `ratio ${(high / low).toFixed(3)}`);
  assert('Hi-Lo pitches inside DIN 14610 360-630 Hz',
    low > 355 && high < 640, `${low.toFixed(0)}-${high.toFixed(0)} Hz`);
}

group('Air horn reproduces the Nathan AirChime chord');
{
  const T = TONES.airhorn;
  const data = await render('airhorn', 2.0);
  check('Air horn fundamental (D#4)', pitchHz(data, Math.floor(SR * 0.8), 16384, SR, { min: 150, max: 800 }), T.bells[0].hz, 6);
  // Every bell of the chord should be present in the spectrum.
  const mag = magnitudes(data, Math.floor(SR * 0.9), 16384);
  const binOf = (hz) => Math.round((hz * 16384) / SR);
  let ceiling = 0;
  for (const m of mag) ceiling = Math.max(ceiling, m);
  for (const bell of T.bells) {
    const b = binOf(bell.hz);
    let local = 0;
    for (let i = b - 3; i <= b + 3; i++) local = Math.max(local, mag[i] || 0);
    const db = 20 * Math.log10(local / ceiling + 1e-12);
    assert(`Air horn bell present @ ${bell.hz.toFixed(0)} Hz`, db > -26, `${db.toFixed(1)} dB rel. peak`);
  }
  // The attack must be fast enough to feel like a button press.
  let peakIdx = 0, peakVal = 0;
  for (let i = 0; i < SR * 0.4; i++) { const a = Math.abs(data[i]); if (a > peakVal) { peakVal = a; peakIdx = i; } }
  assert('Air horn reaches full level within 120 ms', peakIdx / SR < 0.12, `${((peakIdx / SR) * 1000).toFixed(0)} ms`);
}

group('Q-siren follows rotor physics  f = (rpm / 60) x ports');
{
  const T = TONES.mech;
  const peak = (T.runRpm / 60) * T.ports;
  const data = await render('mech', 16, { stopAt: 10 });
  const at = (t) => pitchHz(data, Math.floor(SR * t), 16384, SR, { min: 60, max: 1600 });
  const early = at(1.5), full = at(9.4), coasting = at(13.5);
  check('Q-siren peak fundamental', full, peak, 12);
  assert('Q-siren winds up under power', full > early * 1.4, `${early.toFixed(0)} -> ${full.toFixed(0)} Hz`);
  assert('Q-siren coasts down on the clutch', coasting < full * 0.75, `${full.toFixed(0)} -> ${coasting.toFixed(0)} Hz`);
  assert('Q-siren peak inside published 400-800 Hz', peak >= 400 && peak <= 820, `${peak.toFixed(0)} Hz`);

  // The readout model has to agree with the scheduled ramps: stop() reads
  // the coast-down's starting pitch out of it, so a model that drifts makes
  // the siren jump when it is switched off mid-spin-up.
  {
    const ctxM = new OfflineAudioContext(1, SR * 12, SR);
    const engM = new AudioEngine();
    engM.ctx = ctxM; engM.waves = buildWaves(ctxM); engM.noiseBuffer = makeNoiseBuffer(ctxM);
    engM._buildChain(); engM.ready = true;
    const vM = createVoice(engM, TONES.mech);
    vM.start(0);
    const dM = (await ctxM.startRendering()).getChannelData(0);
    let worst = 0, worstAt = 0;
    // Sampled from 3.5 s on. Before that the rotor is under ~300 Hz, which
    // the horn-speaker simulation deliberately filters out — so there is no
    // fundamental left in the output to measure, and any reading there says
    // more about the detector than about the model.
    for (const t of [3.5, 5, 6.5, 8, 10]) {
      const predicted = vM.frequency(t);
      const measured = pitchHz(dM, Math.floor(SR * t), 16384, SR, { min: 60, max: 1600 });
      const err = Math.abs(measured - predicted) / predicted * 100;
      if (err > worst) { worst = err; worstAt = t; }
    }
    assert('Q-siren readout tracks its spin-up', worst < 15, `worst ${worst.toFixed(1)}% at t=${worstAt}s`);
  }
}

group('Rumbler tracks the active siren inside its 182-400 Hz band');
for (const src of ['wail1', 'yelp', 'hilo']) {
  const data = await render('rumbler', 8, { sourceId: src, tone: { bass: true } });
  const f = pitchHz(data, Math.floor(SR * 4), 16384, SR, { min: 80, max: 700 });
  assert(`Rumble under ${TONES[src].label}`, f >= 150 && f <= 440, `${f.toFixed(0)} Hz`);
}

group('Manual wail rises while held and falls when released');
{
  const T = TONES.manual;
  const ctx = new OfflineAudioContext(1, SR * 10, SR);
  const eng = new AudioEngine();
  eng.ctx = ctx; eng.waves = buildWaves(ctx); eng.noiseBuffer = makeNoiseBuffer(ctx);
  eng._buildChain(); eng.ready = true;
  const v = createVoice(eng, T);
  v.start(0);
  v.fall(4);          // release the button at t=4s
  const data = (await ctx.startRendering()).getChannelData(0);
  const at = (t) => pitchHz(data, Math.floor(SR * t), 16384, SR, { min: 300, max: 2400 });
  const held = at(3.0), released = at(7.5);
  check('Manual peak while held', held, T.hi, 12);
  assert('Manual falls after release', released < held * 0.8, `${held.toFixed(0)} -> ${released.toFixed(0)} Hz`);
}

group('Output never exceeds full scale, alone or layered');
for (const id of ['wail1', 'wail2', 'yelp', 'phaser', 'wawa', 'hilo', 'airhorn', 'mech']) {
  const data = await render(id, 3);
  let pk = 0;
  for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
  assert(`${TONES[id].label} peak sample`, pk <= 1.0, `${pk.toFixed(3)}`);
}
{
  // Worst case the UI allows: siren + rumbler + air horn together, HIGH+BASS.
  const ctx = new OfflineAudioContext(1, SR * 4, SR);
  const eng = new AudioEngine();
  eng.ctx = ctx; eng.waves = buildWaves(ctx); eng.noiseBuffer = makeNoiseBuffer(ctx);
  eng._buildChain(); eng.ready = true;
  eng.setTone({ high: true, bass: true });
  eng.setVolume(1);
  createVoice(eng, TONES.yelp).start(0);
  createVoice(eng, TONES.rumbler, { source: TONES.yelp }).start(0);
  createVoice(eng, TONES.airhorn).start(0.5);
  const data = (await ctx.startRendering()).getChannelData(0);
  let pk = 0;
  for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
  assert('YELP + RUMBLE + AIR HORN at full volume', pk <= 1.0, `${pk.toFixed(3)}`);
}

group('The LCD frequency model agrees with the rendered audio');
for (const id of ['wail1', 'yelp']) {
  const T = TONES[id];
  const period = 1 / T.rateHz;
  const secs = Math.max(4, period * 4);
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * secs), SR);
  const eng = new AudioEngine();
  eng.ctx = ctx; eng.waves = buildWaves(ctx); eng.noiseBuffer = makeNoiseBuffer(ctx);
  eng._buildChain(); eng.ready = true;
  const v = createVoice(eng, T);
  v.start(0);
  const data = (await ctx.startRendering()).getChannelData(0);
  // Compare the model's prediction to the measurement at several phases.
  let worst = 0;
  for (const frac of [0.1, 0.3, 0.55, 0.8]) {
    const t = secs - period + frac * period;
    const predicted = T.lo + (() => {
      const ph = ((t * T.rateHz) % 1);
      const r = T.shape === 'ramp' ? (T.riseRatio ?? 0.68) : 0.5;
      return (ph < r ? ph / r : 1 - (ph - r) / (1 - r)) * (T.hi - T.lo);
    })();
    const measured = pitchHz(data, Math.floor(SR * t), 4096, SR, { min: 400, max: 2600 });
    worst = Math.max(worst, Math.abs(measured - predicted) / predicted * 100);
  }
  assert(`${T.label} readout tracks audio`, worst < 15, `worst ${worst.toFixed(1)}% off`);
}

group('Regressions');
{
  // RUMBLE used to read .lo/.hi straight off the active tone. The mechanical
  // and horn specs carry neither, so it reached the oscillator as NaN and
  // threw "the provided float value is non-finite".
  for (const src of ['wail1', 'wail2', 'yelp', 'phaser', 'hilo', 'wawa', 'mech', 'airhorn', 'manual']) {
    let ok = true, why = '';
    let peak = 0;
    try {
      const data = await render('rumbler', 3, { sourceId: src, tone: { bass: true } });
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) { ok = false; why = 'NaN in output'; break; }
        peak = Math.max(peak, Math.abs(data[i]));
      }
      if (ok && peak < 1e-4) { ok = false; why = 'silent'; }
    } catch (e) { ok = false; why = e.message.slice(0, 44); }
    assert(`RUMBLE under ${TONES[src].label}`, ok, ok ? `peak ${peak.toFixed(3)}` : why);
  }

  // STOP used to call the ordinary release, so the Q-siren kept sounding for
  // its full nineteen-second coast-down after the panic button was pressed.
  const ctx = new OfflineAudioContext(1, SR * 8, SR);
  const eng = new AudioEngine();
  eng.ctx = ctx; eng.waves = buildWaves(ctx); eng.noiseBuffer = makeNoiseBuffer(ctx);
  eng._buildChain(); eng.ready = true;
  const q = createVoice(eng, TONES.mech);
  q.start(0);
  q.kill(5);
  const data = (await ctx.startRendering()).getChannelData(0);
  const rms = (t) => {
    let s2 = 0;
    const n = Math.floor(SR * 0.2);
    for (let i = 0; i < n; i++) { const x = data[Math.floor(SR * t) + i] || 0; s2 += x * x; }
    return Math.sqrt(s2 / n);
  };
  const before = rms(4.5), after = rms(5.3), later = rms(7);
  assert('kill() silences the Q-siren at once', after < before * 0.02 && later < 1e-4,
    `${before.toFixed(4)} -> ${after.toFixed(4)} -> ${later.toFixed(4)}`);

  // kill() guarded on `stopped`, which stop() had just set — so it was a
  // no-op on a voice already coasting, the one case it exists for.
  //
  // The audible side of this is checked in verify-ui.mjs, in a real browser:
  // an OfflineAudioContext cannot reproduce it, because reading .value on an
  // AudioParam before the render returns the initial value rather than the
  // automated one, so a stop scheduled ahead does not behave as it does live.
  // What regressed here was the guard, so the guard is what is asserted.
  const ctx2 = new OfflineAudioContext(1, SR * 2, SR);
  const eng2 = new AudioEngine();
  eng2.ctx = ctx2; eng2.waves = buildWaves(ctx2); eng2.noiseBuffer = makeNoiseBuffer(ctx2);
  eng2._buildChain(); eng2.ready = true;
  const q2 = createVoice(eng2, TONES.mech);
  q2.start(0);
  q2.stop(0);
  const stoppedFirst = q2.stopped && !q2.killed;
  q2.kill(0);
  assert('kill() still acts on a voice already stopped', stoppedFirst && q2.killed,
    `stopped=${q2.stopped} killed=${q2.killed}`);
  // And the reverse order must not let a later stop() undo a kill.
  const q3 = createVoice(eng2, TONES.mech);
  q3.start(0);
  q3.kill(0);
  const before3 = q3.out.gain.value;
  q3.stop(0);
  assert('stop() after kill() is a no-op', q3.out.gain.value === before3,
    `gain ${before3} -> ${q3.out.gain.value}`);

  // A half-written localStorage entry used to reach an AudioParam as NaN,
  // which throws rather than being ignored.
  let threw = false;
  try { eng.setVolume(NaN); eng.setVolume(undefined); eng.setVolume('loud'); }
  catch { threw = true; }
  assert('setVolume survives a corrupt preference', !threw && Number.isFinite(eng.volume), `volume=${eng.volume}`);
}

console.log(`\n\x1b[1m${pass}/${pass + fail} checks passed\x1b[0m${fail ? `  \x1b[31m(${fail} failing)\x1b[0m` : ''}\n`);
process.exit(fail ? 1 : 0);
