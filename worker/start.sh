#!/usr/bin/env bash
# =============================================================================
# worker/start.sh — SUPERVISOR dos processos do worker on-prem (C4 + C9)
# =============================================================================
# Sobe 4 processos e SUPERVISIONA:
#   1. healthz.py            — HTTP :8080/healthz (liveness p/ o compose)
#   2. celery worker scraper — SÓ a fila `scraping`, --concurrency=1: no máximo
#      1 Chromium/Playwright vivo => rate-limit global DE FATO no Portal da
#      Transparência (antes, o worker único -c 2 podia rodar 2 scrapings juntos).
#   3. celery worker geral   — demais filas (default,embeddings,ia,manutencao,
#      roteadas em celery_app.py task_routes), --concurrency=2.
#   4. celery beat           — agendador (12 crons; lock em /state = 1 só beat).
#
# C4: se QUALQUER processo morrer, o supervisor derruba os demais e sai exit 1
# — o `restart: unless-stopped` do compose religa o container INTEIRO. (Antes,
# worker/beat rodavam em background sem supervisão: processo morto deixava o
# container Up; o healthz reportava 503 mas o Docker NÃO reinicia unhealthy.)
# SIGTERM/SIGINT são propagados aos filhos (docker stop gracioso; o Celery faz
# warm shutdown — termina a task corrente antes de sair).
#
# Memória: 2 workers (1+2 children) + beat + healthz no MESMO container; o
# celery_app.py já limita prefetch_multiplier=1 e max_tasks_per_child=50.
# =============================================================================
set -uo pipefail

PIDS=()

# SIGTERM -> warm shutdown do Celery (termina a task corrente). O drain é
# LIMITADO (WORKER_SHUTDOWN_GRACE, default 30s): uma task de scraping pode
# rodar por ate 1h e seguraria o restart do container esse tempo todo; apos o
# grace, SIGKILL — seguro, pois task_acks_late + reject_on_worker_lost fazem o
# broker reentregar a task interrompida no proximo boot.
shutdown() {
  trap '' TERM INT
  echo "[start.sh] encerrando filhos: ${PIDS[*]}" >&2
  kill -- "${PIDS[@]}" 2>/dev/null || true
  local grace="${WORKER_SHUTDOWN_GRACE:-30}" i alive p
  for (( i = 0; i < grace; i++ )); do
    alive=0
    for p in "${PIDS[@]}"; do kill -0 "${p}" 2>/dev/null && alive=1; done
    [[ "${alive}" == "0" ]] && break
    sleep 1
  done
  if [[ "${alive:-0}" == "1" ]]; then
    echo "[start.sh] grace de ${grace}s esgotado — SIGKILL nos restantes (tasks serao reentregues)." >&2
    kill -9 -- "${PIDS[@]}" 2>/dev/null || true
  fi
  wait
}
trap 'shutdown; exit 143' TERM
trap 'shutdown; exit 130' INT

# 0-pre) LOCKS ORFAOS (M3): as tasks de scraping usam `SET NX EX` no Redis com
#    TTL de ate 3h20 e so soltam no __exit__. Se o container for reiniciado no
#    meio (deploy, OOM, restart de boa-fe), o lock SOBREVIVE e a proxima execucao
#    agendada retorna {'skipped':'locked'} — a coleta do dia e adiada em
#    ate 3h20 sem NADA no sync_log e sem alerta. Como aqui e o boot, nao ha task
#    de scraping viva por definicao: qualquer lock presente e orfao.
python - <<'PYLOCK' || true
import os, redis
url = os.environ.get("CELERY_BROKER_URL") or os.environ.get("REDIS_URL")
if url:
    try:
        r = redis.from_url(url)
        ks = r.keys("lock:worker:scraping:*")
        for k in ks:
            r.delete(k)
        nomes = [k.decode() if isinstance(k, bytes) else k for k in ks]
        print(f"[start.sh] locks orfaos de scraping limpos no boot: {nomes or 'nenhum'}")
    except Exception as e:
        print(f"[start.sh] nao foi possivel limpar locks orfaos: {e}")
PYLOCK

# 0) Catch-up de BOOT: assim que o Docker religa apos ficar parado, enfileira o
#    reconciliador de gap (tasks.catchup_stale_syncs) — ele dispara UMA execucao
#    de cada scraper cujo ultimo sync_log passou do limite, deixando a base
#    "sempre atualizada" sem o operador precisar clicar Sincronizar/Reclassificar.
#    Roda em FOREGROUND (nao vira job de background -> nao interfere no `wait -n`
#    da supervisao) e apenas PUBLICA a msg no Redis; o worker geral (abaixo) a
#    consome em seguida. Best-effort: qualquer falha nao impede o boot, pois o
#    beat reconcilia de novo em ate 30 min (ver beat_schedule.py).
timeout "${CATCHUP_BOOT_TIMEOUT:-30}" \
  celery -A celery_app.app call tasks.catchup_stale_syncs >/dev/null 2>&1 \
  && echo "[start.sh] catch-up de boot enfileirado (recuperacao de gaps)." >&2 \
  || echo "[start.sh] catch-up de boot NAO enfileirado — o beat periodico cobre em <=30min." >&2

# 1) Healthcheck HTTP (:8080/healthz) — o compose bate aqui.
python healthz.py &
PIDS+=($!)

# 2) Worker DEDICADO ao scraping (C9): 1 task por vez, nó nomeado p/ inspeção
#    (celery inspect active_queues mostra scraper@<host> só com `scraping`).
celery -A celery_app.app worker \
  --loglevel="${LOG_LEVEL:-info}" \
  --queues=scraping \
  --concurrency=1 \
  --hostname='scraper@%h' &
PIDS+=($!)

# 3) Worker GERAL: todas as demais filas roteadas no celery_app.py.
celery -A celery_app.app worker \
  --loglevel="${LOG_LEVEL:-info}" \
  --queues=default,embeddings,ia,manutencao \
  --concurrency="${CELERY_CONCURRENCY:-2}" \
  --hostname='geral@%h' &
PIDS+=($!)

# 4) Beat (agendador).
celery -A celery_app.app beat \
  --loglevel="${LOG_LEVEL:-info}" \
  --schedule=/state/celerybeat-schedule &
PIDS+=($!)

# ── Supervisão (C4): bloqueia até o PRIMEIRO filho sair (ok OU erro). Nenhum
# deles termina por design => qualquer saída é anormal: derruba o resto e
# exit 1 para o restart policy do compose religar o container inteiro.
wait -n
rc=$?
echo "[start.sh] um processo do worker saiu (rc=${rc}) — derrubando o container para o compose reiniciar." >&2
shutdown
exit 1
