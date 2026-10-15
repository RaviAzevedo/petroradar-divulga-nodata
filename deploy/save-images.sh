#!/usr/bin/env bash
# =============================================================================
# deploy/save-images.sh — PITSTOP passo 2/4: SERIALIZAR todas as imagens
# =============================================================================
# Faz `docker save` de TODAS as imagens (próprias + terceiros) num ÚNICO tar:
#   deploy/dist/images.tar
# É esse tar que vai dentro do bundle e que o servidor air-gapped carrega com
# `docker load` (load-and-run.sh). Sem isto, o servidor precisaria de internet
# para puxar pgvector/redis/minio/es/TEI — o que NÃO existe (objetivo PITSTOP).
#
# Gera também deploy/dist/images.list (lista exata salva) e images.tar.sha256.
#
# Flags:
#   --gzip          comprime → deploy/dist/images.tar.gz (bundle.sh detecta os dois)
#   --out=PATH      caminho de saída alternativo do tar
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

GZIP="0"
OUT="${DIST_DIR}/images.tar"
for arg in "$@"; do
  case "$arg" in
    --gzip)    GZIP="1" ;;
    --out=*)   OUT="${arg#--out=}" ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "argumento desconhecido: $arg" ;;
  esac
done

banner "PITSTOP 2/4 — SAVE IMAGES  (versao: $(pkg_version))"
require_docker
mkdir -p "${DIST_DIR}"

# ── Confere que TODAS as imagens existem localmente (idempotência: build antes) ─
log "Validando presenca local das imagens antes do save..."
declare -a TO_SAVE=()
missing=0
while IFS= read -r img; do
  if docker image inspect "${img}" >/dev/null 2>&1; then
    TO_SAVE+=("${img}")
  else
    warn "AUSENTE: ${img} — rode deploy/build.sh primeiro."
    missing=$((missing+1))
  fi
done < <(all_images)
[[ "${missing}" -eq 0 ]] || die "${missing} imagem(ns) ausente(s). Abortando save."

# ── Registra a lista exata salva (auditoria + carregamento no servidor) ───────
printf '%s\n' "${TO_SAVE[@]}" > "${DIST_DIR}/images.list"
ok "$(wc -l < "${DIST_DIR}/images.list" | tr -d ' ') imagens listadas em dist/images.list"

# ── docker save (um único arquivo com todas as imagens e camadas comuns) ──────
# Salvar tudo de uma vez deduplica camadas base compartilhadas → tar menor.
if [[ "${GZIP}" == "1" ]]; then
  OUT="${OUT%.tar}.tar.gz"
  log "Serializando (gzip) -> ${OUT}"
  docker save "${TO_SAVE[@]}" | gzip -c > "${OUT}"
else
  log "Serializando -> ${OUT}"
  docker save -o "${OUT}" "${TO_SAVE[@]}"
fi
ok "Imagens serializadas: ${OUT}  ($(human_size "${OUT}"))"

# ── Checksum (integridade na transferência p/ o servidor) ─────────────────────
sum="$(sha256_of "${OUT}")"
echo "${sum}  $(basename "${OUT}")" > "${OUT}.sha256"
ok "sha256: ${sum}"

hr
ok "SAVE OK. Proximo passo: deploy/bundle.sh"
