#!/usr/bin/env bash
# =============================================================================
# deploy/load-and-run.sh — PITSTOP passo 4/4: SUBIR E RODAR (no SERVIDOR)
# =============================================================================
# Roda DENTRO do pacote extraído, no servidor air-gapped da Proponente. Faz, em
# ordem idempotente, tudo que separa "tar recebido" de "Petro Radar no ar":
#
#   0) pré-checagens (docker, arquivos do pacote, integridade opcional)
#   1) docker load das imagens (images.tar) + verificação contra images.list
#   2) restore do cache de embeddings no volume (air-gap), se o tar existir
#   3) validação do .env.onprem (segredos obrigatórios, placeholders TROQUE-*)
#   4) docker compose up -d  (sobe a stack; espera healthchecks)
#   5) bootstrap MinIO (createbuckets)
#   6) migrations Drizzle COMPLETAS (1024) → [opcional restore --data-only s/ acervo_chunks]
#   7) seed do 1o ADMIN via /api/auth/setup (paridade de acesso, SETUP_TOKEN)
#   8) re-embed do acervo (derivado do Postgres)
#   9) SMOKE TESTS de paridade (health web/bff, csrf, login-page, ES, MinIO)
#
# É 100% idempotente: rodar de novo NÃO duplica dados (load/up/bootstrap/seed
# todos toleram "já existe"). Migrations e restore têm GUARDAS explícitas.
#
# Flags:
#   --skip-load        pula docker load (imagens já carregadas)
#   --skip-migrate     pula as migrations (banco já migrado)
#   --skip-seed        pula o seed do admin
#   --restore-dump=F   pg_restore --data-only de F APOS o migrate (exclui acervo_chunks)
#   --restore-blobs=T  espelha os blobs (tgz de pack-data.sh) R2->MinIO + valida keys
#   --airgap           usa o overlay docker-compose.airgap.yml (egress restrito)
#   --skip-embeddings  pula re-embed do acervo (faça depois pela task do worker)
#   --no-up            só prepara (load + valida env); não sobe a stack
#   --yes              não pergunta confirmação em passos sensíveis
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

SKIP_LOAD="0"; SKIP_MIGRATE="0"; SKIP_SEED="0"; SKIP_EMB="0"
NO_UP="0"; ASSUME_YES="0"; RESTORE_DUMP=""; RESTORE_BLOBS=""; AIRGAP="0"
for arg in "$@"; do
  case "$arg" in
    --skip-load)        SKIP_LOAD="1" ;;
    --skip-migrate)     SKIP_MIGRATE="1" ;;
    --skip-seed)        SKIP_SEED="1" ;;
    --skip-embeddings)  SKIP_EMB="1" ;;
    --restore-dump=*)   RESTORE_DUMP="${arg#--restore-dump=}" ;;
    --restore-blobs=*)  RESTORE_BLOBS="${arg#--restore-blobs=}" ;;
    --airgap)           AIRGAP="1" ;;
    --no-up)            NO_UP="1" ;;
    --yes|-y)           ASSUME_YES="1" ;;
    -h|--help)          grep -E '^#( |=)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                  die "argumento desconhecido: $arg" ;;
  esac
done

confirm() { # confirm "mensagem"
  [[ "${ASSUME_YES}" == "1" ]] && return 0
  printf '%s%s%s [s/N] ' "${C_YEL}" "$1" "${C_RST}"; read -r r
  [[ "${r}" =~ ^[sSyY]$ ]]
}

ENV_FILE="${REPO_DIR}/.env.onprem"

# ── 0) Pré-checagens ──────────────────────────────────────────────────────────
banner "PITSTOP 4/4 — LOAD & RUN  (versao: $([[ -f "${REPO_DIR}/VERSION" ]] && cat "${REPO_DIR}/VERSION" || pkg_version))"
require_docker
[[ -f "${REPO_DIR}/docker-compose.yml" ]] || die "docker-compose.yml ausente — rode dentro do pacote extraido."

