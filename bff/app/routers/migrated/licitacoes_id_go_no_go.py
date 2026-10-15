"""Rota migrada (strangler-fig): GET /api/licitacoes/{id}/go-no-go.

Espelho 1:1 de ``src/app/api/licitacoes/[id]/go-no-go/route.ts`` (Next.js) +
``src/lib/licitacoes/go-no-go.ts`` (``calcularGoNoGo``) +
``src/lib/conformidade/familias/match.ts`` (``calcularAderencia``, usado como
fallback ao vivo quando NÃO há cache em ``licitacoes_familias_match``) +
``src/lib/conformidade/familias/queries.ts`` (``getItensComFamiliaCadastrada``) +
``src/lib/conformidade/familias/validations.ts`` (``normalizarCodigoCrc``).

READ-ONLY (não persiste). Semáforo VERDE/AMARELO/VERMELHO de habilitabilidade.

GUARD
  ``requireVisualizar()`` (Next) → ``require_visualizar`` (BFF): ADMIN, LIDER,
  ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR. EXTERNO é barrado (403).

VALIDAÇÃO DO ID
  A rota Next valida o ``id`` contra um regex de UUID e devolve
  ``{error:"ID inválido"}`` com status 400 se não casar — replicado aqui ANTES de
  qualquer query.

SHAPE (paridade JSON — ``{ "data": <objeto GoNoGoResult> }``):
  {
    "data": {
      "licitacaoId": str, "numero": str, "semaforo": "VERDE|AMARELO|VERMELHO",
      "scoreAderencia": number, "totalItens": int, "itensCobertos": int,
      "familiasFaltantes": [str, ...],
      "familiasHabilitadas": [{codigoCrc, nome, itensCobertos}, ...],
      "totalRequisitos": int, "requisitosAtendidos": int,
      "requisitosFaltantes": int, "requisitosVencendo": int,
      "requisitos": [{requisitoId, codigo, descricao, obrigatorio, status,
                      documentoId, documentoTitulo, venceEm}, ...],
      "familiasComProblema": [{codigoCrc, nome, statusFluxoCrc, validadeFim}, ...],
      "dataReferencia": str|null, "recomendacao": str
    }
  }

SERIALIZAÇÃO (paridade com Drizzle/pg → Next):
  - timestamps (``validade_fim``, etc.) → ISO via ``.isoformat()`` (Next usa
    ``Date.toISOString()``); só aparecem no payload já como ISO ou null.
  - uuid → ``str`` (Drizzle devolve uuid como string).
  - ``score_aderencia`` (real) → number; arredondado ``round(x*10)/10`` como o Next.
  - jsonb (``familias_usadas``, ``familias_faltantes``) → já vem dict/list do asyncpg.

NOTA SOBRE DATAS DE REFERÊNCIA (replicar o parsing exato do Next):
  ``data_abertura``/``data_disputa``/``data_fim`` são colunas ``text``. O Next
  parseia o 1º candidato não-vazio aceitando ISO ``YYYY-MM-DD...`` OU
  ``dd/mm/yyyy``, ancorado em ``T00:00:00Z`` (meia-noite UTC). Comparações de
  validade (``validade_fim < dataRef``) são feitas como datetimes aware (UTC),
  espelhando a comparação de objetos ``Date`` do JS.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()

# Mesmo regex de UUID da rota Next (case-insensitive).
_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


# ── Helpers de normalização / parsing (espelham as libs do Next) ──────────────


def _normalizar_codigo_crc(codigo: str) -> str:
    """Espelha ``normalizarCodigoCrc`` (validations.ts).

    NFD → remove diacríticos (categoria Unicode "Mn") → remove tudo que não for
    [a-zA-Z0-9] → maiúsculas. O Next usa ``\\u0300-\\u036f`` (diacríticos
    combinantes); a checagem por categoria "Mn" cobre exatamente esse intervalo.
    """
    decomposto = unicodedata.normalize("NFD", codigo)
    sem_acentos = "".join(c for c in decomposto if unicodedata.category(c) != "Mn")
    apenas_alnum = re.sub(r"[^a-zA-Z0-9]", "", sem_acentos)
    return apenas_alnum.upper()


def _resolver_data_referencia(
    data_abertura: str | None,
    data_disputa: str | None,
    data_fim: str | None,
) -> datetime | None:
    """Espelha ``resolverDataReferencia`` (go-no-go.ts).

    Tenta, em ordem, ``data_abertura`` → ``data_disputa`` → ``data_fim``. Para
    cada candidato não-vazio aceita ISO ``YYYY-MM-DD...`` OU BR ``dd/mm/yyyy...``,
    ancorando em meia-noite UTC. Retorna o primeiro que parsear; senão ``None``.
    """
    for candidato in (data_abertura, data_disputa, data_fim):
        if not candidato:
            continue
        iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})", candidato)
        if iso:
            try:
                return datetime(
                    int(iso.group(1)),
                    int(iso.group(2)),
                    int(iso.group(3)),
                    tzinfo=timezone.utc,
                )
            except ValueError:
                pass
        br = re.match(r"^(\d{2})/(\d{2})/(\d{4})", candidato)
        if br:
            try:
                return datetime(
                    int(br.group(3)),
                    int(br.group(2)),
                    int(br.group(1)),
                    tzinfo=timezone.utc,
                )
            except ValueError:
                pass
    return None


def _aware(dt: datetime | None) -> datetime | None:
    """Garante datetime timezone-aware (UTC) p/ comparar com a dataRef (aware)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt: datetime | None) -> str | None:
    """ISO 8601 (espelha ``Date.toISOString()``); ``None`` permanece ``null``."""
    return dt.isoformat() if dt is not None else None


