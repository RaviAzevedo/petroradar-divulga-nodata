"""Observabilidade do BFF: métricas Prometheus + Sentry/GlitchTip opcional.

Endereça a LACUNA 15 (observabilidade/Sentry + log shipping não containerizados)
e dá paridade com a produção, que tem ``src/lib/observability/sentry.ts`` (no-op
até ``SENTRY_DSN`` + ``@sentry/nextjs``) e logger estruturado. Aqui entregamos
duas peças desacopladas e ambas DEGRADAM PARA NO-OP sem dependências externas:

  1. **Métricas Prometheus** (``GET /metrics``): contadores e histogramas por
     requisição HTTP, mais um helper para instrumentar tarefas de fundo. Usa
     ``prometheus-client`` (puro Python, sem egress). O scrape é feito por um
     Prometheus interno do datacenter — nada sai para a internet.

  2. **Sentry/GlitchTip opcional**: ``init_sentry()`` só liga se ``SENTRY_DSN``
     estiver setado E o pacote ``sentry-sdk`` estiver instalado. On-prem o DSN
     aponta para um **GlitchTip self-hosted** (compatível com o protocolo
     Sentry), nunca para o SaaS. O ``before_send`` REDIGE PII antes de enviar
     qualquer evento (e-mails, tokens, cookies, Authorization, CPF/CNPJ, etc.) —
     requisito LGPD (relacionado à Lacuna 13).

Ambas as peças são seguras para rede fechada: sem ``prometheus-client`` o
``/metrics`` responde texto vazio; sem ``sentry-sdk``/``SENTRY_DSN`` a captura
de exceções é no-op silencioso (mesmo contrato do ``captureException`` do TS).

================================================================================
WIRING NECESSÁRIO (este arquivo é NOVO; não edita nenhum existente)
================================================================================

1) requirements.txt (bff/) — ADICIONAR (ambos opcionais p/ runtime, mas
   recomendados; o módulo degrada se faltarem):

       # Observabilidade
       prometheus-client==0.21.1
       sentry-sdk==2.20.0

2) app/core/config.py — ADICIONAR ao corpo da classe ``Settings`` (espelha as
   envs de paridade SENTRY_* da matriz ENV.md §1.13):

       # ── Sentry / GlitchTip (opcional, self-hosted on-prem) ───────────────
       sentry_dsn: str = Field(default="", alias="SENTRY_DSN")
       sentry_environment: str = Field(default="onprem", alias="SENTRY_ENVIRONMENT")
       sentry_traces_sample_rate: float = Field(
           default=0.0, alias="SENTRY_TRACES_SAMPLE_RATE"
       )
       # Liga/desliga o endpoint /metrics (default ligado).
       metrics_enabled: bool = Field(default=True, alias="METRICS_ENABLED")

3) app/main.py — instrumentar a aplicação. Aplicar este diff:

       # --- topo ---
       from app.core.observability import (
           init_sentry, instrument_app, mount_metrics,
       )

       # --- logo após criar `app = FastAPI(...)` ---
       init_sentry()        # no-op sem SENTRY_DSN/sentry-sdk
       instrument_app(app)  # registra o middleware de métricas (latência/contagem)
       mount_metrics(app)   # publica GET /metrics (no-op sem prometheus-client)

   O ``instrument_app`` registra um middleware que NÃO conflita com o de
   Request-ID já existente (ambos são ``@app.middleware("http")``; a ordem é a
   de registro). Se preferir consolidar, mover a medição de latência para o
   middleware de Request-ID e chamar ``record_http_request(...)`` lá — diff
   alternativo no rodapé desta docstring.

4) docker-compose.yml — expor ``/metrics`` ao Prometheus interno: o serviço
   ``bff`` já está na rede ``backend``; basta o Prometheus interno fazer scrape
   de ``http://bff:8000/metrics``. NÃO publicar ``/metrics`` no NGINX externo
   (em ``nginx/conf.d/petro-radar.conf`` manter o location ``/bff/`` sem expor
   ``/metrics``, ou bloqueá-lo com ``deny all;``). Para coletar também o worker
   Celery, ver ``worker/healthz.py`` (porta de health própria).

   --- DIFF ALTERNATIVO (consolidar no middleware de Request-ID, item 3) ---
   Em app/main.py, no ``request_id_middleware``, após calcular ``dur_ms`` final:
       from app.core.observability import record_http_request
       record_http_request(
           method=request.method,
           path=request.url.path,
           status=response.status_code,
           duration_s=(time.perf_counter() - inicio),
       )
   e então NÃO chamar ``instrument_app(app)`` (evita medir duas vezes).
"""

