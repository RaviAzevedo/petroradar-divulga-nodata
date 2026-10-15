"""
Agendamento (Celery beat) do worker on-prem.

TODOS os horarios em UTC (celery_app.py usa timezone="UTC") -> paridade com o
agendador time-based que este beat substituiu.

Confiabilidade (gap #9): celery_app tem task_acks_late + reject_on_worker_lost;
cada task pega lock distribuido no Redis (tasks._Lock) -> sem perda no restart
nem duplicidade com replicas.

ANTI-CATCH-UP (2026-07-02): TODA entrada tem "options.expires". O broker Redis
tem AOF ligado — se a stack fica dias parada, as mensagens enfileiradas
sobrevivem e, no proximo `up`, o worker executava TODO o backlog de uma vez
(tempestade de scraping/crons observada em dev).
Com `expires`, mensagem nao consumida dentro da janela e DESCARTADA pelo
worker (Discarded/Expired) — a proxima execucao agendada acontece no horario
normal. Janela = ~metade do intervalo entre execucoes (min 55s, max 6h).
"""

from __future__ import annotations

import os

from celery.schedules import crontab

BEAT_SCHEDULE = {

    # ── Crons do app (disparam /api/cron/<nome> via CRON_SECRET) — UTC ────────
    "cron-prazos": {
        "task": "tasks.cron_trigger", "args": ("prazos",),
        "schedule": crontab(minute=0, hour=11),
        "options": {"expires": 6 * 3600},
    },
    "cron-vencimentos": {
        "task": "tasks.cron_trigger", "args": ("vencimentos",),
        "schedule": crontab(minute=0, hour=12),
        "options": {"expires": 6 * 3600},
    },
    "cron-sync-monitor": {
        "task": "tasks.cron_trigger", "args": ("sync-monitor",),
        "schedule": crontab(minute=0, hour="10,16,20,23"),  # logo apos cada janela
        "options": {"expires": 3 * 3600},
    },
    "cron-saude-contratos": {
        "task": "tasks.cron_trigger", "args": ("saude-contratos",),
        "schedule": crontab(minute=30, hour=13),
        "options": {"expires": 6 * 3600},
    },
    "cron-cnpj-watch": {
        "task": "tasks.cron_trigger", "args": ("cnpj-watch",),
        "schedule": crontab(minute=0, hour=9, day_of_week=1),  # seg 09:00 UTC
        "options": {"expires": 6 * 3600},
    },
    "cron-triagem-semantica": {
        "task": "tasks.cron_trigger", "args": ("triagem-semantica",),
        "schedule": crontab(minute=15),  # HH:15 toda hora
        "options": {"expires": 1800},       # horario -> janela 30 min
    },
    "cron-convocacao-watch": {
        "task": "tasks.cron_trigger", "args": ("convocacao-watch",),
        "schedule": crontab(minute="25,55"),
        "options": {"expires": 900},
    },
    "cron-acervo-index": {
        "task": "tasks.cron_trigger", "args": ("acervo-index",),
        "schedule": crontab(minute=0, hour=4),  # 04:00 diario (budget)
        "options": {"expires": 6 * 3600},
    },
    "cron-digest-executivo": {
        "task": "tasks.cron_trigger", "args": ("digest-executivo",),
        "schedule": crontab(minute=0, hour=8, day_of_week=1),  # seg 08:00 UTC
        "options": {"expires": 6 * 3600},
    },
    # Digest de licitacoes por filtro de e-mail (0026): 3x/dia apos as janelas
    # de scraping (12/18 UTC) — a cadencia POR ASSINATURA (tempo-real/diario/
    # semanal) e decidida dentro da rota; a rodada so entrega o "tick".
    # EXCECAO DE FLIP: este cron e WEB-ONLY (Graph sendMail so existe no Next);
    # com CRON_TARGET=bff ele daria 404 — manter no web ou espelhar antes.
    # Extracao do texto dos anexos: deixa o edital MASTIGADO antes de alguem
    # pedir a analise. Sem isto a rota de analise caia em licitacoes.objeto (70
    # caracteres em media) e gerava briefing de 12 secoes sobre nada.
    #
    # FILA: cron_trigger roteia "tasks.cron_*" para a fila `default`. NAO pode ir
    # para `scraping` (concurrency=1, compartilhada com os scrapes Playwright) —
    # foi esse head-of-line blocking que ja congelou transparencia_contratos
    # por semanas. E nao precisa: baixar anexo e HTTP puro com cookie SAP
    # cacheado, sem Chromium.
    #
    # A cada 20 min, 8 licitacoes por rodada com orcamento de 210s. O backlog
    # relevante fecha em algumas horas; depois
    # disso a rodada so pega o que a coleta trouxe de novo e volta vazia barato.
    "cron-extrair-anexos": {
        "task": "tasks.cron_trigger", "args": ("extrair-anexos",),
        "schedule": crontab(minute="*/20"),
        "options": {"expires": 15 * 60},
    },
    "cron-digest-licitacoes": {
        "task": "tasks.cron_trigger", "args": ("digest-licitacoes",),
        # 07:00 e 13:00 BRT (decisao do dono 07/08/2026). Um e-mail POR PESSOA em
        # cada janela, e so se houver novidade — o ledger garante que a rodada das
        # 13h nao repete o que saiu as 7h.
        "schedule": crontab(minute=0, hour="10,16"),
        "options": {"expires": 3 * 3600},
    },
    "cron-relatorio-mensal": {
        "task": "tasks.cron_trigger", "args": ("relatorio-mensal",),
        "schedule": crontab(minute=0, hour=6, day_of_month=1),  # dia 1 06:00
        "options": {"expires": 6 * 3600},
    },

    # (Crons es-reindex-* REMOVIDOS em 2026-07-02 junto com o Elasticsearch —
    #  a busca usa o Postgres direto; nada mais a reconciliar.)

    # Heartbeat de liveness beat+worker (lido por healthz.py). A cada 1 min.
    "beat-heartbeat": {
        "task": "tasks.beat_heartbeat",
        "schedule": crontab(minute="*"),
        "options": {"expires": 55},         # heartbeat velho e inutil
    },

    # ── Manutencao / retencao LGPD (NOVO — gap #13) ──────────────────────────
    "retencao-expurgo": {
        "task": "tasks.retencao_expurgo",
        "schedule": crontab(minute=0, hour=3),  # diario 03:00 UTC
        "options": {"expires": 6 * 3600},
    },

    # ── Catch-up de gap: auto-recuperacao dos scrapers apos downtime ──────────
    # Reconciliador (tasks.catchup_stale_syncs) que dispara UMA execucao de cada
    # scraper cujo ultimo sync_log passou do limite. Complementa o disparo de
    # BOOT (worker/start.sh, logo apos religar o Docker) — mantem a base "sempre
    # atualizada" mesmo que uma execucao agendada tenha falhado, SEM depender do
    # operador clicar Sincronizar/Reclassificar. Bounded (1 run por tipo) +
    # cooldown por tipo no Redis -> NAO reintroduz a tempestade de backlog que o
    # ANTI-CATCH-UP (options.expires acima) evita. A cada 30 min.
    "catchup-stale-syncs": {
        "task": "tasks.catchup_stale_syncs",
        "schedule": crontab(minute="*/30"),
        "options": {"expires": 25 * 60},   # a cada 30 min -> janela ~25 min
    },
}

