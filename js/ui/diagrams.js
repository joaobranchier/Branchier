/**
 * diagrams.js — the illustrations in the guide.
 *
 * Every one is generated from the tone's own entry in tones.js, so a picture
 * here cannot drift away from what the oscillator actually does: change a
 * sweep rate and its plot redraws. Nothing is hand-drawn.
 *
 * Returns SVG strings rather than DOM, because the guide builds its pages as
 * HTML in one pass and these drop straight in.
 */

import { toneRange } from '../audio/tones.js';

const W = 320, H = 96, PAD_L = 34, PAD_R = 8, PAD_T = 10, PAD_B = 18;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(1).replace('.', ',')}k` : Math.round(hz));
const fmtS = (s) => (s >= 1 ? `${s.toFixed(1).replace('.', ',')} s` : `${Math.round(s * 1000)} ms`);

/* ------------------------------------------------------------------ *
 * Frequency over time
 * ------------------------------------------------------------------ */

/**
 * Samples the tone's pitch over a window of time, in the same terms the
 * synthesis uses. Returns { pts: [[t, hz]…], span, lo, hi, caption }.
 */
function trace(spec) {
  const r = toneRange(spec);

  if (spec.kind === 'mechanical') {
    // The rotor's whole story: wind-up under power, then the coast-down.
    const total = spec.spinUpS + spec.coastDownS;
    const peak = (spec.runRpm / 60) * spec.ports;
    const idle = (60 / 60) * spec.ports;
    const kneeT = spec.spinUpS * 0.42;
    const kneeHz = peak * 0.72;
    const pts = [];
    for (let i = 0; i <= 160; i++) {
      const t = (i / 160) * total;
      let hz;
      if (t <= kneeT) hz = idle * Math.pow(kneeHz / idle, t / kneeT);
      else if (t < spec.spinUpS) hz = kneeHz * Math.pow(peak / kneeHz, (t - kneeT) / (spec.spinUpS - kneeT));
      else hz = peak * Math.pow(((40 / 60) * spec.ports) / peak, (t - spec.spinUpS) / spec.coastDownS);
      pts.push([t, hz]);
    }
    return {
      pts, span: total, lo: idle, hi: peak,
      caption: `sobe em ${fmtS(spec.spinUpS)}, desce em ${fmtS(spec.coastDownS)}`,
      marks: [{ t: spec.spinUpS, label: 'corta a força' }],
    };
  }

  if (spec.kind === 'horn') {
    // A chord does not sweep: it is three steady bells struck together.
    const span = 1.2;
    return {
      pts: null,
      lines: spec.bells.map((b) => b.hz),
      span, lo: Math.min(...spec.bells.map((b) => b.hz)) * 0.8,
      hi: Math.max(...spec.bells.map((b) => b.hz)) * 1.15,
      // One note plus its beat, not a chord — so the caption says what the
      // lines actually are instead of counting them.
      caption: 'nota única sustentada, sem varredura',
    };
  }

  if (spec.kind === 'manual') {
    const span = spec.riseS + spec.fallS;
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * span;
      const hz = t <= spec.riseS
        ? spec.lo * Math.pow(spec.hi / spec.lo, t / spec.riseS)
        : spec.hi * Math.pow(spec.lo / spec.hi, (t - spec.riseS) / spec.fallS);
      pts.push([t, hz]);
    }
    return {
      pts, span, lo: spec.lo, hi: spec.hi,
      caption: `sobe enquanto você segura, cai ao soltar`,
      marks: [{ t: spec.riseS, label: 'solta' }],
    };
  }

  if (spec.kind === 'rumble') {
    // It has no sweep of its own: it follows the siren above it, divided
    // down. Drawing both makes that relationship the point of the picture.
    const src = { lo: 725, hi: 1800, rateHz: 0.25 };
    const div = 4;
    const period = 1 / src.rateHz;
    const span = period * 2.2;
    const mk = (lo, hi) => {
      const out = [];
      for (let i = 0; i <= 300; i++) {
        const t = (i / 300) * span;
        const ph = (t / period) % 1;
        const k = ph < 0.5 ? ph / 0.5 : 1 - (ph - 0.5) / 0.5;
        out.push([t, lo + k * (hi - lo)]);
      }
      return out;
    };
    return {
      pts: mk(Math.max(spec.lo, src.lo / div), Math.min(spec.hi, src.hi / div)),
      ghost: mk(src.lo, src.hi),
      span, lo: spec.lo * 0.7, hi: src.hi,
      caption: 'segue a sirene, duas oitavas abaixo',
    };
  }

  // Sweeping and two-tone sirens: show a couple of cycles.
  const period = 1 / r.rateHz;
  const cycles = r.rateHz > 8 ? 6 : 2.2;
  const span = period * cycles;
  const shape = r.shape;
  const rise = shape === 'ramp' ? (spec.riseRatio ?? 0.68) : 0.5;
  const pts = [];
  const steps = 400;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * span;
    const ph = (t / period) % 1;
    let k;
    if (shape === 'sq') k = ph < 0.5 ? 1 : 0;
    else k = ph < rise ? ph / rise : 1 - (ph - rise) / (1 - rise);
    pts.push([t, r.lo + k * (r.hi - r.lo)]);
  }
  return {
    pts, span, lo: r.lo, hi: r.hi,
    caption: shape === 'sq'
      ? `alterna a cada ${fmtS(period / 2)}`
      : `um ciclo completo a cada ${fmtS(period)}`,
  };
}

/** Frequency-versus-time plot for one tone. */
export function sweepPlot(spec) {
  const t = trace(spec);
  const yLo = t.lo * 0.82;
  const yHi = t.hi * 1.1;
  const x = (time) => PAD_L + (time / t.span) * PLOT_W;
  const y = (hz) => PAD_T + PLOT_H - ((hz - yLo) / (yHi - yLo)) * PLOT_H;

  let body = '';

  if (t.lines) {
    // Steady bells: one horizontal line each, thickest for the fundamental.
    body += t.lines.map((hz, i) => `
      <line x1="${PAD_L}" y1="${y(hz).toFixed(1)}" x2="${W - PAD_R}" y2="${y(hz).toFixed(1)}"
            stroke="var(--amber)" stroke-width="${i === 0 ? 2.4 : 1.4}" opacity="${i === 0 ? 1 : 0.6}"/>
      <text x="${W - PAD_R - 2}" y="${(y(hz) - 4).toFixed(1)}" text-anchor="end"
            class="dg-tick">${fmtHz(hz)}</text>`).join('');
  } else {
    const draw = (pts) => pts.map(([time, hz], i) =>
      `${i ? 'L' : 'M'}${x(time).toFixed(1)},${y(hz).toFixed(1)}`).join('');
    if (t.ghost) {
      body += `
      <path d="${draw(t.ghost)}" fill="none" stroke="currentColor" stroke-width="1.6"
            opacity=".3" stroke-dasharray="4 3" stroke-linejoin="round"/>`;
    }
    body += `
      <path d="${draw(t.pts)}" fill="none" stroke="var(--amber)" stroke-width="2.2"
            stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  // Guides at the two endpoints, so the numbers in the spec line are visible
  // in the picture too.
  const guide = (hz, label) => `
    <line x1="${PAD_L}" y1="${y(hz).toFixed(1)}" x2="${W - PAD_R}" y2="${y(hz).toFixed(1)}"
          stroke="currentColor" stroke-width="1" opacity=".18" stroke-dasharray="3 3"/>
    <text x="${PAD_L - 5}" y="${(y(hz) + 3.5).toFixed(1)}" text-anchor="end" class="dg-tick">${label}</text>`;

  const marks = (t.marks ?? []).map((m) => `
    <line x1="${x(m.t).toFixed(1)}" y1="${PAD_T}" x2="${x(m.t).toFixed(1)}" y2="${PAD_T + PLOT_H}"
          stroke="var(--red-hi)" stroke-width="1.2" stroke-dasharray="2 3" opacity=".8"/>
    <text x="${(x(m.t) + 4).toFixed(1)}" y="${PAD_T + 9}" class="dg-tick" fill="var(--red-hi)">${m.label}</text>`).join('');

  return `
  <svg class="dg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Frequência ao longo do tempo">
    <rect x="${PAD_L}" y="${PAD_T}" width="${PLOT_W}" height="${PLOT_H}" fill="rgba(255,255,255,.03)" rx="4"/>
    ${guide(t.hi, fmtHz(t.hi))}
    ${guide(t.lo, fmtHz(t.lo))}
    ${body}
    ${marks}
    <text x="${PAD_L - 5}" y="${PAD_T - 2}" text-anchor="end" class="dg-axis">Hz</text>
    <text x="${W - PAD_R}" y="${H - 5}" text-anchor="end" class="dg-axis">${t.caption}</text>
    <text x="${PAD_L}" y="${H - 5}" class="dg-axis">tempo →</text>
  </svg>`;
}

