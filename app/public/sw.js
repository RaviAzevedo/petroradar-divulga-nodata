/*
 * Service Worker de DESPEDIDA do Petro Radar.
 *
 * Até 2026-09 este arquivo recebia Web Push (notificações do navegador). O push
 * nunca teve inscritos e saiu na limpeza geral, junto com o registro do SW no
 * layout. Navegadores que já registraram a versão antiga continuam buscando
 * /sw.js (o header no-cache de next.config.ts garante): esta versão assume o
 * controle e se DESREGISTRA, deixando o navegador limpo.
 *
 * Pode ser apagado (com o bloco /sw.js do next.config.ts e do NGINX) depois de
 * algumas semanas no ar.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});
