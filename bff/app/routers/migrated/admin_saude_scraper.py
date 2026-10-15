"""Rota migrada (strangler-fig): GET /api/admin/saude-scraper.

Espelho 1:1 de ``src/app/api/admin/saude-scraper/route.ts`` (Next.js) +
``src/lib/observability/scraper-health.ts`` (``getSaudeScraper``) — paridade de
resposta JSON com o BFF FastAPI.

Dashboard de observabilidade do scraper: consolida ``sync_log`` por tipo de sync
(última execução, gap em horas vs. limite, erros) + status global.

  - Auth:    require_admin (apenas ADMIN; espelha ``requireAdmin()`` da rota Next).
  - Método:  GET, read-only.
  - Params:  NENHUM (a rota Next não lê query params).
  - Shape:   ``{ "data": <SaudeScraper> }`` onde SaudeScraper =
             ``{ geradoEm, tipos: [SaudeTipoSync...], statusGlobal,
                 tiposCriticos: [str...], ultimoLogId, ultimoLogEm }``
             e SaudeTipoSync =
             ``{ tipo, ultimaExecucao, horasDesde, limiteHoras, status,
                 erros, totalEncontradas, novas }``.

Detalhes de serialização (paridade JSON com o lado JS):
  - ``executado_em`` (timestamp SEM timezone no schema Drizzle) → o asyncpg
    devolve ``datetime`` naive. PORÉM o lado Next roda com
    ``TZ=America/Sao_Paulo`` e usa node-postgres, cujo parser interpreta o naive
    como WALL-CLOCK NO FUSO DO PROCESSO (São Paulo); ``new Date(...).toISOString()``
    então emite o INSTANTE correspondente em UTC. Por isso interpretamos o naive
    como America/Sao_Paulo (-03:00) e convertemos para UTC em :func:`_to_utc`
    ANTES de formatar/subtrair — tratá-lo como UTC adiantava tudo em 3h.
    ``.toISOString()`` SEMPRE emite UTC com sufixo ``Z`` e milissegundos
    (ex.: ``2026-06-08T12:34:56.789Z``); replicamos esse formato exato em
    :func:`_js_iso` — NÃO usamos ``datetime.isoformat()`` (que daria offset
    diferente / microssegundos).
  - ``horasDesde`` = ``Math.floor((agora - ultima) / 3_600_000)`` — inteiro com
    floor (replicado com ``//`` sobre milissegundos), onde ``ultima`` é o MESMO
    instante UTC que o Next obtém via node-postgres.
  - ``id`` (serial/int), ``erros``/``novas``/``total_encontradas`` → inteiros
    (``Number(x) || 0`` no Next; COALESCE(...,0) na query → nunca NULL).
  - Ordenação dos tipos: piores primeiro (RANK desc), depois ``tipo`` asc
    (localeCompare → comparação lexicográfica de string).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.logging import get_logger
from app.core.security import CurrentUser, require_admin
from app.db.session import get_db

router = APIRouter()

log = get_logger("petro_radar_bff.admin_saude_scraper")


# ── Fuso do processo Next (paridade de TIMEZONE) ───────────────────────────────
#
# ``executado_em`` é ``timestamp WITHOUT TIME ZONE`` (Drizzle). O lado Next roda
# com ``TZ=America/Sao_Paulo`` e usa node-postgres (``pg``): o parser default do
# tipo ``timestamp`` (OID 1114) constrói o ``Date`` interpretando a string
# wall-clock NO FUSO LOCAL DO PROCESSO — ou seja, America/Sao_Paulo. Em seguida
# ``.toISOString()`` emite esse INSTANTE em UTC.
#
# Logo, o naive da coluna NÃO é UTC: é horário de parede de São Paulo. Tratá-lo
# como UTC (bug anterior) deslocava ``ultimaExecucao`` e ``horasDesde`` em
# EXATAMENTE +3h. Aqui interpretamos o naive como America/Sao_Paulo e convertemos
# para UTC, igual ao Next.
#
# São Paulo não observa horário de verão desde 2019 → offset fixo e constante
# de -03:00 para todo timestamp recente (todos os logs aqui são >= 2019). Usamos
# ZoneInfo quando a base tzdata estiver disponível (cobre qualquer edge histórico)
# e caímos para o offset fixo -03:00 quando não estiver (ex.: ``python:3.12-slim``
# sem o pacote ``tzdata``), garantindo o MESMO resultado para o período relevante.
_TZ_SAO_PAULO_FIXO = timezone(timedelta(hours=-3))
try:  # pragma: no cover - depende da presença de tzdata no ambiente
    from zoneinfo import ZoneInfo

    TZ_SAO_PAULO = ZoneInfo("America/Sao_Paulo")
except Exception:  # ZoneInfoNotFoundError / ImportError → offset fixo (-03:00).
    TZ_SAO_PAULO = _TZ_SAO_PAULO_FIXO


def _to_utc(executado_em: datetime | None) -> datetime | None:
    """Naive de São Paulo → ``datetime`` aware-UTC (paridade com ``new Date(...)``).

    O ``pg`` (node-postgres) lê o ``timestamp without time zone`` como wall-clock
    no fuso do processo Next (``America/Sao_Paulo``). Replicamos: anexamos o fuso
    de São Paulo ao naive e convertemos para UTC. Se já vier aware (defensivo),
    apenas normalizamos para UTC.
    """
    if executado_em is None:
        return None
    if executado_em.tzinfo is None:
        return executado_em.replace(tzinfo=TZ_SAO_PAULO).astimezone(timezone.utc)
    return executado_em.astimezone(timezone.utc)


# ── Constantes espelhadas de scraper-health.ts ────────────────────────────────

#: Limite de horas sem sync por tipo — espelha MAX_HORAS_POR_TIPO (scraper-health.ts).
# 2026-07-02: on-prem — adicionado petronect_v2 (pipeline V2 principal, roda
# várias vezes/dia) e removido concluidas_historico (job legado da hospedagem
# anterior, aposentado no on-prem; ficava CRÍTICO eterno sem produtor).
# "resultados" voltou a ter produtor (projeção V2 -> app).
# 2026-07-07: valores DESALINHADOS do Next corrigidos ("todas" 6 e petronect_v2
# 24 eram drift) + "todas" 15→21: janelas de scraping alinhadas em 12:00/18:00
# UTC → gap noturno normal de 18h (ver worker/beat_schedule.py).
# Ajuste 06/08/2026 (calendario 24/7): ~30% acima da maior janela real.
# MESMOS valores de scraper-health.ts e cron_sync_monitor.py.
MAX_HORAS_POR_TIPO: dict[str, int] = {
    "todas": 18,
    "abertas": 24,
    "andamento": 24,
    "concluidas": 24,
    "resultados": 20,
    "circulares": 24,
    "transparencia": 30,
    "petronect_v2": 20,
}

#: Ranking de severidade dos status (espelha RANK em scraper-health.ts).
_RANK: dict[str, int] = {"OK": 0, "RODANDO": 0, "DESCONHECIDO": 1, "ATENCAO": 2, "CRITICO": 3}



#: Lock do worker -> tipo do sync_log (espelha LOCK_PARA_TIPO de scraper-health.ts).
#: As tasks seguram ``lock:worker:scraping:<nome>`` no Redis ENQUANTO rodam; o
#: sync_log so recebe a linha no FIM. Sem ler o lock, um job legitimo de 2h30
#: (circulares completa) aparece como "16h sem coleta" e pinta a tela de vermelho.
LOCK_PARA_TIPO: dict[str, str] = {
    "sync_todas": "todas",
    "sync_circulares": "circulares",
    "v2_stale": "petronect_v2",
    "v2_all_db": "petronect_v2",
    "v2_retry_pending": "petronect_v2",
    "v2_project_resultados": "resultados",
    "transparencia_valores": "transparencia",
    "transparencia_sweep_cnpj": "transparencia",
    "transparencia_sweep_objeto": "transparencia",
    "transparencia_sweep_adjudicacoes": "transparencia",
}


async def _tipos_em_execucao() -> set[str]:
    """Tipos com task de scraping ATIVA agora. Qualquer falha => conjunto vazio
    (o painel volta ao comportamento antigo, nunca quebra por causa do Redis)."""
    import os

    url = os.environ.get("CELERY_BROKER_URL") or os.environ.get("REDIS_URL")
    if not url:
        return set()
    cli = None
    try:
        import redis.asyncio as aioredis

        cli = aioredis.from_url(url, socket_connect_timeout=1.5)
        tipos: set[str] = set()
        for k in await cli.keys("lock:worker:scraping:*"):
            nome = (k.decode() if isinstance(k, bytes) else k).split(":")[-1]
            tipo = LOCK_PARA_TIPO.get(nome)
            if tipo:
                tipos.add(tipo)
        return tipos
    except Exception:
        return set()
    finally:
        if cli is not None:
            try:
                await cli.aclose()
            except Exception:
                pass


def _classifica(horas_desde, limite, erros: int, rodando: bool = False) -> str:
    """Espelha ``classifica`` de scraper-health.ts.

    DESCONHECIDO se limite/horas indefinidos; CRITICO se atingiu o limite;
    ATENCAO se houve erros OU passou de 75% do limite; senão OK.
    """
    # Rodando agora nao e atraso.
    if rodando:
        return "RODANDO"
    if limite is None or horas_desde is None:
        return "DESCONHECIDO"
    if horas_desde >= limite:
        return "CRITICO"
    if erros > 0:
        return "ATENCAO"
    # Aviso quando passou de 75% do limite sem novo sync.
    if horas_desde >= limite * 0.75:
        return "ATENCAO"
    return "OK"


def _js_iso(dt: datetime) -> str:
    """Replica ``new Date(dt).toISOString()`` do JS: UTC, sufixo ``Z``, ms.

    O asyncpg devolve ``executado_em`` (timestamp WITHOUT TIME ZONE) como um
    ``datetime`` naive. O lado Next faz ``new Date(value)`` e ``.toISOString()``.
    Sob ``TZ=America/Sao_Paulo``, o ``pg`` interpreta o naive como wall-clock de
    São Paulo e ``.toISOString()`` emite o INSTANTE correspondente em UTC. Por
    isso convertemos o naive de São Paulo → UTC (:func:`_to_utc`) ANTES de formatar
    — caso contrário a saída ficaria 3h adiantada (bug de timezone corrigido).

    ``geradoEm`` já chega aware-UTC (``datetime.now(tz=utc)``) e passa por
    :func:`_to_utc` sem deslocamento (paridade com ``new Date()`` do mesmo
    instante).

    Formato: 3 casas decimais de milissegundo + ``Z`` (igual ao JS).
    """
    dt = _to_utc(dt).replace(tzinfo=None)
    millis = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
        f".{millis:03d}Z"
    )


@router.get("/api/admin/saude-scraper")
async def get_saude_scraper(
    request: Request,
    user: CurrentUser = Depends(require_admin),
    db=Depends(get_db),
):
    """GET /api/admin/saude-scraper — paridade 1:1 com a rota Next.

    Guard ADMIN (``require_admin``) espelha ``requireAdmin()`` da rota Next.
    Replica ``getSaudeScraper()``: snapshot por tipo + status global, envelopado
    em ``{ "data": ... }`` (como ``NextResponse.json({ data: saude })``).
    """
    # try/except espelha o ``try { const saude = await getSaudeScraper(); ... }
    # catch (e) { log.error(...); return NextResponse.json({ error: ... }, 500) }``
    # da rota Next: em falha de DB devolvemos a MESMA mensagem/shape (sem deixar a
    # exceção cair no middleware global, que emitiria {"error":"Erro interno",
    # "request_id":...}). O guard ``require_admin`` roda fora deste try (como
    # ``requireAdmin()`` no seu próprio try/catch do Next).
    try:
        # ``agora`` (timezone-aware UTC) — base do cálculo de gap e do ``geradoEm``.
        agora = datetime.now(tz=timezone.utc)

        # ── Última execução + métricas por tipo (DISTINCT ON, último log de cada) ──
        # Espelha o SQL cru de getSaudeScraper. COALESCE garante 0 em vez de NULL.
        sql_por_tipo = text(
            """
            SELECT DISTINCT ON (tipo)
                tipo,
                executado_em,
                COALESCE(erros, 0)             AS erros,
                COALESCE(total_encontradas, 0) AS total_encontradas,
                COALESCE(novas, 0)             AS novas
            FROM sync_log
            ORDER BY tipo, executado_em DESC NULLS LAST
            """
        )
        result = await db.execute(sql_por_tipo)
        rows = result.all()

        em_execucao = await _tipos_em_execucao()
        tipos: list[dict] = []
        for r in rows:
            m = r._mapping
            executado_em = m["executado_em"]
            # ``ultima`` aware-UTC p/ subtração. O naive da coluna é wall-clock de
            # São Paulo (paridade com node-postgres sob TZ=America/Sao_Paulo) →
            # convertido para UTC por _to_utc. Isso garante o MESMO instante que o
            # Next usa em ``new Date(...)``, eliminando o desvio de 3h em horasDesde.
            ultima = _to_utc(executado_em)

            if ultima is not None:
                # Math.floor((agora - ultima) / (1000*60*60)) → horas inteiras (floor).
                delta_ms = (agora - ultima).total_seconds() * 1000.0
                horas_desde = int(delta_ms // (1000 * 60 * 60))
            else:
                horas_desde = None

            limite = MAX_HORAS_POR_TIPO.get(m["tipo"])  # None se tipo desconhecido
            erros = int(m["erros"]) or 0
            tipos.append(
                {
                    "tipo": m["tipo"],
                    "ultimaExecucao": _js_iso(executado_em) if executado_em else None,
                    "horasDesde": horas_desde,
                    "limiteHoras": limite,
                    "status": _classifica(horas_desde, limite, erros, m["tipo"] in em_execucao),
                    "rodando": m["tipo"] in em_execucao,
                    "erros": erros,
                    "totalEncontradas": int(m["total_encontradas"]) or 0,
                    "novas": int(m["novas"]) or 0,
                }
            )

        # Ordena: piores primeiro (RANK desc), depois por tipo asc (localeCompare).
        tipos.sort(key=lambda t: (-_RANK[t["status"]], t["tipo"]))

        # statusGlobal: pior status entre os tipos, partindo de "OK" (reduce do Next).
        status_global = "OK"
        for t in tipos:
            if _RANK[t["status"]] > _RANK[status_global]:
                status_global = t["status"]

        tipos_criticos = [t["tipo"] for t in tipos if t["status"] == "CRITICO"]

        # ── Último log global (id + timestamp) para correlação/log ─────────────────
        sql_ultimo = text(
            """
            SELECT id, executado_em
            FROM sync_log
            ORDER BY executado_em DESC
            LIMIT 1
            """
        )
        ultimo_result = await db.execute(sql_ultimo)
        ultimo = ultimo_result.first()

        if ultimo is None:
            ultimo_log_id = None
            ultimo_log_em = None
        else:
            um = ultimo._mapping
            ultimo_log_id = um["id"] if um["id"] is not None else None
            ultimo_log_em = _js_iso(um["executado_em"]) if um["executado_em"] else None

        saude = {
            "geradoEm": _js_iso(agora),
            "tipos": tipos,
            "statusGlobal": status_global,
            "tiposCriticos": tipos_criticos,
            "ultimoLogId": ultimo_log_id,
            "ultimoLogEm": ultimo_log_em,
        }

        # Envelope idêntico ao ``NextResponse.json({ data: saude })``.
        return JSONResponse(content={"data": saude})
    except Exception as e:  # noqa: BLE001 — paridade com o catch (e) do Next.
        # ``log.error("falha ao consolidar saúde do scraper", e)`` + 500 com a
        # mensagem exata e SEM o campo ``request_id`` que o middleware global
        # adicionaria.
        log.error("falha ao consolidar saúde do scraper: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": "Falha ao consolidar saúde do scraper"},
        )
