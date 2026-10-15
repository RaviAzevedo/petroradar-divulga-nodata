#!/usr/bin/env bash
# =============================================================================
# deploy/build.sh — PITSTOP passo 1/4: CONSTRUIR e BAIXAR todas as imagens
# =============================================================================
# Roda na MÁQUINA DE EMPACOTAMENTO (com internet). Produz, no Docker local:
#   • petro-radar/web:onprem     (build de ./app via Dockerfile.web)
#   • petro-radar/bff:onprem     (build de ./bff/Dockerfile)
#   • petro-radar/worker:onprem  (build de ./worker/Dockerfile)
#   • petro-radar/migrate:onprem (target builder do Dockerfile.web; roda as migrations)
#   • todas as imagens de TERCEIROS via `docker pull` (db/redis/minio/mc/es/TEI)
#
# Depois rode: deploy/save-images.sh → deploy/bundle.sh.
#
# Pré-requisitos cobertos (Decisão 3 / lacuna 8 / lacuna 16):
#   - O build context do web é ./app (clone do app com os prereqs aplicados).
#   - O web só builda standalone se o app já tiver output:'standalone' + driver pg
#     + next/font local (branch feat/onprem-prereqs). Se faltar, o build QUEBRA
#     aqui — de propósito, para o problema aparecer no empacotamento e não no
#     servidor air-gapped.
#   - --pull garante camadas base atualizadas (node:22-alpine, python:3.12-slim,
#     mcr.microsoft.com/playwright/python) — precisam estar embutidas nas imagens
#     finais (o servidor não terá acesso a esses registries).
#
# Flags:
#   --no-pull-base   não passa --pull no build (usa camadas base já em cache)
#   --no-cache       força rebuild total (descarta cache de camadas)
#   --only=web,bff   constrói só esses serviços (csv: web,bff,worker)
#   --skip-third     pula o `docker pull` das imagens de terceiros
#   --platform=...   alvo de plataforma (ex.: linux/amd64 se o servidor é x86)
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

PULL_BASE="--pull"
NO_CACHE=""
ONLY=""
SKIP_THIRD="0"
# Servidor da Proponente e x86 -> default amd64 (o pitstop e p/ o servidor, nao p/ o
# Mac de dev). Override com --platform=... ou BUILD_PLATFORM=. Builds locais de dev
# usam `make build` (nativo), nao este script.
PLATFORM="${BUILD_PLATFORM:-linux/amd64}"

for arg in "$@"; do
  case "$arg" in
    --no-pull-base) PULL_BASE="" ;;
    --no-cache)     NO_CACHE="--no-cache" ;;
    --only=*)       ONLY="${arg#--only=}" ;;
    --skip-third)   SKIP_THIRD="1" ;;
    --platform=*)   PLATFORM="${arg#--platform=}" ;;
    -h|--help)      grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "argumento desconhecido: $arg" ;;
  esac
done

banner "PITSTOP 1/4 — BUILD  (versao: $(pkg_version))"
require_docker

# ── Sanidade do build context ────────────────────────────────────────────────
# O web buildaa de ${WEB_REPO_DIR} (= ./app, MESMO context do
# compose). O bff buildaa de ./bff/Dockerfile e o worker de ./worker/Dockerfile
# (self-contained no repo on-prem) — NAO dependem de WEB_REPO_DIR.
log "Repo on-prem (infra)  : ${REPO_DIR}"
log "Repo do app (web)     : ${WEB_REPO_DIR}"
[[ -d "${WEB_REPO_DIR}" ]] || die "repo do app nao encontrado em '${WEB_REPO_DIR}'. \
Defina WEB_REPO_DIR=/caminho/do/app-next e rode de novo."
[[ -f "${WEB_REPO_DIR}/package.json" ]] || die "'${WEB_REPO_DIR}' nao parece o app Next (sem package.json)."

# Pré-requisitos de código BLOQUEADORES (Decisão 3 / branch feat/onprem-prereqs):
# sem eles a imagem web NAO builda (standalone) ou builda mas TODA query falha em
# runtime (sem driver pg). ABORTA o build (WP11 §1) — use ALLOW_MISSING_PREREQS=1
# apenas para inspecionar/iterar localmente.
_prereq_fail=0
if [[ -f "${WEB_REPO_DIR}/next.config.ts" ]] && ! grep -q "standalone" "${WEB_REPO_DIR}/next.config.ts" 2>/dev/null; then
  warn "next.config.ts SEM output:'standalone' (Decisao 3.2)."; _prereq_fail=1
fi
if [[ -f "${WEB_REPO_DIR}/package.json" ]] && ! grep -q '"pg"' "${WEB_REPO_DIR}/package.json" 2>/dev/null; then
  warn "package.json SEM driver 'pg' (node-postgres) (Decisao 3.1 / lacuna 4)."; _prereq_fail=1
fi
if [[ -f "${WEB_REPO_DIR}/src/lib/storage/r2.ts" ]] && ! grep -q "R2_ENDPOINT" "${WEB_REPO_DIR}/src/lib/storage/r2.ts" 2>/dev/null; then
  warn "r2.ts SEM R2_ENDPOINT — getR2Client() quebra com MinIO (Decisao 3.3 / lacuna 3)."; _prereq_fail=1
