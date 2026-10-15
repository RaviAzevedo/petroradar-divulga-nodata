"""
Tasks Celery do worker on-prem do Petro Radar.

Estrategia estranguladora:
  - As tasks ``cron_trigger`` DISPARAM os endpoints ``/api/cron/<nome>`` que ja
    existem no Next.js (autenticados por CRON_SECRET) — a logica de negocio segue
    no app e migra para o FastAPI por ondas.
  - As tasks ``transparencia_*`` rodam os jobs de coleta do Portal da
    Transparencia. Os modulos importam playwright/psycopg2, que SO existem na
    imagem do worker — por isso os imports sao LAZY DENTRO de cada task.
  - ``embedding_reindex_acervo`` delega ao modulo ``indexer`` (tambem lazy).
  - ``retencao_expurgo`` (gap #13) e NOVA.

Idempotencia/anti-duplicidade (gap #9): cada task pega um lock distribuido no
Redis (SET NX EX) antes de rodar.
"""

from __future__ import annotations

import os
import logging
import time

import httpx
import redis as redislib

from celery_app import app

log = logging.getLogger("petro_radar.worker")


@app.task(name="tasks.beat_heartbeat")
def beat_heartbeat() -> dict:
    """Heartbeat de liveness do par beat+worker (lido por healthz.py:_check_beat).
    Agendado a cada 1 min; se o beat parar de agendar OU o worker de consumir, a
    chave envelhece e o /healthz vira 503 (gap do healthcheck so-Redis)."""
    try:
        _redis.set("worker:beat:heartbeat", str(time.time()), ex=900)
    except Exception:  # noqa: BLE001
        pass
    return {"hb": "ok"}

APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://web:3000")
BFF_BASE_URL = os.environ.get("BFF_BASE_URL", "http://bff:8000")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/1")

_redis = redislib.from_url(REDIS_URL)


# ── Lock distribuido (Redlock simples) ───────────────────────────────────────
class _Lock:
    """Lock best-effort no Redis: SET chave NX EX ttl. Solta no fim."""

    def __init__(self, nome: str, ttl: int = 600) -> None:
        self.key = f"lock:worker:{nome}"
        self.ttl = ttl
        self.ok = False

    def __enter__(self) -> bool:
        self.ok = bool(_redis.set(self.key, "1", nx=True, ex=self.ttl))
        return self.ok

    def __exit__(self, *exc) -> None:
        if self.ok:
            _redis.delete(self.key)


# ── Crons: dispara /api/cron/<nome> no Next OU no BFF (estrangulador) ─────────
def _cron_base_url() -> tuple[str, str]:
    """Resolve o alvo dos crons pela env CRON_TARGET (flip H3, rollback em 1 env):
      - "web" (default): Next.js em APP_BASE_URL (http://web:3000)
      - "bff":           FastAPI em BFF_BASE_URL (http://bff:8000) — o BFF espelha
                         os MESMOS paths /api/cron/<nome> (sem prefixo extra).
    Valor desconhecido cai no default "web" (fail-safe) com warning no log.
    Retorna (alvo, base_url)."""
    alvo = os.environ.get("CRON_TARGET", "web").strip().lower() or "web"
    if alvo == "bff":
        return "bff", BFF_BASE_URL
    if alvo != "web":
        log.warning("CRON_TARGET=%r desconhecido — usando 'web' (rollback seguro)", alvo)
    return "web", APP_BASE_URL


@app.task(name="tasks.cron_trigger", bind=True, max_retries=3, default_retry_delay=60)
def cron_trigger(self, nome: str) -> dict:
    """Chama GET {base}/api/cron/<nome> com CRON_SECRET. Retry x3.
    O alvo (web|bff) é decidido POR EXECUÇÃO via CRON_TARGET (ver _cron_base_url)."""
    with _Lock(f"cron:{nome}", ttl=900) as got:
        if not got:
            log.info("cron %s pulado (lock ocupado)", nome)
            return {"cron": nome, "skipped": "locked"}
        alvo, base = _cron_base_url()
        log.info("cron %s: alvo=%s (%s)", nome, alvo, base)
        url = f"{base}/api/cron/{nome}"
        headers = {
            "Authorization": f"Bearer {CRON_SECRET}",
            "x-cron-secret": CRON_SECRET,
        }
        try:
            r = httpx.get(url, headers=headers, timeout=300)
            r.raise_for_status()
            log.info("cron %s OK (%s)", nome, r.status_code)
            return {"cron": nome, "target": alvo, "status": r.status_code}
        except Exception as exc:  # noqa: BLE001
            log.warning("cron %s falhou: %s", nome, exc)
            raise self.retry(exc=exc)