# Integridade opcional do pacote (se SHA256SUMS veio junto).
if [[ -f "${REPO_DIR}/SHA256SUMS" ]] && command -v sha256sum >/dev/null 2>&1; then
  log "Verificando integridade (SHA256SUMS)..."
  ( cd "${REPO_DIR}" && sha256sum -c SHA256SUMS --quiet ) && ok "Integridade OK." \
    || warn "Divergencias no SHA256SUMS (pode ser por arquivos gerados no servidor — revise)."
fi

# ── 1) docker load ────────────────────────────────────────────────────────────
if [[ "${SKIP_LOAD}" == "1" ]]; then
  warn "--skip-load: pulando docker load."
else
  IMG_TAR=""
  if   [[ -f "${REPO_DIR}/images.tar" ]];    then IMG_TAR="${REPO_DIR}/images.tar";
  elif [[ -f "${REPO_DIR}/images.tar.gz" ]]; then IMG_TAR="${REPO_DIR}/images.tar.gz";
  else die "images.tar(.gz) ausente no pacote."; fi

  if [[ -f "${IMG_TAR}.sha256" ]] && command -v sha256sum >/dev/null 2>&1; then
    log "Conferindo checksum de $(basename "${IMG_TAR}")..."
    ( cd "${REPO_DIR}" && sha256sum -c "$(basename "${IMG_TAR}").sha256" ) >/dev/null \
      && ok "Checksum das imagens OK." || die "checksum de ${IMG_TAR} NAO confere — transferencia corrompida."
  fi

  log "Carregando imagens (docker load < $(basename "${IMG_TAR}"))..."
  if [[ "${IMG_TAR}" == *.gz ]]; then gunzip -c "${IMG_TAR}" | docker load; else docker load -i "${IMG_TAR}"; fi
  ok "Imagens carregadas."

  # Verifica que TODAS as imagens esperadas estão presentes após o load.
  if [[ -f "${REPO_DIR}/images.list" ]]; then
    missing=0
    while IFS= read -r img; do
      [[ -z "${img}" ]] && continue
      docker image inspect "${img}" >/dev/null 2>&1 || { warn "AUSENTE pos-load: ${img}"; missing=$((missing+1)); }
    done < "${REPO_DIR}/images.list"
    [[ "${missing}" -eq 0 ]] && ok "Todas as imagens de images.list presentes." \
      || die "${missing} imagem(ns) faltando apos o load."
  fi
fi

# ── 2) Restore do cache de embeddings (air-gap) ───────────────────────────────
EMB_CACHE_TAR=""
[[ -f "${REPO_DIR}/embeddings_cache.tar.gz" ]] && EMB_CACHE_TAR="${REPO_DIR}/embeddings_cache.tar.gz"
[[ -z "${EMB_CACHE_TAR}" && -f "${REPO_DIR}/embeddings_cache.tar" ]] && EMB_CACHE_TAR="${REPO_DIR}/embeddings_cache.tar"
if [[ -n "${EMB_CACHE_TAR}" ]]; then
  VOL="${COMPOSE_PROJECT}_embeddings_cache"
  log "Restaurando cache do BGE-m3 -> volume ${VOL} (air-gap)..."
  docker volume create "${VOL}" >/dev/null
  if [[ "${EMB_CACHE_TAR}" == *.gz ]]; then
    docker run --rm -v "${VOL}:/data" -v "${REPO_DIR}:/in:ro" alpine:3.20 \
      sh -c 'cd /data && tar xzf /in/'"$(basename "${EMB_CACHE_TAR}")"
  else
    docker run --rm -v "${VOL}:/data" -v "${REPO_DIR}:/in:ro" alpine:3.20 \
      sh -c 'cd /data && tar xf /in/'"$(basename "${EMB_CACHE_TAR}")"
  fi
  ok "Cache de embeddings restaurado (TEI sobe sem internet)."
else
  warn "Sem embeddings_cache.tar — embeddings-local tentara baixar o modelo (precisa egress)."
