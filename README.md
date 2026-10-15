# Petro Radar

Plataforma para **monitorar, classificar e preparar a participação em licitações públicas do setor de
óleo e gás** (Petrobras / Transpetro), com um **acervo técnico** pesquisável por IA para provar
habilitação.

Roda inteira **on-premise**, em Docker Compose: Next.js 16 + FastAPI + PostgreSQL/pgvector + Celery +
MinIO + embeddings locais (BGE-m3). Nenhum SaaS obrigatório além do provedor de LLM.

> **Versão de divulgação, sem dados.** Este repositório contém só código. Não acompanha nenhuma
> licitação coletada, nenhum documento de acervo, nenhuma credencial e nenhum conector para o portal
> Petronect. O banco sobe vazio. Os dados de exemplo em `tests/fixtures/` são fictícios.

---

## O que o sistema faz

| Módulo | O que entrega |
|---|---|
| **Painel / Hoje** | Visão diária das oportunidades de maior aderência e dos prazos que estão vencendo. |
| **Explorar** | Busca e filtros sobre a base de licitações, ordenada por aderência aos perfis de interesse. |
| **Classificação** | Motor determinístico (`shared/classificacao`) que pontua cada edital por natureza, tipo de serviço, segmento e palavras-chave dos perfis. |
| **Detalhe da licitação** | Itens, anexos, circulares, análise por IA do edital, briefing em PDF, checklist em XLSX e pacote de orçamento em ZIP. |
| **Habilitação** | Cruza as famílias de fornecimento exigidas pelo edital com as que a empresa consegue comprovar. |
| **Resultados** | Vencedores, propostas e valores homologados, com dados do Portal da Transparência. |
| **Acervo técnico** | Cofre de atestados/contratos/CATs por operação, OCR, busca semântica híbrida (vetor + texto) com RAG, disciplinas e currículo técnico dos profissionais. |
| **Admin** | Usuários e papéis (RBAC com 7 papéis), SSO Microsoft Entra ID, auditoria, saúde das coletas, e-mails. |

## Arquitetura

```
Browser ──HTTPS──> NGINX
                     ├─ /bff/*  e  /api/*  ──> bff  (FastAPI :8000)
                     └─ / , /_next/* , PWA ──> web  (Next.js :3000)

  rede backend (internal, sem internet):  db (Postgres + pgvector) · redis · minio
  rede frontend (egress controlado):      web · bff · worker · embeddings-local
  worker (Celery beat) ── dispara os crons e os jobs de coleta
```

- **`web`** — Next.js 16 *standalone* (App Router, PWA, NextAuth). Dona do schema do banco (Drizzle).
- **`bff`** — FastAPI que assumiu as rotas `/api/*` do Next rota a rota (padrão *strangler-fig*), validando
  o mesmo JWT de sessão. Paridade de resposta verificada por testes.
- **`worker`** — Celery + beat: crons de notificação e digest, coleta do Portal da Transparência,
  reindexação de embeddings, expurgo de retenção (LGPD).
- **`embeddings-local`** — Text Embeddings Inference com BGE-m3 (1024 dimensões), para o RAG não
  depender de API externa.
- A rede `backend` é `internal: true`: banco, cache e blobs nunca falam com a internet.

## Mapa de pastas

```
├─ app/            Frontend Next.js 16 (UI, rotas /api, schema Drizzle e migrations)
├─ bff/            FastAPI: core (JWT/RBAC, rate limit, orçamento de IA) e routers migrados
├─ worker/         Celery: beat, tasks, jobs do Portal da Transparência, indexador
├─ shared/         Motor de classificação e contrato de IA compartilhados entre app/bff/worker
├─ db/             SQL de init do Postgres (extensões), aplicador de migrations extras e seed de demonstração
├─ nginx/          Configs de proxy reverso e regras do estrangulador
├─ observability/  Prometheus, Grafana, Loki, Promtail, Alertmanager, blackbox
├─ deploy/         Empacotamento offline: build → save-images → bundle → load-and-run; backup/restore
├─ scripts/        Bootstrap do MinIO e checagens de paridade
└─ tests/          Smoke, e2e, paridade e unitários (imagem tester própria)
```

## Subir o ambiente

Pré-requisitos: Docker + Docker Compose. Node 24 é opcional, só para mexer no front fora do container.

```bash
cp .env.onprem.example .env.onprem     # preencha os segredos (deploy/gen-secrets.sh gera valores aleatórios)
make pull && make build                # baixa imagens de terceiros e builda web/bff/worker
make up                                # sobe a stack (a 1ª vez baixa o modelo BGE-m3)
make migrate                           # aplica as migrations no banco
make ps                                # health de todos os containers
```

Acessos locais: web `http://127.0.0.1:3000` · bff `http://127.0.0.1:8000/bff/health` · MinIO `http://127.0.0.1:9001`.

`make help` lista todos os atalhos. Em máquinas com pouca RAM, `make up-lite` sobe tudo sem o serviço
de embeddings.

O primeiro administrador é criado pela rota de setup (`/api/auth/setup`, protegida por `SETUP_TOKEN`).

### Dados de demonstração

O banco sobe vazio. Para ver as telas com conteúdo, carregue o seed **fictício**:

```bash
make seed-demo        # idempotente; pode rodar de novo sem duplicar
```

Ele cria 4 usuários (login `admin@demo.invalid`, senha `Demo!PetroRadar` — troque antes de expor a
stack), 30 licitações com prazos relativos à data de hoje, itens, circulares, resultados, contratos,
famílias CRC, perfis de interesse e um acervo pequeno (6 operações, 10 documentos, 3 profissionais).
Números de licitação, empresas, CNPJs, clientes e profissionais são inventados. Os documentos do cofre
têm só metadado: o download falha porque não há arquivo no storage. O arquivo é
`db/seed/demo.sql`.

## Fontes de dados

O sistema é agnóstico quanto à origem das licitações: tudo converge para as tabelas `licitacoes`,
`itens`, `anexos` e `circulares`.

- **Incluído:** jobs que consomem o **Portal da Transparência da Petrobras** (contratos, licitações,
  adjudicações e aditivos — dados públicos), em `worker/transparencia_*.py`.
- **Não incluído:** coleta no portal Petronect. O ponto de extensão para baixar anexos na fonte está em
  `app/src/lib/fonte/anexo-fetch.ts` (hoje responde "conector não configurado").

Para alimentar a base por outro caminho, escreva um job que faça *upsert* nessas tabelas e chame o
classificador de `shared/classificacao`.

## Testes

```bash
cd app && npm install && npm test      # unitários do front e das libs (vitest)
make test-unit-bff                     # unitários do bff (pytest, na imagem tester)
bash tests/smoke.sh                    # smoke com a stack no ar
```

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · Drizzle ORM · NextAuth v5 · FastAPI ·
SQLAlchemy · Celery · PostgreSQL 16 + pgvector · Redis · MinIO · Text Embeddings Inference (BGE-m3) ·
Claude (Anthropic) · Docker Compose · NGINX · Prometheus / Grafana / Loki.

## Aviso

Projeto independente, sem vínculo com a Petrobras, a Transpetro ou a Petronect. Os nomes aparecem
apenas para identificar as fontes públicas de dados com que o sistema trabalha.
