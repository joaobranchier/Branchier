/**
 * guide.js — SireFlex's guide: every tone and every key, explained.
 *
 * Four tabs, one place. The illustrations come from diagrams.js, which draws
 * them from the same tone specs the synthesiser reads, so nothing here can
 * quietly disagree with what you actually hear.
 */

import { TONES, MOD_STEPS } from '../audio/tones.js';
import { sweepPlot, profileBars, penetrationChart, rangeChart } from './diagrams.js';
import { PATTERN_LIST } from './strobe.js';
import { isIOS, isStandalone } from '../platform.js';
import { BUILD, BUILD_DATE } from '../build.js';

const el = () => document.getElementById('guide');
let ctl = null;
let tab = 'tones';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ *
 * Best-use notes
 * ------------------------------------------------------------------ */

/**
 * Why each tone exists and where it earns its keep. Drawn from the published
 * behaviour of these sirens rather than invented: the wail/yelp split between
 * open road and intersection, the priority tone's job of clearing the car
 * immediately ahead, and the Rumbler's whole reason for being — a car body
 * barely resists sound below a few hundred hertz and blocks it hard above a
 * kilohertz.
 */
const USE = {
  wail1: 'Via expressa e trecho aberto. A varredura lenta dá tempo do ouvido acompanhar a subida, e é isso que permite estimar de que lado o som vem e a que distância. É o tom que avisa cedo.',
  wail2: 'Rua fechada e distância longa. Mais grave que o WAIL-1 e com subida arrastada: perde menos energia no caminho e contorna melhor esquinas e prédios, onde o agudo simplesmente para na parede.',
  yelp: 'Cruzamento. A mesma faixa do wail varrida quinze vezes mais rápido lê como pressa — é o tom para quem está a poucos metros e precisa reagir agora, não daqui a pouco.',
  phaser: 'Trânsito parado logo à frente. Duas frequências levemente desencontradas batem entre si e produzem um som difícil de ignorar de perto. Serve para abrir caminho metro a metro, não para avisar de longe.',
  hilo: 'O padrão europeu. Dois tons fixos em vez de varredura: o ouvido reconhece o intervalo mesmo com ruído por cima, e a alternância não se confunde com nada mais no ambiente urbano.',
  wawa: 'Quando já existe outra sirene no ar. O tremolo profundo dá uma assinatura diferente, e é justamente isso que impede que dois veículos em comboio virem um borrão sonoro só.',
  airhorn: 'Um toque, na hora exata. Grave o bastante para atravessar vidro e lataria, curto o bastante para não virar ruído de fundo. É o que se usa quando a sirene contínua já parou de ser notada.',
  rumbler: 'Sempre junto de uma sirene, nunca sozinho. Entre 182 e 400 Hz o som atravessa a carroceria em vez de ricochetear nela — quem está dentro do carro, de vidro fechado e som ligado, sente antes de ouvir.',
  mech: 'Bombeiros, e por tradição. O rotor leva dois a três segundos para chegar ao regime e depois desce sozinho por quase meio minuto, em roda-livre. Não serve para ligar e desligar depressa: serve para anunciar que algo grande está vindo.',
  manual: 'Quando a situação muda mais rápido que um tom fixo. Você desenha a subida com o dedo — um golpe curto para o pedestre distraído, uma subida longa para abrir o cruzamento.',
};

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const TABS = [
  { id: 'tones', label: 'Sirenes' },
  { id: 'keys',  label: 'Botões' },
  { id: 'how',   label: 'Como funciona' },
  { id: 'set',   label: 'Ajustes' },
];

function toneCard(id) {
  const t = TONES[id];
  return `
  <article class="gcard" data-tone-card="${id}">
    <header class="gcard__head">
      <div>
        <b>${esc(t.label)}</b>
        <span class="gcard__sub">${esc(t.caption)}</span>
      </div>
      <button class="gplay" data-play="${id}" type="button" aria-pressed="false">
        <span class="gplay__ico" aria-hidden="true"></span><span class="gplay__txt">Ouvir</span>
      </button>
    </header>
    <p class="gcard__spec">${esc(t.spec)}</p>
    ${sweepPlot(t)}
    <p class="gcard__body">${esc(t.blurb)}</p>
    <h4>Melhor uso</h4>
    <p class="gcard__body">${esc(USE[id] ?? '')}</p>
    <h4>Perfil <span class="gcard__note">comparado aos outros tons</span></h4>
    ${profileBars(t)}
  </article>`;
}

