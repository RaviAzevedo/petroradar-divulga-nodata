"""Rota migrada (estrangulador / strangler-fig): GET /api/cron/digest-executivo.

Espelha 1:1 ``src/app/api/cron/digest-executivo/route.ts`` do app Next.js —
digest executivo semanal por e-mail.

FLUXO DO HANDLER GET (paridade 1:1):
  1. ``autorizarCron(req)`` — se ``CRON_SECRET`` configurado, exige
     ``Authorization: Bearer <CRON_SECRET>``; senão aceita ``x-vercel-cron: 1``.
     Sem autorização → ``NextResponse.json({ error: "Não autorizado" }, 401)``.
  2. Gate gracioso por ``config.crons.digestExecutivo.habilitado``
     (env ``CRON_DIGEST_EXECUTIVO_ENABLED``, default true). Desabilitado →
     ``{ ok: true, skipped: true, motivo: "cron desabilitado" }`` (status 200).
  3. ``getDestinatariosGestao()`` — emails de users ATIVOS com role ∈ {ADMIN,
     LIDER}, filtrando vazios (``.filter(Boolean)``). Vazio →
     ``{ ok: true, enviado: false, motivo: "sem destinatários" }`` (200).
  4. ``Promise.all`` das 4 queries de analytics + a query de famílias CRC:
       - getPerformanceTrimestral(6)   -> _getPerformanceTrimestralImpl
       - getMercado(12)                -> _getMercadoImpl
       - getConcorrencia(3)            -> _getConcorrenciaImpl
       - getOportunidadesPerdidas({ scoreMin: 70, periodoMeses: 1, limit: 5 })
       - familias CRC vencidas/não-aprovadas (isNotNull statusFluxoCrc &
         statusFluxoCrc != 'A', limit 8)
  5. Monta KPIs (4), seções (oportunidades + concorrentes em ascensão),
     alertas CRC; renderiza ``templateDigestExecutivo`` e envia via SMTP
     (``sendEmail`` -> ``app.core.email.send_email``) para os destinatários.
  6. Devolve ``{ ok: true, enviado, destinatarios, kpis, secoes, alertasCrc }``.

Esta réplica reusa A MESMA SQL e o MESMO pós-processamento (toNum/toNumOrNull,
``Math.round`` half-away-from-+Inf, datas ``toISOString`` UTC/ms/"Z") já
estabelecidos nas rotas irmãs de analytics (performance / mercado /
concorrência / oportunidades).

PARIDADE BUG-A-BUG (replicada do Next):
  - ``getMercado`` inclui na query de TOTAIS um subselect com a coluna
    INEXISTENTE ``created_em_dummy``, embrulhado em ``.catch(() => zeros)``. A
    query QUEBRA e os totais caem em ZEROS. Replicamos: a SQL com o subselect
    quebrado é executada; o ``except`` faz rollback e cai para zeros.

Auth do cron (sem sessão): replica ``autorizarCron`` do Next, inclusive o shape
de erro 401 ``{ error: "Não autorizado" }`` (que difere do detail genérico de
``app.core.cron_auth.require_cron``), portanto a checagem é feita INLINE.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.cron_auth import safe_equal
from app.core.email import send_email
from app.db.session import SessionLocal

# Réplicas canônicas (config.ts flag / Math.round / CNPJ) — consolidadas em _shared.
from app.routers.migrated._shared import PROPONENTE_CNPJ, flag as _flag, js_round

router = APIRouter()

# Papéis de gestão (espelha ROLES.ADMIN / ROLES.LIDER de permissions.ts).
ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"

# baseUrl dos templates (templates.ts): NEXTAUTH_URL ?? localhost (via settings).
BASE_URL = settings.nextauth_url or "http://localhost:3000"


# ── Helpers de paridade numérica / datas (espelham queries.ts) ────────────────


def _to_num(v: object) -> float:
    """Espelha ``toNum`` do Next: null/NaN → 0; coage string/Decimal p/ float."""
    if v is None:
        return 0.0
    try:
        n = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(n):
        return 0.0
    return n


def _to_num_or_null(v: object):
    """Espelha ``toNumOrNull`` do Next: null/NaN → null; senão float."""
    if v is None:
        return None
    try:
        n = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if math.isnan(n):
        return None
    return n


# Math.round do JS: canônico de _shared (a cópia local _round_js era idêntica).
_round_js = js_round


def _round1(x: float) -> float:
    """``Math.round(x * 10) / 10`` — 1 casa, semântica JS."""
    return _round_js(x * 10.0) / 10.0


def _round2(x: float) -> float:
    """``Math.round(x * 100) / 100`` — 2 casas, semântica JS."""
    return _round_js(x * 100.0) / 100.0


def _js_num(x):
    """Serializa como o ``JSON.stringify`` do JS: float inteiro-valorado vira int."""
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return x


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, ms, sufixo 'Z')."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _fmt_brl(v: float) -> str:
    """Replica ``v.toLocaleString("pt-BR", {style:"currency", currency:"BRL"})``."""
    inteiro = f"{abs(v):,.2f}"
    inteiro = inteiro.replace(",", "X").replace(".", ",").replace("X", ".")
    sinal = "-" if v < 0 else ""
    return f"{sinal}R$\xa0{inteiro}"


def _fmt_data_br(dt: datetime) -> str:
    """Replica ``date.toLocaleDateString("pt-BR")`` (dd/mm/aaaa)."""
    return f"{dt.day:02d}/{dt.month:02d}/{dt.year:04d}"


def _num_str(v) -> str:
    """Coerção JS de número p/ string em template (``${x}``): inteiros sem .0."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


