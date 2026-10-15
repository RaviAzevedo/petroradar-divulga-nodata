export const runtime = "nodejs";

/**
 * GET    /api/conformidade/familias/[id]/anexos/[anexoId]/download — proxy autenticado streaming
 * DELETE /api/conformidade/familias/[id]/anexos/[anexoId]          — remove anexo
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { familiasAnexos, auditLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { podeGerenciarFamilias, podeExcluirFamilia } from "@/lib/permissions";
import { requireAuth, handleApiError } from "@/lib/api/guards";
import { deleteDocumento } from "@/lib/storage/upload";

type Params = { params: Promise<{ id: string; anexoId: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  // Excluir anexo: gerência (não exige admin total)
  if (!podeGerenciarFamilias(session.user.role) && !podeExcluirFamilia(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }
  const { id, anexoId } = await params;

  const [a] = await db.select().from(familiasAnexos)
    .where(and(eq(familiasAnexos.id, anexoId), eq(familiasAnexos.familiaId, id)))
    .limit(1);
  if (!a) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });

  try { await deleteDocumento(a.blobKey); } catch { /* best-effort */ }
  await db.delete(familiasAnexos).where(eq(familiasAnexos.id, anexoId));

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "REMOVER_ANEXO_FAMILIA",
    entidade: "familia",
    entidadeId: id,
    detalhes: { anexoId, nomeArquivo: a.nomeArquivo },
  });
  return NextResponse.json({ ok: true });
}

export const GET = unsupported;
function unsupported(): Response {
  return NextResponse.json({ error: "Use /download" }, { status: 405 });
}
