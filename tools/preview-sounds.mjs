/**
 * preview-sounds.mjs — renders every tone to a .wav so a person can listen.
 *
 * The synthesis is pure maths over a Float32Array, so it runs here with no
 * audio context and no browser. That is the point: the thing that decides
 * whether a siren sounds like a siren is an ear, and this is how an ear gets
 * to hear a change before it is wired into the app.
 *
 *   node tools/preview-sounds.mjs [outDir] [seconds]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TONES } from '../js/audio/tones.js';
import {
  renderSiren, renderHorn, renderMech, renderRumble, renderSteady, renderStreetIR,
} from '../js/audio/render.js';
import { highpass, peaking, lowpass, chain, driverClip, normalize } from '../js/audio/dsp.js';

const SR = 48000;
const OUT = process.argv[2] || 'preview';
const SECONDS = Number(process.argv[3] || 6);

/* ------------------------------ wav ------------------------------ */

function writeWav(path, data, sr) {
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/* ------------------- the shared horn + room stage ------------------- */

/**
 * Mirrors what the app's graph does after a source buffer: the radiator's own
 * distortion and response, then a little of the street.
 *
 * One voicing per family, because these are not the same object. A siren
 * head is a compression driver on a horn, with a hard presence peak and
 * nothing below a few hundred hertz. An air horn is a flaring trumpet whose
 * fundamental is the point. A Q is a rotor in a housing. Running all three
 * through the siren-speaker curve — which the first pass did — gave the horn
 * and the Q a nasal, hollow colour that belonged to neither.
 */
const VOICING = {
  siren: {
    drive: 1.5, wet: 0.22,
    bands: [[700, 1.1, -4], [1250, 1.5, 5.5], [2600, 2.0, 4]],
    lowCut: 330, highCut: 7800,
  },
  horn: {
    drive: 1.15, wet: 0.26,
    // No dip, and the low cut stays below the trumpets: a 300 Hz horn tuned
    // to 311 Hz must keep its own fundamental.
    bands: [[480, 1.0, 3], [1400, 1.3, 2]],
    lowCut: 130, highCut: 6800,
  },
  mech: {
    drive: 1.3, wet: 0.34,
    bands: [[900, 0.9, 3], [2000, 1.4, 2]],
    lowCut: 190, highCut: 8200,
  },
  rumble: {
    drive: 1.1, wet: 0.10,
    bands: [[160, 0.9, 3]],
    lowCut: 70, highCut: 1200,
  },
};

function voiceChain(src, sr, family = 'siren') {
  const v = VOICING[family];
  const out = Float32Array.from(src);
  for (let i = 0; i < out.length; i++) out[i] = driverClip(out[i], v.drive);
  chain(out,
    highpass(sr, v.lowCut, 0.72),
    ...v.bands.map(([f, q, g]) => peaking(sr, f, q, g)),
    lowpass(sr, v.highCut, 0.7));
  const wet = v.wet;

  if (wet > 0) {
    const ir = renderStreetIR(sr, 0.45);
    const wetBuf = new Float32Array(out.length);
    // Only the discrete taps are convolved: a full convolution of the tail
    // is pointless here, and the early reflections carry the effect.
    for (let i = 0; i < ir.length; i++) {
      const g = ir[i];
      if (Math.abs(g) < 0.02) continue;
      for (let j = 0; j + i < out.length; j++) wetBuf[j + i] += out[j] * g;
    }
    for (let i = 0; i < out.length; i++) out[i] = out[i] * (1 - wet * 0.5) + wetBuf[i] * wet;
  }
  return normalize(out, 0.92);
}

/* ------------------------------ build ------------------------------ */

function tile(rendered, seconds, sr) {
  const { data, loopStart = 0 } = rendered;
  const want = Math.round(sr * seconds);
  const out = new Float32Array(want);
  let w = 0;
  for (let i = 0; i < data.length && w < want; i++) out[w++] = data[i];
  while (w < want) {
    for (let i = loopStart; i < data.length && w < want; i++) out[w++] = data[i];
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const made = [];

for (const [id, spec] of Object.entries(TONES)) {
  let src, seconds = SECONDS, family = 'siren';

  if (spec.kind === 'sweep' || spec.kind === 'twotone') {
    src = tile(renderSiren(spec, SR), seconds, SR);
  } else if (spec.kind === 'horn') {
    const r = renderHorn(spec, SR);
    // A horn is a stab: attack, a moment of loop, then its own release.
    const hold = tile(r, 1.1, SR);
    src = new Float32Array(hold.length + r.release.length);
    src.set(hold, 0);
    src.set(r.release, hold.length);
    family = 'horn';
  } else if (spec.kind === 'mechanical') {
    const r = renderMech(spec, SR);
    const hold = tile(r, spec.spinUpS + 2, SR);
    src = new Float32Array(hold.length + r.release.length);
    src.set(hold, 0);
    src.set(r.release, hold.length);
    family = 'mech';
  } else if (spec.kind === 'rumble') {
    src = tile(renderRumble(spec, TONES.wail1, SR), seconds, SR);
    family = 'rumble';
  } else if (spec.kind === 'manual') {
    // Swept by playback rate in the app; approximated here by resampling.
    const steady = renderSteady(1000, SR);
    const n = Math.round(SR * 5);
    src = new Float32Array(n);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = t < 2 ? spec.lo * Math.pow(spec.hi / spec.lo, t / 2)
                      : spec.hi * Math.pow(spec.lo / spec.hi, (t - 2) / 3);
      pos += f / 1000;
      src[i] = steady.data[Math.floor(pos) % steady.data.length];
    }
  } else {
    continue;
  }

  const wav = voiceChain(src, SR, family);
  const path = join(OUT, `${id}.wav`);
  writeWav(path, wav, SR);
  made.push(`${id}.wav  ${(wav.length / SR).toFixed(1)}s`);
}

console.log(made.join('\n'));
console.log(`\n${made.length} files in ${OUT}/`);
