# `db/` — Inicialização do PostgreSQL

Container do banco = **`pgvector/pgvector:pg16`** (serviço `db` no `docker-compose.yml`, só na rede
`backend`/interna). Este diretório contém **apenas o init que roda 1× no primeiro boot** (volume
vazio), via `/docker-entrypoint-initdb.d/`. Ele **não cria tabelas** — só garante extensões.

> **A fonte única do schema (tabelas + índices) é o Drizzle, em `app/src/db/migrations/`**
> (repo do app). Este init roda **antes** das migrations. Ver [`../bff/alembic-NOTA.md`](../bff/alembic-NOTA.md).

## Arquivos

| Arquivo | Papel |
|---|---|
| `init/01-extensions.sql` | `CREATE EXTENSION` de `vector` (RAG/pgvector, operador `<=>`), `pgcrypto` (uuid + field-level encryption LGPD), `unaccent` e `pg_trgm` (busca acento/fuzzy). |
| `init/02-pg-stat-statements.sql` | Cria a extensão `pg_stat_statements` (a lib já é pré-carregada pelo `command:` do serviço `db`). Diagnóstico de queries lentas. |

## Sequência de bootstrap

```
1) container 'db' sobe        → 01-extensions.sql + 02-pg-stat-statements.sql rodam (só no 1º boot)
2) make migrate               → aplica migrations 0000..0018 (tabelas, HNSW, vector(1024), unaccent/trgm)
3) (opcional) restore de prod → pg_restore do dump (ver deploy/README.md §4)
```

O índice vetorial **HNSW** (`idx_acervo_embedding`) é criado pela **migration 0014** e convertido
para `vector(1024)` (BGE-m3) pela **0015** — nunca via `drizzle-kit push` (push não modela HNSW → o
RAG cairia para Seq Scan). Em banco **já existente** (volume populado, o init não roda de novo),
aplique as extensões manualmente — instruções no cabeçalho de cada `.sql`.
