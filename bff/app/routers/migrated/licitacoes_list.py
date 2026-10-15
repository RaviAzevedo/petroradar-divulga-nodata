"""Rota migrada (strangler-fig): GET /api/licitacoes.

Equivalente 1:1 do handler GET de
``src/app/api/licitacoes/route.ts`` — listagem paginada/filtrada de licitações
com a correção de fase em tempo real (``faseAtualizada``) e o cálculo de
cobertura de habilitação CRC por página.

Guard Next:
    ``requireVisualizar()`` (401 se sem sessão; 403 ``{ "error": "Permissão
    negada" }`` se role ∉ ROLES_VISUALIZAR). Equivalente no BFF:
    :data:`app.core.security.require_visualizar` (ADMIN, LIDER, ORCAMENTISTA,
    TECNICO, SGI, VISUALIZADOR).

Query params lidos (mesmos nomes/defaults/clamps do Next):
    page          int  default 1   clamp >=1  (parseInt || 1; Math.max(1, .))
    limit         int  default 20  clamp 1..100
    search        str  default ""   ILIKE em objeto/numero/regioes/empresa
    empresa       str  default ""   ILIKE em empresa
    fonte         str  default ""   petronect|transparencia (fonte = <valor>)
    relevancia    csv  IN (...)     split "," + filter(Boolean)
    natureza      csv  IN (...)
    fase          csv  IN (...)
    segmento      csv  IN (...)
    data_fim_de   str  >= (text)    (ignorado se ``prazo`` presente e válido)
    data_fim_ate  str  <= (text)
    data_pub_de   str  >=
    data_pub_ate  str  <=
    data_inicio_de  str >=
    data_inicio_ate str <=
    prazo         str  hoje|7d|30d|vencidas (prioridade sobre data_fim_*)
    sort          str  default "score_interesse" (whitelist)
    order         str  default "desc" (asc|desc)
    novas         "1"  criado_em >= NOW() - 24h
    com_circulares "1" EXISTS circulares

Shape da resposta (idêntico ao Next):
    {
      "data": [ { ...colunas camelCase, fase: <corrigida>, habilitacao } ],
      "meta": { "total": int, "page": int, "limit": int, "pages": int }
    }

Colunas (snake_case no banco → camelCase no Drizzle/alias projetado):
    id (uuid)              → "id"
    numero (text)         → "numero"
    fonte (text)          → "fonte"  ('petronect' | 'transparencia')
    objeto (text)         → "objeto"
    empresa (text)        → "empresa"
    status (text)         → "status"
    sub_status (text)     → "subStatus"
    fase (text)           → "fase"  (sobrescrito por faseAtualizada)
    modalidade (text)     → "modalidade"
    data_inicio (text)    → "dataInicio"
    data_fim (text)       → "dataFim"
    hora_fim (text)       → "horaFim"
    data_publicacao (text)→ "dataPublicacao"
    data_disputa (text)   → "dataDisputa"
    natureza (text)       → "natureza"
    tipo_servico (text)   → "tipoServico"
    segmento (text)       → "segmento"
    relevancia (text)     → "relevancia"
    score_interesse (int) → "scoreInteresse"
    regioes (text)        → "regioes"
    abrangencia (text)    → "abrangencia"
    criado_em (timestamp) → "criadoEm"  (serializado via .isoformat())

NOTAS DE PARIDADE:
    - O Drizzle ``orderBy(desc(col))``/``asc(col)`` NÃO emite cláusula NULLS
      explícita → mantemos o default do Postgres (NULLS LAST p/ ASC, NULLS
      FIRST p/ DESC). Não adicionamos NULLS.
    - ``count()`` do Drizzle vira número JS; o ``count(*)`` do Postgres vem
      como ``int`` no asyncpg — coerção explícita p/ ``int``.
    - ``faseAtualizada`` (src/lib/utils.ts) replicada em ``_fase_atualizada``:
      só "Recebendo Propostas" e "Agendada (Futura)" vencem; vira "Prazo
      Encerrado" se dias_restantes < 0 (data local, meia-noite).
    - A cobertura de habilitação é uma única query agrupada sobre os ids da
      página, com a MESMA normalização (regexp_replace upper [^A-Z0-9]) e o
      MESMO CASE (SEM_ITENS / COBERTO / NENHUM / PARCIAL). Licitações sem
      nenhum item (não aparecem no GROUP BY) → "SEM_ITENS".
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db
from app.routers.migrated._licitacoes_filtros import construir_where_licitacoes

# Helpers canônicos (parseInt ||default / serializador) — ver _shared.py.
from app.routers.migrated._shared import (
    parse_int_js_or_default,
    serializar,
)

router = APIRouter()


# ── Whitelist de ordenação (espelha o mapa sortColumn do Next) ────────────────
# sortBy → coluna física (snake_case). Default: score_interesse.
_SORT_COLUMNS: dict[str, str] = {
    "score_interesse": "score_interesse",
    "data_inicio": "data_inicio",
    "data_fim": "data_fim",
    "data_publicacao": "data_publicacao",
    "numero": "numero",
    "empresa": "empresa",
    "relevancia": "relevancia",
}

# Fases que "vencem" (espelha fasesQueVencem de faseAtualizada em utils.ts).
_FASES_QUE_VENCEM = ("Recebendo Propostas", "Agendada (Futura)")


# parseInt ||default: canônico de _shared (a cópia local era idêntica).
_parse_int_js = parse_int_js_or_default


def _dias_restantes(data_fim: str | None) -> int | None:
    """Replica diasRestantes(dataFim) de utils.ts (data LOCAL, meia-noite).

    Parseia YYYY-MM-DD como data local; outros formatos via fromisoformat.
    Retorna ceil((fim - hoje) / 1 dia) em dias, ou None se inválido/ausente.
    """
    if not data_fim:
        return None
    fim: date | None = None
    s = data_fim.strip()
    # Formato YYYY-MM-DD puro → data local.
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        try:
            fim = date(int(s[0:4]), int(s[5:7]), int(s[8:10]))
        except ValueError:
            fim = None
    if fim is None:
        try:
            fim = datetime.fromisoformat(s).date()
        except ValueError:
            return None
    hoje = date.today()
    # diff em dias inteiros; date subtraction já é em dias (meia-noite).
    return (fim - hoje).days


def _fase_atualizada(fase: str | None, data_fim: str | None) -> str:
    """Replica faseAtualizada(fase, dataFim) de utils.ts.

    - fase falsy → "—".
    - sem dataFim → fase.
    - fase ∉ fasesQueVencem → fase (preserva terminais/portal).
    - dias_restantes < 0 → "Prazo Encerrado".
    """
    if not fase:
        return "—"  # "—" (em dash), igual ao utils.ts
    if not data_fim:
        return fase
    if fase not in _FASES_QUE_VENCEM:
        return fase
    dias = _dias_restantes(data_fim)
    if dias is not None and dias < 0:
        return "Prazo Encerrado"
    return fase


# Serializador canônico (a cópia local era idêntica) — ver _shared.py.
_serializar = serializar


@router.get("/api/licitacoes")
async def listar_licitacoes(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/licitacoes — réplica fiel do handler GET do Next."""
    qp = request.query_params

    # ── Paginação (parseInt sem guarda gerava OFFSET NaN; clamps iguais). ──────
    page = max(1, _parse_int_js(qp.get("page"), 1))
    limit = min(max(1, _parse_int_js(qp.get("limit"), 20)), 100)
    offset = (page - 1) * limit

    # Ordenação.
    sort_by = qp.get("sort") or "score_interesse"
    order = qp.get("order") or "desc"

    # ── Build WHERE ───────────────────────────────────────────────────────────
    # Construtor EXTRAIDO para _licitacoes_filtros.py (2026-08-05) para que o
    # /api/licitacoes/export use exatamente as mesmas condicoes — antes o export
    # ignorava todos os filtros e devolvia a base inteira.
    conds, params = construir_where_licitacoes(qp)

    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""

    # ── Total (count() do Drizzle → número). ──────────────────────────────────
    total_res = await db.execute(
        text("SELECT count(*) AS count FROM licitacoes" + where_sql), params
    )
    total = int(total_res.scalar_one())

    # ── Ordenação (whitelist; default score_interesse; asc|desc). ─────────────
    sort_column = _SORT_COLUMNS.get(sort_by, "score_interesse")
    order_dir = "ASC" if order == "asc" else "DESC"

    # ── Query principal: projeção camelCase IDÊNTICA ao .select() do Drizzle. ──
    sql_data = text(
        """
        SELECT
            id              AS "id",
            numero          AS "numero",
            fonte           AS "fonte",
            objeto          AS "objeto",
            empresa         AS "empresa",
            status          AS "status",
            sub_status      AS "subStatus",
            fase            AS "fase",
            modalidade      AS "modalidade",
            data_inicio     AS "dataInicio",
            data_fim        AS "dataFim",
            hora_fim        AS "horaFim",
            data_publicacao AS "dataPublicacao",
            data_disputa    AS "dataDisputa",
            natureza        AS "natureza",
            tipo_servico    AS "tipoServico",
            segmento        AS "segmento",
            relevancia      AS "relevancia",
            score_interesse AS "scoreInteresse",
            regioes         AS "regioes",
            abrangencia     AS "abrangencia",
            perfis_match    AS "perfisMatch",
            melhor_perfil   AS "melhorPerfil",
            criado_em       AS "criadoEm"
        FROM licitacoes
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

    # ── Cobertura de famílias CRC p/ os ids da página (UMA query agrupada). ────
    # Mesma normalização de normalizarCodigoCrc (regexp_replace upper [^A-Z0-9])
    # e mesmo CASE (SEM_ITENS / COBERTO / NENHUM / PARCIAL).
    hab_map: dict[str, str] = {}
    if rows:
        ids = [str(r["id"]) for r in rows]
        id_params: dict[str, Any] = {}
        nomes_id = []
        for i, v in enumerate(ids):
            chave = f"cid_{i}"
            id_params[chave] = v
            nomes_id.append(f":{chave}")
        cov_sql = text(
            """
            SELECT i.licitacao_id AS id,
              CASE
                WHEN COUNT(*) FILTER (WHERE i.familia IS NOT NULL AND i.familia <> '') = 0 THEN 'SEM_ITENS'
                WHEN COUNT(*) FILTER (WHERE m.ok) = COUNT(*) FILTER (WHERE i.familia IS NOT NULL AND i.familia <> '') THEN 'COBERTO'
                WHEN COUNT(*) FILTER (WHERE m.ok) = 0 THEN 'NENHUM'
                ELSE 'PARCIAL'
              END AS habilitacao
            FROM itens i
            LEFT JOIN LATERAL (
              SELECT EXISTS(
                SELECT 1 FROM familias f
                WHERE f.status = 'ATIVA'
                  AND f.deletado_em IS NULL
                  AND regexp_replace(upper(f.codigo_crc), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(i.familia), '[^A-Z0-9]', '', 'g')
              ) AS ok
            ) m ON true
            WHERE i.licitacao_id IN ("""
            + ", ".join(nomes_id)
            + """)
            GROUP BY i.licitacao_id
            """
        )
        cov_res = await db.execute(cov_sql, id_params)
        for cov in cov_res.mappings().all():
            hab_map[str(cov["id"])] = cov["habilitacao"]

    # ── Correção de fase + habilitacao (espelha dataCorrigida do Next). ───────
    data = []
    for r in rows:
        item = {chave: _serializar(valor) for chave, valor in r.items()}
        item["fase"] = _fase_atualizada(item["fase"], item["dataFim"])
        # Sem NENHUM item (ausente no GROUP BY) → SEM_ITENS.
        item["habilitacao"] = hab_map.get(str(r["id"]), "SEM_ITENS")
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