# ═══════════════════════════════════════════════════════════════════════════
# QUERIES DE ANALYTICS (reusam a SQL/pós-processamento das rotas irmãs)
# ═══════════════════════════════════════════════════════════════════════════


async def _get_performance_trimestral(db, trimestres: int) -> dict:
    """Espelha ``getPerformanceTrimestral(trimestres)`` (_getPerformanceTrimestralImpl)."""
    offset_meses = (trimestres - 1) * 3
    offset_sql = f"interval '{offset_meses} months'"

    perf_sql = text(
        """
        WITH trimestres AS (
          SELECT
            date_trunc('quarter', g) AS inicio,
            date_trunc('quarter', g) + interval '3 months' - interval '1 day' AS fim
          FROM generate_series(
            date_trunc('quarter', CURRENT_DATE) - {offset},
            date_trunc('quarter', CURRENT_DATE),
            interval '3 months'
          ) g
        ),
        kp_lics AS (
          SELECT DISTINCT pl.numero_licitacao,
                 MIN(pl.posicao) AS melhor_pos,
                 MAX(pl.valor_total::numeric) AS valor_proposto
          FROM propostas_licitacao pl
          WHERE pl.cnpj = :cnpj AND pl.declinou = false
          GROUP BY pl.numero_licitacao
        ),
        kp_convocacao AS (
          SELECT DISTINCT numero_licitacao
          FROM licitacao_eventos_vencedor
          WHERE cnpj = :cnpj
            AND tipo IN ('CONVOCADO', 'HOMOLOGADO')
        )
        SELECT
          to_char(t.inicio, 'YYYY"-T"Q') AS trimestre,
          t.inicio,
          t.fim,
          COUNT(DISTINCT k.numero_licitacao)::int AS participacoes,
          COUNT(DISTINCT CASE WHEN r.cnpj_vencedor = :cnpj THEN k.numero_licitacao END)::int AS vitorias,
          COUNT(DISTINCT CASE
            WHEN r.cnpj_vencedor = :cnpj AND kc.numero_licitacao IS NULL
            THEN k.numero_licitacao END)::int AS vitorias_diretas,
          COUNT(DISTINCT CASE
            WHEN r.cnpj_vencedor = :cnpj AND kc.numero_licitacao IS NOT NULL
            THEN k.numero_licitacao END)::int AS vitorias_convocacao,
          COALESCE(SUM(k.valor_proposto), 0)::float AS valor_proposto,
          COALESCE(SUM(CASE WHEN r.cnpj_vencedor = :cnpj THEN r.valor_vencedor::numeric ELSE 0 END), 0)::float AS valor_ganho,
          AVG(k.melhor_pos)::float AS posicao_media
        FROM trimestres t
        LEFT JOIN resultados_licitacao r ON r.detectado_em >= t.inicio AND r.detectado_em <= t.fim
        LEFT JOIN kp_lics k ON k.numero_licitacao = r.numero_licitacao
        LEFT JOIN kp_convocacao kc ON kc.numero_licitacao = r.numero_licitacao
        GROUP BY t.inicio, t.fim
        ORDER BY t.inicio ASC
        """.replace("{offset}", offset_sql)
    )

    rows = (await db.execute(perf_sql, {"cnpj": PROPONENTE_CNPJ})).mappings().all()

    trimestres_out = []
    for row in rows:
        participacoes_raw = row["participacoes"]
        vitorias_raw = row["vitorias"]
        if participacoes_raw and participacoes_raw > 0:
            taxa_sucesso = _round_js((vitorias_raw / participacoes_raw) * 1000) / 10
        else:
            taxa_sucesso = 0
        trimestres_out.append(
            {
                "trimestre": row["trimestre"],
                "inicio": _js_to_iso_string(row["inicio"]),
                "fim": _js_to_iso_string(row["fim"]),
                "participacoes": _to_num(row["participacoes"]),
                "vitorias": _to_num(row["vitorias"]),
                "vitoriasDiretas": _to_num(row["vitorias_diretas"]),
                "vitoriasConvocacao": _to_num(row["vitorias_convocacao"]),
                "taxaSucesso": taxa_sucesso,
                "valorPropostoTotal": _to_num(row["valor_proposto"]),
                "valorGanhoTotal": _to_num(row["valor_ganho"]),
                "posicaoMedia": _to_num_or_null(row["posicao_media"]),
            }
        )

    ultimo = trimestres_out[-1] if trimestres_out else None
    anterior = trimestres_out[-2] if len(trimestres_out) >= 2 else None

    ultimos4 = trimestres_out[-4:]
    valor_ganho_12m = sum(t["valorGanhoTotal"] for t in ultimos4)

    taxa_atual = ultimo["taxaSucesso"] if ultimo else 0
    taxa_anterior = anterior["taxaSucesso"] if anterior else 0

    resumo = {
        "taxaSucessoAtual": taxa_atual,
        "taxaSucessoAnterior": taxa_anterior,
        "delta": _round_js((taxa_atual - taxa_anterior) * 10) / 10,
        "valorGanho12m": _round_js(valor_ganho_12m * 100) / 100,
        "posicaoMediaAtual": (ultimo["posicaoMedia"] if ultimo else None),
    }

    return {"trimestres": trimestres_out, "resumo": resumo}