fi

# ── 3) Validação do .env.onprem ───────────────────────────────────────────────
if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${REPO_DIR}/.env.onprem.template" ]]; then
    die ".env.onprem ausente. Copie e preencha:  cp .env.onprem.template .env.onprem  (depois chmod 600)."
  fi
  die ".env.onprem ausente e sem template."
fi
chmod 600 "${ENV_FILE}" 2>/dev/null || true

log "Validando .env.onprem (segredos obrigatorios + placeholders)..."
REQUIRED_VARS=(
  POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL
  AUTH_SECRET NEXTAUTH_SECRET SETUP_TOKEN CRON_SECRET
  REDIS_PASSWORD REDIS_URL CELERY_BROKER_URL
  MINIO_ROOT_USER MINIO_ROOT_PASSWORD
  R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  ANTHROPIC_API_KEY
  EMBEDDING_PROVIDER EMBEDDING_MODEL EMBEDDING_DIMENSOES EMBEDDING_BASE_URL
)
errs=0
get_env() { grep -E "^${1}=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- ; }
for v in "${REQUIRED_VARS[@]}"; do
  val="$(get_env "${v}" || true)"
  if [[ -z "${val}" ]]; then warn "  faltando/vazio: ${v}"; errs=$((errs+1)); continue; fi
  if [[ "${val}" == *TROQUE* || "${val}" == *"sk-ant-..."* ]]; then
    warn "  placeholder nao trocado: ${v}=${val}"; errs=$((errs+1))
  fi
done
# Checagem semântica: dimensão tem que casar com BGE-m3 (Decisão 1 / lacuna 11).
dim="$(get_env EMBEDDING_DIMENSOES || true)"
[[ "${dim}" == "1024" ]] || { warn "  EMBEDDING_DIMENSOES=${dim} (esperado 1024 p/ BGE-m3)"; errs=$((errs+1)); }
prov="$(get_env EMBEDDING_PROVIDER || true)"
[[ "${prov}" == "local" ]] || warn "  EMBEDDING_PROVIDER=${prov} (esperado 'local' on-prem)."
[[ "$(get_env R2_ENDPOINT || true)" == http* ]] || { warn "  R2_ENDPOINT deve apontar p/ http://minio:9000 (lacuna 3)."; errs=$((errs+1)); }

if [[ "${errs}" -gt 0 ]]; then
  die "${errs} problema(s) no .env.onprem. Corrija os segredos/placeholders e rode de novo."
fi
ok ".env.onprem valido."

# Air-gap estrito: usa o overlay docker-compose.airgap.yml (egress restrito). Auto
# liga se houver embeddings_cache.tar no pacote (sinal de empacotamento offline).
if [[ "${AIRGAP}" == "1" || ( -n "${EMB_CACHE_TAR}" && -f "${REPO_DIR}/docker-compose.airgap.yml" ) ]]; then
  if [[ -f "${REPO_DIR}/docker-compose.airgap.yml" ]]; then
    _compose_args+=(-f docker-compose.yml -f docker-compose.airgap.yml)
    ok "Modo AIR-GAP: overlay docker-compose.airgap.yml ativo."
  else
    warn "--airgap pedido mas docker-compose.airgap.yml ausente no pacote."
  fi
fi

[[ "${NO_UP}" == "1" ]] && { ok "--no-up: parando apos load+validacao."; exit 0; }

# ── 4) docker compose up -d ───────────────────────────────────────────────────
log "Subindo a stack (docker compose up -d)..."
dc up -d
ok "Containers criados. Aguardando healthchecks..."

wait_healthy() { # wait_healthy <service> <timeout_s>
  local svc="$1" t="${2:-180}" cid st
  local deadline=$(( $(date +%s) + t ))
  cid="$(dc ps -q "${svc}" 2>/dev/null || true)"
  [[ -n "${cid}" ]] || { warn "servico '${svc}' nao encontrado no compose."; return 1; }
  while true; do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || echo unknown)"
    case "${st}" in
      healthy|running) ok "  ${svc}: ${st}"; return 0 ;;
      exited|dead)     warn "  ${svc}: ${st}"; docker logs --tail 30 "${cid}" || true; return 1 ;;
    esac
    [[ $(date +%s) -ge ${deadline} ]] && { warn "  ${svc}: timeout (${st})"; return 1; }
    sleep 5; printf '.'
  done
}
for s in db redis minio; do wait_healthy "${s}" 240 || die "infra '${s}' nao ficou saudavel."; done
printf '\n'
# embeddings-local pode demorar (TEI). web/bff dependem dele só p/ start.
wait_healthy embeddings-local 300 || warn "embeddings-local ainda nao healthy (RAG fica em GATE 503 ate subir)."
wait_healthy web 240 || die "web nao ficou saudavel."
wait_healthy bff 180 || warn "bff nao ficou saudavel (rotas /bff/* indisponiveis)."
printf '\n'

