"""Autorização de endpoints de cron/protegidos por segredo (Bearer).

Replica ``verifyCronAuth``/``safeEqual`` do Next (src/lib/security/secrets.ts):
comparação resistente a timing attack (SHA-256 + compare_digest). Quando
``CRON_SECRET`` está configurado, SEMPRE exige ``Authorization: Bearer <secret>``;
sem ele (dev), aceita o header ``x-vercel-cron: 1``.
"""
from __future__ import annotations

import hashlib
import hmac

from fastapi import HTTPException, Request, status

from app.core.config import get_settings


def safe_equal(a: str | None, b: str | None) -> bool:
    """Compara dois segredos constant-time (SHA-256 dos dois lados)."""
    if a is None or b is None:
        return False
    ha = hashlib.sha256(a.encode()).digest()
    hb = hashlib.sha256(b.encode()).digest()
    return hmac.compare_digest(ha, hb)


def verify_cron_auth(request: Request) -> bool:
    """True se a requisição está autorizada a rodar um cron. Espelha o Next."""
    settings = get_settings()
    secret = settings.cron_secret
    if secret:
        # PARIDADE com verifyCronAuth do Next (secrets.ts L33-40): com CRON_SECRET
        # configurado, aceita EXCLUSIVAMENTE Authorization: Bearer <secret>. NÃO
        # aceitar x-cron-secret aqui (ampliaria a superfície de auth vs o Next).
        auth = request.headers.get("authorization") or ""
        return safe_equal(auth, f"Bearer {secret}")
    return request.headers.get("x-vercel-cron") == "1"


def require_cron(request: Request) -> None:
    """Levanta 401 se não autorizado (igual ao early-return do Next)."""
    if not verify_cron_auth(request):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
