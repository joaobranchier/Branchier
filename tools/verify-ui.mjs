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
  window.__live = 0;      // playing right now
  window.__started = 0;   // ever started, which is how a 75 ms click is seen
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__live++;
    window.__started++;
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
await p.locator('#dockPower').click();
await p.waitForTimeout(500);
const off = await p.evaluate(() => ({
  lcd: document.getElementById('lcdTone').textContent,
  standby: document.getElementById('remote').classList.contains('is-standby'),
  m: parseFloat(document.getElementById('meterFill').style.width) || 0,
}));
ok('power off -> standby + silence', off.standby && off.lcd === 'STANDBY' && off.m < 2, JSON.stringify(off));
await p.locator('#dockPower').click();
await p.waitForTimeout(400);
ok('power on -> leaves standby',
  await p.evaluate(() => !document.getElementById('remote').classList.contains('is-standby')));

console.log('\n--- volume readout actually appears ---');
await p.locator('#dockVolDown').click();
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
      name: b.querySelector('.brand__name')?.innerText.replace(/\s+/g, ''),
      model: b.querySelector('.brand__model')?.innerText.replace(/\s+/g, ' ').trim(),
      offset: Math.abs((r.left + r.width / 2) - (rem.left + rem.width / 2)),
      usesMark: mark?.getAttribute('href') === '#i-logo',
      markHidden: b.querySelector('.brand__mark')?.getAttribute('aria-hidden') === 'true',
      strokes,
      title: document.title,
    };
  });
  ok('the name is on the panel', brand?.name === 'SireFlex', brand?.name);
  ok('with the model number under it', brand?.model === 'SF500 PRO', brand?.model);
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
  ok('lightbar appears when LED is pressed', !(await read()).hidden);
  await p.locator('#keyLmb').click();
  await p.waitForTimeout(300);
  ok('lightbar goes away when LED is pressed again', (await read()).hidden);
}

