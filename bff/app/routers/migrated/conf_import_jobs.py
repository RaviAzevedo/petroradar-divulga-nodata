"""Rota migrada (strangler-fig): GET /api/conformidade/import/jobs (R14, 0034).

Espelho 1:1 de ``app/src/app/api/conformidade/import/jobs/route.ts`` — a lista
de rodadas de ingestão do acervo (``import_jobs``), com o que o DESFAZER (R15)
removeria de cada uma (``documentosRestantes``).

──────────────────────────────────────────────────────────────────────────────
GUARD
──────────────────────────────────────────────────────────────────────────────
``requireConformidade()`` == :data:`app.core.security.require_conformidade`
(ADMIN, LIDER, SGI).
  401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
  403 ``{"error":"Apenas Conformidade","code":"FORBIDDEN"}``  ← COM ``code``.

──────────────────────────────────────────────────────────────────────────────
QUERY STRING (ListarImportJobsSchema — operacoes/validations.ts)
──────────────────────────────────────────────────────────────────────────────
  limit   z.coerce.number().int().min(1).max(100).default(20)
  offset  z.coerce.number().int().min(0).default(0)
  status  z.enum(["EM_ANDAMENTO","CONCLUIDO","FALHOU","CANCELADO"]).optional()
Falha → 400 ``{"error":"Parâmetros inválidos","detalhes":{…}}`` (padrão R1,
last-wins do formatZodErrors — réplica de ``_validar_coerce_int`` de
conf_operacoes.py).

──────────────────────────────────────────────────────────────────────────────
SHAPE
──────────────────────────────────────────────────────────────────────────────
200 ``{"jobs":[{id, fonte, status, totalArquivos, processados, novos,
    atualizados, ignorados, erros, observacao, iniciadoEm, finalizadoEm,
    documentosRestantes}], "total": int}``
- ``payload`` NÃO sai (pode ser grande); ``iniciadoPor`` não sai nesta rodada
  (decisão declarada §13.3 — quem precisa de autor usa o audit_log);
- ordenação ``iniciado_em DESC NULLS LAST, id DESC`` é CONTRATO (desempate
  estável para paridade);
- ``documentosRestantes`` = count de ``documentos_habilitacao.import_job_id``
  (o que o R15 apagaria), ``::int`` (bigint viraria string no driver do Next);
- sem 404: lista vazia é ``{"jobs":[],"total":0}``.
"""

from __future__ import annotations

import math
import re
from datetime import timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_conformidade
from app.db.session import get_db

router = APIRouter()

_STATUS_IMPORT = ("EM_ANDAMENTO", "CONCLUIDO", "FALHOU", "CANCELADO")

