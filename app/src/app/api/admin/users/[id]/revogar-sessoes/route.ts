export const runtime = "nodejs";

/**
 * POST /api/admin/users/[id]/revogar-sessoes — Derruba TODAS as sessões do
 * usuário na hora (corte por iat no Redis; o BFF rejeita tokens antigos —
 * Decisão 4), SEM desativar a conta. Botão "Revogar sessões" do Admin Center:
 * útil p/ sessão esquecida em máquina compartilhada ou suspeita de comprometimento.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { revokeAllForUser } from "@/lib/security/revocation";
import { registrarAuditoria } from "@/lib/audit/queries";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  const [alvo] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!alvo) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  await revokeAllForUser(id);

  await registrarAuditoria({
    userId:     session.user.id,
    acao:       "SESSOES_REVOGADAS",
    entidade:   "users",
    entidadeId: id,
    detalhes:   { email: alvo.email },
  });

  return NextResponse.json({ id, revogado: true });
}
