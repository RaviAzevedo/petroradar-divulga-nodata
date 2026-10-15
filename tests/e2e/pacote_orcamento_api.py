"""
tests/e2e/pacote_orcamento_api.py — Suíte e2e PACOTE/ORÇAMENTO (gate G3-aux do go_no_go).

Valida, contra a stack VIVA (perfil "tests" do compose), as rotas de geração/
download de artefato binário (xlsx/zip) do estrangulador PINADAS AO WEB no NGINX
(nginx/conf.d/petro-radar.conf + nginx/strangler/
routes.conf, "bytes exceljs != openpyxl"):

    GET /api/licitacoes/{id}/pacote-orcamento          (ZIP — JSZip+exceljs)
    GET /api/conformidade/import/template/familias     (XLSX — exceljs)

(O relatório executivo /api/relatorios/executivo saiu com o hub de relatórios
na limpeza de 2026-09-18 — seus 5 testes foram retirados daqui.)

DUAS SUPERFÍCIES testadas (o tester fala DIRETO com os containers, sem NGINX):
  - WEB (ONPREM_BASE_URL=http://web:3000) — o que o NGINX pina: sessão NextAuth
    REAL (tests/lib/auth_helpers.login_web), 200 + Content-Type certo + bytes
    não-vazios + magic number PK (zip/xlsx são ambos containers ZIP). Sem sessão
    o proxy.ts redireciona p/ /login (30x) — aceito 401 como variante defensiva.
  - BFF (BFF_BASE_URL=http://bff:8000) — o que o estrangulador serve nesses
    MESMOS paths (incluídos SEM prefixo por include_migrated):
      · licitacoes_id_pacote_orcamento  → JSON do lado-LEITURA (meta/analise/
        anexos) — o corpo ZIP é incomparável, só a leitura foi migrada;
      · conf_import_template_familias   → XLSX real via openpyxl.
    Auth no BFF: Bearer JWS HS256 forjado (modo (b) de bff/app/core/security.py)
    via tests/lib/auth_helpers.bff_client. Erros 401/403 têm o shape do Next
    ({"error": ..., "code": "UNAUTHENTICATED"|"FORBIDDEN"} — handler de
    bff/app/main.py).

GUARDS exercitados (mensagens EXATAS de app/core/security.py):
    pacote-orcamento  → require_propor       (ADMIN/LIDER/ORCAMENTISTA/TECNICO)
    template familias → require_conformidade (ADMIN/LIDER/SGI)    "Apenas Conformidade"

REGRAS DE OURO respeitadas: 100% GET/read-only (idempotente, sem cleanup);
NENHUMA chamada paga (as 3 rotas não tocam IA — o pacote só LÊ analises_ia, e o
seed nem semeia análise: o ZIP sai com 00_INDICE.txt marcando "[PENDENTE] sem
análise IA", comportamento gracioso de montarPacoteOrcamento). Timeouts httpx
explícitos; suíte inteira < 120 s (seed pequeno; downloads ~KB).

Fixtures canônicas: tests/lib/fixtures.py (LIC_ID semeada com numero 7004990101;
UUID_NAO_SEMEADO válido-mas-ausente → 404 limpo, nunca 22P02).

Execução isolada:
    pytest -q tests/e2e/pacote_orcamento_api.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
import pytest

# Bootstrap defensivo: garante a raiz do repo no sys.path mesmo fora do tester
# (no container PYTHONPATH=/ já resolve; no host, caminho com espaços idem).
_RAIZ = Path(__file__).resolve().parents[2]
if str(_RAIZ) not in sys.path:
    sys.path.insert(0, str(_RAIZ))

from tests.lib import fixtures
from tests.lib.auth_helpers import bff_client, login_web

# ── Constantes do contrato binário ────────────────────────────────────────────
# xlsx e zip são AMBOS containers ZIP: começam com a assinatura local-file PK\x03\x04.
ZIP_MAGIC = b"PK\x03\x04"
CT_ZIP = "application/zip"
CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Timeouts explícitos (orçamento total da suíte < 120 s):
#   - binários no web (JSZip/exceljs): folga de 60 s;
#   - JSON/erros: 20 s bastam.
TIMEOUT_BINARIO = httpx.Timeout(60.0, connect=10.0)
TIMEOUT_CURTO = httpx.Timeout(20.0, connect=10.0)

ROTA_PACOTE = f"/api/licitacoes/{fixtures.LIC_ID}/pacote-orcamento"
ROTA_PACOTE_404 = f"/api/licitacoes/{fixtures.UUID_NAO_SEMEADO}/pacote-orcamento"
ROTA_TEMPLATE = "/api/conformidade/import/template/familias"


def _web_base() -> str:
    return (os.environ.get("ONPREM_BASE_URL") or "http://web:3000").rstrip("/")


def _bff_base() -> str:
    return (os.environ.get("BFF_BASE_URL") or "http://bff:8000").rstrip("/")


def _assert_download(resp: httpx.Response, ct_esperado: str, magic: bytes = ZIP_MAGIC) -> str:
    """Asserts comuns de download binário: 200 + CT + attachment + bytes + magic.

    Devolve o Content-Disposition p/ asserts específicos de filename no chamador.
    """
    assert resp.status_code == 200, (
        f"esperava 200 no download, veio {resp.status_code}: {resp.text[:300]}"
    )
    ct = resp.headers.get("content-type", "")
    assert ct.startswith(ct_esperado), f"Content-Type errado: {ct!r} (esperava {ct_esperado!r})"
    cd = resp.headers.get("content-disposition", "")
    assert "attachment" in cd, f"Content-Disposition sem attachment: {cd!r}"
    corpo = resp.content
    assert corpo, "corpo do download veio VAZIO"
    assert corpo[: len(magic)] == magic, (
        f"magic number errado: {corpo[:8]!r} (esperava prefixo {magic!r})"
    )
    return cd


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures locais — clientes autenticados (1 login web; tokens BFF são forjados)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def web_admin_mod() -> httpx.Client:
    """Sessão NextAuth REAL do admin e2e (ADMIN passa nos 3 guards das rotas).

    Skip apenas se o web estiver INALCANÇÁVEL (stack fora do ar); falha de
    senha/seed continua sendo FAIL (AssertionError do login_web).
    """
    try:
        client = login_web(fixtures.ADMIN_EMAIL, fixtures.E2E_PASSWORD, timeout=30.0)
    except httpx.TransportError as exc:
        pytest.skip(f"web não alcançável ({exc}) — stack no ar? (make up + perfil tests)")
    yield client
    client.close()


@pytest.fixture(scope="module")
def bff_orcamentista() -> httpx.Client:
    """BFF como ORCAMENTISTA — papel canônico de quem orça (passa require_propor)."""
    with bff_client(role="ORCAMENTISTA", timeout=TIMEOUT_CURTO) as c:
        yield c


@pytest.fixture(scope="module")
def bff_sgi() -> httpx.Client:
    """BFF como SGI — passa require_conformidade (template de famílias)."""
    with bff_client(role="SGI", timeout=TIMEOUT_CURTO) as c:
        yield c


@pytest.fixture(scope="module")
def bff_visualizador() -> httpx.Client:
    """BFF como VISUALIZADOR — autenticado, mas FORA de propor/conformidade."""
    with bff_client(role="VISUALIZADOR", timeout=TIMEOUT_CURTO) as c:
        yield c


# ─────────────────────────────────────────────────────────────────────────────
# WEB (rotas pinadas ao Next no NGINX) — download binário com sessão real
# ─────────────────────────────────────────────────────────────────────────────
def test_web_pacote_orcamento_gera_zip_com_sessao(web_admin_mod: httpx.Client):
    """GET pacote-orcamento (web) → 200 application/zip + PK + filename canônico.

    Mesmo SEM análise IA e SEM anexos no seed, montarPacoteOrcamento gera o ZIP
    (00_INDICE.txt sempre presente) — uma falha de R2 nunca derruba o pacote
    (Promise.allSettled). Nada de IA é acionado: rota 100% read-only.
    """
    resp = web_admin_mod.get(ROTA_PACOTE, timeout=TIMEOUT_BINARIO)
    cd = _assert_download(resp, CT_ZIP, ZIP_MAGIC)
    # filename do route.ts: pacote-orcamento_<numero-sanitizado>_<YYYY-MM-DD>.zip
    assert f"pacote-orcamento_{fixtures.LIC_NUMERO}" in cd, (
        f"filename sem o número da licitação-âncora: {cd!r}"
    )
    assert '.zip"' in cd, f"filename não termina em .zip: {cd!r}"
    # Cache-Control: no-store é parte do contrato do handler (download dinâmico).
    assert "no-store" in resp.headers.get("cache-control", ""), (
        "download binário deveria sair com Cache-Control: no-store"
    )


def test_web_pacote_orcamento_404_para_licitacao_nao_semeada(web_admin_mod: httpx.Client):
    """uuid VÁLIDO mas não-semeado → 404 JSON {"error": "Licitação não encontrada"}."""
    resp = web_admin_mod.get(ROTA_PACOTE_404, timeout=TIMEOUT_CURTO)
    assert resp.status_code == 404, f"esperava 404, veio {resp.status_code}: {resp.text[:200]}"
    assert resp.json().get("error") == "Licitação não encontrada"


def test_web_pacote_orcamento_sem_sessao_nao_entrega_bytes():
    """Sem sessão, o proxy.ts intercepta ANTES do handler: 30x → /login (ou 401).

    O importante do gate: NUNCA 200 com corpo ZIP para anônimo.
    """
    with httpx.Client(base_url=_web_base(), timeout=TIMEOUT_CURTO) as anon:
        resp = anon.get(ROTA_PACOTE)
    assert resp.status_code in (301, 302, 303, 307, 308, 401), (
        f"anônimo deveria ser redirecionado/401, veio {resp.status_code}"
    )
    if resp.status_code != 401:
        assert "/login" in resp.headers.get("location", ""), (
            f"redirect anônimo não aponta p/ /login: {resp.headers.get('location')!r}"
        )
    assert not resp.content.startswith(ZIP_MAGIC), "anônimo recebeu bytes de ZIP!"


def test_web_template_familias_xlsx_com_sessao(web_admin_mod: httpx.Client):
    """GET template de famílias (web) → 200 XLSX (exceljs) determinístico.

    Rota sem banco (monta o template em memória): o teste prova o pipeline
    binário do Next puro — CT de planilha + PK + filename fixo do route.ts.
    """
    resp = web_admin_mod.get(ROTA_TEMPLATE, timeout=TIMEOUT_BINARIO)
    cd = _assert_download(resp, CT_XLSX, ZIP_MAGIC)
    assert 'filename="familias_template.xlsx"' in cd, f"filename inesperado: {cd!r}"


# ─────────────────────────────────────────────────────────────────────────────
# BFF — pacote-orcamento: lado-LEITURA migrado (JSON) + guards propor
# ─────────────────────────────────────────────────────────────────────────────
def test_bff_pacote_orcamento_leitura_json_orcamentista(bff_orcamentista: httpx.Client):
    """GET pacote-orcamento no BFF → 200 JSON {meta, analise, anexos}.

    O BFF NÃO replica o ZIP (binário incomparável): expõe as 4 leituras de banco
    que o Next faz antes de empacotar (docstring de licitacoes_id_pacote_orcamento).
    """
    resp = bff_orcamentista.get(ROTA_PACOTE)
    assert resp.status_code == 200, f"esperava 200, veio {resp.status_code}: {resp.text[:300]}"
    assert resp.headers.get("content-type", "").startswith("application/json")
    corpo = resp.json()
    assert set(corpo) == {"meta", "analise", "anexos"}, f"chaves inesperadas: {sorted(corpo)}"
    # meta espelha o que o Next passa a montarPacoteOrcamento (licitação-âncora).
    meta = corpo["meta"]
    assert meta["numero"] == fixtures.LIC_NUMERO
    assert meta["empresa"] == "PETROBRAS"
    assert set(meta) == {"numero", "objeto", "empresa", "segmento"}
    # anexos = lista EDITAL+ADENDO; cada item com a projeção exata do router.
    assert isinstance(corpo["anexos"], list)
    for item in corpo["anexos"]:
        assert set(item) == {"descricao", "s3Key", "contentType", "tamanhoBytes", "origem"}
        assert item["origem"] in ("EDITAL", "ADENDO")
    # Seed não cria analises_ia p/ a âncora — null é o valor canônico aqui;
    # se outro teste semear análise, um dict também é contrato válido.
    assert corpo["analise"] is None or isinstance(corpo["analise"], dict)


def test_bff_pacote_orcamento_404_para_licitacao_nao_semeada(bff_orcamentista: httpx.Client):
    """uuid válido não-semeado → 404 com o MESMO shape do Next (paridade)."""
    resp = bff_orcamentista.get(ROTA_PACOTE_404)
    assert resp.status_code == 404, f"esperava 404, veio {resp.status_code}: {resp.text[:200]}"
    assert resp.json() == {"error": "Licitação não encontrada"}


def test_bff_pacote_orcamento_sem_token_401():
    """Sem Bearer → 401 {"error": "Não autenticado", "code": "UNAUTHENTICATED"}."""
    with httpx.Client(base_url=_bff_base(), timeout=TIMEOUT_CURTO) as anon:
        resp = anon.get(ROTA_PACOTE)
    assert resp.status_code == 401, f"esperava 401, veio {resp.status_code}: {resp.text[:200]}"
    corpo = resp.json()
    assert corpo.get("code") == "UNAUTHENTICATED"
    assert corpo.get("error") == "Não autenticado"


def test_bff_pacote_orcamento_visualizador_403(bff_visualizador: httpx.Client):
    """VISUALIZADOR está FORA de ROLES_PROPOR → 403 com a mensagem exata do guard."""
    resp = bff_visualizador.get(ROTA_PACOTE)
    assert resp.status_code == 403, f"esperava 403, veio {resp.status_code}: {resp.text[:200]}"
    assert resp.json() == {"error": "Sem permissão de propor", "code": "FORBIDDEN"}


# ─────────────────────────────────────────────────────────────────────────────
# BFF — template de famílias: XLSX real (openpyxl) + guard conformidade
# ─────────────────────────────────────────────────────────────────────────────
def test_bff_template_familias_xlsx_sgi(bff_sgi: httpx.Client):
    """GET template no BFF (SGI) → 200 XLSX openpyxl com o MESMO contrato do Next."""
    resp = bff_sgi.get(ROTA_TEMPLATE, timeout=TIMEOUT_BINARIO)
    cd = _assert_download(resp, CT_XLSX, ZIP_MAGIC)
    assert 'filename="familias_template.xlsx"' in cd, f"filename inesperado: {cd!r}"
    assert "no-store" in resp.headers.get("cache-control", "")


def test_bff_template_familias_visualizador_403(bff_visualizador: httpx.Client):
    """VISUALIZADOR fora de ROLES_CONFORMIDADE → 403 "Apenas Conformidade"."""
    resp = bff_visualizador.get(ROTA_TEMPLATE)
    assert resp.status_code == 403, f"esperava 403, veio {resp.status_code}: {resp.text[:200]}"
    assert resp.json() == {"error": "Apenas Conformidade", "code": "FORBIDDEN"}
