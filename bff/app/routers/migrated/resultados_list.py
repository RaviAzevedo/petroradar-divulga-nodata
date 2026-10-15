"""Rota MIGRADA (estrangulador / strangler-fig): GET /api/resultados.

Equivalente 1:1 do handler GET de
``src/app/api/resultados/route.ts`` — listagem V2-primary de resultados de
licitação (vencedor/estatísticas) com enriquecimento em lote a partir das
tabelas V2 (``petronect_lic_resultado`` + ``petronect_lic_andamento``),
participação Proponente e valor médio orçado.

GATE de feature (ANTES do auth, igual ao Next):
    ``if (!config.features.resultados)`` → 503 ``{"error": "Módulo em
    reconstrução"}``. ``config.features.resultados =
    flag(NEXT_PUBLIC_FEATURE_RESULTADOS, false)`` — undefined/"" → False;
    "true"/"1" → True; senão False.

Guard Next:
    ``requireVisualizar()`` (401 se sem sessão; 403 se role ∉ ROLES_VISUALIZAR).
    Equivalente no BFF: :data:`app.core.security.require_visualizar`
    (ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR). O gate de feature
    roda ANTES do auth, então o dependency é chamado manualmente no corpo do
    handler (e não via ``Depends``) — caso contrário o 401 viria antes do 503.

Query params lidos (mesmos nomes/defaults/clamps do Next):
    page          int  default 1   clamp >=1  (parseInt || 1; Math.max(1, .))
    limit         int  default 20  clamp 1..100 (Math.min(Math.max(1,.),100))
    search        str  default ""   ILIKE em numero_licitacao/fornecedor_vencedor/objeto
    segmento      str  default ""   eq
    natureza      str  default ""   eq
    empresa       str  default ""   ILIKE
    cnpj_vencedor str  default ""   eq
    periodo       str  7d|30d|90d   gte criado_em (NOW() - INTERVAL)
    confidence    str  default ALL  (uppercased) EXISTS em petronect_lic_resultado
    subStatus     str  default ""   EXISTS em petronect_lic_andamento
    contrato      str  ""|com|sem   valor_contrato_real IS [NOT] NULL
    sort          str  default "criado_em" (whitelist)
    order         str  default "desc" (asc|desc)

Shape da resposta (idêntico ao Next):
    {
      "data": [ { ...campos camelCase fixos do data.map } ],
      "meta": { "total": int, "page": int, "limit": int, "pages": int }
    }

Colunas (snake_case no banco → camelCase no Drizzle/alias projetado):
    resultados_licitacao:
        id (uuid)                  → "id"
        licitacao_id (uuid)        → "licitacaoId"
        numero_licitacao (text)    → "numeroLicitacao"
        objeto (text)              → "objeto"
        empresa (text)             → "empresa"
        segmento (text)            → "segmento"
        natureza (text)            → "natureza"
        fornecedor_vencedor (text) → "fornecedorVencedor"
        cnpj_vencedor (text)       → "cnpjVencedor"
        valor_vencedor (numeric)   → "valorVencedor"
        valor_contrato_real (numeric)   → "valorContratoReal" (Transparência)
        contrato_transparencia (text)   → "contratoTransparencia"
        contrato_vigencia_fim (text)    → "contratoVigenciaFim"
        contrato_fornecedor (text)      → "contratoFornecedor" (migration 0020)
        contrato_cnpj (text)            → "contratoCnpj"
        contrato_situacao (text)        → "contratoSituacao"
        contrato_aditivos (int)         → "contratoAditivos"
        contrato_moeda (text)           → "contratoMoeda"
        contrato_vigencia_inicio (text) → "contratoVigenciaInicio"
        total_participantes (int)  → "totalParticipantes"
        total_propostas (int)      → "totalPropostas"
        menor_valor (numeric)      → "menorValor"
        maior_valor (numeric)      → "maiorValor"
        status_resultado (text)    → "statusResultado"
        data_fim (text)            → "dataFim"
        detectado_em (timestamp)   → "detectadoEm"
        criado_em (timestamp)      → "criadoEm"
    petronect_lic_resultado (V2 primário; fallback legado): mesmas colunas +
        confidence_level (text)    → "confidenceLevel"
    petronect_lic_andamento (header V2):
        sub_status (text)          → "subStatus"
        status_desc (text)         → "statusPetronect"
        dispute_mode (text)        → "disputeMode"
        end_date (text)            → "dataFim" (override)

NOTAS DE PARIDADE:
    - V2 PRIMÁRIO: ``fornecedorVencedor``/``cnpjVencedor``/``valorVencedor``/
      ``totalParticipantes``/``totalPropostas``/``menorValor``/``maiorValor``/
      ``statusResultado`` vêm de ``petronect_lic_resultado`` se houver linha
      casada por ``numero``; senão fallback para ``resultados_licitacao``.
      O nullish (``??``) do Next: campos numéricos inteiros e status passam
      direto; os ``toNum(...)`` viram número ou null.
    - ``valorMedio`` = AVG(valor_total) das propostas NÃO declinadas, com
      valor_total NOT NULL e > 0, agrupado por numero_licitacao; ausente → null.
    - ``proponenteParticipou`` = EXISTS de proposta cujo CNPJ (só dígitos via
      REGEXP_REPLACE) == "11222333000181" (config.proponente.cnpj normalizado).
    - ``toNum`` (Next): null → null; parseFloat → número, NaN → null. Replicado
      em ``_to_num`` (null-returning).
    - ``count()`` do Drizzle → número JS; ``count(*)`` do Postgres vem int no
      asyncpg — coerção explícita p/ int.
    - ``orderBy(desc/asc)`` do Drizzle NÃO emite NULLS explícito → mantém o
      default do Postgres (NULLS LAST p/ ASC, NULLS FIRST p/ DESC). Não
      adicionamos NULLS.
    - datetimes → .isoformat(); uuid → str(); numeric → número; jsonb → dict/list.
"""

