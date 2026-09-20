/**
 * sw.js — cache offline do SireFlex.
 *
 * O app inteiro são alguns arquivos de texto e quatro PNGs, então tudo é
 * guardado na instalação: depois disso o simulador funciona sem rede, que é o
 * ponto — um app de sirene não serve de nada se só toca onde tem sinal.
 *
 * A estratégia NÃO é cache-first, e isso é deliberado. Cache-first respondia
 * com a cópia guardada em toda visita e só buscava a nova em segundo plano,
 * então uma versão recém-publicada só aparecia na abertura seguinte — e num
 * PWA instalado, que fica aberto por dias, podia demorar muito mais. Quem
 * testou no telefone viu a versão antiga e concluiu, com razão, que nada havia
 * mudado.
 *
 * Agora:
 *   - o código do app (HTML, CSS, JS, manifest) é buscado na rede primeiro,
 *     com o cache HTTP do navegador ignorado e o cache local como rede de
 *     segurança se estiver offline ou se a rede demorar demais;
 *   - os ícones, que não mudam, continuam vindo do cache na hora.
 *
 * O custo é uma ida à rede por arquivo quando há sinal; o ganho é que uma
 * correção publicada agora está no telefone na próxima abertura, sempre.
 */

const BUILD = 'v8';                 // precisa casar com js/build.js
const VERSION = `sireflex-${BUILD}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/build.js',
  './js/platform.js',
  './js/audio/engine.js',
  './js/audio/voices.js',
  './js/audio/waves.js',
  './js/audio/dsp.js',
  './js/audio/render.js',
  './js/audio/tones.js',
  './js/ui/strobe.js',
  './js/ui/guide.js',
  './js/ui/diagrams.js',
  './js/ui/sheets.js',
  './js/ui/waveicons.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/** Quanto se espera pela rede antes de usar a cópia local. */
const NET_TIMEOUT_MS = 3500;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll é tudo-ou-nada, então um arquivo faltando deixaria o app sem
      // cache nenhum. Cada um entra por conta própria.
      //
      // cache: 'reload' passa por cima do cache HTTP. Sem isso uma build nova
      // pode ser "instalada" a partir de uma entrada velha do navegador, e a
      // correção que a pessoa está esperando nunca chega de fato.
      .then((c) => Promise.all(
        SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));

    // Nada de navigation preload, por mais tentador que seja o ganho de
    // latência. A requisição de pré-carga é montada pelo navegador, com as
    // regras de cache HTTP dele — ou seja, ela ignora o `cache: 'reload'`
    // abaixo e pode devolver alegremente a página de dez minutos atrás, que é
    // exatamente o defeito que este service worker existe para não cometer.
    // Se em algum momento ela tiver ficado ligada, desliga.
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

/** A página pergunta qual build está no ar, e manda atualizar na hora. */
self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source?.postMessage({ type: 'version', build: BUILD });
  if (e.data === 'skipWaiting') self.skipWaiting();
});

/** Ícones e imagens: imutáveis na prática, vêm do cache na hora. */
const isStatic = (url) => /\.(png|svg|jpg|webp|ico)$/i.test(url.pathname);

async function putInCache(req, res) {
  try {
    const c = await caches.open(VERSION);
    await c.put(req, res);
  } catch { /* cota cheia ou modo privado: o app continua funcionando */ }
}

/** Rede primeiro, com prazo; cache como rede de segurança. */
async function freshFirst(req) {
  const fromNet = (async () => {
    // cache: 'reload' não é detalhe: o Pages serve com `max-age=600`, e sem
    // isto o navegador devolve uma cópia de minutos atrás como se fosse nova
    // — a versão publicada agora continuaria invisível, só que por um cache
    // diferente daquele que causou o problema da primeira vez.
    const res = await fetch(req.url, { cache: 'reload', credentials: 'same-origin' });
    if (res && res.ok) putInCache(req, res.clone());
    return res;
  })();

  // Nada de esperar 30 s numa rede ruim com a cópia boa ali do lado.
  const deadline = new Promise((resolve) => setTimeout(() => resolve(null), NET_TIMEOUT_MS));

  try {
    const res = await Promise.race([fromNet, deadline]);
    if (res && res.ok) return res;
  } catch { /* offline */ }

  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;

  // Sem rede e sem cópia desta URL: qualquer navegação vira a página inicial,
  // que é o único destino que o app tem.
  if (req.mode === 'navigate') {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
  }
  return fromNet;
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) putInCache(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(isStatic(url) ? cacheFirst(req) : freshFirst(req));
});
