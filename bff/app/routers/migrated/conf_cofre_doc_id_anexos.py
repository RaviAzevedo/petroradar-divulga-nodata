"""Rota MIGRADA (estrangulador): /api/conformidade/cofre/documentos/{id}/anexos.

Espelha 1:1 ``src/app/api/conformidade/cofre/documentos/[id]/anexos/route.ts`` do
app Next.js. O Next exporta DOIS handlers neste arquivo — replicamos AMBOS, na
mesma ordem de checagens, com os MESMOS status e shapes:

  GET   → lista os anexos EXTRAS do documento (``getAnexosByDocumento``). É um
          proxy de METADADOS (JSON), NÃO um download binário — este route.ts NÃO
          serve o objeto do MinIO (o download do binário fica em
          ``.../anexos/[anexoId]/download``). Por isso o GET aqui NÃO toca o S3:
          só projeta as MESMAS colunas camelCase do ``.select({...})`` do Drizzle
          (com LEFT JOIN users.nome → uploadadoPorNome, ORDER BY criadoEm DESC).

  POST  → upload multipart/form-data: confere a existência do documento (404),
          valida o arquivo (tipo / tamanho 50MB / magic bytes → 422), faz
          ``put_object`` no MinIO com a MESMA key/estrutura
          (``conformidade/documentos/<docId>/anexos/<ts_ms>_<nome>``), grava a
          linha em ``documentos_habilitacao_anexos``, registra o ``audit_log`` e
          devolve o REGISTRO inserido CRU (NextResponse.json(novo, {status:201})).

NÃO há DELETE/PATCH/PUT neste arquivo (o Next não os exporta nesta rota), então
não os implementamos — manter paridade significa NÃO criar handlers que o Next
não tem. (DELETE/PATCH vivem em ``.../anexos/[anexoId]``.)

──────────────────────────────────────────────────────────────────────────────
GUARDS (paridade EXATA com o Next):

  GET   → ``requireVisualizar()`` == BFF ``require_visualizar`` (ADMIN, LIDER,
          ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR). 401 sem sessão, 403 EXTERNO.

  POST  → ``requireAuth()`` (apenas sessão; 401 sem sessão, via get_current_user)
          e SÓ DEPOIS ``podeGerenciarDocumentosHabilitacao(role)`` ==
          ``isConformidade(role) || role == ORCAMENTISTA || role == TECNICO``
          (conjunto efetivo {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}). Falha de
          papel → 403 ``{"error":"Permissão negada"}``. NÃO usamos o guard
          semântico ``require_conformidade``: fazemos a checagem manual após
          ``get_current_user`` para manter a ordem 401-antes-de-403 e a mensagem
          exata do Next.

SHAPE de erro: o Next usa ``{ "error": <string> }`` com status 400/403/404/422.
Replicamos literalmente.

SHAPE de sucesso:
  GET  200  {"data":[...]}  (== { data: lista } do route.ts)
  POST 201  o REGISTRO inserido CRU (NextResponse.json(novo)) — NÃO embrulhado em
            {"data": ...}. camelCase idêntico ao $inferSelect do Drizzle
            (documentos_habilitacao_anexos.returning() = TODAS as colunas).

STORAGE: upload no S3/MinIO via ``boto3`` SÍNCRONO em ``run_in_threadpool``
(settings.s3_*). Réplica do ``uploadByKey`` de ``src/lib/storage/upload.ts``
(path-style, MESMA key ``conformidade/documentos/<docId>/anexos/<ts_ms>_<nome>``,
MESMA URL canônica path-style ``<endpoint>/<bucket>/<key>`` == ``getR2ObjectUrl``).
Cliente boto3 conforme contrato do BFF: ``endpoint_url=settings.s3_endpoint``,
credenciais ``settings.s3_access_key`` / ``settings.s3_secret_key``,
``region_name='us-east-1'`` e ``config=Config(s3={'addressing_style':'path'})``
(MinIO EXIGE path-style). ``bucket=settings.s3_bucket``.

SERIALIZAÇÃO: timestamptz → ``_js_to_iso_string`` (UTC, ms, sufixo 'Z', batendo
wire-a-wire com o ``Date.toISOString()`` do ``NextResponse.json``); uuid → ``str()``.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

from botocore.config import Config
from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import (
    CurrentUser,
    get_current_user,
    require_visualizar,
)
from app.db.session import get_db
from app.routers.migrated._restrito import is_conformidade
from app.services.audit import registrar_audit

router = APIRouter()


# ── Barreira do documento PAI restrito (0034/S8 — 02-APIS §16-B.1) ────────────
async def _pai_restrito_invisivel(db, id: str, role: str) -> bool:
    """True quando o documento pai existe, é ``restrito`` e o papel está fora
    de Conformidade — caso em que o handler responde o MESMO 404 de documento
    inexistente ("anexo não encontrado" ou 403 confirmaria a existência do
    pai). Pai inexistente devolve False: os gates atuais da rota tratam."""
    row = (
        await db.execute(
            text(
                "SELECT restrito FROM documentos_habilitacao "
                "WHERE id::text = :id LIMIT 1"
            ),
            {"id": id},
        )
    ).mappings().first()
    return row is not None and row["restrito"] and not is_conformidade(role)


# ══════════════════════════════════════════════════════════════════════════════
# Permissão (espelha podeGerenciarDocumentosHabilitacao de permissions.ts)
# ══════════════════════════════════════════════════════════════════════════════
# isConformidade(role) || role == ORCAMENTISTA || role == TECNICO
#   isConformidade = role ∈ {ADMIN, LIDER, SGI}
# ⇒ conjunto efetivo: {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}
def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    return role in ("ADMIN", "LIDER", "SGI", "ORCAMENTISTA", "TECNICO")


# ══════════════════════════════════════════════════════════════════════════════
# Serialização de datetimes (paridade com NextResponse.json -> Date.toISOString)
# ══════════════════════════════════════════════════════════════════════════════


def _js_to_iso_string(dt: Any) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, milissegundos, sufixo 'Z').

    As colunas de tempo são ``timestamptz`` (asyncpg devolve ``datetime`` aware em
    UTC). O Drizzle entrega ``Date`` e o ``NextResponse.json`` serializa via
    ``.toISOString()`` → SEMPRE UTC, precisão de MILISSEGUNDOS, sufixo ``Z``.
    """
    if dt is None:
        return None
    if not isinstance(dt, datetime):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _uuid_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    return str(value)


