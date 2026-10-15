"""Rate-limit distribuído (sliding window) sobre Redis para a camada BFF.

Endereça as LACUNAS 6, 9 e (indiretamente) 12 do revisor: a produção usa o
``rate-limit`` da Upstash via REST (``src/lib/rate-limit/index.ts``), que **não
existe** on-prem. Aqui reimplementamos o mesmo contrato funcional usando o
container ``redis`` (TCP), no **db0** (cache/rate-limit) — exatamente a alocação
travada nas matrizes de paridade:

    db0 = cache / rate-limit   (ESTE módulo)
    db1 = broker Celery        (worker/)
    db2 = sessão / revogação    (app/core/revocation.py — set ``auth:revogados``)
    db3 = reservado             (lado web)

Diferenças vs. produção (melhorias, mantendo paridade de comportamento):
  - **Sliding window log** (ZSET) em vez de *fixed window* (INCR+EXPIRE). O
    fixed-window da Upstash deixa passar até 2x ``max`` na virada da janela; o
    sliding window por timestamp elimina esse pico. O contrato externo
    (``allowed``/``remaining``/``reset_at``) é o mesmo.
  - **Distribuído de verdade** (Redis compartilhado por todos os workers do
    BFF), então ``isRateLimitDistributed()`` da produção passa a ser sempre
    verdadeiro on-prem (a matriz DADOS-STORAGE §exige isso para login/setup).
  - **Fail-open** controlável: se o Redis cair, por padrão LIBERA (paridade com
    o fallback in-process da produção, que degrada para o Map). Pontos
    sensíveis (login) podem pedir ``fail_open=False`` para fail-closed.

A janela é implementada com a técnica do *sorted set por timestamp*:
``ZREMRANGEBYSCORE`` poda os hits fora da janela, ``ZADD`` registra o hit atual,
``ZCARD`` conta os hits vivos e ``EXPIRE`` garante limpeza preguiçosa. Tudo numa
pipeline atômica (``MULTI/EXEC``) — uma viagem ao Redis por verificação.

================================================================================
WIRING NECESSÁRIO (este arquivo é NOVO; não edita nenhum existente)
================================================================================

1) requirements.txt (bff/) — JÁ contém ``redis==5.2.1``. Nada a adicionar para
   o rate-limit; ele reusa o mesmo client async já presente no /health.

2) app/main.py — registrar o ciclo de vida do pool Redis e (opcional) um
   middleware global. Aplicar este diff ao ``lifespan`` e ao final do arquivo:

       # --- imports (topo) ---
       from app.core.rate_limit import (
           close_rate_limit_redis,
           rate_limit_dependency,
       )

       # --- dentro de lifespan(), ANTES do yield: nada obrigatório (lazy) ---
       # --- dentro de lifespan(), DEPOIS do yield (encerramento): ---
       async def lifespan(_app: FastAPI):
           log.info("BFF iniciando", extra={"cors_origins": settings.cors_origins})
           yield
           await close_rate_limit_redis()   # <-- ADICIONAR
           await engine.dispose()
           log.info("BFF encerrado")

   Para rate-limit GLOBAL barato por IP (porta de entrada), adicionar como
   dependency do app inteiro na criação da instância:

       app = FastAPI(
           title="Petro Radar BFF",
           ...,
           lifespan=lifespan,
           dependencies=[Depends(rate_limit_dependency(
               name="global", max_hits=600, window_seconds=60, by="ip",
           ))],
       )

3) Routers de domínio — aplicar limites finos espelhando os pontos que a
   produção protege (``src/lib/rate-limit`` é chamado em ``acervo/buscar``,
   rotas de analytics, ``licitacoes/[id]/analise``, ``auth/setup``,
   ``cron/cnpj-watch``). Exemplos de uso por rota:

       from fastapi import Depends
       from app.core.rate_limit import rate_limit_dependency
       from app.core.security import CurrentUser, require_acervo

       # busca semântica do acervo (caro: chama embeddings + Anthropic)
       @router.post(
           "/acervo/buscar",
           dependencies=[Depends(rate_limit_dependency(
               name="acervo-buscar", max_hits=20, window_seconds=60, by="user",
           ))],
       )
       async def buscar(..., user: CurrentUser = Depends(require_acervo)): ...

   Para combinar com o usuário autenticado sem dupla checagem, use o limitador
   imperativo dentro do handler (``check_rate_limit(key=..., ...)``) — útil
   quando a chave precisa de dados do corpo (ex.: ``login:{email}``).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status

from app.core.config import settings
from app.core.logging import get_logger

try:  # redis é dependência declarada (redis==5.2.1); import tardio por robustez
    import redis.asyncio as aioredis
except Exception:  # pragma: no cover - ambiente sem a lib
    aioredis = None  # type: ignore[assignment]

log = get_logger("petro_radar_bff.rate_limit")

#: Prefixo das chaves do sliding window (espelha o ``rl:`` da produção).
_KEY_PREFIX = "rl"


def _rate_limit_failclosed() -> bool:
    """Kill-switch global de fail-CLOSED, controlado por env (default desligado).

    Com ``RATE_LIMIT_FAILCLOSED=1``, quando o Redis cair TODO limite passa a
    NEGAR (429) em vez de liberar — mesmo que o chamador tenha pedido
    ``fail_open=True``. Serve de trava operacional para endurecer o BFF sob
    ataque sem precisar redeployar. Default ``0`` (fail-open) preserva o
    comportamento tolerante atual. Lido do ambiente para não exigir alteração no
    config.py (fora do escopo deste módulo)."""
    return os.getenv("RATE_LIMIT_FAILCLOSED", "0") == "1"

# ── Pool Redis dedicado ao db0 (cache/rate-limit) ─────────────────────────────
#
# A REDIS_URL canônica já aponta para db0 (``redis://...:6379/0``), portanto
# reaproveitamos settings.redis_url sem reescrever o número do db. Mantemos um
# único client compartilhado (connection pool interno do redis-py).

_redis_client: "aioredis.Redis | None" = None  # type: ignore[name-defined]


def _get_redis() -> "aioredis.Redis | None":  # type: ignore[name-defined]
    """Retorna o client Redis singleton (lazy). ``None`` se a lib faltar."""
    global _redis_client
    if aioredis is None:
        return None
    if _redis_client is None:
        # decode_responses=False: trabalhamos com membros binários no ZSET.
        _redis_client = aioredis.from_url(
            settings.redis_url,
            encoding="utf-8",
            decode_responses=False,
        )
    return _redis_client


async def close_rate_limit_redis() -> None:
    """Fecha o pool Redis do rate-limit. Chamar no encerramento (lifespan)."""
    global _redis_client
    if _redis_client is not None:
        try:
            await _redis_client.aclose()
        except Exception as exc:  # noqa: BLE001
            log.warning("rate_limit.redis_close_falhou", extra={"erro": str(exc)})
        finally:
            _redis_client = None


def is_rate_limit_distributed() -> bool:
    """Espelha ``isRateLimitDistributed()`` da produção.

    On-prem o rate-limit usa o Redis compartilhado: distribuído sempre que a
    lib ``redis`` estiver disponível. Pontos sensíveis (login/setup) usam isto
    para decidir fail-open vs. fail-closed quando o Redis cai.
    """
    return _get_redis() is not None


# ── Resultado ─────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class RateLimitResult:
    """Resultado de uma verificação (espelha ``RateLimitResult`` do TS).

    ``allowed``    — se o hit atual está dentro do limite.
    ``remaining``  — quantos hits ainda cabem na janela.
    ``reset_at``   — epoch (segundos, float) em que o hit mais antigo expira.
    ``limit``      — o teto configurado (para o header ``X-RateLimit-Limit``).
    """

    allowed: bool
    remaining: int
    reset_at: float
    limit: int


# ── Núcleo: sliding window log via ZSET ───────────────────────────────────────


async def check_rate_limit(
    *,
    key: str,
    max_hits: int,
    window_seconds: int,
    fail_open: bool = True,
) -> RateLimitResult:
    """Verifica e registra um hit no contador ``key`` (sliding window).

    Algoritmo (uma pipeline atômica por chamada):
      1. ``ZREMRANGEBYSCORE`` remove hits anteriores a ``agora - janela``.
      2. ``ZADD`` registra o hit atual (score = timestamp em ms; membro único).
      3. ``ZCARD`` conta os hits vivos na janela.
      4. ``EXPIRE`` aplica TTL = janela (limpeza preguiçosa de chaves frias).

    ``allowed`` = (contagem <= max_hits). Quando ``allowed`` é falso, o hit JÁ
    foi gravado — isso é intencional (mantém o atacante "pressionando" a janela,
    igual à semântica INCR da produção).

    Fail-open: se o Redis estiver indisponível e ``fail_open=True`` (padrão),
    LIBERA o acesso (paridade com o fallback in-process da produção). Use
    ``fail_open=False`` em login/setup para negar quando o Redis cair. O
    kill-switch global ``RATE_LIMIT_FAILCLOSED=1`` força fail-closed mesmo quando
    o chamador pediu ``fail_open=True`` (ver :func:`_rate_limit_failclosed`).
    """
    client = _get_redis()
    full_key = f"{_KEY_PREFIX}:{key}"
    agora = time.time()
    janela_inicio = agora - window_seconds
    # fail-open efetivo: o kill-switch global vence o pedido do chamador.
    fail_open_efetivo = fail_open and not _rate_limit_failclosed()

    if client is None:
        return _fallback(max_hits, agora, window_seconds, fail_open_efetivo)

    # Membro único por hit: "<ts_ns>-<contador-best-effort>". Usar ns evita
    # colisão de score quando dois hits caem no mesmo ms (ZADD sobrescreveria
    # o membro idêntico e subcontaria). O sufixo aleatório-leve resolve o resto.
    membro = f"{time.time_ns()}".encode()

    try:
        pipe = client.pipeline(transaction=True)
        pipe.zremrangebyscore(full_key, 0, janela_inicio)
        pipe.zadd(full_key, {membro: agora})
        pipe.zcard(full_key)
        pipe.zrange(full_key, 0, 0, withscores=True)  # hit mais antigo (p/ reset)
        pipe.expire(full_key, window_seconds)
        resultados = await pipe.execute()
    except Exception as exc:  # noqa: BLE001 - falha de infra do Redis
        log.error(
            "rate_limit.redis_falhou",
            extra={"erro": str(exc), "key": key, "failclosed": not fail_open_efetivo},
        )
        return _fallback(max_hits, agora, window_seconds, fail_open_efetivo)

    contagem = int(resultados[2] or 0)
    mais_antigo = resultados[3]
    if mais_antigo:
        # zrange withscores -> [(membro, score)]; score = epoch do hit + janela.
        _, score = mais_antigo[0]
        reset_at = float(score) + window_seconds
    else:
        reset_at = agora + window_seconds

    return RateLimitResult(
        allowed=contagem <= max_hits,
        remaining=max(0, max_hits - contagem),
        reset_at=reset_at,
        limit=max_hits,
    )


def _fallback(
    max_hits: int, agora: float, window_seconds: int, fail_open: bool
) -> RateLimitResult:
    """Resultado quando o Redis está indisponível.

    ``fail_open=True`` libera (remaining cheio); ``False`` nega tudo.
    """
    if fail_open:
        return RateLimitResult(
            allowed=True,
            remaining=max_hits,
            reset_at=agora + window_seconds,
            limit=max_hits,
        )
    return RateLimitResult(
        allowed=False,
        remaining=0,
        reset_at=agora + window_seconds,
        limit=max_hits,
    )


async def reset_rate_limit(key: str) -> None:
    """Zera o contador de ``key`` (espelha ``rateLimitReset`` — ex.: login OK)."""
    client = _get_redis()
    if client is None:
        return
    try:
        await client.delete(f"{_KEY_PREFIX}:{key}")
    except Exception as exc:  # noqa: BLE001
        # Best-effort: o contador expira sozinho pelo TTL.
        log.warning("rate_limit.reset_falhou", extra={"erro": str(exc), "key": key})


# ── Identificação do cliente (usuário autenticado ou IP) ──────────────────────


def _client_ip(request: Request) -> str:
    """Extrai o IP de origem respeitando o proxy reverso (NGINX estrangulador).

    O NGINX repassa ``X-Forwarded-For``/``X-Real-IP``; usamos o primeiro IP do
    XFF (cliente original). Fallback para o peer TCP direto.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "desconhecido"


