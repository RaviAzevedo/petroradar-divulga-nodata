"""
Router /bff/acervo (rota MIGRADA de exemplo do estrangulador).

RAG sobre acervo_chunks (pgvector). Porta Python de /api/acervo/buscar +
src/lib/acervo/retrieval.ts:
  1. gera o embedding da pergunta (app.services.embeddings, input_type="query");
  2. k-NN por distancia de cosseno (<=>) com filtros de metadata e corte de
     similaridade minima (settings.acervo defaults via env);
  3. opcionalmente sintetiza resposta CITANDO as fontes (app.services.anthropic).

Anti-IDOR: o retrieval so roda para usuarios internos. O gate de papel
(require_role(...)) replica o requireAcervo da rota Next: ADMIN, LIDER,
ORCAMENTISTA, TECNICO, VISUALIZADOR (EXTERNO fica de fora; SGI nao consome RAG).

Montado em app.main com prefixo /bff -> path efetivo: POST /bff/acervo/buscar.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.core.security import CurrentUser, require_role
from app.db.session import get_db
from app.schemas.acervo import (
    BuscaRequest,
    BuscaResponse,
    ChunkResultado,
    FonteCitavel,
)
from app.services import anthropic as anthropic_service
from app.services import embeddings as embeddings_service

router = APIRouter(prefix="/acervo", tags=["acervo"])

# Defaults do RAG (espelham config.acervo: ACERVO_TOP_K=8, ACERVO_SIMILARIDADE_MIN=0.35).
_TOP_K_DEFAULT = int(os.getenv("ACERVO_TOP_K", "8"))
_SIM_MIN_DEFAULT = float(os.getenv("ACERVO_SIMILARIDADE_MIN", "0.35"))

# Papeis com acesso ao RAG (replica requireAcervo; ver src/lib/permissions.ts).
_GATE_ACERVO = require_role(
    "ADMIN", "LIDER", "ORCAMENTISTA", "TECNICO", "VISUALIZADOR"
)


def _vetor_para_literal(vetor: list[float]) -> str:
    """
    Serializa o vetor para o literal textual do pgvector ("[a,b,c]"), sanitizando
    para conter apenas numeros finitos (defesa contra injecao via interpolacao —
    asyncpg nao tem binding nativo para o tipo `vector`).
    """
    nums: list[str] = []
    for v in vetor:
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):  # NaN/inf
            raise ValueError("Embedding contem valor nao-numerico")
        nums.append(repr(f))
    return "[" + ",".join(nums) + "]"


@router.post(
    "/buscar",
    response_model=BuscaResponse,
    summary="Busca semantica no acervo (RAG)",
    dependencies=[Depends(_GATE_ACERVO)],
)
async def buscar_acervo(
    body: BuscaRequest,
    user: CurrentUser = Depends(_GATE_ACERVO),
    db: AsyncSession = Depends(get_db),
) -> BuscaResponse:
    """RAG: embedding da query -> k-NN cosseno em acervo_chunks -> sintese opcional."""
    # Rate limit por usuario (paridade com migrated/acervo_buscar.py — custo de
    # embedding + Claude; antes esta rota Onda 0 era a UNICA sem limite).
    rl = await check_rate_limit(
        key=f"acervo-buscar:{user.id}",
        max_hits=30,
        window_seconds=60,
    )
    if not rl.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Muitas buscas em sequência. Tente novamente em instantes.",
        )

    # GATE gracioso: sem provider de embeddings nao ha como buscar.
    if not embeddings_service.embeddings_disponivel():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Busca semantica indisponivel: provider de embeddings nao configurado.",
        )

    try:
        embedding = await embeddings_service.gerar_embedding(body.query, tipo="query")
    except embeddings_service.EmbeddingError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc

    top_k = max(1, min(50, body.top_k or _TOP_K_DEFAULT))
    sim_min = body.similaridade_minima if body.similaridade_minima is not None else _SIM_MIN_DEFAULT
    literal = _vetor_para_literal(embedding)

    # Filtros de metadata como bind params; origem_tipo via = ANY(:origens).
    conds = ["embedding IS NOT NULL"]
    params: dict[str, object] = {"qvec": literal, "limit": top_k}
    if body.origem_tipo:
        conds.append("origem_tipo = ANY(:origens)")
        params["origens"] = body.origem_tipo
    if body.licitacao_id:
        conds.append("licitacao_id = :licitacao_id")
        params["licitacao_id"] = body.licitacao_id
    where_sql = " AND ".join(conds)

    # O vetor da query entra como bind param e e cast para ::vector no SQL.
    sql = text(
        f"""
        SELECT
            id::text                      AS id,
            origem_tipo                   AS "origemTipo",
            origem_id::text               AS "origemId",
            licitacao_id::text            AS "licitacaoId",
            chunk_index                   AS "chunkIndex",
            texto                         AS texto,
            metadata                      AS metadata,
            1 - (embedding <=> (:qvec)::vector) AS similaridade
        FROM acervo_chunks
        WHERE {where_sql}
        ORDER BY embedding <=> (:qvec)::vector
        LIMIT :limit
        """
    )
    rows = await db.execute(sql, params)

    chunks: list[ChunkResultado] = []
    for m in rows.mappings().all():
        sim = float(m["similaridade"] or 0.0)
        if sim < sim_min:
            continue
        chunks.append(
            ChunkResultado(
                id=m["id"],
                origemTipo=m["origemTipo"],
                origemId=m["origemId"],
                licitacaoId=m["licitacaoId"],
                chunkIndex=int(m["chunkIndex"] or 0),
                texto=m["texto"],
                metadata=m["metadata"],
                similaridade=sim,
            )
        )

    # Monta fontes numeradas (1-based) e o bloco de contexto para o Claude.
    fontes: list[FonteCitavel] = []
    blocos: list[str] = []
    for i, c in enumerate(chunks):
        numero = i + 1
        fontes.append(
            FonteCitavel(
                numero=numero,
                origemTipo=c.origem_tipo,
                origemId=c.origem_id,
                licitacaoId=c.licitacao_id,
                chunkIndex=c.chunk_index,
                similaridade=round(c.similaridade, 3),
            )
        )
        rotulo = f"[{numero}] origem={c.origem_tipo} id={c.origem_id}"
        if c.licitacao_id:
            rotulo += f" licitacao={c.licitacao_id}"
        blocos.append(f"{rotulo}\n{c.texto}")
    contexto = "\n\n---\n\n".join(blocos)

    resposta: str | None = None
    modelo: str | None = None
    # Trava de IA (services/anthropic.py): a sintese RAG do acervo ("acervo-busca")
    # esta BLOQUEADA por decisao de produto — so a analise de edital consome a API da
    # Anthropic. ia_permitida() e sempre false aqui, entao a busca continua util e
    # devolve chunks/fontes com `resposta=None`, apenas sem a sintese redigida pela
    # IA. (Cobre tambem o caso de ANTHROPIC_API_KEY ausente.)
    if (
        body.sintetizar
        and chunks
        and anthropic_service.ia_permitida("acervo-busca")
    ):
        try:
            resposta = await anthropic_service.sintetizar_resposta(body.query, contexto)
            modelo = settings.anthropic_model_sonnet
        except anthropic_service.AnthropicError as exc:
            # Falha de sintese nao deve derrubar a busca: devolve chunks/fontes.
            resposta = f"(sintese indisponivel: {exc})"

    return BuscaResponse(
        query=body.query,
        resposta=resposta,
        chunks=chunks,
        fontes=fontes,
        modelo=modelo,
    )
