"""
indexer.py — (re)geracao de embeddings do acervo (RAG) no worker on-prem.

Responsabilidade unica (chamada por tasks.embedding_reindex_acervo):

  reembed_acervo(batch): le acervo_chunks SEM embedding (apos a migration
  0015 truncar a tabela, todos ficam sem vetor), chama o TEI
  (EMBEDDING_BASE_URL /v1/embeddings, modelo BAAI/bge-m3, 1024 dims) para
  gerar os vetores e faz UPDATE acervo_chunks SET embedding = '[...]'
  (formato de literal pgvector). Em lotes, com commit por lote.

NOTA (2026-07-02): a metade de indexacao no ELASTICSEARCH (reindex_entidade,
streams licitacoes/resultados/acervo, _bulk) foi REMOVIDA junto com o servico
— o ES era um destino so-de-escrita (a busca do app/BFF usa o Postgres).
Historico completo no git (commit anterior a esta data).

Premissas de ambiente (imagem do worker):
  - DATABASE_URL ............ DSN do Postgres (psycopg2).
  - EMBEDDING_BASE_URL ...... ex. http://embeddings-local:80 (TEI / BGE-m3)
  - EMBEDDING_MODEL ......... default 'BAAI/bge-m3'
  - EMBEDDING_DIMENSOES ..... default '1024' (invariante coluna == modelo).

IMPORTANTE (py_compile nesta maquina): psycopg2 e requests NAO existem aqui,
entao os imports sao LAZY (dentro das funcoes). Na imagem do worker eles
existem (requirements.txt: psycopg2-binary, requests).
"""

from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger("petro_radar.worker.indexer")

# ── Configuracao via ENV (lida no import; sem efeito colateral de rede) ────────
DATABASE_URL = os.environ.get("DATABASE_URL", "")

EMBEDDING_BASE_URL = os.environ.get(
    "EMBEDDING_BASE_URL", "http://embeddings-local:80"
).rstrip("/")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")
EMBEDDING_DIMENSOES = int(os.environ.get("EMBEDDING_DIMENSOES", "1024"))

# Lote padrao de leitura (configuravel sem deploy).
LOTE_LEITURA = int(os.environ.get("REEMBED_LOTE", "1000"))

# Teto de textos por request ao TEI. O servico embeddings-local sobe SEM
# --max-client-batch-size no docker-compose, logo vale o default 32 do TEI —
# input com mais de 32 textos toma HTTP 413 (Payload Too Large) e poe o
# re-embed em loop de erro. TODO caminho que poste ao /v1/embeddings passa por
# _tei_embeddings, que fatia em sub-lotes <= este teto (espelha
# EMBEDDING_MAX_LOTE de app/src/lib/acervo/embeddings.ts).
EMBEDDING_MAX_LOTE = 32


# ═══════════════════════════════════════════════════════════════════════════
# Helpers de baixo nivel (conexao PG)
# ═══════════════════════════════════════════════════════════════════════════
def _conn_pg():
    """Abre conexao psycopg2 (import lazy). autocommit desligado p/ controlar
    commits por lote no reembed. Falha cedo se DATABASE_URL ausente."""
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL ausente")
    import psycopg2  # import tardio (existe so na imagem do worker)

    return psycopg2.connect(DATABASE_URL)


def _dict_cursor(conn, name: str | None = None):
    """Cursor com RealDictCursor (linhas como dict). Se `name` for dado, cria
    um cursor SERVER-SIDE (nomeado) — nao carrega a tabela toda em RAM."""
    import psycopg2.extras  # import tardio

    if name:
        cur = conn.cursor(name=name, cursor_factory=psycopg2.extras.RealDictCursor)
        cur.itersize = LOTE_LEITURA
        return cur
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)


# ── Embeddings (TEI / BGE-m3) ─────────────────────────────────────────────────
def _tei_embeddings(textos: list[str]) -> list[list[float]]:
    """Gera embeddings via TEI fatiando `textos` em sub-lotes de ate
    EMBEDDING_MAX_LOTE (limite do --max-client-batch-size default do TEI = 32;
    acima disso o servidor responde 413). Requests SEQUENCIAIS — a ordem
    original fica garantida pela concatenacao em sequencia."""
    vetores: list[list[float]] = []
    for i in range(0, len(textos), EMBEDDING_MAX_LOTE):
        vetores.extend(_tei_embeddings_lote(textos[i : i + EMBEDDING_MAX_LOTE]))
    return vetores


