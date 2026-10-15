#!/usr/bin/env bash
# =============================================================================
# db/scripts/apply-extra-migrations.sh — aplica as migrations FORA do journal
# =============================================================================
# A partir da 0019 as migrations passaram a ser escritas a mao e NAO entram no
# `meta/_journal.json` do Drizzle — logo `tsx src/db/migrate.ts` NAO as aplica.
# Sem este passo o schema para na 0018 e falta, entre outros:
#   0019/0020/0021  valor real + vencedor efetivo (Transparencia)
#   0022/0023/0027  transparencia_contratos / _licitacoes / _adjudicacoes
#   0024            licitacoes.fonte
#   0025            SSO Entra ID (users.entra_oid, pendente, ultimo_login)
#   0026/0028       digest de e-mail (filtros/assinaturas/ledger/preferencias)
#
# Sem elas, um pg_restore de dump de producao aborta os COPYs ("relation ... does
# not exist", "column ... does not exist") e o banco fica VAZIO. Por isso o passo
# virou parte do `make migrate`.
#
# Todas sao idempotentes (IF NOT EXISTS / OR REPLACE) — rodar de novo e seguro.
#
# Uso:  bash db/scripts/apply-extra-migrations.sh
# Vars: POSTGRES_USER / POSTGRES_DB (lidas do .env.onprem pelo Makefile)
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIG_DIR="${REPO_DIR}/app/src/db/migrations"
JOURNAL="${MIG_DIR}/meta/_journal.json"
COMPOSE="docker compose --env-file ${REPO_DIR}/.env.onprem"
PG_U="${POSTGRES_USER:-petro}"
PG_D="${POSTGRES_DB:-petro_radar}"

[[ -d "${MIG_DIR}" ]] || { echo "!! ${MIG_DIR} ausente"; exit 1; }

# Tags ja versionadas pelo Drizzle (aplicadas pelo migrator TS).
if [[ -f "${JOURNAL}" ]] && command -v jq >/dev/null 2>&1; then
  mapfile -t NO_JOURNAL < <(jq -r '.entries[].tag' "${JOURNAL}")
else
  # fallback sem jq: extrai "tag": "..." do journal
  mapfile -t NO_JOURNAL < <(grep -oE '"tag"[[:space:]]*:[[:space:]]*"[^"]+"' "${JOURNAL}" 2>/dev/null \
    | sed -E 's/.*"tag"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi

esta_no_journal() {
  local base="$1"
  for t in "${NO_JOURNAL[@]}"; do [[ "${t}" == "${base}" ]] && return 0; done
  return 1
}

aplicadas=0; puladas=0
for f in $(ls -1 "${MIG_DIR}"/*.sql | sort); do
  base="$(basename "${f}" .sql)"
  if esta_no_journal "${base}"; then puladas=$((puladas+1)); continue; fi
  echo ">> extra-migration: ${base}"
  # ON_ERROR_STOP=1: uma extra quebrada TEM de falhar alto — foi justamente o
  # silencio que deixou o schema incompleto passar despercebido.
  ${COMPOSE} exec -T db psql -v ON_ERROR_STOP=1 -q -U "${PG_U}" -d "${PG_D}" -f /dev/stdin < "${f}"
  aplicadas=$((aplicadas+1))
done

echo ">> extras aplicadas: ${aplicadas} (no journal, puladas: ${puladas})"