# ── Handler ───────────────────────────────────────────────────────────────────


@router.get("/api/licitacoes/{id}/go-no-go")
async def get_go_no_go(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
):
    """GET /api/licitacoes/{id}/go-no-go — paridade 1:1 com a rota Next.

    Ordem (igual ao Next):
      1) ``requireVisualizar`` (dependency) → 2) valida UUID (400 se inválido) →
      3) ``calcularGoNoGo`` → 4) envelopa em ``{data}``; ``GoNoGoNotFound`` → 404.
    """
    # ── Validação do ID (espelha o UUID_REGEX.test do route.ts) ───────────────
    if not _UUID_REGEX.match(id):
        return JSONResponse(status_code=400, content={"error": "ID inválido"})

    # ── 0. Licitação ─────────────────────────────────────────────────────────
    lic_row = (
        await db.execute(
            text(
                """
                SELECT
                    id::text       AS "id",
                    numero         AS "numero",
                    data_abertura  AS "dataAbertura",
                    data_disputa   AS "dataDisputa",
                    data_fim       AS "dataFim"
                FROM licitacoes
                WHERE id = :id
                LIMIT 1
                """
            ),
            {"id": id},
        )
    ).first()

    if lic_row is None:
        # GoNoGoNotFound → 404 (mesmo shape do route.ts).
        return JSONResponse(
            status_code=404,
            content={
                "error": {
                    "code": "NOT_FOUND",
                    "message": "Licitação não encontrada",
                }
            },
        )

    lic = lic_row._mapping
    data_ref = _resolver_data_referencia(
        lic["dataAbertura"], lic["dataDisputa"], lic["dataFim"]
    )

    # ── 1. Aderência de famílias — cache se existir, senão cálculo ao vivo ─────
    match_row = (
        await db.execute(
            text(
                """
                SELECT
                    total_itens        AS "totalItens",
                    itens_cobertos     AS "itensCobertos",
                    score_aderencia    AS "scoreAderencia",
                    familias_usadas    AS "familiasUsadas",
                    familias_faltantes AS "familiasFaltantes"
                FROM licitacoes_familias_match
                WHERE licitacao_id = :id
                LIMIT 1
                """
            ),
            {"id": id},
        )
    ).first()

    if match_row is not None:
        mc = match_row._mapping
        aderencia = {
            "totalItens": mc["totalItens"],
            "itensCobertos": mc["itensCobertos"],
            "scoreAderencia": mc["scoreAderencia"],
            "familiasUsadas": mc["familiasUsadas"] or [],
            "familiasFaltantes": mc["familiasFaltantes"] or [],
        }
    else:
        aderencia = await _calcular_aderencia(db, id)

    # A aderência só pesa no semáforo quando houve itens-família para avaliar.
    aderencia_avaliada = aderencia["totalItens"] > 0

    # ── 2. Requisitos do edital (ordenados por ``ordem``) ─────────────────────
    requisitos_rows = (
        await db.execute(
            text(
                """
                SELECT
                    id::text    AS "id",
                    codigo      AS "codigo",
                    descricao   AS "descricao",
                    obrigatorio AS "obrigatorio"
                FROM requisitos_edital
                WHERE licitacao_id = :id
                ORDER BY ordem
                """
            ),
            {"id": id},
        )
    ).all()

    # Documentos VIGENTES do cofre (cofre é global — sem vínculo por licitação).
    docs_rows = (
        await db.execute(
            text(
                """
                SELECT
                    id::text              AS "id",
                    titulo                AS "titulo",
                    subcategoria          AS "subcategoria",
                    validade_fim          AS "validadeFim",
                    validade_indeterminada AS "validadeIndeterminada"
                FROM documentos_habilitacao
                WHERE status = 'VIGENTE'
                  AND restrito = false
                """
                # 0034/S14 (02-APIS §16-B.3): INCONDICIONAL — seleção de prova
                # do go/no-go nunca cita documento restrito, nem p/ Conformidade.
            )
        )
    ).all()

    # Index por subcategoria — escolhe o doc com maior validade (igual ao Next).
    doc_por_subcat: dict = {}
    for d in docs_rows:
        dm = d._mapping
        subcat = dm["subcategoria"]
        atual = doc_por_subcat.get(subcat)
        if atual is None:
            doc_por_subcat[subcat] = dm
            continue
        # Prioriza indeterminada; senão, maior validade_fim.
        if dm["validadeIndeterminada"] and not atual["validadeIndeterminada"]:
            doc_por_subcat[subcat] = dm
        elif (
            not atual["validadeIndeterminada"]
            and dm["validadeFim"] is not None
            and atual["validadeFim"] is not None
            and dm["validadeFim"] > atual["validadeFim"]
        ):
            doc_por_subcat[subcat] = dm

    coberturas: list[dict] = []
    for r in requisitos_rows:
        req = r._mapping
        doc = doc_por_subcat.get(req["codigo"])
        if doc is None:
            coberturas.append(
                {
                    "requisitoId": req["id"],
                    "codigo": req["codigo"],
                    "descricao": req["descricao"],
                    "obrigatorio": req["obrigatorio"],
                    "status": "FALTANTE",
                    "documentoId": None,
                    "documentoTitulo": None,
                    "venceEm": None,
                }
            )
            continue
        # Verifica validade vs data de referência.
        status_cob = "ATENDIDO"
        doc_validade = _aware(doc["validadeFim"])
        if (
            not doc["validadeIndeterminada"]
            and doc_validade is not None
            and data_ref is not None
            and doc_validade < data_ref
        ):
            status_cob = "VENCE_ANTES_DA_DATA"
        coberturas.append(
            {
                "requisitoId": req["id"],
                "codigo": req["codigo"],
                "descricao": req["descricao"],
                "obrigatorio": req["obrigatorio"],
                "status": status_cob,
                "documentoId": doc["id"],
                "documentoTitulo": doc["titulo"],
                "venceEm": _iso(doc_validade),
            }
        )

    total_requisitos = len(coberturas)
    requisitos_atendidos = sum(1 for c in coberturas if c["status"] == "ATENDIDO")
    requisitos_faltantes = sum(
        1 for c in coberturas if c["status"] == "FALTANTE" and c["obrigatorio"]
    )
    requisitos_vencendo = sum(
        1 for c in coberturas if c["status"] == "VENCE_ANTES_DA_DATA"
    )

    # ── 3. Famílias CRC envolvidas (deram match) com status crítico ───────────
    familias_usadas = aderencia["familiasUsadas"] or []
    familias_usadas_ids = [f["familiaId"] for f in familias_usadas]
    familias_com_problema: list[dict] = []
    nome_por_familia_id: dict[str, str] = {}

    if len(familias_usadas_ids) > 0:
        fams_rows = (
            await db.execute(
                text(
                    """
                    SELECT
                        id::text         AS "id",
                        codigo_crc       AS "codigoCrc",
                        nome             AS "nome",
                        status_fluxo_crc AS "statusFluxoCrc",
                        validade_fim     AS "validadeFim"
                    FROM familias
                    WHERE id = ANY(:ids)
                      AND deletado_em IS NULL
                    """
                ),
                {"ids": familias_usadas_ids},
            )
        ).all()

        for fr in fams_rows:
            fam = fr._mapping
            nome_por_familia_id[fam["id"]] = fam["nome"]

        for fr in fams_rows:
            fam = fr._mapping
            nao_ativa = fam["statusFluxoCrc"] != "A"
            fam_validade = _aware(fam["validadeFim"])
            vencida = (
                fam_validade is not None
                and data_ref is not None
                and fam_validade < data_ref
            )
            if nao_ativa or vencida:
                familias_com_problema.append(
                    {
                        "codigoCrc": fam["codigoCrc"],
                        "nome": fam["nome"],
                        "statusFluxoCrc": fam["statusFluxoCrc"]
                        if fam["statusFluxoCrc"] is not None
                        else None,
                        "validadeFim": _iso(fam_validade),
                    }
                )

    # Famílias CRC em que nos habilitamos (cobrem itens), enriquecidas com nome.
    familias_habilitadas = [
        {
            "codigoCrc": f["codigoCrc"],
            "nome": nome_por_familia_id.get(f["familiaId"], f["codigoCrc"]),
            "itensCobertos": f["itensCobertos"],
        }
        for f in familias_usadas
    ]

    # ── Veredito do semáforo (igual ao Next) ──────────────────────────────────
    # NADA AVALIÁVEL: sem requisitos do edital E sem itens CRC avaliados — não há
    # habilitação para cobrir. Estado NEUTRO SEM_DADOS (não "coberta"): a UI orienta
    # rodar a análise IA, em vez de liberar o orçamento com um falso verde.
    nada_avaliavel = total_requisitos == 0 and not aderencia_avaliada
    if nada_avaliavel:
        semaforo = "SEM_DADOS"
    elif (
        requisitos_faltantes > 0
        or len(familias_com_problema) > 0
        or (aderencia_avaliada and aderencia["scoreAderencia"] < 40)
    ):
        semaforo = "VERMELHO"
    elif (
        requisitos_vencendo > 0
        or (aderencia_avaliada and aderencia["scoreAderencia"] < 70)
        or (total_requisitos > 0 and requisitos_atendidos < total_requisitos)
    ):
        semaforo = "AMARELO"
    else:
        semaforo = "VERDE"

    if semaforo == "SEM_DADOS":
        recomendacao = (
            "Sem requisitos de habilitação nem itens CRC mapeados — rode a análise "
            "IA do edital para avaliar a habilitação."
        )
    elif semaforo == "VERMELHO":
        recomendacao = (
            "NÃO recomendado prosseguir sem resolver gaps de habilitação/CRC "
            "antes de orçar."
        )
    elif semaforo == "AMARELO":
        recomendacao = (
            "Avaliar com cautela — há documentos vencendo ou cobertura parcial; "
            "renovar antes do protocolo."
        )
    else:
        recomendacao = "Habilitação coberta — pode prosseguir para orçamento."

    data = {
        "licitacaoId": lic["id"],
        "numero": lic["numero"],
        "semaforo": semaforo,
        # Math.round(x*10)/10 — uma casa decimal (paridade JS).
        "scoreAderencia": _round_meio(aderencia["scoreAderencia"]),
        "totalItens": aderencia["totalItens"],
        "itensCobertos": aderencia["itensCobertos"],
        "familiasFaltantes": aderencia["familiasFaltantes"],
        "familiasHabilitadas": familias_habilitadas,
        "totalRequisitos": total_requisitos,
        "requisitosAtendidos": requisitos_atendidos,
        "requisitosFaltantes": requisitos_faltantes,
        "requisitosVencendo": requisitos_vencendo,
        "requisitos": coberturas,
        "familiasComProblema": familias_com_problema,
        "dataReferencia": _iso(data_ref),
        "recomendacao": recomendacao,
    }

    return JSONResponse(content={"data": data})


