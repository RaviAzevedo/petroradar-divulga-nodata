"""Rota migrada (strangler-fig): GET /api/cron/acervo-index.

Equivalente 1:1 de ``src/app/api/cron/acervo-index/route.ts`` (handler GET).

Indexação incremental do acervo técnico para o RAG (pgvector). Indexa o texto
JÁ extraído (sem re-OCR):
  - anexos.texto_cache                  → origem ANEXO_EDITAL (ligado à licitação)
  - documentos_habilitacao.ocr_texto    → origem DOC_HABILITACAO (cofre, sem licitação)

Para cada fonte: chunk quebra o texto, o provider de embeddings gera os vetores e
inserimos em acervo_chunks. A idempotência é garantida por acervo_index_log
(uniq por origem_tipo + origem_id + modelo_embedding): se o texto_hash não mudou
para o mesmo modelo, pulamos a fonte; se mudou (reindexação), apagamos os chunks
antigos da fonte e regravamos.

Budget: respeita config.acervo.budgetFontesPorExecucao e budgetChunksPorExecucao
para conter o custo recorrente de embeddings.

Gate gracioso (200 + {skipped}):
  - cron desabilitado          → config.crons.acervoIndex.habilitado
  - feature RAG / sem provider → config.acervo.habilitado (embeddingDisponivel)

────────────────────────────────────────────────────────────────────────────
Auth (réplica EXATA de ``autorizarCron`` do route.ts):
  - Se ``CRON_SECRET`` (settings.cron_secret) estiver definido (truthy):
    exige header ``Authorization: Bearer <CRON_SECRET>`` — qualquer outro → 401
    ``{"error": "Não autorizado"}``.
  - Se ``CRON_SECRET`` NÃO estiver definido: aceita ``x-vercel-cron: 1`` —
    qualquer outro → 401 ``{"error": "Não autorizado"}``.
  (Não há disparo manual por ADMIN logado neste cron — o Next só checa o cron.)

NOTA sobre db.batch:
  O Next escreve tudo num único ``db.batch`` (neon-http não suporta transaction).
  Aqui acumulamos as operações e as aplicamos numa única sessão com um único
  commit — mesmo efeito de persistência atômica no fim.

Shape da resposta (200, idêntico ao Next):
  {"ok": true, "skipped": "..."}                              (gates)
  {"ok": true, "stats": {...}, "modelo": "<modelo>"}          (execução)
"""

from __future__ import annotations

import hashlib
import json as _json
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.cron_auth import safe_equal
from app.db.session import SessionLocal
from app.routers.migrated._shared import flag as _flag, num as _num
from app.services import embeddings as embeddings_svc

router = APIRouter()


# ── Config (réplica de src/lib/config.ts → config.crons / config.acervo / config.ia)
#
# O ``config.ts`` lê variáveis de ambiente com fallbacks via helpers locais
# (flag/num/str). Usamos os helpers paritários canônicos de _shared e lemos os
# valores CRUS do ``settings`` (campos-espelho, default "" = ausente),
# preservando o comportamento de habilitação/limiares.


def _cron_acervo_index_habilitado() -> bool:
    """config.crons.acervoIndex.habilitado (default true)."""
    return _flag(settings.cron_acervo_index_enabled, True)


def _acervo_chunk_tamanho() -> int:
    """config.acervo.chunkTamanho (default 1_200)."""
    return _num(settings.acervo_chunk_tamanho, 1_200)


def _acervo_chunk_overlap() -> int:
    """config.acervo.chunkOverlap (default 200)."""
    return _num(settings.acervo_chunk_overlap, 200)


def _acervo_budget_fontes() -> int:
    """config.acervo.budgetFontesPorExecucao (default 50)."""
    return _num(settings.acervo_budget_fontes, 50)


def _acervo_budget_chunks() -> int:
    """config.acervo.budgetChunksPorExecucao (default 800)."""
    return _num(settings.acervo_budget_chunks, 800)


