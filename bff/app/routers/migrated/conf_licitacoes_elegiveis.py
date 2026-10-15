"""Rota migrada (strangler-fig): GET /api/conformidade/licitacoes-elegiveis.

Equivalente 1:1 de
``src/app/api/conformidade/licitacoes-elegiveis/route.ts`` (handler GET).

Retorna licitações candidatas a virar envelope (autocomplete da tela
``/conformidade/envelopes/novo``), excluindo as que já têm envelope.

Guard Next:
    ``requireAuth()`` (401 se sem sessão) +
    ``podeGerenciarEnvelope(role)`` → ``isConformidade(role)`` →
    role ∈ {ADMIN, LIDER, SGI}, senão 403 ``{ "error": "Permissão negada" }``.
Equivalente no BFF: :data:`app.core.security.require_conformidade`
(ADMIN, LIDER, SGI). A negação de role devolve 403 e o 401 vem de
``get_current_user`` por baixo.

Query params lidos (iguais ao Next):
    ``?q=`` — texto de busca (trim); ILIKE em numero/objeto/empresa.
    Default: "" (vazio → sem filtro de texto).

Lógica replicada do Drizzle (mesma ordem/joins/limites):
    1. ``SELECT DISTINCT licitacao_id FROM envelopes_habilitacao`` e filtra
       os NULL (espelha ``.filter((x) => !!x)``) → ``idsExcluir``.
    2. Filtros condicionais:
         - se ``q``: ``(numero ILIKE %q% OR objeto ILIKE %q% OR empresa ILIKE %q%)``
         - se ``idsExcluir``: ``id NOT IN (...)``
       WHERE só existe se houver ao menos uma condição (espelha o
       ``where = conds.length > 0 ? and(...conds) : undefined`` do Drizzle;
       ``.where(undefined)`` → sem cláusula WHERE).
    3. Projeção (aliases camelCase IGUAIS às props do Drizzle):
         id, numero, objeto, empresa, status, fase, dataFim.
    4. ``ORDER BY atualizado_em DESC`` (coluna ``atualizadoEm``), ``LIMIT 20``.

Shape da resposta: ``{ "data": [ {...} ] }``.

Colunas (snake_case no banco → camelCase no Drizzle/alias):
    licitacoes.id (uuid) → "id"
    licitacoes.numero (text) → "numero"
    licitacoes.objeto (text) → "objeto"
    licitacoes.empresa (text) → "empresa"
    licitacoes.status (text) → "status"
    licitacoes.fase (text) → "fase"
    licitacoes.data_fim (text) → "dataFim"
    licitacoes.atualizado_em (timestamp) → ordenação (não projetado)
    envelopes_habilitacao.licitacao_id (uuid) → exclusão
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_conformidade
from app.db.session import get_db

# Serializador canônico (a cópia local era idêntica) — ver _shared.py.
from app.routers.migrated._shared import serializar as _serializar

router = APIRouter()


@router.get("/api/conformidade/licitacoes-elegiveis")
async def listar_licitacoes_elegiveis(
    request: Request,
    user: CurrentUser = Depends(require_conformidade),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/conformidade/licitacoes-elegiveis?q=texto.

    Réplica fiel do handler GET do Next: licitações sem envelope, filtradas
    por ``q`` (opcional) e ordenadas por ``atualizado_em DESC``, limite 20.
    """
    # ── Query param ``q`` (trim), default "" — igual ao Next. ─────────────────
    q = (request.query_params.get("q") or "").strip()

    # ── 1) IDs de licitações que já têm envelope (exclui do resultado). ───────
    # Espelha: db.selectDistinct({ id: envelopesHabilitacao.licitacaoId }) +
    # .filter((x) => !!x) — descarta NULLs.
    res_excluir = await db.execute(
        text(
            "SELECT DISTINCT licitacao_id AS id FROM envelopes_habilitacao"
        )
    )
    ids_excluir = [r["id"] for r in res_excluir.mappings().all() if r["id"]]

    # ── 2) Monta WHERE condicional (espelha and(...conds) | undefined). ───────
    conds: list[str] = []
    params: dict[str, Any] = {}

    if q:
        params["termo"] = f"%{q}%"
        conds.append(
            "(numero ILIKE :termo OR objeto ILIKE :termo OR empresa ILIKE :termo)"
        )

    if ids_excluir:
        nomes = []
        for i, valor in enumerate(ids_excluir):
            chave = f"ex_{i}"
            params[chave] = str(valor)
            nomes.append(f":{chave}")
        conds.append("id NOT IN (" + ", ".join(nomes) + ")")

    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""

    # ── 3) Projeção camelCase + 4) ORDER BY atualizado_em DESC, LIMIT 20. ─────
    sql = text(
        """
        SELECT
            id        AS "id",
            numero    AS "numero",
            objeto    AS "objeto",
            empresa   AS "empresa",
            status    AS "status",
            fase      AS "fase",
            data_fim  AS "dataFim"
        FROM licitacoes
        """
        + where_sql
        + """
        ORDER BY atualizado_em DESC
        LIMIT 20
        """
    )

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    data = [
        {chave: _serializar(valor) for chave, valor in row.items()} for row in rows
    ]

    return JSONResponse(content={"data": data})
