"""Servidor mínimo de healthcheck + métricas do worker (porta 8080).

Rotas (mesmo servidor HTTP, processo separado do Celery — ver start.sh):
  - ``GET /healthz`` — liveness usado pelo healthcheck do compose. Retorna 200
    se o broker Redis responde PING, o Postgres responde SELECT 1 e o
    heartbeat do beat está fresco; 503 caso contrário.
  - ``GET /metrics`` — exposição Prometheus (formato texto 0.0.4) gerada À MÃO
    (a imagem do worker NÃO tem prometheus_client; zero dependência nova).
    Métricas: backlog por fila Celery (LLEN no Redis db1), idade/erros/novas
    do último ``sync_log`` por tipo (Postgres, conexão curta), idade do
    heartbeat do beat e status das dependências. Consumida pelo job ``worker``
    do Prometheus da stack de observabilidade (docker-compose.observability.yml).

Cuidados (o healthz roda num processo separado dentro do container do worker):
  - TODA conexão é curta e com timeout — um Redis/Postgres pendurado não pode
    travar o healthcheck do compose.
  - Servidor THREADED: um scrape lento de /metrics não bloqueia o /healthz.
"""

from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis as redislib

# Timeouts curtos no cliente Redis: healthz/metrics nunca podem pendurar.
_redis = redislib.from_url(
    os.environ.get("REDIS_URL", "redis://redis:6379/1"),
    socket_timeout=3,
    socket_connect_timeout=3,
)
DATABASE_URL = os.environ.get("DATABASE_URL", "")
# A task tasks.beat_heartbeat (agendada a cada 1 min) atualiza esta chave. Liveness
# do par beat+worker = heartbeat fresco (se o beat parar de agendar OU o worker
# parar de consumir, a chave envelhece e o healthz vira 503).
BEAT_HB_KEY = "worker:beat:heartbeat"
BEAT_MAX_AGE = int(os.environ.get("BEAT_HB_MAX_AGE", "300"))  # 5 min

# Filas Celery REAIS (celery_app.py: task_routes + task_default_queue). A fila
# de broadcast/pidbox e a indexacao-es legada ficam de fora de propósito.
FILAS_CELERY = ("default", "scraping", "embeddings", "ia", "manutencao")

# Limite de horas sem sync por tipo — espelha MAX_HORAS_POR_TIPO de
# src/lib/observability/scraper-health.ts do app (paridade com o painel
# /admin/saude-scraper e com o cron sync-monitor). Tipo fora da lista não gera
# a série de limite (equivale ao status DESCONHECIDO do painel: sem alerta).
MAX_HORAS_POR_TIPO = {
    "transparencia": 30,
}


def _check_redis() -> bool:
    try:
        return bool(_redis.ping())
    except Exception:  # noqa: BLE001
        return False


def _check_db() -> bool:
    if not DATABASE_URL:
        return True
    try:
        import psycopg2  # import tardio (dep do worker)
        conn = psycopg2.connect(DATABASE_URL, connect_timeout=3)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            return True
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return False


def _beat_age() -> float | None:
    """Idade (s) do heartbeat do beat, ou None se a chave não existe/Redis caiu."""
    try:
        raw = _redis.get(BEAT_HB_KEY)
        if raw is None:
            return None
        return max(0.0, time.time() - float(raw))
    except Exception:  # noqa: BLE001
        return None


def _check_beat() -> bool:
    # Best-effort: exige frescor SE a chave existir; nao bloqueia antes do 1o tick.
    age = _beat_age()
    if age is None:
        return True
    return age <= BEAT_MAX_AGE


# ── /metrics: coleta + renderização (formato de exposição Prometheus 0.0.4) ───

def _coleta_filas() -> dict[str, int]:
    """Backlog por fila Celery: LLEN das listas no Redis db1 (broker)."""
    filas: dict[str, int] = {}
    for fila in FILAS_CELERY:
        try:
            filas[fila] = int(_redis.llen(fila))
        except Exception:  # noqa: BLE001
            continue
    return filas