def _acervo_habilitado() -> bool:
    """Espelha ``config.acervo.habilitado`` do Next.

    No Next: ``flag(FEATURE_ACERVO_RAG, true) && this.embeddingDisponivel``. O
    componente de provider é coberto por ``embeddings_svc.embeddings_disponivel()``
    (mesma semântica de ``embeddingDisponivel``). A rota Next ainda checa
    ``embeddingsDisponivel()`` separadamente — aqui ambos os checks usam a mesma
    função, preservando o gate "RAG ligado E provider disponível".
    ``feature_acervo_rag_raw`` é o valor CRU da env (a semântica flag(env, true)
    difere da coerção bool do pydantic — ver nota no config.py).
    """
    return _flag(settings.feature_acervo_rag_raw, True) and (
        embeddings_svc.embeddings_disponivel()
    )


# ── Chunking (porta de src/lib/acervo/chunk.ts) ────────────────────────────────


def _normalizar(texto: str) -> str:
    """Réplica de ``normalizar`` (chunk.ts).

    Colapsa runs de espaços/tabs, normaliza CRLF/CR → LF, mantém quebras de
    parágrafo mas remove linhas vazias excessivas.
    """
    texto = re.sub(r"\r\n?", "\n", texto)
    texto = re.sub(r"[ \t]+", " ", texto)
    texto = re.sub(r"\n{3,}", "\n\n", texto)
    return texto.strip()


def _achar_fronteira(texto: str, minimo: int, hard_max: int) -> int:
    """Réplica de ``acharFronteira`` (chunk.ts).

    Procura a melhor fronteira de corte dentro de [min, hardMax], preferindo fim
    de parágrafo, depois fim de frase, depois espaço. Retorna o índice de corte
    (exclusivo); ``hardMax`` se nada for encontrado (corte cego).
    """
    janela = texto[minimo:hard_max]

    # 1) Quebra de parágrafo
    par = janela.rfind("\n\n")
    if par > 0:
        return minimo + par + 2

    # 2) Fim de frase (.!? seguido de espaço/quebra)
    frase = max(
        janela.rfind(". "),
        janela.rfind(".\n"),
        janela.rfind("! "),
        janela.rfind("? "),
    )
    if frase > 0:
        return minimo + frase + 1

    # 3) Último espaço/quebra
    espaco = max(janela.rfind(" "), janela.rfind("\n"))
    if espaco > 0:
        return minimo + espaco + 1

    # 4) Corte cego
    return hard_max


def _chunk_texto(
    texto_bruto: str,
    tamanho_opt: int | None = None,
    overlap_opt: int | None = None,
) -> list[dict[str, Any]]:
    """Réplica de ``chunkTexto`` (chunk.ts).

    Quebra o texto em chunks com sobreposição. Parâmetros vêm de config.acervo
    por padrão. Retorna lista de dicts ``{"index": int, "texto": str}``.
    """
    import math

    tamanho = max(
        200,
        tamanho_opt if tamanho_opt is not None else _acervo_chunk_tamanho(),
    )
    # overlap nunca pode ser >= tamanho (geraria loop infinito).
    overlap = min(
        max(0, overlap_opt if overlap_opt is not None else _acervo_chunk_overlap()),
        math.floor(tamanho / 2),
    )

    texto = _normalizar(texto_bruto)
    if len(texto) == 0:
        return []

    # Texto cabe num único chunk.
    if len(texto) <= tamanho:
        return [{"index": 0, "texto": texto}]

    chunks: list[dict[str, Any]] = []
    pos = 0
    idx = 0

    while pos < len(texto):
        hard_max = min(pos + tamanho, len(texto))

        if hard_max >= len(texto):
            fim = len(texto)
        else:
            # Procura fronteira a partir de ~70% da janela.
            minimo = pos + math.floor(tamanho * 0.7)
            fim = _achar_fronteira(texto, minimo, hard_max)

        pedaco = texto[pos:fim].strip()
        if len(pedaco) > 0:
            chunks.append({"index": idx, "texto": pedaco})
            idx += 1

        if fim >= len(texto):
            break

        # Avança com sobreposição; garante progresso mínimo para não travar.
        proximo = fim - overlap
        pos = proximo if proximo > pos else fim

    return chunks


