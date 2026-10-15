# -*- coding: utf-8 -*-
"""
Descoberta SUPLEMENTAR de licitações via módulo Licitações do Portal da
Transparência Petrobras (Lei 13.303) → tabela transparencia_licitacoes.

A tabela `licitacoes` só contém o que a coleta nativa (fonte='petronect')
trouxe. O módulo Licitações do Portal da Transparência publica o UNIVERSO de
licitações das 5 empresas (matriz + subsidiárias). Este job baixa esse universo
e o cruza com a tabela `licitacoes` — o que o portal tem e a base NÃO tem é a
LACUNA de cobertura (superfície "Cobertura Petronect").

Receita (recon P2, provado ao vivo):
  iframe .../A11237/PortalConsultarLicitacao?EM=lN3MPBEFoSQ= ;
  bootstrap Playwright captura x-csrftoken de /screenservices/ (WAF/Akamai
  bloqueia requests puros — mesma técnica do transparencia_job) ; POST à action
  DataActionGetlicitacaoExcel que devolve data.Binary = XLSX base64 com TODAS as
  linhas do filtro DE UMA VEZ (a paginação JSON não funciona em replay, mas o
  EXPORT re-consulta server-side a partir do FormFiltros — GetLicitacoes pode ir
  vazio). O XLSX é parseado com a stdlib (zipfile + xml.etree; o worker não tem
  openpyxl).

Fonte pública, somente leitura, sem autenticação de usuário. Gate:
TRANSPARENCIA_ENABLED (mesmo dos outros sweeps). Beat semanal (domingo).
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import zipfile
from datetime import date, datetime, timezone
import xml.etree.ElementTree as ET

# Reusa constantes/infra do job de valores (mesmo container/imagem).
from transparencia_job import MODULE_VERSION, UNIDADES_TODAS

HOST = "https://sistematransparencia.petrobras.com.br/A11237"
IFRAME = HOST + "/PortalConsultarLicitacao?EM=lN3MPBEFoSQ="
EP_EXCEL = HOST + "/screenservices/A11237_CW/MenuConsulta_Licitacao/Licitacao/DataActionGetlicitacaoExcel"
# apiVersion do módulo Licitacao (recon 2026-07-05). Distinto do de Contratos.
API_VERSION_EXCEL = "D0Ecpth4ph5j3WuoRYQ4bw"
VIEW_NAME = "MenuConsultasIFrame.LicitacaoIframe"

# Janela de publicação (meses para trás a partir de hoje).
JANELA_MESES = int(os.environ.get("TRANSPARENCIA_LIC_MESES", "6"))

# Heurística de serviços/obras sobre o objeto (truncado ~40 chars na fonte) —
# usada só para o stat lacuna_servicos (foco comercial da Proponente).
_SERVICOS_RE = re.compile(
    r"servi[çc]|obra|engenharia|manuten|montagem|reforma|constru[çc]|apoio|"
    r"t[ée]cnic|fiscaliz|inspe[çc]|comission|reparo|instala[çc]|limpeza|"
    r"gerenciam|supervis|caldeiraria|tubula|instrumenta|automa[çc]",
    re.I,
)


# ── XLSX parser (stdlib — worker sem openpyxl) ────────────────────────────────
_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_idx(cell_ref: str) -> int:
    """'A1'->0, 'B2'->1, 'AA3'->26. Converte a letra da referência da célula
    em índice de coluna 0-based (empty cells podem ser omitidas no XML, então
    NÃO se pode confiar na posição sequencial)."""
    letters = re.match(r"[A-Z]+", cell_ref or "")
    if not letters:
        return 0
    idx = 0
    for ch in letters.group(0):
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def _parse_xlsx(raw: bytes) -> list[list[str]]:
    """Devolve as linhas do 1º worksheet como listas de strings (índice por
    coluna real via referência da célula). Usa sharedStrings + inline strings."""
    z = zipfile.ZipFile(io.BytesIO(raw))
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in sst.findall(_NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(_NS + "t")))
    sheet_name = next(
        (n for n in z.namelist() if re.match(r"xl/worksheets/sheet1\.xml$", n)),
        None,
    ) or next(n for n in z.namelist() if n.startswith("xl/worksheets/") and n.endswith(".xml"))
    ws = ET.fromstring(z.read(sheet_name))
    sheet_data = ws.find(_NS + "sheetData")
    rows: list[list[str]] = []
    for row in sheet_data.findall(_NS + "row"):
        cells: dict[int, str] = {}
        for c in row.findall(_NS + "c"):
            ci = _col_idx(c.get("r", ""))
            t = c.get("t")
            if t == "s":  # shared string
                v = c.find(_NS + "v")
                cells[ci] = shared[int(v.text)] if v is not None and v.text else ""
            elif t == "inlineStr":
                is_ = c.find(_NS + "is")
                cells[ci] = "".join(x.text or "" for x in is_.iter(_NS + "t")) if is_ is not None else ""
            else:
                v = c.find(_NS + "v")
                cells[ci] = v.text if v is not None and v.text is not None else ""
        width = (max(cells) + 1) if cells else 0
        rows.append([cells.get(i, "") for i in range(width)])
    return rows


def _ddmmyyyy_iso(s: str | None) -> str | None:
    """'04/02/2026' ou '13/01/2026 00:00:00' -> '2026-02-04' / '2026-01-13'."""
    m = re.match(r"^\s*(\d{2})/(\d{2})/(\d{4})", s or "")
    if not m:
        return None
    ano, mes, dia = m.group(3), m.group(2), m.group(1)
    if ano == "1900":  # sentinela de data ausente no portal
        return None
    return f"{ano}-{mes}-{dia}"


def _meses_atras_iso(meses: int) -> str:
    hoje = date.today()
    total = hoje.year * 12 + (hoje.month - 1) - meses
    ano, mes = divmod(total, 12)
    return date(ano, mes + 1, 1).isoformat()


def _body(pub_de: str, pub_ate: str) -> dict:
    """Corpo da action DataActionGetlicitacaoExcel. O EXPORT re-consulta o banco
    a partir de FormFiltros (server-side) — GetLicitacoes vai VAZIO (o request do
    recon tinha 1 linha e a resposta veio com 1779: prova de que não é montado a
    partir da lista passada)."""
    filtros = {
        "UnidadeAdministrativa": UNIDADES_TODAS,
        "NumeroDaLicitacao": "",
        "NumeroDoProcesso": "",
        "EnquadramentoDoProcesso": 0,
        "Situacao": "0",
        "ObjetoDaContratacao": "",
        "DataDeAbertura_de": "1900-01-01",
        "DataDeAbertura_ate": "1900-01-01",
        "DataDePulicacao_de": pub_de,
        "DataDePulicacao_ate": pub_ate,
        "UnidadeFederativa": "",
        "CargoDoContemplado": "",
    }
    return {
        "versionInfo": {"moduleVersion": MODULE_VERSION, "apiVersion": API_VERSION_EXCEL},
        "viewName": VIEW_NAME,
        "screenData": {"variables": {
            "FormFiltros": filtros,
            "TableSort": "",
            "StartIndex": 0,
            "MaxRecords": 10,
            "FormCheckboxesTela": {
                "OrgaoSuperior": True, "OrgaoSubordinado": True, "UnidadeAdministrativa": True,
                "NumeroDoProcesso": True, "NumeroDoICJ": True, "EnquadramentoDoProcesso": True,
                "CNPJ_CPF": True, "LogDeRegistro": True, "ObjetoDaContratacao": True,
                "ValorDoContrato": True, "SaldoBrutoDoContrato": True, "SaldoInadtivo": True,
                "Situacao": True, "NumerosDosAditivos": True, "FundamentoLegal": True, "All": True,
            },
            "Flag_ConsultaAtiva": True,
            "FormCheckboxesPosConsulta": {
                "OrgaoSuperior": True, "OrgaoSubordinado": True, "UnidadeAdministrativa": True,
                "NumeroDoProcesso": True, "EnquadramentoDoProcesso": True, "QuantidadeDeItens": True,
                "Situacao": True, "NumeroDosContrato": True, "UnidadeFederativa": True,
                "DataDePublicao": True, "LogDeRegistro": False, "All": True,
            },
            "FlagLoading": False,
            "MensagemValidacao": "Foram encontrados os seguintes erros:<br>",
            "Aux_FormCadastro": dict(filtros),
            "FlagLoadingExportarExcel": False,
            "FlagLoadingExportarCSv": True,
            "Flag_UnidadeAdminsitrat_Todos": True,
            "In_IsDefaultUN": False,
            "RefazerConsulta": False,
            "In_EmpresaId": "lN3MPBEFoSQ=",
            "_in_EmpresaIdInDataFetchStatus": 1,
            "IsIframe": True,
            "_isIframeInDataFetchStatus": 1,
            "GetLicitacoes": {"List": {"List": []}, "Count": "0", "DataFetchStatus": 1},
        }},
    }


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
        print(f"[LIC-SWEEP] goto: {exc}")
    for _ in range(60):
        if csrf:
            break
        page.wait_for_timeout(1000)
    if not csrf:
        browser.close()
        raise RuntimeError("Transparência licitações: bootstrap sem CSRF (WAF/rede)")
    headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "Accept": "application/json",
        "X-CSRFToken": csrf[0],
        "Referer": IFRAME,
        "X-Requested-With": "XMLHttpRequest",
    }
    return browser, ctx, headers


# Cabeçalhos esperados no XLSX -> chave interna (robusto a reordenação de coluna).
_HEADER_MAP = {
    "Número da licitação": "numero",
    "Objeto da contratação": "objeto",
    "Data de abertura": "data_abertura",
    "Unidade administrativa": "orgao",
    "Número do processo": "processo",
    "Enquadramento do Processo": "modalidade",
    "Situação": "situacao",
    "Número dos contratos": "contratos_raw",
    "UF": "uf",
    "Data de publicação": "data_publicacao",
    "Cidade de abertura": "cidade",
}


def _linhas_do_xlsx(raw: bytes) -> list[dict]:
    grid = _parse_xlsx(raw)
    if not grid:
        return []
    header = grid[0]
    # posição de cada campo pelo nome do cabeçalho
    pos: dict[str, int] = {}
    for i, h in enumerate(header):
        chave = _HEADER_MAP.get((h or "").strip())
        if chave:
            pos[chave] = i

    def cell(row: list[str], chave: str) -> str:
        i = pos.get(chave)
        if i is None or i >= len(row):
            return ""
        return (row[i] or "").strip()

    out: list[dict] = []
    for row in grid[1:]:
        numero = cell(row, "numero")
        if not numero:
            continue
        contratos_raw = cell(row, "contratos_raw")
        out.append({
            "numero": numero,
            "processo": cell(row, "processo") or None,
            "objeto": cell(row, "objeto") or None,
            "cidade": cell(row, "cidade") or None,
            "uf": cell(row, "uf") or None,
            "situacao": cell(row, "situacao") or None,
            "modalidade": cell(row, "modalidade") or None,
            "data_abertura": _ddmmyyyy_iso(cell(row, "data_abertura")),
            "data_publicacao": _ddmmyyyy_iso(cell(row, "data_publicacao")),
            "tem_contratos": bool(contratos_raw),
            "orgao": cell(row, "orgao") or None,
        })
    return out


_UPSERT = """
INSERT INTO transparencia_licitacoes (
  numero, processo, objeto, cidade, uf, situacao, modalidade,
  data_abertura, data_publicacao, tem_contratos, orgao, atualizado_em
) VALUES (
  %(numero)s, %(processo)s, %(objeto)s, %(cidade)s, %(uf)s, %(situacao)s,
  %(modalidade)s, %(data_abertura)s, %(data_publicacao)s, %(tem_contratos)s,
  %(orgao)s, %(agora)s
)
ON CONFLICT (numero) DO UPDATE SET
  processo = EXCLUDED.processo, objeto = EXCLUDED.objeto,
  cidade = EXCLUDED.cidade, uf = EXCLUDED.uf, situacao = EXCLUDED.situacao,
  modalidade = EXCLUDED.modalidade, data_abertura = EXCLUDED.data_abertura,
  data_publicacao = EXCLUDED.data_publicacao, tem_contratos = EXCLUDED.tem_contratos,
  orgao = EXCLUDED.orgao, atualizado_em = EXCLUDED.atualizado_em
