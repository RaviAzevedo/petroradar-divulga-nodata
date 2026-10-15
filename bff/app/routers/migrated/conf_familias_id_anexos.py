"""Rota MIGRADA (estrangulador): /api/conformidade/familias/{id}/anexos.

Espelha 1:1 ``src/app/api/conformidade/familias/[id]/anexos/route.ts`` do app
Next.js. O Next exporta DOIS handlers neste arquivo — replicamos AMBOS, na mesma
ordem de checagens, com os MESMOS status e shapes:

  GET   → lista os anexos da família (``getAnexosByFamilia``). É um proxy de
          METADADOS (JSON), NÃO um download binário — este route.ts não serve o
          objeto do MinIO (o download do binário fica em outra rota de anexo). Por
          isso o GET aqui NÃO toca o S3: só projeta as MESMAS colunas camelCase do
          ``.select({...})`` do Drizzle (com LEFT JOIN users.nome → uploadadoPorNome).

  POST  → upload multipart/form-data: valida o arquivo (tipo/tamanho 50MB/magic
          bytes), faz ``put_object`` no MinIO com a MESMA key/estrutura
          (``conformidade/familias/<codigoNormalizado>/<ts_ms>_<nome>``), grava a
          linha em ``familias_anexos``, registra o ``audit_log`` e devolve o
          REGISTRO inserido cru (NextResponse.json(novo, {status:201})).

NÃO há DELETE/PATCH/PUT neste arquivo (o Next não os exporta nesta rota), então
não os implementamos — manter paridade significa NÃO criar handlers que o Next
não tem.

──────────────────────────────────────────────────────────────────────────────
GUARDS (paridade EXATA com o Next):

  GET   → ``requireVisualizar()`` == BFF ``require_visualizar`` (ADMIN, LIDER,
          ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR). 401 sem sessão, 403 EXTERNO.

  POST  → ``requireAuth()`` (apenas sessão; 401 sem sessão, via get_current_user)
          e SÓ DEPOIS ``podeGerenciarFamilias(role)`` == ``isConformidade(role)``
          (ADMIN/LIDER/SGI == ``ROLES_CONFORMIDADE``). Falha de papel → 403
          ``{"error":"Permissão negada"}``. NÃO usamos o guard semântico
          ``require_conformidade`` (que devolveria 401 OU 403 misturando a ordem):
          fazemos a checagem manual após ``get_current_user`` para manter a ordem
          401-antes-de-403 e a mensagem exata do Next.

SHAPE de erro: o Next usa ``{ "error": <string> }`` com status 400/403/404/422.
Replicamos literalmente.

SHAPE de sucesso:
  GET  200  {"data":[...]}  (== { data: lista } do route.ts)
  POST 201  o REGISTRO inserido cru (NextResponse.json(novo)) — NÃO embrulhado em
            {"data": ...}. camelCase idêntico ao $inferSelect do Drizzle
            (familias_anexos.returning()).

STORAGE: upload no S3/MinIO via ``aioboto3`` (settings.s3_*). Réplica do
``uploadByKey`` de ``src/lib/storage`` (path-style, MESMA key
``conformidade/familias/<codigoNormalizado>/<ts_ms>_<nome>``, MESMA URL canônica
path-style ``<endpoint>/<bucket>/<key>``). Cliente boto3 conforme contrato do BFF:
``endpoint_url=settings.s3_endpoint``, credenciais ``settings.s3_access_key`` /
``settings.s3_secret_key``, ``region_name='us-east-1'`` e
``config=Config(s3={'addressing_style':'path'})`` (MinIO EXIGE path-style).
``bucket=settings.s3_bucket``. Import lazy de aioboto3 para não onerar o import do
módulo quando a dependência não está instalada.

SERIALIZAÇÃO: timestamptz → ``_js_to_iso_string`` (UTC, ms, sufixo 'Z', batendo
wire-a-wire com o ``Date.toISOString()`` do ``NextResponse.json``); uuid → ``str()``.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import (
    CurrentUser,
    get_current_user,
    require_visualizar,
    ROLES_CONFORMIDADE,
)
from app.db.session import get_db
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissões (réplica fiel de src/lib/permissions.ts)
# ══════════════════════════════════════════════════════════════════════════════


def _pode_gerenciar_familias(role: str) -> bool:
    """``podeGerenciarFamilias(role)`` == ``isConformidade(role)``.

    ADMIN, LIDER, SGI (== ``ROLES_CONFORMIDADE``).
    """
    return role in ROLES_CONFORMIDADE


# ══════════════════════════════════════════════════════════════════════════════
# Serialização de datetimes (paridade com NextResponse.json -> Date.toISOString)
# ══════════════════════════════════════════════════════════════════════════════


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, milissegundos, sufixo 'Z').

    As colunas de tempo de ``familias_anexos`` são ``timestamptz`` (asyncpg devolve
    ``datetime`` aware em UTC). O Drizzle entrega ``Date`` e o ``NextResponse.json``
    serializa via ``.toISOString()`` → SEMPRE UTC, precisão de MILISSEGUNDOS,
    sufixo ``Z``. O ``isoformat()`` puro divergiria (``+00:00`` e microssegundos),
    então formatamos à mão (mesma convenção dos irmãos migrados).
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _parse_iso_dt(value: str | None) -> datetime | None:
    """Réplica de ``new Date(isoString)`` para o campo ``validadeFim`` do POST.

    O Next faz ``validadeRaw ? new Date(validadeRaw) : null``. Aqui convertemos a
    string para ``datetime`` aware (UTC) para o INSERT (timestamptz). Diferente do
    Zod, este campo NÃO é validado no route.ts — qualquer string vira um ``Date``
    (que pode ser "Invalid Date"). Para paridade prática, aceitamos ISO 8601 e, se
    não parsear, gravamos NULL (o caminho normal do front envia ISO ou vazio).
    """
    if not value:
        return None
    s = value
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


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

    Réplica EXATA do JS ``"." + (file.name.split(".").pop()?.toLowerCase() ?? "")``:
    ``str.split(".")`` em JS/Python NUNCA retorna lista vazia — o último elemento
    sempre existe. Para um nome SEM ponto (ex.: ``"pdf"``) o split devolve
    ``["pdf"]`` e ``pop()``/``partes[-1]`` == ``"pdf"`` → ``ext == ".pdf"`` (casa a
    whitelist). NÃO usar guard ``len(partes) > 1``: ele divergiria do Next ao
    devolver ``"."`` para nomes sem ponto, rejeitando (422) arquivos que o Next
    aceita.
    """
    partes = nome.split(".")
    ext = "." + partes[-1].lower()
    if content_type not in _TIPOS_PERMITIDOS and ext not in _EXTENSOES_PERMITIDAS:
        return False, "Tipo de arquivo não permitido. Use: PDF, XLS, XLSX, DOC ou DOCX."
    return True, None