def _hash_texto(texto_bruto: str) -> str:
    """Réplica de ``hashTexto`` (chunk.ts): sha-256 hex do texto normalizado."""
    return hashlib.sha256(_normalizar(texto_bruto).encode("utf-8")).hexdigest()


# ── Serialização de vetor para pgvector (literal "[a,b,c]") ────────────────────


def _vetor_para_literal(vetor: list[float]) -> str:
    """Serializa o vetor → literal pgvector ("[a,b,c]"), só números finitos."""
    nums: list[float] = []
    for v in vetor:
        n = float(v)
        if n != n or n in (float("inf"), float("-inf")):  # NaN/Inf
            raise ValueError("Embedding contém valor não-numérico")
        nums.append(n)
    return "[" + ",".join(repr(n) for n in nums) + "]"


# ── Auth do cron (réplica de ``autorizarCron`` do route.ts) ────────────────────


def _autorizar_cron(request: Request) -> bool:
    """Réplica EXATA de ``autorizarCron`` (route.ts).

    - Se ``CRON_SECRET`` definido (truthy): exige ``Authorization: Bearer
      <CRON_SECRET>``.
    - Caso contrário: aceita ``x-vercel-cron: 1``.
    """
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = request.headers.get("authorization") or ""
        # Constant-time (safe_equal): mesmo resultado booleano da igualdade
        # simples, sem canal de timing (hardening 02/07).
        return safe_equal(auth_header, f"Bearer {cron_secret}")
    return request.headers.get("x-vercel-cron") == "1"


# ── Handler ────────────────────────────────────────────────────────────────────