from __future__ import annotations

import re
import time
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("petro_radar_bff.observability")

# ── Dependências opcionais (degradam para no-op) ──────────────────────────────

try:
    from prometheus_client import (  # type: ignore[import-not-found]
        CONTENT_TYPE_LATEST,
        CollectorRegistry,
        Counter,
        Histogram,
        generate_latest,
    )

    _PROM_OK = True
except Exception:  # pragma: no cover - ambiente sem prometheus-client
    _PROM_OK = False
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"

try:
    import sentry_sdk  # type: ignore[import-not-found]

    _SENTRY_SDK_OK = True
except Exception:  # pragma: no cover - ambiente sem sentry-sdk
    _SENTRY_SDK_OK = False


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ 1. MÉTRICAS PROMETHEUS                                                     ║
# ╚══════════════════════════════════════════════════════════════════════════╝

# Buckets de latência (segundos) afinados para um BFF interno (p50 baixo, mas
# rotas de RAG/IA podem demorar segundos).
_LAT_BUCKETS = (
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
)

# Registry próprio (não polui o default global; facilita testes).
_registry: Any = None
_http_requests_total: Any = None
_http_request_duration: Any = None
_http_requests_in_progress: Any = None
_task_runs_total: Any = None
_task_duration: Any = None
_anthropic_tokens_total: Any = None


def _ensure_metrics() -> bool:
    """Cria os coletores uma única vez. Retorna False se prometheus faltar."""
    global _registry, _http_requests_total, _http_request_duration
    global _http_requests_in_progress, _task_runs_total, _task_duration
    global _anthropic_tokens_total
    if not _PROM_OK:
        return False
    if _registry is not None:
        return True

    _registry = CollectorRegistry()
    _http_requests_total = Counter(
        "bff_http_requests_total",
        "Total de requisições HTTP atendidas pelo BFF.",
        labelnames=("method", "path", "status"),
        registry=_registry,
    )
    _http_request_duration = Histogram(
        "bff_http_request_duration_seconds",
        "Duração das requisições HTTP do BFF (segundos).",
        labelnames=("method", "path"),
        buckets=_LAT_BUCKETS,
        registry=_registry,
    )
    _http_requests_in_progress = Counter(
        "bff_http_requests_in_progress_total",
        "Requisições iniciadas (proxy para in-flight; pareie com _total).",
        labelnames=("method", "path"),
        registry=_registry,
    )
    _task_runs_total = Counter(
        "bff_task_runs_total",
        "Execuções de tarefas de fundo instrumentadas pelo BFF.",
        labelnames=("task", "outcome"),
        registry=_registry,
    )
    _task_duration = Histogram(
        "bff_task_duration_seconds",
        "Duração de tarefas de fundo (segundos).",
        labelnames=("task",),
        buckets=_LAT_BUCKETS,
        registry=_registry,
    )
    _anthropic_tokens_total = Counter(
        "anthropic_tokens_total",
        "Tokens Anthropic consumidos pelo BFF (input/output/cache).",
        labelnames=("rota", "modelo", "tipo"),
        registry=_registry,
    )
    return True


# Limite de cardinalidade: normaliza paths com ids para não explodir labels.
_ID_SEGMENT = re.compile(
    r"/(?:"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"  # uuid
    r"|\d+"  # ids numéricos
    r")"
)


def _normalize_path(path: str) -> str:
    """Substitui segmentos variáveis (uuid/inteiros) por ``/:id``.

    Sem isso, ``/bff/licitacoes/123`` e ``/bff/licitacoes/456`` virariam labels
    distintos, explodindo a cardinalidade do Prometheus. Reduz para
    ``/bff/licitacoes/:id``.
    """
    return _ID_SEGMENT.sub("/:id", path)


