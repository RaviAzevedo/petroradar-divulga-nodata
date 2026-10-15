# Petro Radar On-Premise — PITSTOP de Empacotamento e Deploy

> **Objetivo PITSTOP:** empacotar o Petro Radar inteiro (web + BFF + worker +
> banco + storage + busca + RAG) **offline**, num único `.tar.gz`, de modo que no
> servidor da Proponente baste **carregar e rodar** — sem internet, com **paridade
> funcional total** com a produção de hoje (103 rotas, 52 tabelas, 12 crons).
>
> Estes scripts vivem em `deploy/` e implementam o fluxo de 4 passos
> (empacotar na máquina com internet) + 1 passo (rodar no servidor air-gapped).

---

## 0. Visão geral do fluxo

```
 MÁQUINA DE EMPACOTAMENTO (com internet)            SERVIDOR PROPONENTE (air-gap)
 ───────────────────────────────────────            ────────────────────────────
 1) deploy/build.sh                                  5) deploy/load-and-run.sh
      build web/bff/worker + pull terceiros               docker load (images.tar)
 2) deploy/save-images.sh                                 restore embeddings_cache
      docker save -> dist/images.tar                      valida .env.onprem
 (opc) deploy/preload-embeddings.sh                       docker compose up -d
      baixa BGE-m3 -> dist/embeddings_cache.tar           bootstrap MinIO + ES
 3) deploy/bundle.sh                                       migrate (0000..0015)
      monta dist/petro-radar-onprem-<ver>.tar.gz   ──┐    [restore dump opcional]
                                                      │    seed 1o admin
            transferir o .tar.gz + .sha256  ──────────┘    reindex ES + re-embed
                                                           SMOKE TESTS (paridade)
```

Cada script é **bash robusto** (`set -euo pipefail`), **idempotente** e com
**echos claros**. Todos carregam `deploy/_lib.sh` (lista canônica de imagens,
versão, helpers). A lista de imagens em `_lib.sh` **espelha** o
`docker-compose.yml` — se uma imagem mudar lá, atualize `THIRD_PARTY_IMAGES`.

---

## 1. Pré-requisitos

### Na máquina de empacotamento
- Docker Engine + plugin `docker compose` v2, `git`, `gzip`, `tar`, `curl`.
- O **código do app** em **`./app`** (parte deste repo) com os 3 pré-requisitos de código aplicados
  (Decisão 3): `output:'standalone'`, driver `pg` (node-postgres) e
  `R2_ENDPOINT` em `r2.ts`. **Sem eles a imagem `web` nem builda** — `build.sh`
  avisa e o build do Next falha de propósito (melhor falhar aqui que no servidor).
- `next/font` migrado para `next/font/local` (`.woff2` versionado) **ou** egress
  no estágio builder (lacuna 16) — caso contrário o build offline quebra.
- Plataforma: se o servidor é **x86_64** e você builda no Mac ARM, passe
  `--platform=linux/amd64` em `build.sh` (e exporte `BUILD_PLATFORM=linux/amd64`).

### No servidor da Proponente
- Docker Engine + `docker compose` v2. **Não precisa de internet.**
- NGINX já instalado (não é serviço do compose). Use `nginx/conf.d/petro-radar.conf`
  (estrangulador: `/bff/` → FastAPI:8000, `/api/`+`/` → Next:3000).
- RAM recomendada: ES 1 GB heap + Postgres + TEI (CPU) → mín. **8 GB**, ideal 16 GB.
- Filesystem dos volumes `pg_data`/`minio_data` em disco cifrado (LUKS) — LGPD.

---

## 2. Empacotar (máquina com internet)

```bash
cd /caminho/para/petro-radar-onprem

# (opcional) fixar versão do pacote
echo "1.0.0" > deploy/VERSION          # ou exporte VERSION=1.0.0

# 1) Build das 3 imagens próprias + pull das 6 de terceiros
./deploy/build.sh                      # use --platform=linux/amd64 se necessário

# 2) Serializar TODAS as imagens num único tar
./deploy/save-images.sh                # gera dist/images.tar (+ .sha256, images.list)

# 3) (AIR-GAP) pré-carregar o modelo de embeddings BGE-m3 (~2.2 GB)
./deploy/preload-embeddings.sh --gzip  # gera dist/embeddings_cache.tar.gz

# 4) Montar o pacote PITSTOP final
./deploy/bundle.sh                     # gera dist/petro-radar-onprem-<ver>.tar.gz
```