# ══════════════════════════════════════════════════════════════════════════════
# Validações de arquivo (réplica de src/lib/storage/upload.ts)
# ══════════════════════════════════════════════════════════════════════════════

_TIPOS_PERMITIDOS = (
    "application/pdf",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
)
_EXTENSOES_PERMITIDAS = (".pdf", ".xls", ".xlsx", ".doc", ".docx")


def _validar_tipo_arquivo(nome: str, content_type: str) -> tuple[bool, str | None]:
    """``validarTipoArquivo`` — MIME permitido OU extensão permitida.

    A extração da extensão replica ``"." + (file.name.split(".").pop()?.toLowerCase() ?? "")``
    do Next: ``.split(".")`` SEMPRE devolve ao menos um segmento e ``.pop()`` pega o
    ÚLTIMO — então um nome SEM ponto (ex.: ``"doc"``) produz ``ext == ".doc"`` (e não
    ``"."``). Por isso NÃO usamos o guard ``len(partes) > 1``: sempre tomamos o último
    segmento, igual ao ``.pop()`` do JS.
    """
    ext = "." + nome.rsplit(".", 1)[-1].lower()
    if content_type not in _TIPOS_PERMITIDOS and ext not in _EXTENSOES_PERMITIDAS:
        return False, "Tipo de arquivo não permitido. Use: PDF, XLS, XLSX, DOC ou DOCX."
    return True, None


