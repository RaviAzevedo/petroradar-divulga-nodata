"""tests/e2e/licitacoes_api.py — Suíte E2E do DOMÍNIO LICITAÇÕES via BFF (WP12 §3).

Alimenta tests/_artifacts/e2e_results.json → suites["licitacoes_api"] (gate G3
do go_no_go.py; as rotas aqui exercitadas também constam do inventário do G2).
Roda contra a STACK VIVA (perfil "tests" do compose: web:3000 / bff:8000 /
Postgres) — NENHUM mock de rede; o cross-check de paridade do total vai DIRETO
no banco (psycopg via tests.lib.auth_helpers.db_conn).

ROTAS SOB TESTE (migradas ao BFF — estrangulador, paths /api/* SEM prefixo;
contrato lido do código REAL em bff/app/routers/migrated/):
  - GET /api/licitacoes          (licitacoes_list.py)   guard require_visualizar
        listagem paginada ``{data:[...], meta:{total,page,limit,pages}}``;
        filtros search/empresa/relevancia (csv); sort whitelist + order;
        clamps page>=1 / limit 1..100 (parseInt JS → "abc" cai no default);
        ``habilitacao`` ∈ {SEM_ITENS, COBERTO, NENHUM, PARCIAL} por página.
  - GET /api/licitacoes/{id}     (licitacoes_id.py)     guard require_visualizar
        400 ``{error:"ID inválido"}`` (regex UUID); 404 ``{error:{code:
        NOT_FOUND}}``; 200 ``{data:{...lic, itens, anexos, historico, analise,
        totalCirculares}}``.
  - GET /api/licitacoes/search   (licitacoes_search.py) guard require_visualizar
        RBAC hardening (FRENTE D): exige ROLES_VISUALIZAR — EXTERNO recebe 403
        (a busca expõe pipeline interno). ``q`` trim < 2 → shape vazio SEM tocar
        o banco; LIMIT 5 (licitacoes).

CONTRATO DE ERRO de auth (handler global em bff/app/main.py): 401/403 são
reescritos para o shape do Next ``{error:<msg>, code:UNAUTHENTICATED|FORBIDDEN}``;
400/404 chegam com o dict exato que a rota montou.

ANCORAGEM: dados canônicos de tests/lib/fixtures.py, semeados por
tests/fixtures/seed.sql (make seed-e2e): LIC_ID/LIC_NUMERO (PETROBRAS,
relevância ALTA) e LIC_ID_2/LIC_NUMERO_2 (PETROBRAS, concluída). Auth no BFF:
JWS HS256 forjado (modo (b) de bff/app/core/security.py) via
tests.lib.auth_helpers.bff_client — sem depender do login NextAuth.

IDEMPOTÊNCIA: suíte 100% read-only (só GET) — re-execução não suja estado e não
há cleanup. Timeout explícito por client; total da suíte << 120s. NENHUMA
chamada paga (nenhum fluxo de IA é acionado por estas rotas GET).
"""

from __future__ import annotations

import math
import os
import uuid

import httpx
import pytest

from tests.lib import fixtures
from tests.lib.auth_helpers import DEFAULT_BFF_BASE, bff_client, db_conn

# Timeout único e explícito (requests simples de leitura; mantém a suíte rápida
# e falha cedo se a stack estiver fora do ar em vez de pendurar o gate).
TIMEOUT_S = 20.0

# Valores possíveis da cobertura CRC por página (CASE de licitacoes_list.py).
_HABILITACOES = {"SEM_ITENS", "COBERTO", "NENHUM", "PARCIAL"}

# Colunas-núcleo da projeção camelCase da listagem (licitacoes_list.py) que
# TODA linha precisa expor — superset é tolerado, ausência é quebra de contrato.
_COLUNAS_LISTAGEM = {
    "id", "numero", "objeto", "empresa", "status", "subStatus", "fase",
    "modalidade", "dataInicio", "dataFim", "dataPublicacao", "natureza",
    "tipoServico", "segmento", "relevancia", "scoreInteresse", "regioes",
    "criadoEm", "habilitacao",
}

# Projeção EXATA do autocomplete (licitacoes_search.py — 5 colunas, nada além).
_COLUNAS_SEARCH_LIC = {"id", "numero", "objeto", "empresa", "relevancia"}


def _base_bff() -> str:
    """Base do BFF (no tester: http://bff:8000 — rotas /api/* sem prefixo)."""
    return (os.environ.get("BFF_BASE_URL") or DEFAULT_BFF_BASE).rstrip("/")


