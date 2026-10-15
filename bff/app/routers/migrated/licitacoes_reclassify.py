"""Rota migrada (strangler-fig): POST /api/licitacoes/reclassify.

Equivalente de ``src/app/api/licitacoes/reclassify/route.ts`` (handler POST),
agora DELEGANDO ao MOTOR ÚNICO de classificação em ``/shared/classificacao``
(o mesmo módulo importado pelo worker de sync). As heurísticas locais que
este arquivo re-implementava (portadas do route.ts) divergiam do worker e
foram REMOVIDAS — a paridade worker↔BFF passa a valer POR CONSTRUÇÃO: os dois
lados chamam ``classificar_licitacao`` do mesmo código-fonte montado em
``/shared``.

Diferenças de dado em relação à versão antiga (alinhado ao motor novo):
  - Os ITENS de cada licitação agora ALIMENTAM a classificação (descricao,
    familia, familia_descricao, familia_classif) — o sinal primário de
    natureza é o prefixo 98*/99* de familia_classif, como no worker.
  - TODOS os perfis são passados ao motor (ele filtra ``ativo`` internamente);
    perfis com ``filtros`` JSON malformado são pulados no carregamento.
  - ``data_fim`` deixou de importar: prazo está FORA do score no motor novo.

────────────────────────────────────────────────────────────────────────────
Guards do Next (replicados na MESMA ordem):
  1. ``requireAuth()`` → 401 ``{ "error": "Não autenticado", "code":
     "UNAUTHENTICATED" }`` quando não há sessão. No BFF, ``get_current_user``
     valida o token e levanta 401 (``detail="Não autenticado"``).
  2. ``podeSincronizar(role)`` → ``isGestao(role)`` → role ∈ {ADMIN, LIDER}.
     Se falhar: 403 ``{ "error": "Permissão negada" }`` (SEM ``code``, igual
     ao Next que faz ``NextResponse.json({ error: "Permissão negada" }, 403)``
     INLINE, não via ApiError). A checagem é feita INLINE no handler para
     preservar o shape EXATO do corpo do erro.

A ordem importa: 401 (sessão) ANTES de 403 (papel), idêntico ao Next.

────────────────────────────────────────────────────────────────────────────
Validações de negócio (idênticas ao contrato antigo):
  - Sem perfis ativos → 400 ``{ "error": "Nenhum perfil ativo encontrado" }``.

Operações no banco:
  - SELECT perfis_interesse (nome, ativo, filtros) — TODOS.
  - SELECT licitacoes (id, objeto, objeto_resumido, empresa, regioes,
    abrangencia, natureza, tipo_servico, segmento).
  - SELECT itens (licitacao_id, descricao, familia, familia_descricao,
    familia_classif) em UMA query, agrupados por licitacao_id em memória.
  - Para cada licitação cujo natureza/tipo_servico/segmento mudou:
      INSERT em historico_alteracoes (um por campo alterado).
  - UPDATE licitacoes SET natureza, tipo_servico, segmento, relevancia,
    score_interesse, perfis_match, melhor_perfil, atualizado_em = now()
    para TODAS as licitações (mesmo sem mudança de campo "monitorado").
  - await db.commit() ao final.

Shape da resposta (200, INALTERADO):
  {
    "ok": true,
    "total": <int>,
    "reclassificadas": <int>,
    "campos_alterados": { "natureza": n, "tipo_servico": n, "segmento": n },
    "perfisAtivos": <int>,
    "message": "<...>"
  }
"""

from __future__ import annotations

import json
import sys
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, get_current_user, is_gestao
from app.db.session import get_db

# Motor único de classificação (montado em /shared no container do BFF).
if "/shared" not in sys.path:
    sys.path.insert(0, "/shared")

from classificacao import classificar_licitacao  # noqa: E402

router = APIRouter()


def _pode_sincronizar(role: str) -> bool:
    """Réplica de ``podeSincronizar`` (permissions.ts): ``isGestao(role)``.

    O BFF não tem um ``pode_sincronizar`` próprio; a regra em produção é
    literalmente ``return isGestao(role)`` → {ADMIN, LIDER}. Delegamos a
    :func:`app.core.security.is_gestao` para manter UMA fonte de verdade.
    """
    return is_gestao(role)


