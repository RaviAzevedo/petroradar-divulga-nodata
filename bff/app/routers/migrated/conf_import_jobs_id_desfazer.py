"""Rota migrada (strangler-fig): POST /api/conformidade/import/jobs/{id}/desfazer.

Espelho 1:1 de
``app/src/app/api/conformidade/import/jobs/[id]/desfazer/route.ts`` — o
DESFAZER de uma rodada de ingestão (R15, 0034). O CLI de
ingestão roda as MESMAS etapas 0–5 direto no
banco; esta rota é o caminho de tela/emergência — a spec SQL do 02-APIS §14 é a
fonte única para os dois.

──────────────────────────────────────────────────────────────────────────────
GUARD
──────────────────────────────────────────────────────────────────────────────
``requireAdmin()`` == ``require_admin`` — apagar em massa é o nível do DELETE
de documento.
  401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
  403 ``{"error":"Apenas administrador","code":"FORBIDDEN"}``  ← COM ``code``.

──────────────────────────────────────────────────────────────────────────────
ORDEM dos gates (§14.2)
──────────────────────────────────────────────────────────────────────────────
  1. requireAdmin                 → 401/403 (com code)
  2. ehUuid(id) / job inexistente → 404 {"error":"Job não encontrado"}
  3. request.json()               → 400 {"error":"JSON inválido"}
  4. confirmar !== true           → 422 {"error":"Envie confirmar:true para desfazer o job"}
  5. etapa 0 (uso a jusante)      → 409 JOB_EM_USO (quando forcar !== true)
  6. etapas 1–4 em transação → commit → etapa 5 (MinIO) → 200

──────────────────────────────────────────────────────────────────────────────
ETAPAS (§14.3/§14.4 — "linhas primeiro, objetos depois")
──────────────────────────────────────────────────────────────────────────────
  0. Recusa por uso a jusante: envelope_itens/gap_habilitacao têm FK SET NULL
     para o documento — apagar esvaziaria slot de envelope em silêncio. Com
     qualquer contagem > 0 e ``forcar !== true`` → 409 com os números.
  1. DELETE com captura (RETURNING id, blob_key) — a cascata leva anexos,
     documentos_familias e alertas; envelope/gap viram NULL (aceito com forcar).
  2. Reverte ADOÇÕES via audit_log ``IMPORT_ADOCAO`` (os docs adotados são
     PRÉ-existentes e sobrevivem ao passo 1): cada campo só é limpo SE o valor
     atual ainda é o que a adoção gravou (UPDATE condicional). Caveat ADR-10:
     o expurgo de 12 meses do audit_log limita a janela desta rota (o CLI tem
     ledger próprio).
  3. Fecha o job: status CANCELADO + marca ``| desfeito em <ISO>`` na observação.
  4. Audit ``DESFAZER_IMPORT_JOB`` na MESMA transação (``blobsApagados`` NÃO
     entra — só se conhece após o commit; sai apenas na resposta).
  5. Pós-commit: apaga blobs no MinIO, best-effort em paralelo
     (``asyncio.gather(return_exceptions=True)``); ``blobsApagados`` = sucessos.
     Se morrer no meio sobram blobs órfãos — nunca linha apontando pra blob
     inexistente.

IDEMPOTENTE (declarado): desfazer job já desfeito → 200 com zeros e status
CANCELADO (o UPDATE do passo 3 roda de novo e concatena outra marca — aceito).
"""

from __future__ import annotations

import asyncio
import json as _json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import CurrentUser, require_admin
from app.db.session import get_db
from app.services.audit import registrar_audit

router = APIRouter()

# Regex LITERAL do ``z.string().uuid()`` do Zod v4.4.3 (``ehUuid`` do Next).
_UUID_ZOD_REGEX = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)

