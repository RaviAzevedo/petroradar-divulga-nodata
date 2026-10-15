"""
Router /bff/licitacoes (rota MIGRADA de exemplo do estrangulador).

Leitura paginada da tabela `licitacoes` (src/db/schema.ts). Usa o engine async
(get_db) com SQLAlchemy Core + text() e bind params (sem f-string em SQL). Exige
usuario autenticado (Depends(get_current_user)); a leitura de feed e liberada para
qualquer papel autenticado, conforme o app Next.

Montado em app.main com prefixo /bff, logo os paths efetivos sao:
  GET /bff/licitacoes
  GET /bff/licitacoes/{licitacao_id}
"""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import CurrentUser, get_current_user
from app.db.session import get_db
from app.schemas.licitacoes import LicitacaoOut, PaginaLicitacoes, Paginacao

router = APIRouter(prefix="/licitacoes", tags=["licitacoes"])

# Colunas projetadas (com alias camelCase para casar com o front Next).
_SELECT_COLS = """
    id::text                       AS id,
    numero                         AS numero,
    objeto                         AS objeto,
    objeto_resumido                AS "objetoResumido",
    empresa                        AS empresa,
    empresa_codigo                 AS "empresaCodigo",
    status                         AS status,
    sub_status                     AS "subStatus",
    fase                           AS fase,
    modalidade                     AS modalidade,
    abrangencia                    AS abrangencia,
    data_inicio                    AS "dataInicio",
    data_fim                       AS "dataFim",
    data_abertura                  AS "dataAbertura",
    natureza                       AS natureza,
    tipo_servico                   AS "tipoServico",
    segmento                       AS segmento,
    relevancia                     AS relevancia,
    score_interesse                AS "scoreInteresse",
    melhor_perfil                  AS "melhorPerfil",
    criado_em                      AS "criadoEm",
    atualizado_em                  AS "atualizadoEm"
"""


@router.get("", response_model=PaginaLicitacoes, summary="Lista licitacoes (paginada)")
async def listar_licitacoes(
    page: int = Query(1, ge=1, description="Pagina (1-based)."),
    page_size: int = Query(20, ge=1, le=100, description="Itens por pagina."),
    relevancia: str | None = Query(None, description="Filtra por relevancia."),
    fase: str | None = Query(None, description="Filtra por fase."),
    _user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaLicitacoes:
    """Leitura paginada de licitacoes, ordenada por score/recencia."""
    # Filtros opcionais com bind params (nunca interpolados em string).
    where = ["1 = 1"]
    params: dict[str, object] = {}
    if relevancia is not None:
        where.append("relevancia = :relevancia")
        params["relevancia"] = relevancia
    if fase is not None:
        where.append("fase = :fase")
        params["fase"] = fase
    where_sql = " AND ".join(where)

    total_row = await db.execute(
        text(f"SELECT COUNT(*) AS total FROM licitacoes WHERE {where_sql}"), params
    )
    total = int(total_row.scalar_one())

    params["limit"] = page_size
    params["offset"] = (page - 1) * page_size
    rows = await db.execute(
        text(
            f"SELECT {_SELECT_COLS} FROM licitacoes WHERE {where_sql} "
            "ORDER BY score_interesse DESC NULLS LAST, criado_em DESC "
            "LIMIT :limit OFFSET :offset"
        ),
        params,
    )

    data = [LicitacaoOut.model_validate(m) for m in rows.mappings().all()]
    total_pages = math.ceil(total / page_size) if total else 0
    return PaginaLicitacoes(
        data=data,
        paginacao=Paginacao(
            page=page, page_size=page_size, total=total, total_pages=total_pages
        ),
    )


@router.get(
    "/{licitacao_id}", response_model=LicitacaoOut, summary="Detalhe de uma licitacao"
)
async def obter_licitacao(
    licitacao_id: str,
    _user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LicitacaoOut:
    """Detalhe de uma licitacao por id (uuid). 404 se nao existir."""
    row = await db.execute(
        text(f"SELECT {_SELECT_COLS} FROM licitacoes WHERE id = :id"),
        {"id": licitacao_id},
    )
    mapping = row.mappings().first()
    if mapping is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Licitacao nao encontrada."
        )
    return LicitacaoOut.model_validate(mapping)
