"""Aplicação FastAPI — camada BFF (estrangulador) do Petro Radar on-premise.

Responsabilidades deste módulo:
  - Criar a instância ``FastAPI(title="Petro Radar BFF")``.
  - Configurar CORS interno a partir de ``settings.cors_origins``.
  - Middleware de ``X-Request-ID`` + logging estruturado por requisição.
  - Endpoint ``GET /health`` que verifica banco e Redis.
  - Incluir os routers de domínio sob o prefixo ``/bff``.

Padrão estrangulador (strangler-fig): o Next.js continua sendo o front e o
emissor de tokens; este BFF assume gradualmente endpoints de domínio, validando
o JWT emitido pelo NextAuth (ver ``app/core/security.py``).
"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.core.errors import registrar_handlers
from app.core.logging import get_logger, request_id_ctx, setup_logging
from app.core.observability import init_sentry, instrument_app, mount_metrics
from app.core.rate_limit import close_rate_limit_redis, rate_limit_dependency
from app.core.revocation import close_revocation_redis
from app.db.session import check_db, engine

setup_logging(settings.log_level)
log = get_logger("petro_radar_bff.main")

REQUEST_ID_HEADER = "X-Request-ID"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Ciclo de vida: loga subida e libera os pools no encerramento.

    Fecha, além do engine do banco, os pools Redis dedicados ao rate-limit (db0)
    e à revogação de JWT (db2) — ambos abertos lazy nos respectivos módulos.
    """
    log.info("BFF iniciando", extra={"cors_origins": settings.cors_origins})
    yield
    # Encerramento ordenado dos pools Redis de hardening + engine do banco.
    await close_rate_limit_redis()
    await close_revocation_redis()
    await engine.dispose()
    log.info("BFF encerrado")


# Rate-limit GLOBAL por IP (porta de entrada barata): aplicado como dependency
# do app inteiro. Limites finos por rota ficam nos routers de domínio (ver
# app/core/rate_limit.py). Fail-open por padrão (libera se o Redis cair).
_global_rate_limit = rate_limit_dependency(
    name="global", max_hits=600, window_seconds=60, by="ip"
)

app = FastAPI(
    title="Petro Radar BFF",
    description="Camada BFF (estrangulador) da versão on-premise do Petro Radar.",
    version="0.1.0",
    lifespan=lifespan,
    dependencies=[Depends(_global_rate_limit)],
)

# ── Observabilidade (LACUNA 15): Sentry/GlitchTip + métricas Prometheus ───────
# Todas degradam para no-op se a dep/DSN faltar (ver app/core/observability.py).
init_sentry()  # liga só com SENTRY_DSN + sentry-sdk; redige PII no before_send
instrument_app(app)  # middleware de latência/contagem HTTP (respeita metrics_enabled)
mount_metrics(app)  # publica GET /metrics (fora do prefixo /bff; só rede interna)

# ── Handlers de erro tipados (WP03/§8) ────────────────────────────────────────
# ApiError -> {error,code}; RequestValidationError (422) -> {error,code:VALIDATION}
# SEM ecoar o input (fix de PII). Complementam o handler de StarletteHTTPException
# (abaixo) e o catch-all 500 do middleware.
registrar_handlers(app)

# ── CORS interno ──────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[REQUEST_ID_HEADER],
)


