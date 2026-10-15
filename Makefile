# =============================================================================
# Petro Radar — Makefile de operacao on-premise
# =============================================================================
# Pre-requisito: copie .env.onprem.example -> .env.onprem e preencha os segredos.
# Uso: make up | make migrate | make logs | make backup | make down
# =============================================================================

SHELL := /bin/bash
COMPOSE := docker compose --env-file .env.onprem
BACKUP_DIR := ./backups
STAMP := $(shell date +%Y%m%d_%H%M%S)

# Carrega POSTGRES_* do .env.onprem para os alvos de backup/migrate.
# -include (com hífen): em clone fresco SEM .env.onprem o make não pode morrer
# em "No such file or directory" — os alvos que dependem das vars falham com
# mensagem própria; `make help` e afins seguem funcionando.
-include .env.onprem
export

.DEFAULT_GOAL := help
.PHONY: help up up-lite stop-embeddings down restart logs ps build pull \
        migrate backup backup-db restore-db check-ext check-hnsw count-tables \
        parity-diff storage-validate seed-admin seed-demo psql redis-cli clean

help:  ## Lista os alvos disponiveis
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n",$$1,$$2}'

up:  ## Sobe toda a stack (8 servicos, INCLUI embeddings-local BGE-m3)
	$(COMPOSE) up -d --build
	@echo ">> Aguardando healthchecks... use 'make ps' para conferir."

# (alias up-local REMOVIDO em 2026-07-02 — use `make up` ou `make up-lite`.)

up-lite:  ## DEV: sobe a stack e PARA o embeddings-local (TEI emulado consome ~9GB RAM/100% CPU no Mac ARM)
	@# Use quando NAO estiver trabalhando no RAG. As rotas de acervo/RAG degradam
	@# com 503 por design (gate no BFF). Para religar: docker compose start embeddings-local
	$(COMPOSE) up -d
	$(COMPOSE) stop embeddings-local
	@echo ">> embeddings-local PARADO (RAG indisponivel; use 'make ps' p/ conferir o resto)."

stop-embeddings:  ## DEV: para so o embeddings-local (libera RAM/CPU; RAG degrada p/ 503)
	$(COMPOSE) stop embeddings-local

down:  ## Para e remove os containers (mantem volumes/dados)
	$(COMPOSE) down

restart:  ## Reinicia web/bff/worker (sem mexer em db/redis/es/minio)
	$(COMPOSE) restart web bff worker

logs:  ## Segue os logs de todos os servicos (Ctrl-C para sair)
	$(COMPOSE) logs -f --tail=200

ps:  ## Mostra status + health dos containers
	$(COMPOSE) ps

build:  ## (Re)constroi as imagens web/bff/worker
	$(COMPOSE) build web bff worker

pull:  ## Baixa as imagens de terceiros (db/redis/minio)
	$(COMPOSE) pull db redis minio

migrate:  ## Aplica as migrations Drizzle (0000..0015) no db (imagem pre-buildada; SEM build no servidor).
	@echo ">> Aplicando migrations (52 tabelas + extensao vector + HNSW + vector(1024))..."
	@# No servidor air-gapped a imagem ja foi CARREGADA por deploy/load-and-run.sh.
	@# Build so e tentado como FALLBACK DE DEV (precisa do source ./app).
	@docker image inspect petro-radar/migrate:onprem >/dev/null 2>&1 || { \
	  echo ">> imagem petro-radar/migrate:onprem ausente; buildando (fallback de dev)"; \
	  docker build --target builder -t petro-radar/migrate:onprem -f Dockerfile.web ./app; }
	docker run --rm --network petro-radar_backend --env-file .env.onprem \
	  petro-radar/migrate:onprem node node_modules/.bin/tsx src/db/migrate.ts
	@# As migrations 0019+ sao escritas a mao e ficam FORA do meta/_journal.json,
	@# entao o migrator TS acima NAO as aplica. Sem este passo o schema para na
	@# 0018 e um pg_restore de dump de producao aborta.
	@echo ">> Aplicando migrations fora do journal (0019+)..."
	bash db/scripts/apply-extra-migrations.sh

backup:  ## Backup CONSISTENTE (Postgres -Fc + blobs MinIO mc mirror + retencao). Agende via systemd timer.
	bash deploy/backup.sh

backup-db:  ## So o pg_dump logico do Postgres -> backups/ (dump rapido avulso)
	@mkdir -p $(BACKUP_DIR)
	@echo ">> pg_dump petro_radar -> $(BACKUP_DIR)/db_$(STAMP).sql.gz"
	$(COMPOSE) exec -T db pg_dump --no-owner --no-acl -U $(POSTGRES_USER) $(POSTGRES_DB) \
	  | gzip > $(BACKUP_DIR)/db_$(STAMP).sql.gz
	@echo ">> OK."