async def _get_mercado(db, periodo_meses: int) -> dict:
    """Espelha ``getMercado(periodoMeses)`` (_getMercadoImpl)."""
    intervalo_sql = f"interval '{periodo_meses} months'"

    seg_sql = text(
        """
        WITH kp_lics AS (
          SELECT DISTINCT numero_licitacao FROM propostas_licitacao
          WHERE cnpj = :cnpj AND declinou = false
        )
        SELECT
          r.segmento                                          AS segmento,
          COUNT(*)::int                                       AS total_licitacoes,
          COALESCE(SUM(r.valor_vencedor::numeric), 0)::float  AS valor_total_gasto,
          AVG(r.valor_vencedor::numeric)::float               AS valor_medio_vencedor,
          CASE
            WHEN AVG(r.valor_vencedor::numeric) > 0
            THEN ((MAX(r.valor_vencedor::numeric) - MIN(r.valor_vencedor::numeric))
                  / AVG(r.valor_vencedor::numeric) * 100)::float
            ELSE 0
          END                                                 AS spread_medio,
          AVG(r.total_participantes)::float                   AS media_participantes,
          COUNT(DISTINCT CASE WHEN k.numero_licitacao IS NOT NULL
                THEN r.numero_licitacao END)::int             AS participacoes_proponente,
          COUNT(DISTINCT CASE WHEN r.cnpj_vencedor = :cnpj
                THEN r.numero_licitacao END)::int             AS vitorias_proponente
        FROM resultados_licitacao r
        LEFT JOIN kp_lics k ON k.numero_licitacao = r.numero_licitacao
        WHERE r.segmento IS NOT NULL
          AND r.detectado_em >= CURRENT_DATE - {intervalo}
          AND r.valor_vencedor::numeric > 0
        GROUP BY r.segmento
        HAVING COUNT(*) > 1
        ORDER BY valor_total_gasto DESC NULLS LAST
        LIMIT 20
        """.replace("{intervalo}", intervalo_sql)
    )

    serie_sql = text(
        """
        SELECT
          to_char(date_trunc('month', detectado_em), 'YYYY-MM')  AS mes,
          COUNT(*)::int                                          AS total_licitacoes,
          COALESCE(SUM(valor_vencedor::numeric), 0)::float       AS valor_total,
          AVG(valor_vencedor::numeric)::float                    AS media_preco_vencedor
        FROM resultados_licitacao
        WHERE detectado_em >= CURRENT_DATE - {intervalo}
          AND valor_vencedor::numeric > 0
        GROUP BY date_trunc('month', detectado_em)
        ORDER BY date_trunc('month', detectado_em) ASC
        """.replace("{intervalo}", intervalo_sql)
    )

    # PARIDADE BUG-A-BUG: subselect com a coluna INEXISTENTE ``created_em_dummy``
    # (envolvido em .catch(() => zeros) no Next) → a query QUEBRA → totais = zeros.
    totais_sql = text(
        """
        SELECT
          COUNT(*)::int                                     AS licitacoes_periodo,
          COALESCE(SUM(valor_vencedor::numeric), 0)::float  AS valor_total_periodo,
          AVG(total_participantes)::float                   AS media_participantes,
          (SELECT COUNT(DISTINCT cnpj)::int FROM propostas_licitacao
            WHERE declinou = false AND created_em_dummy IS NULL) AS dummy
        FROM resultados_licitacao
        WHERE detectado_em >= CURRENT_DATE - {intervalo}
        """.replace("{intervalo}", intervalo_sql)
    )

    conc_sql = text(
        """
        WITH ranking AS (
          SELECT cnpj_vencedor, COUNT(*)::int AS vitorias
          FROM resultados_licitacao
          WHERE cnpj_vencedor IS NOT NULL
            AND detectado_em >= CURRENT_DATE - {intervalo}
          GROUP BY cnpj_vencedor
          ORDER BY vitorias DESC
          LIMIT 5
        ),
        total AS (
          SELECT COUNT(*)::int AS t
          FROM resultados_licitacao
          WHERE cnpj_vencedor IS NOT NULL
            AND detectado_em >= CURRENT_DATE - {intervalo}
        )
        SELECT
          CASE WHEN total.t > 0
               THEN (SUM(ranking.vitorias)::float / total.t * 100)
               ELSE 0 END AS concentracao
        FROM ranking, total
        GROUP BY total.t
        """.replace("{intervalo}", intervalo_sql)
    )

    me_epp_sql = text(
        """
        WITH vencedores_no_periodo AS (
          SELECT DISTINCT r.numero_licitacao, r.cnpj_vencedor
          FROM resultados_licitacao r
          WHERE r.cnpj_vencedor IS NOT NULL
            AND r.detectado_em >= CURRENT_DATE - {intervalo}
        )
        SELECT
          COUNT(DISTINCT v.numero_licitacao)::int AS total,
          COUNT(DISTINCT CASE WHEN p.me_epp = true
                THEN v.numero_licitacao END)::int AS me_epp_count
        FROM vencedores_no_periodo v
        LEFT JOIN propostas_licitacao p
          ON p.numero_licitacao = v.numero_licitacao AND p.cnpj = v.cnpj_vencedor
        """.replace("{intervalo}", intervalo_sql)
    )

    fornecedores_sql = text(
        """
        SELECT COUNT(DISTINCT p.cnpj)::int AS fornecedores_unicos
        FROM propostas_licitacao p
        INNER JOIN resultados_licitacao r ON r.numero_licitacao = p.numero_licitacao
        WHERE p.declinou = false
          AND r.detectado_em >= CURRENT_DATE - {intervalo}
        """.replace("{intervalo}", intervalo_sql)
    )

    params = {"cnpj": PROPONENTE_CNPJ}

    seg_rows = (await db.execute(seg_sql, params)).mappings().all()
    serie_rows = (await db.execute(serie_sql, params)).mappings().all()

    try:
        totais_rows = (await db.execute(totais_sql, params)).mappings().all()
    except Exception:  # noqa: BLE001 — paridade: query quebrada → zeros
        await db.rollback()
        totais_rows = []

    conc_rows = (await db.execute(conc_sql, params)).mappings().all()
    me_epp_rows = (await db.execute(me_epp_sql, params)).mappings().all()
    fornecedores_rows = (await db.execute(fornecedores_sql, params)).mappings().all()

    segmentos = [
        {
            "segmento": s["segmento"],
            "totalLicitacoes": int(_to_num(s["total_licitacoes"])),
            "valorTotalGasto": _round2(_to_num(s["valor_total_gasto"])),
            "valorMedioVencedor": _round2(_to_num(s["valor_medio_vencedor"])),
            "spreadMedio": _round1(_to_num(s["spread_medio"])),
            "mediaParticipantes": _round1(_to_num(s["media_participantes"])),
            "participacoesProponente": int(_to_num(s["participacoes_proponente"])),
            "vitoriasProponente": int(_to_num(s["vitorias_proponente"])),
            "taxaSucessoProponente": (
                _round_js(
                    (_to_num(s["vitorias_proponente"]) / _to_num(s["participacoes_proponente"]))
                    * 1000
                )
                / 10
                if _to_num(s["participacoes_proponente"]) > 0
                else 0
            ),
        }
        for s in seg_rows
    ]

    serie_temporal = [
        {
            "mes": m["mes"],
            "totalLicitacoes": int(_to_num(m["total_licitacoes"])),
            "valorTotal": _round2(_to_num(m["valor_total"])),
            "mediaPrecoVencedor": _round2(_to_num(m["media_preco_vencedor"])),
        }
        for m in serie_rows
    ]

    t = totais_rows[0] if totais_rows else {
        "licitacoes_periodo": 0,
        "valor_total_periodo": 0,
        "media_participantes": 0,
    }
    concentracao = _to_num(conc_rows[0]["concentracao"]) if conc_rows else 0.0
    me_epp = me_epp_rows[0] if me_epp_rows else None
    fornecedores_unicos = (
        int(_to_num(fornecedores_rows[0]["fornecedores_unicos"]))
        if fornecedores_rows
        else 0
    )

    percentual_me_epp = (
        _round_js((_to_num(me_epp["me_epp_count"]) / _to_num(me_epp["total"])) * 1000) / 10
        if me_epp and _to_num(me_epp["total"]) > 0
        else 0
    )

    totais = {
        "licitacoesPeriodo": int(_to_num(t["licitacoes_periodo"])),
        "valorTotalPeriodo": _round2(_to_num(t["valor_total_periodo"])),
        "mediaParticipantes": _round1(_to_num(t["media_participantes"])),
        "fornecedoresUnicos": fornecedores_unicos,
        "concentracaoTop5": _round1(concentracao),
        "percentualMeEpp": percentual_me_epp,
    }

    return {
        "segmentos": segmentos,
        "serieTemporal": serie_temporal,
        "totais": totais,
    }