# ``.int()`` do Zod v4 também exige o intervalo de inteiro SEGURO do JS.
_MAX_SAFE_INT = 9007199254740991


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, milissegundos, sufixo 'Z')."""
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


def _zod_enum_msg(valores: tuple[str, ...]) -> str:
    return "Invalid option: expected one of " + "|".join(f'"{v}"' for v in valores)


# Regex de números aceitos pelo ``Number()`` do JS (cópia de conf_operacoes.py).
_JS_NUM_DEC = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_JS_NUM_HEX = re.compile(r"^0[xX][0-9a-fA-F]+$")
_JS_NUM_BIN = re.compile(r"^0[bB][01]+$")
_JS_NUM_OCT = re.compile(r"^0[oO][0-7]+$")


def _js_number(valor: str) -> float:
    """Réplica de ``Number(string)`` (o que ``z.coerce.number()`` faz)."""
    s = valor.strip()
    if s == "":
        return 0.0
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    if _JS_NUM_HEX.match(s):
        return float(int(s, 16))
    if _JS_NUM_BIN.match(s):
        return float(int(s, 2))
    if _JS_NUM_OCT.match(s):
        return float(int(s, 8))
    if not _JS_NUM_DEC.match(s):
        return math.nan
    return float(s)


def _validar_coerce_int(
    raw: str, campo: str, minimo: int, maximo: int | None, detalhes: dict[str, str]
) -> int | None:
    """``z.coerce.number().int().min()[.max()]`` — cópia fiel do last-wins de
    ``conf_operacoes.py:345`` (mensagem acumulada; a ÚLTIMA issue do path vence)."""
    num = _js_number(raw)
    if math.isnan(num):
        detalhes[campo] = "Invalid input: expected number, received NaN"
        return None
    if math.isinf(num):
        detalhes[campo] = "Invalid input: expected number, received number"
        return None
    if num != math.floor(num):
        detalhes[campo] = "Invalid input: expected int, received number"
        return None

    msg: str | None = None
    if num > _MAX_SAFE_INT:
        msg = f"Too big: expected int to be <={_MAX_SAFE_INT}"
    elif num < -_MAX_SAFE_INT:
        msg = f"Too small: expected int to be >=-{_MAX_SAFE_INT}"

    n = int(num)
    if n < minimo:
        msg = f"Too small: expected number to be >={minimo}"
    elif maximo is not None and n > maximo:
        msg = f"Too big: expected number to be <={maximo}"

    if msg is not None:
        detalhes[campo] = msg
        return None
    return n


@router.get("/api/conformidade/import/jobs")
async def listar_import_jobs(
    request: Request,
    user: CurrentUser = Depends(require_conformidade),
    db=Depends(get_db),
) -> JSONResponse:
    """Lista as rodadas de ingestão, mais recentes primeiro."""
    qp = request.query_params

    def _qp_opt(k: str) -> str | None:
        valores = qp.getlist(k)  # primeira ocorrência (URLSearchParams.get)
        return valores[0] if valores else None

    def _qp_def(k: str, default: str) -> str:
        v = _qp_opt(k)
        return default if v is None else v

    detalhes: dict[str, str] = {}

    limit = _validar_coerce_int(_qp_def("limit", "20"), "limit", 1, 100, detalhes)
    offset = _validar_coerce_int(_qp_def("offset", "0"), "offset", 0, None, detalhes)

    status_f = _qp_opt("status")
    if status_f is not None and status_f not in _STATUS_IMPORT:
        detalhes["status"] = _zod_enum_msg(_STATUS_IMPORT)

    if detalhes:
        return JSONResponse(
            status_code=400,
            content={"error": "Parâmetros inválidos", "detalhes": detalhes},
        )

    where_sql = ""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if status_f:
        where_sql = "WHERE j.status = :status"
        params["status"] = status_f

    rows = (
        await db.execute(
            text(
                f"""
                SELECT j.id, j.fonte, j.status, j.total_arquivos, j.processados,
                       j.novos, j.atualizados, j.ignorados, j.erros, j.observacao,
                       j.iniciado_em, j.finalizado_em,
                       (SELECT count(*) FROM documentos_habilitacao d
                         WHERE d.import_job_id = j.id)::int AS documentos_restantes
                FROM import_jobs j
                {where_sql}
                ORDER BY j.iniciado_em DESC NULLS LAST, j.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        )
    ).mappings().all()

    total_row = (
        await db.execute(
            text(
                "SELECT count(*)::int AS total FROM import_jobs j "
                + ("WHERE j.status = :status" if status_f else "")
            ),
            {"status": status_f} if status_f else {},
        )
    ).mappings().first()
    total = total_row["total"] if total_row and total_row["total"] is not None else 0

    jobs = [
        {
            "id": str(r["id"]),
            "fonte": r["fonte"],
            "status": r["status"],
            "totalArquivos": r["total_arquivos"],
            "processados": r["processados"],
            "novos": r["novos"],
            "atualizados": r["atualizados"],
            "ignorados": r["ignorados"],
            "erros": r["erros"],
            "observacao": r["observacao"],
            "iniciadoEm": _js_to_iso_string(r["iniciado_em"]),
            "finalizadoEm": _js_to_iso_string(r["finalizado_em"]),
            "documentosRestantes": r["documentos_restantes"],
        }
        for r in rows
    ]

    return JSONResponse(content={"jobs": jobs, "total": total})