def record_http_request(
    *, method: str, path: str, status: int, duration_s: float
) -> None:
    """Registra uma requisição HTTP nos coletores. No-op sem prometheus-client.

    Idempotente e barata; pode ser chamada pelo middleware de métricas OU,
    alternativamente, do middleware de Request-ID já existente (ver WIRING §4).
    """
    if not _ensure_metrics():
        return
    rota = _normalize_path(path)
    try:
        _http_requests_total.labels(method=method, path=rota, status=str(status)).inc()
        _http_request_duration.labels(method=method, path=rota).observe(duration_s)
    except Exception as exc:  # noqa: BLE001 - métricas nunca quebram o request
        log.warning("observability.metric_falhou", extra={"erro": str(exc)})


def record_anthropic_usage(
    *,
    rota: str,
    modelo: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> None:
    """G3: contador Prometheus de tokens Anthropic por rota/modelo/tipo."""
    if not _ensure_metrics():
        return
    try:
        if input_tokens:
            _anthropic_tokens_total.labels(rota=rota, modelo=modelo, tipo="input").inc(input_tokens)
        if output_tokens:
            _anthropic_tokens_total.labels(rota=rota, modelo=modelo, tipo="output").inc(output_tokens)
        if cache_read_tokens:
            _anthropic_tokens_total.labels(rota=rota, modelo=modelo, tipo="cache_read").inc(cache_read_tokens)
        if cache_write_tokens:
            _anthropic_tokens_total.labels(rota=rota, modelo=modelo, tipo="cache_write").inc(cache_write_tokens)
    except Exception as exc:  # noqa: BLE001
        log.warning("observability.anthropic_metric_falhou", extra={"erro": str(exc)})


def record_task(*, task: str, outcome: str, duration_s: float) -> None:
    """Registra a execução de uma tarefa de fundo. No-op sem prometheus-client.

    ``outcome`` ∈ {"ok", "erro"}. Útil para o BFF disparar/medir trabalho
    síncrono pesado (ex.: re-embed sob demanda) — o worker Celery tem suas
    próprias métricas em ``worker/``.
    """
    if not _ensure_metrics():
        return
    try:
        _task_runs_total.labels(task=task, outcome=outcome).inc()
        _task_duration.labels(task=task).observe(duration_s)
    except Exception as exc:  # noqa: BLE001
        log.warning("observability.task_metric_falhou", extra={"erro": str(exc)})


def render_metrics() -> tuple[bytes, str]:
    """Renderiza a exposição Prometheus (corpo, content-type).

    Retorna corpo vazio se ``prometheus-client`` não estiver instalado — o
    endpoint segue respondendo ``200`` para não quebrar o scrape.
    """
    if not _ensure_metrics():
        return b"", CONTENT_TYPE_LATEST
    return generate_latest(_registry), CONTENT_TYPE_LATEST


def instrument_app(app: Any) -> None:
    """Registra um middleware HTTP que mede latência e conta requisições.

    Convive com o middleware de Request-ID (ambos ``@app.middleware('http')``).
    Se ``settings.metrics_enabled`` for falso, não registra nada.
    """
    if not getattr(settings, "metrics_enabled", True):
        log.info("observability.metrics_desabilitado")
        return

    @app.middleware("http")
    async def _metrics_middleware(request: Any, call_next: Any):  # noqa: ANN001
        inicio = time.perf_counter()
        if _ensure_metrics():
            try:
                _http_requests_in_progress.labels(
                    method=request.method, path=_normalize_path(request.url.path)
                ).inc()
            except Exception:  # noqa: BLE001
                pass
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            record_http_request(
                method=request.method,
                path=request.url.path,
                status=status_code,
                duration_s=time.perf_counter() - inicio,
            )


def mount_metrics(app: Any) -> None:
    """Publica ``GET /metrics`` (Prometheus). Protegido por ``metrics_enabled``.

    Mantido FORA do prefixo ``/bff`` e NÃO deve ser exposto pelo NGINX externo
    (scrape só pela rede interna ``backend``). Ver WIRING §4.
    """
    if not getattr(settings, "metrics_enabled", True):
        return

    # Import tardio para não exigir FastAPI no momento do import do módulo.
    from fastapi import Response

    @app.get("/metrics", include_in_schema=False, tags=["infra"])
    async def metrics() -> Response:  # noqa: D401 - endpoint
        corpo, content_type = render_metrics()
        return Response(content=corpo, media_type=content_type)


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ 2. SENTRY / GLITCHTIP (opcional) + REDAÇÃO DE PII                          ║
# ╚══════════════════════════════════════════════════════════════════════════╝

_sentry_ready = False

# Chaves cujo VALOR deve ser totalmente mascarado (case-insensitive, match
# parcial por substring). Espelha o que o logger da produção evita vazar.
_PII_KEYS = (
    "authorization", "cookie", "set-cookie", "token", "jwt", "jti",
    "password", "senha", "secret", "api_key", "apikey", "api-key",
    "auth_secret", "nextauth_secret", "x-auth", "session", "credential",
    "access_key", "secret_key", "anthropic_api_key", "voyage_api_key",
    "openai_api_key", "vapid_private", "cron_secret",
    "email", "e-mail", "cpf", "cnpj", "telefone", "phone",
)

_REDACTED = "[REDIGIDO]"

# Padrões de PII em texto livre (mensagens, querystrings, valores soltos).
_RE_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+", re.IGNORECASE)
# CPF: 000.000.000-00 ou 11 dígitos; CNPJ: 00.000.000/0000-00 ou 14 dígitos.
_RE_CPF = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")
_RE_CNPJ = re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b")
# Bearer <token> e JWTs (três segmentos base64url separados por ponto).
_RE_BEARER = re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE)
_RE_JWT = re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b")


