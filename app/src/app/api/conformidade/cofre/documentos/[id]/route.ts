export const runtime = "nodejs";

/**
 * GET    /api/conformidade/cofre/documentos/[id] — Detalhe (com famílias,
 *        projetos, anexos e, na 0034, o objeto `operacao`)
 * PATCH  /api/conformidade/cofre/documentos/[id] — Edita metadados (0034:
 *        aceita operacaoId/papel/tipoDocumento/situacaoProva/detentora/restrito;
 *        0043: aceita `disciplinaId` — `null` limpa, uuid troca, ausente não mexe)
 * DELETE /api/conformidade/cofre/documentos/[id] — Remove (somente ADMIN, apaga blob)
 *
 * Restrito (0034): documento `restrito=true` responde 404 — o MESMO corpo do
 * 404 de inexistente — para papel fora de Conformidade, no GET e no PATCH.
 * 403 confirmaria a existência (ADR-05).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  documentosHabilitacao,
  acervoChunks,
  acervoIndexLog,
  auditLog,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  podeGerenciarDocumentosHabilitacao,
  podeExcluirDocumentoHabilitacao,
  isConformidade,
} from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import {
  EditarDocumentoSchema,
  formatZodErrors,
} from "@/lib/conformidade/cofre/validations";
import {
  getDocumentoById,
  getFamiliasByDocumento,
  getProjetosByDocumento,
  getAnexosByDocumento,
} from "@/lib/conformidade/cofre/queries";
import { getOperacaoById } from "@/lib/conformidade/operacoes/queries";
// 0043: trava de existência da disciplina (a mesma do POST do cofre) — handler
// não monta SQL.
import { conferirDisciplina } from "@/lib/conformidade/disciplinas/queries";
import { deleteDocumento } from "@/lib/storage/upload";

type Params = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
}

// ── GET (R17) ────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const documento = await getDocumentoById(id);
  if (!documento) return notFound();

  // Barreira restrito: o MESMO 404 do inexistente (ADR-05) — nunca 403.
  if (documento.restrito && !isConformidade(user.role)) return notFound();

  const [familias, projetos, anexos, operacaoRow] = await Promise.all([
    getFamiliasByDocumento(id),
    getProjetosByDocumento(id),
    getAnexosByDocumento(id),
    // D1 do 03-FRONTEND: o card "Operação" do detalhe precisa do objeto — o
    // MESMO shape aninhado que a lista (R6) já devolve.
    documento.operacaoId ? getOperacaoById(documento.operacaoId) : Promise.resolve(null),
  ]);

  const operacao = operacaoRow
    ? { id: operacaoRow.id, codigo: operacaoRow.codigo, clienteNome: operacaoRow.clienteNome }
    : null;

  // `operacao` como ÚLTIMA chave — a ordem das chaves é contrato de paridade.
  return NextResponse.json({ ...documento, familias, projetos, anexos, operacao });
}

// ── PATCH (R8 — B1 estendido) ────────────────────────────────────────────────

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

  const { id } = await params;
  const atual = await getDocumentoById(id);
  if (!atual) return notFound();

  // Gate 3b: papel fora de Conformidade recebe o MESMO 404 do detalhe —
  // fecha a superfície de edição sem confirmar a existência (ADR-05).
  if (atual.restrito && !isConformidade(session.user.role)) return notFound();

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const parsed = EditarDocumentoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // Gate 6: mexer em `restrito` (para qualquer lado) é privativo de
  // Conformidade — 403 SEM `code` (checagem inline, convenção do módulo).
  if (data.restrito !== undefined && !isConformidade(session.user.role)) {
    return NextResponse.json(
      { error: "Apenas Conformidade pode alterar a restrição de acesso" },
      { status: 403 }
    );
  }

  // Gate 7: operacaoId não-nulo tem de resolver ANTES do UPDATE (a FK acusaria
  // depois, com 500). `null` desvincula e NÃO passa por aqui.
  if (data.operacaoId !== undefined && data.operacaoId !== null) {
    const operacao = await getOperacaoById(data.operacaoId);
    if (!operacao) {
      return NextResponse.json(
        { error: "Operação não encontrada", code: "OPERACAO_NAO_ENCONTRADA" },
        { status: 422 }
      );
    }
  }

  // Gate 7b (0043): a disciplina não-nula tem de existir ANTES do UPDATE. Com a
  // FK `fk_doch_disciplina`, um uuid inexistente seria 23503 → 500 sem dizer o
  // campo; aqui sai 422 em `disciplinaId` (§1a). `null` limpa e NÃO passa aqui.
  if (data.disciplinaId !== undefined && data.disciplinaId !== null) {
    if (!(await conferirDisciplina(data.disciplinaId))) {
      return NextResponse.json(
        { error: "Dados inválidos", detalhes: { disciplinaId: "Disciplina não encontrada" } },
        { status: 422 }
      );
    }
  }

  const updates: Partial<typeof documentosHabilitacao.$inferInsert> = {
    atualizadoPor: session.user.id,
    atualizadoEm:  new Date(),
  };

  if (data.categoria !== undefined)             updates.categoria = data.categoria;
  if (data.subcategoria !== undefined)          updates.subcategoria = data.subcategoria;
  if (data.titulo !== undefined)                updates.titulo = data.titulo;
  if (data.descricao !== undefined)             updates.descricao = data.descricao;
  if (data.numeroDocumento !== undefined)       updates.numeroDocumento = data.numeroDocumento;
  // 0044 (B6): `null` limpa, valor troca, ausente não mexe — a mesma regra dos
  // campos 0033/0034 acima. O `{ antes, depois }` do audit NÃO ganha a chave,
  // pela mesma razão de `disciplinaId` na onda 4: o contrato do detalhe é a
  // lista FIXA de campos de 0033/0034 e o espelho Python repete a mesma lista.
  if (data.revisao !== undefined)               updates.revisao = data.revisao;
  if (data.validadeIndeterminada !== undefined) updates.validadeIndeterminada = data.validadeIndeterminada;
  if (data.status !== undefined)                updates.status = data.status;
  if (data.tags !== undefined)                  updates.tags = data.tags;
  if (data.emitidoEm !== undefined) {
    updates.emitidoEm = data.emitidoEm ? new Date(data.emitidoEm) : null;
  }
  if (data.validadeFim !== undefined) {
    updates.validadeFim = data.validadeFim ? new Date(data.validadeFim) : null;
  }
  // 0034: `null` limpa, valor troca, ausente não mexe. `operacaoId: null`
  // desvincula SEM limpar `papel` (limpar papel é decisão separada — ADR-04).
  if (data.operacaoId !== undefined)            updates.operacaoId = data.operacaoId;
  if (data.papel !== undefined)                 updates.papel = data.papel;
  if (data.tipoDocumento !== undefined)         updates.tipoDocumento = data.tipoDocumento;
  if (data.situacaoProva !== undefined)         updates.situacaoProva = data.situacaoProva;
  if (data.detentora !== undefined)             updates.detentora = data.detentora;
  if (data.restrito !== undefined)              updates.restrito = data.restrito;
  // 0043: mesma regra dos campos 0034 acima — `null` limpa a disciplina, uuid
  // troca, ausente não mexe. O `{ antes, depois }` do audit NÃO ganha a chave:
  // o contrato do detalhe é a lista fixa de campos de 0033/0034 e o espelho
  // Python repete a mesma lista (spec ONDA-4 §5.8c).
  if (data.disciplinaId !== undefined)          updates.disciplinaId = data.disciplinaId;

  // Efeito colateral de restrito false→true (S15-b): chunk já indexado não pode
  // sobreviver à marcação. O log de índice TAMBÉM sai — sem isso, DESMARCAR
  // nunca re-indexaria (o cron veria o texto_hash "já indexado" e pularia o
  // documento para sempre). Tudo na MESMA transação do UPDATE. Transições
  // false→false, true→true e true→false não disparam nada.
  const marcouRestrito = data.restrito === true && atual.restrito === false;

  const { atualizado, chunksRemovidos } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(documentosHabilitacao)
      .set(updates)
      .where(eq(documentosHabilitacao.id, id))
      .returning();

    let removidos = 0;
    if (row && marcouRestrito) {
      const chunks = await tx
        .delete(acervoChunks)
        .where(and(eq(acervoChunks.origemTipo, "DOC_HABILITACAO"), eq(acervoChunks.origemId, id)))
        .returning({ id: acervoChunks.id });
      removidos = chunks.length;
      await tx
        .delete(acervoIndexLog)
        .where(and(eq(acervoIndexLog.origemTipo, "DOC_HABILITACAO"), eq(acervoIndexLog.origemId, id)));
    }
    return { atualizado: row, chunksRemovidos: removidos };
  });

  if (!atualizado) return notFound();

  // Audit: antes/depois ganham os campos 0033/0034 — mudança de `restrito`
  // sempre visível (é o rastro que o P9/P7 exige).
  const detalhes: Record<string, unknown> = {
    antes: {
      titulo: atual.titulo,           status: atual.status,           validadeFim: atual.validadeFim,
      operacaoId: atual.operacaoId,   papel: atual.papel,
      tipoDocumento: atual.tipoDocumento, situacaoProva: atual.situacaoProva,
      detentora: atual.detentora,     restrito: atual.restrito,
    },
    depois: {
      titulo: atualizado.titulo,      status: atualizado.status,      validadeFim: atualizado.validadeFim,
      operacaoId: atualizado.operacaoId, papel: atualizado.papel,
      tipoDocumento: atualizado.tipoDocumento, situacaoProva: atualizado.situacaoProva,
      detentora: atualizado.detentora, restrito: atualizado.restrito,
    },
  };
  if (marcouRestrito) detalhes.chunksRemovidos = chunksRemovidos;

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EDITAR_DOCUMENTO_HABILITACAO",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes,
  });

  return NextResponse.json(atualizado);
}

// ── DELETE (R9 — só o audit muda) ────────────────────────────────────────────

export async function DELETE(_req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeExcluirDocumentoHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Somente administradores podem excluir documentos" }, { status: 403 });
  }

  const { id } = await params;
  const atual = await getDocumentoById(id);
  if (!atual) return notFound();

  // Apaga o blob no R2 (best-effort) — usa blobKey, não blobUrl
  try {
    await deleteDocumento(atual.blobKey);
  } catch {
    // Loga e segue — o registro do banco é mais importante para auditoria
  }

  await db.delete(documentosHabilitacao).where(eq(documentosHabilitacao.id, id));

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EXCLUIR_DOCUMENTO_HABILITACAO",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   {
      titulo: atual.titulo,
      blobKey: atual.blobKey,
      // 0034 (R9): sem estes quatro o expurgo não é reconstituível.
      operacaoId: atual.operacaoId,
      importJobId: atual.importJobId,
      origemPath: atual.origemPath,
      restrito: atual.restrito,
    },
  });

  return NextResponse.json({ ok: true, message: "Documento removido com sucesso" });
}
