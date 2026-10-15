"""Rota migrada (strangler-fig): GET /api/admin/audit-log.

Espelho 1:1 de ``src/app/api/admin/audit-log/route.ts`` (Next.js) — paridade de
resposta byte-a-byte com o BFF FastAPI.

Dois modos (decididos pela presença de ``entidade`` + ``entidadeId``):

  - Por entidade  (``?entidade=X&entidadeId=Y``)
        guard: require_visualizar (qualquer visualizador)
        query: listarAuditoria — histórico da entidade, mais recente primeiro,
               com nome/email do usuário (LEFT JOIN users), LIMIT 100.
        shape: ``{ "data": [ {id, acao, detalhes, criadoEm, userId, userNome,
               userEmail}, ... ] }``

  - Lista geral   (sem entidade/entidadeId)
        guard: require_admin (apenas ADMIN)
        query: listarTodaAuditoria — paginado com filtros opcionais
               (entidade, userId, acao), ordenado por criado_em DESC,
               LIMIT/OFFSET, e total via count(*)::int.
        shape: ``{ "rows": [ {id, acao, entidade, entidadeId, detalhes,
               criadoEm, userId, userNome, userEmail}, ... ], "total": N }``
        (NOTE: a rota Next devolve ``result`` cru — SEM envelope ``{data}``.)

Detalhes de serialização (paridade JSON):
  - ``criado_em`` (timestamp SEM timezone no schema Drizzle) → ISO via
    ``datetime.isoformat()`` (o asyncpg devolve ``datetime`` nativo).
  - ``detalhes`` (jsonb) → já vem como dict/list parseado pelo asyncpg.
  - ``id`` (serial/int) e ``count`` (::int) → permanecem inteiros.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    ROLE_ADMIN,
    CurrentUser,
    require_visualizar,
)
from app.db.session import get_db

router = APIRouter()


def _jsonable(value):
    """Normaliza um valor de coluna para algo JSON-serializável (paridade Next).

    O ``json.dumps`` padrão do ``JSONResponse`` não serializa ``uuid.UUID``,
    ``datetime``, ``date`` nem ``Decimal`` — daí o
    ``TypeError: Object of type UUID is not JSON serializable``. O asyncpg
    devolve ``user_id`` (coluna ``uuid``) como ``uuid.UUID``; o Drizzle/pg
    devolve uuid como STRING. Convertendo aqui mantemos a resposta idêntica ao
    Next (e ``None``/``NULL`` permanece ``null``, como no LEFT JOIN do Drizzle).

    - ``UUID``      → ``str`` (ex.: ``user_id``; paridade com Drizzle uuid→string).
    - ``datetime``  → ISO 8601 via ``isoformat()`` (``criado_em``).
    - ``date``      → ISO 8601 via ``isoformat()``.
    - ``Decimal``   → ``float`` (paridade com numeric→number do pg/Drizzle).
    - jsonb (dict/list) e escalares (int/str/None) já são serializáveis.
    """
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _linha(row) -> dict:
    """Converte uma Row do SQLAlchemy num dict com valores JSON-ready."""
    return {chave: _jsonable(valor) for chave, valor in row._mapping.items()}


@router.get("/api/admin/audit-log")
async def get_audit_log(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
):
    """GET /api/admin/audit-log — paridade 1:1 com a rota Next.

    O guard mínimo (``require_visualizar``) cobre o modo por-entidade. O modo
    lista-geral é re-protegido como ADMIN dentro do handler (espelha o
    ``requireAdmin()`` da rota Next, que só roda quando não há entidade/id).
    """
    params = request.query_params
    entidade = params.get("entidade")
    entidade_id = params.get("entidadeId")

    # ── Modo histórico por entidade — qualquer visualizador ───────────────────
    if entidade and entidade_id:
        # require_visualizar já validou (dependency acima).
        sql = text(
            """
            SELECT
                a.id          AS "id",
                a.acao        AS "acao",
                a.detalhes    AS "detalhes",
                a.criado_em   AS "criadoEm",
                a.user_id     AS "userId",
                u.nome        AS "userNome",
                u.email       AS "userEmail"
            FROM audit_log a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE a.entidade = :entidade
              AND a.entidade_id = :entidade_id
            ORDER BY a.criado_em DESC
            LIMIT 100
            """
        )
        result = await db.execute(
            sql, {"entidade": entidade, "entidade_id": entidade_id}
        )
        data = [_linha(row) for row in result.all()]
        return JSONResponse(content={"data": data})

    # ── Modo lista geral — apenas ADMIN ───────────────────────────────────────
    # Espelha o requireAdmin() da rota Next (que só roda neste ramo). O guard de
    # dependency (require_visualizar) só garante sessão+visualização; aqui
    # elevamos para ADMIN como no Next.
    if user.role != ROLE_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Permissão negada"
        )

    user_id = params.get("userId") or None
    acao = params.get("acao") or None

    # ── Coerção limit/offset: paridade EXATA com o Next ───────────────────────
    # Next: parseInt(searchParams.get("limit") ?? "50") — parseInt do JS faz
    # parse PARCIAL (prefixo numérico; NaN se não começa com dígito).
    #   limit  = Math.min(200, Math.max(1, parseInt(...)))
    #   offset = Math.max(0, parseInt(...))
    #
    # O resultado vai para o Drizzle: ``.limit(limit ?? 50)`` / ``.offset(offset ?? 0)``.
    # Como o clamp produz NaN (não null), o ``?? default`` NÃO dispara: passa NaN.
    # No dialeto pg do Drizzle (dialect.cjs):
    #   - LIMIT  só é emitido se ``typeof limit === "number" && limit >= 0`` →
    #     com NaN (``NaN >= 0`` é false) a cláusula LIMIT SOME (retorna tudo).
    #   - OFFSET só é emitido se ``offset`` for truthy → NaN e 0 são falsy, logo
    #     ambos OMITEM o OFFSET (equivalente a OFFSET 0).
    #
    # Por isso ``_js_parse_int`` devolve ``None`` para o NaN do JS, e aqui
    # decidimos emitir/omitir cada cláusula como o Drizzle faria.

    # absente (None) → searchParams.get devolve null → vira "50"/"0" antes do parseInt.
    raw_limit = params.get("limit")
    limit_prefix = _js_parse_int(raw_limit if raw_limit is not None else "50")
    if limit_prefix is None:
        # NaN no Next → LIMIT some no Drizzle → sem LIMIT (retorna tudo).
        limit = None
    else:
        limit = min(200, max(1, limit_prefix))

    raw_offset = params.get("offset")
    offset_prefix = _js_parse_int(raw_offset if raw_offset is not None else "0")
    if offset_prefix is None:
        # NaN no Next → OFFSET falsy → OFFSET some (equivale a OFFSET 0).
        offset = 0
    else:
        offset = max(0, offset_prefix)

    # WHERE dinâmico (entidade/userId/acao são opcionais), igual ao Drizzle.
    filtros = []
    binds: dict = {}
    if entidade:
        filtros.append("a.entidade = :f_entidade")
        binds["f_entidade"] = entidade
    if user_id:
        filtros.append("a.user_id = :f_user_id")
        binds["f_user_id"] = user_id
    if acao:
        filtros.append("a.acao = :f_acao")
        binds["f_acao"] = acao
    where_clause = (" WHERE " + " AND ".join(filtros)) if filtros else ""

    # Cláusula LIMIT é CONDICIONAL (paridade Drizzle): com NaN no Next o LIMIT
    # some por completo (retorna tudo). OFFSET é sempre seguro emitir (OFFSET 0
    # == sem OFFSET no pg). Mantemos OFFSET :offset para simplicidade.
    limit_clause = "LIMIT :limit " if limit is not None else ""
    sql_rows = text(
        f"""
        SELECT
            a.id          AS "id",
            a.acao        AS "acao",
            a.entidade    AS "entidade",
            a.entidade_id AS "entidadeId",
            a.detalhes    AS "detalhes",
            a.criado_em   AS "criadoEm",
            a.user_id     AS "userId",
            u.nome        AS "userNome",
            u.email       AS "userEmail"
        FROM audit_log a
        LEFT JOIN users u ON a.user_id = u.id
        {where_clause}
        ORDER BY a.criado_em DESC
        {limit_clause}OFFSET :offset
        """
    )
    sql_count = text(
        f"""
        SELECT count(*)::int AS count
        FROM audit_log a
        {where_clause}
        """
    )

    row_binds = {**binds, "offset": offset}
    if limit is not None:
        row_binds["limit"] = limit
    rows_result = await db.execute(sql_rows, row_binds)
    rows = [_linha(row) for row in rows_result.all()]

    count_result = await db.execute(sql_count, binds)
    count = count_result.scalar()
    total = int(count or 0)

    # Paridade: a rota Next devolve ``result`` cru ({rows, total}), SEM {data}.
    return JSONResponse(content={"rows": rows, "total": total})


# parseInt do JS: strip de whitespace inicial, sinal opcional, prefixo numérico
# (radix 16 se começar com 0x/0X, senão radix 10). Para no 1º caractere inválido.
# Devolve o prefixo já convertido, ou ``None`` para o NaN do JS (sem dígito inicial).
_JS_PARSEINT_RE = re.compile(r"^([+-]?)(0[xX][0-9a-fA-F]+|[0-9]+)")
# WhiteSpace + LineTerminator que o JS strip antes do parse (Annex: StrWhiteSpace).
_JS_LEADING_WS = " \t\n\r\f\v                 　﻿"


def _js_parse_int(valor):
    """Espelha ``parseInt(string)`` do JS (parse PARCIAL).

    Diferente de ``int(str.strip())``, replica o comportamento real do Next:

      - ``"150abc"`` → ``150`` (prefixo numérico; ignora o resto).
      - ``"3.9"``    → ``3``  (o ``.`` interrompe o parse).
      - ``"0x1F"``   → ``31`` (radix 16 automático no prefixo ``0x``).
      - ``"+7"`` → ``7``; ``"-5"`` → ``-5``; ``"  42  "`` → ``42``.
      - ``"abc"`` / ``""`` / ``"  "`` → ``None`` (o NaN do JS).

    Retornar ``None`` (e não um default) é essencial: o caller decide, igual ao
    dialeto Drizzle, se a cláusula deve ser OMITIDA (LIMIT NaN → sem LIMIT).
    """
    if valor is None:
        return None
    s = str(valor).lstrip(_JS_LEADING_WS)
    m = _JS_PARSEINT_RE.match(s)
    if m is None:
        return None
    sinal = -1 if m.group(1) == "-" else 1
    corpo = m.group(2)
    if corpo[:2] in ("0x", "0X"):
        return sinal * int(corpo, 16)
    return sinal * int(corpo, 10)
