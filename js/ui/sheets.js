/**
 * sheets.js — the first-run notice.
 *
 * Everything else that used to live in a sheet (settings, the tone reference,
 * the about text) moved into the guide, so there is one place to look rather
 * than a sheet that opens another sheet.
 */

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
    <h2>SireFlex</h2>
    <p><strong>Sire</strong>ne + giro<strong>flex</strong>: um controlador completo, com todos
       os tons <strong>sintetizados ao vivo</strong>
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
    <button class="btn btn--ghost" id="bGuide">Abrir o guia dos tons</button>
    <p style="margin-top:14px"><small>O guia explica cada botão e cada sirene, com
       gráficos de como o som se comporta. Fica na barra embaixo do aparelho.</small></p>
  `);
}