# ── Cálculo de aderência ao vivo (fallback sem cache) ─────────────────────────


async def _calcular_aderencia(db, licitacao_id: str) -> dict:
    """Espelha ``calcularAderencia`` (match.ts) + ``getItensComFamiliaCadastrada``.

    Busca os itens da licitação e cruza com famílias ATIVA (não deletadas) e seus
    aliases, via ``codigo_normalizado``. NÃO persiste. ``score`` = itensCobertos /
    totalItens * 100 (0 se sem itens), arredondado a 2 casas (``round(x*100)/100``).
    """
    itens_rows = (
        await db.execute(
            text(
                """
                SELECT
                    id::text  AS "id",
                    familia   AS "familia",
                    descricao AS "descricao"
                FROM itens
                WHERE licitacao_id = :id
                """
            ),
            {"id": licitacao_id},
        )
    ).all()

    familias_rows = (
        await db.execute(
            text(
                """
                SELECT
                    id::text          AS "id",
                    codigo_crc        AS "codigoCrc",
                    codigo_normalizado AS "codigoNormalizado",
                    nome              AS "nome"
                FROM familias
                WHERE deletado_em IS NULL
                  AND status = 'ATIVA'
                """
            )
        )
    ).all()

    aliases_rows = (
        await db.execute(
            text(
                """
                SELECT
                    familia_id::text             AS "familiaId",
                    codigo_alternativo_normalizado AS "codigoAlternativoNormalizado"
                FROM familias_aliases
                """
            )
        )
    ).all()

    familias_lista = [r._mapping for r in familias_rows]

    # Mapa de código normalizado → família.
    mapa_familia: dict[str, dict] = {}
    for f in familias_lista:
        mapa_familia[f["codigoNormalizado"]] = {
            "id": f["id"],
            "codigoCrc": f["codigoCrc"],
        }
    # Aliases resolvem para a mesma família.
    fam_por_id = {f["id"]: f for f in familias_lista}
    for a in aliases_rows:
        am = a._mapping
        fam = fam_por_id.get(am["familiaId"])
        if fam is not None:
            mapa_familia[am["codigoAlternativoNormalizado"]] = {
                "id": fam["id"],
                "codigoCrc": fam["codigoCrc"],
            }

    contador_por_familia: dict[str, dict] = {}
    codigos_faltantes: list[str] = []
    codigos_faltantes_set: set[str] = set()
    itens_cobertos = 0

    for item_row in itens_rows:
        item = item_row._mapping
        if not item["familia"]:
            continue
        codigo_norm = _normalizar_codigo_crc(item["familia"])
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
            # Set p/ unicidade; lista preserva a ordem de 1ª ocorrência (Set JS).
            if item["familia"] not in codigos_faltantes_set:
                codigos_faltantes_set.add(item["familia"])
                codigos_faltantes.append(item["familia"])

    total_itens = len(itens_rows)
    score = (itens_cobertos / total_itens) * 100 if total_itens > 0 else 0

    return {
        "totalItens": total_itens,
        "itensCobertos": itens_cobertos,
        "scoreAderencia": _round_centesimo(score),
        "familiasUsadas": [
            {
                "familiaId": familia_id,
                "codigoCrc": info["codigoCrc"],
                "itensCobertos": info["itensCobertos"],
            }
            for familia_id, info in contador_por_familia.items()
        ],
        "familiasFaltantes": codigos_faltantes[:50],
    }


def _round_centesimo(x: float) -> float:
    """``Math.round(x*100)/100`` — arredonda meio-pra-cima como o JS."""
    import math

    return math.floor(x * 100 + 0.5) / 100


def _round_meio(x: float) -> float:
    """``Math.round(x*10)/10`` — arredonda meio-pra-cima como o JS."""
    import math

    return math.floor(x * 10 + 0.5) / 10