/* ------------------------------------------------------------------ *
 * Derived character profile
 * ------------------------------------------------------------------ */

/**
 * Three qualities, each computed from the tone's own numbers rather than
 * asserted, so the bars stay consistent with one another and with any change
 * to the specs. They compare the tones to each other; they are not
 * measurements of a real siren on a real street.
 *
 *  - alcance      lower mean pitch and a slower sweep carry further and are
 *                 easier to judge distance from
 *  - urgência     how fast the pitch moves; this is what reads as "hurry"
 *  - penetração   share of the tone that sits below 1 kHz, where a car body
 *                 stops shielding the cabin
 */
export function profile(spec) {
  const r = toneRange(spec);
  const mean = (r.lo + r.hi) / 2;
  const rate = r.rateHz || 0.18;

  // 250 Hz -> 1, 1800 Hz -> 0 on a log scale.
  const lowness = clamp01((Math.log2(1800 / mean)) / Math.log2(1800 / 250));
  // 0.18 Hz -> 0, 22 Hz -> 1 on a log scale.
  const speed = clamp01(Math.log2(rate / 0.15) / Math.log2(22 / 0.15));
  // Fraction of the swept band that falls under 1 kHz.
  const below = clamp01((Math.min(1000, r.hi) - r.lo) / Math.max(1, r.hi - r.lo));

  return [
    { label: 'Alcance',    v: clamp01(0.30 + 0.55 * lowness + 0.15 * (1 - speed)) },
    { label: 'Urgência',   v: clamp01(0.12 + 0.88 * speed) },
    { label: 'Penetração', v: clamp01(0.10 + 0.90 * (0.65 * lowness + 0.35 * below)) },
  ];
}