console.log('\n--- the guide ---');
{
  // Snapshot the panel first: the point is that auditioning tones in the
  // guide leaves it exactly as it was, not that it is empty. Modifier keys
  // such as RUMBLE and MIX deliberately survive STOP, so "no keys lit" would
  // be the wrong thing to assert.
  const latchedBefore = await p.evaluate(() =>
    [...document.querySelectorAll('.key.is-on')].map((k) => k.dataset.act + ':' + (k.dataset.tone || k.dataset.eq || '')).sort().join(','));

  await p.locator('#dockGuide').click();
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
  await p.locator('#dockGuide').click();
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
  await p.locator('#dockGuide').click();
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
  await p.locator('#dockGuide').click();
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
  await p.locator('#dockGuide').click();
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

console.log('\n--- PHSR is a priority channel, not another tone ---');
{
  const state = () => p.evaluate(() => ({
    lcd: document.getElementById('lcdTone').innerText.trim(),
    on: [...document.querySelectorAll('.key.is-on[data-tone]')].map((k) => k.dataset.tone),
    armed: [...document.querySelectorAll('.key.is-armed[data-tone]')].map((k) => k.dataset.tone),
    meter: parseFloat(document.getElementById('meterFill').style.width) || 0,
  }));
  const press = async (sel) => { await p.locator(sel).click(); await p.waitForTimeout(700); };

  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(600);

  await press('[data-tone="wail1"]');
  ok('the wail is running', (await state()).lcd.startsWith('WAIL-1'));

  await press('[data-tone="phaser"]');
  let st = await state();
  ok('PHSR takes over from it', st.lcd === 'PHSR' && st.on.join() === 'phaser',
    `${st.lcd} / ligados: ${st.on.join() || 'nenhum'}`);
  ok('and the wail waits, visibly', st.armed.join() === 'wail1',
    `esperando: ${st.armed.join() || 'nenhum'}`);
  ok('one voice at a time, not both', st.meter > 10, `medidor ${st.meter}%`);

  await press('[data-tone="phaser"]');
  st = await state();
  ok('switching PHSR off brings the wail back by itself',
    st.lcd.startsWith('WAIL-1') && st.on.join() === 'wail1',
    `${st.lcd} / ligados: ${st.on.join() || 'nenhum'}`);
  ok('and nothing is left waiting', st.armed.length === 0, st.armed.join());
  ok('it is actually sounding again', st.meter > 10, `medidor ${st.meter}%`);

  // Choosing a different tone while the override is up is a change of mind,
  // and what it was holding must not come back later to surprise anyone.
  await press('[data-tone="phaser"]');
  await press('[data-tone="yelp"]');
  st = await state();
  ok('picking another tone drops what was waiting', st.armed.length === 0, st.armed.join());
  await press('[data-tone="yelp"]');
  st = await state();
  ok('and switching that off leaves silence, not a ghost',
    st.on.length === 0 && st.lcd === 'PRONTO', `${st.lcd} / ${st.on.join()}`);

  // STOP is STOP.
  await press('[data-tone="wail1"]');
  await press('[data-tone="phaser"]');
  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(700);
  st = await state();
  ok('STOP clears the waiting tone too',
    st.on.length === 0 && st.armed.length === 0 && st.meter < 2,
    `${st.on.join()} / ${st.armed.join()} / ${st.meter}%`);

  // With nothing selected it is simply a tone, like any other key.
  await press('[data-tone="phaser"]');
  ok('on its own it latches like any other tone', (await state()).lcd === 'PHSR');
  await press('[data-tone="phaser"]');
  ok('and unlatches into silence', (await state()).lcd === 'PRONTO');

  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(500);
}

console.log('\n--- the dock, and the key click ---');
{
  const live = () => p.evaluate(() => window.__live);
  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(600);

  // The guide and the settings used to be reachable only through buttons
  // moulded into the case edges — a few millimetres of glass with no label.
  // On a phone that is not a control, it is a decoration in front of a door.
  ok('the side nubs are gone', (await p.locator('.nub, .side').count()) === 0);

  // There was a speaker grille moulded across the top of the case, which on
  // a rounded dark rectangle reads as an earpiece — and an earpiece makes
  // the thing a telephone. This is a siren head; it has no ear.
  ok('no earpiece on a control head', (await p.locator('.grille').count()) === 0);

  // The badge is printing on the panel and has to be legible as such. Given
  // as a fraction of the unit, so it holds at every scale the faceplate
  // takes; it was under a sixth of the width and read as a watermark.
  const badgeShare = await p.evaluate(() =>
    document.querySelector('.brand').getBoundingClientRect().width
      / document.querySelector('.remote').getBoundingClientRect().width);
  ok('the badge is printed large enough to read', badgeShare > 0.2,
    `${(badgeShare * 100).toFixed(0)}% da largura do aparelho`);

  // MANUAL has the big momentary key and the air horn has a pill. It is the
  // one that gets played — held, worked, let go — rather than stabbed, so it
  // is the one worth a thumb-sized target.
  const layout = await p.evaluate(() => {
    const big = document.querySelector('.key--big');
    const pills = [...document.querySelectorAll('.key--pill')].map((k) => k.dataset.act);
    return { big: big?.dataset.act, bigArea: big?.getBoundingClientRect().width
      * big?.getBoundingClientRect().height, pills };
  });
  ok('MANUAL holds the big key', layout.big === 'manual', layout.big);
  ok('and the air horn is one of the pills', layout.pills.includes('horn'),
    layout.pills.join(' '));
  const pillArea = await p.locator('[data-act="horn"]').evaluate((e) => {
    const r = e.getBoundingClientRect();
    return r.width * r.height;
  });
  ok('the big key really is the bigger of the two', layout.bigArea > pillArea * 1.5,
    `${Math.round(layout.bigArea)} contra ${Math.round(pillArea)} px²`);

  ok('the low channel is named RUMBLER',
    (await p.locator('[data-act="rumble"] .key__lbl').innerText()).trim() === 'RUMBLER');

  // The badge in the middle of the panel, where a manufacturer prints one.
  const badge = (await p.locator('.brand').innerText()).replace(/\s+/g, ' ').trim();
  ok('the badge carries the name and the model', badge === 'SireFlex SF500 PRO', badge);
  const [nameSize, modelSize] = await p.evaluate(() => [
    parseFloat(getComputedStyle(document.querySelector('.brand__name')).fontSize),
    parseFloat(getComputedStyle(document.querySelector('.brand__model')).fontSize),
  ]);
  ok('the model is set smaller than the name', modelSize < nameSize,
    `${modelSize.toFixed(1)}px vs ${nameSize.toFixed(1)}px`);

  // The two lightbar keys read in Portuguese on the panel, whatever the
  // action names underneath them still say.
  const lightKeys = await p.evaluate(() => [
    document.querySelector('[data-act="lmb"] .key__lbl').textContent.trim(),
    document.querySelector('[data-act="light"] .key__lbl').textContent.trim(),
  ]);
  ok('the lightbar keys read LED and LUZ', lightKeys.join('/') === 'LED/LUZ', lightKeys.join('/'));
  ok('the dock has its five keys', (await p.locator('.dock__btn').count()) === 5);
  const small = await p.locator('.dock__btn').evaluateAll((els) =>
    els.filter((e) => e.getBoundingClientRect().height < 44).length);
  ok('every dock key is big enough to hit', small === 0, `${small} pequeno(s) demais`);

  await p.locator('#dockGuide').click();
  await p.waitForTimeout(400);
  ok('the dock opens the guide', !(await p.locator('#guide').evaluate((e) => e.hidden)));
  ok('and lands on the tones tab',
    (await p.locator('[data-tab="tones"]').getAttribute('aria-selected')) === 'true');
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);

  // The keyboard path. These act on pointerdown, so a click is how a keyboard
  // and a screen reader reach them — and the click that follows a tap has to
  // be told apart from that one, or every tap fires the action twice.
  await p.locator('#dockGuide').focus();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(400);
  ok('Enter opens the guide from the dock',
    !(await p.locator('#guide').evaluate((e) => e.hidden)));
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);

  await p.locator('#dockSet').click();
  await p.waitForTimeout(400);
  ok('and the settings key lands on settings',
    (await p.locator('[data-tab="set"]').getAttribute('aria-selected')) === 'true');
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);

  // The click has to be audible, and it has to be audible from the one key
  // whose whole job is to silence everything: it is routed past voiceSum for
  // exactly that reason, so pressing STOP still answers.
  // Counted as starts, not as voices playing: a click is seventy-five
  // milliseconds long and is over before any poll could catch it alive.
  const started = () => p.evaluate(() => window.__started);
  const clicksOn = async (sel) => {
    const before = await started();
    await p.locator(sel).click();
    await p.waitForTimeout(250);
    const after = await started();
    await p.locator('[data-act="stop"]').click();
    await p.waitForTimeout(400);
    return after > before;
  };
  ok('a key answers with a click', await clicksOn('[data-act="mod"]'));
  ok('STOP does not swallow its own click', await clicksOn('[data-act="stop"]'));
  ok('a dock key answers too', await clicksOn('#dockVolUp'));

  // And it can be switched off, for people who would rather it were not there.
  await p.locator('#dockSet').click();
  await p.waitForTimeout(450);
  await p.locator('#tClack').click();
  await p.waitForTimeout(300);
  await p.locator('.guide__close').click();
  await p.waitForTimeout(400);
  ok('the click can be switched off', !(await clicksOn('[data-act="mod"]')));
  await p.locator('#dockSet').click();
  await p.waitForTimeout(450);
  await p.locator('#tClack').click();
  await p.waitForTimeout(300);
  await p.locator('.guide__close').click();
  await p.waitForTimeout(400);
  ok('and back on', await clicksOn('[data-act="mod"]'));

  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(600);
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

