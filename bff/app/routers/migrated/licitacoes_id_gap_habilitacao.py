"""Rota MIGRADA (estrangulador): /api/licitacoes/{id}/gap-habilitacao.

Espelha 1:1 a rota Next:
  src/app/api/licitacoes/[id]/gap-habilitacao/route.ts

Gap de Habilitação Inteligente — cruza requisitos_edital +
analises_ia.criteriosHabilitacao contra o cofre (documentos_habilitacao VIGENTE)
e as famílias CRC, persistindo o resultado materializado em ``gap_habilitacao``.

  GET  -> lê o gap JÁ materializado (sem recalcular). Retorna ``{data}`` onde
          ``data`` é ``null`` se NUNCA foi calculado (UI mostra CTA "Calcular gap").
  POST -> RECALCULA (Claude/Haiku só nos requisitos ambíguos) e PERSISTE
          (delete + inserts), devolvendo ``{data}``.

────────────────────────────────────────────────────────────────────────────────
GUARDS (paridade EXATA com o Next):

  GET  -> ``requireVisualizar()`` == BFF ``require_visualizar``
          (ADMIN/LIDER/ORCAMENTISTA/TECNICO/SGI/VISUALIZADOR; EXTERNO barrado).
  POST -> ``requirePropor()``     == BFF ``require_propor``
          (ADMIN/LIDER/ORCAMENTISTA/TECNICO).

  Em ambos: sessão ausente -> 401 (get_current_user, por baixo do require_*);
  papel sem permissão -> 403. O guard roda ANTES da validação do ID (igual ao
  Next, que faz ``await requireX()`` antes de ler ``params``).

ORDEM DAS CHECAGENS (idêntica ao Next):
  GET:  visualizar(401/403) -> UUID inválido? 400 -> getGap -> 200 {data}
        | GapNotFound -> 404 {error:{code,message}}.
  POST: propor(401/403) -> UUID inválido? 400 -> body.usarIA (default true)
        -> calcularGap -> 200 {data}
        | GapNotFound -> 404 {error:{code,message}}
        | erro inesperado -> 500 {error:"Erro interno"}.

SHAPES DE ERRO (idênticos ao Next):
  - ID inválido (UUID_REGEX falha) -> 400 ``{"error": "ID inválido"}`` (PLANO).
  - Licitação não encontrada (GapNotFound) -> 404
        ``{"error": {"code": "NOT_FOUND", "message": "Licitação não encontrada"}}``.
  - 401/403 dos guards -> FastAPI ``{"detail": ...}`` (mesmo comportamento das
        demais rotas migradas que usam Depends(require_*)).
  - POST com erro inesperado -> 500 ``{"error": "Erro interno"}``.

CORPO DA REQUISIÇÃO (POST) — réplica de ``req.json().catch(() => ({}))``:
  Lê o JSON; se o parse falhar, trata como objeto vazio. ``usarIA = body.usarIA
  !== false`` (DEFAULT true — só desliga se vier EXPLICITAMENTE ``false``).

LÓGICA DE NEGÓCIO replicada de src/lib/licitacoes/gap-habilitacao.ts:

  resolverDataReferencia: 1ª data válida entre [dataAbertura, dataDisputa,
    dataFim], aceitando ``YYYY-MM-DD...`` ou ``DD/MM/YYYY...`` -> meia-noite UTC.

  Cofre VIGENTE indexado por subcategoria (MELHOR validade): para cada
    subcategoria, escolhe o doc com validadeIndeterminada (se o atual não for) ou,
    entre datados, o de validadeFim MAIOR (réplica fiel do desempate do Next).

  classificarCobertura(subcat, doc, dataRef):
    - sem subcat OU sem doc -> FALTANTE
    - doc datado com validadeFim < dataRef -> VENCE_ANTES_DA_DATA
    - senão -> ATENDIDO

  Match por CÓDIGO: requisito casa por código se ``docPorSubcat[codigo]`` existe
    OU ``codigo ∈ SUBCATEGORIAS``. Senão -> ambíguo (resolvido por IA).
    Critérios de texto da análise IA que NÃO sejam idênticos à descrição de algum
    requisito também entram como ambíguos (requisitoId = null).

  Match por IA (Haiku, batch único): gate gracioso por ANTHROPIC_API_KEY; falha
    de IA não quebra o cálculo (ambíguos viram FALTANTE). Para cada ambíguo,
    classifica a cobertura pela subcategoria sugerida (ou FALTANTE se sem subcat).

  Persistência (POST): DELETE de todos os gaps da licitação + INSERT de cada item.
    (No Next via db.batch — neon-http não suporta transaction; aqui usamos a MESMA
    AsyncSession + ``await db.commit()`` ao final.)

  computarFamiliasHabilitadas (derivado, NÃO persistido): roda calcularAderencia
    (réplica de conf/familias/match.ts) e enriquece com o nome da família. Falha
    silenciosa -> []. Replica EXATAMENTE o cálculo (não importa o módulo p/ evitar
    acoplamento, mas a lógica é idêntica à de conf_familias_match.py).

  montarResultado / semáforo: VERMELHO se faltantes>0; senão AMARELO se
    venceAntesDaData>0; senão VERDE. ``parciais`` é sempre 0 (classificarCobertura
    nunca emite PARCIAL) mas a contagem fica em ``totais`` por contrato/UI.

SERIALIZAÇÃO de wire (JSON.parse(bff) == JSON.parse(next)):
  - uuid -> str(...) (licitacaoId, requisitoId, documentoId).
  - datetime -> ``.isoformat()`` (venceEm, calculadoEm). O Next usa
    ``Date.toISOString()`` (sufixo "Z", ms). Aqui a coluna é ``timestamptz``;
    serializamos via isoformat (offset +00:00) — ambos ISO-8601 válidos.
  - confianca/score -> número nativo (real).
"""