# ── Coleta (jobs que sobem Chromium) ─────────────────────────────────────────
# A5 (auditoria 02/07): limites de tempo POR TASK de scraping (via decorator) —
# NAO globais no app Celery, porque tasks legitimamente longas (ex.:
# embedding_reindex_acervo em modo bootstrap) podem passar de 1h. O lock
# distribuido tem TTL >= time_limit (3900 > 3600): o lock nunca expira com a
# task ainda viva.
SCRAPING_TIME_LIMIT = 3600        # hard limit — worker mata a task (SIGKILL)
SCRAPING_SOFT_TIME_LIMIT = 3300   # SoftTimeLimitExceeded 5 min antes (cleanup)
SCRAPING_LOCK_TTL = 3900          # >= time_limit — sem janela de lock orfao

# A3: autoretry LIMITADO nas tasks de scraping. Com acks_late o retry e seguro
# aqui pois e EXPLICITO e limitado (1 retentativa, 30 min depois — janela para
# o bloqueio Akamai/instabilidade transitoria passar). A task que esgotar o
# retry fica FAILURE (visivel no flower/result backend), nao SUCCESS.
SCRAPING_TASK_KW = dict(
    autoretry_for=(Exception,),
    max_retries=1,
    default_retry_delay=1800,
    time_limit=SCRAPING_TIME_LIMIT,
    soft_time_limit=SCRAPING_SOFT_TIME_LIMIT,
)


