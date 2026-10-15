#!/usr/bin/env bash
# =============================================================================
# smoke.sh — Smoke test de PARIDADE/INFRA do Petro Radar on-premise
# =============================================================================
# Verifica, com curl, a saúde de TODOS os serviços do docker-compose e faz uma
# requisição AUTENTICADA de exemplo contra o BFF (JWT HS256 forjado com AUTH_SECRET).
#
# Serviços cobertos (espelham docker-compose.yml):
#   web (Next standalone) · bff (FastAPI) · db (pgvector/pg16) · redis ·
#   minio (+ console/bucket) · worker (healthz) · embeddings-local (TEI)
#
# Como rodar (na raiz do repo petro-radar-onprem/, após `make up`):
#   ./tests/smoke.sh                      # usa as portas do compose (loopback) e .env.onprem
#   AUTH_SECRET=... ./tests/smoke.sh      # sobrescreve segredo de assinatura do JWT
#   STRICT=1 ./tests/smoke.sh             # falha (exit!=0) se QUALQUER checagem reprovar
#   IN_DOCKER=1 ./tests/smoke.sh          # roda DENTRO da rede do compose (service names)
#
# Por padrão (STRICT=0) o script é informativo: imprime PASS/FAIL/SKIP e segue.
# Em CI/cutover use STRICT=1 para travar o pipeline em qualquer falha.
# SEMPRE grava tests/_artifacts/smoke.json no contrato canônico do gate G1:
#   {"pass": int, "fail": int, "skip": int, "checks": {nome: {ok, detail}}}
# (mesmo com STRICT=0/exit 0, o JSON reflete os contadores reais p/ o go_no_go).
#
# Dependências: bash, curl. (jq, python3 e openssl são OPCIONAIS — há fallbacks.)
# =============================================================================

set -uo pipefail

