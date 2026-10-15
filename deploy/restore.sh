#!/usr/bin/env bash
# =============================================================================
# deploy/restore.sh — RESTORE do dump Postgres do backup.sh (F2; aceita cifrado)
# =============================================================================
# Contraparte do deploy/backup.sh. Aceita QUALQUER artefato que ele gera:
#   postgres.dump        pg_dump -Fc em claro
#   postgres.dump.age    cifrado com age    -> exige BACKUP_AGE_IDENTITY=/chave
#   postgres.dump.gpg    cifrado com gpg    -> BACKUP_GPG_PASSPHRASE_FILE (ou prompt)
#   *.sql.gz             dump plain do `make backup-db` (gunzip | psql)
#
# Restaura NO db do compose (service `db`), no database do .env.onprem por
# default. DESTRUTIVO no destino: usa --clean --if-exists (dropa e recria os
# objetos) — por isso pede confirmação (pule com --yes).
#
# Uso:
#   ./deploy/restore.sh backups/daily/<stamp>/postgres.dump.age            # restore no POSTGRES_DB
#   ./deploy/restore.sh <dump> --db=petro_radar_teste                     # noutro database (já criado)
#   ./deploy/restore.sh <dump> --list                                     # só VALIDA (pg_restore -l), não restaura
#   BACKUP_AGE_IDENTITY=/root/petro-backup.key ./deploy/restore.sh <dump>.age
#
# Blobs MinIO: NÃO passam por aqui — restore de blobs é o espelho reverso:
#   docker run --rm --network petro-radar_backend \
#     -e MC_HOST_minio="http://<root>:<pass>@minio:9000" \
#     -v <backup>/blobs:/in minio/mc:latest mirror --overwrite /in/<bucket> minio/<bucket>
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_docker
ENV_FILE="${REPO_DIR}/.env.onprem"
[[ -f "${ENV_FILE}" ]] || die ".env.onprem ausente."
get_env() { grep -E "^${1}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- ; }

DUMP=""
TARGET_DB=""
LIST_ONLY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --db=*)    TARGET_DB="${arg#--db=}" ;;
    --list)    LIST_ONLY=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "argumento desconhecido: $arg" ;;
    *)         DUMP="$arg" ;;
  esac
done
[[ -n "${DUMP}" ]] || die "informe o dump: ./deploy/restore.sh <postgres.dump[.age|.gpg]|*.sql.gz>"
[[ -f "${DUMP}" ]] || die "dump nao encontrado: ${DUMP}"

PG_U="$(get_env POSTGRES_USER)"; PG_U="${PG_U:-petro}"
PG_D_DEFAULT="$(get_env POSTGRES_DB)"; PG_D_DEFAULT="${PG_D_DEFAULT:-petro_radar}"
TARGET_DB="${TARGET_DB:-${PG_D_DEFAULT}}"

banner "RESTORE Petro Radar  (${DUMP} -> db=${TARGET_DB})"

# ── 0) Integridade: se existir o .sha256 irmão, confere antes de tudo ─────────
if [[ -f "${DUMP}.sha256" ]]; then
  want="$(awk '{print $1}' "${DUMP}.sha256")"
  have="$(sha256_of "${DUMP}")"
  [[ "${want}" == "${have}" ]] || die "sha256 do dump NAO confere (esperado ${want}, obtido ${have})."
  ok "sha256 do dump confere."
fi

# ── 1) Decifração p/ arquivo temporário (nunca deixa o claro para trás) ───────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/petro-restore.XXXXXX")"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

PLAIN=""
case "${DUMP}" in
  *.age)
    command -v age >/dev/null 2>&1 || die "binario 'age' ausente (apt install age)."
    IDENTITY="${BACKUP_AGE_IDENTITY:-}"
    [[ -n "${IDENTITY}" ]] || die "dump .age exige BACKUP_AGE_IDENTITY=/caminho/da/chave-privada (age-keygen)."
    [[ -r "${IDENTITY}" ]] || die "BACKUP_AGE_IDENTITY ilegivel: ${IDENTITY}"
    log "decifrando com age..."
    PLAIN="${WORK}/postgres.dump"
    age -d -i "${IDENTITY}" -o "${PLAIN}" "${DUMP}" || die "age -d falhou (chave errada?)."
    ok "dump decifrado."
    ;;
  *.gpg)
    command -v gpg >/dev/null 2>&1 || die "binario 'gpg' ausente."
    log "decifrando com gpg..."
    PLAIN="${WORK}/postgres.dump"
    if [[ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" && -r "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]]; then
      gpg --batch --yes --decrypt --passphrase-file "${BACKUP_GPG_PASSPHRASE_FILE}" \
          -o "${PLAIN}" "${DUMP}" || die "gpg --decrypt falhou."
    else
      gpg --decrypt -o "${PLAIN}" "${DUMP}" || die "gpg --decrypt falhou."
    fi
    ok "dump decifrado."
    ;;
  *)
    PLAIN="${DUMP}"
    ;;
esac

# ── 2) --list: valida o artefato sem restaurar (prova de restaurabilidade) ────
if [[ "${LIST_ONLY}" == "1" ]]; then
  case "${PLAIN}" in
    *.sql.gz) gunzip -t "${PLAIN}" && ok "gzip integro (dump plain sql)." ;;
    *)        dc exec -T db pg_restore -l < "${PLAIN}" >/dev/null \
                && ok "pg_restore -l OK — dump -Fc valido e legivel." ;;
  esac
  exit 0
fi

# ── 3) Confirmação (restore é destrutivo no database alvo) ────────────────────
if [[ "${ASSUME_YES}" != "1" ]]; then
  printf 'Restaurar em "%s" (DROPA objetos existentes)? [digite: sim] ' "${TARGET_DB}"
  read -r resp
  [[ "${resp}" == "sim" ]] || die "abortado pelo usuario."
fi

# ── 4) Restore ────────────────────────────────────────────────────────────────
case "${PLAIN}" in
  *.sql.gz)
    log "gunzip | psql -d ${TARGET_DB} ..."
    gunzip -c "${PLAIN}" | dc exec -T db psql -q -U "${PG_U}" -d "${TARGET_DB}" \
      || die "psql do restore falhou."
    ;;
  *)
    # -Fc: --clean --if-exists recria os objetos; --no-owner/--no-acl casa com o
    # pg_dump do backup.sh. Erros nao-fatais (ex.: extensao ja existe) nao derrubam.
    log "pg_restore -d ${TARGET_DB} (--clean --if-exists) ..."
    dc exec -T db pg_restore -U "${PG_U}" -d "${TARGET_DB}" \
        --clean --if-exists --no-owner --no-acl < "${PLAIN}" \
      || warn "pg_restore terminou com avisos (comum: DROP de objeto inexistente). Verifique abaixo."
    ;;
esac

# ── 5) Sanidade pós-restore ───────────────────────────────────────────────────
NT="$(dc exec -T db psql -tA -U "${PG_U}" -d "${TARGET_DB}" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" | tr -d '[:space:]')"
ok "tabelas public restauradas: ${NT}"
[[ "${NT}" -ge 50 ]] || die "restore suspeito: ${NT} tabelas (<50 — schema real tem 52)."

hr
ok "RESTORE OK em ${TARGET_DB}."
echo " Pos-restore: reindexar derivados se necessario (task embedding_reindex_acervo)."
echo " Blobs: mc mirror reverso (ver cabecalho deste script)."
