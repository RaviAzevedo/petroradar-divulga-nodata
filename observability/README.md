# Observabilidade on-prem (WP10) — Prometheus + Grafana + Loki + Alertmanager (+ GlitchTip)

Stack **opt-in** de observabilidade do Petro Radar on-premise. Vive num compose
**separado** (`docker-compose.observability.yml`, na raiz) que funciona como
**overlay** do compose principal: mesmo project name (`petro-radar`), mesmas
redes `frontend`/`backend`, **zero alteração** nos serviços existentes — só
ADICIONA serviços.

> Origem do design: plano WP10 (Opção B + adendo GlitchTip). Ajustes em relação
> ao plano: Elasticsearch foi **removido** da
> stack em 2026-07-02 (sem scrape/alerta de ES), o `health-exporter` custom do
> doc foi **absorvido pelo `/metrics` do worker** (G6 — `worker/healthz.py`,
> sem container extra) e as imagens foram **repinadas** (as do doc tinham >1
> ano de defasagem).

## Subida

```bash
# Stack base (Prometheus, Alertmanager, Grafana, Loki, Promtail, exporters):
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d

# Em DEV (Mac), o nginx/embeddings vêm do override de dev — inclua-o para o
# compose não acusar drift/órfãos nos serviços do app:
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.observability.yml up -d

# GlitchTip (error tracking, OPT-IN — G2):
docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile errors up -d
```

O overlay **não** redeclara as redes `frontend`/`backend` (herda do
`docker-compose.yml`, mesmo projeto). Se a TI quiser rodar como stack
independente (project name próprio), troque as referências para
`external: true` com os nomes reais `petro-radar_backend`/`petro-radar_frontend`.

## URLs (loopback do host)

| Serviço | URL | Credencial |
|---|---|---|
| Grafana (UI única) | http://localhost:3001 | `admin` / `${GRAFANA_ADMIN_PASSWORD}` (default `admin`) |
| Prometheus (debug) | http://localhost:9090 | — |
| Loki (API LogQL, debug) | http://localhost:3100 | — |
| GlitchTip (só com `--profile errors`) | http://localhost:8010 | criar conta no 1º acesso (registro aberto desabilitado depois) |

Alertmanager (9093), exporters e Promtail ficam **só na rede interna**.
Dashboards provisionados (pasta "Petro Radar"): **Visão Geral da Stack**
(healthchecks, CPU/RAM por container, disco, logs), **Coleta / Worker (sync)**
(idade do sync por tipo vs limite, erros, heartbeat do beat) e **Filas / Redis**
(backlog por fila, memória vs maxmemory).

## Envs novas (consolidar no `.env.onprem.example` — orquestrador)

Este overlay usa defaults sensatos para tudo; as chaves abaixo são as que a TI
deve definir no `.env.onprem` real:

```bash
# ══════════════════════ OBSERVABILIDADE (WP10 / G1) ══════════════════════════
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=troque-senha-forte        # secret novo (openssl rand -hex 24)
GRAFANA_ROOT_URL=http://localhost:3001           # trocar se o NGINX proxiar (ex.: https://radar.example.local/obs/)
ALERT_EMAIL_TO=ti@example.com                # destino dos alertas do Alertmanager
# SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/FROM_EMAIL: REUSA as já existentes (WP08)

# ══════════════════════ GLITCHTIP (G2, opt-in --profile errors) ══════════════
GLITCHTIP_SECRET_KEY=troque-gere-com-openssl-rand-hex-32
GLITCHTIP_DB_PASSWORD=troque-senha-forte         # Postgres PRÓPRIO do GlitchTip
GLITCHTIP_DOMAIN=http://localhost:8010           # URL externa da UI (usada nos e-mails/DSN)
GLITCHTIP_EMAIL_URL=consolemail://               # smtp://user:pass@smtp.example.local:587 quando liberar
```

Reusadas (já existem no projeto, **não duplicar**): `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`, `REDIS_PASSWORD`, `DATABASE_URL`.

