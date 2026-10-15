"""
Celery app do worker on-premise do Petro Radar.

Decisão TI Proponente (19/06): **Celery + Redis** substitui o dispatcher.py
time-based (Railway) e o scraper agendado por GitHub Actions. Ganhos: retries
com backoff, dead-letter, lock distribuído (evita duplicidade em restart),
disparo on-demand e filas por tipo de carga (scraping/embeddings/IA/indexação).

Broker e result-backend = Redis (mesmo container `redis` do compose, db 1).
O agendamento (beat) vive em ``beat_schedule.py``; as tasks em ``tasks.py``.
"""

from __future__ import annotations

import os

from celery import Celery

# Redis db1 dedicado a Celery (db0 = cache/rate-limit do app; db3 = cookies SAP).
BROKER_URL = os.environ.get("CELERY_BROKER_URL") or os.environ.get(
    "REDIS_URL", "redis://redis:6379/1"
)

app = Celery("petro_radar", broker=BROKER_URL, backend=BROKER_URL, include=["tasks"])

app.conf.update(
    # UTC para casar BYTE-A-BYTE com o dispatcher.py de producao (que e UTC).
    # NAO usar America/Sao_Paulo aqui: faria o crontab() interpretar os campos
    # em BRT (UTC-3) e os crons rodariam no horario errado (quebra de paridade).
    timezone="UTC",
    enable_utc=True,
    # Confiabilidade: só confirma a mensagem após concluir (retry seguro se o
    # worker morrer no meio). Crons de prazo fatal (Lei 13.303) não podem sumir.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_track_started=True,
    # Jobs pesados (scraping Playwright, IA, embeddings) — 1 por vez por worker.
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=50,  # recicla processo (evita leak do Chromium)
    # A5 (auditoria 02/07): time limits NAO sao globais de proposito —
    # embedding_reindex_acervo (bootstrap do acervo) pode legitimamente passar
    # de 1h. Os limites (time_limit=3600 / soft_time_limit=3300) sao aplicados
    # POR TASK nas tasks de scraping via decorator (tasks.SCRAPING_TASK_KW);
    # task_routes nao suporta time limits.
    result_expires=3600,
    task_default_queue="default",
    # Roteamento por prefixo de nome da task -> fila dedicada.
    task_routes={
        # A3: transparencia_* tambem sobem Chromium (Playwright) -> mesma fila
        # dedicada 'scraping' (concurrency=1), preservando o invariante do
        # start.sh (C9) "no maximo 1 Chromium vivo". Antes casavam so o
        # task_default_queue='default' (concurrency=2) e 2 podiam rodar juntas
        # -> 2 Chromium concorrentes contra o WAF do Portal + risco de OOM.
        "tasks.transparencia_*": {"queue": "scraping"},
        "tasks.embedding_*": {"queue": "embeddings"},
        "tasks.ia_*": {"queue": "ia"},
        "tasks.retencao_*": {"queue": "manutencao"},
        "tasks.cron_*": {"queue": "default"},
    },
)

# Beat schedule (crons do app + coleta da Transparência + retenção LGPD) carregado de um módulo
# próprio para manter este arquivo enxuto.
from beat_schedule import BEAT_SCHEDULE  # noqa: E402

app.conf.beat_schedule = BEAT_SCHEDULE
