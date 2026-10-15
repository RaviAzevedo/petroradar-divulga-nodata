"""
conftest.py local de tests/parity/ — fixture `sessao_por_papel` para os testes
FULL-STACK (web/Next via NGINX), complementar ao conftest raiz (que é BFF/JWT).

Pytest funde conftests por diretório: este NÃO sobrescreve o da raiz; apenas
adiciona a fixture de SESSÃO NEXTAUTH (cookie) usada por test_route_inventory.py.

Decisão 4: NextAuth (Credentials+bcrypt) emite a sessão; o login REAL é o de
tests/lib/auth_helpers.login_web (fluxo csrf → callback/credentials replicado
do smoke-front.sh — único fluxo de login provado do subsistema). Credenciais
vêm da FONTE ÚNICA tests/lib/fixtures.py (fixtures.USERS[papel] +
fixtures.E2E_PASSWORD), semeadas no Postgres por tests/fixtures/seed.sql
(make seed-e2e). O antigo tests/fixtures/users.json foi APOSENTADO: divergia
do seed canônico (*@proponente.test / Test1234!) e o login falhava silencioso —
allow-tests 401 e deny-tests passando VÁCUOS (auditoria 2026-06-10, alta).

FALHA ALTO, NUNCA cookies vazios (401 sem sessão ≠ RBAC barrando):
  - login sem cookie *session-token* (seed não rodou, senha != E2E_PASSWORD,
    usuário inativo) → AssertionError de login_web vira pytest.fail, cacheada
    por papel p/ não martelar bcrypt(12) a cada teste;
  - papel fora de fixtures.USERS → pytest.fail (inventário inconsistente);
  - stack fora do ar (TransportError) → pytest.skip, mesmo critério do
    fixture web_admin do conftest raiz, também cacheado (evita re-timeout).
"""
from __future__ import annotations

import httpx
import pytest

from tests.lib import auth_helpers, fixtures


@pytest.fixture(scope="session")
def sessao_por_papel():
    """papel → dict de cookies da sessão NextAuth REAL (cacheado por papel).

    Reusa auth_helpers.login_web; o client é fechado logo após extrair o jar —
    test_route_inventory.py só precisa do dict (httpx.request(..., cookies=)).
    Custo: 1 login bcrypt por papel por sessão pytest (7 no total).
    """
    cache: dict[str, dict[str, str]] = {}     # papel → cookies (sucesso)
    falhas: dict[str, str] = {}               # papel → diagnóstico (login FAIL)
    indisponivel: list[str] = []              # 1º TransportError → skip geral

    def _login(papel: str) -> dict[str, str]:
        if indisponivel:
            pytest.skip(indisponivel[0])
        if papel in falhas:
            pytest.fail(falhas[papel], pytrace=False)
        if papel in cache:
            return cache[papel]

        email = fixtures.USERS.get(papel)
        if not email:
            falhas[papel] = (
                f"papel {papel!r} fora do canônico fixtures.USERS "
                f"({sorted(fixtures.USERS)}) — corrija route_inventory.csv."
            )
            pytest.fail(falhas[papel], pytrace=False)

        try:
            client = auth_helpers.login_web(email, fixtures.E2E_PASSWORD)
        except httpx.TransportError as exc:
            indisponivel.append(
                f"web não alcançável ({exc}) — stack no ar? (make up + perfil tests)"
            )
            pytest.skip(indisponivel[0])
        except AssertionError as exc:  # login sem session-token: seed/senha quebrados
            falhas[papel] = str(exc)
            pytest.fail(falhas[papel], pytrace=False)

        try:
            cookies = {c.name: c.value for c in client.cookies.jar}
        finally:
            client.close()
        cache[papel] = cookies
        return cookies

    return _login