# camelCase do IMPORT_ADOCAO → (coluna, é uuid?). A comparação condicional usa
# o VALOR gravado pela adoção — só limpa se ninguém mexeu depois.
_CAMPOS_ADOCAO: dict[str, tuple[str, bool]] = {
    "operacaoId": ("operacao_id", True),
    "papel": ("papel", False),
    "tipoDocumento": ("tipo_documento", False),
    "situacaoProva": ("situacao_prova", False),
    "detentora": ("detentora", False),
}


def _js_to_iso_string(dt: datetime) -> str:
    """``Date.toISOString()`` (UTC, milissegundos, sufixo 'Z')."""
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _apagar_blob_sync(key: str) -> None:
    """DELETE de um objeto no MinIO (boto3, path-style). Levanta em falha — o
    chamador conta sucessos via gather(return_exceptions=True)."""
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint or None,
        aws_access_key_id=settings.s3_access_key or None,
        aws_secret_access_key=settings.s3_secret_key or None,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )
    client.delete_object(Bucket=settings.s3_bucket, Key=key)


async def _apagar_blob(key: str) -> None:
    await run_in_threadpool(_apagar_blob_sync, key)


@router.post("/api/conformidade/import/jobs/{id}/desfazer")
async def desfazer_import_job(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_admin),
    db=Depends(get_db),
) -> JSONResponse:
    """Desfaz uma rodada de ingestão: apaga o que ela criou, reverte adoções."""
    # ── Gate 2: ehUuid + job existe. ──────────────────────────────────────────
    if not _UUID_ZOD_REGEX.match(id):
        return JSONResponse(status_code=404, content={"error": "Job não encontrado"})

    job = (
        await db.execute(
            text(
                "SELECT id, status, observacao FROM import_jobs "
                "WHERE id = CAST(:id AS uuid) LIMIT 1"
            ),
            {"id": id},
        )
    ).mappings().first()
    if job is None:
        return JSONResponse(status_code=404, content={"error": "Job não encontrado"})

    # ── Gate 3: body JSON. ────────────────────────────────────────────────────
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # ── Gate 4: confirmar !== true (comparação ESTRITA — "true" string não vale).
    confirmar = body.get("confirmar") if isinstance(body, dict) else None
    if confirmar is not True:
        return JSONResponse(
            status_code=422,
            content={"error": "Envie confirmar:true para desfazer o job"},
        )
    # forcar: só ``true`` literal desarma a etapa 0 (default false).
    forcar = isinstance(body, dict) and body.get("forcar") is True

    # ── Etapa 0: recusa por uso a jusante (§14.3). ────────────────────────────
    uso = (
        await db.execute(
            text(
                """
                SELECT
                  (SELECT count(*) FROM envelope_itens ei
                     JOIN documentos_habilitacao d ON d.id = ei.documento_id
                    WHERE d.import_job_id = CAST(:job AS uuid))::int AS envelope_itens,
                  (SELECT count(*) FROM gap_habilitacao g
                     JOIN documentos_habilitacao d ON d.id = g.documento_id
                    WHERE d.import_job_id = CAST(:job AS uuid))::int AS gaps,
                  (SELECT count(*) FROM documentos_familias df
                     JOIN documentos_habilitacao d ON d.id = df.documento_id
                    WHERE d.import_job_id = CAST(:job AS uuid))::int AS familias
                """
            ),
            {"job": id},
        )
    ).mappings().first()
    envelope_itens = uso["envelope_itens"]
    gaps = uso["gaps"]
    familias = uso["familias"]

    if (envelope_itens > 0 or gaps > 0 or familias > 0) and not forcar:
        return JSONResponse(
            status_code=409,
            content={
                "error": (
                    f"Job em uso a jusante: {envelope_itens} itens de envelope, "
                    f"{gaps} gaps, {familias} vínculos de família — "
                    "repita com forcar:true"
                ),
                "code": "JOB_EM_USO",
                "detalhes": {
                    "envelopeItens": envelope_itens,
                    "gaps": gaps,
                    "familias": familias,
                },
            },
        )

    # ── Etapa 1: DELETE com captura (linhas primeiro, objetos depois). ────────
    apagados_rows = (
        await db.execute(
            text(
                "DELETE FROM documentos_habilitacao "
                "WHERE import_job_id = CAST(:job AS uuid) "
                "RETURNING id, blob_key"
            ),
            {"job": id},
        )
    ).mappings().all()
    apagados = len(apagados_rows)
    blob_keys = [r["blob_key"] for r in apagados_rows if r["blob_key"]]

    # ── Etapa 2: reverte adoções (via audit_log IMPORT_ADOCAO — ADR-10). ──────
    adocoes = (
        await db.execute(
            text(
                "SELECT entidade_id, detalhes FROM audit_log "
                "WHERE acao = 'IMPORT_ADOCAO' AND detalhes->>'jobId' = :job"
            ),
            {"job": id},
        )
    ).mappings().all()

    adocoes_desfeitas = 0
    for reg in adocoes:
        detalhes = reg["detalhes"]
        if isinstance(detalhes, str):
            # Defensivo: alguns drivers entregam o jsonb como string crua.
            try:
                detalhes = _json.loads(detalhes)
            except Exception:  # noqa: BLE001
                continue
        if not isinstance(detalhes, dict):
            continue
        campos = detalhes.get("camposPreenchidos")
        doc_id = detalhes.get("documentoId") or (
            str(reg["entidade_id"]) if reg["entidade_id"] is not None else None
        )
        if not isinstance(campos, dict) or not doc_id:
            continue
        reverteu = False
        for campo, valor in campos.items():
            mapa = _CAMPOS_ADOCAO.get(campo)
            if mapa is None or not isinstance(valor, str):
                continue
            col, eh_uuid = mapa
            cond = (
                f"{col} = CAST(:valor AS uuid)" if eh_uuid else f"{col} = :valor"
            )
            res = await db.execute(
                text(
                    f"UPDATE documentos_habilitacao SET {col} = NULL "
                    f"WHERE id = CAST(:doc AS uuid) AND {cond}"
                ),
                {"doc": doc_id, "valor": valor},
            )
            if (res.rowcount or 0) > 0:
                reverteu = True
        if reverteu:
            adocoes_desfeitas += 1

    # ── Etapa 3: fecha o job (idempotente — a marca concatena de novo). ───────
    quando = _js_to_iso_string(datetime.now(tz=timezone.utc))
    await db.execute(
        text(
            "UPDATE import_jobs SET status = 'CANCELADO', finalizado_em = now(), "
            "observacao = COALESCE(observacao, '') || ' | desfeito em ' || :quando "
            "WHERE id = CAST(:job AS uuid)"
        ),
        {"job": id, "quando": quando},
    )

    # ── Etapa 4: audit na MESMA transação (blobsApagados fica de fora — só se
    # conhece após o commit; sai apenas na resposta). ──────────────────────────
    await registrar_audit(
        db,
        user_id=user.id,
        acao="DESFAZER_IMPORT_JOB",
        entidade="import_job",
        entidade_id=id,
        detalhes={
            "apagados": apagados,
            "adocoesDesfeitas": adocoes_desfeitas,
            "forcar": forcar,
            "usoAJusante": {
                "envelopeItens": envelope_itens,
                "gaps": gaps,
                "familias": familias,
            },
        },
    )

    await db.commit()

    # ── Etapa 5: MinIO DEPOIS do commit — best-effort em paralelo. ────────────
    resultados = await asyncio.gather(
        *[_apagar_blob(k) for k in blob_keys], return_exceptions=True
    )
    blobs_apagados = sum(1 for r in resultados if not isinstance(r, Exception))

    return JSONResponse(
        content={
            "ok": True,
            "apagados": apagados,
            "adocoesDesfeitas": adocoes_desfeitas,
            "blobsApagados": blobs_apagados,
            "status": "CANCELADO",
        }
    )
