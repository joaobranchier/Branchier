/**
 * tones.js — Siren tone specification database.
 *
 * Every figure below is taken from published manufacturer data or standards,
 * not invented. Sources are cited per entry so the numbers can be audited.
 *
 *  - Federal Signal PA300 (models 690000/690001): sweep range 725–1800 Hz;
 *    cycle rates Wail 15 cpm, Yelp 220 cpm, Hi-Lo 70 cpm, Priority 1300 cpm.
 *  - Federal Signal PA300-012MSC: 700–1600 Hz.
 *  - DIN 14610 (European two-tone / Martinshorn): two fixed tones a musical
 *    fourth apart (ratio 1:1.33) within 360–630 Hz. Martin-Horn tuning a'/d''
 *    = 440/585 Hz.
 *  - Rumbler-class low-frequency siren: 182–400 Hz, run in tandem with a
 *    conventional high-frequency siren.
 *  - Nathan AirChime chord horns: fundamentals ~311 Hz (D#) to 415 Hz (G#);
 *    K5LA bells span 155–622 Hz, tuned D# F# G# B D#(oct); harmonics past 5 kHz.
 *  - Federal Signal Q2B: 14-port rotor, fundamental variable with rotor speed,
 *    roughly 400–800 Hz at operating speed; coaster clutch gives a long
 *    coast-down. f = (rotor_rpm / 60) * ports.
 *
 * cpm  = cycles per minute (manufacturer's unit). Hz = cpm / 60.
 */

/** Convert a manufacturer cycles-per-minute figure to hertz. */
export const cpmToHz = (cpm) => cpm / 60;

/**
 * Sweep shapes. Each returns the LFO wave used to drive the carrier and,
 * where the sweep is asymmetric, the ratio of rise time to the full period.
 *   - 'tri'   symmetric rise/fall (Federal Signal electronic sweep)
 *   - 'ramp'  asymmetric: slow rise, faster fall (long-range highway wail)
 *   - 'sq'    no sweep at all, hard alternation between two pitches (Hi-Lo)
 */

