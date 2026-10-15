"""
tests/unit_bff — UNIT TESTS do BFF **in-process** (F10). Sem rede, sem stack.

Consome o modo IN-PROCESS que o conftest raiz (tests/conftest.py) já preparava:
importa ``app.main:app`` (o pacote vive em ``bff/``, inserido no sys.path pelo
conftest raiz) e conversa com ele via ``httpx.ASGITransport``. Diferença
DELIBERADA em relação ao fixture ``client`` do conftest raiz: aqui o import do
BFF que falha é **FAIL**, não skip — esta suíte só roda em ambientes que têm as
deps do BFF, então "não importou" é regressão, não degradação consciente.

CAMINHOS DE EXECUÇÃO SUPORTADOS (escolha do F10 — documentada no Makefile):
  1. ``make test-unit-bff`` (canônico): container tester (python 3.12) com as
     deps do BFF pinadas em tests/requirements.txt e ``./bff`` montado em
     ``/bff:ro``. O conftest raiz resolve ``tests/../bff`` = ``/bff``.
  2. CI (.github/workflows/ci.yml, job unit-bff): ubuntu-latest + python 3.12,
     ``pip install -r bff/requirements.txt -r tests/requirements-test.txt`` e
     ``pytest tests/unit_bff`` direto no checkout (sem docker). Redis/DB fora
     do ar não travam: rate-limit e revogação são fail-open por default.
  3. Host dev com as deps do BFF num venv (mesmo comando do CI).

AUTH: o conftest raiz exporta AUTH_SECRET de teste ANTES de importar ``app.*``
(env var > .env do pydantic-settings), e a fábrica ``jwt_factory`` forja JWS
HS256 com o MESMO segredo — o contrato validado por bff/app/core/security.py.
"""
from __future__ import annotations

import pytest


@pytest.fixture(scope="session")
def bff_app():
    """Instância FastAPI do BFF importada in-process. ImportError = FAIL alto."""
    try:
        from app.main import app  # sys.path já tem bff/ (conftest raiz)
    except ImportError as exc:
        pytest.fail(
            f"BFF não importável in-process: {exc}. Rode via `make test-unit-bff` "
            "(tester com deps de tests/requirements.txt + ./bff montado) ou "
            "instale bff/requirements.txt no ambiente."
        )
    return app


@pytest.fixture
async def client(bff_app):
    """AsyncClient httpx via ASGITransport (in-process, sem sockets)."""
    import httpx

    transport = httpx.ASGITransport(app=bff_app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://bff.unit", timeout=30.0
    ) as c:
        yield c


@pytest.fixture(autouse=True)
async def _dispose_engine_do_bff():
    """Descarta o pool do engine global do BFF ao FIM de cada teste.

    Por quê: o pytest-asyncio (asyncio_mode=auto, fixtures function-scoped) cria
    um event loop NOVO por teste, mas ``app.db.session.engine`` é um singleton do
    processo — conexões asyncpg devolvidas ao pool ficam presas ao loop do teste
    que as criou. O próximo teste (loop novo) reusa a conexão do loop morto e
    estoura ``RuntimeError: Task got Future attached to a different loop`` /
    ``Event loop is closed`` (flaky: depende da ordem e do reuso do pool). Foi
    exatamente o sintoma da suíte S1–S7 de test_acervo_restrito.py, a primeira
    desta pasta a executar SQL de verdade in-process.

    ``engine.dispose()`` roda AINDA no loop do teste corrente, então fecha as
    conexões no loop que as possui; o teste seguinte começa com pool vazio. Para
    testes guard-only (sem I/O) é no-op barato. O import é tardio e tolerante:
    sem as deps do BFF quem falha alto é o fixture ``bff_app``, não este.
    """
    yield
    try:
        from app.db.session import engine  # sys.path já tem bff/ (conftest raiz)
    except Exception:  # noqa: BLE001 — sem BFF importável não há pool a limpar
        return
    await engine.dispose()