## G6 — métricas do worker (EXIGE REBUILD da imagem)

`worker/healthz.py` agora serve **`GET :8080/metrics`** (formato Prometheus,
texto gerado à mão — **sem** dependência nova) além do `/healthz`:

- `petro_worker_redis_up` / `petro_worker_db_up` / `petro_worker_beat_ok`
- `petro_worker_beat_heartbeat_age_seconds` (heartbeat do beat, 1/min)
- `petro_celery_fila_backlog{fila}` — LLEN das filas reais do Celery
  (`default|scraping|embeddings|ia|manutencao`, Redis db1)
- `petro_sync_idade_segundos{tipo}` + `petro_sync_limite_segundos{tipo}`
  (limites espelham `MAX_HORAS_POR_TIPO` do app — paridade com
  `/admin/saude-scraper`) + `petro_sync_erros_ultima_execucao{tipo}`,
  `petro_sync_novas_ultima_execucao{tipo}`, `petro_sync_total_ultima_execucao{tipo}`

> ⚠️ **O container do worker roda a imagem antiga**: o `/metrics` só passa a
> existir após `docker compose build worker && docker compose up -d worker`
> (fica a cargo do orquestrador). Até lá o target `worker` do Prometheus fica
> **DOWN** (esperado) e o alerta `WorkerMetricsIndisponivel` (warning) fica
> ativo. O `/healthz` continua igual (healthcheck do compose não quebra) e o
> backlog das filas já é coberto HOJE pelo `redis-exporter` (`redis_key_size`).
> `celery_task_result_total{task,status}` ficou de fora de propósito: exigiria
> celery events/instrumentação pesada (decisão G6).

## Alertas (4 famílias — `observability/prometheus/alerts.yml`)

1. **Cron falho/atrasado**: `WorkerBeatParado` (heartbeat >5min),
   `SyncAtrasado` (idade > limite por tipo — mesmo limiar do sync-monitor),
   `SyncComErros`, `WorkerMetricsIndisponivel`.
2. **Fila travada/backlog**: `FilaComBacklog` (>50 por 15m),
   `FilaTravada` (não drena abaixo de 20 por 30m) — via `redis_key_size` db1.
3. **Disco/recursos**: `DiscoQuaseCheio`/`DiscoCritico`/`InodesQuaseEsgotados`,
   `MemoriaHostBaixa`, `ContainerOOM`, `ContainerReiniciando`,
   `ServicoForaDoAr` (blackbox), `BffSemMetricas`, `ExporterForaDoAr`.
4. **Redis cheio**: `RedisMemoriaAlta` (>85%)/`RedisCheio` (>95% — policy
   noeviction: broker PARA), `RedisForaDoAr`, `PostgresForaDoAr`.

Rota: e-mail via SMTP interno (`ALERT_EMAIL_TO`); `critical` repete a cada 1h.
O Alertmanager não expande env no config — o entrypoint do serviço renderiza o
template `observability/alertmanager/alertmanager.yml` (`${SMTP_...}`) via sed.
`NOTIFY_WEBHOOK_URL` (Teams) está vazio no ambiente; adicionar
`webhook_configs` quando existir (WP10 §5.7).

## G2 — GlitchTip (error tracking, profile `errors`)

Sobe `glitchtip-web` + `glitchtip-worker` + `glitchtip-migrate` com **Postgres
e Redis próprios** (rede isolada `glitchtip`; volume `glitchtip_pg_data`) —
nada de reusar o `db`/`redis` do app. O `glitchtip-web` também entra na rede
`backend` com alias **`glitchtip`**.

Como apontar o app para ele (envs **já existem** no código):

1. Suba com `--profile errors`, acesse http://localhost:8010, crie
   organização + projeto e copie o DSN.
2. Troque o host do DSN pelo alias interno: `http://<chave>@glitchtip:8000/<id>`.
3. **bff**: setar `SENTRY_DSN` (+ `SENTRY_ENVIRONMENT`, já em
   `bff/app/core/config.py`; init + redação de PII em
   `bff/app/core/observability.py` — `sentry-sdk` já está no requirements).
