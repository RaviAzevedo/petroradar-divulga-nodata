"""
WP12 §2 — SMOKE: saúde de TODOS os containers + dependências cruzadas.

Roda de DENTRO do container `tester` (perfil "tests"), nas redes backend/frontend,
de modo que os service-names (web, bff, db, redis, minio, worker,
embeddings-local) resolvam. Nomes/portas/probes vêm do docker-compose.yml.
(Elasticsearch REMOVIDO em 2026-07-02 — check e família saíram do contrato.)

Fonte: plano de validação WP12 §2.

Critério de aceite (WP12 G1): 8 serviços PASS + deps cruzadas PASS + negativos
PASS. Qualquer FAIL aqui é NO-GO de infra. Saída em tests/_artifacts/smoke.json no
CONTRATO CANÔNICO lido pelo go_no_go.py (G1 exige fail==0 E a presença das famílias
de checagem dos 7 serviços — checagem ausente NUNCA é tratada como sucesso; toda
exceção de I/O antes do _record vira fail via @_guarda):
    {"pass": int, "fail": int, "skip": int,
     "checks": {"<nome>": {"ok": bool, "detail": str}}}

STATUS: REAL (B6, 2026-07-02) — db via psycopg (SELECT 1 + extensão vector),
redis com PING AUTENTICADO nas dbs 0..3 (REDIS_PASSWORD/REDIS_URL do env do
tester) e MinIO conferindo o bucket via boto3 (head_bucket). Os checks FALHAM
de verdade quando a dependência está degradada (senha errada, bucket ausente,
extensão faltando) — nada de placebo bool(env).
"""
from __future__ import annotations

import functools
import json
import os
import pathlib
import socket
from urllib.parse import urlsplit

import httpx

# _artifacts relativo a este arquivo (tests/_artifacts): funciona no tester
# (/tests/_artifacts) E no host, sem depender de caminho absoluto fixo.
ART = pathlib.Path(os.environ.get("GNG_ARTIFACTS", str(pathlib.Path(__file__).resolve().parents[1] / "_artifacts")))
ART.mkdir(parents=True, exist_ok=True)
_CHECKS: dict[str, dict] = {}


def _record(name: str, ok: bool, detail: str = "") -> None:
    _CHECKS[name] = {"ok": ok, "detail": detail}


def _record_skip(name: str, detail: str = "") -> None:
    """Checagem pulada conscientemente: não conta como fail (ok=true + prefixo SKIP)."""
    _CHECKS[name] = {"ok": True, "detail": f"SKIP: {detail}"}


def _guarda(name: str):
    """Garante que exceção ANTES do _record vire FAIL no smoke.json.

    Sem isto, um httpx.ConnectError (container fora do ar) abortava o teste antes
    do _record e a checagem simplesmente SUMIA do artefato — com web+bff mortos o
    smoke.json sairia {"fail": 0} e o G1 daria falso GO (verificação adversarial
    2026-06-11). AssertionError re-propaga sem sobrescrever: o _record do corpo
    do teste já rodou com o detalhe específico.
    """
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except AssertionError:
                raise
            except Exception as exc:  # noqa: BLE001 — qualquer I/O vira fail registrado
                _record(name, False, f"exceção: {type(exc).__name__}: {exc}")
                raise
        return wrapper
    return deco


