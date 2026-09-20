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
  let stored = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) ?? {};
  } catch { /* unreadable or not JSON — fall through to the defaults */ }
  if (typeof stored !== 'object' || Array.isArray(stored)) stored = {};

  // Only take a stored value when it has the same shape as the default. A
  // hand-edited or half-written entry otherwise reaches an AudioParam as a
  // string or NaN, and an AudioParam given either of those throws.
  const out = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const v = stored[key];
    if (v === undefined) continue;
    if (typeof fallback === 'number') { if (Number.isFinite(v)) out[key] = v; }
    else if (typeof fallback === 'boolean') { if (typeof v === 'boolean') out[key] = v; }
    else if (typeof fallback === 'string') { if (typeof v === 'string') out[key] = v; }
  }
  return out;
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
  constructor() {
    this._lock = null;
    this._pending = null;
    this._want = false;
    this._bound = false;
    this._blocked = false;
  }

  /** Bound once, and before the first request — a request that fails needs
   *  this listener just as much as one that succeeds, to un-block itself. */
  _bind() {
    if (this._bound) return;
    this._bound = true;
    // iOS drops the lock whenever the tab is backgrounded and does not give
    // it back on return, so it has to be re-taken by hand.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this._blocked = false;
      if (this._want && !this._lock) this.enable().catch(() => {});
    });
  }

  async enable() {
    this._want = true;
    if (!('wakeLock' in navigator)) return false;
    this._bind();
    // syncScreenLock() runs on every tone change. Without this guard each one
    // requested a fresh sentinel and dropped the previous one un-released,
    // leaking them for as long as the app stayed open.
    if (this._lock) return true;
    if (this._pending) return this._pending;
    // A request rejects when the document is hidden, or outright where the
    // API is disabled. Retrying on every tone change after that is pointless
    // noise; _bind's listener clears this and tries again on return.
    if (this._blocked) return false;
    try {
      this._pending = navigator.wakeLock.request('screen');
      this._lock = await this._pending;
      this._pending = null;
      this._lock.addEventListener?.('release', () => { this._lock = null; });
      return true;
    } catch {
      this._pending = null;
      this._blocked = true;
      return false;
    }
  }

  async disable() {
    this._want = false;
    this._blocked = false;
    try { await this._lock?.release(); } catch {}
    this._lock = null;
    this._pending = null;
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