# ── Gate da triagem IA (F0 do plano perfis+classificação) ────────────────────
# A triagem semântica exige ANTHROPIC_API_KEY válida; com chave placeholder o
# cron falhava 100% em loop eterno (401 a cada hora nas MESMAS 40 licitações).
# Habilite explicitamente com TRIAGEM_IA_ENABLED=1 quando houver chave real
# (o endpoint /api/cron/triagem-semantica continua existindo e testável).
if os.environ.get("TRIAGEM_IA_ENABLED", "0").strip() not in ("1", "true", "yes"):
    BEAT_SCHEDULE.pop("cron-triagem-semantica", None)

# ── Transparência Petrobras: valores reais de disputas fechadas ──────────────
# Consulta o Portal da Transparência (público, Playwright p/ WAF) e preenche
# valor real + vencedor/metadados do contrato. Diário (ver crontab abaixo).
# DEFAULT LIGADO (dado público, sem chave);
# desligue com TRANSPARENCIA_ENABLED=0 em ambientes air-gapped (exige egress
# p/ sistematransparencia.petrobras.com.br — ver .env.onprem.example).
if os.environ.get("TRANSPARENCIA_ENABLED", "1").strip() not in ("0", "false", "no"):
    BEAT_SCHEDULE["transparencia-valores"] = {
        "task": "tasks.transparencia_valores",
        "schedule": crontab(minute=40, hour=9),
        "options": {"expires": 6 * 3600},
    }
    # Sweeps semanais (domingo):
    # histórico all-time por CNPJ (F3) e universo de renovações por objeto (F4).
    BEAT_SCHEDULE["transparencia-sweep-cnpj"] = {
        "task": "tasks.transparencia_sweep_cnpj",
        "schedule": crontab(minute=10, hour=11, day_of_week=0),
        "options": {"expires": 12 * 3600},
    }
    BEAT_SCHEDULE["transparencia-sweep-objeto"] = {
        "task": "tasks.transparencia_sweep_objeto",
        "schedule": crontab(minute=10, hour=13, day_of_week=0),
        "options": {"expires": 12 * 3600},
    }
    # Vencedores recentes (migration 0027): contratos com INÍCIO de vigência nos
    # últimos N meses = licitações recém-ganhas → prospecção de parceria.
    # Semanal: o contrato leva de 1 a 8 dias para aparecer no portal depois da
    # assinatura (medido via DataLogInclusao), e a janela é móvel de 3 meses —
    # não há o que ganhar rodando diariamente. Domingo 14:10, depois do
    # sweep-objeto, para não concorrer pelo bootstrap Playwright.
    BEAT_SCHEDULE["transparencia-sweep-adjudicacoes"] = {
        "task": "tasks.transparencia_sweep_adjudicacoes",
        "schedule": crontab(minute=10, hour=14, day_of_week=0),
        "options": {"expires": 12 * 3600},
    }
    # F6 — descoberta suplementar de licitações (módulo Licitações da
    # Transparência) → transparencia_licitacoes + no_banco (cobertura do scraper)
    # + ingestão no Explorar. DIÁRIO 11:00 UTC (junto com valores):
    # licitações novas aparecem no dia; carga leve (1 export XLSX + upsert).
    BEAT_SCHEDULE["transparencia-licitacoes"] = {
        "task": "tasks.transparencia_licitacoes",
        "schedule": crontab(minute=0, hour=10),
        "options": {"expires": 12 * 3600},
    }
    # Aditivos dos contratos revelados (F2): corrige vigência efetiva + engorda.
    BEAT_SCHEDULE["transparencia-aditivos"] = {
        "task": "tasks.transparencia_aditivos",
        "schedule": crontab(minute=40, hour=11, day_of_week=0),
        "options": {"expires": 12 * 3600},
    }