def _validar_tamanho_arquivo(tamanho: int, max_mb: int = 50) -> tuple[bool, str | None]:
    """``validarTamanhoArquivo`` — limite em MB (default 50).

    A mensagem usa ``(file.size/1024/1024).toFixed(1)`` no Next: o ``toFixed`` do V8
    arredonda HALF-UP (afasta do zero no .x5), enquanto ``f"{atual:.1f}"`` do Python
    usa HALF-EVEN. Para casar byte-a-byte o dígito impresso, quantizamos o valor
    EXATO do double com ``ROUND_HALF_UP`` (mesma semântica do ``toFixed``).
    """
    max_bytes = max_mb * 1024 * 1024
    if tamanho > max_bytes:
        atual = tamanho / 1024 / 1024
        atual_str = str(Decimal(atual).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))
        return (
            False,
            f"Arquivo muito grande. Máximo: {max_mb} MB. "
            f"Tamanho atual: {atual_str} MB.",
        )
    return True, None


def _validar_magic_bytes(buf: bytes) -> tuple[bool, str | None]:
    """``validarMagicBytes`` — assinatura PDF (%PDF) / ZIP (PK..) / OLE2."""
    b = buf[:8]
    is_pdf = len(b) >= 4 and b[0] == 0x25 and b[1] == 0x50 and b[2] == 0x44 and b[3] == 0x46
    is_zip = len(b) >= 4 and b[0] == 0x50 and b[1] == 0x4B and b[2] == 0x03 and b[3] == 0x04
    is_ole2 = len(b) >= 4 and b[0] == 0xD0 and b[1] == 0xCF and b[2] == 0x11 and b[3] == 0xE0
    if is_pdf or is_zip or is_ole2:
        return True, None
    return (
        False,
        "O conteúdo do arquivo não corresponde ao tipo declarado. "
        "Apenas PDF, XLS, XLSX, DOC e DOCX são permitidos.",
    )


# ══════════════════════════════════════════════════════════════════════════════
# Storage S3/MinIO (réplica de uploadByKey / getR2ObjectUrl via boto3 síncrono)
# ══════════════════════════════════════════════════════════════════════════════


def _s3_object_url(key: str) -> str:
    """URL canônica path-style ``<endpoint>/<bucket>/<key>`` (getR2ObjectUrl)."""
    return f"{settings.s3_endpoint}/{settings.s3_bucket}/{key}"


def _put_object_sync(key: str, body: bytes, content_type: str) -> None:
    """``put_object`` SÍNCRONO (boto3) — chamado via ``run_in_threadpool``.

    Cliente boto3 conforme contrato do BFF (path-style obrigatório para MinIO).
    Import tardio do boto3 para não pesar o import do módulo.
    """
    import boto3  # import tardio: storage não está no caminho quente

    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),  # MinIO exige path-style
    )
    client.put_object(Bucket=settings.s3_bucket, Key=key, Body=body, ContentType=content_type)


async def _upload_by_key(key: str, body: bytes, content_type: str) -> dict:
    """Réplica de ``uploadByKey`` — PUT no S3/MinIO (path-style) via threadpool.

    A key JÁ vem montada pelo chamador (mesma estrutura do Next). Retorna
    ``{url, key, contentType, size}`` (mesmo ``UploadResult`` do Next).

    Coerção do content-type: o Next faz ``ct = contentType ?? ... ?? "application/octet-stream"``
    com ``??`` (nullish) — o chamador passa ``file.type``, então uma string VAZIA
    (``""``) NÃO cai no default (``??`` só dispara em ``null``/``undefined``). Logo
    replicamos com ``is not None`` (e NÃO com ``or``/truthiness, que trocaria ``""``
    pelo default): um upload com MIME vazio guarda/devolve ``content_type=""`` e grava
    ``ContentType=""`` no S3, byte-a-byte igual ao Next.
    """
    ct = content_type if content_type is not None else "application/octet-stream"
    await run_in_threadpool(_put_object_sync, key, body, ct)
    return {"url": _s3_object_url(key), "key": key, "contentType": ct, "size": len(body)}


