"""Rota migrada (strangler-fig): /api/perfis/{id}.

Espelho 1:1 de ``src/app/api/perfis/[id]/route.ts`` (handlers PUT / DELETE) —
paridade de comportamento, status e shape de resposta com o BFF FastAPI.

route.ts original (verbatim)::

    import { db } from "@/db";
    import { perfisInteresse } from "@/db/schema";
    import { eq } from "drizzle-orm";
    import { requireGestao, handleApiError } from "@/lib/api/guards";

    export async function PUT(request, { params }) {
      try { await requireGestao(); } catch (e) { return handleApiError(e); }
      const { id } = await params;
      const body = await request.json();
      const [updated] = await db.update(perfisInteresse)
        .set({ ...body, atualizadoEm: new Date() })
        .where(eq(perfisInteresse.id, id))
        .returning();
      if (!updated) return NextResponse.json({ error: { message: "Perfil não encontrado" } }, { status: 404 });
      return NextResponse.json({ data: updated });
    }

    export async function DELETE(request, { params }) {
      try { await requireGestao(); } catch (e) { return handleApiError(e); }
      const { id } = await params;
      await db.delete(perfisInteresse).where(eq(perfisInteresse.id, id));
      return new NextResponse(null, { status: 204 });
    }

Tabela: ``perfis_interesse`` (Drizzle ``perfisInteresse``). Colunas/props::
    id, nome, descricao, ativo, filtros, criadoEm (criado_em),
    atualizadoEm (atualizado_em).

Guard do Next (replicado): ``requireGestao()`` = ``requireAuth()`` (401
``{error:"Não autenticado", code:"UNAUTHENTICATED"}``) seguido de ``isGestao``
(ADMIN/LIDER → 403 ``{error:"Apenas gestão", code:"FORBIDDEN"}``). O Next chama
``handleApiError(e)`` que converte o ``ApiError`` em ``{error: err.message,
code: err.code}`` — por isso fazemos auth MANUAL e devolvemos esse shape EXATO
(NÃO o ``{detail}`` default do FastAPI).

SET do UPDATE (paridade com Drizzle ``.set({ ...body, atualizadoEm: new Date() })``):
    O Drizzle só mapeia chaves do body que correspondem a PROPRIEDADES do schema
    (``nome``/``descricao``/``ativo``/``filtros``/``criadoEm``/``atualizadoEm``/
    ``id``). Chaves desconhecidas são silenciosamente ignoradas. ``atualizadoEm``
    é sempre sobrescrito por ``new Date()`` (vem por ÚLTIMO no spread, prevalece
    sobre um ``atualizadoEm`` do body). Replicamos esse whitelist + override.
    jsonb (``filtros``) → CAST(:p AS jsonb); timestamps recebidos no body →
    ``new Date(valor)``.

Serialização do retorno (``.returning()`` → objeto camelCase do Drizzle):
    timestamp → ISO 8601 (isoformat); uuid → str; jsonb → dict/list nativo
    (asyncpg parseia); bool/text → cru.
"""

from __future__ import annotations

import json as _json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text

from app.core.security import CurrentUser, get_current_user, is_gestao
from app.db.session import get_db

router = APIRouter()


# ── Serialização (paridade Next/Drizzle/pg) ───────────────────────────────────


def _jsonable(value: Any) -> Any:
    """Normaliza um valor de coluna para JSON (paridade com o objeto do Drizzle)."""
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    # dict/list (jsonb), int/float, bool, str → JSON-serializáveis nativos.
    return value


def _row_perfil(row) -> dict:
    """Projeta uma Row de ``perfis_interesse`` no objeto camelCase do Drizzle.

    Aliases IGUAIS às propriedades do schema (ordem de declaração):
    id, nome, descricao, ativo, filtros, criadoEm, atualizadoEm.
    """
    m = row._mapping
    return {
        "id": _jsonable(m["id"]),
        "nome": m["nome"],
        "descricao": m["descricao"],
        "ativo": m["ativo"],
        "filtros": m["filtros"],
        "criadoEm": _jsonable(m["criado_em"]),
        "atualizadoEm": _jsonable(m["atualizado_em"]),
    }


_PERFIL_COLS = (
    'id AS "id", nome AS "nome", descricao AS "descricao", ativo AS "ativo", '
    'filtros AS "filtros", criado_em AS "criado_em", atualizado_em AS "atualizado_em"'
)


def _parse_data(valor: Any) -> Any:
    """Espelha ``new Date(valor)`` p/ colunas timestamp recebidas no body.

    Aceita ISO 8601 com ``Z`` (normaliza p/ ``+00:00``). Valores não-string ou
    não-ISO são repassados crus (o ``new Date()`` do JS sobre lixo produziria
    ``Invalid Date``; mantemos paridade no caminho feliz).
    """
    if isinstance(valor, str):
        candidato = valor[:-1] + "+00:00" if valor.endswith("Z") else valor
        try:
            return datetime.fromisoformat(candidato)
        except ValueError:
            return valor
    return valor


# ── 401/403 com o shape do Next (handleApiError de requireGestao) ─────────────


