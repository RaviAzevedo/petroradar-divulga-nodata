# tests/ — Validação de Paridade On-Premise (WP12)

Prova que o pacote on-prem (`docker compose up`, offline) roda **igual à
produção** (`origin/main`). Matriz de rotas canônica: `tests/parity/route_inventory.csv`.

## Pré-requisitos

1. Banco migrado (`make migrate`) e, para a comparação com produção, dados
   restaurados (dump → `db`; `mc mirror` → `minio`) — ver `deploy/README.md`.
2. `.env.onprem` preenchido (segredos) — ver `.env.onprem.example`.
3. Imagens carregadas (modelo "pitstop": `docker load`) e `make up`.

## Como rodar (espelha WP12 §7 — alvos REAIS do Makefile)

O runner é o serviço `tester` do `docker-compose.yml` (perfil `tests`): **não
sobe no `make up`** — é buildado sob demanda no primeiro `make test-*`
(`compose --profile tests run --rm tester`) e descartado a cada alvo. O código
de `./tests` é montado por volume (editar teste no host vale na hora, sem
rebuild); os artefatos persistem em `tests/_artifacts/`.

```bash
make up                # toda a stack (8 serviços; embeddings-local BGE-m3 SEMPRE
                       # incluso; em dev use `make up-lite` p/ poupar RAM/CPU)
make migrate           # migrations 0000..0016 (vector 1024 + HNSW)

make test-smoke        # (a) saúde dos 8 containers + deps cruzadas -> smoke.json
make test-seed         # fixtures determinísticas (psql no db, idempotente)
make test-migrate-check# extensões + migrations + vector(1024) -> migrate_check.json
make test-e2e          # (b) e2e por feature (7 suítes) -> e2e_results.json
make test-routes       # (c) cobertura das 102 rotas -> route_inventory.csv
make test-parity       # (d) comparação on-prem × prod -> parity_summary.json
make test-parity-self  # (d') G5 parcial SEM prod: captura/compara goldens
                       #      locais em tests/_golden/ (self-golden, B5)
make test-unit-bff     # unit tests do BFF in-process (tests/unit_bff, F10)
make test-egress       # sonda ativa (host) + guard -> egress.json
make test-backup       # DR dry-run backup->restore -> backup_check.json
make go-no-go          # (e) veredito GO/NO-GO -> _artifacts/go-no-go.md
# ou tudo, na ordem acima (sem parity-self/unit-bff, que são alvos avulsos):
make test-all
```

Notas de execução:

- `test-seed` roda **no container `db`** (que não monta `./tests`): o
  `fixtures/seed.sql` entra do host via stdin do `compose exec -T db psql`.
- `test-egress` (passo 1) e `test-backup` rodam **no host** (`bash tests/...`):
  precisam de `docker exec`/daemon, que o `tester` não tem de propósito.
- Imports nas suítes: sempre `from tests.lib import fixtures` (pacote regular
  `tests` enraizado em `/` via `PYTHONPATH=/` + `__init__.py`).

## Serviços e probes de saúde (do docker-compose.yml)

| Serviço | Probe |
|---|---|
| `web` | `GET http://web:3000/api/auth/csrf` (<500) |
| `bff` | `GET http://bff:8000/bff/health` (200, `{db,redis:ok}`) |
| `db` | psycopg `SELECT 1` + extensão `vector` (pg_extension) |
| `redis` | PING **autenticado** (REDIS_PASSWORD) nas dbs 0/1/2/3 |
| `minio` | `GET /minio/health/ready` + `head_bucket petro-radar` (boto3) |
| `worker` | `GET http://worker:8080/healthz` |
| `embeddings-local` | `POST /v1/embeddings` → vetor **len==1024** |

## Artefatos (em `_artifacts/` — contrato canônico lido pelo `go_no_go.py`)

- `smoke.json` — `{pass,fail,skip,checks}` por checagem.
- `e2e_results.json` — `{ok,suites,faltando}`; ok=true só com todas as suítes
  presentes (junit) e failures+errors==0 em todas.
- `migrate_check.json` — `{ok,embedding_dim,migrations_aplicadas,extensoes,...}`.
- `route_inventory.csv` — 102 rotas: `rota,método,papel,status,ok`.
- `parity_summary.json` — `{casos,identicos,equivalentes,divergentes,...}`
  (+ `parity_report.html` legível por humanos).
- `egress.json` — `{proibidos,exigidos,gated,veredito}` (formato do egress_guard).
- `backup_check.json` — `{ok,restored,tabelas,dump,detalhe}` do DR dry-run.
- `go-no-go.md` — veredito final com os gates G1–G13 e D1–D6.

Obs.: `tests/_artifacts/` e `tests/_golden/` são runtime (gitignored). A baseline
do parity self-golden é capturada do PRÓPRIO ambiente na 1ª execução — pode
conter dado real do banco, por isso não é versionada.

## Modo air-gap

Sem `GRAPH_MAIL_SENDER` / `ANTHROPIC_API_KEY` os testes marcam **SKIP**
(degradação consciente) e **provam o no-op gracioso** — não é FAIL.
