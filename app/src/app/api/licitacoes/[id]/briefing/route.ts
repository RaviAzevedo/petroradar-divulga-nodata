import { NextRequest, NextResponse } from "next/server";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { briefingIaHabilitado, BRIEFING_DESABILITADO } from "@/lib/licitacoes/briefing-flag";
import { db } from "@/db";
import { licitacoes, analisesIa } from "@/db/schema";
import { eq } from "drizzle-orm";
import { montarBriefingMarkdown, montarBriefingJson, type AnaliseRow, type BriefingMeta } from "@/lib/licitacoes/briefing";
import { gerarBriefingPdf, type RequisitoBriefing } from "@/lib/licitacoes/briefing-pdf";
import { condicaoDeParticipar } from "@/lib/licitacoes/habilitacao-familias";

export const runtime = "nodejs";

/**
 * GET /api/licitacoes/[id]/briefing?formato=pdf|md|json
 *
 * Gera o briefing de proposta a partir da análise IA persistida.
 *   - pdf  (default): Briefing PDF no padrão visual Proponente (12 seções).
 *   - md:  briefing.md legível (mesmo do pacote de orçamento).
 *   - json: briefing.json estruturado.
 *
 * Leitura INTERNA → requireVisualizar (barra EXTERNO), igual à rota de checklist.
 * Rota WEB-ONLY (o PDF é gerado no Next/pdf-lib; o BFF parita só o ramo de erro).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Chave geral da geração por IA (desligada por padrão).
  if (!briefingIaHabilitado()) {
    return NextResponse.json(BRIEFING_DESABILITADO, { status: 503 });
  }

  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const formato = (request.nextUrl.searchParams.get("formato") || "pdf").toLowerCase();

  const [lic] = await db.select().from(licitacoes).where(eq(licitacoes.id, id)).limit(1);
  if (!lic) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Licitação não encontrada" } }, { status: 404 });
  }

  const [analise] = await db.select().from(analisesIa).where(eq(analisesIa.licitacaoId, id)).limit(1);
  if (!analise) {
    return NextResponse.json({ error: { code: "NO_ANALYSIS", message: "Rode a analise IA primeiro" } }, { status: 400 });
  }

  const meta: BriefingMeta = {
    numero:   lic.numero,
    objeto:   lic.objeto ?? null,
    empresa:  lic.empresa ?? null,
    segmento: lic.segmento ?? null,
  };

  const row: AnaliseRow = {
    resumo:               analise.resumo ?? null,
    objetoDetalhado:      analise.objetoDetalhado ?? null,
    checklist:            analise.checklist ?? null,
    requisitos:           analise.requisitos ?? null,
    criteriosHabilitacao: analise.criteriosHabilitacao ?? null,
    criteriosJulgamento:  analise.criteriosJulgamento ?? null,
    valorEstimado:        analise.valorEstimado ?? null,
    prazos:               analise.prazos ?? null,
    riscos:               analise.riscos ?? null,
    recomendacao:         analise.recomendacao ?? null,
    modeloUsado:          analise.modeloUsado ?? null,
    erroParse:            analise.erroParse ?? null,
    schemaVersao:         analise.schemaVersao ?? null,
    fonteTexto:           analise.fonteTexto ?? null,
    charsEntrada:         analise.charsEntrada ?? null,
    probVitoria:          analise.probVitoria ?? null,
    analisadoEm:          analise.analisadoEm ?? null,
  };

  // Habilitação por família CRC — junção determinística, CUSTO ZERO DE TOKEN.
  // Não depende de a IA estar ligada, e é a única parte do briefing que responde
  // o que a PROPONENTE tem, e não o que o edital exige.
  const habilitacao = await condicaoDeParticipar(id).catch(() => null);

  if (formato === "md") {
    const md = montarBriefingMarkdown(meta, row, habilitacao);
    return new NextResponse(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="BRIEFING_${lic.numero}.md"`,
      },
    });
  }

  if (formato === "json") {
    return NextResponse.json(montarBriefingJson(meta, row));
  }

  // pdf (default): extrai requisitos_estruturados de resposta_raw (sem coluna própria)
  let reqs: RequisitoBriefing[] = [];
  if (analise.respostaRaw) {
    try {
      const raw = JSON.parse(analise.respostaRaw) as { requisitos_estruturados?: unknown };
      if (Array.isArray(raw.requisitos_estruturados)) {
        reqs = (raw.requisitos_estruturados as Array<Record<string, unknown>>)
          .map((r) => ({
            codigo:      String(r.codigo ?? ""),
            descricao:   String(r.descricao ?? ""),
            obrigatorio: r.obrigatorio !== false,
            confianca:   typeof r.confianca === "number" ? r.confianca : undefined,
          }))
          .filter((r) => r.codigo || r.descricao);
      }
    } catch {
      // resposta_raw ausente/inválido — segue sem a tabela de requisitos
    }
  }

  const buffer = await gerarBriefingPdf(meta, row, reqs, habilitacao);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="BRIEFING_${lic.numero}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
