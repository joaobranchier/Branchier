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

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

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

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: dir, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/index.html`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('o servidor de teste não subiu');
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

  const before = (await p.locator('#hint').innerText()).trim();

  // Publish: the page text changes, and the build number with it.
  edit('index.html', 'Toque em qualquer botão para ligar o áudio', 'BUILD-NOVA-CHEGOU');
  edit('js/build.js', "export const BUILD = 'v6'", "export const BUILD = 'v7'");
  edit('sw.js', "const BUILD = 'v6'", "const BUILD = 'v7'");

  // One reopen. Not two.
  await p.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await sleep(1200);
  const after = (await p.locator('#hint').innerText()).trim();
  ok('the new build shows up on the first reopen', after === 'BUILD-NOVA-CHEGOU',
    `${before} -> ${after}`);

  // And the module graph, not only the document: a fresh index.html importing
  // stale JS is the same bug wearing a different hat.
  await sleep(800);
  const build = await p.evaluate(() => import('./js/build.js').then((m) => m.BUILD).catch(() => 'erro'));
  ok('the modules are fresh too, not just the html', build === 'v7', `build.js diz ${build}`);

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
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n\x1b[1m${pass}/${pass + fail} update checks passed\x1b[0m${fail ? `  \x1b[31m(${fail} failing)\x1b[0m` : ''}\n`);
process.exit(fail ? 1 : 0);