console.log('\n--- the panel survives the audio refusing to start ---');
{
  // Safari allows an origin only a few live AudioContexts, and two copies of
  // the app open at once reaches the limit: a tab plus the home-screen icon,
  // which is what adding it to the home screen again without removing the old
  // one leaves you with. The constructor then throws — and that exception used
  // to reject the key handler, so the press never reached the action. Not for
  // that key: for every key, on every press, from then on. The panel was dead.
  const ctxDead = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctxDead.addInitScript(() => {
    const refuse = function () { throw new Error('NotAllowedError: too many AudioContexts'); };
    Object.defineProperty(window, 'AudioContext', { value: refuse, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: refuse, configurable: true });
  });
  const pd = await ctxDead.newPage();
  const deadErrs = [];
  pd.on('pageerror', (e) => deadErrs.push(e.message));
  await pd.goto(`${BASE}/index.html`);
  await pd.waitForTimeout(600);
  await pd.locator('.btn[data-close]').click();
  await pd.waitForTimeout(300);

  await pd.locator('[data-tone="wail1"]').click();
  await pd.waitForTimeout(500);
  ok('a dead audio context throws nothing at the page', deadErrs.length === 0,
    deadErrs.slice(0, 2).join(' | '));
  ok('and the panel says why instead of going quiet',
    /indispon/i.test(await pd.locator('#hint').innerText()),
    (await pd.locator('#hint').innerText()).slice(0, 48));

  // Everything that is not a sound still has to work.
  await pd.locator('[data-act="lmb"]').click();
  await pd.waitForTimeout(400);
  ok('the lightbar still works without audio',
    !(await pd.locator('#strobe').evaluate((e) => e.hidden)));
  await pd.locator('[data-act="lmb"]').click();
  await pd.waitForTimeout(300);

  await pd.locator('#dockGuide').click();
  await pd.waitForTimeout(500);
  ok('and the guide still opens', !(await pd.locator('#guide').evaluate((e) => e.hidden)));
  ok('still nothing thrown', deadErrs.length === 0, deadErrs.slice(0, 2).join(' | '));
  await ctxDead.close();
}

console.log('\n--- MOD moves the rumble layer with the siren ---');
{
  const started = () => p.evaluate(() => window.__started);
  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(600);
  // Leave RUMBLE off first, to learn what one MOD press costs on its own.
  await p.locator('[data-tone="wail1"]').click();
  await p.waitForTimeout(600);
  const a = await started();
  await p.locator('[data-act="mod"]').click();
  await p.waitForTimeout(600);
  const alone = (await started()) - a;

  // Now with the layer running. The Rumbler exists to follow the siren above
  // it; MOD used to change the siren's sweep rate and leave the layer at the
  // old one, because the call that was supposed to carry the rate went to a
  // method this voice does not implement and did nothing at all.
  await p.locator('[data-act="rumble"]').click();
  await p.waitForTimeout(700);
  const b = await started();
  await p.locator('[data-act="mod"]').click();
  await p.waitForTimeout(700);
  const withLayer = (await started()) - b;
  ok('MOD rebuilds the rumble layer as well as the siren', withLayer > alone,
    `${alone} voz(es) sem a camada, ${withLayer} com ela`);

  await p.locator('[data-act="rumble"]').click();
  await p.locator('[data-act="stop"]').click();
  await p.waitForTimeout(600);
}

