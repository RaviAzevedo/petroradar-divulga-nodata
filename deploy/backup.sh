#!/usr/bin/env bash
# =============================================================================
# deploy/backup.sh — BACKUP consistente do Petro Radar on-prem (CRÍTICO #4 + F2)
# =============================================================================
# Faz backup da FONTE DA VERDADE (que NÃO é reconstruível) e ignora os derivados:
#   • Postgres  : pg_dump lógico (-Fc, custom) via o CLIENTE do PRÓPRIO container
#                 db (versão casada) — consistente (snapshot transacional),
#                 CIFRADO com age (ou gpg simétrico) + .sha256 (ver CIFRAGEM).
#   • Blobs MinIO: mc mirror do bucket -> diretório de backup (objeto-a-objeto,
#                 consistente; NÃO é tar de volume vivo). Os blobs NÃO são
#                 cifrados aqui: são um ESPELHO objeto-a-objeto (restore =
#                 mc mirror reverso, objeto por objeto); tar+cifrar o espelho
#                 quebraria a semântica incremental do restore e dobraria o
#                 espaço. Proteção em repouso dos blobs = LUKS no filesystem
#                 do BACKUP_DIR/BACKUP_OFFSITE_DIR (ver deploy/checklist-prod.md §4).
#   • Embeddings (acervo_chunks): NÃO são backupados — DERIVADOS do Postgres
#                 (reconstruíveis pela task embedding_reindex_acervo).
#
# CIFRAGEM do dump (F2):
#   BACKUP_AGE_RECIPIENT=age1...       chave PÚBLICA age  -> postgres.dump.age
#   BACKUP_GPG_PASSPHRASE_FILE=/path   fallback gpg AES256 -> postgres.dump.gpg
#   BACKUP_REQUIRE_ENCRYPTION=1        FALHA se não conseguir cifrar (produção!)
#   (nenhum dos dois configurado, sem a flag: warn ALTO e segue em claro — dev)
#   Restore/decifração: deploy/restore.sh (usa BACKUP_AGE_IDENTITY).
#
# Retenção local: últimos N diários (BACKUP_KEEP_DAILY=14) + M semanais
# (BACKUP_KEEP_WEEKLY=8, domingos). SHA256 por arquivo (manifesto SHA256SUMS).
# Offsite (F2): se BACKUP_OFFSITE_DIR setado, copia o backup do dia p/ lá
# (NAS/segundo disco/cofre) com VERIFICAÇÃO pós-cópia (sha256 do dump) e
# retenção própria (BACKUP_OFFSITE_RETENTION_DAYS=30) — proteção contra perda
# do host/ransomware.
#
# Agende com o systemd timer: ./deploy/install-backup-timer.sh (diário 02:30;
# units em deploy/systemd/). Uso manual:
#   ./deploy/backup.sh [--offsite=/mnt/nas/petro-backups]
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

BACKUP_DIR="${BACKUP_DIR:-${REPO_DIR}/backups}"
OFFSITE="${BACKUP_OFFSITE_DIR:-}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
OFFSITE_RETENTION_DAYS="${BACKUP_OFFSITE_RETENTION_DAYS:-30}"
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
GPG_PASSPHRASE_FILE="${BACKUP_GPG_PASSPHRASE_FILE:-}"
REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-0}"
for arg in "$@"; do
  case "$arg" in
    --offsite=*) OFFSITE="${arg#--offsite=}" ;;
    --dir=*)     BACKUP_DIR="${arg#--dir=}" ;;
    -h|--help)   grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "argumento desconhecido: $arg" ;;
  esac
done