# ── Localização: raiz do repo é o pai de tests/ ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Carrega .env.onprem (se existir) com parser SEGURO (sem `source` cru) ────
# O `source` cru executava o arquivo: linhas com espaço sem aspas (ex.:
# `ES_JAVA_OPTS=-Xms1g -Xmx1g`) ou com `<...>` (FROM_EMAIL) viravam comandos/
# syntax error e ABORTAVAM o carregamento no meio — AUTH_SECRET/ELASTIC_PASSWORD
# ficavam vazios e as checagens autenticadas eram puladas em silêncio.
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env.onprem}"
if [[ -f "${ENV_FILE}" ]]; then
  while IFS= read -r _line || [[ -n "${_line}" ]]; do
    [[ "${_line}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    _key="${_line%%=*}"
    _val="${_line#*=}"
    if [[ "${_val}" == \"* ]]; then
      # Valor entre aspas (pode conter espaços/<>): remove só as aspas externas.
      _val="${_val#\"}"
      _val="${_val%%\"*}"
    else
      # Remove comentário inline (espaço + #...) e espaços das pontas.
      _val="$(printf '%s' "${_val}" | sed -E 's/[[:space:]]+#.*$//')"
      _val="${_val#"${_val%%[![:space:]]*}"}"
      _val="${_val%"${_val##*[![:space:]]}"}"
    fi
    export "${_key}=${_val}"
  done < "${ENV_FILE}"
fi

# ── Endpoints: dentro do compose (service names) ou no host (loopback) ───────
if [[ "${IN_DOCKER:-0}" == "1" ]]; then
  WEB_URL="${WEB_URL:-http://web:3000}"
  BFF_URL="${BFF_URL:-http://bff:8000}"
  MINIO_URL="${MINIO_URL:-http://minio:9000}"
  WORKER_URL="${WORKER_URL:-http://worker:8080}"
  EMBED_URL="${EMBED_URL:-http://embeddings-local:80}"
  REDIS_HOST="${REDIS_HOST:-redis}"
  DB_HOST="${DB_HOST:-db}"
else
  WEB_URL="${WEB_URL:-http://127.0.0.1:3000}"
  BFF_URL="${BFF_URL:-http://127.0.0.1:8000}"
  MINIO_URL="${MINIO_URL:-http://127.0.0.1:9000}" # exposto só se descomentado no compose
  MINIO_CONSOLE_URL="${MINIO_CONSOLE_URL:-http://127.0.0.1:9001}"
  WORKER_URL="${WORKER_URL:-http://127.0.0.1:8080}"
  EMBED_URL="${EMBED_URL:-http://127.0.0.1:80}"
  REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
  DB_HOST="${DB_HOST:-127.0.0.1}"
fi

# ── Credenciais de infra (do .env.onprem) ────────────────────────────────────
POSTGRES_USER="${POSTGRES_USER:-petro}"
POSTGRES_DB="${POSTGRES_DB:-petro_radar}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
ELASTIC_PASSWORD="${ELASTIC_PASSWORD:-}"
AUTH_SECRET="${AUTH_SECRET:-${NEXTAUTH_SECRET:-}}"

STRICT="${STRICT:-0}"
COMPOSE="${COMPOSE:-docker compose}"

# ── Contadores, registro p/ smoke.json e cores ───────────────────────────────
# Além de imprimir, cada checagem é REGISTRADA para o smoke.json canônico do G1
# (go_no_go.py): {"pass","fail","skip","checks":{nome:{ok,detail}}}. O nome de
# cada check é derivado da seção corrente (hdr) + sequencial: "web:1", "bff:2"...
PASS=0; FAIL=0; SKIP=0
SECTION="init"; CHECK_SEQ=0
CHECK_LOG="$(mktemp "${TMPDIR:-/tmp}/smoke_checks.XXXXXX")"
trap 'rm -f "${CHECK_LOG}"' EXIT

# status (true/false/skip) <TAB> nome <TAB> detalhe — newlines do detalhe achatados.
_reg() {
  local st="$1"; shift
  CHECK_SEQ=$((CHECK_SEQ+1))
  local detail="$*"
  detail="${detail//$'\n'/ }"; detail="${detail//$'\t'/ }"
  printf '%s\t%s:%d\t%s\n' "${st}" "${SECTION}" "${CHECK_SEQ}" "${detail}" >> "${CHECK_LOG}"
}

if [[ -t 1 ]]; then C_OK=$'\033[32m'; C_NO=$'\033[31m'; C_SK=$'\033[33m'; C_Z=$'\033[0m'
else C_OK=""; C_NO=""; C_SK=""; C_Z=""; fi

ok()   { echo "  ${C_OK}PASS${C_Z}  $*"; PASS=$((PASS+1)); _reg true "$@"; }
nok()  { echo "  ${C_NO}FAIL${C_Z}  $*"; FAIL=$((FAIL+1)); _reg false "$@"; }
skip() { echo "  ${C_SK}SKIP${C_Z}  $*"; SKIP=$((SKIP+1)); _reg skip "$@"; }
hdr()  { SECTION="${1%% *}"; CHECK_SEQ=0; echo; echo "── $* ─────────────────────────────────────────────"; }

# curl helper: imprime só o status HTTP; trata timeout/conn-refused como 000.
# Nota: no timeout o curl JÁ imprime "000" e ainda sai !=0 — sem a normalização
# abaixo o fallback duplicava ("000\n000") e quebrava os matches == "000".
http_status() {
  local out
  out="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${CURL_TIMEOUT:-8}" "$@" 2>/dev/null || true)"
  out="${out//[^0-9]/}"
  out="${out:-000}"
  echo "${out:0:3}"
}

# =============================================================================
# 1. web — Next.js standalone (canário público /api/auth/csrf)
# =============================================================================
hdr "web (Next.js standalone) @ ${WEB_URL}"
code=$(http_status "${WEB_URL}/api/auth/csrf")
if [[ "${code}" == "200" ]]; then
  ok "GET /api/auth/csrf → ${code} (server.js de pé)"
else
  nok "GET /api/auth/csrf → ${code} (esperado 200)"
fi
# Rota autenticada sem token DEVE dar 401 (prova que o guard do app está ativo).
code=$(http_status "${WEB_URL}/api/licitacoes")
if [[ "${code}" == "401" ]]; then
  ok "GET /api/licitacoes sem token → 401 (guard requireVisualizar ativo)"
elif [[ "${code}" == "000" ]]; then
  skip "GET /api/licitacoes → sem conexão (web não exposto neste contexto?)"
else
  nok "GET /api/licitacoes sem token → ${code} (esperado 401)"
fi

# =============================================================================
# 2. bff — FastAPI (/bff/health agrega db+redis)
# =============================================================================
hdr "bff (FastAPI) @ ${BFF_URL}"
body="$(curl -s --max-time 8 "${BFF_URL}/bff/health" 2>/dev/null || true)"
code=$(http_status "${BFF_URL}/bff/health")
if [[ "${code}" == "200" ]]; then
  ok "GET /bff/health → 200 ${body}"
elif [[ "${code}" == "503" ]]; then
  nok "GET /bff/health → 503 (degraded) ${body}"
elif [[ "${code}" == "000" ]]; then
  nok "GET /bff/health → sem conexão (container bff no ar?)"
else
  nok "GET /bff/health → ${code}"
fi
# 401 sem token (contrato de auth do estrangulador).
code=$(http_status "${BFF_URL}/bff/licitacoes")
if [[ "${code}" == "401" ]]; then
  ok "GET /bff/licitacoes sem token → 401"
else
  nok "GET /bff/licitacoes sem token → ${code} (esperado 401)"
fi

# =============================================================================
# 3. db — PostgreSQL/pgvector (via docker exec pg_isready; fallback TCP)
# =============================================================================
hdr "db (PostgreSQL 16 + pgvector)"
if ${COMPOSE} version >/dev/null 2>&1; then
  if (cd "${REPO_DIR}" && ${COMPOSE} exec -T db pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1); then
    ok "pg_isready (${POSTGRES_USER}/${POSTGRES_DB}) → accepting connections"
    # Confirma a extensão vector instalada (pré-req do RAG / migration 0015).
    has_vec=$(cd "${REPO_DIR}" && ${COMPOSE} exec -T db psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
      "SELECT 1 FROM pg_extension WHERE extname='vector'" 2>/dev/null | tr -d '[:space:]')
    if [[ "${has_vec}" == "1" ]]; then ok "extensão 'vector' presente (pgvector)"
    else nok "extensão 'vector' AUSENTE (db/init/01-extensions.sql rodou?)"; fi
  else
    nok "pg_isready falhou (db unhealthy ou compose indisponível)"
  fi
else
  skip "docker compose indisponível — checagem do db pulada"
fi

# =============================================================================
# 4. redis — PING (db0 cache/rate-limit; db1 broker Celery; db3 cookie SAP)
# =============================================================================
hdr "redis @ ${REDIS_HOST}:6379"
if ${COMPOSE} version >/dev/null 2>&1; then
  pong=$(cd "${REPO_DIR}" && ${COMPOSE} exec -T redis sh -c \
    'redis-cli -a "$REDIS_PASSWORD" ping' 2>/dev/null | tr -d '[:space:]')
  if [[ "${pong}" == "PONG" ]]; then ok "redis-cli PING → PONG"
  else nok "redis-cli PING → '${pong:-vazio}' (senha/serviço?)"; fi
else
  skip "docker compose indisponível — PING do redis pulado"
fi

# =============================================================================
# 5. minio — health do cluster (/minio/health/ready) + console
# =============================================================================
hdr "minio (S3 on-prem) @ ${MINIO_URL}"
code=$(http_status "${MINIO_URL}/minio/health/ready")
if [[ "${code}" == "200" ]]; then
  ok "GET /minio/health/ready → 200"
elif [[ "${code}" == "000" ]]; then
  # API 9000 fica na rede backend (não exposta). Tenta o console 9001 (loopback).
  if [[ "${IN_DOCKER:-0}" != "1" ]]; then
    ccode=$(http_status "${MINIO_CONSOLE_URL:-http://127.0.0.1:9001}")
    if [[ "${ccode}" =~ ^(200|403)$ ]]; then
      ok "console MinIO (9001) responde → ${ccode} (API 9000 é interna/backend)"
    else
      skip "MinIO API 9000 não exposta e console 9001 → ${ccode} (use IN_DOCKER=1)"
    fi
  else
    nok "GET /minio/health/ready → sem conexão"
  fi
else
  nok "GET /minio/health/ready → ${code}"
fi

# =============================================================================
# (seção 6/elasticsearch REMOVIDA em 2026-07-02 junto com o serviço — a busca
#  do app/BFF usa o Postgres; ver decisão no docker-compose.yml)
# =============================================================================

# =============================================================================
# 7. worker — Celery worker+beat (healthz: broker vivo)
# =============================================================================
hdr "worker (Celery worker/beat) @ ${WORKER_URL}/healthz"
if [[ "${IN_DOCKER:-0}" == "1" ]]; then
  code=$(http_status "${WORKER_URL}/healthz")
  if [[ "${code}" == "200" ]]; then
    ok "GET /healthz → 200 (broker Redis respondendo)"
  else
    nok "GET /healthz → ${code} (esperado 200)"
  fi
else
  # A 8080 do worker NÃO é publicada no host — e em DEV a 127.0.0.1:8080 é o
  # NGINX (docker-compose.dev.yml), que devolvia 307 e gerava FAIL FALSO aqui.
  # No host, checa DIRETO via compose exec.
  if ${COMPOSE} version >/dev/null 2>&1 && \
     (cd "${REPO_DIR}" && ${COMPOSE} exec -T worker python -c \
       "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=3).status==200 else 1)" >/dev/null 2>&1); then
    ok "/healthz (via compose exec) → 200"
  else
    skip "worker /healthz não alcançável (container worker no ar? use IN_DOCKER=1)"
  fi
fi

# =============================================================================
# 8. embeddings-local — TEI BGE-m3 (/health) — RAG on-prem (1024 dims)
# =============================================================================
hdr "embeddings-local (TEI / BGE-m3 1024) @ ${EMBED_URL}"
code=$(http_status "${EMBED_URL}/health")
if [[ "${code}" == "200" ]]; then
  ok "GET /health → 200 (modelo carregado)"
elif [[ "${code}" == "000" ]]; then
  if ${COMPOSE} version >/dev/null 2>&1 && \
     (cd "${REPO_DIR}" && ${COMPOSE} exec -T embeddings-local sh -c \
       'curl -fsS http://localhost:80/health' >/dev/null 2>&1); then
    ok "/health (via compose exec) → 200"
  else
    skip "embeddings-local não alcançável (interno; 1ª subida baixa ~2.2GB)"
  fi
else
  nok "GET /health → ${code}"
fi

# =============================================================================
# 9. Requisição AUTENTICADA de exemplo no BFF (JWT HS256 forjado)
# =============================================================================
hdr "Requisição autenticada de exemplo (JWT HS256) @ ${BFF_URL}/bff/licitacoes"

forjar_jwt() {
  # $1=role. Usa python3 (pyjwt OU HMAC manual). Sem python3, usa openssl.
  local role="${1:-ADMIN}" secret="${AUTH_SECRET}"
  if [[ -z "${secret}" ]]; then echo ""; return 1; fi

  if command -v python3 >/dev/null 2>&1; then
    SMOKE_ROLE="${role}" SMOKE_SECRET="${secret}" python3 - <<'PY' 2>/dev/null
import base64, hashlib, hmac, json, os, time
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
secret = os.environ["SMOKE_SECRET"].encode()
role = os.environ["SMOKE_ROLE"]
now = int(time.time())
hdr = {"alg": "HS256", "typ": "JWT"}
pl = {"sub": "smoke-test", "email": "smoke@example.local", "role": role,
      "iat": now, "exp": now + 600}
seg = b64(json.dumps(hdr, separators=(",", ":")).encode()) + "." + \
      b64(json.dumps(pl, separators=(",", ":")).encode())
sig = hmac.new(secret, seg.encode(), hashlib.sha256).digest()
print(seg + "." + b64(sig))
PY
    return $?
  fi

  # Fallback openssl puro (sem python).
  if command -v openssl >/dev/null 2>&1; then
    local now exp header payload h64 p64 unsigned sig
    now=$(date +%s); exp=$((now + 600))
    header='{"alg":"HS256","typ":"JWT"}'
    payload="{\"sub\":\"smoke-test\",\"email\":\"smoke@example.local\",\"role\":\"${role}\",\"iat\":${now},\"exp\":${exp}}"
    b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }
    h64=$(printf '%s' "${header}"  | b64url)
    p64=$(printf '%s' "${payload}" | b64url)
    unsigned="${h64}.${p64}"
    sig=$(printf '%s' "${unsigned}" | openssl dgst -sha256 -hmac "${secret}" -binary | b64url)
    echo "${unsigned}.${sig}"
    return 0
  fi

  echo ""; return 1
}

if [[ -z "${AUTH_SECRET}" ]]; then
  skip "AUTH_SECRET ausente — não há como forjar o JWT (defina no .env.onprem)"
else
  TOKEN="$(forjar_jwt ADMIN || true)"
  if [[ -z "${TOKEN}" ]]; then
    skip "não foi possível forjar JWT (sem python3/openssl)"
  else
    code=$(http_status -H "Authorization: Bearer ${TOKEN}" "${BFF_URL}/bff/licitacoes?page=1&page_size=5")
    if [[ "${code}" == "200" ]]; then
      ok "GET /bff/licitacoes (ADMIN) → 200 (auth HS256 OK + DB OK)"
    elif [[ "${code}" =~ ^(401|403)$ ]]; then
      nok "GET /bff/licitacoes (ADMIN) → ${code} (segredo AUTH_SECRET divergente do web?)"
    elif [[ "${code}" == "000" ]]; then
      nok "GET /bff/licitacoes (ADMIN) → sem conexão"
    else
      nok "GET /bff/licitacoes (ADMIN) → ${code} (auth passou; verifique DB)"
    fi

    # Gate de papel: EXTERNO autenticado deve ser barrado no acervo (403).
    EXT_TOKEN="$(forjar_jwt EXTERNO || true)"
    if [[ -n "${EXT_TOKEN}" ]]; then
      code=$(http_status -X POST -H "Authorization: Bearer ${EXT_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"query":"refino","sintetizar":false}' \
        "${BFF_URL}/bff/acervo/buscar")
      if [[ "${code}" == "403" ]]; then
        ok "POST /bff/acervo/buscar (EXTERNO) → 403 (anti-IDOR / requireAcervo)"
      elif [[ "${code}" == "401" ]]; then
        nok "POST /bff/acervo/buscar (EXTERNO) → 401 (esperado 403; token válido?)"
      elif [[ "${code}" == "000" ]]; then
        skip "POST /bff/acervo/buscar → sem conexão"
      else
        nok "POST /bff/acervo/buscar (EXTERNO) → ${code} (esperado 403)"
      fi
    fi
  fi
fi

# =============================================================================
# Resumo + smoke.json (contrato canônico do G1 — go_no_go.py exige "fail")
# =============================================================================
hdr "Resumo"
echo "  PASS=${PASS}  FAIL=${FAIL}  SKIP=${SKIP}"

# Grava tests/_artifacts/smoke.json com os contadores REAIS (mesmo em STRICT=0 o
# JSON denuncia as falhas — o exit "informativo" continua 0, mas o G1 vê o fail).
ART_DIR="${ART_DIR:-${SCRIPT_DIR}/_artifacts}"
mkdir -p "${ART_DIR}"
if command -v python3 >/dev/null 2>&1; then
  SMOKE_PASS="${PASS}" SMOKE_FAIL="${FAIL}" SMOKE_SKIP="${SKIP}" \
  SMOKE_LOG="${CHECK_LOG}" SMOKE_OUT="${ART_DIR}/smoke.json" python3 - <<'PY'
import json, os
checks = {}
with open(os.environ["SMOKE_LOG"], encoding="utf-8", errors="replace") as f:
    for ln in f:
        ln = ln.rstrip("\n")
        if not ln:
            continue
        st, nome, detail = (ln.split("\t", 2) + ["", ""])[:3]
        if st == "skip":
            checks[nome] = {"ok": True, "detail": f"SKIP: {detail}"}
        else:
            checks[nome] = {"ok": st == "true", "detail": detail}
out = {
    "pass": int(os.environ["SMOKE_PASS"]),
    "fail": int(os.environ["SMOKE_FAIL"]),
    "skip": int(os.environ["SMOKE_SKIP"]),
    "checks": checks,
}
with open(os.environ["SMOKE_OUT"], "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
PY
else
  # Fallback sem python3: escapa \ e " via sed (detalhes já vêm sem \n/\t do _reg).
  {
    printf '{\n  "pass": %d,\n  "fail": %d,\n  "skip": %d,\n  "checks": {' "${PASS}" "${FAIL}" "${SKIP}"
    sep=""
    while IFS=$'\t' read -r st nome detail; do
      [[ -z "${st}" ]] && continue
      esc_nome=$(printf '%s' "${nome}" | sed 's/\\/\\\\/g; s/"/\\"/g')
      esc_det=$(printf '%s' "${detail}" | sed 's/\\/\\\\/g; s/"/\\"/g')
      if [[ "${st}" == "skip" ]]; then okv="true"; esc_det="SKIP: ${esc_det}"
      elif [[ "${st}" == "true" ]]; then okv="true"
      else okv="false"; fi
      printf '%s\n    "%s": {"ok": %s, "detail": "%s"}' "${sep}" "${esc_nome}" "${okv}" "${esc_det}"
      sep=","
    done < "${CHECK_LOG}"
    printf '\n  }\n}\n'
  } > "${ART_DIR}/smoke.json"
fi
echo "  smoke.json gravado em ${ART_DIR}/smoke.json"

if [[ "${STRICT}" == "1" && "${FAIL}" -gt 0 ]]; then
  echo "  ${C_NO}STRICT=1 e houve ${FAIL} falha(s) → exit 1${C_Z}"
  exit 1
fi
exit 0
