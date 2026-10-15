#!/usr/bin/env bash
# =============================================================================
# deploy/dr_check.sh — DR dry-run COMPLETO: Postgres + blobs MinIO (F3)
# =============================================================================
# O tests/dr_check.sh prova o ciclo backup->restore SÓ do Postgres. Este script
# o EXECUTA (parte 1, inalterada — mesmo artefato backup_check.json do gate G12)
# e ESTENDE a prova para os blobs do MinIO (fonte da verdade não-reconstruível):
#
#   2a. espelho de backup: mc mirror do bucket -> diretório temporário
#       (mesmo mecanismo do deploy/backup.sh);
#   2b. CONTAGEM: nº de objetos no espelho vs nº de blob_keys DISTINTOS
#       referenciados no Postgres (tabelas com blob_key no schema do app:
#       documentos_habilitacao, documentos_habilitacao_anexos,
#       participacoes_documentos, familias_anexos, iqf_avaliacoes,
#       petitorios_licitacao + anexos.s3_key da coleta).
#       espelho < referenciado  =>  FALHA (documentos seriam perdidos no DR);
#   2c. RESTORE de amostra: até 5 objetos aleatórios do espelho são restaurados
#       num MinIO EFÊMERO (mesma imagem do compose) e lidos de volta;
#   2d. SHA256: cada objeto restaurado é comparado byte-a-byte (sha256) com o
#       espelho — mínimo 1 objeto conferido quando o bucket não está vazio.
#
# Artefatos: tests/_artifacts/backup_check.json (parte 1, contrato G12) +
#            tests/_artifacts/backup_check_blobs.json (parte 2).
# Exit: 0 = DR completo validado; 1 = QUALQUER falha (Postgres OU blobs).
#
# Uso:  ./deploy/dr_check.sh          # na raiz do repo (stack no ar)
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}" || exit 1

