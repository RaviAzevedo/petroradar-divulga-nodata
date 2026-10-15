"""Rota MIGRADA: GET /api/licitacoes/{id}/circulares (estrangulador).

Espelha 1:1 a rota Next:
  src/app/api/licitacoes/[id]/circulares/route.ts
    -> requireVisualizar()                 # sessão + ROLES_VISUALIZAR (barra EXTERNO)
    -> id = params.id
       if (!UUID_REGEX.test(id)) -> 400 { "error": "ID inválido" }
    -> db.select({ id, tipo, autor, mensagem, dataPublicacao,
                   anexoPhioObjid, anexoDescricao, criadoEm })
         .from(circulares)
         .where(eq(circulares.licitacaoId, id))
         .orderBy(desc(circulares.dataPublicacao))
    -> [countResult] = db.select({ count: count(*)::int })
         .from(circulares).where(eq(circulares.licitacaoId, id))
    -> NextResponse.json({ data, total: countResult?.count ?? 0 })

GUARD (RBAC hardening — FRENTE D, 2026-07-02): requireVisualizar() do Next ==
sessão válida + papel em ROLES_VISUALIZAR. BARRA EXTERNO (403 "Permissão
negada"/FORBIDDEN); 401 sem sessão. Antes era requireAuth (qualquer
autenticado), mas circulares são comunicações internas da licitação. O
equivalente no BFF é ``require_visualizar``.

SHAPE da resposta (== Next):

    {
      "data": [
        {
          "id": "<uuid>",
          "tipo": "<text>",
          "autor": "<text>"|null,
          "mensagem": "<text>"|null,
          "dataPublicacao": "<iso Z>"|null,
          "anexoPhioObjid": "<text>"|null,
          "anexoDescricao": "<text>"|null,
          "criadoEm": "<iso Z>"|null
        }, ...
      ],
      "total": <int>
    }

Aliases camelCase IGUAIS aos do Drizzle (schema.ts ``circulares``):
  id            <- id            (uuid)
  tipo          <- tipo          (text, NOT NULL default 'MENSAGEM')
  autor         <- autor         (text)
  mensagem      <- mensagem      (text)
  dataPublicacao<- data_publicacao (timestamp SEM tz)
  anexoPhioObjid<- anexo_phio_objid (text)
  anexoDescricao<- anexo_descricao  (text)
  criadoEm      <- criado_em     (timestamp SEM tz, default now())

SERIALIZAÇÃO de datetimes (paridade de WIRE):
  ``data_publicacao`` e ``criado_em`` são ``timestamp`` SEM timezone -> o asyncpg
  devolve ``datetime`` naive. O Drizzle (mode "date" default) entrega um JS
  ``Date`` e o ``NextResponse.json`` serializa via ``.toISOString()`` -> UTC, com
  MILISSEGUNDOS e sufixo ``Z`` (ex.: ``2026-06-08T12:34:56.000Z``). Usamos
  :func:`_js_to_iso_string` (não ``isoformat()`` puro, que daria ``+00:00`` e
  microssegundos) — convenção já adotada pelos irmãos migrados.

ORDENAÇÃO: ``desc(dataPublicacao)`` no Postgres é ``DESC`` => ``NULLS FIRST`` por
padrão. Replicamos literalmente ``ORDER BY data_publicacao DESC`` (mesmo
comportamento de NULLs).

Objetivo: JSON.parse(resp_bff) == JSON.parse(resp_next).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()

# Mesmo regex do Next (case-insensitive): valida formato canônico de UUID.
_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` do JS (UTC, ms, sufixo 'Z').

    ``data_publicacao``/``criado_em`` são ``timestamp`` SEM tz -> o asyncpg
    devolve ``datetime`` naive, que o JS interpreta como UTC ao serializar. O
    ``.toISOString()`` SEMPRE normaliza para UTC, com precisão de MILISSEGUNDOS e
    sufixo ``Z``. O ``datetime.isoformat()`` puro divergiria (``+00:00`` e
    microssegundos), então formatamos à mão.
    """
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


@router.get("/api/licitacoes/{id}/circulares")
async def get_circulares(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    # if (!UUID_REGEX.test(id)) -> 400 { "error": "ID inválido" }
    if not _UUID_REGEX.match(id):
        return JSONResponse(status_code=400, content={"error": "ID inválido"})

    # SELECT projetando aliases camelCase IGUAIS aos do Drizzle, mesmo filtro/ordem.
    rows_sql = text(
        """
        SELECT
          id,
          tipo,
          autor,
          mensagem,
          data_publicacao,
          anexo_phio_objid,
          anexo_descricao,
          criado_em
        FROM circulares
        WHERE licitacao_id = :id
        ORDER BY data_publicacao DESC
        """
    )

    # [countResult] = select({ count: sql`count(*)::int` }) ... where(eq(...))
    count_sql = text(
        """
        SELECT count(*)::int AS count
        FROM circulares
        WHERE licitacao_id = :id
        """
    )

    rows = (await db.execute(rows_sql, {"id": id})).mappings().all()
    count_row = (await db.execute(count_sql, {"id": id})).mappings().first()

    data = [
        {
            "id": str(r["id"]),
            "tipo": r["tipo"],
            "autor": r["autor"],
            "mensagem": r["mensagem"],
            "dataPublicacao": _js_to_iso_string(r["data_publicacao"]),
            "anexoPhioObjid": r["anexo_phio_objid"],
            "anexoDescricao": r["anexo_descricao"],
            "criadoEm": _js_to_iso_string(r["criado_em"]),
        }
        for r in rows
    ]

    # total: countResult?.count ?? 0
    total = count_row["count"] if count_row and count_row["count"] is not None else 0

    return JSONResponse(content={"data": data, "total": total})
