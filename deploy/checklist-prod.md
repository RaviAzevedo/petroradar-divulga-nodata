# Checklist de GO-LIVE — ambiente de PRODUÇÃO (Petro Radar on-prem)

> Lista **verificável** de env/segurança antes de liberar usuários. Complementa
> o checklist de empacotamento/subida do `deploy/README.md §7` — aqui é só o que
> é **fail-open por default** no código (e portanto silenciosamente inseguro se
> o `.env.onprem` de produção omitir) + custódia de segredos + disco.
>
> Convenção: marque cada item com o comando de verificação ao lado. Rode tudo
> no host de produção, na raiz do pacote extraído.

---

## 1. Envs OBRIGATÓRIAS de produção (fail-closed)

O código **defaulta para fail-open** (não travar dev). Produção DEVE fixar:

| Chave | Valor prod | Onde o código lê | Efeito se omitida |
|---|---|---|---|
| `AUTH_FAILCLOSED` | `1` | `app/src/lib/auth.ts` | login degrada p/ rate-limit in-process (inútil multi-réplica) |
| `REVOCATION_FAILCLOSED` | `1` | `bff/app/core/revocation.py` | Redis db2 fora ⇒ token revogado continua ACEITO até o exp |
| `RATE_LIMIT_FAILCLOSED` | `1`* | `bff/app/core/rate_limit.py` | Redis fora ⇒ API SEM rate-limit nenhum |
| `CORS_ORIGINS` | `https://radar.example.local` (origem real) | `bff/app/core/config.py` | BFF só aceita `http://localhost:3000` (quebra o front real) |
| `AUTH_COOKIE_NAME` | `__Secure-authjs.session-token` | `bff/app/core/config.py` | BFF tenta variantes, mas o salt HKDF explícito evita decode duplo |
| `AUTH_TRUST_HOST` | `true` | NextAuth | login rejeitado atrás do NGINX |
| `CRON_SECRET` | definido (hex 32) | `verifyCronAuth` | rotas /api/cron/* abertas ao caminho x-vercel-cron |
| `RETENCAO_DRY_RUN` | `1` até sign-off DPO | worker | expurgo LGPD executaria sem aprovação jurídica |
| `OCR_IA_ENABLED` | `false` até DPA Anthropic | upload cofre | PDF do cofre enviado à Anthropic sem contrato |

\* `RATE_LIMIT_FAILCLOSED=1` = **trade-off segurança > disponibilidade**: queda
do Redis nega a API inteira (429) até ele voltar. O Redis é local (mesmo
compose, AOF + restart automático) ⇒ janela esperada de segundos. Se a TI
priorizar disponibilidade, use `0` **sabendo que sem Redis não há rate-limit**.

Verificação (deve imprimir as 5 primeiras com os valores acima):

```bash
grep -E '^(AUTH_FAILCLOSED|REVOCATION_FAILCLOSED|RATE_LIMIT_FAILCLOSED|CORS_ORIGINS|AUTH_COOKIE_NAME|AUTH_TRUST_HOST)=' .env.onprem
```

- [ ] `AUTH_FAILCLOSED=1`
- [ ] `REVOCATION_FAILCLOSED=1`
- [ ] `RATE_LIMIT_FAILCLOSED=1` (ou `0` com aceite formal do risco pela TI)
- [ ] `CORS_ORIGINS=https://<domínio real>` (NUNCA `*`, NUNCA localhost)
- [ ] `AUTH_COOKIE_NAME=__Secure-authjs.session-token` (HTTPS atrás do NGINX)
- [ ] `AUTH_TRUST_HOST=true`
- [ ] `CRON_SECRET` definido (não `TROQUE-*`)

## 2. Segredos a TROCAR (nunca reaproveitar de dev/SaaS)

Gerar **por instalação** (WP09 §6.3): `openssl rand -base64 32` (AUTH) /
`openssl rand -hex 32` (tokens) / `openssl rand -base64 24` (senhas).

- [ ] `AUTH_SECRET` == `NEXTAUTH_SECRET` (mesmo valor, NOVO — invalida sessões da Vercel de propósito)
- [ ] `POSTGRES_PASSWORD` (e refletida em `DATABASE_URL`)
- [ ] `REDIS_PASSWORD` (e refletida em `REDIS_URL`/`CELERY_*`)
- [ ] `MINIO_ROOT_PASSWORD` + `R2_SECRET_ACCESS_KEY` (service account)
- [ ] `SETUP_TOKEN`, `CRON_SECRET`
- [ ] `SMTP_PASS`, `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN` (se usados)
- [ ] `VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY` (par novo)
- [ ] Nenhum `TROQUE-*`/`sk-ant-...` placeholder: `grep -c 'TROQUE-' .env.onprem` ⇒ `0`
- [ ] `.env.onprem` com `chmod 600`, dono root, FORA do git

### 2.1 Docker secrets (overlay opt-in — G7)

`env_file` expõe segredos em `docker inspect`/`/proc/<pid>/environ`. Para
reduzir o raio (WP09 §6.2), produção pode ativar o overlay **file-based**:

```bash
./deploy/gen-secrets.sh            # materializa deploy/secrets/* a partir do .env.onprem (chmod 400)
docker compose -f docker-compose.yml -f docker-compose.secrets.yml config -q   # valida
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d      # aplica
```

- [ ] `deploy/secrets/*` com `chmod 400`, fora do git (o `.gitignore` da pasta já cobre)
- [ ] Segredos REMOVIDOS do `.env.onprem` após ativar o overlay (senão continuam no environ)
- [ ] Ver `deploy/secrets/README.md` para o passo-a-passo e limitações

## 3. Backup cifrado + offsite (F2)

- [ ] `age` instalado no host (`apt install age`) e par de chaves gerado
      (`age-keygen -o /root/petro-backup.key`); **IDENTITY custodiada offline**
- [ ] Env do serviço systemd com `BACKUP_AGE_RECIPIENT=age1...` e `BACKUP_REQUIRE_ENCRYPTION=1`
- [ ] `BACKUP_OFFSITE_DIR` apontando p/ NAS/segundo disco montado (+ `BACKUP_OFFSITE_RETENTION_DAYS`)
- [ ] Timer instalado: `./deploy/install-backup-timer.sh` ⇒
      `systemctl list-timers petro-radar-backup.timer` mostra próximo disparo 02:30
- [ ] Teste de RESTORE do dump cifrado num Postgres efêmero:
      `BACKUP_AGE_IDENTITY=/root/petro-backup.key ./deploy/restore.sh --list <dump>.age`
- [ ] DR dry-run verde: `./deploy/dr_check.sh` (valida Postgres + blobs MinIO; exit 0)

## 4. Disco cifrado — LUKS (F8; OPS externo, ANTES do primeiro `up`)

Os volumes `pg_data` e `minio_data` (e idealmente `/var/lib/docker` inteiro)
DEVEM viver em filesystem cifrado **LUKS2** no host — é a defesa principal de
dados em repouso (LGPD). Runbook completo: **WP09 §4.1** (provisionamento
`cryptsetup luksFormat` + crypttab) e **WP09 §14.4** (residuais de OPS).

- [ ] Volume LUKS2 provisionado ANTES do primeiro `docker compose up` (migrar depois exige janela)
- [ ] Passphrase com **2 custodiantes** (TI + gestor), guardada em cofre físico/gerenciador corporativo — NUNCA no host
- [ ] `worker_state` (estado do beat do worker) também em LUKS (WP09 §11)
- [ ] Procedimento de boot documentado (quem digita a passphrase após reinício do host)
- [ ] `cryptsetup luksDump` do header exportado e custodiado (recuperação)

## 5. Rede / borda

- [ ] Portas publicadas SÓ no loopback (`127.0.0.1:3000/8000/9001`) — NGINX é a única borda
- [ ] NGINX com TLS válido interno + HSTS; `/api/cron/*` bloqueado externamente
- [ ] Egress do firewall: liberar SÓ api.anthropic.com,
      sistematransparencia.petrobras.com.br, login.microsoftonline.com e
      graph.microsoft.com (se usados) — resto fechado (deny-list DNS do compose é 2ª camada)

## 6. Pós-subida (sanidade)

- [ ] `docker compose ps` ⇒ todos `healthy`
- [ ] `SELECT count(*) FROM pg_stat_statements` responde (D2 ativo)
- [ ] `docker exec petro-radar-worker-1 celery -A celery_app inspect active_queues`
      ⇒ 2 workers: `scraper@` (fila scraping, c=1) e `geral@` (default/embeddings/ia/manutencao)
- [ ] Login admin OK via `https://radar.example.local/login`
- [ ] `make backup` manual OK e artefato `.age` gerado