# ── .env.onprem ───────────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env.onprem}"
[[ -f "${ENV_FILE}" ]] || { echo ">> [dr] FAIL: .env.onprem ausente" >&2; exit 1; }
get_env() { grep -E "^${1}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- ; }
POSTGRES_USER="$(get_env POSTGRES_USER)";  POSTGRES_USER="${POSTGRES_USER:-petro}"
POSTGRES_DB="$(get_env POSTGRES_DB)";      POSTGRES_DB="${POSTGRES_DB:-petro_radar}"
BUCKET="$(get_env R2_BUCKET)";             BUCKET="${BUCKET:-petro-radar}"
MINIO_USER="$(get_env MINIO_ROOT_USER)"
MINIO_PASS="$(get_env MINIO_ROOT_PASSWORD)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-petro-radar}"
NET="${COMPOSE_PROJECT}_backend"

ART_DIR="${ART_DIR:-${REPO_DIR}/tests/_artifacts}"
mkdir -p "${ART_DIR}"
TS="$(date +%Y%m%d_%H%M%S)"
MIRROR_DIR="${REPO_DIR}/backups/dr_blobs_${TS}"   # sob o repo => bind-mount ok no Docker Desktop
DR_MINIO="pr-dr-minio"
SAMPLE_N=5

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ── Estado p/ o artefato de blobs ─────────────────────────────────────────────
B_OK=false; N_ESPELHO=0; N_DB=0; N_AMOSTRA=0; N_SHA_OK=0; B_DETALHE=""

write_blob_json() {
  printf '{\n  "ok": %s,\n  "objetos_espelho": %d,\n  "blob_keys_db": %d,\n  "amostra_restaurada": %d,\n  "sha256_conferidos": %d,\n  "detalhe": "%s"\n}\n' \
    "${B_OK}" "${N_ESPELHO}" "${N_DB}" "${N_AMOSTRA}" "${N_SHA_OK}" "${B_DETALHE//\"/\\\"}" \
    > "${ART_DIR}/backup_check_blobs.json"
}

cleanup() {
  write_blob_json
  docker rm -f "${DR_MINIO}" >/dev/null 2>&1 || true
  rm -rf "${MIRROR_DIR}"
  echo ">> [dr] backup_check_blobs.json gravado em ${ART_DIR}/backup_check_blobs.json"
}
trap cleanup EXIT

fail_blobs() {
  B_DETALHE="$1"
  echo ">> [dr-blobs] FAIL: ${B_DETALHE}" >&2
  exit 1
}

# ═══ PARTE 1 — Postgres (delega ao tests/dr_check.sh, contrato G12 intacto) ═══
echo ">> [dr] ===== PARTE 1/2: Postgres (tests/dr_check.sh) ====="
PG_RC=0
if [[ -x "${REPO_DIR}/tests/dr_check.sh" || -f "${REPO_DIR}/tests/dr_check.sh" ]]; then
  bash "${REPO_DIR}/tests/dr_check.sh" || PG_RC=$?
else
  echo ">> [dr] FAIL: tests/dr_check.sh nao encontrado" >&2
  PG_RC=1
fi

# ═══ PARTE 2 — Blobs MinIO ════════════════════════════════════════════════════
echo ">> [dr] ===== PARTE 2/2: blobs MinIO (${BUCKET}) ====="
[[ -n "${MINIO_USER}" && -n "${MINIO_PASS}" ]] || fail_blobs "MINIO_ROOT_USER/PASSWORD ausentes no .env.onprem"

# ── 2a. Espelho de backup (mc mirror -> diretório temporário) ─────────────────
echo ">> [dr-blobs] 1/4 mc mirror minio/${BUCKET} -> ${MIRROR_DIR}"
mkdir -p "${MIRROR_DIR}"
if ! docker run --rm --network "${NET}" \
    -e MC_HOST_minio="http://${MINIO_USER}:${MINIO_PASS}@minio:9000" \
    -v "${MIRROR_DIR}:/out" minio/mc:latest \
    mirror --overwrite --preserve "minio/${BUCKET}" "/out/${BUCKET}" >/dev/null 2>&1; then
  fail_blobs "mc mirror falhou (stack no ar? rede ${NET}? credenciais MinIO?)"
fi
N_ESPELHO="$(find "${MIRROR_DIR}/${BUCKET}" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo ">> [dr-blobs]     ${N_ESPELHO} objeto(s) no espelho"

# ── 2b. Contagem: espelho vs referências no Postgres ──────────────────────────
echo ">> [dr-blobs] 2/4 contagem espelho vs blob_keys no Postgres"
SQL="SELECT count(DISTINCT k) FROM (
       SELECT blob_key AS k FROM documentos_habilitacao        WHERE blob_key IS NOT NULL
 UNION SELECT blob_key      FROM documentos_habilitacao_anexos WHERE blob_key IS NOT NULL
 UNION SELECT blob_key      FROM participacoes_documentos      WHERE blob_key IS NOT NULL
 UNION SELECT blob_key      FROM familias_anexos               WHERE blob_key IS NOT NULL
 UNION SELECT blob_key      FROM iqf_avaliacoes                WHERE blob_key IS NOT NULL
 UNION SELECT blob_key      FROM petitorios_licitacao          WHERE blob_key IS NOT NULL
 UNION SELECT s3_key        FROM anexos                        WHERE s3_key   IS NOT NULL
) t"
N_DB="$(docker compose --env-file "${ENV_FILE}" exec -T db \
  psql -tA -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "${SQL}" 2>/dev/null | tr -d '[:space:]')"
N_DB="${N_DB:-0}"
echo ">> [dr-blobs]     espelho=${N_ESPELHO}  referenciados_no_db=${N_DB}"
if (( N_ESPELHO < N_DB )); then
  fail_blobs "espelho tem MENOS objetos (${N_ESPELHO}) que blob_keys referenciados no db (${N_DB}) — blobs faltando no bucket/backup (perda no DR)"
fi

# Bucket e db vazios: nada a proteger — PASS trivial (instalação nova).
if (( N_ESPELHO == 0 && N_DB == 0 )); then
  B_OK=true
  B_DETALHE="bucket e referencias vazios (instalacao nova) — nada a validar"
  echo ">> [dr-blobs] PASS: ${B_DETALHE}"
  if (( PG_RC == 0 )); then echo ">> [dr] PASS GERAL (postgres + blobs)"; exit 0
  else echo ">> [dr] FAIL GERAL: postgres falhou (rc=${PG_RC})" >&2; exit 1; fi
fi

