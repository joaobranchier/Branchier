/**
 * verify-ui.mjs — drives the real faceplate in a real browser.
 *
 * Every check here corresponds to a defect that was found by doing this
 * rather than by reading the code: the STOP button that left the Q-siren
 * coasting for nineteen seconds, the RUMBLE layer that threw a non-finite
 * AudioParam over any tone without a lo/hi pair, the air horn that stuck on
 * for good if the first tap ended before the AudioContext finished building,
 * and a wake lock released and re-taken on every single key press.
 *
 * Run with:  npm run test:ui     (needs `npm start` serving on 8099, or set
 *                                 BASE_URL to point somewhere else)
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';
const SHOT = process.env.SHOT_DIR || null;

/**
 * Where to find Chromium. CHROME_PATH wins; otherwise a pre-provisioned
 * browser is used if one is present, and failing that Playwright falls back
 * to whatever `playwright install` put in its own cache (undefined means
 * "you choose"). Hard-coding one path breaks the other environment.
 */
const PRESET = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = process.env.CHROME_PATH || (existsSync(PRESET) ? PRESET : undefined);

const b = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${n.padEnd(46)} ${d}`);
};

const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/**
 * Counts the buffer sources actually playing.
 *
 * The level meter cannot answer "is the old voice still there?": it saturates,
 * so a siren buried under a Q-siren that should have been cut reads exactly
 * the same as a siren playing alone. Counting the sources in the graph is the
 * difference between "something is loud" and "the right thing is sounding".
 */
await ctx.addInitScript(() => {
  window.__live = 0;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__live++;
    this.addEventListener('ended', () => { window.__live--; });
    return start.apply(this, a);
  };
});

const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(`${BASE}/index.html`);
await p.waitForTimeout(600);
await p.locator('.btn[data-close]').click();
await p.waitForTimeout(200);
const meter = () => p.evaluate(() => parseFloat(document.getElementById('meterFill').style.width) || 0);

console.log('\n--- every tone actually makes a sound ---');
{
  // The tones are rendered, not sampled, and the render is warmed up inside
  // the audio unlock. A throw in there once took the very first key press
  // down with it and left the panel silent while looking alive, so each one
  // is played and listened to.
  for (const t of ['wail1', 'wail2', 'yelp', 'phaser', 'hilo', 'wawa']) {
    await p.locator(`[data-tone="${t}"]`).click();
    await p.waitForTimeout(700);
    ok(`${t} sounds`, (await meter()) > 10, `${(await meter()).toFixed(0)}%`);
    await p.locator('#keyStop').click();
    await p.waitForTimeout(250);
  }

  // The horn is momentary, so it has to be held to be heard.
  const hb = await p.locator('#keyHorn').boundingBox();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(500);
  ok('air horn sounds', (await meter()) > 10, `${(await meter()).toFixed(0)}%`);
  await p.mouse.up();
  await p.waitForTimeout(700);

  await p.locator('#keyRumble').click();
  await p.locator('[data-tone="wail1"]').click();
  await p.waitForTimeout(700);
  ok('rumble layer sounds under a siren', (await meter()) > 10, `${(await meter()).toFixed(0)}%`);
  await p.locator('#keyRumble').click();
  await p.locator('#keyStop').click();
  await p.waitForTimeout(300);
}

console.log('\n--- STOP kills the Q-siren immediately ---');
await p.locator('[data-tone="mech"]').click();
await p.waitForTimeout(6000);
const qRun = await meter();
await p.locator('#keyStop').click();
await p.waitForTimeout(600);
const qAfter = await meter();
await p.waitForTimeout(2500);
const qLater = await meter();
ok('Q-siren audible before STOP', qRun > 20, `${qRun.toFixed(0)}%`);
ok('silent 0.6s after STOP', qAfter < 2, `${qAfter.toFixed(0)}%`);
ok('still silent 3s after STOP', qLater < 2, `${qLater.toFixed(0)}%`);

console.log('\n--- RUMBLE over every tone, no exceptions ---');
errs.length = 0;
await p.locator('#keyRumble').click();
for (const t of ['mech', 'wail1', 'yelp', 'hilo', 'phaser', 'wawa', 'wail2']) {
  await p.locator(`[data-tone="${t}"]`).click();
  await p.waitForTimeout(400);
  await p.locator(`[data-tone="${t}"]`).click();
  await p.waitForTimeout(200);
}
ok('no page errors with RUMBLE over all tones', errs.length === 0, errs[0] || '');
await p.locator('#keyRumble').click();
await p.locator('#keyStop').click();

console.log('\n--- air horn released during the audio unlock ---');
const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}/index.html`);
await p2.waitForTimeout(500);
await p2.locator('.btn[data-close]').click();
const box = await p2.locator('#keyHorn').boundingBox();
await p2.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await p2.mouse.down();
await p2.waitForTimeout(30);   // a tap shorter than the first AudioContext build
await p2.mouse.up();
await p2.waitForTimeout(2500);
const stuck = await p2.evaluate(() => parseFloat(document.getElementById('meterFill').style.width) || 0);
ok('horn does not stick on the first quick tap', stuck < 2, `${stuck.toFixed(0)}%`);
await ctx2.close();

