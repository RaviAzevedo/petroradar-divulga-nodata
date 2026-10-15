#!/usr/bin/env bash
# =============================================================================
# scripts/pitstop/pack-data.sh — EXPORTA os blobs do Cloudflare R2 (PRODUÇÃO)
# para um tarball que o PITSTOP carrega no MinIO do servidor (CRÍTICO #5).
# =============================================================================
# Roda na MÁQUINA-PONTE (com internet + acesso ao R2 de produção). NÃO precisa
# instalar o cliente `mc` no host: usa a imagem minio/mc via docker.
#
# Espelha r2://<bucket>  ->  ./r2-export/<bucket>  ->  petro-radar-blobs.tgz
# O tarball + o pg_dump (de `make backup-db`) são os DOIS artefatos de DADOS que
# vão no pacote/transferência para o servidor air-gapped.
#
# Credenciais de ORIGEM (R2 de produção) — passe por ENV (NÃO ficam no repo):
#   R2_PACK_ENDPOINT   ex.: https://<accountid>.r2.cloudflarestorage.com
#   R2_PACK_ACCESS_KEY
#   R2_PACK_SECRET_KEY
#   R2_PACK_BUCKET     (default: petro-radar)
#
# Uso:
#   R2_PACK_ENDPOINT=https://abc.r2.cloudflarestorage.com \
#   R2_PACK_ACCESS_KEY=... R2_PACK_SECRET_KEY=... \
#   scripts/pitstop/pack-data.sh [--out=DIR]
# =============================================================================
set -euo pipefail

OUT_DIR="."
for arg in "$@"; do
  case "$arg" in
    --out=*) OUT_DIR="${arg#--out=}" ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 1 ;;
  esac
done

: "${R2_PACK_ENDPOINT:?defina R2_PACK_ENDPOINT (https://<account>.r2.cloudflarestorage.com)}"
: "${R2_PACK_ACCESS_KEY:?defina R2_PACK_ACCESS_KEY (R2 de producao)}"
: "${R2_PACK_SECRET_KEY:?defina R2_PACK_SECRET_KEY (R2 de producao)}"
R2_PACK_BUCKET="${R2_PACK_BUCKET:-petro-radar}"
MC_IMAGE="minio/mc:latest"

command -v docker >/dev/null 2>&1 || { echo "docker obrigatorio" >&2; exit 1; }
mkdir -p "${OUT_DIR}"
WORK="$(mkdir -p "${OUT_DIR}/r2-export" && cd "${OUT_DIR}/r2-export" && pwd)"

echo ">> Espelhando r2://${R2_PACK_BUCKET} -> ${WORK}/${R2_PACK_BUCKET} (mc mirror --preserve)"
docker run --rm \
  -e MC_HOST_r2src="https://${R2_PACK_ACCESS_KEY}:${R2_PACK_SECRET_KEY}@${R2_PACK_ENDPOINT#https://}" \
  -v "${WORK}:/export" \
  "${MC_IMAGE}" \
  mirror --preserve --overwrite "r2src/${R2_PACK_BUCKET}" "/export/${R2_PACK_BUCKET}"

N="$(find "${WORK}/${R2_PACK_BUCKET}" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo ">> ${N} objeto(s) espelhado(s)."

TGZ="${OUT_DIR}/petro-radar-blobs.tgz"
echo ">> Empacotando -> ${TGZ}"
( cd "${OUT_DIR}" && tar czf "$(basename "${TGZ}")" r2-export )
if command -v sha256sum >/dev/null 2>&1; then sha256sum "${TGZ}" > "${TGZ}.sha256";
elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "${TGZ}" > "${TGZ}.sha256"; fi

echo ">> OK. Artefato de blobs: ${TGZ} ($(du -h "${TGZ}" | cut -f1))"
echo ">> No servidor:  ./deploy/load-and-run.sh --restore-dump=db.sql.gz --restore-blobs=${TGZ}"
