"""Rota migrada (strangler-fig): POST /api/perfis (criar perfil de interesse).

Equivalente 1:1 de ``src/app/api/perfis/route.ts`` (handler POST):

    export async function POST(request: NextRequest) {
      try {
        await requireGestao();
      } catch (e) {
        return handleApiError(e);
      }

      const body = await request.json();
      const { nome, descricao, filtros } = body;

      if (!nome || !filtros) {
        return NextResponse.json(
          { error: { message: "Nome e filtros são obrigatórios" } },
          { status: 400 },
        );
      }

      const [created] = await db.insert(perfisInteresse).values({
        nome,
        descricao: descricao || "",
        ativo: true,
        filtros,
      }).returning();

      return NextResponse.json({ data: created }, { status: 201 });
    }

Tabela: ``perfis_interesse`` (Drizzle ``perfisInteresse``). Colunas:
    id            uuid    PK   default gen_random_uuid()
    nome          text    NOT NULL
    descricao     text
    ativo         boolean default true
    filtros       jsonb   NOT NULL
    criado_em     timestamp default now()
    atualizado_em timestamp default now()

Guard Next: ``requireGestao()`` → ADMIN ou LIDER. Equivalente no BFF:
:data:`app.core.security.require_gestao`.

Shape da resposta: ``{ "data": {...} }`` com chaves camelCase IDÊNTICAS às
propriedades do schema Drizzle (id, nome, descricao, ativo, filtros, criadoEm,
atualizadoEm) e status HTTP 201.

Validação replicada VERBATIM do Next (truthiness JS):
    if (!nome || !filtros) → 400 { error: { message: "..." } }
``descricao || ""`` → string vazia quando descricao for falsy (None/"" /0/false).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_gestao
from app.db.session import get_db

# Serializador canônico (a cópia local era idêntica) — ver _shared.py.
from app.routers.migrated._shared import serializar as _serializar

router = APIRouter()


def _eh_falsy(valor: Any) -> bool:
    """Replica a truthiness do JavaScript para a checagem ``!nome || !filtros``.

    Em JS, ``!x`` é verdadeiro para: ``undefined``, ``null``, ``""``, ``0``,
    ``NaN`` e ``false``. Como ``body`` vem de ``request.json()``, os valores
    possíveis são tipos JSON: ``None`` (null/ausente), ``""``, ``0``/``0.0``,
    ``False``. Objetos/arrays/strings não-vazias e números != 0 são truthy.
    """
    if valor is None:
        return True
    if valor is False:
        return True
    if valor == 0 and isinstance(valor, (int, float)) and not isinstance(valor, bool):
        return True
    if valor == "":
        return True
    return False


@router.post("/api/perfis")
async def criar_perfil(
    request: Request,
    user: CurrentUser = Depends(require_gestao),
    db=Depends(get_db),
) -> JSONResponse:
    """POST /api/perfis — cria um perfil de interesse (somente gestão).

    Replica o handler POST do Next: lê o JSON do corpo, valida ``nome`` e
    ``filtros`` (truthiness JS), insere com ``descricao || ""`` e ``ativo = true``
    e devolve a linha criada (RETURNING) com status 201.
    """
    body = await request.json()
    nome = body.get("nome")
    descricao = body.get("descricao")
    filtros = body.get("filtros")

    # if (!nome || !filtros) → 400
    if _eh_falsy(nome) or _eh_falsy(filtros):
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "Nome e filtros são obrigatórios"}},
        )

    # descricao || "" — em JS qualquer valor falsy vira string vazia.
    descricao_valor = descricao if not _eh_falsy(descricao) else ""

    # INSERT ... RETURNING * (projeta como aliases camelCase do schema Drizzle).
    # ``id``/``criado_em``/``atualizado_em`` ficam a cargo dos defaults do banco
    # (gen_random_uuid()/now()), idênticos ao Drizzle.
    sql = text(
        """
        INSERT INTO perfis_interesse (nome, descricao, ativo, filtros)
        VALUES (:nome, :descricao, :ativo, CAST(:filtros AS jsonb))
        RETURNING
            id            AS "id",
            nome          AS "nome",
            descricao     AS "descricao",
            ativo         AS "ativo",
            filtros       AS "filtros",
            criado_em     AS "criadoEm",
            atualizado_em AS "atualizadoEm"
        """
    )

    import json as _json

    result = await db.execute(
        sql,
        {
            "nome": nome,
            "descricao": descricao_valor,
            "ativo": True,
            "filtros": _json.dumps(filtros),
        },
    )
    row = result.mappings().one()
    await db.commit()

    created = {chave: _serializar(valor) for chave, valor in row.items()}

    return JSONResponse(status_code=201, content={"data": created})
