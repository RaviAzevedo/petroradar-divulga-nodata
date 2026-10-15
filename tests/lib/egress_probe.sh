#!/usr/bin/env bash
# =============================================================================
# egress_probe.sh — WP12 G10/G11: sondagem ATIVA de egress por container
# =============================================================================
# Roda no HOST (docker compose no ar). Complementa o egress_guard.py: em vez de
# depender só de captura passiva (conntrack.txt), tenta ABRIR conexão TCP:443 de
# DENTRO de cada container de aplicação (web/bff/worker) para cada destino do
# contrato de rede:
#   - PROIBIDOS (lista REAL de tests/lib/egress_guard.py): api.github.com,
#     upstash.io (cobre *.upstash.io), api.voyageai.com, api.openai.com,
#     api.resend.com — bloqueado em TODOS os containers => "provado_bloqueado".
#   - EXIGIDOS: api.anthropic.com (se IA habilitada) e os hosts do Microsoft
#     Graph (se e-mail) — alcançável => o guard marca status "alcancavel".
#
# Método por container (timeout 3s, sem instalar nada):
#   web    -> node -e (socket TCP; a imagem standalone do Next só tem node)
#   bff    -> python3 -c socket.create_connection
#   worker -> python3 -c socket.create_connection
# Falha de DNS conta como BLOQUEADO (deny-list de DNS/firewall é bloqueio válido).
#
# Saída: tests/_artifacts/egress_probe.json
#   {"<host>": {"alcancavel": bool, "por_container": {"web": bool, ...}}}
# O egress_guard.py LÊ este arquivo quando presente e o combina com conntrack.txt.
#
# Uso:  ./tests/lib/egress_probe.sh        (na raiz do repo, .env.onprem presente)
# Exit: 0 sempre que a sonda rodou (o VEREDITO é do egress_guard/go_no_go, não daqui);
#       1 só se nenhum container pôde ser sondado.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
cd "${REPO_DIR}"

ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env.onprem}"
# compose() em função (não string): o caminho do repo pode ter ESPAÇOS e a
# expansão não-quotada de uma var COMPOSE com --env-file quebraria em word-split.
compose() {
  if [[ -n "${COMPOSE:-}" ]]; then
    ${COMPOSE} "$@"
  else
    docker compose --env-file "${ENV_FILE}" "$@"
  fi
}
ART_DIR="${ART_DIR:-${TESTS_DIR}/_artifacts}"
mkdir -p "${ART_DIR}"

TIMEOUT_S=3
PORT=443

# Listas espelham tests/lib/egress_guard.py (PROIBIDOS + EXIGIDOS). A sonda so
# COLETA; a CLASSIFICAÇÃO (proibido/exigido/gated) é toda do guard.
# login.microsoftonline.com + graph.microsoft.com sao os hosts do transporte de
# e-mail (Microsoft Graph, transporte UNICO): precisam ser sondados, senao o G11
# nunca consegue provar que o e-mail tem egress e o gate passa verde com o
# sistema mudo.
HOSTS=(
  api.github.com
  upstash.io
  api.voyageai.com
  api.openai.com
  api.resend.com
  api.anthropic.com
  login.microsoftonline.com
  graph.microsoft.com
)
CONTAINERS=(web bff worker)

# ── Probes (rc 0 = TCP conectou = host ALCANÇÁVEL do container) ──────────────
probe_node() {  # $1=container  $2=host
  compose exec -T "$1" node -e '
    const net = require("net");
    const s = net.connect({ host: process.argv[1], port: '"${PORT}"', timeout: '"$((TIMEOUT_S * 1000))"' },
      () => { s.destroy(); process.exit(0); });
    s.on("timeout", () => { s.destroy(); process.exit(1); });
    s.on("error", () => process.exit(1));
  ' "$2" >/dev/null 2>&1
}

probe_python() {  # $1=container  $2=host
  compose exec -T "$1" python3 -c '
import socket, sys
try:
    socket.create_connection((sys.argv[1], '"${PORT}"'), timeout='"${TIMEOUT_S}"').close()
except OSError:
    sys.exit(1)
' "$2" >/dev/null 2>&1
}

container_up() {  # $1=container — exec trivial prova que está no ar
  compose exec -T "$1" true >/dev/null 2>&1 || \
    compose exec -T "$1" sh -c 'exit 0' >/dev/null 2>&1
}

# ── Sondagem ─────────────────────────────────────────────────────────────────
declare -a UP_CONTAINERS=()
for c in "${CONTAINERS[@]}"; do
  if container_up "${c}"; then
    UP_CONTAINERS+=("${c}")
  else
    echo ">> [egress-probe] container '${c}' indisponível — sonda pulada para ele" >&2
  fi
done
if [[ ${#UP_CONTAINERS[@]} -eq 0 ]]; then
  echo ">> [egress-probe] NENHUM container sondável (stack no ar?) — abortando" >&2
  exit 1
fi

# JSON construído à mão (hosts/booleans fixos, sem necessidade de escaping).
# Sem arrays associativos de propósito: o bash 3.2 do macOS não os suporta.
OUT="${ART_DIR}/egress_probe.json"
{
  printf '{'
  sep_h=""
  for host in "${HOSTS[@]}"; do
    alcancavel=false
    frag=""
    sep_c=""
    for c in "${UP_CONTAINERS[@]}"; do
      reached=false
      case "${c}" in
        web) probe_node "${c}" "${host}" && reached=true ;;
        *)   probe_python "${c}" "${host}" && reached=true ;;
      esac
      [[ "${reached}" == "true" ]] && alcancavel=true
      frag="${frag}${sep_c}\"${c}\": ${reached}"
      sep_c=", "
      echo ">> [egress-probe] ${c} -> ${host}:${PORT} = $([[ ${reached} == true ]] && echo ALCANCAVEL || echo bloqueado)" >&2
    done
    printf '%s\n  "%s": {"alcancavel": %s, "por_container": {%s}}' "${sep_h}" "${host}" "${alcancavel}" "${frag}"
    sep_h=","
  done
  printf '\n}\n'
} > "${OUT}"

echo ">> [egress-probe] resultado em ${OUT}"
exit 0