from __future__ import annotations

import json as _json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import (
    CurrentUser,
    require_propor,
    require_visualizar,
)
from app.db.session import get_db

# Réplica canônica do Math.round do JS — ver _shared.py.
from app.routers.migrated._shared import js_round as _js_round

router = APIRouter()


# ── Constantes (réplica de gap-habilitacao.ts) ────────────────────────────────

_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Vocabulário de subcategorias válido (ordem idêntica à do TS).
SUBCATEGORIAS: list[str] = [
    "CND_FEDERAL", "FGTS", "CNDT", "CND_ESTADUAL", "CND_MUNICIPAL", "FALENCIA",
    "BALANCO", "INDICES_FINANCEIROS",
    "CONTRATO_SOCIAL", "CNPJ", "ATO_CONSTITUTIVO", "PROCURACAO",
    "ATESTADO_ACT", "ISO_9001", "ISO_14001", "ISO_45001",
    "NR_10", "NR_13", "NR_35", "ASME", "API_Q1", "API_6D", "PED", "OUTROS_TECNICOS",
    "CREA_PJ", "CREA_PF", "ART_CAT", "CTPS", "FORMACAO",
    "DECL_MENOR_NAO_EMPREGA", "DECL_IDONEIDADE", "DECL_ME_EPP", "DECL_OUTRA",
    "OUTRO",
]
_SUBCATEGORIAS_SET = set(SUBCATEGORIAS)


# ── GapNotFound (réplica do erro tipado do TS) ────────────────────────────────


class GapNotFound(Exception):
    """Erro tipado p/ converter em 404 (espelha ``class GapNotFound``)."""


# ── Helpers de serialização ───────────────────────────────────────────────────


def _iso(dt: Any) -> str | None:
    """datetime -> ISO-8601 (espelha ``Date.toISOString``). None -> None."""
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.isoformat()
    return str(dt)


def _to_jsonb(value: Any) -> str:
    """Serializa dict/list em string JSON p/ o cast ``::jsonb``."""
    return _json.dumps(value)


# ── resolverDataReferencia (réplica fiel) ─────────────────────────────────────


