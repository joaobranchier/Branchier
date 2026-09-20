/**
 * verify-update.mjs — prova que uma versão publicada chega ao aparelho.
 *
 * Este teste existe por causa de um defeito real: o service worker respondia
 * do cache em toda visita e só buscava a versão nova em segundo plano, então
 * quem abria o app no telefone depois de uma publicação via a versão antiga e
 * não tinha como saber por quê. Ler o código não pegou isso; só medir pega.
 *
 * O roteiro é o mesmo que uma pessoa vive:
 *   1. abre o app e o deixa instalar o service worker;
 *   2. uma versão nova é publicada;
 *   3. abre de novo — e tem de estar na nova, na primeira vez, não na segunda;
 *   4. fica sem rede — e o app tem de continuar abrindo.
 *
 * A cópia servida é um clone temporário do repositório, porque o passo 2
 * significa reescrever arquivos enquanto o navegador está de olho neles.
 *
 *   node tools/verify-update.mjs
 */

import {
  createReadStream, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import { BUILD } from '../js/build.js';

/** The version the test pretends to publish. Never a real one. */
const NEXT = 'v999-teste';

const PRESET = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = process.env.CHROME_PATH || (existsSync(PRESET) ? PRESET : undefined);
const PORT = Number(process.env.SW_PORT || 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${n.padEnd(46)} ${d}`);
};

/* ---------------------- a copy of the site to meddle with ---------------------- */

const dir = mkdtempSync(join(tmpdir(), 'sireflex-'));
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'icons']) {
  cpSync(join(ROOT, f), join(dir, f), { recursive: true });
}

/**
 * Um servidor próprio, e não `python3 -m http.server`, por um motivo só: o
 * cabeçalho. O GitHub Pages responde com `Cache-Control: max-age=600`, e é
 * justamente esse cabeçalho que dá ao navegador permissão para devolver a
 * página de dez minutos atrás como se fosse nova. Um teste servido sem ele
 * está medindo uma situação mais fácil do que a real — e foi assim que a
 * primeira versão deste teste passou aqui e falhou no CI, onde os tempos
 * calharam de cair dentro da janela em que o navegador se acha no direito de
 * reaproveitar a cópia.
 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('não existe'); return; }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'max-age=600',
  });
  createReadStream(file).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForServer = () => new Promise((resolve, reject) => {
  server.listen(PORT, '127.0.0.1', resolve);
  server.on('error', reject);
});

/** The first run opens a welcome sheet, which covers the side keys. */
async function dismissWelcome() {
  const b = p.locator('.btn[data-close]');
  if (await b.isVisible().catch(() => false)) {
    await b.click();
    await sleep(350);
  }
}

const edit = (rel, from, to) => {
  const path = join(dir, rel);
  const s = readFileSync(path, 'utf8');
  if (!s.includes(from)) throw new Error(`não achei ${JSON.stringify(from)} em ${rel}`);
  writeFileSync(path, s.replace(from, to));
};

/* ------------------------------- the run ------------------------------- */

await waitForServer();

const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

try {
  console.log('\n--- a new build reaches the phone ---');

  await p.goto(`${BASE}/index.html`);
  // localhost counts as a secure context, so the worker installs here exactly
  // as it does over https on Pages.
  await p.evaluate(() => navigator.serviceWorker.ready);
  for (let i = 0; i < 40 && !(await p.evaluate(() => !!navigator.serviceWorker.controller)); i++) {
    await sleep(250);
  }
  ok('the worker installs and takes control',
    await p.evaluate(() => !!navigator.serviceWorker.controller));
  await dismissWelcome();

  const before = (await p.locator('#hint').innerText()).trim();

  // Publish: the page text changes, and the build number with it.
  edit('index.html', 'Toque em qualquer botão para ligar o áudio', 'BUILD-NOVA-CHEGOU');
  edit('js/build.js', `export const BUILD = '${BUILD}'`, `export const BUILD = '${NEXT}'`);
  edit('sw.js', `const BUILD = '${BUILD}'`, `const BUILD = '${NEXT}'`);

  // The strategy, measured on its own, before any reload can paper over it.
  // The app is open and a build has just gone out; this is the worker being
  // asked for a file in exactly that state. Cache-first answers v6 here — and
  // that single answer is the whole defect, upstream of anything the page
  // does about it afterwards.
  const served = await p.evaluate(() =>
    fetch('./js/build.js', { cache: 'no-store' }).then((r) => r.text()).catch(() => 'erro'));
  const servedBuild = (served.match(/BUILD = '([^']+)'/) || [])[1];
  ok('the worker serves the published file, not the cached one', servedBuild === NEXT,
    `o worker devolveu ${servedBuild || '???'}`);

  // One reopen. Not two.
  //
  // The settling time is not padding: a build this page did not have arrives
  // while it is loading, the worker takes over, and the app reloads itself on
  // purpose. Reaching for an element before that lands finds it mid-swap.
  await p.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await sleep(2500);
  await p.waitForLoadState('load');
  const after = (await p.locator('#hint').innerText()).trim();
  ok('the new build shows up on the first reopen', after === 'BUILD-NOVA-CHEGOU',
    `${before} -> ${after}`);

  // And the module graph the page is actually running, not only the document:
  // a fresh index.html importing stale JS is the same bug wearing a different
  // hat. This reads the number off the screen, through the app's own code,
  // rather than importing the file separately — a separate import can be
  // served fresh while the page keeps running the old one.
  await dismissWelcome();
  await p.locator('#dockGuide').click();
  await p.waitForTimeout(300);
  await p.locator('[data-tab="set"]').click();
  await p.waitForTimeout(400);
  const shown = (await p.locator('.guide__body').innerText()).match(/SireFlex (v[\w.-]+)/);
  ok('the running modules are fresh too, not just the html', shown?.[1] === NEXT,
    `a tela diz ${shown?.[1] || 'nada'}`);
  await p.locator('.guide__close').click();

  console.log('\n--- and it still works with no network ---');

  await ctx.setOffline(true);
  await p.goto(`${BASE}/index.html`, { waitUntil: 'load' }).catch(() => {});
  await sleep(1500);
  ok('the faceplate still loads offline', await p.locator('#remote').isVisible());
  ok('the keys are there offline', (await p.locator('[data-tone]').count()) >= 5);
  await ctx.setOffline(false);

  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
  await b.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n\x1b[1m${pass}/${pass + fail} update checks passed\x1b[0m${fail ? `  \x1b[31m(${fail} failing)\x1b[0m` : ''}\n`);
process.exit(fail ? 1 : 0);