# OBS: NAO fazemos tar dos volumes minio AO VIVO (gera snapshot inconsistente).
# Blobs MinIO -> 'mc mirror' (em deploy/backup.sh). Embeddings sao DERIVADOS do
# Postgres (reconstruir via task embedding_reindex_acervo) — nao backupar.

restore-db:  ## Restaura um dump: make restore-db FILE=backups/db_XXX.sql.gz
	@test -n "$(FILE)" || (echo "informe FILE=backups/db_XXX.sql.gz"; exit 1)
	@echo ">> Restaurando $(FILE) em $(POSTGRES_DB)..."
	gunzip -c $(FILE) | $(COMPOSE) exec -T db psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

# ── Validacao de paridade / aceite (WP02 §11) ────────────────────────────────
check-ext:  ## Confere extensoes obrigatorias (vector + pgcrypto)
	$(COMPOSE) exec -T db psql -tA -U $(POSTGRES_USER) -d $(POSTGRES_DB) -f /dev/stdin < scripts/parity/00_check_extensions.sql

check-hnsw:  ## Confere acervo_chunks vector(1024) + indice HNSW
	$(COMPOSE) exec -T db psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) -f /dev/stdin < scripts/parity/02_check_hnsw.sql

count-tables:  ## Conta exata de todas as tabelas public -> stdout (CSV: tabela,linhas)
	@$(COMPOSE) exec -T db psql -tA -F',' -U $(POSTGRES_USER) -d $(POSTGRES_DB) -f /dev/stdin < scripts/parity/count_tables.sql

parity-diff:  ## Compara contagens vs ORIGIN=origin_counts.csv (exclui tabelas DERIVADAS)
	@test -n "$(ORIGIN)" || (echo "informe ORIGIN=origin_counts.csv (capturado na producao no dump)"; exit 1)
	@# Excecoes esperadas (WP02 §9.3): acervo_chunks/acervo_index_log sao
	@# RECONSTRUIDAS pelo re-embed (origem=0, on-prem>0); consultas_certidoes tem o
	@# payload anonimizado. Excluidas do diff p/ nao gerar falso-positivo.
	@EXC='acervo_chunks|acervo_index_log|consultas_certidoes'; \
	  $(MAKE) -s count-tables | grep -vE "^($$EXC)," | sort > /tmp/onprem_counts.csv; \
	  grep -vE "^($$EXC)," "$(ORIGIN)" | sort > /tmp/origin_counts.csv; \
	  echo ">> diff (origin -> on-prem), excluindo derivadas; vazio = paridade exata:"; \
	  diff /tmp/origin_counts.csv /tmp/onprem_counts.csv && echo "  PARIDADE EXATA (tabelas-fonte)" || echo "  ^^ divergencias acima"

storage-validate:  ## Valida paridade banco<->MinIO (toda blob_key tem objeto)
	bash scripts/parity/03_storage_validate.sh

seed-admin:  ## Cria o 1o ADMIN via /api/auth/setup (ADMIN_EMAIL/ADMIN_PASS no ambiente)
	@test -n "$(ADMIN_PASS)" || (echo "informe ADMIN_PASS=... (e opcional ADMIN_EMAIL=)"; exit 1)
	$(COMPOSE) exec -T -e X_T="$(SETUP_TOKEN)" -e X_E="$(or $(ADMIN_EMAIL),admin@example.com)" -e X_P="$(ADMIN_PASS)" web \
	  node -e 'fetch("http://127.0.0.1:3000/api/auth/setup",{method:"POST",headers:{"content-type":"application/json","x-setup-token":process.env.X_T},body:JSON.stringify({nome:"Administrador",email:process.env.X_E,password:process.env.X_P})}).then(r=>r.text().then(t=>{console.log("HTTP",r.status,t);process.exit(r.status<300||r.status===403||r.status===409?0:1)})).catch(e=>{console.log(e.message);process.exit(1)})'

seed-demo:  ## Carrega dados FICTICIOS de demonstracao (idempotente; login admin@demo.invalid)
	@# O servico db NAO monta ./db/seed — o arquivo entra do HOST via stdin do exec.
	$(COMPOSE) exec -T db psql -v ON_ERROR_STOP=1 -U $(POSTGRES_USER) -d $(POSTGRES_DB) < db/seed/demo.sql

psql:  ## Abre psql no banco
	$(COMPOSE) exec db psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

redis-cli:  ## Abre redis-cli (autenticado)
	$(COMPOSE) exec redis sh -c 'redis-cli -a "$$REDIS_PASSWORD"'

