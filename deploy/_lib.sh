#!/usr/bin/env bash
# =============================================================================
# deploy/_lib.sh — Biblioteca compartilhada dos scripts PITSTOP
# =============================================================================
# NÃO executar diretamente. É carregado via `source` pelos demais scripts
# (build.sh, save-images.sh, bundle.sh, preload-embeddings.sh, load-and-run.sh).
#
# Centraliza: descoberta de caminhos, lista canônica de imagens, helpers de
# log, checagens de pré-requisitos e versionamento — para que todos os scripts
# do PITSTOP falem a MESMA verdade (DRY). Se algo mudar no docker-compose.yml
# (uma imagem nova), basta atualizar AQUI.
# =============================================================================
set -euo pipefail

# ─── Resolução de caminhos (robusta a symlink e a chamada de qualquer cwd) ────
# DEPLOY_DIR = .../petro-radar-onprem/deploy   |  REPO_DIR = .../petro-radar-onprem
_lib_self="${BASH_SOURCE[0]}"
DEPLOY_DIR="$(cd "$(dirname "${_lib_self}")" >/dev/null 2>&1 && pwd)"
REPO_DIR="$(cd "${DEPLOY_DIR}/.." >/dev/null 2>&1 && pwd)"
DIST_DIR="${DEPLOY_DIR}/dist"
# Base do app Next (build context do web/bff/migrate). É o MESMO que o
# docker-compose.yml usa em web.build.context (./app — branch
# feat/onprem-prereqs). Override via env WEB_REPO_DIR.
WEB_REPO_DIR="${WEB_REPO_DIR:-${REPO_DIR}/app}"

export DEPLOY_DIR REPO_DIR DIST_DIR WEB_REPO_DIR

# ─── Nome do projeto compose (precisa casar com `name:` do compose) ───────────
# Volumes nomeados ganham o prefixo "<COMPOSE_PROJECT>_": petro-radar_pg_data etc.
COMPOSE_PROJECT="${COMPOSE_PROJECT:-petro-radar}"
export COMPOSE_PROJECT

# ─── docker compose: usa --env-file quando o .env.onprem existir ──────────────
# No EMPACOTAMENTO (máquina de build) o .env pode não existir → cai p/ compose puro.
# Usa array (não string) para sobreviver a caminhos com espaço e ao caso vazio.
_compose_args=()
if [[ -f "${REPO_DIR}/.env.onprem" ]]; then
  _compose_args=(--env-file "${REPO_DIR}/.env.onprem")
fi
dc() { ( cd "${REPO_DIR}" && docker compose "${_compose_args[@]}" "$@" ); }

# ─── Imagens construídas localmente (definidas no compose, tag fixa :onprem) ──
BUILT_IMAGES=(
  "petro-radar/web:onprem"
  "petro-radar/bff:onprem"
  "petro-radar/worker:onprem"
  # Imagem de MIGRATIONS = target `builder` do Dockerfile.web (tem tsx + src +
  # node_modules + as migrations). Empacotada p/ o servidor rodar `make migrate`
  # SEM `docker build` (que exigiria o source). Ver Makefile:migrate.
  "petro-radar/migrate:onprem"
)

# ─── Imagens de TERCEIROS (puxadas de registries públicos) ────────────────────
# Mantenha SINCRONIZADO com `grep image: docker-compose.yml`.
# minio/mc é o "createbuckets" (job efêmero) — precisa ir no tar também.
THIRD_PARTY_IMAGES=(
  "pgvector/pgvector:pg16"
  "redis:7-alpine"
  "minio/minio:latest"
  "minio/mc:latest"
  "ghcr.io/huggingface/text-embeddings-inference:cpu-1.8"
  # Utilitarias dos scripts (NAO estao no compose, mas o servidor air-gapped
  # precisa delas): alpine p/ restaurar embeddings_cache/rollback de volumes
  # (load-and-run.sh) e alpine/openssl p/ o fallback do gen-cert.sh.
  "alpine:3.20"
  "alpine/openssl:latest"
)

# União usada por save-images.sh / load-and-run.sh.
all_images() { printf '%s\n' "${BUILT_IMAGES[@]}" "${THIRD_PARTY_IMAGES[@]}"; }

# ─── Versão do pacote ─────────────────────────────────────────────────────────
# Prioriza VERSION env > deploy/VERSION > git describe > data UTC.
pkg_version() {
  if [[ -n "${VERSION:-}" ]]; then echo "${VERSION}"; return; fi
  if [[ -f "${DEPLOY_DIR}/VERSION" ]]; then
    tr -d ' \t\n\r' < "${DEPLOY_DIR}/VERSION"; return
  fi
  if git -C "${REPO_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "${REPO_DIR}" describe --tags --always --dirty 2>/dev/null && return || true
  fi
  date -u +"%Y%m%d-%H%M%S"
}

# ─── Helpers de log (com cor quando TTY) ──────────────────────────────────────
if [[ -t 1 ]]; then
  C_RST=$'\033[0m'; C_BLU=$'\033[34m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_BLD=$'\033[1m'
else
  C_RST=''; C_BLU=''; C_GRN=''; C_YEL=''; C_RED=''; C_BLD=''
fi
log()   { printf '%s[ %s ]%s %s\n' "${C_BLU}" "$(date +%H:%M:%S)" "${C_RST}" "$*"; }
ok()    { printf '%s  ✓ %s%s\n' "${C_GRN}" "$*" "${C_RST}"; }
warn()  { printf '%s  ! %s%s\n' "${C_YEL}" "$*" "${C_RST}" >&2; }
die()   { printf '%s  ✗ %s%s\n' "${C_RED}" "$*" "${C_RST}" >&2; exit 1; }
hr()    { printf '%s──────────────────────────────────────────────────────────────%s\n' "${C_BLD}" "${C_RST}"; }
banner(){ hr; printf '%s  %s%s\n' "${C_BLD}" "$*" "${C_RST}"; hr; }

# ─── Pré-requisitos ───────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || die "comando obrigatorio ausente: '$1'"; }
require_docker() {
  need docker
  docker info >/dev/null 2>&1 || die "Docker daemon nao esta acessivel (rode 'docker info')."
  docker compose version >/dev/null 2>&1 || die "plugin 'docker compose' (v2) ausente."
}

# ─── sha256 portável (Linux: sha256sum | macOS: shasum -a 256) ────────────────
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else die "nem sha256sum nem shasum disponiveis"; fi
}

# Tamanho legível de arquivo, portável.
human_size() { du -h "$1" 2>/dev/null | awk '{print $1}'; }
