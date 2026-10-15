export const runtime = "nodejs";

/**
 * POST /api/admin/emails/assinaturas/[id]/enviar-teste — Dispara o digest REAL
 * desta assinatura AGORA, ignorando cadência e ledger (subject "[TESTE]",
 * nada é gravado). Validação instantânea do filtro/transporte pelo admin.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { assinaturasEmail, filtrosEmail, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";
import { config } from "@/lib/config";
import { enviarDigestAssinatura, normalizarCriterios } from "@/lib/digest/licitacoes";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  const [ass] = await db
    .select({
      id:         assinaturasEmail.id,
      formato:    assinaturasEmail.formato,
      email:      users.email,
      filtroNome: filtrosEmail.nome,
      criterios:  filtrosEmail.criterios,
    })
    .from(assinaturasEmail)
    .innerJoin(users, eq(assinaturasEmail.userId, users.id))
    .innerJoin(filtrosEmail, eq(assinaturasEmail.filtroId, filtrosEmail.id))
    .where(eq(assinaturasEmail.id, id))
    .limit(1);

  if (!ass) return NextResponse.json({ error: "Assinatura não encontrada" }, { status: 404 });

  const r = await enviarDigestAssinatura(
    {
      id:         ass.id,
      email:      ass.email,
      formato:    ass.formato as "resumido" | "completo",
      filtroNome: ass.filtroNome,
      criterios:  normalizarCriterios(ass.criterios),
    },
    config.crons.digestLicitacoes.maxItensPorEmail,
    true, // teste: ignora ledger e não grava nada (janela cheia de 7 dias)
  );

  await registrarAuditoria({
    userId:     session.user.id,
    acao:       "EMAIL_TESTE_ENVIADO",
    entidade:   "assinaturas_email",
    entidadeId: id,
    detalhes:   { para: ass.email, filtro: ass.filtroNome, itens: r.itens, ok: r.enviado, erro: r.erro },
  });

  if (r.erro) {
    return NextResponse.json(
      { ok: false, error: `Falha no envio: ${r.erro}`, total: r.total },
      { status: 502 },
    );
  }
  if (!r.enviado) {
    return NextResponse.json({ ok: true, enviado: false, motivo: "Nenhuma licitação casou com o filtro nos últimos 7 dias" });
  }
  return NextResponse.json({ ok: true, enviado: true, para: ass.email, itens: r.itens, total: r.total });
}
