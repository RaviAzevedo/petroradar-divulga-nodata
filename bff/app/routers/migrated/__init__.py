"""
Rotas /api/* MIGRADAS para o BFF (estrangulador, por ondas).

Cada módulo aqui expõe um ``router = APIRouter()`` cujos paths são EXATAMENTE os
do Next (ex.: ``@router.get("/api/perfis")``). São incluídos SEM prefixo, então o
BFF serve o mesmo path /api/<X> que o Next servia — o NGINX roteia esse path para
o BFF (strangler-routes.conf) e o front nem percebe (resposta idêntica, validada
por teste de paridade).
"""
from __future__ import annotations

import importlib
import pkgutil

from fastapi import FastAPI


def _spec_key(router):
    """Ordena por ESPECIFICIDADE: rotas estaticas antes das dinamicas; entre
    dinamicas, as mais profundas primeiro. Evita que /api/licitacoes/{id} capture
    /api/licitacoes/search (FastAPI casa na ordem de registro)."""
    paths = [getattr(r, "path", "") for r in router.routes] or [""]
    p = paths[0]
    return (p.count("{"), -p.count("/"), p)


def include_migrated(app: FastAPI) -> list[str]:
    """Descobre e inclui todos os routers de rotas migradas. Retorna os nomes.

    NOTA (rotas XLSX): o NGINX serve os paths XLSX pelo Next (bytes exceljs !=
    openpyxl). O relatório executivo saiu com o hub em 2026-09-18; a coleta de
    dados sobrevive em ``_relatorio_executivo_lib`` (módulo interno, prefixo
    ``_`` = ignorado abaixo) p/ uso do cron_relatorio_mensal.
    """
    incluidos: list[str] = []
    import logging

    import app.routers.migrated as pkg

    log = logging.getLogger("petro_radar_bff.main")

    # ISOLAMENTO POR MÓDULO (auditoria 2026-07, A-08): uma falha de import de UM
    # módulo NÃO pode derrubar as ~98 rotas /api (foi a classe de bug do C-01, em
    # que ai-contract ausente zerava TODA a superfície). Cada import é isolado;
    # o módulo defeituoso vira 404 só dele, os demais registram normalmente.
    falhas: list[str] = []
    mods = []
    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        try:
            m = importlib.import_module(f"app.routers.migrated.{mod.name}")
            router = getattr(m, "router", None)
            if router is not None:
                mods.append((mod.name, router))
        except Exception as exc:  # noqa: BLE001 — falha isolada, não global
            falhas.append(mod.name)
            log.error("router migrado FALHOU no import (rota vira 404, resto segue)",
                      extra={"modulo": mod.name, "erro": str(exc)})
    # estaticas primeiro, dinamicas depois (mais profundas antes das rasas).
    mods.sort(key=lambda t: _spec_key(t[1]))
    for name, router in mods:
        app.include_router(router)  # SEM prefixo -> serve /api/<X> exato
        incluidos.append(name)
    if falhas:
        log.error("include_migrated: %d módulo(s) falharam: %s", len(falhas), ", ".join(falhas))
    return incluidos
