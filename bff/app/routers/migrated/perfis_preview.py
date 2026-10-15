"""Rota migrada (strangler-fig): POST /api/perfis/preview.

Preview de captura de um perfil de interesse — agora calculado pelo MOTOR
ÚNICO de classificação em ``/shared/classificacao`` (o mesmo módulo do worker
e do reclassify). A versão anterior usava um count SQL "simplificado"
(LIKE sobre ``objeto``) que divergia ~4x do motor real; o preview passa a ser
fiel POR CONSTRUÇÃO: monta um pseudo-perfil com os filtros postados e chama
``pontuar_perfil`` (hard-gates + score) contra cada licitação, usando as
colunas de classificação já PERSISTIDAS no banco (natureza/tipo_servico/
segmento NÃO são reclassificados aqui) + o texto agregado dos itens.

Guard (INALTERADO — RBAC hardening, FRENTE D, 2026-07-02):
    ``requireVisualizar()`` → sessão válida + papel em ROLES_VISUALIZAR. BARRA
    EXTERNO (403 ``{ "error": "Permissão negada", "code": "FORBIDDEN" }``); 401
    se não houver sessão. Equivalente no BFF:
    :func:`app.core.security.require_visualizar`.

Corpo (FiltrosPreview — lido via ``await request.json()`` SEM validação Zod):
    natureza?:          string[]
    tipo_servico?:      string[]
    segmento?:          string[]
    keywords_incluir?:  string[]
    keywords_excluir?:  string[]
    regioes?:           string[]
    empresas?:          string[]
    abrangencia?:       string | string[]
    peso?:              number
    prazo_minimo_dias?: number   (só VALIDADO — o motor não usa prazo no score)

Status codes (INALTERADOS): 401 sem sessão, 403 sem papel, 400
``{ "error": "prazo_minimo_dias inválido" }`` para prazo truthy > 0 que
flooreia para <= 0 (mesma coerção Number() do JS), 200 caso contrário.

Cálculo (2 queries + loop em memória — alguns milhares de licitações é tranquilo):
    1. SELECT das colunas persistidas de TODAS as licitações (id, numero,
       objeto, objeto_resumido, empresa, regioes, abrangencia, natureza,
       tipo_servico, segmento, data_fim).
    2. SELECT do texto agregado dos itens por licitação
       (string_agg(descricao + familia_descricao + familia)).
    3. Para cada licitação: monta o ctx do motor e chama
       ``pontuar_perfil({nome: "(preview)", ativo: true, filtros: body}, ctx)``
       — None = não casou; dict = match com score 0-100.

Shape da resposta (NOVO — contrato combinado com a UI):
    {
      "count":  <total de matches>,
      "abertas": <matches com data_fim >= hoje (texto YYYY-MM-DD)>,
      "distribuicao": { "ALTA": n, "MEDIA": n, "BAIXA": n },
      "sample": [ até 5 matches de MAIOR score:
                  { "numero", "objeto" (<=140 chars), "relevancia", "score" } ]
    }

Relevância por match (thresholds importados do motor): ALTA score >=
THRESH_ALTA (75), MÉDIA >= THRESH_MEDIA (55), senão BAIXA. Na ``distribuicao``
a chave é "MEDIA" SEM acento (contrato da UI); no ``sample`` o rótulo é
"MÉDIA" (mesmo rótulo persistido pelo motor).
"""

from __future__ import annotations

import math
import sys
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

# Motor único de classificação (montado em /shared no container do BFF).
if "/shared" not in sys.path:
    sys.path.insert(0, "/shared")

from classificacao import THRESH_ALTA, THRESH_MEDIA, normalizar, pontuar_perfil  # noqa: E402

router = APIRouter()


def _js_number(valor: Any) -> float:
    """Replica a coerção ``Number(x)`` do JS (o suficiente p/ prazo_minimo_dias).

    - None  → NaN (Number(undefined) === NaN). [body sem a chave]
    - bool  → 1.0/0.0 (Number(true)===1, Number(false)===0).
    - int/float → float.
    - str: trim; "" / só-espaços → 0; senão tenta float (aceita 0x/0o/0b,
      inteiros e decimais); falha → NaN.
    - outros (list/dict) → NaN.
    """
    if valor is None:
        return float("nan")
    if isinstance(valor, bool):
        return 1.0 if valor else 0.0
    if isinstance(valor, (int, float)):
        return float(valor)
    if isinstance(valor, str):
        s = valor.strip()
        if s == "":
            return 0.0
        try:
            # JS Number aceita prefixos 0x/0o/0b para inteiros.
            low = s.lower()
            if low.startswith(("0x", "0o", "0b", "-0x", "-0o", "-0b", "+0x", "+0o", "+0b")):
                return float(int(s, 0))
            return float(s)
        except ValueError:
            return float("nan")
    return float("nan")


