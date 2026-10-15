# Petro Radar BFF (FastAPI) — Versão On-Premise

Camada **BFF (Backend-for-Frontend)** em FastAPI da versão on-premise do Petro Radar.
Nasceu de uma migração no padrão **strangler-fig** (figueira-estranguladora) e o flip
final **já foi executado**: este serviço é o **dono canônico das rotas de API**
(`/api/*`) — bugfix/feature de API acontece **só aqui, em Python**; os `route.ts` do
Next são rollback congelado.

> **Quem manda no schema continua sendo o Node.** Este BFF é um inquilino do mesmo
> banco PostgreSQL; ele **lê e escreve**, mas **não cria nem altera** tabelas.
> Veja [`alembic-NOTA.md`](./alembic-NOTA.md) e a seção *ORM e migrations* abaixo.

---

## 1. Arquitetura em uma imagem

```
                         ┌──────────────────────────────────────────────┐
   Browser  ──HTTPS──►   │                   NGINX                       │
   (PWA)                 │  (reverse proxy / roteador do estrangulador)  │
                         └───────────────┬──────────────┬───────────────┘
                                         │              │
                  rotas ainda no Node    │              │   rotas já migradas
                  (location /api/...)    │              │   (location /bff/...)
                                         ▼              ▼
                         ┌───────────────────┐   ┌────────────────────────┐
                         │  Next.js 16        │   │  FastAPI BFF (este)    │
                         │  - NextAuth v5     │   │  - VALIDA o JWT        │
                         │  - EMISSOR do JWT  │   │  - SQLAlchemy 2 async  │
                         │  - Drizzle (schema)│   │  - python-jose / pyjwt │
                         └─────────┬─────────┘   └───────────┬────────────┘
                                   │                         │
                                   ▼                         ▼
                         ┌──────────────────────────────────────────────┐
                         │   PostgreSQL (+ pgvector)   •   Redis   •  S3  │
                         │   ── MESMO banco para ambos os serviços ──     │
                         └──────────────────────────────────────────────┘
```

- O **NGINX** decide, por `location` (prefixo de path), quem atende: o que já foi
  estrangulado vai para o FastAPI (`/bff/<dominio>`), o resto segue no Next.

> **NOTA — estado do estrangulador (flip final):** além dos 2
> routers "Onda 0" (`/bff/licitacoes`, `/bff/acervo/buscar`), o BFF serve as
> **demais rotas** do inventário via módulos em `app/routers/migrated/`, respondendo
> nos paths `/api/*` originais, e o NGINX (`nginx/strangler/routes.conf`) manda
> **todo `/api/` para o BFF** com exceções (auth + 3 rotas xlsx + crons). Decisões:
> 1. **Rotas Onda 0 duplicadas**: `/bff/licitacoes` e `/bff/acervo/buscar` são
>    MANTIDAS como rota de diagnóstico/contrato (smoke.sh e test_bff.py as usam)
>    e agora têm o MESMO rate-limit da versão migrada.
> 2. **Routers `cron_*.py`**: são o **alvo do flip `CRON_TARGET`**.
>    O worker dispara `GET {alvo}/api/cron/<nome>`; com `CRON_TARGET=web`
>    (default atual) a lógica executa no Next (`http://web:3000`); com
>    `CRON_TARGET=bff` passam a executar AQUI (`http://bff:8000`, mesmos paths).
>    Rollback = voltar a env + recriar o worker. O NGINX pode continuar mandando
>    `/api/cron/` ao Next (allowlist de IP) — o worker chama o alvo direto,
>    sem passar pelo NGINX.
> 3. **3 rotas XLSX**: os módulos Python equivalentes (`relatorios_executivo`,
>    `conf_import_template_familias`, `licitacoes_id_pacote_orcamento`) foram
>    **REMOVIDOS do BFF** — eram código morto: o NGINX serve essas
>    rotas pelo Next em caráter permanente (bytes `exceljs` ≠ `openpyxl`). A
>    coleta/render do relatório executivo sobrevive só como lib interna
>    (`migrated/_relatorio_executivo_lib.py`) para o cron `relatorio-mensal`.
- O **Next.js** continua sendo o **emissor** da sessão/JWT (NextAuth v5). O login
  **não migra agora**.