function pageTones() {
  return `
    <p class="gintro">Toque em <b>Ouvir</b> para escutar cada tom aqui mesmo — o
       painel atrás fica como estava. O gráfico de cada cartão é desenhado a partir
       dos mesmos números que o sintetizador usa.</p>
    ${Object.keys(TONES).map(toneCard).join('')}`;
}

const KEYS = [
  { group: 'Tons', items: [
    ['WAIL-1 / WAIL-2', 'Travam a varredura lenta. Toque de novo para desligar.'],
    ['YELP', 'Varredura rápida, para curta distância.'],
    ['HI-LO', 'Dois tons fixos alternando, padrão europeu.'],
    ['PHSR', 'Varredura muito rápida com batimento. Curtíssima distância. É o <b>canal de prioridade</b>: apertado por cima de outra sirene, ele assume e a sirene fica esperando, com a tecla dela apagada mas acesa por dentro. Desligue o PHSR e ela volta sozinha — você não precisa reescolher o tom no meio do trânsito.'],
    ['WA.WA', 'Varredura média com tremolo profundo.'],
    ['Q-SIREN', 'A eletromecânica. Sobe em 2–3 s e desce sozinha por ~30 s.'],
    ['AIR HORN', 'Momentâneo: só soa enquanto o dedo está em cima.'],
    ['MANUAL', 'Momentâneo. Segure para subir o tom, solte para deixar cair.'],
  ]},
  { group: 'Modificadores', items: [
    ['HIGH', 'Equalização cortante e de longo alcance. Tira corpo, ganha penetração no agudo.'],
    ['BASS', 'Acrescenta corpo grave. Combine com HIGH para o modo mais alto.'],
    ['MOD', `Muda a velocidade de varredura do tom ativo: ${MOD_STEPS.map((m) => m.label).join(' → ')}.`],
    ['MIX', 'Empilha tons em vez de trocá-los. Serve para rodar sirene e buzina juntas.'],
    ['AUTO', 'Varre wail → yelp → phaser sozinho. Qualquer toque em um tom cancela.'],
    ['RUMBLE', 'Camada grave por baixo do que estiver tocando. Não toca sozinha.'],
  ]},
  { group: 'Luzes', items: [
    ['LED', 'Liga o giroflex vermelho/azul <b>atrás</b> do controle. Vem desligado e só acende aqui — os botões continuam funcionando com ele ligado.'],
    ['LUZ', 'Luz branca em tela cheia, útil como lanterna. Toque em qualquer lugar para sair.'],
  ]},
  { group: 'Controle', items: [
    ['STOP', 'Corta tudo na hora, inclusive um tom que ainda estava descendo.'],
    ['Vol − / Vol +', 'Volume principal, na barra embaixo do aparelho.'],
    ['Liga', 'Liga e desliga. Em standby o painel escurece e tudo se cala.'],
    ['Guia', 'Abre isto aqui.'],
    ['Ajustes', 'Abre isto aqui já na aba de ajustes.'],
  ]},
];

function pageKeys() {
  return `
    <p class="gintro">Tudo também funciona por teclado: <b>Tab</b> para navegar,
       <b>Enter</b> ou <b>Espaço</b> para acionar. Nos botões momentâneos o som dura
       enquanto a tecla fica pressionada.</p>
    ${KEYS.map((g) => `
      <h3>${esc(g.group)}</h3>
      <dl class="gkeys">
        ${g.items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}
      </dl>`).join('')}`;
}