def _resolver_data_referencia(
    data_abertura: str | None,
    data_disputa: str | None,
    data_fim: str | None,
) -> datetime | None:
    """1ª data válida entre [abertura, disputa, fim]; ISO ou BR -> meia-noite UTC."""
    for c in (data_abertura, data_disputa, data_fim):
        if not c:
            continue
        iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})", c)
        if iso:
            try:
                return datetime(
                    int(iso.group(1)), int(iso.group(2)), int(iso.group(3)),
                    tzinfo=timezone.utc,
                )
            except ValueError:
                pass
        br = re.match(r"^(\d{2})/(\d{2})/(\d{4})", c)
        if br:
            try:
                return datetime(
                    int(br.group(3)), int(br.group(2)), int(br.group(1)),
                    tzinfo=timezone.utc,
                )
            except ValueError:
                pass
    return None


def _as_aware_utc(dt: Any) -> datetime | None:
    """Garante datetime tz-aware (assume UTC se naive) p/ comparações seguras."""
    if dt is None or not isinstance(dt, datetime):
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# ── classificarCobertura (réplica fiel) ───────────────────────────────────────


def _classificar_cobertura(
    subcat: str | None,
    doc_por_subcat: dict[str, dict[str, Any]],
    data_ref: datetime | None,
) -> tuple[str, dict[str, Any] | None]:
    """Classifica a cobertura de um requisito (status, doc)."""
    if not subcat:
        return ("FALTANTE", None)
    doc = doc_por_subcat.get(subcat)
    if not doc:
        return ("FALTANTE", None)
    validade_fim = _as_aware_utc(doc["validadeFim"])
    if (
        not doc["validadeIndeterminada"]
        and validade_fim is not None
        and data_ref is not None
        and validade_fim < data_ref
    ):
        return ("VENCE_ANTES_DA_DATA", doc)
    return ("ATENDIDO", doc)


# ── resolverAmbiguosComIA (réplica fiel — Haiku, batch único) ─────────────────