clean:  ## PERIGO: remove containers E volumes (apaga TODOS os dados)
	@echo ">> Isto APAGA todos os dados (pg/minio/es/redis). Ctrl-C para abortar."; sleep 5
	$(COMPOSE) down -v

# ── Runner de validacao de paridade (WP12 §7) — perfil "tests" ───────────────
# O `tester` (docker-compose.yml, profiles: ["tests"]) NAO sobe no `make up`:
# e buildado sob demanda no primeiro `run` e descartado a cada alvo (--rm).
# Roda DENTRO das redes do compose (alcanca web/bff/db/redis/minio pelos
# service names) e grava os artefatos canonicos em tests/_artifacts/ (volume).
# Pre-condicao: make up + migrate ja executados (healthchecks OK).
.PHONY: test-smoke test-seed test-migrate-check test-e2e test-routes \
        test-parity test-parity-self test-unit-bff test-egress test-backup \
        go-no-go test-all

TESTER := $(COMPOSE) --profile tests run --rm tester

test-smoke:  ## Smoke de saude dos 9 containers + deps cruzadas -> _artifacts/smoke.json
	$(TESTER) pytest -q tests/smoke

test-seed:  ## Aplica as fixtures deterministicas (idempotente) -> psql no container db
	@# O servico db NAO monta ./tests — o seed.sql entra do HOST via stdin do exec.
	$(COMPOSE) exec -T db psql -v ON_ERROR_STOP=1 -U $(POSTGRES_USER) -d $(POSTGRES_DB) < tests/fixtures/seed.sql

test-migrate-check:  ## Confere migrations/extensoes/vector(1024) -> _artifacts/migrate_check.json
	$(TESTER) python tests/migrate_check.py

test-e2e:  ## E2E por feature (7 suites pytest+httpx + playwright) -> _artifacts/e2e_results.json
	$(TESTER) bash tests/run_e2e.sh

test-routes:  ## Cobertura das 103 rotas (status+shape+RBAC) -> _artifacts/route_inventory.csv
	$(TESTER) pytest -q tests/parity/test_route_inventory.py

test-parity:  ## Comparacao on-prem x prod (mesmos inputs) -> _artifacts/parity_summary.json
	$(TESTER) python tests/parity/compare_prod_onprem.py

test-parity-self:  ## Paridade SELF-GOLDEN (G5 parcial): captura goldens do PROPRIO ambiente na 1a execucao (em tests/_golden/, local e gitignored) e, nas seguintes, compara o ambiente atual contra eles (detector de drift de contrato). Refresh: SELF_GOLDEN_REFRESH=1
	@# Pre-req: stack no ar + fixtures aplicadas (make up + migrate + test-seed).
	$(TESTER) env SELF_GOLDEN=1 SELF_GOLDEN_REFRESH=$(or $(SELF_GOLDEN_REFRESH),0) \
	  python tests/parity/compare_prod_onprem.py

test-unit-bff:  ## Unit tests do BFF in-process (tests/unit_bff, sem rede): roda no tester com ./bff montado em /bff (deps do BFF pinadas em tests/requirements.txt). Rebuild automatico da imagem.
	@# Caminho de execucao escolhido (F10): container tester + ASGITransport.
	@# O host (macOS/py3.14) nao tem as deps do BFF; o container bff nao tem
	@# pytest. O tester (py3.12) ganhou as deps do BFF no requirements.txt e
	@# monta ./bff:/bff (o conftest de tests/ ja poe /bff no sys.path).
	$(COMPOSE) --profile tests build -q tester
	$(COMPOSE) --profile tests run --rm -v ./bff:/bff:ro tester \
	  pytest -q tests/unit_bff

test-egress:  ## Guard de egress (G10/G11): sonda ativa + veredito -> _artifacts/egress.json
	@# Passo 1 NO HOST: a sonda usa `docker exec` nos containers (o tester nao
	@# tem docker socket — privilegio negado de proposito). Passo 2 no tester:
	@# consolida observado/exigido/gated no formato canonico do egress_guard.py.
	bash tests/lib/egress_probe.sh
	$(TESTER) python tests/lib/egress_guard.py

test-backup:  ## DR dry-run (G12): backup -> restore em db efemero -> _artifacts/backup_check.json
	@# NO HOST: orquestra pg_dump/restore via docker (fora do tester, que nao
	@# tem acesso ao daemon). Nao toca no volume pg_data de producao.
	bash tests/dr_check.sh

go-no-go:  ## Consolida os artefatos no veredito final -> _artifacts/go-no-go.md
	$(TESTER) python tests/go_no_go.py

test-all: test-smoke test-seed test-migrate-check test-e2e test-routes test-parity test-egress test-backup go-no-go  ## Pipeline completo de validacao (WP12 §7, em ordem)
