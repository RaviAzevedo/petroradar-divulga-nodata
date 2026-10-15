# Worker on-premise — Petro Radar (Celery + Redis + Playwright)

Agendador e executor de tarefas em segundo plano da stack on-prem: **Celery +
Redis** (filas com retries, lock distribuído, disparo on-demand). Substitui um
agendador time-based externo por um beat local, sem dependência de SaaS.

> **Escopo desta edição do repositório:** o coletor do portal de compras (scraper)
> **não faz parte** deste código. O worker aqui cuida de: disparo dos crons do
> app, jobs do **Portal da Transparência Petrobras** (dado público), reindexação
> de embeddings do acervo e retenção LGPD. A tabela `licitacoes` precisa ser
> alimentada por outra fonte (import próprio ou os jobs da Transparência, que
> ingerem as licitações publicadas no portal com `fonte='transparencia'`).

## Componentes

| Arquivo | Papel |
|---|---|
| `celery_app.py` | App Celery (broker/back-end = Redis db1), roteamento de filas |
| `beat_schedule.py` | Agendamento: crons do app, jobs da Transparência, heartbeat, catch-up e expurgo LGPD (todas as entradas com `options.expires` anti-catch-up) |
| `tasks.py` | Tasks: `cron_trigger`, `transparencia_*`, `embedding_reindex_acervo`, `retencao_expurgo` (DRY-RUN por default), `catchup_stale_syncs`, `beat_heartbeat` |
| `db_util.py` | Helpers de banco dos jobs: conexão psycopg2, leitura de `perfis_interesse`, gravação em `sync_log` e o motor de classificação compartilhado (`/shared/classificacao`) |
| `transparencia_job.py` | Valor real + vencedor/metadados do contrato para resultados já conhecidos |
| `transparencia_sweep.py` | Sweeps semanais de contratos: por CNPJ, por termos de objeto e por adjudicações recentes |
| `transparencia_licitacoes_job.py` | Universo de licitações publicadas (export XLSX) → `transparencia_licitacoes` + ingestão em `licitacoes` |
| `transparencia_aditivos.py` | Aditivos dos contratos revelados (corrige vigência efetiva) |
| `indexer.py` | Re-embedding do acervo (`acervo_chunks`) via TEI / BGE-m3 |
| `healthz.py` | HTTP `:8080/healthz` (Redis PING + `SELECT 1` no Postgres + heartbeat do beat) e `:8080/metrics` (formato Prometheus) |
| `start.sh` | Supervisor: sobe healthz + 2 workers Celery + beat e derruba o container se qualquer um morrer |

## Filas

`default` (crons) · `scraping` (jobs que sobem Chromium — Transparência) ·
`embeddings` (BGE-m3) · `ia` · `manutencao` (retenção).

A fila `scraping` roda com `--concurrency=1`: no máximo **um** Chromium vivo por
vez (educação com o portal público e teto de memória do container).

## O que roda

### 1. Crons do app (`tasks.cron_trigger`)

A lógica de negócio dos crons vive no app (Next.js) / BFF. O worker apenas
**dispara** `GET /api/cron/<nome>` com `Authorization: Bearer $CRON_SECRET`:

`prazos` · `vencimentos` · `sync-monitor` · `saude-contratos` · `cnpj-watch` ·
`triagem-semantica` (só com `TRIAGEM_IA_ENABLED=1`) · `convocacao-watch` ·
`acervo-index` · `digest-executivo` · `extrair-anexos` · `digest-licitacoes` ·
`relatorio-mensal`.

O alvo é escolhido por execução via `CRON_TARGET` (`web` = default, `bff`).
Horários (UTC) e janelas de expiração: ver `beat_schedule.py`.

### 2. Portal da Transparência Petrobras (`tasks.transparencia_*`)

Fonte **pública**, somente leitura, sem credencial. O portal fica atrás de WAF,
então cada job abre um Chromium headless (Playwright) só para obter a sessão e o
token CSRF e depois consulta a API do portal, com pausa entre requisições.

| Task | Frequência | Efeito |
|---|---|---|
| `transparencia_valores` | diária | `resultados_licitacao`: valor real do contrato, vencedor, vigência |
| `transparencia_licitacoes` | diária | `transparencia_licitacoes` + ingestão das descobertas em `licitacoes` |
| `transparencia_sweep_cnpj` | semanal | histórico de contratos por CNPJ → `transparencia_contratos` |
| `transparencia_sweep_objeto` | semanal | contratos a vencer por termos de objeto → `transparencia_contratos` |
| `transparencia_sweep_adjudicacoes` | semanal | contratos recém-iniciados (licitações ganhas) → `transparencia_contratos` |
| `transparencia_aditivos` | semanal | aditivos dos contratos revelados → `resultados_licitacao.contrato_dados` |

Ligado por padrão; desligue com `TRANSPARENCIA_ENABLED=0` em ambiente sem egress
para `sistematransparencia.petrobras.com.br`. Cada execução grava uma linha em
`sync_log` (tipo `transparencia`), que alimenta o painel de saúde e o catch-up.

### 3. Embeddings (`tasks.embedding_reindex_acervo`)

Disparo manual (ou pelo `deploy/load-and-run.sh`):

- `acervo_chunks` **vazio** → bootstrap: chama o cron `acervo-index` em laço até
  drenar as fontes (é ele que cria os chunks com texto + embedding).
- `acervo_chunks` **não-vazio** → `indexer.reembed_acervo()` regenera os vetores
  que estão `NULL` (troca de modelo, por exemplo).

### 4. Retenção LGPD (`tasks.retencao_expurgo`)

Diária. Roda em **DRY-RUN** por padrão (`RETENCAO_DRY_RUN=1` — só conta e loga o
que seria expurgado). O expurgo real (`=0`) só deve ser ligado após aprovação
jurídica/DPO. Política em `_RETENCAO_SQL` (`tasks.py`).

### 5. Catch-up e heartbeat

- `catchup_stale_syncs` (boot + a cada 30 min): se o último `sync_log` de um tipo
  monitorado passou do limite, enfileira **uma** execução — recupera a base após
  downtime sem reprocessar o backlog inteiro.
- `beat_heartbeat` (1/min): grava uma chave no Redis lida pelo `/healthz`.

## Confiabilidade

- `task_acks_late` + `task_reject_on_worker_lost`: nenhum cron de prazo é perdido
  se o worker reiniciar no meio.
- Lock distribuído no Redis (`_Lock`, SET NX EX) em cada task: evita duplicidade
  com réplicas e no restart no minuto-alvo.
- `options.expires` em toda entrada do beat: mensagem velha é descartada em vez
  de gerar tempestade de backlog quando a stack volta de uma parada.

## Rodar local

```bash
docker compose build worker && docker compose up -d worker
docker compose logs -f worker
# disparar uma task manualmente:
docker compose exec worker celery -A celery_app.app call tasks.cron_trigger --args='["sync-monitor"]'
docker compose exec worker celery -A celery_app.app call tasks.transparencia_valores
```

## Variáveis de ambiente

`DATABASE_URL`, `REDIS_URL` / `CELERY_BROKER_URL`, `CRON_SECRET`, `APP_BASE_URL`,
`BFF_BASE_URL`, `CRON_TARGET`, `TRANSPARENCIA_ENABLED`, `TRIAGEM_IA_ENABLED`,
`RETENCAO_DRY_RUN`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`,
`EMBEDDING_DIMENSOES` — ver `.env.onprem.example` na raiz.
