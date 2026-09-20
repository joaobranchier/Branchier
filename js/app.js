/**
 * app.js — the controller. Wires the faceplate to the synthesis engine.
 */

import { AudioEngine } from './audio/engine.js';
import { createVoice, prewarm } from './audio/voices.js';
import { TONES, AUTO_CYCLE, MOD_STEPS } from './audio/tones.js';
import { Strobe } from './ui/strobe.js';
import { injectWaveIcons } from './ui/waveicons.js';
import { initSheets, openWelcome, isOpen as sheetOpen, close as closeSheet } from './ui/sheets.js';
import { initGuide, openGuide, closeGuide, guideOpen, tabBarHTML } from './ui/guide.js';
import { ScreenLock, Haptics, loadPrefs, savePrefs, isIOS, isStandalone } from './platform.js';

const DEFAULTS = {
  volume: 0.8,
  pattern: 'alt',
  brightness: 1,
  wakeLock: true,
  haptics: true,
  autoSecs: 6,
  seen: false,
};

class Controller {
  constructor() {
    this.prefs = loadPrefs(DEFAULTS);
    this.engine = new AudioEngine();
    this.strobe = new Strobe(document.getElementById('strobe'));
    this.screenLock = new ScreenLock();
    this.haptics = new Haptics(this.prefs.haptics);

    /** Latched siren tones currently sounding: id -> voice. */
    this.active = new Map();
    /** Momentary voices (horn, manual): key -> voice. */
    this.held = new Map();
    /**
     * Voices that are no longer latched or held but are still sounding: the
     * Q-siren coasts for nineteen seconds after its key is switched off, and
     * the manual wail falls for three. They had been dropped from the maps
     * the moment the key was released, which left STOP unable to reach them
     * and let the screen lock while they were still audible.
     */
    this.fading = new Set();

    this.mix = false;
    this.modStep = 1;
    this.auto = false;
    this.autoTimer = 0;
    this.autoIndex = 0;
    this.rumble = false;
    this.rumbleVoice = null;
    /** Tone being auditioned from the guide, separate from the faceplate. */
    this.previewVoice = null;
    this.previewId = null;
    this.standby = true;

    this.engine.setVolume(this.prefs.volume);
    this.strobe.setPattern(this.prefs.pattern);
    this.strobe.setBrightness(this.prefs.brightness);
    this.strobe.onEnd = () => {
      this.setKey('[data-act="lmb"]', false);
      this.setKey('[data-act="light"]', false);
    };
  }

  /* ------------------------------ prefs ------------------------------ */

  setPref(key, value) { this.prefs[key] = value; savePrefs(this.prefs); }
  setVolume(v) { this.engine.setVolume(v); this.setPref('volume', v); }

  /* ------------------------------ audio ------------------------------ */

  async ensureAudio() {
    if (!this.engine.ready) {
      await this.engine.unlock();
      // Every tone is computed, not sampled, so the first press of each one
      // would otherwise pay for its render. Doing them all in idle time
      // after the first touch means none of them ever does. Warming up is a
      // convenience and must never be able to stop a key from sounding.
      try { prewarm(this.engine, TONES, TONES.wail1); } catch { /* renders on demand */ }
      document.getElementById('hint').textContent = 'Pronto — áudio ativo';
      document.getElementById('hint').dataset.state = 'on';
      setTimeout(() => { document.getElementById('hint').style.opacity = '0'; }, 1800);
    } else if (this.engine.ctx.state !== 'running') {
      await this.engine.ctx.resume().catch(() => {});
    }
    this.standby = false;
  }

  /**
   * The tone the display and the rumble layer follow. A held momentary key
   * outranks a latched one — it is what the finger is doing right now.
   */
  get primaryId() {
    if (this.previewId) return this.previewId;
    if (this.held.has('manual')) return 'manual';
    const latched = this.active.keys().next().value;
    if (latched) return latched;
    if (this.held.has('horn')) return 'airhorn';
    return null;
  }

  get primaryVoice() {
    if (this.previewVoice) return this.previewVoice;
    if (this.held.has('manual')) return this.held.get('manual');
    const latched = this.active.keys().next().value;
    if (latched) return this.active.get(latched);
    return this.held.get('horn') ?? null;
  }