def _tei_embeddings_lote(textos: list[str]) -> list[list[float]]:
    """UMA request ao TEI (POST {EMBEDDING_BASE_URL}/v1/embeddings) com ate
    EMBEDDING_MAX_LOTE textos. NAO chamar direto: use _tei_embeddings (fatiador).
    BGE-m3 e simetrico: NAO envia input_type; TEI ignora 'dimensions' (1024 nativo).
    Valida a dimensao (invariante coluna == modelo == EMBEDDING_DIMENSOES).
    Devolve os vetores na MESMA ordem dos textos de entrada."""
    import requests  # import tardio

    resp = requests.post(
        f"{EMBEDDING_BASE_URL}/v1/embeddings",
        json={"model": EMBEDDING_MODEL, "input": textos},
        headers={"Content-Type": "application/json"},
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json().get("data", [])
    # ordena por index (o TEI devolve {embedding,index}); garante alinhamento.
    data = sorted(data, key=lambda d: d.get("index", 0))
    vetores = [d["embedding"] for d in data]
    if len(vetores) != len(textos):
        raise RuntimeError(
            f"TEI devolveu {len(vetores)} vetores p/ {len(textos)} textos"
        )
    for v in vetores:
        if len(v) != EMBEDDING_DIMENSOES:
            raise RuntimeError(
                f"dim do embedding={len(v)} != EMBEDDING_DIMENSOES={EMBEDDING_DIMENSOES}"
            )
    return vetores


def _pgvector_literal(vetor: list[float]) -> str:
    """Serializa um vetor Python p/ o literal textual do pgvector: '[0.1,0.2,...]'.
    O cast ::vector no UPDATE converte a string nesse formato."""
    return "[" + ",".join(repr(float(x)) for x in vetor) + "]"


def reembed_acervo(batch: int = 200) -> dict:
    """Gera (ou regenera) os embeddings de acervo_chunks via TEI/BGE-m3 1024 e
    grava com UPDATE acervo_chunks SET embedding = '[...]'::vector.

    Processa apenas chunks SEM embedding (embedding IS NULL) — apos a migration
    0015 (TRUNCATE), isso cobre todo o acervo; em operacao normal cobre so o que
    falta. Em lotes de `batch`, com commit por lote (resiliente a interrupcao).

    Retorna {processados, lotes, dim}. NAO levanta se o TEI cair no meio: faz
    rollback do lote em curso e propaga a excecao p/ a task tratar (retry)."""
    log.info("reembed_acervo(batch=%s) iniciando", batch)
    conn = _conn_pg()
    conn.autocommit = False
    processados = 0
    lotes = 0
    try:
        # cursor de leitura paginada (server-side) so dos chunks pendentes.
        leitura = _dict_cursor(conn, name="reembed_leitura")
        leitura.execute(
            """
            SELECT id::text AS id, texto
              FROM acervo_chunks
             WHERE embedding IS NULL
             ORDER BY id
            """
        )
        # cursor de escrita separado (server-side cursors nao executam UPDATE).
        escrita = conn.cursor()

        buffer: list[dict[str, Any]] = []
        for row in leitura:
            buffer.append(row)
            if len(buffer) >= batch:
                processados += _flush_reembed(escrita, buffer)
                conn.commit()
                lotes += 1
                buffer = []
        if buffer:
            processados += _flush_reembed(escrita, buffer)
            conn.commit()
            lotes += 1

        leitura.close()
        escrita.close()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    log.info("reembed_acervo OK: %s chunks em %s lotes", processados, lotes)
    return {"processados": processados, "lotes": lotes, "dim": EMBEDDING_DIMENSOES}


def _flush_reembed(escrita, linhas: list[dict[str, Any]]) -> int:
    """Embeda um lote de linhas (id, texto) e faz UPDATE em massa via execute_batch.
    O lote aqui (default 200) e a unidade de COMMIT no Postgres; o HTTP ao TEI e
    fatiado em sub-lotes <= EMBEDDING_MAX_LOTE dentro de _tei_embeddings (evita 413).
    Devolve a quantidade de chunks atualizados."""
    import psycopg2.extras  # import tardio (execute_batch)

    textos = [(r["texto"] or "") for r in linhas]
    vetores = _tei_embeddings(textos)
    params = [
        (_pgvector_literal(vetor), r["id"]) for r, vetor in zip(linhas, vetores)
    ]
    # cast explicito ::vector converte o literal '[...]' na coluna pgvector.
    psycopg2.extras.execute_batch(
        escrita,
        "UPDATE acervo_chunks SET embedding = %s::vector WHERE id = %s",
        params,
        page_size=len(params) or 1,
    )
    return len(params)
