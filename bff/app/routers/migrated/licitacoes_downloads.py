"""Rota migrada (strangler-fig): GET /api/licitacoes/downloads.

Equivalente 1:1 do handler GET de
``src/app/api/licitacoes/downloads/route.ts`` — lista licitações com o total de
anexos para a página de downloads.

Guard Next (RBAC hardening — FRENTE D, 2026-07-02):
    ``requireVisualizar()`` → sessão válida + papel em ROLES_VISUALIZAR. BARRA
    EXTERNO (403 ``{ "error": "Permissão negada", "code": "FORBIDDEN" }``); 401
    ``{ "error": "Não autenticado", "code": "UNAUTHENTICATED" }`` se sem sessão.
    Antes era ``requireAuth`` (qualquer autenticado), mas a listagem expõe
    licitações internas + anexos. Equivalente no BFF:
    :func:`app.core.security.require_visualizar`.

Query params lidos (mesmos nomes/defaults do Next):
    search       str  default ""    ILIKE em objeto/numero
    relevancia   str  default ""    eq exato em relevancia
    com_anexos   "1"  filtro pós-query (mantém só linhas com totalAnexos > 0)
    page         int  default 1     (parseInt; sem clamp explícito no Next)
    limit        int  default 30    clamp <= 100 (Math.min)
    offset = (page - 1) * limit

Detalhes de paridade (replicados VERBATIM, inclusive comportamentos peculiares):
    - A subquery ``totais`` agrupa ``anexos`` por ``licitacao_id`` com
      ``COUNT(*) AS total`` e o LEFT JOIN traz ``COALESCE(totais.total, 0)`` como
      ``totalAnexos``.
    - O filtro ``com_anexos=1`` (``soComAnexos``) é aplicado em MEMÓRIA, APÓS o
      ``LIMIT/OFFSET`` — ou seja, filtra apenas as linhas da página corrente
      (exatamente como o ``.filter()`` JS do Next). NÃO mexe no ``total`` do meta.
    - ``ORDER BY score_interesse DESC`` (Drizzle ``desc()`` → default NULLS FIRST
      do Postgres; não emitimos NULLS).
    - ``total`` do meta é o ``count()`` sobre ``licitacoes`` com o MESMO WHERE,
      independente de anexos e independente do filtro ``com_anexos``.
    - ``pages = Math.ceil(total / limit)``.

Shape da resposta (idêntico ao Next):
    {
      "data": [ {
        "id", "numero", "objeto", "empresa", "fase", "dataFim",
        "relevancia", "scoreInteresse", "totalAnexos"
      } ],
      "meta": { "total": int, "page": int, "limit": int, "pages": int }
    }
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db
from app.routers.migrated._shared import serializar

router = APIRouter()


def _parse_int_js(valor: str | None, default: int) -> int:
    """Replica ``parseInt(x ?? "<default>")`` do JS (SEM ``|| default``).

    O Next faz ``parseInt(searchParams.get("page") ?? "1")``: quando o param
    está ausente usa a string default; quando presente lê o prefixo numérico.
    Diferente de listar_licitacoes, AQUI o Next NÃO tem fallback ``|| default``
    nem clamp para page — então ``page=0`` ou ``page=abc`` (NaN) propagam.

    Mantemos a fidelidade: ausente → default; presente sem dígitos → 0 (NaN do
    JS vira 0 na aritmética de offset abaixo, como no Next ``(NaN-1)*limit`` →
    NaN; aqui usamos 0 para não quebrar o SQL, mas o page=NaN não ocorre via
    query string típica — replicamos o caminho numérico).
    """
    s = valor if valor is not None else str(default)
    s = s.strip()
    i = 0
    n = len(s)
    if i < n and s[i] in "+-":
        i += 1
    j = i
    while j < n and s[j].isdigit():
        j += 1
    if j == i:  # sem dígitos → NaN no JS
        return 0
    try:
        return int(s[:j])
    except ValueError:
        return 0


# Serializador canônico (a cópia local era idêntica) — ver _shared.py.
_serializar = serializar


@router.get("/api/licitacoes/downloads")
async def listar_downloads(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/licitacoes/downloads — réplica fiel do handler GET do Next."""
    qp = request.query_params

    search = qp.get("search") or ""
    relevancia = qp.get("relevancia") or ""
    so_com_anexos = qp.get("com_anexos") == "1"
    page = _parse_int_js(qp.get("page"), 1)
    limit = min(_parse_int_js(qp.get("limit"), 30), 100)
    offset = (page - 1) * limit

    # ── Build WHERE (espelha a ordem/condições do Drizzle). ───────────────────
    conds: list[str] = []
    params: dict[str, Any] = {}

    if search:
        params["search"] = f"%{search}%"
        conds.append("(objeto ILIKE :search OR numero ILIKE :search)")

    if relevancia:
        params["relevancia"] = relevancia
        conds.append("relevancia = :relevancia")

    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""

    # ── Query principal: LEFT JOIN com a subquery de total de anexos. ─────────
    # Subquery ``totais``: COUNT(*) AS total por licitacao_id (anexos).
    # COALESCE(totais.total, 0) AS totalAnexos. ORDER BY score_interesse DESC.
    sql_data = text(
        """
        SELECT
            licitacoes.id              AS "id",
            licitacoes.numero          AS "numero",
            licitacoes.objeto          AS "objeto",
            licitacoes.empresa         AS "empresa",
            licitacoes.fase            AS "fase",
            licitacoes.data_fim        AS "dataFim",
            licitacoes.relevancia      AS "relevancia",
            licitacoes.score_interesse AS "scoreInteresse",
            COALESCE(totais.total, 0)  AS "totalAnexos"
        FROM licitacoes
        LEFT JOIN (
            SELECT licitacao_id, COUNT(*) AS total
            FROM anexos
            GROUP BY licitacao_id
        ) AS totais ON licitacoes.id = totais.licitacao_id
        """
        + where_sql
        + """
        ORDER BY licitacoes.score_interesse DESC
        LIMIT :_limit OFFSET :_offset
        """
    )

    params_data = dict(params)
    params_data["_limit"] = limit
    params_data["_offset"] = offset

    result = await db.execute(sql_data, params_data)
    rows = [dict(r) for r in result.mappings().all()]

    # ── Filtro soComAnexos: aplicado em MEMÓRIA, após o LIMIT/OFFSET (igual ──
    # ao .filter((r) => Number(r.totalAnexos) > 0) do Next). ───────────────────
    if so_com_anexos:
        filtered_rows = [r for r in rows if float(r["totalAnexos"]) > 0]
    else:
        filtered_rows = rows

    filtered = []
    for r in filtered_rows:
        d = {chave: _serializar(valor) for chave, valor in r.items()}
        # PARIDADE: node-postgres devolve COUNT(*) (bigint) como STRING; o Next
        # repassa `totalAnexos` como "3"/"0". asyncpg traz int -> castamos p/ str.
        if d.get("totalAnexos") is not None:
            d["totalAnexos"] = str(int(d["totalAnexos"]))
        filtered.append(d)

    # ── Total (count() do Drizzle sobre licitacoes com o MESMO WHERE). ────────
    total_res = await db.execute(
        text("SELECT count(*) AS count FROM licitacoes" + where_sql), params
    )
    total = int(total_res.scalar_one())

    pages = -(-total // limit) if limit else 0  # Math.ceil(total / limit)

    return JSONResponse(
        content={
            "data": filtered,
            "meta": {
                "total": total,
                "page": page,
                "limit": limit,
                "pages": pages,
            },
        }
    )