def _subject_key(request: Request, by: str) -> str:
    """Deriva a chave do sujeito do rate-limit.

    ``by="user"``  → tenta o ``sub`` do JWT (se já validado em ``request.state``);
                     cai para o IP se não houver usuário.
    ``by="ip"``    → sempre o IP de origem.
    """
    if by == "user":
        # Reusa o usuário se já foi resolvido por outra dependency neste request.
        user = getattr(request.state, "current_user", None)
        sub = getattr(user, "sub", None)
        if sub:
            return f"user:{sub}"
        return f"ip:{_client_ip(request)}"
    return f"ip:{_client_ip(request)}"


# ── Dependency factory para FastAPI ───────────────────────────────────────────


def rate_limit_dependency(
    *,
    name: str,
    max_hits: int,
    window_seconds: int,
    by: str = "ip",
    fail_open: bool = True,
):
    """Cria uma dependency FastAPI que aplica rate-limit e responde ``429``.

    Parâmetros:
      ``name``           — namespace do limite (compõe a chave; ex.: ``acervo-buscar``).
      ``max_hits``       — teto de requisições na janela.
      ``window_seconds`` — tamanho da janela deslizante.
      ``by``             — ``"user"`` (sub do JWT, fallback IP) ou ``"ip"``.
      ``fail_open``      — comportamento quando o Redis cai (padrão: liberar).

    Em estouro, levanta ``429`` com os headers padrão de rate-limit
    (``Retry-After``, ``X-RateLimit-Limit/Remaining/Reset``). Em sucesso, grava
    os mesmos headers em ``request.state`` para o handler/middleware repassar.

    Uso::

        @router.post(
            "/acervo/buscar",
            dependencies=[Depends(rate_limit_dependency(
                name="acervo-buscar", max_hits=20, window_seconds=60, by="user",
            ))],
        )
        async def buscar(...): ...
    """

    async def _dependency(request: Request) -> None:
        sujeito = _subject_key(request, by)
        chave = f"{name}:{sujeito}"
        resultado = await check_rate_limit(
            key=chave,
            max_hits=max_hits,
            window_seconds=window_seconds,
            fail_open=fail_open,
        )

        # Headers informativos (sempre, mesmo quando permitido) — guardados em
        # request.state para o middleware de resposta anexar (paridade com APIs
        # que expõem X-RateLimit-*). Não conseguimos setar headers de resposta
        # aqui diretamente (a Response ainda não existe), então propagamos.
        request.state.rate_limit_headers = {
            "X-RateLimit-Limit": str(resultado.limit),
            "X-RateLimit-Remaining": str(resultado.remaining),
            "X-RateLimit-Reset": str(int(resultado.reset_at)),
        }

        if not resultado.allowed:
            retry_after = max(1, int(resultado.reset_at - time.time()))
            log.warning(
                "rate_limit.bloqueado",
                extra={
                    "limite": name,
                    "sujeito": sujeito,
                    "max": max_hits,
                    "janela_s": window_seconds,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Muitas requisições. Tente novamente em instantes.",
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Limit": str(resultado.limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(resultado.reset_at)),
                },
            )

    return _dependency


__all__ = [
    "RateLimitResult",
    "check_rate_limit",
    "reset_rate_limit",
    "rate_limit_dependency",
    "is_rate_limit_distributed",
    "close_rate_limit_redis",
]
