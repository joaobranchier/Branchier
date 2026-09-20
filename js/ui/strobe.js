/**
 * strobe.js — the lightbar.
 *
 * LMB flashes *behind* the faceplate, the way the original app presents it,
 * so the keys stay reachable while the lights run — being unable to change
 * tone without first killing the lightbar is the wrong trade. LIGHT is the
 * one that takes the whole screen, because there it is the point: a torch.
 *
 * Patterns are step tables of [leftOn, rightOn, milliseconds], written to
 * match the flash rates real warning bars use (SAE J595 allows 75–240 flashes
 * per minute per side; quad and single flash are the two commonest patterns).
 *
 * Driven by requestAnimationFrame against a wall clock rather than timers, so
 * a dropped frame shifts nothing: the pattern stays on schedule.
 */

const PATTERNS = {
  alt: {
    label: 'Alternado',
    steps: [[1, 0, 120], [0, 0, 60], [1, 0, 120], [0, 0, 60],
            [0, 1, 120], [0, 0, 60], [0, 1, 120], [0, 0, 60]],
  },
  quad: {
    label: 'Quad flash',
    steps: [[1, 0, 55], [0, 0, 55], [1, 0, 55], [0, 0, 55],
            [1, 0, 55], [0, 0, 55], [1, 0, 55], [0, 0, 190],
            [0, 1, 55], [0, 0, 55], [0, 1, 55], [0, 0, 55],
            [0, 1, 55], [0, 0, 55], [0, 1, 55], [0, 0, 190]],
  },
  single: {
    label: 'Flash simples',
    steps: [[1, 0, 90], [0, 0, 330], [0, 1, 90], [0, 0, 330]],
  },
  both: {
    label: 'Simultâneo',
    steps: [[1, 1, 80], [0, 0, 70], [1, 1, 80], [0, 0, 330]],
  },
  slow: {
    label: 'Lento (suave)',
    steps: [[1, 0, 420], [0, 0, 120], [0, 1, 420], [0, 0, 120]],
  },
};

export const PATTERN_LIST = Object.entries(PATTERNS).map(([id, p]) => ({ id, label: p.label }));

export class Strobe {
  constructor(root) {
    this.root = root;
    this.left = root.querySelector('.strobe__half--l');
    this.right = root.querySelector('.strobe__half--r');
    this.exit = root.querySelector('.strobe__exit');
    this.raf = 0;
    this.mode = null;           // 'bar' | 'white' | null
    this.pattern = 'alt';
    this.brightness = 1;
    this.onEnd = null;
  }

  get active() { return this.mode !== null; }

  setPattern(id) { if (PATTERNS[id]) this.pattern = id; }
  setBrightness(v) { this.brightness = Math.max(0.15, Math.min(1, v)); }

  /** @param {'bar'|'white'} mode */
  start(mode) {
    this.stop(true);
    this.mode = mode;
    this.root.hidden = false;
    this.root.setAttribute('aria-hidden', 'false');
    this.root.classList.toggle('strobe--white', mode === 'white');
    // Behind the faceplate, and transparent to touches, so every key still works.
    this.root.classList.toggle('strobe--behind', mode === 'bar');
    this.exit.hidden = mode !== 'white';

    if (mode === 'white') {
      // Takedown / scene light: steady, and genuinely useful as a torch.
      this.left.style.opacity = this.brightness;
      this.right.style.opacity = this.brightness;
      return;
    }

    const steps = PATTERNS[this.pattern].steps;
    const total = steps.reduce((a, s) => a + s[2], 0);
    const t0 = performance.now();

    const tick = (now) => {
      let t = (now - t0) % total;
      let i = 0;
      while (t >= steps[i][2]) { t -= steps[i][2]; i++; }
      const [l, r] = steps[i];
      this.left.style.opacity = l ? this.brightness : 0;
      this.right.style.opacity = r ? this.brightness : 0;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(silent = false) {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mode = null;
    this.left.style.opacity = 0;
    this.right.style.opacity = 0;
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    if (!silent) this.onEnd?.();
  }
}
