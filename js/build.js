/**
 * build.js — um número que diz qual versão está rodando.
 *
 * Existe para responder a uma pergunta que não tinha resposta: "o que está no
 * meu telefone é a versão nova?". A tela de Ajustes mostra este número, e o
 * service worker nomeia o cache com ele, então os dois sempre contam a mesma
 * história. tools/verify-audio.mjs falha se alguém mudar um e esquecer o outro.
 */

export const BUILD = 'v6';
export const BUILD_DATE = '20/09/2026';
