"""Rota migrada (strangler-fig): GET /api/licitacoes/search.

Equivalente 1:1 de ``src/app/api/licitacoes/search/route.ts`` (handler GET).

Autocomplete / busca rápida global: dado um termo ``q``, devolve até 5
licitações (feed Petronect) cujo número/objeto/empresa casem com o termo
(ILIKE ``%q%``). Até 2026-09 também devolvia participações; o módulo saiu
na limpeza geral (Next e BFF juntos).

Guard Next (RBAC hardening — FRENTE D, 2026-07-02):
    ``requireVisualizar()`` → sessão válida + papel em ROLES_VISUALIZAR
    (ADMIN/LIDER/ORCAMENTISTA/TECNICO/SGI/VISUALIZADOR). BARRA EXTERNO com 403
    ``{ "error": "Permissão negada", "code": "FORBIDDEN" }``; 401 se não houver
    sessão. Antes era ``requireAuth`` (qualquer autenticado, inclusive EXTERNO),
    mas a busca global é leitura interna. Equivalente no BFF:
    :func:`app.core.security.require_visualizar`.

Query params lidos (iguais ao Next):
    ``?q=`` — texto de busca. É ``.trim()``-ado. Se ausente/vazio OU com
    ``length < 2`` (após o trim), retorna o shape vazio
    ``{ "licitacoes": [] }`` ANTES de tocar o banco.

Lógica replicada do Drizzle (mesma projeção/filtros/limites; SEM ORDER BY —
ordem default do banco, igual ao Next):

    licitacoes:
        SELECT id, numero, objeto, empresa, relevancia
        FROM licitacoes
        WHERE numero ILIKE %q% OR objeto ILIKE %q% OR empresa ILIKE %q%
        LIMIT 5

Flag SEARCH_TRGM (E12, 2026-07-02) — busca acento-insensível + ranking:
    ``SEARCH_TRGM=1`` troca, na query acima:
      - WHERE: ``f_unaccent(col) ILIKE f_unaccent(:termo)`` (acento-insensível;
        usa os índices GIN de expressão idx_lic_*_unaccent_trgm da migration
        0018_busca_unaccent.sql);
      - ORDER BY: ``GREATEST(similarity(f_unaccent(col1), f_unaccent(:q)), ...)
        DESC`` como critério PRIMÁRIO. A rota nunca teve ORDER BY (ordem default
        do banco), então não há desempate herdado — empates seguem na ordem
        default, como hoje. O ranking usa o termo CRU (sem ``%``): os curingas
        poluiriam os trigramas.
    Nesta rota SEMPRE há termo quando o banco é consultado (guarda len < 2
    acima), então a flag ON implica ranking; sem termo a rota nem chega ao SQL.
    Shape da resposta INALTERADO (mesmos campos/limites) — só a ORDEM dos
    resultados muda com a flag ON. Default (unset/"0"): SQL byte-a-byte igual
    ao histórico. Espelho exato do route.ts (process.env.SEARCH_TRGM === "1").

Shape da resposta: ``{ "licitacoes": [ {...} ] }``.

Colunas (snake_case no banco → camelCase no Drizzle/alias projetado):
    licitacoes.id (uuid)                       → "id"
    licitacoes.numero (text)                   → "numero"
    licitacoes.objeto (text)                   → "objeto"
    licitacoes.empresa (text)                  → "empresa"
    licitacoes.relevancia (text)               → "relevancia"
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()


def _search_trgm_habilitada() -> bool:
    """Flag SEARCH_TRGM: "1" liga busca acento-insensível + ranking trigram.

    Lida direto de ``os.environ`` (e não de ``app.core.config.settings``) de
    propósito: (1) config.py está sendo editado por frente paralela — evitamos
    conflito; (2) espelha byte-a-byte a decisão do Next
    (``process.env.SEARCH_TRGM === "1"`` em
    app/src/app/api/licitacoes/search/route.ts) — paridade da flag garantida
    por construção. Default (unset/qualquer outro valor) = DESLIGADA.
    """
    return os.environ.get("SEARCH_TRGM") == "1"


def _serializar(valor: Any) -> Any:
    """Serializa valores para JSON paritário com o Next.

    - datetime → ISO 8601 (``datetime.isoformat()``), igual ao Date do Next.
    - uuid → str(); numeric → número nativo; jsonb → dict/list nativo.
    - None/bool/int/float/str → valor nativo.
    """
    if valor is None:
        return None
    if isinstance(valor, datetime):
        return valor.isoformat()
    if isinstance(valor, (dict, list, int, float, bool, str)):
        return valor
    return str(valor)


@router.get("/api/licitacoes/search")
async def buscar_licitacoes(
    q: str | None = Query(
        default=None,
        description=(
            "Texto de busca (OPCIONAL). Espelha "
            "request.nextUrl.searchParams.get('q')?.trim() do Next: ausente, "
            "vazio ou com menos de 2 caracteres (após trim) devolve o shape "
            "vazio { licitacoes: [] }, NUNCA 400."
        ),
    ),
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/licitacoes/search?q=texto — busca rápida de licitações.

    Réplica fiel do handler GET do Next: ``q`` é OPCIONAL (default ``None`` →
    FastAPI NUNCA devolve 400/422 quando o param está ausente), guarda de
    curto-circuito para ``q`` com menos de 2 caracteres, uma query ILIKE com
    LIMIT 5 e shape ``{ licitacoes }``.
    """
    # ── Query param ``q`` (trim) — igual ao Next: get("q")?.trim(). ───────────
    # ``q`` chega tipado e OPCIONAL (default None); FastAPI não exige sua
    # presença, então requisição sem ``?q=`` responde 200 (não 400/422).
    if q is not None:
        q = q.strip()

    # Curto-circuito: ausente/vazio OU < 2 caracteres → shape vazio, sem banco.
    if not q or len(q) < 2:
        return JSONResponse(content={"licitacoes": []})

    termo = f"%{q}%"
    trgm = _search_trgm_habilitada()
    # Flag ON leva 2 parâmetros: :termo (%q%, para o ILIKE) e :q (cru, para o
    # similarity — curingas poluiriam os trigramas). Flag OFF: só :termo.
    params: dict[str, Any] = {"termo": termo, "q": q} if trgm else {"termo": termo}

    # ── 1) licitacoes: ILIKE em numero/objeto/empresa, LIMIT 5 (sem ORDER BY;
    #       flag ON: f_unaccent + ORDER BY similarity — ver docstring). ────────
    if trgm:
        lics_sql = text(
            """
            SELECT
                id          AS "id",
                numero      AS "numero",
                objeto      AS "objeto",
                empresa     AS "empresa",
                relevancia  AS "relevancia"
            FROM licitacoes
            WHERE f_unaccent(numero) ILIKE f_unaccent(:termo)
               OR f_unaccent(objeto) ILIKE f_unaccent(:termo)
               OR f_unaccent(empresa) ILIKE f_unaccent(:termo)
            ORDER BY GREATEST(
                similarity(f_unaccent(numero), f_unaccent(:q)),
                similarity(f_unaccent(objeto), f_unaccent(:q)),
                similarity(f_unaccent(empresa), f_unaccent(:q))
            ) DESC
            LIMIT 5
            """
        )
    else:
        lics_sql = text(
            """
            SELECT
                id          AS "id",
                numero      AS "numero",
                objeto      AS "objeto",
                empresa     AS "empresa",
                relevancia  AS "relevancia"
            FROM licitacoes
            WHERE numero ILIKE :termo
               OR objeto ILIKE :termo
               OR empresa ILIKE :termo
            LIMIT 5
            """
        )
    lics_res = await db.execute(lics_sql, params)
    licitacoes_rows = lics_res.mappings().all()

    licitacoes = [
        {chave: _serializar(valor) for chave, valor in row.items()}
        for row in licitacoes_rows
    ]
    return JSONResponse(content={"licitacoes": licitacoes})
