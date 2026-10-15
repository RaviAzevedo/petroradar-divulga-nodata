"""Rota MIGRADA (estrangulador / strangler-fig):
    /api/conformidade/cofre/documentos/{id}/download

Espelho 1:1 de
``src/app/api/conformidade/cofre/documentos/[id]/download/route.ts`` — PROXY
AUTENTICADO de download do Cofre de Documentos de Habilitação (CND, ISO, ART/CAT,
declarações, ACT etc.). Stream direto do MinIO/S3 (era Cloudflare R2 na nuvem),
sem carregar o arquivo inteiro na memória.

──────────────────────────────────────────────────────────────────────────────
MÉTODOS (paridade EXATA com o route.ts)
──────────────────────────────────────────────────────────────────────────────
O ``download/route.ts`` exporta UM ÚNICO handler: ``GET``. NÃO há POST / DELETE /
PATCH neste arquivo do Next — o UPLOAD vive em
``.../documentos/route.ts`` (POST, já migrado em ``conf_cofre_documentos.py``) e o
DELETE/PATCH do documento vivem em ``.../documentos/[id]/route.ts`` (já migrados
em ``conf_cofre_documentos_id.py``). Esta rota é apenas o proxy de DOWNLOAD, então
replicamos SOMENTE o GET. Adicionar POST/DELETE/PATCH aqui CRIARIA superfície que
o Next não expõe (no Next, um POST/DELETE em ``.../download`` retorna 405 do
framework). Mantemos a paridade: só GET.

──────────────────────────────────────────────────────────────────────────────
GUARD (mapeamento requireX do Next → require_X do BFF)
──────────────────────────────────────────────────────────────────────────────
GET → ``requireVisualizar()``  ==  sessão + ``podeVisualizar(role)``
      role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR}; barra
      EXTERNO. Equivalente no BFF: ``require_visualizar`` (Depends).
      401 (sem sessão) / 403 (papel barrado) — emitidos pelo próprio guard,
      ANTES de qualquer leitura de banco (ordem do Next: ``await requireVisualizar()``
      é a primeira coisa do handler, dentro de try/catch → ``handleApiError``).

      NOTA sobre o shape do 401/403: no Next o ``requireVisualizar`` lança
      ``ApiError`` que o ``handleApiError`` serializa como
      ``{"error": <msg>, "code": <code>}``. O ``require_visualizar`` do BFF lança
      ``HTTPException`` (``{"detail": ...}``). Essa diferença de envelope de ERRO
      de auth é a MESMA já aceita por todos os irmãos migrados deste módulo
      (o teste de paridade compara o CORPO DE SUCESSO; o handler de exceção
      global do app normaliza/loga os 401/403). Mantemos o guard idêntico aos
      irmãos para consistência.

──────────────────────────────────────────────────────────────────────────────
ORDEM das checagens (preservada do route.ts, linha a linha)
──────────────────────────────────────────────────────────────────────────────
  1. ``await requireVisualizar()``                        → 401 / 403
  2. ``getDocumentoById(id)``; se ``!documento``          → 404
        ``{"error":"Documento não encontrado"}``
  3. ``if (!documento.blobKey)``                          → 500
        ``{"error":"Documento sem blob_key"}``
        (a coluna ``blob_key`` é NOT NULL no schema, mas o Next FAZ essa checagem
        defensiva e devolve 500 — replicamos fielmente.)
  4. ``streamFromR2(documento.blobKey)``  +  monta headers e devolve 200 stream.
        Qualquer ERRO do storage (objeto inexistente, auth, endpoint) cai no
        ``catch`` do Next → 500 ``{"error":"Falha ao baixar o arquivo"}``.
        IMPORTANTE: um OBJETO inexistente no MinIO NÃO vira 404 — vira 500 (o
        ``GetObjectCommand`` lança e o catch genérico responde 500). O 404 só
        ocorre quando a LINHA do banco não existe (passo 2). Replicamos isso.

──────────────────────────────────────────────────────────────────────────────
HEADERS de sucesso (idênticos ao route.ts)
──────────────────────────────────────────────────────────────────────────────
  Content-Type        ← ``buildDownloadHeaders(...).contentType``
  Content-Disposition ← ``buildDownloadHeaders(...).contentDisposition``
  Cache-Control       ← ``"private, no-store"`` (literal, sempre)
  Content-Length      ← ``String(obj.contentLength)`` SE o storage informar o
                        ``ContentLength`` (omitido quando ``None``).

``buildDownloadHeaders`` (réplica de ``src/lib/storage/disposition.ts``):
  - mime efetivo = ``storedMime (banco) || r2Mime (storage) || octet-stream``;
  - Content-Type SANITIZADO: MIMEs perigosos (HTML/JS/SVG/XML) viram
    ``application/octet-stream`` (defesa anti-XSS, casa com nosniff global);
  - Content-Disposition RFC 6266 + RFC 5987:
      ``<inline|attachment>; filename="<ascii>"; filename*=UTF-8''<utf8>``
    ``inline`` SOMENTE quando ``?inline=1`` E o mime está na whitelist segura
    (pdf, png, jpeg, gif, webp, text/plain); caso contrário ``attachment``.

  Fonte dos campos (réplica de ``getDocumentoById`` / colunas Drizzle):
    filename   = ``documentos_habilitacao.nome_arquivo``
    storedMime = ``documentos_habilitacao.content_type``
    r2Mime     = ``ContentType`` retornado pelo storage (header do objeto)
    inline     = ``new URL(req.url).searchParams.get("inline") === "1"``

──────────────────────────────────────────────────────────────────────────────
STORAGE (boto3 — MinIO path-style)
──────────────────────────────────────────────────────────────────────────────
Cliente S3 via ``boto3`` (síncrono) com:
  endpoint_url          = settings.s3_endpoint
  aws_access_key_id     = settings.s3_access_key
  aws_secret_access_key = settings.s3_secret_key
  region_name           = "us-east-1"
  config                = Config(s3={"addressing_style": "path"})  (MinIO EXIGE)
  Bucket                = settings.s3_bucket

O ``aioboto3`` NÃO está no requirements (só ``boto3`` será adicionado), então
importamos ``boto3`` DENTRO da função (import tardio: storage fora do caminho
quente do import-time; idêntico ao padrão dos irmãos ``conf_cofre_documentos*``).

Streaming: ``get_object`` devolve um ``StreamingBody`` (file-like, ``.read``).
Envolvemos num gerador que lê em chunks de 64 KiB e devolve via
``fastapi.responses.StreamingResponse`` — paridade com o stream do R2 do Next
(não materializa o arquivo inteiro na memória). O cliente boto3 é mantido vivo
pela closure do gerador até o fim do stream (e fechado ao final).
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db
from app.routers.migrated._restrito import (
    is_conformidade,
    registrar_download_restrito,
)
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Metadados de acesso p/ trilha LGPD (IP + User-Agent) — só vão no jsonb detalhes
# ══════════════════════════════════════════════════════════════════════════════
def _client_ip(request: Request) -> str:
    """IP do cliente via ``x-forwarded-for`` (1º IP) → ``x-real-ip`` → 'unknown'.

    Espelha ``getClientIp`` de ``src/lib/auth.ts`` (mesma ordem de headers).
    """
    xff = request.headers.get("x-forwarded-for") or ""
    first = xff.split(",")[0].strip()
    if first:
        return first
    return request.headers.get("x-real-ip") or "unknown"


def _user_agent(request: Request) -> str:
    """User-Agent truncado em 512 chars (espelha ``getUserAgent`` de auth.ts)."""
    return (request.headers.get("user-agent") or "unknown")[:512]


# ══════════════════════════════════════════════════════════════════════════════
# Content-Type / Content-Disposition — réplica de src/lib/storage/disposition.ts
# ══════════════════════════════════════════════════════════════════════════════

#: MIMEs que podem ser servidos com ``inline`` com baixo risco de XSS
#: (espelha INLINE_SAFE_MIMES).
_INLINE_SAFE_MIMES = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "text/plain",
    }
)

#: MIMEs perigosos (executáveis no browser) — reescritos p/ octet-stream
#: (espelha DANGEROUS_MIMES).
_DANGEROUS_MIMES = frozenset(
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
    """Réplica de ``normalizeMime``: sem mime → octet-stream; tira ``;params``;
    trim + lower."""
    if not mime:
        return "application/octet-stream"
    trimmed = mime.split(";")[0] if ";" in mime else mime
    return trimmed.strip().lower()


def _is_mime_safe_for_inline(mime: str | None) -> bool:
    """Réplica de ``isMimeSafeForInline``."""
    return _normalize_mime(mime) in _INLINE_SAFE_MIMES


def _sanitize_response_mime(mime: str | None) -> str:
    """Réplica de ``sanitizeResponseMime``: MIMEs perigosos → octet-stream."""
    m = _normalize_mime(mime)
    if m in _DANGEROUS_MIMES:
        return "application/octet-stream"
    return m


def _ascii_filename_fallback(name: str) -> str:
    """Réplica de ``asciiFilenameFallback``.

    JS:
      name.replace(/[\\r\\n"\\\\]/g, "_").replace(/[^\\x20-\\x7E]/g, "_")
          .slice(0, 200) || "arquivo"
    """
    # 1) CR/LF, aspas e barra invertida → "_"  (anti header-injection / escape)
    fora_injecao = {"\r", "\n", '"', "\\"}
    # 2) qualquer char fora de [0x20..0x7E] (ASCII imprimível) → "_"
    chars = []
    for ch in name:
        if ch in fora_injecao:
            chars.append("_")
        elif 0x20 <= ord(ch) <= 0x7E:
            chars.append(ch)
        else:
            chars.append("_")
    ascii_name = "".join(chars)[:200]
    return ascii_name or "arquivo"


def _encode_uri_component(value: str) -> str:
    """Réplica de ``encodeURIComponent`` do JS.

    ``encodeURIComponent`` NÃO escapa: A-Z a-z 0-9 - _ . ! ~ * ' ( ).
    O ``quote`` do Python NÃO escapa por padrão A-Z a-z 0-9 _ . - ~ e o que
    estiver em ``safe``. Passamos o restante do conjunto seguro do JS em ``safe``
    para casar EXATAMENTE com ``encodeURIComponent``.
    """
    return quote(value, safe="!~*'()")


def _build_content_disposition(
    filename: str, requested_inline: bool, mime: str | None
) -> str:
    """Réplica de ``buildContentDisposition`` (RFC 6266 + RFC 5987)."""
    allow_inline = requested_inline and _is_mime_safe_for_inline(mime)
    dispo = "inline" if allow_inline else "attachment"

    ascii_name = _ascii_filename_fallback(filename)
    utf8 = _encode_uri_component(filename)

    return f"{dispo}; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8}"


def _build_download_headers(
    filename: str,
    stored_mime: str | None,
    r2_mime: str | None,
    requested_inline: bool,
) -> tuple[str, str]:
    """Réplica de ``buildDownloadHeaders`` → (contentType, contentDisposition)."""
    mime = stored_mime or r2_mime or "application/octet-stream"
    return (
        _sanitize_response_mime(mime),
        _build_content_disposition(filename, requested_inline, mime),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Banco — getDocumentoById (SELECT * de documentos_habilitacao)
# ══════════════════════════════════════════════════════════════════════════════
# Cast EXPLÍCITO do parâmetro para uuid (``id = CAST(:id AS uuid)``) para reproduzir
# FIELMENTE o comportamento do Next. No Next, ``getDocumentoById`` faz
# ``eq(documentosHabilitacao.id, id)`` sobre uma coluna ``id`` do tipo *uuid*
# (schema.ts:806 → ``uuid("id")``): o driver vincula a string crua contra a coluna
# uuid e, para um id NÃO-UUID, o Postgres lança ``22P02 invalid input syntax for
# type uuid``. Como a chamada de ``getDocumentoById`` está FORA de qualquer
# try/catch no route.ts (a 1ª try fecha na linha 25; a 2ª só abre na linha 36), a
# exceção propaga sem tratamento → o Next responde 500 (erro de framework).
#
# Aqui, ``_get_documento`` também é chamado FORA da try/catch local (a try só
# envolve o storage). Com ``CAST(:id AS uuid)``, um id não-UUID faz o Postgres
# lançar 22P02, que propaga do handler → é capturado pelo middleware global
# (main.py) → 500. Já um UUID VÁLIDO mas inexistente simplesmente não casa → 404.
# Resultado: id não-UUID → 500 (igual ao Next); UUID inexistente → 404 (igual ao
# Next); UUID existente → 200 (caminho feliz preservado).
_SELECT_DOC = text(
    # 0034/R16: ``titulo``/``restrito`` e o ``codigo`` da operação (LEFT JOIN)
    # entram para a barreira restrito e para o espelho 0035 (P7).
    "SELECT d.id, d.titulo, d.nome_arquivo, d.blob_key, d.content_type, "
    "d.restrito, o.codigo AS operacao_codigo "
    "FROM documentos_habilitacao d "
    "LEFT JOIN operacoes o ON o.id = d.operacao_id "
    "WHERE d.id = CAST(:id AS uuid) LIMIT 1"
)


async def _get_documento(db, id: str):
    """``getDocumentoById(id)``: SELECT ... LIMIT 1 → mapping ou None."""
    res = await db.execute(_SELECT_DOC, {"id": id})
    return res.mappings().first()


# ══════════════════════════════════════════════════════════════════════════════
# Storage S3/MinIO (boto3, path-style) — réplica de streamFromR2 (lib/storage)
# ══════════════════════════════════════════════════════════════════════════════
_CHUNK = 64 * 1024  # 64 KiB — streaming sem materializar o arquivo na memória.


def _s3_client():
    """Cliente boto3 S3 path-style (MinIO exige addressing_style=path).

    Import tardio de boto3/botocore: mantém o storage fora do caminho de import e
    fora do caminho quente quando a rota não baixa nada (padrão dos irmãos
    migrados ``conf_cofre_documentos*``).
    """
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/conformidade/cofre/documentos/{id}/download — proxy de download
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/conformidade/cofre/documentos/{id}/download")
async def download_documento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),  # 401/403 (requireVisualizar)
    db=Depends(get_db),
):
    # ── 404: a LINHA do banco existe? (getDocumentoById) ──────────────────────
    documento = await _get_documento(db, id)
    if documento is None:
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── Barreira restrito (0034/R16): 404 IDÊNTICO ao de inexistente ─────────
    # Nunca 403 — confirmaria a existência do contrato sob sigilo (ADR-05).
    if documento["restrito"] and not is_conformidade(user.role):
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── 500 defensivo: blob_key nula (Next checa mesmo sendo NOT NULL) ────────
    blob_key = documento["blob_key"]
    if not blob_key:
        return JSONResponse(
            content={"error": "Documento sem blob_key"}, status_code=500
        )

    # ── Stream do MinIO/S3 (streamFromR2) + headers (buildDownloadHeaders) ────
    try:
        client = _s3_client()
        obj = client.get_object(Bucket=settings.s3_bucket, Key=blob_key)
    except Exception:  # noqa: BLE001 — qualquer falha de storage → 500 (igual ao catch do Next)
        return JSONResponse(
            content={"error": "Falha ao baixar o arquivo"}, status_code=500
        )

    requested_inline = request.query_params.get("inline") == "1"
    content_type, content_disposition = _build_download_headers(
        filename=documento["nome_arquivo"],
        stored_mime=documento["content_type"],
        r2_mime=obj.get("ContentType"),
        requested_inline=requested_inline,
    )

    headers = {
        "Content-Disposition": content_disposition,
        "Cache-Control": "private, no-store",
    }
    content_length = obj.get("ContentLength")
    if content_length is not None:
        headers["Content-Length"] = str(content_length)

    # ── Espelho 0035 (P7): Conformidade baixando documento RESTRITO ──────────
    # Só quem é Conformidade chega aqui com restrito=true (a barreira acima
    # barrou o resto). Gravado ANTES de streamar o corpo, FORA do expurgo de 12
    # meses, ALÉM do audit LGPD normal. Best-effort com log: falha não derruba
    # o download (política do §1.4 da arquitetura). Commit próprio: rota de
    # stream, sem transação da resposta.
    if documento["restrito"]:
        try:
            await registrar_download_restrito(
                db,
                documento_id=str(documento["id"]),
                titulo=documento["titulo"],
                operacao_codigo=documento["operacao_codigo"],
                user_id=user.id,
                user_email=user.email,
                role=user.role,
                via="DOWNLOAD",
            )
            await db.commit()
        except Exception:  # noqa: BLE001 — espelho é best-effort, não quebra o download
            import logging

            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass
            logging.getLogger("petro.audit").warning(
                "falha ao gravar audit_download_restrito (doc=%s via=DOWNLOAD)",
                documento["id"],
            )

    # ── Auditoria LGPD (best-effort) ─────────────────────────────────────────
    # Documentos de habilitação contêm PII (CPF, certidões). Registramos QUEM
    # baixou O QUÊ e QUANDO — APÓS o guard require_visualizar (401/403 nunca
    # chegam aqui), a linha existir (404 já retornou) e o storage responder
    # (500 já retornou): ou seja, só download efetivamente autorizado. IP e
    # user-agent vão DENTRO do jsonb ``detalhes`` (sem PII do conteúdo, só
    # metadados do acesso). Commit ANTES de iniciar o stream (o gerador de corpo
    # usa só o boto3, não a sessão). Falha de auditoria NÃO derruba o download.
    try:
        await registrar_audit(
            db,
            user_id=user.id,
            acao="DOWNLOAD_DOCUMENTO_HABILITACAO",
            entidade="documento_habilitacao",
            entidade_id=str(documento["id"]),
            detalhes={
                "nomeArquivo": documento["nome_arquivo"],
                "inline": requested_inline,
                "ip": _client_ip(request),
                "userAgent": _user_agent(request),
            },
        )
        await db.commit()
    except Exception:  # noqa: BLE001 — auditoria é best-effort, não quebra o download
        import logging

        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logging.getLogger("petro.audit").warning(
            "falha ao gravar audit de DOWNLOAD_DOCUMENTO_HABILITACAO (doc=%s)",
            documento["id"],
        )

    body = obj["Body"]  # botocore StreamingBody (file-like)

    def _iter_body():
        """Lê o objeto em chunks (não materializa o arquivo inteiro) e garante o
        fechamento do StreamingBody e do cliente boto3 ao final do stream."""
        try:
            while True:
                chunk = body.read(_CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                body.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass

    return StreamingResponse(
        _iter_body(),
        status_code=200,
        media_type=content_type,  # vira o header Content-Type
        headers=headers,
    )
