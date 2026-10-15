#!/usr/bin/env bash
# =============================================================================
# deploy/snapshot-prod.sh — CAPTURA o snapshot FRESCO de PRODUÇÃO no cutover.
# =============================================================================
# Roda na MÁQUINA-PONTE (com acesso ao Neon + ao R2 de produção), no momento do
# go-live, DEPOIS do freeze das escritas na origem. Produz o "data-bundle":
#   • db_prod_<ts>.sql.gz   — pg_dump do Neon (EXCLUI acervo_chunks: re-embeddado)
#   • petro-radar-blobs.tgz — blobs R2 (via scripts/pitstop/pack-data.sh)
#   • origin_counts.csv     — contagem por tabela NA ORIGEM (p/ parity-diff)
#   • SHA256SUMS
# É SEPARADO do bundle de imagens (que é estático e vai antes). No servidor:
#   ./deploy/load-and-run.sh --restore-dump=db_prod_<ts>.sql.gz --restore-blobs=petro-radar-blobs.tgz
# depois  make parity-diff ORIGIN=origin_counts.csv  +  make storage-validate.
#
# ENV obrigatórios:
#   NEON_DATABASE_URL                              (Postgres de produção, leitura)
#   R2_PACK_ENDPOINT / R2_PACK_ACCESS_KEY / R2_PACK_SECRET_KEY [/ R2_PACK_BUCKET]
# Uso:  NEON_DATABASE_URL=... R2_PACK_*=... deploy/snapshot-prod.sh [--out=DIR]
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

OUT_DIR="${REPO_DIR}/deploy/dist/data-bundle"
for arg in "$@"; do
  case "$arg" in
    --out=*) OUT_DIR="${arg#--out=}" ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "argumento desconhecido: $arg" ;;
  esac
done
: "${NEON_DATABASE_URL:?defina NEON_DATABASE_URL (Postgres de producao, somente leitura)}"
need docker
mkdir -p "${OUT_DIR}"
TS="$(date -u +%Y%m%d_%H%M%S)"
banner "SNAPSHOT PROD (cutover) — ${TS} UTC"
warn "PRE-REQUISITO: o FREEZE ja foi feito? (agendador e jobs de coleta da origem parados + escritas de usuario congeladas)."

# ── 1) pg_dump do Neon (formato PLANO .sql.gz; EXCLUI acervo_chunks) ──────────
# O Neon de producao roda PostgreSQL 17 — pg_dump 16 RECUSA servidor mais novo
# ("server version mismatch"). Client 17 dedicado p/ o dump; o restore no pg16
# on-prem e dump PLANO sob ON_ERROR_STOP=0 (SETs novos do 17, ex. transaction_timeout,
# viram aviso inocuo). Roda na maquina-ponte (com internet): pull e ok.
PG_CLIENT_IMAGE="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
DUMP="${OUT_DIR}/db_prod_${TS}.sql.gz"
log "pg_dump do Neon (client ${PG_CLIENT_IMAGE}) -> $(basename "${DUMP}")  (exclui acervo_chunks / __drizzle_migrations data)"
docker run --rm -e PGURL="${NEON_DATABASE_URL}" "${PG_CLIENT_IMAGE}" \
  sh -c 'pg_dump --no-owner --no-acl --exclude-table-data="*acervo_chunks*" --exclude-table-data="*__drizzle_migrations*" "$PGURL"' \
  | gzip > "${DUMP}"
ok "Dump: $(human_size "${DUMP}")"

# ── 2) Contagem por tabela NA ORIGEM (para parity-diff no servidor) ───────────
ORIGIN="${OUT_DIR}/origin_counts.csv"
log "Capturando origin_counts.csv (contagem por tabela na producao)..."
docker run --rm -e PGURL="${NEON_DATABASE_URL}" -v "${REPO_DIR}/scripts/parity:/p:ro" "${PG_CLIENT_IMAGE}" \
  sh -c 'psql -tA -F"," "$PGURL" -f /p/count_tables.sql' | sort > "${ORIGIN}" || warn "origin_counts.csv falhou (revise)."
ok "origin_counts.csv: $(wc -l < "${ORIGIN}" | tr -d ' ') tabelas"

# ── 3) Blobs R2 -> tarball (delega ao pack-data.sh) ───────────────────────────
if [[ -n "${R2_PACK_ENDPOINT:-}" ]]; then
  log "Espelhando blobs R2 (pack-data.sh)..."
  ( cd "${REPO_DIR}" && bash scripts/pitstop/pack-data.sh --out="${OUT_DIR}" )
else
  warn "R2_PACK_* nao setado — pulei os blobs. Rode scripts/pitstop/pack-data.sh separado (senao /download 404)."
fi

# ── 4) Checksums do data-bundle ───────────────────────────────────────────────
( cd "${OUT_DIR}" && { command -v sha256sum >/dev/null 2>&1 && sha256sum * 2>/dev/null || shasum -a 256 * 2>/dev/null; } > SHA256SUMS )
hr
ok "DATA-BUNDLE pronto em ${OUT_DIR}"
cat <<EOF
 Transfira o data-bundle ao servidor e rode:
   ./deploy/load-and-run.sh --restore-dump=db_prod_${TS}.sql.gz --restore-blobs=petro-radar-blobs.tgz
   make parity-diff ORIGIN=origin_counts.csv      # paridade de contagens
   make storage-validate                          # blobs faltando: 0
EOF
