# `scripts/` — Bootstrap, checagens de paridade e empacotamento de dados

Scripts utilitários usados pela stack e pelos runbooks. (Os scripts do **pitstop de deploy** —
build/save/bundle/load-and-run — ficam em [`../deploy/`](../deploy/README.md); aqui estão os
auxiliares de banco/storage e de dados.)

## Arquivos

| Arquivo | Papel | Quem chama |
|---|---|---|
| `bootstrap.sh` | Cria o bucket privado `petro-radar` + service account de menor privilégio no MinIO (idempotente). | O serviço `createbuckets` do compose: `bootstrap.sh minio`. |
| `parity/00_check_extensions.sql` | Confere as extensões do Postgres (`vector`, `pgcrypto`, `unaccent`, `pg_trgm`). | Runbooks de import/paridade. |
| `parity/02_check_hnsw.sql` | Confere o índice HNSW do RAG (`idx_acervo_embedding`). | idem |
| `parity/04_db_keys.sql` | Lista as `blob_key` referenciadas no banco. | Insumo do `03_storage_validate.sh`. |
| `parity/count_tables.sql` | Conta linhas por tabela (paridade de dados on-prem × produção). | `make parity-diff` / runbooks. |
| `parity/03_storage_validate.sh` | Valida paridade **banco ↔ MinIO**: toda `blob_key` do Postgres tem objeto no bucket. | Rodar no servidor com a stack no ar. |
| `pitstop/pack-data.sh` | Exporta os blobs do **Cloudflare R2 (produção)** para um tarball que o pitstop carrega no MinIO. Roda na máquina-ponte (com internet + acesso ao R2). | `deploy/snapshot-prod.sh` (ou manualmente) |

## Contexto

Estes scripts materializam partes do WP02 (dados/migração) e do WP12 (paridade). O fluxo de import de
dados e as asserções de paridade estão descritos em [`../deploy/README.md`](../deploy/README.md) e
[`../tests/README.md`](../tests/README.md).