def _sanitize_nome_anexo(nome: str) -> str:
    """Sanitiza o nome como o route.ts (IN-LINE, NÃO o ``sanitizeName`` de upload.ts).

    O POST do route.ts faz::

        file.name
          .normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")   // remove diacríticos
          .replace(/\\.\\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");

    Replicamos com NFD + descarte de marcas combinantes (categoria Unicode ``Mn``)
    + ``..`` → ``_`` + whitelist de caracteres.
    """
    n = unicodedata.normalize("NFD", nome)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    n = n.replace("..", "_")
    n = re.sub(r"[^a-zA-Z0-9._-]", "_", n)
    return n


# ══════════════════════════════════════════════════════════════════════════════
# GET — lista anexos do documento (== handler GET do route.ts + getAnexosByDocumento)
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/api/conformidade/cofre/documentos/{id}/anexos")
async def get_anexos_documento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """Lista os anexos extras de um documento (paridade 1:1 com o Next).

    Guard: ``require_visualizar`` (espelha ``requireVisualizar()`` → todos exceto
    EXTERNO; 401 sem sessão, 403 EXTERNO). Em seguida devolve ``{ data: lista }``
    com ``lista = getAnexosByDocumento(id)`` (LEFT JOIN users.nome →
    uploadadoPorNome, ORDER BY criadoEm DESC).

    OBS: o route.ts NÃO valida o ``id`` (apenas o repassa ao SELECT). Para um id
    não-uuid usamos CAST textual (``::text``) no WHERE para tolerar ids não-uuid
    sem estourar, devolvendo lista vazia (mesmo efeito prático do Next).
    """
    # Barreira do pai (0034/S8): documento restrito é invisível fora de
    # Conformidade — 404 com a MESMA string do 404 de documento inexistente.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    rows = (
        await db.execute(
            text(
                """
                SELECT
                  a.id                AS id,
                  a.documento_id      AS documento_id,
                  a.tipo              AS tipo,
                  a.titulo            AS titulo,
                  a.nome_arquivo      AS nome_arquivo,
                  a.blob_url          AS blob_url,
                  a.blob_key          AS blob_key,
                  a.tamanho_bytes     AS tamanho_bytes,
                  a.content_type      AS content_type,
                  a.uploadado_por     AS uploadado_por,
                  u.nome              AS uploadado_por_nome,
                  a.criado_em         AS criado_em
                FROM documentos_habilitacao_anexos a
                LEFT JOIN users u ON a.uploadado_por = u.id
                WHERE a.documento_id::text = :id
                ORDER BY a.criado_em DESC
                """
            ),
            {"id": id},
        )
    ).mappings().all()

    data = [
        {
            "id": _uuid_str(r["id"]),
            "documentoId": _uuid_str(r["documento_id"]),
            "tipo": r["tipo"],
            "titulo": r["titulo"],
            "nomeArquivo": r["nome_arquivo"],
            "blobUrl": r["blob_url"],
            "blobKey": r["blob_key"],
            "tamanhoBytes": r["tamanho_bytes"],
            "contentType": r["content_type"],
            "uploadadoPor": _uuid_str(r["uploadado_por"]),
            "uploadadoPorNome": r["uploadado_por_nome"],
            "criadoEm": _js_to_iso_string(r["criado_em"]),
        }
        for r in rows
    ]

    return JSONResponse(content={"data": data})


