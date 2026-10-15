"""
tests/e2e/auth_rbac_api.py — SUÍTE E2E "auth_rbac_api" (gate G3 do go_no_go; WP12 §3.1).

Login + RBAC contra a stack VIVA (perfil "tests": web:3000 / bff:8000 / db / redis
do compose) — nada de mock de rede. Cobertura:

  1. Login NextAuth REAL (csrf → callback/credentials, via auth_helpers.login_web)
     com o admin canônico de tests/lib/fixtures.py + sessão FUNCIONAL
     (GET / autenticado → 200, sem bounce p/ /login).
  2. Senha errada → login recusado (sem cookie ``*session-token*`` no jar).
  3. Anônimo em página protegida no web → 307 p/ /login?callbackUrl=... .
     GUARDIÃO do fix do proxy.ts: o gate de sessão é EXPLÍCITO no wrapper
     ``auth((req) => …)`` porque o NextAuth v5 ignora o callback ``authorized``
     nessa forma (antes do fix o gate era no-op e TODAS as rotas eram públicas).
  4. BFF (rotas migradas servem o MESMO path /api/* do Next, sem prefixo /bff):
     sem token → 401; papel sem permissão → 403; admin → 200. Matriz dos 7
     papéis de permissions.ts (fixtures.PAPEIS) em 3 gates reais:
       require_admin       GET /api/admin/users     (só ADMIN)
       require_gestao      GET /api/users           (ADMIN, LIDER)
       require_visualizar  GET /api/licitacoes      (todos exceto EXTERNO)
  5. Revogação (Decisão 4 / auditoria 2026-06-10):
       - CONSUMIDOR já plugado (get_current_user → assert_nao_revogado lê a
         denylist ``auth:revogados:<jti>`` no redis db2) → teste NORMAL: jti
         na denylist ⇒ 401 "Sessão revogada".
       - PRODUTOR ausente (PATCH ativo=false não revoga; ALTA "Revogação de JWT
         meia-implementada") e sessão SEM maxAge 8h (ALTA "Sessão sem maxAge";
         auth.ts herda ~30d do Auth.js) → pytest.mark.xfail(strict=False).

Auth/fixtures vêm EXCLUSIVAMENTE de tests/lib/auth_helpers.py + tests/lib/
fixtures.py (fonte única). Idempotente: todo efeito colateral (denylist, ativo=
false) é desfeito em finally; nenhum fluxo IA é acionado (zero chamadas pagas).

Execução isolada:  pytest -q tests/e2e/auth_rbac_api.py
No harness:        tests/run_e2e.sh (1 junit por suíte → e2e_results.json → G3).
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

# `from tests.lib import ...` exige o PAI de tests/ no sys.path (no tester o
# Dockerfile exporta PYTHONPATH=/; aqui garantimos o mesmo p/ rodar no host).
_RAIZ = Path(__file__).resolve().parents[2]  # .../petro-radar-onprem
if str(_RAIZ) not in sys.path:
    sys.path.insert(0, str(_RAIZ))

from tests.lib import fixtures
from tests.lib.auth_helpers import (
    DEFAULT_BFF_BASE,
    DEFAULT_WEB_BASE,
    bff_client,
    db_conn,
    forge_bff_token,
    login_web,
)

# ── Bases (service names do compose; perfil "tests") e timeouts explícitos ────
_WEB_BASE = (os.environ.get("ONPREM_BASE_URL") or DEFAULT_WEB_BASE).rstrip("/")
_BFF_BASE = (os.environ.get("BFF_BASE_URL") or DEFAULT_BFF_BASE).rstrip("/")
TIMEOUT = 15.0  # por request; mantém a suíte inteira bem abaixo dos 120s

# Páginas REAIS de app (existem em app/src/app/) cobertas pela matcher do
# proxy.ts — o redirect anônimo precisa valer em todas.
PAGINAS_PROTEGIDAS = ("/", "/acervo", "/explorar")

# Matriz papel → esperado por gate (espelha permissions.ts / security.py).
_GESTAO = {"ADMIN", "LIDER"}


def _redis_db2():
    """Client redis no db2 (sessão/revogação) — MESMA derivação de
    bff/app/core/revocation.py::_revocation_redis_url: usa REDIS_REVOCATION_URL
    se setada; senão troca o nº do db da REDIS_URL por 2 (ou anexa ``/2``).
    """
    import redis  # redis-py (tests/requirements.txt)

    url = os.environ.get("REDIS_REVOCATION_URL", "") or ""
    if not url:
        base = os.environ.get("REDIS_URL", "")
        if not base:
            pytest.skip("REDIS_URL ausente no ambiente do tester (env_file .env.onprem).")
        if "/" in base.split("://", 1)[-1]:
            prefixo, _, db = base.rpartition("/")
            url = f"{prefixo}/2" if db.isdigit() else base.rstrip("/") + "/2"
        else:
            url = base.rstrip("/") + "/2"
    cliente = redis.Redis.from_url(url, decode_responses=True)
    try:
        cliente.ping()
    except Exception as exc:  # noqa: BLE001 — infra fora do ar: skip, não fail
        pytest.skip(f"redis db2 (revogação) não alcançável ({exc}).")
    return cliente


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures locais — clientes anônimos com probe de alcançabilidade (skip limpo
# se a stack não estiver no ar; falha de SENHA/seed/contrato continua FAIL).
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def web_anon():
    """httpx.Client ANÔNIMO no web (sem cookie de sessão; redirects manuais)."""
    cliente = httpx.Client(base_url=_WEB_BASE, timeout=TIMEOUT, follow_redirects=False)
    try:
        cliente.get("/api/auth/csrf")  # rota pública do NextAuth como probe
    except httpx.TransportError as exc:
        cliente.close()
        pytest.skip(f"web não alcançável ({exc}) — stack no ar? (make up + perfil tests)")
    yield cliente
    cliente.close()


@pytest.fixture(scope="session")
def bff_anon():
    """httpx.Client SEM Authorization no BFF (prova os 401 de gate)."""
    cliente = httpx.Client(base_url=_BFF_BASE, timeout=TIMEOUT)
    try:
        cliente.get("/bff/health")  # liveness sem auth como probe
    except httpx.TransportError as exc:
        cliente.close()
        pytest.skip(f"bff não alcançável ({exc}) — stack no ar? (make up + perfil tests)")
    yield cliente
    cliente.close()


# ─────────────────────────────────────────────────────────────────────────────
# 1–2. Login NextAuth real (web) — OK com fixtures; recusado com senha errada
# ─────────────────────────────────────────────────────────────────────────────
def test_login_admin_nextauth_ok_e_sessao_navega(web_admin):
    """Login REAL do admin e2e (fixtures) emite cookie de sessão FUNCIONAL.

    ``web_admin`` (conftest) já fez csrf → callback/credentials via login_web;
    aqui provamos que o cookie navega: GET / autenticado → 200 no dashboard,
    sem bounce p/ /login (se o seed não rodou, o próprio fixture FALHA — certo).
    """
    assert any(
        "session-token" in (c.name or "") for c in web_admin.cookies.jar
    ), "jar do admin sem cookie *session-token* — login_web deveria ter garantido"

    r = web_admin.get("/", follow_redirects=True, timeout=30.0)  # dashboard SSR pesado
    assert r.status_code == 200, f"GET / autenticado → HTTP {r.status_code}: {r.text[:200]}"
    assert "/login" not in str(r.url), f"sessão não colou: bounce p/ {r.url}"


def test_login_senha_errada_recusado():
    """Senha != fixtures.E2E_PASSWORD → NextAuth NÃO emite *session-token*.

    login_web levanta AssertionError com a mensagem canônica quando o callback
    de credentials não devolve cookie de sessão — é exatamente o que exigimos.
    """
    try:
        with pytest.raises(AssertionError, match="login NextAuth FALHOU"):
            cliente = login_web(
                fixtures.ADMIN_EMAIL, "Senha-Errada-E2e!2026", timeout=TIMEOUT
            )
            cliente.close()  # só alcançado se o login (indevidamente) passar
    except httpx.TransportError as exc:
        pytest.skip(f"web não alcançável ({exc}) — stack no ar?")


# ─────────────────────────────────────────────────────────────────────────────
# 3. Anônimo em página protegida → 307 /login (GUARDIÃO do fix do proxy.ts)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("pagina", PAGINAS_PROTEGIDAS)
def test_anonimo_em_pagina_protegida_redireciona_307_login(web_anon, pagina):
    """Sem sessão, QUALQUER página coberta pela matcher → 307 p/ /login.

    Guardião do fix de app/src/proxy.ts: no wrapper ``auth((req) => …)`` o
    NextAuth v5 IGNORA o callback ``authorized``, então a checagem de sessão é
    explícita no middleware. Regressão aqui = app inteiro público de novo.
    Exigimos 307 exato (NextResponse.redirect) + callbackUrl preservando o destino.
    """
    r = web_anon.get(pagina)
    assert r.status_code == 307, (
        f"anônimo em {pagina} → HTTP {r.status_code} (esperado 307; o gate de "
        f"sessão do proxy.ts regrediu?): {r.text[:200]}"
    )
    destino = urlsplit(r.headers.get("location", ""))
    assert destino.path == "/login", f"Location fora de /login: {r.headers.get('location')}"
    callback = parse_qs(destino.query).get("callbackUrl", [""])[0]
    assert callback.startswith(pagina), (
        f"callbackUrl não preserva o destino: {callback!r} (esperado prefixo {pagina!r})"
    )


def test_logado_em_login_redireciona_para_home(web_admin):
    """Com sessão, GET /login redireciona p/ / (o outro ramo do gate do proxy.ts).

    302 ou 307: o NextResponse.redirect do proxy emite 307 em dev mas o build
    de produção responde 302 (verificado no próprio commit 81d57bc: '302→/').
    Ambos preservam o GET; o contrato é "redireciona pra home".
    """
    r = web_admin.get("/login", follow_redirects=False)
    assert r.status_code in (302, 307), f"logado em /login → HTTP {r.status_code}"
    assert urlsplit(r.headers.get("location", "")).path == "/", (
        f"Location fora da home: {r.headers.get('location')}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4a. BFF — gate de autenticação (401 sem token / expirado / assinatura errada)
# ─────────────────────────────────────────────────────────────────────────────
def test_bff_sem_token_401(bff_anon):
    """Sem Authorization, rota gated → 401 ANTES de qualquer RBAC/DB."""
    for rota in ("/api/admin/users", "/api/licitacoes", "/api/users"):
        r = bff_anon.get(rota)
        assert r.status_code == 401, f"{rota} sem token → HTTP {r.status_code}: {r.text[:200]}"


def test_bff_token_expirado_401(bff_anon):
    """JWS HS256 com exp no passado (forja dos helpers) → 401."""
    token = forge_bff_token(role="ADMIN", ttl_segundos=-60)
    r = bff_anon.get("/api/licitacoes", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401, f"token expirado aceito: HTTP {r.status_code}"


def test_bff_assinatura_invalida_401(bff_anon):
    """JWS assinado com OUTRO segredo (≠ AUTH_SECRET) → 401."""
    import jwt as _pyjwt  # PyJWT (tests/requirements.txt)

    agora = int(time.time())
    forjado_errado = _pyjwt.encode(
        {
            "sub": fixtures.USER_IDS["ADMIN"],
            "email": fixtures.ADMIN_EMAIL,
            "role": "ADMIN",
            "iat": agora,
            "exp": agora + 600,
        },
        "segredo-totalmente-errado",
        algorithm="HS256",
    )
    r = bff_anon.get("/api/licitacoes", headers={"Authorization": f"Bearer {forjado_errado}"})
    assert r.status_code == 401, f"assinatura inválida aceita: HTTP {r.status_code}"


# ─────────────────────────────────────────────────────────────────────────────
# 4b. BFF — RBAC: matriz dos 7 papéis (fixtures.PAPEIS) em 3 gates reais
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("papel", fixtures.PAPEIS)
def test_rbac_admin_users_so_admin(bff_anon, papel):
    """GET /api/admin/users (require_admin): ADMIN → 200; demais 6 papéis → 403.

    No 200, o shape é ``{"users":[...]}`` e o admin canônico do seed aparece —
    prova conjunta de gate + seed + projeção (admin_users.py espelha o Next).
    """
    with bff_client(role=papel, timeout=TIMEOUT) as cliente:
        r = cliente.get("/api/admin/users")
    if papel == "ADMIN":
        assert r.status_code == 200, f"ADMIN barrado em /api/admin/users: {r.text[:200]}"
        corpo = r.json()
        assert isinstance(corpo.get("users"), list), f"shape != {{users:[...]}}: {corpo}"
        emails = {u.get("email") for u in corpo["users"]}
        assert fixtures.ADMIN_EMAIL in emails, (
            f"admin e2e do seed ausente da listagem ({fixtures.ADMIN_EMAIL})"
        )
    else:
        assert r.status_code == 403, (
            f"papel {papel} deveria ser 403 em /api/admin/users, veio "
            f"HTTP {r.status_code}: {r.text[:200]}"
        )


@pytest.mark.parametrize("papel", fixtures.PAPEIS)
def test_rbac_users_somente_gestao(bff_anon, papel):
    """GET /api/users (require_gestao): ADMIN/LIDER → 200; demais → 403."""
    with bff_client(role=papel, timeout=TIMEOUT) as cliente:
        r = cliente.get("/api/users")
    esperado = 200 if papel in _GESTAO else 403
    assert r.status_code == esperado, (
        f"papel {papel} em /api/users: esperado {esperado}, veio "
        f"HTTP {r.status_code}: {r.text[:200]}"
    )


@pytest.mark.parametrize("papel", fixtures.PAPEIS)
def test_rbac_licitacoes_todos_menos_externo(bff_anon, papel):
    """GET /api/licitacoes (require_visualizar): só EXTERNO → 403; resto → 200.

    EXTERNO autenticado-mas-barrado tem que ser 403 (nunca 401): prova que o
    gate de papel roda DEPOIS do gate de auth — anti-IDOR do feed.
    """
    with bff_client(role=papel, timeout=TIMEOUT) as cliente:
        r = cliente.get("/api/licitacoes")
    esperado = 403 if papel == "EXTERNO" else 200
    assert r.status_code == esperado, (
        f"papel {papel} em /api/licitacoes: esperado {esperado}, veio "
        f"HTTP {r.status_code}: {r.text[:200]}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 5a. Revogação — CONSUMIDOR implementado: jti na denylist (redis db2) ⇒ 401
# ─────────────────────────────────────────────────────────────────────────────
def test_bff_rejeita_token_com_jti_na_denylist(bff_anon):
    """jti em ``auth:revogados:<jti>`` (db2) derruba o token na hora → 401.

    Este é o lado JÁ plugado da Decisão 4 (security.get_current_user →
    assert_nao_revogado). Gravamos a chave com o MESMO contrato de
    revocation.py (setex com TTL) e provamos a transição 200 → 401 do MESMO
    token. Cleanup em finally (idempotente; TTL curto como rede de segurança).
    """
    jti = f"e2e-authrbac-{uuid.uuid4()}"
    token = forge_bff_token(role="ADMIN", jti=jti)
    headers = {"Authorization": f"Bearer {token}"}

    # Sanidade: ANTES da denylist o token passa (200 — admin em rota visualizar).
    r0 = bff_anon.get("/api/licitacoes", headers=headers)
    assert r0.status_code == 200, f"token com jti recusado ANTES da denylist: {r0.text[:200]}"

    db2 = _redis_db2()
    chave = f"auth:revogados:{jti}"
    try:
        db2.setex(chave, 120, "1")  # TTL 120s: some sozinho mesmo se o cleanup falhar
        r1 = bff_anon.get("/api/licitacoes", headers=headers)
        assert r1.status_code == 401, (
            f"jti revogado ainda autentica (HTTP {r1.status_code}) — denylist do "
            f"db2 não está sendo consultada (fail-open do redis?): {r1.text[:200]}"
        )
        assert "revogada" in r1.text.lower(), (
            f"401 sem o detalhe 'Sessão revogada' (veio de outro ramo?): {r1.text[:200]}"
        )
    finally:
        try:
            db2.delete(chave)
        finally:
            db2.close()


# ─────────────────────────────────────────────────────────────────────────────
# 5b. Revogação — PRODUTOR ausente + maxAge 8h: documentados, NÃO implementados
#     (auditoria 2026-06-10, ALTAs da Decisão 4) → xfail(strict=False)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.xfail(
    strict=False,
    reason=(
        "Decisão 4 não aplicada (auditoria 2026-06-10, ALTA 'Revogação de JWT "
        "meia-implementada'): PATCH /api/admin/users/{id} ativo=false NÃO chama "
        "revoke_all_for_user/add_revoked_jti — desativar usuário não derruba a "
        "sessão; o token segue válido até o exp."
    ),
)
def test_desativar_usuario_revoga_sessao_imediatamente(bff_anon):
    """Desativar usuário (ativo=false) deveria invalidar o token NA HORA (401).

    Hoje o consumidor da denylist existe, mas NENHUM produtor escreve nela: o
    EXTERNO desativado continua autenticando (403 de papel, não 401 de sessão
    revogada). Quando a Decisão 4 for aplicada, este teste vira PASS sozinho.
    Restauração tripla em finally (PATCH + SQL + limpeza db2) p/ idempotência —
    outras suítes dependem do EXTERNO ativo do seed.
    """
    ext_id = fixtures.USER_IDS["EXTERNO"]
    url_patch = f"/api/admin/users/{ext_id}"

    # Pré-limpeza idempotente: re-execuções não podem herdar corte de revogação.
    db2 = _redis_db2()
    db2.delete(f"auth:revogado:user:{ext_id}")

    with bff_client(role="ADMIN", timeout=TIMEOUT) as admin, bff_client(
        role="EXTERNO", timeout=TIMEOUT
    ) as externo:
        # Sanidade: EXTERNO autenticado e barrado por PAPEL (403, não 401).
        r0 = externo.get("/api/licitacoes")
        assert r0.status_code == 403, f"pré-condição: EXTERNO ativo → 403; veio {r0.status_code}"

        r1 = admin.patch(url_patch, json={"ativo": False})
        assert r1.status_code == 200, f"PATCH ativo=false falhou: {r1.status_code} {r1.text[:200]}"
        try:
            r2 = externo.get("/api/licitacoes")
            # Comportamento DOCUMENTADO (Decisão 4): revogação imediata → 401.
            # Comportamento ATUAL: 403 (token segue válido) → xfail.
            assert r2.status_code == 401, (
                f"usuário desativado ainda autentica (HTTP {r2.status_code}) — "
                "produtor da denylist ausente (Decisão 4 pendente)"
            )
        finally:
            # 1º pelo MESMO caminho do operador (PATCH), 2º SQL direto (cinto e
            # suspensório), 3º limpa eventual corte que uma futura implementação
            # da Decisão 4 grave no db2 (senão envenenaria as outras suítes).
            try:
                admin.patch(url_patch, json={"ativo": True})
            except Exception:  # noqa: BLE001 — best-effort; o SQL abaixo garante
                pass
            try:
                with db_conn(autocommit=True) as conn, conn.cursor() as cur:
                    cur.execute(
                        "UPDATE users SET ativo = true WHERE id = %s", (ext_id,)
                    )
            except Exception:  # noqa: BLE001
                pass
            try:
                db2.delete(f"auth:revogado:user:{ext_id}")
            finally:
                db2.close()


@pytest.mark.xfail(
    strict=False,
    reason=(
        "Decisão 4 não aplicada (auditoria 2026-06-10, ALTA 'Sessão sem maxAge'): "
        "src/lib/auth.ts define session:{strategy:'jwt'} SEM maxAge → herda ~30d "
        "do Auth.js em vez das 8h documentadas (config do BFF assume 8h+9h TTL)."
    ),
)
def test_sessao_web_expira_em_8h(web_admin):
    """O cookie de sessão deveria expirar em ≤ 8h (maxAge da Decisão 4).

    O Auth.js grava Expires/Max-Age do cookie = maxAge da sessão; hoje sai
    ~30 dias. Quando auth.ts ganhar ``session.maxAge = 8*60*60``, vira PASS.
    """
    cookie_sessao = next(
        (c for c in web_admin.cookies.jar if "session-token" in (c.name or "")), None
    )
    assert cookie_sessao is not None, "jar sem cookie *session-token*"
    assert cookie_sessao.expires is not None, (
        "cookie de sessão sem Expires/Max-Age — impossível garantir as 8h"
    )
    restante_s = cookie_sessao.expires - time.time()
    leeway_s = 15 * 60  # folga p/ clock-skew e duração da própria suíte
    assert restante_s <= 8 * 3600 + leeway_s, (
        f"sessão expira em {restante_s / 3600:.1f}h (> 8h da Decisão 4 — "
        "default ~30d do Auth.js em vigor)"
    )
