"""Schemas Pydantic (DTOs de request/response) do Petro Radar BFF."""

from app.schemas.acervo import (
    BuscaRequest,
    BuscaResponse,
    ChunkResultado,
    FonteCitavel,
)
from app.schemas.licitacoes import LicitacaoOut, PaginaLicitacoes, Paginacao

__all__ = [
    "BuscaRequest",
    "ChunkResultado",
    "FonteCitavel",
    "BuscaResponse",
    "LicitacaoOut",
    "Paginacao",
    "PaginaLicitacoes",
]
