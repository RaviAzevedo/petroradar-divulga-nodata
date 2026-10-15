"""Rota MIGRADA (estrangulador): /api/conformidade/familias/match/{licitacao_id}.

Espelha 1:1 a rota Next:
  src/app/api/conformidade/familias/match/[licitacaoId]/route.ts

Módulo Famílias CRC — cálculo de ADERÊNCIA de uma licitação ao catálogo de
famílias ativas da Proponente:
  - GET  -> calcula a aderência SEM persistir (preview ao vivo).
  - POST -> recalcula e PERSISTE no cache ``licitacoes_familias_match`` (upsert).

Ambos devolvem o MESMO objeto ``ResultadoMatch`` (camelCase), serializado
direto via ``NextResponse.json(resultado)`` (NÃO embrulhado em ``{data}``):

  {
    "totalItens": <int>,
    "itensCobertos": <int>,
    "scoreAderencia": <float 0..100, arredondado a 2 casas>,
    "familiasUsadas": [ { "familiaId": <uuid str>, "codigoCrc": <str>,
                          "itensCobertos": <int> }, ... ],
    "familiasFaltantes": [ <str>, ... ]   # no máx. 50, ordem de 1ª aparição
  }

────────────────────────────────────────────────────────────────────────────────
GUARDS (paridade EXATA com o Next):

  GET  -> ``requireVisualizar()``  == BFF ``require_visualizar``
          (ADMIN/LIDER/ORCAMENTISTA/TECNICO/SGI/VISUALIZADOR; EXTERNO barrado).
          Sessão ausente -> 401 (get_current_user, por baixo); papel inválido -> 403.

  POST -> NÃO usa ``requireRole``. O Next faz:
            1) ``requireAuth()``  (apenas sessão válida — QUALQUER papel, inclusive
               EXTERNO/VISUALIZADOR, passa nesta etapa; 401 se não logado);
            2) checagem MANUAL de papel via ``podeGerenciarFamilias(role)`` ->
               ``isConformidade(role)`` -> {ADMIN, LIDER, SGI}
               -> se falhar: 403 ``{ "error": "Permissão negada" }``.

          IMPORTANTE: a paridade do POST NÃO é ``require_conformidade`` direto
          (que devolveria detail/403 da dependency); o Next devolve a sessão em
          requireAuth ANTES de checar o papel, e o 403 de papel tem o shape PLANO
          ``{ "error": "Permissão negada" }`` (NextResponse.json inline). Por isso
          o guard de AUTENTICAÇÃO é ``get_current_user`` (== requireAuth) e o gate
          de PAPEL é replicado à mão com :func:`app.core.security.is_conformidade`,
          na MESMA ORDEM do Next (auth primeiro -> 401; depois papel -> 403).

ORDEM DAS CHECAGENS (idêntica ao Next):
  GET:  visualizar(401/403) -> calcula aderência -> 200 (resultado).
  POST: auth(401) -> role(403) -> recalcula + upsert no cache -> 200 (resultado).

LÓGICA DE NEGÓCIO replicada de ``src/lib/conformidade/familias/match.ts`` +
``queries.ts`` (``getItensComFamiliaCadastrada``) + ``validations.ts``
(``normalizarCodigoCrc``):

  1) Carrega os ITENS da licitação (id, familia, descricao) — todos, sem filtro.
  2) Carrega as FAMÍLIAS ATIVAS (deletado_em IS NULL AND status = 'ATIVA').
  3) Carrega TODOS os aliases (familia_id, codigo_alternativo_normalizado).
  4) Monta o mapa ``codigoNormalizado -> {id, codigoCrc}``; aliases resolvem para
     a mesma família (sobrescrevendo a chave do alias, igual ao JS Map.set).
  5) Para cada item COM ``familia`` não-vazia: normaliza ``item.familia`` e
     procura no mapa. Se achou -> conta cobertura por família; senão -> registra
     o código BRUTO (``item.familia``, NÃO normalizado) em ``familiasFaltantes``.
  6) ``scoreAderencia = round((itensCobertos/totalItens)*100, 2)`` (JS Math.round)
     ou 0 se ``totalItens == 0``. ``totalItens = itens.length``.
  7) ``familiasFaltantes`` = códigos brutos distintos (ordem de 1ª aparição),
     fatiados nos PRIMEIROS 50.

  PERSISTÊNCIA (POST, ``calcularEPersistirAderencia``): UPSERT manual no Next
  (SELECT id existente -> UPDATE ou INSERT), replicado aqui. No UPDATE grava
  ``calculado_em = now()`` (``new Date()``); no INSERT deixa o DEFAULT do banco
  (``defaultNow()``) — paridade fiel (o INSERT do Drizzle NÃO seta calculadoEm).

NORMALIZAÇÃO (``normalizarCodigoCrc``): NFD -> remove combining marks
(U+0300..U+036F) -> remove tudo que não é [A-Za-z0-9] -> uppercase. Réplica EXATA
em :func:`_normalizar_codigo_crc`.

SERIALIZAÇÃO de wire (JSON.parse(bff) == JSON.parse(next)):
  - ``familias.id`` é ``uuid`` -> ``str(...)`` em ``familiasUsadas[].familiaId``.
  - ``codigoCrc`` / códigos faltantes são ``text`` -> string nativa.
  - ``scoreAderencia`` é ``real`` 0..100 arredondado a 2 casas -> número nativo.
  - inteiros (totalItens/itensCobertos) -> int nativo.

Objetivo: JSON.parse(resp_bff) == JSON.parse(resp_next) e MESMOS status codes.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    get_current_user,
    is_conformidade,
    require_visualizar,
)
from app.db.session import get_db

# Réplica canônica de Math.round do JS — ver _shared.py.
from app.routers.migrated._shared import js_round as _js_round

router = APIRouter()


# ── Normalização do código CRC (réplica de normalizarCodigoCrc) ───────────────


def _normalizar_codigo_crc(codigo: str) -> str:
    """Réplica EXATA de ``normalizarCodigoCrc`` (validations.ts).

    JS::

        codigo
          .normalize("NFD")
          .replace(/[\\u0300-\\u036f]/g, "")   // remove combining diacritical marks
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase();

    Passos: (1) decompõe em NFD; (2) descarta marcas combinantes (categoria Unicode
    "Mn" no range U+0300..U+036F); (3) mantém só ``[A-Za-z0-9]``; (4) uppercase.
    """
    nfd = unicodedata.normalize("NFD", codigo)
    sem_diacriticos = "".join(
        ch for ch in nfd if not ("̀" <= ch <= "ͯ")
    )
    apenas_alnum = "".join(ch for ch in sem_diacriticos if ch.isascii() and ch.isalnum())
    return apenas_alnum.upper()


# ── Cálculo de aderência (réplica de calcularAderencia) ───────────────────────


async def _calcular_aderencia(db, licitacao_id: str) -> dict[str, Any]:
    """Réplica de ``calcularAderencia`` + ``getItensComFamiliaCadastrada``.

    Devolve o objeto ``ResultadoMatch`` (dict camelCase) sem persistir.
    """
    # 1) Itens da licitação (todos; sem filtro). Espelha o select do Drizzle.
    itens_rows = (
        await db.execute(
            text(
                "SELECT id AS id, familia AS familia, descricao AS descricao "
                "FROM itens WHERE licitacao_id = :licitacao_id"
            ),
            {"licitacao_id": licitacao_id},
        )
    ).mappings().all()

    # 2) Famílias ATIVAS e não deletadas.
    familias_rows = (
        await db.execute(
            text(
                """
                SELECT
                    id                  AS id,
                    codigo_crc          AS codigo_crc,
                    codigo_normalizado  AS codigo_normalizado,
                    nome                AS nome
                FROM familias
                WHERE deletado_em IS NULL AND status = 'ATIVA'
                """
            )
        )
    ).mappings().all()

    # 3) Todos os aliases (sem filtro de família ativa — igual ao Next).
    aliases_rows = (
        await db.execute(
            text(
                "SELECT familia_id AS familia_id, "
                "codigo_alternativo_normalizado AS codigo_alternativo_normalizado "
                "FROM familias_aliases"
            )
        )
    ).mappings().all()

    # ── Mapa codigoNormalizado -> { id, codigoCrc } ───────────────────────────
    # familias[] primeiro; aliases sobrescrevem/adicionam (resolvem p/ a mesma
    # família). ``familiaId`` é o uuid da família -> str.
    mapa_familia: dict[str, dict[str, str]] = {}
    familias_por_id: dict[str, dict[str, str]] = {}
    for f in familias_rows:
        fam_id = str(f["id"])
        info = {"id": fam_id, "codigoCrc": f["codigo_crc"]}
        familias_por_id[fam_id] = info
        mapa_familia[f["codigo_normalizado"]] = info

    for a in aliases_rows:
        # ``familias.find(f => f.id === a.familiaId)`` — só resolve se a família do
        # alias estiver entre as ATIVAS carregadas.
        fam = familias_por_id.get(str(a["familia_id"]))
        if fam is not None:
            mapa_familia[a["codigo_alternativo_normalizado"]] = {
                "id": fam["id"],
                "codigoCrc": fam["codigoCrc"],
            }

    # ── Loop sobre itens ──────────────────────────────────────────────────────
    # contador_por_familia: dict ordenado por 1ª inserção (== Map JS).
    contador_por_familia: dict[str, dict[str, Any]] = {}
    # codigos_faltantes: ordem de 1ª aparição, distintos (== Set JS).
    codigos_faltantes: dict[str, None] = {}
    itens_cobertos = 0

    for item in itens_rows:
        familia_bruta = item["familia"]
        # ``if (!item.familia) continue;`` — pula None e string vazia (falsy no JS).
        if not familia_bruta:
            continue
        codigo_norm = _normalizar_codigo_crc(familia_bruta)

        match = mapa_familia.get(codigo_norm)
        if match is not None:
            itens_cobertos += 1
            atual = contador_por_familia.get(match["id"])
            if atual is not None:
                atual["itensCobertos"] += 1
            else:
                contador_por_familia[match["id"]] = {
                    "codigoCrc": match["codigoCrc"],
                    "itensCobertos": 1,
                }
        else:
            # Registra o código BRUTO (não normalizado), igual ao Next.
            codigos_faltantes.setdefault(familia_bruta, None)

    total_itens = len(itens_rows)
    score = (itens_cobertos / total_itens) * 100 if total_itens > 0 else 0
    score_aderencia = _js_round(score * 100) / 100

    return {
        "totalItens": total_itens,
        "itensCobertos": itens_cobertos,
        "scoreAderencia": score_aderencia,
        "familiasUsadas": [
            {
                "familiaId": familia_id,
                "codigoCrc": info["codigoCrc"],
                "itensCobertos": info["itensCobertos"],
            }
            for familia_id, info in contador_por_familia.items()
        ],
        "familiasFaltantes": list(codigos_faltantes.keys())[:50],
    }


# ── GET — calcula aderência (sem persistir) ───────────────────────────────────
@router.get("/api/conformidade/familias/match/{licitacao_id}")
async def calcular_aderencia(
    licitacao_id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET: calcula aderência SEM persistir. Guard: require_visualizar.

    Espelha ``calcularAderencia(licitacaoId)`` -> ``NextResponse.json(resultado)``.
    """
    resultado = await _calcular_aderencia(db, licitacao_id)
    return JSONResponse(content=resultado)