async def _get_concorrencia(db, periodo_meses: int) -> dict:
    """Espelha ``getConcorrencia(periodoMeses)`` (_getConcorrenciaImpl)."""
    top_sql = text(
        """
        WITH kp_lics AS (
          SELECT DISTINCT pl.numero_licitacao
          FROM propostas_licitacao pl
          INNER JOIN resultados_licitacao r ON r.numero_licitacao = pl.numero_licitacao
          WHERE pl.cnpj = :proponente
            AND pl.declinou = false
            AND r.detectado_em >= CURRENT_DATE - make_interval(months => :meses)
        ),
        outros AS (
          SELECT DISTINCT o.cnpj, o.fornecedor, o.numero_licitacao
          FROM propostas_licitacao o
          INNER JOIN kp_lics k ON k.numero_licitacao = o.numero_licitacao
          WHERE o.cnpj != :proponente AND o.declinou = false
        )
        SELECT
          o.cnpj, o.fornecedor,
          COUNT(DISTINCT o.numero_licitacao)::int AS encontros,
          COUNT(DISTINCT CASE WHEN r.cnpj_vencedor = o.cnpj THEN o.numero_licitacao END)::int AS vitorias_dele,
          COUNT(DISTINCT CASE WHEN r.cnpj_vencedor = :proponente THEN o.numero_licitacao END)::int AS vitorias_proponente
        FROM outros o
        LEFT JOIN resultados_licitacao r ON r.numero_licitacao = o.numero_licitacao
        GROUP BY o.cnpj, o.fornecedor
        ORDER BY encontros DESC
        LIMIT 20
        """
    )

    asc_sql = text(
        """
        SELECT
          cnpj_vencedor AS cnpj,
          fornecedor_vencedor AS fornecedor,
          COUNT(CASE WHEN detectado_em >= CURRENT_DATE - interval '3 months' THEN 1 END)::int AS vitorias_3m,
          COUNT(*)::int AS vitorias_12m
        FROM resultados_licitacao
        WHERE cnpj_vencedor IS NOT NULL
          AND cnpj_vencedor != :proponente
          AND detectado_em >= CURRENT_DATE - interval '12 months'
        GROUP BY cnpj_vencedor, fornecedor_vencedor
        HAVING COUNT(*) >= 3
        ORDER BY (COUNT(CASE WHEN detectado_em >= CURRENT_DATE - interval '3 months' THEN 1 END)::float / 3.0)
               - (COUNT(*)::float / 12.0) DESC
        LIMIT 10
        """
    )

    heat_sql = text(
        """
        WITH top_cnpjs AS (
          SELECT cnpj_vencedor
          FROM resultados_licitacao
          WHERE cnpj_vencedor IS NOT NULL
            AND cnpj_vencedor != :proponente
            AND detectado_em >= CURRENT_DATE - make_interval(months => :meses)
          GROUP BY cnpj_vencedor
          ORDER BY COUNT(*) DESC
          LIMIT 10
        ),
        top_segmentos AS (
          SELECT segmento
          FROM resultados_licitacao
          WHERE segmento IS NOT NULL
            AND detectado_em >= CURRENT_DATE - make_interval(months => :meses)
          GROUP BY segmento
          ORDER BY COUNT(*) DESC
          LIMIT 8
        )
        SELECT
          r.cnpj_vencedor AS cnpj,
          r.fornecedor_vencedor AS fornecedor,
          r.segmento,
          COUNT(*)::int AS vitorias,
          COALESCE(SUM(r.valor_vencedor::numeric), 0)::float AS valor_ganho
        FROM resultados_licitacao r
        INNER JOIN top_cnpjs tc ON tc.cnpj_vencedor = r.cnpj_vencedor
        INNER JOIN top_segmentos ts ON ts.segmento = r.segmento
        WHERE r.detectado_em >= CURRENT_DATE - make_interval(months => :meses)
        GROUP BY r.cnpj_vencedor, r.fornecedor_vencedor, r.segmento
        """
    )

    seg_top_sql = text(
        """
        SELECT segmento
        FROM resultados_licitacao
        WHERE segmento IS NOT NULL
          AND detectado_em >= CURRENT_DATE - make_interval(months => :meses)
        GROUP BY segmento
        ORDER BY COUNT(*) DESC
        LIMIT 8
        """
    )

    params = {"proponente": PROPONENTE_CNPJ, "meses": periodo_meses}

    top_rows = (await db.execute(top_sql, params)).mappings().all()
    asc_rows = (await db.execute(asc_sql, params)).mappings().all()
    heat_rows = (await db.execute(heat_sql, params)).mappings().all()
    seg_rows = (await db.execute(seg_top_sql, params)).mappings().all()

    top_concorrentes = []
    for r in top_rows:
        encontros = _to_num(r["encontros"])
        vitorias_dele = _to_num(r["vitorias_dele"])
        top_concorrentes.append(
            {
                "cnpj": r["cnpj"],
                "fornecedor": r["fornecedor"],
                "encontros": _js_num(encontros),
                "vitoriasDele": _js_num(vitorias_dele),
                "vitoriasProponente": _js_num(_to_num(r["vitorias_proponente"])),
                "taxaVitoriaDele": _js_num(
                    _round_js((vitorias_dele / encontros) * 1000) / 10
                    if encontros > 0
                    else 0
                ),
            }
        )

    em_ascensao = []
    for r in asc_rows:
        v3 = _to_num(r["vitorias_3m"])
        v12 = _to_num(r["vitorias_12m"])
        ritmo3m = r["vitorias_3m"] / 3
        ritmo12m = r["vitorias_12m"] / 12
        delta = _round_js((ritmo3m - ritmo12m) * 100) / 100
        if delta > 0:
            em_ascensao.append(
                {
                    "cnpj": r["cnpj"],
                    "fornecedor": r["fornecedor"],
                    "vitorias3m": _js_num(v3),
                    "vitorias12m": _js_num(v12),
                    "delta": _js_num(delta),
                }
            )

    heatmap = []
    for r in heat_rows:
        heatmap.append(
            {
                "cnpj": r["cnpj"],
                "fornecedor": r["fornecedor"],
                "segmento": r["segmento"],
                "vitorias": _js_num(_to_num(r["vitorias"])),
                "valorGanho": _js_num(_round_js(_to_num(r["valor_ganho"]) * 100) / 100),
            }
        )

    segmentos_top = [r["segmento"] for r in seg_rows]

    return {
        "topConcorrentes": top_concorrentes,
        "emAscensao": em_ascensao,
        "heatmap": heatmap,
        "segmentosTop": segmentos_top,
    }