console.log('\n--- lightbar flashes behind the unit, keys stay live ---');
await p.locator('#keyLmb').click();
await p.waitForTimeout(400);
const behind = await p.evaluate(() => {
  const s = document.getElementById('strobe');
  return {
    visible: !s.hidden,
    pe: getComputedStyle(s).pointerEvents,
    z: +getComputedStyle(s).zIndex,
    stageZ: +getComputedStyle(document.querySelector('.stage')).zIndex,
  };
});
ok('lightbar visible', behind.visible);
ok('lightbar sits behind the stage', behind.z < behind.stageZ, `z ${behind.z} < ${behind.stageZ}`);
ok('lightbar ignores touches', behind.pe === 'none', behind.pe);
await p.locator('[data-tone="yelp"]').click();
await p.waitForTimeout(500);
ok('tone key still works while lightbar runs', (await p.locator('#lcdTone').textContent()).trim() === 'YELP');
if (SHOT) await p.screenshot({ path: `${SHOT}/lightbar.png` });
await p.locator('#keyLmb').click();
await p.locator('#keyStop').click();
await p.waitForTimeout(200);

console.log('\n--- power toggles both ways ---');
await p.locator('[data-tone="wail1"]').click();
await p.waitForTimeout(400);
await p.locator('#btnPower').click();
await p.waitForTimeout(500);
const off = await p.evaluate(() => ({
  lcd: document.getElementById('lcdTone').textContent,
  standby: document.getElementById('remote').classList.contains('is-standby'),
  m: parseFloat(document.getElementById('meterFill').style.width) || 0,
}));
ok('power off -> standby + silence', off.standby && off.lcd === 'STANDBY' && off.m < 2, JSON.stringify(off));
await p.locator('#btnPower').click();
await p.waitForTimeout(400);
ok('power on -> leaves standby',
  await p.evaluate(() => !document.getElementById('remote').classList.contains('is-standby')));

console.log('\n--- volume readout actually appears ---');
await p.locator('#btnVolDown').click();
await p.waitForTimeout(250);
const vtxt = (await p.locator('#lcdHz').textContent()).trim();
ok('volume shown on the display', /^VOL \d+%$/.test(vtxt), vtxt);
await p.waitForTimeout(1500);
ok('volume readout clears itself', !(await p.locator('#lcdHz').textContent()).includes('VOL'));

