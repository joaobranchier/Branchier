/**
 * platform.js — the iOS-specific plumbing.
 *
 * Nothing here is essential to making sound; it is all the difference
 * between a web page and something that behaves like an app on a phone.
 */

/* --------------------------- persistence --------------------------- */

const KEY = 'sirenremote.v1';

/** localStorage throws outright in Lockdown Mode and private windows. */
export function loadPrefs(defaults) {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch { return { ...defaults }; }
}

export function savePrefs(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* not fatal */ }
}

/* ---------------------------- wake lock ---------------------------- */

/**
 * Keeps the screen alive while a siren is running. Without this iOS dims and
 * locks after ~30 s, and a locked screen suspends the AudioContext — the
 * siren would simply stop mid-run. Safari 16.4+.
 */
export class ScreenLock {
  constructor() { this._lock = null; this._want = false; this._bound = false; }

  async enable() {
    this._want = true;
    if (!('wakeLock' in navigator)) return false;
    try {
      this._lock = await navigator.wakeLock.request('screen');
      this._lock.addEventListener?.('release', () => { this._lock = null; });
      if (!this._bound) {
        // iOS drops the lock whenever the tab is backgrounded, and does not
        // give it back on return, so it has to be re-taken by hand.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && this._want && !this._lock) {
            this.enable().catch(() => {});
          }
        });
        this._bound = true;
      }
      return true;
    } catch { return false; }
  }

  async disable() {
    this._want = false;
    try { await this._lock?.release(); } catch {}
    this._lock = null;
  }

  get active() { return !!this._lock; }
}

/* ----------------------------- haptics ----------------------------- */

/**
 * Safari on iOS exposes no vibration API. The one thing that does produce a
 * physical tick is toggling a <input type="checkbox" switch> — the control
 * Apple added in 17.4 — by clicking its label. It is a trick, so it is
 * wrapped in feature detection and failing silently is an acceptable result.
 */
export class Haptics {
  constructor(enabled = true) {
    this.enabled = enabled;
    this._label = null;
    this._native = typeof navigator.vibrate === 'function';
    this._switchSupported = (() => {
      const el = document.createElement('input');
      el.setAttribute('type', 'checkbox');
      // Safari reflects an unknown attribute as a property only when it
      // actually implements it.
      return 'switch' in el;
    })();
  }

  _ensure() {
    if (this._label || !this._switchSupported) return;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('switch', '');
    box.id = '_haptic_switch';
    const label = document.createElement('label');
    label.htmlFor = '_haptic_switch';
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px';
    host.append(box, label);
    document.body.appendChild(host);
    this._label = label;
  }

  tap() {
    if (!this.enabled) return;
    if (this._native) { try { navigator.vibrate(12); } catch {} return; }
    this._ensure();
    try { this._label?.click(); } catch {}
  }

  /** Best effort only — say so in the UI rather than promising it works. */
  get supported() { return this._native || this._switchSupported; }
}

/* ------------------------- install / display ------------------------- */

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