async def _get_oportunidades_perdidas(db, score_min: int, periodo_meses: int, limit: int) -> list:
    """Espelha ``getOportunidadesPerdidas({scoreMin, periodoMeses, limit})``."""
    sql = text(
        """
        SELECT
          l.id AS licitacao_id,
          l.numero,
          l.objeto,
          l.segmento,
          l.natureza,
          l.empresa,
          r.valor_vencedor::float AS valor_vencedor,
          r.cnpj_vencedor,
          r.fornecedor_vencedor,
          lfm.score_aderencia AS score_aderencia,
          lfm.itens_cobertos,
          lfm.total_itens,
          r.detectado_em
        FROM licitacoes l
        INNER JOIN licitacoes_familias_match lfm ON lfm.licitacao_id = l.id
        INNER JOIN resultados_licitacao r ON r.numero_licitacao = l.numero
        WHERE lfm.score_aderencia >= :score_min
          AND r.detectado_em >= CURRENT_DATE - make_interval(months => :periodo_meses)
          AND l.numero NOT IN (
            SELECT DISTINCT numero_licitacao FROM propostas_licitacao
            WHERE cnpj = :proponente AND declinou = false
          )
        ORDER BY lfm.score_aderencia DESC, r.detectado_em DESC
        LIMIT :limit
        """
    )

    rows = (
        await db.execute(
            sql,
            {
                "score_min": score_min,
                "periodo_meses": periodo_meses,
                "proponente": PROPONENTE_CNPJ,
                "limit": limit,
            },
        )
    ).mappings().all()

    out = []
    for row in rows:
        lic_id = row["licitacao_id"]
        out.append(
            {
                "licitacaoId": str(lic_id) if isinstance(lic_id, UUID) else lic_id,
                "numero": row["numero"],
                "objeto": row["objeto"],
                "segmento": row["segmento"],
                "natureza": row["natureza"],
                "empresa": row["empresa"],
                "valorVencedor": _to_num_or_null(row["valor_vencedor"]),
                "cnpjVencedor": row["cnpj_vencedor"],
                "fornecedorVencedor": row["fornecedor_vencedor"],
                "scoreAderencia": _js_num(
                    _round_js(_to_num(row["score_aderencia"]) * 10) / 10
                ),
                "itensCobertos": _js_num(_to_num(row["itens_cobertos"])),
                "totalItens": _js_num(_to_num(row["total_itens"])),
                "detectadoEm": _js_to_iso_string(row["detectado_em"]),
            }
        )
    return out


