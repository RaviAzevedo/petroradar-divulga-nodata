# -*- coding: utf-8 -*-
"""
Enriquecimento de valores REAIS via Portal da Transparência Petrobras.

Em disputas de modalidade FECHADA o Petronect publica apenas valores SIMBÓLICOS
de ranking (centavos — ex.: R$ 0,94); o valor real é sigiloso. Após a assinatura
o contrato aparece no Portal da Transparência (Lei 13.303) com o valor REAL e
com COTR_CD_PROCESSO = número da licitação Petronect — join direto (provado
2026-07-05: processo 7004991007 → contrato e valor homologado).

Fluxo (task tasks.transparencia_valores, beat gated por TRANSPARENCIA_ENABLED):
  1. Seleciona resultados Homologados/Adjudicados com valor simbólico (<R$100)
     ou ausente, ainda não checados (ou checados há > RECHECK_DIAS).
  2. Bootstrap de sessão via Playwright (WAF/Akamai bloqueia requests puros);
     captura o X-CSRFToken.
  3. Uma consulta por NumeroDoProcesso (anti-bulk friendly, com pausa).
  4. UPDATE resultados_licitacao.{valor_contrato_real, contrato_transparencia,
     contrato_vigencia_fim, transparencia_checado_em}. Não encontrado também
     marca checado_em (contrato pode ainda não ter sido assinado — re-checa
     depois de RECHECK_DIAS).

Fonte pública, somente leitura, sem autenticação de usuário.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone

# ── Constantes da API (recon 2026-06-19) ──────────────────────────────────────
HOST = "https://sistematransparencia.petrobras.com.br/A11237"
IFRAME = HOST + "/PortalConsultarContratos?EM=lN3MPBEFoSQ="
EP_LIST = HOST + "/screenservices/A11237_CW/MenuConsulta_Contratos/Contratos/ScreenDataSetGet_Contratos"
MODULE_VERSION = "veS6rUdT_rCJIYZqbwIlKA"
API_VERSION_LIST = "X6v3KmV4aj17BpwdHWUoaQ"
UNIDADES_TODAS = (
    "910816 - Petróleo Brasileiro S.A.#925950 - TERMOCEARÁ LTDA.#925949 - SOC FLUMINENSE DE ENERGIA"
    "#927053 - Petrobras Logist. de Gás#926073 - REFINARIA ABREU E LIMA"
)

BATCH_POR_EXECUCAO = int(os.environ.get("TRANSPARENCIA_BATCH", "30"))
RECHECK_DIAS = int(os.environ.get("TRANSPARENCIA_RECHECK_DIAS", "7"))
PAUSA_ENTRE_CONSULTAS_S = 1.0
PISO_VALOR_SIMBOLICO = 100  # < R$ 100 = valor simbólico de ranking


def _body(numero_processo: str) -> dict:
    return {
        "versionInfo": {"moduleVersion": MODULE_VERSION, "apiVersion": API_VERSION_LIST},
        "viewName": "MenuConsultasIFrame.ContratosIframe",
        "inputParameters": {},
        "screenData": {"variables": {
            "FormFiltros": {
                "UnidadeAdministrativa": UNIDADES_TODAS, "NumerodoContrato": "",
                "NumeroDoProcesso": numero_processo, "EnquadramentoDoProcesso": 0,
                "Situacao": "", "ObjetoDaContratacao": "", "Fornecedor": "",
                "CNPJ_CPF": "", "NumeroDoICJ": "",
                "InicioDaVigencia_de": "1900-01-01", "InicioDaVigencia_ate": "1900-01-01",
                "FimDaVigencia_de": "1900-01-01", "FimDaVigencia_ate": "1900-01-01",
                "ValorDoContrato_de": "", "ValorDoContrato_ate": "",
            },
            "Flag_UnidadeAdminsitrat_Todos": True, "StartIndex": 0, "MaxRecords": 20,
            "Flag_ConsultaAtiva": True, "RefazerConsulta": True,
            "In_EmpresaId": "lN3MPBEFoSQ=", "_in_EmpresaIdInDataFetchStatus": 1,
            "IsIframe": True, "_isIframeInDataFetchStatus": 1,
            "HasUnidadeAdministrativa": True, "TableSort": "", "MensagemValidacao": "",
        }},
    }


def _ddmmyyyy_to_iso(s: str | None) -> str | None:
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def _selecionar_pendentes(conn) -> list[str]:
    """Números de licitação elegíveis ao enriquecimento (limite por execução)."""
    with conn.cursor() as cur:
        # Elegível = QUALQUER resultado sem valor real conhecido (simbólico ou
        # ausente). Não exigimos vencedor/homologação nos NOSSOS dados: a
        # Transparência pode revelar contratos que a coleta não capturou (o
        # processo casa direto). Prioriza os com vencedor/homologação (mais
        # prováveis de já terem contrato assinado).
        cur.execute(
            """
            SELECT numero_licitacao
            FROM resultados_licitacao
            WHERE (
                    -- ciclo normal: sem valor real conhecido (recheck periódico)
                    (valor_contrato_real IS NULL
                     AND (valor_vencedor IS NULL OR valor_vencedor < %s)
                     AND (transparencia_checado_em IS NULL
                          OR transparencia_checado_em < NOW() - make_interval(days => %s)))
                    -- self-heal: enriquecido antes da v2 — completa vencedor/metadados
                    OR (valor_contrato_real IS NOT NULL AND contrato_cnpj IS NULL)
                  )
            ORDER BY (cnpj_vencedor IS NOT NULL) DESC,
                     (status_resultado ILIKE '%%homolog%%' OR status_resultado ILIKE '%%adjudic%%') DESC,
                     detectado_em DESC
            LIMIT %s
            """,
            (PISO_VALOR_SIMBOLICO, RECHECK_DIAS, BATCH_POR_EXECUCAO),
        )
        return [r["numero_licitacao"] for r in cur.fetchall()]


def run_transparencia(timeout_bootstrap_s: int = 60) -> dict:
    """Roda um ciclo de enriquecimento. Retorna estatísticas p/ o sync_log."""
    from playwright.sync_api import sync_playwright  # import tardio (imagem worker)
    import db_util  # get_db_conn (conexão psycopg2 com keepalives)

    conn = db_util.get_db_conn()
    try:
        pendentes = _selecionar_pendentes(conn)
        if not pendentes:
            print("[TRANSPARENCIA] nada pendente")
            # Grava sync_log de sucesso mesmo sem trabalho: mantem o painel de
            # saude e o catch-up (gap por tipo) com "ultima execucao" atual —
            # senao o gap nunca resetaria e o reconciliador re-disparia em loop.
            db_util.registrar_sync_log(
                conn, "transparencia", 0, 0, 0, 0,
                "Transparência: nada pendente (todos os resultados já checados).",
            )
            return {"pendentes": 0, "enriquecidos": 0, "sem_contrato": 0, "erros": 0}

        print(f"[TRANSPARENCIA] {len(pendentes)} pendentes — bootstrap Playwright...")
        stats = {"pendentes": len(pendentes), "enriquecidos": 0, "sem_contrato": 0, "erros": 0}

        with sync_playwright() as pw:
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
            except Exception as exc:  # noqa: BLE001 — WAF/timeout: aborta o ciclo
                print(f"[TRANSPARENCIA] goto falhou: {exc}")
            for _ in range(timeout_bootstrap_s):
                if csrf:
                    break
                page.wait_for_timeout(1000)
            if not csrf:
                browser.close()
                raise RuntimeError("Transparência: bootstrap não obteve CSRF (WAF/rede)")

            headers = {
                "Content-Type": "application/json; charset=UTF-8",
                "Accept": "application/json",
                "X-CSRFToken": csrf[0],
                "Referer": IFRAME,
                "X-Requested-With": "XMLHttpRequest",
            }

            for numero in pendentes:
                try:
                    resp = ctx.request.post(
                        EP_LIST, headers=headers, data=json.dumps(_body(numero)), timeout=60_000
                    )
                    d = resp.json()
                    if d.get("exception"):
                        raise RuntimeError(d["exception"].get("message", "OutSystems exception"))
                    vinfo = d.get("versionInfo") or {}
                    if vinfo.get("hasApiVersionChanged") or vinfo.get("hasModuleVersionChanged"):
                        print("[TRANSPARENCIA] ⚠ versão da API OutSystems mudou — atualizar tokens")
                    rows = ((d.get("data") or {}).get("List") or {}).get("List") or []
                    # Pode haver >1 contrato p/ o mesmo processo (lotes) — usa o de maior valor.
                    melhor = None
                    for row in rows:
                        c = row.get("CONTRATO_TRANSPARENCIA") or {}
                        val = float((row.get("VALOR_CONTRATO") or {}).get("VACO_VL_CONTRATO") or 0)
                        if val >= PISO_VALOR_SIMBOLICO and (melhor is None or val > melhor["valor"]):
                            melhor = {
                                "valor": val,
                                "contrato": str(c.get("COTR_CD_CONTRATO") or ""),
                                "vig_fim": _ddmmyyyy_to_iso(row.get("DatafimVigencia")),
                                "vig_inicio": _ddmmyyyy_to_iso(row.get("DatainicioVigencia")),
                                # Vencedor segundo o contrato (backfill p/ coleta cega)
                                "fornecedor": (c.get("COTR_NM_FORNECEDOR") or "").strip() or None,
                                "cnpj": re.sub(r"\D", "", str(c.get("COTR_CD_CNPJ_CPF") or "")) or None,
                                "situacao": ((row.get("SITUACAO_CONTRATO") or {}).get("SICO_NM_SITUACAO") or "").strip() or None,
                                "aditivos": int(c.get("COTR_QN_ADITIVOS") or 0),
                                "moeda": ((row.get("MOEDA") or {}).get("MOED_SG_MOEDA") or "").strip() or None,
                                "dados": {
                                    "objeto_contrato": (c.get("COTR_DS_OBJETO") or "").replace("\n", " ").strip()[:500] or None,
                                    "unidade": (c.get("COTR_NM_UNIDADE_ADMINISTRATIVA") or "").strip() or None,
                                    "modalidade": ((row.get("MODALIDADE") or {}).get("MODA_NM_MODALIDADE") or "").strip() or None,
                                    "instrumento": (c.get("COTR_DS_INSTRUMENTO_JURIDICO") or "").strip() or None,
                                    "fundamento_legal": (c.get("COTR_DS_FUNDAMENTO_LEGAL") or "").strip() or None,
                                },
                            }
                    with conn.cursor() as cur:
                        if melhor:
                            cur.execute(
                                """
                                UPDATE resultados_licitacao
                                SET valor_contrato_real = %s, contrato_transparencia = %s,
                                    contrato_vigencia_fim = %s, contrato_vigencia_inicio = %s,
                                    contrato_fornecedor = %s, contrato_cnpj = %s,
                                    contrato_situacao = %s, contrato_aditivos = %s,
                                    contrato_moeda = %s, contrato_dados = %s,
                                    transparencia_checado_em = %s
                                WHERE numero_licitacao = %s
                                """,
                                (melhor["valor"], melhor["contrato"], melhor["vig_fim"],
                                 melhor["vig_inicio"], melhor["fornecedor"], melhor["cnpj"],
                                 melhor["situacao"], melhor["aditivos"], melhor["moeda"],
                                 json.dumps(melhor["dados"], ensure_ascii=False),
                                 datetime.now(timezone.utc), numero),
                            )
                            stats["enriquecidos"] += 1
                            print(f"[TRANSPARENCIA] {numero} → contrato {melhor['contrato']} "
                                  f"{melhor['moeda'] or 'R$'} {melhor['valor']:,.2f} | {melhor['fornecedor'] or '?'}")
                        else:
                            cur.execute(
                                """
                                UPDATE resultados_licitacao
                                SET transparencia_checado_em = %s
                                WHERE numero_licitacao = %s
                                """,
                                (datetime.now(timezone.utc), numero),
                            )
                            stats["sem_contrato"] += 1
                    conn.commit()
                except Exception as exc:  # noqa: BLE001 — 1 falha não derruba o lote
                    conn.rollback()
                    stats["erros"] += 1
                    print(f"[TRANSPARENCIA] {numero} erro: {exc}")
                time.sleep(PAUSA_ENTRE_CONSULTAS_S)

            browser.close()

        print(f"[TRANSPARENCIA] fim: {stats}")
        # Persiste o resultado do ciclo no sync_log (tipo='transparencia'): o job
        # so gravava em caso de FALHA (via _grava_sync_log_falha no worker), entao
        # o painel de saude nunca via um sucesso e o gap ficava eternamente alto.
        db_util.registrar_sync_log(
            conn, "transparencia",
            stats["pendentes"], stats["enriquecidos"], stats["sem_contrato"], stats["erros"],
            f"Transparência: {stats['enriquecidos']} enriquecidos, "
            f"{stats['sem_contrato']} sem contrato, {stats['erros']} erros.",
        )
        return stats
    finally:
        conn.close()


if __name__ == "__main__":
    resultado = run_transparencia()
    raise SystemExit(0 if resultado.get("erros", 0) == 0 else 1)