  startTone(id) {
    if (this.active.has(id)) return;
    // Anything still coasting has had its turn. The Q-siren freewheels for
    // thirty seconds after its release, and leaving that under the tone that
    // replaced it is not "two sirens" — it is one siren you cannot hear, with
    // the master limiter pulling the new one down to nothing. Switching tone
    // on a real controller switches the tone.
    this.cutFading();
    const voice = createVoice(this.engine, TONES[id]);
    voice.setRate(MOD_STEPS[this.modStep].factor);
    voice.start();
    this.active.set(id, voice);
    this.setKey(`[data-tone="${id}"]`, true);
    this.syncRumble();
    this.syncScreenLock();
  }

  stopTone(id) {
    const voice = this.active.get(id);
    if (!voice) return;
    // Out of the map first: a tone that failed to release cleanly must not
    // also be stuck latched, or every later stopAllTones trips over it again
    // and no other key works.
    this.active.delete(id);
    this._fade(voice, TONES[id]);
    this.setKey(`[data-tone="${id}"]`, false);
    this.syncRumble();
    this.syncScreenLock();
  }

  stopAllTones() {
    for (const id of [...this.active.keys()]) this.stopTone(id);
  }

  toggleTone(id) {
    if (this.active.has(id)) { this.stopTone(id); return; }
    // Without MIX a controller is radio-button: one tone at a time.
    if (!this.mix) this.stopAllTones();
    this.startTone(id);
  }

  /** Keeps the low-frequency layer following whatever is currently playing. */
  syncRumble() {
    const want = this.rumble && (this.active.size > 0 || this.held.size > 0);
    const id = this.primaryId;
    const source = id ? TONES[id] : TONES.wail1;

    if (!want) {
      this._retire(this.rumbleVoice);
      this.rumbleVoice = null;
      this._rumbleSource = null;
      return;
    }
    if (this.rumbleVoice && this._rumbleSource === source.id) return;
    // The source changed, so rebuild it to track the new tone.
    this._retire(this.rumbleVoice);
    this._rumbleSource = source.id;
    this.rumbleVoice = createVoice(this.engine, TONES.rumbler, { source });
    this.rumbleVoice.start();
  }

  /**
   * Hand a voice over to be released, when the controller is about to drop
   * its own reference to it.
   *
   * The rumble layer used to be stopped and forgotten in the same breath:
   * if stopping it had thrown, it would have gone on sounding with nothing
   * left that could reach it — not even STOP. Going through the tracker
   * costs nothing and closes that door.
   */
  _retire(voice) {
    if (voice) this._fade(voice, voice.spec);
  }

  /** Cuts, now, anything still ringing out from an earlier release. */
  cutFading() {
    for (const voice of this.fading) voice.kill();
    this.fading.clear();
  }

  get isSounding() {
    return this.active.size > 0 || this.held.size > 0 || this.fading.size > 0
        || !!this.previewVoice || this.strobe.active;
  }

  /** How long a voice stays audible after its ordinary release, in seconds. */
  static tailOf(spec) {
    if (spec.kind === 'mechanical') return spec.coastDownS;
    if (spec.kind === 'manual') return spec.fallS;
    return (spec.releaseMs ?? 40) / 1000;
  }

  /**
   * Release a voice, keep hold of it while it rings out, and guarantee it
   * goes quiet whatever happens in between.
   *
   * The watchdog is armed before anything that can throw, and kill() is
   * unconditional and idempotent. A release path that an exception can skip
   * is precisely how a tone ends up sounding forever with no way to reach
   * it, and a voice that stopped cleanly pays nothing for the insurance.
   */
  _fade(voice, spec, alreadyFalling = false) {
    const tail = voice.tailS ?? Controller.tailOf(spec);
    this.fading.add(voice);
    setTimeout(() => {
      voice.kill();
      this.fading.delete(voice);
      this.syncScreenLock();
    }, (tail + 0.35) * 1000);
    if (!alreadyFalling) {
      try { voice.stop(); } catch { voice.kill(); }
    }
  }

