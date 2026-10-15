export const runtime = "nodejs";

/**
 * GET /api/users
 *
 * Lista usuários ativos para uso em dropdowns de designação.
 * Retorna apenas id, nome, email, role — sem dados sensíveis.
 *
 * Query params:
 *   roles  (csv) — filtra por role: ex. "LIDER,ADMIN"
 *   ativos (bool, default true)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { UserRole } from "@/lib/permissions";
import { requireGestao, handleApiError } from "@/lib/api/guards";

export async function GET(req: NextRequest) {
  // Apenas ADMIN, LIDER e GESTOR podem listar usuários
  try {
    await requireGestao();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(req.url);
  const rolesParam = searchParams.get("roles");
  const rolesFiltro = rolesParam
    ? rolesParam.split(",").map((r) => r.trim()).filter(Boolean)
    : [];

  const conditions = [eq(users.ativo, true)];

  if (rolesFiltro.length > 0) {
    conditions.push(inArray(users.role, rolesFiltro as UserRole[]));
  }

  const lista = await db
    .select({
      id:    users.id,
      nome:  users.nome,
      email: users.email,
      role:  users.role,
    })
    .from(users)
    .where(and(...conditions))
    .orderBy(users.nome);

  return NextResponse.json({ users: lista });
}