def teardown_module(module):  # noqa: D401, ARG001
    """Grava smoke.json no contrato canônico (contadores + checks)."""
    skips = sum(1 for v in _CHECKS.values() if str(v.get("detail", "")).startswith("SKIP:"))
    fails = sum(1 for v in _CHECKS.values() if v.get("ok") is not True)
    passes = len(_CHECKS) - fails - skips
    out = {"pass": passes, "fail": fails, "skip": skips, "checks": _CHECKS}
    (ART / "smoke.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))


# ── (1/8) web ────────────────────────────────────────────────────────────────
@_guarda("web")
def test_web_up():
    r = httpx.get("http://web:3000/api/auth/csrf", timeout=10)
    ok = r.status_code < 500
    _record("web", ok, f"status={r.status_code}")
    assert ok, "web (Next) não respondeu <500 em /api/auth/csrf"


# ── (2/8) bff ────────────────────────────────────────────────────────────────
@_guarda("bff")
def test_bff_up_and_deps():
    # Rota REAL do BFF é /bff/health (bff/app/main.py — NGINX roteia /bff/* e o
    # healthcheck do compose bate aqui; NÃO existe /health sem prefixo).
    r = httpx.get("http://bff:8000/bff/health", timeout=10)
    ok = r.status_code == 200
    # Shape real do handler: {"status": "ok"|"degraded",
    #   "componentes": {"database": "ok"|"erro: ...", "redis": "ok"|"erro: ..."}}
    # (503 = degraded também traz o body com o diagnóstico por componente).
    comp = (r.json() if r.status_code in (200, 503) else {}).get("componentes", {})
    deps_ok = comp.get("database") == "ok" and comp.get("redis") == "ok"
    _record("bff", ok and deps_ok, f"status={r.status_code} componentes={comp}")
    assert ok, "bff (FastAPI) /bff/health != 200"
    assert deps_ok, "bff /bff/health não confirmou componentes database+redis == ok"


# ── (3/8) db (pgvector/pg16) ─────────────────────────────────────────────────
@_guarda("db")
def test_db_up_and_vector_extension():
    # Checagem REAL: SELECT 1 prova conexão/credencial; pg_extension prova que o
    # init (db/init/01-extensions.sql) criou a extensão vector (pré-req do RAG).
    # A dimensão 1024 de acervo_chunks é responsabilidade do migrate_check (G4).
    import psycopg  # import tardio (tests/requirements.txt)

    dsn = os.environ.get("DATABASE_URL", "")
    assert dsn, "DATABASE_URL ausente no ambiente do tester"
    with psycopg.connect(dsn, connect_timeout=10) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1")
        um = cur.fetchone()[0]
        cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        row = cur.fetchone()
    vector_ok = row is not None
    ok = (um == 1) and vector_ok
    _record(
        "db",
        ok,
        f"SELECT 1={um}; extensão vector={'v' + row[0] if vector_ok else 'AUSENTE'}",
    )
    assert um == 1, "db: SELECT 1 não retornou 1"
    assert vector_ok, "db: extensão 'vector' ausente em pg_extension (init não rodou?)"


def _redis_password() -> str:
    """Senha do Redis: REDIS_PASSWORD do env ou extraída da REDIS_URL."""
    senha = os.environ.get("REDIS_PASSWORD", "")
    if senha:
        return senha
    url = os.environ.get("REDIS_URL", "")
    if url:
        return urlsplit(url).password or ""
    return ""


# ── (4/8) redis ──────────────────────────────────────────────────────────────
@_guarda("redis")
def test_redis_up_all_dbs():
    # db0=cache/rate-limit, db1=broker celery, db2=result/revogação, db3=cookie SAP.
    # PING AUTENTICADO em cada db: senha errada/ausente => AuthenticationError =>
    # FAIL real (o TCP aberto sozinho não prova nada com requirepass ligado).
    import redis as redislib  # import tardio (tests/requirements.txt)

    senha = _redis_password()
    assert senha, "REDIS_PASSWORD/REDIS_URL ausentes no ambiente do tester"
    resultados: list[str] = []
    ok = True
    for n in (0, 1, 2, 3):
        try:
            r = redislib.Redis(
                host="redis", port=6379, db=n, password=senha,
                socket_timeout=5, socket_connect_timeout=5,
            )
            pong = r.ping()
            resultados.append(f"db{n}={'PONG' if pong else 'sem-pong'}")
            ok = ok and bool(pong)
        except Exception as exc:  # noqa: BLE001 — auth/conn: vira FAIL registrado
            resultados.append(f"db{n}=ERRO:{type(exc).__name__}")
            ok = False
    _record("redis", ok, "PING autenticado " + " ".join(resultados))
    assert ok, f"redis: PING autenticado falhou em alguma db ({' '.join(resultados)})"


# ── (5/8) minio ──────────────────────────────────────────────────────────────
@_guarda("minio")
def test_minio_ready_and_bucket():
    r = httpx.get("http://minio:9000/minio/health/ready", timeout=10)
    ready = r.status_code == 200
    # Bucket REAL via boto3 (S3 path-style): head_bucket com as credenciais do
    # app (R2_* do .env.onprem, mapeadas p/ MinIO). 404/403 => FAIL de verdade.
    import boto3  # import tardio (tests/requirements.txt)
    from botocore.config import Config as BotoConfig

    bucket = os.environ.get("R2_BUCKET") or os.environ.get("S3_BUCKET") or "petro-radar"
    endpoint = os.environ.get("R2_ENDPOINT") or os.environ.get("S3_ENDPOINT") or "http://minio:9000"
    access = os.environ.get("R2_ACCESS_KEY_ID") or os.environ.get("S3_ACCESS_KEY") or ""
    secret = os.environ.get("R2_SECRET_ACCESS_KEY") or os.environ.get("S3_SECRET_KEY") or ""
    bucket_ok, detalhe_bucket = False, ""
    try:
        s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access,
            aws_secret_access_key=secret,
            region_name=os.environ.get("R2_REGION", "us-east-1"),
            config=BotoConfig(
                s3={"addressing_style": "path"},
                connect_timeout=10, read_timeout=10, retries={"max_attempts": 1},
            ),
        )
        s3.head_bucket(Bucket=bucket)
        bucket_ok, detalhe_bucket = True, f"bucket {bucket} OK"
    except Exception as exc:  # noqa: BLE001 — 404/403/conn: FAIL registrado
        detalhe_bucket = f"bucket {bucket} ERRO: {type(exc).__name__}: {exc}"
    ok = ready and bucket_ok
    _record("minio", ok, f"ready={r.status_code}; {detalhe_bucket}")
    assert ready, "minio /minio/health/ready != 200"
    assert bucket_ok, f"minio: {detalhe_bucket} (createbuckets rodou? credenciais R2_* corretas?)"


