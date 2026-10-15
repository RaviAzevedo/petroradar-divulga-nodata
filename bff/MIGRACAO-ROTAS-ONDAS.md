# Migração das Rotas em Ondas (Strangler-Fig)

Plano de estrangulamento do Petro Radar: mover, **domínio por domínio e por risco
crescente**, as rotas de `/api/*` (Next.js) para `/bff/*` (FastAPI), com o
**NGINX como chave de roteamento** e **login mantido no Next até o fim**.

- **Inventário total:** 88 rotas. Métodos agregados: **64 GET, 35 POST, 15 DELETE,
  10 PATCH, 1 PUT**. Todas as rotas Node rodam em `runtime = "nodejs"`.
- **Princípio:** começamos pelas rotas de **leitura isolada** (sem efeito colateral,
  fáceis de comparar lado a lado) e terminamos nas **escritas críticas, uploads e
  autenticação**.
- **Sem big-bang:** a cada onda, um punhado de `location` migra no NGINX; o resto
  continua no Next. Rollback é trocar o `proxy_pass` de volta.

---

## 0. Como o NGINX roteia (mecânica do estrangulador)

O NGINX é o único endereço que o browser conhece. Ele decide, por **prefixo de
path**, se a requisição vai para o Next (`upstream next`) ou para o FastAPI
(`upstream bff`).

```nginx
upstream next { server next:3000; }
upstream bff  { server bff:8000;  }

server {
  # ── Default: tudo ainda é do Node ──
  location /api/ {
    proxy_pass http://next;
  }

  # ── Rota migrada: reescreve /api/<dominio>/... → /bff/<dominio>/... ──
  # (exemplo: Onda 1, domínio resultados — leitura isolada)
  location /api/resultados/ {
    rewrite ^/api/(.*)$ /bff/$1 break;   # /api/resultados/x → /bff/resultados/x
    proxy_pass http://bff;
    proxy_set_header Authorization $http_authorization;  # repassa o Bearer
    proxy_set_header Cookie        $http_cookie;          # repassa o cookie de sessão
    proxy_set_header X-Request-ID  $request_id;
  }
}
```

Pontos-chave:
- O **client (PWA) não muda**: continua chamando `/api/resultados`. Quem reescreve
  para `/bff/...` é o NGINX. Isso evita mexer no front a cada onda.
- O **header `Authorization` e o `Cookie` são repassados** intactos — o FastAPI
  valida o **mesmo** JWT que o NextAuth emitiu (ver README §5).
- Migrar = adicionar/editar **um `location`**. Reverter = remover esse `location`
  (volta a cair no `location /api/` genérico → Next). `nginx -t && nginx -s reload`,
  zero downtime.
- **Healthcheck do upstream bff** (`GET /health`, 503 se db/redis fora) tira a
  instância do balanceamento automaticamente.

---

## 1. Inventário por domínio (prioridade · risco · onda)

> Risco = combinação de **efeito colateral** (escreve? envia e-mail/push? toca S3?),
> **acoplamento** (JWE/auth, secrets, GitHub) e **criticidade** (prazos legais).

| # | Domínio | Rotas | Métodos | Natureza | Prioridade | Risco | Onda |
|--:|---------|------:|---------|----------|-----------|-------|-----:|
| 1 | `resultados` | 4 | 4 GET · 1 POST | Leitura de resultados/eventos de licitação | Alta | **Baixo** | **1** |
| 2 | `relatorios` | 1 | 1 GET | Relatório executivo (leitura agregada) | Média | **Baixo** | **1** |
| 3 | `acervo` | 1 | 1 POST | `/acervo/buscar` — busca semântica (pgvector) | Alta | Baixo-Médio | **1** |
| 4 | `conformidade` | 20 | 14 GET · 11 POST · 7 DELETE · 3 PATCH | Cofre, Famílias CRC, import, downloads | Alta | Médio (leit.) / Alto (escr./S3) | **2** (GET) / 5 (escritas) |
| 5 | `participacoes` | 16 | 10 GET · 5 POST · 5 PATCH · 3 DELETE | Pipeline de participação, fases, docs | Alta | Médio (leit.) / Alto (escr./lock) | **3** (GET) / 5 (escritas) |
| 6 | `licitacoes` | 18 | 15 GET · 7 POST · 2 DELETE · 1 PATCH | Núcleo: licitações, análise IA, petitórios | Crítica | Médio (leit.) / **Alto** (petitórios) | **3** (GET) / 5 (escritas) |
| 7 | `cron` | 12 | 12 GET · 1 POST | Jobs agendados (CRON_SECRET) | Alta | **Alto** (efeito colateral em lote) | **4** |
| 8 | `petronect-v2` | 2 | 1 GET · 2 POST | Webhooks de eventos/winner-changed (CRON_SECRET) | Alta | **Alto** (webhook) | **4** |
| 9 | `sync` | 1 | 1 POST | Dispara GitHub Actions (GITHUB_SYNC_TOKEN) | Média | **Alto** (integração externa) | **4** |
| 10 | `push` | 2 | 1 GET · 1 POST · 1 DELETE | Web Push (subscribe / vapid key) | Baixa | Médio | **4** |
| 11 | `perfis` | 3 | 1 GET · 2 POST · 1 PUT · 1 DELETE | Perfis de busca/alerta | Média | Médio (escrita) | **5** |
| 12 | `admin` | 5 | 4 GET · 2 POST · 1 PATCH · 1 DELETE | Users, audit-log, saúde-scraper, webhooks | Alta | **Alto** (admin/users) | **5** |
| 13 | `users` | 1 | 1 GET | Listagem de usuários | Baixa | Médio (PII) | **5** |
| 14 | `auth` | 2 | 1 POST (+ `[...nextauth]`) | **Login / NextAuth** | — | **Crítico** | **NUNCA / por último** |