  syncScreenLock() {
    if (this.isSounding && this.prefs.wakeLock) {
      clearTimeout(this._lockOff);
      this.screenLock.enable();
      return;
    }
    // Switching tone stops one voice and starts the next, so this runs with
    // nothing sounding for a moment in between. Releasing the lock there and
    // taking it again restarts the idle timer on every single key press, so
    // the release waits to see whether anything picks up.
    clearTimeout(this._lockOff);
    this._lockOff = setTimeout(() => {
      if (!this.isSounding) this.screenLock.disable();
    }, 400);
  }

  /* --------------------------- momentary --------------------------- */

  press(key, toneId) {
    // Replace, never stack. A key whose release never arrived — iOS can take
    // a touch away mid-press and the button's own pointerup never fires —
    // would otherwise leave its note sounding underneath the new one, and
    // every further press would add another. Cutting the old one here makes
    // that impossible by construction rather than by hoping for an event.
    const stale = this.held.get(key);
    if (stale) {
      stale.kill();
      this.held.delete(key);
    }
    // And cut whatever is still falling from the last press of this same
    // key: one manual siren, not a rising one over a falling one. A Q
    // coasting underneath is left alone — that one really is a second siren.
    for (const v of [...this.fading]) {
      if (v.spec.id === toneId) { v.kill(); this.fading.delete(v); }
    }
    const voice = createVoice(this.engine, TONES[toneId]);
    voice.start();
    this.held.set(key, voice);
    this.syncRumble();
    this.syncScreenLock();
  }

  release(key) {
    const voice = this.held.get(key);
    if (!voice) return;
    this.held.delete(key);
    const spec = voice.spec;
    // The watchdog goes on first. Everything below it can throw — the glide
    // schedules automation on a live AudioParam — and none of it may be able
    // to leave the voice running.
    this._fade(voice, spec, true);
    try {
      if (typeof voice.fall === 'function') {
        // The manual wail coasts down under its own envelope before teardown.
        voice.fall();
        const tail = voice.tailS ?? Controller.tailOf(spec);
        setTimeout(() => {
          try { voice.stop(); } catch { voice.kill(); }
        }, tail * 1000);
      } else {
        voice.stop();
      }
    } catch { voice.kill(); }
    this.syncRumble();
    this.syncScreenLock();
  }

  /* ----------------------------- preview ----------------------------- */

  /**
   * Auditions a tone from inside the guide, where the faceplate is covered.
   * Kept apart from the latched tones so opening the guide, listening to a
   * few, and closing it again leaves the panel exactly as it was.
   */
  preview(id) {
    if (this.previewId === id) { this.stopPreview(); return false; }
    this.stopPreview();
    const spec = TONES[id];
    const voice = createVoice(this.engine, spec, {
      source: TONES.wail1,
      bus: this.engine.preview,
    });
    voice.start();
    this.previewVoice = voice;
    this.previewId = id;
    // Fade the faceplate out underneath: two sirens at once, with a display
    // that can only name one, is just noise.
    this.engine.duckPanel(true);
    // A horn is a stab, not a state: it stops on its own.
    if (spec.kind === 'horn') {
      this._previewTimer = setTimeout(() => this.stopPreview(), 1500);
    }
    this.syncScreenLock();
    return true;
  }

  stopPreview() {
    clearTimeout(this._previewTimer);
    if (!this.previewVoice) return;
    const voice = this.previewVoice;
    const spec = TONES[this.previewId];
    this.previewVoice = null;
    this.previewId = null;
    this.engine.duckPanel(false);
    // Long-tailed tones keep ringing out, so hand them to the same tracker
    // the faceplate uses — STOP has to be able to reach them too.
    this._fade(voice, spec);
    this.syncScreenLock();
  }

  /* ------------------------------ modes ------------------------------ */

  toggleMix() {
    this.mix = !this.mix;
    this.setKey('[data-act="mix"]', this.mix);
    document.getElementById('chipMix').classList.toggle('chip--hot', this.mix);
    document.getElementById('chipMix').classList.toggle('chip--off', !this.mix);
    // Leaving MIX collapses back to a single tone.
    if (!this.mix && this.active.size > 1) {
      const keep = this.primaryId;
      for (const id of [...this.active.keys()]) if (id !== keep) this.stopTone(id);
    }
  }