@router.post("/api/perfis/preview")
async def preview_perfil(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """POST /api/perfis/preview — estima a captura de um perfil via motor real.

    Monta um pseudo-perfil com os filtros postados e pontua TODAS as
    licitações com ``pontuar_perfil`` (mesmos hard-gates e score do worker),
    sobre as classificações já persistidas no banco.
    """
    # ── Corpo (FiltrosPreview): await request.json() SEM validação. ───────────
    body: dict[str, Any] = await request.json()

    # ── Validação de prazo_minimo_dias (status 400 preservado). ───────────────
    # O motor novo NÃO usa prazo no score, mas o contrato de erro é mantido:
    # prazo truthy cujo Number() > 0 flooreia para <= 0 continua sendo 400.
    prazo_raw = body.get("prazo_minimo_dias")
    # "&&" com truthiness de JS: 0, "", None, NaN, false são falsy.
    prazo_truthy = bool(prazo_raw) if not isinstance(prazo_raw, (int, float)) else (prazo_raw != 0)
    if isinstance(prazo_raw, float) and math.isnan(prazo_raw):
        prazo_truthy = False
    if prazo_truthy and _js_number(prazo_raw) > 0:
        num = _js_number(prazo_raw)
        # Math.min(Math.floor(Number(x)), 365).
        floored = math.floor(num) if math.isfinite(num) else num
        dias = min(floored, 365) if math.isfinite(num) else float("nan")
        # !Number.isFinite(dias) || dias <= 0 → 400.
        if not (isinstance(dias, (int, float)) and math.isfinite(dias)) or dias <= 0:
            return JSONResponse(
                content={"error": "prazo_minimo_dias inválido"}, status_code=400
            )

    # ── Pseudo-perfil com os filtros postados (contrato do motor). ────────────
    perfil = {"nome": "(preview)", "ativo": True, "filtros": body}

    # ── Query 1: colunas PERSISTIDAS de todas as licitações. ──────────────────
    res_lic = await db.execute(
        text(
            """
            SELECT
                id              AS "id",
                numero          AS "numero",
                objeto          AS "objeto",
                objeto_resumido AS "objeto_resumido",
                empresa         AS "empresa",
                regioes         AS "regioes",
                abrangencia     AS "abrangencia",
                natureza        AS "natureza",
                tipo_servico    AS "tipo_servico",
                segmento        AS "segmento",
                data_fim        AS "data_fim"
            FROM licitacoes
            """
        )
    )
    lics = res_lic.mappings().all()

    # ── Query 2: texto agregado dos itens por licitação. ──────────────────────
    res_itens = await db.execute(
        text(
            """
            SELECT
                licitacao_id AS "licitacao_id",
                string_agg(
                    coalesce(descricao, '') || ' ' ||
                    coalesce(familia_descricao, '') || ' ' ||
                    coalesce(familia, ''),
                    ' '
                ) AS "texto"
            FROM itens
            GROUP BY licitacao_id
            """
        )
    )
    texto_itens_por_lic: dict[str, str] = {
        str(r["licitacao_id"]): (r["texto"] or "") for r in res_itens.mappings().all()
    }

    # ── Loop em memória: pontua cada licitação contra o pseudo-perfil. ────────
    hoje = date.today().isoformat()  # data_fim é text YYYY-MM-DD... (compara [:10])
    matches: list[dict[str, Any]] = []
    abertas = 0
    distribuicao = {"ALTA": 0, "MEDIA": 0, "BAIXA": 0}

    for lic in lics:
        ctx = {
            # Classificação PERSISTIDA (não reclassifica no preview).
            "natureza": lic["natureza"] or "",
            "tipo_servico": lic["tipo_servico"] or "",
            "segmento": lic["segmento"] or "",
            "texto_objeto": f"{lic['objeto'] or ''} {lic['objeto_resumido'] or ''}",
            "texto_itens": texto_itens_por_lic.get(str(lic["id"]), ""),
            "regioes_norm": normalizar(str(lic["regioes"] or "")),
            "empresa": str(lic["empresa"] or ""),
            "abrangencia": str(lic["abrangencia"] or ""),
        }
        r = pontuar_perfil(perfil, ctx)
        if r is None:
            continue

        score = int(round(r["score"]))
        if score >= THRESH_ALTA:
            relevancia = "ALTA"
            distribuicao["ALTA"] += 1
        elif score >= THRESH_MEDIA:
            relevancia = "MÉDIA"
            distribuicao["MEDIA"] += 1
        else:
            relevancia = "BAIXA"
            distribuicao["BAIXA"] += 1

        if str(lic["data_fim"] or "")[:10] >= hoje:
            abertas += 1

        matches.append(
            {
                "numero": lic["numero"],
                "objeto": (lic["objeto"] or "")[:140],
                "relevancia": relevancia,
                "score": score,
            }
        )

    # ── Sample: até 5 matches de MAIOR score (ordenação estável p/ empates). ──
    sample = sorted(matches, key=lambda m: m["score"], reverse=True)[:5]

    return JSONResponse(
        content={
            "count": len(matches),
            "abertas": abertas,
            "distribuicao": distribuicao,
            "sample": sample,
        }
    )
