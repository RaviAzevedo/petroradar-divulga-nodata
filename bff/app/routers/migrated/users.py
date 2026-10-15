"""Rota migrada: GET /api/users (estrangulador / strangler-fig).

Espelha 1:1 ``src/app/api/users/route.ts`` do app Next.js.

Lista usuários ATIVOS para uso em dropdowns de designação. Retorna apenas
``id``, ``nome``, ``email`` e ``role`` — sem dados sensíveis.

Guard: ``requireGestao`` no Next  →  :data:`require_gestao` no BFF
       (ADMIN, LIDER). Demais papéis recebem 403.

Query params:
    roles  (csv) — filtra por role: ex. "LIDER,ADMIN"

SHAPE da resposta (paridade com o Next): ``{ "users": [...] }`` com chaves
camelCase iguais às propriedades do schema Drizzle (id, nome, email, role).
ATENÇÃO: o Next NÃO usa ``{ "data": [...] }`` nesta rota — usa ``{ "users": [...] }``.
Replicamos o shape REAL para passar no teste de paridade.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_gestao
from app.db.session import get_db

router = APIRouter()


@router.get("/api/users")
async def listar_users(
    roles: str | None = None,
    user: CurrentUser = Depends(require_gestao),
    db=Depends(get_db),
):
    """Lista usuários ativos (id, nome, email, role) ordenados por nome.

    Replica a query Drizzle do Next:

        db.select({ id, nome, email, role })
          .from(users)
          .where(and(eq(users.ativo, true), [inArray(users.role, roles)]))
          .orderBy(users.nome)

    e o shape ``{ "users": [...] }``.
    """
    # roles (csv) → lista limpa, igual ao split/trim/filter(Boolean) do Next.
    roles_filtro = (
        [r.strip() for r in roles.split(",") if r.strip()] if roles else []
    )

    # SELECT com colunas projetadas como aliases camelCase IGUAIS às do Drizzle.
    # Filtro fixo: ativo = true. Filtro opcional: role = ANY(:roles). ORDER BY nome.
    sql = """
        SELECT
            id    AS "id",
            nome  AS "nome",
            email AS "email",
            role  AS "role"
        FROM users
        WHERE ativo = true
    """
    params: dict[str, object] = {}
    if roles_filtro:
        sql += " AND role = ANY(:roles)"
        params["roles"] = roles_filtro
    sql += " ORDER BY nome"

    result = await db.execute(text(sql), params)
    rows = result.mappings().all()

    # Serialização: as 4 colunas são uuid/text (id vem como uuid → str).
    # Nenhum datetime/numeric/jsonb nesta projeção. id como string p/ casar
    # com o JSON do Next (uuid serializa como string).
    lista = [
        {
            "id": str(r["id"]) if r["id"] is not None else None,
            "nome": r["nome"],
            "email": r["email"],
            "role": r["role"],
        }
        for r in rows
    ]

    return JSONResponse(content={"users": lista})