console.log('\n--- aria-pressed reflects latch state ---');
await p.locator('[data-tone="yelp"]').click();
await p.waitForTimeout(300);
ok('latched key exposes aria-pressed=true', await p.getAttribute('[data-tone="yelp"]', 'aria-pressed') === 'true');
await p.locator('[data-tone="yelp"]').click();
await p.waitForTimeout(300);
ok('unlatched key exposes aria-pressed=false', await p.getAttribute('[data-tone="yelp"]', 'aria-pressed') === 'false');

console.log('\n--- wake lock is not re-requested per tone change ---');
{
  // A fresh context: by this point the shared page has already had a real
  // request rejected (headless has no display), so ScreenLock is in its
  // blocked state and would never call a stub installed now — the check
  // would pass without exercising anything.
  const ctx3 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx3.addInitScript(() => {
    window.__wakeCalls = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          window.__wakeCalls++;
          return { release: async () => {}, addEventListener() {} };
        },
      },
    });
  });
  const p3 = await ctx3.newPage();
  await p3.goto(`${BASE}/index.html`);
  await p3.waitForTimeout(600);
  await p3.locator('.btn[data-close]').click();
  for (const t of ['wail1', 'yelp', 'hilo', 'wail2']) {
    await p3.locator(`[data-tone="${t}"]`).click();
    await p3.waitForTimeout(250);
  }
  const calls = await p3.evaluate(() => window.__wakeCalls);
  ok('stub was actually exercised', calls >= 1, `${calls} requests`);
  ok('one sentinel across four tone changes', calls === 1, `${calls} requests`);

  // Releasing on silence, then re-taking it, is the intended round trip.
  // The release is deliberately deferred ~400 ms so a tone swap does not
  // churn the lock, so wait past that before expecting a second request.
  await p3.locator('#keyStop').click();
  await p3.waitForTimeout(900);
  await p3.locator('[data-tone="yelp"]').click();
  await p3.waitForTimeout(300);
  const after = await p3.evaluate(() => window.__wakeCalls);
  ok('re-acquired after going silent', after === 2, `${after} total`);
  await ctx3.close();
}

console.log('\n--- STOP reaches voices that are still ringing out ---');
{
  // A released voice was dropped from the controller's maps at once, so STOP
  // could not reach it while it rang out — and the level meter read zero
  // throughout, because it was gated on something being latched.
  await p.locator('[data-tone="mech"]').click();
  await p.waitForTimeout(6000);
  const running = await meter();
  await p.locator('[data-tone="mech"]').click();   // un-latch: the coast starts
  await p.waitForTimeout(700);
  const coasting = await meter();
  ok('meter shows the coast-down', coasting > 20, `${coasting.toFixed(0)}%`);
  await p.locator('#keyStop').click();
  await p.waitForTimeout(800);
  const afterStop = await meter();
  ok('STOP silences a coasting Q-siren', afterStop < 2, `${running.toFixed(0)}% -> ${afterStop.toFixed(0)}%`);

  const mbox = await p.locator('#keyManual').boundingBox();
  await p.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(2000);
  await p.mouse.up();
  await p.waitForTimeout(400);
  ok('manual wail keeps falling after release', (await meter()) > 20);
  await p.locator('#keyStop').click();
  await p.waitForTimeout(700);
  ok('STOP silences a falling manual wail', (await meter()) < 2);
}

console.log('\n--- keys are operable from a keyboard ---');
{
  await p.locator('#keyStop').click();
  await p.waitForTimeout(300);
  // Latching key: Enter toggles it.
  await p.locator('[data-tone="wail1"]').focus();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(500);
  ok('Enter latches a tone key',
    await p.getAttribute('[data-tone="wail1"]', 'aria-pressed') === 'true');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  ok('Enter again releases it',
    await p.getAttribute('[data-tone="wail1"]', 'aria-pressed') === 'false');

  // Momentary key: sound lasts only while the key is held.
  await p.locator('#keyHorn').focus();
  await p.keyboard.down(' ');
  await p.waitForTimeout(600);
  const held = await meter();
  await p.keyboard.up(' ');
  await p.waitForTimeout(700);
  const released = await meter();
  ok('Space holds the air horn', held > 10, `${held.toFixed(0)}%`);
  ok('releasing Space stops it', released < 2, `${released.toFixed(0)}%`);

  // Key-repeat must not machine-gun a latch on and off.
  await p.locator('[data-tone="yelp"]').focus();
  await p.keyboard.down('Enter');
  await p.waitForTimeout(700);
  const latched = await p.getAttribute('[data-tone="yelp"]', 'aria-pressed');
  await p.keyboard.up('Enter');
  ok('held Enter does not re-trigger the latch', latched === 'true', `aria-pressed=${latched}`);
  await p.locator('#keyStop').click();
}

