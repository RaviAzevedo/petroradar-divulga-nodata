# `nginx/` — Proxy reverso e o "galho" do estrangulador

O **NGINX vive no host** dos servidores da Proponente (fora do `docker-compose.yml`). Estes arquivos
são **a referência a copiar/incluir** nesse NGINX. Ele é o **roteador do estrangulador (strangler-fig)**:
decide, por `location`, o que vai para o `bff` (FastAPI) e o que vai para o `web` (Next.js).

## Arquivos

| Arquivo | Onde entra | Papel |
|---|---|---|
| `conf.d/petro-radar.conf` | `/etc/nginx/conf.d/` do host (produção, 443/TLS) | Server block real: termina TLS, HSTS, redirect 80→443, roteia `/bff/` e `/api/` → `bff`, resto → `web`, assets `/_next/static/` com cache, PWA (`/sw.js`, manifest). |
| `conf.d/petro-radar-dev.conf` | usado pelo `docker-compose.dev.yml` | NGINX de DEV (http, sem TLS) para testar o estrangulador no Mac via `http://localhost:8080`. |
| `strangler/routes.conf` | incluído pelos server blocks acima | **O flip final**: todo `/api/` → `bff`, exceto `/api/auth*` (NextAuth emite o token; o BFF só valida) e **3 rotas xlsx** (bytes `exceljs` ≠ `openpyxl` → ficam no Next). 142 pares (method, path) verificados por paridade + smoke. |
| `snippets/security-headers.conf` | incluído dentro do `server{}` | Só o que o app **não** faz no edge (oculta a versão do nginx). O CSP e os demais headers de segurança já vêm do `next.config` do app — não duplicar aqui. |

## Como migrar/reverter uma rota

Migrar = mover um prefixo de `location /api/...` (Next) para o `bff` no `strangler/routes.conf`;
reverter = apontar de volta e `nginx -s reload`. Um corte limpo, sem downtime.

> Timeouts de `/bff/` e `/api/` são altos (300s) de propósito: rotas de IA/RAG podem demorar.