console.log('\n--- the colophon, and the settings sheet ---');
{
  await p.locator('#dockSet').click();
  await p.waitForTimeout(500);

  const credit = (await p.locator('.guide__body .gcredit').innerText())
    .replace(/\s+/g, ' ').trim();
  ok('settings are signed', /BRANCHIER LAW TECH/i.test(credit) && credit.includes('2026'),
    credit.slice(0, 40));
  ok('and say what the house does',
    /simuladores jurídicos, legais e de segurança pública/i.test(credit));

  // Every row in Settings is a label with its description under it. Both are
  // inline elements, so for a long time they ran together on one line and
  // each row read as one sentence with a stray capital in the middle.
  const stacked = await p.evaluate(() =>
    [...document.querySelectorAll('.guide__body .switchrow > div')].every((d) => {
      const t = d.querySelector('span');
      const s = d.querySelector('small');
      if (!t || !s) return true;
      return t.getBoundingClientRect().bottom <= s.getBoundingClientRect().top + 1;
    }));
  ok('every settings row stacks its description', stacked);

  // The donation block, and the one thing about it that matters: the key on
  // screen and the key on the clipboard have to be the same string, since a
  // Pix key that copies wrong sends someone's money to nobody.
  const shownKey = (await p.locator('#pixKey').innerText()).trim();
  ok('the Pix key is on screen', /^[0-9a-f-]{36}$/.test(shownKey), shownKey);

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.locator('#bPix').click();
  await p.waitForTimeout(400);
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  ok('and the button copies exactly it', copied === shownKey, copied);
  ok('the button says it worked',
    /copiada/i.test(await p.locator('#bPix').innerText()),
    await p.locator('#bPix').innerText());

  // If both clipboard paths are refused, the key still has to be selectable
  // by hand — the app switches selection off everywhere else.
  const selectable = await p.locator('#pixKey').evaluate((e) =>
    getComputedStyle(e).webkitUserSelect !== 'none'
      && getComputedStyle(e).userSelect !== 'none');
  ok('and stays selectable by hand', selectable);

  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);
}

console.log('\n--- version and self-update ---');
{
  // A build number nobody can see is a build number nobody can trust. This
  // row is how the answer to "is this the new version?" stops being a guess.
  await p.locator('#dockGuide').click();
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

console.log('\n--- MOD changes the speed of the sweep and nothing else ---');
{
  // Every press of MOD used to start the new buffer from its top — the
  // bottom of the sweep — so a wail at 1400 Hz dropped to 725 Hz, with the
  // old buffer still sounding over it for fifty milliseconds. Rendered here
  // through the real voice and chain, and the pitch measured on both sides.
  const r = await p.evaluate(async () => {
    const [{ AudioEngine }, { createVoice, getBuffers }, { TONES }] = await Promise.all([
      import('./js/audio/engine.js'), import('./js/audio/voices.js'), import('./js/audio/tones.js')]);
    const SR = 48000;
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const engine = new AudioEngine(); engine.attachContext(ctx);
    engine.wet.gain.value = 0;
    const v = createVoice(engine, TONES.wail1); v.start(0);
    const at = 1.3;
    const shown = {};
    ctx.suspend(at).then(() => {
      shown.before = v.frequency();
      v.setRate(1.55);
      shown.after = v.frequency();
      ctx.resume();
    });
    const d = (await ctx.startRendering()).getChannelData(0);

    // Autocorrelation pitch, in 12 ms windows either side of the swap.
    const pitch = (s) => {
      let best = 0, lag0 = 0;
      for (let lag = 24; lag <= 70; lag++) {
        let c = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < 576; i++) { c += d[s + i] * d[s + i + lag]; e1 += d[s + i] ** 2; e2 += d[s + i + lag] ** 2; }
        const q = c / Math.sqrt(e1 * e2 + 1e-12);
        if (q > best) { best = q; lag0 = lag; }
      }
      return SR / lag0;
    };
    // Octave errors are the tracker's, not the siren's: fold to the sweep band.
    const fold = (f) => { while (f < 700) f *= 2; while (f > 1850) f /= 2; return f; };
    const pre = fold(pitch(Math.round((at - 0.03) * SR)));
    const post = fold(pitch(Math.round((at + 0.05) * SR)));
    let peak = 0, steady = 0;
    for (let i = Math.round((at - 0.01) * SR); i < Math.round((at + 0.06) * SR); i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = Math.round(0.5 * SR); i < Math.round(1.2 * SR); i++) steady = Math.max(steady, Math.abs(d[i]));

    // WA.WA's tremolo is locked to its sweep; at FAST both must move.
    const fast = getBuffers(engine, TONES.wawa, { rate: 1.55 });
    const w = fast.buffer.getChannelData(0);
    const win = 240, env = [];
    for (let i = 0; i + win <= w.length; i += win) {
      let s = 0; for (let j = 0; j < win; j++) s += w[i + j] ** 2; env.push(Math.sqrt(s / win));
    }
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    let bestLag = 0, bestC = -Infinity;
    for (let lag = 20; lag < env.length / 2; lag++) {
      let c = 0; for (let i = 0; i + lag < env.length; i++) c += (env[i] - mean) * (env[i + lag] - mean);
      if (c > bestC) { bestC = c; bestLag = lag; }
    }
    return { pre, post, shown, peak, steady,
      tremoloS: (bestLag * win) / SR, sweepS: 1 / (TONES.wawa.rateHz * 1.55) };
  });
  ok('MOD does not send the sweep back to the bottom',
    Math.abs(r.post - r.pre) < 120, `${r.pre.toFixed(0)} Hz -> ${r.post.toFixed(0)} Hz`);
  ok('and the display agrees', Math.abs(r.shown.after - r.shown.before) < 5,
    `${r.shown.before.toFixed(0)} -> ${r.shown.after.toFixed(0)} Hz`);
  ok('the handover does not stack two sirens', r.peak <= r.steady * 1.08,
    `pico ${r.peak.toFixed(3)} (normal ${r.steady.toFixed(3)})`);
  ok('WA.WA tremolo follows MOD with the sweep', Math.abs(r.tremoloS - r.sweepS) / r.sweepS < 0.06,
    `tremolo ${r.tremoloS.toFixed(3)} s, varredura ${r.sweepS.toFixed(3)} s`);
}