from __future__ import annotations

import math
import re
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import CurrentUser, get_current_user, require_visualizar
from app.db.session import get_db
from app.routers.migrated._shared import (
    feature_resultados_habilitada,
    parse_int_js_or_default,
    serializar,
)

router = APIRouter()


# CNPJ Proponente — espelha normalizeCnpj(config.proponente.cnpj) (só dígitos).
# settings.proponente_cnpj = NEXT_PUBLIC_PROPONENTE_CNPJ ?? "11222333000181".
PROPONENTE_CNPJ = re.sub(
    r"\D", "", settings.proponente_cnpj or "11222333000181"
)

# Whitelist de ordenação (espelha o mapa sortColumn do Next). Default criado_em.
_SORT_COLUMNS: dict[str, str] = {
    "valor_vencedor": "valor_vencedor",
    "total_participantes": "total_participantes",
    "data_fim": "data_fim",
    "criado_em": "criado_em",
}

# Confidence levels que filtram via igualdade (espelha o includes do Next).
_CONFIDENCE_EQ = ("OFFICIAL", "RANKED", "PENDING")


# Gate de feature / parseInt / serializador: canônicos de _shared (as cópias
# locais que viviam aqui eram idênticas às consolidadas).
_feature_resultados_habilitada = feature_resultados_habilitada
_parse_int_js = parse_int_js_or_default
_serializar = serializar


def _to_num(v: Any) -> float | None:
    """Espelha ``toNum`` do Next: null → null; parseFloat → número, NaN → null."""
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(n):
        return None
    return n