  cycleMod() {
    this.modStep = (this.modStep + 1) % MOD_STEPS.length;
    const step = MOD_STEPS[this.modStep];
    for (const v of this.active.values()) v.setRate(step.factor);
    this.rumbleVoice?.setRate(step.factor);
    document.getElementById('chipMod').textContent = step.label;
    this.setKey('[data-act="mod"]', this.modStep !== 1);
  }

  toggleAuto() {
    this.auto = !this.auto;
    this.setKey('[data-act="auto"]', this.auto);
    clearInterval(this.autoTimer);
    if (!this.auto) return;
    this.stopAllTones();
    this.autoIndex = 0;
    this.startTone(AUTO_CYCLE[0]);
    this.autoTimer = setInterval(() => {
      this.autoIndex = (this.autoIndex + 1) % AUTO_CYCLE.length;
      this.stopAllTones();
      this.startTone(AUTO_CYCLE[this.autoIndex]);
      // A corrupt stored value here would otherwise become setInterval(…, 0).
    }, Math.max(2, Math.min(60, this.prefs.autoSecs || 6)) * 1000);
  }

  cancelAuto() {
    if (!this.auto) return;
    this.auto = false;
    clearInterval(this.autoTimer);
    this.setKey('[data-act="auto"]', false);
  }

  toggleRumble() {
    this.rumble = !this.rumble;
    this.setKey('[data-act="rumble"]', this.rumble);
    this.syncRumble();
  }

  toggleEq(which) {
    const key = document.querySelector(`[data-eq="${which}"]`);
    const on = !key.classList.contains('is-on');
    key.classList.toggle('is-on', on);
    const label = this.engine.setTone({ [which]: on });
    document.getElementById('chipEq').textContent = label;
  }

  /* ------------------------------ lights ------------------------------ */

  toggleStrobe(mode, selector) {
    const on = this.strobe.mode !== mode;
    this.strobe.stop(true);
    this.setKey('[data-act="lmb"]', false);
    this.setKey('[data-act="light"]', false);
    if (on) {
      this.strobe.start(mode);
      this.setKey(selector, true);
    }
    this.syncScreenLock();
  }

  /* ------------------------------ stop ------------------------------ */

  /**
   * STOP. Every voice is killed outright rather than released: the Q-siren's
   * normal release is a nineteen-second coast-down, and a panic button that
   * keeps sounding for nineteen seconds is not a panic button.
   */
  panic() {
    this.cancelAuto();
    clearTimeout(this._previewTimer);
    this.previewVoice?.kill();
    this.previewVoice = null;
    this.previewId = null;
    for (const [id, voice] of this.active) { voice.kill(); this.setKey(`[data-tone="${id}"]`, false); }
    this.active.clear();
    for (const voice of this.held.values()) voice.kill();
    this.held.clear();
    // Anything still ringing out from an earlier release.
    for (const voice of this.fading) voice.kill();
    this.fading.clear();
    for (const el of document.querySelectorAll('.key--horn.is-down, .key--pill.is-down')) el.classList.remove('is-down');
    this.rumbleVoice?.kill();
    this.rumbleVoice = null;
    this._rumbleSource = null;
    this.engine.panic();
    this.syncScreenLock();
  }

  /** The side power key: standby on the way down, wake on the way back. */
  togglePower() {
    if (this.standby) {
      this.standby = false;
      document.getElementById('remote').classList.remove('is-standby');
      this.ensureAudio().catch(() => {});
      return;
    }
    this.panic();
    this.strobe.stop();
    this.standby = true;
    document.getElementById('remote').classList.add('is-standby');
    for (const k of document.querySelectorAll('.key.is-on')) {
      k.classList.remove('is-on');
      if (k.hasAttribute('aria-pressed')) k.setAttribute('aria-pressed', 'false');
    }
    this.mix = false; this.rumble = false; this.modStep = 1;
    this.engine.setTone({ high: false, bass: false });
    document.getElementById('chipEq').textContent = 'FLAT';
    document.getElementById('chipMod').textContent = MOD_STEPS[1].label;
    document.getElementById('chipMix').classList.add('chip--off');
    document.getElementById('chipMix').classList.remove('chip--hot');
  }

