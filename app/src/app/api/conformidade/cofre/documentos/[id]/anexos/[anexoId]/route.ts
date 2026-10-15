export const runtime = "nodejs";

/**
 * PATCH  /api/conformidade/cofre/documentos/[id]/anexos/[anexoId] — edita título/tipo
 * DELETE /api/conformidade/cofre/documentos/[id]/anexos/[anexoId] — remove anexo (e blob)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosHabilitacaoAnexos, auditLog, type TipoAnexoDocumento } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, handleApiError } from "@/lib/api/guards";
import { deleteDocumento } from "@/lib/storage/upload";
import { paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";

type Params = { params: Promise<{ id: string; anexoId: string }> };

const TIPOS_VALIDOS: TipoAnexoDocumento[] = ["ANEXO", "COMPLEMENTAR", "RETIFICACAO", "OUTRO"];

export async function PATCH(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }
  const { id, anexoId } = await params;

  // Barreira do pai restrito (0034/S9) — ANTES do 404 de anexo, com a MESMA
  // string do 404 de documento inexistente (espelho do BFF).
  if (await paiRestritoInvisivel(id, session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }

  const [a] = await db.select().from(documentosHabilitacaoAnexos)
    .where(and(eq(documentosHabilitacaoAnexos.id, anexoId), eq(documentosHabilitacaoAnexos.documentoId, id)))
    .limit(1);
  if (!a) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const b = body as { tipo?: string; titulo?: string | null };

  const updates: Partial<typeof documentosHabilitacaoAnexos.$inferInsert> = {};
  if (b.tipo !== undefined) {
    if (!TIPOS_VALIDOS.includes(b.tipo as TipoAnexoDocumento)) {
      return NextResponse.json({ error: "Tipo inválido" }, { status: 422 });
    }
    updates.tipo = b.tipo as TipoAnexoDocumento;
  }
  if (b.titulo !== undefined) {
    updates.titulo = b.titulo ? String(b.titulo).slice(0, 200) : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nada a atualizar" }, { status: 422 });
  }

  const [atualizado] = await db.update(documentosHabilitacaoAnexos)
    .set(updates)
    .where(eq(documentosHabilitacaoAnexos.id, anexoId))
    .returning();

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "EDITAR_ANEXO_DOCUMENTO",
    entidade: "documento_habilitacao",
    entidadeId: id,
    detalhes: {
      anexoId,
      antes:  { tipo: a.tipo,         titulo: a.titulo },
      depois: { tipo: atualizado.tipo, titulo: atualizado.titulo },
    },
  });
  return NextResponse.json(atualizado);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }
  const { id, anexoId } = await params;

  // Barreira do pai restrito (0034/S9) — ANTES do 404 de anexo: nada é apagado
  // (nem blob, nem linha) e a resposta não denuncia a existência do pai.
  if (await paiRestritoInvisivel(id, session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }

  const [a] = await db.select().from(documentosHabilitacaoAnexos)
    .where(and(eq(documentosHabilitacaoAnexos.id, anexoId), eq(documentosHabilitacaoAnexos.documentoId, id)))
    .limit(1);
  if (!a) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });

  try { await deleteDocumento(a.blobKey); } catch { /* best-effort */ }
  await db.delete(documentosHabilitacaoAnexos).where(eq(documentosHabilitacaoAnexos.id, anexoId));

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "REMOVER_ANEXO_DOCUMENTO",
    entidade: "documento_habilitacao",
    entidadeId: id,
    detalhes: { anexoId, nomeArquivo: a.nomeArquivo },
  });
  return NextResponse.json({ ok: true });
}
