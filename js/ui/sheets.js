/**
 * sheets.js — the bottom sheets: first-run notice, settings, tone reference.
 */

import { TONES } from '../audio/tones.js';
import { PATTERN_LIST } from './strobe.js';
import { isIOS, isStandalone } from '../platform.js';

const el = document.getElementById('sheet');
const body = document.getElementById('sheetBody');
let ctl = null;

export function initSheets(controller) {
  ctl = controller;
  el.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) close();
  });
}

export function close() { el.hidden = true; body.innerHTML = ''; }
export const isOpen = () => !el.hidden;

function open(html, wire) {
  body.innerHTML = html;
  el.hidden = false;
  body.scrollTop = 0;
  wire?.(body);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------ first run ------------------------------ */

export function openWelcome() {
  const needsInstall = isIOS() && !isStandalone();
  open(`
    <h2>Siren Remote</h2>
    <p>Um controlador de sirene completo, com todos os tons <strong>sintetizados ao vivo</strong>
       no seu aparelho — nada de arquivos de áudio. Cada tom foi calibrado pelas
       especificações publicadas dos fabricantes: as faixas de frequência e as
       taxas de varredura são as de verdade, não aproximações de ouvido.</p>

    <div class="warn">
      <p><strong>Use com responsabilidade.</strong> Imitar sirene de viatura em via
         pública é infração — e, dependendo da situação, crime — na maior parte
         do mundo, Brasil incluído. Isto aqui é um simulador para uso pessoal,
         estudo e produção de áudio. Não use para se passar por autoridade nem
         para obrigar alguém a sair da frente.</p>
    </div>

    <div class="warn">
      <p><strong>Volume e audição.</strong> Ligado a uma caixa de som, esse material
         chega fácil a níveis que machucam. Comece baixo. E os botões
         <strong>LMB</strong> e <strong>LIGHT</strong> piscam forte — se você tem
         epilepsia fotossensível, deixe-os desligados.</p>
    </div>

    ${needsInstall ? `
    <h3>Instalar no iPhone</h3>
    <p>Para rodar em tela cheia, sem a barra do Safari e funcionando offline:</p>
    <p>1. Toque em <strong>Compartilhar</strong> (o quadrado com a seta para cima)<br>
       2. Role e escolha <strong>Adicionar à Tela de Início</strong><br>
       3. Toque em <strong>Adicionar</strong></p>
    <p><small>Depois disso é só abrir pelo ícone. Instalado, o app não precisa mais
       de internet.</small></p>` : ''}

    <button class="btn" data-close>Entendi, vamos lá</button>
    <p style="margin-top:14px"><small>Você pode reler isto a qualquer momento no botão lateral direito de baixo.</small></p>
  `);
}

/* ------------------------------ settings ------------------------------ */

export function openSettings() {
  const p = ctl.prefs;
  open(`
    <h2>Ajustes</h2>

    <h3>Áudio</h3>
    <div class="field">
      <label for="sVol">Volume principal</label>
      <input type="range" id="sVol" min="0" max="100" step="1" value="${Math.round(p.volume * 100)}">
      <output id="oVol">${Math.round(p.volume * 100)}%</output>
    </div>

    <h3>Sinalizador</h3>
    <div class="field">
      <label for="sPat">Padrão do giroflex</label>
      <select id="sPat" style="flex:1.2;padding:9px;border-radius:9px;background:#22282c;color:#dbe3e7;border:1px solid #2f363b;font-size:14px">
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
        <small>Enquanto a sirene toca. Sem isso o iPhone bloqueia e o som para.</small></div>
      <button class="toggle" id="tWake" aria-pressed="${p.wakeLock}" aria-label="Manter a tela acesa"></button>
    </div>
    <div class="switchrow">
      <div><span>Resposta tátil</span>
        <small>${ctl.haptics.supported ? 'Vibração curta a cada toque.' : 'Não disponível neste navegador.'}</small></div>
      <button class="toggle" id="tHap" aria-pressed="${p.haptics}" aria-label="Resposta tátil"${ctl.haptics.supported ? '' : ' disabled style="opacity:.4"'}></button>
    </div>
    <div class="switchrow">
      <div><span>AUTO troca a cada</span>
        <small>Tempo em cada tom no modo de varredura automática.</small></div>
      <select id="sAuto" style="flex:none;padding:8px 10px;border-radius:9px;background:#22282c;color:#dbe3e7;border:1px solid #2f363b;font-size:14px">
        ${[4, 6, 8, 12].map((s) => `<option value="${s}"${s === p.autoSecs ? ' selected' : ''}>${s}s</option>`).join('')}
      </select>
    </div>

    <button class="btn btn--ghost" id="bTones">Ver a referência dos tons</button>
    <button class="btn btn--ghost" id="bAbout">Sobre / avisos</button>
    <button class="btn" data-close>Fechar</button>
  `, (root) => {
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
      if (ctl.strobe.mode === 'bar') ctl.strobe.start('bar');
    });
    root.querySelector('#sAuto').addEventListener('change', (e) => {
      ctl.setPref('autoSecs', Number(e.target.value));
    });
    const toggle = (id, key, after) => {
      const b = root.querySelector(id);
      b.addEventListener('click', () => {
        const v = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(v));
        ctl.setPref(key, v);
        after?.(v);
      });
    };
    toggle('#tWake', 'wakeLock', (v) => { if (!v) ctl.screenLock.disable(); else if (ctl.active.size) ctl.screenLock.enable(); });
    toggle('#tHap', 'haptics', (v) => { ctl.haptics.enabled = v; if (v) ctl.haptics.tap(); });
    root.querySelector('#bTones').addEventListener('click', openTones);
    root.querySelector('#bAbout').addEventListener('click', openAbout);
  });
}