console.log('\n--- RUMBLER follows a played tone, not a sweep of its own ---');
{
  // Under MANUAL the layer used to sweep by itself at the wail's rate, deaf
  // to the thumb, and cut out the instant the key was let go while the note
  // was still falling. It now rides on the manual voice's own pitch control.
  const r = await p.evaluate(async () => {
    const [{ AudioEngine }, { createVoice }, { TONES }] = await Promise.all([
      import('./js/audio/engine.js'), import('./js/audio/voices.js'), import('./js/audio/tones.js')]);
    const SR = 48000;
    const ctx = new OfflineAudioContext(1, SR * 5, SR);
    const engine = new AudioEngine(); engine.attachContext(ctx);
    engine.wet.gain.value = 0;
    const lead = createVoice(engine, TONES.manual);
    lead.out.disconnect();                       // listen to the layer alone
    const layer = createVoice(engine, TONES.rumbler, { followHz: lead.baseHz });
    const linked = lead.lead?.(layer) ?? false;
    lead.start(0); layer.start(0);
    const release = 1.6;
    ctx.suspend(release).then(() => { lead.stop(ctx.currentTime); ctx.resume(); });
    const d = (await ctx.startRendering()).getChannelData(0);

    // Autocorrelation, taking the shortest lag that correlates nearly as
    // well as the best one: twice the period correlates just as well, and
    // picking it would read every note an octave low.
    const pitch = (t) => {
      const s = Math.round(t * SR), win = 2400, q = [];
      for (let lag = 100; lag <= 420; lag++) {
        let c = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < win; i++) { c += d[s + i] * d[s + i + lag]; e1 += d[s + i] ** 2; e2 += d[s + i + lag] ** 2; }
        q[lag] = c / Math.sqrt(e1 * e2 + 1e-12);
      }
      const best = Math.max(...q.filter(Number.isFinite));
      let lag0 = 100;
      while (lag0 < 420 && !(q[lag0] >= best * 0.92 && q[lag0] >= q[lag0 - 1] && q[lag0] >= q[lag0 + 1])) lag0++;
      return SR / lag0;
    };
    const level = (t) => {
      let s = 0; const a = Math.round(t * SR), n = 2400;
      for (let i = a; i < a + n; i++) s += d[i] ** 2;
      return Math.sqrt(s / n);
    };
    return {
      linked,
      low: pitch(0.12), high: pitch(1.45), falling: pitch(release + 1.0),
      before: level(release - 0.1), during: level(release + 0.9), after: level(release + 2.6),
    };
  });
  ok('the layer is driven by the manual voice', r.linked);
  ok('it rises with the thumb, two octaves down',
    r.low < 170 && r.high > 300, `${r.low.toFixed(0)} Hz -> ${r.high.toFixed(0)} Hz`);
  ok('and falls with the note when it is let go', r.falling < r.high - 40,
    `${r.high.toFixed(0)} Hz -> ${r.falling.toFixed(0)} Hz`);
  ok('still sounding through the fall, not cut at the release', r.during > r.before * 0.3,
    `${(r.during / r.before * 100).toFixed(0)}% do nível`);
  ok('and silent at the bottom', r.after < r.before * 0.01, `${(r.after / r.before * 100).toFixed(2)}%`);

  // Switched on halfway through the Q's wind-up, the layer has to join the
  // rotor where it is — not start from rest, and not jump to full speed.
  const q = await p.evaluate(async () => {
    const [{ AudioEngine }, { createVoice }, { TONES }] = await Promise.all([
      import('./js/audio/engine.js'), import('./js/audio/voices.js'), import('./js/audio/tones.js')]);
    const SR = 48000;
    const ctx = new OfflineAudioContext(1, SR * 4, SR);
    const engine = new AudioEngine(); engine.attachContext(ctx);
    engine.wet.gain.value = 0;
    const rotor = createVoice(engine, TONES.mech);
    rotor.out.disconnect();
    rotor.start(0);
    let layer = null;
    ctx.suspend(0.8).then(() => {
      layer = createVoice(engine, TONES.rumbler, { followHz: rotor.baseHz });
      rotor.lead?.(layer);
      layer.start(ctx.currentTime);
      ctx.resume();
    });
    const d = (await ctx.startRendering()).getChannelData(0);
    const pitch = (t) => {
      const s = Math.round(t * SR), win = 3600, q = [];
      for (let lag = 60; lag <= 900; lag++) {
        let c = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < win; i++) { c += d[s + i] * d[s + i + lag]; e1 += d[s + i] ** 2; e2 += d[s + i + lag] ** 2; }
        q[lag] = c / Math.sqrt(e1 * e2 + 1e-12);
      }
      const best = Math.max(...q.filter(Number.isFinite));
      let lag0 = 60;
      while (lag0 < 900 && !(q[lag0] >= best * 0.92 && q[lag0] >= q[lag0 - 1] && q[lag0] >= q[lag0 + 1])) lag0++;
      return SR / lag0;
    };
    return {
      mid: pitch(1.4), midWant: rotor.frequency(1.45) / 4,
      top: pitch(3.2), topWant: rotor.baseHz / 4,
    };
  });
  ok('joining a Q mid wind-up, the layer picks the rotor up where it is',
    Math.abs(q.mid - q.midWant) / q.midWant < 0.08,
    `${q.mid.toFixed(0)} Hz (rotor/4 = ${q.midWant.toFixed(0)} Hz)`);
  ok('and reaches full speed with it', Math.abs(q.top - q.topWant) / q.topWant < 0.05,
    `${q.top.toFixed(0)} Hz (rotor/4 = ${q.topWant.toFixed(0)} Hz)`);

  // End to end, through the controller: nothing may throw, and STOP must
  // still reach a layer that is falling with its note.
  errs.length = 0;
  await p.locator('#keyRumble').click();
  const mb = await p.locator('#keyManual').boundingBox();
  await p.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(700);
  await p.mouse.up();
  await p.waitForTimeout(300);
  await p.locator('#keyStop').click();
  await p.waitForTimeout(500);
  ok('RUMBLER + MANUAL: silent after STOP', (await meter()) < 2, `${(await meter()).toFixed(0)}%`);
  await p.locator('[data-tone="mech"]').click();
  await p.waitForTimeout(1200);
  await p.locator('[data-tone="mech"]').click();       // off: it coasts
  await p.waitForTimeout(600);
  const coasting = await meter();
  await p.locator('#keyStop').click();
  await p.waitForTimeout(500);
  ok('RUMBLER + Q-SIREN: coasting, then silent after STOP', coasting > 5 && (await meter()) < 2,
    `${coasting.toFixed(0)}% -> ${(await meter()).toFixed(0)}%`);
  await p.locator('#keyRumble').click();
  ok('no page errors from the layer', errs.length === 0, errs.slice(0, 2).join(' | '));
}