def _grava_sync_log_falha(tipo: str, exc: Exception) -> None:
    """A3: registra a falha da task em sync_log (erros=1) — antes o except de
    _scrape engolia a excecao e a coleta quebrada ficava INVISIVEL no painel
    de saude (que deriva os tipos de sync_log). Mesmo esquema/colunas usados
    por db_util.registrar_sync_log. Conexao propria com commit; qualquer erro
    AQUI e engolido para nao mascarar a excecao original do scraping."""
    if not DATABASE_URL:
        return
    try:
        import psycopg2  # import tardio (deps da imagem do worker)
        conn = psycopg2.connect(DATABASE_URL)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO sync_log (tipo, total_encontradas, novas, atualizadas, erros, detalhes, executado_em)
                    VALUES (%s, 0, 0, 0, 1, %s, NOW())
                    """,
                    (tipo, f"FALHA na task do worker: {str(exc)[:500]}"),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as log_exc:  # noqa: BLE001
        log.warning("sync_log de falha (%s) nao gravado: %s", tipo, log_exc)


def _scrape(nome: str, fn, ttl: int = SCRAPING_LOCK_TTL, tipo_log: str | None = None) -> dict:
    """Roda `fn()` sob lock distribuido (gap #9). `fn` ja faz os imports LAZY do
    scraper (playwright/psycopg2 so existem na imagem do worker). Normaliza o
    retorno: dict do scraper -> mesclado no resultado; None -> status 'ok'.

    A3: falha NAO e mais engolida — grava sync_log com erros=1 (tipo_log) e
    RE-RAISE para a task ficar FAILURE e o autoretry limitado do decorator
    (SCRAPING_TASK_KW) agir. O lock e solto no __exit__ mesmo com excecao,
    entao a retentativa (30 min depois) consegue readquiri-lo."""
    with _Lock(f"scraping:{nome}", ttl=ttl) as got:
        if not got:
            return {"job": nome, "skipped": "locked"}
        try:
            res = fn()
            log.info("scraping %s OK: %s", nome, res)
            if isinstance(res, dict):
                return {"job": nome, **res}
            return {"job": nome, "status": "ok"}
        except Exception as exc:  # noqa: BLE001
            log.error("scraping %s ERRO: %s", nome, exc)
            if tipo_log:
                _grava_sync_log_falha(tipo_log, exc)
            raise


def _acervo_chunks_vazio() -> bool:
    """True se acervo_chunks nao tem nenhuma linha (estado pos-migration 0015)."""
    if not DATABASE_URL:
        return False
    import psycopg2  # import tardio (deps do worker)
    try:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM acervo_chunks")
                return (cur.fetchone()[0] or 0) == 0
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao foi possivel contar acervo_chunks: %s", exc)
        return False


def _acervo_index_bootstrap(max_passes: int = 300) -> dict:
    """BOOTSTRAP do acervo VAZIO: chama GET /api/cron/acervo-index repetidamente
    (cada chamada processa um batch ate o budget) ate DRENAR as fontes — definido
    como 2 passadas seguidas com stats.fontesIndexadas == 0. E o cron que CRIA os
    chunks (texto + embedding inline); reembed_acervo (NULL-based) nao serve aqui."""
    url = f"{APP_BASE_URL}/api/cron/acervo-index"
    headers = {"Authorization": f"Bearer {CRON_SECRET}", "x-cron-secret": CRON_SECRET}
    passes = 0
    vazias = 0
    total_fontes = 0
    total_chunks = 0
    while passes < max_passes:
        passes += 1
        try:
            r = httpx.get(url, headers=headers, timeout=600)
            r.raise_for_status()
            data = r.json()
        except Exception as exc:  # noqa: BLE001
            return {"status": "erro", "modo": "bootstrap", "passes": passes, "detalhe": str(exc)[:200]}
        stats = data.get("stats") or {}
        n = stats.get("fontesIndexadas", 0) or 0
        total_fontes += n
        total_chunks += stats.get("chunksGerados", 0) or 0
        if n == 0:
            vazias += 1
            if vazias >= 2:  # drenado
                break
        else:
            vazias = 0
    return {
        "status": "ok", "modo": "bootstrap", "passes": passes,
        "fontes_indexadas": total_fontes, "chunks_gerados": total_chunks,
    }


@app.task(name="tasks.embedding_reindex_acervo")
def embedding_reindex_acervo() -> dict:
    """(Re)popula/re-embedda o acervo (BGE-m3 local, vector(1024)).

    DUAS situacoes (gap de estrategia corrigido):
      (a) acervo_chunks VAZIO (pos-0015 / go-live): indexer.reembed_acervo so
          processa `embedding IS NULL` — numa tabela vazia NAO HA chunk, logo nao
          popularia nada. Quem CRIA os chunks (texto + embedding inline) e o cron
          acervo-index. Entao fazemos BOOTSTRAP: loop do cron ate drenar as fontes.
      (b) acervo_chunks NAO-vazio (troca de modelo sem truncate): reembed_acervo
          re-embedda os chunks existentes.
    """
    # C3: o modo BOOTSTRAP (acervo vazio no go-live) faz ate 300 passadas de
    # httpx.get(timeout=600) e pode rodar HORAS — mais que o antigo ttl=3600s. Se
    # o lock expirasse com a task viva, um 2o disparo (redeploy load-and-run.sh ou
    # `celery call` manual) rodaria EM PARALELO no worker geral (concurrency=2),
    # duplicando trabalho e martelando o embeddings-local/Postgres. TTL de 8h
    # cobre o pior caso do bootstrap (a task nao tem time_limit de proposito).
    with _Lock("embedding_reindex_acervo", ttl=8 * 3600) as got:
        if not got:
            return {"skipped": "locked"}
        try:
            if _acervo_chunks_vazio():
                log.info("acervo_chunks vazio -> BOOTSTRAP via cron acervo-index")
                return _acervo_index_bootstrap()
            import indexer  # import tardio
            res = indexer.reembed_acervo()
            log.info("embedding_reindex_acervo OK: %s", res)
            if isinstance(res, dict):
                return res
            return {"status": "ok"}
        except Exception as exc:  # noqa: BLE001
            log.error("embedding_reindex_acervo ERRO: %s", exc)
            return {"status": "erro", "detalhe": str(exc)[:200]}


# ── Retencao / expurgo LGPD (NOVO — gap #13) ──────────────────────────────────
# Politica inicial (alinhar com juridico/DPO e CONFIRMAR nomes de coluna no schema
# real antes de ativar — algumas tabelas usam created_at/data_evento).
# Nomes de coluna de data CONFERIDOS contra o schema real (information_schema):
#   audit_log.criado_em | sync_log.EXECUTADO_EM | cnpj_status_log.CHECADO_EM |
#   participacoes_notificacoes.criado_em | consultas_certidoes.TENTATIVA_EM |
#   import_jobs.FINALIZADO_EM. (sync_log/cnpj_status_log usavam o nome errado.)
_RETENCAO_SQL = [
    ("audit_log", "DELETE FROM audit_log WHERE criado_em < now() - interval '12 months'"),
    ("sync_log", "DELETE FROM sync_log WHERE executado_em < now() - interval '90 days'"),
    ("cnpj_status_log", "DELETE FROM cnpj_status_log WHERE checado_em < now() - interval '2 years'"),
    ("participacoes_notificacoes",
     "DELETE FROM participacoes_notificacoes WHERE lida = true AND criado_em < now() - interval '90 days'"),
    # LGPD §8.3: anonimiza o payload de certidoes antigas (mantem a linha p/ auditoria).
    ("consultas_certidoes",
     "UPDATE consultas_certidoes SET payload_resposta = NULL WHERE tentativa_em < now() - interval '6 months' AND payload_resposta IS NOT NULL"),
    # Jobs de import concluidos ha mais de 90 dias.
    ("import_jobs", "DELETE FROM import_jobs WHERE finalizado_em IS NOT NULL AND finalizado_em < now() - interval '90 days'"),
    # LGPD (auditoria 02/07, achado #4): ANONIMIZA (nunca DELETA — ha FKs) contas
    # desativadas ha 180+ dias. O filtro usa users.desativado_em (timestamptz,
    # migration 0017; preenchido pelo endpoint de desativacao) — o proxy antigo
    # por criado_em anonimizaria conta ANTIGA desativada ONTEM. Exigir
    # desativado_em IS NOT NULL tambem poupa contas desativadas ANTES da 0017
    # (coluna NULL) ate um admin re-registrar a desativacao.
    # email -> anon+<id>@removido.local (unico por id, evita colisao com o UNIQUE
    # de email); nome -> "Usuario removido". Idempotente: pula quem ja esta anonimo.
    ("users",
     "UPDATE users SET email = 'anon+' || id::text || '@removido.local', nome = 'Usuário removido' "
     "WHERE ativo = false AND desativado_em IS NOT NULL "
     "AND desativado_em < now() - interval '180 days' "
     "AND email NOT LIKE 'anon+%@removido.local'"),
]


# Converte cada DELETE/UPDATE da politica no SELECT count(*) equivalente
# (mesma clausula WHERE) para o modo DRY-RUN contar sem tocar nos dados.
def _retencao_sql_dry(sql: str) -> str:
    if sql.upper().startswith("DELETE FROM"):
        return "SELECT count(*) FROM" + sql[len("DELETE FROM"):]
    # UPDATE <tabela> SET ... WHERE <cond>  ->  SELECT count(*) FROM <tabela> WHERE <cond>
    cabeca, _, resto = sql.partition(" SET ")
    tabela = cabeca[len("UPDATE "):].strip()
    _, _, cond = resto.partition(" WHERE ")
    return f"SELECT count(*) FROM {tabela} WHERE {cond}"


@app.task(name="tasks.retencao_expurgo")
def retencao_expurgo() -> dict:
    """Expurga registros antigos conforme politica de retencao LGPD (diario 03:00 UTC).

    TRAVA DE SEGURANCA (WP05 §retencao / decisao pendente do DPO): por padrao roda
    em DRY-RUN — apenas CONTA o que seria expurgado (SELECT count(*)) e loga, sem
    deletar/anonimizar NADA. O expurgo real so executa com RETENCAO_DRY_RUN=0
    explicito no ambiente, apos aprovacao juridica/DPO.
    """
    if not DATABASE_URL:
        return {"erro": "DATABASE_URL ausente"}
    import psycopg  # import tardio (so no worker de manutencao)

    dry_run = os.getenv("RETENCAO_DRY_RUN", "1").strip().lower() not in ("0", "false", "no")
    resultado: dict[str, int | str | bool] = {"dry_run": dry_run}
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        for tabela, sql in _RETENCAO_SQL:
            try:
                if dry_run:
                    cur = conn.execute(_retencao_sql_dry(sql))
                    qtd = int(cur.fetchone()[0])
                    resultado[tabela] = qtd
                    log.info("retencao [DRY-RUN] %s: %s linhas SERIAM expurgadas", tabela, qtd)
                else:
                    cur = conn.execute(sql)
                    resultado[tabela] = cur.rowcount
                    log.info("retencao %s: %s linhas expurgadas", tabela, cur.rowcount)
            except Exception as exc:  # noqa: BLE001
                log.warning("retencao %s falhou: %s", tabela, exc)
                resultado[tabela] = -1
    if dry_run:
        log.info("retencao: DRY-RUN concluido (nada expurgado). Ative com RETENCAO_DRY_RUN=0 apos aprovacao do DPO.")
    return resultado


# ── Catch-up de syncs parados (auto-recuperacao apos downtime do Docker) ──────
# Limite de horas sem coleta por tipo de sync_log. Quando a stack fica dias parada e volta, o beat NAO
# reprocessa o backlog (options.expires descarta as msgs velhas — ver
# beat_schedule.py "ANTI-CATCH-UP"). Esta task fecha essa lacuna SEM tempestade:
# enfileira NO MAXIMO UMA execucao por tipo cujo gap (now - ultimo sync_log de
# SUCESSO; ver A1 no SQL) passou do limite. NAO conflita com o anti-catch-up
# (que evita re-rodar o backlog ENFILEIRADO); disparamos 1 run fresco por tipo.
# ESPELHOS desta tabela (atualize os CINCO juntos):
#   app/src/lib/observability/scraper-health.ts   <- FONTE do lado Next
#   app/src/app/api/cron/sync-monitor/route.ts     (importa da fonte)
#   bff/app/routers/migrated/admin_saude_scraper.py
#   bff/app/routers/migrated/cron_sync_monitor.py
#   worker/tasks.py (CATCHUP_LIMITES_HORAS) e worker/healthz.py
# Valores de 06/08/2026 (calendario 24/7). O catchup roda de 30 em 30 min e o
# monitor so 4x/dia, entao na pratica o catchup CURA antes de o alerta reclamar.
CATCHUP_LIMITES_HORAS: dict[str, int] = {
    "transparencia": 30,
}
# tipo de sync_log -> (task produtora, kwargs, fila).
CATCHUP_TASKS: dict[str, tuple[str, dict, str]] = {
    # A3: transparencia_valores sobe Chromium -> fila 'scraping' (concurrency=1),
    # coerente com o task_routes de celery_app.py (antes ia p/ 'default').
    "transparencia": ("tasks.transparencia_valores", {}, "scraping"),
}
# Cooldown por tipo (s): enquanto valido, o reconciliador NAO redispara o mesmo
# tipo — evita empilhar N copias de uma varredura ainda na fila/rodando.
CATCHUP_COOLDOWN_SEG: dict[str, int] = {
    "transparencia": 3600,
}
# A4: a task transparencia_valores NAO e gated por env (so a ENTRADA do beat e —
# ver beat_schedule.py). Sem isto, o catch-up (boot + a cada 30min) dispararia
# transparencia mesmo com TRANSPARENCIA_ENABLED=0, tentando egress p/ o Portal
# da Transparencia num deploy air-gapped. Espelha BYTE-A-BYTE o gate do beat
# (beat_schedule.py usa .strip() SEM .lower() -> mantemos igual p/ nao divergir:
# se um dia divergissem, TRANSPARENCIA_ENABLED=FALSE agendaria no beat mas nao
# no catch-up, ou vice-versa).
if os.environ.get("TRANSPARENCIA_ENABLED", "1").strip() in ("0", "false", "no"):
    for _d in (CATCHUP_TASKS, CATCHUP_LIMITES_HORAS, CATCHUP_COOLDOWN_SEG):
        _d.pop("transparencia", None)


@app.task(name="tasks.catchup_stale_syncs")
def catchup_stale_syncs(force: bool = False) -> dict:
    """Reconciliador de gap dos scrapers — auto-recuperacao "sempre atualizado".

    Le o ultimo ``sync_log`` de cada tipo monitorado e, para os que passaram do
    limite (CATCHUP_LIMITES_HORAS), enfileira UMA execucao da task produtora.
    Roda no BOOT (worker/start.sh, logo apos religar o Docker) e a cada 30 min
    (beat) — entao, quando a stack volta apos ficar parada, a base se atualiza
    SOZINHA, sem o operador precisar clicar "Reclassificar/Sincronizar" e SEM a
    tempestade de backlog do anti-catch-up. ``force=True`` ignora gap e cooldown
    (dispara TODOS os tipos) — usado para o disparo manual "rode todos agora".

    Idempotente: (a) lock global curto evita 2 reconciliadores juntos (boot+beat);
    (b) cooldown por tipo no Redis evita re-enfileirar o mesmo tipo enquanto a
    execucao anterior ainda esta na fila/rodando; (c) cada task produtora ainda
    tem seu proprio lock distribuido em _scrape.
    """
    if not DATABASE_URL:
        return {"erro": "DATABASE_URL ausente"}
    with _Lock("catchup_stale_syncs", ttl=300) as got:
        if not got:
            return {"skipped": "locked"}

        import psycopg2  # import tardio (deps da imagem do worker)
        horas_por_tipo: dict[str, float | None] = {}
        try:
            conn = psycopg2.connect(DATABASE_URL)
            try:
                with conn.cursor() as cur:
                    # A1: gap medido sobre o ultimo run que NAO foi FALHA de task.
                    # ATENCAO: sync_log.erros e um CONTADOR de falhas POR-ITEM de
                    # runs bem-sucedidos (scraping de centenas de itens quase sempre
                    # tem erros>0), NAO um flag de falha-da-task. Filtrar por erros=0
                    # descartaria runs de sucesso-parcial e o tipo aparentaria stale
                    # eterno -> catch-up redisparando scraper pesado. Falha REAL de
                    # task e gravada por _grava_sync_log_falha com detalhes iniciando
                    # em "FALHA na task do worker:" — e SO essas que excluimos. Tipo
                    # so-com-falha -> FILTER NULL -> horas None -> stale (dispara).
                    #
                    # psycopg2: NENHUM comentario dentro da string SQL. O paramstyle
                    # e "%s" e o driver varre a string CRUA atras de "%" (ignora os
                    # comentarios "--" do SQL); um "%" solto (ou um "%s" no texto)
                    # vira placeholder e quebra com "tuple index out of range". Por
                    # isso o LIKE escapa como "%%" (literal %) e o SQL fica sem
                    # comentarios. (Esta explicacao mora aqui, em comentario Python.)
                    cur.execute(
                        """
                        SELECT tipo,
                               EXTRACT(EPOCH FROM (
                                   now() - max(executado_em) FILTER (
                                       WHERE coalesce(detalhes, '') NOT LIKE 'FALHA na task do worker:%%'
                                   )
                               )) / 3600.0
                        FROM sync_log
                        WHERE tipo = ANY(%s)
                        GROUP BY tipo
                        """,
                        (list(CATCHUP_TASKS.keys()),),
                    )
                    for tipo, horas in cur.fetchall():
                        horas_por_tipo[tipo] = float(horas) if horas is not None else None
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001
            log.error("catchup: leitura de sync_log falhou: %s", exc)
            return {"erro": str(exc)[:200]}

        disparadas: dict[str, str] = {}
        pulados: dict[str, str] = {}
        for tipo, (task_name, kwargs, fila) in CATCHUP_TASKS.items():
            horas = horas_por_tipo.get(tipo)  # ausente/None = nunca rodou = stale
            limite = CATCHUP_LIMITES_HORAS.get(tipo)
            stale = force or horas is None or (limite is not None and horas >= limite)
            if not stale:
                pulados[tipo] = f"ok ({horas:.1f}h < {limite}h)" if horas is not None else "ok"
                continue
            cooldown = CATCHUP_COOLDOWN_SEG.get(tipo, 3600)
            if not force and not _redis.set(
                f"catchup:cooldown:{tipo}", "1", nx=True, ex=cooldown
            ):
                pulados[tipo] = "cooldown (execucao recente ainda em curso)"
                continue
            try:
                # expires = cooldown: se nao consumida na janela, e descartada e
                # o proximo tick reconcilia de novo (coerente com o anti-catch-up).
                app.send_task(task_name, kwargs=kwargs, queue=fila, expires=cooldown)
                disparadas[tipo] = f"{horas:.1f}h" if horas is not None else "nunca"
                log.info(
                    "catchup: %s stale (%s, limite %sh) -> %s enfileirada (fila=%s)",
                    tipo, disparadas[tipo], limite, task_name, fila,
                )
            except Exception as exc:  # noqa: BLE001
                log.error("catchup: falha ao enfileirar %s: %s", task_name, exc)
                pulados[tipo] = f"erro: {str(exc)[:120]}"
                _redis.delete(f"catchup:cooldown:{tipo}")  # solta p/ re-tentar no proximo tick

        resumo = {
            "disparadas": disparadas,
            "pulados": pulados,
            "verificados": list(CATCHUP_TASKS.keys()),
            "force": force,
        }
        log.info("catchup concluido: %s", resumo)
        return resumo


@app.task(name="tasks.transparencia_valores", **SCRAPING_TASK_KW)
def transparencia_valores() -> dict:
    """Enriquece resultados com o valor REAL do contrato (Portal da Transparência).

    Disputas FECHADAS têm valores simbólicos no Petronect (R$ 0,94 = ranking);
    o valor real sai no Portal da Transparência após a assinatura, com
    processo = nº da licitação (join direto). Beat gated TRANSPARENCIA_ENABLED.
    Lote pequeno por execução (TRANSPARENCIA_BATCH, default 30) + pausa entre
    consultas — mesma etiqueta anti-bulk do Petronect."""
    def _job() -> dict:
        import transparencia_job  # import tardio (playwright/psycopg2 da imagem)
        return transparencia_job.run_transparencia()
    return _scrape("transparencia_valores", _job, tipo_log="transparencia")


@app.task(name="tasks.transparencia_sweep_cnpj", **SCRAPING_TASK_KW)
def transparencia_sweep_cnpj() -> dict:
    """F3: histórico ALL-TIME de contratos por CNPJ de interesse (Transparência)
    → transparencia_contratos. Semanal (beat, gated TRANSPARENCIA_ENABLED)."""
    def _job() -> dict:
        import transparencia_sweep
        return transparencia_sweep.run_sweep("cnpj")
    return _scrape("transparencia_sweep_cnpj", _job, ttl=3600, tipo_log="transparencia")


@app.task(name="tasks.transparencia_sweep_objeto", **SCRAPING_TASK_KW)
def transparencia_sweep_objeto() -> dict:
    """F4: universo de renovações por termos de objeto (Transparência)
    → transparencia_contratos (prospecção). Semanal (beat, gated)."""
    def _job() -> dict:
        import transparencia_sweep
        return transparencia_sweep.run_sweep("objeto")
    return _scrape("transparencia_sweep_objeto", _job, ttl=3600, tipo_log="transparencia")


@app.task(name="tasks.transparencia_sweep_adjudicacoes", **SCRAPING_TASK_KW)
def transparencia_sweep_adjudicacoes() -> dict:
    """Vencedores recentes: contratos com INÍCIO de vigência nos últimos N meses
    (licitação ganha) → transparencia_contratos origem='adjudicacao'.
    Alimenta a visão "Vencedores recentes" da Prospecção. Semanal (beat, gated).

    Descobre fornecedores que a coleta nativa nunca viu — ela só traz
    licitações que casam com os perfis de interesse, então os maiores vencedores
    de EPC não estavam na base. Os CNPJs novos passam a ser
    varridos pelo transparencia_sweep_cnpj no domingo seguinte, montando o
    histórico do parceiro em potencial."""
    def _job() -> dict:
        import transparencia_sweep
        return transparencia_sweep.run_sweep("adjudicacoes")
    return _scrape("transparencia_sweep_adjudicacoes", _job, ttl=3600, tipo_log="transparencia")


@app.task(name="tasks.transparencia_licitacoes", **SCRAPING_TASK_KW)
def transparencia_licitacoes() -> dict:
    """F6: descoberta SUPLEMENTAR de licitações via módulo Licitações do Portal
    da Transparência (EXPORT XLSX dos últimos N meses) → transparencia_licitacoes.
    Cruza com licitacoes.numero (no_banco) para revelar a LACUNA de cobertura da
    coleta nativa. Diário (beat, gated TRANSPARENCIA_ENABLED)."""
    def _job() -> dict:
        import transparencia_licitacoes_job
        return transparencia_licitacoes_job.run()
    return _scrape("transparencia_licitacoes", _job, ttl=3600, tipo_log="transparencia")


@app.task(name="tasks.transparencia_aditivos", **SCRAPING_TASK_KW)
def transparencia_aditivos() -> dict:
    """F2: aditivos dos contratos revelados (Transparência) → contrato_dados +
    corrige vigência efetiva (aditivo de prazo = renovação adiada). Semanal."""
    def _job() -> dict:
        import transparencia_aditivos as ta
        return ta.run()
    return _scrape("transparencia_aditivos", _job, ttl=3600, tipo_log="transparencia")