**Saídas em `deploy/dist/`:**
- `images.tar` (+ `.sha256`, `images.list`)
- `embeddings_cache.tar.gz` (se rodou o preload)
- `petro-radar-onprem-<ver>.tar.gz` (+ `.sha256`) ← **é este que vai p/ o servidor**

> O bundle inclui: `images.tar`, `embeddings_cache.tar.gz`, `docker-compose.yml`,
> `Makefile`, `db/init/`, `nginx/`, `scripts/`, `deploy/{load-and-run.sh,_lib.sh,README.md}`,
> `.env.onprem.template`, `VERSION`,
> `MANIFEST.txt` e `SHA256SUMS`. **Nunca** inclui o `.env.onprem` real nem `backups/`.

---

## 3. Transferir

Copie **dois** arquivos para o servidor (pendrive/scp/registro interno):

```bash
petro-radar-onprem-<ver>.tar.gz
petro-radar-onprem-<ver>.tar.gz.sha256
```

No servidor, **verifique a integridade** antes de extrair:

```bash
sha256sum -c petro-radar-onprem-<ver>.tar.gz.sha256   # deve dizer: OK
tar xzf petro-radar-onprem-<ver>.tar.gz
cd petro-radar-onprem-<ver>
```

---

## 4. Subir e rodar (servidor air-gap)

```bash
# 4.1 Preencher os segredos (NUNCA versione este arquivo; chmod 600)
cp .env.onprem.template .env.onprem
chmod 600 .env.onprem
$EDITOR .env.onprem      # troque TODOS os "TROQUE-*" e "sk-ant-..."

# Geração de segredos:
#   AUTH_SECRET / NEXTAUTH_SECRET : openssl rand -base64 32   (MESMO valor nos dois)
#   CRON_SECRET / SETUP_TOKEN     : openssl rand -hex 32
#   senhas DB/Redis/MinIO/ES      : openssl rand -base64 24
#   VAPID                         : npx web-push generate-vapid-keys

# 4.2 PITSTOP: carrega imagens, valida, sobe, migra, faz seed e smoke
./deploy/load-and-run.sh

# Variante com MIGRAÇÃO DE DADOS (dump da produção Neon entre 0014 e 0015):
ADMIN_PASS='senha-forte' ./deploy/load-and-run.sh \
  --restore-dump=/caminho/db_prod.sql.gz
```

O `load-and-run.sh` é **idempotente** — pode ser reexecutado à vontade. Flags
úteis: `--skip-load`, `--skip-migrate`, `--skip-seed`, `--skip-embeddings`,
`--skip-es-reindex`, `--no-up`, `--yes`. Variáveis de seed: `ADMIN_EMAIL`,
`ADMIN_PASS`, `ADMIN_NAME` (ou no `.env.onprem`).

Ao final, os **SMOKE TESTS** confirmam a paridade:
web vivo · `/login` renderiza · `/bff/health` · extensão `vector` ·
**≥ 52 tabelas** · ES yellow/green + alias `licitacoes` · bucket MinIO ·
embeddings-local `/health` · worker `/healthz`.

### 4.3 NGINX (estrangulador) — fora do compose
Habilite o server block no host (já incluído no pacote):

```bash
sudo cp nginx/conf.d/petro-radar.conf /etc/nginx/conf.d/petro-radar.conf
sudo nginx -t && sudo systemctl reload nginx
```

Acesse: `https://radar.example.local/login` (ajuste o domínio no `.env` e no
certificado interno da TI).

---

## 5. Operação do dia a dia

| Ação | Comando |
|------|---------|
| Status + health | `make ps` |
| Logs (todos) | `make logs` |
| Reiniciar web/bff/worker | `make restart` |
| Backup completo | `make backup` (pg_dump + mc mirror MinIO) |
| Restaurar dump | `make restore-db FILE=backups/db_XXX.sql.gz` |
| Abrir psql / redis | `make psql` / `make redis-cli` |
| Console MinIO | http://127.0.0.1:9001 |

**Crons (12) e filas:** rodam no container `worker` (Celery beat + Redlock +
`misfire_grace` — lacuna 9). O beat dispara `/api/cron/<nome>` com `CRON_SECRET`.

---

## 6. Rollback

> Princípio: a stack nova **não destrói dados** ao subir. Rollback é, na prática,
> derrubar a versão nova e (se preciso) restaurar o último backup.

