"""Rota migrada (strangler-fig): GET /api/perfis.

Equivalente 1:1 de ``src/app/api/perfis/route.ts`` (handler GET):

    const perfis = await db.select().from(perfisInteresse)
        .orderBy(desc(perfisInteresse.criadoEm));
    return NextResponse.json({ data: perfis });

Tabela: ``perfis_interesse`` (Drizzle ``perfisInteresse``).
Guard Next: ``requireAuth()`` → apenas sessão válida (qualquer papel
autenticado, sem restrição de role). Equivalente no BFF:
:func:`app.core.security.get_current_user`.

Shape da resposta: ``{ "data": [ {...} ] }`` com chaves camelCase IDÊNTICAS
às propriedades do schema Drizzle:
    id, nome, descricao, ativo, filtros, criadoEm, atualizadoEm.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, get_current_user
from app.db.session import get_db

# Serializador canônico (a cópia local era idêntica) — ver _shared.py.
from app.routers.migrated._shared import serializar as _serializar

router = APIRouter()


@router.get("/api/perfis")
async def listar_perfis(
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/perfis — lista perfis de interesse (ordem por criado_em DESC).

    Replica a query do Drizzle: ``SELECT * FROM perfis_interesse ORDER BY
    criado_em DESC``. Projeta as colunas como aliases camelCase IGUAIS às
    propriedades do schema Drizzle, preservando a ordem de declaração.
    """
    sql = text(
        """
        SELECT
            id            AS "id",
            nome          AS "nome",
            descricao     AS "descricao",
            ativo         AS "ativo",
            filtros       AS "filtros",
            criado_em     AS "criadoEm",
            atualizado_em AS "atualizadoEm"
        FROM perfis_interesse
        ORDER BY criado_em DESC
        """
    )

    result = await db.execute(sql)
    rows = result.mappings().all()

    data = [{chave: _serializar(valor) for chave, valor in row.items()} for row in rows]

    return JSONResponse(content={"data": data})
