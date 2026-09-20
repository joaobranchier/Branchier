/**
 * waveicons.js — the zigzag glyphs on the tone keys.
 *
 * Each glyph is generated from that tone's own `icon` block in tones.js, so a
 * key's picture says what the key does: PHSR gets a dense comb because it
 * sweeps at 1300 cpm, WAIL-2 gets two lazy asymmetric humps because it sweeps
 * at 11 and rises slower than it falls. The density is stored per tone rather
 * than fitted from the rate, because the useful range of rates spans two
 * orders of magnitude and any single curve either flattens the slow end or
 * saturates the fast one.
 */

import { TONES } from '../audio/tones.js';

const W = 44, H = 16, PAD = 2;

/**
 * @param {number} cycles  peaks to draw across the glyph
 * @param {'tri'|'ramp'|'sq'} shape
 * @param {number} amp  0..1 fraction of the glyph height used
 */
function path(cycles, shape, amp = 1) {
  const pts = [];
  const top = PAD + (H - PAD * 2) * (1 - amp) / 2;
  const bot = H - PAD - (H - PAD * 2) * (1 - amp) / 2;
  const steps = shape === 'sq' ? 2 : 2;

  if (shape === 'sq') {
    // Hi-Lo does not sweep, so its glyph is a square wave, not a zigzag.
    const seg = W / (cycles * 2);
    let x = 0, up = false;
    pts.push([x, bot]);
    for (let i = 0; i < cycles * 2; i++) {
      const y = up ? top : bot;
      pts.push([x, y], [x + seg, y]);
      x += seg; up = !up;
    }
    return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L');
  }

  const r = shape === 'ramp' ? 0.68 : 0.5;
  const period = W / cycles;
  pts.push([0, bot]);
  for (let i = 0; i < cycles; i++) {
    const x0 = i * period;
    pts.push([x0 + period * r, top], [x0 + period, bot]);
  }
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L');
}

export function injectWaveIcons() {
  const defs = document.querySelector('.sprite defs');
  if (!defs) return;
  const ns = 'http://www.w3.org/2000/svg';

  for (const [id, tone] of Object.entries(TONES)) {
    if (!tone.icon) continue;
    const sym = document.createElementNS(ns, 'symbol');
    sym.id = `w-${id}`;
    sym.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path(tone.icon.cycles, tone.icon.shape, tone.icon.amp));
    sym.appendChild(p);
    defs.appendChild(sym);
  }
}