function pageHow() {
  const bands = [
    { lo: 182,  hi: 400,  label: 'RUMBLE',  color: '#f5484e' },
    { lo: 440,  hi: 585,  label: 'HI-LO',   color: '#7dffb2' },
    { lo: 725,  hi: 1800, label: 'WAIL / YELP', color: '#ffb02e' },
  ];
  return `
    <h3>Por que o grave entra no carro e o agudo não</h3>
    ${penetrationChart(bands)}
    <p class="gcard__body">A carroceria de um carro moderno é projetada para barrar
       ruído, e faz isso muito melhor acima de 1 kHz do que abaixo de algumas centenas
       de hertz. Por isso a sirene aguda, que atravessa a rua sem esforço, morre no
       vidro do carro da frente — e por isso existe o Rumbler, que segue a mesma
       sirene uma ou duas oitavas abaixo só para atravessar a lataria.</p>

    <h3>Quanto o som perde com a distância</h3>
    ${rangeChart()}
    <p class="gcard__body">Som espalhando no ar perde <b>6 dB a cada vez que a
       distância dobra</b>. A faixa destacada é o número desconfortável: medições do
       Departamento de Transportes dos EUA em cruzamento urbano acharam que, depois do
       ruído do próprio carro e da carroceria, a sirene só chega de fato dentro da
       cabine a cerca de <b>8 a 12 metros</b>. É a distância de meio quarteirão, não
       de dois.</p>

    <h3>Por que varrer em vez de tocar um tom só</h3>
    <p class="gcard__body">Um tom fixo some no ruído da rua e é difícil de localizar:
       o ouvido precisa de mudança para dizer de onde algo vem. Varrer a frequência dá
       essa mudança continuamente, e a velocidade da varredura carrega a informação —
       lenta lê como "vem vindo", rápida lê como "está aqui". É por isso que wail e
       yelp usam exatamente a mesma faixa de frequência e mesmo assim significam
       coisas diferentes.</p>

    <h3>Como o som é feito aqui</h3>
    <p class="gcard__body">Não existe um único arquivo de áudio neste app. Cada tom é
       <b>calculado amostra a amostra</b>, porque as coisas que fazem esses sons serem
       reconhecíveis não cabem num punhado de osciladores. Uma buzina de ar é uma
       <b>palheta cortando o fluxo</b>, e o que se ouve como aspereza é ela não repetir
       exatamente igual a cada período. Uma Q-siren é um <b>rotor cortando ar</b>, e o
       ruído dela é modulado pelo próprio fluxo que gera o tom — não é chiado por
       baixo, é o ar sendo picado.</p>
    <p class="gcard__body">As sirenes de varredura são uma onda quadrada varrida: os
       harmônicos são somados um a um e descartados ao passar do limite de Nyquist, o
       que é o motivo de a varredura nunca devolver nota errada. A buzina são
       <b>duas</b> trombetas a uma terça menor — conjuntos duplos de fábrica são
       assim, e um acorde maior soaria musical, tipo órgão, não caminhão. A Q-siren
       segue a física do rotor: <code>f = (rpm ÷ 60) × portas</code>, com 14 portas,
       e o som irradiado é a <i>derivada</i> do fluxo, o que transforma a área aberta
       triangular numa onda quadrada assimétrica.</p>
    <p class="gcard__body">Cada família passa pelo <b>seu</b> radiador, porque uma
       corneta com driver de compressão, uma trombeta com pavilhão e um rotor em
       carcaça de aço não são o mesmo objeto. E o radiador das sirenes assume onde
       você está: uma corneta re-entrante é muito direcional no agudo, então da rua,
       fora do eixo dela, o topo cai e a fundamental não. É por isso que sirene de
       verdade ao ar livre é mais redonda do que sirene apontada para a sua cara.</p>

    <h3>De onde vêm os números</h3>
    <p class="gsmall">
      Federal Signal PA300 (690000/690001): 725–1800 Hz; wail 15 cpm, yelp 220 cpm,
      hi-lo 70 cpm, priority 1300 cpm. Modelo 012MSC: 700–1600 Hz.<br><br>
      DIN 14610 (Martinshorn): dois tons fixos a uma quarta justa, razão 1:1,33,
      dentro de 360–630 Hz; Martin-Horn afinado em lá/ré (440/585 Hz).<br><br>
      Sirene classe Rumbler: 182–400 Hz, tocada junto com a sirene aguda, seguindo-a
      uma ou duas oitavas abaixo.<br><br>
      Buzinas de acorde Nathan AirChime: fundamentais entre ~311 Hz (ré♯) e 415 Hz
      (sol♯), com harmônicos acima de 5 kHz.<br><br>
      Federal Signal Q2B: rotor de 14 portas, 123 dB a 3 m, fundamental variável com
      a rotação (≈400–800 Hz em regime), embreagem de roda-livre.
    </p>

    <div class="warn">
      <p><strong>Aviso legal.</strong> Simulador para uso pessoal, estudo e produção de
         áudio. Imitar sirene de viatura em via pública é infração — e, dependendo da
         situação, crime — na maior parte do mundo, Brasil incluído. Usar para se passar
         por autoridade ou para obrigar alguém a sair da frente é ilegal.</p>
    </div>`;
}

