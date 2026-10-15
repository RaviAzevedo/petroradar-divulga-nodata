#!/usr/bin/env bash
# =============================================================================
# deploy/gen-secrets.sh — materializa deploy/secrets/* a partir do .env.onprem (G7)
# =============================================================================
# Extrai os segredos do .env.onprem ATUAL e grava um arquivo por segredo em
# deploy/secrets/ (chmod 400, dir 700) — o insumo do overlay
# docker-compose.secrets.yml (secrets file-based).
#
# Idempotente: sobrescreve os arquivos a cada execução (rode de novo após
# rotacionar um segredo no .env.onprem; depois `docker compose ... up -d`).
# Arquivos são criados MESMO para segredos vazios (ex.: SMTP_PASS sem uso)
# — o compose falha o `up` se o file de um secret declarado não existir.
#
# Uso:  ./deploy/gen-secrets.sh [--env-file=/caminho/.env.onprem]
# Depois: docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d
# Ver deploy/secrets/README.md para o fluxo completo (e a troca por placeholders).
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

ENV_FILE="${REPO_DIR}/.env.onprem"
for arg in "$@"; do
  case "$arg" in
    --env-file=*) ENV_FILE="${arg#--env-file=}" ;;
    -h|--help)    grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "argumento desconhecido: $arg" ;;
  esac
done
[[ -f "${ENV_FILE}" ]] || die ".env.onprem ausente em ${ENV_FILE}"

SECRETS_DIR="${DEPLOY_DIR}/secrets"
mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

get_env() { grep -E "^${1}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- ; }

banner "gen-secrets: ${ENV_FILE} -> ${SECRETS_DIR}/"

# <arquivo-do-secret>:<CHAVE no .env.onprem> — mantenha em sincronia com o
# bloco `secrets:` do docker-compose.secrets.yml.
MAPPINGS=(
  "auth_secret:AUTH_SECRET"
  "cron_secret:CRON_SECRET"
  "setup_token:SETUP_TOKEN"
  "postgres_password:POSTGRES_PASSWORD"
  "database_url:DATABASE_URL"
  "redis_password:REDIS_PASSWORD"
  "redis_url:REDIS_URL"
  "celery_broker_url:CELERY_BROKER_URL"
  "celery_result_backend:CELERY_RESULT_BACKEND"
  "minio_root_password:MINIO_ROOT_PASSWORD"
  "r2_secret_access_key:R2_SECRET_ACCESS_KEY"
  "smtp_pass:SMTP_PASS"
  "anthropic_api_key:ANTHROPIC_API_KEY"
)

n_ok=0; n_vazio=0
for map in "${MAPPINGS[@]}"; do
  fname="${map%%:*}"; key="${map#*:}"
  val="$(get_env "${key}" || true)"
  out="${SECRETS_DIR}/${fname}"
  # chmod de escrita temporario p/ sobrescrever arquivos 400 de execucao anterior.
  [[ -f "${out}" ]] && chmod 600 "${out}"
  printf '%s' "${val}" > "${out}"
  chmod 400 "${out}"
  if [[ -n "${val}" ]]; then
    if [[ "${val}" == TROQUE-* || "${val}" == "sk-ant-..." ]]; then
      warn "  ${fname} <- ${key} (PLACEHOLDER '${val:0:12}...' — troque no .env.onprem e rode de novo)"
    else
      ok "  ${fname} <- ${key}"
    fi
    n_ok=$((n_ok+1))
  else
    warn "  ${fname} <- ${key} (VAZIO — ok se o recurso nao e usado)"
    n_vazio=$((n_vazio+1))
  fi
done

hr
ok "${n_ok} segredo(s) materializados, ${n_vazio} vazio(s) em ${SECRETS_DIR}/"
echo " Proximos passos:"
echo "   1. docker compose -f docker-compose.yml -f docker-compose.secrets.yml config -q"
echo "   2. docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d"
echo "   3. (apos validar) troque os valores no .env.onprem por placeholders"
echo "      (ver deploy/secrets/README.md) para tirar os segredos do environ."
