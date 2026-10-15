"""Lib INTERNA (não é rota): coleta de dados do relatório executivo.

Réplica de ``coletarDadosRelatorio`` (``src/lib/relatorios/executivo-dados.ts``
do Next), consumida pela rota migrada ``cron_relatorio_mensal.py`` (GET
/api/cron/relatorio-mensal), que monta os KPIs do e-mail mensal. O render XLSX
(``gerarRelatorioXlsx``) saiu com o hub de relatórios em 2026-09-18.

HISTÓRICO (02/07/2026): este código vivia em ``relatorios_executivo.py``, que
também registrava a rota GET /api/relatorios/executivo no BFF. Essa rota (e as
demais rotas XLSX) é servida pelo NEXT por decisão de arquitetura — o NGINX
roteia os paths XLSX para o Next (nginx/strangler/routes.conf e
nginx/conf.d/petro-radar.conf), pois os bytes de exceljs != openpyxl. A rota
morta foi REMOVIDA do BFF; a coleta/render permanece aqui APENAS para o cron.
O prefixo ``_`` faz o autodiscovery de ``include_migrated`` ignorar o módulo.

O ``coletarDadosRelatorio`` roda as MESMAS 6 leituras de analytics + a aba
de lacunas CRC:

  - getPerformanceTrimestral(trimestres)   -> _getPerformanceTrimestralImpl
  - getMercado(periodoMeses)               -> _getMercadoImpl
  - getConcorrencia(periodoMeses)          -> _getConcorrenciaImpl
  - getOportunidadesPerdidas({scoreMin:60, periodoMeses, limit:100})
  - getParticipacoesProponente({periodoMeses, limit:300})
  - lacunas CRC (familias + licitacoes_familias_match)  -> query crua

onde ``trimestres = Math.max(2, Math.ceil(periodoMeses / 3))``.

Reusa A MESMA SQL e o MESMO pós-processamento (toNum/toNumOrNull, ``Math.round``
half-away-from-+Inf, datas ``toISOString`` UTC/ms/"Z") das rotas irmãs de analytics
(performance / mercado / concorrentes / oportunidades perdidas / participações
do proponente). NENHUM campo é inventado.

PARIDADE BUG-A-BUG (replicada do Next):
  - ``getMercado`` inclui na query de TOTAIS um subselect com a coluna
    INEXISTENTE ``created_em_dummy``, embrulhado em ``.catch(() => zeros)``. A
    query QUEBRA e os totais caem em ZEROS. Replicamos: a SQL com o subselect
    quebrado é executada; o ``except`` faz rollback e cai para zeros.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

from sqlalchemy import text

from app.routers.migrated._shared import PROPONENTE_CNPJ, js_round


# ── Helpers de paridade numérica/datas (espelham queries.ts) ──────────────────


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


def _to_num_or_null(v: object) -> float | None:
    """Espelha ``toNumOrNull`` do Next: null/NaN → None; senão float."""
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


def _iso_z(dt: datetime | None) -> str | None:
    """Replica ``new Date(dt).toISOString()`` do JS (UTC, ms, sufixo 'Z')."""
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


# ═══════════════════════════════════════════════════════════════════════════
# COLETA DE DADOS — replica coletarDadosRelatorio (único acesso a DB).
# Cada bloco reusa a SQL/pós-processamento das rotas migradas irmãs.
# ═══════════════════════════════════════════════════════════════════════════


async def _performance(db, trimestres: int) -> dict:
    """Replica _getPerformanceTrimestralImpl (analytics de performance)."""
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

    trimestres_out: list[dict] = []
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
                "inicio": _iso_z(row["inicio"]),
                "fim": _iso_z(row["fim"]),
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

    return {
        "trimestres": trimestres_out,
        "resumo": {
            "taxaSucessoAtual": taxa_atual,
            "taxaSucessoAnterior": taxa_anterior,
            "delta": _round_js((taxa_atual - taxa_anterior) * 10) / 10,
            "valorGanho12m": _round_js(valor_ganho_12m * 100) / 100,
            "posicaoMediaAtual": (ultimo["posicaoMedia"] if ultimo else None),
        },
    }


async def _mercado(db, periodo_meses: int) -> dict:
    """Replica _getMercadoImpl (analytics de mercado), com bug created_em_dummy."""
    intervalo_sql = f"interval '{periodo_meses} months'"
    params = {"cnpj": PROPONENTE_CNPJ}

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
    # BUG-A-BUG: subselect com coluna INEXISTENTE created_em_dummy → query quebra
    # e cai em zeros (Next embrulha em .catch). Replicamos com try/except abaixo.
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

    return {
        "segmentos": segmentos,
        "serieTemporal": serie_temporal,
        "totais": {
            "licitacoesPeriodo": int(_to_num(t["licitacoes_periodo"])),
            "valorTotalPeriodo": _round2(_to_num(t["valor_total_periodo"])),
            "mediaParticipantes": _round1(_to_num(t["media_participantes"])),
            "fornecedoresUnicos": fornecedores_unicos,
            "concentracaoTop5": _round1(concentracao),
            "percentualMeEpp": percentual_me_epp,
        },
    }


async def _concorrencia(db, periodo_meses: int) -> dict:
    """Replica _getConcorrenciaImpl (analytics de concorrentes)."""
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
                "encontros": _to_num(r["encontros"]),
                "vitoriasDele": vitorias_dele,
                "vitoriasProponente": _to_num(r["vitorias_proponente"]),
                "taxaVitoriaDele": (
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
                    "vitorias3m": v3,
                    "vitorias12m": v12,
                    "delta": delta,
                }
            )

    heatmap = [
        {
            "cnpj": r["cnpj"],
            "fornecedor": r["fornecedor"],
            "segmento": r["segmento"],
            "vitorias": _to_num(r["vitorias"]),
            "valorGanho": _round_js(_to_num(r["valor_ganho"]) * 100) / 100,
        }
        for r in heat_rows
    ]
    segmentos_top = [r["segmento"] for r in seg_rows]

    return {
        "topConcorrentes": top_concorrentes,
        "emAscensao": em_ascensao,
        "heatmap": heatmap,
        "segmentosTop": segmentos_top,
    }


async def _oportunidades_perdidas(db, periodo_meses: int) -> list[dict]:
    """Replica _getOportunidadesPerdidasImpl ({scoreMin:60, periodoMeses, limit:100})."""
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
                "score_min": 60,
                "periodo_meses": periodo_meses,
                "proponente": PROPONENTE_CNPJ,
                "limit": 100,
            },
        )
    ).mappings().all()

    out = []
    for row in rows:
        lic_id = row["licitacao_id"]
        out.append(
            {
                "licitacaoId": str(lic_id) if lic_id is not None else lic_id,
                "numero": row["numero"],
                "objeto": row["objeto"],
                "segmento": row["segmento"],
                "natureza": row["natureza"],
                "empresa": row["empresa"],
                "valorVencedor": _to_num_or_null(row["valor_vencedor"]),
                "cnpjVencedor": row["cnpj_vencedor"],
                "fornecedorVencedor": row["fornecedor_vencedor"],
                "scoreAderencia": _round_js(_to_num(row["score_aderencia"]) * 10) / 10,
                "itensCobertos": _to_num(row["itens_cobertos"]),
                "totalItens": _to_num(row["total_itens"]),
                "detectadoEm": _iso_z(row["detectado_em"]),
            }
        )
    return out


async def _participacoes(db, periodo_meses: int) -> dict:
    """Replica getParticipacoesProponente({periodoMeses, limit:300})."""
    # clausulaTempo (periodoMeses > 0) — limit fixo 300; sem status/segmento/search.
    clausula_tempo = (
        f"AND (r.detectado_em IS NULL OR r.detectado_em >= CURRENT_DATE "
        f"- interval '{periodo_meses} months')"
        if periodo_meses > 0
        else ""
    )
    main_sql = text(
        """
        WITH kp_propostas AS (
          SELECT
            pl.numero_licitacao,
            MIN(pl.posicao) FILTER (WHERE pl.posicao IS NOT NULL) AS melhor_posicao,
            MAX(pl.valor_total::numeric) AS valor_proposta,
            MAX(pl.data_proposta) AS data_proposta,
            MAX(pl.criado_em)     AS proposta_criada_em
          FROM propostas_licitacao pl
          WHERE pl.cnpj = :cnpj AND pl.declinou = false
          GROUP BY pl.numero_licitacao
        ),
        kp_part AS (
          SELECT DISTINCT ON (numero_edital)
            id, numero_edital, fase, resultado, versao
          FROM participacoes_licitacao
          WHERE deletado_em IS NULL
          ORDER BY numero_edital, atualizado_em DESC NULLS LAST
        ),
        kp_convocacao AS (
          SELECT DISTINCT numero_licitacao
          FROM licitacao_eventos_vencedor
          WHERE cnpj = :cnpj
            AND tipo IN ('CONVOCADO', 'HOMOLOGADO')
        )
        SELECT
          kpr.numero_licitacao,
          l.id AS licitacao_id,
          COALESCE(r.objeto, l.objeto) AS objeto,
          COALESCE(r.segmento, l.segmento) AS segmento,
          COALESCE(r.empresa, l.empresa) AS empresa,
          kpr.melhor_posicao,
          kpr.valor_proposta::float AS valor_proposta,
          kpr.data_proposta,
          r.cnpj_vencedor,
          r.fornecedor_vencedor,
          r.valor_vencedor::float AS valor_vencedor,
          r.total_participantes,
          r.detectado_em AS resultado_em,
          kp.id AS participacao_id,
          kp.fase AS participacao_fase,
          kp.resultado AS participacao_resultado,
          kp.versao AS participacao_versao,
          CASE
            WHEN r.cnpj_vencedor = :cnpj                                 THEN true
            WHEN r.cnpj_vencedor IS NULL AND kp.resultado = 'GANHOU'     THEN true
            ELSE false
          END AS proponente_venceu,
          CASE WHEN kc.numero_licitacao IS NOT NULL THEN true ELSE false END AS venceu_por_convocacao,
          CASE
            WHEN r.cnpj_vencedor = :cnpj AND kc.numero_licitacao IS NOT NULL THEN 'CONVOCACAO'
            WHEN r.cnpj_vencedor = :cnpj                                      THEN 'DIRETA'
            WHEN r.cnpj_vencedor IS NULL AND kp.resultado = 'GANHOU'          THEN 'PIPELINE_ONLY'
            WHEN r.cnpj_vencedor IS NOT NULL AND r.cnpj_vencedor != :cnpj
                 AND kp.resultado = 'GANHOU'                                  THEN 'CONFLITO'
            ELSE NULL
          END AS vitoria_tipo
        FROM kp_propostas kpr
        LEFT JOIN licitacoes l ON l.numero = kpr.numero_licitacao
        LEFT JOIN resultados_licitacao r ON r.numero_licitacao = kpr.numero_licitacao
        LEFT JOIN kp_part kp ON kp.numero_edital = kpr.numero_licitacao
        LEFT JOIN kp_convocacao kc ON kc.numero_licitacao = kpr.numero_licitacao
        WHERE 1=1
          {clausula_tempo}
        ORDER BY COALESCE(r.detectado_em, kpr.proposta_criada_em) DESC NULLS LAST
        LIMIT :limit
        """.replace("{clausula_tempo}", clausula_tempo)
    )
    rows = (
        await db.execute(main_sql, {"cnpj": PROPONENTE_CNPJ, "limit": 300})
    ).mappings().all()

    todos: list[dict] = []
    for row in rows:
        resultado_em = row["resultado_em"]
        todos.append(
            {
                "numeroLicitacao": row["numero_licitacao"],
                "licitacaoId": str(row["licitacao_id"]) if row["licitacao_id"] is not None else None,
                "objeto": row["objeto"],
                "segmento": row["segmento"],
                "empresa": row["empresa"],
                "melhorPosicao": _to_num(row["melhor_posicao"]) if row["melhor_posicao"] is not None else None,
                "valorProposta": _to_num_or_null(row["valor_proposta"]),
                "dataProposta": row["data_proposta"] if row["data_proposta"] is not None else None,
                "cnpjVencedorAtual": row["cnpj_vencedor"],
                "fornecedorVencedor": row["fornecedor_vencedor"],
                "valorVencedor": _to_num_or_null(row["valor_vencedor"]),
                "totalParticipantes": _to_num(row["total_participantes"]) if row["total_participantes"] is not None else None,
                "resultadoEm": resultado_em.isoformat() if resultado_em is not None else None,
                "participacaoId": str(row["participacao_id"]) if row["participacao_id"] is not None else None,
                "participacaoFase": row["participacao_fase"],
                "participacaoResultado": row["participacao_resultado"],
                "participacaoVersao": row["participacao_versao"],
                "proponenteVenceu": row["proponente_venceu"],
                "vitoriaTipo": row["vitoria_tipo"],
                "venceuPorConvocacao": row["venceu_por_convocacao"],
            }
        )

    def is_vitoria(p: dict) -> bool:
        return bool(p["proponenteVenceu"])

    def is_perda_port(p: dict) -> bool:
        return (
            not p["proponenteVenceu"]
            and bool(p["cnpjVencedorAtual"])
            and p["cnpjVencedorAtual"] != PROPONENTE_CNPJ
        )

    def is_perda(p: dict) -> bool:
        return is_perda_port(p) or (
            p["participacaoResultado"] == "PERDEU" and not p["proponenteVenceu"]
        )

    totais = {
        "total": len(todos),
        "ganhou": sum(1 for p in todos if is_vitoria(p)),
        "perdeu": sum(
            1
            for p in todos
            if not p["proponenteVenceu"]
            and is_perda(p)
            and p["participacaoResultado"] != "CANCELADA"
        ),
        "cancelou": sum(1 for p in todos if p["participacaoResultado"] == "CANCELADA"),
        "semResultado": sum(
            1
            for p in todos
            if not p["cnpjVencedorAtual"] and not p["participacaoResultado"]
        ),
        "semParticipacao": sum(1 for p in todos if not p["participacaoId"]),
    }
    # Sem filtro de status: data == todos (igual ao Next quando filtroStatus == "").
    return {"data": todos, "totais": totais}


async def _lacunas_crc(db) -> list[dict]:
    """Replica a query de lacunas CRC embutida em coletarDadosRelatorio."""
    sql = text(
        """
        SELECT
          f.codigo_crc,
          f.nome,
          f.segmento_petrobras,
          f.status_fluxo_crc,
          f.validade_fim,
          COUNT(DISTINCT lfm.licitacao_id)::int AS demanda_recente
        FROM familias f
        LEFT JOIN licitacoes_familias_match lfm
          ON lfm.familias_usadas @> jsonb_build_array(jsonb_build_object('codigoCrc', f.codigo_crc))
        WHERE f.deletado_em IS NULL
          AND (f.status_fluxo_crc IS DISTINCT FROM 'A')
        GROUP BY f.codigo_crc, f.nome, f.segmento_petrobras, f.status_fluxo_crc, f.validade_fim
        ORDER BY demanda_recente DESC, f.validade_fim ASC NULLS LAST
        LIMIT 100
        """
    )
    rows = (await db.execute(sql)).mappings().all()
    out = []
    for r in rows:
        validade_fim = r["validade_fim"]
        out.append(
            {
                "codigoCrc": r["codigo_crc"],
                "nome": r["nome"],
                "segmentoPetrobras": r["segmento_petrobras"],
                "statusFluxoCrc": r["status_fluxo_crc"],
                "validadeFim": _iso_z(validade_fim) if validade_fim is not None else None,
                "demandaRecente": _to_num(r["demanda_recente"]) or 0,
            }
        )
    return out


async def _coletar_dados_relatorio(db, periodo_meses: int) -> dict:
    """Replica coletarDadosRelatorio(periodoMeses): único acesso a DB.

    No Next as 6 leituras rodam em ``Promise.all`` na MESMA conexão (Neon HTTP).
    Aqui são sequenciais na mesma ``AsyncSession`` — resultado idêntico (todas
    read-only, sem dependência entre elas).
    """
    trimestres = max(2, math.ceil(periodo_meses / 3))
    performance = await _performance(db, trimestres)
    mercado = await _mercado(db, periodo_meses)
    concorrencia = await _concorrencia(db, periodo_meses)
    oportunidades = await _oportunidades_perdidas(db, periodo_meses)
    participacoes = await _participacoes(db, periodo_meses)
    lacunas_crc = await _lacunas_crc(db)

    return {
        "periodoMeses": periodo_meses,
        "geradoEm": _iso_z(datetime.now(tz=timezone.utc)),
        "performance": performance,
        "mercado": mercado,
        "concorrencia": concorrencia,
        "oportunidades": oportunidades,
        "participacoes": participacoes,
        "lacunasCrc": lacunas_crc,
    }