  /* ------------------------------ view ------------------------------ */

  setKey(selector, on) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.classList.toggle('is-on', on);
    // A latched key is a toggle, and a screen reader has no other way to
    // learn that the amber backlight means "this tone is running".
    if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', String(on));
  }

  /** A short message that briefly takes over the frequency readout. */
  flash(text, ms = 1100) {
    this._flashText = text;
    this._flashUntil = performance.now() + ms;
  }

  render() {
    const tone = document.getElementById('lcdTone');
    const hz = document.getElementById('lcdHz');
    const meter = document.getElementById('meterFill');

    const id = this.primaryId;
    const voice = this.primaryVoice;

    if (id) {
      const extra = this.active.size > 1 ? ` +${this.active.size - 1}` : '';
      tone.textContent = TONES[id].label + extra;
    } else {
      tone.textContent = this.standby ? 'STANDBY' : 'PRONTO';
    }

    // A volume nudge writes here too, and used to be overwritten by the very
    // next frame — so the readout never actually appeared.
    if (this._flashUntil && performance.now() < this._flashUntil) {
      hz.textContent = this._flashText;
    } else {
      this._flashUntil = 0;
      const f = voice?.frequency();
      hz.textContent = Number.isFinite(f) && f > 0 ? `${Math.round(f)} Hz` : '';
    }

    // Read the bus itself rather than inferring from what is latched: a tone
    // released into a long tail (the Q-siren coasts for nineteen seconds) is
    // still very much audible, and a meter that reads zero there is lying.
    meter.style.width = `${Math.round(this.engine.level() * 100)}%`;
    requestAnimationFrame(() => this.render());
  }
}

/* ===================================================================== */
/*  Wiring                                                               */
/* ===================================================================== */

const ctl = new Controller();
injectWaveIcons();
initSheets(ctl);
document.querySelector('.guide__tabs').innerHTML = tabBarHTML();
initGuide(ctl);

// The welcome sheet offers a shortcut straight into the guide.
document.getElementById('sheetBody').addEventListener('click', (e) => {
  if (e.target.id === 'bGuide') { closeSheet(); openGuide('tones'); }
});

const ACTIONS = {
  tone:   (el) => { ctl.cancelAuto(); ctl.toggleTone(el.dataset.tone); },
  eq:     (el) => ctl.toggleEq(el.dataset.eq),
  auto:   () => ctl.toggleAuto(),
  mix:    () => ctl.toggleMix(),
  mod:    () => ctl.cycleMod(),
  rumble: () => ctl.toggleRumble(),
  stop:   () => ctl.panic(),
  lmb:    () => ctl.toggleStrobe('bar', '[data-act="lmb"]'),
  light:  () => ctl.toggleStrobe('white', '[data-act="light"]'),
};

/** Momentary keys: the sound lasts exactly as long as the finger is down. */
const MOMENTARY = { horn: 'airhorn', manual: 'manual' };

const LATCHING = new Set(['tone', 'eq', 'auto', 'mix', 'rumble', 'lmb', 'light']);

/**
 * Every momentary key's release, callable from outside that key.
 *
 * A note that lasts as long as the finger is down must not depend on its own
 * button seeing the finger lift. On iOS a touch can be taken away mid-press
 * — the system claims it for a gesture, the pointer capture is lost, the app
 * is backgrounded — and the button's pointerup never arrives. The note then
 * sounds forever, and the next press stacks another on top of it.
 */
const releasers = [];        // release regardless of pointer
const pointerReleasers = []; // release only if this is that key's pointer

function releaseAllHeld() {
  for (const fn of releasers) fn();
}