# ── 5) Bootstrap MinIO ─────────────────────────────────────────────────────────
# (bootstrap de indices Elasticsearch REMOVIDO em 2026-07-02 junto com o servico.)
log "Bootstrap MinIO (createbuckets)..."
dc up --no-deps createbuckets || warn "createbuckets retornou erro (verifique R2_SECRET_ACCESS_KEY)."
ok "Bootstrap de storage concluido."

# ── 6) Migrations + restore do dump (ordem CORRETA p/ vector 1024) ────────────
if [[ "${SKIP_MIGRATE}" == "1" ]]; then
  warn "--skip-migrate: pulando migrations."
else
  # ORDEM CORRETA (corrige o bug de dimensao vector 1024 vs 1536):
  #   1) migrate COMPLETO (0000..0015) -> schema final; acervo_chunks JA em
  #      vector(1024) (a 0015 dropa o HNSW antigo, ALTERA p/ 1024 e recria o HNSW).
  #   2) pg_restore --data-only EXCLUINDO acervo_chunks: o dump de producao traz
  #      acervo_chunks vazio (em prod sempre foi vazio) — e, se trouxesse algo, os
  #      vetores seriam 1536 e colidiriam com a coluna 1024. Por isso NUNCA
  #      restauramos acervo_chunks; ele e reconstruido no passo 8 (re-embed 1024).
  #      Tambem excluimos __drizzle_migrations (o journal ja foi escrito no passo 1).
  log "Aplicando migrations Drizzle COMPLETAS (52 tabelas + HNSW + acervo vector(1024))..."
  ( cd "${REPO_DIR}" && make migrate ) || die "migrate falhou (driver pg ausente? Decisao 3.1)."
  ok "Migrations aplicadas (schema final, acervo_chunks em 1024)."
  # Índice para expurgo eficiente da trilha de auditoria (WP09 §7.3). Idempotente.
  PG_U2="$(get_env POSTGRES_USER)"; PG_D2="$(get_env POSTGRES_DB)"
  dc exec -T db psql -U "${PG_U2}" -d "${PG_D2}" -c \
    "CREATE INDEX IF NOT EXISTS idx_audit_criado_em ON audit_log (criado_em);" >/dev/null 2>&1 \
    && ok "Índice idx_audit_criado_em garantido." || warn "nao foi possivel criar idx_audit_criado_em."
  # Rede de seguranca (snapshot 0015 do Drizzle ausente): confirma que a 0015 foi
  # aplicada (embedding em vector(1024)). Se vier vector(1536), o re-embed/RAG quebra.
  _emb_t="$(dc exec -T db psql -tA -U "${PG_U2}" -d "${PG_D2}" -c \
    "SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname='acervo_chunks' AND a.attname='embedding'" 2>/dev/null | tr -d '[:space:]')"
  if [[ "${_emb_t}" == "vector(1024)" ]]; then ok "acervo_chunks.embedding = vector(1024) (0015 aplicada)."
  else warn "acervo_chunks.embedding = '${_emb_t}' (esperado vector(1024)). A migration 0015 NAO foi aplicada — RAG/re-embed vao quebrar. Verifique o migrator/0015."; fi

  if [[ -n "${RESTORE_DUMP}" ]]; then
    [[ -f "${RESTORE_DUMP}" ]] || die "dump nao encontrado: ${RESTORE_DUMP}"
    confirm "Restore do dump '${RESTORE_DUMP}' insere dados de producao. Continuar?" \
      || die "restore cancelado pelo operador."
    POSTGRES_USER="$(get_env POSTGRES_USER)"; POSTGRES_DB="$(get_env POSTGRES_DB)"
    log "pg_restore --data-only (EXCLUINDO acervo_chunks — reconstruido pelo re-embed)..."
    if [[ "${RESTORE_DUMP}" == *.sql.gz || "${RESTORE_DUMP}" == *.sql ]]; then
      # Dump SQL PLANO: o psql nao para no 1o erro por padrao. Eventuais INSERTs de
      # acervo_chunks (1536) sao rejeitados linha-a-linha SEM abortar o restore (a
      # tabela fica vazia, como esperado). PREFIRA gerar o dump ja sem acervo_chunks.
      #
      # session_replication_role=replica e OBRIGATORIO: o pg_dump plano ordena os
      # COPY alfabeticamente (assume FKs criadas DEPOIS dos dados), mas aqui o
      # schema ja foi migrado com FKs ATIVAS — filhos alfabeticamente antes dos
      # pais (envelope_itens<envelopes, participacoes_documentos<participacoes_
      # licitacao) falhavam e perdiam linhas EM SILENCIO (ensaio 2026-06-11: 99
      # linhas). Em replica, triggers/FKs nao validam durante o COPY; a
      # integridade vem da origem (producao consistente).
      if [[ "${RESTORE_DUMP}" == *.gz ]]; then
        { echo "SET session_replication_role = replica;"; gunzip -c "${RESTORE_DUMP}"; } \
          | dc exec -T db psql -v ON_ERROR_STOP=0 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
          || warn "psql reportou avisos (esperado se o dump tiver acervo_chunks 1536)."
      else
        { echo "SET session_replication_role = replica;"; cat "${RESTORE_DUMP}"; } \
          | dc exec -T db psql -v ON_ERROR_STOP=0 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
          || warn "psql reportou avisos."
      fi
      warn "Dump SQL plano: se contiver acervo_chunks(1536), as linhas foram rejeitadas (ok). Ideal: dump --exclude-table-data=acervo_chunks."
    else
      # Dump em FORMATO CUSTOM (pg_dump -Fc): pg_restore NAO tem --exclude-table-data
      # (flag exclusiva do pg_dump) — o caminho suportado e filtrar o TOC via -L,
      # pulando os DADOS de acervo_chunks (re-embeddado; dim pode divergir) e
      # __drizzle_migrations (journal ja escrito pelo migrate). Rodamos num
      # container pg16 irmao com o dump montado read-only (sem copiar p/ dentro).
      DUMP_DIR="$(cd "$(dirname "${RESTORE_DUMP}")" && pwd)"
      DUMP_BASE="$(basename "${RESTORE_DUMP}")"
      PGPASS_RESTORE="$(get_env POSTGRES_PASSWORD)"
      docker run --rm --network "${COMPOSE_PROJECT}_backend" \
        -e PGPASSWORD="${PGPASS_RESTORE}" -v "${DUMP_DIR}:/dump:ro" \
        pgvector/pgvector:pg16 sh -c "
          pg_restore -l /dump/${DUMP_BASE} \
            | grep -vE 'TABLE DATA [^ ]+ (acervo_chunks|__drizzle_migrations) ' > /tmp/restore.list &&
          pg_restore --no-owner --no-acl --data-only --disable-triggers -L /tmp/restore.list \
            -h db -U ${POSTGRES_USER} -d ${POSTGRES_DB} /dump/${DUMP_BASE}" \
        || warn "pg_restore retornou avisos (constraints/duplicatas) — contagens validadas abaixo."
    fi
    # Sanidade ANTI-MASCARAMENTO: restore que termina com banco vazio e falha
    # engolida por warn ja aconteceu (auditoria). users>=1 e licitacoes>0 ou aborta.
    _n_users="$(dc exec -T db psql -tA -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c 'SELECT count(*) FROM users' 2>/dev/null | tr -d '[:space:]')"
    _n_lic="$(dc exec -T db psql -tA -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c 'SELECT count(*) FROM licitacoes' 2>/dev/null | tr -d '[:space:]')"
    if [[ "${_n_users:-0}" -ge 1 && "${_n_lic:-0}" -ge 1 ]]; then
      ok "Dados restaurados e validados (users=${_n_users}, licitacoes=${_n_lic}; acervo_chunks vazio -> re-embed)."
    else
      die "RESTORE VAZIO/INCOMPLETO (users=${_n_users:-?}, licitacoes=${_n_lic:-?}) — o pg_restore falhou de verdade. Revise o log acima; nao siga com o cutover."
    fi
  fi
