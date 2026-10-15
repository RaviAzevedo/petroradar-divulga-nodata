"""
conftest.py — Fixtures compartilhadas da SUITE DE TESTES DE PARIDADE do BFF.

Estes fixtures sustentam ``test_bff.py`` (pytest + httpx) e podem ser reusados
por novos testes de paridade conforme as Ondas de migração ao FastAPI avançam.

PRINCÍPIOS (paridade com a PRODUÇÃO):
  - O FastAPI BFF **apenas valida** JWT HS256 emitido pelo NextAuth (Decisão 4).
    Aqui FORJAMOS um JWS HS256 de teste usando o
    MESMO segredo (``AUTH_SECRET``) e o MESMO algoritmo que ``app/core/security.py``
    espera (claims ``sub``/``email``/``role``/``exp``). Não dependemos do NextAuth
    para gerar tokens em teste — só replicamos seu contrato.
  - Os 7 papéis (ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR, EXTERNO)
    espelham src/lib/permissions.ts. As fixtures expõem helpers por papel para
    exercitar os gates RBAC (require_visualizar, require_acervo, etc.).

DOIS MODOS DE EXECUÇÃO:
  1. IN-PROCESS (padrão, sem rede): importa ``app.main:app`` e roda via
     ``httpx.ASGITransport`` — não precisa do container `bff` no ar. Bom para CI
     e para validar o contrato de auth/RBAC/paginação isoladamente.
  2. LIVE (contra o container): defina ``BFF_BASE_URL`` (ex.: http://127.0.0.1:8000)
     e os testes batem no BFF real. Útil no smoke pós ``docker compose up``.

Variáveis de ambiente reconhecidas:
  - ``AUTH_SECRET``       segredo HS256 compartilhado web↔bff. Default de teste abaixo.
  - ``NEXTAUTH_SECRET``   fallback (espelha config.py). Usado se AUTH_SECRET vazio.
  - ``BFF_BASE_URL``      se setado, ativa o MODO LIVE (rede) em vez do in-process.
  - ``BFF_PREFIX``        prefixo das rotas de domínio (default ``/bff``).

Dependências de teste (ver tests/requirements-test.txt, abaixo no manifesto):
  pytest, pytest-asyncio, httpx, pyjwt
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, Callable

import jwt
import pytest

# ── Localização do pacote BFF para o modo IN-PROCESS ──────────────────────────
# tests/ é irmão de bff/. Inserimos bff/ no sys.path para `import app.main`.
_TESTS_DIR = Path(__file__).resolve().parent
_BFF_DIR = _TESTS_DIR.parent / "bff"
if _BFF_DIR.is_dir() and str(_BFF_DIR) not in sys.path:
    sys.path.insert(0, str(_BFF_DIR))

# ── Segredo de teste (DEVE casar entre forja do token e validador do BFF) ─────
# Definimos um default determinístico e o EXPORTAMOS para o ambiente ANTES de
# qualquer import de `app.*`, porque o config.py do BFF lê AUTH_SECRET na carga
# do módulo (singleton `settings`, lru_cache). Se o operador já exportou um
# AUTH_SECRET (modo LIVE contra container), respeitamos o existente.
_DEFAULT_TEST_SECRET = "test-suite-paridade-petro-radar-hs256-secret"


def _ensure_test_secret() -> str:
    """Garante AUTH_SECRET no ambiente e o devolve (idempotente)."""
    secret = os.environ.get("AUTH_SECRET") or os.environ.get("NEXTAUTH_SECRET")
    if not secret:
        secret = _DEFAULT_TEST_SECRET
        os.environ["AUTH_SECRET"] = secret
    return secret


# Aplica imediatamente na importação do conftest (antes de coletar testes).
_TEST_SECRET = _ensure_test_secret()

# Papéis (espelham src/lib/permissions.ts / app/core/security.py).
ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"
ROLE_ORCAMENTISTA = "ORCAMENTISTA"
ROLE_TECNICO = "TECNICO"
ROLE_SGI = "SGI"
ROLE_VISUALIZADOR = "VISUALIZADOR"
ROLE_EXTERNO = "EXTERNO"
TODOS_OS_PAPEIS = (
    ROLE_ADMIN,
    ROLE_LIDER,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
    ROLE_SGI,
    ROLE_VISUALIZADOR,
    ROLE_EXTERNO,
)


# ── pytest-asyncio: modo automático para testes `async def` ──────────────────
def pytest_configure(config: "pytest.Config") -> None:
    """Registra o modo asyncio e markers customizados sem exigir pytest.ini."""
    config.addinivalue_line(
        "markers", "live: teste que exige o container bff no ar (BFF_BASE_URL)."
    )
    # Define o modo asyncio se o plugin estiver instalado e o usuário não tiver
    # configurado via pyproject/ini.
    try:
        if not config.getini("asyncio_mode"):
            config.inicfg["asyncio_mode"] = "auto"  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - ini pode não existir; pytest_collection trata.
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures de segredo / token
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def auth_secret() -> str:
    """Segredo HS256 compartilhado (mesmo que o BFF usa para validar)."""
    return _TEST_SECRET


@pytest.fixture(scope="session")
def bff_prefix() -> str:
    """Prefixo das rotas de domínio do BFF (default /bff)."""
    return os.environ.get("BFF_PREFIX", "/bff")


def _forjar_jwt(
    secret: str,
    *,
    sub: str = "user-test-0001",
    email: str = "teste@example.local",
    role: str = ROLE_ADMIN,
    expira_em_segundos: int = 3600,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    """
    Forja um JWS HS256 com o MESMO contrato que app/core/security.py valida.

    Claims obrigatórias para o validador: ``sub`` e ``exp`` (options require).
    Incluímos também ``email`` e ``role`` (consumidas pelo CurrentUser e RBAC).
    ``iat`` é informativo. ``role`` aceita papéis novos ou legados (admin/editor/
    viewer) — o BFF normaliza via normalize_role.
    """
    agora = int(time.time())
    payload: dict[str, Any] = {
        "sub": sub,
        "email": email,
        "role": role,
        "iat": agora,
        "exp": agora + expira_em_segundos,
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, secret, algorithm="HS256")


@pytest.fixture(scope="session")
def jwt_factory(auth_secret: str) -> Callable[..., str]:
    """
    Fábrica de tokens de teste por papel/expiração.

    Uso::

        token = jwt_factory(role="VISUALIZADOR")
        token_externo = jwt_factory(role="EXTERNO")
        token_vencido = jwt_factory(expira_em_segundos=-10)
        token_outro_segredo = jwt_factory(secret_override="errado")
    """

    def _make(
        *,
        sub: str = "user-test-0001",
        email: str = "teste@example.local",
        role: str = ROLE_ADMIN,
        expira_em_segundos: int = 3600,
        extra_claims: dict[str, Any] | None = None,
        secret_override: str | None = None,
    ) -> str:
        return _forjar_jwt(
            secret_override or auth_secret,
            sub=sub,
            email=email,
            role=role,
            expira_em_segundos=expira_em_segundos,
            extra_claims=extra_claims,
        )

    return _make


@pytest.fixture
def token_admin(jwt_factory: Callable[..., str]) -> str:
    """Token HS256 válido com papel ADMIN."""
    return jwt_factory(role=ROLE_ADMIN)


@pytest.fixture
def token_visualizador(jwt_factory: Callable[..., str]) -> str:
    """Token válido VISUALIZADOR (passa em require_visualizar e require_acervo)."""
    return jwt_factory(role=ROLE_VISUALIZADOR, sub="user-viz-0002")


@pytest.fixture
def token_externo(jwt_factory: Callable[..., str]) -> str:
    """Token válido EXTERNO (autenticado, mas BARRADO em require_visualizar/acervo)."""
    return jwt_factory(role=ROLE_EXTERNO, sub="user-ext-0003")


@pytest.fixture
def token_expirado(jwt_factory: Callable[..., str]) -> str:
    """Token HS256 já expirado (exp no passado) — deve gerar 401."""
    return jwt_factory(role=ROLE_ADMIN, expira_em_segundos=-30)


@pytest.fixture
def token_assinatura_invalida(jwt_factory: Callable[..., str]) -> str:
    """Token assinado com OUTRO segredo — assinatura inválida, deve gerar 401."""
    return jwt_factory(role=ROLE_ADMIN, secret_override="segredo-totalmente-errado")


def auth_headers(token: str) -> dict[str, str]:
    """Helper: monta o header Authorization Bearer para um token."""
    return {"Authorization": f"Bearer {token}"}


# ─────────────────────────────────────────────────────────────────────────────
# Cliente HTTP — escolhe IN-PROCESS (ASGI) ou LIVE (rede) conforme BFF_BASE_URL
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def base_url() -> str | None:
    """
    URL base do BFF no MODO LIVE (rede). ``None`` => modo IN-PROCESS (ASGI).

    Exporte ``BFF_BASE_URL=http://127.0.0.1:8000`` para testar o container real.
    """
    return os.environ.get("BFF_BASE_URL") or None


@pytest.fixture
async def client(base_url: str | None):
    """
    AsyncClient httpx apontando para o BFF.

    - LIVE: ``httpx.AsyncClient(base_url=BFF_BASE_URL)`` (precisa do container).
    - IN-PROCESS: importa ``app.main:app`` e usa ``ASGITransport`` (sem rede).

    Yield assíncrono: requer pytest-asyncio (asyncio_mode=auto).
    """
    import httpx

    if base_url:
        async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as c:
            yield c
        return

    # Modo in-process: importa a app DEPOIS do AUTH_SECRET já estar no ambiente.
    try:
        from app.main import app  # type: ignore
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"BFF não importável in-process ({exc}); defina BFF_BASE_URL.")
        return

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://bff.test", timeout=30.0
    ) as c:
        yield c


@pytest.fixture(scope="session")
def is_live(base_url: str | None) -> bool:
    """True se rodando contra um container real (BFF_BASE_URL setado)."""
    return base_url is not None


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures das suítes E2E (WP12) — clientes autenticados via tests/lib/auth_helpers
# ─────────────────────────────────────────────────────────────────────────────
# As 10 suítes e2e (tests/e2e/*.py) usam estes fixtures para falar com o stack
# REAL (perfil "tests" do compose): login NextAuth de verdade no web, JWS HS256
# forjado no BFF (modo (b) de bff/app/core/security.py) e conexão direta ao DB
# p/ asserts de efeito colateral. Os imports são TARDIOS porque tests/lib/
# fixtures.py e auth_helpers.py podem ser gerados em paralelo — a coleta
# (pytest --collect-only) nunca pode quebrar por causa deles.


def _carregar_auth_helpers():
    """Import tardio de tests.lib.auth_helpers (garante a raiz do repo no path)."""
    raiz = _TESTS_DIR.parent
    if str(raiz) not in sys.path:
        sys.path.insert(0, str(raiz))
    from tests.lib import auth_helpers  # noqa: PLC0415 — tardio de propósito

    return auth_helpers


def _carregar_fixtures_e2e():
    """Import tardio de tests.lib.fixtures (fonte única de UUIDs/usuários e2e)."""
    raiz = _TESTS_DIR.parent
    if str(raiz) not in sys.path:
        sys.path.insert(0, str(raiz))
    try:
        from tests.lib import fixtures  # noqa: PLC0415

        return fixtures
    except ImportError:
        return None


@pytest.fixture(scope="session")
def artifacts_dir() -> Path:
    """tests/_artifacts/ — destino canônico dos artefatos (e2e_results.json etc.)."""
    destino = _TESTS_DIR / "_artifacts"
    destino.mkdir(parents=True, exist_ok=True)
    return destino


@pytest.fixture(scope="session")
def web_admin():
    """httpx.Client com SESSÃO NextAuth real do admin e2e (cookie *session-token*).

    Login via fluxo csrf→callback/credentials (réplica do smoke-front.sh) com as
    credenciais canônicas de tests/lib/fixtures.py. Skip se o web não estiver
    alcançável (stack fora do ar) — falha de SENHA/seed continua sendo FAIL.
    """
    import httpx

    ah = _carregar_auth_helpers()
    fx = _carregar_fixtures_e2e()
    if fx is None:
        pytest.skip("tests/lib/fixtures.py ausente — rode o seed/fixtures e2e antes.")
    try:
        client = ah.login_web(fx.ADMIN_EMAIL, fx.E2E_PASSWORD)
    except httpx.TransportError as exc:
        pytest.skip(f"web não alcançável ({exc}) — stack no ar? (make up + perfil tests)")
    yield client
    client.close()


@pytest.fixture(scope="session")
def bff_admin():
    """httpx.Client no BFF com Bearer JWS HS256 forjado, papel ADMIN."""
    ah = _carregar_auth_helpers()
    client = ah.bff_client(role="ADMIN")
    yield client
    client.close()


@pytest.fixture(scope="session")
def bff_viewer():
    """httpx.Client no BFF, papel VISUALIZADOR (passa visualizar/acervo; sem gestão)."""
    ah = _carregar_auth_helpers()
    client = ah.bff_client(role="VISUALIZADOR")
    yield client
    client.close()


@pytest.fixture
def db():
    """Conexão psycopg (DATABASE_URL) p/ asserts de efeito colateral.

    Escopo de FUNÇÃO de propósito: cada teste recebe transação limpa e o
    rollback implícito do close não vaza estado entre testes. Skip se o DB não
    estiver alcançável (porta interna do compose; rodar no perfil tests).
    """
    ah = _carregar_auth_helpers()
    try:
        conn = ah.db_conn()
    except Exception as exc:  # noqa: BLE001 — OperationalError/DNS: infra fora do ar
        pytest.skip(f"PostgreSQL não alcançável via DATABASE_URL ({exc}).")
    yield conn
    conn.close()