console.log('\n--- branding ---');
{
  const brand = await p.evaluate(() => {
    const b = document.querySelector('.brand');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const rem = document.querySelector('.remote').getBoundingClientRect();
    const mark = b.querySelector('.brand__mark use');
    const strokes = [...document.querySelectorAll('#i-logo path')].map((x) => x.getAttribute('stroke'));
    return {
      text: b.innerText.replace(/\s+/g, ''),
      offset: Math.abs((r.left + r.width / 2) - (rem.left + rem.width / 2)),
      usesMark: mark?.getAttribute('href') === '#i-logo',
      markHidden: b.querySelector('.brand__mark')?.getAttribute('aria-hidden') === 'true',
      strokes,
      title: document.title,
    };
  });
  ok('the name is on the panel', brand?.text === 'SireFlex', brand?.text);
  ok('it is centred on the unit', brand.offset < 1, `${brand.offset.toFixed(1)}px off`);
  ok('the mark is drawn', brand.usesMark);
  ok('the mark is hidden from screen readers', brand.markHidden,
     'the wordmark beside it already says the name');
  ok('the mark carries both lightbar colours', brand.strokes.length === 2
     && brand.strokes[0] !== brand.strokes[1], brand.strokes.join(' / '));
  ok('the document is titled SireFlex', brand.title === 'SireFlex', brand.title);
}

console.log('\n--- the lightbar never comes on by itself ---');
{
  await p.locator('#keyStop').click();
  await p.waitForTimeout(300);
  const read = () => p.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    hidden: document.getElementById('strobe').hidden,
  }));
  const rest = await read();
  ok('background is black at rest', rest.bg === 'rgb(0, 0, 0)', rest.bg);
  ok('lightbar hidden at rest', rest.hidden);

  // Starting every tone, one after another, must leave it alone.
  for (const t of ['wail1', 'yelp', 'hilo', 'phaser', 'wawa', 'wail2', 'mech']) {
    await p.locator(`[data-tone="${t}"]`).click();
    await p.waitForTimeout(150);
  }
  await p.locator('#keyRumble').click();
  await p.locator('#keyAuto').click();
  await p.waitForTimeout(900);
  const busy = await read();
  ok('background still black with sirens running', busy.bg === 'rgb(0, 0, 0)', busy.bg);
  ok('lightbar still hidden with sirens running', busy.hidden);
  await p.locator('#keyAuto').click();
  await p.locator('#keyStop').click();
  await p.waitForTimeout(300);

  // And it does come on when its own key is pressed.
  await p.locator('#keyLmb').click();
  await p.waitForTimeout(300);
  ok('lightbar appears when LMB is pressed', !(await read()).hidden);
  await p.locator('#keyLmb').click();
  await p.waitForTimeout(300);
  ok('lightbar goes away when LMB is pressed again', (await read()).hidden);
}

