"""Budget diário de tokens Anthropic (G4) — kill-switch por cron/rota.

Usa Redis db0 (mesmo do rate-limit). Chave ``ia:tokens:YYYY-MM-DD`` com TTL 48h.
``IA_BUDGET_TOKENS_DAILY=0`` (default) = ilimitado.
"""

from __future__ import annotations

from datetime import datetime, timezone

import redis as redislib

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("petro_radar_bff.ia_budget")

_redis: redislib.Redis | None = None


def _client() -> redislib.Redis | None:
    global _redis
    if _redis is not None:
        return _redis
    url = settings.redis_url
    if not url:
        return None
    try:
        _redis = redislib.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        _redis.ping()
        return _redis
    except Exception:  # noqa: BLE001
        return None


def _chave_dia() -> str:
    dia = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    return f"ia:tokens:{dia}"


def tokens_usados_hoje() -> int:
    r = _client()
    if r is None:
        return 0
    try:
        val = r.get(_chave_dia())
        return int(val or 0)
    except Exception:  # noqa: BLE001
        return 0


def budget_excedido(extra: int = 0) -> bool:
    """True se o teto diário (settings) seria ultrapassado com ``extra`` tokens."""
    teto = int(getattr(settings, "ia_budget_tokens_daily", 0) or 0)
    if teto <= 0:
        return False
    return tokens_usados_hoje() + extra > teto


def registrar_tokens(n: int) -> None:
    """Incrementa o contador diário (best-effort)."""
    if n <= 0:
        return
    r = _client()
    if r is None:
        return
    try:
        chave = _chave_dia()
        pipe = r.pipeline()
        pipe.incrby(chave, n)
        pipe.expire(chave, 48 * 3600)
        pipe.execute()
    except Exception as exc:  # noqa: BLE001
        log.warning("ia_budget.registrar_falhou", extra={"erro": str(exc)})
