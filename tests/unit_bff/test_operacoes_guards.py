"""
0033 — Guards RBAC das rotas de OPERAÇÃO no BFF, in-process (sem stack).

Por que este arquivo existe: as três rotas nascidas com o "cofre por operação"
entraram em ``tests/parity/route_inventory.csv``, mas o ``test_route_inventory.py``
só roda contra um alvo HTTP de pé. Sem isto, os routers novos do BFF ficariam
cobertos apenas por ``python -m compileall`` — e a armadilha nº 1 da entrega é
justamente a ordem 401-antes-de-403 e o shape do corpo de erro, que só aparecem
em runtime.

Contrato verificado (espelha o Next):
  sem token   → 401 {"error": <msg>, "code": "UNAUTHENTICATED"}   (todas as rotas)
  EXTERNO     → 403 com o corpo EXATO do guard de cada rota (tabela abaixo)

ASSIMETRIA DE PROPÓSITO — o 403 de guard que LANÇA tem ``code`` e o inline NÃO:
  • o GET da LISTA chama ``requireConformidade()`` (decisão P10 — a lista expõe
    ``valor``): LEVANTA ApiError(403, "FORBIDDEN", "Apenas Conformidade") e o
    handleApiError do Next (e o handler global de bff/app/main.py) transforma
    em ``{error: "Apenas Conformidade", code: "FORBIDDEN"}``;
  • o GET do DETALHE segue ``requireVisualizar()`` (o dossiê não expõe valor a
    quem não é Conformidade): mesmo mecanismo, corpo ``{error: "Permissão
    negada", code: "FORBIDDEN"}``;
  • os POST fazem a checagem INLINE — ``if (!podeGerenciarDocumentosHabilitacao)
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 })``
    (operacoes/route.ts e verificar/route.ts) — e o corpo sai SEM ``code``,
    igual ao POST do cofre que já existia.
Não é bug: é o shape que o Next devolve, e paridade é copiar o que existe. O
teste trava a assimetria para que ninguém "uniformize" um lado só e quebre a
comparação Next×BFF.

Os guards levantam ANTES de qualquer I/O, então nenhum teste aqui toca banco.
"""
from __future__ import annotations

import pytest

from tests.conftest import auth_headers

# (método, rota, erro_403, code_403) — o inventário do CSV, em forma executável.
# ``code_403 is None`` marca a checagem INLINE (POST); string marca o guard que
# LANÇA (GET) — ver o docstring do módulo sobre a assimetria.
ROTAS_OPERACAO = [
    ("GET", "/api/conformidade/operacoes", "Apenas Conformidade", "FORBIDDEN"),  # P10
    ("POST", "/api/conformidade/operacoes", "Permissão negada", None),
    (
        "GET",
        "/api/conformidade/operacoes/11111111-1111-4111-8111-111111111111",
        "Permissão negada",
        "FORBIDDEN",
    ),
    ("POST", "/api/conformidade/cofre/documentos/verificar", "Permissão negada", None),
]


async def _chamar(client, metodo: str, rota: str, headers=None):
    if metodo == "GET":
        return await client.get(rota, headers=headers)
    return await client.post(rota, json={}, headers=headers)


@pytest.mark.parametrize("metodo,rota,_erro,_code", ROTAS_OPERACAO)
async def test_sem_token_da_401(client, metodo, rota, _erro, _code):
    r = await _chamar(client, metodo, rota)
    assert r.status_code == 401, f"{metodo} {rota}: esperado 401 sem token, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("code") == "UNAUTHENTICATED"
    assert corpo.get("error")


@pytest.mark.parametrize("metodo,rota,erro,code", ROTAS_OPERACAO)
async def test_externo_barrado(client, token_externo, metodo, rota, erro, code):
    """EXTERNO não enxerga dado nenhum — nem o catálogo de operações."""
    r = await _chamar(client, metodo, rota, auth_headers(token_externo))
    assert r.status_code == 403, f"{metodo} {rota}: EXTERNO deveria tomar 403, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("error") == erro
    # `code` só existe no ramo que LEVANTA (GET/require*) — ver o docstring do
    # módulo. Nos POST o Next devolve o corpo cru, sem `code`.
    assert corpo.get("code") == code


@pytest.mark.parametrize(
    "metodo,rota",
    [(m, r) for m, r, _erro, code in ROTAS_OPERACAO if code is None],
)
async def test_visualizador_nao_escreve(client, token_visualizador, metodo, rota):
    """VISUALIZADOR passa no gate de leitura e para no de conformidade.

    É o par que separa ``requireVisualizar`` de
    ``podeGerenciarDocumentosHabilitacao``: quem só olha não cadastra operação
    nem consulta o cofre por hash.
    """
    r = await _chamar(client, metodo, rota, auth_headers(token_visualizador))
    assert r.status_code == 403, f"{metodo} {rota}: VISUALIZADOR deveria tomar 403, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("error") == "Permissão negada"
    assert corpo.get("code") is None, "POST faz checagem inline: corpo sem `code` (paridade com o Next)"


async def test_401_vem_antes_de_403(client, token_externo):
    """Ordem dos gates: token inválido é 401 mesmo em rota que o papel também barraria.

    Se a autorização rodasse antes da autenticação, um EXTERNO com token vencido
    levaria 403 — e o front trataria como "sem permissão" em vez de mandar relogar.
    """
    r = await _chamar(client, "POST", "/api/conformidade/operacoes", {"Authorization": "Bearer lixo.nao.e.jwt"})
    assert r.status_code == 401
    assert r.json().get("code") == "UNAUTHENTICATED"