console.log('\n--- the guide ---');
{
  // Snapshot the panel first: the point is that auditioning tones in the
  // guide leaves it exactly as it was, not that it is empty. Modifier keys
  // such as RUMBLE and MIX deliberately survive STOP, so "no keys lit" would
  // be the wrong thing to assert.
  const latchedBefore = await p.evaluate(() =>
    [...document.querySelectorAll('.key.is-on')].map((k) => k.dataset.act + ':' + (k.dataset.tone || k.dataset.eq || '')).sort().join(','));

  await p.locator('#btnInfo').click();
  await p.waitForTimeout(500);
  ok('guide opens from the side key', await p.locator('#guide').isVisible());
  ok('four tabs', (await p.locator('.guide__tabs button').count()) === 4);
  ok('a card per tone', (await p.locator('.gcard').count()) === 10);
  ok('two diagrams per tone', (await p.locator('.guide svg.dg').count()) === 20);

  // No diagram may contain a broken number.
  const broken = await p.evaluate(() =>
    [...document.querySelectorAll('.guide svg')]
      .filter((s) => /NaN|Infinity|undefined/.test(s.outerHTML)).length);
  ok('no broken coordinates in any diagram', broken === 0, `${broken} broken`);

  // Auditioning from the guide, and leaving it, must not disturb the panel.
  await p.locator('[data-play="yelp"]').click();
  await p.waitForTimeout(800);
  ok('preview plays', (await meter()) > 10, `${(await meter()).toFixed(0)}%`);
  ok('preview button shows Parar',
    (await p.locator('[data-play="yelp"]').innerText()).includes('Parar'));
  // Auditioning over a running faceplate: the display must name what is
  // actually being heard, and the panel must come back afterwards.
  await p.locator('.guide__close').click();
  await p.waitForTimeout(400);
  await p.locator('[data-tone="wail1"]').click();
  await p.waitForTimeout(500);
  await p.locator('#btnInfo').click();
  await p.waitForTimeout(400);
  await p.locator('[data-play="hilo"]').click();
  await p.waitForTimeout(700);
  ok('display names the tone being auditioned',
    (await p.locator('#lcdTone').innerText()).trim() === 'HI-LO');
  await p.locator('[data-play="hilo"]').click();
  await p.waitForTimeout(700);
  ok('display returns to the panel tone afterwards',
    (await p.locator('#lcdTone').innerText()).trim().startsWith('WAIL-1'));
  await p.locator('.guide__close').click();
  await p.waitForTimeout(400);
  await p.locator('[data-tone="wail1"]').click();
  await p.waitForTimeout(300);
  await p.locator('#btnInfo').click();
  await p.waitForTimeout(400);
  await p.locator('[data-play="yelp"]').click();
  await p.waitForTimeout(700);

  await p.locator('.guide__close').click();
  await p.waitForTimeout(700);
  ok('closing the guide stops the preview', (await meter()) < 2);
  const latchedAfter = await p.evaluate(() =>
    [...document.querySelectorAll('.key.is-on')].map((k) => k.dataset.act + ':' + (k.dataset.tone || k.dataset.eq || '')).sort().join(','));
  ok('the faceplate is exactly as it was', latchedAfter === latchedBefore,
    `${latchedBefore || '(none)'} -> ${latchedAfter || '(none)'}`);
  ok('the preview latched no tone key',
    (await p.locator('[data-tone].is-on').count()) === 0);

  // Every tab renders.
  await p.locator('#btnInfo').click();
  await p.waitForTimeout(300);
  for (const t of ['keys', 'how', 'set']) {
    await p.locator(`[data-tab="${t}"]`).click();
    await p.waitForTimeout(350);
    const len = (await p.locator('.guide__body').innerText()).length;
    ok(`tab "${t}" renders`, len > 400, `${len} chars`);
  }
  // Settings still work from inside the guide.
  await p.locator('#sVol').evaluate((e) => { e.value = 40; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(200);
  ok('volume slider in the guide applies',
    Math.abs((await p.evaluate(() => JSON.parse(localStorage.getItem('sireflex.v1')).volume)) - 0.4) < 0.01);
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);
}

console.log('\n--- a tone cannot outlive the finger ---');
{
  const live = () => p.evaluate(() => window.__live);
  const stopAll = async () => {
    await p.locator('[data-act="stop"]').click();
    await p.waitForTimeout(800);
  };
  // RUMBLE and MIX are latched by earlier groups and each adds a voice of its
  // own, so the counts below would be measuring the previous test's leftovers.
  for (const act of ['rumble', 'mix']) {
    const key = p.locator(`[data-act="${act}"]`);
    if ((await key.getAttribute('aria-pressed')) === 'true') {
      await key.click();
      await p.waitForTimeout(250);
    }
  }
  // Synthetic pointer events, because the point is what happens when the
  // button does NOT get the release. Playwright's own input always delivers
  // both halves to the element, which is exactly the case that works.
  const pdown = (sel, id) => p.locator(sel).evaluate((el, id) =>
    el.dispatchEvent(new PointerEvent('pointerdown',
      { bubbles: true, cancelable: true, pointerId: id, isPrimary: true })), id);
  const windowUp = (id) => p.evaluate((id) =>
    window.dispatchEvent(new PointerEvent('pointerup',
      { bubbles: true, pointerId: id, isPrimary: true })), id);

  // Every count below is absolute, so the group states its own starting
  // point rather than trusting what the previous one left behind.
  await stopAll();
  ok('nothing is sounding going in', (await live()) === 0, `${await live()} voz(es)`);

  // The Q-siren coasts for thirty seconds after its release. Switching to
  // another tone used to hand it that release, so the Q kept blaring over
  // whatever came next and drove the master limiter down on top of it: the
  // panel looked alive and no other siren could be heard. The meter cannot
  // see this — it saturates either way — so count the voices.
  await stopAll();
  await p.locator('[data-tone="mech"]').click();
  await p.waitForTimeout(3000);
  ok('the Q-siren is running', (await live()) === 1, `${await live()} voz(es)`);
  await p.locator('[data-tone="wail1"]').click();
  await p.waitForTimeout(1400);
  ok('switching away from the Q leaves one voice', (await live()) === 1,
    `${await live()} voz(es) — a Q deveria ter sido cortada`);
  ok('and the new tone is the latched one',
    (await p.locator('[data-tone="wail1"]').getAttribute('aria-pressed')) === 'true');

  // A momentary key whose own pointerup never arrives. iOS can take a touch
  // away mid-press — a system gesture claims it, the capture is lost — and
  // the note then sounded forever, with every further press stacking another
  // on top of it.
  await stopAll();
  await pdown('[data-act="manual"]', 7);
  await p.waitForTimeout(900);
  ok('manual sounds while held', (await live()) === 1, `${await live()} voz(es)`);
  await windowUp(7);
  await p.waitForTimeout(4600);
  ok('manual stops when only the window sees the release', (await live()) === 0,
    `${await live()} voz(es) ainda tocando`);

  // The release path itself must not be skippable. It schedules automation on
  // a live AudioParam, and when one of those calls threw, the note kept
  // sounding with nothing left holding a reference to it — the key had
  // already left the map — so STOP could not reach it and the next press
  // stacked a second note on top. The fault is injected rather than argued
  // about: whatever throws, the note has to end.
  await stopAll();
  await pdown('[data-act="manual"]', 11);
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    const proto = AudioParam.prototype;
    const real = proto.exponentialRampToValueAtTime;
    let armed = true;
    proto.exponentialRampToValueAtTime = function (...a) {
      if (armed) { armed = false; throw new Error('falha injetada no release'); }
      return real.apply(this, a);
    };
    window.__restore = () => { proto.exponentialRampToValueAtTime = real; };
  });
  await windowUp(11);
  await p.waitForTimeout(4600);
  ok('a release that throws still silences the note', (await live()) === 0,
    `${await live()} voz(es) ainda tocando`);
  await p.evaluate(() => window.__restore());

  // And the symptom that followed from it.
  await pdown('[data-act="manual"]', 12);
  await p.waitForTimeout(700);
  ok('pressing again never stacks a second note', (await live()) === 1,
    `${await live()} voz(es)`);
  await windowUp(12);
  await p.waitForTimeout(4600);
  ok('and the survivor still stops', (await live()) === 0, `${await live()} voz(es)`);

  // The release must not depend on a JavaScript timer at all. iOS throttles
  // and drops them in a web app that is idle or in the background, and the
  // manual wail's silencing used to be one three and a half seconds out: the
  // pitch fell, because that part is audio-thread automation, and then the
  // note held its bottom note forever. Timers are switched off here for the
  // whole release, which is the only honest way to test "does not depend on
  // a timer".
  await stopAll();
  await pdown('[data-act="manual"]', 31);
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    window.__timers = [window.setTimeout, window.setInterval];
    window.setTimeout = () => 0;
    window.setInterval = () => 0;
  });
  await windowUp(31);
  await p.waitForTimeout(5000);
  const survived = await live();
  await p.evaluate(() => {
    [window.setTimeout, window.setInterval] = window.__timers;
  });
  ok('the release survives timers being dropped', survived === 0,
    `${survived} voz(es) ainda tocando sem setTimeout`);

  // The guide's horn preview ends itself after a stab, and that ending used
  // to be a timer too.
  await stopAll();
  await p.locator('#btnInfo').click();
  await p.waitForTimeout(400);
  await p.locator('[data-tab="tones"]').click();
  await p.waitForTimeout(400);
  await p.locator('[data-play="airhorn"]').click();
  await p.waitForTimeout(500);
  // Two sources, not one: the horn's release is scheduled the moment the
  // stab starts, so the buffer that ends it is already in the graph waiting
  // its turn. That is the point — the ending does not depend on anything
  // happening later on the main thread. So this one asks the meter.
  ok('the guide previews the air horn', (await meter()) > 2, `medidor ${await meter()}%`);
  await p.evaluate(() => {
    window.__timers = [window.setTimeout, window.setInterval];
    window.setTimeout = () => 0;
    window.setInterval = () => 0;
  });
  await p.waitForTimeout(3500);
  const hornLeft = await live();
  await p.evaluate(() => { [window.setTimeout, window.setInterval] = window.__timers; });
  ok('the horn preview ends itself without timers', hornLeft === 0,
    `${hornLeft} voz(es) ainda tocando`);

  // And stopping a preview early still means now, not when it felt like it.
  await p.locator('[data-play="airhorn"]').click();
  await p.waitForTimeout(300);
  await p.locator('[data-play="airhorn"]').click();
  await p.waitForTimeout(500);
  ok('stopping a preview early stops it now', (await live()) === 0,
    `${await live()} voz(es)`);
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);

  // The safety net must not cost two-handed use: the panel is meant to be
  // played with a siren latched and the horn stabbed over it.
  await stopAll();
  await pdown('[data-act="horn"]', 21);
  await p.waitForTimeout(700);
  ok('the horn sounds while held', (await live()) === 1, `${await live()} voz(es)`);
  await windowUp(22);                       // a different finger, elsewhere
  await p.waitForTimeout(600);
  ok('another finger lifting does not release the horn', (await live()) === 1,
    `${await live()} voz(es)`);
  await windowUp(21);                       // the one actually holding it
  await p.waitForTimeout(1600);
  ok('its own finger does', (await live()) === 0, `${await live()} voz(es)`);

  await stopAll();
}

