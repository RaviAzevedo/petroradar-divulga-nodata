import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  resultadosLicitacao,
  propostasLicitacao,
  petronectLicResultado,
  petronectLicAndamento,
} from "@/db/schema";
import { sql, and, or, ilike, desc, asc, count, eq, gte, inArray } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { config } from "@/lib/config";
import { normalizeCnpj } from "@/lib/format";

export const runtime = "nodejs";

/**
 * GET /api/resultados — Listagem V2-primary.
 *
 * Fonte primária: petronect_lic_resultado JOIN petronect_lic_andamento.
 * Metadados legados (segmento, natureza) vêm de resultados_licitacao
 * (não populado por V2 — pipeline antigo classifica via keywords).
 *
 * Filtros suportados:
 *   • search        — número, fornecedor, objeto
 *   • segmento, natureza, empresa, cnpj_vencedor (legacy fields)
 *   • periodo       — 7d / 30d / 90d
 *   • confidence    — OFFICIAL | RANKED | PENDING | UNKNOWN | ALL (default)
 *   • subStatus     — 01..06 (granular)
 *   • sort          — valor_vencedor | data_fim | criado_em
 */
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

  // Sanitiza paginação: parseInt sem guarda gerava OFFSET NaN (page/limit inválidos).
  const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  const limit  = Math.min(Math.max(1, parseInt(searchParams.get("limit") ?? "20") || 20), 100);
  const offset = (page - 1) * limit;

  // Filtros
  const search       = searchParams.get("search") ?? "";
  const segmento     = searchParams.get("segmento") ?? "";
  const natureza     = searchParams.get("natureza") ?? "";
  const empresa      = searchParams.get("empresa") ?? "";
  const cnpjVencedor = searchParams.get("cnpj_vencedor") ?? "";
  const periodo      = searchParams.get("periodo") ?? "";
  const confidence   = (searchParams.get("confidence") ?? "ALL").toUpperCase();
  const subStatus    = searchParams.get("subStatus") ?? "";
  // Filtros novos: participação Proponente ("participou"|"venceu") e faixa de valor.
  const proponente     = searchParams.get("proponente") ?? "";
  const valorMin     = searchParams.get("valor_min") ?? "";
  const valorMax     = searchParams.get("valor_max") ?? "";
  // Presença de contrato REAL (Portal da Transparência): "" (sem filtro) |
  // "com" (valor_contrato_real IS NOT NULL) | "sem" (IS NULL).
  const contrato     = searchParams.get("contrato") ?? "";

  const sortBy = searchParams.get("sort") ?? "criado_em";
  const order  = searchParams.get("order") ?? "desc";

  // ── WHERE clause (mistura legado + V2) ───────────────────────────────────
  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(resultadosLicitacao.numeroLicitacao, `%${search}%`),
        ilike(resultadosLicitacao.fornecedorVencedor, `%${search}%`),
        ilike(resultadosLicitacao.objeto, `%${search}%`),
      ),
    );
  }
  if (segmento)     conditions.push(eq(resultadosLicitacao.segmento, segmento));
  if (natureza)     conditions.push(eq(resultadosLicitacao.natureza, natureza));
  if (empresa)      conditions.push(ilike(resultadosLicitacao.empresa, `%${empresa}%`));
  if (cnpjVencedor) conditions.push(eq(resultadosLicitacao.cnpjVencedor, cnpjVencedor));

  // Participação da Proponente: "participou" (tem proposta não declinada) ou "venceu".
  if (proponente === "participou" || proponente === "venceu") {
    const propCnpj = normalizeCnpj(config.proponente.cnpj);
    if (proponente === "participou") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM propostas_licitacao pk
        WHERE pk.numero_licitacao = ${resultadosLicitacao.numeroLicitacao}
          AND regexp_replace(pk.cnpj, '[^0-9]', '', 'g') = ${propCnpj}
          AND pk.declinou = false
      )`);
    } else {
      conditions.push(sql`regexp_replace(${resultadosLicitacao.cnpjVencedor}, '[^0-9]', '', 'g') = ${propCnpj}`);
    }
  }

  // Faixa de valor do vencedor (ignora sigilosos/nulos ao filtrar).
  const vMin = parseFloat(valorMin);
  if (Number.isFinite(vMin) && vMin > 0) {
    conditions.push(sql`${resultadosLicitacao.valorVencedor} >= ${vMin}`);
  }
  const vMax = parseFloat(valorMax);
  if (Number.isFinite(vMax) && vMax > 0) {
    conditions.push(sql`${resultadosLicitacao.valorVencedor} <= ${vMax}`);
  }

  // Presença de contrato REAL (Transparência): com/sem. Aplica no WHERE da
  // listagem — a contagem total (mesmo `where`) respeita o filtro.
  if (contrato === "com") {
    conditions.push(sql`${resultadosLicitacao.valorContratoReal} IS NOT NULL`);
  } else if (contrato === "sem") {
    conditions.push(sql`${resultadosLicitacao.valorContratoReal} IS NULL`);
  }

  if (periodo === "7d") {
    conditions.push(gte(resultadosLicitacao.criadoEm, sql`NOW() - INTERVAL '7 days'`));
  } else if (periodo === "30d") {
    conditions.push(gte(resultadosLicitacao.criadoEm, sql`NOW() - INTERVAL '30 days'`));
  } else if (periodo === "90d") {
    conditions.push(gte(resultadosLicitacao.criadoEm, sql`NOW() - INTERVAL '90 days'`));
  }

  // Filtro V2 (confidence_level): EXISTS correlacionado em vez de SELECT sem LIMIT.
  // O SELECT numero FROM petronect_lic_resultado anterior trazia a tabela inteira
  // pra memória; aqui empurramos a condição pro WHERE da query paginada.
  if (confidence !== "ALL") {
    let confWhere = sql`1=1`;
    if (confidence === "UNKNOWN") {
      confWhere = sql`pr.confidence_level IS NULL`;
    } else if (["OFFICIAL", "RANKED", "PENDING"].includes(confidence)) {
      confWhere = sql`pr.confidence_level = ${confidence}`;
    }
    conditions.push(sql`EXISTS (
      SELECT 1 FROM petronect_lic_resultado pr
      WHERE pr.numero = ${resultadosLicitacao.numeroLicitacao} AND ${confWhere}
    )`);
  }

  if (subStatus) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM petronect_lic_andamento pa
      WHERE pa.numero = ${resultadosLicitacao.numeroLicitacao} AND pa.sub_status = ${subStatus}
    )`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // ── Count + dados paginados ──────────────────────────────────────────────
  const [totalResult] = await db
    .select({ count: count() })
    .from(resultadosLicitacao)
    .where(where);

  const sortColumn = {
    valor_vencedor:      resultadosLicitacao.valorVencedor,
    total_participantes: resultadosLicitacao.totalParticipantes,
    data_fim:            resultadosLicitacao.dataFim,
    criado_em:           resultadosLicitacao.criadoEm,
  }[sortBy] ?? resultadosLicitacao.criadoEm;

  const orderFn = order === "asc" ? asc : desc;

  const rows = await db
    .select()
    .from(resultadosLicitacao)
    .where(where)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  const numerosLicitacao = rows.map((r) => r.numeroLicitacao);

  // ── Enriquecimento V2 (resultado + andamento) em lote ────────────────────
  const v2ResultadoRows = numerosLicitacao.length > 0
    ? await db
        .select()
        .from(petronectLicResultado)
        .where(inArray(petronectLicResultado.numero, numerosLicitacao))
    : [];
  const v2ResultadoMap = new Map(v2ResultadoRows.map((r) => [r.numero, r]));

  const v2AndamentoRows = numerosLicitacao.length > 0
    ? await db
        .select({
          numero:      petronectLicAndamento.numero,
          subStatus:   petronectLicAndamento.subStatus,
          status:      petronectLicAndamento.status,
          statusDesc:  petronectLicAndamento.statusDesc,
          disputeMode: petronectLicAndamento.disputeMode,
          endDate:     petronectLicAndamento.endDate,
        })
        .from(petronectLicAndamento)
        .where(inArray(petronectLicAndamento.numero, numerosLicitacao))
    : [];
  const v2AndamentoMap = new Map(v2AndamentoRows.map((r) => [r.numero, r]));

  // Proponente participou?
  const cnpjDigits = normalizeCnpj(config.proponente.cnpj);
  const proponenteParticipacoes =
    numerosLicitacao.length > 0
      ? await db
          .select({ numero: propostasLicitacao.numeroLicitacao })
          .from(propostasLicitacao)
          .where(
            and(
              sql`REGEXP_REPLACE(${propostasLicitacao.cnpj}, '[^0-9]', '', 'g') = ${cnpjDigits}`,
              inArray(propostasLicitacao.numeroLicitacao, numerosLicitacao),
            ),
          )
      : [];
  const proponenteSet = new Set(proponenteParticipacoes.map((r) => r.numero));

  // Média orçada: AVG(valor_total) por licitação a partir das propostas válidas
  // (ignora declinadas e valores nulos/zerados que sujariam a média).
  const valorMedioRows =
    numerosLicitacao.length > 0
      ? await db
          .select({
            numero: propostasLicitacao.numeroLicitacao,
            valorMedio: sql<string | null>`AVG(${propostasLicitacao.valorTotal})`,
          })
          .from(propostasLicitacao)
          .where(
            and(
              inArray(propostasLicitacao.numeroLicitacao, numerosLicitacao),
              eq(propostasLicitacao.declinou, false),
              sql`${propostasLicitacao.valorTotal} IS NOT NULL`,
              sql`${propostasLicitacao.valorTotal} > 0`,
            ),
          )
          .groupBy(propostasLicitacao.numeroLicitacao)
      : [];
  const valorMedioMap = new Map(valorMedioRows.map((r) => [r.numero, r.valorMedio]));

  const toNum = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  const data = rows.map((r) => {
    const v2r = v2ResultadoMap.get(r.numeroLicitacao);
    const v2a = v2AndamentoMap.get(r.numeroLicitacao);
    return {
      id:                 r.id,
      licitacaoId:        r.licitacaoId,
      numeroLicitacao:    r.numeroLicitacao,
      objeto:             r.objeto,
      empresa:            r.empresa,
      segmento:           r.segmento,
      natureza:           r.natureza,
      // Vencedor: V2 primário; fallback legado
      fornecedorVencedor: v2r?.fornecedorVencedor ?? r.fornecedorVencedor,
      cnpjVencedor:       v2r?.cnpjVencedor ?? r.cnpjVencedor,
      valorVencedor:      v2r ? toNum(v2r.valorVencedor) : toNum(r.valorVencedor),
      // Valor REAL do contrato (Portal da Transparência) — cron transparencia-valores.
      // A UI prefere este valor quando presente (Petronect publica só simbólico
      // em disputa fechada).
      valorContratoReal:     toNum(r.valorContratoReal),
      contratoTransparencia: r.contratoTransparencia,
      contratoVigenciaFim:   r.contratoVigenciaFim,
      // Vencedor + metadados do contrato (migration 0020) — fallback rotulado
      // na UI quando o Petronect ainda não expôs o vencedor (PENDING).
      contratoFornecedor:     r.contratoFornecedor,
      contratoCnpj:           r.contratoCnpj,
      contratoSituacao:       r.contratoSituacao,
      contratoAditivos:       r.contratoAditivos,
      contratoMoeda:          r.contratoMoeda,
      contratoVigenciaInicio: r.contratoVigenciaInicio,
      totalParticipantes: v2r?.totalParticipantes ?? r.totalParticipantes,
      totalPropostas:     v2r?.totalPropostas ?? r.totalPropostas,
      menorValor:         v2r ? toNum(v2r.menorValor) : toNum(r.menorValor),
      maiorValor:         v2r ? toNum(v2r.maiorValor) : toNum(r.maiorValor),
      valorMedio:         toNum(valorMedioMap.get(r.numeroLicitacao) ?? null),
      // Status + confidence (V2)
      statusResultado:    v2r?.statusResultado ?? r.statusResultado,
      confidenceLevel:    v2r?.confidenceLevel ?? null,
      // Header V2
      subStatus:          v2a?.subStatus ?? null,
      statusPetronect:    v2a?.statusDesc ?? null,
      disputeMode:        v2a?.disputeMode ?? null,
      // Legacy
      dataFim:            v2a?.endDate ?? r.dataFim,
      detectadoEm:        r.detectadoEm,
      criadoEm:           r.criadoEm,
      proponenteParticipou: proponenteSet.has(r.numeroLicitacao),
    };
  });

  return NextResponse.json({
    data,
    meta: {
      total: totalResult.count,
      page,
      limit,
      pages: Math.ceil(totalResult.count / limit),
    },
  });
}
