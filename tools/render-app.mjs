/**
 * render-app.mjs — renders what the app actually plays, not an imitation.
 *
 * Every earlier attempt at judging the timbre went through a separate copy
 * of the signal path written for the purpose, and a copy is a claim. This
 * drives the real modules — the real voice, the real radiator, the real
 * master chain with its limiter and ceiling — inside a browser's
 * OfflineAudioContext, and hands back the samples. What comes out is the
 * sound, so it can be both listened to and measured.
 *
 *   node tools/render-app.mjs [outDir] [seconds]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PRESET = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = process.env.CHROME_PATH || (existsSync(PRESET) ? PRESET : undefined);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';
const OUT = process.argv[2] || 'preview';
const SECONDS = Number(process.argv[3] || 5);
const SR = 48000;

/* ------------------------------ wav ------------------------------ */

function writeWav(path, data, sr) {
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
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

/* ---------------------------- rendering ---------------------------- */

/**
 * Renders one tone through the whole app chain.
 * `hold` is how long the key is down; the render runs past it so a release
 * is part of what comes out.
 */
export async function renderInBrowser(page, id, { seconds = 5, hold = null } = {}) {
  return page.evaluate(async ({ id, seconds, hold, SR }) => {
    const [{ AudioEngine }, { createVoice }, { TONES }] = await Promise.all([
      import('./js/audio/engine.js'),
      import('./js/audio/voices.js'),
      import('./js/audio/tones.js'),
    ]);
    const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    const engine = new AudioEngine();
    engine.attachContext(ctx);

    const spec = TONES[id];
    const voice = createVoice(engine, spec,
      spec.kind === 'rumble' ? { source: TONES.wail1 } : {});
    voice.start(0);
    if (hold != null) voice.stop(hold);

    const buf = await ctx.startRendering();
    return Array.from(buf.getChannelData(0));
  }, { id, seconds, hold, SR });
}

/* ------------------------------ main ------------------------------ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await b.newPage();
  await page.goto(`${BASE}/index.html`);

  mkdirSync(OUT, { recursive: true });
  const ids = process.env.TONES?.split(',')
    ?? ['wail1', 'wail2', 'yelp', 'hilo', 'phaser', 'wawa', 'manual', 'mech', 'airhorn'];

  for (const id of ids) {
    const hold = id === 'airhorn' ? 1.2 : (id === 'manual' ? 2.2 : null);
    const secs = id === 'manual' ? 7 : (id === 'airhorn' ? 3 : SECONDS);
    const data = Float32Array.from(await renderInBrowser(page, id, { seconds: secs, hold }));
    writeWav(join(OUT, `${id}.wav`), data, SR);
    let peak = 0, sum = 0;
    for (const v of data) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    console.log(`${id.padEnd(8)} ${(data.length / SR).toFixed(1)}s  pico ${peak.toFixed(3)}  rms ${Math.sqrt(sum / data.length).toFixed(3)}`);
  }
  await b.close();
  console.log(`\n${ids.length} arquivos em ${OUT}/`);
}
