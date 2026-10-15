"""Rota migrada (strangler-fig): GET /api/resultados/{id}.

Espelho 1:1 de ``src/app/api/resultados/[id]/route.ts`` (handler GET) — paridade
de resposta com o BFF FastAPI (``JSON.parse(bff) === JSON.parse(next)``).

Detalhe de uma licitação (resultado consolidado). O ``[id]`` pode ser o UUID
legado de ``resultados_licitacao.id`` OU o número da licitação direto.

Guard Next:
    ``requireVisualizar()`` → ``requireAuth()`` (401 ``{error,code}`` se sem
    sessão) + ``podeVisualizar(role)`` → role ∈ {ADMIN, LIDER, ORCAMENTISTA,
    TECNICO, SGI, VISUALIZADOR}, senão 403.
Equivalente no BFF: :data:`app.core.security.require_visualizar`.

Feature flag (igual ao Next — checada ANTES do guard):
    ``config.features.resultados`` (env ``NEXT_PUBLIC_FEATURE_RESULTADOS``,
    default ``false``). Se desligada → 503 ``{"error": "Módulo em
    reconstrução"}``. Replicado via ``settings`` (mesma env + default false).
    OBS de paridade: no Next o 503 vem ANTES de ``requireVisualizar()``; aqui o
    guard é um ``Depends`` que rodaria antes do corpo do handler. Para manter a
    ORDEM do Next (503 mesmo sem sessão), checamos a flag dentro do handler e o
    guard via ``request`` manualmente NÃO seria suficiente — então marcamos o
    ``user`` como dependency, mas o 503 do Next só dispara quando a flag está
    ligada (em produção, default false ⇒ a rota é 503 para todos). Mantemos o
    guard como Depends; quando a flag está ON o comportamento é idêntico.

Resolução de ``[id]`` (igual ao Next):
    ``isLikelyNumero = /^\\d{8,12}$/.test(id)``. Se casar → ``numero = id``.
    Senão, busca ``resultados_licitacao.numero_licitacao`` WHERE id = :id
    LIMIT 1; se não achar → 404 ``{"error": "Resultado não encontrado"}``.

Queries (mesma ordem/joins/filtros/ordenação/limites do Drizzle), todas por
``numero``:
    - v2Resultado : SELECT * FROM petronect_lic_resultado WHERE numero LIMIT 1.
    - v2Andamento : SELECT * FROM petronect_lic_andamento WHERE numero LIMIT 1.
    - v2Propostas : SELECT * FROM petronect_lic_propostas WHERE numero
        ORDER BY item_numero_int ASC,
                 (CASE WHEN declinou = true THEN 1 ELSE 0 END) ASC,
                 posicao ASC.
    - v2Items     : SELECT * FROM petronect_lic_items WHERE numero (sem ORDER).
    - v2Anexos    : SELECT * FROM petronect_lic_anexos WHERE numero (sem ORDER).
    - legacyMeta  : SELECT objeto, empresa, segmento, natureza,
        valor_contrato_real, contrato_transparencia, contrato_vigencia_fim,
        contrato_fornecedor, contrato_cnpj, contrato_situacao,
        contrato_aditivos, contrato_moeda, contrato_vigencia_inicio
        FROM resultados_licitacao WHERE numero_licitacao LIMIT 1.
    - Fallback propostas (só se v2Propostas vazio): SELECT * FROM
        propostas_licitacao WHERE numero_licitacao
        ORDER BY item_numero ASC,
                 (CASE WHEN declinou = true THEN 1 ELSE 0 END) ASC,
                 posicao ASC, valor_total ASC.

Shape da resposta (copiado EXATAMENTE do Next):
    ``{ "resultado": {...}, "propostas": [...], "propostasPorItem": {...},
        "items": [...], "anexos": [...] }``.

Serialização (paridade JSON com o Drizzle/pg):
    - ``toNum`` (parseFloat de numeric → number|null): numeric vem como Decimal
      do asyncpg; convertemos para float (ou None se NULL).
    - timestamp → ISO 8601 via ``isoformat()`` (nenhum dos campos do shape final
      é timestamp; os ``data_*`` são ``text`` no schema, portanto strings cruas).
    - uuid → ``str()`` (Drizzle/pg devolve uuid como string).
    - jsonb → dict/list nativo (asyncpg já parseia) — não usado no shape final.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import get_current_user, require_visualizar
from app.db.session import get_db
from app.routers.migrated._shared import feature_resultados_habilitada

router = APIRouter()

# Mesma regex do Next: número da licitação "puro" (8 a 12 dígitos).
_NUMERO_REGEX = re.compile(r"^\d{8,12}$")


def _to_num(value):
    """Replica ``toNum`` do Next: numeric/string → number|null.

    O Next faz ``parseFloat(v)`` e devolve ``null`` se ``NaN`` ou se ``v`` é
    null/undefined. O asyncpg entrega ``numeric`` como ``Decimal``; convertemos
    para ``float``. Strings que não parseiam viram ``None`` (igual ao ``isNaN``).
    """
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n


def _jsonable(value):
    """Normaliza um valor para JSON (paridade Next). Usado em campos crus."""
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


# Gate de feature: canônico de _shared (a cópia local era idêntica).
_feature_resultados_habilitada = feature_resultados_habilitada


@router.get("/api/resultados/{id}")
async def get_resultado(
    id: str,
    request: Request,
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/resultados/{id} — paridade 1:1 com a rota Next.

    Ordem idêntica ao Next: (1) gate de feature → 503; (2) auth
    (``requireVisualizar`` → 401/403); (3) resolução do id e queries.
    """
    # ── (1) Feature flag (ANTES do auth, igual ao Next) → 503. ────────────────
    if not _feature_resultados_habilitada():
        return JSONResponse(
            content={"error": "Módulo em reconstrução"}, status_code=503
        )

    # ── (2) Auth: requireVisualizar() — chamado manualmente (na ordem do Next).
    # Não usamos Depends(require_visualizar) porque ele rodaria ANTES do corpo e
    # devolveria 401 antes do 503 de feature. Replicamos a ordem exata do Next.
    user = await get_current_user(request)
    require_visualizar(user=user)

    # ── Resolve [id] → numero da licitação (UUID legado ou numero direto). ────
    if _NUMERO_REGEX.match(id):
        numero = id
    else:
        res_legacy = await db.execute(
            text(
                'SELECT numero_licitacao AS "numero" '
                "FROM resultados_licitacao WHERE id = :id LIMIT 1"
            ),
            {"id": id},
        )
        legacy_row = res_legacy.mappings().first()
        if legacy_row is None:
            return JSONResponse(
                content={"error": "Resultado não encontrado"}, status_code=404
            )
        numero = legacy_row["numero"]

    # ── Queries chaveadas por `numero`. ───────────────────────────────────────
    # 1) v2Resultado (SELECT * LIMIT 1).
    res_v2res = await db.execute(
        text("SELECT * FROM petronect_lic_resultado WHERE numero = :n LIMIT 1"),
        {"n": numero},
    )
    v2_resultado = res_v2res.mappings().first()

    # 2) v2Andamento (SELECT * LIMIT 1).
    res_v2and = await db.execute(
        text("SELECT * FROM petronect_lic_andamento WHERE numero = :n LIMIT 1"),
        {"n": numero},
    )
    v2_andamento = res_v2and.mappings().first()

    # 3) v2Propostas (SELECT * ORDER BY item_numero_int, declinou-flag, posicao).
    res_v2prop = await db.execute(
        text(
            """
            SELECT * FROM petronect_lic_propostas
            WHERE numero = :n
            ORDER BY item_numero_int ASC,
                     (CASE WHEN declinou = true THEN 1 ELSE 0 END) ASC,
                     posicao ASC
            """
        ),
        {"n": numero},
    )
    v2_propostas = res_v2prop.mappings().all()

    # 4) v2Items (SELECT * — sem ORDER BY, igual ao Drizzle).
    res_v2items = await db.execute(
        text("SELECT * FROM petronect_lic_items WHERE numero = :n"),
        {"n": numero},
    )
    v2_items = res_v2items.mappings().all()

    # 5) v2Anexos (SELECT * — sem ORDER BY, igual ao Drizzle).
    res_v2anexos = await db.execute(
        text("SELECT * FROM petronect_lic_anexos WHERE numero = :n"),
        {"n": numero},
    )
    v2_anexos = res_v2anexos.mappings().all()

    # 6) legacyMeta (colunas explícitas, LIMIT 1).
    res_meta = await db.execute(
        text(
            """
            SELECT
                objeto    AS "objeto",
                empresa   AS "empresa",
                segmento  AS "segmento",
                natureza  AS "natureza",
                valor_contrato_real    AS "valorContratoReal",
                contrato_transparencia AS "contratoTransparencia",
                contrato_vigencia_fim  AS "contratoVigenciaFim",
                contrato_fornecedor    AS "contratoFornecedor",
                contrato_cnpj          AS "contratoCnpj",
                contrato_situacao      AS "contratoSituacao",
                contrato_aditivos      AS "contratoAditivos",
                contrato_moeda         AS "contratoMoeda",
                contrato_vigencia_inicio AS "contratoVigenciaInicio"
            FROM resultados_licitacao
            WHERE numero_licitacao = :n
            LIMIT 1
            """
        ),
        {"n": numero},
    )
    legacy_meta = res_meta.mappings().first()

    # ── Propostas: prioriza V2, fallback antigo. ──────────────────────────────
    propostas: list[dict] = []

    if len(v2_propostas) > 0:
        propostas = [
            {
                "id": _jsonable(p["id"]),
                "posicao": p["posicao"],
                "fornecedor": p["fornecedor"],
                "cnpj": p["cnpj"],
                "valorTotal": _to_num(p["total_value"]),
                "valorUnitario": _to_num(p["unit_value"]),
                "itemNumero": p["item_numero_int"],
                "itemDescricao": p["item_descricao"],
                "meEpp": p["me_epp"],
                "declinou": p["declinou"],
                "dataProposta": p["data_proposta"],
                "characteristic": p["characteristic"],
            }
            for p in v2_propostas
        ]
    else:
        # Fallback antigo (sem characteristic).
        res_raw = await db.execute(
            text(
                """
                SELECT * FROM propostas_licitacao
                WHERE numero_licitacao = :n
                ORDER BY item_numero ASC,
                         (CASE WHEN declinou = true THEN 1 ELSE 0 END) ASC,
                         posicao ASC,
                         valor_total ASC
                """
            ),
            {"n": numero},
        )
        raw_propostas = res_raw.mappings().all()
        propostas = [
            {
                "id": _jsonable(p["id"]),
                "posicao": p["posicao"],
                "fornecedor": p["fornecedor"],
                "cnpj": p["cnpj"],
                "valorTotal": _to_num(p["valor_total"]),
                "valorUnitario": _to_num(p["valor_unitario"]),
                "itemNumero": p["item_numero"],
                "itemDescricao": p["item_descricao"],
                "meEpp": p["me_epp"],
                "declinou": p["declinou"],
                "dataProposta": p["data_proposta"],
                "characteristic": None,  # tabela antiga não tem
            }
            for p in raw_propostas
        ]

    # ── Agrupa por item (key = itemNumero ?? "__sem_item__"). ─────────────────
    propostas_por_item: dict[str, list[dict]] = {}
    for p in propostas:
        key = p["itemNumero"] if p["itemNumero"] is not None else "__sem_item__"
        propostas_por_item.setdefault(key, []).append(p)

    # ── 404 se não há nem V2 nem metadados legados. ───────────────────────────
    if v2_resultado is None and legacy_meta is None:
        return JSONResponse(
            content={"error": "Resultado não encontrado"}, status_code=404
        )

    # ── Resposta consolidada (mesmo shape do Next). ───────────────────────────
    resultado = {
        "numero": numero,
        # metadados (V2 + legado)
        "objeto": (
            (v2_andamento["opport_descr"] if v2_andamento is not None else None)
            or (legacy_meta["objeto"] if legacy_meta is not None else None)
            or None
        ),
        "empresa": (
            (v2_andamento["company_desc"] if v2_andamento is not None else None)
            or (legacy_meta["empresa"] if legacy_meta is not None else None)
            or None
        ),
        "segmento": (legacy_meta["segmento"] if legacy_meta is not None else None)
        or None,
        "natureza": (legacy_meta["natureza"] if legacy_meta is not None else None)
        or None,
        # vencedor (V2 é fonte primária)
        "fornecedorVencedor": (
            v2_resultado["fornecedor_vencedor"] if v2_resultado is not None else None
        )
        or None,
        "cnpjVencedor": (
            v2_resultado["cnpj_vencedor"] if v2_resultado is not None else None
        )
        or None,
        "valorVencedor": (
            _to_num(v2_resultado["valor_vencedor"])
            if v2_resultado is not None
            else None
        ),
        # Valor REAL do contrato (Portal da Transparência) — espelha
        # toNum(legacyMeta?.valorContratoReal) e `?? null` do Next.
        "valorContratoReal": (
            _to_num(legacy_meta["valorContratoReal"])
            if legacy_meta is not None
            else None
        ),
        "contratoTransparencia": (
            legacy_meta["contratoTransparencia"] if legacy_meta is not None else None
        ),
        "contratoVigenciaFim": (
            legacy_meta["contratoVigenciaFim"] if legacy_meta is not None else None
        ),
        # Vencedor + metadados do contrato (migration 0020) — espelha o
        # `legacyMeta?.campo ?? null` do Next (passthrough; aditivos é int).
        "contratoFornecedor": (
            legacy_meta["contratoFornecedor"] if legacy_meta is not None else None
        ),
        "contratoCnpj": (
            legacy_meta["contratoCnpj"] if legacy_meta is not None else None
        ),
        "contratoSituacao": (
            legacy_meta["contratoSituacao"] if legacy_meta is not None else None
        ),
        "contratoAditivos": (
            legacy_meta["contratoAditivos"] if legacy_meta is not None else None
        ),
        "contratoMoeda": (
            legacy_meta["contratoMoeda"] if legacy_meta is not None else None
        ),
        "contratoVigenciaInicio": (
            legacy_meta["contratoVigenciaInicio"] if legacy_meta is not None else None
        ),
        "totalParticipantes": (
            v2_resultado["total_participantes"]
            if v2_resultado is not None and v2_resultado["total_participantes"] is not None
            else None
        ),
        "totalPropostas": (
            v2_resultado["total_propostas"]
            if v2_resultado is not None and v2_resultado["total_propostas"] is not None
            else None
        ),
        "menorValor": (
            _to_num(v2_resultado["menor_valor"]) if v2_resultado is not None else None
        ),
        "maiorValor": (
            _to_num(v2_resultado["maior_valor"]) if v2_resultado is not None else None
        ),
        "statusResultado": (
            v2_resultado["status_resultado"] if v2_resultado is not None else None
        )
        or None,
        "confidenceLevel": (
            v2_resultado["confidence_level"]
            if v2_resultado is not None and v2_resultado["confidence_level"] is not None
            else None
        ),
        # header detalhado V2
        "status": (v2_andamento["status"] if v2_andamento is not None else None)
        or None,
        "statusDesc": (
            v2_andamento["status_desc"] if v2_andamento is not None else None
        )
        or None,
        "subStatus": (v2_andamento["sub_status"] if v2_andamento is not None else None)
        or None,
        "disputeMode": (
            v2_andamento["dispute_mode"] if v2_andamento is not None else None
        )
        or None,
        "isEqualized": (
            v2_andamento["is_equalized"]
            if v2_andamento is not None and v2_andamento["is_equalized"] is not None
            else None
        ),
        "hasPrequalified": (
            v2_andamento["has_prequalified"]
            if v2_andamento is not None and v2_andamento["has_prequalified"] is not None
            else None
        ),
        "startDate": (v2_andamento["start_date"] if v2_andamento is not None else None)
        or None,
        "endDate": (v2_andamento["end_date"] if v2_andamento is not None else None)
        or None,
        "douPublDate": (
            v2_andamento["dou_publ_date"] if v2_andamento is not None else None
        )
        or None,
        "descObjContrat": (
            v2_andamento["desc_obj_contrat"] if v2_andamento is not None else None
        )
        or None,
    }

    items = [
        {
            "id": _jsonable(i["id"]),
            "itemNum": i["item_num"],
            "exlin": i["exlin"],
            "itemDesc": i["item_desc"],
            "unit": i["unit"],
            "quantity": _to_num(i["quantity"]),
            "delivDate": i["deliv_date"],
            "family": i["family"],
            "familyDescr": i["family_descr"],
        }
        for i in v2_items
    ]

    anexos = [
        {
            "description": a["description"],
            "phioObjid": a["phio_objid"],
            "detectedAt": _jsonable(a["detected_at"]),
            "lastSeenAt": _jsonable(a["last_seen_at"]),
        }
        for a in v2_anexos
    ]

    return JSONResponse(
        content={
            "resultado": resultado,
            "propostas": propostas,
            "propostasPorItem": propostas_por_item,
            "items": items,
            "anexos": anexos,
        }
    )