- O **FastAPI** apenas **valida** o token e fala com o banco/redis/S3.

---

## 2. Pré-requisitos

- Python 3.11+
- PostgreSQL 15+ com a extensão `pgvector` instalada (`CREATE EXTENSION vector;` —
  já criada do lado Node, pela tabela `acervo_chunks` que usa `vector(1536)`).
- Redis 7+
- Endpoint S3-compatível (MinIO on-prem ou Cloudflare R2 na nuvem).
- O **mesmo** `DATABASE_URL` que o container Node usa (mesmo banco, mesmas tabelas).

---

## 3. Variáveis de ambiente (`.env`)

O objeto `settings` em `app/core/config.py` (pydantic-settings) lê de `.env`.
Mínimo para subir:

```dotenv
# ── Banco (MESMA string do Node; convertida internamente p/ postgresql+asyncpg://) ──
DATABASE_URL=postgresql://petro:senha@localhost:5432/petro_radar

# ── Contrato JWT (ver seção 5) ──
# DEVE ser idêntico ao AUTH_SECRET / NEXTAUTH_SECRET do container Next.js.
AUTH_SECRET=<o-mesmo-secret-do-nextauth>
# NEXTAUTH_SECRET=...   # fallback aceito por config.py

# ── Redis ──
REDIS_URL=redis://localhost:6379/0

# ── IA (Anthropic) ──
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_SONNET=claude-sonnet-...
ANTHROPIC_MODEL_HAIKU=claude-haiku-...

# ── Embeddings (Voyage ou OpenAI) ──
EMBEDDING_PROVIDER=voyage          # voyage | openai
VOYAGE_API_KEY=...
OPENAI_API_KEY=...
EMBEDDING_MODEL=voyage-3
EMBEDDING_DIMENSOES=1536           # casa com acervo_chunks vector(1536)

# ── Storage S3 / R2 / MinIO ──
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=petro-radar

# ── CORS interno ──
CORS_ORIGINS=http://localhost:3000,https://petro-radar.example.local

# ── Secrets de automação (replicados do Node — ver MIGRACAO-ROTAS-ONDAS.md, Onda 4) ──
CRON_SECRET=<o-mesmo-CRON_SECRET-do-Node>
GITHUB_SYNC_TOKEN=<PAT-para-/bff/sync>
```

> **`EMBEDDING_DIMENSOES` é contrato físico**, não preferência: a coluna
> `acervo_chunks.embedding` é `vector(1536)`. Mudar esse número quebra inserts.

---

## 4. Rodando localmente

