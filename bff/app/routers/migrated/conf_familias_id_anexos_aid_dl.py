"""Rota migrada: DOWNLOAD de anexo de FAMÍLIA (proxy autenticado S3/MinIO).

Espelha EXATAMENTE
``src/app/api/conformidade/familias/[id]/anexos/[anexoId]/download/route.ts``:

    GET /api/conformidade/familias/{id}/anexos/{anexo_id}/download

A rota Next tem APENAS o método GET (proxy de streaming de anexos de família —
CRC, atas, etc.). Não há POST/PUT/PATCH/DELETE no arquivo original, então este
módulo replica somente o GET.

Fluxo replicado linha-a-linha do Next:
  1. ``requireVisualizar()`` → 401/403 (guard ``require_visualizar``).
  2. SELECT em ``familias_anexos`` por ``id == anexoId`` **e** ``familia_id == id``
     (limit 1). Se não houver linha → **404** ``{"error": "Anexo não encontrado"}``.
  3. Se ``blob_key`` for nulo/vazio → **500** ``{"error": "Anexo sem blob_key"}``.
     (Na prática a coluna é NOT NULL; mantemos o ramo por fidelidade ao Next.)
  4. Lê o objeto do MinIO (``streamFromR2(blobKey)``). Em qualquer erro de storage
     (objeto inexistente, auth, body vazio) → **500** ``{"error": "Falha ao baixar"}``
     (EXATAMENTE como o ``catch`` do Next — NÃO é 404; o 404 é só para a linha de
     banco ausente).
  5. Em sucesso → **200** com ``StreamingResponse`` e os MESMOS headers:
       - ``Content-Type``        = ``buildDownloadHeaders().contentType``
       - ``Content-Disposition`` = ``buildDownloadHeaders().contentDisposition``
       - ``Cache-Control``       = ``private, no-store``
       - ``Content-Length``      = tamanho do objeto (quando o MinIO informa)

``buildDownloadHeaders`` / ``buildContentDisposition`` / ``sanitizeResponseMime``
são réplicas fiéis de ``src/lib/storage/disposition.ts`` (whitelist de MIMEs
seguros para inline, reescrita de MIMEs perigosos como
``application/octet-stream``, fallback ASCII + ``filename*`` RFC 5987).

``?inline=1`` é o gatilho de inline (igual ao Next:
``searchParams.get("inline") === "1"``).

Storage: lazy ``aioboto3`` (mesma dependência já usada por
``conf_cofre_documentos.py``), client path-style contra ``settings.s3_endpoint``
(MinIO exige path-style). O objeto é lido inteiro em memória e devolvido como um
único chunk via ``StreamingResponse`` — fidelidade de comportamento ao proxy do
Next (que faz streaming; aqui materializamos o corpo, pois ``get_object`` do
aioboto3 entrega um ``StreamingBody`` assíncrono que se esgota ao fechar o client).
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Content-Type / Content-Disposition (réplica fiel de src/lib/storage/disposition.ts)
# ══════════════════════════════════════════════════════════════════════════════

#: MIMEs que podem ser servidos inline com baixo risco de XSS (INLINE_SAFE_MIMES).
_INLINE_SAFE_MIMES: frozenset[str] = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "text/plain",
    }
)

#: MIMEs perigosos → reescritos como application/octet-stream (DANGEROUS_MIMES).
_DANGEROUS_MIMES: frozenset[str] = frozenset(
    {
        "text/html",
        "application/xhtml+xml",
        "application/javascript",
        "text/javascript",
        "application/x-javascript",
        "image/svg+xml",
        "text/xml",
        "application/xml",
    }
)


def _normalize_mime(mime: str | None) -> str:
    """``normalizeMime`` — sem MIME → octet-stream; tira params (``;``) e baixa caixa."""
    if not mime:
        return "application/octet-stream"
    trimmed = mime.split(";", 1)[0] if ";" in mime else mime
    return trimmed.strip().lower()


def _is_mime_safe_for_inline(mime: str | None) -> bool:
    """``isMimeSafeForInline`` — verdadeiro se o MIME está na whitelist de inline."""
    return _normalize_mime(mime) in _INLINE_SAFE_MIMES


def _sanitize_response_mime(mime: str | None) -> str:
    """``sanitizeResponseMime`` — MIME perigoso → application/octet-stream."""
    m = _normalize_mime(mime)
    if m in _DANGEROUS_MIMES:
        return "application/octet-stream"
    return m


def _ascii_filename_fallback(name: str) -> str:
    """``asciiFilenameFallback`` — fallback ASCII p/ Content-Disposition.

    Remove CR/LF/aspas/backslash (header injection) e qualquer char fora de
    0x20..0x7E vira ``_``; limita a 200 chars; vazio → ``arquivo``.
    """
    # /[\r\n"\\]/g → "_"
    ascii_name = re.sub(r'[\r\n"\\]', "_", name)
    # /[^\x20-\x7E]/g → "_"
    ascii_name = re.sub(r"[^\x20-\x7E]", "_", ascii_name)
    ascii_name = ascii_name[:200]
    return ascii_name or "arquivo"


def _build_content_disposition(
    filename: str, requested_inline: bool, mime: str | None
) -> str:
    """``buildContentDisposition`` — RFC 6266 + RFC 5987.

    inline só se ``requested_inline`` E o MIME está na whitelist; caso contrário
    attachment. Combina ``filename="<ascii>"`` + ``filename*=UTF-8''<utf8>``.
    """
    allow_inline = requested_inline and _is_mime_safe_for_inline(mime)
    dispo = "inline" if allow_inline else "attachment"

    ascii_name = _ascii_filename_fallback(filename)
    # encodeURIComponent: percent-encode mantendo os "marks" A-Za-z0-9 e !'()*-._~
    utf8 = urllib.parse.quote(filename, safe="!'()*-._~")

    return f"{dispo}; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8}"


def _build_download_headers(
    filename: str,
    stored_mime: str | None,
    storage_mime: str | None,
    requested_inline: bool,
) -> tuple[str, str]:
    """``buildDownloadHeaders`` → ``(contentType, contentDisposition)``.

    MIME efetivo = stored || storage || octet-stream (mesma precedência do Next:
    ``a.contentType`` primeiro, depois o do storage).
    """
    mime = stored_mime or storage_mime or "application/octet-stream"
    return (
        _sanitize_response_mime(mime),
        _build_content_disposition(filename, requested_inline, mime),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Storage S3/MinIO (réplica de streamFromR2 — src/lib/storage/download.ts)
# ══════════════════════════════════════════════════════════════════════════════


async def _stream_from_storage(key: str) -> tuple[bytes, str | None, int | None]:
    """Réplica de ``streamFromR2(key)`` — GetObject no S3/MinIO (path-style).

    Retorna ``(body_bytes, contentType, contentLength)``. Levanta exceção se o
    objeto não existir, se houver erro de auth, ou se o corpo vier vazio
    (``"R2 retornou objeto sem body"``) — o chamador converte qualquer exceção
    aqui no MESMO 500 do ``catch`` do Next.

    Client path-style: MinIO EXIGE ``addressing_style='path'``. ``region_name`` é
    ``us-east-1`` (não importa para o MinIO; basta um valor válido).
    """
    import aioboto3
    from botocore.config import Config

    session = aioboto3.Session()
    async with session.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    ) as s3:
        resp = await s3.get_object(Bucket=settings.s3_bucket, Key=key)
        body_stream = resp.get("Body")
        if body_stream is None:
            # Espelha o `if (!r.Body) throw new Error("R2 retornou objeto sem body")`.
            raise RuntimeError("R2 retornou objeto sem body")
        # StreamingBody assíncrono do aioboto3: lê tudo antes do client fechar.
        body = await body_stream.read()
        content_type = resp.get("ContentType")
        content_length = resp.get("ContentLength")
        if not isinstance(content_length, int):
            content_length = None
        return body, content_type, content_length


# ══════════════════════════════════════════════════════════════════════════════
# Banco: SELECT do anexo (familias_anexos) por anexoId + familiaId
# ══════════════════════════════════════════════════════════════════════════════


async def _get_anexo(db: Any, familia_id: str, anexo_id: str) -> Any:
    """SELECT em ``familias_anexos`` por ``id == anexoId`` E ``familia_id == id``.

    Réplica de ``db.select().from(familiasAnexos).where(and(eq(id, anexoId),
    eq(familiaId, id))).limit(1)``. Retorna a row (ou ``None``).
    """
    result = await db.execute(
        text(
            """
            SELECT id, familia_id, tipo, nome_arquivo, blob_url, blob_key,
                   tamanho_bytes, content_type
              FROM familias_anexos
             WHERE id = CAST(:anexo_id AS uuid)
               AND familia_id = CAST(:familia_id AS uuid)
             LIMIT 1
            """
        ),
        {"anexo_id": anexo_id, "familia_id": familia_id},
    )
    return result.mappings().first()


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/conformidade/familias/{id}/anexos/{anexo_id}/download
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/conformidade/familias/{id}/anexos/{anexo_id}/download")
async def download_anexo_familia(
    id: str,
    anexo_id: str,
    request: Request,
    # requireVisualizar(): 401 sem sessão, 403 sem permissão (EXTERNO).
    user: CurrentUser = Depends(require_visualizar),
    db: Any = Depends(get_db),
):
    """Proxy autenticado de streaming de anexo de família (CRC, atas, etc.)."""
    # ── 404: anexo existe? (and(id == anexoId, familiaId == id)) ──────────────
    anexo = await _get_anexo(db, id, anexo_id)
    if anexo is None:
        return JSONResponse(
            content={"error": "Anexo não encontrado"}, status_code=404
        )

    blob_key = anexo["blob_key"]
    # ── 500: blob_key ausente (ramo `if (!a.blobKey)` do Next) ────────────────
    if not blob_key:
        return JSONResponse(
            content={"error": "Anexo sem blob_key"}, status_code=500
        )

    # ── Lê do storage + monta headers; qualquer falha → 500 (catch do Next) ───
    try:
        body, storage_ct, content_length = await _stream_from_storage(blob_key)

        # `new URL(req.url).searchParams.get("inline") === "1"`
        requested_inline = request.query_params.get("inline") == "1"

        content_type, content_disposition = _build_download_headers(
            anexo["nome_arquivo"],
            anexo["content_type"],
            storage_ct,
            requested_inline,
        )

        headers = {
            "Content-Type": content_type,
            "Content-Disposition": content_disposition,
            "Cache-Control": "private, no-store",
        }
        if content_length is not None:
            headers["Content-Length"] = str(content_length)

        # StreamingResponse com o corpo único; media_type repete o Content-Type
        # já calculado (e fica em headers para garantir o valor exato/sanitizado).
        return StreamingResponse(
            iter((body,)),
            status_code=200,
            media_type=content_type,
            headers=headers,
        )
    except Exception:  # noqa: BLE001 — qualquer erro de storage = 500 (igual ao Next)
        return JSONResponse(content={"error": "Falha ao baixar"}, status_code=500)
