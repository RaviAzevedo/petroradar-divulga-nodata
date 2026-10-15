"""Rota MIGRADA (estrangulador / strangler-fig):
    GET /api/licitacoes/{id}/briefing

Espelho do lado-LEITURA de ``src/app/api/licitacoes/[id]/briefing/route.ts``.

O handler Next gera, por padrão, um **Briefing PDF** (pdf-lib) — binário WEB-ONLY,
não byte-replicável em Python (o BFF não embarca gerador de PDF). Por isso o NGINX
roteia ``^/api/licitacoes/[^/]+/briefing$`` ao ``petro_web`` (mesma decisão das
rotas XLSX ``relatorios/executivo``/``pacote-orcamento``). A superfície paritável
é o LADO-LEITURA: o guard de auth, o 404 (licitação inexistente), o 400
(``NO_ANALYSIS``) e o JSON estruturado (``?formato=json``) que o Next também expõe.

Este router replica esse lado-leitura:
  - guard ``require_visualizar`` (barra EXTERNO — 403 ``{ "error": "Permissão negada" }``);
  - 404 ``{ "error": { "code": "NOT_FOUND", "message": "Licitação não encontrada" } }``;
  - 400 ``{ "error": { "code": "NO_ANALYSIS", "message": "Rode a analise IA primeiro" } }``;
  - 200 JSON do briefing (mesmos campos que ``montarBriefingJson`` do Next).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()


def _lista_str(valor: Any) -> list[str]:
    """Espelha toStringArray do briefing.ts (jsonb -> list[str] não-vazias)."""
    if isinstance(valor, str):
        try:
            valor = json.loads(valor)
        except (ValueError, TypeError):
            return []
    if not isinstance(valor, list):
        return []
    saida: list[str] = []
    for x in valor:
        if isinstance(x, str):
            s = x
        elif x is None:
            s = ""
        else:
            s = json.dumps(x, ensure_ascii=False)
        if s:
            saida.append(s)
    return saida


def _riscos(valor: Any) -> list[dict[str, str]]:
    """Espelha toRiscos do briefing.ts."""
    if isinstance(valor, str):
        try:
            valor = json.loads(valor)
        except (ValueError, TypeError):
            return []
    if not isinstance(valor, list):
        return []
    saida: list[dict[str, str]] = []
    for r in valor:
        if isinstance(r, dict) and "descricao" in r:
            saida.append(
                {
                    "descricao": str(r.get("descricao") or ""),
                    "classificacao": str(r.get("classificacao") or "MEDIO"),
                }
            )
        else:
            saida.append({"descricao": str(r or ""), "classificacao": "MEDIO"})
    return saida


@router.get("/api/licitacoes/{id}/briefing")
async def briefing(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """Lado-leitura paritável do briefing (o PDF é servido pelo Next, web-only)."""
    res_lic = await db.execute(
        text(
            "SELECT numero, objeto, empresa, segmento "
            "FROM licitacoes WHERE id = :id LIMIT 1"
        ),
        {"id": id},
    )
    lic = res_lic.mappings().first()
    if lic is None:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Licitação não encontrada"}},
        )

    res_analise = await db.execute(
        text("SELECT * FROM analises_ia WHERE licitacao_id = :id LIMIT 1"),
        {"id": id},
    )
    analise = res_analise.mappings().first()
    if analise is None:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "NO_ANALYSIS", "message": "Rode a analise IA primeiro"}},
        )

    checklist = analise.get("checklist")
    if isinstance(checklist, str):
        try:
            checklist = json.loads(checklist)
        except (ValueError, TypeError):
            checklist = {}
    if not isinstance(checklist, dict):
        checklist = {}

    corpo = {
        "meta": {
            "numero": lic.get("numero"),
            "objeto": lic.get("objeto"),
            "empresa": lic.get("empresa"),
            "segmento": lic.get("segmento"),
            "geradoEm": datetime.now(timezone.utc).isoformat(),
            "modeloUsado": analise.get("modelo_usado"),
            "erroParse": bool(analise.get("erro_parse") or False),
        },
        "analise": {
            "resumo_executivo": analise.get("resumo") or "",
            "objeto_detalhado": analise.get("objeto_detalhado") or "",
            "requisitos_tecnicos": _lista_str(analise.get("requisitos")),
            "criterios_habilitacao": _lista_str(analise.get("criterios_habilitacao")),
            "criterios_julgamento": analise.get("criterios_julgamento") or "",
            "valor_estimado": analise.get("valor_estimado") or "",
            "prazos_importantes": _lista_str(analise.get("prazos")),
            "riscos_alertas": _riscos(analise.get("riscos")),
            "recomendacao": analise.get("recomendacao") or "",
            "checklist": checklist,
            "_erro_parse": bool(analise.get("erro_parse") or False),
            "_schema_versao": analise.get("schema_versao") or 1,
        },
        "probVitoria": analise.get("prob_vitoria"),
    }
    return JSONResponse(content=corpo)
