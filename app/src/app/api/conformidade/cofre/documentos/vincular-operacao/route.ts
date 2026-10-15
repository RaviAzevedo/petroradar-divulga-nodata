export const runtime = "nodejs";

/**
 * POST /api/conformidade/cofre/documentos/vincular-operacao — Adoção em LOTE
 * de documentos órfãos por UMA operação (R11/B3 — 0034).
 *
 * Só preenche onde `operacao_id IS NULL`: documento já vinculado é PULADO,
 * nunca sobrescrito (sobrescrever é ato unitário e consciente via PATCH do
 * documento — ADR-04). Documento restrito com requisitante fora de
 * Conformidade é pulado (motivo RESTRITO); inexistente, NAO_ENCONTRADO.
 *
 * Guard: requireAuth + podeGerenciarDocumentosHabilitacao — 403 SEM `code`
 * (adoção em lote é gesto de quem sobe documento; ORCAMENTISTA/TECNICO também).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosHabilitacao, auditLog } from "@/db/schema";
import { and, inArray, isNull } from "drizzle-orm";
import { podeGerenciarDocumentosHabilitacao, isConformidade } from "@/lib/permissions";
import { requireAuth, handleApiError } from "@/lib/api/guards";
import {
  VincularOperacaoEmLoteSchema,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";
import { getOperacaoById } from "@/lib/conformidade/operacoes/queries";

type MotivoPulado = "NAO_ENCONTRADO" | "RESTRITO" | "JA_VINCULADO";

export async function POST(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const parsed = VincularOperacaoEmLoteSchema.safeParse(body);
  if (!parsed.success) {
    // Precedência de erro (contrato §10.2): qualquer issue em `ids` vira o 422
    // FIXO sem detalhes; o resto cai no 422 padrão. O BFF replica (ids vence).
    const temIssueEmIds = parsed.error.issues.some((issue) => issue.path[0] === "ids");
    if (temIssueEmIds) {
      return NextResponse.json(
        { error: "Esperado { ids: string[] } com 1 a 200 itens" },
        { status: 422 }
      );
    }
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const { ids, operacaoId, papel } = parsed.data;

  const operacao = await getOperacaoById(operacaoId);
  if (!operacao) {
    return NextResponse.json(
      { error: "Operação não encontrada", code: "OPERACAO_NAO_ENCONTRADA" },
      { status: 422 }
    );
  }

  const encontrados = await db
    .select({
      id:         documentosHabilitacao.id,
      operacaoId: documentosHabilitacao.operacaoId,
      restrito:   documentosHabilitacao.restrito,
    })
    .from(documentosHabilitacao)
    .where(inArray(documentosHabilitacao.id, ids));

  const porId = new Map(encontrados.map((d) => [d.id, d]));
  const conformidade = isConformidade(session.user.role);

  // Classificação NA ORDEM dos ids do request — a ordem de `pulados` é contrato.
  const pulados: Array<{ id: string; motivo: MotivoPulado }> = [];
  const aprovados: string[] = [];
  for (const id of ids) {
    const doc = porId.get(id);
    if (!doc) {
      pulados.push({ id, motivo: "NAO_ENCONTRADO" });
    } else if (doc.restrito && !conformidade) {
      pulados.push({ id, motivo: "RESTRITO" });
    } else if (doc.operacaoId !== null) {
      pulados.push({ id, motivo: "JA_VINCULADO" });
    } else {
      aprovados.push(id);
    }
  }

  // UM update só. O `operacao_id IS NULL` repete a regra no banco: numa corrida
  // entre duas adoções a segunda afeta 0 linhas — `vinculados` é o rowcount do
  // UPDATE, não a contagem da classificação.
  let vinculados = 0;
  if (aprovados.length > 0) {
    const updates: Partial<typeof documentosHabilitacao.$inferInsert> = {
      operacaoId:    operacaoId,
      atualizadoPor: session.user.id,
      atualizadoEm:  new Date(),
    };
    // `papel` só entra no SET quando presente no body.
    if (papel !== undefined) updates.papel = papel;

    const linhas = await db
      .update(documentosHabilitacao)
      .set(updates)
      .where(and(
        inArray(documentosHabilitacao.id, aprovados),
        isNull(documentosHabilitacao.operacaoId),
      ))
      .returning({ id: documentosHabilitacao.id });
    vinculados = linhas.length;
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "VINCULAR_OPERACAO_EM_LOTE",
    entidade:   "documento_habilitacao",
    entidadeId: null,
    detalhes:   { operacaoId, ids, papel: papel ?? null, vinculados, pulados },
  });

  // `pulados` vazio → [] (nunca omitido).
  return NextResponse.json({ ok: true, vinculados, pulados });
}