console.log('\n--- the timbre, measured through the real chain ---');
{
  /**
   * Renders a tone offline through the app's own engine and reports where
   * its energy is. Everything downstream of a voice used to be describable
   * only in prose, which is how a master chain quietly changes the timbre of
   * every tone in the app and nobody notices until someone listens on a
   * phone.
   */
  const balance = (id) => p.evaluate(async (id) => {
    const [{ AudioEngine }, { createVoice }, { TONES }] = await Promise.all([
      import('./js/audio/engine.js'),
      import('./js/audio/voices.js'),
      import('./js/audio/tones.js'),
    ]);
    const SR = 48000;
    const ctx = new OfflineAudioContext(1, SR * 5, SR);
    const engine = new AudioEngine();
    engine.attachContext(ctx);
    const voice = createVoice(engine, TONES[id], {});
    voice.start(0);
    const d = (await ctx.startRendering()).getChannelData(0);

    const N = 4096;
    const fft = (re, im) => {
      const n = re.length;
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
    };

    const acc = new Float64Array(N >> 1);
    for (let s = 0; s + N < d.length; s += N >> 1) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        re[i] = d[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      }
      fft(re, im);
      for (let i = 0; i < acc.length; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
    }
    const bin = (hz) => Math.round((hz / SR) * N);
    let total = 0, low = 0, high = 0;
    for (let i = 0; i < acc.length; i++) total += acc[i];
    for (let i = 0; i < bin(1250); i++) low += acc[i];
    for (let i = bin(2500); i < acc.length; i++) high += acc[i];
    let peak = 0;
    for (const v of d) { const a = Math.abs(v); if (a > peak) peak = a; }
    return { low: (low / total) * 100, high: (high / total) * 100, peak };
  }, id);

  // A wail's fundamental sweeps 725–1800 Hz. The radiator must not tilt the
  // sound off its own fundamental and onto the harmonic stack above it: the
  // curve this replaced put 54% of the energy above 1250 Hz and only 34%
  // below, which reads as thin and wrong on the one speaker this app is
  // actually played through.
  const w = await balance('wail1');
  ok('the wail keeps its weight at the fundamental', w.low > 62,
    `${w.low.toFixed(0)}% até 1250 Hz`);
  ok('and is not shrill on a phone speaker', w.high < 4,
    `${w.high.toFixed(0)}% acima de 2500 Hz`);

  // One voice must not arrive at the master limiter already over its
  // threshold, or the limiter is a compressor that is always on and the
  // dynamics of every sweep are squashed flat.
  ok('one voice leaves headroom for the limiter', w.peak < 0.85,
    `pico ${w.peak.toFixed(2)}`);

  const h = await balance('hilo');
  ok('hi-lo keeps its weight too', h.low > 90, `${h.low.toFixed(0)}% até 1250 Hz`);
}