require_docker
ENV_FILE="${REPO_DIR}/.env.onprem"
[[ -f "${ENV_FILE}" ]] || die ".env.onprem ausente."
get_env() { grep -E "^${1}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- ; }

STAMP="$(date -u +%Y%m%d_%H%M%S)"
DOW="$(date -u +%u)"   # 7 = domingo
[[ "${DOW}" == "7" ]] && TAG="weekly" || TAG="daily"
DEST="${BACKUP_DIR}/${TAG}/${STAMP}"
mkdir -p "${DEST}"
banner "BACKUP Petro Radar  (${TAG} ${STAMP} UTC)"

PG_U="$(get_env POSTGRES_USER)"; PG_D="$(get_env POSTGRES_DB)"
BUCKET="$(get_env R2_BUCKET)"; BUCKET="${BUCKET:-petro-radar}"
MINIO_USER="$(get_env MINIO_ROOT_USER)"; MINIO_PASS="$(get_env MINIO_ROOT_PASSWORD)"
NET="${COMPOSE_PROJECT}_backend"

# ── 1) Postgres (fonte da verdade) — pg_dump custom (-Fc) consistente ─────────
log "pg_dump (-Fc) ${PG_D} ..."
dc exec -T db pg_dump -Fc --no-owner --no-acl -U "${PG_U}" "${PG_D}" > "${DEST}/postgres.dump" \
  || die "pg_dump falhou."
sz="$(human_size "${DEST}/postgres.dump")"
ok "Postgres dump: postgres.dump (${sz})"

# ── 1b) CIFRAGEM do dump (F2): age (preferido) > gpg simétrico > claro+warn ───
# Sai com DUMP_FILE apontando para o artefato final (cifrado ou não).
DUMP_FILE="${DEST}/postgres.dump"
ENCRYPTED="none"
encrypt_dump() {
  if [[ -n "${AGE_RECIPIENT}" ]]; then
    command -v age >/dev/null 2>&1 \
      || { warn "BACKUP_AGE_RECIPIENT setado mas binario 'age' ausente no host."; return 1; }
    log "cifrando dump com age (recipient ${AGE_RECIPIENT:0:12}...)"
    age -r "${AGE_RECIPIENT}" -o "${DEST}/postgres.dump.age" "${DEST}/postgres.dump" \
      || { warn "age falhou ao cifrar o dump."; rm -f "${DEST}/postgres.dump.age"; return 1; }
    DUMP_FILE="${DEST}/postgres.dump.age"; ENCRYPTED="age"
    return 0
  fi
  if [[ -n "${GPG_PASSPHRASE_FILE}" ]]; then
    command -v gpg >/dev/null 2>&1 \
      || { warn "BACKUP_GPG_PASSPHRASE_FILE setado mas binario 'gpg' ausente."; return 1; }
    [[ -r "${GPG_PASSPHRASE_FILE}" ]] \
      || { warn "passphrase ilegivel: ${GPG_PASSPHRASE_FILE}"; return 1; }
    log "cifrando dump com gpg simetrico (AES256)"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-file "${GPG_PASSPHRASE_FILE}" \
        -o "${DEST}/postgres.dump.gpg" "${DEST}/postgres.dump" \
      || { warn "gpg falhou ao cifrar o dump."; rm -f "${DEST}/postgres.dump.gpg"; return 1; }
    DUMP_FILE="${DEST}/postgres.dump.gpg"; ENCRYPTED="gpg"
    return 0
  fi
  return 1
}
if encrypt_dump; then
  rm -f "${DEST}/postgres.dump"            # nunca deixar o claro junto do cifrado
  ok "Dump cifrado (${ENCRYPTED}): $(basename "${DUMP_FILE}") ($(human_size "${DUMP_FILE}"))"
elif [[ "${REQUIRE_ENCRYPTION}" == "1" ]]; then
  rm -f "${DEST}/postgres.dump"          # nao deixar dump em claro no caminho de falha
  die "BACKUP_REQUIRE_ENCRYPTION=1 e nao foi possivel cifrar (configure BACKUP_AGE_RECIPIENT — instale 'age' — ou BACKUP_GPG_PASSPHRASE_FILE)."
else
  warn "=========================================================================="
  warn " DUMP EM CLARO: nenhuma cifragem configurada (BACKUP_AGE_RECIPIENT /"
  warn " BACKUP_GPG_PASSPHRASE_FILE). Aceitavel APENAS em dev. Em PRODUCAO,"
  warn " configure a cifragem e BACKUP_REQUIRE_ENCRYPTION=1 (deploy/checklist-prod.md §3)."
  warn "=========================================================================="
fi
sha256_of "${DUMP_FILE}" > "${DUMP_FILE}.sha256"
ok "sha256 do dump: $(basename "${DUMP_FILE}").sha256"

# ── 2) Blobs MinIO (não reconstruíveis) — espelho ÚNICO + hardlink por dia ────
# Antes, cada daily/<stamp>/blobs era uma CÓPIA integral do bucket — com um
# acervo de alguns GB, N dailies + M weeklies multiplicam esse volume e estouram
# o disco de backup de uma vez. Agora o mirror escreve num espelho
# ESTÁVEL fora da rotação e cada daily recebe HARDLINKS (cp -al): arquivo
# inalterado ocupa 1× no disco, e cada daily continua um snapshot completo e
# restaurável por caminho. Seguro porque (a) o mc grava via .part + rename
# (inode novo — o hardlink do daily antigo preserva o conteúdo velho) e (b) as
# chaves de blob levam timestamp no upload: objeto nunca é reescrito in-place.
# --remove: o espelho acompanha exclusões do bucket; o histórico fica nos
# hardlinks dos dailies anteriores.
ESPELHO="${BACKUP_DIR}/blobs-espelho"
log "mc mirror minio/${BUCKET} -> blobs-espelho/ (estavel) ..."
mkdir -p "${ESPELHO}"
docker run --rm --network "${NET}" \
  --user "$(id -u):$(id -g)" \
  -e MC_CONFIG_DIR=/tmp/.mc \
  -e MC_HOST_minio="http://${MINIO_USER}:${MINIO_PASS}@minio:9000" \
  -v "${ESPELHO}:/out" minio/mc:latest \
  mirror --overwrite --remove --preserve "minio/${BUCKET}" "/out/${BUCKET}" \
  && ok "Espelho atualizado (blobs-espelho/${BUCKET})." || warn "mc mirror dos blobs retornou avisos."
log "hardlink do espelho -> ${DEST}/blobs ..."
mkdir -p "${DEST}"
cp -al "${ESPELHO}" "${DEST}/blobs"
nblob="$(find "${DEST}/blobs" -type f 2>/dev/null | wc -l | tr -d ' ')"
ok "  ${nblob} objeto(s) de blob no backup (hardlinks; custo extra ~0)."

# ── 3) Manifesto + checksum agregado ──────────────────────────────────────────
(
  cd "${DEST}"
  if command -v sha256sum >/dev/null 2>&1; then
    find . -type f ! -name SHA256SUMS -exec sha256sum {} +
  else
    find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} +
  fi
) > "${DEST}/SHA256SUMS"
{
  echo "postgres=fonte-da-verdade (cifragem: ${ENCRYPTED}); blobs=fonte-da-verdade (espelho mc, claro — LUKS no destino); embeddings=DERIVADOS (reconstruir via task embedding_reindex_acervo)"
  echo "restore: deploy/restore.sh $(basename "${DUMP_FILE}")  # .age exige BACKUP_AGE_IDENTITY; .gpg pede passphrase"
} > "${DEST}/README.txt"
ok "Manifesto/checksums gravados."