/* --------------------------- tone reference --------------------------- */

export function openTones() {
  const cards = Object.values(TONES).map((t) => `
    <div class="tone-card">
      <b>${esc(t.label)}</b> — ${esc(t.caption)}
      <span class="spec">${esc(t.spec)}</span>
      <p>${esc(t.blurb)}</p>
    </div>`).join('');

  open(`
    <h2>Os tons</h2>
    <p>Cada tom abaixo roda com os números publicados pelo fabricante. A linha
       laranja é a especificação de origem.</p>
    ${cards}
    <h3>De onde vêm os números</h3>
    <p><small>
      Federal Signal PA300 (modelos 690000/690001): varredura 725–1800 Hz;
      wail 15 cpm, yelp 220 cpm, hi-lo 70 cpm, priority 1300 cpm.
      PA300-012MSC: 700–1600 Hz.<br><br>
      DIN 14610 (Martinshorn, Europa): dois tons fixos a uma quarta justa,
      razão 1:1,33, dentro de 360–630 Hz; o Martin-Horn é afinado em lá/ré
      (440/585 Hz).<br><br>
      Sirene classe Rumbler: 182–400 Hz, tocada junto com a sirene aguda.<br><br>
      Buzinas de acorde Nathan AirChime: fundamentais entre ~311 Hz (ré♯) e
      415 Hz (sol♯), com harmônicos acima de 5 kHz.<br><br>
      Federal Signal Q2B: rotor de 14 portas, 123 dB a 3 m, fundamental
      variável com a rotação (≈400–800 Hz em regime), embreagem de roda-livre
      para a descida longa. A frequência sai de f = (rpm ÷ 60) × portas.
    </small></p>
    <button class="btn btn--ghost" id="bBack">Voltar aos ajustes</button>
    <button class="btn" data-close>Fechar</button>
  `, wireBack);
}

/** Sub-sheets replace the settings body, so they need a way back to it. */
function wireBack(root) {
  root.querySelector('#bBack')?.addEventListener('click', openSettings);
}

/* ------------------------------- about ------------------------------- */

export function openAbout() {
  open(`
    <h2>Sobre</h2>
    <p>Todo o som sai de osciladores da Web Audio API, gerados no momento em que
       você aperta o botão. Não há um único arquivo de áudio no projeto — é por
       isso que ele carrega instantaneamente, funciona offline e sustenta um tom
       por horas sem emenda audível.</p>

    <h3>Como os tons são feitos</h3>
    <p>As sirenes de varredura usam um oscilador de baixa frequência modulando a
       frequência de dois osciladores portadores afinados com alguns hertz de
       diferença — é essa diferença que produz o batimento de um par de
       alto-falantes reais. Depois tudo passa por uma simulação do próprio
       alto-falante de sirene: corte grave, realce em torno de 1,6 kHz e corte
       agudo, que é a resposta de um driver de compressão com corneta.</p>

    <h3>Os botões</h3>
    <p><strong>HIGH / BASS</strong> mudam essa equalização: HIGH deixa cortante e de
       longo alcance, BASS acrescenta corpo. <strong>MOD</strong> altera a
       velocidade de varredura do tom ativo. <strong>MIX</strong> permite empilhar
       tons em vez de trocá-los. <strong>AUTO</strong> varre wail → yelp → phaser
       sozinho. <strong>RUMBLE</strong> acrescenta a camada grave por baixo do que
       estiver tocando. <strong>AIR HORN</strong> e <strong>MANUAL</strong> são
       momentâneos: só soam enquanto o dedo está em cima. No MANUAL, o tom sobe
       enquanto você segura e desce sozinho quando solta.</p>

    <div class="warn">
      <p><strong>Aviso legal.</strong> Simulador para uso pessoal, estudo e produção
         de áudio. Usar para se passar por veículo de emergência ou autoridade é
         ilegal. A responsabilidade pelo uso é de quem usa.</p>
    </div>

    <p><small>Sem anúncios, sem rastreamento, sem rede. Nenhum dado sai do aparelho —
       os ajustes ficam no armazenamento local do próprio navegador.</small></p>
    <button class="btn btn--ghost" id="bBack">Voltar aos ajustes</button>
    <button class="btn" data-close>Fechar</button>
  `, wireBack);
}