# ─────────────────────────────────────────────────────────────────────────────
# Clients por papel (escopo de módulo: 1 token forjado por papel p/ a suíte toda)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def admin():
    """Client BFF autenticado como ADMIN (passa require_visualizar)."""
    with bff_client(role="ADMIN", timeout=TIMEOUT_S) as c:
        yield c


@pytest.fixture(scope="module")
def viewer():
    """Client BFF como VISUALIZADOR (último papel DENTRO de ROLES_VISUALIZAR)."""
    with bff_client(role="VISUALIZADOR", timeout=TIMEOUT_S) as c:
        yield c


@pytest.fixture(scope="module")
def externo():
    """Client BFF como EXTERNO (autenticado, mas FORA de ROLES_VISUALIZAR —
    barrado com 403 em listagem, detalhe E busca desde o RBAC hardening)."""
    with bff_client(role="EXTERNO", timeout=TIMEOUT_S) as c:
        yield c


@pytest.fixture(scope="module")
def anon():
    """Client SEM Authorization — prova o 401 dos guards."""
    with httpx.Client(base_url=_base_bff(), timeout=TIMEOUT_S) as c:
        yield c


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/licitacoes — listagem (shape, paginação, clamps)
# ─────────────────────────────────────────────────────────────────────────────
def test_listagem_200_shape_data_e_meta(admin):
    """Listagem default: 200 + envelope {data, meta} com colunas e tipos do contrato."""
    r = admin.get("/api/licitacoes")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) >= {"data", "meta"}, f"envelope inesperado: {sorted(body)}"

    meta = body["meta"]
    for chave in ("total", "page", "limit", "pages"):
        assert isinstance(meta.get(chave), int), f"meta.{chave} não é int: {meta}"
    # Defaults do Next replicados: page=1, limit=20.
    assert meta["page"] == 1 and meta["limit"] == 20, meta
    # As duas licitações-âncora do seed garantem total >= 2 (banco pode ter mais).
    assert meta["total"] >= 2, f"seed e2e ausente? total={meta['total']} (make seed-e2e)"
    assert meta["pages"] == math.ceil(meta["total"] / meta["limit"]), meta

    data = body["data"]
    assert isinstance(data, list) and len(data) <= meta["limit"]
    assert data, "página 1 vazia com total >= 2"
    for item in data:
        faltando = _COLUNAS_LISTAGEM - set(item)
        assert not faltando, f"colunas ausentes na listagem: {sorted(faltando)}"
        assert item["habilitacao"] in _HABILITACOES, item["habilitacao"]
        # fase corrigida em tempo real (faseAtualizada) — nunca null/vazia ("—" ok).
        assert isinstance(item["fase"], str) and item["fase"], item


