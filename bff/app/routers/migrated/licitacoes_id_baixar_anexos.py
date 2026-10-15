"""Rota MIGRADA (estrangulador / strangler-fig):
    POST /api/licitacoes/{id}/baixar-anexos

Espelho do LADO-AUTH de ``src/app/api/licitacoes/[id]/baixar-anexos/route.ts``.

O handler Next é o PRODUTOR de texto dos anexos: baixa cada anexo do portal
(egress externo) e extrai o texto com unpdf (local) + Claude vision (fallback),
gravando ``anexos.texto_cache``. Esse trabalho usa libs TS (unpdf) + egress
externo — não é reimplementável no BFF Python. Por isso o NGINX roteia
``^/api/licitacoes/[^/]+/baixar-anexos$`` ao ``petro_web`` (web-only, como as
rotas XLSX/PDF).

Este router parita a superfície verificável: o guard ``require_propor`` (barra
VISUALIZADOR/EXTERNO), o 404 (licitação inexistente) e o SHAPE do resumo. O
processamento real (download+extração+escrita) roda no Next.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_propor
from app.db.session import get_db

router = APIRouter()


@router.post("/api/licitacoes/{id}/baixar-anexos")
async def baixar_anexos(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_propor),
    db=Depends(get_db),
) -> JSONResponse:
    """Parity do guard/404 do produtor (processamento real é web-only, no Next)."""
    res_lic = await db.execute(
        text("SELECT id FROM licitacoes WHERE id = :id LIMIT 1"),
        {"id": id},
    )
    if res_lic.mappings().first() is None:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Licitação não encontrada"}},
        )

    # Conta os anexos (o Next é quem baixa/extrai/grava — web-only).
    res_cnt = await db.execute(
        text("SELECT COUNT(*) AS n FROM anexos WHERE licitacao_id = :id"),
        {"id": id},
    )
    total = int((res_cnt.mappings().first() or {}).get("n", 0))
    resumo: dict[str, Any] = {
        "ok": True,
        "licitacaoId": id,
        "total": total,
        "processados": 0,
        "comTexto": 0,
        "jaTinham": 0,
        "semPhio": 0,
        "falhas": [],
    }
    return JSONResponse(content=resumo)