# ── POST — recalcula e persiste no cache (upsert) ─────────────────────────────
@router.post("/api/conformidade/familias/match/{licitacao_id}")
async def recalcular_e_persistir_aderencia(
    licitacao_id: str,
    request: Request,
    # requireAuth() do Next == apenas sessão válida (qualquer papel logado). O gate
    # de PAPEL (podeGerenciarFamilias -> isConformidade) é feito À MÃO logo abaixo,
    # na MESMA ordem do Next (auth -> 401; depois papel -> 403).
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """POST: recalcula e PERSISTE no cache. Auth(401) -> role(403) -> upsert -> 200.

    Réplica fiel de ``calcularEPersistirAderencia`` (upsert manual no cache
    ``licitacoes_familias_match``).
    """
    # Checagem manual de papel (após auth) — podeGerenciarFamilias == isConformidade.
    if not is_conformidade(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    resultado = await _calcular_aderencia(db, licitacao_id)

    # Upsert manual (espelha o SELECT-then-UPDATE/INSERT do Next, sem ON CONFLICT).
    existente = (
        await db.execute(
            text(
                "SELECT id FROM licitacoes_familias_match "
                "WHERE licitacao_id = :licitacao_id LIMIT 1"
            ),
            {"licitacao_id": licitacao_id},
        )
    ).mappings().first()

    # jsonb: passa as estruturas nativas (asyncpg + SQLAlchemy bind serializam o
    # dict/list em jsonb). ``familias_usadas`` é list[dict]; ``familias_faltantes``
    # é list[str].
    params: dict[str, Any] = {
        "licitacao_id": licitacao_id,
        "total_itens": resultado["totalItens"],
        "itens_cobertos": resultado["itensCobertos"],
        "score_aderencia": resultado["scoreAderencia"],
        "familias_usadas": _to_jsonb(resultado["familiasUsadas"]),
        "familias_faltantes": _to_jsonb(resultado["familiasFaltantes"]),
    }

    if existente is not None:
        # UPDATE grava calculado_em = now() (new Date() no Next).
        await db.execute(
            text(
                """
                UPDATE licitacoes_familias_match
                SET total_itens        = :total_itens,
                    itens_cobertos     = :itens_cobertos,
                    score_aderencia    = :score_aderencia,
                    familias_usadas    = CAST(:familias_usadas AS jsonb),
                    familias_faltantes = CAST(:familias_faltantes AS jsonb),
                    calculado_em       = now()
                WHERE licitacao_id = :licitacao_id
                """
            ),
            params,
        )
    else:
        # INSERT NÃO seta calculado_em -> usa o DEFAULT do banco (defaultNow()),
        # exatamente como o ``db.insert(...).values(...)`` do Drizzle (que omite
        # calculadoEm).
        await db.execute(
            text(
                """
                INSERT INTO licitacoes_familias_match
                    (licitacao_id, total_itens, itens_cobertos, score_aderencia,
                     familias_usadas, familias_faltantes)
                VALUES
                    (:licitacao_id, :total_itens, :itens_cobertos, :score_aderencia,
                     CAST(:familias_usadas AS jsonb), CAST(:familias_faltantes AS jsonb))
                """
            ),
            params,
        )

    await db.commit()

    return JSONResponse(content=resultado)


def _to_jsonb(value: Any) -> str:
    """Serializa dict/list em string JSON para o cast ``::jsonb``."""
    import json as _json

    return _json.dumps(value)
