export const runtime = "nodejs";

/**
 * GET    /api/conformidade/familias/[id] — Detalhe (com aliases, anexos, documentos vinculados)
 * PATCH  /api/conformidade/familias/[id] — Edita
 * DELETE /api/conformidade/familias/[id] — Soft delete (somente ADMIN)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { familias, auditLog } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  podeGerenciarFamilias,
  podeExcluirFamilia,
} from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import {
  EditarFamiliaSchema,
  formatZodErrors,
  normalizarCodigoCrc,
} from "@/lib/conformidade/familias/validations";
import {
  getFamiliaById,
  getAliasesByFamilia,
  getAnexosByFamilia,
} from "@/lib/conformidade/familias/queries";
import { getDocumentosByFamilia } from "@/lib/conformidade/cofre/queries";

type Params = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Família não encontrada" }, { status: 404 });
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const familia = await getFamiliaById(id);
  if (!familia) return notFound();

  const [aliases, anexos, documentos] = await Promise.all([
    getAliasesByFamilia(id),
    getAnexosByFamilia(id),
    // 0034/S12: a lista de provas da família não denuncia o restrito a papel
    // fora de Conformidade (espelho de conf_familias_id.py no BFF).
    getDocumentosByFamilia(id, user.role),
  ]);

  return NextResponse.json({
    ...familia,
    aliases,
    anexos,
    documentos,
  });
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarFamilias(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;

  const atual = await getFamiliaById(id);
  if (!atual) return notFound();

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const parsed = EditarFamiliaSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // Se mudou o código, verifica unicidade
  if (data.codigoCrc && data.codigoCrc !== atual.codigoCrc) {
    const codigoNormalizado = normalizarCodigoCrc(data.codigoCrc);
    const [conflito] = await db
      .select({ id: familias.id })
      .from(familias)
      .where(
        and(
          eq(familias.codigoNormalizado, codigoNormalizado),
          isNull(familias.deletadoEm)
        )
      )
      .limit(1);
    if (conflito && conflito.id !== id) {
      return NextResponse.json(
        { error: `Já existe família com código ${data.codigoCrc}` },
        { status: 409 }
      );
    }
  }

  const updates: Partial<typeof familias.$inferInsert> = {
    atualizadoPor: session.user.id,
    atualizadoEm:  new Date(),
  };

  if (data.codigoCrc !== undefined) {
    updates.codigoCrc = data.codigoCrc;
    updates.codigoNormalizado = normalizarCodigoCrc(data.codigoCrc);
  }
  if (data.nome !== undefined)                updates.nome = data.nome;
  if (data.descricao !== undefined)           updates.descricao = data.descricao;
  if (data.nivel !== undefined)               updates.nivel = data.nivel;
  if (data.parentId !== undefined)            updates.parentId = data.parentId;
  if (data.cadastroCorporativo !== undefined) updates.cadastroCorporativo = data.cadastroCorporativo;
  if (data.segmentoPetrobras !== undefined)   updates.segmentoPetrobras = data.segmentoPetrobras;
  if (data.statusFluxoCrc !== undefined)      updates.statusFluxoCrc = data.statusFluxoCrc;
  if (data.status !== undefined)              updates.status = data.status;
  if (data.validadeFim !== undefined) {
    updates.validadeFim = data.validadeFim ? new Date(data.validadeFim) : null;
  }
  if (data.criterios !== undefined)        updates.criterios = data.criterios;
  if (data.tags !== undefined)             updates.tags = data.tags;
  if (data.escoposCobertos !== undefined)  updates.escoposCobertos = data.escoposCobertos;
  if (data.observacoes !== undefined)      updates.observacoes = data.observacoes;

  const [atualizada] = await db
    .update(familias)
    .set(updates)
    .where(and(eq(familias.id, id), isNull(familias.deletadoEm)))
    .returning();

  if (!atualizada) return notFound();

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EDITAR_FAMILIA",
    entidade:   "familia",
    entidadeId: id,
    detalhes:   {
      antes: {
        codigoCrc: atual.codigoCrc, nome: atual.nome, status: atual.status,
        segmentoPetrobras: atual.segmentoPetrobras, statusFluxoCrc: atual.statusFluxoCrc,
      },
      depois: {
        codigoCrc: atualizada.codigoCrc, nome: atualizada.nome, status: atualizada.status,
        segmentoPetrobras: atualizada.segmentoPetrobras, statusFluxoCrc: atualizada.statusFluxoCrc,
      },
    },
  });

  return NextResponse.json(atualizada);
}

// ── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(_req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeExcluirFamilia(session.user.role)) {
    return NextResponse.json({ error: "Somente administradores podem excluir famílias" }, { status: 403 });
  }

  const { id } = await params;
  const atual = await getFamiliaById(id);
  if (!atual) return notFound();

  await db
    .update(familias)
    .set({ deletadoEm: new Date(), atualizadoEm: new Date() })
    .where(eq(familias.id, id));

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EXCLUIR_FAMILIA",
    entidade:   "familia",
    entidadeId: id,
    detalhes:   { codigoCrc: atual.codigoCrc, nome: atual.nome },
  });

  return NextResponse.json({ ok: true, message: "Família removida com sucesso" });
}
