"""Rota MIGRADA: download de anexo extra do cofre de habilitação.

Espelha EXATAMENTE o handler Next.js::

    src/app/api/conformidade/cofre/documentos/[id]/anexos/[anexoId]/download/route.ts

que faz um proxy autenticado STREAMING de anexos extras do cofre (R2/MinIO).

PARIDADE DE WIRE (réplica fiel do Next):

  - MÉTODO: só ``GET`` (o ``route.ts`` desta pasta só exporta ``GET``; POST/
    DELETE/PATCH vivem nos ``route.ts`` IRMÃOS ``.../anexos/route.ts`` e
    ``.../anexos/[anexoId]/route.ts``, que NÃO fazem parte desta rota).

  - GUARD: ``requireVisualizar()`` no Next → :data:`require_visualizar` no BFF
    (todos os papéis exceto EXTERNO; 401 sem sessão, 403 sem permissão). O guard
    do Next, via ``handleApiError``, devolve ``{"error": ...}`` — aqui o
    ``require_visualizar`` levanta ``HTTPException`` (401/403), cujo corpo padrão
    do FastAPI é ``{"detail": ...}``. (Mesmos STATUS; o corpo dos 401/403 do app
    inteiro já é tratado por handlers globais do BFF, fora do escopo desta rota.)

  - LOOKUP (mesma query Drizzle):
        SELECT * FROM documentos_habilitacao_anexos
        WHERE id = :anexo_id AND documento_id = :id LIMIT 1
    Note a inversão de nomes vs. o path: no Next ``a.id == anexoId`` e
    ``a.documentoId == id``.

  - ERROS de domínio (corpo idêntico ao ``NextResponse.json``):
      * anexo não encontrado     → 404 ``{"error": "Anexo não encontrado"}``
      * anexo sem ``blob_key``   → 500 ``{"error": "Anexo sem blob_key"}``
      * falha ao baixar do R2    → 500 ``{"error": "Falha ao baixar"}``

  - HEADERS (réplica de ``buildDownloadHeaders`` de
    ``src/lib/storage/disposition.ts``):
      * ``Content-Type``        = MIME sanitizado (tipos perigosos viram
                                  ``application/octet-stream``).
      * ``Content-Disposition`` = ``inline``/``attachment`` + ``filename="..."``
                                  (fallback ASCII) + ``filename*=UTF-8''...``.
                                  Só vira ``inline`` se ``?inline=1`` E o MIME
                                  estiver na whitelist segura.
      * ``Cache-Control``       = ``private, no-store``.
      * ``Content-Length``      = setado quando o objeto reporta o tamanho.

  - STREAMING: ``StreamingResponse`` lendo o objeto do MinIO em chunks (não
    carrega o arquivo inteiro em memória — paridade com ``streamFromR2``).

STORAGE no BFF (réplica de ``src/lib/storage/r2.ts`` + ``download.ts``):
  boto3 (client S3 SÍNCRONO) com ``endpoint_url=settings.s3_endpoint``,
  ``aws_access_key_id=settings.s3_access_key``,
  ``aws_secret_access_key=settings.s3_secret_key``, ``region_name="us-east-1"`` e
  ``config=Config(s3={"addressing_style": "path"})`` — MinIO EXIGE path-style
  (espelha ``forcePathStyle: true`` do ``r2.ts``). ``bucket=settings.s3_bucket``.
  Import LAZY do boto3 dentro da função (aioboto3 NÃO está em requirements; boto3
  foi adicionado). O GetObject roda em threadpool (``run_in_threadpool``) para não
  bloquear o event loop; o body é iterado em chunks dentro do gerador.
"""

from __future__ import annotations

from urllib.parse import quote
from typing import Any, Iterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db
from app.routers.migrated._restrito import (
    is_conformidade,
    registrar_download_restrito,
)

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Headers seguros — réplica de src/lib/storage/disposition.ts
# ══════════════════════════════════════════════════════════════════════════════

#: MIMEs que podem ser servidos ``inline`` com baixo risco de XSS (INLINE_SAFE_MIMES).
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

#: MIMEs perigosos: reescritos como ``application/octet-stream`` (DANGEROUS_MIMES).
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
    """Réplica de ``normalizeMime``: minúsculas, sem parâmetros, fallback octet."""
    if not mime:
        return "application/octet-stream"
    trimmed = mime.split(";", 1)[0] if ";" in mime else mime
    return trimmed.strip().lower()


def _is_mime_safe_for_inline(mime: str | None) -> bool:
    """Réplica de ``isMimeSafeForInline``."""
    return _normalize_mime(mime) in _INLINE_SAFE_MIMES


