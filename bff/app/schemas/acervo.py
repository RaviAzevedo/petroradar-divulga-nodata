"""
Schemas do RAG do acervo (busca semantica em acervo_chunks via pgvector).

Espelha o contrato da rota Next /api/acervo/buscar + retrieval.ts:
  - BuscaRequest   ~ corpo da busca (query + filtros + flag de sintese);
  - ChunkResultado ~ ChunkRecuperado de retrieval.ts (com similaridade 0..1);
  - FonteCitavel   ~ FonteCitavel de retrieval.ts (numeracao 1-based para citacao);
  - BuscaResponse  ~ resultado da rota (chunks + fontes + resposta sintetizada).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Espelha `type OrigemAcervo` de src/db/schema.ts (linha 1696).
OrigemAcervo = Literal["ANEXO_EDITAL", "DOC_HABILITACAO", "PROJETO"]


class BuscaRequest(BaseModel):
    """
    Corpo do POST /bff/acervo/buscar.

    `top_k` e `similaridade_minima` sobrescrevem os defaults do config (ACERVO_TOP_K=8,
    ACERVO_SIMILARIDADE_MIN=0.35); ficam None aqui e o router resolve o default.
    """

    model_config = ConfigDict(populate_by_name=True)

    query: str = Field(min_length=1, max_length=4000, description="Pergunta do usuario.")
    origem_tipo: list[OrigemAcervo] | None = Field(
        default=None,
        alias="origemTipo",
        description="Restringe a busca a um ou mais tipos de origem.",
    )
    licitacao_id: str | None = Field(
        default=None,
        alias="licitacaoId",
        description="Restringe a busca a uma licitacao especifica.",
    )
    top_k: int | None = Field(
        default=None,
        alias="topK",
        ge=1,
        le=50,
        description="Sobrescreve o top-K default do retrieval.",
    )
    similaridade_minima: float | None = Field(
        default=None,
        alias="similaridadeMinima",
        ge=0.0,
        le=1.0,
        description="Corte minimo de similaridade de cosseno (0..1).",
    )
    sintetizar: bool = Field(
        default=True,
        description="Se True, pede ao Claude uma resposta citando as fontes.",
    )


class ChunkResultado(BaseModel):
    """Um chunk recuperado pelo k-NN de cosseno (espelha ChunkRecuperado)."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    origem_tipo: OrigemAcervo = Field(alias="origemTipo")
    origem_id: str = Field(alias="origemId")
    licitacao_id: str | None = Field(default=None, alias="licitacaoId")
    chunk_index: int = Field(alias="chunkIndex")
    texto: str
    metadata: dict[str, Any] | None = None
    similaridade: float = Field(description="Similaridade de cosseno 0..1 (1 = identico).")


class FonteCitavel(BaseModel):
    """Fonte numerada (1-based) para renderizar citacoes [1], [2]..."""

    model_config = ConfigDict(populate_by_name=True)

    numero: int
    origem_tipo: OrigemAcervo = Field(alias="origemTipo")
    origem_id: str = Field(alias="origemId")
    licitacao_id: str | None = Field(default=None, alias="licitacaoId")
    chunk_index: int = Field(alias="chunkIndex")
    similaridade: float


class BuscaResponse(BaseModel):
    """Resposta do POST /bff/acervo/buscar."""

    query: str
    resposta: str | None = Field(
        default=None,
        description="Sintese do Claude citando as fontes; None se sintetizar=False ou IA indisponivel.",
    )
    chunks: list[ChunkResultado]
    fontes: list[FonteCitavel]
    modelo: str | None = Field(
        default=None, description="Modelo usado na sintese, quando houver."
    )