async def _get_destinatarios_gestao(db) -> list[str]:
    """Espelha ``getDestinatariosGestao``: emails de users ATIVOS ∈ {ADMIN, LIDER}.

    Replica ``db.select({email}).from(users).where(and(eq(ativo,true),
    inArray(role,[ADMIN,LIDER])))`` + ``.map(u => u.email).filter(Boolean)``.
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT email
                FROM users
                WHERE ativo = true
                  AND role IN (:admin, :lider)
                """
            ),
            {"admin": ROLE_ADMIN, "lider": ROLE_LIDER},
        )
    ).mappings().all()
    # .filter(Boolean) descarta None/"" (emails vazios/nulos).
    return [r["email"] for r in rows if r["email"]]


# ═══════════════════════════════════════════════════════════════════════════
# TEMPLATE DE E-MAIL — replica templateDigestExecutivo (templates.ts)
# ═══════════════════════════════════════════════════════════════════════════


def _layout(conteudo: str) -> str:
    """Replica ``layout(conteudo)`` de templates.ts."""
    ano = datetime.now().year
    return (
        """<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Petro Radar</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12);">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:20px 32px;">
              <span style="color:#f8fafc;font-size:20px;font-weight:700;letter-spacing:-0.5px;">
                Petro Radar
              </span>
              <span style="color:#94a3b8;font-size:13px;margin-left:12px;">Petro Radar</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              """
        + conteudo
        + """
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                Este é um e-mail automático do sistema Petro Radar. Não responda este e-mail.<br/>
                © """
        + str(ano)
        + """ Petro Radar
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    )


def _button(href: str, texto: str) -> str:
    """Replica ``button(href, texto)`` de templates.ts."""
    return (
        f'<a href="{href}" style="display:inline-block;background:#0f172a;'
        'color:#f8fafc;padding:12px 24px;border-radius:6px;text-decoration:none;'
        f'font-weight:600;font-size:14px;margin-top:20px;">{texto}</a>'
    )


def _kpi_card(k: dict) -> str:
    """Replica ``kpiCard(k)`` de templates.ts."""
    tendencia = k.get("tendencia")
    cor_var = "#16a34a" if tendencia == "up" else "#dc2626" if tendencia == "down" else "#64748b"
    variacao = k.get("variacao")
    bloco_var = (
        f'<p style="margin:4px 0 0;color:{cor_var};font-size:12px;font-weight:600;">{variacao}</p>'
        if variacao
        else ""
    )
    return (
        '<td style="padding:8px;width:50%;vertical-align:top;">'
        '<div style="border:1px solid #e2e8f0;border-radius:6px;padding:14px;">'
        f'<p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.3px;">{k["rotulo"]}</p>'
        f'<p style="margin:0;color:#0f172a;font-size:22px;font-weight:700;">{k["valor"]}</p>'
        f"{bloco_var}"
        "</div>"
        "</td>"
    )


def _kpi_grid(kpis: list) -> str:
    """Replica ``kpiGrid(kpis)`` de templates.ts."""
    if len(kpis) == 0:
        return ""
    rows = []
    i = 0
    while i < len(kpis):
        a = _kpi_card(kpis[i])
        b = _kpi_card(kpis[i + 1]) if i + 1 < len(kpis) else '<td style="width:50%;"></td>'
        rows.append(f"<tr>{a}{b}</tr>")
        i += 2
    return (
        '<table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">'
        + "".join(rows)
        + "</table>"
    )


def _secao_lista(s: dict) -> str:
    """Replica ``secaoLista(s)`` de templates.ts."""
    if len(s["itens"]) == 0:
        return ""
    lis = []
    for it in s["itens"]:
        href = it.get("href")
        if href:
            conteudo = f'<a href="{href}" style="color:#1d4ed8;text-decoration:none;">{it["texto"]}</a>'
        else:
            conteudo = it["texto"]
        lis.append(
            f'<li style="color:#0f172a;font-size:13px;margin-bottom:6px;">{conteudo}</li>'
        )
    return (
        f'\n    <p style="margin:0 0 8px;color:#0f172a;font-size:15px;font-weight:600;">{s["titulo"]}</p>'
        f'\n    <ul style="margin:0 0 24px;padding-left:20px;">{"".join(lis)}</ul>'
    )


def _template_digest_executivo(
    periodo_label: str,
    kpis: list,
    secoes: list,
    alertas_crc: list,
) -> dict:
    """Replica ``templateDigestExecutivo(p)`` de templates.ts → {subject, html, text}."""
    subject = f"Painel Executivo Petro Radar — {periodo_label}"

    if alertas_crc and len(alertas_crc) > 0:
        bloco_alertas = (
            '\n    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:16px;margin-bottom:24px;">'
            '\n      <p style="margin:0 0 8px;color:#991b1b;font-size:13px;font-weight:600;">Alertas de CRC</p>'
            '\n      <ul style="margin:0;padding-left:18px;">'
            "\n        "
            + "".join(
                f'<li style="color:#991b1b;font-size:13px;margin-bottom:4px;">{a}</li>'
                for a in alertas_crc
            )
            + "\n      </ul>"
            "\n    </div>"
        )
    else:
        bloco_alertas = ""

    conteudo = (
        '\n    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Painel Executivo</h2>'
        f'\n    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">{periodo_label}</p>'
        "\n\n    "
        + _kpi_grid(kpis)
        + "\n    "
        + bloco_alertas
        + "\n    "
        + "".join(_secao_lista(s) for s in secoes)
        + "\n\n    "
        + _button(f"{BASE_URL}/resultados", "Abrir os Resultados →")
        + "\n  "
    )
    html = _layout(conteudo)

    text_kpis = "\n".join(
        f"- {k['rotulo']}: {k['valor']}" + (f" ({k['variacao']})" if k.get("variacao") else "")
        for k in kpis
    )
    text_secoes = "\n".join(
        f"\n{s['titulo']}\n"
        + "\n".join(f"  • {it['texto']}" for it in s["itens"])
        for s in secoes
    )
    text_alertas = (
        "\nAlertas de CRC:\n" + "\n".join(f"  • {a}" for a in alertas_crc)
        if alertas_crc and len(alertas_crc) > 0
        else ""
    )

    text = "\n".join(
        [
            f"Painel Executivo Petro Radar — {periodo_label}",
            text_kpis,
            text_alertas,
            text_secoes,
            f"\nAcesse: {BASE_URL}/resultados",
        ]
    )

    return {"subject": subject, "html": html, "text": text}


# ═══════════════════════════════════════════════════════════════════════════
# HANDLER GET — /api/cron/digest-executivo
# ═══════════════════════════════════════════════════════════════════════════


def _autorizar_cron(request: Request) -> bool:
    """Replica ``autorizarCron(req)`` do Next.

    Com ``CRON_SECRET`` configurado, exige ``Authorization: Bearer <secret>``;
    senão aceita o header ``x-vercel-cron: 1``.
    """
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = request.headers.get("authorization") or ""
        # Constant-time (safe_equal): mesmo resultado booleano da igualdade
        # simples, sem canal de timing (hardening 02/07).
        return safe_equal(auth_header, f"Bearer {cron_secret}")
    return request.headers.get("x-vercel-cron") == "1"


@router.get("/api/cron/digest-executivo")
async def get_digest_executivo(request: Request) -> JSONResponse:
    """GET /api/cron/digest-executivo — digest executivo semanal por e-mail.

    Paridade 1:1 com o handler GET de ``cron/digest-executivo/route.ts``.
    """
    # ── 1. Auth do cron (Bearer CRON_SECRET ou x-vercel-cron: 1) ──────────────
    if not _autorizar_cron(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # ── 2. Gate gracioso: config.crons.digestExecutivo.habilitado ─────────────
    if not _flag(settings.cron_digest_executivo_enabled, True):
        return JSONResponse(
            content={"ok": True, "skipped": True, "motivo": "cron desabilitado"}
        )

    async with SessionLocal() as db:
        # ── 3. Destinatários de gestão (ADMIN/LIDER ativos) ───────────────────
        destinatarios = await _get_destinatarios_gestao(db)
        if len(destinatarios) == 0:
            # log.warn("nenhum destinatário de gestão")
            return JSONResponse(
                content={"ok": True, "enviado": False, "motivo": "sem destinatários"}
            )

        # ── 4. Coleta de dados (Promise.all das queries cacheadas) ────────────
        perf = await _get_performance_trimestral(db, 6)
        mercado = await _get_mercado(db, 12)
        concorrencia = await _get_concorrencia(db, 3)
        oportunidades = await _get_oportunidades_perdidas(
            db, score_min=70, periodo_meses=1, limit=5
        )
        # Famílias CRC vencidas ou não aprovadas (alerta executivo).
        familias_rows = (
            await db.execute(
                text(
                    """
                    SELECT
                      codigo_crc        AS codigo_crc,
                      nome              AS nome,
                      status_fluxo_crc  AS status_fluxo_crc,
                      validade_fim      AS validade_fim
                    FROM familias
                    WHERE status_fluxo_crc IS NOT NULL
                      AND status_fluxo_crc != :status_a
                    LIMIT 8
                    """
                ),
                {"status_a": "A"},
            )
        ).mappings().all()

    r = perf["resumo"]

    # ── KPIs (4) ──────────────────────────────────────────────────────────────
    delta_v = r["delta"]
    delta_num = _to_num(delta_v)
    kpis = [
        {
            "rotulo": "Taxa de sucesso",
            "valor": f"{_num_str(r['taxaSucessoAtual'])}%",
            "variacao": f"{'+' if delta_num >= 0 else ''}{_num_str(delta_v)} p.p. vs. trimestre anterior",
            "tendencia": "up" if delta_num > 0 else "down" if delta_num < 0 else "neutral",
        },
        {"rotulo": "Valor ganho (12m)", "valor": _fmt_brl(r["valorGanho12m"])},
        {"rotulo": "Mercado (12m)", "valor": _fmt_brl(mercado["totais"]["valorTotalPeriodo"])},
        {
            "rotulo": "Concentração top 5",
            "valor": f"{_num_str(mercado['totais']['concentracaoTop5'])}%",
        },
    ]

    # ── Seções ────────────────────────────────────────────────────────────────
    secoes = []

    if len(oportunidades) > 0:
        secoes.append(
            {
                "titulo": "Oportunidades de alto interesse (última semana)",
                "itens": [
                    {
                        "texto": (
                            f"{o['numero']} — "
                            f"{(o['objeto'] or '')[:70]} "
                            f"(aderência {_num_str(o['scoreAderencia'])}%)"
                        ),
                        "href": (
                            f"{BASE_URL}/licitacoes/{o['licitacaoId']}"
                            if o["licitacaoId"]
                            else None
                        ),
                    }
                    for o in oportunidades
                ],
            }
        )

    if len(concorrencia["emAscensao"]) > 0:
        secoes.append(
            {
                "titulo": "Concorrentes em ascensão",
                "itens": [
                    {
                        "texto": f"{c['fornecedor']} — {_num_str(c['vitorias3m'])} vitórias nos últimos 3 meses",
                    }
                    for c in concorrencia["emAscensao"][:5]
                ],
            }
        )

    # ── Alertas CRC ───────────────────────────────────────────────────────────
    alertas_crc = []
    for f in familias_rows:
        validade_fim = f["validade_fim"]
        if validade_fim:
            venc = f" (validade {_fmt_data_br(validade_fim)})"
        else:
            venc = ""
        status = f["status_fluxo_crc"] if f["status_fluxo_crc"] is not None else "?"
        alertas_crc.append(f"{f['codigo_crc']} — {f['nome']}: status {status}{venc}")

    # ── Período (semana de hoje-6d a hoje) ────────────────────────────────────
    hoje = datetime.now()
    inicio_semana = hoje - timedelta(days=6)
    periodo_label = (
        f"Semana de {_fmt_data_br(inicio_semana)} a {_fmt_data_br(hoje)}"
    )

    tpl = _template_digest_executivo(periodo_label, kpis, secoes, alertas_crc)

    resultado = await send_email(
        to=destinatarios,
        subject=tpl["subject"],
        html=tpl["html"],
        text=tpl["text"],
    )

    # log.info("digest enviado", ...)

    return JSONResponse(
        content={
            "ok": True,
            "enviado": bool(resultado.get("ok")),
            "destinatarios": len(destinatarios),
            "kpis": len(kpis),
            "secoes": len(secoes),
            "alertasCrc": len(alertas_crc),
        }
    )