console.log('\n--- a key pressed in standby wakes the whole panel ---');
{
  await p.locator('#keyStop').click();
  await p.waitForTimeout(200);
  await p.locator('#dockPower').click();          // power down
  await p.waitForTimeout(250);
  ok('powered down, the panel dims',
    await p.locator('#remote').evaluate((e) => e.classList.contains('is-standby')));
  await p.locator('[data-tone="wail1"]').click();  // a tone wakes it
  await p.waitForTimeout(400);
  ok('a tone key wakes it, and it stops being dim',
    !(await p.locator('#remote').evaluate((e) => e.classList.contains('is-standby'))));
  ok('with the power key lit to match',
    await p.locator('#dockPower').evaluate((e) => e.classList.contains('is-on')));
  await p.locator('#keyStop').click();
  await p.waitForTimeout(300);
}

console.log('\n--- the guide\'s play button follows the sound ---');
{
  // The air horn's audition ends by itself; its button went on reading
  // "Parar" over silence until it was pressed again.
  await p.locator('#dockGuide').click();
  await p.waitForTimeout(300);
  await p.locator('[data-tab="tones"]').click();
  await p.waitForTimeout(300);
  const btn = p.locator('[data-play="airhorn"]');
  await btn.click();
  await p.waitForTimeout(300);
  const during = (await btn.innerText()).trim();
  await p.waitForTimeout(2600);
  const after = (await btn.innerText()).trim();
  ok('while the horn sounds it says Parar', /Parar/.test(during), during);
  ok('and goes back to Ouvir when it ends', /Ouvir/.test(after), after);

  // Space inside the guide belongs to whatever has focus there. It used to
  // fire STOP as well, which cut the very preview the button had started.
  await p.locator('[data-play="wail1"]').click();
  await p.waitForTimeout(400);
  // Nothing focused: a focused button would take the Space for itself, which
  // is right, and is not what is being tested.
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press(' ');
  await p.waitForTimeout(400);
  // Listened for, not read off the button: STOP used to kill the preview and
  // leave the button saying it was still playing.
  ok('Space in the guide is not STOP', (await meter()) > 5, `medidor ${(await meter()).toFixed(0)}%`);
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);
}

