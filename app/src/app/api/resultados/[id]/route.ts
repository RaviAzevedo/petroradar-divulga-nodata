import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  resultadosLicitacao, propostasLicitacao,
  petronectLicResultado, petronectLicAndamento, petronectLicPropostas,
  petronectLicItems, petronectLicAnexos,
} from "@/db/schema";
import { eq, asc, sql } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { config } from "@/lib/config";

export const runtime = "nodejs";

/**
 * GET /api/resultados/[id]
 *
 * Detalhe de uma licitação. Após migração V2:
 *   • Header rico vem de petronect_lic_andamento (SUB_STATUS, ANEXOS,
 *     IS_EQUALIZED, HAS_PREQUALIFIED, etc.)
 *   • Resultado consolidado vem de petronect_lic_resultado (com
 *     confidence_level OFFICIAL/RANKED/PENDING)
 *   • Propostas vêm de petronect_lic_propostas (com `characteristic`:
 *     Adjudicada/Homologada/Proposta não Avaliada/Declassified/...)
 *   • Items + Anexos do pipeline V2
 *   • Fallback para tabelas antigas (resultados_licitacao,
 *     propostas_licitacao) quando V2 ainda não migrou aquele número
 *     (poucos casos de NULL).
 *
 * O `[id]` pode ser:
 *   • UUID de resultados_licitacao.id (compat com URLs antigas)
 *   • OU numero da licitação direto (novo formato — recomendado)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!config.features.resultados) {
    return NextResponse.json({ error: "Módulo em reconstrução" }, { status: 503 });
  }
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;

  // Resolve [id] → numero da licitação. Aceita ambos UUID legado e numero direto.
  let numero: string;
  const isLikelyNumero = /^\d{8,12}$/.test(id);
  if (isLikelyNumero) {
    numero = id;
  } else {
    // Tenta UUID legado em resultados_licitacao
    const [legacyRow] = await db
      .select({ numero: resultadosLicitacao.numeroLicitacao })
      .from(resultadosLicitacao)
      .where(eq(resultadosLicitacao.id, id))
      .limit(1);
    if (!legacyRow) {
      return NextResponse.json({ error: "Resultado não encontrado" }, { status: 404 });
    }
    numero = legacyRow.numero;
  }

  const toNum = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  // ── Queries independentes (todas chaveadas por `numero`) em paralelo ──
  // v2Resultado, v2Andamento, v2Propostas, v2Items, v2Anexos e os metadados
  // legados não dependem entre si — agrupamos em Promise.all em vez de
  // awaits sequenciais. O fallback de propostas (que depende de
  // v2Propostas.length) permanece sequencial logo abaixo.
  const [
    [v2Resultado],
    [v2Andamento],
    v2Propostas,
    v2Items,
    v2Anexos,
    [legacyMeta],
  ] = await Promise.all([
    db
      .select()
      .from(petronectLicResultado)
      .where(eq(petronectLicResultado.numero, numero))
      .limit(1),
    db
      .select()
      .from(petronectLicAndamento)
      .where(eq(petronectLicAndamento.numero, numero))
      .limit(1),
    db
      .select()
      .from(petronectLicPropostas)
      .where(eq(petronectLicPropostas.numero, numero))
      .orderBy(
        asc(petronectLicPropostas.itemNumeroInt),
        asc(sql`CASE WHEN ${petronectLicPropostas.declinou} = true THEN 1 ELSE 0 END`),
        asc(petronectLicPropostas.posicao),
      ),
    db
      .select()
      .from(petronectLicItems)
      .where(eq(petronectLicItems.numero, numero)),
    db
      .select()
      .from(petronectLicAnexos)
      .where(eq(petronectLicAnexos.numero, numero)),
    db
      .select({
        objeto:    resultadosLicitacao.objeto,
        empresa:   resultadosLicitacao.empresa,
        segmento:  resultadosLicitacao.segmento,
        natureza:  resultadosLicitacao.natureza,
        // Valor REAL do contrato (Portal da Transparência) — cron transparencia-valores.
        valorContratoReal:     resultadosLicitacao.valorContratoReal,
        contratoTransparencia: resultadosLicitacao.contratoTransparencia,
        contratoVigenciaFim:   resultadosLicitacao.contratoVigenciaFim,
        // Vencedor + metadados do contrato (migration 0020) — fallback rotulado.
        contratoFornecedor:     resultadosLicitacao.contratoFornecedor,
        contratoCnpj:           resultadosLicitacao.contratoCnpj,
        contratoSituacao:       resultadosLicitacao.contratoSituacao,
        contratoAditivos:       resultadosLicitacao.contratoAditivos,
        contratoMoeda:          resultadosLicitacao.contratoMoeda,
        contratoVigenciaInicio: resultadosLicitacao.contratoVigenciaInicio,
      })
      .from(resultadosLicitacao)
      .where(eq(resultadosLicitacao.numeroLicitacao, numero))
      .limit(1),
  ]);

  // ── Propostas: prioriza V2, fallback antigo ───────────────────────
  let propostas: Array<{
    id: string; posicao: number | null; fornecedor: string | null;
    cnpj: string | null; valorTotal: number | null; valorUnitario: number | null;
    itemNumero: string | null; itemDescricao: string | null;
    meEpp: boolean | null; declinou: boolean | null; dataProposta: string | null;
    characteristic: string | null;
  }> = [];

  if (v2Propostas.length > 0) {
    propostas = v2Propostas.map((p) => ({
      id:             p.id,
      posicao:        p.posicao,
      fornecedor:     p.fornecedor,
      cnpj:           p.cnpj,
      valorTotal:     toNum(p.totalValue),
      valorUnitario:  toNum(p.unitValue),
      itemNumero:     p.itemNumeroInt,
      itemDescricao:  p.itemDescricao,
      meEpp:          p.meEpp,
      declinou:       p.declinou,
      dataProposta:   p.dataProposta,
      characteristic: p.characteristic,
    }));
  } else {
    // Fallback antigo (sem characteristic)
    const rawPropostas = await db
      .select()
      .from(propostasLicitacao)
      .where(eq(propostasLicitacao.numeroLicitacao, numero))
      .orderBy(
        asc(propostasLicitacao.itemNumero),
        asc(sql`CASE WHEN ${propostasLicitacao.declinou} = true THEN 1 ELSE 0 END`),
        asc(propostasLicitacao.posicao),
        asc(propostasLicitacao.valorTotal),
      );
    propostas = rawPropostas.map((p) => ({
      id:             p.id,
      posicao:        p.posicao,
      fornecedor:     p.fornecedor,
      cnpj:           p.cnpj,
      valorTotal:     toNum(p.valorTotal),
      valorUnitario:  toNum(p.valorUnitario),
      itemNumero:     p.itemNumero,
      itemDescricao:  p.itemDescricao,
      meEpp:          p.meEpp,
      declinou:       p.declinou,
      dataProposta:   p.dataProposta,
      characteristic: null, // tabela antiga não tem
    }));
  }

  // Agrupa por item
  const propostasPorItem: Record<string, typeof propostas> = {};
  for (const p of propostas) {
    const key = p.itemNumero ?? "__sem_item__";
    if (!propostasPorItem[key]) propostasPorItem[key] = [];
    propostasPorItem[key].push(p);
  }

  // Items + anexos do V2 (extras que UI antiga não tinha) e metadados
  // legados (objeto, empresa, segmento, natureza) já foram carregados em
  // paralelo no Promise.all acima.

  // ── Resposta consolidada ──────────────────────────────────────────
  if (!v2Resultado && !legacyMeta) {
    return NextResponse.json({ error: "Resultado não encontrado" }, { status: 404 });
  }

  return NextResponse.json({
    resultado: {
      numero,
      // metadados (V2 + legado)
      objeto:    v2Andamento?.opportDescr || legacyMeta?.objeto || null,
      empresa:   v2Andamento?.companyDesc || legacyMeta?.empresa || null,
      segmento:  legacyMeta?.segmento || null,
      natureza:  legacyMeta?.natureza || null,
      // vencedor (V2 é fonte primária)
      fornecedorVencedor: v2Resultado?.fornecedorVencedor || null,
      cnpjVencedor:       v2Resultado?.cnpjVencedor || null,
      valorVencedor:      v2Resultado ? toNum(v2Resultado.valorVencedor) : null,
      // Valor REAL do contrato (Portal da Transparência) — a UI prefere
      // este valor quando presente (Petronect publica só simbólico em
      // disputa fechada).
      valorContratoReal:     toNum(legacyMeta?.valorContratoReal),
      contratoTransparencia: legacyMeta?.contratoTransparencia ?? null,
      contratoVigenciaFim:   legacyMeta?.contratoVigenciaFim ?? null,
      // Vencedor + metadados do contrato (migration 0020) — fallback rotulado
      // na UI quando o Petronect ainda não expôs o vencedor.
      contratoFornecedor:     legacyMeta?.contratoFornecedor ?? null,
      contratoCnpj:           legacyMeta?.contratoCnpj ?? null,
      contratoSituacao:       legacyMeta?.contratoSituacao ?? null,
      contratoAditivos:       legacyMeta?.contratoAditivos ?? null,
      contratoMoeda:          legacyMeta?.contratoMoeda ?? null,
      contratoVigenciaInicio: legacyMeta?.contratoVigenciaInicio ?? null,
      totalParticipantes: v2Resultado?.totalParticipantes ?? null,
      totalPropostas:     v2Resultado?.totalPropostas ?? null,
      menorValor:         v2Resultado ? toNum(v2Resultado.menorValor) : null,
      maiorValor:         v2Resultado ? toNum(v2Resultado.maiorValor) : null,
      statusResultado:    v2Resultado?.statusResultado || null,
      confidenceLevel:    v2Resultado?.confidenceLevel ?? null,
      // header detalhado V2
      status:             v2Andamento?.status || null,
      statusDesc:         v2Andamento?.statusDesc || null,
      subStatus:          v2Andamento?.subStatus || null,
      disputeMode:        v2Andamento?.disputeMode || null,
      isEqualized:        v2Andamento?.isEqualized ?? null,
      hasPrequalified:    v2Andamento?.hasPrequalified ?? null,
      startDate:          v2Andamento?.startDate || null,
      endDate:            v2Andamento?.endDate || null,
      douPublDate:        v2Andamento?.douPublDate || null,
      descObjContrat:     v2Andamento?.descObjContrat || null,
    },
    propostas,
    propostasPorItem,
    items: v2Items.map((i) => ({
      id:            i.id,
      itemNum:       i.itemNum,
      exlin:         i.exlin,
      itemDesc:      i.itemDesc,
      unit:          i.unit,
      quantity:      toNum(i.quantity),
      delivDate:     i.delivDate,
      family:        i.family,
      familyDescr:   i.familyDescr,
    })),
    anexos: v2Anexos.map((a) => ({
      description: a.description,
      phioObjid:   a.phioObjid,
      detectedAt:  a.detectedAt,
      lastSeenAt:  a.lastSeenAt,
    })),
  });
}
