/**
 * PRODUTOR da revogação de sessões (Decisão 4 / WIRING #4 da auditoria).
 *
 * Contrato compartilhado com o BFF (bff/app/core/revocation.py), Redis **db2**:
 *   - `auth:revogado:user:<id>`  → epoch do corte: tokens com `iat` anterior
 *     são rejeitados pelo BFF (revogação em massa por usuário).
 *   - `auth:revogados` (set) + `auth:revogados:<jti>` (chave com TTL) →
 *     revogação individual por jti (logout/token específico).
 *
 * O CONSUMIDOR é o `get_current_user` do BFF (assert_nao_revogado). Este módulo
 * só escreve. Best-effort: falha de Redis é logada e NÃO derruba a rota (a
 * segurança residual é o maxAge=8h do JWT).
 */

import Redis from "ioredis";
import { logger } from "@/lib/observability/logger";

const REVOKED_USER_PREFIX = "auth:revogado:user:";
/** Set + prefixo da chave dos `jti` revogados individualmente (contrato no BFF). */
const REVOKED_JTI_SET = "auth:revogados";
/** TTL da denylist: maxAge 8h da sessão + 1h de folga (mesmo default do BFF). */
const REVOCATION_TTL_SECONDS = 9 * 60 * 60;

let client: Redis | null | undefined;

/** URL do Redis db2 (sessão/revogação): REDIS_REVOCATION_URL ou REDIS_URL com db→2. */
function revocationRedisUrl(): string | null {
  const explicit = process.env.REDIS_REVOCATION_URL;
  if (explicit) return explicit;
  const base = process.env.REDIS_URL;
  if (!base) return null;
  // Troca o "/<db>" final por "/2" (db0 = cache/rate-limit por convenção).
  const m = base.match(/^(.*)\/(\d+)$/);
  if (m) return `${m[1]}/2`;
  return `${base.replace(/\/$/, "")}/2`;
}

function getClient(): Redis | null {
  if (client !== undefined) return client;
  const url = revocationRedisUrl();
  if (!url) {
    client = null;
    return null;
  }
  client = new Redis(url, {
    connectTimeout: 3_000,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  client.on("error", (err) => {
    logger.warn(`Redis (revogação db2) indisponível: ${err.message}`);
  });
  return client;
}

/**
 * Revoga TODAS as sessões de um usuário (corte por `iat`).
 * Chamar ao desativar (`ativo=false`), rebaixar role ou trocar senha.
 */
export async function revokeAllForUser(userId: string): Promise<void> {
  const redis = getClient();
  if (!redis || !userId) return;
  const corte = Math.floor(Date.now() / 1000);
  try {
    await redis.setex(`${REVOKED_USER_PREFIX}${userId}`, REVOCATION_TTL_SECONDS, String(corte));
    logger.info(`Sessões revogadas (corte por usuário): ${userId}`);
  } catch (err) {
    logger.error(`Falha ao revogar sessões de ${userId}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Revoga UM token/sessão específico (logout explícito) — WP09.
 *
 * Espelha `add_revoked_jti` do BFF (bff/app/core/revocation.py):
 *   - `SETEX auth:revogados:<jti> <ttl> "1"` → a chave que o `is_revoked` do BFF
 *     consulta via EXISTS (com TTL, expira sozinha; não cresce indefinidamente);
 *   - `SADD auth:revogados <jti>`            → set para inspeção/contrato.
 *
 * Chamado no evento `signOut` (src/lib/auth.ts): o BFF passa a rejeitar o token
 * na hora, sem esperar o maxAge de 8h. Best-effort: falha de Redis é logada e
 * NÃO derruba o logout (a segurança residual é o maxAge do JWT).
 */
export async function revokeJti(jti: string | null | undefined): Promise<void> {
  const redis = getClient();
  if (!redis || !jti) return;
  try {
    await redis
      .multi()
      .setex(`${REVOKED_JTI_SET}:${jti}`, REVOCATION_TTL_SECONDS, "1")
      .sadd(REVOKED_JTI_SET, jti)
      .exec();
    logger.info(`Sessão revogada (jti no logout): ${jti}`);
  } catch (err) {
    logger.error(`Falha ao revogar jti ${jti}: ${err instanceof Error ? err.message : err}`);
  }
}