async def _resolver_ambiguos_com_ia(
    descricoes: list[str],
) -> dict[str, dict[str, Any]]:
    """Resolve via Claude (Haiku) o código de subcategoria de requisitos ambíguos.

    Gate gracioso: sem descrições OU IA bloqueada/sem chave -> mapa vazio. Falha de
    IA não quebra o cálculo (try/except amplo, igual ao ``catch {}`` do Next).
    Retorna ``Map<descricao, {subcategoria, confianca, justificativa}>``.

    TRAVA DE IA: "gap-habilitacao" está BLOQUEADO por decisão de produto (ver
    services/anthropic.py), então ia_permitida() é sempre false e devolvemos SEMPRE o
    mapa vazio — o cálculo do gap segue pelo casamento determinístico, sem gastar.
    """
    out: dict[str, dict[str, Any]] = {}

    from app.services.anthropic import get_client, ia_permitida

    if len(descricoes) == 0 or not ia_permitida("gap-habilitacao"):
        return out

    # Inalcançável enquanto o módulo estiver fora da allowlist (lança se chamado).
    client = get_client("gap-habilitacao")
    lista = "\n".join(f"{i + 1}. {d}" for i, d in enumerate(descricoes))

    prompt = (
        "Você é um especialista em habilitação de licitações da Petrobras.\n"
        "Para cada requisito abaixo, classifique a qual SUBCATEGORIA de documento "
        "de habilitação ele corresponde.\n"
        f"Subcategorias válidas: {', '.join(SUBCATEGORIAS)}.\n"
        "\n"
        "Responda EXATAMENTE em JSON válido (sem markdown):\n"
        '{ "itens": [ { "indice": 1, "subcategoria": "ISO_9001" | null, '
        '"confianca": 0.0-1.0, "justificativa": "1 frase" } ] }\n'
        "\n"
        "Use null em subcategoria quando o requisito não corresponder a nenhum "
        "documento padrão.\n"
        "\n"
        "REQUISITOS:\n"
        f"{lista}"
    )

    try:
        message = await client.messages.create(
            # Modelo Haiku via settings (ANTHROPIC_MODEL_HAIKU; default
            # "claude-haiku-4-5" — mesmo literal que o Next hardcoda), seguindo
            # o padrão dos demais routers (cron_triagem_semantica etc.).
            model=settings.anthropic_model_haiku,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        block = message.content[0] if message.content else None
        texto = block.text if (block is not None and getattr(block, "type", None) == "text") else ""
        cleaned = re.sub(r"```json\s*", "", texto)
        cleaned = re.sub(r"```\s*$", "", cleaned).strip()
        parsed = _json.loads(cleaned)
        itens = parsed.get("itens") or []
        for item in itens:
            try:
                indice = item["indice"]
            except (KeyError, TypeError):
                continue
            if not isinstance(indice, int):
                continue
            if indice - 1 < 0 or indice - 1 >= len(descricoes):
                continue
            desc = descricoes[indice - 1]
            if not desc:
                continue
            sub_raw = item.get("subcategoria")
            subcat = sub_raw if (sub_raw in _SUBCATEGORIAS_SET) else None
            conf = item.get("confianca")
            justif = item.get("justificativa")
            out[desc] = {
                "subcategoria": subcat,
                "confianca": conf if isinstance(conf, (int, float)) and not isinstance(conf, bool) else 0.5,
                "justificativa": justif if isinstance(justif, str) else "",
            }
    except Exception:
        # Falha de IA não quebra o cálculo — ambíguos ficam FALTANTE.
        return out
    return out


# ── computarFamiliasHabilitadas (réplica de calcularAderencia + nome) ─────────


def _normalizar_codigo_crc(codigo: str) -> str:
    """Réplica de ``normalizarCodigoCrc`` (validations.ts): NFD -> sem marcas
    combinantes -> só [A-Za-z0-9] -> uppercase."""
    nfd = unicodedata.normalize("NFD", codigo)
    sem_diacriticos = "".join(ch for ch in nfd if not ("̀" <= ch <= "ͯ"))
    apenas_alnum = "".join(
        ch for ch in sem_diacriticos if ch.isascii() and ch.isalnum()
    )
    return apenas_alnum.upper()


async def _calcular_aderencia(db, licitacao_id: str) -> dict[str, Any]:
    """Réplica de ``calcularAderencia`` + ``getItensComFamiliaCadastrada``."""
    itens_rows = (
        await db.execute(
            text(
                "SELECT id AS id, familia AS familia, descricao AS descricao "
                "FROM itens WHERE licitacao_id = :licitacao_id"
            ),
            {"licitacao_id": licitacao_id},
        )
    ).mappings().all()

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

    aliases_rows = (
        await db.execute(
            text(
                "SELECT familia_id AS familia_id, "
                "codigo_alternativo_normalizado AS codigo_alternativo_normalizado "
                "FROM familias_aliases"
            )
        )
    ).mappings().all()

    mapa_familia: dict[str, dict[str, str]] = {}
    familias_por_id: dict[str, dict[str, str]] = {}
    for f in familias_rows:
        fam_id = str(f["id"])
        info = {"id": fam_id, "codigoCrc": f["codigo_crc"]}
        familias_por_id[fam_id] = info
        mapa_familia[f["codigo_normalizado"]] = info

    for a in aliases_rows:
        fam = familias_por_id.get(str(a["familia_id"]))
        if fam is not None:
            mapa_familia[a["codigo_alternativo_normalizado"]] = {
                "id": fam["id"],
                "codigoCrc": fam["codigoCrc"],
            }

    contador_por_familia: dict[str, dict[str, Any]] = {}
    codigos_faltantes: dict[str, None] = {}
    itens_cobertos = 0

    for item in itens_rows:
        familia_bruta = item["familia"]
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


async def _computar_familias_habilitadas(db, licitacao_id: str) -> list[dict[str, Any]]:
    """Réplica de ``computarFamiliasHabilitadas``. Falha silenciosa -> []."""
    try:
        aderencia = await _calcular_aderencia(db, licitacao_id)
        usadas = aderencia.get("familiasUsadas") or []
        if len(usadas) == 0:
            return []

        ids = [u["familiaId"] for u in usadas]
        fams = (
            await db.execute(
                text(
                    "SELECT id AS id, nome AS nome FROM familias "
                    "WHERE id = ANY(CAST(:ids AS uuid[])) AND deletado_em IS NULL"
                ),
                {"ids": ids},
            )
        ).mappings().all()
        nome_por_id: dict[str, str] = {str(f["id"]): f["nome"] for f in fams}

        return [
            {
                "codigoCrc": u["codigoCrc"],
                "nome": nome_por_id.get(u["familiaId"], u["codigoCrc"]),
                "itensCobertos": u["itensCobertos"],
            }
            for u in usadas
        ]
    except Exception:
        return []


# ── montarResultado (réplica fiel) ────────────────────────────────────────────


def _montar_resultado(
    licitacao_id: str,
    numero: str,
    itens: list[dict[str, Any]],
    calculado_em: datetime,
    familias_habilitadas: list[dict[str, Any]],
) -> dict[str, Any]:
    atendidos = sum(1 for i in itens if i["statusCobertura"] == "ATENDIDO")
    parciais = sum(1 for i in itens if i["statusCobertura"] == "PARCIAL")
    faltantes = sum(1 for i in itens if i["statusCobertura"] == "FALTANTE")
    vence_antes = sum(1 for i in itens if i["statusCobertura"] == "VENCE_ANTES_DA_DATA")

    # Sem NENHUM item mapeado (edital não analisado) não há habilitação a cobrir —
    # estado NEUTRO SEM_DADOS, não "coberta" (evita falso verde antes da análise IA).
    if len(itens) == 0:
        semaforo = "SEM_DADOS"
    elif faltantes > 0:
        semaforo = "VERMELHO"
    elif vence_antes > 0:
        semaforo = "AMARELO"
    else:
        semaforo = "VERDE"

    return {
        "licitacaoId": licitacao_id,
        "numero": numero,
        "semaforo": semaforo,
        "totais": {
            "total": len(itens),
            "atendidos": atendidos,
            "parciais": parciais,
            "faltantes": faltantes,
            "venceAntesDaData": vence_antes,
        },
        "itens": itens,
        "familiasHabilitadas": familias_habilitadas,
        "calculadoEm": _iso(calculado_em),
    }


# ── Cofre VIGENTE indexado por subcategoria (melhor validade) ─────────────────


async def _carregar_doc_por_subcat(db) -> dict[str, dict[str, Any]]:
    """Cofre VIGENTE indexado por subcategoria, escolhendo a MELHOR validade."""
    docs = (
        await db.execute(
            text(
                """
                SELECT
                    id                       AS id,
                    titulo                   AS titulo,
                    subcategoria             AS subcategoria,
                    validade_fim             AS validade_fim,
                    validade_indeterminada   AS validade_indeterminada
                FROM documentos_habilitacao
                WHERE status = 'VIGENTE'
                  AND restrito = false
                """
                # 0034/S14 (02-APIS §16-B.3): INCONDICIONAL — o gap é agregado
                # e não há por que citar documento restrito nem p/ Conformidade.
            )
        )
    ).mappings().all()

    doc_por_subcat: dict[str, dict[str, Any]] = {}
    for d in docs:
        doc = {
            "id": str(d["id"]),
            "titulo": d["titulo"],
            "subcategoria": d["subcategoria"],
            "validadeFim": d["validade_fim"],
            "validadeIndeterminada": bool(d["validade_indeterminada"]),
        }
        subcat = doc["subcategoria"]
        atual = doc_por_subcat.get(subcat)
        if atual is None:
            doc_por_subcat[subcat] = doc
            continue
        d_fim = _as_aware_utc(doc["validadeFim"])
        a_fim = _as_aware_utc(atual["validadeFim"])
        if doc["validadeIndeterminada"] and not atual["validadeIndeterminada"]:
            doc_por_subcat[subcat] = doc
        elif (
            not atual["validadeIndeterminada"]
            and d_fim is not None
            and a_fim is not None
            and d_fim > a_fim
        ):
            doc_por_subcat[subcat] = doc
    return doc_por_subcat


# ── calcularGapHabilitacao (réplica fiel — recalcula + persiste) ──────────────


async def _calcular_gap_habilitacao(
    db, licitacao_id: str, usar_ia: bool
) -> dict[str, Any]:
    """Réplica de ``calcularGapHabilitacao``. Levanta GapNotFound se a licitação
    não existir. Persiste via DELETE + INSERTs (sem commit aqui)."""
    lic = (
        await db.execute(
            text("SELECT * FROM licitacoes WHERE id = :id LIMIT 1"),
            {"id": licitacao_id},
        )
    ).mappings().first()
    if lic is None:
        raise GapNotFound()

    data_ref = _resolver_data_referencia(
        lic["data_abertura"], lic["data_disputa"], lic["data_fim"]
    )

    # Requisitos estruturados (ordenados por ``ordem``).
    requisitos = (
        await db.execute(
            text(
                "SELECT id AS id, codigo AS codigo, descricao AS descricao "
                "FROM requisitos_edital WHERE licitacao_id = :id ORDER BY ordem"
            ),
            {"id": licitacao_id},
        )
    ).mappings().all()

    # Critérios da análise IA (texto livre).
    analise = (
        await db.execute(
            text(
                "SELECT criterios_habilitacao AS criterios FROM analises_ia "
                "WHERE licitacao_id = :id LIMIT 1"
            ),
            {"id": licitacao_id},
        )
    ).mappings().first()

    criterios_raw = analise["criterios"] if analise is not None else None
    criterios_texto: list[str] = (
        [c for c in criterios_raw if isinstance(c, str)]
        if isinstance(criterios_raw, list)
        else []
    )

    doc_por_subcat = await _carregar_doc_por_subcat(db)

    # ── Match por CÓDIGO ──────────────────────────────────────────────────────
    itens: list[dict[str, Any]] = []
    ambiguos: list[dict[str, Any]] = []

    for req in requisitos:
        codigo = req["codigo"]
        match_por_codigo = (codigo in doc_por_subcat) or (codigo in _SUBCATEGORIAS_SET)
        if match_por_codigo:
            status_cob, doc = _classificar_cobertura(codigo, doc_por_subcat, data_ref)
            itens.append(
                {
                    "requisitoId": str(req["id"]),
                    "requisitoCodigo": codigo,
                    "descricao": req["descricao"],
                    "statusCobertura": status_cob,
                    "documentoId": doc["id"] if doc else None,
                    "documentoTitulo": doc["titulo"] if doc else None,
                    "venceEm": _iso(doc["validadeFim"]) if doc else None,
                    "metodoMatch": "CODIGO",
                    "confianca": 1,
                    "justificativa": (
                        f"Match por código ({codigo})."
                        if doc
                        else f"Sem documento VIGENTE para {codigo}."
                    ),
                }
            )
        else:
            ambiguos.append({"descricao": req["descricao"], "requisitoId": str(req["id"])})

    # Critérios da IA sem requisito estruturado também entram como ambíguos.
    descricoes_req = {r["descricao"] for r in requisitos}
    for crit in criterios_texto:
        if crit in descricoes_req:
            continue
        ambiguos.append({"descricao": crit, "requisitoId": None})

    # ── Match por IA nos ambíguos ─────────────────────────────────────────────
    resolucao = (
        await _resolver_ambiguos_com_ia([a["descricao"] for a in ambiguos])
        if usar_ia
        else {}
    )

    for amb in ambiguos:
        r = resolucao.get(amb["descricao"])
        subcat = r["subcategoria"] if r else None
        status_cob, doc = _classificar_cobertura(subcat, doc_por_subcat, data_ref)
        itens.append(
            {
                "requisitoId": amb["requisitoId"],
                "requisitoCodigo": subcat,
                "descricao": amb["descricao"],
                "statusCobertura": status_cob if subcat else "FALTANTE",
                "documentoId": doc["id"] if doc else None,
                "documentoTitulo": doc["titulo"] if doc else None,
                "venceEm": _iso(doc["validadeFim"]) if doc else None,
                "metodoMatch": "IA",
                "confianca": (r["confianca"] if r else 0),
                "justificativa": (
                    r["justificativa"]
                    if r
                    else "Requisito ambíguo, sem mapeamento de subcategoria."
                ),
            }
        )

    # ── Persistência (delete + inserts) ───────────────────────────────────────
    calculado_em = datetime.now(tz=timezone.utc)

    await db.execute(
        text("DELETE FROM gap_habilitacao WHERE licitacao_id = :id"),
        {"id": licitacao_id},
    )

    for it in itens:
        await db.execute(
            text(
                """
                INSERT INTO gap_habilitacao
                    (licitacao_id, requisito_id, requisito_codigo, status_cobertura,
                     documento_id, familia_id, vence_em, metodo_match, confianca,
                     justificativa, calculado_em)
                VALUES
                    (:licitacao_id, :requisito_id, :requisito_codigo, :status_cobertura,
                     :documento_id, NULL, :vence_em, :metodo_match, :confianca,
                     :justificativa, :calculado_em)
                """
            ),
            {
                "licitacao_id": licitacao_id,
                "requisito_id": it["requisitoId"],
                "requisito_codigo": it["requisitoCodigo"],
                "status_cobertura": it["statusCobertura"],
                "documento_id": it["documentoId"],
                "vence_em": it["venceEm"],
                "metodo_match": it["metodoMatch"],
                "confianca": it["confianca"],
                "justificativa": it["justificativa"],
                "calculado_em": calculado_em,
            },
        )

    await db.commit()

    familias_habilitadas = await _computar_familias_habilitadas(db, licitacao_id)
    return _montar_resultado(
        str(lic["id"]), lic["numero"], itens, calculado_em, familias_habilitadas
    )


# ── getGapHabilitacao (réplica fiel — lê o materializado) ─────────────────────


async def _get_gap_habilitacao(db, licitacao_id: str) -> dict[str, Any] | None:
    """Réplica de ``getGapHabilitacao``. Levanta GapNotFound se a licitação não
    existir; retorna None se NUNCA foi calculado."""
    lic = (
        await db.execute(
            text("SELECT id AS id, numero AS numero FROM licitacoes WHERE id = :id LIMIT 1"),
            {"id": licitacao_id},
        )
    ).mappings().first()
    if lic is None:
        raise GapNotFound()

    rows = (
        await db.execute(
            text(
                """
                SELECT
                    requisito_id      AS requisito_id,
                    requisito_codigo  AS requisito_codigo,
                    status_cobertura  AS status_cobertura,
                    documento_id      AS documento_id,
                    vence_em          AS vence_em,
                    metodo_match      AS metodo_match,
                    confianca         AS confianca,
                    justificativa     AS justificativa,
                    calculado_em      AS calculado_em
                FROM gap_habilitacao
                WHERE licitacao_id = :id
                """
            ),
            {"id": licitacao_id},
        )
    ).mappings().all()

    if len(rows) == 0:
        return None

    # Títulos de documentos p/ exibição.
    doc_ids = [str(r["documento_id"]) for r in rows if r["documento_id"]]
    titulos: dict[str, str] = {}
    if len(doc_ids) > 0:
        docs = (
            await db.execute(
                text(
                    # 0034/S14: título de restrito não sai no gap (incondicional).
                    "SELECT id AS id, titulo AS titulo FROM documentos_habilitacao "
                    "WHERE id = ANY(CAST(:ids AS uuid[])) AND restrito = false"
                ),
                {"ids": doc_ids},
            )
        ).mappings().all()
        for d in docs:
            titulos[str(d["id"])] = d["titulo"]

    # Descrição REAL do requisito (por id; fallback por código escopado à licitação).
    requisitos_lic = (
        await db.execute(
            text(
                "SELECT id AS id, codigo AS codigo, descricao AS descricao "
                "FROM requisitos_edital WHERE licitacao_id = :id"
            ),
            {"id": licitacao_id},
        )
    ).mappings().all()

    desc_por_req_id: dict[str, str] = {}
    desc_por_codigo: dict[str, str] = {}
    for r in requisitos_lic:
        desc_por_req_id[str(r["id"])] = r["descricao"]
        # Primeiro requisito por código vence (fallback).
        if r["codigo"] not in desc_por_codigo:
            desc_por_codigo[r["codigo"]] = r["descricao"]

    itens: list[dict[str, Any]] = []
    for r in rows:
        req_id = str(r["requisito_id"]) if r["requisito_id"] else None
        req_codigo = r["requisito_codigo"]
        doc_id = str(r["documento_id"]) if r["documento_id"] else None
        # Cadeia de ?? do Next: só cai p/ o próximo se o anterior for None/undefined
        # (string vazia "" é valor válido e short-circuita, igual ao JS).
        descricao_real = desc_por_req_id.get(req_id) if req_id else None
        if descricao_real is None:
            descricao_real = desc_por_codigo.get(req_codigo) if req_codigo else None
        if descricao_real is None:
            descricao_real = r["justificativa"]
        if descricao_real is None:
            descricao_real = req_codigo
        if descricao_real is None:
            descricao_real = ""

        itens.append(
            {
                "requisitoId": req_id,
                "requisitoCodigo": req_codigo,
                "descricao": descricao_real,
                "statusCobertura": r["status_cobertura"],
                "documentoId": doc_id,
                "documentoTitulo": (titulos.get(doc_id) if doc_id else None),
                "venceEm": _iso(r["vence_em"]),
                "metodoMatch": r["metodo_match"],
                "confianca": r["confianca"],
                "justificativa": r["justificativa"],
            }
        )

    calculado_em = rows[0]["calculado_em"] or datetime.now(tz=timezone.utc)
    familias_habilitadas = await _computar_familias_habilitadas(db, licitacao_id)
    return _montar_resultado(
        str(lic["id"]), lic["numero"], itens, calculado_em, familias_habilitadas
    )


# ══════════════════════════════════════════════════════════════════════════════
# GET — lê o gap materializado (sem recalcular)
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/licitacoes/{id}/gap-habilitacao")
async def get_gap_habilitacao(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET: lê o gap materializado. Guard: require_visualizar (401/403 antes do ID).

    Ordem: guard -> UUID inválido? 400 -> getGap -> 200 {data}
           | GapNotFound -> 404 {error:{code,message}}.
    """
    # Validação do ID (espelha o UUID_REGEX.test do route.ts).
    if not _UUID_REGEX.match(id):
        return JSONResponse(status_code=400, content={"error": "ID inválido"})

    try:
        data = await _get_gap_habilitacao(db, id)
    except GapNotFound:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Licitação não encontrada"}},
        )
    # data === null => nunca calculado ainda (UI mostra CTA "Calcular gap").
    return JSONResponse(content={"data": data})


# ══════════════════════════════════════════════════════════════════════════════
# POST — recalcula (Claude só nos requisitos ambíguos)
# ══════════════════════════════════════════════════════════════════════════════
@router.post("/api/licitacoes/{id}/gap-habilitacao")
async def post_gap_habilitacao(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_propor),
    db=Depends(get_db),
) -> JSONResponse:
    """POST: recalcula + persiste. Guard: require_propor (401/403 antes do ID).

    Ordem: guard -> UUID inválido? 400 -> body.usarIA (default true)
           -> calcularGap -> 200 {data}
           | GapNotFound -> 404 {error:{code,message}}
           | erro inesperado -> 500 {error:"Erro interno"}.
    """
    # Validação do ID (espelha o UUID_REGEX.test do route.ts).
    if not _UUID_REGEX.match(id):
        return JSONResponse(status_code=400, content={"error": "ID inválido"})

    # body = await req.json().catch(() => ({})); usarIA = body.usarIA !== false.
    try:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
    except Exception:
        body = {}
    usar_ia = body.get("usarIA") is not False  # default true; só desliga se === false

    try:
        data = await _calcular_gap_habilitacao(db, id, usar_ia)
    except GapNotFound:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Licitação não encontrada"}},
        )
    except Exception:
        # log.error("Falha ao calcular gap de habilitação", e) -> 500 {error:"Erro interno"}.
        return JSONResponse(status_code=500, content={"error": "Erro interno"})

    return JSONResponse(content={"data": data})