def _validar_tamanho_arquivo(tamanho: int, max_mb: int = 50) -> tuple[bool, str | None]:
    """``validarTamanhoArquivo`` — limite em MB (default 50)."""
    max_bytes = max_mb * 1024 * 1024
    if tamanho > max_bytes:
        atual = tamanho / 1024 / 1024
        return (
            False,
            f"Arquivo muito grande. Máximo: {max_mb} MB. "
            f"Tamanho atual: {atual:.1f} MB.",
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
# Storage S3/MinIO (réplica de uploadByKey / getR2ObjectUrl via aioboto3)
# ══════════════════════════════════════════════════════════════════════════════


def _s3_object_url(key: str) -> str:
    """URL canônica path-style ``<endpoint>/<bucket>/<key>`` (getR2ObjectUrl)."""
    return f"{settings.s3_endpoint}/{settings.s3_bucket}/{key}"


async def _upload_by_key(key: str, body: bytes, content_type: str | None) -> dict:
    """Réplica de ``uploadByKey`` — PUT no S3/MinIO (path-style).

    A key JÁ vem montada pelo chamador (mesma estrutura do Next). Retorna
    ``{url, key, contentType, size}`` (mesmo ``UploadResult`` do Next).

    SEMÂNTICA DO ``??`` (NÃO ``or``): no Next ``ct = contentType ?? file.type ??
    "application/octet-stream"``. O ``??`` só ativa o fallback para ``null``/
    ``undefined`` — uma string vazia ``""`` (``file.type`` de um File sem MIME) é
    PRESERVADA como ``""``. Por isso tratamos APENAS ``None`` como ausente; ``""``
    sobrevive como ``""`` (na coluna ``content_type`` gravada e no campo
    ``contentType`` da resposta 201), igualando o comportamento do Next. Usar
    ``or`` aqui coagiria ``""`` → ``"application/octet-stream"`` (divergente).

    Cliente boto3 conforme contrato do BFF (path-style obrigatório para MinIO).
    """
    import aioboto3
    from botocore.config import Config

    ct = content_type if content_type is not None else "application/octet-stream"

    session = aioboto3.Session()
    async with session.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    ) as s3:
        await s3.put_object(
            Bucket=settings.s3_bucket, Key=key, Body=body, ContentType=ct
        )

    return {"url": _s3_object_url(key), "key": key, "contentType": ct, "size": len(body)}


