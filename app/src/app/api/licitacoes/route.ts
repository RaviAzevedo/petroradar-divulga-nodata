import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes } from "@/db/schema";
import { sql, eq, and, or, desc, asc, count, ilike, gte, lte } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { faseAtualizada } from "@/lib/utils";
import { construirFiltrosLicitacoes } from "@/lib/licitacoes/filtros";

export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  // Sanitiza paginação: parseInt sem guarda gerava OFFSET NaN (page/limit inválidos).
  const page    = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  const limit   = Math.min(Math.max(1, parseInt(searchParams.get("limit") ?? "20") || 20), 100);
  const offset  = (page - 1) * limit;

  // Ordenação
  const sortBy = searchParams.get("sort")  ?? "score_interesse";
  const order  = searchParams.get("order") ?? "desc";

  // ── Build WHERE ────────────────────────────────────────────────────────────
  // Construtor EXTRAIDO para @/lib/licitacoes/filtros para que o
  // /api/licitacoes/export use exatamente as mesmas condicoes — antes o export
  // ignorava todos os filtros e devolvia a base inteira.
  const conditions = construirFiltrosLicitacoes(searchParams);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // ── Query ──────────────────────────────────────────────────────────────────

  const [totalResult] = await db.select({ count: count() }).from(licitacoes).where(where);

  const sortColumn = {
    score_interesse:  licitacoes.scoreInteresse,
    data_inicio:      licitacoes.dataInicio,
    data_fim:         licitacoes.dataFim,
    data_publicacao:  licitacoes.dataPublicacao,
    numero:           licitacoes.numero,
    empresa:          licitacoes.empresa,
    relevancia:       licitacoes.relevancia,
  }[sortBy] ?? licitacoes.scoreInteresse;

  const orderFn = order === "asc" ? asc : desc;

  const data = await db
    .select({
      id:             licitacoes.id,
      numero:         licitacoes.numero,
      fonte:          licitacoes.fonte,
      objeto:         licitacoes.objeto,
      empresa:        licitacoes.empresa,
      status:         licitacoes.status,
      subStatus:      licitacoes.subStatus,
      fase:           licitacoes.fase,
      modalidade:     licitacoes.modalidade,
      dataInicio:     licitacoes.dataInicio,
      dataFim:        licitacoes.dataFim,
      horaFim:        licitacoes.horaFim,
      dataPublicacao: licitacoes.dataPublicacao,
      dataDisputa:    licitacoes.dataDisputa,
      natureza:       licitacoes.natureza,
      tipoServico:    licitacoes.tipoServico,
      segmento:       licitacoes.segmento,
      relevancia:     licitacoes.relevancia,
      scoreInteresse: licitacoes.scoreInteresse,
      regioes:        licitacoes.regioes,
      abrangencia:    licitacoes.abrangencia,
      perfisMatch:    licitacoes.perfisMatch,
      melhorPerfil:   licitacoes.melhorPerfil,
      criadoEm:       licitacoes.criadoEm,
    })
    .from(licitacoes)
    .where(where)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  // Cobertura de famílias CRC da Proponente p/ os itens de CADA licitação da página.
  // Feito em UMA query agrupada sobre os ids da página (subquery correlacionada com
  // ${licitacoes.id} dentro do .select() do Drizzle não correlaciona). Cruza
  // itens.familia (normalizado) com famílias ATIVAS, mesma normalização de
  // normalizarCodigoCrc (regexp_replace upper, só A-Z0-9).
  const habMap = new Map<string, string>();
  if (data.length > 0) {
    const ids = data.map((r) => r.id);
    const covRes = await db.execute(sql`
      SELECT i.licitacao_id AS id,
        CASE
          WHEN COUNT(*) FILTER (WHERE i.familia IS NOT NULL AND i.familia <> '') = 0 THEN 'SEM_ITENS'
          WHEN COUNT(*) FILTER (WHERE m.ok) = COUNT(*) FILTER (WHERE i.familia IS NOT NULL AND i.familia <> '') THEN 'COBERTO'
          WHEN COUNT(*) FILTER (WHERE m.ok) = 0 THEN 'NENHUM'
          ELSE 'PARCIAL'
        END AS habilitacao
      FROM itens i
      LEFT JOIN LATERAL (
        SELECT EXISTS(
          SELECT 1 FROM familias f
          WHERE f.status = 'ATIVA'
            AND f.deletado_em IS NULL
            AND regexp_replace(upper(f.codigo_crc), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(i.familia), '[^A-Z0-9]', '', 'g')
        ) AS ok
      ) m ON true
      WHERE i.licitacao_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      GROUP BY i.licitacao_id
    `);
    const covRows = (Array.isArray(covRes)
      ? covRes
      : (covRes as { rows?: unknown[] }).rows ?? []) as { id: string; habilitacao: string }[];
    for (const row of covRows) habMap.set(row.id, row.habilitacao);
  }

  const dataCorrigida = data.map((r) => ({
    ...r,
    fase: faseAtualizada(r.fase, r.dataFim),
    // Licitações sem NENHUM item (não aparecem no GROUP BY) => SEM_ITENS.
    habilitacao: habMap.get(r.id) ?? "SEM_ITENS",
  }));

  return NextResponse.json({
    data: dataCorrigida,
    meta: {
      total:  totalResult.count,
      page,
      limit,
      pages:  Math.ceil(totalResult.count / limit),
    },
  });
}
