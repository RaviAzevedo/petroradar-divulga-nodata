"""Rota MIGRADA (estrangulador / strangler-fig):
    /api/conformidade/familias/{id}/anexos/{anexo_id}

Espelho 1:1 de
``src/app/api/conformidade/familias/[id]/anexos/[anexoId]/route.ts`` — anexos de
uma FAMÍLIA CRC (CRC, atas, etc.). O arquivo Next expõe DOIS handlers:

  - ``DELETE`` → remove o anexo (e o blob no MinIO/S3, best-effort).
  - ``GET``    → ``unsupported`` → 405 ``{"error":"Use /download"}`` (o download
                de verdade vive em ``.../[anexoId]/download``; aqui o GET é só um
                405 explícito, SEM auth).

NÃO há POST/PUT/PATCH NESTE arquivo de rota do Next; um POST/PUT/PATCH neste path
retorna 405 (Next não exporta o handler), e o FastAPI faz o mesmo (método não
registrado → 405).

──────────────────────────────────────────────────────────────────────────────
GUARDS (mapeamento Next → BFF)
──────────────────────────────────────────────────────────────────────────────
DELETE no Next faz::

    requireAuth()                                               # só 401
    if (!podeGerenciarFamilias(role) && !podeExcluirFamilia(role)) -> 403

``podeGerenciarFamilias(role)`` = isConformidade(role) = role ∈ {ADMIN, LIDER, SGI}
``podeExcluirFamilia(role)``    = isAdmin(role)        = role ∈ {ADMIN}
Negação do AND (De Morgan): bloqueia quando NÃO está em nenhum dos dois conjuntos,
ou seja, autoriza quando role ∈ ({ADMIN,LIDER,SGI} ∪ {ADMIN}) = {ADMIN, LIDER, SGI}.

``require_conformidade`` do BFF cobre EXATAMENTE {ADMIN, LIDER, SGI}, MAS ele
levanta 403 com ``detail="Permissão negada"`` via HTTPException (shape
``{"detail": ...}``), enquanto o Next devolve ``NextResponse.json({error:...},403)``
(shape ``{"error":"Permissão negada"}``). Para paridade de WIRE no 403 usamos
``Depends(get_current_user)`` (→ 401 se sem sessão) e checamos o papel à mão,
devolvendo ``{"error":"Permissão negada"}`` cru.

ORDEM das checagens (preservada do Next):
  DELETE: guard(401) → 403(papel) → 404(anexo) → delete blob (best-effort)
          → DELETE → audit → resposta ``{ok:true}``.

GET (unsupported): SEM auth — devolve 405 ``{"error":"Use /download"}`` direto.

──────────────────────────────────────────────────────────────────────────────
404 (existência) — espelha o SELECT do Next
──────────────────────────────────────────────────────────────────────────────
``db.select().from(familiasAnexos)
   .where(and(eq(id, anexoId), eq(familiaId, id))).limit(1)`` → se vazio:
404 ``{"error":"Anexo não encontrado"}``.

NOTA SOBRE ids INVÁLIDOS (paridade bug-for-bug): o Next NÃO valida
``id``/``anexoId`` como UUID — passa direto pro ``eq(...)`` sobre colunas ``uuid``
(``familias_anexos.id`` e ``familia_id``, schema.ts L715-716). O Postgres tenta
castar o param de texto para ``uuid`` e, quando a string NÃO é um UUID válido,
levanta ``22P02 invalid input syntax for type uuid``. Esse SELECT está FORA do
``try/catch`` do ``requireAuth`` no Next, então o erro propaga como exceção não
tratada → o Next responde **500 genérico** (não o 404). Para replicar isso,
comparamos contra a coluna ``uuid`` DIRETAMENTE (``id = :anexo_id``, sem
``::text``) e NÃO capturamos o erro: o ``22P02`` (wrapping ``DBAPIError``) sobe até
o middleware do ``main.py`` → ``500 {"error":"Erro interno"}``, casando com o
throw-não-tratado do Next. Para ids VÁLIDOS porém inexistentes, o WHERE não casa
→ 404 ``{"error":"Anexo não encontrado"}`` (idêntico ao Next).

──────────────────────────────────────────────────────────────────────────────
DELETE — storage + audit
──────────────────────────────────────────────────────────────────────────────
``try { await deleteDocumento(a.blobKey) } catch {}`` → apaga o objeto no
MinIO/S3 (best-effort: erro engolido). Depois
``db.delete(familiasAnexos).where(eq(id, anexoId))``.
audit_log — ``REMOVER_ANEXO_FAMILIA``::
    entidade="familia", entidade_id=id,
    detalhes = { anexoId, nomeArquivo }
Resposta: ``NextResponse.json({ ok: true })``.

──────────────────────────────────────────────────────────────────────────────
STORAGE (MinIO/S3 via boto3)
──────────────────────────────────────────────────────────────────────────────
Cliente boto3 ``s3`` com ``endpoint_url=settings.s3_endpoint``,
``aws_access_key_id=settings.s3_access_key``,
``aws_secret_access_key=settings.s3_secret_key``, ``region_name='us-east-1'`` e
``config=Config(s3={'addressing_style':'path'})`` (MinIO EXIGE path-style),
``bucket=settings.s3_bucket``. Import TARDIO (dentro da função) para manter o
boto3 fora do caminho quente. ``deleteDocumento`` (lib/storage/upload.ts) tolera
key OU URL completa S3 (extrai a key via regex ``.../<bucket>/<key>``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from sqlalchemy import text

from app.core.security import CurrentUser, get_current_user
from app.db.session import get_db
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissão (espelha podeGerenciarFamilias / podeExcluirFamilia de permissions.ts)
# ══════════════════════════════════════════════════════════════════════════════
# DELETE autoriza quando: podeGerenciarFamilias(role) OU podeExcluirFamilia(role)
#   podeGerenciarFamilias = isConformidade = role ∈ {ADMIN, LIDER, SGI}
#   podeExcluirFamilia    = isAdmin        = role ∈ {ADMIN}
# ⇒ conjunto efetivo: {ADMIN, LIDER, SGI}
def _pode_excluir_anexo_familia(role: str) -> bool:
    return role in ("ADMIN", "LIDER", "SGI")


# ── SELECT do anexo (espelha .select().where(and(eq id, eq familiaId)).limit(1)) ─
# Comparação DIRETA contra as colunas ``uuid`` (sem ``::text``), igual ao Next:
# para ids não-uuid o Postgres levanta ``22P02`` → 500 não tratado (paridade);
# para ids válidos inexistentes → não casa → 404.
_SELECT_ANEXO = text(
    "SELECT id, familia_id, tipo, nome_arquivo, blob_url, blob_key, "
    "tamanho_bytes, content_type, validade_fim, uploadado_por, criado_em "
    "FROM familias_anexos "
    "WHERE id = :anexo_id AND familia_id = :id LIMIT 1"
)


async def _get_anexo(db: Any, id: str, anexo_id: str):
    """SELECT ... WHERE id = anexoId AND familia_id = id LIMIT 1 → mapping/None."""
    res = await db.execute(_SELECT_ANEXO, {"id": id, "anexo_id": anexo_id})
    return res.mappings().first()


# ══════════════════════════════════════════════════════════════════════════════
# Storage (MinIO/S3) — delete best-effort do blob (espelha deleteDocumento)
# ══════════════════════════════════════════════════════════════════════════════
def _delete_blob_best_effort(key_or_url: str | None) -> None:
    """Apaga o objeto no MinIO/S3. Best-effort: NUNCA propaga erro.

    Espelha ``await deleteDocumento(a.blobKey)`` (lib/storage/upload.ts) chamado
    dentro de ``try {} catch {}`` no DELETE do Next — falha de storage é engolida
    (o registro de banco/auditoria é prioritário). Aceita key OU URL S3 (extrai a
    key da URL, mesmo regex do Next).

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
# DELETE /api/conformidade/familias/{id}/anexos/{anexo_id}
#   — remove anexo (e blob no MinIO, best-effort)
# ══════════════════════════════════════════════════════════════════════════════
@router.delete("/api/conformidade/familias/{id}/anexos/{anexo_id}")
async def delete_anexo_familia(
    id: str,
    anexo_id: str,
    user: CurrentUser = Depends(get_current_user),  # requireAuth → só 401
    db=Depends(get_db),
) -> JSONResponse:
    """Remove um anexo de família (gerência: ADMIN/LIDER/SGI)."""
    # ── 403: papel (podeGerenciarFamilias || podeExcluirFamilia) ──────────────
    if not _pode_excluir_anexo_familia(user.role):
        return JSONResponse(content={"error": "Permissão negada"}, status_code=403)

    # ── 404: anexo existe? (and(eq id, eq familiaId)) ─────────────────────────
    a = await _get_anexo(db, id, anexo_id)
    if a is None:
        return JSONResponse(
            content={"error": "Anexo não encontrado"}, status_code=404
        )

    # ── Apaga o blob no MinIO/S3 (best-effort) — usa blobKey, não blobUrl. ────
    _delete_blob_best_effort(a["blob_key"])

    # ── DELETE FROM familias_anexos WHERE id = anexoId. ───────────────────────
    # Alcançado só após o SELECT casar → anexo_id é um UUID válido aqui;
    # comparação direta contra a coluna ``uuid`` (sem ``::text``), igual ao Next.
    await db.execute(
        text("DELETE FROM familias_anexos WHERE id = :anexo_id"),
        {"anexo_id": anexo_id},
    )

    # ── audit_log: REMOVER_ANEXO_FAMILIA ──────────────────────────────────────
    # Espelha db.insert(auditLog).values({ userId, acao, entidade, entidadeId,
    # detalhes }) do Next — MESMA sessão/transação (commit é do handler).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="REMOVER_ANEXO_FAMILIA",
        entidade="familia",
        entidade_id=id,
        detalhes={"anexoId": anexo_id, "nomeArquivo": a["nome_arquivo"]},
    )

    await db.commit()

    # ── Resposta: NextResponse.json({ ok: true }). ────────────────────────────
    return JSONResponse(content={"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/conformidade/familias/{id}/anexos/{anexo_id}
#   — unsupported: 405 "Use /download" (SEM auth, igual ao Next)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/conformidade/familias/{id}/anexos/{anexo_id}")
async def get_anexo_familia_unsupported(id: str, anexo_id: str) -> JSONResponse:
    """``export const GET = unsupported`` → 405 ``{"error":"Use /download"}``.

    O Next NÃO autentica este GET: ``unsupported()`` devolve direto o 405. O
    download real vive em ``.../{anexo_id}/download``.
    """
    return JSONResponse(content={"error": "Use /download"}, status_code=405)