export function profileBars(spec) {
  const rows = profile(spec).map((p, i) => {
    const y = 10 + i * 22;
    return `
      <text x="0" y="${y + 9}" class="dg-label">${p.label}</text>
      <rect x="74" y="${y}" width="230" height="12" rx="6" fill="rgba(255,255,255,.07)"/>
      <rect x="74" y="${y}" width="${(230 * p.v).toFixed(1)}" height="12" rx="6" fill="var(--amber)" opacity=".85"/>`;
  }).join('');
  return `
  <svg class="dg dg--bars" viewBox="0 0 310 74" role="img"
       aria-label="Perfil comparativo do tom">${rows}</svg>`;
}

/* ------------------------------------------------------------------ *
 * Why low frequencies get inside a car
 * ------------------------------------------------------------------ */

/**
 * One shared chart for the "how it works" tab: a car body blocks high
 * frequencies far more than low ones, which is the reason the tone bands sit
 * where they do — and the reason the Rumbler exists at all.
 */
export function penetrationChart(bands) {
  const w = 320, h = 150, l = 34, b = 26, t = 12, r = 8;
  const pw = w - l - r, ph = h - t - b;
  // 100 Hz .. 6 kHz, log scale
  const fx = (hz) => l + (Math.log10(hz / 100) / Math.log10(60)) * pw;
  // Transmission loss through a modern car body: small below a few hundred
  // hertz, climbing steeply past 1 kHz.
  // Clamp before the exponent: below 160 Hz the ratio goes negative, and a
  // negative base raised to a fractional power is NaN.
  const loss = (hz) => clamp01(Math.log10(hz / 160) / Math.log10(30)) ** 1.35;
  const fy = (v) => t + ph - v * ph;

  let curve = '';
  for (let i = 0; i <= 120; i++) {
    const hz = 100 * Math.pow(60, i / 120);
    curve += `${i ? 'L' : 'M'}${fx(hz).toFixed(1)},${fy(loss(hz)).toFixed(1)}`;
  }

  const ticks = [100, 300, 1000, 3000, 6000].map((hz) => `
    <line x1="${fx(hz).toFixed(1)}" y1="${t}" x2="${fx(hz).toFixed(1)}" y2="${t + ph}"
          stroke="currentColor" opacity=".1"/>
    <text x="${fx(hz).toFixed(1)}" y="${h - 12}" text-anchor="middle" class="dg-tick">${fmtHz(hz)}</text>`).join('');

  // Each tone's band as a shaded column, so it reads as "this tone lives
  // here" rather than as a floating line. The label gets a backing plate:
  // without it, the one over the steep part of the curve is unreadable.
  const marks = (bands ?? []).map((band, i) => {
    const x1 = fx(Math.max(100, band.lo));
    const x2 = fx(Math.min(6000, band.hi));
    const y = t + 7 + i * 14;
    const cx = (x1 + x2) / 2;
    const wLabel = band.label.length * 5.4 + 8;
    return `
      <rect x="${x1.toFixed(1)}" y="${t}" width="${(x2 - x1).toFixed(1)}" height="${ph}"
            fill="${band.color}" opacity=".08"/>
      <line x1="${x1.toFixed(1)}" y1="${(y + 7).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${(y + 7).toFixed(1)}"
            stroke="${band.color}" stroke-width="3" stroke-linecap="round" opacity=".95"/>
      <rect x="${(cx - wLabel / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}"
            width="${wLabel.toFixed(1)}" height="12" rx="3" fill="#0b0d0f" opacity=".92"/>
      <text x="${cx.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle"
            class="dg-tick" fill="${band.color}">${band.label}</text>`;
  }).join('');

  return `
  <svg class="dg dg--wide" viewBox="0 0 ${w} ${h}" role="img"
       aria-label="Quanto a carroceria de um carro barra cada frequência">
    <rect x="${l}" y="${t}" width="${pw}" height="${ph}" fill="rgba(255,255,255,.03)" rx="4"/>
    ${ticks}
    <path d="${curve}" fill="none" stroke="var(--lcd-ink)" stroke-width="2.2" stroke-linecap="round"/>
    ${marks}
    <text x="${l - 5}" y="${t + 8}" text-anchor="end" class="dg-tick">barra</text>
    <text x="${l - 5}" y="${t + ph}" text-anchor="end" class="dg-tick">passa</text>
    <text x="${w - r}" y="${h - 1}" text-anchor="end" class="dg-axis">frequência (Hz) →</text>
  </svg>`;
}

