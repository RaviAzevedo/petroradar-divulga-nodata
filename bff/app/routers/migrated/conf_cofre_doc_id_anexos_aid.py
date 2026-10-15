"""Rota MIGRADA (estrangulador / strangler-fig):
    /api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}

Espelho 1:1 de
``src/app/api/conformidade/cofre/documentos/[id]/anexos/[anexoId]/route.ts`` —
anexos extras de um documento do Cofre de Habilitação. O arquivo Next expõe
APENAS dois handlers:

  - ``PATCH``  → edita ``titulo`` / ``tipo`` do anexo.
  - ``DELETE`` → remove o anexo (e o blob no MinIO/S3, best-effort).

NÃO há GET (download) nem POST (upload) NESTE arquivo de rota do Next — o
download de anexo e o upload acontecem em OUTRAS rotas (o detalhe do documento e
a rota de upload do anexo). Por fidelidade ao estrangulador, replicamos somente
os dois métodos que o Next realmente serve aqui; um GET/POST neste path no Next
retorna 405 (Next não exporta o handler), e o FastAPI faz o mesmo (método não
registrado → 405).

──────────────────────────────────────────────────────────────────────────────
GUARDS (mapeamento Next → BFF)
──────────────────────────────────────────────────────────────────────────────
Ambos os métodos no Next fazem::

    requireAuth()                       # só 401 (qualquer papel autenticado)
    if (!podeGerenciarDocumentosHabilitacao(role)) -> 403

``podeGerenciarDocumentosHabilitacao(role)`` =
    isConformidade(role) || role == ORCAMENTISTA || role == TECNICO
    = role ∈ {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}.

NENHUM ``require_*`` do BFF cobre EXATAMENTE esse conjunto (``require_propor``
exclui SGI; ``require_conformidade`` exclui ORCAMENTISTA/TECNICO). Então usamos
``Depends(get_current_user)`` (→ 401 se sem sessão) e checamos o papel à mão para
reproduzir o 403 com a MESMA mensagem do Next: ``{"error":"Permissão negada"}``
(SEM ``code`` — o Next devolve um ``NextResponse.json`` cru aqui, não via
ApiError/guard).

ORDEM das checagens (preservada do Next):
  PATCH : guard(401) → 403(papel) → 404(anexo) → 400(JSON inválido)
          → 422(tipo inválido / nada a atualizar) → UPDATE → audit → resposta.
  DELETE: guard(401) → 403(papel) → 404(anexo) → delete blob (best-effort)
          → DELETE → audit → resposta.

──────────────────────────────────────────────────────────────────────────────
404 (existência) — espelha o SELECT do Next
──────────────────────────────────────────────────────────────────────────────
``SELECT * FROM documentos_habilitacao_anexos
   WHERE id = :anexoId AND documento_id = :id LIMIT 1`` → se vazio:
404 ``{"error":"Anexo não encontrado"}``.

NOTA SOBRE ids INVÁLIDOS: o Next NÃO valida ``id``/``anexoId`` como UUID (passa
direto pro ``eq(...)``). Comparamos com cast TEXTUAL (``id::text = :id``) para
que ids não-uuid simplesmente não casem → 404 (o resultado observável do Next),
em vez de um 500 por cast inválido no WHERE.

──────────────────────────────────────────────────────────────────────────────
PATCH — validação (réplica do handler, NÃO é zod)
──────────────────────────────────────────────────────────────────────────────
O Next monta ``updates`` campo-a-campo a partir do body cru (sem schema zod):
  - ``tipo`` (se presente): deve ∈ {ANEXO, COMPLEMENTAR, RETIFICACAO, OUTRO};
    senão → 422 ``{"error":"Tipo inválido"}``.
  - ``titulo`` (se presente): ``b.titulo ? String(b.titulo).slice(0,200) : null``
    (qualquer falsy → null; truthy → string truncada em 200 chars).
  - Se ``updates`` ficar vazio (nenhuma chave presente) → 422
    ``{"error":"Nada a atualizar"}``.
JSON malformado (body não-JSON) → 400 ``{"error":"JSON inválido"}``.

audit_log (PATCH) — ``EDITAR_ANEXO_DOCUMENTO``::
    detalhes = { anexoId,
                 antes:  { tipo, titulo },     # valores ANTES
                 depois: { tipo, titulo } }    # valores DEPOIS (do UPDATE RETURNING)
entidade="documento_habilitacao", entidade_id=id.

──────────────────────────────────────────────────────────────────────────────
DELETE — storage + audit
──────────────────────────────────────────────────────────────────────────────
``try { deleteDocumento(a.blobKey) } catch {}`` → apaga o objeto no MinIO/S3
(best-effort: erro engolido). Depois ``DELETE FROM ... WHERE id = anexoId``.
audit_log — ``REMOVER_ANEXO_DOCUMENTO``::
    detalhes = { anexoId, nomeArquivo }
Resposta: ``{ ok: true }``.

──────────────────────────────────────────────────────────────────────────────
SERIALIZAÇÃO (paridade de WIRE com ``NextResponse.json`` + Drizzle)
──────────────────────────────────────────────────────────────────────────────
- O PATCH responde ``NextResponse.json(atualizado)`` = a LINHA INTEIRA do
  ``.returning()`` (todas as colunas de ``documentos_habilitacao_anexos`` no shape
  camelCase do Drizzle). Serializado por :func:`_anexo_to_json`.
- uuid → ``str()``; timestamptz → ``new Date(...).toISOString()`` (UTC, ms, 'Z').

──────────────────────────────────────────────────────────────────────────────
STORAGE (MinIO/S3 via boto3)
──────────────────────────────────────────────────────────────────────────────
Cliente boto3 ``s3`` com ``endpoint_url=settings.s3_endpoint``,
``aws_access_key_id=settings.s3_access_key``,
``aws_secret_access_key=settings.s3_secret_key``, ``region_name='us-east-1'`` e
``config=Config(s3={'addressing_style':'path'})`` (MinIO EXIGE path-style),
``bucket=settings.s3_bucket``. Import TARDIO (dentro da função) para manter o
boto3 fora do caminho quente das rotas que não tocam storage.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, get_current_user
from app.db.session import get_db
from app.routers.migrated._restrito import is_conformidade
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissão (espelha podeGerenciarDocumentosHabilitacao de permissions.ts)
# ══════════════════════════════════════════════════════════════════════════════
# isConformidade(role) || role == ORCAMENTISTA || role == TECNICO
#   isConformidade = role ∈ {ADMIN, LIDER, SGI}
# ⇒ conjunto efetivo: {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}
def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    return role in ("ADMIN", "LIDER", "SGI", "ORCAMENTISTA", "TECNICO")


# Tipos válidos do anexo (espelha TIPOS_VALIDOS / TipoAnexoDocumento do route.ts).
_TIPOS_VALIDOS = ("ANEXO", "COMPLEMENTAR", "RETIFICACAO", "OUTRO")


# ══════════════════════════════════════════════════════════════════════════════
# Serialização (paridade com Drizzle / NextResponse.json)
# ══════════════════════════════════════════════════════════════════════════════
def _js_to_iso_string(dt: Any) -> str | None:
    """Replica ``new Date(dt).toISOString()`` do JS (UTC, ms, sufixo 'Z')."""
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


def _anexo_to_json(r: Any) -> dict[str, Any]:
    """Serializa uma linha de ``documentos_habilitacao_anexos`` no shape camelCase
    do Drizzle (``db.select()``/``.returning()`` = TODAS as colunas)."""
    return {
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
        "criadoEm": _js_to_iso_string(r["criado_em"]),
    }


# ── SELECT do anexo (espelha o select com and(eq id, eq documentoId) LIMIT 1). ──
# Cast textual no WHERE para tolerar ids não-uuid (Next não valida) → 404.
_SELECT_ANEXO = text(
    "SELECT * FROM documentos_habilitacao_anexos "
    "WHERE id::text = :anexo_id AND documento_id::text = :id LIMIT 1"
)


async def _get_anexo(db, id: str, anexo_id: str):
    """SELECT * ... WHERE id = anexoId AND documento_id = id LIMIT 1 → mapping/None."""
    res = await db.execute(_SELECT_ANEXO, {"id": id, "anexo_id": anexo_id})
    return res.mappings().first()


# ── Barreira do documento PAI restrito (0034/S9 — 02-APIS §16-B.1) ────────────
async def _pai_restrito_invisivel(db, id: str, role: str) -> bool:
    """True quando o pai existe, é ``restrito`` e o papel está fora de
    Conformidade — o handler responde o MESMO 404 de documento inexistente
    ANTES de qualquer efeito (nem o 404 de "anexo não encontrado" pode
    confirmar a existência do pai). Pai inexistente → False (gates atuais)."""
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
# Storage (MinIO/S3) — delete best-effort do blob (espelha deleteDocumento)
# ══════════════════════════════════════════════════════════════════════════════
def _delete_blob_best_effort(key_or_url: str) -> None:
    """Apaga o objeto no MinIO/S3. Best-effort: NUNCA propaga erro.

    Espelha ``deleteDocumento(a.blobKey)`` (lib/storage/upload.ts) chamado dentro
    de ``try {} catch {}`` no DELETE do Next — falha de storage é engolida (o
    registro de banco/auditoria é prioritário). Aceita key OU URL S3 (extrai a key
    da URL, igual ao regex do Next).

    boto3 com path-style (MinIO exige): import tardio para não pesar nas rotas que
    não tocam storage.
    """
    import re

    from app.core.config import settings

    try:
        if not key_or_url:
            return
        key = key_or_url
        # Tolera URL completa S3 (mesmo regex do Next: .../<bucket>/<key>).
        m = re.search(r"r2\.cloudflarestorage\.com/[^/]+/(.+)$", key_or_url)
        if m:
            key = m.group(1)

        import boto3  # import tardio: storage não está no caminho quente
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint or None,
            aws_access_key_id=settings.s3_access_key or None,
            aws_secret_access_key=settings.s3_secret_key or None,
            region_name="us-east-1",
            config=Config(s3={"addressing_style": "path"}),  # MinIO exige path-style
        )
        client.delete_object(Bucket=settings.s3_bucket, Key=key)
    except Exception:  # noqa: BLE001 — best-effort (igual ao catch vazio do Next)
        pass


# ══════════════════════════════════════════════════════════════════════════════
# PATCH /api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}
#   — edita título/tipo do anexo
# ══════════════════════════════════════════════════════════════════════════════
@router.patch("/api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}")
async def patch_anexo(
    id: str,
    anexo_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),  # requireAuth → só 401
    db=Depends(get_db),
) -> JSONResponse:
    # ── 403: papel (podeGerenciarDocumentosHabilitacao) ───────────────────────
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(content={"error": "Permissão negada"}, status_code=403)

    # ── Barreira do pai restrito (0034/S9) — ANTES do 404 de anexo. ───────────
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── 404: anexo existe? (and(eq id, eq documentoId)) ───────────────────────
    a = await _get_anexo(db, id, anexo_id)
    if a is None:
        return JSONResponse(content={"error": "Anexo não encontrado"}, status_code=404)

    # ── 400: JSON inválido (body não-parseável). ──────────────────────────────
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — qualquer falha de parse = 400 (igual Next)
        return JSONResponse(content={"error": "JSON inválido"}, status_code=400)

    # O Next trata body como ``{ tipo?: string; titulo?: string | null }`` via
    # ``const b = body as {...}`` e em seguida lê ``b.tipo``. Detalhe de borda
    # (bug-a-bug): se o body JSON for o literal ``null``, ``request.json()`` do
    # Next retorna ``null`` COM SUCESSO (o try/catch só cobre o parse) e então
    # ``b.tipo`` faz acesso de propriedade em ``null`` → ``TypeError`` NÃO
    # capturado (não há try/catch no restante do handler) → Next responde 500.
    # Para os demais não-objetos (string/number/bool/array) o acesso a ``.tipo``
    # devolve ``undefined`` no JS (sem lançar) → nenhuma chave aplicada → 422.
    # Replicamos: ``body is None`` → levanta (middleware global gera 500 "Erro
    # interno", espelhando o TypeError não capturado do Next); demais não-dict →
    # tratados como sem chaves presentes (→ 422 "Nada a atualizar").
    if body is None:
        # Espelha ``(null).tipo`` do Next: TypeError não capturado → 500.
        raise TypeError(
            "Cannot read properties of null (reading 'tipo')"
        )
    is_obj = isinstance(body, dict)

    # ── Monta updates campo-a-campo (réplica EXATA do handler). ───────────────
    set_cols: list[str] = []
    params: dict[str, Any] = {"id": id, "anexo_id": anexo_id}

    if is_obj and "tipo" in body:
        tipo = body["tipo"]
        # 422 se tipo não estiver na whitelist (inclui não-string → não casa).
        if not isinstance(tipo, str) or tipo not in _TIPOS_VALIDOS:
            return JSONResponse(content={"error": "Tipo inválido"}, status_code=422)
        set_cols.append("tipo = :tipo")
        params["tipo"] = tipo

    if is_obj and "titulo" in body:
        # b.titulo ? String(b.titulo).slice(0,200) : null
        raw = body["titulo"]
        # Truthiness ESTILO JS (não Python): só são falsy null/false/0/""/NaN.
        # Em particular [] e {} são TRUTHY no JS (≠ Python, onde são falsy) →
        # String([])="" e String({})="[object Object]".
        if _js_truthy(raw):
            # String(...) do JS: stringify do valor (números/booleans viram texto).
            titulo = _js_string(raw)[:200]
        else:
            titulo = None
        set_cols.append("titulo = :titulo")
        params["titulo"] = titulo

    # ── 422: nada a atualizar (updates vazio). ────────────────────────────────
    if not set_cols:
        return JSONResponse(content={"error": "Nada a atualizar"}, status_code=422)

    # ── UPDATE ... WHERE id = anexoId RETURNING * (espelha .returning()). ──────
    update_sql = text(
        f"UPDATE documentos_habilitacao_anexos SET {', '.join(set_cols)} "
        "WHERE id::text = :anexo_id RETURNING *"
    )
    res = await db.execute(update_sql, params)
    atualizado = res.mappings().first()

    # ── audit_log: EDITAR_ANEXO_DOCUMENTO ─────────────────────────────────────
    # Espelha db.insert(auditLog).values({...}) do Next: mesma sessão/transação
    # (commit do handler, abaixo), mesmas strings e chaves de detalhes.
    await registrar_audit(
        db,
        user_id=user.id,
        acao="EDITAR_ANEXO_DOCUMENTO",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={
            "anexoId": anexo_id,
            "antes": {"tipo": a["tipo"], "titulo": a["titulo"]},
            "depois": {
                "tipo": atualizado["tipo"] if atualizado is not None else None,
                "titulo": atualizado["titulo"] if atualizado is not None else None,
            },
        },
    )

    await db.commit()

    # ── Resposta: NextResponse.json(atualizado) — a linha completa do anexo. ──
    return JSONResponse(content=_anexo_to_json(atualizado))


# ══════════════════════════════════════════════════════════════════════════════
# DELETE /api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}
#   — remove anexo (e blob no MinIO, best-effort)
# ══════════════════════════════════════════════════════════════════════════════
@router.delete("/api/conformidade/cofre/documentos/{id}/anexos/{anexo_id}")
async def delete_anexo(
    id: str,
    anexo_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),  # requireAuth → só 401
    db=Depends(get_db),
) -> JSONResponse:
    # ── 403: papel (podeGerenciarDocumentosHabilitacao) ───────────────────────
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(content={"error": "Permissão negada"}, status_code=403)

    # ── Barreira do pai restrito (0034/S9) — ANTES do DELETE e do 404 de
    # anexo: nada é alterado/apagado, nem no banco nem no MinIO. ───────────────
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            content={"error": "Documento não encontrado"}, status_code=404
        )

    # ── 404: anexo existe? (and(eq id, eq documentoId)) ───────────────────────
    a = await _get_anexo(db, id, anexo_id)
    if a is None:
        return JSONResponse(content={"error": "Anexo não encontrado"}, status_code=404)

    # ── Apaga o blob no MinIO/S3 (best-effort) — usa blobKey, não blobUrl. ────
    _delete_blob_best_effort(a["blob_key"])

    # ── DELETE FROM documentos_habilitacao_anexos WHERE id = anexoId. ─────────
    await db.execute(
        text("DELETE FROM documentos_habilitacao_anexos WHERE id::text = :anexo_id"),
        {"anexo_id": anexo_id},
    )

    # ── audit_log: REMOVER_ANEXO_DOCUMENTO ────────────────────────────────────
    # Espelha db.insert(auditLog).values({...}) do Next: mesma sessão/transação
    # (commit do handler, abaixo), mesmas strings e chaves de detalhes.
    await registrar_audit(
        db,
        user_id=user.id,
        acao="REMOVER_ANEXO_DOCUMENTO",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={"anexoId": anexo_id, "nomeArquivo": a["nome_arquivo"]},
    )

    await db.commit()

    # ── Resposta: NextResponse.json({ ok: true }). ────────────────────────────
    return JSONResponse(content={"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════
def _js_truthy(value: Any) -> bool:
    """Replica a truthiness do JS para valores vindos de um JSON body.

    No Next, ``b.titulo ? ... : null`` usa truthiness JS, NÃO Python. Valores
    JSON possíveis e seu resultado no JS:
      - ``None``  (null)      → falsy
      - ``False`` / ``True``  → falsy / truthy
      - ``0`` / ``0.0`` / outros números → 0 é falsy; demais truthy
        (NaN não ocorre em JSON padrão)
      - ``""``    (string vazia) → falsy; string não-vazia → truthy
      - ``[]`` / ``[...]``    → SEMPRE truthy (≠ Python, onde [] é falsy)
      - ``{}`` / ``{...}``    → SEMPRE truthy (≠ Python, onde {} é falsy)
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value != ""
    # list / dict (arrays e objetos JS) são sempre truthy no JS.
    return True


def _js_string(value: Any) -> str:
    """Replica ``String(value)`` do JS para os tipos que chegam num JSON body.

    O Next faz ``String(b.titulo)`` quando ``b.titulo`` é truthy. Para um body
    JSON, ``b.titulo`` truthy é tipicamente uma string não-vazia; mas também pode
    ser number/true/objeto/array. Replicamos a stringificação do JS:
      - bool  → "true"/"false"
      - int/float → repr numérico estilo JS (sem ".0" para inteiros)
      - list  → ``Array.prototype.toString``: junta com "," e null/undefined → ""
        (ex.: ``[1,2]``→"1,2", ``[]``→"", ``[null,3]``→",3")
      - dict  → ``Object.prototype.toString`` → "[object Object]"
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        # 1.0 → "1" (estilo JS). Caso contrário, repr normal.
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        # Array.prototype.toString = join(","); null/undefined viram "".
        return ",".join("" if el is None else _js_string(el) for el in value)
    if isinstance(value, dict):
        # Object.prototype.toString.
        return "[object Object]"
    return str(value)
