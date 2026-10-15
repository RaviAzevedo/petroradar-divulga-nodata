# -*- coding: utf-8 -*-
"""
Sweeps semanais do Portal da Transparência → tabela transparencia_contratos.

Fase 2 do plano da Transparência:

  • modo "cnpj"   (F3): histórico ALL-TIME de contratos por CNPJ de interesse
    (vencedores efetivos da base + Proponente). Alimenta a Ficha 360
    ("Histórico Petrobras completo": market share, série anual, unidades).
  • modo "objeto" (F4): varre termos de engenharia com FIM DE VIGÊNCIA na
    janela hoje→+18 meses (qualquer fornecedor) — universo de renovações para
    prospecção pré-licitação (Radar de Renovação fonte=todos).
  • modo "adjudicacoes" (migration 0027): olha para TRÁS. Contratos com INÍCIO
    DE VIGÊNCIA nos últimos N meses = licitações recém-ganhas. Alimenta a visão
    "Vencedores recentes" (prospecção de PARCERIA: quem ganhou EPC/obra e não
    tem braço de projeto é comprador de engenharia).

Mesma técnica do transparencia_job (Playwright bootstrap p/ WAF + 1 req/s).
Upsert por contrato_cd; origem preservada na primeira captura.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import date, datetime, timezone

# Reusa constantes/infra do job de valores (mesmo container/imagem).
from transparencia_job import (
    EP_LIST, IFRAME, MODULE_VERSION, API_VERSION_LIST, UNIDADES_TODAS,
    _ddmmyyyy_to_iso,
)

PAUSA_S = 1.0
PAGE_SIZE = 100
CAP_POR_CNPJ = 500
CAP_POR_TERMO = 3000
JANELA_OBJETO_MESES = 18

# ── Termos e classificadores (herdados de um protótipo anterior)    ────────────
TERMOS_OBJETO = [
    "engenharia", "projeto básico", "projeto executivo", "detalhamento",
    "consultoria", "apoio técnico", "serviço técnico", "técnico especializado",
    "fiscalização", "comissionamento", "gerenciamento", "inspeção", "supervisão",
    "manutenção industrial", "parada de manutenção", "montagem eletromecânica",
    "caldeiraria", "tubulação", "instrumentação", "automação",
]

SEG_REGEX = [
    ("Engenharia & Projetos", re.compile(r"engenharia|projeto\b|projetos|detalhament|consultoria|feed\b|b[áa]sico|executiv|estudo", re.I)),
    ("Apoio técnico / especializado", re.compile(r"apoio t[ée]cnico|servi[çc]o t[ée]cnico|t[ée]cnico especializ|servi[çc]o especializ|fiscaliza|comission|gerenciam|inspe[çc]|supervis|assist[êe]ncia t[ée]cnica", re.I)),
    ("Manutenção / montagem", re.compile(r"manuten[çc]|montagem|caldeiraria|reparo|retrofit|parada", re.I)),
    ("Serviços administrativos", re.compile(r"administrativ|gest[ãa]o documental|gest[ãa]o de contrato|secretari|recep[çc][ãa]o|protocolo|posto de servi[çc]o|arquivo", re.I)),
]
ADERENCIA_RE = re.compile(
    r"refin|petr[óo]le|[óo]leo|g[áa]s|offshore|onshore|tubula|tancagem|tanque|caldeiraria|instrumenta|el[ée]tric|autom[aç]|mec[âa]nic|parada|plataforma|fpso|unidade industrial|planta|duto|polo|terminal|esta[çc][ãa]o|montagem eletromec|estrutural|pintura|isolamento|v[áa]lvula|press[ãa]o|soldagem|END\b|ndt",
    re.I,
)


def _classificar(objeto: str) -> tuple[str, int]:
    seg = "Outros serviços"
    for nome, rx in SEG_REGEX:
        if rx.search(objeto or ""):
            seg = nome
            break
    return seg, 1 if ADERENCIA_RE.search(objeto or "") else 0


def _fmt_cnpj(digits: str) -> str:
    # O filtro CNPJ_CPF do portal espera SÓ DÍGITOS (provado ao vivo: formatado
    # com pontuação → 0 resultados; dígitos → todos os contratos do fornecedor).
    return re.sub(r"\D", "", digits or "")


# ── ADJUDICAÇÕES: quem ganhou licitação recentemente (migration 0027) ─────────
# Janela e piso configuráveis: a densidade cai muito abaixo de R$ 1MM (medido ao
# vivo 2026-07-09, janela de 3 meses: 13.663 contratos Ativos, 1.660 ≥ R$100k,
# 620 ≥ R$1MM). O piso é o que separa contrato de licitação de ordem de compra.
#
# A JANELA DO SWEEP É MAIS LARGA QUE A DA TELA (que abre em 3 meses). Só as
# linhas que este sweep toca ganham papel_vencedor/classificacao_ia; uma linha
# não classificada cai em COALESCE(...,'outro') e some da fila de alvos. Como a
# tela oferece 3/6/12 meses, o sweep tem de cobrir 12 — senão as vistas de 6 e
# 12 meses mostrariam vencedores reais como "outro/desconhecido". A rota clampa
# `meses` a este mesmo teto. Custo: ~2,5 mil linhas, ~25 páginas, semanal.
JANELA_ADJUDICACAO_MESES = int(os.environ.get("TRANSPARENCIA_ADJUDICACAO_MESES", "12"))
PISO_VALOR_ADJUDICACAO = os.environ.get("TRANSPARENCIA_ADJUDICACAO_PISO", "1000000")
CAP_ADJUDICACAO = int(os.environ.get("TRANSPARENCIA_ADJUDICACAO_CAP", "5000"))

# Só estas são "licitação GANHA". DISPENSA/INEXIGIBILIDADE/CONVÊNIO são
# adjudicação direta — não houve disputa, não há parceria a propor. O portal não
# filtra modalidade server-side (EnquadramentoDoProcesso só aceita 0, provado ao
# vivo), então o corte é aqui.
MODALIDADES_LICITADAS = {"LICITAÇÃO", "PREGÃO"}

# Escopo do contrato, por precedência. Deliberadamente diferente do SEG_REGEX
# acima: aquele rotula SEGMENTO (e é lido pelo Radar de Renovação); este rotula
# TIPO DE ESCOPO para a tese comercial de parceria. Não fundir os dois — mudar
# SEG_REGEX reclassificaria todas as linhas já gravadas.
#
# Ordem importa: "SUPORTE TÉCNICO ÀS ATIVIDADES DE FISCALIZAÇÃO PARA A
# IMPLANTAÇÃO DE PROJETOS" é fiscalização (serviço), não obra — por isso
# `servico` vem antes de `obra`, apesar de casar "implantação".
_RE_PROJETO = re.compile(
    r"projeto b[áa]sico|projeto executivo|projeto conceitual|detalhament|"
    r"\bfeed\b|as.?built|engenharia consultiva|projeto de engenharia|"
    r"estudo de viabilidade|engenharia b[áa]sica",
    re.I,
)
_RE_EPC = re.compile(r"\bepc\b|\bepcm\b|turn.?key", re.I)
_RE_SERVICO = re.compile(
    r"manuten[çc]|inspe[çc]|fiscaliza|comission|apoio t[ée]cnico|"
    r"suporte t[ée]cnico|gerenciam|supervis|assist[êe]ncia t[ée]cnica",
    re.I,
)
_RE_OBRA = re.compile(
    r"constru[çc][ãa]o|montagem eletromec|montagem industrial|implanta[çc][ãa]o|"
    r"\bobra\b|\bobras\b|tancagem|\bduto\b|\bdutos\b",
    re.I,
)
_RE_FORNECIMENTO = re.compile(r"fornecimento|loca[çc][ãa]o|aquisi[çc][ãa]o|suprimento", re.I)

# Papel do vencedor pela RAZÃO SOCIAL. Custo zero: já vem no payload.
# "ENGENHARIA" de propósito NÃO entra em nenhuma das listas — é ambíguo demais
# (há "X ENGENHARIA E INSPEÇÃO" que é manutenção industrial e "Y ENGENHARIA" que
# é apoio administrativo). Preferimos "desconhecido" a um rótulo errado.
#
# COSTURA: trocar por CNAE (BrasilAPI, grátis — a mesma fonte já usada por
# /api/cron/cnpj-watch) é um upgrade drop-in, sem migration. Medido ao vivo em
# construtoras reais: CNAE principal 4299-5/99 ou 4211-1/01 (obra). Atenção:
# quase toda construtora registra 7112-0 (serviços de engenharia) como
# secundário, então o sinal tem de vir do CNAE PRINCIPAL.
_RE_NOME_OBRA = re.compile(
    r"constru[çt][oaã]|construtora|montagens?\b|montagem|empreiteira|\bobras\b", re.I
)
_RE_NOME_PROJETO = re.compile(
    r"\bprojetos?\b|consultoria|consulting|arquitetura|\bdesign\b|projetista", re.I
)


def _papel_vencedor(razao_social: str | None) -> str:
    nome = razao_social or ""
    obra = bool(_RE_NOME_OBRA.search(nome))
    proj = bool(_RE_NOME_PROJETO.search(nome))
    if obra and proj:
        return "hibrido"
    if obra:
        return "construtora"
    if proj:
        return "projetista"
    return "desconhecido"


def _tipo_escopo(objeto: str | None) -> str:
    o = objeto or ""
    if _RE_PROJETO.search(o):
        return "projeto"
    if _RE_EPC.search(o):
        return "epc"
    if _RE_SERVICO.search(o):
        return "servico"
    if _RE_OBRA.search(o):
        return "obra"
    if _RE_FORNECIMENTO.search(o):
        return "fornecimento"
    return "outro"


# Peso do escopo na nota de parceria. EPC é o alvo máximo: o "E" de Engineering
# está dentro do contrato e a vencedora tipicamente subcontrata o projeto.
# `projeto` pontua baixo de propósito — quem ganha contrato de projeto puro é
# CONCORRENTE, não parceiro.
_FIT_POR_TIPO = {"epc": 70, "obra": 55, "projeto": 30, "servico": 15, "fornecimento": 5, "outro": 0}
_FIT_POR_PAPEL = {"construtora": 25, "hibrido": 5, "desconhecido": 0, "projetista": -15}


def _classificacao(objeto: str | None, fornecedor: str | None, valor: float | None,
                   aderencia: int) -> tuple[str, dict]:
    """Devolve (papel_vencedor, classificacao_ia). Regex v1 — sem custo de LLM.

    A nota é uma soma explicável de propósito: dá para auditar por que um
    contrato subiu na fila. `fonte` marca a procedência para um classificador
    LLM poder sobrescrever depois (fonte='llm') sem mudar o schema.
    """
    papel = _papel_vencedor(fornecedor)
    tipo = _tipo_escopo(objeto)
    contem_eng = tipo in ("projeto", "epc") or bool(_RE_PROJETO.search(objeto or ""))

    fit = _FIT_POR_TIPO[tipo] + _FIT_POR_PAPEL[papel]
    if aderencia:
        fit += 10
    v = valor or 0
    if v >= 50_000_000:
        fit += 10
    elif v >= 10_000_000:
        fit += 5
    fit = max(0, min(100, fit))

    return papel, {
        "v": 1,
        "fonte": "regex",
        "tipo_escopo": tipo,
        "contem_engenharia": contem_eng,
        "fit": fit,
    }


def _body(filtros_extra: dict, start_index: int) -> dict:
    filtros = {
        "UnidadeAdministrativa": UNIDADES_TODAS, "NumerodoContrato": "",
        "NumeroDoProcesso": "", "EnquadramentoDoProcesso": 0, "Situacao": "",
        "ObjetoDaContratacao": "", "Fornecedor": "", "CNPJ_CPF": "",
        "NumeroDoICJ": "", "InicioDaVigencia_de": "1900-01-01",
        "InicioDaVigencia_ate": "1900-01-01", "FimDaVigencia_de": "1900-01-01",
        "FimDaVigencia_ate": "1900-01-01", "ValorDoContrato_de": "",
        "ValorDoContrato_ate": "",
    }
    filtros.update(filtros_extra)
    return {
        "versionInfo": {"moduleVersion": MODULE_VERSION, "apiVersion": API_VERSION_LIST},
        "viewName": "MenuConsultasIFrame.ContratosIframe",
        "inputParameters": {},
        "screenData": {"variables": {
            "FormFiltros": filtros,
            "Flag_UnidadeAdminsitrat_Todos": True, "StartIndex": start_index,
            "MaxRecords": PAGE_SIZE, "Flag_ConsultaAtiva": True,
            "RefazerConsulta": True, "In_EmpresaId": "lN3MPBEFoSQ=",
            "_in_EmpresaIdInDataFetchStatus": 1, "IsIframe": True,
            "_isIframeInDataFetchStatus": 1, "HasUnidadeAdministrativa": True,
            "TableSort": "", "MensagemValidacao": "",
        }},
    }


def _parse_row(row: dict) -> dict | None:
    c = row.get("CONTRATO_TRANSPARENCIA") or {}
    contrato_cd = str(c.get("COTR_CD_CONTRATO") or "").strip()
    if not contrato_cd:
        return None
    objeto = (c.get("COTR_DS_OBJETO") or "").replace("\n", " ").strip()
    seg, ader = _classificar(objeto)
    fornecedor = (c.get("COTR_NM_FORNECEDOR") or "").strip() or None
    valor = float((row.get("VALOR_CONTRATO") or {}).get("VACO_VL_CONTRATO") or 0) or None

    # Fornecedor ESTRANGEIRO vem com COTR_CD_CNPJ_CPF = "EXTERNO" (visto ao vivo
    # em contrato bilionário). Sem dígitos → cnpj NULL, e a agregação por
    # fornecedor a jusante precisa usar COALESCE(cnpj, fornecedor).
    cnpj = re.sub(r"\D", "", str(c.get("COTR_CD_CNPJ_CPF") or "")) or None

    papel, classificacao = _classificacao(objeto, fornecedor, valor, ader)

    return {
        "contrato_cd": contrato_cd,
        "processo": str(c.get("COTR_CD_PROCESSO") or "").strip() or None,
        "cnpj": cnpj,
        "fornecedor": fornecedor,
        "objeto": objeto[:800] or None,
        "valor": valor,
        "moeda": ((row.get("MOEDA") or {}).get("MOED_SG_MOEDA") or "").strip() or None,
        "situacao": ((row.get("SITUACAO_CONTRATO") or {}).get("SICO_NM_SITUACAO") or "").strip() or None,
        "modalidade": ((row.get("MODALIDADE") or {}).get("MODA_NM_MODALIDADE") or "").strip() or None,
        "unidade": (c.get("COTR_NM_UNIDADE_ADMINISTRATIVA") or "").strip() or None,
        "orgao_superior": ((row.get("ORGAO_SUPERIOR") or {}).get("ORGA_NM_ORGAO") or "").strip() or None,
        "vigencia_inicio": _ddmmyyyy_to_iso(row.get("DatainicioVigencia")),
        "vigencia_fim": _ddmmyyyy_to_iso(row.get("DatafimVigencia")),
        "aditivos_qtd": int(c.get("COTR_QN_ADITIVOS") or 0),
        "fundamento_legal": (c.get("COTR_DS_FUNDAMENTO_LEGAL") or "").strip()[:300] or None,
        "instrumento": (c.get("COTR_DS_INSTRUMENTO_JURIDICO") or "").strip()[:200] or None,
        "segmento_estimado": seg,
        "aderencia": ader,
        # ── migration 0027 ──
        "data_log_inclusao": _ddmmyyyy_to_iso(row.get("DataLogInclusao")),
        "patrocinio": bool(int(c.get("COTR_IN_PATROCINIO") or 0)),
        "papel_vencedor": papel,
        "classificacao_ia": json.dumps(classificacao),
    }


_UPSERT = """
INSERT INTO transparencia_contratos (
  contrato_cd, processo, cnpj, fornecedor, objeto, valor, moeda, situacao,
  modalidade, unidade, orgao_superior, vigencia_inicio, vigencia_fim,
  aditivos_qtd, fundamento_legal, instrumento, origem, aderencia,
  segmento_estimado, data_log_inclusao, patrocinio, papel_vencedor,
  classificacao_ia, atualizado_em
) VALUES (
  %(contrato_cd)s, %(processo)s, %(cnpj)s, %(fornecedor)s, %(objeto)s,
  %(valor)s, %(moeda)s, %(situacao)s, %(modalidade)s, %(unidade)s,
  %(orgao_superior)s, %(vigencia_inicio)s, %(vigencia_fim)s, %(aditivos_qtd)s,
  %(fundamento_legal)s, %(instrumento)s, %(origem)s, %(aderencia)s,
  %(segmento_estimado)s, %(data_log_inclusao)s, %(patrocinio)s,
  %(papel_vencedor)s, %(classificacao_ia)s::jsonb, %(agora)s
)
ON CONFLICT (contrato_cd) DO UPDATE SET
  processo = EXCLUDED.processo, cnpj = EXCLUDED.cnpj,
  fornecedor = EXCLUDED.fornecedor, objeto = EXCLUDED.objeto,
  valor = EXCLUDED.valor, moeda = EXCLUDED.moeda, situacao = EXCLUDED.situacao,
  modalidade = EXCLUDED.modalidade, unidade = EXCLUDED.unidade,
  orgao_superior = EXCLUDED.orgao_superior,
  vigencia_inicio = EXCLUDED.vigencia_inicio,
  vigencia_fim = EXCLUDED.vigencia_fim, aditivos_qtd = EXCLUDED.aditivos_qtd,
  fundamento_legal = EXCLUDED.fundamento_legal,
  instrumento = EXCLUDED.instrumento, aderencia = EXCLUDED.aderencia,
  segmento_estimado = EXCLUDED.segmento_estimado,
  data_log_inclusao = EXCLUDED.data_log_inclusao,
  patrocinio = EXCLUDED.patrocinio,
  papel_vencedor = EXCLUDED.papel_vencedor,
  atualizado_em = EXCLUDED.atualizado_em,
  -- Não sobrescreve uma classificação de LLM com a de regex: quando um
  -- classificador melhor já marcou fonte='llm', a linha é preservada.
  classificacao_ia = CASE
    WHEN transparencia_contratos.classificacao_ia ->> 'fonte' = 'llm'
      THEN transparencia_contratos.classificacao_ia
    ELSE EXCLUDED.classificacao_ia
  END