function wire(el) {
  const act = el.dataset.act;
  const momentaryTone = MOMENTARY[act];
  if (LATCHING.has(act)) el.setAttribute('aria-pressed', 'false');

  // Unlocking the audio on the very first press takes long enough that a
  // quick tap can finish before it resolves. Without this the release ran
  // against an empty map and the note started afterwards — the air horn
  // would sound forever on the first tap of the session.
  let down = false;
  // Which finger is holding this key, so a second finger lifting off another
  // key does not release it. Two hands on the panel — a siren latched, the
  // air horn stabbed over it — is the whole point of the layout.
  let pointer = null;

  const onDown = async (e) => {
    e.preventDefault();
    down = true;
    pointer = e.pointerId ?? null;
    el.classList.add('is-down');
    ctl.haptics.tap();
    if (momentaryTone && e.pointerId !== undefined) {
      try { el.setPointerCapture(e.pointerId); } catch {}
    }
    await ctl.ensureAudio();
    if (!down) return;
    if (momentaryTone) ctl.press(act, momentaryTone);
    else ACTIONS[act]?.(el);
  };

  const onUp = () => {
    down = false;
    pointer = null;
    el.classList.remove('is-down');
    if (momentaryTone) ctl.release(act);
  };

  // pointerdown, not click: a siren button has to fire on contact, and the
  // ~300 ms a synthesised click costs is the difference between an
  // instrument and a web page.
  if (momentaryTone) {
    releasers.push(onUp);
    pointerReleasers.push((e) => {
      if (!down) return;
      if (pointer === null || e.pointerId === pointer) onUp();
    });
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  // These are <button>s, focusable and carrying aria-pressed, but they act on
  // pointerdown — so without this they were unreachable from a keyboard.
  // Enter and Space mirror press and release, which also gives the momentary
  // keys their hold-to-sound behaviour.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.repeat) return;        // key-repeat must not re-trigger a latch
    onDown(e);
  });
  el.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onUp();
  });
  el.addEventListener('blur', onUp);
}

for (const el of document.querySelectorAll('.key[data-act]')) wire(el);

// The safety net for the momentary keys. The window sees the finger lift even
// when the button does not, and it is matched by pointer id so that lifting
// one finger never releases the key another finger is still holding. Each
// releaser is idempotent, so the button's own handler firing first costs
// nothing.
const onWindowUp = (e) => { for (const fn of pointerReleasers) fn(e); };
addEventListener('pointerup', onWindowUp);
addEventListener('pointercancel', onWindowUp);

// And anything that takes the app away is a release: nothing that stops the
// user from touching the glass may leave a tone sounding.
addEventListener('blur', releaseAllHeld);
addEventListener('pagehide', releaseAllHeld);

/* ---------------------------- side buttons ---------------------------- */

const nudge = (delta) => {
  ctl.haptics.tap();
  ctl.setVolume(Math.max(0, Math.min(1, ctl.engine.volume + delta)));
  ctl.flash(`VOL ${Math.round(ctl.engine.volume * 100)}%`);
};

// pointerdown here too, for the same reason the keys use it.
const side = (id, fn) =>
  document.getElementById(id).addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });

side('btnVolUp', () => nudge(0.08));
side('btnVolDown', () => nudge(-0.08));
side('btnPower', () => { ctl.haptics.tap(); ctl.togglePower(); });
side('btnInfo', () => {
  ctl.haptics.tap();
  openGuide();
});

/* ------------------------------ strobe exit ------------------------------ */

// Only the fullscreen torch closes on a tap; the lightbar behind the unit is
// pointer-transparent and is switched off with its own key.
document.getElementById('strobe').addEventListener('pointerdown', (e) => {
  if (ctl.strobe.mode !== 'white') return;
  e.preventDefault();
  ctl.strobe.stop();
  ctl.syncScreenLock();
});

/* ------------------------------ lifecycle ------------------------------ */

document.addEventListener('visibilitychange', () => {
  // Coming back from the lock screen or another app leaves the context
  // suspended; nothing would sound again until it is resumed.
  if (document.visibilityState === 'visible' && ctl.engine.ready) {
    ctl.engine.ctx.resume().catch(() => {});
    return;
  }
  // Going away is a release: the finger is not coming back to a button whose
  // pointerup was swallowed by whatever took the app away.
  releaseAllHeld();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    ctl.strobe.stop();
    if (guideOpen()) closeGuide();
    if (sheetOpen()) closeSheet();
  }
  // Space is panic only when no key has focus — otherwise it belongs to the
  // focused button, which handles it itself.
  const onKey = document.activeElement?.closest?.('.key');
  if (e.key === ' ' && !onKey) { e.preventDefault(); ctl.panic(); }
});

