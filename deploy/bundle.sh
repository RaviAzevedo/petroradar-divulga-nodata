#!/usr/bin/env bash
# =============================================================================
# deploy/bundle.sh — PITSTOP passo 3/4: MONTAR o pacote offline final
# =============================================================================
# Empacota TUDO o que o servidor air-gapped precisa num único .tar.gz:
#   deploy/dist/petro-radar-onprem-<versao>.tar.gz
#
# Conteúdo (estrutura espelha o que load-and-run.sh espera):
#   petro-radar-onprem-<versao>/
#     ├── images.tar                 (de save-images.sh — todas as imagens)
#     ├── images.list                (lista exata p/ verificacao pos-load)
#     ├── images.tar.sha256
#     ├── embeddings_cache.tar[.gz]  (de preload-embeddings.sh, se existir)
#     ├── docker-compose.yml
#     ├── .env.onprem.template       (renomeado de .env.onprem.example)
#     ├── Makefile
#     ├── db/init/                   (01-extensions.sql)
#     ├── nginx/                     (conf.d/petro-radar.conf — estrangulador)
#     ├── scripts/                   (bootstrap.sh)
#     ├── deploy/                    (load-and-run.sh + _lib.sh + README.md)
#     ├── VERSION
#     └── MANIFEST.txt + SHA256SUMS  (auditoria/integridade)
#
# NÃO inclui: o repo do app (já está dentro das imagens), backups/, .env real.
#
# Pré-requisito: rodar build.sh + save-images.sh antes (images.tar tem que existir).
# Opcional: preload-embeddings.sh (embeddings_cache.tar) para air-gap.
#
# Flags:
#   --no-docs       (sem efeito; mantida por compatibilidade — o repo nao traz docs/)
#   --out=PATH      caminho do .tar.gz final
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

OUT=""
for arg in "$@"; do
  case "$arg" in
    --no-docs) : ;;   # no-op (compatibilidade)
    --out=*)   OUT="${arg#--out=}" ;;
    -h|--help) grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "argumento desconhecido: $arg" ;;
  esac
done

VER="$(pkg_version)"
banner "PITSTOP 3/4 — BUNDLE  (versao: ${VER})"
mkdir -p "${DIST_DIR}"

# ── images.tar é obrigatório (aceita .tar ou .tar.gz) ─────────────────────────
IMAGES_TAR=""
if   [[ -f "${DIST_DIR}/images.tar" ]];    then IMAGES_TAR="${DIST_DIR}/images.tar";
elif [[ -f "${DIST_DIR}/images.tar.gz" ]]; then IMAGES_TAR="${DIST_DIR}/images.tar.gz";
else die "images.tar(.gz) ausente em dist/. Rode deploy/save-images.sh primeiro."; fi
ok "Imagens: $(basename "${IMAGES_TAR}")  ($(human_size "${IMAGES_TAR}"))"

# ── Área de staging temporária ────────────────────────────────────────────────
STAGE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/petro-bundle.XXXXXX")"
PKG="petro-radar-onprem-${VER}"
STAGE="${STAGE_ROOT}/${PKG}"
mkdir -p "${STAGE}"
cleanup() { rm -rf "${STAGE_ROOT}"; }
trap cleanup EXIT

copy_in() { # copy_in <src-relativo-ao-REPO> [obrigatorio?]
  local src="${REPO_DIR}/$1" dest="${STAGE}/$1" req="${2:-1}"
  if [[ -e "${src}" ]]; then
    mkdir -p "$(dirname "${dest}")"
    cp -R "${src}" "${dest}"
    ok "  + $1"
  elif [[ "${req}" == "1" ]]; then
    die "arquivo obrigatorio ausente no scaffold: $1"
  else
    warn "  (opcional ausente) $1"
  fi
}

log "Montando staging em ${STAGE}"

# 1) Imagens + lista + checksum
cp "${IMAGES_TAR}" "${STAGE}/$(basename "${IMAGES_TAR}")"
[[ -f "${IMAGES_TAR}.sha256" ]] && cp "${IMAGES_TAR}.sha256" "${STAGE}/"
[[ -f "${DIST_DIR}/images.list" ]] && cp "${DIST_DIR}/images.list" "${STAGE}/"
ok "  + $(basename "${IMAGES_TAR}") (+ .sha256 / images.list)"

# 2) Cache de embeddings (air-gap) — opcional
if   [[ -f "${DIST_DIR}/embeddings_cache.tar.gz" ]]; then
  cp "${DIST_DIR}/embeddings_cache.tar.gz"* "${STAGE}/" ; ok "  + embeddings_cache.tar.gz (air-gap)"
elif [[ -f "${DIST_DIR}/embeddings_cache.tar" ]]; then
  cp "${DIST_DIR}/embeddings_cache.tar"* "${STAGE}/" ; ok "  + embeddings_cache.tar (air-gap)"