"""
# origem NÃO é atualizada no conflito: preserva a primeira captura.


def _bootstrap(pw):
    """Sessão + CSRF via Playwright (WAF). Retorna (browser, ctx, headers)."""
    browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(locale="pt-BR")
    page = ctx.new_page()
    csrf: list[str] = []

    def _captura(req):
        if "/screenservices/" in req.url:
            tok = req.headers.get("x-csrftoken")
            if tok and not csrf:
                csrf.append(tok)

    page.on("request", _captura)
    try:
        page.goto(IFRAME, wait_until="domcontentloaded", timeout=45_000)
    except Exception as exc:  # noqa: BLE001
        print(f"[SWEEP] goto: {exc}")
    for _ in range(60):
        if csrf:
            break
        page.wait_for_timeout(1000)
    if not csrf:
        browser.close()
        raise RuntimeError("Transparência sweep: bootstrap sem CSRF (WAF/rede)")
    headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "Accept": "application/json",
        "X-CSRFToken": csrf[0],
        "Referer": IFRAME,
        "X-Requested-With": "XMLHttpRequest",
    }
    return browser, ctx, headers


def _paginar(ctx, headers, filtros_extra: dict, cap: int, stats: dict) -> list[dict]:
    """Busca todas as páginas (até cap) de uma consulta; devolve rows parseadas."""
    out: list[dict] = []
    start = 0
    total = None
    while total is None or (start < min(total, cap)):
        resp = ctx.request.post(
            EP_LIST, headers=headers,
            data=json.dumps(_body(filtros_extra, start)), timeout=60_000,
        )
        d = resp.json()
        if d.get("exception"):
            raise RuntimeError(d["exception"].get("message", "OutSystems exception"))
        vinfo = d.get("versionInfo") or {}
        if vinfo.get("hasApiVersionChanged") or vinfo.get("hasModuleVersionChanged"):
            print("[SWEEP] ⚠ versão da API OutSystems mudou — atualizar tokens")
        data = d.get("data") or {}
        if total is None:
            total = int(data.get("Count") or 0)
        rows = ((data.get("List") or {}).get("List")) or []
        for raw in rows:
            rec = _parse_row(raw)
            if rec:
                out.append(rec)
        start += PAGE_SIZE
        stats["consultas"] += 1
        time.sleep(PAUSA_S)
        if not rows:
            break
    if total and total > cap:
        print(f"[SWEEP]   (limitado a {cap} de {total})")
    return out


def _meses_atras(n: int) -> str:
    """Data ISO de N meses atrás (clampa o dia p/ meses curtos: 31/03 −1m → 28/02)."""
    hoje = date.today()
    total = hoje.year * 12 + (hoje.month - 1) - n
    ano, mes = divmod(total, 12)
    mes += 1
    # Último dia do mês alvo, para não estourar (ex.: 31 em fevereiro).
    if mes == 12:
        ultimo = 31
    else:
        ultimo = (date(ano, mes + 1, 1) - date.resolution).day
    return date(ano, mes, min(hoje.day, ultimo)).isoformat()


def run_sweep(modo: str) -> dict:
    """modo = 'cnpj' | 'objeto' | 'adjudicacoes'. Retorna stats p/ o sync_log."""
    from playwright.sync_api import sync_playwright  # import tardio
    import db_util

    conn = db_util.get_db_conn()
    agora = datetime.now(timezone.utc)
    stats = {"modo": modo, "alvos": 0, "consultas": 0, "contratos": 0, "erros": 0}
    if modo == "adjudicacoes":
        stats["descartados"] = 0
    try:
        if modo == "cnpj":
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT cnpj_vencedor_efetivo AS cnpj
                    FROM resultados_licitacao
                    WHERE cnpj_vencedor_efetivo IS NOT NULL
                    UNION SELECT '11222333000181'
                    """
                )
                alvos = [r["cnpj"] for r in cur.fetchall()]
        elif modo == "adjudicacoes":
            # Uma única consulta paginada: a janela inteira. Sem filtro de objeto
            # — o `ObjetoDaContratacao` do portal casa substring LITERAL e é
            # sensível a acento ("projeto básico" → 0 resultados, "projeto
            # executivo" → 4), então filtrar por termo PERDERIA contratos em
            # silêncio. Puxamos tudo acima do piso e classificamos aqui.
            alvos = [f"{_meses_atras(JANELA_ADJUDICACAO_MESES)}..{date.today().isoformat()}"]
        else:
            alvos = TERMOS_OBJETO
        stats["alvos"] = len(alvos)
        print(f"[SWEEP:{modo}] {len(alvos)} alvos — bootstrap Playwright...")

        hoje = date.today().isoformat()
        fim_janela = (
            date.today().replace(year=date.today().year + (date.today().month + JANELA_OBJETO_MESES - 1) // 12,
                                 month=(date.today().month + JANELA_OBJETO_MESES - 1) % 12 + 1)
        ).isoformat()

        with sync_playwright() as pw:
            browser, ctx, headers = _bootstrap(pw)
            for alvo in alvos:
                try:
                    if modo == "cnpj":
                        filtros = {"CNPJ_CPF": _fmt_cnpj(alvo)}
                        origem = "cnpj-sweep"
                        cap = CAP_POR_CNPJ
                    elif modo == "adjudicacoes":
                        inicio_de, inicio_ate = alvo.split("..")
                        filtros = {
                            "InicioDaVigencia_de": inicio_de,
                            "InicioDaVigencia_ate": inicio_ate,
                            "Situacao": "2",  # Ativo
                            "ValorDoContrato_de": PISO_VALOR_ADJUDICACAO,
                        }
                        origem = "adjudicacao"
                        cap = CAP_ADJUDICACAO
                    else:
                        filtros = {
                            "ObjetoDaContratacao": alvo,
                            "Situacao": "2",  # Ativo
                            "FimDaVigencia_de": hoje,
                            "FimDaVigencia_ate": fim_janela,
                        }
                        origem = "objeto-sweep"
                        cap = CAP_POR_TERMO
                    rows = _paginar(ctx, headers, filtros, cap, stats)

                    if modo == "adjudicacoes":
                        # Só licitação DISPUTADA e sem patrocínio. Medido ao vivo
                        # (janela 3m, ≥R$1MM): 637 contratos → 317 LICITAÇÃO.
                        # O resto é INEXIGIBILIDADE/CONVÊNIO/DISPENSA.
                        antes = len(rows)
                        rows = [
                            r for r in rows
                            if (r["modalidade"] or "").strip().upper() in MODALIDADES_LICITADAS
                            and not r["patrocinio"]
                        ]
                        stats["descartados"] += antes - len(rows)

                    with conn.cursor() as cur:
                        for rec in rows:
                            cur.execute(_UPSERT, {**rec, "origem": origem, "agora": agora})
                    conn.commit()
                    stats["contratos"] += len(rows)
                    if rows:
                        print(f"[SWEEP:{modo}] {str(alvo)[:40]}: {len(rows)} contratos")
                except Exception as exc:  # noqa: BLE001 — 1 alvo não derruba o lote
                    conn.rollback()
                    stats["erros"] += 1
                    print(f"[SWEEP:{modo}] {str(alvo)[:40]} erro: {exc}")
            browser.close()

        print(f"[SWEEP:{modo}] fim: {stats}")
        return stats
    finally:
        conn.close()


if __name__ == "__main__":
    import sys

    modo = sys.argv[1] if len(sys.argv) > 1 else "cnpj"
    resultado = run_sweep(modo)
    raise SystemExit(0 if resultado.get("erros", 0) == 0 else 1)