async def _require_gestao_ou_resp(
    request: Request,
) -> tuple[CurrentUser | None, JSONResponse | None]:
    """Replica ``requireGestao()`` + ``handleApiError(e)`` do Next.

    Ordem: ``requireAuth()`` (401 ``{error:"Não autenticado",
    code:"UNAUTHENTICATED"}``) → ``isGestao`` (403 ``{error:"Apenas gestão",
    code:"FORBIDDEN"}``). Devolve ``(user, None)`` em sucesso ou
    ``(None, JSONResponse)`` no erro, com o shape EXATO do ``handleApiError``.
    """
    from fastapi import HTTPException

    try:
        user = await get_current_user(request)
    except HTTPException as exc:
        if exc.status_code == 401:
            return None, JSONResponse(
                status_code=401,
                content={"error": "Não autenticado", "code": "UNAUTHENTICATED"},
            )
        # Demais (ex.: 500 sem AUTH_SECRET) propagam o detail do FastAPI.
        return None, JSONResponse(
            status_code=exc.status_code, content={"error": exc.detail}
        )

    if not is_gestao(user.role):
        return None, JSONResponse(
            status_code=403,
            content={"error": "Apenas gestão", "code": "FORBIDDEN"},
        )
    return user, None


# ── PUT ────────────────────────────────────────────────────────────────────────


@router.put("/api/perfis/{id}")
async def atualizar_perfil(
    id: str,
    request: Request,
    db=Depends(get_db),
) -> Response:
    """PUT /api/perfis/{id} — atualiza um perfil de interesse.

    Ordem idêntica ao Next:
      1) ``requireGestao()`` (try/catch → handleApiError): 401/403 com shape
         ``{error, code}``;
      2) ``body = await request.json()``;
      3) UPDATE perfis_interesse SET <body mapeável> + atualizado_em = now
         WHERE id = :id RETURNING *;
      4) sem linha → 404 ``{error:{message:"Perfil não encontrado"}}``;
      5) 200 ``{data: <perfil>}``.
    """
    # (1) requireGestao → 401/403
    user, resp = await _require_gestao_ou_resp(request)
    if resp is not None:
        return resp
    assert user is not None

    # (2) body = await request.json(). No Next, um JSON inválido aqui estouraria
    # (sem try/catch no handler) e cairia no error boundary genérico do Next.
    # Mantemos o comportamento: parse cru (falha → 500 do framework).
    body = await request.json()

    # (3) Monta o SET espelhando `.set({ ...body, atualizadoEm: new Date() })`.
    # O Drizzle só aceita chaves que sejam PROPRIEDADES do schema; demais são
    # ignoradas. atualizadoEm é sempre sobrescrito por new Date() (último no
    # spread). NÃO incluímos `id` no SET (chave primária; o Drizzle permitiria,
    # mas o body realista não a traz — e não altera o WHERE de qualquer forma).
    set_clauses: list[str] = []
    params: dict[str, Any] = {"id": id}

    if isinstance(body, dict):
        if "nome" in body:
            set_clauses.append("nome = :nome")
            params["nome"] = body["nome"]
        if "descricao" in body:
            set_clauses.append("descricao = :descricao")
            params["descricao"] = body["descricao"]
        if "ativo" in body:
            set_clauses.append("ativo = :ativo")
            params["ativo"] = body["ativo"]
        if "filtros" in body:
            set_clauses.append("filtros = CAST(:filtros AS jsonb)")
            params["filtros"] = _json.dumps(body["filtros"], ensure_ascii=False)
        if "criadoEm" in body:
            set_clauses.append("criado_em = :criado_em")
            params["criado_em"] = _parse_data(body["criadoEm"])

    # atualizadoEm: new Date() — sempre, por último (prevalece sobre o body).
    #
    # now() do POSTGRES, nao um datetime do Python. `perfis_interesse.atualizado_em`
    # e `timestamp WITHOUT time zone`, e bindar um datetime AWARE nele fazia o
    # asyncpg estourar com "can't subtract offset-naive and offset-aware
    # datetimes" -> 500. Resultado: ATIVAR/DESATIVAR PERFIL quebrava
    # (o toggle de /perfis chama exatamente este PUT), e o perfil nunca
    # aparecia na matriz de e-mails porque nunca chegava a ficar ativo.
    #
    # Deixar o Postgres carimbar tambem mantem a coerencia com o lado Next: o
    # Drizzle manda a data com offset e o banco converte usando a timezone da
    # SESSAO (America/Sao_Paulo). Um `datetime.utcnow()` naive gravaria 3h a
    # frente do resto da base.
    set_clauses.append("atualizado_em = now()")

    set_sql = ", ".join(set_clauses)
    res = await db.execute(
        text(
            f"UPDATE perfis_interesse SET {set_sql} "
            f"WHERE id = :id RETURNING {_PERFIL_COLS}"
        ),
        params,
    )
    updated_row = res.first()

    # (4) sem linha → 404 {error:{message}}.
    if updated_row is None:
        await db.rollback()
        return JSONResponse(
            status_code=404,
            content={"error": {"message": "Perfil não encontrado"}},
        )

    await db.commit()

    # (5) 200 {data: <perfil>}.
    return JSONResponse(content={"data": _row_perfil(updated_row)})


# ── DELETE ──────────────────────────────────────────────────────────────────────


@router.delete("/api/perfis/{id}")
async def deletar_perfil(
    id: str,
    request: Request,
    db=Depends(get_db),
) -> Response:
    """DELETE /api/perfis/{id} — remove um perfil de interesse.

    Ordem idêntica ao Next:
      1) ``requireGestao()`` (try/catch → handleApiError): 401/403 ``{error, code}``;
      2) DELETE FROM perfis_interesse WHERE id = :id (sem checagem de existência);
      3) 204 sem corpo.
    """
    # (1) requireGestao → 401/403
    user, resp = await _require_gestao_ou_resp(request)
    if resp is not None:
        return resp
    assert user is not None

    # (2) db.delete(...).where(eq(id)). Não verifica existência (igual ao Next).
    await db.execute(
        text("DELETE FROM perfis_interesse WHERE id = :id"),
        {"id": id},
    )
    await db.commit()

    # (3) 204 sem corpo (new NextResponse(null, { status: 204 })).
    return Response(status_code=204)