function pageSettings() {
  const p = ctl.prefs;
  const needsInstall = isIOS() && !isStandalone();
  return `
    <h3>Áudio</h3>
    <div class="field">
      <label for="sVol">Volume principal</label>
      <input type="range" id="sVol" min="0" max="100" step="1" value="${Math.round(p.volume * 100)}">
      <output id="oVol">${Math.round(p.volume * 100)}%</output>
    </div>

    <h3>Giroflex</h3>
    <p class="gsmall" style="margin:-4px 0 12px">Vem desligado e só acende quando você
       aperta <b>LED</b> ou <b>LUZ</b>. Nenhuma sirene liga a luz sozinha.</p>
    <div class="field">
      <label for="sPat">Padrão</label>
      <select id="sPat">
        ${PATTERN_LIST.map((x) => `<option value="${x.id}"${x.id === p.pattern ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="sBri">Intensidade</label>
      <input type="range" id="sBri" min="15" max="100" step="5" value="${Math.round(p.brightness * 100)}">
      <output id="oBri">${Math.round(p.brightness * 100)}%</output>
    </div>

    <h3>Comportamento</h3>
    <div class="switchrow">
      <div><span>Manter a tela acesa</span>
        <small>Enquanto algo estiver tocando. Sem isso o iPhone bloqueia e o som para.</small></div>
      <button class="toggle" id="tWake" aria-pressed="${p.wakeLock}" aria-label="Manter a tela acesa"></button>
    </div>
    <div class="switchrow">
      <div><span>Som dos botões</span>
        <small>O "clack" a cada toque. Ele sai por fora das sirenes, então o
           STOP não engole o próprio clique.</small></div>
      <button class="toggle" id="tClack" aria-pressed="${p.clack}" aria-label="Som dos botões"></button>
    </div>
    <div class="switchrow">
      <div><span>Resposta tátil</span>
        <small>${ctl.haptics.supported ? 'Vibração curta a cada toque.' : 'Não disponível neste navegador.'}</small></div>
      <button class="toggle" id="tHap" aria-pressed="${p.haptics}" aria-label="Resposta tátil"${ctl.haptics.supported ? '' : ' disabled style="opacity:.4"'}></button>
    </div>
    <div class="switchrow">
      <div><span>AUTO troca a cada</span>
        <small>Tempo em cada tom no modo de varredura automática.</small></div>
      <select id="sAuto" class="sel--inline">
        ${[4, 6, 8, 12].map((s) => `<option value="${s}"${s === p.autoSecs ? ' selected' : ''}>${s}s</option>`).join('')}
      </select>
    </div>

    ${needsInstall ? `
    <h3>Instalar no iPhone</h3>
    <p class="gcard__body">Para rodar em tela cheia, sem a barra do Safari e
       funcionando offline: toque em <b>Compartilhar</b> (o quadrado com a seta para
       cima), role e escolha <b>Adicionar à Tela de Início</b>.</p>` : ''}

    <div class="warn">
      <p><strong>Volume e audição.</strong> Ligado a uma caixa de som, esse material
         chega fácil a níveis que machucam. Comece baixo.</p>
    </div>
    <div class="warn">
      <p><strong>Fotossensibilidade.</strong> LED e LUZ piscam forte. Quem tem
         epilepsia fotossensível deve deixá-los desligados.</p>
    </div>
    <p class="gsmall">Sem anúncios, sem rastreamento, sem rede. Nenhum dado sai do
       aparelho — os ajustes ficam no armazenamento local do navegador.</p>

    <h3>Versão</h3>
    <div class="switchrow">
      <div><span>SireFlex ${BUILD} &middot; ${BUILD_DATE}</span>
        <small id="oUpd">O app se atualiza sozinho ao ser reaberto. Este botão
           força a verificação agora.</small></div>
      <button class="gplay" id="bUpd" type="button"><span class="gplay__txt">Verificar</span></button>
    </div>`;
}

const PAGES = { tones: pageTones, keys: pageKeys, how: pageHow, set: pageSettings };

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export function initGuide(controller) {
  ctl = controller;
  const root = el();

  root.querySelector('.guide__close').addEventListener('click', closeGuide);

  root.querySelector('.guide__tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });

  // One listener for the whole body, so re-rendering a page never leaves
  // stale handlers behind.
  root.querySelector('.guide__body').addEventListener('click', (e) => {
    const play = e.target.closest('[data-play]');
    if (play) { onPlay(play.dataset.play); return; }
  });
}

function onPlay(id) {
  ctl.ensureAudio().then(() => {
    ctl.haptics.tap();
    ctl.preview(id);
    syncPlayButtons();
  }).catch(() => {});
}

/** Reflects which tone the guide is currently auditioning. */
function syncPlayButtons() {
  for (const b of el().querySelectorAll('[data-play]')) {
    const on = b.dataset.play === ctl.previewId;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.querySelector('.gplay__txt').textContent = on ? 'Parar' : 'Ouvir';
  }
}

function render() {
  const root = el();
  for (const b of root.querySelectorAll('[data-tab]')) {
    b.classList.toggle('is-on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  const body = root.querySelector('.guide__body');
  body.innerHTML = PAGES[tab]();
  body.scrollTop = 0;
  if (tab === 'set') wireSettings(body);
  if (tab === 'tones') syncPlayButtons();
}

export function openGuide(startTab) {
  if (startTab) tab = startTab;
  el().hidden = false;
  document.body.classList.add('is-locked');
  render();
}

export function closeGuide() {
  // Listening in the guide should not leave a tone running behind it.
  ctl.stopPreview();
  el().hidden = true;
  document.body.classList.remove('is-locked');
}

export const guideOpen = () => !el().hidden;

/* ------------------------------------------------------------------ *
 * Settings wiring
 * ------------------------------------------------------------------ */

function wireSettings(root) {
  const vol = root.querySelector('#sVol'), oVol = root.querySelector('#oVol');
  vol.addEventListener('input', () => {
    oVol.textContent = `${vol.value}%`;
    ctl.setVolume(vol.value / 100);
  });

  const bri = root.querySelector('#sBri'), oBri = root.querySelector('#oBri');
  bri.addEventListener('input', () => {
    oBri.textContent = `${bri.value}%`;
    ctl.setPref('brightness', bri.value / 100);
    ctl.strobe.setBrightness(bri.value / 100);
  });

  root.querySelector('#sPat').addEventListener('change', (e) => {
    ctl.setPref('pattern', e.target.value);
    ctl.strobe.setPattern(e.target.value);
    // Only restart it if the user already had it running.
    if (ctl.strobe.mode === 'bar') ctl.strobe.start('bar');
  });

  root.querySelector('#sAuto').addEventListener('change', (e) => {
    ctl.setPref('autoSecs', Number(e.target.value));
  });

  const toggle = (sel, key, after) => {
    const b = root.querySelector(sel);
    b.addEventListener('click', () => {
      const v = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(v));
      ctl.setPref(key, v);
      after?.(v);
    });
  };
  toggle('#tWake', 'wakeLock', (v) => {
    if (!v) ctl.screenLock.disable();
    else if (ctl.isSounding) ctl.screenLock.enable();
  });
  toggle('#tHap', 'haptics', (v) => { ctl.haptics.enabled = v; if (v) ctl.haptics.tap(); });
  toggle('#tClack', 'clack', (v) => { if (v) ctl.clack('down'); });

  root.querySelector('#bUpd').addEventListener('click', checkForUpdate);
}

/**
 * Asks the service worker to go and look for a new build right now.
 *
 * If it finds one, app.js is already listening: the worker takes over and the
 * page reloads itself. All this has to do is say what is happening, because
 * the alternative — a button that looks like it did nothing — is exactly the
 * doubt this row exists to settle.
 */
async function checkForUpdate() {
  const out = el().querySelector('#oUpd');
  const btn = el().querySelector('#bUpd');
  if (!out || !btn) return;

  const say = (msg) => { out.textContent = msg; };
  btn.disabled = true;
  say('Procurando…');

  try {
    if (!('serviceWorker' in navigator)) {
      location.reload();
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { location.reload(); return; }

    await reg.update();
    // update() resolves as soon as the new worker starts installing, so give
    // it a moment to get far enough to announce itself before declaring
    // victory or defeat.
    await new Promise((r) => setTimeout(r, 1200));
    if (reg.installing || reg.waiting) say('Versão nova encontrada — atualizando…');
    else say('Você já está na versão mais recente.');
  } catch {
    say('Não deu para verificar agora — verifique a conexão.');
  } finally {
    btn.disabled = false;
  }
}

/** The tab bar markup, built once from the tab list. */
export function tabBarHTML() {
  return TABS.map((t, i) => `
    <button data-tab="${t.id}" role="tab" type="button"
            aria-selected="${i === 0}"${i === 0 ? ' class="is-on"' : ''}>${t.label}</button>`).join('');
}
