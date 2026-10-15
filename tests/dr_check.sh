#!/usr/bin/env bash
# =============================================================================
# dr_check.sh — WP12 G12: DR dry-run AUTOMATIZADO (backup -> restore -> validação)
# =============================================================================
# Roda no HOST, na raiz do repo (precisa de docker + .env.onprem + db no ar).
# Prova o ciclo completo de disaster recovery SEM tocar na stack de produção:
#   1. pg_dump lógico do `db` do compose (--no-owner --no-acl, igual ao make backup-db);
#   2. sobe um Postgres EFÊMERO (pgvector/pgvector:pg16 — mesma imagem do compose);
#   3. cria o database de teste + extensões vector/pgcrypto;
#   4. restaura o dump via gunzip|psql e conta tabelas + linhas de `users`;
#   5. grava tests/_artifacts/backup_check.json no CONTRATO CANÔNICO do gate G12:
#        {"ok": bool, "restored": bool, "tabelas": int, "dump": str, "detalhe": str}
#      ok=true SOMENTE se o restore terminou sem erro fatal E tabelas >= 50
#      (o schema real tem 52 — menos que isso é dump truncado/errado).
#   6. SEMPRE remove o container efêmero e o dump temporário (trap), sucesso ou não.
#
# Uso:  ./tests/dr_check.sh            # na raiz do repo
#       KEEP_DUMP=1 ./tests/dr_check.sh  # preserva o dump em backups/ p/ auditoria
# Exit: 0 = DR validado; 1 = falha (detalhe no backup_check.json e no stdout).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

# ── .env.onprem (POSTGRES_USER/POSTGRES_DB) ──────────────────────────────────
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env.onprem}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${ENV_FILE}" || true)
  set +a
fi
POSTGRES_USER="${POSTGRES_USER:-petro}"
POSTGRES_DB="${POSTGRES_DB:-petro_radar}"

# compose() em função (não string): o caminho do repo pode ter ESPAÇOS e a
# expansão não-quotada de uma var COMPOSE com --env-file quebraria em word-split.
# Override opcional: COMPOSE="docker-compose" ./tests/dr_check.sh
compose() {
  if [[ -n "${COMPOSE:-}" ]]; then
    ${COMPOSE} "$@"
  else
    docker compose --env-file "${ENV_FILE}" "$@"
  fi
}
ART_DIR="${ART_DIR:-${SCRIPT_DIR}/_artifacts}"
mkdir -p "${ART_DIR}" "${REPO_DIR}/backups"

TS="$(date +%Y%m%d_%H%M%S)"
DUMP="backups/dr_check_${TS}.sql.gz"
DR_CONTAINER="pr-dr-check"
DR_DB="dr_check"
MIN_TABELAS=50   # schema real: 52 tabelas public

OK=false; RESTORED=false; TABELAS=0; DETALHE=""

# ── Artefato + limpeza SEMPRE (sucesso ou falha) ─────────────────────────────
write_json() {
  printf '{\n  "ok": %s,\n  "restored": %s,\n  "tabelas": %d,\n  "dump": "%s",\n  "detalhe": "%s"\n}\n' \
    "${OK}" "${RESTORED}" "${TABELAS}" "${DUMP}" "${DETALHE//\"/\\\"}" \
    > "${ART_DIR}/backup_check.json"
}

cleanup() {
  write_json
  docker rm -f "${DR_CONTAINER}" >/dev/null 2>&1 || true
  if [[ "${KEEP_DUMP:-0}" != "1" ]]; then
    rm -f "${REPO_DIR}/${DUMP}"
  fi
  echo ">> [dr] backup_check.json gravado em ${ART_DIR}/backup_check.json"
}
trap cleanup EXIT

fail() {
  DETALHE="$1"
  echo ">> [dr] FAIL: ${DETALHE}" >&2
  exit 1
}

# ── 1. Dump lógico do db do compose ──────────────────────────────────────────
echo ">> [dr] 1/5 pg_dump ${POSTGRES_DB} (compose db) -> ${DUMP}"
if ! compose exec -T db pg_dump --no-owner --no-acl -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
     | gzip > "${DUMP}"; then
  fail "pg_dump falhou (stack no ar? .env.onprem correto?)"
