# deploy/secrets/ — Docker secrets file-based (G7 / WP09 §6.2)

> **OPT-IN de produção.** Dev continua com `env_file` puro (`.env.onprem`) —
> nada muda sem o overlay. Motivação: `env_file` expõe segredos em
> `docker inspect` e `/proc/<pid>/environ`; secrets file-based vivem em tmpfs
> (`/run/secrets/<nome>`, 0400) e o environ do container fica "limpo".

## Fluxo de ativação (host de produção)

```bash
# 1. Materializa os arquivos de secret a partir do .env.onprem atual
./deploy/gen-secrets.sh

# 2. Valida o merge do overlay
docker compose -f docker-compose.yml -f docker-compose.secrets.yml config -q

# 3. Sobe com o overlay (recreate dos serviços afetados)
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d

# 4. Confirma: environ dos containers SEM os valores reais
docker inspect petro-radar-bff-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep AUTH_SECRET
#   -> AUTH_SECRET=          (vazio; o valor real só existe no processo e no tmpfs)
```

Para que o compose sempre use o overlay sem digitar `-f ...` toda vez, crie no
host um arquivo `compose.override.yml`? **Não** — o override automático é o
`docker-compose.override.yml`; prefira um alias/wrapper ou a env
`COMPOSE_FILE=docker-compose.yml:docker-compose.secrets.yml` no shell do operador.

## Passo final (o que dá o ganho real): tirar os segredos do `.env.onprem`

Enquanto o `.env.onprem` mantiver os valores reais, eles continuam sendo
injetados via `env_file` nos serviços (o overlay zera as chaves cobertas, mas o
arquivo no disco segue sensível). Depois de validar a stack com secrets:

1. Edite `.env.onprem` e troque os valores dos segredos por placeholders.
   **Atenção:** três chaves são *guardadas* por `${VAR:?}` no compose base e
   precisam de placeholder **não-vazio** (qualquer string):

   ```dotenv
   POSTGRES_PASSWORD=em-docker-secret
   REDIS_PASSWORD=em-docker-secret
   MINIO_ROOT_PASSWORD=em-docker-secret
   AUTH_SECRET=em-docker-secret
   NEXTAUTH_SECRET=em-docker-secret
   SETUP_TOKEN=em-docker-secret
   CRON_SECRET=em-docker-secret
   DATABASE_URL=em-docker-secret
   REDIS_URL=em-docker-secret
   CELERY_BROKER_URL=em-docker-secret
   CELERY_RESULT_BACKEND=em-docker-secret
   R2_SECRET_ACCESS_KEY=em-docker-secret
   SMTP_PASS=em-docker-secret
   ANTHROPIC_API_KEY=em-docker-secret
   VAPID_PRIVATE_KEY=em-docker-secret
   WHATSAPP_TOKEN=
   ```

2. `docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d`
   de novo (recreate) e re-teste login/health.
3. A partir daí, **rotação de segredo** = editar o ARQUIVO em `deploy/secrets/`
   (ou rodar `gen-secrets.sh` com um `.env` temporário) + `up -d` no serviço.

## Como cada serviço recebe o segredo

| Serviço | Mecanismo |
|---|---|
| `db` | nativo: `POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password` (só usado no 1º initdb) |
| `minio` | nativo: `MINIO_ROOT_PASSWORD_FILE=/run/secrets/minio_root_password` |
| `redis` | sem suporte `*_FILE`: o `command` lê `$(cat /run/secrets/redis_password)` em runtime |
| `web`/`bff`/`worker` | wrapper `deploy/entrypoints/secrets-env.sh` (entrypoint): exporta `VAR=$(cat $VAR_FILE)` p/ toda env `*_FILE` e `exec` o CMD original |

## Limitações conhecidas

- **`createbuckets`** (bootstrap one-shot do MinIO) continua lendo `env_file`.
  Rode-o na provisão inicial, ANTES de trocar os valores do `.env.onprem` por
  placeholders (ou exporte as vars na mão para reexecutá-lo).
- **`tester`** (perfil `tests`, dev-only) não é coberto pelo overlay.
- O wrapper de entrypoint fixa o `command` original de cada imagem no overlay
  (override de `entrypoint` limpa o CMD). Se o CMD de um Dockerfile mudar,
  atualize o `command:` correspondente no `docker-compose.secrets.yml`.
- `deploy/secrets/*` precisa de `chmod 400` e dono root (o `gen-secrets.sh` já
  aplica). O diretório é gitignored — **nunca** versione.

## Rotação rápida de um segredo

```bash
# ex.: rotacionar a senha do Redis
openssl rand -base64 24 > /tmp/nova
chmod 600 deploy/secrets/redis_password && cp /tmp/nova deploy/secrets/redis_password && chmod 400 deploy/secrets/redis_password
# ATENÇÃO: redis_url/celery_broker_url/celery_result_backend embutem a senha — atualize os 3 também.
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d redis worker web bff
```