console.log('\n--- AUTO follows its interval when it is changed ---');
{
  await p.locator('#dockSet').click();
  await p.waitForTimeout(300);
  await p.locator('#sAuto').selectOption('12');
  await p.locator('.guide__close').click();
  await p.waitForTimeout(200);
  await p.locator('#keyAuto').click();
  await p.waitForTimeout(600);
  const first = await p.locator('#lcdTone').innerText();
  // Changed while running: the scan has to pick the new interval up now, not
  // the next time AUTO is switched on.
  await p.locator('#dockSet').click();
  await p.waitForTimeout(250);
  await p.locator('#sAuto').selectOption('4');
  await p.locator('.guide__close').click();
  await p.waitForTimeout(4700);
  const next = await p.locator('#lcdTone').innerText();
  ok('a new AUTO interval applies to a running scan', first !== next, `${first} -> ${next}`);
  await p.locator('#keyAuto').click();
  await p.locator('#keyStop').click();
  await p.locator('#dockSet').click();
  await p.waitForTimeout(250);
  await p.locator('#sAuto').selectOption('6');
  await p.locator('.guide__close').click();
  await p.waitForTimeout(300);
}

console.log('\n--- on a computer, the keyboard plays the panel ---');
{
  const ctxK = await b.newContext({ viewport: { width: 1366, height: 768 } });
  await ctxK.addInitScript(() => {
    window.__live = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      window.__live++;
      this.addEventListener('ended', () => { window.__live--; });
      return start.apply(this, a);
    };
  });
  const pk = await ctxK.newPage();
  const kErrs = [];
  pk.on('pageerror', (e) => kErrs.push(e.message));
  await pk.goto(`${BASE}/index.html`);
  await pk.waitForTimeout(500);
  await pk.locator('.btn[data-close]').click();
  await pk.waitForTimeout(200);
  const on = (sel) => pk.locator(sel).evaluate((e) => e.classList.contains('is-on'));

  await pk.keyboard.press('1');
  await pk.waitForTimeout(500);
  ok('1 latches WAIL-1', await on('[data-tone="wail1"]'));
  await pk.keyboard.press('3');
  await pk.waitForTimeout(400);
  ok('3 moves to YELP', (await on('[data-tone="yelp"]')) && !(await on('[data-tone="wail1"]')));

  await pk.keyboard.down('m');
  await pk.waitForTimeout(500);
  const held = await pk.locator('#keyManual').evaluate((e) => e.classList.contains('is-down'));
  const shownHeld = await pk.locator('#lcdTone').innerText();
  await pk.keyboard.up('m');
  await pk.waitForTimeout(300);
  ok('M holds MANUAL while the key is down', held && /MANUAL/.test(shownHeld), shownHeld);
  ok('and lets it go with the key',
    !(await pk.locator('#keyManual').evaluate((e) => e.classList.contains('is-down'))));

  const v0 = await pk.evaluate(() => JSON.parse(localStorage.getItem('sireflex.v1') || '{}').volume ?? 0.8);
  await pk.keyboard.press('ArrowDown');
  await pk.waitForTimeout(150);
  const v1 = await pk.evaluate(() => JSON.parse(localStorage.getItem('sireflex.v1')).volume);
  ok('the arrow keys move the volume', v1 < v0, `${v0.toFixed(2)} -> ${v1.toFixed(2)}`);

  await pk.keyboard.press(' ');
  await pk.waitForTimeout(400);
  ok('Space is STOP', !(await on('[data-tone="yelp"]')));

  // Inside the guide the letters are text and the numbers are nothing.
  await pk.locator('#dockGuide').click();
  await pk.waitForTimeout(300);
  await pk.keyboard.press('1');
  await pk.waitForTimeout(300);
  ok('shortcuts stay quiet while the guide is open', !(await on('[data-tone="wail1"]')));

  // The tab list walks with the arrows.
  await pk.locator('[data-tab="tones"]').focus();
  await pk.keyboard.press('ArrowRight');
  await pk.waitForTimeout(250);
  ok('the arrow keys move between the guide\'s tabs',
    await pk.locator('[data-tab="keys"]').evaluate((e) => e.classList.contains('is-on')));
  const listed = await pk.locator('.guide__body').innerText();
  ok('and the guide lists the shortcuts on a computer', /teclado/i.test(listed) && /Espaço/.test(listed));
  await pk.keyboard.press('Escape');
  await pk.waitForTimeout(250);
  ok('Esc closes the guide', await pk.locator('#guide').evaluate((e) => e.hidden));
  ok('each key names its shortcut when hovered',
    /tecla 1/.test(await pk.locator('[data-tone="wail1"]').getAttribute('title') || ''));
  ok('no page errors from the keyboard', kErrs.length === 0, kErrs.slice(0, 2).join(' | '));
  await ctxK.close();

  // And a phone does not get told about a keyboard it does not have.
  await p.locator('#dockGuide').click();
  await p.waitForTimeout(250);
  await p.locator('[data-tab="keys"]').click();
  await p.waitForTimeout(250);
  ok('a phone does not list keyboard shortcuts',
    !/teclado/i.test(await p.locator('.guide__body').innerText()));
  await p.locator('.guide__close').click();
  await p.waitForTimeout(200);
}