def _scrub_text(texto: str) -> str:
    """Redige PID/segredos em uma string (e-mail, CPF/CNPJ, Bearer, JWT)."""
    texto = _RE_BEARER.sub("Bearer " + _REDACTED, texto)
    texto = _RE_JWT.sub(_REDACTED, texto)
    texto = _RE_EMAIL.sub(_REDACTED, texto)
    texto = _RE_CNPJ.sub(_REDACTED, texto)
    texto = _RE_CPF.sub(_REDACTED, texto)
    return texto


def _key_is_sensitive(chave: str) -> bool:
    """True se o NOME da chave indicar conteúdo sensível."""
    baixa = chave.lower()
    return any(p in baixa for p in _PII_KEYS)


def _scrub(obj: Any, _profundidade: int = 0) -> Any:
    """Redige PII recursivamente em dicts/listas/strings do evento Sentry.

    - Valores de chaves sensíveis (Authorization, cookie, email, cpf...) viram
      ``[REDIGIDO]`` independente do conteúdo.
    - Strings têm e-mails/CPF/CNPJ/Bearer/JWT mascarados por regex.
    - Limita a profundidade para não percorrer estruturas patológicas.
    """
    if _profundidade > 8:
        return _REDACTED
    if isinstance(obj, dict):
        saida: dict[Any, Any] = {}
        for k, v in obj.items():
            if isinstance(k, str) and _key_is_sensitive(k):
                saida[k] = _REDACTED
            else:
                saida[k] = _scrub(v, _profundidade + 1)
        return saida
    if isinstance(obj, (list, tuple)):
        return [_scrub(v, _profundidade + 1) for v in obj]
    if isinstance(obj, str):
        return _scrub_text(obj)
    return obj