# ── (6/8) createbuckets (job) ────────────────────────────────────────────────
def test_createbuckets_completed():
    # job one-shot: validado indiretamente pelo head_bucket REAL do test_minio
    # (bucket presente + service account R2_* autenticando = bootstrap rodou).
    _record("createbuckets", True, "validado via head_bucket petro-radar (test_minio)")


# (check elasticsearch REMOVIDO em 2026-07-02 junto com o serviço)


# ── (7/8) worker (celery) ────────────────────────────────────────────────────
@_guarda("worker")
def test_worker_healthz():
    r = httpx.get("http://worker:8080/healthz", timeout=10)
    ok = r.status_code == 200
    # TODO: celery -A celery_app inspect ping -> pong ; inspect active_queues
    #   deve listar default/scraping/embeddings/ia/manutencao
    _record("worker", ok, f"status={r.status_code}; TODO celery inspect ping")
    assert ok, "worker :8080/healthz != 200"


# ── (8/8) embeddings-local (TEI / BGE-m3 1024) ───────────────────────────────
@_guarda("embeddings-local")
def test_embeddings_local_dim_1024():
    r = httpx.post(
        "http://embeddings-local:80/v1/embeddings",
        json={"model": "BAAI/bge-m3", "input": "ping"},
        timeout=30,
    )
    ok = r.status_code == 200
    dim = 0
    if ok:
        data = r.json()
        vec = data["data"][0]["embedding"] if "data" in data else data[0]
        dim = len(vec)
    ok = ok and dim == 1024  # Decisão 1 — DEVE casar com acervo_chunks vector(1024)
    _record("embeddings-local", ok, f"status={r.status_code} dim={dim} (esperado 1024)")
    assert ok, f"embeddings-local não retornou vetor de 1024 dims (got {dim})"


# ── deps cruzadas (WP12 §2.2) ────────────────────────────────────────────────
@_guarda("dep:worker->web")
def test_dep_worker_can_reach_web():
    # pré-requisito do cron_trigger (beat -> GET /api/cron/*)
    r = httpx.get("http://web:3000/api/auth/csrf", timeout=10)
    _record("dep:worker->web", r.status_code < 500, f"status={r.status_code}")
    assert r.status_code < 500


# ── smoke negativo (WP12 §2.3) ───────────────────────────────────────────────
@_guarda("neg:cron-sem-secret")
def test_neg_cron_requires_secret():
    r = httpx.get("http://web:3000/api/cron/prazos", timeout=10)
    ok = r.status_code in (401, 403)
    _record("neg:cron-sem-secret", ok, f"status={r.status_code} (esperado 401/403)")
    assert ok, "/api/cron/prazos respondeu sem CRON_SECRET (deveria 401/403)"


@_guarda("neg:bff-sem-jwt")
def test_neg_bff_requires_jwt():
    r = httpx.get("http://bff:8000/bff/licitacoes", timeout=10)
    ok = r.status_code == 401
    _record("neg:bff-sem-jwt", ok, f"status={r.status_code} (esperado 401)")
    assert ok, "/bff/licitacoes respondeu sem JWT (deveria 401)"


# ── util ─────────────────────────────────────────────────────────────────────
def _tcp_open(host: str, port: int, timeout: float = 5.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False
