#!/usr/bin/env bash
# =============================================================================
# deploy/install-backup-timer.sh — instala o timer systemd do backup (F2)
# =============================================================================
# RODAR NO HOST DE PRODUÇÃO (Linux com systemd), como root. NÃO roda em dev/Mac.
# Copia deploy/systemd/petro-radar-backup.{service,timer} p/ /etc/systemd/system,
# ajusta o WorkingDirectory p/ a raiz REAL do pacote, daemon-reload e enable --now.
#
# ANTES de rodar, edite deploy/systemd/petro-radar-backup.service:
#   BACKUP_AGE_RECIPIENT=age1...   (cifragem — OBRIGATORIA em producao)
#   BACKUP_OFFSITE_DIR=/mnt/...    (offsite)
# Ou edite depois com: systemctl edit petro-radar-backup.service
#
# Uso: sudo ./deploy/install-backup-timer.sh [--dry-run]
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "argumento desconhecido: $arg" ;;
  esac
done

UNIT_DIR="${DEPLOY_DIR}/systemd"
SERVICE_SRC="${UNIT_DIR}/petro-radar-backup.service"
TIMER_SRC="${UNIT_DIR}/petro-radar-backup.timer"
[[ -f "${SERVICE_SRC}" && -f "${TIMER_SRC}" ]] || die "units ausentes em ${UNIT_DIR}."

banner "Instalação do timer de backup (systemd)"

# ── Guardas: host Linux com systemd, root ─────────────────────────────────────
[[ "$(uname -s)" == "Linux" ]] || die "este script e para o HOST DE PRODUCAO (Linux). Em dev/Mac, nao instale."
command -v systemctl >/dev/null 2>&1 || die "systemctl ausente — host sem systemd."
if [[ "${DRY_RUN}" == "0" && "$(id -u)" != "0" ]]; then
  die "rode como root: sudo $0"
fi

# ── Render: fixa o WorkingDirectory na raiz REAL do pacote extraido ───────────
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
sed "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_DIR}|" "${SERVICE_SRC}" \
  > "${STAGE}/petro-radar-backup.service"
cp "${TIMER_SRC}" "${STAGE}/petro-radar-backup.timer"
ok "WorkingDirectory=${REPO_DIR}"

if grep -qE '^Environment=BACKUP_AGE_RECIPIENT=$' "${STAGE}/petro-radar-backup.service"; then
  warn "BACKUP_AGE_RECIPIENT vazio no service — com BACKUP_REQUIRE_ENCRYPTION=1 o backup vai FALHAR ate configurar."
  warn "Edite deploy/systemd/petro-radar-backup.service (ou systemctl edit) com a chave publica age."
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  log "[dry-run] instalaria em /etc/systemd/system:"
  sed -n '1,30p' "${STAGE}/petro-radar-backup.service"
  exit 0
fi

# ── Instala + habilita ────────────────────────────────────────────────────────
install -m 0644 "${STAGE}/petro-radar-backup.service" /etc/systemd/system/petro-radar-backup.service
install -m 0644 "${STAGE}/petro-radar-backup.timer"   /etc/systemd/system/petro-radar-backup.timer
systemctl daemon-reload
systemctl enable --now petro-radar-backup.timer
ok "timer habilitado."

hr
systemctl list-timers petro-radar-backup.timer --no-pager || true
echo " Teste manual do backup (sem esperar 02:30):  systemctl start petro-radar-backup.service"
echo " Logs:                                        journalctl -u petro-radar-backup.service -f"