# ── 4) Retenção (N diários + M semanais) ──────────────────────────────────────
prune() { # prune <subdir> <keep>
  local sub="$1" keep="$2" d
  [[ -d "${BACKUP_DIR}/${sub}" ]] || return 0
  ls -1dt "${BACKUP_DIR}/${sub}"/*/ 2>/dev/null | tail -n +"$((keep+1))" | while read -r d; do
    log "  retencao: removendo ${d}"; rm -rf "${d}"
  done
}
prune daily  "${KEEP_DAILY}"
prune weekly "${KEEP_WEEKLY}"
ok "Retencao aplicada (daily=${KEEP_DAILY}, weekly=${KEEP_WEEKLY})."

# ── 5) Offsite (F2: cópia verificada + retenção própria) ─────────────────────
if [[ -n "${OFFSITE}" ]]; then
  OFF_DEST="${OFFSITE}/${TAG}/${STAMP}"
  log "Copiando p/ offsite: ${OFF_DEST}"
  mkdir -p "${OFF_DEST}"
  # Copia o backup do dia INTEIRO (dump cifrado + sha256 + SHA256SUMS + blobs).
  # Blobs vao como espelho (claro) — em repouso protegidos pelo LUKS do destino.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${DEST}/" "${OFF_DEST}/" || die "rsync p/ offsite falhou."
  else
    cp -R "${DEST}/." "${OFF_DEST}/" || die "cp p/ offsite falhou."
  fi
  # Verificação pós-cópia: recomputa o sha256 do DUMP no destino e compara.
  off_dump="${OFF_DEST}/$(basename "${DUMP_FILE}")"
  [[ -f "${off_dump}" ]] || die "verificacao offsite: dump ausente em ${off_dump}"
  src_sha="$(awk '{print $1}' "${DUMP_FILE}.sha256")"
  dst_sha="$(sha256_of "${off_dump}")"
  [[ "${src_sha}" == "${dst_sha}" ]] \
    || die "verificacao offsite FALHOU: sha256 divergente (src=${src_sha} dst=${dst_sha})"
  ok "Offsite verificado (sha256 do dump confere)."
  # Retenção offsite SEPARADA: apaga backups mais antigos que N dias (por mtime
  # do diretório <stamp>; independe da retenção local daily/weekly).
  find "${OFFSITE}" -mindepth 2 -maxdepth 2 -type d -mtime +"${OFFSITE_RETENTION_DAYS}" \
       -print -exec rm -rf {} + 2>/dev/null \
    | while read -r d; do log "  retencao offsite (${OFFSITE_RETENTION_DAYS}d): removendo ${d}"; done
  ok "Retencao offsite aplicada (${OFFSITE_RETENTION_DAYS} dias)."
else
  warn "BACKUP_OFFSITE_DIR nao definido — backup fica SO no host (sem protecao a perda do servidor)."
fi

hr
ok "BACKUP OK -> ${DEST}  (dump: $(basename "${DUMP_FILE}"), cifragem: ${ENCRYPTED})"
echo " Restore (DR):  deploy/restore.sh <dump> [--db=nome]   (decifra .age/.gpg automaticamente;"
echo "                .age exige BACKUP_AGE_IDENTITY=/caminho/da/chave)  |  blobs: mc mirror reverso"