fi
[[ -s "${DUMP}" ]] || fail "dump vazio em ${DUMP}"
echo ">> [dr]     dump: $(du -h "${DUMP}" | cut -f1)"

# ── 2. Postgres efêmero (mesma imagem pgvector do compose) ───────────────────
echo ">> [dr] 2/5 subindo container efêmero ${DR_CONTAINER} (pgvector/pgvector:pg16)"
docker rm -f "${DR_CONTAINER}" >/dev/null 2>&1 || true
if ! docker run --rm -d --name "${DR_CONTAINER}" -e POSTGRES_PASSWORD=drcheck \
     pgvector/pgvector:pg16 >/dev/null; then
  fail "não foi possível subir o container efêmero (imagem pgvector/pgvector:pg16 local?)"
fi

# pg_isready em loop (timeout ~60s) — o initdb da 1ª subida leva alguns segundos.
echo ">> [dr]     aguardando pg_isready..."
ready=false
for _ in $(seq 1 60); do
  if docker exec "${DR_CONTAINER}" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
[[ "${ready}" == "true" ]] || fail "Postgres efêmero não ficou ready em 60s"
# initdb reinicia o servidor uma vez; respiro extra evita 'connection refused' raro.
sleep 2

# ── 3. Database de teste + extensões ─────────────────────────────────────────
echo ">> [dr] 3/5 criando database ${DR_DB} + extensões vector/pgcrypto"
docker exec "${DR_CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${DR_DB}" >/dev/null \
  || fail "CREATE DATABASE ${DR_DB} falhou"
docker exec "${DR_CONTAINER}" psql -U postgres -d "${DR_DB}" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null \
  || fail "CREATE EXTENSION vector/pgcrypto falhou no efêmero"

# ── 4. Restore (gunzip | psql) ───────────────────────────────────────────────
echo ">> [dr] 4/5 restaurando dump no ${DR_DB}..."
RESTORE_ERR="$(mktemp "${TMPDIR:-/tmp}/dr_restore.XXXXXX")"
if gunzip -c "${DUMP}" | docker exec -i "${DR_CONTAINER}" psql -U postgres -d "${DR_DB}" \
     -q -v ON_ERROR_STOP=0 >/dev/null 2>"${RESTORE_ERR}"; then
  RESTORED=true
else
  RESTORED=false
fi
N_ERROS="$(grep -c '^ERROR' "${RESTORE_ERR}" 2>/dev/null || true)"; N_ERROS="${N_ERROS:-0}"
rm -f "${RESTORE_ERR}"
[[ "${RESTORED}" == "true" ]] || fail "psql do restore terminou com erro fatal (${N_ERROS} ERROR no log)"

# ── 5. Validação: nº de tabelas + linhas de users ────────────────────────────
echo ">> [dr] 5/5 validando estado restaurado"
TABELAS="$(docker exec "${DR_CONTAINER}" psql -U postgres -d "${DR_DB}" -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" \
  2>/dev/null | tr -d '[:space:]')"
TABELAS="${TABELAS:-0}"
USERS="$(docker exec "${DR_CONTAINER}" psql -U postgres -d "${DR_DB}" -tA -c \
  "SELECT count(*) FROM users" 2>/dev/null | tr -d '[:space:]')"
USERS="${USERS:-n/d}"

if [[ "${TABELAS}" -ge "${MIN_TABELAS}" ]]; then
  OK=true
  DETALHE="restore OK: ${TABELAS} tabelas (>=${MIN_TABELAS}), users=${USERS} linhas, ${N_ERROS} erro(s) não-fatais no psql"
  echo ">> [dr] PASS: ${DETALHE}"
  exit 0
else
  OK=false
  DETALHE="restore incompleto: ${TABELAS} tabelas (<${MIN_TABELAS}); users=${USERS}; ${N_ERROS} erro(s) no psql"
  echo ">> [dr] FAIL: ${DETALHE}" >&2
  exit 1
fi