/* ------------------------------------------------------------------ *
 * Distance and the inverse-square law
 * ------------------------------------------------------------------ */

/**
 * Sound spreading outward loses 6 dB for every doubling of distance. Drawn
 * against the figure US DOT measured for an urban intersection: after the
 * car's own noise and its bodywork, a siren only really lands inside the
 * cabin within about 8 to 12 metres.
 */
export function rangeChart() {
  const w = 320, h = 128, l = 30, b = 26, t = 10, r = 10;
  const pw = w - l - r, ph = h - t - b;
  // Domain starts at 3 m, which is where siren output is actually rated
  // (the Q2B's 123 dB figure is "at 10 feet"). Starting at 1 m would put the
  // curve above the top of the frame.
  const M0 = 3, M1 = 100, DB0 = 115, DB1 = 80;
  const fx = (m) => l + (Math.log10(m / M0) / Math.log10(M1 / M0)) * pw;
  const fy = (db) => t + ((DB0 - db) / (DB0 - DB1)) * ph;

  let curve = '';
  for (let i = 0; i <= 120; i++) {
    const m = M0 * Math.pow(M1 / M0, i / 120);
    // 6 dB per doubling of distance, from 115 dB at the 3 m reference.
    const db = DB0 - 20 * Math.log10(m / M0);
    curve += `${i ? 'L' : 'M'}${fx(m).toFixed(1)},${fy(db).toFixed(1)}`;
  }

  const ticks = [3, 6, 12, 25, 50, 100].map((m) => `
    <line x1="${fx(m).toFixed(1)}" y1="${t}" x2="${fx(m).toFixed(1)}" y2="${t + ph}"
          stroke="currentColor" opacity=".1"/>
    <text x="${fx(m).toFixed(1)}" y="${h - 12}" text-anchor="middle" class="dg-tick">${m} m</text>`).join('');

  return `
  <svg class="dg dg--wide" viewBox="0 0 ${w} ${h}" role="img"
       aria-label="Perda de nível com a distância">
    <rect x="${l}" y="${t}" width="${pw}" height="${ph}" fill="rgba(255,255,255,.03)" rx="4"/>
    ${ticks}
    <rect x="${fx(8).toFixed(1)}" y="${t}" width="${(fx(12) - fx(8)).toFixed(1)}" height="${ph}"
          fill="var(--red-hi)" opacity=".18"/>
    <text x="${fx(10).toFixed(1)}" y="${t + 12}" text-anchor="middle" class="dg-tick" fill="var(--red-hi)">8–12 m</text>
    <path d="${curve}" fill="none" stroke="var(--amber)" stroke-width="2.2" stroke-linecap="round"/>
    <text x="${l - 4}" y="${(fy(DB0) + 8).toFixed(1)}" text-anchor="end" class="dg-tick">${DB0} dB</text>
    <text x="${l - 4}" y="${fy(DB1 + 1).toFixed(1)}" text-anchor="end" class="dg-tick">${DB1} dB</text>
    <text x="${w - r}" y="${h - 1}" text-anchor="end" class="dg-axis">distância →</text>
  </svg>`;
}