def _carregar_perfis(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normaliza os perfis do banco para o contrato do motor.

    ``filtros`` é jsonb — o driver normalmente já entrega dict, mas se vier
    como string JSON fazemos o parse; perfil com filtros MALFORMADOS é pulado
    (não derruba a reclassificação inteira).
    """
    perfis: list[dict[str, Any]] = []
    for row in rows:
        p = dict(row)
        filtros = p.get("filtros")
        if isinstance(filtros, str):
            try:
                filtros = json.loads(filtros)
            except (json.JSONDecodeError, ValueError):
                continue  # filtros malformados → pula o perfil
            p["filtros"] = filtros
        perfis.append(p)
    return perfis


# ── Handler ───────────────────────────────────────────────────────────────────


@router.post("/api/licitacoes/reclassify")
async def reclassificar_licitacoes(
    request: Request,
    db=Depends(get_db),
) -> JSONResponse:
    """POST /api/licitacoes/reclassify — reclassifica TODAS as licitações.

    Valida sessão (401) e papel de gestão (403), exige ≥1 perfil ativo (400) e
    reclassifica em lote via ``classificar_licitacao`` do motor único
    (/shared/classificacao), agora incluindo os ITENS de cada licitação.
    Registra histórico das mudanças de natureza/tipo_servico/segmento e
    atualiza relevância/score/perfis em TODAS as licitações. Não recebe body.
    """
    # ── Guard 1: requireAuth() → 401 (mesma ordem do Next). ───────────────────
    # get_current_user levanta HTTPException(401, "Não autenticado") quando não
    # há sessão válida — propaga como 401 (mesmo status que o Next via ApiError).
    user: CurrentUser = await get_current_user(request)

    # ── Guard 2: podeSincronizar(role) → isGestao → {ADMIN, LIDER}. ───────────
    # Réplica INLINE do Next (NextResponse.json({ error: "Permissão negada" },
    # 403)): shape SEM ``code``.
    if not _pode_sincronizar(user.role):
        return JSONResponse(content={"error": "Permissão negada"}, status_code=403)

    # ── Carregar TODOS os perfis (o motor filtra ``ativo`` internamente). ─────
    res_perfis = await db.execute(
        text(
            """
            SELECT
                nome    AS "nome",
                ativo   AS "ativo",
                filtros AS "filtros"
            FROM perfis_interesse
            """
        )
    )
    perfis = _carregar_perfis(res_perfis.mappings().all())

    # Sem perfis ativos → 400 (mesmo contrato de antes).
    perfis_ativos = sum(1 for p in perfis if p.get("ativo"))
    if perfis_ativos == 0:
        return JSONResponse(
            content={"error": "Nenhum perfil ativo encontrado"}, status_code=400
        )

    # ── Carregar todas as licitações com os campos consumidos pelo motor. ─────
    res_lic = await db.execute(
        text(
            """
            SELECT
                id              AS "id",
                objeto          AS "objeto",
                objeto_resumido AS "objeto_resumido",
                empresa         AS "empresa",
                regioes         AS "regioes",
                abrangencia     AS "abrangencia",
                natureza        AS "natureza",
                tipo_servico    AS "tipo_servico",
                segmento        AS "segmento"
            FROM licitacoes
            """
        )
    )
    todas = [dict(r) for r in res_lic.mappings().all()]

    # ── Itens de TODAS as licitações numa query só, agrupados em memória. ─────
    res_itens = await db.execute(
        text(
            """
            SELECT
                licitacao_id      AS "licitacao_id",
                descricao         AS "descricao",
                familia           AS "familia",
                familia_descricao AS "familia_descricao",
                familia_classif   AS "familia_classif"
            FROM itens
            """
        )
    )
    itens_por_lic: dict[str, list[dict[str, Any]]] = {}
    for r in res_itens.mappings().all():
        item = dict(r)
        lic_id = str(item.pop("licitacao_id"))
        itens_por_lic.setdefault(lic_id, []).append(item)

    reclassificadas = 0
    campos_alterados_count: dict[str, int] = {
        "natureza": 0,
        "tipo_servico": 0,
        "segmento": 0,
    }
    # Distribuição de relevância pós-reclassificação — consumida pelo frontend
    # (perfis/page.tsx) como ``stats["ALTA" | "MÉDIA" | "BAIXA" | "SEM INTERESSE"]``.
    stats_relevancia: dict[str, int] = {
        "ALTA": 0,
        "MÉDIA": 0,
        "BAIXA": 0,
        "SEM INTERESSE": 0,
    }

    for lic in todas:
        lic_id = str(lic.get("id"))
        c = classificar_licitacao(
            {
                "objeto": lic.get("objeto") or "",
                "objeto_resumido": lic.get("objeto_resumido") or "",
                "empresa": lic.get("empresa"),
                "regioes": lic.get("regioes"),
                "abrangencia": lic.get("abrangencia"),
                "itens": itens_por_lic.get(lic_id, []),
            },
            perfis,
        )

        rel = c.get("relevancia") or "SEM INTERESSE"
        stats_relevancia[rel] = stats_relevancia.get(rel, 0) + 1

        # Detecta mudanças nos campos "monitorados" (mesma comparação de antes:
        # (valorAtual ?? "") !== valorNovo).
        changes: list[dict[str, Any]] = []
        if (lic.get("natureza") or "") != c["natureza"]:
            changes.append(
                {"campo": "natureza", "anterior": lic.get("natureza"), "novo": c["natureza"]}
            )
            campos_alterados_count["natureza"] += 1
        if (lic.get("tipo_servico") or "") != c["tipo_servico"]:
            changes.append(
                {"campo": "tipo_servico", "anterior": lic.get("tipo_servico"), "novo": c["tipo_servico"]}
            )
            campos_alterados_count["tipo_servico"] += 1
        if (lic.get("segmento") or "") != c["segmento"]:
            changes.append(
                {"campo": "segmento", "anterior": lic.get("segmento"), "novo": c["segmento"]}
            )
            campos_alterados_count["segmento"] += 1

        if len(changes) > 0:
            reclassificadas += 1
            for ch in changes:
                await db.execute(
                    text(
                        """
                        INSERT INTO historico_alteracoes
                            (licitacao_id, campo, valor_anterior, valor_novo)
                        VALUES
                            (:licitacao_id, :campo, :valor_anterior, :valor_novo)
                        """
                    ),
                    {
                        "licitacao_id": lic_id,
                        "campo": ch["campo"],
                        "valor_anterior": ch["anterior"],
                        "valor_novo": ch["novo"],
                    },
                )

        # UPDATE de TODAS as licitações (mesmo sem mudança de campo monitorado),
        # exatamente como antes — mesmas colunas.
        await db.execute(
            text(
                """
                UPDATE licitacoes
                SET natureza        = :natureza,
                    tipo_servico    = :tipo_servico,
                    segmento        = :segmento,
                    relevancia      = :relevancia,
                    score_interesse = :score_interesse,
                    perfis_match    = :perfis_match,
                    melhor_perfil   = :melhor_perfil,
                    atualizado_em   = now()
                WHERE id = :id
                """
            ),
            {
                "id": lic_id,
                "natureza": c["natureza"],
                "tipo_servico": c["tipo_servico"],
                "segmento": c["segmento"],
                "relevancia": c["relevancia"],
                "score_interesse": c["score_interesse"],
                "perfis_match": c["perfis_match"],
                "melhor_perfil": c["melhor_perfil"],
            },
        )

    await db.commit()

    return JSONResponse(
        content={
            "ok": True,
            "total": len(todas),
            "stats": stats_relevancia,
            "reclassificadas": reclassificadas,
            "campos_alterados": campos_alterados_count,
            "perfisAtivos": perfis_ativos,
            "message": (
                f"{len(todas)} licitações processadas, {reclassificadas} "
                f"reclassificadas com {perfis_ativos} perfis ativos."
            ),
        }
    )
