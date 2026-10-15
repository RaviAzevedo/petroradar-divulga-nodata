import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes } from "@/db/schema";
import { and, desc } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { construirFiltrosLicitacoes } from "@/lib/licitacoes/filtros";

/**
 * Escapa um campo para CSV (RFC 4180).
 *
 * Antes daqui a linha era montada com `join(",")` e só 3 das 14 colunas eram
 * citadas: qualquer vírgula em `segmento` ou `tipo_servico` DESLOCAVA todas as
 * colunas seguintes — parte das linhas saía com SCORE mostrando texto e
 * REGIÃO mostrando número, sem aviso nenhum.
 */
function campoCsv(valor: unknown): string {
  const s = valor === null || valor === undefined ? "" : String(valor);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "csv";

  // Os MESMOS filtros de /api/licitacoes. Antes a query string era
  // ignorada: o usuário filtrava /explorar, clicava em "Exportar" e levava a base
  // inteira achando que levava a seleção.
  const conditions = construirFiltrosLicitacoes(searchParams);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const data = await db
    .select({
      numero: licitacoes.numero,
      objeto: licitacoes.objeto,
      empresa: licitacoes.empresa,
      status: licitacoes.status,
      fase: licitacoes.fase,
      dataFim: licitacoes.dataFim,
      dataPublicacao: licitacoes.dataPublicacao,
      natureza: licitacoes.natureza,
      tipoServico: licitacoes.tipoServico,
      segmento: licitacoes.segmento,
      relevancia: licitacoes.relevancia,
      scoreInteresse: licitacoes.scoreInteresse,
      regioes: licitacoes.regioes,
      abrangencia: licitacoes.abrangencia,
    })
    .from(licitacoes)
    .where(where)
    .orderBy(desc(licitacoes.scoreInteresse))
    .limit(5000);

  if (format === "json") {
    return NextResponse.json(data, {
      headers: {
        "Content-Disposition": `attachment; filename="petro_radar_export.json"`,
      },
    });
  }

  // CSV
  const headers = ["NUMERO", "OBJETO", "EMPRESA", "STATUS", "FASE", "DATA_FIM", "DATA_PUBLICACAO",
    "NATUREZA", "TIPO_SERVICO", "SEGMENTO", "RELEVANCIA", "SCORE", "REGIOES", "ABRANGENCIA"];

  const csvRows = [headers.join(",")];
  for (const row of data) {
    csvRows.push([
      row.numero, row.objeto, row.empresa,
      row.status, row.fase, row.dataFim, row.dataPublicacao,
      row.natureza, row.tipoServico, row.segmento, row.relevancia,
      row.scoreInteresse ?? 0, row.regioes, row.abrangencia,
    ].map(campoCsv).join(","));
  }

  return new NextResponse(csvRows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="petro_radar_export.csv"`,
    },
  });
}