fi
# next/font/google exige egress a fonts.gstatic.com no estagio builder -> quebra
# build OFFLINE. Deve estar migrado p/ next/font/local com o .woff2 versionado.
if [[ -f "${WEB_REPO_DIR}/src/app/layout.tsx" ]] && grep -q "next/font/google" "${WEB_REPO_DIR}/src/app/layout.tsx" 2>/dev/null; then
  warn "layout.tsx ainda usa next/font/google — build OFFLINE quebra (migre p/ next/font/local com .woff2 local)."; _prereq_fail=1
fi
if [[ "${_prereq_fail}" -eq 1 && "${ALLOW_MISSING_PREREQS:-0}" != "1" ]]; then
  die "Pre-requisitos do branch feat/onprem-prereqs ausentes (ver acima). Aplique-os ou rode com ALLOW_MISSING_PREREQS=1."
fi

PLAT_FLAG=""
[[ -n "${PLATFORM}" ]] && PLAT_FLAG="--platform ${PLATFORM}" && log "Plataforma alvo: ${PLATFORM}"

# ── Quais serviços construir ──────────────────────────────────────────────────
declare -a SERVICES
if [[ -n "${ONLY}" ]]; then
  IFS=',' read -r -a SERVICES <<< "${ONLY}"
else
  SERVICES=(web bff worker)
fi

# ── BUILD das imagens próprias (delega ao compose p/ herdar context + build args)
# O compose já carrega NEXT_PUBLIC_* como build args (Dockerfile.web). Por isso
# usamos `docker compose build` em vez de `docker build` solto.
# `docker compose build` NAO aceita --platform (compose v2 rejeita com 'unknown
# flag') — a plataforma vai via DOCKER_DEFAULT_PLATFORM. Os `docker build`/`docker
# pull` soltos abaixo seguem com ${PLAT_FLAG}, que eles aceitam normalmente.
log "Construindo imagens proprias: ${SERVICES[*]}"
# shellcheck disable=SC2086
DOCKER_DEFAULT_PLATFORM="${PLATFORM}" dc build ${NO_CACHE} ${PULL_BASE} "${SERVICES[@]}"
ok "Build das imagens proprias concluido."

# ── Imagem de MIGRATIONS (target builder do Dockerfile.web) ───────────────────
# Empacotamos uma imagem dedicada p/ o servidor rodar `make migrate` via
# `docker run` (sem `docker build`, que exigiria o source no servidor air-gapped).
# Buildada AQUI (maquina com source); incluida em BUILT_IMAGES -> save-images a
# salva e load-and-run a carrega/verifica. Pulada se --only nao incluir web.
if [[ -z "${ONLY}" || ",${ONLY}," == *",web,"* || ",${ONLY}," == *",migrate,"* ]]; then
  log "Construindo imagem de migrations: petro-radar/migrate:onprem (target builder)"
  # shellcheck disable=SC2086
  docker build ${NO_CACHE} ${PULL_BASE} ${PLAT_FLAG} \
    --target builder -t petro-radar/migrate:onprem \
    -f "${REPO_DIR}/Dockerfile.web" "${WEB_REPO_DIR}" \
    || die "build da imagem de migrate falhou (Dockerfile.web/target builder; source em ${WEB_REPO_DIR})."
  ok "Imagem de migrations construida."
fi

# ── PULL das imagens de terceiros ─────────────────────────────────────────────
if [[ "${SKIP_THIRD}" == "1" ]]; then
  warn "--skip-third: imagens de terceiros NAO foram baixadas (use só se já estão em cache)."
else
  log "Baixando imagens de terceiros (db/redis/minio/mc/es/embeddings)..."
  for img in "${THIRD_PARTY_IMAGES[@]}"; do
    log "  docker pull ${img}"
    # shellcheck disable=SC2086
    docker pull ${PLAT_FLAG} "${img}" >/dev/null || die "falha ao baixar ${img}"
    ok "  ${img}"
  done
fi

# ── Resumo: confirma presenca + ARQUITETURA de todas as imagens ──────────────
# Arquitetura errada (arm64 buildado no Mac) NAO roda no servidor x86 -> aborta.
hr
log "Verificando presenca + arquitetura de todas as imagens do PITSTOP:"
want_arch=""
case "${PLATFORM}" in
  linux/amd64|amd64) want_arch="amd64" ;;
  linux/arm64|arm64) want_arch="arm64" ;;
esac
missing=0
arch_bad=0
while IFS= read -r img; do
  if docker image inspect "${img}" >/dev/null 2>&1; then
    size="$(docker image inspect "${img}" --format '{{.Size}}' 2>/dev/null | awk '{printf "%.0fMB", $1/1048576}')"
    arch="$(docker image inspect "${img}" --format '{{.Architecture}}' 2>/dev/null || echo '?')"
    if [[ -n "${want_arch}" && "${arch}" != "${want_arch}" ]]; then
      warn "  ${img}  (${size})  ARCH=${arch} != ${want_arch} (NAO roda no servidor!)"
      arch_bad=$((arch_bad+1))
    else
      ok "  ${img}  (${size}, ${arch})"
    fi
  else
    warn "  AUSENTE: ${img}"
    missing=$((missing+1))
  fi
done < <(all_images)
if [[ "${arch_bad}" -gt 0 ]]; then
  die "${arch_bad} imagem(ns) com ARQUITETURA != ${want_arch}. Rebuilde com --platform=${PLATFORM} (ou ajuste BUILD_PLATFORM)."
fi

hr
if [[ "${missing}" -gt 0 ]]; then
  die "${missing} imagem(ns) ausente(s). Resolva antes de empacotar (save-images.sh)."
fi
ok "BUILD OK. Proximo passo: deploy/save-images.sh"
