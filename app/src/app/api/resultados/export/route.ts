import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { resultadosLicitacao, petronectLicResultado, propostasLicitacao } from "@/db/schema";
import { sql, and, or, ilike, desc, eq, gte, inArray } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { config } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!config.features.resultados) {
    return NextResponse.json({ error: "Módulo em reconstrução" }, { status: 503 });
  }
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  const format       = searchParams.get("format") ?? "csv";
  const search       = searchParams.get("search") ?? "";
  const segmento     = searchParams.get("segmento") ?? "";
  const natureza     = searchParams.get("natureza") ?? "";
  const empresa      = searchParams.get("empresa") ?? "";
  const cnpjVencedor = searchParams.get("cnpj_vencedor") ?? "";
  const periodo      = searchParams.get("periodo") ?? "";

  // ── Build WHERE ──────────────────────────────────────────────────────────

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(resultadosLicitacao.numeroLicitacao, `%${search}%`),
        ilike(resultadosLicitacao.fornecedorVencedor, `%${search}%`),
        ilike(resultadosLicitacao.objeto, `%${search}%`),
      )
    );
  }

  if (segmento) {
    conditions.push(eq(resultadosLicitacao.segmento, segmento));
  }

  if (natureza) {
    conditions.push(eq(resultadosLicitacao.natureza, natureza));
  }

  if (empresa) {
    conditions.push(ilike(resultadosLicitacao.empresa, `%${empresa}%`));
  }

  if (cnpjVencedor) {
    conditions.push(eq(resultadosLicitacao.cnpjVencedor, cnpjVencedor));
  }

  if (periodo === "7d") {
    conditions.push(gte(resultadosLicitacao.criadoEm, sql`NOW() - INTERVAL '7 days'`));
  } else if (periodo === "30d") {
    conditions.push(gte(resultadosLicitacao.criadoEm, sql`NOW() - INTERVAL '30 days'`));
  } else if (periodo === "90d") {
    conditions.push(gte(resultadosLicitacao.criadoEm, sql`NOW() - INTERVAL '90 days'`));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // ── Query ────────────────────────────────────────────────────────────────

  const rawLegacy = await db
    .select({
      numeroLicitacao:    resultadosLicitacao.numeroLicitacao,
      objeto:             resultadosLicitacao.objeto,
      empresa:            resultadosLicitacao.empresa,
      fornecedorVencedor: resultadosLicitacao.fornecedorVencedor,
      cnpjVencedor:       resultadosLicitacao.cnpjVencedor,
      valorVencedor:      resultadosLicitacao.valorVencedor,
      totalParticipantes: resultadosLicitacao.totalParticipantes,
      segmento:           resultadosLicitacao.segmento,
      natureza:           resultadosLicitacao.natureza,
      dataFim:            resultadosLicitacao.dataFim,
    })
    .from(resultadosLicitacao)
    .where(where)
    .orderBy(desc(resultadosLicitacao.criadoEm))
    .limit(5000);

  // Enriquece com V2 (vencedor + confidence_level)
  const numeros = rawLegacy.map((r) => r.numeroLicitacao);
  const v2Rows = numeros.length > 0
    ? await db
        .select({
          numero:             petronectLicResultado.numero,
          cnpjVencedor:       petronectLicResultado.cnpjVencedor,
          fornecedorVencedor: petronectLicResultado.fornecedorVencedor,
          valorVencedor:      petronectLicResultado.valorVencedor,
          totalParticipantes: petronectLicResultado.totalParticipantes,
          statusResultado:    petronectLicResultado.statusResultado,
          confidenceLevel:    petronectLicResultado.confidenceLevel,
        })
        .from(petronectLicResultado)
        .where(inArray(petronectLicResultado.numero, numeros))
    : [];
  const v2Map = new Map(v2Rows.map((r) => [r.numero, r]));

  // Média orçada: AVG(valor_total) por licitação a partir das propostas válidas.
  const valorMedioRows = numeros.length > 0
    ? await db
        .select({
          numero:     propostasLicitacao.numeroLicitacao,
          valorMedio: sql<string | null>`AVG(${propostasLicitacao.valorTotal})`,
        })
        .from(propostasLicitacao)
        .where(
          and(
            inArray(propostasLicitacao.numeroLicitacao, numeros),
            eq(propostasLicitacao.declinou, false),
            sql`${propostasLicitacao.valorTotal} IS NOT NULL`,
            sql`${propostasLicitacao.valorTotal} > 0`,
          ),
        )
        .groupBy(propostasLicitacao.numeroLicitacao)
    : [];
  const valorMedioMap = new Map(valorMedioRows.map((r) => [r.numero, r.valorMedio]));

  const data = rawLegacy.map((r) => {
    const v2 = v2Map.get(r.numeroLicitacao);
    return {
      ...r,
      // V2 sobrescreve quando disponível
      fornecedorVencedor: v2?.fornecedorVencedor ?? r.fornecedorVencedor,
      cnpjVencedor:       v2?.cnpjVencedor ?? r.cnpjVencedor,
      valorVencedor:      v2?.valorVencedor ?? r.valorVencedor,
      totalParticipantes: v2?.totalParticipantes ?? r.totalParticipantes,
      valorMedio:         valorMedioMap.get(r.numeroLicitacao) ?? null,
      statusResultado:    v2?.statusResultado ?? null,
      confidenceLevel:    v2?.confidenceLevel ?? null,
    };
  });

  // ── JSON format ──────────────────────────────────────────────────────────

  if (format === "json") {
    return NextResponse.json(data, {
      headers: {
        "Content-Disposition": `attachment; filename="resultados_export.json"`,
      },
    });
  }

  // ── CSV format ───────────────────────────────────────────────────────────

  const csvHeaders = [
    "NUMERO_LICITACAO",
    "OBJETO",
    "EMPRESA",
    "FORNECEDOR_VENCEDOR",
    "CNPJ_VENCEDOR",
    "VALOR_VENCEDOR",
    "TOTAL_PARTICIPANTES",
    "VALOR_MEDIO_ORCADO",
    "SEGMENTO",
    "NATUREZA",
    "DATA_FIM",
    "STATUS_RESULTADO",
    "CONFIDENCE",
  ];

  const escCsv = (val: string | number | null | undefined): string => {
    if (val == null) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csvRows = [csvHeaders.join(",")];
  for (const row of data) {
    csvRows.push([
      escCsv(row.numeroLicitacao),
      escCsv(row.objeto),
      escCsv(row.empresa),
      escCsv(row.fornecedorVencedor),
      escCsv(row.cnpjVencedor),
      escCsv(row.valorVencedor),
      escCsv(row.totalParticipantes),
      escCsv(row.valorMedio),
      escCsv(row.segmento),
      escCsv(row.natureza),
      escCsv(row.dataFim),
      escCsv(row.statusResultado),
      escCsv(row.confidenceLevel),
    ].join(","));
  }

  return new NextResponse(csvRows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="resultados_export.csv"`,
    },
  });
}