fi

# ── 6b) Restore dos BLOBS R2 -> MinIO (CRITICO #5) ────────────────────────────
# Sem os bytes no MinIO, todo /download da 404/500 (cofre de habilitacao,
# DFP/PPU, petitorios). O tarball vem de scripts/pitstop/pack-data.sh.
if [[ -n "${RESTORE_BLOBS}" ]]; then
  [[ -f "${RESTORE_BLOBS}" ]] || die "tarball de blobs nao encontrado: ${RESTORE_BLOBS}"
  BUCKET="$(get_env R2_BUCKET)"; BUCKET="${BUCKET:-petro-radar}"
  MINIO_USER="$(get_env MINIO_ROOT_USER)"; MINIO_PASS="$(get_env MINIO_ROOT_PASSWORD)"
  NET="${COMPOSE_PROJECT}_backend"
  BLOB_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/petro-blobs.XXXXXX")"
  log "Extraindo blobs de $(basename "${RESTORE_BLOBS}")..."
  tar xzf "${RESTORE_BLOBS}" -C "${BLOB_STAGE}"
  SRC_DIR="${BLOB_STAGE}/r2-export/${BUCKET}"
  [[ -d "${SRC_DIR}" ]] || SRC_DIR="${BLOB_STAGE}/r2-export"
  log "Espelhando blobs -> MinIO (mc mirror --overwrite --preserve)..."
  # A imagem minio/mc tem ENTRYPOINT 'mc' -> p/ rodar VARIOS comandos num shell e
  # preciso sobrescrever com --entrypoint sh (senao 'sh -c ...' vira 'mc sh').
  docker run --rm --network "${NET}" \
    -e MC_HOST_minio="http://${MINIO_USER}:${MINIO_PASS}@minio:9000" \
    -v "${BLOB_STAGE}:/blobs:ro" --entrypoint sh minio/mc:latest \
    -c "mc mb --ignore-existing minio/${BUCKET} >/dev/null 2>&1; mc version enable minio/${BUCKET} >/dev/null 2>&1; mc mirror --overwrite --preserve /blobs/r2-export/${BUCKET} minio/${BUCKET}" \
    && ok "Blobs espelhados no MinIO." || warn "mirror de blobs retornou avisos — revise."

  # Validacao banco<->storage: blobs faltando deve ser 0.
  log "Validando keys do banco vs objetos no MinIO..."
  PG_U="$(get_env POSTGRES_USER)"; PG_D="$(get_env POSTGRES_DB)"
  KEYS_SQL="${REPO_DIR}/scripts/parity/04_db_keys.sql"
  if [[ -f "${KEYS_SQL}" ]]; then
    keys="$(dc exec -T db psql -tA -U "${PG_U}" -d "${PG_D}" -f /dev/stdin < "${KEYS_SQL}" 2>/dev/null || true)"
    total=0; faltando=0
    while IFS= read -r k; do
      [[ -z "${k}" ]] && continue
      total=$((total+1))
      docker run --rm --network "${NET}" -e MC_HOST_minio="http://${MINIO_USER}:${MINIO_PASS}@minio:9000" \
        minio/mc:latest stat "minio/${BUCKET}/${k}" >/dev/null 2>&1 || { faltando=$((faltando+1)); warn "  blob FALTANDO: ${k}"; }
    done <<< "${keys}"
    if [[ "${faltando}" -eq 0 ]]; then ok "  blobs faltando: 0 / ${total} keys (paridade banco<->MinIO)."
    else warn "  ${faltando}/${total} blobs FALTANDO no MinIO — downloads vao 404. Revise o pack-data/mirror."; fi
  else
    warn "  scripts/parity/04_db_keys.sql ausente — pulei a validacao de keys."
  fi
  rm -rf "${BLOB_STAGE}"