console.log('\n--- version and self-update ---');
{
  // A build number nobody can see is a build number nobody can trust. This
  // row is how the answer to "is this the new version?" stops being a guess.
  await p.locator('#btnInfo').click();
  await p.waitForTimeout(300);
  await p.locator('[data-tab="set"]').click();
  await p.waitForTimeout(350);
  const txt = await p.locator('.guide__body').innerText();
  ok('settings show the build number', /SireFlex v\d+/.test(txt),
    (txt.match(/SireFlex v[\d.]+[^\n]*/) || ['not found'])[0]);

  // The check button must answer something. Without a service worker (this
  // page is served over plain http from a script) it reloads, so only the
  // presence and wiring are checked here; the strategy itself is measured in
  // the node suite.
  ok('settings offer a manual update check',
    (await p.locator('#bUpd').count()) === 1);

  await p.locator('.guide__close').click();
  await p.waitForTimeout(250);

  // The notice must never be in the way unless a new build arrived mid-tone.
  ok('update notice is hidden by default',
    await p.locator('#update').evaluate((e) => e.hidden));
  ok('update notice takes no space while hidden',
    (await p.locator('#update').evaluate((e) => getComputedStyle(e).display)) === 'none');
}

console.log(`\n\x1b[1m${pass}/${pass + fail} UI checks passed\x1b[0m${fail ? `  \x1b[31m(${fail} failing)\x1b[0m` : ''}`);
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
process.exit(fail ? 1 : 0);