else
  warn "  embeddings_cache ausente — TEI baixara o modelo na 1a subida (precisa egress). Rode preload-embeddings.sh p/ air-gap."
fi

# 2b) Blobs R2->MinIO (CRITICO #5) — opcional. Se pack-data.sh gerou o tarball em
# dist/, embute-o no pacote (air-gap). Senao, transfira-o separado e passe
# --restore-blobs ao load-and-run.sh.
if [[ -f "${DIST_DIR}/petro-radar-blobs.tgz" ]]; then
  cp "${DIST_DIR}/petro-radar-blobs.tgz"* "${STAGE}/" ; ok "  + petro-radar-blobs.tgz (blobs R2->MinIO)"
else
  warn "  petro-radar-blobs.tgz ausente — rode scripts/pitstop/pack-data.sh (com credenciais R2) p/ air-gap dos /download."
fi

# 3) Infra do compose
copy_in "docker-compose.yml"
copy_in "docker-compose.airgap.yml" 0   # overlay air-gap estrito (load-and-run --airgap)
copy_in "Makefile"
copy_in "db/init"
copy_in "nginx"
copy_in "scripts"
# shared/ai-contract.json: o BFF o monta em /shared (ver docker-compose bff.volumes).
# SEM isto no bundle, o bind nao teria fonte no servidor e o include_migrated
# derrubaria TODAS as rotas /api (auditoria 2026-07, C-01). OBRIGATORIO.
copy_in "shared"
# (elasticsearch/ REMOVIDO do bundle em 2026-07-02 junto com o servico.)
# Dockerfile.web vai opcional: serve apenas de fallback de build da imagem de
# migrate em DEV; no servidor a imagem ja vem carregada (BUILT_IMAGES).
copy_in "Dockerfile.web" 0

# 4) deploy/: load-and-run.sh + lib + README (os de empacotamento NÃO vão).
mkdir -p "${STAGE}/deploy"
for f in load-and-run.sh _lib.sh README.md; do
  [[ -f "${DEPLOY_DIR}/${f}" ]] && { cp "${DEPLOY_DIR}/${f}" "${STAGE}/deploy/"; ok "  + deploy/${f}"; } \
    || warn "  deploy/${f} ausente (sera necessario no servidor)."
done

# 5) .env.onprem.template (a partir do .example; NUNCA o .env real)
if [[ -f "${REPO_DIR}/.env.onprem.example" ]]; then
  cp "${REPO_DIR}/.env.onprem.example" "${STAGE}/.env.onprem.template"
  ok "  + .env.onprem.template"
else
  die ".env.onprem.example ausente — necessario como template de segredos."
fi
# Guarda de segurança: jamais empacotar segredos reais.
[[ -f "${REPO_DIR}/.env.onprem" ]] && warn "Existe .env.onprem REAL no repo — NAO sera incluido (apenas o .template)."

# 6) VERSION
echo "${VER}" > "${STAGE}/VERSION"

# ── MANIFEST + SHA256SUMS (auditoria/integridade do conteúdo) ─────────────────
log "Gerando MANIFEST.txt e SHA256SUMS..."
( cd "${STAGE}" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.txt | sort > MANIFEST.txt )
(
  cd "${STAGE}"
  : > SHA256SUMS
  while IFS= read -r f; do
    f="${f#./}"
    [[ "${f}" == "MANIFEST.txt" || "${f}" == "SHA256SUMS" ]] && continue
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "${f}";
    else shasum -a 256 "${f}"; fi
  done < <(find . -type f | sed 's|^\./||' | sort) >> SHA256SUMS
)
ok "Manifesto e checksums gerados."

# ── tar.gz final ──────────────────────────────────────────────────────────────
[[ -n "${OUT}" ]] || OUT="${DIST_DIR}/${PKG}.tar.gz"
log "Compactando -> ${OUT}"
( cd "${STAGE_ROOT}" && tar czf "${OUT}" "${PKG}" )
ok "Pacote PITSTOP: ${OUT}  ($(human_size "${OUT}"))"

# Checksum do pacote inteiro (verificacao na transferencia ao servidor).
sum="$(sha256_of "${OUT}")"
echo "${sum}  $(basename "${OUT}")" > "${OUT}.sha256"
ok "sha256: ${sum}"

hr
cat <<EOF
 ${C_BLD}PITSTOP pronto.${C_RST} Transfira para o servidor da Proponente:
   • ${OUT}
   • ${OUT}.sha256
 No servidor:
   sha256sum -c $(basename "${OUT}").sha256
   tar xzf $(basename "${OUT}")
   cd ${PKG}
   cp .env.onprem.template .env.onprem   # preencha os segredos
   ./deploy/load-and-run.sh
EOF
hr
ok "BUNDLE OK. Proximo passo (no servidor): deploy/load-and-run.sh"