# ══════════════════════════════════════════════════════════════════════════════
# POST — upload multipart + criação do registro (== handler POST do route.ts)
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/conformidade/cofre/documentos/{id}/anexos")
async def post_anexo_documento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """Upload (multipart/form-data) de um anexo extra do documento (paridade 1:1).

    Ordem das checagens (igual ao Next):
      1. requireAuth() → 401 sem sessão (via get_current_user).
      2. podeGerenciarDocumentosHabilitacao(role) → 403 ``Permissão negada``.
      3. 404 ``Documento não encontrado`` se o documento não existe.
      4. parse multipart → 400 ``Esperado multipart/form-data`` se falhar.
      5. file obrigatório (instanceof File) → 422 ``Arquivo é obrigatório``.
      6. tipo/tamanho(50MB)/magic-bytes → 422 com a mensagem do validador.
      7. tipo (COMPLEMENTAR|RETIFICACAO|OUTRO senão ANEXO), titulo opcional.
      8. monta a key, faz upload S3 (put_object), INSERT em
         documentos_habilitacao_anexos, audit_log → 201 com o REGISTRO inserido cru.
    """
    # (2) Gate de papel — após auth, com a MENSAGEM e o status do Next.
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # (3) 404 — documento existe?
    #     SELECT id FROM documentos_habilitacao WHERE id = :id LIMIT 1.
    #     CAST textual no WHERE para tolerar id não-uuid (Next não valida o id).
    doc = (
        await db.execute(
            text(
                """
                SELECT id, restrito
                FROM documentos_habilitacao
                WHERE id::text = :id
                LIMIT 1
                """
            ),
            {"id": id},
        )
    ).mappings().first()
    if doc is None:
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    # (3b/0034 — S8) Barreira do pai restrito ANTES do parse do multipart:
    # nenhum blob sobe, nenhuma linha nasce em documentos_habilitacao_anexos —
    # ORCAMENTISTA/TECNICO passam no gate de papel, mas não podem sequer
    # inferir a existência de um contrato restrito pela diferença de resposta.
    if doc["restrito"] and not is_conformidade(user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    # (4) multipart/form-data.
    try:
        form = await request.form()
    except Exception:
        return JSONResponse(
            status_code=400, content={"error": "Esperado multipart/form-data"}
        )

    # (5) file obrigatório (instanceof File). Starlette: UploadFile p/ arquivos,
    #     str p/ campos de texto. Sem 'read'/'filename' → não é arquivo → 422.
    file = form.get("file")
    if file is None or not hasattr(file, "read") or not hasattr(file, "filename"):
        return JSONResponse(
            status_code=422, content={"error": "Arquivo é obrigatório"}
        )

    file_name = file.filename or ""
    content_type = file.content_type or ""
    file_bytes = await file.read()
    file_size = len(file_bytes)

    # (6a) tipo de arquivo.
    ok, erro = _validar_tipo_arquivo(file_name, content_type)
    if not ok:
        return JSONResponse(status_code=422, content={"error": erro})

    # (6b) tamanho (50 MB).
    ok, erro = _validar_tamanho_arquivo(file_size, 50)
    if not ok:
        return JSONResponse(status_code=422, content={"error": erro})

    # (6c) magic bytes (primeiros 8 do conteúdo).
    ok, erro = _validar_magic_bytes(file_bytes)
    if not ok:
        return JSONResponse(status_code=422, content={"error": erro})

    # (7) tipo: String(formData.get("tipo") ?? "ANEXO"); só COMPLEMENTAR /
    #     RETIFICACAO / OUTRO são aceitos, senão "ANEXO".
    tipo_raw_val = form.get("tipo")
    tipo_raw = tipo_raw_val if isinstance(tipo_raw_val, str) else "ANEXO"
    tipo = (
        tipo_raw
        if tipo_raw in ("COMPLEMENTAR", "RETIFICACAO", "OUTRO")
        else "ANEXO"
    )

    # titulo: String(formData.get("titulo") ?? "").trim() || null.
    titulo_val = form.get("titulo")
    titulo_str = (titulo_val if isinstance(titulo_val, str) else "").strip()
    titulo = titulo_str or None

    # ── Monta a key (MESMA estrutura do route.ts) ────────────────────────────
    #     `conformidade/documentos/${doc.id}/anexos/${Date.now()}_${nomeSan}`
    nome_san = _sanitize_nome_anexo(file_name)
    timestamp = int(datetime.now(tz=timezone.utc).timestamp() * 1000)  # Date.now()
    doc_id = str(doc["id"])
    key = f"conformidade/documentos/{doc_id}/anexos/{timestamp}_{nome_san}"

    # ── Upload S3/MinIO (uploadByKey(key, file, file.type)) ──────────────────
    upload = await _upload_by_key(key, file_bytes, content_type)

    # ── INSERT em documentos_habilitacao_anexos (réplica EXATA do .values().returning()) ─
    #     documentoId=doc.id, tipo, titulo, nomeArquivo=file.name,
    #     blobUrl=upload.url, blobKey=upload.key, tamanhoBytes=file.size,
    #     contentType=upload.contentType, uploadadoPor=session.user.id.
    insert_sql = text(
        """
        INSERT INTO documentos_habilitacao_anexos (
          documento_id, tipo, titulo, nome_arquivo, blob_url, blob_key,
          tamanho_bytes, content_type, uploadado_por
        ) VALUES (
          :documento_id, :tipo, :titulo, :nome_arquivo, :blob_url, :blob_key,
          :tamanho_bytes, :content_type, :uploadado_por
        )
        RETURNING
          id, documento_id, tipo, titulo, nome_arquivo, blob_url, blob_key,
          tamanho_bytes, content_type, uploadado_por, criado_em
        """
    )
    insert_params = {
        "documento_id": doc_id,
        "tipo": tipo,
        "titulo": titulo,
        "nome_arquivo": file_name,
        "blob_url": upload["url"],
        "blob_key": upload["key"],
        "tamanho_bytes": file_size,
        "content_type": upload["contentType"],
        "uploadado_por": user.id,
    }
    novo = (await db.execute(insert_sql, insert_params)).mappings().first()

    # ── Fronteira de transação: paridade com o Next ──────────────────────────
    #     O Next emite DOIS db.insert() INDEPENDENTES (sem wrapper de transação):
    #     o INSERT do anexo e o INSERT do audit_log auto-commitam SEPARADAMENTE.
    #     Logo uma falha no audit_log NÃO desfaz a linha do anexo (a linha fica
    #     persistida). Para reproduzir essa NÃO-atomicidade conhecida do Next,
    #     commitamos o anexo ANTES de emitir o INSERT do audit_log — assim, se o
    #     audit falhar, o anexo permanece gravado exatamente como no Next.
    await db.commit()

    # ── audit_log (MESMO payload de detalhes do Next) ────────────────────────
    #     acao "UPLOAD_ANEXO_DOCUMENTO", entidade "documento_habilitacao",
    #     entidadeId doc.id, detalhes { anexoId, tipo, nomeArquivo, titulo }.
    #     Réplica de db.insert(auditLog).values({...}) do route.ts via
    #     registrar_audit (best-effort; o commit fica por conta do handler).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="UPLOAD_ANEXO_DOCUMENTO",
        entidade="documento_habilitacao",
        entidade_id=doc_id,
        detalhes={
            "anexoId": _uuid_str(novo["id"]),
            "tipo": tipo,
            "nomeArquivo": novo["nome_arquivo"],
            "titulo": titulo,
        },
    )

    await db.commit()

    # ── 201 com o REGISTRO inserido CRU (NextResponse.json(novo, {status:201})) ─
    body = {
        "id": _uuid_str(novo["id"]),
        "documentoId": _uuid_str(novo["documento_id"]),
        "tipo": novo["tipo"],
        "titulo": novo["titulo"],
        "nomeArquivo": novo["nome_arquivo"],
        "blobUrl": novo["blob_url"],
        "blobKey": novo["blob_key"],
        "tamanhoBytes": novo["tamanho_bytes"],
        "contentType": novo["content_type"],
        "uploadadoPor": _uuid_str(novo["uploadado_por"]),
        "criadoEm": _js_to_iso_string(novo["criado_em"]),
    }
    return JSONResponse(status_code=201, content=body)
