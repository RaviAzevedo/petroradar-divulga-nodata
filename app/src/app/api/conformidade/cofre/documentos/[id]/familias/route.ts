export const runtime = "nodejs";

/**
 * GET    /api/conformidade/cofre/documentos/[id]/familias    — lista famílias vinculadas
 * POST   /api/conformidade/cofre/documentos/[id]/familias    — vincula uma família
 * DELETE /api/conformidade/cofre/documentos/[id]/familias    — desvincula uma família
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosFamilias, auditLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import {
  VincularDocumentoFamiliaSchema,
  formatZodErrors,
} from "@/lib/conformidade/cofre/validations";
import { getFamiliasByDocumento, paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }
  const { id } = await params;
  // Barreira do pai restrito (0034/S11): 404 com a MESMA string do 404 de
  // documento inexistente (espelho de conf_cofre_doc_id_familias.py).
  if (await paiRestritoInvisivel(id, user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  const lista = await getFamiliasByDocumento(id);
  return NextResponse.json({ data: lista });
}

export async function POST(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;
  // Barreira do pai restrito (0034/S11) — antes de qualquer efeito.
  if (await paiRestritoInvisivel(id, session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const parsed = VincularDocumentoFamiliaSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) }, { status: 422 });
  }

  // Idempotência: se já existe vínculo, retorna sem erro
  const [existente] = await db
    .select({ id: documentosFamilias.id })
    .from(documentosFamilias)
    .where(and(
      eq(documentosFamilias.documentoId, id),
      eq(documentosFamilias.familiaId, parsed.data.familiaId),
    ))
    .limit(1);
  if (existente) return NextResponse.json({ id: existente.id, ok: true, status: "ja-existia" });

  const [novo] = await db.insert(documentosFamilias).values({
    documentoId: id,
    familiaId: parsed.data.familiaId,
    observacao: parsed.data.observacao ?? null,
  }).returning({ id: documentosFamilias.id });

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "VINCULAR_DOC_FAMILIA",
    entidade: "documento_habilitacao",
    entidadeId: id,
    detalhes: { familiaId: parsed.data.familiaId },
  });
  return NextResponse.json({ id: novo.id, ok: true });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;
  // Barreira do pai restrito (0034/S11) — antes de qualquer efeito.
  if (await paiRestritoInvisivel(id, session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  const familiaId = new URL(request.url).searchParams.get("familiaId");
  if (!familiaId) {
    return NextResponse.json({ error: "Query param familiaId é obrigatório" }, { status: 400 });
  }

  await db.delete(documentosFamilias).where(and(
    eq(documentosFamilias.documentoId, id),
    eq(documentosFamilias.familiaId, familiaId),
  ));

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "DESVINCULAR_DOC_FAMILIA",
    entidade: "documento_habilitacao",
    entidadeId: id,
    detalhes: { familiaId },
  });
  return NextResponse.json({ ok: true });
}
