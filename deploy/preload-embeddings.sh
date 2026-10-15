#!/usr/bin/env bash
# =============================================================================
# deploy/preload-embeddings.sh — PITSTOP (opcional, AIR-GAP): pré-carregar BGE-m3
# =============================================================================
# Resolve a LACUNA do RAG em rede fechada (Decisão 1 + lacuna 11):
# na 1ª subida, o container `embeddings-local` (HuggingFace TEI) baixa o modelo
# BAAI/bge-m3 (~2.2 GB) do huggingface.co. Em DATACENTER SEM EGRESS isso QUEBRA.
#
# Este script roda na MÁQUINA DE EMPACOTAMENTO (com internet) e:
#   1) sobe o TEI uma vez, populando o volume nomeado petro-radar_embeddings_cache;
#   2) aguarda o /health ficar OK (download concluído);
#   3) exporta o conteúdo do volume para deploy/dist/embeddings_cache.tar(.gz).
#
# No servidor, load-and-run.sh restaura esse tar PARA o mesmo volume ANTES de
# subir a stack → o TEI encontra o modelo em cache e nunca toca a internet.
#
# Também emite a NOTA de WIRING para remover a rede `frontend` do serviço
# embeddings-local em air-gap estrito (ver no fim deste arquivo).
#
# Flags:
#   --gzip          comprime a saída (embeddings_cache.tar.gz)
#   --keep-up       não derruba o container TEI ao final (debug)
#   --timeout=SEG   espera máx. pelo /health (default 900s = 15 min)
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

GZIP="0"; KEEP_UP="0"; TIMEOUT="${PRELOAD_TIMEOUT:-900}"
for arg in "$@"; do
  case "$arg" in
    --gzip)      GZIP="1" ;;
    --keep-up)   KEEP_UP="1" ;;
    --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
    -h|--help)   grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "argumento desconhecido: $arg" ;;
  esac
done

banner "PITSTOP (opcional) — PRELOAD EMBEDDINGS BGE-m3 (air-gap)"
require_docker
mkdir -p "${DIST_DIR}"

# ALINHADO ao docker-compose.yml/_lib.sh (cpu-1.8): a 1.5 tinha hf-hub antigo
# (loop de redirect no download) e cache podia divergir do runtime.
TEI_IMAGE="ghcr.io/huggingface/text-embeddings-inference:cpu-1.8"
MODEL_ID="${EMBEDDING_MODEL:-BAAI/bge-m3}"
VOLUME="${COMPOSE_PROJECT}_embeddings_cache"   # nome real do volume nomeado
CNAME="petro-radar-preload-tei"
OUT="${DIST_DIR}/embeddings_cache.tar"

log "Modelo : ${MODEL_ID}"
log "Volume : ${VOLUME}"
log "Imagem : ${TEI_IMAGE}"

# Garante a imagem do TEI presente (build.sh já faz o pull; aqui é defensivo).
docker image inspect "${TEI_IMAGE}" >/dev/null 2>&1 || {
  log "Imagem TEI ausente localmente — baixando..."
  docker pull "${TEI_IMAGE}" >/dev/null || die "falha ao baixar ${TEI_IMAGE}"
}

# Cria o volume (idempotente) e remove container órfão de execução anterior.
docker volume create "${VOLUME}" >/dev/null
docker rm -f "${CNAME}" >/dev/null 2>&1 || true

cleanup() { [[ "${KEEP_UP}" == "1" ]] || docker rm -f "${CNAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Sobe o TEI apontando o cache para o volume; ele baixa o modelo e fica HEALTHY.
log "Subindo TEI para popular o cache (download ~2.2GB, pode demorar)..."
docker run -d --name "${CNAME}" \
  -e HUGGINGFACE_HUB_CACHE=/data \
  -v "${VOLUME}:/data" \
  -p 127.0.0.1:18080:80 \
  "${TEI_IMAGE}" --model-id "${MODEL_ID}" --port 80 >/dev/null

# Espera o /health (download concluído) com timeout — sem `sleep` solto longo.
log "Aguardando /health (timeout ${TIMEOUT}s)..."
deadline=$(( $(date +%s) + TIMEOUT ))
until curl -fsS "http://127.0.0.1:18080/health" >/dev/null 2>&1; do
  if [[ $(date +%s) -ge ${deadline} ]]; then
    docker logs --tail 40 "${CNAME}" || true
    die "TEI nao ficou healthy em ${TIMEOUT}s (download do modelo falhou?)."
  fi
  sleep 5
  printf '.'
done
printf '\n'; ok "Modelo baixado e TEI saudavel."

# Exporta o conteúdo do volume para um tar (via container alpine efêmero).
if [[ "${GZIP}" == "1" ]]; then OUT="${OUT}.gz"; fi
log "Exportando volume '${VOLUME}' -> ${OUT}"
if [[ "${GZIP}" == "1" ]]; then
  docker run --rm -v "${VOLUME}:/data:ro" -v "${DIST_DIR}:/out" alpine \
    sh -c 'cd /data && tar czf /out/embeddings_cache.tar.gz .'
else
  docker run --rm -v "${VOLUME}:/data:ro" -v "${DIST_DIR}:/out" alpine \
    sh -c 'cd /data && tar cf /out/embeddings_cache.tar .'
fi
ok "Cache exportado: ${OUT}  ($(human_size "${OUT}"))"

sum="$(sha256_of "${OUT}")"
echo "${sum}  $(basename "${OUT}")" > "${OUT}.sha256"
ok "sha256: ${sum}"

cat <<'NOTA'

────────────────────────────────────────────────────────────────────────────
 WIRING NECESSARIO — air-gap ESTRITO (remover egress do embeddings-local)
────────────────────────────────────────────────────────────────────────────
 Com o cache pré-carregado, o serviço NÃO precisa mais da rede 'frontend'
 (egress p/ huggingface.co). Em docker-compose.yml, no serviço
 'embeddings-local', troque:

     networks: [frontend, backend]
 por:
     networks: [backend]

 (NÃO editado automaticamente — é override consciente. Mantenha 'frontend'
  apenas se quiser que a 1a subida ainda possa baixar caso o cache falte.)
────────────────────────────────────────────────────────────────────────────
NOTA

hr
ok "PRELOAD OK. O bundle.sh incluira dist/embeddings_cache.tar se existir."