**Soma:** 4+1+1+20+16+18+12+2+1+2+3+5+1+2 = **88 rotas**. ✔

> Domínios que se dividem entre ondas (ex.: `conformidade`, `participacoes`,
> `licitacoes`) migram em **dois `location` distintos** — primeiro
> os GET de leitura, depois as escritas. No NGINX isso é feito casando o **método**
> (`if ($request_method = GET)`) ou, preferencialmente, separando por **sub-path**
> quando o desenho de URL permitir. Onde não houver separação limpa de URL, o domínio
> inteiro espera a onda da escrita.

---

## 2. Back-compat: rewrites do `next.config.ts` a replicar

O Next mantém rewrites que preservam **CLIs, tokens e scripts antigos**. Ao migrar
o domínio de destino, **o BFF (ou o NGINX) precisa replicar esses aliases**, senão
integrações legadas quebram. Tratar cada um como item de checklist da onda:

| Alias antigo (`/api/...`) | Destino real (`/api/...`) | Onda em que o alias deve passar a apontar p/ `/bff` |
|---------------------------|---------------------------|------|
| `/api/habilitacao/documentos[/*]` | `/api/conformidade/cofre/documentos[/*]` | Onda 2/5 (conformidade) |
| `/api/familias[/*]` | `/api/conformidade/familias[/*]` | Onda 2/5 (conformidade) |
| `/api/import[/*]` | `/api/conformidade/import[/*]` | Onda 5 (escrita) |
| `/api/search` | `/api/licitacoes/search` | Onda 3 (licitações GET) |
| `/api/reclassify` | `/api/licitacoes/reclassify` | Onda 5 (escrita/gestão) |
| `/api/audit-log` | `/api/admin/audit-log` | Onda 5 (admin) |

> **Regra:** o destino canônico migra **primeiro**; o alias só passa a apontar para
> `/bff` **depois** que o destino já está estável no FastAPI. Enquanto o destino
> estiver no Next, o alias **também** fica no Next (o rewrite original do
> `next.config.ts` continua valendo). Quando um alias mudar o **shape do JSON**,
> ao replicar no BFF manter exatamente o shape novo (o do destino), nunca o legado.
>
> **Os `redirects()` permanentes** do `next.config.ts` (ex.: `/habilitacao →
> /acervo/cofre`, `/conformidade/:path* → /acervo/:path*`, `/licitacao/:id →
> /licitacoes/:id`) são **de páginas, não de API** — ficam no Next e **não** migram.

---

## 3. As 5 ondas

Cada onda tem o mesmo gabarito: **escopo · critério de pronto (Definition of Done) ·
rollback · roteamento NGINX**.

### Onda 1 — Leitura isolada (sem efeito colateral)

- **Escopo:** `resultados` (4), `relatorios` (1 GET), `acervo/buscar` (1 POST —
  busca read-only via pgvector).
- **Por quê primeiro:** zero escrita, fácil de validar comparando o JSON do Next com
  o do BFF byte a byte; exercita já o caminho completo (JWT → SQLAlchemy → pgvector →
  Anthropic/Voyage read).
- **Critério de pronto:**
  - Para cada rota, resposta do BFF **idêntica** (mesmo schema/valores) à do Next
    em uma bateria de queries reais (shadow-compare).
  - `require_role` aplicado conforme `ROLES_VISUALIZAR` (todos exceto EXTERNO).
  - p95 de latência ≤ o do Next; `/health` verde sob carga.
  - Erros (401/403/404/422) com o mesmo contrato.
