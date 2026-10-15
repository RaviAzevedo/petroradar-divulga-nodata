"""Rota migrada (estrangulador): POST /api/acervo/buscar.

Equivalente 1:1 do handler ``POST`` de
``src/app/api/acervo/buscar/route.ts`` (busca semântica / RAG sobre o acervo
técnico e editais). A rota Next é READ-ONLY: NÃO há GET/PUT/PATCH/DELETE e
NENHUMA escrita no banco (apenas SELECT k-NN). Esta porta replica isso.

Guard Next:
    ``requireAcervo()`` → sessão válida + ``podeVisualizar`` (todos os papéis
    exceto EXTERNO). 401 se não houver sessão; 403 se EXTERNO.
    Equivalente BFF: :data:`app.core.security.require_acervo` (== ``require_visualizar``,
    ambos = ``ROLES_VISUALIZAR``). Falha de auth/perm é tratada PELA dependency
    (HTTPException 401/403), exatamente como o ``requireAcervo`` do Next dispara
    ``ApiError`` ANTES de qualquer lógica de negócio.

Fluxo (idêntico ao Next, MESMA ordem):
    1. requireAcervo (dependency) — gate de papel.
    2. Gate gracioso: se RAG desabilitado (FEATURE_ACERVO_RAG) OU provider de
       embeddings indisponível → 200 ``{disponivel:false, motivo, resposta:null,
       fontes:[], trechos:[]}``.
    3. Rate limit por usuário (``acervo-buscar:<id>``, max 30 / 60s) → 429
       ``{error:"...", code:"RATE_LIMITED"}``.
    4. Lê o body JSON e valida (pergunta 3..2000; origemTipo enum[]; licitacaoId
       uuid; topK int 1..20). Falha → 422 ``{error:"<msg>", code:"VALIDATION"}``.
    5. Embedding da pergunta (tipo "query").
    6. ``buscar_chunks_similares`` — k-NN por cosseno (<=>) + filtros + corte de
       similaridade mínima (config.acervo.* → settings).
    7. assertAcessoObjeto(podeVisualizar) — anti-IDOR (sempre true para interno).
    8. 0 chunks → 200 ``{disponivel:true, resposta:"Não encontrei...", fontes:[],
       trechos:[]}``.
    9. Monta contexto/fontes/trechos.
   10. IA bloqueada/indisponível (``ia_permitida("acervo-busca")`` — trava de IA em
       services/anthropic.py; cobre também ANTHROPIC_API_KEY ausente) → 200
       ``{disponivel:true, resposta:null, motivo, fontes, trechos}`` (devolve os
       trechos sem síntese). Na prática este é HOJE o caminho SEMPRE tomado: a
       síntese RAG está fora da allowlist por decisão de produto.
   11. Síntese via Claude (MESMO modelo Haiku, MESMA INSTRUCAO_SISTEMA e MESMO
       formato de mensagem do Next; NÃO usa anthropic.sintetizar_resposta porque
       aquele helper usa Sonnet e outro prompt). INALCANÇÁVEL enquanto o módulo
       estiver bloqueado. Sucesso → 200 ``{disponivel:true, resposta, fontes,
       trechos, _meta}``. Falha → 200 ``{disponivel:true, resposta:null, motivo,
       fontes, trechos}``.

Shape de erro: o ``handleApiError`` do Next serializa ``ApiError`` como
``{ "error": <message>, "code": <code> }`` (FLAT, não aninhado). Replicamos esse
shape exato nos 422/429.

Serialização paritária: datetime → ``.isoformat()``; uuid → ``str()``; numeric →
número nativo; jsonb → dict/list nativo. As colunas projetadas aqui (origem_id,
licitacao_id) são uuid → str; metadata é jsonb → dict/list; chunk_index é int;
similaridade é float (arredondado a 3 casas no shape, igual ao Next).
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.rate_limit import check_rate_limit
from app.core.security import CurrentUser, pode_visualizar, require_acervo
from app.routers.migrated._pii import redigir_pii
from app.db.session import get_db
from app.routers.migrated._restrito import (
    is_conformidade as _restrito_is_conformidade,
)
from app.services import anthropic as anthropic_svc
from app.services import embeddings as embeddings_svc

router = APIRouter()

# ── Constantes de validação (espelham o bodySchema zod do route.ts) ───────────
ORIGENS: tuple[str, ...] = ("ANEXO_EDITAL", "DOC_HABILITACAO", "PROJETO")

_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Instrução estática (cacheável) — cópia EXATA do INSTRUCAO_SISTEMA do route.ts.
# (Difere intencionalmente do prompt de anthropic.sintetizar_resposta, que usa
# Sonnet + delimitador <documento_nao_confiavel>. Para paridade 1:1 com a rota
# Next replicamos o prompt/modelo/formato de mensagem DELA.)
_INSTRUCAO_SISTEMA = (
    "Você é um assistente de pesquisa do acervo técnico da empresa proponente "
    "(óleo & gás / Petrobras).\n\n"
    "Responda à pergunta do usuário usando EXCLUSIVAMENTE os trechos de contexto "
    "fornecidos. Cada trecho vem rotulado com um número entre colchetes (ex.: "
    "[1], [2]).\n\n"
    "Regras:\n"
    "- Cite SEMPRE a origem das afirmações usando os números dos trechos, ex.: "
    '"... conforme o atestado [2]".\n'
    "- NÃO invente dados que não estejam no contexto. Se o contexto for "
    "insuficiente, diga claramente que não encontrou a informação no acervo.\n"
    "- Seja objetivo e técnico; responda em português do Brasil.\n"
    "- Quando houver datas/validades/valores, transcreva-os fielmente do trecho "
    "citado."
)


# ── Helpers de erro (shape do handleApiError do Next: {error, code}, FLAT) ─────


def _erro(status: int, code: str, message: str) -> JSONResponse:
    """Replica ``ApiError`` → ``handleApiError`` do Next: ``{error, code}``."""
    return JSONResponse(status_code=status, content={"error": message, "code": code})


# ── Gate gracioso: RAG habilitado? (espelha config.acervo.habilitado) ─────────


def _rag_habilitado() -> bool:
    """Espelha ``config.acervo.habilitado`` do Next.

    No Next: ``flag(FEATURE_ACERVO_RAG, true) && embeddingDisponivel``. Aqui o
    flag default é ligado; ``embeddings_disponivel()`` cobre o provider. A rota
    Next ainda checa ``embeddingsDisponivel()`` separadamente — o OR resultante é
    equivalente a "RAG ligado E provider disponível".
    """
    raw = str(getattr(settings, "feature_acervo_rag", "")).strip().lower()
    if raw in ("false", "0", "off", "no"):
        flag_ligado = False
    else:
        # Default ligado (igual a flag(..., true) do Next): vazio/ausente = true.
        flag_ligado = True
    return flag_ligado and embeddings_svc.embeddings_disponivel()


# ── Validação do body (espelha bodySchema.safeParse + primeira issue) ─────────


def _validar_body(json: Any) -> tuple[dict | None, str | None]:
    """Valida o corpo igual ao zod do Next. Retorna (dados, msg_erro).

    Mensagens de erro replicam as do zod (primeira issue):
      - corpo não-objeto / pergunta ausente → "Required" / mensagens de tipo.
    Mantemos mensagens curtas equivalentes; o importante para paridade de
    contrato é o status 422 + ``code:"VALIDATION"`` + ``{error:<msg>}``.
    """
    if not isinstance(json, dict):
        return None, "Corpo inválido"

    # pergunta: string, min 3, max 2000 (obrigatória).
    pergunta = json.get("pergunta")
    if not isinstance(pergunta, str):
        return None, "Required"
    if len(pergunta) < 3:
        return None, "String must contain at least 3 character(s)"
    if len(pergunta) > 2000:
        return None, "String must contain at most 2000 character(s)"

    # origemTipo?: array de enum(ORIGENS).
    origem_tipo = json.get("origemTipo")
    if origem_tipo is not None:
        if not isinstance(origem_tipo, list):
            return None, "Expected array, received " + type(origem_tipo).__name__
        for t in origem_tipo:
            if t not in ORIGENS:
                return None, (
                    "Invalid enum value. Expected "
                    + " | ".join(f"'{o}'" for o in ORIGENS)
                )

    # licitacaoId?: uuid.
    licitacao_id = json.get("licitacaoId")
    if licitacao_id is not None:
        if not isinstance(licitacao_id, str) or not _UUID_REGEX.match(licitacao_id):
            return None, "Invalid uuid"

    # topK?: int, min 1, max 20.
    #
    # zod v4: z.number().int() usa Number.isInteger(). Em JS, JSON "5.0" vira o
    # número 5 (indistinguível de 5), e Number.isInteger(5.0) é true → ACEITO.
    # Em Python, json.loads("5.0") -> float 5.0; por isso coagimos floats
    # inteiro-valorados para int (paridade), mantendo a rejeição de não-inteiros
    # genuínos (5.5) e booleanos.
    # Filtros de metadado. Listas fechadas onde o valor tem enum no banco;
    # `desde` e ano inteiro. Valor invalido vira 422, nunca SQL.
    detentora = json.get("detentora")
    if detentora is not None:
        if not isinstance(detentora, list) or not all(
            isinstance(x, str) and x in ("PROPONENTE", "COLIGADA", "PARCEIRO")
            for x in detentora
        ):
            return None, "detentora: esperado lista de PROPONENTE|COLIGADA|PARCEIRO"
        detentora = detentora or None

    tipo_doc = json.get("tipoDocumento")
    if tipo_doc is not None:
        if not isinstance(tipo_doc, list) or not all(
            isinstance(x, str) and 1 <= len(x) <= 40 and x.replace("_", "").isalnum()
            for x in tipo_doc
        ):
            return None, "tipoDocumento: esperado lista de identificadores"
        tipo_doc = tipo_doc or None

    desde = json.get("desde")
    if desde is not None:
        if isinstance(desde, bool) or not isinstance(desde, int):
            return None, "desde: esperado ano inteiro"
        if not (1990 <= desde <= 2100):
            return None, "desde: fora do intervalo 1990..2100"

    top_k = json.get("topK")
    if top_k is not None:
        if isinstance(top_k, bool):
            return None, "Expected number, received boolean"
        if isinstance(top_k, float):
            if top_k.is_integer():
                top_k = int(top_k)  # 5.0 -> 5 (igual ao Next via Number.isInteger)
            else:
                # 5.5: zod v4 rejeita com a issue de inteiro.
                return None, "Expected int, received number"
        elif not isinstance(top_k, int):
            return None, "Expected number, received " + type(top_k).__name__
        if top_k < 1:
            return None, "Number must be greater than or equal to 1"
        if top_k > 20:
            return None, "Number must be less than or equal to 20"

    return (
        {
            "pergunta": pergunta,
            "origemTipo": origem_tipo,
            "licitacaoId": licitacao_id,
            "topK": top_k,
            "detentora": detentora,
            "tipoDocumento": tipo_doc,
            "desde": desde,
        },
        None,
    )


# ── Retrieval k-NN (porta de buscarChunksSimilares de retrieval.ts) ───────────


def _config_top_k() -> int:
    return int(getattr(settings, "acervo_top_k", 8))


def _config_sim_min() -> float:
    return float(getattr(settings, "acervo_similaridade_min", 0.35))


# ── Sanitização da pergunta para o lado TEXTUAL ───────────────────────────────
#
# websearch_to_tsquery tem sintaxe de operador, e texto de edital colado no campo
# de busca a dispara sem querer. Medido no parser do PostgreSQL 16.14:
#
#   " - ABCD"   → !'abcd'    o "-" vira NOT quando NÃO está colado a um
#                            alfanumérico à esquerda (espaço, início, "(", tab)
#   '"'         → <-> (frase); aspa ÍMPAR faz frase até o fim da string
#   "or"/"OR"   → | (OR), quando token solto entre operandos
#   & | ! < > ( ) :* e "and" NÃO são operadores aqui — viram pontuação
#
# O caso típico: "Refinaria Exemplo - ABCD - Município … - UF" virava
# `… & !'abcd' & !'municipi' & … & !'uf' & …`, ou seja, o braço estrito EXCLUÍA
# os três termos que identificam a refinaria e devolvia 0 chunks.
#
# TRÊS CUIDADOS QUE CUSTARAM MEDIÇÃO:
#
# 1. As classes são UNICODE, não ASCII. O `f_unaccent` roda DENTRO do SQL, DEPOIS
#    desta função, e converte 15 codepoints de travessão para "-" e 9 de aspa
#    para '"'. Tratar só o ASCII não conserta nada para texto vindo de Word ou
#    PDF — e o golden set do benchmark já traz U+2014 na maioria das perguntas
#    de identificador.
#
# 2. A ordem é ASPAS → OR → HÍFEN. Remover o "or" DEPOIS do hífen CRIA negação
#    que não existia: "alfa or-beta" (que o parser lê como frase) viraria
#    "alfa -beta" = `'alfa' & !'bet'`.
#
# 3. O "-" COLADO à esquerda é INTOCÁVEL. "contrato PJ-1234567" indexa como
#    'contrat' + 'pj' + '-1234567' — o hífen fica DENTRO do lexema. Trocá-lo por
#    espaço geraria '1234567', que não casa com o '-1234567' do índice, e mataria
#    o caso "identificador" (hoje 83% de hit@10). Mesma coisa em U-10, P-00,
#    Cidade-UF, pré-operação e 11.222.333/0001-81.
#
# Espelho exato de sanitizarWebsearch() em app/src/lib/acervo/retrieval.ts:
# 0 divergências em 55 casos de borda, U+FEFF incluído.
_RE_ASPAS = re.compile("[\"\u02BA\u201C\u201D\u201F\u2033\u301D\u301E\uFF02]")
_RE_OR_OPERADOR = re.compile(r"(^|[\s(])[oO][rR](?=[\s)]|$)")
_RE_HIFEN_OPERADOR = re.compile(
    "(^|[^0-9A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF])"
    "[\\-\u00AD\u02D7\u2010\u2011\u2012\u2013\u2014\u2015\u2212"
    "\uFE31\uFE32\uFE58\uFE63\uFF0D]+"
)
_RE_ESPACOS = re.compile("[\\s\uFEFF]+")
_BRANCOS = " \t\n\r\f\v\u00a0\ufeff"


def _sanitizar_websearch(pergunta: str) -> str:
    """Neutraliza a SINTAXE de websearch_to_tsquery sem tocar no CONTEÚDO.

    Só o lado textual usa isto. O embedding é gerado da pergunta CRUA, antes —
    sanitizar o texto que vai ao modelo mudaria a semântica sem motivo.
    """
    v = pergunta or ""
    v = _RE_ASPAS.sub(" ", v)
    v = _RE_OR_OPERADOR.sub(r"\1 ", v)
    v = _RE_HIFEN_OPERADOR.sub(r"\1 ", v)
    return _RE_ESPACOS.sub(" ", v).strip(_BRANCOS)


def _vetor_para_literal(vetor: list[float]) -> str:
    """Serializa o vetor TS->literal pgvector ("[a,b,c]"), só números finitos."""
    nums: list[float] = []
    for v in vetor:
        n = float(v)
        if n != n or n in (float("inf"), float("-inf")):  # NaN/Inf
            raise ValueError("Embedding contém valor não-numérico")
        nums.append(n)
    return "[" + ",".join(repr(n) for n in nums) + "]"


# Reciprocal Rank Fusion: score = Σ 1/(K + posição). K amortece o topo — sem
# ele o 1º lugar de uma lista domina o 2º de outra. 60 é o valor do artigo
# original (Cormack et al.) e o que a maioria das implementações usa.
_RRF_K = 60
# Candidatos por lado antes da fusão.
#
# ⚠️ 60 ERA UM TETO QUE NUNCA CHEGAVA A VALER (medido). O braço
# vetorial é servido por um índice HNSW, e o pgvector limita o número de linhas
# que o scan devolve a `hnsw.ef_search` — cujo DEFAULT é 40. Pedindo LIMIT 60 o
# índice entregava ~44; pedindo LIMIT 200 entregava as MESMAS ~44. Ou seja: o
# braço vetorial rodava a 70% da largura que o código pensava ter, e aumentar
# esta constante sozinha não mudava nada.
_CANDIDATOS_DEFAULT = 120

# Teto de exploração do grafo HNSW por consulta.
#
# Precisa ser >= ao LIMIT do braço vetorial, senão ele trunca em silêncio. E o
# efeito na QUALIDADE é grande, não marginal: medido contra
# o golden set do benchmark de RAG (40 perguntas), o braço vetorial isolado achava
# o documento certo em 16 das 40 com ef=40, e em 26 das 40 com ef=400 —
# documentos que são a 1ª posição do ranking exato simplesmente não voltavam.
#
# Ponta a ponta, na consulta híbrida completa:
#
#   ef=40  cand=60    hit@5 75%  hit@10 85%  MRR 0,636   mediana 446 ms
#   ef=200 cand=120   hit@5 82%  hit@10 88%  MRR 0,691   mediana 436 ms
#   ef=400 cand=120   hit@5 85%  hit@10 90%  MRR 0,745   mediana 474 ms
#
# O custo é ~7 ms no scan (EXPLAIN confirma Index Scan em 9 ms a ef=400 com
# LIMIT 120) porque o índice inteiro cabe em cache (o HNSW é menor que o
# shared_buffers, acerto de cache ~100%). Num host com menos memória este número
# precisa ser remedido antes de subir.
#
# NÃO desfaça a nota antiga de que "calibrar ef_search é perda de tempo" sem
# medir: ela foi escrita a partir do ranking EXATO (enable_indexscan=off), que
# de fato mostra o trecho certo na posição 46-130. O que ela não viu é que, com
# ef=40, o índice nem chega a devolver 60 linhas.
_EF_SEARCH_DEFAULT = 400


# Orçamento de custo do braço AMPLO, em CHUNKS (migração 0039).
#
# ts_rank_cd pesa frequência e proximidade mas NÃO raridade, e o Postgres não tem
# IDF nativo — então quem tem de pesar raridade é a SELEÇÃO dos termos. Os
# lexemas da pergunta entram do mais raro para o mais comum enquanto a soma dos
# `ndoc` couber aqui; `sum(ndoc)` é o teto da união das posting lists, que é o
# custo real do braço.
#
# O corte fixo de 20% da 0037 não bastava: em "Refinaria Exemplo - ABCD -
# … escritórios da PETROBRAS …", vários lexemas comuns (cada um no limite ou
# abaixo dos 20%) passavam um a um, e juntos casavam a maior parte do índice
# — 1,7 a 2,2 s de busca.
#
# 12.000 chunks é uma fração minoritária do índice, calibrada contra as 40
# perguntas do golden set: 12k e 14k mantêm hit@10 em 36/40; 16k cai para 35 (o braço amplo
# largo demais afoga o identificador) e 10k também cai para 35. O joelho é
# estreito. RECALIBRAR quando o acervo mudar de tamanho — o orçamento é absoluto
# porque o que ele limita é o número de chunks varridos.
_ORCAMENTO_AMPLA_DEFAULT = 12_000


def _config_orcamento_ampla() -> int:
    return max(1, int(getattr(settings, "acervo_orcamento_ampla",
                              _ORCAMENTO_AMPLA_DEFAULT)))


def _config_candidatos() -> int:
    """Candidatos por braço. Clampeado para não pedir mais do que o ef permite."""
    return max(1, min(500, int(getattr(settings, "acervo_candidatos", _CANDIDATOS_DEFAULT))))


def _config_ef_search() -> int:
    """hnsw.ef_search da consulta. Sempre >= candidatos, senão trunca em silêncio."""
    # Clampeado a [candidatos, 1000]: 1000 é o teto do pgvector, e o piso
    # garante que o braço vetorial nunca trunque abaixo do que foi pedido.
    return max(
        _config_candidatos(),
        min(1000, int(getattr(settings, "acervo_ef_search", _EF_SEARCH_DEFAULT))),
    )


async def _buscar_chunks_similares(
    db: Any, embedding: list[float], filtro: dict, role: str,
    pergunta: str = "",
) -> list[dict]:
    """Busca HÍBRIDA em acervo_chunks: vetor + texto, fundidos por RRF.

    POR QUE HÍBRIDA
    ───────────────
    O k-NN puro foi medido contra o golden set do benchmark de RAG e deu hit@10 de
    30%. O recorte mostra onde: 35% em pergunta semântica, 17% em identificador
    (número de contrato, sigla de unidade), 38% em citação literal do documento.
    Nesse último caso, o chunk que CONTÉM a frase citada aparece na posição exata
    46 a 130 — dezenas de trechos são mais próximos de uma citação do que o
    próprio trecho citado. Não é falta de recall do HNSW (conferido com
    enable_indexscan=off); é o bi-encoder não discriminando: entre a 1ª e a 20ª
    posição há 0,03 a 0,07 de similaridade.

    O texto cobre exatamente esse buraco, e o inverso também vale — full-text
    puro devolve 0 para "tubulação industrial refinaria" porque tsquery faz AND.
    Um resgata o outro; nenhum substitui.

    A ordenação passa a ser por RRF. `similaridade` continua no retorno porque a
    tela a exibe, mas ela deixou de ser o critério de ordem.

    topK segue clampeado a [1, 50]; `similaridadeMinima` continua aplicada no
    código pelo chamador.
    """
    top_k_req = filtro.get("topK")
    top_k = max(1, min(50, top_k_req if top_k_req is not None else _config_top_k()))
    sim_min_req = filtro.get("similaridadeMinima")
    sim_min = sim_min_req if sim_min_req is not None else _config_sim_min()
    candidatos = _config_candidatos()
    ef_search = _config_ef_search()
    orcamento_ampla = _config_orcamento_ampla()

    literal = _vetor_para_literal(embedding)

    # Condições. licitacao_id como bind param; origem_tipo como ARRAY literal
    # (valores restritos ao enum, validados no body) — mesmo padrão do TS.
    where = "c.embedding IS NOT NULL"
    params: dict[str, Any] = {}

    origem_tipo = filtro.get("origemTipo")
    if origem_tipo:
        # Enum fechado (validado): monta ARRAY['...','...'] com escape de aspas.
        arr = ",".join("'" + str(t).replace("'", "''") + "'" for t in origem_tipo)
        where += f" AND c.origem_tipo = ANY(ARRAY[{arr}])"

    # Filtros de metadado — todos via EXISTS no documento, para não alterar a
    # cardinalidade das CTEs de candidatos (um JOIN aqui duplicaria linhas).
    detentora = filtro.get("detentora")
    if detentora:
        arr = ",".join("'" + str(x).replace("'", "''") + "'" for x in detentora)
        where += (
            " AND EXISTS (SELECT 1 FROM documentos_habilitacao d2"
            " LEFT JOIN operacoes o2 ON o2.id = d2.operacao_id"
            f" WHERE d2.id = c.origem_id"
            f" AND coalesce(o2.detentora, d2.detentora) = ANY(ARRAY[{arr}]))"
        )

    tipo_doc = filtro.get("tipoDocumento")
    if tipo_doc:
        arr = ",".join("'" + str(x).replace("'", "''") + "'" for x in tipo_doc)
        where += (
            " AND EXISTS (SELECT 1 FROM documentos_habilitacao d3"
            f" WHERE d3.id = c.origem_id"
            f" AND d3.tipo_documento = ANY(ARRAY[{arr}]))"
        )

    desde = filtro.get("desde")
    if desde:
        where += (
            " AND EXISTS (SELECT 1 FROM documentos_habilitacao d4"
            " LEFT JOIN operacoes o4 ON o4.id = d4.operacao_id"
            " WHERE d4.id = c.origem_id"
            " AND coalesce(o4.periodo_fim, o4.periodo_inicio, d4.emitido_em::date)"
            "     >= make_date(:desde, 1, 1))"
        )
        params["desde"] = int(desde)

    licitacao_id = filtro.get("licitacaoId")
    if licitacao_id:
        where += " AND c.licitacao_id = :licitacao_id"
        params["licitacao_id"] = licitacao_id

    # 0034/S16 (02-APIS §16-B.3): predicado restrito no cruzamento com
    # documentos_habilitacao — defesa em profundidade (S15 garante que restrito
    # nunca é indexado; se um chunk órfão sobrar de antes da marcação, ele não
    # sai daqui para papel fora de Conformidade).
    where += (
        " AND NOT (c.origem_tipo = 'DOC_HABILITACAO' AND EXISTS ("
        "SELECT 1 FROM documentos_habilitacao d "
        "WHERE d.id = c.origem_id "
        "AND NOT (d.restrito = false OR :is_conformidade)))"
    )
    params["is_conformidade"] = _restrito_is_conformidade(role)

    # Só o lado TEXTUAL. O embedding já foi gerado da pergunta CRUA, na rota,
    # antes desta função — sanitizar o texto que vai ao modelo mudaria a
    # semântica sem necessidade.
    params["pergunta"] = _sanitizar_websearch(pergunta)

    # O vetor entra como literal seguro ('[...]'::vector) — sem binding nativo.
    # `vetorial` e `textual` produzem POSIÇÕES; `fundido` soma os recíprocos.
    # FULL OUTER JOIN porque um chunk pode vir só de um dos lados — é o ponto:
    # o texto resgata identificador que o vetor perdeu, e vice-versa.
    sql = text(
        f"""
        WITH consulta AS (
            -- DUAS consultas textuais, porque uma só não serve às duas perguntas.
            --
            -- `estrita` (AND, como o websearch entrega): exige todos os termos.
            -- É o que acerta identificador — "Contrato 1234.0001111.17.2" casa
            -- poucos trechos e todos certos. Medido: 75% de hit@10 em pergunta
            -- de identificador.
            --
            -- `ampla` (& trocado por | no tsquery já parseado, o que preserva
            -- stemming e stopwords): basta um termo. É o que acerta linguagem
            -- natural, onde exigir todas as palavras não encontra nada. Medido:
            -- 90% de hit@10 em pergunta semântica.
            --
            -- Sozinhas elas se anulam: com AND a semântica cai para 60%; com OR
            -- o identificador desaba para 17%, porque "contrato" e "documentos"
            -- aparecem em milhares de trechos e o ts_rank_cd, que pesa
            -- frequência e proximidade mas NÃO raridade, afoga o número. Rodar
            -- as duas e fundir tudo por RRF fica com o melhor das duas.
            SELECT websearch_to_tsquery('portuguese',
                     f_unaccent(coalesce(:pergunta, ''))) AS estrita
        ),
        -- Quebra o tsquery JA PARSEADO em lexemas, para poder podar. Parsear
        -- no Postgres e filtrar aqui preserva stemming e stopwords do
        -- portugues; montar a query na mao perderia os dois.
        termos AS (
            -- Extrai APENAS os lexemas do tsquery JA PARSEADO. Em tsquery::text
            -- todo lexema sai entre aspas simples e todo operador (& | ! <-> <N>
            -- parenteses) sai FORA delas; pegar so o miolo das aspas descarta
            -- operador POR CONSTRUCAO.
            --
            -- A versao anterior quebrava so em ' & ' e por isso (a) colava o "!"
            -- no lexema, gerando o literal '!abcd' que casa 0 chunks, e (b)
            -- colapsava frase inteira num lexema unico com espacos dentro
            -- ('11.222.333 <-> /0001-81'). Medido nas 40 perguntas do golden:
            -- 21 lexemas mortos em 10 perguntas.
            --
            -- O '''' do replace desdobra a aspa escapada que o proprio Postgres
            -- gera quando o lexema contem aspa simples.
            SELECT replace(m[1], '''''', '''') AS lexema
              FROM consulta,
                   regexp_matches(consulta.estrita::text,
                                  '''((?:[^'']|'''')*)''', 'g') AS m
        ),
        -- ORCAMENTO DE RARIDADE (migracao 0039). Os termos entram do mais raro
        -- para o mais comum enquanto a soma dos ndoc couber no orcamento.
        --
        -- ndoc = 0 e lexema que NAO existe no acervo (OCR torto, termo de outro
        -- dominio): custa nada, casa nada, entra de graca — e a rede de
        -- seguranca para tabela desatualizada, que assim degrada para "AMPLA
        -- mais larga" e nunca para "AMPLA que perde termo raro".
        --
        -- PISO: o termo mais raro tem a PRIMEIRA reivindicacao do orcamento,
        -- entao K=1 e implicito e nao precisa de clausula. Se nem ele cabe
        -- (pergunta so de palavra ultracomum, "contrato de prestacao de
        -- servicos"), `ampla` sai NULA e o braco desliga — mesmo comportamento
        -- da 0037. Piso incondicional foi MEDIDO e e nocivo: ligaria o braco em
        -- "contrato", que casa quase todos os chunks do indice.
        termos_df AS (
            -- GROUP BY obrigatorio: sem ele um lexema repetido na pergunta
            -- contaria o custo duas vezes no orcamento.
            SELECT t.lexema, coalesce(max(d.ndoc), 0) AS ndoc
              FROM termos t
              LEFT JOIN acervo_lexemas_df d ON d.lexema = t.lexema
             WHERE t.lexema <> ''
               -- Cinto e suspensorio: descarta residuo de operador que escape da
               -- extracao por aspas. Lexema legitimo do acervo tem letra,
               -- digito, ".", "/", "-" ou "_" — nunca estes.
               AND t.lexema !~ '[!&|<>()'' ]'
               -- Lexema de 1 caractere nao discrimina: 'r' (de "reator R-301")
               -- casa uma fracao grande dos chunks e nao esta em nenhuma lista.
               AND char_length(t.lexema) > 1
             GROUP BY t.lexema
        ),
        termos_orcados AS (
            -- PARTITION BY (ndoc = 0) isola os inexistentes: eles nao consomem
            -- orcamento nem empurram os reais para fora.
            SELECT lexema, ndoc,
                   sum(ndoc) OVER (PARTITION BY (ndoc = 0)
                                   ORDER BY ndoc, lexema
                                   ROWS UNBOUNDED PRECEDING) AS custo_acum
              FROM termos_df
        ),
        consulta_ampla AS (
            -- ORDER BY ndoc, lexema aparece na janela E aqui: e o desempate
            -- deterministico, sem ele duas execucoes da mesma pergunta montam
            -- tsqueries diferentes.
            SELECT nullif(string_agg(quote_literal(lexema), ' | '
                                     ORDER BY ndoc, lexema), '')::tsquery AS ampla
              FROM termos_orcados
             WHERE ndoc = 0 OR custo_acum <= {orcamento_ampla}
        ),
        vetorial AS (
            SELECT c.id,
                   row_number() OVER (ORDER BY c.embedding <=> '{literal}'::vector)
                     AS posicao
              FROM acervo_chunks c
             WHERE {where}
             ORDER BY c.embedding <=> '{literal}'::vector
             LIMIT {candidatos}
        ),
        estrita AS (
            SELECT c.id,
                   row_number() OVER (
                     ORDER BY ts_rank_cd(c.busca_tsv, q.estrita) DESC, c.id)
                     AS posicao
              FROM acervo_chunks c CROSS JOIN consulta q
             WHERE {where}
               AND q.estrita IS NOT NULL
               AND c.busca_tsv @@ q.estrita
             ORDER BY ts_rank_cd(c.busca_tsv, q.estrita) DESC, c.id
             LIMIT {candidatos}
        ),
        ampla AS (
            SELECT c.id,
                   row_number() OVER (
                     ORDER BY ts_rank_cd(c.busca_tsv, q.ampla) DESC, c.id)
                     AS posicao
              FROM acervo_chunks c CROSS JOIN consulta_ampla q
             WHERE {where}
               AND q.ampla IS NOT NULL
               AND c.busca_tsv @@ q.ampla
             ORDER BY ts_rank_cd(c.busca_tsv, q.ampla) DESC, c.id
             LIMIT {candidatos}
        ),
        fundido AS (
            SELECT coalesce(v.id, e.id, a.id) AS id,
                   CASE WHEN v.posicao IS NULL THEN 0
                        ELSE 1.0 / ({_RRF_K} + v.posicao) END
                 + CASE WHEN e.posicao IS NULL THEN 0
                        ELSE 1.0 / ({_RRF_K} + e.posicao) END
                 + CASE WHEN a.posicao IS NULL THEN 0
                        ELSE 1.0 / ({_RRF_K} + a.posicao) END AS rrf,
                   v.posicao AS pos_vetor,
                   coalesce(e.posicao, a.posicao) AS pos_texto
              FROM vetorial v
              FULL OUTER JOIN estrita e ON e.id = v.id
              FULL OUTER JOIN ampla   a ON a.id = coalesce(v.id, e.id)
        ),
        ordenado AS (
            SELECT f.*, c.texto AS _txt,
                   -- Dedup: boa parte do índice é texto que se repete em 2+
                   -- documentos (cláusula padrão de contrato Petrobras). Sem
                   -- isto, quatro cópias do mesmo parágrafo ocupavam quatro das
                   -- doze vagas. Fica a melhor colocada.
                   row_number() OVER (PARTITION BY md5(c.texto)
                                      ORDER BY f.rrf DESC, c.id) AS repetido
              FROM fundido f JOIN acervo_chunks c ON c.id = f.id
        )
        SELECT
            c.id,
            c.origem_tipo   AS "origemTipo",
            c.origem_id     AS "origemId",
            c.licitacao_id  AS "licitacaoId",
            c.chunk_index   AS "chunkIndex",
            c.texto,
            c.metadata,
            d.titulo          AS "docTitulo",
            d.nome_arquivo    AS "docArquivo",
            d.tipo_documento  AS "docTipo",
            d.situacao_prova  AS "docSituacao",
            d.detentora       AS "docDetentora",
            o.codigo          AS "opCodigo",
            o.cliente_nome    AS "opCliente",
            d.numero_documento AS "docNumero",
            d.emitido_em       AS "docEmitidoEm",
            o.detentora        AS "opDetentora",
            o.cliente_grupo    AS "opClienteGrupo",
            o.contrato_numero  AS "opContrato",
            o.unidade          AS "opUnidade",
            o.escopo           AS "opEscopo",
            o.periodo_inicio   AS "opInicio",
            o.periodo_fim      AS "opFim",
            a.descricao       AS "anexoDescricao",
            1 - (c.embedding <=> '{literal}'::vector) AS "similaridade",
            r.rrf             AS "rrf",
            r.pos_vetor       AS "posVetor",
            r.pos_texto       AS "posTexto"
        FROM ordenado r
        JOIN acervo_chunks c ON c.id = r.id
        LEFT JOIN documentos_habilitacao d
               ON c.origem_tipo = 'DOC_HABILITACAO' AND d.id = c.origem_id
        LEFT JOIN operacoes o ON o.id = d.operacao_id
        LEFT JOIN anexos a
               ON c.origem_tipo = 'ANEXO_EDITAL' AND a.id = c.origem_id
        WHERE r.repetido = 1
        ORDER BY r.rrf DESC, c.id
        LIMIT {top_k}
        """
    )
    # ef_search TRANSACIONAL (terceiro argumento `true` de set_config).
    #
    # Tem de ser transaction-local: a AsyncSession vive sobre um pool, e um
    # `SET` de sessão vazaria o valor para toda consulta que reutilizasse a
    # conexão depois desta. Com `true` o efeito morre no fim da transação.
    #
    # O valor entra por bind param — nunca por f-string — mesmo sendo um int
    # nosso: set_config recebe texto, e concatenar aqui abriria um caminho de
    # injeção onde não precisa existir nenhum.
    await db.execute(
        text("SELECT set_config('hnsw.ef_search', :ef, true)"),
        {"ef": str(ef_search)},
    )
    res = await db.execute(sql, params)
    rows = res.mappings().all()

    chunks: list[dict] = []
    for row in rows:
        sim = float(row["similaridade"]) if row["similaridade"] is not None else 0.0
        chunks.append(
            {
                "id": str(row["id"]) if row["id"] is not None else None,
                "origemTipo": row["origemTipo"],
                "origemId": str(row["origemId"])
                if row["origemId"] is not None
                else None,
                "licitacaoId": str(row["licitacaoId"])
                if row["licitacaoId"] is not None
                else None,
                "chunkIndex": int(row["chunkIndex"] or 0),
                # Redigido na LEITURA. Uma parte dos chunks do acervo
                # traz CPF ou e-mail, e a busca
                # devolve o trecho LITERAL — então um resultado podia exibir o
                # CPF de um responsável técnico. Redigir aqui fecha a exposição
                # sem tocar em acervo_chunks, então a decisão sobre sanear o
                # armazenado continua aberta.
                #
                # NÃO redigir antes do embedding nem do tsquery: o vetor e o
                # índice textual são construídos na INDEXAÇÃO, não aqui. Esta
                # redação é só de apresentação e não muda o ranking.
                "texto": redigir_pii(row["texto"]),
                "metadata": row["metadata"],
                "similaridade": sim,
                # de onde este resultado veio — permite a tela dizer "achado
                # pelo texto" e permite depurar a fusão sem ler SQL
                "rrf": float(row["rrf"]) if row["rrf"] is not None else 0.0,
                "posVetor": row["posVetor"],
                "posTexto": row["posTexto"],
                "arquivo": _identidade(row),
            }
        )

    # O piso de similaridade é do lado VETORIAL, e só dele.
    #
    # Medido: a amplitude de similaridade entre a 1ª e a 20ª posição é de 0,03 a
    # 0,07, e o valor absoluto varia por pergunta — a 0,55, "tubulação" não perde
    # nada e "submarina" perde 19 de 20 resultados. Como filtro global de
    # qualidade ele não separa bom de ruim; fica só contendo ruído do vetor.
    #
    # Resultado que veio pelo TEXTO passa direto: casamento lexical com o número
    # do contrato não é ruído de vetor, e é exatamente o que o híbrido existe
    # para resgatar. Cortá-lo aqui desfaria a fusão no último passo.
    return [
        c for c in chunks
        if c["similaridade"] >= sim_min or c.get("posTexto") is not None
    ]


def _ano(v) -> "str | None":
    """Ano de uma data (date/datetime do driver, ou string ISO)."""
    if not v:
        return None
    s = v.isoformat() if hasattr(v, "isoformat") else str(v)
    return s[:4] if len(s) >= 4 and s[:4].isdigit() else None


def _periodo(ini, fim) -> "str | None":
    """"2018-2021" · "2018-" · "-2021" · None. Sem inventar ponta faltante."""
    a, b = _ano(ini), _ano(fim)
    if not a and not b:
        return None
    if a and b:
        return a if a == b else f"{a}\u2013{b}"
    return f"{a}\u2013" if a else f"\u2013{b}"


def _identidade(row) -> dict:
    """Identidade do arquivo por tras do trecho: o que exibir e para onde levar.

    Espelha `identidade()` de src/lib/acervo/retrieval.ts. Sem isto a fonte sai
    como "origem=DOC_HABILITACAO id=<uuid>" — correto e inutil, porque ninguem
    abre documento por UUID.

    `href` aponta para a PAGINA do documento e nao para o download direto: a
    pagina mostra situacao da prova, operacao e familias, que e o contexto que
    decide se aquela prova serve. O download fica a um clique de la.
    """
    meta = row["metadata"] if isinstance(row["metadata"], dict) else {}
    do_meta = meta.get("titulo") if isinstance(meta.get("titulo"), str) else None
    oid = str(row["origemId"]) if row["origemId"] is not None else ""
    tipo = row["origemTipo"]

    if tipo == "DOC_HABILITACAO":
        return {
            "nome": row["docTitulo"] or row["docArquivo"] or do_meta or "documento sem título",
            "tipo": row["docTipo"],
            "numero": row["docNumero"],
            "emitidoEm": _ano(row["docEmitidoEm"]),
            "situacao": row["docSituacao"],
            # operacoes.detentora e NOT NULL com CHECK; documentos.detentora e
            # livre e as vezes vem vazia. A da operacao manda quando existe.
            "detentora": row["opDetentora"] or row["docDetentora"],
            "operacao": row["opCodigo"],
            "contrato": row["opContrato"],
            "cliente": row["opCliente"],
            "clienteGrupo": row["opClienteGrupo"],
            "unidade": row["opUnidade"],
            "escopo": row["opEscopo"],
            "periodo": _periodo(row["opInicio"], row["opFim"]),
            "href": f"/acervo/cofre/{oid}",
            "download": f"/api/conformidade/cofre/documentos/{oid}/download",
        }
    if tipo == "ANEXO_EDITAL":
        lic = str(row["licitacaoId"]) if row["licitacaoId"] is not None else None
        return {
            "nome": row["anexoDescricao"] or do_meta or "anexo de edital",
            "tipo": "ANEXO_EDITAL", "numero": None, "emitidoEm": None,
            "situacao": None, "detentora": None, "operacao": None,
            "contrato": None, "cliente": None, "clienteGrupo": None,
            "unidade": None, "escopo": None, "periodo": None,
            "href": f"/licitacoes/{lic}" if lic else None,
            "download": None,
        }
    return {
        "nome": do_meta or "origem não identificada",
        "tipo": tipo, "numero": None, "emitidoEm": None, "situacao": None,
        "detentora": None, "operacao": None, "contrato": None, "cliente": None,
        "clienteGrupo": None, "unidade": None, "escopo": None, "periodo": None,
        "href": None, "download": None,
    }


def _round3(x: float) -> float:
    """``Math.round(x*1000)/1000`` do TS (half-up no .5; JS arredonda p/ cima)."""
    import math

    return math.floor(x * 1000 + 0.5) / 1000


def _montar_contexto(chunks: list[dict]) -> tuple[str, list[dict]]:
    """Porta de ``montarContexto``: numera fontes (1-based) e monta o bloco."""
    fontes: list[dict] = []
    blocos: list[str] = []
    for i, c in enumerate(chunks):
        numero = i + 1
        fontes.append(
            {
                "numero": numero,
                "origemTipo": c["origemTipo"],
                "origemId": c["origemId"],
                "licitacaoId": c["licitacaoId"],
                "chunkIndex": c["chunkIndex"],
                "similaridade": _round3(c["similaridade"]),
                "arquivo": c.get("arquivo"),
            }
        )
        # O rotulo nomeia o documento tambem para o MODELO: citar
        # "[1] ART BA2025... (operacao 12345)" produz resposta verificavel;
        # citar um UUID, nao.
        a = c.get("arquivo") or {}
        if a.get("nome"):
            detalhe = a["nome"]
            if a.get("operacao"):
                detalhe += f" · operação {a['operacao']}"
            if a.get("tipo"):
                detalhe += f" · {a['tipo']}"
        else:
            detalhe = f"{c['origemTipo']} {c['origemId']}"
        rotulo = f"[{numero}] {detalhe}"
        blocos.append(f"{rotulo}\n{c['texto']}")
    return "\n\n---\n\n".join(blocos), fontes


# ── Handler POST (read-only) ──────────────────────────────────────────────────


@router.post("/api/acervo/buscar")
async def buscar_acervo(
    request: Request,
    user: CurrentUser = Depends(require_acervo),
    db=Depends(get_db),
) -> JSONResponse:
    """POST /api/acervo/buscar — busca semântica (RAG) no acervo técnico.

    Réplica fiel do handler POST do Next (read-only). A dependency
    ``require_acervo`` cobre o ``requireAcervo()`` (401/403) ANTES desta função.
    """
    # ── Gate gracioso: RAG indisponível (sem extension/provider) — não quebra. ─
    if not _rag_habilitado():
        return JSONResponse(
            content={
                "disponivel": False,
                "motivo": "Busca semântica indisponível (provider de embeddings não configurado).",
                "resposta": None,
                "fontes": [],
                "trechos": [],
            }
        )

    # ── Rate limit por usuário (custo de embedding + Claude). ─────────────────
    rl = await check_rate_limit(
        key=f"acervo-buscar:{user.id}",
        max_hits=30,
        window_seconds=60,
    )
    if not rl.allowed:
        return _erro(
            429,
            "RATE_LIMITED",
            "Muitas buscas em sequência. Tente novamente em instantes.",
        )

    # ── Body + validação (zod safeParse → 422 na primeira issue). ─────────────
    try:
        json = await request.json()
    except Exception:  # noqa: BLE001 — .catch(() => null) do Next: body inválido
        json = None

    dados, erro_msg = _validar_body(json)
    if dados is None:
        return _erro(422, "VALIDATION", erro_msg or "Corpo inválido")

    pergunta = dados["pergunta"]
    filtro = {
        "origemTipo": dados["origemTipo"],
        "licitacaoId": dados["licitacaoId"],
        "topK": dados["topK"],
        "detentora": dados["detentora"],
        "tipoDocumento": dados["tipoDocumento"],
        "desde": dados["desde"],
    }

    # ── 1. Embedding da pergunta ──────────────────────────────────────────────
    # Se o provider (TEI local) estiver fora do ar, degrada com 503 gracioso —
    # NUNCA 500. O gate _rag_habilitado() só checa CONFIG; a disponibilidade
    # real do TEI só se conhece ao chamar (verificado na prática).
    try:
        query_embedding = await embeddings_svc.gerar_embedding(pergunta, "query")
    except embeddings_svc.EmbeddingError as exc:
        return JSONResponse(
            status_code=503,
            content={
                "disponivel": False,
                "motivo": "Busca semântica temporariamente indisponível (serviço de embeddings fora do ar).",
                "detalhe": str(exc)[:200],
                "resposta": None,
                "fontes": [],
                "trechos": [],
            },
        )

    # ── 2. Retrieval k-NN por cosseno + filtros de metadata ───────────────────
    chunks = await _buscar_chunks_similares(
        db, query_embedding, filtro, user.role, pergunta=dados["pergunta"]
    )

    # ── Anti-IDOR a nível de objeto: interno (podeVisualizar) vê tudo do tenant.
    # assertAcessoObjeto(podeVisualizar(role)) — sempre true aqui (require_acervo
    # já garantiu o papel); reforça a invariante (403 se algum dia mudar).
    if not pode_visualizar(user.role):
        return _erro(403, "FORBIDDEN", "Sem acesso ao acervo")

    if len(chunks) == 0:
        return JSONResponse(
            content={
                "disponivel": True,
                "resposta": "Não encontrei nada no acervo que responda a essa pergunta.",
                "fontes": [],
                "trechos": [],
            }
        )

    contexto, fontes = _montar_contexto(chunks)
    trechos = [
        {
            "numero": i + 1,
            "origemTipo": c["origemTipo"],
            "origemId": c["origemId"],
            "licitacaoId": c["licitacaoId"],
            "chunkIndex": c["chunkIndex"],
            "similaridade": _round3(c["similaridade"]),
            # ja redigido na origem, em _buscar_chunks_similares — o que faz
            # `_montar_contexto` acima receber texto limpo tambem, e a PII nunca
            # entrar no prompt da sintese.
            "texto": c["texto"],
            "metadata": c["metadata"],
            # a UI renderiza `trechos`, nao `fontes` — sem isto o card volta a
            # mostrar so tipo e relevancia, sem nome de arquivo nem link
            "arquivo": c.get("arquivo"),
            # proveniencia da fusao — permite a tela marcar "achado pelo texto"
            "posTexto": c.get("posTexto"),
        }
        for i, c in enumerate(chunks)
    ]

    # ── Gate parcial: a síntese RAG está BLOQUEADA por decisão de produto (ver
    # services/anthropic.py) — só a análise de edital consome a API da Anthropic.
    # ia_permitida("acervo-busca") é sempre false, então a busca continua funcionando
    # e devolve os trechos relevantes, apenas sem a síntese redigida pela IA. (Cobre
    # também o caso de ANTHROPIC_API_KEY ausente.)
    if not anthropic_svc.ia_permitida("acervo-busca"):
        return JSONResponse(
            content={
                "disponivel": True,
                "resposta": None,
                "motivo": "Síntese por IA indisponível. Trechos relevantes retornados.",
                "fontes": fontes,
                "trechos": trechos,
            }
        )

    # ── 3. Síntese com citação via Claude (MESMO modelo/prompt/mensagem do Next).
    # Inalcançável enquanto o módulo estiver fora da allowlist (lança se chamado).
    modelo_haiku = settings.anthropic_model_haiku
    resposta = ""
    tokens_input = 0
    tokens_output = 0
    try:
        client = anthropic_svc.get_client("acervo-busca")
        message = await client.messages.create(
            model=modelo_haiku,
            max_tokens=1024,
            # Bloco estático (instruções) cacheável; só pergunta+contexto variam.
            system=[
                {
                    "type": "text",
                    "text": _INSTRUCAO_SISTEMA,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Pergunta: {pergunta}\n\n"
                        f"--- CONTEXTO DO ACERVO ---\n{contexto}\n\n"
                        "--- FIM DO CONTEXTO ---\n\n"
                        "Responda citando os trechos pelos números."
                    ),
                }
            ],
        )
        block = next(
            (b for b in message.content if getattr(b, "type", None) == "text"),
            None,
        )
        resposta = getattr(block, "text", "") or "" if block else ""
        tokens_input = message.usage.input_tokens
        tokens_output = message.usage.output_tokens
    except Exception:  # noqa: BLE001 — falha de síntese não invalida o retrieval
        return JSONResponse(
            content={
                "disponivel": True,
                "resposta": None,
                "motivo": "Falha ao sintetizar a resposta. Trechos relevantes retornados.",
                "fontes": fontes,
                "trechos": trechos,
            }
        )

    return JSONResponse(
        content={
            "disponivel": True,
            "resposta": resposta,
            "fontes": fontes,
            "trechos": trechos,
            "_meta": {
                "modelo": modelo_haiku,
                "tokensInput": tokens_input,
                "tokensOutput": tokens_output,
            },
        }
    )
