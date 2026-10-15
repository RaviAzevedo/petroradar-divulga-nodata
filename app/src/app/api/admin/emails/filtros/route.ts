export const runtime = "nodejs";

/**
 * GET  /api/admin/emails/filtros — Lista os filtros de e-mail (0026) + opções
 *      de critérios (DISTINCT de natureza/tipo_servico/segmento) p/ o painel
 * POST /api/admin/emails/filtros — Cria filtro
 *
 * Filtros de e-mail são entidade PRÓPRIA — independentes de perfis_interesse
 * (plano do digest de e-mail de licitações).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { filtrosEmail, assinaturasEmail, licitacoes } from "@/db/schema";
import { desc, sql, isNotNull } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";
import { normalizarCriterios } from "@/lib/digest/licitacoes";

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e);
  }

  const [lista, naturezas, tipos, segmentos] = await Promise.all([
    db
      .select({
        id:          filtrosEmail.id,
        nome:        filtrosEmail.nome,
        descricao:   filtrosEmail.descricao,
        criterios:   filtrosEmail.criterios,
        ativo:       filtrosEmail.ativo,
        criadoEm:    filtrosEmail.criadoEm,
        // A coluna externa PRECISA vir qualificada. Com `${filtrosEmail.id}` o Drizzle
        // renderiza apenas `"id"`, que dentro da subconsulta resolve para `a.id` —
        // a condicao vira `a.filtro_id = a.id`, sempre falsa, e TODO filtro
        // aparecia com 0 assinantes. Pior: o dialogo de exclusao esconde o aviso
        // de CASCADE quando assinantes=0, entao apagar um filtro levava junto a
        // assinatura e o ledger de envios sem avisar.
        assinantes:  sql<number>`(SELECT count(*)::int FROM ${assinaturasEmail} a WHERE a.filtro_id = ${filtrosEmail}.id)`,
      })
      .from(filtrosEmail)
      .orderBy(desc(filtrosEmail.criadoEm)),
    db.selectDistinct({ v: licitacoes.natureza }).from(licitacoes).where(isNotNull(licitacoes.natureza)),
    db.selectDistinct({ v: licitacoes.tipoServico }).from(licitacoes).where(isNotNull(licitacoes.tipoServico)),
    db.selectDistinct({ v: licitacoes.segmento }).from(licitacoes).where(isNotNull(licitacoes.segmento)),
  ]);

  return NextResponse.json({
    filtros: lista,
    opcoes: {
      naturezas:     naturezas.map((r) => r.v).filter(Boolean).sort(),
      tipos_servico: tipos.map((r) => r.v).filter(Boolean).sort(),
      segmentos:     segmentos.map((r) => r.v).filter(Boolean).sort(),
    },
  });
}

export async function POST(req: NextRequest) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e);
  }

  let body: { nome?: string; descricao?: string; criterios?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const nome = body.nome?.trim();
  if (!nome) return NextResponse.json({ error: "Campo obrigatório: nome" }, { status: 422 });

  // Normaliza na entrada: o que persiste é sempre o shape canônico.
  const criterios = normalizarCriterios(body.criterios);

  try {
    const [novo] = await db
      .insert(filtrosEmail)
      .values({ nome, descricao: body.descricao?.trim() || null, criterios, ativo: true })
      .returning({ id: filtrosEmail.id, nome: filtrosEmail.nome });

    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "FILTRO_EMAIL_CRIADO",
      entidade:   "filtros_email",
      entidadeId: novo.id,
      detalhes:   { nome, criterios },
    });

    return NextResponse.json(novo, { status: 201 });
  } catch (e: unknown) {
    // drizzle 0.45 embrulha em DrizzleQueryError — o código pg vive no cause.
    const code = (e as { code?: string; cause?: { code?: string } })?.code
      ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "Já existe um filtro com esse nome" }, { status: 409 });
    }
    return handleApiError(e, req);
  }
}