@router.get("/api/cron/acervo-index")
async def get_cron_acervo_index(request: Request) -> JSONResponse:
    """GET /api/cron/acervo-index — indexação incremental do acervo (RAG/pgvector).

    Réplica fiel do handler GET do Next: auth de cron, gates graciosos, coleta de
    fontes candidatas, indexação incremental por hash, budget de fontes/chunks e
    persistência em lote.
    """
    if not _autorizar_cron(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # ── Gates graciosos ───────────────────────────────────────────────────────
    if not _cron_acervo_index_habilitado():
        return JSONResponse(content={"ok": True, "skipped": "desabilitado"})
    if not _acervo_habilitado() or not embeddings_svc.embeddings_disponivel():
        # log.warn("RAG do acervo indisponível — provider de embeddings ausente")
        return JSONResponse(
            content={"ok": True, "skipped": "sem provider de embeddings"}
        )

    modelo = embeddings_svc.modelo_embedding()
    budget_fontes = _acervo_budget_fontes()
    budget_chunks = _acervo_budget_chunks()

    stats = {
        "fontesAvaliadas": 0,
        "fontesIndexadas": 0,
        "fontesPuladas": 0,
        "fontesReindexadas": 0,
        "chunksGerados": 0,
        "tokensEmbedding": 0,
        "falhas": 0,
    }

    async with SessionLocal() as db:
        # ── 1. Carrega o log de indexação existente para o modelo atual ────────
        # Map "origemTipo:origemId" → textoHash já indexado (mesmo modelo).
        res_log = await db.execute(
            text(
                """
                SELECT
                    origem_tipo      AS "origemTipo",
                    origem_id        AS "origemId",
                    texto_hash       AS "textoHash"
                FROM acervo_index_log
                WHERE modelo_embedding = :modelo
                """
            ),
            {"modelo": modelo},
        )
        log_rows = [dict(r) for r in res_log.mappings().all()]

        ja_indexado: dict[str, str] = {}
        for r in log_rows:
            ja_indexado[f"{r.get('origemTipo')}:{r.get('origemId')}"] = r.get(
                "textoHash"
            )

        # ── 2. Coleta fontes candidatas (texto já extraído, não-vazio) ─────────
        # Limita o SELECT a um múltiplo do budget de fontes; a filtragem fina por
        # hash acontece em memória logo abaixo.
        limite_scan = budget_fontes * 4

        res_anexos = await db.execute(
            text(
                """
                SELECT
                    id           AS "id",
                    licitacao_id AS "licitacaoId",
                    descricao    AS "descricao",
                    texto_cache  AS "texto"
                FROM anexos
                WHERE texto_cache IS NOT NULL AND texto_cache <> ''
                LIMIT :limite
                """
            ),
            {"limite": int(limite_scan)},
        )
        anexo_rows = [dict(r) for r in res_anexos.mappings().all()]

        res_docs = await db.execute(
            text(
                """
                SELECT
                    id           AS "id",
                    categoria    AS "categoria",
                    subcategoria AS "subcategoria",
                    titulo       AS "titulo",
                    ocr_texto    AS "texto"
                FROM documentos_habilitacao
                WHERE ocr_texto IS NOT NULL AND ocr_texto <> ''
                  AND restrito = false
                LIMIT :limite
                """
                # 0034/S15 (02-APIS §16-B.4): documento restrito NUNCA vira
                # chunk — cron sem sessão usa o literal ``restrito = false``.
                # A remoção do já-indexado ao MARCAR restrito é efeito do PATCH
                # de documento (R8 §8.3), não deste cron.
            ),
            {"limite": int(limite_scan)},
        )
        doc_rows = [dict(r) for r in res_docs.mappings().all()]

        fontes: list[dict[str, Any]] = []
        for a in anexo_rows:
            if not a.get("texto"):
                continue
            fontes.append(
                {
                    "origemTipo": "ANEXO_EDITAL",
                    "origemId": a.get("id"),
                    "licitacaoId": a.get("licitacaoId"),
                    "texto": a.get("texto"),
                    "metadata": {"descricao": a.get("descricao")},
                }
            )
        for d in doc_rows:
            if not d.get("texto"):
                continue
            fontes.append(
                {
                    "origemTipo": "DOC_HABILITACAO",
                    "origemId": d.get("id"),
                    "licitacaoId": None,
                    "texto": d.get("texto"),
                    "metadata": {
                        "categoria": d.get("categoria"),
                        "subcategoria": d.get("subcategoria"),
                        "titulo": d.get("titulo"),
                    },
                }
            )

        # ── 3. Indexa as fontes que mudaram, respeitando o budget ──────────────
        # Acumula as operações (delete/insert/upsert) e aplica num único commit no
        # fim (o Next usa db.batch; mesmo efeito de persistência atômica).
        deletes: list[dict[str, Any]] = []
        inserts_chunks: list[dict[str, Any]] = []
        upserts_log: list[dict[str, Any]] = []

        for fonte in fontes:
            if stats["fontesIndexadas"] >= budget_fontes:
                break
            if stats["chunksGerados"] >= budget_chunks:
                break

            stats["fontesAvaliadas"] += 1

            chave = f"{fonte['origemTipo']}:{fonte['origemId']}"
            hash_atual = _hash_texto(fonte["texto"])

            hash_anterior = ja_indexado.get(chave)
            if hash_anterior == hash_atual:
                stats["fontesPuladas"] += 1
                continue  # texto inalterado para este modelo — idempotente

            reindex = chave in ja_indexado

            # Chunking
            chunks = _chunk_texto(fonte["texto"])
            if len(chunks) == 0:
                stats["fontesPuladas"] += 1
                continue
            # Respeita o teto de chunks restante nesta execução.
            restante = budget_chunks - stats["chunksGerados"]
            a_processar = chunks[: max(0, restante)]
            if len(a_processar) == 0:
                break

            # Embeddings (uma chamada por fonte; o provider faz batch interno).
            try:
                resp = await embeddings_svc.gerar_embeddings(
                    [c["texto"] for c in a_processar], "document"
                )
                vetores = resp.vetores
                stats["tokensEmbedding"] += resp.tokens
            except Exception:  # noqa: BLE001 — falha de embedding não derruba o lote
                stats["falhas"] += 1
                # log.error("falha ao gerar embeddings da fonte", err, {...})
                continue

            if len(vetores) != len(a_processar):
                stats["falhas"] += 1
                # log.error("contagem de embeddings divergente", null, {...})
                continue

            # Reindexação: apaga chunks antigos da fonte antes de regravar.
            if reindex:
                deletes.append(
                    {
                        "origemTipo": fonte["origemTipo"],
                        "origemId": fonte["origemId"],
                    }
                )
                stats["fontesReindexadas"] += 1

            # Insere os chunks com embedding + metadata.
            for i, c in enumerate(a_processar):
                inserts_chunks.append(
                    {
                        "origemTipo": fonte["origemTipo"],
                        "origemId": fonte["origemId"],
                        "licitacaoId": fonte["licitacaoId"],
                        "chunkIndex": c["index"],
                        "texto": c["texto"],
                        "embedding": _vetor_para_literal(vetores[i]),
                        "metadata": _json.dumps(
                            {**fonte["metadata"], "modelo": modelo},
                            ensure_ascii=False,
                        ),
                    }
                )

            # Upsert no log de idempotência (uniq origem_tipo+origem_id+modelo).
            upserts_log.append(
                {
                    "origemTipo": fonte["origemTipo"],
                    "origemId": fonte["origemId"],
                    "textoHash": hash_atual,
                    "modeloEmbedding": modelo,
                    "chunksGerados": len(a_processar),
                }
            )

            stats["fontesIndexadas"] += 1
            stats["chunksGerados"] += len(a_processar)

        # ── 4. Persiste tudo (Next: db.batch; aqui um commit único da sessão) ──
        houve_escrita = (
            len(deletes) > 0 or len(inserts_chunks) > 0 or len(upserts_log) > 0
        )
        if houve_escrita:
            # Deletes de reindexação (apaga chunks antigos da fonte).
            for d in deletes:
                await db.execute(
                    text(
                        """
                        DELETE FROM acervo_chunks
                        WHERE origem_tipo = :origemTipo
                          AND origem_id = :origemId
                        """
                    ),
                    {
                        "origemTipo": d["origemTipo"],
                        "origemId": d["origemId"],
                    },
                )

            # Inserts dos chunks (embedding como literal pgvector).
            for ic in inserts_chunks:
                await db.execute(
                    text(
                        """
                        INSERT INTO acervo_chunks
                            (origem_tipo, origem_id, licitacao_id, chunk_index,
                             texto, embedding, metadata)
                        VALUES
                            (:origemTipo, :origemId, :licitacaoId, :chunkIndex,
                             :texto, CAST(:embedding AS vector),
                             CAST(:metadata AS jsonb))
                        """
                    ),
                    {
                        "origemTipo": ic["origemTipo"],
                        "origemId": ic["origemId"],
                        "licitacaoId": ic["licitacaoId"],
                        "chunkIndex": ic["chunkIndex"],
                        "texto": ic["texto"],
                        "embedding": ic["embedding"],
                        "metadata": ic["metadata"],
                    },
                )

            # Upserts no log de idempotência.
            for ul in upserts_log:
                await db.execute(
                    text(
                        """
                        INSERT INTO acervo_index_log
                            (origem_tipo, origem_id, texto_hash,
                             modelo_embedding, chunks_gerados)
                        VALUES
                            (:origemTipo, :origemId, :textoHash,
                             :modeloEmbedding, :chunksGerados)
                        ON CONFLICT (origem_tipo, origem_id, modelo_embedding)
                        DO UPDATE SET
                            texto_hash     = EXCLUDED.texto_hash,
                            chunks_gerados = EXCLUDED.chunks_gerados,
                            indexado_em    = now()
                        """
                    ),
                    {
                        "origemTipo": ul["origemTipo"],
                        "origemId": ul["origemId"],
                        "textoHash": ul["textoHash"],
                        "modeloEmbedding": ul["modeloEmbedding"],
                        "chunksGerados": ul["chunksGerados"],
                    },
                )

            await db.commit()

        # log.info("execução concluída", { stats, modelo })
        return JSONResponse(content={"ok": True, "stats": stats, "modelo": modelo})
