"""
Geracao de embeddings para o RAG do acervo (porta Python de src/lib/acervo/embeddings.ts).

A Anthropic NAO oferece embeddings nativos. Provider gated por env
(settings.embedding_provider):
  - "local"  -> modelo BGE-m3 (1024) servido pelo container embeddings-local
               (HuggingFace TEI, endpoint OpenAI-compativel), settings.embedding_base_url.
               >>> DECISAO DE ARQUITETURA: embeddings 100% on-premise. <<<
  - "voyage" -> Voyage AI (externo), settings.voyage_api_key
  - "openai" -> OpenAI text-embedding-* (externo), settings.openai_api_key

Tudo via httpx async (REST). Quando o provider configurado nao tem credencial/URL,
`embeddings_disponivel()` devolve False e os callers (router /bff/acervo/buscar)
fazem GATE gracioso (503) em vez de quebrar.

Dimensao DEVE casar com acervo_chunks.embedding = vector(N) (N=1024 para BGE-m3).
Validamos o tamanho do vetor retornado e lancamos erro claro se o modelo nao bater
para evitar inserts/buscas silenciosamente incompativeis com a coluna.
"""

from __future__ import annotations

from typing import Literal

import httpx

from app.core.config import settings

# Tipo de entrada do embedding: documento (indexacao) ou consulta (busca).
TipoEmbedding = Literal["document", "query"]

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class EmbeddingError(RuntimeError):
    """Falha ao gerar embeddings (provider indisponivel, HTTP ou dimensao)."""


class EmbeddingResposta:
    """Resultado de um lote de embeddings."""

    __slots__ = ("vetores", "modelo", "tokens")

    def __init__(self, vetores: list[list[float]], modelo: str, tokens: int) -> None:
        self.vetores = vetores
        self.modelo = modelo
        self.tokens = tokens


def embeddings_disponivel() -> bool:
    """Indica se o provider de embeddings configurado esta disponivel (gate)."""
    provider = (settings.embedding_provider or "").lower()
    if provider == "local":
        return bool(settings.embedding_base_url)
    if provider == "openai":
        return bool(settings.openai_api_key)
    if provider == "voyage":
        return bool(settings.voyage_api_key)
    # Sem provider explicito: qualquer chave/URL serve.
    return bool(
        settings.embedding_base_url
        or settings.voyage_api_key
        or settings.openai_api_key
    )


def modelo_embedding() -> str:
    """Identificador do modelo de embedding em uso."""
    return settings.embedding_model


def _validar_dimensao(resp: EmbeddingResposta) -> EmbeddingResposta:
    esperado = settings.embedding_dimensoes
    recebido = len(resp.vetores[0]) if resp.vetores else 0
    if recebido != esperado:
        raise EmbeddingError(
            f'Dimensao de embedding incompativel: modelo "{resp.modelo}" devolveu '
            f"{recebido}, esperado {esperado} (coluna vector({esperado})). "
            "Ajuste EMBEDDING_MODEL/EMBEDDING_DIMENSOES."
        )
    return resp


# -- Provider: Voyage AI -------------------------------------------------------


async def _embed_voyage(
    client: httpx.AsyncClient, textos: list[str], tipo: TipoEmbedding
) -> EmbeddingResposta:
    api_key = settings.voyage_api_key
    if not api_key:
        raise EmbeddingError("VOYAGE_API_KEY ausente")

    res = await client.post(
        "https://api.voyageai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": settings.embedding_model,
            "input": textos,
            # Voyage distingue documento x consulta (retrieval assimetrico).
            "input_type": tipo,
            # Pede a dimensao configurada quando o modelo suportar.
            "output_dimension": settings.embedding_dimensoes,
        },
    )
    if res.status_code >= 400:
        raise EmbeddingError(f"Voyage embeddings HTTP {res.status_code}: {res.text[:300]}")

    json = res.json()
    ordenados = sorted(json["data"], key=lambda d: d["index"])
    return EmbeddingResposta(
        vetores=[d["embedding"] for d in ordenados],
        modelo=settings.embedding_model,
        tokens=(json.get("usage") or {}).get("total_tokens", 0),
    )


# -- Provider: OpenAI ----------------------------------------------------------


