export const runtime = "nodejs";

/**
 * PATCH  /api/admin/emails/assinaturas/[id] — Atualiza formato/frequência/ativo
 * DELETE /api/admin/emails/assinaturas/[id] — Exclui (ledger cai em CASCADE)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { assinaturasEmail } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";

type Params = { params: Promise<{ id: string }> };

const FORMATOS    = ["resumido", "completo"];
const FREQUENCIAS = ["tempo-real", "diario", "semanal"];

export async function PATCH(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  let body: { formato?: string; frequencia?: string; ativo?: boolean; relevanciaMinima?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  if (body.formato !== undefined && !FORMATOS.includes(body.formato)) {
    return NextResponse.json({ error: "Formato inválido (resumido|completo)" }, { status: 422 });
  }
  if (body.frequencia !== undefined && !FREQUENCIAS.includes(body.frequencia)) {
    return NextResponse.json({ error: "Frequência inválida (tempo-real|diario|semanal)" }, { status: 422 });
  }
  if (body.relevanciaMinima !== undefined && !["ALTA", "MEDIA", "TODAS"].includes(body.relevanciaMinima)) {
    return NextResponse.json({ error: "Relevância mínima inválida (ALTA|MEDIA|TODAS)" }, { status: 422 });
  }

  const updates: Record<string, unknown> = {};
  if (body.formato !== undefined)    updates.formato = body.formato;
  if (body.relevanciaMinima !== undefined) updates.relevanciaMinima = body.relevanciaMinima;
  if (body.frequencia !== undefined) updates.frequencia = body.frequencia;
  if (body.ativo !== undefined)      updates.ativo = body.ativo;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nenhum campo para atualizar" }, { status: 400 });
  }

  const [updated] = await db
    .update(assinaturasEmail)
    .set(updates)
    .where(eq(assinaturasEmail.id, id))
    .returning({ id: assinaturasEmail.id, formato: assinaturasEmail.formato, frequencia: assinaturasEmail.frequencia, ativo: assinaturasEmail.ativo });

  if (!updated) return NextResponse.json({ error: "Assinatura não encontrada" }, { status: 404 });

  await registrarAuditoria({
    userId:     session.user.id,
    acao:       "ASSINATURA_EMAIL_ATUALIZADA",
    entidade:   "assinaturas_email",
    entidadeId: id,
    detalhes:   updates,
  });

  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  const [excluida] = await db
    .delete(assinaturasEmail)
    .where(eq(assinaturasEmail.id, id))
    .returning({ id: assinaturasEmail.id });

  if (!excluida) return NextResponse.json({ error: "Assinatura não encontrada" }, { status: 404 });

  await registrarAuditoria({
    userId:     session.user.id,
    acao:       "ASSINATURA_EMAIL_EXCLUIDA",
    entidade:   "assinaturas_email",
    entidadeId: id,
    detalhes:   {},
  });

  return NextResponse.json({ id, excluido: true });
}
