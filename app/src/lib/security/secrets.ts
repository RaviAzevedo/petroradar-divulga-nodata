/**
 * Helpers de comparação de segredos e autorização por Bearer token.
 *
 * Centraliza a lógica que antes estava copiada em cada cron (`autorizarCron`)
 * e usa comparação resistente a timing attack (hash SHA-256 + timingSafeEqual),
 * eliminando a comparação `===` direta de segredos.
 */

import { createHash, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

/**
 * Compara dois segredos de forma resistente a timing attack.
 * Aplica SHA-256 nos dois lados (comprimento fixo) antes do timingSafeEqual,
 * para não vazar o comprimento nem permitir inferência byte-a-byte.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Autoriza a execução de um cron/endpoint protegido por Bearer secret.
 *
 * Ordem de verificação:
 *   1. Se CRON_SECRET está configurado → SEMPRE exige Authorization: Bearer <CRON_SECRET>
 *      (comparação constant-time). O header x-vercel-cron sozinho NÃO é suficiente,
 *      pois qualquer cliente externo pode forjá-lo.
 *   2. Se CRON_SECRET NÃO está configurado (dev/local) → aceita x-vercel-cron: 1.
 */
export function verifyCronAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    return safeEqual(authHeader, `Bearer ${cronSecret}`);
  }
  return req.headers.get("x-vercel-cron") === "1";
}

/**
 * Verifica um Authorization: Bearer <expectedSecret> arbitrário de forma
 * constant-time. Retorna false se o segredo esperado não estiver configurado.
 */
export function verifyBearer(req: NextRequest, expectedSecret: string | undefined): boolean {
  if (!expectedSecret) return false;
  const authHeader = req.headers.get("authorization") ?? "";
  return safeEqual(authHeader, `Bearer ${expectedSecret}`);
}
