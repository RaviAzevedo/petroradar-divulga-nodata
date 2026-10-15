#!/usr/bin/env bash
# scripts/parity/03_storage_validate.sh (WP02 §11.2)
# Valida PARIDADE banco<->MinIO: toda blob_key referenciada no Postgres (04_db_keys.sql)
# tem o objeto correspondente no bucket MinIO. Saída: "blobs faltando: N".
# Uso (no servidor, stack no ar):  bash scripts/parity/03_storage_validate.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${HERE}/../.." && pwd)"
ENV_FILE="${REPO_DIR}/.env.onprem"
[ -f "${ENV_FILE}" ] || { echo ".env.onprem ausente"; exit 1; }
get_env() { grep -E "^${1}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- ; }
DC=(docker compose --env-file "${ENV_FILE}")
PG_U="$(get_env POSTGRES_USER)"; PG_D="$(get_env POSTGRES_DB)"
BUCKET="$(get_env R2_BUCKET)"; BUCKET="${BUCKET:-petro-radar}"
MINIO_USER="$(get_env MINIO_ROOT_USER)"; MINIO_PASS="$(get_env MINIO_ROOT_PASSWORD)"
NET="${COMPOSE_PROJECT:-petro-radar}_backend"

keys="$( ( cd "${REPO_DIR}" && "${DC[@]}" exec -T db psql -tA -U "${PG_U}" -d "${PG_D}" \
  -f /dev/stdin < "${HERE}/04_db_keys.sql" ) 2>/dev/null || true )"
total=0; faltando=0
while IFS= read -r k; do
  [ -z "${k}" ] && continue
  total=$((total+1))
  docker run --rm --network "${NET}" -e MC_HOST_minio="http://${MINIO_USER}:${MINIO_PASS}@minio:9000" \
    minio/mc:latest stat "minio/${BUCKET}/${k}" >/dev/null 2>&1 || { faltando=$((faltando+1)); echo "  FALTANDO: ${k}"; }
done <<< "${keys}"
echo "blobs faltando: ${faltando} / ${total}"
[ "${faltando}" -eq 0 ] || { echo "FAIL: ha blobs no banco sem objeto no MinIO (downloads vao 404)."; exit 1; }
echo "OK: paridade banco<->MinIO (todos os ${total} blobs presentes)."
