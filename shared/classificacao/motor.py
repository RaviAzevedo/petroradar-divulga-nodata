# -*- coding: utf-8 -*-
"""
Motor ÚNICO de classificação de licitações (natureza / tipo de serviço /
segmento) + scoring de perfis de interesse.

Substitui as 3 implementações divergentes (worker, BFF
licitacoes_reclassify.py e o route.ts legado) — worker e BFF importam DAQUI
(montado em /shared, mesmo padrão do ai-contract.json). Redesenho (F1+F2):

  1. familia_classif dos ITENS como sinal PRIMÁRIO de natureza:
     98* = Bens (aquisição), 99* = Serviços — cobre 91% dos itens reais e é
     quase determinístico. Keywords só refinam DENTRO do grupo permitido.
     (O código antigo procurava prefixos M*/S* que não existem no dado.)
  2. Matching por WORD-BOUNDARY sobre texto normalizado sem acentos —
     "óleo" não casa mais dentro de "petróleo"; "aquisição"≡"aquisicao".
  3. Dominância: o score de uma categoria = melhor keyword + 0.25 × demais —
     uma keyword forte não é mais atropelada pela soma de fracas.
  4. Scoring de perfis com HARD-GATES: filtro DEFINIDO no perfil é
     eliminatório (natureza/tipo/segmento/keywords_incluir/keywords_excluir/
     regioes/empresas/abrangencia); filtro ausente é NEUTRO (zero pontos de
     graça — perfil vazio não casa nada). Perfil bloqueado NÃO alimenta
     score/melhor_perfil.
  5. Peso do perfil é ADITIVO ((peso-5)*2, -8..+10) — nunca multiplica; com o
     peso default 5 da UI, ALTA continua alcançável.
  6. PRAZO FORA DO SCORE: prazo curto/vencido não penaliza o score persistido
     (o /explorar já filtra por prazo; notificação pode aplicar o corte).
  7. Regex de keyword de perfil malformada NÃO derruba o sync (try/except).

Relevância (sobre o score cru do melhor perfil COM match):
  ALTA >= 75 | MÉDIA >= 55 | BAIXA = match < 55 | SEM INTERESSE = sem match.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Optional

from .keywords import NATUREZA_KEYWORDS, TIPO_SERVICO_KEYWORDS, SEGMENTO_KEYWORDS

# ── Thresholds (centralizados; futuros overrides por env/config) ─────────────
THRESH_ALTA = 75
THRESH_MEDIA = 55

# Naturezas por grupo de familia_classif (98*=Bens / 99*=Serviços)
NATUREZAS_BENS = {"AQUISIÇÃO", "FORNECIMENTO COM SERVIÇO"}
NATUREZAS_SERVICOS = {
    "SERVIÇO", "EPC / OBRA", "AFRETAMENTO / LOCAÇÃO",
    "LICENCIAMENTO / CREDENCIAMENTO", "FORNECIMENTO COM SERVIÇO",
}

# Naturezas em que tipo_servico não se aplica (rótulo canônico Title Case —
# fim da fragmentação "N/A - AQUISIÇÃO" × "N/A - Aquisição").
_NA_NATUREZAS = {
    "AQUISIÇÃO": "N/A - Aquisição",
    "AFRETAMENTO / LOCAÇÃO": "N/A - Afretamento",
    "LICENCIAMENTO / CREDENCIAMENTO": "N/A - Licenciamento",
}


# ── Normalização e matching ──────────────────────────────────────────────────

def normalizar(texto: str) -> str:
    """minúsculas + remove diacríticos (NFD) — 'Aquisição' -> 'aquisicao'."""
    if not texto:
        return ""
    nfd = unicodedata.normalize("NFD", texto.lower())
    return "".join(c for c in nfd if unicodedata.category(c) != "Mn")


_REGEX_MARKERS = (".*", "\\b", "\\d", "[", "(", "|", "?")


def _compilar(kw: str) -> Optional[re.Pattern]:
    """Compila keyword como regex word-boundary sobre texto normalizado.

    Keywords de perfil podem conter fragmentos de regex (".*", "\\b") — nesse
    caso compilamos como regex crua (normalizada). Regex inválida retorna None
    (keyword ignorada) em vez de derrubar o sync inteiro.
    """
    kw_norm = normalizar(kw).strip()
    if not kw_norm:
        return None
    try:
        if any(m in kw for m in _REGEX_MARKERS):
            return re.compile(kw_norm)
        return re.compile(r"(?<!\w)" + re.escape(kw_norm) + r"(?!\w)")
    except re.error:
        return None


# Cache de compilação (as listas canônicas são estáveis por processo).
_cache_compilado: dict[str, Optional[re.Pattern]] = {}


def _pattern(kw: str) -> Optional[re.Pattern]:
    if kw not in _cache_compilado:
        _cache_compilado[kw] = _compilar(kw)
    return _cache_compilado[kw]


def match_keywords(texto: str, keywords: list[str]) -> tuple[bool, list[str]]:
    """True + lista das keywords encontradas (word-boundary, sem acentos)."""
    if not keywords:
        return False, []
    tx = normalizar(texto)
    found = []
    for kw in keywords:
        pat = _pattern(kw)
        if pat is not None and pat.search(tx):
            found.append(kw)
    return len(found) > 0, found


def _scores_por_categoria(
    keywords: list[tuple[str, str, int]], obj_norm: str, itens_norm: str,
) -> dict[str, float]:
    """Score por categoria com DOMINÂNCIA: melhor peso + 0.25 × soma dos demais.

    Keyword no objeto vale 2x; nos itens 1x (mesma convenção do motor antigo,
    mas sem o acúmulo aditivo puro que invertia casos óbvios).
    """
    pesos: dict[str, list[float]] = {}
    for kw, categoria, peso in keywords:
        pat = _pattern(kw)
        if pat is None:
            continue
        p = 0.0
        if pat.search(obj_norm):
            p = peso * 2.0
        elif itens_norm and pat.search(itens_norm):
            p = peso * 1.0
        if p > 0:
            pesos.setdefault(categoria, []).append(p)
    return {
        cat: max(vals) + 0.25 * (sum(vals) - max(vals))
        for cat, vals in pesos.items()
    }


# ── Classificadores ──────────────────────────────────────────────────────────

def stats_familia(itens: list[dict]) -> tuple[int, int, int]:
    """(n_bens, n_servicos, n_total_com_classif) a partir de familia_classif.

    Dado real Petronect: '98...' = Bens, '99...' = Serviços (91% dos itens).
    """
    n_bens = n_serv = n_total = 0
    for item in itens or []:
        if not isinstance(item, dict):
            continue
        fc = str(item.get("familia_classif") or item.get("FAMILY_CLASSIF") or "").strip()
        if not fc:
            continue
        n_total += 1
        if fc.startswith("98"):
            n_bens += 1
        elif fc.startswith("99"):
            n_serv += 1
    return n_bens, n_serv, n_total


def classificar_natureza(obj: str, itens_texto: str = "", itens: Optional[list[dict]] = None) -> str:
    """familia_classif decide o GRUPO (bens × serviços); keywords refinam dentro dele."""
    obj_norm = normalizar(obj)
    itens_norm = normalizar(itens_texto)
    scores = _scores_por_categoria(NATUREZA_KEYWORDS, obj_norm, itens_norm)

    n_bens, n_serv, n_total = stats_familia(itens or [])
    if n_total > 0:
        if n_bens >= n_total * 0.7:
            grupo = NATUREZAS_BENS
            fallback = "AQUISIÇÃO"
        elif n_serv >= n_total * 0.7:
            grupo = NATUREZAS_SERVICOS
            fallback = "SERVIÇO"
        else:
            # misto de bens e serviços — natureza híbrida por definição
            grupo = None
            fallback = "FORNECIMENTO COM SERVIÇO"
        if grupo is not None:
            no_grupo = {c: s for c, s in scores.items() if c in grupo}
            if no_grupo:
                return max(no_grupo, key=no_grupo.get)
            return fallback
        # misto: keyword vence se existir; senão híbrido
        if scores:
            return max(scores, key=scores.get)
        return fallback

    # Sem sinal de itens: keywords decidem; OUTROS só com zero sinal.
    if scores:
        return max(scores, key=scores.get)
    return "OUTROS"


def classificar_tipo_servico(obj: str, natureza: str, itens_texto: str = "") -> str:
    if natureza in _NA_NATUREZAS:
        return _NA_NATUREZAS[natureza]
    obj_norm = normalizar(obj)
    itens_norm = normalizar(itens_texto)
    scores = _scores_por_categoria(TIPO_SERVICO_KEYWORDS, obj_norm, itens_norm)
    if not scores:
        return "Serviço Especializado"
    return max(scores, key=scores.get)


def classificar_segmento(obj: str, itens_texto: str = "") -> str:
    obj_norm = normalizar(obj)
    itens_norm = normalizar(itens_texto)
    scores = _scores_por_categoria(SEGMENTO_KEYWORDS, obj_norm, itens_norm)
    if not scores:
        return "Geral / Multidisciplinar"
    return max(scores, key=scores.get)


# ── Scoring de perfis (hard-gates + sinais) ──────────────────────────────────

def _regioes_da_licitacao(lic: dict) -> str:
    return normalizar(str(lic.get("regioes") or ""))


def pontuar_perfil(perfil: dict, ctx: dict) -> Optional[dict]:
    """Pontua UM perfil contra a licitação classificada.

    Retorna None quando qualquer HARD-GATE definido falha (perfil não casa e
    NÃO contribui para score/melhor_perfil). Caso contrário, dict com score
    0-100 e o breakdown.
    """
    filtros = perfil.get("filtros") or {}
    if not isinstance(filtros, dict):
        return None

    dims_definidas = 0
    breakdown: dict[str, Any] = {}

    # Gate: natureza
    f_nat = filtros.get("natureza")
    if f_nat:
        dims_definidas += 1
        if ctx["natureza"] not in f_nat:
            return None
        breakdown["natureza"] = ctx["natureza"]

    # Gate: tipo de serviço
    f_tipo = filtros.get("tipo_servico")
    if f_tipo:
        dims_definidas += 1
        if ctx["tipo_servico"] not in f_tipo:
            return None
        breakdown["tipo_servico"] = ctx["tipo_servico"]

    # Gate: segmento
    f_seg = filtros.get("segmento")
    if f_seg:
        dims_definidas += 1
        if ctx["segmento"] not in f_seg:
            return None
        breakdown["segmento"] = ctx["segmento"]

    # Gate: keywords_incluir (>=1 hit em objeto+resumido+itens; hit no objeto conta mais)
    kw_hits_obj: list[str] = []
    kw_hits_itens: list[str] = []
    f_inc = filtros.get("keywords_incluir") or []
    if f_inc:
        dims_definidas += 1
        _, kw_hits_obj = match_keywords(ctx["texto_objeto"], f_inc)
        _, kw_hits_itens = match_keywords(ctx["texto_itens"], f_inc)
        if not kw_hits_obj and not kw_hits_itens:
            return None
        breakdown["keywords"] = sorted(set(kw_hits_obj + kw_hits_itens))

    # Gate: keywords_excluir (nenhuma em lugar nenhum)
    f_exc = filtros.get("keywords_excluir") or []
    if f_exc:
        achou_obj, _ = match_keywords(ctx["texto_objeto"], f_exc)
        achou_itens, _ = match_keywords(ctx["texto_itens"], f_exc)
        if achou_obj or achou_itens:
            return None

    # Gates opcionais (campos antes IGNORADOS pelo motor — agora honrados):
    f_regioes = filtros.get("regioes")
    if f_regioes:
        dims_definidas += 1
        lic_regioes = ctx["regioes_norm"]
        if not any(normalizar(r) in lic_regioes for r in f_regioes):
            return None
    f_empresas = filtros.get("empresas")
    if f_empresas:
        dims_definidas += 1
        emp = normalizar(ctx["empresa"])
        if not any(normalizar(e) in emp for e in f_empresas):
            return None
    f_abr = filtros.get("abrangencia")
    if f_abr:
        dims_definidas += 1
        abr = normalizar(ctx["abrangencia"])
        alvo = [normalizar(a) for a in (f_abr if isinstance(f_abr, list) else [f_abr])]
        if not any(abr.startswith(a[:1]) for a in alvo if a):
            return None

    # Perfil sem NENHUM filtro definido não casa nada (fim do match-all).
    if dims_definidas == 0:
        return None

    # ── Score (0-100) ─────────────────────────────────────────────────────────
    score = 50.0  # base: passou em todos os gates definidos

    # Keywords: até +25 (8/hit; hit no objeto vale bônus fixo +5)
    n_hits = len(set(kw_hits_obj + kw_hits_itens))
    if n_hits:
        score += min(20.0, 8.0 * n_hits)
        if kw_hits_obj:
            score += 5.0

    # Especificidade: perfis mais restritos são matches mais confiáveis
    score += min(15.0, 5.0 * max(0, dims_definidas - 1))

    # Peso: prioridade ADITIVA (default 5 = neutro; 10 = +10; 1 = -8)
    peso = filtros.get("peso", 5)
    try:
        peso = int(peso)
    except (TypeError, ValueError):
        peso = 5
    score += (max(1, min(10, peso)) - 5) * 2.0

    score = max(0.0, min(100.0, score))
    breakdown["dims"] = dims_definidas
    breakdown["peso"] = peso
    breakdown["score"] = round(score, 1)
    return {"score": score, "breakdown": breakdown}


def classificar_licitacao(lic: dict, perfis: list[dict]) -> dict:
    """Classifica a licitação e pontua os perfis ATIVOS.

    Contrato de saída idêntico ao consumido pelo upsert do worker:
      natureza, tipo_servico, segmento, relevancia, score_interesse,
      perfis_match (csv), melhor_perfil — mais score_breakdown (não persistido).
    """
    objeto = lic.get("objeto") or ""
    objeto_resumido = lic.get("objeto_resumido") or ""

    itens = lic.get("itens", []) or []
    partes = []
    for item in itens:
        if isinstance(item, dict):
            partes.append(str(item.get("descricao") or item.get("ITEM_DESC") or ""))
            partes.append(str(item.get("familia_descricao") or item.get("FAMILY_DESCR") or ""))
            partes.append(str(item.get("familia") or item.get("FAMILY") or ""))
    itens_texto = " ".join(p for p in partes if p)

    natureza = classificar_natureza(objeto, itens_texto, itens)
    tipo_servico = classificar_tipo_servico(objeto, natureza, itens_texto)
    segmento = classificar_segmento(objeto, itens_texto)

    ctx = {
        "natureza": natureza,
        "tipo_servico": tipo_servico,
        "segmento": segmento,
        "texto_objeto": f"{objeto} {objeto_resumido}",
        "texto_itens": itens_texto,
        "regioes_norm": _regioes_da_licitacao(lic),
        "empresa": str(lic.get("empresa") or ""),
        "abrangencia": str(lic.get("abrangencia") or ""),
    }

    matches: list[tuple[str, dict]] = []
    breakdown_all: dict[str, Any] = {}
    for perfil in perfis or []:
        if not perfil.get("ativo", True):
            continue
        r = pontuar_perfil(perfil, ctx)
        if r is not None:
            nome = perfil.get("nome", "")
            matches.append((nome, r))
            breakdown_all[nome] = r["breakdown"]

    if matches:
        melhor_nome, melhor = max(matches, key=lambda m: m[1]["score"])
        final = int(round(melhor["score"]))
        if final >= THRESH_ALTA:
            relevancia = "ALTA"
        elif final >= THRESH_MEDIA:
            relevancia = "MÉDIA"
        else:
            relevancia = "BAIXA"
    else:
        melhor_nome = ""
        final = 0
        relevancia = "SEM INTERESSE"

    return {
        "natureza": natureza,
        "tipo_servico": tipo_servico,
        "segmento": segmento,
        "relevancia": relevancia,
        "score_interesse": final,
        "perfis_match": ", ".join(n for n, _ in matches),
        "melhor_perfil": melhor_nome,
        "score_breakdown": breakdown_all,
    }