- **Rollback:** remover os `location` da onda no NGINX → tudo volta ao Next. Sem
  migração de dados envolvida, rollback é instantâneo e sem perda.
- **NGINX:** novos `location /api/resultados/`, `/api/relatorios/`, `/api/acervo/`.
  Quando um domínio se divide por método (GET → bff; escrita → next até a onda 5):
  ```nginx
  location /api/<dominio>/ {
    set $target next;
    if ($request_method = GET) { set $target bff; }
    rewrite ^/api/(.*)$ /bff/$1 break;
    proxy_pass http://$target;
  }
  ```

### Onda 2 — Conformidade (leitura) + Famílias (leitura)

- **Escopo:** os **GET** de `conformidade` (14): cofre/documentos (listagem,
  detalhe, famílias/projetos do doc), famílias CRC (listagem/detalhe/anexos/match),
  `licitacoes-elegiveis`. **Sem** uploads, deletes, downloads de binário ainda.
- **Critério de pronto:**
  - Leitura paginada e filtros idênticos ao Next.
  - `require_role` conforme `ROLES_CONFORMIDADE` (ADMIN/LIDER/SGI) e os predicados
    de visualização de cofre/família — **replicar exatamente** `permissions.ts`.
  - Match de famílias por licitação (`familias/match/[licitacaoId]`) confere com o
    Node em casos de regressão conhecidos.
- **Rollback:** remover os `location` GET de conformidade. As escritas nunca saíram
  do Next nesta onda, então não há estado divergente.
- **NGINX:** `location /api/conformidade/` com split por método (GET→bff, restante→
  next). Replicar aliases `/api/familias` e `/api/habilitacao/documentos` **somente
  para os verbos GET**.

### Onda 3 — Participações (leitura) + Licitações (leitura)

- **Escopo:** os **GET** de `participacoes` (10: listagem, detalhe, histórico,
  benchmark, notificações…) e os **GET** de `licitacoes` (15: listagem, detalhe,
  análise, checklist, circulares, gap-habilitação, go-no-go, pacote-orçamento,
  previsão-winrate, downloads, export, **search**, **petitórios GET**). Replicar o
  alias `/api/search → /api/licitacoes/search`.
- **Por quê depois de conformidade:** estas leituras já dependem de joins com
  conformidade (gap-habilitação cruza famílias/cofre) — migrar leitura de
  conformidade antes reduz acoplamento cruzado entre serviços.
- **Critério de pronto:**
  - Análises de IA somente-leitura (go-no-go, previsão-winrate, análise) servidas do
    cache/registro existente, **sem regravar** (escrita fica na Onda 5).
  - `ROLES_VISUALIZAR` para leitura; `podeVerPetitorios` (= visualizar) para os GET
    de petitórios.
  - Exports (CSV/XLSX) idênticos.
- **Rollback:** remover os `location` GET; nenhuma escrita migrou.
- **NGINX:** `location /api/participacoes/` e `/api/licitacoes/` com split por método
  (GET→bff). Atenção a rotas profundas com `[id]` e `[petitorioId]`.

### Onda 4 — Crons (CRON_SECRET) e Webhooks

- **Escopo:** `cron` (12 jobs: prazos, vencimentos, oportunidades-novas,
  triagem-semantica, digest-executivo, relatorio-mensal, sync-monitor,
  saude-contratos, convocacao-watch, circulares-watch, cnpj-watch, acervo-index),
  `petronect-v2` (eventos + notify-winner-changed — webhooks), `sync` (dispara GitHub
  Actions), `push` (subscribe + vapid).
- **Por quê só agora:** têm **efeito colateral em lote** (e-mail, push, escrita de
  monitoramento, disparo de pipeline externo) e dependem de **secrets** que precisam
  ser replicados no BFF: `CRON_SECRET` (autenticação `Authorization: Bearer
  ${CRON_SECRET}` — **mesmo segredo do Node**), `GITHUB_SYNC_TOKEN` (rota `sync`).
- **Critério de pronto:**
  - Autenticação por `CRON_SECRET` no BFF **idêntica** ao Node (header
    `Authorization: Bearer <CRON_SECRET>`, 401 se diferente, 500 se não configurado).
    Esses endpoints **não** usam o JWT de usuário — usam o segredo de máquina.
  - **Idempotência verificada:** rodar o job via Next e via BFF não pode duplicar
    e-mails/registros. Antes do cutover, rodar em **modo dry-run/shadow** comparando
    o que *seria* feito.
  - Webhooks `petronect-v2` respondem o mesmo corpo/status ao produtor de eventos.
  - O agendador (cron externo / GitHub Actions schedule) aponta para
    **uma** origem de cada job por vez — **nunca os dois** simultaneamente (risco de
    duplicação).