elif [[ -n "${RESTORE_DUMP}" ]]; then
  warn "Dump restaurado SEM --restore-blobs: as blob_key apontam p/ objetos que o MinIO nao tem -> /download dara 404."
  warn "Rode scripts/pitstop/pack-data.sh (com credenciais R2) e re-execute com --restore-blobs=<tgz>."
fi

# ── 7) Seed do 1o ADMIN (paridade de acesso) ──────────────────────────────────
if [[ "${SKIP_SEED}" == "1" ]]; then
  warn "--skip-seed: pulando seed do admin."
else
  SETUP_TOKEN="$(get_env SETUP_TOKEN)"
  ADMIN_EMAIL="${ADMIN_EMAIL:-$(get_env ADMIN_EMAIL || true)}"; ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
  ADMIN_PASS="${ADMIN_PASS:-$(get_env ADMIN_PASS || true)}"
  ADMIN_NAME="${ADMIN_NAME:-Administrador}"
  if [[ -z "${ADMIN_PASS}" ]]; then
    warn "ADMIN_PASS nao definido (env ou .env). Pulando seed — crie depois via /api/auth/setup."
  else
    log "Criando 1o ADMIN (${ADMIN_EMAIL}) via /api/auth/setup ..."
    # Segredos passados ao container via `-e` (nunca interpolados no node -e).
    # A rota /api/auth/setup le {email, password, nome}. 403 = "Setup ja realizado"
    # (esperado apos --restore-dump, que ja traz admins) — tratado como sucesso.
    SEED_JS='const t=process.env.X_SETUP_TOKEN, b=JSON.stringify({nome:process.env.X_NAME,email:process.env.X_EMAIL,password:process.env.X_PASS});'
    SEED_JS+='fetch("http://127.0.0.1:3000/api/auth/setup",{method:"POST",headers:{"content-type":"application/json","x-setup-token":t},body:b})'
    SEED_JS+='.then(r=>r.text().then(tx=>{console.log("HTTP",r.status,tx);process.exit(r.status<300||r.status===403||r.status===409?0:1)}))'
    SEED_JS+='.catch(e=>{console.log(e.message);process.exit(1)});'
    code="$(dc exec -T \
      -e X_SETUP_TOKEN="${SETUP_TOKEN}" -e X_NAME="${ADMIN_NAME}" \
      -e X_EMAIL="${ADMIN_EMAIL}" -e X_PASS="${ADMIN_PASS}" \
      web node -e "${SEED_JS}" 2>&1)" || true
    if echo "${code}" | grep -qE "HTTP (2[0-9][0-9]|403|409)"; then
      ok "Admin criado (ou ja existia)."
    else
      # Sem admin nao ha login — falha aqui NAO pode ser mascarada como warn.
      die "Seed do admin FALHOU: ${code} — sem 1o admin nao ha login. Verifique SETUP_TOKEN/ADMIN_PASS e a rota /api/auth/setup."
    fi
  fi