def _before_send(event: dict, _hint: dict) -> dict | None:
    """Hook ``before_send`` do Sentry: redige PII antes de transmitir.

    Atua nos campos mais propensos a vazar PII: ``request`` (headers, cookies,
    query_string, data), ``user``, ``extra``, ``contexts``, ``breadcrumbs`` e o
    ``message``. Nunca lança (qualquer falha aqui não pode derrubar o envio nem
    a aplicação). Retornar ``None`` descartaria o evento; retornamos o evento
    redigido.
    """
    try:
        # Remove o IP do usuário e mascara identificadores.
        if isinstance(event.get("user"), dict):
            event["user"] = _scrub(event["user"])
            event["user"].pop("ip_address", None)

        for campo in ("request", "extra", "contexts", "tags"):
            if campo in event and event[campo] is not None:
                event[campo] = _scrub(event[campo])

        # Cabeçalhos sensíveis explicitamente (defesa extra além do _scrub).
        req = event.get("request")
        if isinstance(req, dict):
            headers = req.get("headers")
            if isinstance(headers, dict):
                for h in list(headers.keys()):
                    if _key_is_sensitive(h):
                        headers[h] = _REDACTED
            req.pop("cookies", None)  # cookies = sessão; nunca enviar

        if isinstance(event.get("message"), str):
            event["message"] = _scrub_text(event["message"])

        # Breadcrumbs podem carregar mensagens/dados com PII.
        bc = event.get("breadcrumbs")
        if isinstance(bc, dict) and isinstance(bc.get("values"), list):
            bc["values"] = [_scrub(v) for v in bc["values"]]
        elif isinstance(bc, list):
            event["breadcrumbs"] = [_scrub(v) for v in bc]

        # Exceções: a mensagem do valor pode conter PII (ex.: "user x@y nao...").
        exc = event.get("exception")
        if isinstance(exc, dict) and isinstance(exc.get("values"), list):
            for item in exc["values"]:
                if isinstance(item, dict) and isinstance(item.get("value"), str):
                    item["value"] = _scrub_text(item["value"])
    except Exception as e:  # noqa: BLE001 - redação nunca quebra o envio
        log.warning("observability.before_send_falhou", extra={"erro": str(e)})
    return event


def init_sentry() -> bool:
    """Inicializa o Sentry/GlitchTip se houver DSN e SDK. No-op caso contrário.

    Espelha o comportamento "ligado só com DSN + pacote" do
    ``src/lib/observability/sentry.ts`` da produção. On-prem o DSN aponta para um
    GlitchTip self-hosted. Retorna True se ligou.
    """
    global _sentry_ready
    if _sentry_ready:
        return True

    dsn = getattr(settings, "sentry_dsn", "") or ""
    if not dsn:
        log.info("observability.sentry_desligado", extra={"motivo": "sem SENTRY_DSN"})
        return False
    if not _SENTRY_SDK_OK:
        log.warning(
            "observability.sentry_indisponivel",
            extra={"motivo": "sentry-sdk não instalado"},
        )
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=getattr(settings, "sentry_environment", "onprem"),
            traces_sample_rate=float(
                getattr(settings, "sentry_traces_sample_rate", 0.0)
            ),
            # Não capturar PII automaticamente; nossa redação é a última linha.
            send_default_pii=False,
            before_send=_before_send,
            # Opcional: marca a release/serviço para filtrar no GlitchTip.
            release="petro-radar-bff",
        )
        _sentry_ready = True
        log.info("observability.sentry_ligado")
        return True
    except Exception as exc:  # noqa: BLE001 - falha de init nunca derruba o app
        log.error("observability.sentry_init_falhou", extra={"erro": str(exc)})
        return False


def capture_exception(err: BaseException, **ctx: Any) -> None:
    """Envia uma exceção ao Sentry se ligado; no-op caso contrário.

    Espelha o ``captureException`` do TS — chamável sem ``if`` guards. O
    contexto passado é REDIGIDO antes de anexar (PII safety).
    """
    if not _sentry_ready or not _SENTRY_SDK_OK:
        return
    try:
        if ctx:
            with sentry_sdk.push_scope() as scope:  # type: ignore[attr-defined]
                scope.set_context("petro-radar", _scrub(ctx))
                sentry_sdk.capture_exception(err)
        else:
            sentry_sdk.capture_exception(err)
    except Exception as exc:  # noqa: BLE001 - proteção dupla
        log.warning("observability.capture_falhou", extra={"erro": str(exc)})


__all__ = [
    # métricas
    "instrument_app",
    "mount_metrics",
    "render_metrics",
    "record_http_request",
    "record_anthropic_usage",
    "record_task",
    # sentry
    "init_sentry",
    "capture_exception",
]