export const TONES = {
  wail1: {
    id: 'wail1',
    label: 'WAIL-1',
    caption: 'Wail clássico',
    blurb: 'Varredura lenta 725→1800 Hz. O som de patrulha norte-americano. Alcance longo — usado em via expressa, onde o aviso precisa chegar cedo.',
    spec: 'Federal Signal PA300 · 725–1800 Hz · 15 cpm',
    kind: 'sweep',
    lo: 725, hi: 1800,
    rateHz: cpmToHz(15),      // 0.25 Hz -> 4.0 s per full cycle
    shape: 'tri',
    wave: 'siren',
    detune: 6,                 // Hz of beating between the two speaker drivers
    icon: { cycles: 3,  shape: 'tri',  amp: 1.00 },
    gain: 0.82,
  },

  wail2: {
    id: 'wail2',
    label: 'WAIL-2',
    caption: 'Wail longo alcance',
    blurb: 'Varredura mais grave e mais lenta, com subida arrastada e descida rápida. Penetra melhor a longa distância e em ruas fechadas.',
    spec: 'PA300-012MSC · 700–1600 Hz · 11 cpm · assimétrico',
    kind: 'sweep',
    lo: 700, hi: 1600,
    rateHz: cpmToHz(11),      // 0.1833 Hz -> ~5.45 s per cycle
    shape: 'ramp',
    riseRatio: 0.68,           // 68% of the period rising, 32% falling
    wave: 'siren',
    detune: 5,
    icon: { cycles: 2,  shape: 'ramp', amp: 0.95 },
    gain: 0.82,
  },

  yelp: {
    id: 'yelp',
    label: 'YELP',
    caption: 'Yelp',
    blurb: 'Mesma faixa do wail, varrida ~15× mais rápido. Cria urgência imediata — é o tom de cruzamento, para quem está a poucos metros.',
    spec: 'Federal Signal PA300 · 725–1800 Hz · 220 cpm',
    kind: 'sweep',
    lo: 725, hi: 1800,
    rateHz: cpmToHz(220),     // 3.667 Hz -> 273 ms per cycle
    shape: 'tri',
    wave: 'siren',
    detune: 7,
    icon: { cycles: 7,  shape: 'tri',  amp: 1.00 },
    gain: 0.80,
  },

  phaser: {
    id: 'phaser',
    label: 'PHSR',
    caption: 'Phaser / Priority',
    blurb: 'Varredura extremamente rápida somada a duas frequências levemente desencontradas. O batimento entre elas produz o "rasgo" que fura o trânsito parado à frente.',
    spec: 'PA300 Priority · 725–1800 Hz · 1300 cpm + batimento',
    kind: 'sweep',
    lo: 725, hi: 1800,
    rateHz: cpmToHz(1300),    // 21.67 Hz -> 46 ms per cycle
    shape: 'tri',
    wave: 'siren',
    detune: 11,                // wider offset: the interference IS the effect
    // Locked to the sweep rather than restated, so the two cannot drift apart.
    gate: { rateHz: cpmToHz(1300), depth: 0.55 },
    icon: { cycles: 12, shape: 'tri',  amp: 0.90 },
    gain: 0.74,
  },

  hilo: {
    id: 'hilo',
    label: 'HI-LO',
    caption: 'Hi-Lo europeu',
    blurb: 'Dois tons fixos alternando — o "nêe-nááw". Não é varredura: salta entre lá (440 Hz) e ré (585 Hz), uma quarta justa, como manda a norma alemã.',
    spec: 'DIN 14610 / Martin-Horn · 440 ↔ 585 Hz · 70 cpm',
    kind: 'twotone',
    lo: 440, hi: 585,          // a' / d'' — ratio 1.3295, the required ~1:1.33
    rateHz: cpmToHz(70),      // 1.167 Hz -> 857 ms per pair
    shape: 'sq',
    wave: 'horn',              // the European unit is a trumpet, not a speaker
    detune: 3,
    glideMs: 18,               // real horns take a few ms to change pitch
    icon: { cycles: 4,  shape: 'sq',   amp: 0.80 },
    gain: 0.78,
  },

  wawa: {
    id: 'wawa',
    label: 'WA.WA',
    caption: 'Wa-Wa',
    blurb: 'Varredura média com tremolo profundo travado na mesma taxa. O volume pulsa junto com o tom e produz o "uá-uá" que vira de cabeça quem está ao lado.',
    spec: '725–1800 Hz · 132 cpm · AM 85% sincronizada',
    kind: 'sweep',
    lo: 725, hi: 1800,
    rateHz: cpmToHz(132),     // 2.2 Hz
    shape: 'tri',
    wave: 'siren',
    detune: 6,
    gate: { rateHz: cpmToHz(132), depth: 0.85 },
    icon: { cycles: 5,  shape: 'tri',  amp: 0.62 },
    gain: 0.82,
  },

  airhorn: {
    id: 'airhorn',
    label: 'AIR HORN',
    caption: 'Air horn',
    blurb: 'Buzina de ar de caminhão. Três trombetas afinadas em acorde, levemente desafinadas entre si para bater, com jato de ar no ataque e queda de pressão ao soltar.',
    spec: 'Nathan AirChime · 311 Hz (D#) + acorde · harmônicos >5 kHz',
    kind: 'horn',
    // Nathan K-series fundamentals sit between ~311 Hz (D#) and 415 Hz (G#).
    // A three-bell chord: D#4, G4 (major third), A#4 (fifth).
    bells: [
      { hz: 311.13, gain: 1.00, detune: 0.7 },   // D#4 — the fundamental bell
      { hz: 392.00, gain: 0.62, detune: -1.1 },  // G4
      { hz: 466.16, gain: 0.45, detune: 1.6 },   // A#4
    ],
    wave: 'horn',
    attackMs: 26,
    releaseMs: 180,
    scoopSemis: 1.4,           // pitch rises into tune as air pressure builds
    droopSemis: 0.9,           // and falls away as it bleeds out
    airNoise: 0.22,
    gain: 0.95,
  },

  rumbler: {
    id: 'rumbler',
    label: 'RUMBLE',
    caption: 'Rumbler (grave)',
    blurb: 'Camada de baixa frequência que acompanha a sirene principal. Você sente antes de ouvir — é o que faz o vidro do carro da frente vibrar.',
    spec: 'Rumbler-class · 182–400 Hz · subharmônico da sirene ativa',
    kind: 'rumble',
    lo: 182, hi: 400,
    divisor: 4,                // tracks the active siren two octaves down
    wave: 'rumble',
    gain: 0.90,
  },

  mech: {
    id: 'mech',
    label: 'Q-SIREN',
    caption: 'Sirene mecânica',
    blurb: 'A eletromecânica de bombeiro. Um rotor de 14 portas cortando ar: sobe devagar conforme o motor ganha rotação e desce sozinha por muito tempo, em ponto morto.',
    spec: 'Federal Signal Q2B · rotor 14 portas · 400–800 Hz · 123 dB @ 3 m',
    kind: 'mechanical',
    ports: 14,                 // f = (rpm / 60) * ports
    idleRpm: 0,
    runRpm: 3430,              // (3430/60)*14 = 800 Hz peak fundamental
    spinUpS: 8.5,              // motor loaded against the rotor
    coastDownS: 19.0,          // the coaster clutch is why this takes so long
    wave: 'mech',
    airNoise: 0.30,
    gain: 0.88,
  },

  manual: {
    id: 'manual',
    label: 'MANUAL',
    caption: 'Wail manual',
    blurb: 'Você é o operador. Segure para subir o tom, solte para deixar cair. É assim que se "toca" uma sirene de verdade em cima da hora.',
    spec: 'Whelen-style manual wail · 600–1750 Hz',
    kind: 'manual',
    lo: 600, hi: 1750,
    riseS: 1.9,
    fallS: 3.4,
    wave: 'siren',
    detune: 6,
    gain: 0.84,
  },
};

/**
 * The frequency span a tone occupies, normalised.
 *
 * RUMBLE has to track whatever is currently playing, but the mechanical and
 * air-horn tones describe themselves with rotor speeds and bell pitches
 * rather than a lo/hi pair — reading `.lo` off those produced NaN and a
 * non-finite AudioParam. Every kind answers the same question here.
 */
export function toneRange(spec) {
  switch (spec.kind) {
    case 'mechanical': {
      const hi = (spec.runRpm / 60) * spec.ports;
      return { lo: hi * 0.35, hi, rateHz: 0, shape: 'tri' };
    }
    case 'horn': {
      const hz = spec.bells.map((b) => b.hz);
      return { lo: Math.min(...hz), hi: Math.max(...hz), rateHz: 0, shape: 'tri' };
    }
    default:
      return {
        lo: spec.lo, hi: spec.hi,
        rateHz: spec.rateHz ?? 0,
        shape: spec.shape ?? 'tri',
      };
  }
}

/** The order AUTO scans through, mirroring a real auto-scan controller. */
export const AUTO_CYCLE = ['wail1', 'yelp', 'phaser'];

/**
 * MOD trims the sweep rate of the active tone, the way the rate pot on a
 * programmable siren head does. Index 1 is the manufacturer's figure.
 */
export const MOD_STEPS = [
  { label: 'SLOW', factor: 0.62 },
  { label: 'STD',  factor: 1.00 },
  { label: 'FAST', factor: 1.55 },
];