@router.get("/api/resultados")
async def listar_resultados(
    request: Request,
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/resultados — réplica fiel do handler GET do Next (V2-primary)."""
    # ── GATE de feature (ANTES do auth, igual ao Next) ────────────────────────
    if not _feature_resultados_habilitada():
        return JSONResponse(
            content={"error": "Módulo em reconstrução"}, status_code=503
        )

    # ── Auth: requireVisualizar() ─────────────────────────────────────────────
    # No Next o gate de feature roda ANTES do auth; por isso chamamos o MESMO
    # dependency manualmente (e não via Depends, que rodaria antes do corpo e
    # devolveria 401 antes do 503 de feature).
    user: CurrentUser = await get_current_user(request)
    require_visualizar(user=user)

    qp = request.query_params

    # ── Paginação (parseInt sem guarda gerava OFFSET NaN; clamps iguais). ──────
    page = max(1, _parse_int_js(qp.get("page"), 1))
    limit = min(max(1, _parse_int_js(qp.get("limit"), 20)), 100)
    offset = (page - 1) * limit

    # ── Filtros. ──────────────────────────────────────────────────────────────
    search = qp.get("search") or ""
    segmento = qp.get("segmento") or ""
    natureza = qp.get("natureza") or ""
    empresa = qp.get("empresa") or ""
    cnpj_vencedor = qp.get("cnpj_vencedor") or ""
    periodo = qp.get("periodo") or ""
    confidence = (qp.get("confidence") or "ALL").upper()
    sub_status = qp.get("subStatus") or ""
    # Filtros novos: participação Proponente ("participou"|"venceu") e faixa de valor.
    proponente = qp.get("proponente") or ""
    valor_min = qp.get("valor_min") or ""
    valor_max = qp.get("valor_max") or ""
    # Presença de contrato REAL (Portal da Transparência): "" (sem filtro) |
    # "com" (valor_contrato_real IS NOT NULL) | "sem" (IS NULL).
    contrato = qp.get("contrato") or ""

    sort_by = qp.get("sort") or "criado_em"
    order = qp.get("order") or "desc"

    # ── WHERE clause (mistura legado + V2; mesma ordem do Drizzle). ───────────
    conds: list[str] = []
    params: dict[str, Any] = {}

    if search:
        params["search"] = f"%{search}%"
        conds.append(
            "(numero_licitacao ILIKE :search "
            "OR fornecedor_vencedor ILIKE :search "
            "OR objeto ILIKE :search)"
        )
    if segmento:
        params["segmento"] = segmento
        conds.append("segmento = :segmento")
    if natureza:
        params["natureza"] = natureza
        conds.append("natureza = :natureza")
    if empresa:
        params["empresa"] = f"%{empresa}%"
        conds.append("empresa ILIKE :empresa")
    if cnpj_vencedor:
        params["cnpj_vencedor"] = cnpj_vencedor
        conds.append("cnpj_vencedor = :cnpj_vencedor")

    # Participação Proponente: "participou" (proposta não declinada) ou "venceu".
    if proponente in ("participou", "venceu"):
        params["prop_cnpj"] = PROPONENTE_CNPJ
        if proponente == "participou":
            conds.append(
                "EXISTS (SELECT 1 FROM propostas_licitacao pk "
                "WHERE pk.numero_licitacao = resultados_licitacao.numero_licitacao "
                "AND regexp_replace(pk.cnpj, '[^0-9]', '', 'g') = :prop_cnpj "
                "AND pk.declinou = false)"
            )
        else:
            conds.append(
                "regexp_replace(cnpj_vencedor, '[^0-9]', '', 'g') = :prop_cnpj"
            )

    # Faixa de valor do vencedor (ignora sigilosos/nulos ao filtrar).
    if valor_min:
        try:
            params["valor_min"] = float(valor_min)
            conds.append("valor_vencedor >= :valor_min")
        except (TypeError, ValueError):
            pass
    if valor_max:
        try:
            params["valor_max"] = float(valor_max)
            conds.append("valor_vencedor <= :valor_max")
        except (TypeError, ValueError):
            pass

    # Presença de contrato REAL (Transparência): com/sem. Aplica no WHERE da
    # listagem — o count usa o mesmo WHERE, então a paginação respeita o filtro.
    if contrato == "com":
        conds.append("valor_contrato_real IS NOT NULL")
    elif contrato == "sem":
        conds.append("valor_contrato_real IS NULL")

    if periodo == "7d":
        conds.append("criado_em >= NOW() - INTERVAL '7 days'")
    elif periodo == "30d":
        conds.append("criado_em >= NOW() - INTERVAL '30 days'")
    elif periodo == "90d":
        conds.append("criado_em >= NOW() - INTERVAL '90 days'")

    # Filtro V2 (confidence_level) via EXISTS correlacionado.
    if confidence != "ALL":
        if confidence == "UNKNOWN":
            conf_where = "pr.confidence_level IS NULL"
        elif confidence in _CONFIDENCE_EQ:
            params["confidence"] = confidence
            conf_where = "pr.confidence_level = :confidence"
        else:
            conf_where = "1=1"
        conds.append(
            "EXISTS ("
            "SELECT 1 FROM petronect_lic_resultado pr "
            "WHERE pr.numero = resultados_licitacao.numero_licitacao "
            f"AND {conf_where})"
        )

    if sub_status:
        params["sub_status"] = sub_status
        conds.append(
            "EXISTS ("
            "SELECT 1 FROM petronect_lic_andamento pa "
            "WHERE pa.numero = resultados_licitacao.numero_licitacao "
            "AND pa.sub_status = :sub_status)"
        )

    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""

    # ── Count (count() do Drizzle → número). ──────────────────────────────────
    total_res = await db.execute(
        text("SELECT count(*) AS count FROM resultados_licitacao" + where_sql),
        params,
    )
    total = int(total_res.scalar_one())

    # ── Ordenação (whitelist; default criado_em; asc|desc). ───────────────────
    sort_column = _SORT_COLUMNS.get(sort_by, "criado_em")
    order_dir = "ASC" if order == "asc" else "DESC"

    # ── Linhas paginadas: projeção camelCase IDÊNTICA ao .select() do Drizzle. ─
    sql_data = text(
        """
        SELECT
            id                  AS "id",
            licitacao_id        AS "licitacaoId",
            numero_licitacao    AS "numeroLicitacao",
            objeto              AS "objeto",
            empresa             AS "empresa",
            segmento            AS "segmento",
            natureza            AS "natureza",
            fornecedor_vencedor AS "fornecedorVencedor",
            cnpj_vencedor       AS "cnpjVencedor",
            valor_vencedor      AS "valorVencedor",
            valor_contrato_real AS "valorContratoReal",
            contrato_transparencia AS "contratoTransparencia",
            contrato_vigencia_fim  AS "contratoVigenciaFim",
            contrato_fornecedor    AS "contratoFornecedor",
            contrato_cnpj          AS "contratoCnpj",
            contrato_situacao      AS "contratoSituacao",
            contrato_aditivos      AS "contratoAditivos",
            contrato_moeda         AS "contratoMoeda",
            contrato_vigencia_inicio AS "contratoVigenciaInicio",
            total_participantes AS "totalParticipantes",
            total_propostas     AS "totalPropostas",
            menor_valor         AS "menorValor",
            maior_valor         AS "maiorValor",
            status_resultado    AS "statusResultado",
            data_fim            AS "dataFim",
            detectado_em        AS "detectadoEm",
            criado_em           AS "criadoEm"
        FROM resultados_licitacao
        """
        + where_sql
        + f"""
        ORDER BY {sort_column} {order_dir}
        LIMIT :_limit OFFSET :_offset
        """
    )
    params_data = dict(params)
    params_data["_limit"] = limit
    params_data["_offset"] = offset

    result = await db.execute(sql_data, params_data)
    rows = [dict(r) for r in result.mappings().all()]

    numeros = [r["numeroLicitacao"] for r in rows]

    # ── Enriquecimento V2 (resultado + andamento) em lote. ────────────────────
    v2_resultado_map: dict[str, dict[str, Any]] = {}
    v2_andamento_map: dict[str, dict[str, Any]] = {}
    proponente_set: set[str] = set()
    valor_medio_map: dict[str, Any] = {}

    if numeros:
        in_params: dict[str, Any] = {}
        nomes = []
        for i, v in enumerate(numeros):
            chave = f"n_{i}"
            in_params[chave] = v
            nomes.append(f":{chave}")
        in_list = "(" + ", ".join(nomes) + ")"

        # petronect_lic_resultado (V2 primário).
        res_v2 = await db.execute(
            text(
                """
                SELECT
                    numero                AS "numero",
                    cnpj_vencedor         AS "cnpjVencedor",
                    fornecedor_vencedor   AS "fornecedorVencedor",
                    valor_vencedor        AS "valorVencedor",
                    total_participantes   AS "totalParticipantes",
                    total_propostas       AS "totalPropostas",
                    menor_valor           AS "menorValor",
                    maior_valor           AS "maiorValor",
                    status_resultado      AS "statusResultado",
                    confidence_level      AS "confidenceLevel"
                FROM petronect_lic_resultado
                WHERE numero IN """
                + in_list
            ),
            in_params,
        )
        v2_resultado_map = {r["numero"]: dict(r) for r in res_v2.mappings().all()}

        # petronect_lic_andamento (header V2).
        and_v2 = await db.execute(
            text(
                """
                SELECT
                    numero       AS "numero",
                    sub_status   AS "subStatus",
                    status       AS "status",
                    status_desc  AS "statusDesc",
                    dispute_mode AS "disputeMode",
                    end_date     AS "endDate"
                FROM petronect_lic_andamento
                WHERE numero IN """
                + in_list
            ),
            in_params,
        )
        v2_andamento_map = {r["numero"]: dict(r) for r in and_v2.mappings().all()}

        # Proponente participou? (CNPJ só-dígitos == config.proponente.cnpj).
        prop_params = dict(in_params)
        prop_params["cnpj_digits"] = PROPONENTE_CNPJ
        prop_res = await db.execute(
            text(
                """
                SELECT numero_licitacao AS "numero"
                FROM propostas_licitacao
                WHERE REGEXP_REPLACE(cnpj, '[^0-9]', '', 'g') = :cnpj_digits
                  AND numero_licitacao IN """
                + in_list
            ),
            prop_params,
        )
        proponente_set = {r["numero"] for r in prop_res.mappings().all()}

        # Média orçada: AVG(valor_total) por licitação (propostas válidas).
        vm_res = await db.execute(
            text(
                """
                SELECT
                    numero_licitacao    AS "numero",
                    AVG(valor_total)    AS "valorMedio"
                FROM propostas_licitacao
                WHERE numero_licitacao IN """
                + in_list
                + """
                  AND declinou = false
                  AND valor_total IS NOT NULL
                  AND valor_total > 0
                GROUP BY numero_licitacao
                """
            ),
            in_params,
        )
        valor_medio_map = {
            r["numero"]: r["valorMedio"] for r in vm_res.mappings().all()
        }

    # ── Monta o data.map (V2 primário; fallback legado). ──────────────────────
    #
    # Distinção de semântica do Next (REPLICAR FIELMENTE):
    #   • Campos com ``v2r?.x ?? r.x`` (nullish): caem no legado se v2r AUSENTE
    #     OU se v2r.x for null/undefined → _nullish() abaixo.
    #   • Campos com ``v2r ? toNum(v2r.x) : toNum(r.x)`` (ternário): a escolha é
    #     pela PRESENÇA do objeto v2r (não pelo valor do campo) → checa v2r.
    def _nullish(primario: Any, fallback: Any) -> Any:
        """Espelha ``primario ?? fallback`` do JS (null/undefined → fallback)."""
        return fallback if primario is None else primario

    data: list[dict[str, Any]] = []
    for r in rows:
        num = r["numeroLicitacao"]
        v2r = v2_resultado_map.get(num)
        v2a = v2_andamento_map.get(num)

        item: dict[str, Any] = {
            "id": _serializar(r["id"]),
            "licitacaoId": _serializar(r["licitacaoId"]),
            "numeroLicitacao": num,
            "objeto": r["objeto"],
            "empresa": r["empresa"],
            "segmento": r["segmento"],
            "natureza": r["natureza"],
            # Vencedor: V2 primário; fallback legado (nullish ??).
            "fornecedorVencedor": _nullish(
                v2r["fornecedorVencedor"] if v2r is not None else None,
                r["fornecedorVencedor"],
            ),
            "cnpjVencedor": _nullish(
                v2r["cnpjVencedor"] if v2r is not None else None,
                r["cnpjVencedor"],
            ),
            # Numéricos: ternário pela PRESENÇA de v2r (não nullish do campo).
            "valorVencedor": (
                _to_num(v2r["valorVencedor"]) if v2r is not None
                else _to_num(r["valorVencedor"])
            ),
            # Valor REAL do contrato (Portal da Transparência) — cron
            # transparencia-valores. Espelha toNum(r.valorContratoReal) e
            # passthrough dos campos text do Next.
            "valorContratoReal": _to_num(r["valorContratoReal"]),
            "contratoTransparencia": r["contratoTransparencia"],
            "contratoVigenciaFim": r["contratoVigenciaFim"],
            # Vencedor + metadados do contrato (migration 0020) — passthrough
            # (aditivos é integer; espelha o passthrough do Next).
            "contratoFornecedor": r["contratoFornecedor"],
            "contratoCnpj": r["contratoCnpj"],
            "contratoSituacao": r["contratoSituacao"],
            "contratoAditivos": r["contratoAditivos"],
            "contratoMoeda": r["contratoMoeda"],
            "contratoVigenciaInicio": r["contratoVigenciaInicio"],
            "totalParticipantes": _nullish(
                v2r["totalParticipantes"] if v2r is not None else None,
                r["totalParticipantes"],
            ),
            "totalPropostas": _nullish(
                v2r["totalPropostas"] if v2r is not None else None,
                r["totalPropostas"],
            ),
            "menorValor": (
                _to_num(v2r["menorValor"]) if v2r is not None
                else _to_num(r["menorValor"])
            ),
            "maiorValor": (
                _to_num(v2r["maiorValor"]) if v2r is not None
                else _to_num(r["maiorValor"])
            ),
            "valorMedio": _to_num(valor_medio_map.get(num)),
            # Status + confidence (V2) — nullish ??.
            "statusResultado": _nullish(
                v2r["statusResultado"] if v2r is not None else None,
                r["statusResultado"],
            ),
            "confidenceLevel": (
                v2r["confidenceLevel"] if v2r is not None else None
            ),
            # Header V2 — v2a?.campo ?? null.
            "subStatus": (v2a["subStatus"] if v2a is not None else None),
            "statusPetronect": (v2a["statusDesc"] if v2a is not None else None),
            "disputeMode": (v2a["disputeMode"] if v2a is not None else None),
            # Legacy — v2a?.endDate ?? r.dataFim (nullish).
            "dataFim": _nullish(
                v2a["endDate"] if v2a is not None else None,
                r["dataFim"],
            ),
            "detectadoEm": _serializar(r["detectadoEm"]),
            "criadoEm": _serializar(r["criadoEm"]),
            "proponenteParticipou": num in proponente_set,
        }
        data.append(item)

    pages = -(-total // limit) if limit else 0  # Math.ceil(total / limit)

    return JSONResponse(
        content={
            "data": data,
            "meta": {
                "total": total,
                "page": page,
                "limit": limit,
                "pages": pages,
            },
        }
    )