console.log('\n--- the layout, at every size ---');
{
  const sizes = [
    ['iPhone SE', 375, 667, true], ['iPhone 15', 393, 852, true],
    ['iPad', 820, 1180, true], ['laptop', 1366, 768, false], ['monitor', 1920, 1080, false],
  ];
  for (const [name, w, h, mobile] of sizes) {
    const c = await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
    const q = await c.newPage();
    await q.goto(`${BASE}/index.html`);
    await q.waitForTimeout(500);
    const sheetW = await q.locator('.sheet__panel').evaluate((e) => e.getBoundingClientRect().width);
    await q.locator('.btn[data-close]').click();
    await q.waitForTimeout(250);
    const m = await q.evaluate(() => {
      const r = document.querySelector('.remote').getBoundingClientRect();
      const d = document.querySelector('.dock').getBoundingClientRect();
      const hint = document.querySelector('.hint').getBoundingClientRect();
      const line = getComputedStyle(document.querySelector('.dock'), '::before');
      return {
        scrolls: document.documentElement.scrollHeight > innerHeight + 1
          || document.documentElement.scrollWidth > innerWidth + 1,
        dockBottom: d.bottom, remoteW: r.width, remoteH: r.height,
        hairline: d.top + parseFloat(line.top), hintBottom: hint.bottom,
      };
    });
    // The faceplate is sized by whichever of width and height runs out
    // first. It used to leave a third of every screen unused.
    const fill = Math.max(m.remoteW / (w - 16), m.remoteH / (h - 104));
    ok(`${name}: fits without scrolling`, !m.scrolls && m.dockBottom <= h + 0.5,
      `dock termina em ${m.dockBottom.toFixed(0)} de ${h}`);
    ok(`${name}: the faceplate uses the room it has`, fill > 0.9 || m.remoteW >= 629,
      `${m.remoteW.toFixed(0)}x${m.remoteH.toFixed(0)} (${(fill * 100).toFixed(0)}%)`);
    ok(`${name}: the hint clears the dock's hairline`, m.hairline >= m.hintBottom + 2,
      `linha em ${m.hairline.toFixed(0)}, dica termina em ${m.hintBottom.toFixed(0)}`);
    if (w >= 640) {
      ok(`${name}: the welcome is a dialog, not a banner`, sheetW <= 600, `${sheetW.toFixed(0)} px`);
    }

    await q.locator('#dockGuide').click();
    await q.waitForTimeout(300);
    for (const tab of ['tones', 'how']) {
      await q.locator(`[data-tab="${tab}"]`).click();
      await q.waitForTimeout(250);
      const g = await q.evaluate(() => {
        const body = document.querySelector('.guide__body');
        const text = body.querySelector('.gcard__body, .gintro');
        const charts = [...body.querySelectorAll('svg.dg')];
        // A label is inside its picture when its box is inside the viewBox.
        const spill = charts.flatMap((svg) => {
          const vb = svg.viewBox.baseVal;
          return [...svg.querySelectorAll('text')].filter((t) => {
            const bb = t.getBBox();
            return bb.x < vb.x - 0.5 || bb.x + bb.width > vb.x + vb.width + 0.5;
          }).map((t) => t.textContent);
        });
        return {
          line: text.getBoundingClientRect().width,
          chart: Math.max(...charts.map((c) => c.getBoundingClientRect().width)),
          tick: Math.max(...charts.map((c) => {
            const t = c.querySelector('.dg-tick');
            return t ? t.getBoundingClientRect().height : 0;
          })),
          spill,
        };
      });
      if (tab === 'tones') {
        ok(`${name}: the guide reads in a column`, g.line <= 760, `linha de ${g.line.toFixed(0)} px`);
        ok(`${name}: chart type is text-sized, not zoomed`, g.tick <= 20, `${g.tick.toFixed(1)} px`);
      }
      ok(`${name}: no chart label hangs outside its picture (${tab})`, g.spill.length === 0,
        g.spill.slice(0, 3).join(', '));
    }
    await c.close();
  }
}

console.log(`\n\x1b[1m${pass}/${pass + fail} UI checks passed\x1b[0m${fail ? `  \x1b[31m(${fail} failing)\x1b[0m` : ''}`);
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
process.exit(fail ? 1 : 0);
