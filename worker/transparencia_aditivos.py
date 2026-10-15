# -*- coding: utf-8 -*-
"""
Aditivos dos contratos revelados (Portal da Transparência) — Fase 2 (F2).

Descoberta no recon P1: a listagem de contratos traz COTR_QN_ADITIVOS SEMPRE 0
(mesmo quando há aditivos!), então a ÚNICA via confiável é a consulta dedicada
de aditivos (ScreenDataSetGetAditivoByFormBusca, filtro por NumeroContrato), que
devolve o DETALHE completo: objeto, valor, vigência, instrumento. Público.

Este job, para cada contrato JÁ revelado em resultados_licitacao
(contrato_transparencia IS NOT NULL), busca seus aditivos e:
  • grava o detalhe em contrato_dados->'aditivos' (jsonb),
  • corrige contrato_aditivos (contagem real),
  • ESTENDE contrato_vigencia_fim para a maior DataFinalVigencia de aditivo
    (aditivo de prazo = renovação ADIADA → o Radar de Renovação para de tratar
    o contrato como "vencendo" antes da hora),
  • guarda em contrato_dados o valor total aditivado e o % de "engorda".

Bounded aos contratos revelados (centenas), não ao universo do sweep. 1 req/s.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone

from transparencia_job import IFRAME, MODULE_VERSION, _ddmmyyyy_to_iso

HOST = "https://sistematransparencia.petrobras.com.br/A11237"
EP_ADITIVOS = HOST + "/screenservices/A11237_CW/MenuConsulta_Aditivos/Aditivos/ScreenDataSetGetAditivoByFormBusca"
IFRAME_ADITIVOS = HOST + "/PortalConsultarAditivos?EM=lN3MPBEFoSQ="
API_VERSION_ADITIVOS = "m4E26lf7quqa+kKiCfxUDQ"
UNIDADES_TODAS = (
    "910816 - Petróleo Brasileiro S.A.#925950 - TERMOCEARÁ LTDA."
    "#925949 - SOC FLUMINENSE DE ENERGIA#927053 - Petrobras Logist. de Gás"
    "#926073 - REFINARIA ABREU E LIMA"
)
PAUSA_S = 1.0
BATCH = int(__import__("os").environ.get("TRANSPARENCIA_ADITIVOS_BATCH", "400"))


def _body(numero_contrato: str) -> dict:
    return {
        "versionInfo": {"moduleVersion": MODULE_VERSION, "apiVersion": API_VERSION_ADITIVOS},
        "viewName": "MenuConsultasIFrame.AditivosIframe",
        "inputParameters": {},
        "screenData": {"variables": {
            "FormBuscaAditivos": {
                "UnidadeAdministrativa": UNIDADES_TODAS,
                "NumeroContrato": numero_contrato, "NumeroProcesso": "",
                "NumeroAditivo": "", "ObjetoDoAditivo": "", "Fornecedor": "",
                "NumeroICJ": "", "CriacaoInicial": "1900-01-01",
                "CriacaoFinal": "1900-01-01",
                "DataInicialVigenciaInicial": "1900-01-01",
                "DataInicialVigenciaFinal": "1900-01-01",
                "DataFinalVigenciaInicial": "1900-01-01",
                "DataFinalVigenciaFinal": "1900-01-01",
                "ValorMinimo": "", "ValorMaximo": "",
                "ValorMinimoAditivo": "", "ValorMaximoAditivo": "",
                "IsPatrocinio": False,
            },
            "StartIndex": 0, "MaxRecords": 100,
        }},
    }


def _parse_aditivo(row: dict) -> dict:
    # Estrutura real (recon): o detalhe do aditivo fica em ADITIVO_TRANSPARENCIA;
    # o valor em VALOR_ADITIVO.VAAD_VL_ADITIVO (0 p/ aditivo só de prazo); as
    # vigências no nível da linha (DataInicialVigencia/DataFinalVigencia).
    at = row.get("ADITIVO_TRANSPARENCIA") or {}
    va = row.get("VALOR_ADITIVO") or {}
    return {
        "codigo": str(at.get("ADTR_CD_ADITIVO") or "").strip(),
        "objeto": (at.get("ADTR_DS_OBJETO") or "").replace("\n", " ").strip()[:300],
        "instrumento": (at.get("ADTR_DS_INSTRUMENTO_JURIDICO") or "").strip()[:200] or None,
        "valor": float(va.get("VAAD_VL_ADITIVO") or 0) or None,
        "moeda": ((row.get("MOEDA_Aditivo") or {}).get("MOED_SG_MOEDA") or "").strip() or None,
        "vig_inicio": _ddmmyyyy_to_iso(row.get("DataInicialVigencia")),
        "vig_fim": _ddmmyyyy_to_iso(row.get("DataFinalVigencia")),
    }


def _bootstrap(pw):
    browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(locale="pt-BR")
    page = ctx.new_page()
    csrf: list[str] = []
    page.on("request", lambda r: (
        csrf.append(r.headers.get("x-csrftoken"))
        if "/screenservices/" in r.url and r.headers.get("x-csrftoken") and not csrf else None
    ))
    try:
        page.goto(IFRAME_ADITIVOS, wait_until="domcontentloaded", timeout=45_000)
    except Exception as exc:  # noqa: BLE001
        print(f"[ADITIVOS] goto: {exc}")
    for _ in range(60):
        if csrf:
            break
        page.wait_for_timeout(1000)
    if not csrf:
        # fallback: iframe de contratos também emite CSRF válido p/ o mesmo app
        try:
            page.goto(IFRAME, wait_until="domcontentloaded", timeout=45_000)
            for _ in range(30):
                if csrf:
                    break
                page.wait_for_timeout(1000)
        except Exception:  # noqa: BLE001
            pass
    if not csrf:
        browser.close()
        raise RuntimeError("Aditivos: bootstrap sem CSRF (WAF/rede)")
    headers = {
        "Content-Type": "application/json; charset=UTF-8", "Accept": "application/json",
        "X-CSRFToken": csrf[0], "Referer": IFRAME_ADITIVOS,
        "X-Requested-With": "XMLHttpRequest",
    }
    return browser, ctx, headers


_SEL = """
SELECT id, contrato_transparencia AS contrato,
       valor_contrato_real AS valor_base, contrato_vigencia_fim AS vig_fim