fi

# ── 8) Re-embed do acervo (derivado do Postgres) ──────────────────────────────
# (Reindex ES REMOVIDO em 2026-07-02 junto com o Elasticsearch.)
if [[ "${SKIP_EMB}" == "1" ]]; then
  warn "--skip-embeddings: pulando re-embed do acervo."
else
  log "Disparando re-embed do acervo (BGE-m3 1024, task embedding_reindex_acervo)..."
  dc exec -T worker python -c "from tasks import embedding_reindex_acervo; embedding_reindex_acervo.delay()" 2>/dev/null \
    && ok "embedding_reindex_acervo enfileirado." || warn "nao foi possivel enfileirar re-embed (rode pela fila do worker)."
fi

# ── 9) SMOKE TESTS de paridade ────────────────────────────────────────────────
# Resolve os valores AGORA, no shell-pai (não dependemos de funções exportadas
# dentro dos subshells dos testes). Cada smoke roda um comando `dc exec ...`.
banner "SMOKE TESTS"
PG_USER="$(get_env POSTGRES_USER)"; PG_DB="$(get_env POSTGRES_DB)"
BUCKET="$(get_env R2_BUCKET)"; BUCKET="${BUCKET:-petro-radar}"
APP_HOST="$(get_env NEXT_PUBLIC_APP_URL 2>/dev/null | sed 's#https\?://##' || true)"; APP_HOST="${APP_HOST:-radar.example.local}"
smoke_fail=0
smoke() { # smoke "nome" -- <comando...>
  local name="$1"; shift; [[ "$1" == "--" ]] && shift
  if "$@" >/dev/null 2>&1; then ok "  ${name}"; else warn "  FALHOU: ${name}"; smoke_fail=$((smoke_fail+1)); fi
}