```bash
# 1. ambiente virtual + dependências
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # fastapi, uvicorn, sqlalchemy[asyncio], asyncpg,
                                   # pgvector, pydantic-settings, python-jose|pyjwt,
                                   # redis, boto3

# 2. variáveis
cp .env.example .env   # e edite

# 3. subir o servidor (reload em dev)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Healthcheck

`GET /bff/health` checa **db** (SELECT 1) e **redis** (PING). É a sonda do NGINX/Docker:

```bash
curl -s http://localhost:8000/bff/health | jq
# { "status": "ok", "db": "ok", "redis": "ok", "version": "...", "request_id": "..." }
```

Qualquer dependência fora retorna **503** (NGINX para de rotear para a instância).

### Docs interativas

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

Todas as rotas de negócio ficam sob o prefixo **`/bff`** (ex.: `/bff/resultados`).
O NGINX é quem mapeia `/bff/<dominio>` → FastAPI (ver `MIGRACAO-ROTAS-ONDAS.md`).

---

## 5. Contrato JWT — NextAuth (Next.js) → FastAPI

Esta é a **fronteira de confiança** entre os dois serviços. Decisões já travadas:

### 5.1. Quem emite vs quem valida

| Papel | Serviço | O que faz |
|-------|---------|-----------|
| **Emissor** | Next.js / NextAuth v5 | Faz o login, emite o token de sessão, gere refresh. |
| **Validador** | FastAPI (este BFF) | Só **lê e valida** o token. Nunca emite, nunca faz login. |

O login **permanece no Next** — `/api/auth*` é exceção permanente do estrangulador
enquanto o NextAuth for o emissor. O FastAPI confia no token que o browser já carrega.

### 5.2. Formato do token — **JWE real do NextAuth v5**

> O **NextAuth/Auth.js v5 emite, por padrão, JWE** (token *criptografado*, 5
> segmentos) — não um JWS assinado. Um JWE não pode ser apenas "decodificado"
> com o secret: a chave de cifragem é **derivada** do `AUTH_SECRET` via HKDF.
>
> **O que vale hoje:** `app/core/security.py` valida o **JWE REAL**, em modo duplo:
>
> 1. **Token com 5 segmentos (JWE — o token real de produção):** decripta no
>    padrão Auth.js v5 — chave derivada por **HKDF-SHA256** (`ikm` = `AUTH_SECRET`,
>    `salt` = nome do cookie de sessão, `info` = string do Auth.js com sufixo
>    `(<salt>)`), `enc = A256CBC-HS512` (chave de 64 bytes, default do v5).
>    Compat legado: se o cabeçalho do JWE indicar `A256GCM` (v4), deriva 32 bytes
>    com o `info` sem sufixo.
> 2. **Token com 3 segmentos (JWS HS256 — fallback):** mantém a validação
>    `PyJWT`/HS256 usada por testes e clientes internos.
>
> Consequência prática: **nenhuma reconfiguração do NextAuth é necessária** — o
> plano antigo de forçar o Next a emitir JWS HS256 (versões anteriores deste
> README) foi descartado; o BFF acompanha o formato nativo do emissor. O único
> contrato é o **mesmo `AUTH_SECRET`** nos dois containers.

### 5.3. Claims esperadas

```json
{
  "sub":   "id-do-usuario",          // → CurrentUser.id
  "email": "fulano@example.com",    // → CurrentUser.email
  "role":  "ORCAMENTISTA",           // → CurrentUser.role (um dos papéis abaixo)
  "exp":   1750000000                // validado; 401 se expirado
}
```

`get_current_user` (em `app/core/security.py`):
1. extrai o token do header `Authorization: Bearer <jwt>` **ou** do cookie de sessão;
2. decripta o JWE (HKDF + A256CBC-HS512) ou, se for JWS, valida HS256 — sempre com
   `settings.auth_secret` — e checa `exp`;
3. devolve um `CurrentUser(id, email, role)`;
4. retorna **401** se ausente/inválido/expirado.

`require_role(*roles)` é uma factory que devolve uma dependency e retorna **403** se
o papel do usuário não estiver na lista (ou na hierarquia que o domina).

### 5.4. Papéis e hierarquia (espelha `src/lib/permissions.ts` do Node)

> **DISCREPÂNCIA COM O BRIEFING — resolvida a favor do código de produção.**
> O briefing listava `ADMIN, LIDER, ORCAMENTISTA, TECNICO, VISUALIZADOR, EXTERNO`.
> O código real (`src/lib/permissions.ts`) tem **7** papéis: inclui **`SGI`**
> (Sistema de Gestão Integrada — dono do domínio Conformidade) e **não** usa um
> papel "TECNICO" diferente. `security.py` **deve** replicar os 7 papéis reais:

| Papel | Descrição (do permissions.ts) |
|-------|-------------------------------|
| `ADMIN` | Acesso total. Gerencia usuários, config e todos os módulos. |
| `LIDER` | Aprova licitações, designa equipe, métricas, sync. |
| `ORCAMENTISTA` | Elabora propostas, sobe DFP/PPU, registra valores. |
| `TECNICO` | Participa da elaboração técnica, propõe participações. |
| `SGI` | **Conformidade** (Famílias CRC, Cofre, Envelopes, Contratos). |
| `VISUALIZADOR` | Somente leitura. Padrão de novos usuários. |
| `EXTERNO` | Colaborador externo, acesso muito restrito (uso futuro). |

Grupos de permissão a replicar como helpers em `security.py` (mesma semântica do Node):

| Grupo (Node) | Papéis | Uso típico |
|--------------|--------|-----------|
| `ROLES_ADMIN` | ADMIN | admin total |
| `ROLES_GESTAO` | ADMIN, LIDER | sync, reclassify, métricas, aprovar envelope/petitório |
| `ROLES_PROPOR` / `ROLES_ELABORAR` | ADMIN, LIDER, ORCAMENTISTA, TECNICO | propor/editar participações e petitórios |
| `ROLES_VISUALIZAR` | todos **exceto** EXTERNO | leitura geral |
| `ROLES_CONFORMIDADE` | ADMIN, LIDER, SGI | domínio Conformidade |

Replique também os predicados finos quando portar cada domínio, ex.:
`podeGerenciarDocumentosHabilitacao` = Conformidade **+** ORCAMENTISTA **+** TECNICO;
`podeSubstituirDocumento` = Conformidade **+** ORCAMENTISTA; exclusões de família/doc
= **somente ADMIN**. (Ver tabela completa no `permissions.ts`.)

---

## 6. ORM e migrations — por que **Drizzle continua dono**, sem Alembic aqui

Decisão arquitetural travada (resumo; detalhes em [`alembic-NOTA.md`](./alembic-NOTA.md)):

- **Drizzle (Node) é a única fonte de verdade do schema.** Toda criação/alteração de
  tabela, coluna, índice e migration acontece via `drizzle-kit` no lado Node.
- **FastAPI usa SQLAlchemy somente para ler/escrever dados** nas tabelas **que já
  existem**. Os modelos SQLAlchemy são *reflexos* (introspecção / mapeamento manual)
  do schema do Drizzle — eles **descrevem**, não **definem**.
- **NÃO criamos Alembic neste serviço.** Dois geradores de migration sobre o mesmo
  banco = **drift garantido**: ordem de aplicação ambígua, tabelas duplicadas,
  divergência de tipos (ex.: `vector(1536)` que o Alembic não conhece nativamente),
  e o risco real de um `alembic upgrade` reescrever algo que o Drizzle administra.
- **Regra de ouro:** se a estrutura precisa mudar, muda no Drizzle; o FastAPI só
  atualiza seu mapeamento SQLAlchemy depois. Migration de schema rodando do BFF é
  **proibida**.

Isso mantém os dois serviços consistentes durante todo o período em que ambos
coexistem sobre o mesmo PostgreSQL (a essência do strangler-fig).

---

## 7. Estrutura de pastas

```
bff/
├── README.md                  ← este arquivo
├── MIGRACAO-ROTAS-ONDAS.md    ← plano (histórico) da migração das rotas em ondas
├── alembic-NOTA.md            ← por que não há Alembic; como o schema é aplicado
└── app/
    ├── main.py                ← FastAPI(title="Petro Radar BFF"), CORS, /health, routers
    ├── core/
    │   ├── config.py          ← settings (pydantic-settings)
    │   └── security.py        ← CurrentUser, get_current_user, require_role
    ├── db/
    │   └── session.py         ← engine async + asyncpg, get_db(), pgvector
    ├── routers/               ← um router por domínio (montado em /bff/<dominio>)
    ├── services/              ← regra de negócio / integrações (IA, S3, redis)
    └── schemas/               ← modelos Pydantic de request/response
```

---

## 8. Documentos relacionados

- [`MIGRACAO-ROTAS-ONDAS.md`](./MIGRACAO-ROTAS-ONDAS.md) — plano histórico das rotas por
  domínio, ordem em 5 ondas, rollback e roteamento NGINX.
- [`alembic-NOTA.md`](./alembic-NOTA.md) — schema via `drizzle-kit`, introspecção
  SQLAlchemy, e por que Alembic fica de fora.