FROM resultados_licitacao
WHERE contrato_transparencia IS NOT NULL
ORDER BY valor_contrato_real DESC NULLS LAST
LIMIT %(batch)s
"""

_UPD = """
UPDATE resultados_licitacao SET
  contrato_aditivos = %(qtd)s,
  contrato_vigencia_fim = %(vig_fim)s,
  contrato_dados = COALESCE(contrato_dados, '{}'::jsonb)
    || jsonb_build_object(
      'aditivos', %(aditivos)s::jsonb,
      'aditivos_valor_total', %(valor_total)s,
      'aditivos_engorda_pct', %(engorda)s
    ),
  transparencia_checado_em = %(agora)s
WHERE id = %(id)s
"""


def run() -> dict:
    from playwright.sync_api import sync_playwright
    import db_util

    conn = db_util.get_db_conn()
    agora = datetime.now(timezone.utc)
    stats = {"contratos": 0, "consultas": 0, "com_aditivos": 0,
             "vigencias_estendidas": 0, "erros": 0}
    try:
        with conn.cursor() as cur:
            cur.execute(_SEL, {"batch": BATCH})
            alvos = cur.fetchall()
        stats["contratos"] = len(alvos)
        print(f"[ADITIVOS] {len(alvos)} contratos revelados — bootstrap...")

        with sync_playwright() as pw:
            browser, ctx, headers = _bootstrap(pw)
            for row in alvos:
                numero = str(row["contrato"]).strip()
                if not numero:
                    continue
                try:
                    resp = ctx.request.post(
                        EP_ADITIVOS, headers=headers,
                        data=json.dumps(_body(numero)), timeout=60_000,
                    )
                    d = resp.json()
                    stats["consultas"] += 1
                    if d.get("exception"):
                        raise RuntimeError(d["exception"].get("message", "exc"))
                    vinfo = d.get("versionInfo") or {}
                    if vinfo.get("hasApiVersionChanged"):
                        print("[ADITIVOS] ⚠ apiVersion mudou — reextrair token")
                    rows = ((d.get("data") or {}).get("List") or {}).get("List") or []
                    aditivos = [_parse_aditivo(r) for r in rows if r.get("ADTR_CD_ADITIVO")]

                    vig_fim = row["vig_fim"]
                    valor_total = None
                    engorda = None
                    if aditivos:
                        stats["com_aditivos"] += 1
                        # vigência efetiva = maior DataFinalVigencia entre base e aditivos
                        fins = [a["vig_fim"] for a in aditivos if a["vig_fim"]]
                        if row["vig_fim"]:
                            fins.append(row["vig_fim"])
                        if fins:
                            novo = max(fins)
                            if row["vig_fim"] and novo > row["vig_fim"]:
                                stats["vigencias_estendidas"] += 1
                            vig_fim = novo
                        valor_total = round(sum(a["valor"] or 0 for a in aditivos), 2) or None
                        base = float(row["valor_base"] or 0)
                        if base and valor_total:
                            engorda = round(100.0 * valor_total / base, 2)

                    with conn.cursor() as cur:
                        cur.execute(_UPD, {
                            "id": row["id"], "qtd": len(aditivos),
                            "vig_fim": vig_fim, "aditivos": json.dumps(aditivos),
                            "valor_total": valor_total, "engorda": engorda,
                            "agora": agora,
                        })
                    conn.commit()
                except Exception as exc:  # noqa: BLE001
                    conn.rollback()
                    stats["erros"] += 1
                    print(f"[ADITIVOS] contrato {numero}: {exc}")
                time.sleep(PAUSA_S)
            browser.close()

        print(f"[ADITIVOS] fim: {stats}")
        return stats
    finally:
        conn.close()


if __name__ == "__main__":
    resultado = run()
    raise SystemExit(0 if resultado.get("erros", 0) == 0 else 1)