/* Stop iOS from bouncing or zooming the faceplate. Dragging off a key must
   not scroll the page — but when the layout genuinely does not fit (a phone
   in landscape), scrolling is the only way to reach the bottom row, so the
   block is lifted in that case. */
document.addEventListener('gesturestart', (e) => e.preventDefault());
let pageScrolls = false;
const measurePage = () => {
  pageScrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
};
// Measured on resize rather than inside the handler: reading scrollHeight
// forces a layout, and doing that on every touchmove stutters a drag.
addEventListener('resize', measurePage);
addEventListener('orientationchange', () => setTimeout(measurePage, 250));
measurePage();

document.addEventListener('touchmove', (e) => {
  if (!pageScrolls && !e.target.closest('.sheet__body, .guide__body')) e.preventDefault();
}, { passive: false });

/* ------------------------------ first run ------------------------------ */

if (!ctl.prefs.seen) {
  openWelcome();
  ctl.setPref('seen', true);
}
if (isIOS() && !isStandalone()) {
  document.getElementById('hint').textContent =
    'Compartilhar → Adicionar à Tela de Início para tela cheia';
}

ctl.engine.onStateChange((state) => {
  // iOS suspends the context for a phone call, Siri, or a route change. The
  // panel would otherwise look alive and do nothing.
  const hint = document.getElementById('hint');
  if (state === 'suspended' || state === 'interrupted') {
    hint.style.opacity = '1';
    hint.dataset.state = '';
    hint.textContent = 'Áudio pausado pelo sistema — toque para retomar';
  } else if (state === 'running') {
    hint.style.opacity = '0';
  }
});

ctl.render();

/* ------------------- offline cache and self-update ------------------- */

/**
 * Registering the worker is the easy half. The hard half is making sure a
 * build published five minutes ago is the one the phone actually runs.
 *
 * An installed PWA can sit on the home screen for days without ever being
 * killed, so "it will update next time" is not a plan. Three things happen
 * here: the registration is re-checked whenever the app comes back to the
 * foreground; a worker that is ready to take over is told to do so; and when
 * it does, the page reloads itself — silently if nothing is playing, and
 * behind a tappable notice if something is, because cutting a siren off
 * mid-sweep to install an update is rude.
 */
if ('serviceWorker' in navigator) {
  const sw = navigator.serviceWorker;
  // On the very first visit there is no controller yet, and the one that
  // arrives is not replacing anything — reloading for it would be a pointless
  // flash on the first thing the user ever sees.
  const hadController = !!sw.controller;
  let reloading = false;

  const applyUpdate = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };

  const offerUpdate = () => {
    const bar = document.getElementById('update');
    if (!bar || !bar.hidden) return;
    bar.hidden = false;
    bar.addEventListener('pointerdown', applyUpdate, { once: true });
  };

  sw.addEventListener('controllerchange', () => {
    if (!hadController) return;
    // Nothing audible: just swap. The user sees a blink, and the version they
    // reopen is the current one.
    if (ctl.isSounding) offerUpdate();
    else applyUpdate();
  });

  window.addEventListener('load', async () => {
    const reg = await sw.register('sw.js').catch(() => null);
    if (!reg) return; // offline caching is a bonus, never a requirement

    // A worker that installed while the app was open waits for every tab to
    // close before it activates. Nobody closes a home-screen app, so ask.
    const promote = () => reg.waiting?.postMessage('skipWaiting');
    promote();
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', function () {
        if (this.state === 'installed') promote();
      });
    });

    // Coming back to the app is the natural moment to look for a new build:
    // it is the moment the user is most likely to be wondering why the fix
    // they were promised is not there yet.
    const check = () => { if (navigator.onLine !== false) reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
  });
}