### 6.1 Rollback rápido (sem perda de dados — só volta os containers)
```bash
make down                      # para tudo, MANTÉM volumes (pg/minio/es/redis)
# subir uma versão anterior do pacote:
cd ../petro-radar-onprem-<ver-anterior>
cp ../petro-radar-onprem-<ver>/.env.onprem .env.onprem   # reaproveita segredos
./deploy/load-and-run.sh --skip-migrate --skip-seed      # NÃO migra de novo
```

### 6.2 Rollback com restore de backup (se a migration corrompeu dados)
```bash
make down
# restaura o último dump SQL bom:
make up                                          # sobe só a infra/db
make restore-db FILE=backups/db_ANTES_DO_DEPLOY.sql.gz
# restaura volumes de blob/busca (se necessário):
docker run --rm -v petro-radar_minio_data:/v -v "$PWD/backups":/b alpine:3.20 \
  sh -c 'cd /v && tar xzf /b/minio_ANTES.tar.gz'
docker run --rm -v petro-radar_es_data:/v -v "$PWD/backups":/b alpine:3.20 \
  sh -c 'cd /v && tar xzf /b/es_ANTES.tar.gz'
make restart
```

### 6.3 Reset total (PERIGO — apaga TODOS os dados)
```bash
make clean                     # docker compose down -v  (apaga pg/minio/es/redis)
```

> **Sempre** rode `make backup` **antes** de qualquer deploy/migration. O
> `load-and-run.sh --restore-dump=...` pede confirmação porque mexe em dados.

---

## 7. Checklist de Go-Live

**Pré-empacotamento (máquina com internet)**
- [ ] App no branch `feat/onprem-prereqs` (Decisão 3: standalone + pg + R2_ENDPOINT).
- [ ] `next/font` local OU egress no builder (lacuna 16).
- [ ] `WEB_REPO_DIR` aponta para `./app` (default do `_lib.sh`; lacuna 8 resolvida).
- [ ] `deploy/VERSION` definido.
- [ ] `build.sh` OK (todas as 9 imagens presentes; `--platform` certo).
- [ ] `save-images.sh` OK (`images.tar` + checksum).
- [ ] `preload-embeddings.sh` OK (BGE-m3 1024 em `embeddings_cache.tar.gz`) — air-gap.
- [ ] `bundle.sh` OK (`petro-radar-onprem-<ver>.tar.gz` + `.sha256`).

**Servidor (air-gap)**
- [ ] `sha256sum -c` do pacote → OK; extraído.
- [ ] `.env.onprem` preenchido (sem `TROQUE-*`/`sk-ant-...`), `chmod 600`.
- [ ] `AUTH_SECRET == NEXTAUTH_SECRET`; `EMBEDDING_DIMENSOES=1024`; `EMBEDDING_PROVIDER=local`.
- [ ] `R2_ENDPOINT=http://minio:9000`; `DATABASE_URL` → `db:5432` (sem sslmode).
- [ ] Egress liberado **só** para o que a integração exige (Anthropic, Portal da
      Transparência, Microsoft Graph). Resto fechado.
- [ ] `load-and-run.sh` concluiu com **SMOKE TESTS verdes** (≥ 52 tabelas).
- [ ] (migração) `--restore-dump` aplicado + `mc mirror` R2→MinIO feito.
- [ ] Re-embed do acervo concluído (task `embedding_reindex_acervo`) e ES reindexado.
- [ ] NGINX recarregado; `https://radar.example.local/login` abre; login do admin OK.
- [ ] `make backup` agendado (cron do host) + disco cifrado nos volumes (LGPD).
- [ ] **Freeze do pipeline antigo** (agendador + jobs de coleta do ambiente de
      origem) no cutover (lacuna 10) — evita escrita dupla.

---

## 8. Mapa dos scripts

| Script | Onde roda | O que faz |
|--------|-----------|-----------|
| `_lib.sh` | (sourced) | caminhos, lista canônica de imagens, versão, logs, checks |
| `build.sh` | empacotamento | build web/bff/worker + pull dos terceiros + verificação |
| `save-images.sh` | empacotamento | `docker save` de tudo → `dist/images.tar` (+ checksum) |
| `preload-embeddings.sh` | empacotamento | baixa BGE-m3 → `dist/embeddings_cache.tar` (air-gap) |
| `bundle.sh` | empacotamento | monta `dist/petro-radar-onprem-<ver>.tar.gz` + MANIFEST/SHA |
| `load-and-run.sh` | **servidor** | load + valida env + up + bootstrap + migrate + seed + smoke |