"""
# capturado_em / no_banco NÃO são atualizados no conflito (primeiro captura;
# no_banco é recomputado no UPDATE final).


# Ingestão das DESCOBERTAS em licitacoes (fonte='transparencia'), p/ aparecerem
# no Explorar como as demais (com pin). ON CONFLICT DO NOTHING: nunca sobrescreve
# uma licitação coletada nativamente pelo Petronect.
_INGEST = """
INSERT INTO licitacoes (
  id, numero, fonte, objeto, objeto_resumido, empresa, modalidade, status,
  data_abertura, data_publicacao, regioes, natureza, tipo_servico, segmento,
  relevancia, score_interesse, perfis_match, melhor_perfil, dados_completos,
  notificado_perfil_em, criado_em, atualizado_em
) VALUES (
  gen_random_uuid(), %(numero)s, 'transparencia', %(objeto)s, %(objeto)s,
  %(empresa)s, %(modalidade)s, %(status)s, %(data_abertura)s, %(data_publicacao)s,
  %(regioes)s, %(natureza)s, %(tipo_servico)s, %(segmento)s, %(relevancia)s,
  %(score_interesse)s, %(perfis_match)s, %(melhor_perfil)s, %(dados_completos)s::jsonb,
  %(agora)s, COALESCE(%(criado_em)s::timestamp, %(agora)s), %(agora)s
)
ON CONFLICT (numero) DO NOTHING
"""
# notificado_perfil_em = agora: são descobertas RETROATIVAS (publicadas nos
# últimos meses), não publicações novas — suprime o surto de alertas de perfil
# do cron oportunidades-novas. Aparecem no Explorar, mas não geram notificação.
# criado_em = data de PUBLICAÇÃO (não o instante da ingestão), p/ não caírem no
# selo "NOVA" (24h) nem no filtro "Novas 24h" e ordenarem por data real.


def run(meses: int | None = None) -> dict:
    """Baixa o EXPORT XLSX dos últimos N meses, faz upsert e recomputa no_banco.
    Retorna stats {linhas, novas, lacuna_total, lacuna_servicos}."""
    from playwright.sync_api import sync_playwright  # import tardio (imagem worker)
    import db_util  # get_db_conn / carregar_perfis / classificar_licitacao_db

    meses = JANELA_MESES if meses is None else meses
    pub_de = _meses_atras_iso(meses)
    pub_ate = date.today().isoformat()
    agora = datetime.now(timezone.utc)

    conn = db_util.get_db_conn()
    try:
        print(f"[LIC-SWEEP] janela publicação {pub_de} → {pub_ate} — bootstrap Playwright...")
        with sync_playwright() as pw:
            browser, ctx, headers = _bootstrap(pw)
            try:
                resp = ctx.request.post(
                    EP_EXCEL, headers=headers, data=json.dumps(_body(pub_de, pub_ate)),
                    timeout=120_000,
                )
                d = resp.json()
            finally:
                browser.close()

        if d.get("exception"):
            raise RuntimeError(d["exception"].get("message", "OutSystems exception"))
        vinfo = d.get("versionInfo") or {}
        if vinfo.get("hasApiVersionChanged") or vinfo.get("hasModuleVersionChanged"):
            print("[LIC-SWEEP] ⚠ versão da API OutSystems mudou — atualizar tokens")
        b64 = ((d.get("data") or {}).get("Binary")) or ""
        if not b64:
            raise RuntimeError("Transparência licitações: resposta sem data.Binary (XLSX)")

        linhas = _linhas_do_xlsx(base64.b64decode(b64))
        print(f"[LIC-SWEEP] XLSX parseado: {len(linhas)} linhas")

        # novas = números ainda inexistentes na tabela (antes do upsert)
        with conn.cursor() as cur:
            cur.execute("SELECT numero FROM transparencia_licitacoes")
            existentes = {r["numero"] for r in cur.fetchall()}
        novas = sum(1 for l in linhas if l["numero"] not in existentes)

        with conn.cursor() as cur:
            for l in linhas:
                cur.execute(_UPSERT, {**l, "agora": agora})
        conn.commit()

        # recomputa no_banco = cobertura NATIVA (fonte='petronect'); descobertas
        # ingeridas ('transparencia') NÃO contam como coletadas nativamente, de
        # modo que a Cobertura Petronect não zera ao ingerir a lacuna.
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE transparencia_licitacoes tl
                SET no_banco = EXISTS (
                    SELECT 1 FROM licitacoes l
                    WHERE l.numero = tl.numero AND l.fonte = 'petronect'
                )
                """
            )
        conn.commit()

        # INGESTÃO no Explorar: cada descoberta (no_banco=false) entra em
        # licitacoes como fonte='transparencia', classificada pelo motor único
        # (segmento/score/perfis) p/ ser pesquisável e batível de perfil como as
        # demais. Idempotente (DO NOTHING).
        perfis = db_util.carregar_perfis(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT numero, objeto, modalidade, cidade, uf, situacao,
                       data_abertura, data_publicacao, orgao, tem_contratos
                FROM transparencia_licitacoes WHERE no_banco = false
                """
            )
            descobertas = cur.fetchall()
        ingeridas = 0
        for row in descobertas:
            objeto = (row["objeto"] or "").strip()
            classif = db_util.classificar_licitacao_db(
                {"objeto": objeto, "objeto_resumido": objeto, "itens": []}, perfis
            )
            regioes = "/".join(x for x in (row["cidade"], row["uf"]) if x) or (row["uf"] or None)
            dados = json.dumps({
                "origem": "transparencia",
                "cidade": row["cidade"], "uf": row["uf"],
                "situacao": row["situacao"], "tem_contratos": row["tem_contratos"],
                "portal": "https://transparencia.petrobras.com.br/licitacoes",
            }, ensure_ascii=False)
            with conn.cursor() as cur:
                cur.execute(_INGEST, {
                    "numero": row["numero"], "objeto": objeto or None,
                    "empresa": row["orgao"], "modalidade": row["modalidade"],
                    "status": row["situacao"], "regioes": regioes,
                    "data_abertura": row["data_abertura"],
                    "data_publicacao": row["data_publicacao"],
                    "natureza": classif.get("natureza"),
                    "tipo_servico": classif.get("tipo_servico"),
                    "segmento": classif.get("segmento"),
                    "relevancia": classif.get("relevancia"),
                    "score_interesse": classif.get("score_interesse"),
                    "perfis_match": classif.get("perfis_match"),
                    "melhor_perfil": classif.get("melhor_perfil"),
                    "dados_completos": dados, "agora": agora,
                    "criado_em": row["data_publicacao"] or row["data_abertura"],
                })
                if cur.rowcount == 1:
                    ingeridas += 1
        conn.commit()

        # stats de lacuna
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM transparencia_licitacoes WHERE no_banco = false")
            lacuna_total = int(cur.fetchone()["n"])
            cur.execute(
                """
                SELECT numero, objeto FROM transparencia_licitacoes
                WHERE no_banco = false AND objeto IS NOT NULL
                """
            )
            lacuna_servicos = sum(1 for r in cur.fetchall() if _SERVICOS_RE.search(r["objeto"] or ""))

        stats = {
            "linhas": len(linhas),
            "novas": novas,
            "lacuna_total": lacuna_total,
            "lacuna_servicos": lacuna_servicos,
            "ingeridas_explorar": ingeridas,
        }
        print(f"[LIC-SWEEP] fim: {stats}")
        return stats
    finally:
        conn.close()


if __name__ == "__main__":
    resultado = run()
    raise SystemExit(0)
