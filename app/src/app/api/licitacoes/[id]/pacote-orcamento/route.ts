export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/licitacoes/[id]/pacote-orcamento
 *
 * Bridge para as skills Proponente: empacota em um único ZIP os insumos de
 * orçamento da licitação:
 *   - anexos do edital (anexos.s3Key) + anexos de circulares ADENDO;
 *   - briefing.md/json derivado de analises_ia (reaproveita AnaliseResult);
 *   - CHECK-LIST.xlsx pré-preenchido (exceljs).
 *
 * Auth: PROPOR (ADMIN/LIDER/ORCAMENTISTA/TECNICO) — quem orça.
 * Read-only; nenhuma escrita (sem db.transaction). Teto de bytes via LIMITE_BYTES.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes, anexos, analisesIa, circulares } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requirePropor, handleApiError } from "@/lib/api/guards";
import { loggerFor } from "@/lib/observability/logger";
import {
  montarPacoteOrcamento,
  type AnexoPacote,
} from "@/lib/licitacoes/pacote-orcamento";
import type { AnaliseRow } from "@/lib/licitacoes/briefing";
import { condicaoDeParticipar } from "@/lib/licitacoes/habilitacao-familias";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePropor();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const log = loggerFor(req, { route: "licitacoes/pacote-orcamento", licitacaoId: id });

  const [lic] = await db.select().from(licitacoes).where(eq(licitacoes.id, id)).limit(1);
  if (!lic) {
    return NextResponse.json({ error: "Licitação não encontrada" }, { status: 404 });
  }

  const [analise] = await db
    .select()
    .from(analisesIa)
    .where(eq(analisesIa.licitacaoId, id))
    .limit(1);

  // Anexos do edital
  const licAnexos = await db
    .select({
      descricao:    anexos.descricao,
      s3Key:        anexos.s3Key,
      contentType:  anexos.contentType,
      tamanhoBytes: anexos.tamanhoBytes,
    })
    .from(anexos)
    .where(eq(anexos.licitacaoId, id));

  // Anexos de circulares ADENDO — a tabela circulares só guarda metadados do
  // anexo (anexoPhioObjid/anexoDescricao), sem chave R2; entram como pendentes
  // no índice para alertar a equipe a baixar do portal.
  const adendos = await db
    .select({
      anexoDescricao: circulares.anexoDescricao,
      anexoPhioObjid: circulares.anexoPhioObjid,
    })
    .from(circulares)
    .where(and(eq(circulares.licitacaoId, id), eq(circulares.tipo, "ADENDO")));

  const anexosPacote: AnexoPacote[] = [
    ...licAnexos.map((a): AnexoPacote => ({
      descricao:    a.descricao,
      s3Key:        a.s3Key,
      contentType:  a.contentType,
      tamanhoBytes: a.tamanhoBytes,
      origem:       "EDITAL",
    })),
    ...adendos
      .filter((c) => c.anexoPhioObjid || c.anexoDescricao)
      .map((c): AnexoPacote => ({
        descricao:    c.anexoDescricao ?? c.anexoPhioObjid,
        s3Key:        null, // sem chave R2 — baixar manualmente do portal
        contentType:  null,
        tamanhoBytes: null,
        origem:       "ADENDO",
      })),
  ];

  const analiseRow: AnaliseRow | null = analise
    ? {
        resumo:               analise.resumo,
        objetoDetalhado:      analise.objetoDetalhado,
        checklist:            analise.checklist,
        requisitos:           analise.requisitos,
        criteriosHabilitacao: analise.criteriosHabilitacao,
        criteriosJulgamento:  analise.criteriosJulgamento,
        valorEstimado:        analise.valorEstimado,
        prazos:               analise.prazos,
        riscos:               analise.riscos,
        recomendacao:         analise.recomendacao,
        modeloUsado:          analise.modeloUsado,
        erroParse:            analise.erroParse,
        schemaVersao:         analise.schemaVersao,
        fonteTexto:           analise.fonteTexto,
        charsEntrada:         analise.charsEntrada,
        probVitoria:          analise.probVitoria,
        analisadoEm:          analise.analisadoEm,
      }
    : null;

  let pacote;
  try {
    const habilitacao = await condicaoDeParticipar(id).catch(() => null);
    pacote = await montarPacoteOrcamento({
      habilitacao,
      meta: {
        numero:   lic.numero,
        objeto:   lic.objeto,
        empresa:  lic.empresa,
        segmento: lic.segmento,
      },
      analise: analiseRow,
      anexos:  anexosPacote,
    });
  } catch (e) {
    log.error("falha ao montar pacote de orçamento", e);
    return NextResponse.json({ error: "Falha ao montar pacote" }, { status: 500 });
  }

  log.info("pacote gerado", {
    incluidos: pacote.incluidos,
    pulados:   pacote.pulados,
    bytes:     pacote.bytesBaixados,
  });

  return new NextResponse(new Uint8Array(pacote.buffer), {
    status: 200,
    headers: {
      "Content-Type":        "application/zip",
      "Content-Disposition": `attachment; filename="${pacote.filename}"`,
      "Cache-Control":       "no-store",
    },
  });
}