# ── Handler de erro: espelha handleApiError do Next p/ erros de auth ───────────
@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Reescreve o corpo de erro para casar com ``handleApiError`` do Next.

    Os guards (``require_*``/``get_current_user``) levantam ``HTTPException`` 401/403.
    O Next devolve ``{error: <msg>, code: <UNAUTHENTICATED|FORBIDDEN>}``; o default
    do FastAPI seria ``{detail: <msg>}``. Reescrevemos 401/403 para o shape do Next.
    Se o ``detail`` já é um dict (rota que montou ``{error,code}``), repassa como
    está. Demais status mantêm ``{detail}`` (preserva 404/405/429 etc.).
    """
    detail = exc.detail
    headers = getattr(exc, "headers", None)
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content=detail, headers=headers)
    if exc.status_code in (401, 403):
        code = "UNAUTHENTICATED" if exc.status_code == 401 else "FORBIDDEN"
        return JSONResponse(
            status_code=exc.status_code, content={"error": detail, "code": code}
        )
    if exc.status_code == 405:
        # PARIDADE: método não suportado -> Next devolve 405 com corpo VAZIO (só o
        # header Allow). O default do FastAPI mandaria {detail:"Method Not Allowed"}.
        return Response(status_code=405, headers=headers)
    return JSONResponse(
        status_code=exc.status_code, content={"detail": detail}, headers=headers
    )


# ── Middleware: Request-ID + logging estruturado ──────────────────────────────
@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Atribui/propaga um ``X-Request-ID`` e loga início/fim de cada requisição.

    Reaproveita o ``X-Request-ID`` recebido (ex.: vindo do Next.js) ou gera um
    UUID4. O id fica no ``ContextVar`` (para o logger) e volta no header da
    resposta. Mede a latência e loga em JSON.
    """
    rid = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
    token = request_id_ctx.set(rid)
    inicio = time.perf_counter()
    log.info(
        "request.start",
        extra={"method": request.method, "path": request.url.path},
    )
    try:
        response: Response = await call_next(request)
    except Exception:
        dur_ms = round((time.perf_counter() - inicio) * 1000, 2)
        log.exception(
            "request.error",
            extra={"method": request.method, "path": request.url.path, "dur_ms": dur_ms},
        )
        response = JSONResponse(
            status_code=500, content={"error": "Erro interno", "request_id": rid}
        )
    finally:
        request_id_ctx.reset(token)

    dur_ms = round((time.perf_counter() - inicio) * 1000, 2)
    response.headers[REQUEST_ID_HEADER] = rid
    log.info(
        "request.end",
        extra={
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "dur_ms": dur_ms,
        },
    )
    return response


# ── Health check ──────────────────────────────────────────────────────────────
# Sob /bff (o NGINX roteia /bff/* para este servico; o healthcheck do compose e o
# smoke do deploy batem em /bff/health).
@app.get("/bff/health", tags=["infra"])
async def health() -> JSONResponse:
    """Verifica dependências (banco e Redis) e retorna o estado agregado.

    Retorna ``200`` quando tudo está OK; ``503`` se alguma dependência falhar.
    O Redis é checado de forma tolerante: ausência da lib/serviço é reportada
    como ``degraded`` sem derrubar o liveness do banco.
    """
    componentes: dict[str, str] = {}
    ok = True

    # Banco de dados.
    try:
        await check_db()
        componentes["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        ok = False
        componentes["database"] = f"erro: {exc!s}"
        log.error("health.database_falhou", extra={"erro": str(exc)})

    # Redis.
    try:
        import redis.asyncio as aioredis  # import tardio: dependência opcional em dev

        client = aioredis.from_url(settings.redis_url)
        try:
            await client.ping()
            componentes["redis"] = "ok"
        finally:
            await client.aclose()
    except Exception as exc:  # noqa: BLE001
        ok = False
        componentes["redis"] = f"erro: {exc!s}"
        log.error("health.redis_falhou", extra={"erro": str(exc)})

    status_code = 200 if ok else 503
    return JSONResponse(
        status_code=status_code,
        content={"status": "ok" if ok else "degraded", "componentes": componentes},
    )


# ── Routers de domínio (sob /bff) ─────────────────────────────────────────────
#
# Importados aqui ao final para evitar ciclos de import. Estes módulos são
# entregues pelo AGENTE DE ROUTERS; o include espera um objeto `router`
# (APIRouter) em cada um. Mantemos tolerância em dev caso ainda não existam.
try:
    from app.routers import acervo, licitacoes

    app.include_router(licitacoes.router, prefix="/bff")
    app.include_router(acervo.router, prefix="/bff")
except ImportError as exc:  # pragma: no cover - routers ainda não escritos
    log.warning(
        "Routers de domínio ainda não disponíveis", extra={"erro": str(exc)}
    )

# ── Rotas /api/* MIGRADAS (estrangulador) ─────────────────────────────────────
# Incluídas SEM prefixo: servem o MESMO path /api/<X> que o Next. O NGINX roteia
# esses paths ao BFF (nginx/strangler/routes.conf). Resposta validada por paridade.
try:
    from app.routers.migrated import include_migrated

    _migradas = include_migrated(app)
    log.info("estrangulador: rotas /api migradas", extra={"modulos": _migradas})
except Exception as exc:  # noqa: BLE001
    log.warning("nenhuma rota migrada incluída", extra={"erro": str(exc)})