- **Rollback:** reapontar o **agendador** de volta para `/api/cron/...` (Next) e
  remover os `location` no NGINX. Como o agendador é a fonte da chamada, o rollback é
  no scheduler **e** no NGINX, em conjunto.
- **NGINX:** `location /api/cron/`, `/api/petronect-v2/`, `/api/sync/`, `/api/push/`
  → bff. Manter o header `Authorization` (que aqui carrega o `CRON_SECRET`, não o JWT
  de usuário). Webhooks externos podem precisar de allowlist de IP de origem.

### Onda 5 — Escritas críticas, uploads e admin (e só então, auth)

- **Escopo (tudo que sobrou):**
  - **Escritas** de `conformidade` (POST/PATCH/DELETE: subir/substituir/excluir doc
    do cofre, anexos, bulk-download, import de famílias, scan, token, template).
  - **Escritas** de `participacoes` (criar/editar participação, fase, lock,
    resultado, extensão, documentos + download de binário, marcar notificações).
  - **Escritas** de `licitacoes` (análise/reclassify/go-no-go que **gravam**,
    petitórios POST/PATCH/DELETE + anexo + minuta, anexos-batch).
  - `perfis` (3), `admin` (5: users CRUD, audit-log, saúde-scraper, webhooks),
    `users` (1).
  - Replicar aliases de escrita: `/api/import[/*]`, `/api/reclassify`,
    `/api/audit-log`.
- **Por quê por último:** **lock otimista/pessimista** (`participacoes/[id]/lock`),
  **prazos legais fatais** (petitórios — Lei 13.303), **uploads para S3**, e
  **operações de admin sobre usuários** (PII) são as de maior blast-radius. Exigem o
  contrato de permissões fino já 100% replicado (ver README §5.4) e o caminho de S3
  do BFF endurecido.
- **Critério de pronto:**
  - Permissões finas idênticas: `podeGerenciarDocumentosHabilitacao`,
    `podeSubstituirDocumento`, `podeAprovarEnvelope`, `podeProtocolarPetitorio`,
    `podeExcluir*` (= ADMIN) etc. — **testes por papel** para cada rota.
  - Upload/download S3 com as **mesmas chaves e bucket** e o mesmo proxy autenticado
    (browser nunca toca S3 direto — CSP do Next já bloqueia).
  - Locks e transações com a mesma semântica; nenhum write-write conflict novo.
  - Auditoria (`admin/audit-log`) registra a ação do BFF igual ao Node.
  - **Migração de schema:** nenhuma. Se uma rota exigir nova coluna, ela entra
    **pelo Drizzle** antes (ver `alembic-NOTA.md`).
- **Rollback:** por ser escrita, rollback é mais delicado: remover o `location` no
  NGINX devolve o tráfego ao Next, mas **dados já gravados pelo BFF permanecem** (o
  banco é o mesmo — isso é uma vantagem: não há divergência de estado, só de código).
  Recomenda-se **canary por rota** (feature-flag no NGINX por sub-path) antes do
  cutover total.
- **NGINX:** completar o split de método dos domínios já parcialmente migrados
  (POST/PATCH/DELETE → bff) e adicionar `location` para `perfis`, `admin`, `users`.

#### Auth — fora das 5 ondas (último de todos)

`auth/[...nextauth]` e `auth/setup` **permanecem no Next** durante toda a migração.
O NextAuth continua o **emissor** do JWT; o BFF apenas valida (README §5). Só depois
que **todos** os outros domínios estiverem estáveis no FastAPI por tempo suficiente é
que se avalia migrar o login — e isso é um **projeto à parte**, não uma onda deste
plano.

---

## 4. Checklist transversal (vale para toda onda)

- [ ] `require_role` da rota replica **exatamente** o predicado de `permissions.ts`
      (incluindo o papel **SGI**, ausente no briefing — ver README §5.4).
- [ ] Aliases de back-compat do `next.config.ts` que tocam o domínio foram tratados.
- [ ] Shadow-compare BFF × Next passou para as rotas da onda.
- [ ] `/health` verde; p95 ≤ baseline do Next.
- [ ] `location` NGINX testado (`nginx -t`) e com rollback documentado.
- [ ] Nenhuma migration de schema foi feita pelo BFF (Drizzle continua dono).
