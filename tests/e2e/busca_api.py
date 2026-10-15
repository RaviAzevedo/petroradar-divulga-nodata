"""tests/e2e/busca_api.py — Suíte E2E de BUSCA (gate G6-aux do go_no_go, WP12 §3).

Valida, contra a stack VIVA (web:3000 / bff:8000 / Postgres do compose), o
contrato REAL das superfícies de busca do Petro Radar on-prem:

  1. GET /api/licitacoes/search        (BFF migrado, strangler-fig; espelho 1:1
     do route.ts do Next) — autocomplete global da CommandPalette. Guard (RBAC
     hardening FRENTE D, 2026-07-02): require_visualizar (papel em
     ROLES_VISUALIZAR; EXTERNO recebe 403 — a busca expõe pipeline interno, ver
     docstring de bff/app/routers/migrated/licitacoes_search.py). ``q`` é
     OPCIONAL: ausente/vazio/len<2 → 200 com shape vazio {licitacoes:[]}
     ANTES de tocar o banco — NUNCA 400/422 (paridade com o
     Next; testar 4xx aqui seria rota imaginária).
  2. GET /api/licitacoes/search        (web/Next) — mesma rota servida pelo app;
     sem sessão o middleware (app/src/proxy.ts) REDIRECIONA para /login (30x),
     não devolve 401 JSON — esse é o contrato real do lado web.
  3. GET /api/licitacoes?search=       (BFF migrado) — busca textual da página
     /explorar (app/src/app/explorar/page.tsx consome /api/licitacoes). ILIKE
     em objeto/numero/regioes/empresa; shape {data, meta:{total,page,limit,
     pages}}. Guard: require_visualizar → EXTERNO recebe 403.
  4. GET /bff/licitacoes               (rota nativa do BFF, prefixo /bff) —
     única superfície de busca/listagem com validação FastAPI estrita
     (page ge=1, page_size 1..100): é AQUI que "parâmetro inválido → 4xx" (422)
     existe de verdade no stack.

MOTOR DE BUSCA: a auditoria de 2026-06-10 aponta que o
Elasticsearch do compose NÃO está integrado ao app — confirmado por inspeção:
zero referências a elastic/opensearch em app/src e bff/app. TODA a busca
textual atual é Postgres ILIKE; portanto NÃO há testes de ES aqui (seria
contrato imaginário) e "índice vazio" equivale a "termo sem match no Postgres"
→ 200 com listas vazias, que é exatamente o que se asserta.

Fixtures/auth: SOMENTE tests.lib.fixtures (âncoras seedadas por
tests/fixtures/seed.sql — LIC_ID/LIC_NUMERO) e tests.lib.auth_helpers
(login NextAuth real no web; JWS HS256 forjado no BFF). Fixtures de sessão
web_admin/bff_admin vêm de tests/conftest.py.

Idempotência: a suíte é read-only (o teste de soft-delete de participação saiu
com o módulo em 2026-09-18). Sem chamadas pagas: nenhuma rota de IA é tocada.

Execução (tester, perfil "tests"):  pytest -q tests/e2e/busca_api.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
import pytest

# Raiz do repo no sys.path ANTES dos imports de tests.lib (no tester o
# PYTHONPATH=/ já resolve; no host garantimos aqui — mesmo truque do conftest).
_RAIZ = Path(__file__).resolve().parents[2]
if str(_RAIZ) not in sys.path:
    sys.path.insert(0, str(_RAIZ))

from tests.lib import fixtures
from tests.lib.auth_helpers import (
    DEFAULT_BFF_BASE,
    DEFAULT_WEB_BASE,
    bff_client,
)

# ── Constantes da suíte ───────────────────────────────────────────────────────
# Timeout explícito por client local (suíte inteira precisa fechar em <120s).
REQ_TIMEOUT = 15.0

# Termo garantidamente sem match em NENHUMA tabela (índice/feed vazio p/ ele).
TERMO_IMPROVAVEL = "zzz-busca-e2e-improvavel-990699"

# Shape exato projetado por /api/licitacoes/search (Next e BFF migrado).
CHAVES_LIC = {"id", "numero", "objeto", "empresa", "relevancia"}


def _bff_base() -> str:
    return (os.environ.get("BFF_BASE_URL") or DEFAULT_BFF_BASE).rstrip("/")


def _web_base() -> str:
    return (os.environ.get("ONPREM_BASE_URL") or DEFAULT_WEB_BASE).rstrip("/")


# ── Clients locais (anônimo e EXTERNO; admin/viewer vêm do conftest) ──────────


@pytest.fixture(scope="module")
def bff_anon():
    """Client SEM Authorization no BFF — prova o gate 401 de get_current_user."""
    with httpx.Client(base_url=_bff_base(), timeout=REQ_TIMEOUT) as c:
        yield c


@pytest.fixture(scope="module")
def bff_externo():
    """Client BFF com papel EXTERNO (autenticado, mas fora de ROLES_VISUALIZAR)."""
    client = bff_client(role="EXTERNO", timeout=REQ_TIMEOUT)
    yield client
    client.close()


@pytest.fixture(scope="module")
def web_anon():
    """Client SEM cookie de sessão no web (Next) — prova o redirect do middleware."""
    with httpx.Client(
        base_url=_web_base(), timeout=REQ_TIMEOUT, follow_redirects=False
    ) as c:
        yield c


# ─────────────────────────────────────────────────────────────────────────────
# 1. /api/licitacoes/search no BFF — auth (sem token → 401)
# ─────────────────────────────────────────────────────────────────────────────


def test_search_bff_sem_token_retorna_401(bff_anon):
    """GET /api/licitacoes/search sem Authorization → 401 (get_current_user).

    O 401 é o contrato; o header WWW-Authenticate NÃO é emitido pelo BFF
    (verificado ao vivo em 2026-06-11) — não se asserta header opcional.
    """
    r = bff_anon.get("/api/licitacoes/search", params={"q": "refino"})
    assert r.status_code == 401, r.text


def test_search_bff_token_lixo_retorna_401(bff_anon):
    """Bearer malformado (não-JWT) → 401, nunca 200/500."""
    r = bff_anon.get(
        "/api/licitacoes/search",
        params={"q": "refino"},
        headers={"Authorization": "Bearer isto-nao-e-um-jwt"},
    )
    assert r.status_code == 401, r.text


# ─────────────────────────────────────────────────────────────────────────────
# 2. /api/licitacoes/search no BFF — contrato funcional (Postgres ILIKE)
# ─────────────────────────────────────────────────────────────────────────────


def test_search_bff_termo_sem_match_devolve_estrutura_valida(bff_admin):
    """Termo sem NENHUM match → 200 com a lista vazia (estrutura íntegra).

    Equivale ao caso "índice vazio" da spec: a busca é Postgres ILIKE (ES não
    integrado — auditoria), então feed sem match responde 200 + listas vazias.
    """
    r = bff_admin.get("/api/licitacoes/search", params={"q": TERMO_IMPROVAVEL})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == {"licitacoes"}, body
    assert body["licitacoes"] == []


def test_search_bff_q_curto_curto_circuita_em_200_vazio(bff_admin):
    """q com len<2 (após trim) → 200 shape vazio SEM tocar o banco — nunca 4xx.

    Paridade com o Next (route.ts: ``if (!q || q.length < 2)``). Cobre também o
    q só-espaços (trim → vazio). É o contrato REAL: não existe 400 para q aqui.
    """
    for q in ("x", "  x  ", "   "):
        r = bff_admin.get("/api/licitacoes/search", params={"q": q})
        assert r.status_code == 200, f"q={q!r}: {r.text}"
        assert r.json() == {"licitacoes": []}


def test_search_bff_sem_param_q_nao_da_422(bff_admin):
    """Requisição SEM ?q= → 200 shape vazio (q é Query opcional, default None).

    Pega regressão clássica do strangler: se alguém tornar ``q`` obrigatório no
    FastAPI, isso viraria 422 e quebraria a paridade com o Next.
    """
    r = bff_admin.get("/api/licitacoes/search")
    assert r.status_code == 200, r.text
    assert r.json() == {"licitacoes": []}


def test_search_bff_encontra_ancoras_seedadas(bff_admin):
    """q=<numero da âncora> acha a licitação do seed e2e.

    Prova a busca textual de verdade (ILIKE em numero/objeto/empresa), a
    projeção camelCase exata e o LIMIT 5. Pré-requisito: make test-seed
    (tests/fixtures/seed.sql) aplicado — LIC_ID com numero 7004990101.
    """
    r = bff_admin.get("/api/licitacoes/search", params={"q": fixtures.LIC_NUMERO})
    assert r.status_code == 200, r.text
    body = r.json()

    assert len(body["licitacoes"]) <= 5

    lics = {item["id"]: item for item in body["licitacoes"]}
    assert fixtures.LIC_ID in lics, (
        f"licitação-âncora {fixtures.LIC_NUMERO} não veio na busca — "
        "seed e2e (make test-seed) rodou? "
        f"ids retornados: {sorted(lics)}"
    )
    ancora = lics[fixtures.LIC_ID]
    assert set(ancora.keys()) == CHAVES_LIC, ancora
    assert ancora["numero"] == fixtures.LIC_NUMERO


def test_search_bff_externo_autenticado_recebe_403(bff_externo):
    """EXTERNO (fora de ROLES_VISUALIZAR) é BARRADO na busca rápida — 403.

    RBAC hardening (FRENTE D, 2026-07-02): a busca global é leitura interna,
    então o guard passou de requireAuth →
    requireVisualizar (app) / get_current_user → require_visualizar (BFF gêmeo).
    EXTERNO agora recebe 403 FORBIDDEN, igual a /api/licitacoes. Quem reverter a
    dependency para auth-only no BFF quebra este contrato (o teste pega).
    """
    r = bff_externo.get("/api/licitacoes/search", params={"q": TERMO_IMPROVAVEL})
    assert r.status_code == 403, r.text


# ─────────────────────────────────────────────────────────────────────────────
# 3. /api/licitacoes/search no WEB (Next) — sessão real NextAuth
# ─────────────────────────────────────────────────────────────────────────────


def test_search_web_sem_sessao_401_json(web_anon):
    """Sem cookie de sessão, /api/* responde 401 JSON (contrato de API).

    CONTRATO ATUALIZADO (2026-07-02): o middleware (proxy.ts) devolve
    401 {"error","code":"UNAUTHENTICATED"} para paths /api/* sem sessão —
    clientes programáticos (fetch/curl) não devem receber redirect 307 para o
    HTML do /login (paridade com o BFF e com o shape do requireAuth/guards.ts).
    Páginas continuam redirecionando para /login?callbackUrl=...
    """
    try:
        r = web_anon.get("/api/licitacoes/search", params={"q": "refino"})
    except httpx.TransportError as exc:
        pytest.skip(f"web não alcançável ({exc}) — stack no ar? (make up, perfil tests)")
    assert r.status_code == 401, (
        f"esperava 401 JSON do middleware, veio HTTP {r.status_code}: {r.text[:200]}"
    )
    assert r.json().get("code") == "UNAUTHENTICATED", r.text[:200]


def test_search_web_com_sessao_devolve_estrutura_e_ancora(web_admin):
    """Logado de verdade (NextAuth Credentials), o web responde o MESMO shape.

    Mesmo contrato do BFF migrado (é a origem da paridade): 200, chaves
    {licitacoes}, âncora do seed presente com projeção exata.
    """
    r = web_admin.get("/api/licitacoes/search", params={"q": fixtures.LIC_NUMERO})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == {"licitacoes"}, body
    ids = [item["id"] for item in body["licitacoes"]]
    assert fixtures.LIC_ID in ids, (
        f"âncora {fixtures.LIC_NUMERO} ausente na busca via web; ids: {ids}"
    )
    item = next(i for i in body["licitacoes"] if i["id"] == fixtures.LIC_ID)
    assert set(item.keys()) == CHAVES_LIC, item


# ─────────────────────────────────────────────────────────────────────────────
# 4. /api/licitacoes?search= — busca textual da página /explorar (BFF migrado)
# ─────────────────────────────────────────────────────────────────────────────


def test_explorar_busca_textual_acha_ancora(bff_admin):
    """GET /api/licitacoes?search=<numero> → 200 {data, meta} com a âncora.

    É o backend real da página /explorar (fetch `/api/licitacoes?${p}` em
    explorar/page.tsx): ILIKE em objeto/numero/regioes/empresa + envelope
    paginado {data, meta:{total,page,limit,pages}} com tipos numéricos.
    """
    r = bff_admin.get(
        "/api/licitacoes", params={"search": fixtures.LIC_NUMERO, "limit": "5"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) >= {"data", "meta"}, body
    meta = body["meta"]
    assert set(meta.keys()) == {"total", "page", "limit", "pages"}, meta
    assert all(isinstance(meta[k], int) for k in ("total", "page", "limit", "pages"))
    assert meta["total"] >= 1, "seed e2e ausente? âncora não contada no total"
    ids = [item["id"] for item in body["data"]]
    assert fixtures.LIC_ID in ids, f"âncora fora do data da /explorar; ids: {ids}"


def test_explorar_busca_termo_sem_match_total_zero(bff_admin):
    """Termo improvável → 200 com data=[] e meta.total=0 (sem 404/500)."""
    r = bff_admin.get("/api/licitacoes", params={"search": TERMO_IMPROVAVEL})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0
    assert body["meta"]["pages"] == 0


def test_explorar_busca_externo_recebe_403(bff_externo):
    """EXTERNO em /api/licitacoes → 403 (require_visualizar barra).

    Desde o RBAC hardening (FRENTE D), /api/licitacoes/search também barra
    EXTERNO — ambas as superfícies de busca exigem ROLES_VISUALIZAR. Mensagem
    espelha o ApiError do Next ("Permissão negada") via detail do FastAPI.
    """
    r = bff_externo.get("/api/licitacoes", params={"search": fixtures.LIC_NUMERO})
    assert r.status_code == 403, r.text


# ─────────────────────────────────────────────────────────────────────────────
# 5. /bff/licitacoes (rota nativa) — parâmetros inválidos → 4xx de verdade
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "params",
    [
        {"page": "0"},          # viola ge=1
        {"page": "abc"},        # não-int (FastAPI não imita o parseInt do JS aqui)
        {"page_size": "0"},     # viola ge=1
        {"page_size": "101"},   # viola le=100
    ],
    ids=["page-zero", "page-nao-numerica", "page_size-zero", "page_size-acima-100"],
)
def test_busca_nativa_bff_parametro_invalido_422(bff_admin, params):
    """GET /bff/licitacoes com Query inválida → 422 (validação FastAPI).

    Única superfície de busca/listagem do stack onde "parâmetro inválido → 4xx"
    é contrato REAL (Query ge/le tipada em bff/app/routers/licitacoes.py). As
    rotas migradas /api/* NÃO podem 4xx-ar nesses casos (replicam o
    parseInt-com-default do Next) — testá-las com 4xx seria rota imaginária.
    """
    r = bff_admin.get("/bff/licitacoes", params=params)
    assert r.status_code == 422, f"params={params}: HTTP {r.status_code} {r.text[:200]}"
    # Shape canônico do handler WP03 (bff/app/core/errors.py, registrado globalmente):
    # {error, code:VALIDATION, campos:[{campo,erro}]} — NÃO ecoa input (anti-PII) e
    # espelha o Next. (Antes do WP03 o FastAPI devolvia {detail}; assert atualizado.)
    corpo = r.json()
    assert corpo.get("code") == "VALIDATION" and "campos" in corpo, f"shape inesperado: {corpo}"


def test_busca_nativa_bff_paginacao_valida_responde_envelope(bff_admin):
    """Controle positivo do 422: parâmetros válidos → 200 {data, paginacao}.

    Garante que os 422 acima vêm da VALIDAÇÃO (e não de rota quebrada/ausente).
    """
    r = bff_admin.get("/bff/licitacoes", params={"page": "1", "page_size": "1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) >= {"data", "paginacao"}, body
    assert isinstance(body["data"], list)
    assert body["paginacao"]["page"] == 1