def _sanitize_response_mime(mime: str | None) -> str:
    """Réplica de ``sanitizeResponseMime``: tipos perigosos → octet-stream."""
    m = _normalize_mime(mime)
    if m in _DANGEROUS_MIMES:
        return "application/octet-stream"
    return m


def _ascii_filename_fallback(name: str) -> str:
    """Réplica de ``asciiFilenameFallback``.

    Remove CR/LF/aspas/barra invertida (header injection) e troca não-ASCII por
    ``_``; limita a 200 chars; fallback ``"arquivo"`` se ficar vazio.
    """
    # \r \n " \\  → "_"  (header injection + escape literals)
    out_chars: list[str] = []
    for ch in name:
        if ch in ("\r", "\n", '"', "\\"):
            out_chars.append("_")
        elif 0x20 <= ord(ch) <= 0x7E:  # ASCII imprimível
            out_chars.append(ch)
        else:
            out_chars.append("_")  # não-ASCII vira _
    ascii_name = "".join(out_chars)[:200]
    return ascii_name or "arquivo"


def _build_content_disposition(
    filename: str, requested_inline: bool, mime: str | None
) -> str:
    """Réplica de ``buildContentDisposition`` (RFC 6266 + RFC 5987).

    ``inline`` só quando ``requested_inline`` E o MIME está na whitelist; senão
    ``attachment``. Combina ``filename="<ascii>"`` + ``filename*=UTF-8''<utf8>``.
    """
    allow_inline = requested_inline and _is_mime_safe_for_inline(mime)
    dispo = "inline" if allow_inline else "attachment"

    ascii_name = _ascii_filename_fallback(filename)
    # encodeURIComponent: percent-encode preservando os mesmos não-reservados do JS.
    utf8 = quote(filename, safe="!*'()")

    return f"{dispo}; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8}"


def _build_download_headers(
    filename: str,
    stored_mime: str | None,
    r2_mime: str | None,
    requested_inline: bool,
) -> tuple[str, str]:
    """Réplica de ``buildDownloadHeaders`` → ``(content_type, content_disposition)``."""
    mime = stored_mime or r2_mime or "application/octet-stream"
    return (
        _sanitize_response_mime(mime),
        _build_content_disposition(filename, requested_inline, mime),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Storage S3/MinIO — réplica de getR2Client / streamFromR2 (r2.ts + download.ts)
# ══════════════════════════════════════════════════════════════════════════════

#: Tamanho de chunk do streaming (espelha o streaming chunked do download.ts).
_STREAM_CHUNK = 64 * 1024  # 64 KiB


def _s3_client():
    """Cria um client S3 boto3 path-style (réplica de ``getR2Client``).

    MinIO EXIGE path-style (``forcePathStyle: true`` no ``r2.ts``); aqui via
    ``Config(s3={"addressing_style": "path"})``. ``region_name="us-east-1"``
    (default exigido pelo SigV4; o MinIO ignora a região). Import LAZY do boto3:
    mantém o boto3 fora do caminho quente das rotas que não tocam storage.
    """
    import boto3  # import lazy (boto3 só carrega quando há download de anexo)
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )


def _get_object_sync(key: str) -> tuple[Any, str | None, int | None]:
    """GetObject SÍNCRONO (réplica de ``streamFromR2``); roda em threadpool.

    Devolve ``(stream_body, content_type, content_length)``. O ``Body`` é o
    ``StreamingBody`` do botocore (file-like) — iterado em chunks pelo gerador.
    Levanta a exceção do botocore (ex.: ``NoSuchKey``/``ClientError``) se o
    objeto não existir ou houver erro — o chamador converte em 500
    ``{"error": "Falha ao baixar"}``, EXATAMENTE como o ``catch`` do Next.
    """
    client = _s3_client()
    resp = client.get_object(Bucket=settings.s3_bucket, Key=key)
    body = resp["Body"]
    content_type = resp.get("ContentType")
    content_length = resp.get("ContentLength")
    if not isinstance(content_length, int):
        content_length = None
    return body, content_type, content_length