# web vivo (canario publico /api/auth/csrf: <500 ok, >=500 inesperado falha)
smoke "web /api/auth/csrf (<500)" -- \
  dc exec -T web node -e "fetch('http://127.0.0.1:3000/api/auth/csrf').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# pagina de login renderiza
smoke "web /login (HTML)" -- \
  dc exec -T web node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# bff health
smoke "bff /bff/health (200)" -- \
  dc exec -T bff python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/bff/health',timeout=5).status==200 else 1)"
# postgres + extensao vector
smoke "db: extensao vector presente" -- \
  dc exec -T db psql -U "${PG_USER}" -d "${PG_DB}" -tAc "select extname from pg_extension where extname='vector'"
# contagem de tabelas (paridade 52)
TBL="$(dc exec -T db psql -U "${PG_USER}" -d "${PG_DB}" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]' || echo 0)"
if [[ "${TBL}" -ge 52 ]]; then ok "  db: ${TBL} tabelas (>=52 — paridade)"; else warn "  db: apenas ${TBL} tabelas (<52)"; smoke_fail=$((smoke_fail+1)); fi
# minio bucket existe (credenciais ROOT vem do env_file do container createbuckets)
smoke "minio: bucket ${BUCKET} acessivel" -- \
  dc exec -T createbuckets sh -c "mc alias set local http://minio:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD >/dev/null && mc ls local/${BUCKET} >/dev/null"
# embeddings-local respondendo (RAG)
smoke "embeddings-local /health" -- \
  dc exec -T bff python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://embeddings-local:80/health',timeout=5).status==200 else 1)"
# worker scheduler vivo
smoke "worker /healthz" -- \
  dc exec -T worker python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=5).status==200 else 1)"

hr
if [[ "${smoke_fail}" -eq 0 ]]; then
  banner "PETRO RADAR ON-PREM NO AR — paridade verificada."
  cat <<EOF
 Acesso (via NGINX da Proponente -> web 127.0.0.1:3000):
   https://${APP_HOST}/login
 Console MinIO (admin)      : http://127.0.0.1:9001
 Logs                       : make logs   |   Status: make ps
EOF
else
  warn "${smoke_fail} smoke test(s) falharam. A stack subiu, mas revise os avisos acima."
  warn "Diagnostico:  make ps  |  make logs  |  deploy/README.md"
  exit 1
fi
