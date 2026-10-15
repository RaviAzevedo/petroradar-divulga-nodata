"""
tests/lib/auth_helpers.py — Helpers de AUTENTICAÇÃO compartilhados pelas 10 suítes e2e.

Fonte única dos três mecanismos de auth do stack on-prem (cada um replicado do
código REAL, não inventado):

  1. LOGIN WEB (NextAuth v5 Credentials) — replica tests/smoke-front.sh:
         GET  /api/auth/csrf                      → csrfToken + cookie csrf
         POST /api/auth/callback/credentials      → Set-Cookie *session-token*
     O cookie de sessão é um JWE (5 segmentos) que o middleware do Next e o BFF
     (modo (a) de bff/app/core/security.py) sabem decriptar. :func:`login_web`
     devolve um ``httpx.Client`` com o jar pronto para navegar autenticado.

  2. TOKEN BFF (JWS HS256 forjado) — replica tests/smoke.sh (forjar_jwt) e o
     conftest de paridade: o BFF valida em MODO DUPLO pelo nº de segmentos
     (bff/app/core/security.py:get_current_user) e aceita, além do JWE real,
     um JWS HS256 de 3 segmentos assinado com o MESMO ``AUTH_SECRET``
     (fallback ``NEXTAUTH_SECRET``), claims obrigatórias ``sub``/``exp``
     (options require) + ``email``/``role`` consumidas pelo CurrentUser/RBAC.
     Não há por que replicar a derivação HKDF do JWE aqui: o fallback HS256 é
     contrato suportado de primeira classe (documentado no próprio security.py).

  3. CRON (Bearer secret) — replica verifyCronAuth (app/src/lib/security/
     secrets.ts) e require_cron (bff/app/core/cron_auth.py): com ``CRON_SECRET``
     configurado exige ``Authorization: Bearer <CRON_SECRET>``; sem ele (dev),
     o header ``x-vercel-cron: 1`` é aceito.

Conveniências de efeito colateral: :func:`db_conn` (psycopg via DATABASE_URL,
usável como context manager) e :func:`redis_conn` (redis-py via REDIS_URL).

CONSTANTES DE FIXTURE: este módulo consome tests/lib/fixtures.py (fonte única —
fixtures.E2E_PASSWORD, fixtures.USERS, fixtures.USER_IDS, fixtures.ADMIN_EMAIL)
via IMPORT TARDIO: o arquivo é criado por outro agente em paralelo, então a
ausência dele não pode quebrar a importação deste módulo (pytest --collect-only
precisa passar). Sem fixtures no disco, caímos nos defaults do MESMO contrato
("<papel>.e2e@example.invalid" / sub determinístico).

Ambiente esperado (container tester, perfil "tests", env_file .env.onprem):
  ONPREM_BASE_URL (default http://web:3000) · BFF_BASE_URL (default
  http://bff:8000) · AUTH_SECRET/NEXTAUTH_SECRET · CRON_SECRET ·
  DATABASE_URL · REDIS_URL.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

# ── Defaults de rede (service names do docker-compose; perfil "tests") ────────
DEFAULT_WEB_BASE = "http://web:3000"
DEFAULT_BFF_BASE = "http://bff:8000"
DEFAULT_TIMEOUT = 30.0

# TTL default dos tokens forjados (igual ao conftest de paridade: 1h).
DEFAULT_TTL_SEGUNDOS = 3600


# ─────────────────────────────────────────────────────────────────────────────
# Import tardio das fixtures canônicas (criadas em paralelo por outro agente)
# ─────────────────────────────────────────────────────────────────────────────
def _fixtures():
    """Importa ``tests.lib.fixtures`` sob demanda; ``None`` se ainda não existir.

    No tester PYTHONPATH=/ torna ``tests.lib`` um namespace package alcançável.
    Rodando no host (repo com espaços no caminho), garantimos a raiz do repo no
    sys.path antes de tentar — mesmo truque do conftest com o bff/.
    """
    try:
        from tests.lib import fixtures  # type: ignore

        return fixtures
    except ImportError:
        raiz = Path(__file__).resolve().parents[2]  # .../petro-radar-onprem
        if str(raiz) not in sys.path:
            sys.path.insert(0, str(raiz))
        try:
            from tests.lib import fixtures  # type: ignore

            return fixtures
        except ImportError:
            return None  # fixtures.py ainda não está no disco — usa defaults.


def _auth_secret() -> str:
    """Segredo HS256 compartilhado web↔bff (AUTH_SECRET, fallback NEXTAUTH_SECRET)."""
    secret = os.environ.get("AUTH_SECRET") or os.environ.get("NEXTAUTH_SECRET")
    assert secret, (
        "AUTH_SECRET/NEXTAUTH_SECRET ausentes no ambiente do tester — "
        "o env_file .env.onprem foi carregado no serviço (perfil tests)?"
    )
    return secret


# ─────────────────────────────────────────────────────────────────────────────
# 1. Login web real (NextAuth v5 Credentials) — fluxo do smoke-front.sh
# ─────────────────────────────────────────────────────────────────────────────
def _limpar_throttle_login(email: str) -> None:
    """Limpa os contadores de rate-limit de login ANTES de cada login de teste.

    O authorize do app limita 5 tentativas/15min por e-mail E POR IP
    (auth.ts: rl:login:<email> + rl:login-ip:<ip>). Como o tester loga os 7
    papéis a partir do MESMO IP, o 6º/7º login estourariam o limite de IP e o
    harness falharia por throttle — não por bug. Best-effort: sem REDIS_URL
    (ou Redis fora), segue sem limpar e o rate-limit real se aplica.
    """
    url = os.environ.get("REDIS_URL")
    if not url:
        return
    try:
        import redis as _redis

        r = _redis.Redis.from_url(url, socket_timeout=3)
        chaves = [f"rl:login:{email.lower().strip()}".encode()]
        chaves += list(r.keys("rl:login-ip:*"))
        if chaves:
            r.delete(*chaves)
    except Exception:
        pass  # rate-limit real prevalece; o assert de login diagnostica


def login_web(
    email: str,
    password: str,
    base_url: str | None = None,
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> httpx.Client:
    """Faz login REAL no Next (NextAuth Credentials) e devolve o client logado.

    Replica tests/smoke-front.sh: GET /api/auth/csrf (semeia o cookie csrf no
    jar) → POST form-urlencoded em /api/auth/callback/credentials (csrfToken,
    email, password, callbackUrl, json=true) → o sucesso é provado pela
    presença de um cookie ``*session-token*`` no jar (``authjs.session-token``
    em HTTP; ``__Secure-authjs.session-token`` atrás do NGINX TLS).

    O client devolvido NÃO segue redirects por padrão (igual ao smoke-front,
    que trata 30x manualmente p/ detectar bounce a /login); passe
    ``follow_redirects=True`` por request quando precisar navegar páginas.

    Levanta ``AssertionError`` com diagnóstico claro se o login falhar.
    O chamador é dono do client (``with login_web(...) as c:`` fecha o jar).
    """
    base = (base_url or os.environ.get("ONPREM_BASE_URL") or DEFAULT_WEB_BASE).rstrip("/")
    _limpar_throttle_login(email)
    client = httpx.Client(base_url=base, timeout=timeout)
    try:
        r = client.get("/api/auth/csrf")
        assert r.status_code == 200, (
            f"GET {base}/api/auth/csrf → HTTP {r.status_code} (web no ar? make up?)"
        )
        csrf_token = (r.json() or {}).get("csrfToken")
        assert csrf_token, f"resposta de {base}/api/auth/csrf sem csrfToken: {r.text[:200]}"

        r2 = client.post(
            "/api/auth/callback/credentials",
            data={
                "csrfToken": csrf_token,
                "email": email,
                "password": password,
                "callbackUrl": base,
                "json": "true",
            },
            follow_redirects=False,  # 30x manual, como o redirect:"manual" do smoke
        )
        logado = any("session-token" in (c.name or "") for c in client.cookies.jar)
        assert logado, (
            f"login NextAuth FALHOU p/ {email} (POST /api/auth/callback/credentials → "
            f"HTTP {r2.status_code}, sem cookie *session-token*). Causas típicas: seed "
            "e2e não rodou, senha != fixtures.E2E_PASSWORD, usuário inativo/bloqueado."
        )
        return client
    except BaseException:
        client.close()  # não vaza socket se o login não completou
        raise


# ─────────────────────────────────────────────────────────────────────────────
# 2. Token do BFF (JWS HS256 forjado — mecanismo do smoke.sh/conftest paridade)
# ─────────────────────────────────────────────────────────────────────────────
def forge_bff_token(
    email: str | None = None,
    role: str = "ADMIN",
    user_id: str | None = None,
    *,
    ttl_segundos: int = DEFAULT_TTL_SEGUNDOS,
    **claims: Any,
) -> str:
    """Forja um JWS HS256 aceito pelo BFF (modo (b) de get_current_user).

    Contrato validado por bff/app/core/security.py: assinatura HS256 com
    ``AUTH_SECRET``; claims obrigatórias ``sub`` e ``exp`` (options require);
    ``email``/``role`` viram o CurrentUser (role normalizada por normalize_role,
    então papéis legados admin/editor/viewer também funcionam).

    Defaults vêm das fixtures canônicas (import tardio): ``email`` de
    fixtures.USERS[role], ``user_id`` de fixtures.USER_IDS[role]; sem o módulo
    no disco, caem para o MESMO padrão do contrato. ``**claims`` sobrescreve
    qualquer claim (ex.: ``exp=0`` p/ token vencido, ``jti=...`` p/ revogação;
    ``ttl_segundos=-30`` também produz token expirado).
    """
    import jwt  # PyJWT (tests/requirements.txt) — import local, igual security.py

    fx = _fixtures()
    if email is None:
        email = (getattr(fx, "USERS", {}) or {}).get(role) if fx else None
        email = email or f"{role.lower()}.e2e@example.invalid"
    if user_id is None:
        user_id = (getattr(fx, "USER_IDS", {}) or {}).get(role) if fx else None
        user_id = user_id or f"e2e-{role.lower()}"

    agora = int(time.time())
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "email": email,
        "role": role,
        "iat": agora,
        "exp": agora + ttl_segundos,
    }
    payload.update(claims)
    return jwt.encode(payload, _auth_secret(), algorithm="HS256")


def bff_client(
    role: str = "ADMIN",
    email: str | None = None,
    user_id: str | None = None,
    *,
    base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    **claims: Any,
) -> httpx.Client:
    """Client httpx autenticado no BFF (``Authorization: Bearer <JWS HS256>``).

    Base: env ``BFF_BASE_URL`` (no tester = http://bff:8000). Header Bearer é o
    caminho preferencial de _extrair_token (antes do fallback de cookie).
    O chamador é dono do client (usar ``with`` ou fechar no teardown).
    """
    token = forge_bff_token(email=email, role=role, user_id=user_id, **claims)
    base = (base_url or os.environ.get("BFF_BASE_URL") or DEFAULT_BFF_BASE).rstrip("/")
    return httpx.Client(
        base_url=base,
        timeout=timeout,
        headers={"Authorization": f"Bearer {token}"},
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Auth de cron (espelha verifyCronAuth do Next e require_cron do BFF)
# ─────────────────────────────────────────────────────────────────────────────
def cron_headers() -> dict[str, str]:
    """Headers para endpoints de cron, conforme o modo do ambiente.

    Com ``CRON_SECRET`` configurado (caminho de produção on-prem) os dois lados
    — verifyCronAuth (app/src/lib/security/secrets.ts) e require_cron
    (bff/app/core/cron_auth.py) — exigem EXCLUSIVAMENTE ``Authorization:
    Bearer <CRON_SECRET>`` (comparação constant-time). Sem o segredo (dev),
    ambos aceitam ``x-vercel-cron: 1``.
    """
    secret = os.environ.get("CRON_SECRET", "")
    if secret:
        return {"Authorization": f"Bearer {secret}"}
    return {"x-vercel-cron": "1"}


# ─────────────────────────────────────────────────────────────────────────────
# Conveniências p/ asserts de efeito colateral (DB e Redis)
# ─────────────────────────────────────────────────────────────────────────────
def db_conn(*, autocommit: bool = False):
    """Conexão psycopg3 via ``DATABASE_URL`` (libpq URI do .env.onprem).

    A conexão é context manager nativo (commit/rollback + close no exit)::

        with auth_helpers.db_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM licitacoes")

    ``autocommit=True`` é útil p/ limpeza (DELETE de dados de teste) sem
    transação pendente em caso de erro no meio do teardown.
    """
    import psycopg  # psycopg[binary] (tests/requirements.txt)

    dsn = os.environ.get("DATABASE_URL")
    assert dsn, "DATABASE_URL ausente no ambiente do tester (env_file .env.onprem)."
    return psycopg.connect(dsn, autocommit=autocommit)


def redis_conn(*, decode_responses: bool = True):
    """Client redis-py via ``REDIS_URL`` (db0; troque o path p/ db1/2/3).

    ``decode_responses=True`` devolve str (conveniente p/ asserts). O client é
    context manager (``with auth_helpers.redis_conn() as r: r.ping()``).
    """
    import redis  # redis-py (tests/requirements.txt)

    url = os.environ.get("REDIS_URL")
    assert url, "REDIS_URL ausente no ambiente do tester (env_file .env.onprem)."
    return redis.Redis.from_url(url, decode_responses=decode_responses)