async def _embed_openai(client: httpx.AsyncClient, textos: list[str]) -> EmbeddingResposta:
    api_key = settings.openai_api_key
    if not api_key:
        raise EmbeddingError("OPENAI_API_KEY ausente")

    res = await client.post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": settings.embedding_model,
            "input": textos,
            # text-embedding-3-* suportam reducao de dimensao.
            "dimensions": settings.embedding_dimensoes,
        },
    )
    if res.status_code >= 400:
        raise EmbeddingError(f"OpenAI embeddings HTTP {res.status_code}: {res.text[:300]}")

    json = res.json()
    ordenados = sorted(json["data"], key=lambda d: d["index"])
    return EmbeddingResposta(
        vetores=[d["embedding"] for d in ordenados],
        modelo=settings.embedding_model,
        tokens=(json.get("usage") or {}).get("total_tokens", 0),
    )


# -- Provider: local (HuggingFace TEI / BGE-m3) -- ESCOLHA ON-PREMISE ----------


async def _embed_local(client: httpx.AsyncClient, textos: list[str]) -> EmbeddingResposta:
    """Embeddings via container local TEI (endpoint OpenAI-compativel /v1/embeddings).

    BGE-m3 e simetrico (sem input_type doc/query) e emite 1024 dims nativamente.
    O TEI ignora 'dimensions'; a validacao de dimensao garante == settings.embedding_dimensoes.
    """
    base = (settings.embedding_base_url or "").rstrip("/")
    if not base:
        raise EmbeddingError("EMBEDDING_BASE_URL ausente (provider=local)")

    # Falha de transporte (TEI parado/reiniciando, DNS) vira EmbeddingError — o
    # caller (router do acervo) converte em 503 gracioso, NUNCA em 500. Sem isto,
    # com o embeddings-local fora do ar a busca do acervo estourava httpx.ConnectError
    # ate o handler global (500 "erro interno").
    try:
        res = await client.post(
            f"{base}/v1/embeddings",
            json={"model": settings.embedding_model, "input": textos},
        )
    except httpx.RequestError as exc:
        raise EmbeddingError(
            f"Embeddings local (TEI) indisponivel: {type(exc).__name__}: {exc}"
        ) from exc
    if res.status_code >= 400:
        raise EmbeddingError(
            f"Embeddings local (TEI) HTTP {res.status_code}: {res.text[:300]}"
        )

    json = res.json()
    ordenados = sorted(json["data"], key=lambda d: d["index"])
    return EmbeddingResposta(
        vetores=[d["embedding"] for d in ordenados],
        modelo=settings.embedding_model,
        tokens=(json.get("usage") or {}).get("total_tokens", 0),
    )


# -- API publica ---------------------------------------------------------------


async def gerar_embeddings(
    textos: list[str], tipo: TipoEmbedding = "document"
) -> EmbeddingResposta:
    """
    Gera embeddings para uma lista de textos. Roteia para o provider configurado
    e valida a dimensao de saida contra settings.embedding_dimensoes
    (= vector(N); N=1024 para o BGE-m3 local).

    Lanca EmbeddingError se nenhum provider estiver disponivel ou a dimensao nao casar
    (os callers devem ter feito GATE com embeddings_disponivel() antes).
    """
    if not textos:
        return EmbeddingResposta([], settings.embedding_model, 0)
    if not embeddings_disponivel():
        raise EmbeddingError(
            "Provider de embeddings indisponivel "
            "(EMBEDDING_BASE_URL p/ local, ou VOYAGE_API_KEY / OPENAI_API_KEY)"
        )

    provider = (settings.embedding_provider or "").lower()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        if provider == "local" and settings.embedding_base_url:
            resp = await _embed_local(client, textos)
        elif provider == "openai" and settings.openai_api_key:
            resp = await _embed_openai(client, textos)
        elif provider == "voyage" and settings.voyage_api_key:
            resp = await _embed_voyage(client, textos, tipo)
        elif settings.embedding_base_url:
            resp = await _embed_local(client, textos)
        elif settings.voyage_api_key:
            resp = await _embed_voyage(client, textos, tipo)
        else:
            resp = await _embed_openai(client, textos)

    return _validar_dimensao(resp)


async def gerar_embedding(texto: str, tipo: TipoEmbedding = "query") -> list[float]:
    """Conveniencia: embedding de UM unico texto (ex.: a query de busca)."""
    resp = await gerar_embeddings([texto], tipo)
    if not resp.vetores:
        raise EmbeddingError("Embedding vazio")
    return resp.vetores[0]
