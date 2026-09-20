/**
 * app.js — the controller. Wires the faceplate to the synthesis engine.
 */

import { AudioEngine } from './audio/engine.js';
import { createVoice } from './audio/voices.js';
import { TONES, SIREN_IDS, AUTO_CYCLE, MOD_STEPS } from './audio/tones.js';
import { Strobe } from './ui/strobe.js';
import { injectWaveIcons } from './ui/waveicons.js';
import { initSheets, openWelcome, openSettings, isOpen as sheetOpen, close as closeSheet } from './ui/sheets.js';
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

    this.mix = false;
    this.modStep = 1;
    this.auto = false;
    this.autoTimer = 0;
    this.autoIndex = 0;
    this.rumble = false;
    this.rumbleVoice = null;
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
      document.getElementById('hint').textContent = 'Pronto — áudio ativo';
      document.getElementById('hint').dataset.state = 'on';
      setTimeout(() => { document.getElementById('hint').style.opacity = '0'; }, 1800);
    } else if (this.engine.ctx.state !== 'running') {
      await this.engine.ctx.resume().catch(() => {});
    }
    this.standby = false;
  }

  /** The tone whose name and frequency the display follows. */
  get primary() {
    return this.held.get('manual') ? null : (this.active.keys().next().value ?? null);
  }

  startTone(id) {
    if (this.active.has(id)) return;
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
    voice.stop();
    this.active.delete(id);
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
    const source = this.primary ? TONES[this.primary] : TONES.wail1;

    if (!want) {
      this.rumbleVoice?.stop();
      this.rumbleVoice = null;
      this._rumbleSource = null;
      return;
    }
    if (this.rumbleVoice && this._rumbleSource === source.id) return;
    // The source changed, so rebuild it to track the new tone.
    this.rumbleVoice?.stop();
    this._rumbleSource = source.id;
    this.rumbleVoice = createVoice(this.engine, TONES.rumbler, { source });
    this.rumbleVoice.start();
  }

  syncScreenLock() {
    const sounding = this.active.size > 0 || this.held.size > 0 || this.strobe.active;
    if (sounding && this.prefs.wakeLock) this.screenLock.enable();
    else if (!sounding) this.screenLock.disable();
  }

  /* --------------------------- momentary --------------------------- */

  press(key, toneId) {
    if (this.held.has(key)) return;
    const voice = createVoice(this.engine, TONES[toneId]);
    voice.start();
    this.held.set(key, voice);
    this.syncRumble();
    this.syncScreenLock();
  }

  release(key) {
    const voice = this.held.get(key);
    if (!voice) return;
    // Manual wail coasts down under its own envelope before it is torn down.
    if (typeof voice.fall === 'function') {
      voice.fall();
      setTimeout(() => voice.stop(), (TONES.manual.fallS + 0.2) * 1000);
    } else {
      voice.stop();
    }
    this.held.delete(key);
    this.syncRumble();
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
      const keep = this.primary;
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
    }, this.prefs.autoSecs * 1000);
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

  panic() {
    this.cancelAuto();
    this.stopAllTones();
    for (const k of [...this.held.keys()]) this.release(k);
    this.rumbleVoice?.stop();
    this.rumbleVoice = null;
    this._rumbleSource = null;
    this.engine.panic();
    this.syncScreenLock();
  }

  powerOff() {
    this.panic();
    this.strobe.stop();
    this.standby = true;
    for (const k of document.querySelectorAll('.key.is-on')) k.classList.remove('is-on');
    this.mix = false; this.rumble = false;
    this.engine.setTone({ high: false, bass: false });
    document.getElementById('chipEq').textContent = 'FLAT';
    document.getElementById('chipMix').classList.add('chip--off');
    document.getElementById('chipMix').classList.remove('chip--hot');
  }

  /* ------------------------------ view ------------------------------ */

  setKey(selector, on) {
    document.querySelector(selector)?.classList.toggle('is-on', on);
  }

  render() {
    const tone = document.getElementById('lcdTone');
    const hz = document.getElementById('lcdHz');
    const meter = document.getElementById('meterFill');

    const manual = this.held.get('manual');
    const horn = this.held.get('horn');
    const id = this.primary;

    if (manual) {
      tone.textContent = 'MANUAL';
      hz.textContent = `${Math.round(manual.frequency())} Hz`;
    } else if (horn) {
      tone.textContent = 'AIR HORN';
      hz.textContent = `${Math.round(horn.frequency())} Hz`;
    } else if (id) {
      const extra = this.active.size > 1 ? ` +${this.active.size - 1}` : '';
      tone.textContent = TONES[id].label + extra;
      hz.textContent = `${Math.round(this.active.get(id).frequency())} Hz`;
    } else {
      tone.textContent = this.standby ? 'STANDBY' : 'PRONTO';
      hz.textContent = '';
    }

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

function wire(el) {
  const act = el.dataset.act;
  const momentaryTone = MOMENTARY[act];

  const down = async (e) => {
    e.preventDefault();
    el.classList.add('is-down');
    ctl.haptics.tap();
    await ctl.ensureAudio();
    if (momentaryTone) {
      try { el.setPointerCapture(e.pointerId); } catch {}
      ctl.press(act, momentaryTone);
    } else {
      ACTIONS[act]?.(el);
    }
  };

  const up = () => {
    el.classList.remove('is-down');
    if (momentaryTone) ctl.release(act);
  };

  // pointerdown, not click: a siren button has to fire on contact, and the
  // ~300 ms a synthesised click costs is the difference between an
  // instrument and a web page.
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

for (const el of document.querySelectorAll('.key[data-act]')) wire(el);

/* ---------------------------- side buttons ---------------------------- */

const nudge = (delta) => {
  ctl.haptics.tap();
  ctl.setVolume(Math.max(0, Math.min(1, ctl.engine.volume + delta)));
  const l = document.getElementById('lcdHz');
  l.textContent = `VOL ${Math.round(ctl.engine.volume * 100)}%`;
};
document.getElementById('btnVolUp').addEventListener('click', () => nudge(0.08));
document.getElementById('btnVolDown').addEventListener('click', () => nudge(-0.08));
document.getElementById('btnPower').addEventListener('click', () => { ctl.haptics.tap(); ctl.powerOff(); });
document.getElementById('btnInfo').addEventListener('click', async () => {
  ctl.haptics.tap();
  await ctl.ensureAudio().catch(() => {});
  openSettings();
});

/* ------------------------------ strobe exit ------------------------------ */

const strobeEl = document.getElementById('strobe');
strobeEl.addEventListener('pointerdown', (e) => {
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
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ctl.strobe.stop(); if (sheetOpen()) closeSheet(); }
  if (e.key === ' ') { e.preventDefault(); ctl.panic(); }
});

/* Stop iOS from bouncing or zooming the faceplate. Dragging off a key must
   not scroll the page — but when the layout genuinely does not fit (a phone
   in landscape), scrolling is the only way to reach the bottom row, so the
   block is lifted in that case. */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => {
  const pageScrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
  if (!pageScrolls && !e.target.closest('.sheet__body')) e.preventDefault();
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

ctl.render();

/* ---------------------------- offline cache ---------------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
  });
}