def _sanitize_nome_anexo(nome: str) -> str:
    """Sanitiza o nome como o route.ts (NÃO é o ``sanitizeName`` de upload.ts).

    O POST do route.ts faz IN-LINE::

        file.name
          .normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")   // remove diacríticos
          .replace(/\\.\\./g, "_")
          .replace(/[^a-zA-Z0-9._-]/g, "_");

    (As classes de diacríticos no arquivo TS aparecem como bytes combinantes; o
    efeito é remover marcas combinantes — categoria Unicode ``Mn``.) Replicamos com
    NFD + descarte de ``Mn`` + ``..`` → ``_`` + whitelist de caracteres.
    """
    n = unicodedata.normalize("NFD", nome)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    n = n.replace("..", "_")
    n = re.sub(r"[^a-zA-Z0-9._-]", "_", n)
    return n


# ══════════════════════════════════════════════════════════════════════════════
# GET — lista anexos da família (== handler GET do route.ts + getAnexosByFamilia)
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/api/conformidade/familias/{id}/anexos")
async def get_anexos_familia(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
):
    """Lista os anexos de uma família (paridade 1:1 com o Next).

    Guard: ``require_visualizar`` (espelha ``requireVisualizar()`` → todos exceto
    EXTERNO; 401 sem sessão, 403 EXTERNO). Em seguida devolve ``{ data: lista }``
    com ``lista = getAnexosByFamilia(id)``.

    OBS: o route.ts NÃO valida o ``id`` (apenas o repassa ao SELECT). Para um id
    não-uuid o Drizzle compara ``uuid = text`` — usamos CAST textual (``::text``)
    no WHERE para tolerar ids não-uuid sem estourar, devolvendo lista vazia (mesmo
    efeito prático do Next, cujo SELECT simplesmente não casa nenhuma linha).
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT
                  a.id                AS id,
                  a.familia_id        AS familia_id,
                  a.tipo              AS tipo,
                  a.nome_arquivo      AS nome_arquivo,
                  a.blob_url          AS blob_url,
                  a.blob_key          AS blob_key,
                  a.tamanho_bytes     AS tamanho_bytes,
                  a.content_type      AS content_type,
                  a.validade_fim      AS validade_fim,
                  a.uploadado_por     AS uploadado_por,
                  u.nome              AS uploadado_por_nome,
                  a.criado_em         AS criado_em
                FROM familias_anexos a
                LEFT JOIN users u ON a.uploadado_por = u.id
                WHERE a.familia_id::text = :id
                ORDER BY a.criado_em DESC
                """
            ),
            {"id": id},
        )
    ).mappings().all()

    data = [
        {
            "id": str(r["id"]),
            "familiaId": str(r["familia_id"]),
            "tipo": r["tipo"],
            "nomeArquivo": r["nome_arquivo"],
            "blobUrl": r["blob_url"],
            "blobKey": r["blob_key"],
            "tamanhoBytes": r["tamanho_bytes"],
            "contentType": r["content_type"],
            "validadeFim": _js_to_iso_string(r["validade_fim"]),
            "uploadadoPor": str(r["uploadado_por"]) if r["uploadado_por"] is not None else None,
            "uploadadoPorNome": r["uploadado_por_nome"],
            "criadoEm": _js_to_iso_string(r["criado_em"]),
        }
        for r in rows
    ]

    return JSONResponse(content={"data": data})


