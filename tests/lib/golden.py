"""
WP12 §5.1 — Captura/replay de GOLDENS (saídas-ouro de referência).

- Se PROD_REF_BASE_URL estiver setado, chama o PROD-REF (clone read-only de
  produção) e GRAVA o golden em tests/_golden/<rota>__<metodo>__<hash-input>.json.
- Se vazio, faz REPLAY do golden local (permite rodar a comparação offline;
  as comparações exatas — heurísticas/shape/RBAC — não dependem de prod viva).
- MODO SELF-GOLDEN (B5, 2026-07-02): compare_prod_onprem.py também pode capturar
  goldens do PRÓPRIO ambiente on-prem (baseline local) passando a base do
  on-prem como ``prod_ref_base`` — a mecânica de captura/replay é a MESMA.

Nunca escreve na produção real. Só GET idempotentes e POST determinísticos são
capturados ao vivo; POST com IA usa golden de SHAPE (sem texto).

AUTENTICAÇÃO (auditoria 2026-06-10, TODO quitado em 2026-07-02):
:func:`session_cookie` faz login NextAuth REAL via tests/lib/auth_helpers.login_web
(csrf → callback/credentials) com as credenciais canônicas de tests/lib/fixtures
(``<papel>.e2e@example.invalid`` / ``fixtures.E2E_PASSWORD``) e FALHA ALTO
(AssertionError) quando o login não devolve o cookie *session-token* — nunca mais
devolve {} silencioso (que gerava a "paridade" vácua 401×401). Papel ``anon``
(ou vazio) => sem cookie, para rotas públicas. Contra um PROD-REF real, exporte
``PROD_REF_EMAIL``/``PROD_REF_PASSWORD`` (credenciais do operador).
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib

import httpx

GOLDEN_DIR = pathlib.Path(__file__).resolve().parents[1] / "_golden"
GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
_SESSION_CACHE: dict[str, dict] = {}


def _slug(rota: str, metodo: str, body) -> str:
    h = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:8]
    return f"{rota.strip('/').replace('/', '_')}__{metodo}__{h}.json"


def golden_path(rota: str, metodo: str, body) -> pathlib.Path:
    """Caminho canônico do golden de um caso (rota+método+hash do body)."""
    return GOLDEN_DIR / _slug(rota, metodo, body)


def fetch_or_replay(prod_ref_base: str, rota: str, metodo: str, body, papel: str) -> dict:
    path = golden_path(rota, metodo, body)
    if not prod_ref_base:
        if path.exists():
            return json.loads(path.read_text())
        return {"status": None, "json": {}, "_note": "sem PROD_REF e sem golden versionado"}
    cookies = session_cookie(prod_ref_base, papel)
    r = httpx.request(metodo, prod_ref_base + rota, json=body, cookies=cookies, timeout=60)
    try:
        out = {"status": r.status_code, "json": r.json()}
    except ValueError:
        out = {"status": r.status_code, "bytes": len(r.content), "ctype": r.headers.get("content-type")}
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    return out


def session_cookie(base: str, papel: str) -> dict:
    """Cookie de sessão NextAuth REAL para um papel (cacheado por base+papel).

    Reusa tests/lib/auth_helpers.login_web (fluxo csrf → callback/credentials,
    réplica do smoke-front.sh). Credenciais: fixtures canônicas do harness
    (seed.sql precisa ter rodado — ``make test-seed``); contra PROD-REF, os
    envs ``PROD_REF_EMAIL``/``PROD_REF_PASSWORD`` têm precedência.
    ``papel`` vazio/"anon" => {} (rota pública, sem sessão).
    Login que não devolve *session-token* levanta AssertionError (falha alto).
    """
    if not papel or papel.lower() == "anon":
        return {}
    key = f"{base}:{papel}"
    if key in _SESSION_CACHE:
        return _SESSION_CACHE[key]

    from tests.lib import auth_helpers, fixtures  # import tardio (padrão do harness)

    email = os.environ.get("PROD_REF_EMAIL") or fixtures.USERS.get(
        papel, f"{papel.lower()}.e2e@example.invalid"
    )
    password = os.environ.get("PROD_REF_PASSWORD") or fixtures.E2E_PASSWORD
    client = auth_helpers.login_web(email, password, base_url=base)
    try:
        cookies = {c.name: c.value for c in client.cookies.jar if c.value is not None}
    finally:
        client.close()
    _SESSION_CACHE[key] = cookies
    return cookies