def _iter_stream(body: Any) -> Iterator[bytes]:
    """Itera o ``StreamingBody`` do botocore em chunks (sem carregar tudo em RAM).

    Espelha o ``webStreamFromNode`` do ``download.ts`` (stream → response sem
    buffer intermediário). Fecha o body ao final ou em erro.
    """
    try:
        while True:
            chunk = body.read(_STREAM_CHUNK)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            body.close()
        except Exception:  # noqa: BLE001 — best-effort no fechamento do stream
            pass


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}/download
# ══════════════════════════════════════════════════════════════════════════════
@router.get(
    "/api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}/download"
)
async def download_anexo_cofre(
    id: str,
    anexo_id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db: AsyncSession = Depends(get_db),
):
    """Proxy autenticado streaming de anexos extras do cofre (réplica do Next).

    1. ``requireVisualizar`` (guard) — já aplicado via ``Depends``.
    1b. Barreira do PAI restrito (0034/S10): documento pai ``restrito`` fora de
        Conformidade → 404 "Documento não encontrado" (a MESMA string do 404 de
        documento inexistente) — nenhum byte do blob sai.
    2. Lookup do anexo por (id do anexo, documento_id) — 404 se inexistente.
    3. 500 se ``blob_key`` ausente.
    3b. Pai restrito visto por Conformidade → espelho 0035
        (``via='DOWNLOAD_ANEXO'``) ANTES do stream, best-effort com log.
    4. GetObject no MinIO (threadpool) → ``StreamingResponse`` com os mesmos
       headers do Next. 500 ``{"error": "Falha ao baixar"}`` em qualquer falha
       de storage.
    """
    # ── Barreira do pai (0034/S10) — resolve o documento ANTES do anexo. ──────
    # O SELECT traz titulo/restrito e o codigo da operação para o espelho 0035.
    pai = (
        await db.execute(
            text(
                """
                SELECT d.id, d.titulo, d.restrito, o.codigo AS operacao_codigo
                FROM documentos_habilitacao d
                LEFT JOIN operacoes o ON o.id = d.operacao_id
                WHERE d.id::text = :id LIMIT 1
                """
            ),
            {"id": id},
        )
    ).mappings().first()
    if pai is not None and pai["restrito"] and not is_conformidade(user.role):
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Lookup (mesma query Drizzle: id == anexoId AND documento_id == id) ─────
    row = (
        await db.execute(
            text(
                """
                SELECT id, documento_id, nome_arquivo, blob_key, content_type
                FROM documentos_habilitacao_anexos
                WHERE id = :anexo_id AND documento_id = :doc_id
                LIMIT 1
                """
            ),
            {"anexo_id": anexo_id, "doc_id": id},
        )
    ).mappings().first()

    if row is None:
        # NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 })
        return JSONResponse(
            content={"error": "Anexo não encontrado"}, status_code=404
        )

    blob_key = row["blob_key"]
    if not blob_key:
        # NextResponse.json({ error: "Anexo sem blob_key" }, { status: 500 })
        return JSONResponse(
            content={"error": "Anexo sem blob_key"}, status_code=500
        )

    # ?inline=1 → tenta servir inline (só se o MIME estiver na whitelist segura).
    requested_inline = request.query_params.get("inline") == "1"

    # ── Espelho 0035 (P7 — S10): Conformidade baixando anexo de documento
    # RESTRITO. ``via='DOWNLOAD_ANEXO'`` (coluna text sem CHECK — valor novo é
    # compatível). ANTES do stream; best-effort com log; commit próprio (rota
    # de stream, sem transação da resposta). ──────────────────────────────────
    if pai is not None and pai["restrito"]:
        try:
            await registrar_download_restrito(
                db,
                documento_id=str(pai["id"]),
                titulo=pai["titulo"],
                operacao_codigo=pai["operacao_codigo"],
                user_id=user.id,
                user_email=user.email,
                role=user.role,
                via="DOWNLOAD_ANEXO",
            )
            await db.commit()
        except Exception:  # noqa: BLE001 — espelho best-effort, não quebra o download
            import logging

            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass
            logging.getLogger("petro.audit").warning(
                "falha ao gravar audit_download_restrito (doc=%s via=DOWNLOAD_ANEXO)",
                pai["id"],
            )

    # ── Baixa do MinIO (réplica de streamFromR2) ──────────────────────────────
    try:
        body, obj_content_type, obj_content_length = await run_in_threadpool(
            _get_object_sync, blob_key
        )
    except Exception:  # noqa: BLE001 — qualquer erro de R2 = 500 "Falha ao baixar"
        # Espelha o catch do Next (log + NextResponse.json 500).
        return JSONResponse(content={"error": "Falha ao baixar"}, status_code=500)

    content_type, content_disposition = _build_download_headers(
        row["nome_arquivo"],
        row["content_type"],
        obj_content_type,
        requested_inline,
    )

    headers = {
        "Content-Disposition": content_disposition,
        "Cache-Control": "private, no-store",
    }
    if obj_content_length is not None:
        headers["Content-Length"] = str(obj_content_length)

    return StreamingResponse(
        _iter_stream(body),
        status_code=200,
        media_type=content_type,  # vira o header Content-Type
        headers=headers,
    )
