/**
 * Rate limit por chave (fixed window).
 *
 * Adapter pattern (em ordem de preferência):
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → Upstash via REST (SaaS/Vercel).
 *   - REDIS_URL → Redis por TCP via ioredis (on-prem: container `redis` do compose).
 *   - Caso contrário, fallback pra in-process Map (single-instance, só dev).
 *
 * Uso:
 *   const result = await rateLimit({ key: `login:${email}`, max: 5, windowMs: 15*60*1000 });
 *   if (!result.allowed) return 429;
 *
 * Reset (opcional, em sucesso de login):
 *   await rateLimitReset(`login:${email}`);
 */

import Redis from "ioredis";
import { logger } from "@/lib/observability/logger";

export interface RateLimitOptions {
  key:      string;
  max:      number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed:    boolean;
  remaining:  number;
  resetAt:    number;
}

// ── Detecção do adapter ─────────────────────────────────────────────────────

function getUpstashConfig(): { url: string; token: string } | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };
  return null;
}

/**
 * Indica se o rate limit é distribuído/durável (Upstash ou Redis TCP).
 *
 * Em serverless (Vercel) o fallback in-process Map é por instância e
 * efetivamente inútil — cada lambda fria tem seu próprio Map. Pontos
 * sensíveis (login, setup) devem usar isto para tratar produção-sem-backend
 * como fail-closed em vez de cair silenciosamente no Map. No on-prem o
 * REDIS_URL (container redis do compose) satisfaz o requisito.
 */
export function isRateLimitDistributed(): boolean {
  return getUpstashConfig() !== null || Boolean(process.env.REDIS_URL);
}

// ── Adapter Redis TCP (ioredis) — on-prem ───────────────────────────────────

let redisClient: Redis | null | undefined;

function getRedisClient(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }
  redisClient = new Redis(url, {
    connectTimeout: 3_000,
    maxRetriesPerRequest: 2,
    // Sem fila offline: com o Redis fora, comandos falham rápido e o caller
    // cai no fallback in-process em vez de pendurar o request.
    enableOfflineQueue: false,
  });
  redisClient.on("error", (e) => logger.error("Redis (rate limit) erro de conexão", e));
  return redisClient;
}

async function redisRateLimit(client: Redis, opts: RateLimitOptions): Promise<RateLimitResult> {
  const fullKey = `rl:${opts.key}`;
  const count = await client.incr(fullKey);
  if (count === 1) {
    await client.pexpire(fullKey, opts.windowMs);
  }
  let pttl = await client.pttl(fullKey);
  if (pttl < 0) {
    // Chave sem TTL (crash entre INCR e PEXPIRE) — repara pra não virar bloqueio eterno.
    await client.pexpire(fullKey, opts.windowMs);
    pttl = opts.windowMs;
  }
  return {
    allowed:   count <= opts.max,
    remaining: Math.max(0, opts.max - count),
    resetAt:   Date.now() + pttl,
  };
}

// ── Adapter Upstash (REST) ──────────────────────────────────────────────────
//
// Usa pipeline pra fazer INCR + EXPIRE NX numa requisição. EXPIRE NX só
// aplica TTL quando a chave ainda não tem (i.e., primeira escrita da janela).
// Doc: https://upstash.com/docs/redis/features/restapi

async function upstashRateLimit(
  cfg: { url: string; token: string },
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const seconds = Math.ceil(opts.windowMs / 1000);
  const fullKey = `rl:${opts.key}`;

  const res = await fetch(`${cfg.url}/pipeline`, {
    method:  "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR",   fullKey],
      ["EXPIRE", fullKey, String(seconds), "NX"],
      ["PTTL",   fullKey],
    ]),
  });

  if (!res.ok) {
    throw new Error(`Upstash HTTP ${res.status}`);
  }

  const out = await res.json() as Array<{ result?: number | string; error?: string }>;
  const count = Number(out[0]?.result ?? 0);
  const pttl  = Number(out[2]?.result ?? -1);
  const resetAt = pttl > 0 ? Date.now() + pttl : Date.now() + opts.windowMs;

  return {
    allowed:   count <= opts.max,
    remaining: Math.max(0, opts.max - count),
    resetAt,
  };
}

async function upstashReset(cfg: { url: string; token: string }, key: string): Promise<void> {
  const fullKey = `rl:${key}`;
  await fetch(`${cfg.url}/del/${encodeURIComponent(fullKey)}`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
}

// ── Fallback in-process ─────────────────────────────────────────────────────

interface MemRecord { count: number; resetAt: number; }
const memStore = new Map<string, MemRecord>();

function memRateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const r = memStore.get(opts.key);
  if (!r || r.resetAt < now) {
    const next: MemRecord = { count: 1, resetAt: now + opts.windowMs };
    memStore.set(opts.key, next);
    return { allowed: true, remaining: opts.max - 1, resetAt: next.resetAt };
  }
  r.count++;
  return {
    allowed:   r.count <= opts.max,
    remaining: Math.max(0, opts.max - r.count),
    resetAt:   r.resetAt,
  };
}

function memReset(key: string): void {
  memStore.delete(key);
}

// Limpeza periódica do Map em runtimes longos (best-effort; em serverless
// a instância morre antes). setInterval é desligado se globalThis não suportar.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of memStore.entries()) {
      if (v.resetAt < now) memStore.delete(k);
    }
  }, 5 * 60 * 1000).unref?.();
}

// ── API pública ─────────────────────────────────────────────────────────────

/**
 * Verifica + incrementa contador de rate limit.
 * Em caso de falha do backend (Upstash/Redis), faz fallback pro in-process —
 * segurança degradada vale mais que negar-tudo.
 */
export async function rateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const cfg = getUpstashConfig();
  if (cfg) {
    try {
      return await upstashRateLimit(cfg, opts);
    } catch (e) {
      // Falha do Upstash em runtime: o fallback in-process é por-instância e não
      // distribui em serverless — logar como error (não warn) para visibilidade.
      logger.error("Upstash rate limit falhou, usando fallback in-process", e);
      return memRateLimit(opts);
    }
  }

  const redis = getRedisClient();
  if (redis) {
    try {
      return await redisRateLimit(redis, opts);
    } catch (e) {
      logger.error("Redis rate limit falhou, usando fallback in-process", e);
      return memRateLimit(opts);
    }
  }

  return memRateLimit(opts);
}

/** Reseta o contador (ex.: após login bem-sucedido). */
export async function rateLimitReset(key: string): Promise<void> {
  const cfg = getUpstashConfig();
  if (cfg) {
    try {
      await upstashReset(cfg, key);
      return;
    } catch {
      // ignora — o contador expira sozinho
    }
  }
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(`rl:${key}`);
      return;
    } catch {
      // ignora — o contador expira sozinho
    }
  }
  memReset(key);
}