# ══════════════════════════════════════════════════════════════════════════════
# POST — upload multipart + criação do registro (== handler POST do route.ts)
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/conformidade/familias/{id}/anexos")
async def post_anexo_familia(
    id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
):
    """Upload (multipart/form-data) de um anexo da família (paridade 1:1).

    Ordem das checagens (igual ao Next):
      1. requireAuth() → 401 sem sessão (via get_current_user).
      2. podeGerenciarFamilias(role) → 403 ``Permissão negada``.
      3. 404 ``Família não encontrada`` se a família não existe / está deletada.
      4. parse multipart → 400 ``Esperado multipart/form-data`` se falhar.
      5. file obrigatório (instanceof File) → 422 ``Arquivo é obrigatório``.
      6. tipo/tamanho(50MB)/magic-bytes → 422 com a mensagem do validador.
      7. tipo (CERTIFICADO_CRC|ATA_AUDITORIA senão OUTRO), validadeFim opcional.
      8. monta a key, faz upload S3 (put_object), INSERT em familias_anexos,
         audit_log → 201 com o REGISTRO inserido cru.
    """
    # (2) Gate de papel — após auth, com a MENSAGEM e o status do Next.
    if not _pode_gerenciar_familias(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # (3) 404 — família existe e não está soft-deletada?
    #     SELECT id, codigo_normalizado FROM familias WHERE id = :id AND deletado_em IS NULL.
    #     CAST textual no WHERE para tolerar id não-uuid (Next não valida o id) → 404.
    fam = (
        await db.execute(
            text(
                """
                SELECT id, codigo_normalizado
                FROM familias
                WHERE id::text = :id AND deletado_em IS NULL
                LIMIT 1
                """
            ),
            {"id": id},
        )
    ).mappings().first()
    if fam is None:
        return JSONResponse(
            status_code=404, content={"error": "Família não encontrada"}
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
    # No Next, ``file.type`` é SEMPRE uma string: ``""`` quando o File não tem MIME
    # (NUNCA null/undefined). Em Starlette, content-type ausente vem como ``None``.
    # Mapeamos ``None`` → ``""`` para espelhar o ``File.type`` do browser. Assim o
    # ``??`` replicado em ``_upload_by_key`` (que só faz fallback em ``None``)
    # PRESERVA ``""`` como ``""`` (coluna ``content_type`` e campo ``contentType``
    # da resposta 201 batendo wire-a-wire com o Next: ``file.type == "" → ""``).
    content_type = file.content_type if file.content_type is not None else ""
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

    # (7) tipo: String(formData.get("tipo") ?? "OUTRO"); só CERTIFICADO_CRC /
    #     ATA_AUDITORIA são aceitos, senão "OUTRO".
    tipo_raw_val = form.get("tipo")
    tipo_raw = tipo_raw_val if isinstance(tipo_raw_val, str) else "OUTRO"
    tipo = tipo_raw if tipo_raw in ("CERTIFICADO_CRC", "ATA_AUDITORIA") else "OUTRO"

    # validadeFim: String(formData.get("validadeFim") ?? "").trim();
    #              validadeRaw ? new Date(validadeRaw) : null.
    validade_val = form.get("validadeFim")
    validade_raw = (validade_val if isinstance(validade_val, str) else "").strip()
    validade_fim = _parse_iso_dt(validade_raw) if validade_raw else None

    # ── Monta a key (MESMA estrutura do route.ts) ────────────────────────────
    #     `conformidade/familias/${fam.codigoNormalizado}/${Date.now()}_${nomeSan}`
    nome_san = _sanitize_nome_anexo(file_name)
    timestamp = int(datetime.now(tz=timezone.utc).timestamp() * 1000)  # Date.now()
    codigo_normalizado = fam["codigo_normalizado"]
    key = f"conformidade/familias/{codigo_normalizado}/{timestamp}_{nome_san}"

    # ── Upload S3/MinIO (uploadByKey(key, file, file.type)) ──────────────────
    upload = await _upload_by_key(key, file_bytes, content_type)

    # ── INSERT em familias_anexos (réplica EXATA do .values({...}).returning()) ─
    #     blobUrl=upload.url, blobKey=upload.key, contentType=upload.contentType,
    #     tamanhoBytes=file.size, nomeArquivo=file.name, uploadadoPor=session.user.id.
    insert_sql = text(
        """
        INSERT INTO familias_anexos (
          familia_id, tipo, nome_arquivo, blob_url, blob_key,
          tamanho_bytes, content_type, validade_fim, uploadado_por
        ) VALUES (
          :familia_id, :tipo, :nome_arquivo, :blob_url, :blob_key,
          :tamanho_bytes, :content_type, :validade_fim, :uploadado_por
        )
        RETURNING
          id, familia_id, tipo, nome_arquivo, blob_url, blob_key,
          tamanho_bytes, content_type, validade_fim, uploadado_por, criado_em
        """
    )
    insert_params = {
        "familia_id": str(fam["id"]),
        "tipo": tipo,
        "nome_arquivo": file_name,
        "blob_url": upload["url"],
        "blob_key": upload["key"],
        "tamanho_bytes": file_size,
        "content_type": upload["contentType"],
        "validade_fim": validade_fim,
        "uploadado_por": user.id,
    }
    novo = (await db.execute(insert_sql, insert_params)).mappings().first()

    # ── audit_log (MESMO payload de detalhes do Next) ────────────────────────
    #     db.insert(auditLog).values({ userId, acao:"UPLOAD_ANEXO_FAMILIA",
    #     entidade:"familia", entidadeId: fam.id,
    #     detalhes:{ anexoId: novo.id, tipo, nomeArquivo: novo.nomeArquivo } }).
    #     Via registrar_audit (best-effort, MESMA sessão 'db'; commit é do handler).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="UPLOAD_ANEXO_FAMILIA",
        entidade="familia",
        entidade_id=str(fam["id"]),
        detalhes={
            "anexoId": str(novo["id"]),
            "tipo": tipo,
            "nomeArquivo": novo["nome_arquivo"],
        },
    )

    await db.commit()

    # ── 201 com o REGISTRO inserido cru (NextResponse.json(novo, {status:201})) ─
    body = {
        "id": str(novo["id"]),
        "familiaId": str(novo["familia_id"]),
        "tipo": novo["tipo"],
        "nomeArquivo": novo["nome_arquivo"],
        "blobUrl": novo["blob_url"],
        "blobKey": novo["blob_key"],
        "tamanhoBytes": novo["tamanho_bytes"],
        "contentType": novo["content_type"],
        "validadeFim": _js_to_iso_string(novo["validade_fim"]),
        "uploadadoPor": str(novo["uploadado_por"]) if novo["uploadado_por"] is not None else None,
        "criadoEm": _js_to_iso_string(novo["criado_em"]),
    }
    return JSONResponse(status_code=201, content=body)
