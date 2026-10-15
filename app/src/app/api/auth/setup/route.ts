export const runtime = "nodejs";

/**
 * POST /api/auth/setup — cria o primeiro admin do sistema.
 *
 * Guards (defesa em camadas):
 *   1. Em produção, exige `SETUP_TOKEN` configurado E header `x-setup-token` válido.
 *      Sem o token, a rota retorna 503 — não há "modo aberto" em produção.
 *   2. Bloqueia se já existe QUALQUER user com role=ADMIN (independente de hash).
 *   3. Rate limit por IP: 3 tentativas em 15 minutos.
 *
 * Em dev/local, se SETUP_TOKEN não estiver setado, a rota funciona sem token —
 * mas continua bloqueada após o primeiro admin existir.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { rateLimit, isRateLimitDistributed } from "@/lib/rate-limit";
import { safeEqual } from "@/lib/security/secrets";
import { logger } from "@/lib/observability/logger";

const RATE_MAX     = 3;
const RATE_WINDOW  = 15 * 60 * 1000;

function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip") ?? "unknown";
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const isProd      = process.env.NODE_ENV === "production";
  const setupToken  = process.env.SETUP_TOKEN;

  // Guard 1 — em produção, SETUP_TOKEN é obrigatório
  if (isProd && !setupToken) {
    return NextResponse.json(
      { error: "Setup desabilitado: SETUP_TOKEN não configurado no ambiente." },
      { status: 503 },
    );
  }

  // Guard 2 — quando SETUP_TOKEN está configurado, exige header (constant-time)
  if (setupToken) {
    const provided = request.headers.get("x-setup-token") ?? "";
    if (!safeEqual(provided, setupToken)) {
      return NextResponse.json({ error: "Token de setup inválido" }, { status: 401 });
    }
  }

  // Guard 3 — fail-closed: em produção sem Upstash, o rate limit por instância
  // é inútil em serverless. Negar o setup em vez de rodar sem proteção.
  if (isProd && !isRateLimitDistributed()) {
    logger.error("Rate limit de setup não distribuído em produção (Upstash ausente) — negando setup");
    return NextResponse.json(
      { error: "Setup indisponível: rate limit distribuído não configurado." },
      { status: 503 },
    );
  }

  // Guard 4 — rate limit por IP (Upstash se configurado, in-process caso contrário)
  const ip = getClientIp(request);
  const rl = await rateLimit({ key: `setup:${ip}`, max: RATE_MAX, windowMs: RATE_WINDOW });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Muitas tentativas. Aguarde 15 minutos." },
      { status: 429 },
    );
  }

  // Guard 5 — bloqueia se já existe QUALQUER admin (independente de hash).
  // O check antigo só contava admins com passwordHash != null, deixando
  // brecha pra sobrescrever placeholders sem credenciais.
  const [admins] = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.role, "ADMIN"));

  if (admins.count > 0) {
    return NextResponse.json({ error: "Setup já realizado" }, { status: 403 });
  }

  // ── Cria o primeiro admin ──────────────────────────────────────────────────
  const body = await request.json().catch(() => ({}));
  const { email, password, nome } = body as { email?: string; password?: string; nome?: string };

  if (!email || !password) {
    return NextResponse.json({ error: "Email e senha obrigatórios" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Senha deve ter no mínimo 8 caracteres" }, { status: 400 });
  }

  const hash = await bcrypt.hash(password, 12);

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existing) {
    await db
      .update(users)
      .set({ passwordHash: hash, nome: nome || existing.nome, role: "ADMIN" })
      .where(eq(users.id, existing.id));
  } else {
    // Remove o placeholder, se existir
    await db.delete(users).where(eq(users.email, "admin@example.com"));
    await db.insert(users).values({
      email,
      nome:         nome || "Admin",
      passwordHash: hash,
      role:         "ADMIN",
    });
  }

  return NextResponse.json({ ok: true, message: `Usuário ${email} configurado com sucesso` });
}