def test_listagem_paginacao_limit_1_consistente(admin):
    """limit=1&page=2: clamps respeitados e pages == ceil(total/1) na MESMA resposta."""
    r = admin.get("/api/licitacoes", params={"limit": 1, "page": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    meta = body["meta"]
    assert meta["limit"] == 1 and meta["page"] == 2, meta
    assert len(body["data"]) <= 1
    # pages calculado sobre o total da PRÓPRIA resposta (sem race com a coleta).
    assert meta["pages"] == meta["total"], meta


def test_listagem_clamps_de_paginacao_estilo_js(admin):
    """Réplica dos clamps do Next: limit>100 → 100; page=0 → 1; limit não-numérico → 20."""
    r = admin.get("/api/licitacoes", params={"limit": 999, "page": 0})
    assert r.status_code == 200, r.text
    meta = r.json()["meta"]
    assert meta["limit"] == 100, f"clamp limit 1..100 quebrado: {meta}"
    assert meta["page"] == 1, f"clamp page>=1 quebrado: {meta}"

    # parseInt("abc") → NaN → || default (20). NUNCA 400/422.
    r2 = admin.get("/api/licitacoes", params={"limit": "abc"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["meta"]["limit"] == 20


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/licitacoes — filtros (search / empresa / relevancia csv / sort)
# ─────────────────────────────────────────────────────────────────────────────
def test_listagem_filtro_search_acha_a_ancora(admin):
    """search=<numero da âncora>: âncora na página e TODAS as linhas casam o termo."""
    termo = fixtures.LIC_NUMERO
    r = admin.get("/api/licitacoes", params={"search": termo, "limit": 100})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["total"] >= 1, f"âncora {termo} não encontrada (seed e2e rodou?)"
    ids = {item["id"] for item in body["data"]}
    assert fixtures.LIC_ID in ids, f"LIC_ID fora do resultado de search={termo}: {ids}"
    # ILIKE em objeto/numero/regioes/empresa — toda linha devolvida tem que casar.
    for item in body["data"]:
        campos = (item["objeto"], item["numero"], item["regioes"], item["empresa"])
        assert any(termo.lower() in (c or "").lower() for c in campos), item


def test_listagem_total_do_search_casa_com_o_banco(admin):
    """meta.total do search == count(*) com o MESMO ILIKE direto no Postgres."""
    termo = fixtures.LIC_NUMERO
    r = admin.get("/api/licitacoes", params={"search": termo})
    assert r.status_code == 200, r.text
    total_api = r.json()["meta"]["total"]

    padrao = f"%{termo}%"
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM licitacoes "
            "WHERE objeto ILIKE %s OR numero ILIKE %s "
            "   OR regioes ILIKE %s OR empresa ILIKE %s",
            (padrao, padrao, padrao, padrao),
        )
        total_db = cur.fetchone()[0]
    # O nº da âncora é exclusivo do seed (prefixo 70049901xx) — sem race com a
    # coleta de produção; igualdade ESTRITA prova a paridade do WHERE.
    assert total_api == total_db, f"API={total_api} != DB={total_db} (search={termo})"


def test_listagem_filtro_empresa(admin):
    """empresa=PETROBRAS (ILIKE): >= 2 âncoras e todas as linhas casam o filtro."""
    r = admin.get("/api/licitacoes", params={"empresa": "PETROBRAS", "limit": 100})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["total"] >= 2, body["meta"]  # as duas âncoras são PETROBRAS
    for item in body["data"]:
        assert "petrobras" in (item["empresa"] or "").lower(), item


def test_listagem_filtro_relevancia_csv_combinado(admin):
    """relevancia=ALTA combinado com search: inclui a âncora ALTA e EXCLUI a SEM INTERESSE."""
    # Âncora 0101 é ALTA → entra.
    r = admin.get(
        "/api/licitacoes",
        params={"relevancia": "ALTA", "search": fixtures.LIC_NUMERO, "limit": 100},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["total"] >= 1, body["meta"]
    assert all(item["relevancia"] == "ALTA" for item in body["data"]), body["data"]
    assert fixtures.LIC_ID in {item["id"] for item in body["data"]}

    # Âncora 0102 é SEM INTERESSE (hotelaria — ponto fixo do reclassify sob o
    # motor novo: nenhum perfil casa) → filtro ALTA + search
    # pelo número dela = conjunto vazio.
    r2 = admin.get(
        "/api/licitacoes",
        params={"relevancia": "ALTA", "search": fixtures.LIC_NUMERO_2},
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["meta"]["total"] == 0 and body2["data"] == [], body2


def test_listagem_ordenacao_numero_asc(admin):
    """sort=numero&order=asc: números (dígitos puros) saem em ordem crescente."""
    # Prefixo 7004990 isola as âncoras do seed → conjunto estável e só-dígitos
    # (ordem lexicográfica == numérica, imune a collation).
    r = admin.get(
        "/api/licitacoes",
        params={"search": "7004990", "sort": "numero", "order": "asc", "limit": 100},
    )
    assert r.status_code == 200, r.text
    numeros = [item["numero"] for item in r.json()["data"] if item["numero"]]
    assert len(numeros) >= 2, f"esperava >=2 âncoras 7004990*: {numeros}"
    assert numeros == sorted(numeros), f"ordenação asc quebrada: {numeros}"
    assert fixtures.LIC_NUMERO in numeros and fixtures.LIC_NUMERO_2 in numeros


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/licitacoes/{id} — detalhe agregado (200 / 404 / 400)
# ─────────────────────────────────────────────────────────────────────────────
def test_detalhe_ancora_campos_chave_e_filhos(admin):
    """Detalhe da LIC_ID: identidade da âncora + agregados (itens/anexos/...)."""
    r = admin.get(f"/api/licitacoes/{fixtures.LIC_ID}")
    assert r.status_code == 200, r.text
    data = r.json()["data"]

    # Identidade (valores travados no seed canônico).
    assert data["id"] == fixtures.LIC_ID
    assert data["numero"] == fixtures.LIC_NUMERO
    assert data["empresa"] == "PETROBRAS"

    # Agregados do shape (6 queries do handler): listas + analise (dict|None) +
    # totalCirculares (count int). Conteúdo dos filhos depende do seed — aqui o
    # contrato é o TIPO, não a cardinalidade.
    for chave in ("itens", "anexos", "historico"):
        assert isinstance(data.get(chave), list), f"data.{chave} não é lista"
    assert "analise" in data and (data["analise"] is None or isinstance(data["analise"], dict))
    assert isinstance(data.get("totalCirculares"), int) and data["totalCirculares"] >= 0


def test_detalhe_uuid_inexistente_404(admin):
    """UUID válido porém ausente → 404 {error:{code:NOT_FOUND}} (nunca 400/500)."""
    for alvo in (str(uuid.uuid4()), fixtures.UUID_NAO_SEMEADO):
        r = admin.get(f"/api/licitacoes/{alvo}")
        assert r.status_code == 404, f"{alvo}: HTTP {r.status_code} — {r.text}"
        erro = r.json()["error"]
        assert erro["code"] == "NOT_FOUND", erro
        assert erro["message"] == "Licitação não encontrada", erro


def test_detalhe_id_malformado_400(admin):
    """ID que não casa a regex UUID → 400 {"error": "ID inválido"} (antes do banco)."""
    r = admin.get("/api/licitacoes/nao-e-um-uuid")
    assert r.status_code == 400, r.text
    assert r.json() == {"error": "ID inválido"}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/licitacoes/search — autocomplete (shape, curto-circuito, EXTERNO)
# ─────────────────────────────────────────────────────────────────────────────
def test_search_ancora_shape_e_limite(admin):
    """q=<numero da âncora>: âncora entre as licitações; LIMIT 5 e projeção exata."""
    r = admin.get("/api/licitacoes/search", params={"q": fixtures.LIC_NUMERO})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"licitacoes"}, sorted(body)
    assert len(body["licitacoes"]) <= 5
    ids = {item["id"] for item in body["licitacoes"]}
    assert fixtures.LIC_ID in ids, f"âncora fora do autocomplete: {ids}"
    for item in body["licitacoes"]:
        # Projeção EXATA do router (5 colunas) — campo extra/faltando = quebra.
        assert set(item) == _COLUNAS_SEARCH_LIC, sorted(item)


def test_search_q_curto_curto_circuito_vazio(admin):
    """q ausente / vazio / 1 char (pós-trim): shape vazio, 200, NUNCA 400/422."""
    vazio = {"licitacoes": []}
    for params in (None, {"q": ""}, {"q": "x"}, {"q": "  a  "}):
        r = admin.get("/api/licitacoes/search", params=params)
        assert r.status_code == 200, f"params={params}: {r.status_code} {r.text}"
        assert r.json() == vazio, f"params={params}: {r.json()}"


def test_search_externo_autenticado_403(externo):
    """search usa require_visualizar (RBAC hardening FRENTE D) — EXTERNO é BARRADO.

    Antes a busca aceitava EXTERNO (requireAuth). Como ela expõe pipeline interno
    (licitações), passou a exigir ROLES_VISUALIZAR: EXTERNO → 403
    FORBIDDEN, igual à listagem/detalhe.
    """
    r = externo.get("/api/licitacoes/search", params={"q": fixtures.LIC_NUMERO})
    assert r.status_code == 403, f"EXTERNO deveria ser barrado agora: {r.status_code} {r.text}"
    assert r.json().get("code") == "FORBIDDEN", r.text


# ─────────────────────────────────────────────────────────────────────────────
# RBAC mínimo — 401 sem token; 403 EXTERNO na listagem; VISUALIZADOR passa
# ─────────────────────────────────────────────────────────────────────────────
def test_rbac_sem_token_401_em_todas_as_rotas(anon):
    """Sem Authorization: 401 {error, code:UNAUTHENTICATED} nas três rotas."""
    rotas = (
        "/api/licitacoes",
        f"/api/licitacoes/{fixtures.LIC_ID}",
        "/api/licitacoes/search?q=petrobras",
    )
    for rota in rotas:
        r = anon.get(rota)
        assert r.status_code == 401, f"{rota}: HTTP {r.status_code} — {r.text}"
        body = r.json()
        assert body.get("code") == "UNAUTHENTICATED", f"{rota}: {body}"
        assert body.get("error"), f"{rota}: {body}"


def test_rbac_externo_403_na_listagem_e_detalhe(externo):
    """EXTERNO autenticado mas fora de ROLES_VISUALIZAR → 403 FORBIDDEN."""
    for rota in ("/api/licitacoes", f"/api/licitacoes/{fixtures.LIC_ID}"):
        r = externo.get(rota)
        assert r.status_code == 403, f"{rota}: HTTP {r.status_code} — {r.text}"
        body = r.json()
        assert body.get("code") == "FORBIDDEN", f"{rota}: {body}"
        assert body.get("error") == "Permissão negada", f"{rota}: {body}"


def test_rbac_visualizador_acessa_listagem_e_detalhe(viewer):
    """VISUALIZADOR (piso de ROLES_VISUALIZAR) lê listagem e detalhe normalmente."""
    r = viewer.get("/api/licitacoes", params={"limit": 1})
    assert r.status_code == 200, r.text

    r2 = viewer.get(f"/api/licitacoes/{fixtures.LIC_ID}")
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["id"] == fixtures.LIC_ID
