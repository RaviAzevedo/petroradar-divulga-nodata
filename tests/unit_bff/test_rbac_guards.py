"""
F10(a) — Guards RBAC do BFF in-process: EXTERNO barrado em rotas de dados.

Valida o contrato de autorização SEM stack (ASGITransport): os ``require_*`` de
bff/app/core/security.py levantam 401/403 ANTES de qualquer I/O de banco, e o
exception handler de bff/app/main.py reescreve o corpo p/ o shape do Next
(``{"error": <msg>, "code": "UNAUTHENTICATED"|"FORBIDDEN"}``) — paridade com
handleApiError. Rotas escolhidas (inventário tests/parity/route_inventory.csv):

  GET  /api/licitacoes      requireVisualizar  → EXTERNO 403 ("Permissão negada")
  POST /api/acervo/buscar   requireAcervo      → EXTERNO 403 ("Sem acesso ao acervo")
  GET  /api/admin/users     requireAdmin       → VISUALIZADOR 403 ("Apenas administrador")

Tokens: JWS HS256 forjados pelo ``jwt_factory`` do conftest raiz (mesmo
AUTH_SECRET que o app importado valida — modo (b) de get_current_user).
"""
from __future__ import annotations

from tests.conftest import auth_headers


async def test_sem_token_da_401_unauthenticated(client):
    r = await client.get("/api/licitacoes")
    assert r.status_code == 401, f"esperado 401 sem token, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("code") == "UNAUTHENTICATED"
    assert corpo.get("error")  # mensagem do guard (shape do handleApiError)


async def test_token_expirado_da_401(client, token_expirado):
    r = await client.get("/api/licitacoes", headers=auth_headers(token_expirado))
    assert r.status_code == 401, f"esperado 401 c/ token expirado, veio {r.status_code}"
    assert r.json().get("code") == "UNAUTHENTICATED"


async def test_externo_barrado_em_licitacoes(client, token_externo):
    r = await client.get("/api/licitacoes", headers=auth_headers(token_externo))
    assert r.status_code == 403, f"EXTERNO deveria tomar 403 em /api/licitacoes, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("code") == "FORBIDDEN"
    assert corpo.get("error") == "Permissão negada"  # mensagem EXATA do require_visualizar


async def test_externo_barrado_no_acervo_buscar(client, token_externo):
    r = await client.post(
        "/api/acervo/buscar",
        headers=auth_headers(token_externo),
        json={"query": "atestado de refino", "topK": 3},
    )
    assert r.status_code == 403, f"EXTERNO deveria tomar 403 em /api/acervo/buscar, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("code") == "FORBIDDEN"
    assert corpo.get("error") == "Sem acesso ao acervo"  # mensagem EXATA do require_acervo


async def test_visualizador_barrado_em_admin_users(client, token_visualizador):
    r = await client.get("/api/admin/users", headers=auth_headers(token_visualizador))
    assert r.status_code == 403, f"VISUALIZADOR deveria tomar 403 em /api/admin/users, veio {r.status_code}"
    corpo = r.json()
    assert corpo.get("code") == "FORBIDDEN"
    assert corpo.get("error") == "Apenas administrador"  # mensagem EXATA do require_admin