def _coleta_sync() -> list[tuple[str, float, int, int, int]]:
    """(tipo, idade_s, erros, novas, total) do último sync_log de cada tipo.

    A idade é calculada NO Postgres (now()::timestamp - executado_em): o campo é
    timestamp sem fuso gravado com now() do servidor — comparar lá dentro evita
    qualquer ambiguidade de timezone. Conexão própria, curta e com timeouts.
    """
    if not DATABASE_URL:
        return []
    import psycopg2  # import tardio (dep do worker)

    conn = psycopg2.connect(
        DATABASE_URL, connect_timeout=3, options="-c statement_timeout=3000"
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT ON (tipo)
                       tipo,
                       EXTRACT(EPOCH FROM (now()::timestamp - executado_em)) AS idade_s,
                       COALESCE(erros, 0),
                       COALESCE(novas, 0),
                       COALESCE(total_encontradas, 0)
                FROM sync_log
                ORDER BY tipo, executado_em DESC NULLS LAST
                """
            )
            linhas = []
            for tipo, idade_s, erros, novas, total in cur.fetchall():
                linhas.append(
                    (
                        str(tipo),
                        float(idade_s if idade_s is not None else 1e9),
                        int(erros or 0),
                        int(novas or 0),
                        int(total or 0),
                    )
                )
            return linhas
    finally:
        conn.close()


def _lbl(valor: str) -> str:
    """Escapa um valor de label conforme o formato de exposição Prometheus."""
    return valor.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _render_metrics() -> str:
    """Gera o corpo de /metrics à mão (sem prometheus_client)."""
    out: list[str] = []

    def bloco(nome: str, tipo: str, ajuda: str, series: list[str]) -> None:
        if not series:
            return
        out.append(f"# HELP {nome} {ajuda}")
        out.append(f"# TYPE {nome} {tipo}")
        out.extend(series)

    redis_ok = _check_redis()
    db_ok = _check_db()
    beat_ok = _check_beat()

    bloco(
        "petro_worker_redis_up", "gauge",
        "1 se o broker Redis (db1) responde PING.",
        [f"petro_worker_redis_up {int(redis_ok)}"],
    )
    bloco(
        "petro_worker_db_up", "gauge",
        "1 se o Postgres responde SELECT 1.",
        [f"petro_worker_db_up {int(db_ok)}"],
    )
    bloco(
        "petro_worker_beat_ok", "gauge",
        "1 se o heartbeat do beat esta fresco (mesma logica do /healthz).",
        [f"petro_worker_beat_ok {int(beat_ok)}"],
    )

    idade_beat = _beat_age()
    if idade_beat is not None:
        bloco(
            "petro_worker_beat_heartbeat_age_seconds", "gauge",
            "Idade (s) do heartbeat gravado por tasks.beat_heartbeat (1/min).",
            [f"petro_worker_beat_heartbeat_age_seconds {idade_beat:.1f}"],
        )

    if redis_ok:
        filas = _coleta_filas()
        bloco(
            "petro_celery_fila_backlog", "gauge",
            "Tasks pendentes na fila Celery (LLEN no Redis db1 do broker).",
            [
                f'petro_celery_fila_backlog{{fila="{_lbl(fila)}"}} {n}'
                for fila, n in sorted(filas.items())
            ],
        )

    if db_ok and DATABASE_URL:
        try:
            sync = _coleta_sync()
        except Exception:  # noqa: BLE001 - métricas nunca derrubam o endpoint
            sync = []
        bloco(
            "petro_sync_idade_segundos", "gauge",
            "Segundos desde o ultimo sync_log do tipo (paridade saude-scraper).",
            [
                f'petro_sync_idade_segundos{{tipo="{_lbl(t)}"}} {idade:.0f}'
                for t, idade, _e, _n, _tot in sync
            ],
        )
        bloco(
            "petro_sync_limite_segundos", "gauge",
            "Limite de idade por tipo (MAX_HORAS_POR_TIPO do app, em segundos).",
            [
                f'petro_sync_limite_segundos{{tipo="{_lbl(t)}"}} {MAX_HORAS_POR_TIPO[t] * 3600}'
                for t, _i, _e, _n, _tot in sync
                if t in MAX_HORAS_POR_TIPO
            ],
        )
        bloco(
            "petro_sync_erros_ultima_execucao", "gauge",
            "Erros registrados no ultimo sync_log do tipo.",
            [
                f'petro_sync_erros_ultima_execucao{{tipo="{_lbl(t)}"}} {e}'
                for t, _i, e, _n, _tot in sync
            ],
        )
        bloco(
            "petro_sync_novas_ultima_execucao", "gauge",
            "Registros novos no ultimo sync_log do tipo.",
            [
                f'petro_sync_novas_ultima_execucao{{tipo="{_lbl(t)}"}} {n}'
                for t, _i, _e, n, _tot in sync
            ],
        )
        bloco(
            "petro_sync_total_ultima_execucao", "gauge",
            "Total encontrado no ultimo sync_log do tipo.",
            [
                f'petro_sync_total_ultima_execucao{{tipo="{_lbl(t)}"}} {tot}'
                for t, _i, _e, _n, tot in sync
            ],
        )

    return "\n".join(out) + "\n"


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            checks = {"redis": _check_redis(), "db": _check_db(), "beat": _check_beat()}
            ok = all(checks.values())
            corpo = json.dumps({"status": "ok" if ok else "degraded", "checks": checks}).encode()
            self.send_response(200 if ok else 503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(corpo)
            return
        if self.path == "/metrics":
            try:
                corpo = _render_metrics().encode()
            except Exception:  # noqa: BLE001 - o scrape nunca derruba o servidor
                corpo = b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.end_headers()
            self.wfile.write(corpo)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args) -> None:  # silencia o log ruidoso do healthcheck
        return


if __name__ == "__main__":
    # Threaded: /metrics (consultas a Redis/Postgres) não bloqueia o /healthz.
    ThreadingHTTPServer(("0.0.0.0", 8080), _Handler).serve_forever()
