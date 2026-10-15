export const runtime = "nodejs";

/**
 * GET /api/conformidade/licitacoes-elegiveis?q=texto
 *
 * Retorna licitações candidatas a virar envelope (concluídas / homologadas /
 * adjudicadas) sem envelope ainda. Usado pelo autocomplete da tela
 * /conformidade/envelopes/novo.
 *
 * Auth: SGI/LIDER/ADMIN.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes, envelopesHabilitacao } from "@/db/schema";
import { and, or, ilike, isNull, inArray, notInArray, eq, sql, desc } from "drizzle-orm";
import { podeGerenciarEnvelope } from "@/lib/permissions";
import { requireAuth, handleApiError } from "@/lib/api/guards";

export async function GET(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarEnvelope(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();

  // IDs de licitações que já têm envelope (pra excluir do resultado)
  const jaTem = await db
    .selectDistinct({ id: envelopesHabilitacao.licitacaoId })
    .from(envelopesHabilitacao);
  const idsExcluir = jaTem.map((r) => r.id).filter((x): x is string => !!x);

  // Filtros: status terminal Petrobras (concluído, adjudicado, homologado) +
  // permite buscar tudo pra casos onde "ganhamos" mas o status ainda não veio
  const conds = [];
  if (q) {
    const termo = `%${q}%`;
    conds.push(
      or(
        ilike(licitacoes.numero, termo),
        ilike(licitacoes.objeto, termo),
        ilike(licitacoes.empresa, termo),
      )!
    );
  }
  if (idsExcluir.length > 0) {
    conds.push(notInArray(licitacoes.id, idsExcluir));
  }

  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select({
      id:           licitacoes.id,
      numero:       licitacoes.numero,
      objeto:       licitacoes.objeto,
      empresa:      licitacoes.empresa,
      status:       licitacoes.status,
      fase:         licitacoes.fase,
      dataFim:      licitacoes.dataFim,
    })
    .from(licitacoes)
    .where(where!)
    .orderBy(desc(licitacoes.atualizadoEm))
    .limit(20);

  return NextResponse.json({ data: rows });
}