# ── 2c. Restore de amostra num MinIO EFÊMERO ──────────────────────────────────
echo ">> [dr-blobs] 3/4 restaurando amostra de ate ${SAMPLE_N} objeto(s) em MinIO efemero"
docker rm -f "${DR_MINIO}" >/dev/null 2>&1 || true
if ! docker run --rm -d --name "${DR_MINIO}" \
    -e MINIO_ROOT_USER=drcheck -e MINIO_ROOT_PASSWORD=drcheck123 \
    -v "${MIRROR_DIR}:/restore:ro" \
    minio/minio:latest server /data >/dev/null; then
  fail_blobs "nao foi possivel subir o MinIO efemero (imagem minio/minio local?)"
fi
ready=false
for _ in $(seq 1 30); do
  if docker exec "${DR_MINIO}" mc alias set local http://127.0.0.1:9000 drcheck drcheck123 >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
[[ "${ready}" == "true" ]] || fail_blobs "MinIO efemero nao ficou pronto em 30s"
docker exec "${DR_MINIO}" mc mb -p "local/${BUCKET}" >/dev/null 2>&1 \
  || fail_blobs "mc mb no MinIO efemero falhou"

# Amostra aleatória portátil (macOS não tem shuf): decora com rand(), ordena.
SAMPLE_FILE="$(mktemp "${TMPDIR:-/tmp}/dr_sample.XXXXXX")"
( cd "${MIRROR_DIR}/${BUCKET}" && find . -type f | sed 's|^\./||' ) \
  | awk 'BEGIN{srand()} {printf "%.8f\t%s\n", rand(), $0}' | sort -n | cut -f2- \
  | head -n "${SAMPLE_N}" > "${SAMPLE_FILE}"

while IFS= read -r key; do
  [[ -n "${key}" ]] || continue
  if ! docker exec "${DR_MINIO}" mc cp -q "/restore/${BUCKET}/${key}" "local/${BUCKET}/${key}" >/dev/null 2>&1; then
    rm -f "${SAMPLE_FILE}"; fail_blobs "restore da amostra falhou: ${key}"
  fi
  N_AMOSTRA=$((N_AMOSTRA + 1))
done < "${SAMPLE_FILE}"
echo ">> [dr-blobs]     ${N_AMOSTRA} objeto(s) restaurado(s) no efemero"

# ── 2d. SHA256: lê de volta do MinIO efêmero e compara com o espelho ──────────
echo ">> [dr-blobs] 4/4 conferindo sha256 dos objetos restaurados"
while IFS= read -r key; do
  [[ -n "${key}" ]] || continue
  want="$(sha256_of "${MIRROR_DIR}/${BUCKET}/${key}")"
  got="$(docker exec "${DR_MINIO}" sh -c "mc cat 'local/${BUCKET}/${key}' | sha256sum" 2>/dev/null | awk '{print $1}')"
  if [[ -z "${got}" || "${want}" != "${got}" ]]; then
    rm -f "${SAMPLE_FILE}"
    fail_blobs "sha256 divergente no objeto restaurado '${key}' (espelho=${want} efemero=${got:-vazio})"
  fi
  N_SHA_OK=$((N_SHA_OK + 1))
done < "${SAMPLE_FILE}"
rm -f "${SAMPLE_FILE}"
(( N_SHA_OK >= 1 )) || fail_blobs "nenhum objeto teve o sha256 conferido (amostra vazia com bucket nao-vazio?)"
echo ">> [dr-blobs]     ${N_SHA_OK}/${N_AMOSTRA} sha256 conferido(s)"

B_OK=true
B_DETALHE="espelho=${N_ESPELHO} >= db=${N_DB}; amostra=${N_AMOSTRA} restaurada em MinIO efemero; ${N_SHA_OK} sha256 conferidos"
echo ">> [dr-blobs] PASS: ${B_DETALHE}"

# ═══ Veredito ═════════════════════════════════════════════════════════════════
if (( PG_RC == 0 )); then
  echo ">> [dr] PASS GERAL (postgres + blobs)"
  exit 0
else
  echo ">> [dr] FAIL GERAL: parte Postgres falhou (rc=${PG_RC}); blobs OK" >&2
  exit 1
fi