4. **web**: `src/lib/observability/sentry.ts` é no-op até instalar
   `@sentry/nextjs` (exige rebuild do web — WP10 §6, fora deste WP).
5. **worker**: hoje NÃO tem SDK Sentry (sem integração no código); os erros do
   worker ficam cobertos por logs (Loki) e `sync_log`/alertas.

## RAM (Mac dev 16GB)

Limites (`mem_limit`): prometheus 512m, loki 512m, grafana 256m, promtail/
alertmanager 128m, exporters 64m, cadvisor 256m. Teto da stack base ≈ 2GB
(uso real ~0,6–0,8GB). GlitchTip (~1,4GB de teto) fica FORA por default
(profile `errors`).

## Versões pinadas (2026-07-02)

| Serviço | Imagem | Nota |
|---|---|---|
| Prometheus | `prom/prometheus:v3.5.4` | linha LTS 3.5 (WP10: v2.54.1) |
| Alertmanager | `prom/alertmanager:v0.33.0` | WP10: v0.27.0 |
| Grafana | `grafana/grafana:12.4.5` | WP10: 11.2.0 |
| Loki / Promtail | `grafana/loki:3.5.12` / `grafana/promtail:3.5.12` | linha 3.5 em manutenção (WP10: 3.1.1) |
| node-exporter | `prom/node-exporter:v1.11.1` | WP10: v1.8.2 |
| cadvisor | `gcr.io/cadvisor/cadvisor:v0.52.1` | WP10: v0.49.1 |
| redis-exporter | `oliver006/redis_exporter:v1.86.0` | WP10: v1.62.0 |
| postgres-exporter | `prometheuscommunity/postgres-exporter:v0.20.0` | não constava no WP10 (opcional) |
| blackbox-exporter | `prom/blackbox-exporter:v0.28.0` | WP10: v0.25.0 |
| GlitchTip | `glitchtip/glitchtip:6.2.0` + `postgres:16-alpine` | isolado, profile `errors` |

## Validação rápida

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml ps
curl -s localhost:9090/api/v1/targets | python3 -m json.tool | rg '"health"'
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/api/health   # 200
curl -s localhost:9090/api/v1/rules | rg -o '"name":"[^"]*"' | head
curl -s localhost:3100/ready                                          # ready
```

Esperado: todos os targets `up`, **exceto `worker`** (down até o rebuild da
imagem — ver G6 acima). MinIO: só healthcheck via blackbox (o `/minio/v2/metrics`
exigiria `MINIO_PROMETHEUS_AUTH_TYPE=public` no compose principal — fora deste
overlay; anotado como follow-up do orquestrador).

## Limitações conhecidas / follow-ups

- **Scrape do worker DOWN até rebuild** da imagem (G6 — orquestrador).
- **MinIO sem métricas nativas** (precisa de env no serviço `minio` do compose
  principal); healthcheck coberto pelo blackbox.
- **Logs do worker são texto** (Celery), não JSON — entram no Loki sem o label
  `level` (filtráveis por `{service="worker"}`).
- No macOS (dev), node-exporter/cadvisor medem a **VM do Docker Desktop**, não
  o Mac — no servidor Linux medem o host real.
- **cadvisor por-container não funciona com "containerd image store"** (o
  default do Docker Desktop dev): o handler docker falha ao resolver a camada
  RW (`failed to identify the read-write layer`) e só saem métricas de máquina
  (`id="/"`). No servidor Linux com storage driver `overlay2` clássico as
  séries `container_*{name="petro-radar-..."}` saem normalmente (dashboards e
  alertas `ContainerOOM`/`ContainerReiniciando` ficam sem dados no dev, sem
  falso positivo).
- Grafana atrás do NGINX (`/obs/`) é wiring do compose principal/NGINX da TI
  (WP10 §8.2) — fora deste overlay; por ora a UI é `localhost:3001`.
