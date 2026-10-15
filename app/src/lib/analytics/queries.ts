import { db } from "@/db";
import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { config } from "@/lib/config";
import type {
  PerformanceResponse, PerformanceTrimestre,
  MercadoResponse, SegmentoMercado, SerieTemporalMes,
  ConcorrenciaResponse, ConcorrenteRanking, ConcorrenteAscensao, HeatmapCelula,
  OportunidadePerdida,
  ParticipacaoProponenteItem, ParticipacoesProponenteResponse,
  DossieConcorrente, DossieConcorrenteFamilia, DossieConcorrenteSerie, DossieConcorrenteContrato,
  DossieHistoricoTransparencia,
} from "./types";


// ── Cache config ─────────────────────────────────────────────────────────────
//
// Queries de analytics são caras (CTEs com generate_series + agregações)
// e tolerantes a 1 hora de stale — scraper roda 4x/dia, dashboard sempre
// fresco em até 1h. Quando habilitarmos `cacheComponents: true` no next.config
// (mudança maior, todas as 76 rotas dynamic-by-default viram static-by-default),
// migrar pra directive `'use cache'` + `cacheLife/cacheTag` (Next 16 path).
//
// Pra invalidar manualmente (ex.: depois de um sync grande):
//   import { revalidateTag } from "next/cache";
//   revalidateTag("analytics");

const CACHE_REVALIDATE_S = 3600;
const CACHE_TAGS_BASE    = ["analytics"];

const PROPONENTE_CNPJ = config.proponente.cnpj;

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

// ── 1. Performance Proponente por trimestre ───────────────────────────────────

/**
 * Retorna métricas trimestrais da Proponente nos últimos N trimestres
 * (default 6 = 18 meses). Para cada trimestre:
 *   - quantas licitações Proponente propôs (DISTINCT numero_licitacao)
 *   - quantas venceu (cnpj_vencedor = Proponente)
 *   - taxa de sucesso (vitórias / participações)
 *   - valor total proposto e valor total ganho
 *   - posição média (melhor posição por licitação)
 *
 * Marco temporal: `resultados_licitacao.detectado_em` (data anúncio do vencedor).
 */
async function _getPerformanceTrimestralImpl(trimestres: number): Promise<PerformanceResponse> {
  const r = await db.execute(sql`
    WITH trimestres AS (
      SELECT
        date_trunc('quarter', g) AS inicio,
        date_trunc('quarter', g) + interval '3 months' - interval '1 day' AS fim
      FROM generate_series(
        date_trunc('quarter', CURRENT_DATE) - interval '${sql.raw(String((trimestres - 1) * 3))} months',
        date_trunc('quarter', CURRENT_DATE),
        interval '3 months'
      ) g
    ),
    kp_lics AS (
      SELECT DISTINCT pl.numero_licitacao, MIN(pl.posicao) AS melhor_pos, MAX(pl.valor_total::numeric) AS valor_proposto
      FROM propostas_licitacao pl
      WHERE pl.cnpj = ${PROPONENTE_CNPJ} AND pl.declinou = false
      GROUP BY pl.numero_licitacao
    ),
    kp_convocacao AS (
      -- Conjunto de licitações em que Proponente venceu por convocação
      -- (há evento CONVOCADO ou HOMOLOGADO para o CNPJ Proponente)
      SELECT DISTINCT numero_licitacao
      FROM licitacao_eventos_vencedor
      WHERE cnpj = ${PROPONENTE_CNPJ}
        AND tipo IN ('CONVOCADO', 'HOMOLOGADO')
    )
    SELECT
      to_char(t.inicio, 'YYYY"-T"Q') AS trimestre,
      t.inicio,
      t.fim,
      COUNT(DISTINCT k.numero_licitacao)::int AS participacoes,
      COUNT(DISTINCT CASE WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} THEN k.numero_licitacao END)::int AS vitorias,
      COUNT(DISTINCT CASE
        WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} AND kc.numero_licitacao IS NULL
        THEN k.numero_licitacao END)::int AS vitorias_diretas,
      COUNT(DISTINCT CASE
        WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} AND kc.numero_licitacao IS NOT NULL
        THEN k.numero_licitacao END)::int AS vitorias_convocacao,
      COALESCE(SUM(k.valor_proposto), 0)::float AS valor_proposto,
      COALESCE(SUM(CASE WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} THEN r.valor_efetivo ELSE 0 END), 0)::float AS valor_ganho,
      AVG(k.melhor_pos)::float AS posicao_media
    FROM trimestres t
    LEFT JOIN resultados_licitacao r ON r.detectado_em >= t.inicio AND r.detectado_em <= t.fim
    LEFT JOIN kp_lics k ON k.numero_licitacao = r.numero_licitacao
    LEFT JOIN kp_convocacao kc ON kc.numero_licitacao = r.numero_licitacao
    GROUP BY t.inicio, t.fim
    ORDER BY t.inicio ASC
  `);

  type Row = {
    trimestre: string; inicio: Date; fim: Date;
    participacoes: number; vitorias: number;
    vitorias_diretas: number; vitorias_convocacao: number;
    valor_proposto: number; valor_ganho: number; posicao_media: number | null;
  };
  const rows = r.rows as unknown as Row[];

  const trimestresOut: PerformanceTrimestre[] = rows.map((row) => ({
    trimestre:          row.trimestre,
    inicio:             new Date(row.inicio).toISOString(),
    fim:                new Date(row.fim).toISOString(),
    participacoes:      toNum(row.participacoes),
    vitorias:           toNum(row.vitorias),
    vitoriasDiretas:    toNum(row.vitorias_diretas),
    vitoriasConvocacao: toNum(row.vitorias_convocacao),
    taxaSucesso:        row.participacoes > 0 ? Math.round((row.vitorias / row.participacoes) * 1000) / 10 : 0,
    valorPropostoTotal: toNum(row.valor_proposto),
    valorGanhoTotal:    toNum(row.valor_ganho),
    posicaoMedia:       toNumOrNull(row.posicao_media),
  }));

  const ultimo = trimestresOut[trimestresOut.length - 1];
  const anterior = trimestresOut[trimestresOut.length - 2];

  // Valor ganho últimos 12 meses = soma dos 4 trimestres mais recentes
  const ultimos4 = trimestresOut.slice(-4);
  const valorGanho12m = ultimos4.reduce((acc, t) => acc + t.valorGanhoTotal, 0);

  return {
    trimestres: trimestresOut,
    resumo: {
      taxaSucessoAtual:   ultimo?.taxaSucesso ?? 0,
      taxaSucessoAnterior: anterior?.taxaSucesso ?? 0,
      delta:              Math.round(((ultimo?.taxaSucesso ?? 0) - (anterior?.taxaSucesso ?? 0)) * 10) / 10,
      valorGanho12m:      Math.round(valorGanho12m * 100) / 100,
      posicaoMediaAtual:  ultimo?.posicaoMedia ?? null,
    },
  };
}

// ── 2. Mercado por segmento + série temporal ────────────────────────────────

/**
 * Mercado Petronect no período (default 12m): gasto da Petrobras por segmento,
 * evolução mensal, concentração e ME/EPP.
 *
 * Combina o que `/api/resultados/stats` e `/api/resultados/insights` faziam
 * separadamente, agora com filtro temporal real.
 */
async function _getMercadoImpl(periodoMeses: number): Promise<MercadoResponse> {
  const [segmentosResult, serieResult, totaisResult, concentracaoResult, meEppResult] = await Promise.all([
    // Segmentos no período (com performance Proponente acoplada)
    db.execute(sql`
      WITH kp_lics AS (
        SELECT DISTINCT numero_licitacao FROM propostas_licitacao
        WHERE cnpj = ${PROPONENTE_CNPJ} AND declinou = false
      )
      SELECT
        r.segmento,
        COUNT(*)::int AS total_licitacoes,
        COALESCE(SUM(r.valor_efetivo), 0)::float AS valor_total_gasto,
        AVG(r.valor_efetivo)::float AS valor_medio_vencedor,
        CASE
          WHEN AVG(r.valor_efetivo) > 0
          THEN ((MAX(r.valor_efetivo) - MIN(r.valor_efetivo)) / AVG(r.valor_efetivo) * 100)::float
          ELSE 0
        END AS spread_medio,
        AVG(r.total_participantes)::float AS media_participantes,
        COUNT(DISTINCT CASE WHEN k.numero_licitacao IS NOT NULL THEN r.numero_licitacao END)::int AS participacoes_proponente,
        COUNT(DISTINCT CASE WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} THEN r.numero_licitacao END)::int AS vitorias_proponente
      FROM resultados_licitacao r
      LEFT JOIN kp_lics k ON k.numero_licitacao = r.numero_licitacao
      WHERE r.segmento IS NOT NULL
        AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
        AND r.valor_efetivo > 0
      GROUP BY r.segmento
      HAVING COUNT(*) > 1
      ORDER BY valor_total_gasto DESC NULLS LAST
      LIMIT 20
    `),

    // Série temporal mensal
    db.execute(sql`
      SELECT
        to_char(date_trunc('month', detectado_em), 'YYYY-MM') AS mes,
        COUNT(*)::int AS total_licitacoes,
        COALESCE(SUM(valor_efetivo), 0)::float AS valor_total,
        AVG(valor_efetivo)::float AS media_preco_vencedor
      FROM resultados_licitacao
      WHERE detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
        AND valor_efetivo > 0
      GROUP BY date_trunc('month', detectado_em)
      ORDER BY date_trunc('month', detectado_em) ASC
    `),

    // Totais agregados
    db.execute(sql`
      SELECT
        COUNT(*)::int AS licitacoes_periodo,
        COALESCE(SUM(valor_efetivo), 0)::float AS valor_total_periodo,
        AVG(total_participantes)::float AS media_participantes
      FROM resultados_licitacao
      WHERE detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
    `).catch(() => ({ rows: [{ licitacoes_periodo: 0, valor_total_periodo: 0, media_participantes: 0 }] })),

    // Concentração top 5 (% dos contratos ganhos pelos 5 maiores vencedores no período)
    db.execute(sql`
      WITH ranking AS (
        SELECT cnpj_vencedor_efetivo, COUNT(*)::int AS vitorias
        FROM resultados_licitacao
        WHERE cnpj_vencedor_efetivo IS NOT NULL
          AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
        GROUP BY cnpj_vencedor_efetivo
        ORDER BY vitorias DESC
        LIMIT 5
      ),
      total AS (
        SELECT COUNT(*)::int AS t
        FROM resultados_licitacao
        WHERE cnpj_vencedor_efetivo IS NOT NULL
          AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
      )
      SELECT
        CASE WHEN total.t > 0 THEN (SUM(ranking.vitorias)::float / total.t * 100) ELSE 0 END AS concentracao
      FROM ranking, total
      GROUP BY total.t
    `),

    // % vencedores ME/EPP no período
    db.execute(sql`
      WITH vencedores_no_periodo AS (
        SELECT DISTINCT r.numero_licitacao, r.cnpj_vencedor_efetivo AS cnpj_vencedor
        FROM resultados_licitacao r
        WHERE r.cnpj_vencedor_efetivo IS NOT NULL
          AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
      )
      SELECT
        COUNT(DISTINCT v.numero_licitacao)::int AS total,
        COUNT(DISTINCT CASE WHEN p.me_epp = true THEN v.numero_licitacao END)::int AS me_epp_count
      FROM vencedores_no_periodo v
      LEFT JOIN propostas_licitacao p
        ON p.numero_licitacao = v.numero_licitacao AND p.cnpj = v.cnpj_vencedor
    `),
  ]);

  // Conta fornecedores únicos sem JOIN dummy
  const fornecedoresResult = await db.execute(sql`
    SELECT COUNT(DISTINCT p.cnpj)::int AS fornecedores_unicos
    FROM propostas_licitacao p
    INNER JOIN resultados_licitacao r ON r.numero_licitacao = p.numero_licitacao
    WHERE p.declinou = false
      AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
  `);

  type SegRow = { segmento: string; total_licitacoes: number; valor_total_gasto: number; valor_medio_vencedor: number; spread_medio: number; media_participantes: number; participacoes_proponente: number; vitorias_proponente: number };
  type SerieRow = { mes: string; total_licitacoes: number; valor_total: number; media_preco_vencedor: number };

  const segmentos: SegmentoMercado[] = (segmentosResult.rows as unknown as SegRow[]).map((s) => ({
    segmento:           s.segmento,
    totalLicitacoes:    toNum(s.total_licitacoes),
    valorTotalGasto:    Math.round(toNum(s.valor_total_gasto) * 100) / 100,
    valorMedioVencedor: Math.round(toNum(s.valor_medio_vencedor) * 100) / 100,
    spreadMedio:        Math.round(toNum(s.spread_medio) * 10) / 10,
    mediaParticipantes: Math.round(toNum(s.media_participantes) * 10) / 10,
    participacoesProponente: toNum(s.participacoes_proponente),
    vitoriasProponente:    toNum(s.vitorias_proponente),
    taxaSucessoProponente: s.participacoes_proponente > 0
      ? Math.round((s.vitorias_proponente / s.participacoes_proponente) * 1000) / 10
      : 0,
  }));

  const serieTemporal: SerieTemporalMes[] = (serieResult.rows as unknown as SerieRow[]).map((m) => ({
    mes:                m.mes,
    totalLicitacoes:    toNum(m.total_licitacoes),
    valorTotal:         Math.round(toNum(m.valor_total) * 100) / 100,
    mediaPrecoVencedor: Math.round(toNum(m.media_preco_vencedor) * 100) / 100,
  }));

  const t = (totaisResult.rows[0] as unknown as { licitacoes_periodo: number; valor_total_periodo: number; media_participantes: number }) ?? { licitacoes_periodo: 0, valor_total_periodo: 0, media_participantes: 0 };
  const concentracao = toNum((concentracaoResult.rows[0] as unknown as { concentracao: number })?.concentracao);
  const meEpp = meEppResult.rows[0] as unknown as { total: number; me_epp_count: number } | undefined;
  const fornecedoresUnicos = toNum((fornecedoresResult.rows[0] as unknown as { fornecedores_unicos: number })?.fornecedores_unicos);

  return {
    segmentos,
    serieTemporal,
    totais: {
      licitacoesPeriodo:  toNum(t.licitacoes_periodo),
      valorTotalPeriodo:  Math.round(toNum(t.valor_total_periodo) * 100) / 100,
      mediaParticipantes: Math.round(toNum(t.media_participantes) * 10) / 10,
      fornecedoresUnicos,
      concentracaoTop5:   Math.round(concentracao * 10) / 10,
      percentualMeEpp:    meEpp && meEpp.total > 0
        ? Math.round((meEpp.me_epp_count / meEpp.total) * 1000) / 10
        : 0,
    },
  };
}

// ── 3. Concorrência (top + ascensão + heatmap) ──────────────────────────────

/**
 * Análise competitiva no período: top concorrentes, em ascensão, heatmap CNPJ × segmento.
 */
async function _getConcorrenciaImpl(periodoMeses: number): Promise<ConcorrenciaResponse> {
  const [topResult, ascensaoResult, heatmapResult, segmentosTopResult] = await Promise.all([
    // Top concorrentes (encontros + vitórias) no período
    db.execute(sql`
      WITH kp_lics AS (
        SELECT DISTINCT pl.numero_licitacao
        FROM propostas_licitacao pl
        INNER JOIN resultados_licitacao r ON r.numero_licitacao = pl.numero_licitacao
        WHERE pl.cnpj = ${PROPONENTE_CNPJ}
          AND pl.declinou = false
          AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
      ),
      outros AS (
        SELECT DISTINCT o.cnpj, o.fornecedor, o.numero_licitacao
        FROM propostas_licitacao o
        INNER JOIN kp_lics k ON k.numero_licitacao = o.numero_licitacao
        WHERE o.cnpj != ${PROPONENTE_CNPJ} AND o.declinou = false
      )
      SELECT
        o.cnpj, o.fornecedor,
        COUNT(DISTINCT o.numero_licitacao)::int AS encontros,
        COUNT(DISTINCT CASE WHEN r.cnpj_vencedor_efetivo = o.cnpj THEN o.numero_licitacao END)::int AS vitorias_dele,
        COUNT(DISTINCT CASE WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} THEN o.numero_licitacao END)::int AS vitorias_proponente
      FROM outros o
      LEFT JOIN resultados_licitacao r ON r.numero_licitacao = o.numero_licitacao
      GROUP BY o.cnpj, o.fornecedor
      ORDER BY encontros DESC
      LIMIT 20
    `),

    // Concorrentes em ascensão: comparar vitórias 3m vs vitórias 12m
    db.execute(sql`
      SELECT
        cnpj_vencedor_efetivo AS cnpj,
        fornecedor_vencedor_efetivo AS fornecedor,
        COUNT(CASE WHEN detectado_em >= CURRENT_DATE - interval '3 months' THEN 1 END)::int AS vitorias_3m,
        COUNT(*)::int AS vitorias_12m
      FROM resultados_licitacao
      WHERE cnpj_vencedor_efetivo IS NOT NULL
        AND cnpj_vencedor_efetivo != ${PROPONENTE_CNPJ}
        AND detectado_em >= CURRENT_DATE - interval '12 months'
      GROUP BY cnpj_vencedor_efetivo, fornecedor_vencedor_efetivo
      HAVING COUNT(*) >= 3
      ORDER BY (COUNT(CASE WHEN detectado_em >= CURRENT_DATE - interval '3 months' THEN 1 END)::float / 3.0)
             - (COUNT(*)::float / 12.0) DESC
      LIMIT 10
    `),

    // Heatmap top 10 cnpjs × top 8 segmentos (vitórias + valor ganho)
    db.execute(sql`
      WITH top_cnpjs AS (
        SELECT cnpj_vencedor_efetivo AS cnpj_vencedor
        FROM resultados_licitacao
        WHERE cnpj_vencedor_efetivo IS NOT NULL
          AND cnpj_vencedor_efetivo != ${PROPONENTE_CNPJ}
          AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
        GROUP BY cnpj_vencedor_efetivo
        ORDER BY COUNT(*) DESC
        LIMIT 10
      ),
      top_segmentos AS (
        SELECT segmento
        FROM resultados_licitacao
        WHERE segmento IS NOT NULL
          AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
        GROUP BY segmento
        ORDER BY COUNT(*) DESC
        LIMIT 8
      )
      SELECT
        r.cnpj_vencedor_efetivo AS cnpj,
        r.fornecedor_vencedor_efetivo AS fornecedor,
        r.segmento,
        COUNT(*)::int AS vitorias,
        COALESCE(SUM(r.valor_efetivo), 0)::float AS valor_ganho
      FROM resultados_licitacao r
      INNER JOIN top_cnpjs tc ON tc.cnpj_vencedor = r.cnpj_vencedor_efetivo
      INNER JOIN top_segmentos ts ON ts.segmento = r.segmento
      WHERE r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
      GROUP BY r.cnpj_vencedor_efetivo, r.fornecedor_vencedor_efetivo, r.segmento
    `),

    // Lista de segmentos top 8 (mesmos do heatmap, retornados ordenados)
    db.execute(sql`
      SELECT segmento
      FROM resultados_licitacao
      WHERE segmento IS NOT NULL
        AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
      GROUP BY segmento
      ORDER BY COUNT(*) DESC
      LIMIT 8
    `),
  ]);

  type TopRow = { cnpj: string; fornecedor: string; encontros: number; vitorias_dele: number; vitorias_proponente: number };
  type AscRow = { cnpj: string; fornecedor: string; vitorias_3m: number; vitorias_12m: number };
  type HeatRow = { cnpj: string; fornecedor: string; segmento: string; vitorias: number; valor_ganho: number };

  const topConcorrentes: ConcorrenteRanking[] = (topResult.rows as unknown as TopRow[]).map((r) => ({
    cnpj:             r.cnpj,
    fornecedor:       r.fornecedor,
    encontros:        toNum(r.encontros),
    vitoriasDele:     toNum(r.vitorias_dele),
    vitoriasProponente: toNum(r.vitorias_proponente),
    taxaVitoriaDele:  r.encontros > 0
      ? Math.round((r.vitorias_dele / r.encontros) * 1000) / 10
      : 0,
  }));

  const emAscensao: ConcorrenteAscensao[] = (ascensaoResult.rows as unknown as AscRow[])
    .map((r) => {
      const ritmo3m = r.vitorias_3m / 3;
      const ritmo12m = r.vitorias_12m / 12;
      return {
        cnpj:        r.cnpj,
        fornecedor:  r.fornecedor,
        vitorias3m:  toNum(r.vitorias_3m),
        vitorias12m: toNum(r.vitorias_12m),
        delta:       Math.round((ritmo3m - ritmo12m) * 100) / 100,
      };
    })
    .filter((r) => r.delta > 0);

  const heatmap: HeatmapCelula[] = (heatmapResult.rows as unknown as HeatRow[]).map((r) => ({
    cnpj:       r.cnpj,
    fornecedor: r.fornecedor,
    segmento:   r.segmento,
    vitorias:   toNum(r.vitorias),
    valorGanho: Math.round(toNum(r.valor_ganho) * 100) / 100,
  }));

  const segmentosTop = (segmentosTopResult.rows as unknown as { segmento: string }[]).map((r) => r.segmento);

  return { topConcorrentes, emAscensao, heatmap, segmentosTop };
}

// ── 4. Oportunidades perdidas ───────────────────────────────────────────────

/**
 * Licitações que a Proponente NÃO participou mas tinha aderência CRC ≥ scoreMin.
 * Útil para descobrir gaps comerciais — onde poderíamos ter competido.
 */
interface OportunidadesPerdidasInput {
  scoreMin:     number;
  periodoMeses: number;
  limit:        number;
}

async function _getOportunidadesPerdidasImpl(input: OportunidadesPerdidasInput): Promise<OportunidadePerdida[]> {
  const { scoreMin, periodoMeses, limit } = input;

  const r = await db.execute(sql`
    SELECT
      l.id AS licitacao_id,
      l.numero,
      l.objeto,
      l.segmento,
      l.natureza,
      l.empresa,
      r.valor_efetivo::float AS valor_vencedor,
      r.cnpj_vencedor_efetivo AS cnpj_vencedor,
      r.fornecedor_vencedor_efetivo AS fornecedor_vencedor,
      lfm.score_aderencia AS score_aderencia,
      lfm.itens_cobertos,
      lfm.total_itens,
      r.detectado_em
    FROM licitacoes l
    INNER JOIN licitacoes_familias_match lfm ON lfm.licitacao_id = l.id
    INNER JOIN resultados_licitacao r ON r.numero_licitacao = l.numero
    WHERE lfm.score_aderencia >= ${scoreMin}
      AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'
      AND l.numero NOT IN (
        SELECT DISTINCT numero_licitacao FROM propostas_licitacao
        WHERE cnpj = ${PROPONENTE_CNPJ} AND declinou = false
      )
    ORDER BY lfm.score_aderencia DESC, r.detectado_em DESC
    LIMIT ${limit}
  `);

  type Row = {
    licitacao_id: string;
    numero: string;
    objeto: string | null;
    segmento: string | null;
    natureza: string | null;
    empresa: string | null;
    valor_vencedor: number | null;
    cnpj_vencedor: string | null;
    fornecedor_vencedor: string | null;
    score_aderencia: number;
    itens_cobertos: number;
    total_itens: number;
    detectado_em: Date;
  };

  return (r.rows as unknown as Row[]).map((row) => ({
    licitacaoId:       row.licitacao_id,
    numero:            row.numero,
    objeto:            row.objeto,
    segmento:          row.segmento,
    natureza:          row.natureza,
    empresa:           row.empresa,
    valorVencedor:     toNumOrNull(row.valor_vencedor),
    cnpjVencedor:      row.cnpj_vencedor,
    fornecedorVencedor: row.fornecedor_vencedor,
    scoreAderencia:    Math.round(toNum(row.score_aderencia) * 10) / 10,
    itensCobertos:     toNum(row.itens_cobertos),
    totalItens:        toNum(row.total_itens),
    detectadoEm:       new Date(row.detectado_em).toISOString(),
  }));
}

// ── 5. Lista Proponente (todas as licitações onde propôs) ────────────────────

/**
 * Lista todas as licitações onde Proponente fez proposta (em propostas_licitacao).
 * Para cada uma, junta:
 *   - dados da licitação (objeto, segmento)
 *   - posição e valor da nossa proposta (melhor de todos os itens)
 *   - vencedor atual (do resultado, refletindo eventos pós-resultado)
 *   - pipeline interno (participacoesLicitacao) se houver
 *   - flag de "venceu por convocação" (via licitacao_eventos_vencedor)
 *
 * Filtros: período (meses), status (GANHOU/PERDEU/CANCELADA/SEM_RESULTADO/SEM_PIPELINE),
 * segmento, busca textual.
 */
export async function getParticipacoesProponente(input: {
  periodoMeses?: number;       // default 12; -1 ou 0 = sem filtro temporal
  status?:       string;       // GANHOU | PERDEU | CANCELADA | SEM_RESULTADO | SEM_PIPELINE | undefined
  segmento?:    string;
  search?:      string;
  limit?:       number;
} = {}): Promise<ParticipacoesProponenteResponse> {
  const periodoMeses = input.periodoMeses ?? 12;
  const limit = input.limit ?? 200;
  const search = (input.search ?? "").trim();
  const filtroSegmento = (input.segmento ?? "").trim();
  const filtroStatus = input.status ?? "";

  const periodoClause = periodoMeses > 0
    ? sql`AND COALESCE(r.detectado_em, pl.created_at_dummy) >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months'`
    : sql``;

  // Nota: não há `created_at_dummy` — uso só r.detectado_em quando aplicável
  const clausulaTempo = periodoMeses > 0
    ? sql`AND (r.detectado_em IS NULL OR r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(periodoMeses))} months')`
    : sql``;

  // Filtro de segmento
  const clausulaSegmento = filtroSegmento
    ? sql`AND (r.segmento = ${filtroSegmento} OR l.segmento = ${filtroSegmento})`
    : sql``;

  // Busca textual em numero, objeto, fornecedor_vencedor
  const searchPattern = `%${search}%`;
  const clausulaSearch = search.length >= 2
    ? sql`AND (
        pl.numero_licitacao ILIKE ${searchPattern}
        OR l.objeto ILIKE ${searchPattern}
        OR r.fornecedor_vencedor_efetivo ILIKE ${searchPattern}
      )`
    : sql``;

  void periodoClause; // referência só para evitar import warning

  const r = await db.execute(sql`
    WITH kp_propostas AS (
      SELECT
        pl.numero_licitacao,
        MIN(pl.posicao) FILTER (WHERE pl.posicao IS NOT NULL) AS melhor_posicao,
        MAX(pl.valor_total::numeric) AS valor_proposta,
        MAX(pl.data_proposta) AS data_proposta,        -- text livre vindo do portal
        MAX(pl.criado_em)     AS proposta_criada_em    -- timestamptz para ordenação confiável
      FROM propostas_licitacao pl
      WHERE pl.cnpj = ${PROPONENTE_CNPJ} AND pl.declinou = false
      GROUP BY pl.numero_licitacao
    ),
    kp_part AS (
      SELECT DISTINCT ON (numero_edital)
        id, numero_edital, fase, resultado, versao
      FROM participacoes_licitacao
      WHERE deletado_em IS NULL
      ORDER BY numero_edital, atualizado_em DESC NULLS LAST
    ),
    kp_convocacao AS (
      SELECT DISTINCT numero_licitacao
      FROM licitacao_eventos_vencedor
      WHERE cnpj = ${PROPONENTE_CNPJ}
        AND tipo IN ('CONVOCADO', 'HOMOLOGADO')
    )
    SELECT
      kpr.numero_licitacao,
      l.id AS licitacao_id,
      COALESCE(r.objeto, l.objeto) AS objeto,
      COALESCE(r.segmento, l.segmento) AS segmento,
      COALESCE(r.empresa, l.empresa) AS empresa,
      kpr.melhor_posicao,
      kpr.valor_proposta::float AS valor_proposta,
      kpr.data_proposta,
      r.cnpj_vencedor_efetivo AS cnpj_vencedor,
      r.fornecedor_vencedor_efetivo AS fornecedor_vencedor,
      r.valor_efetivo::float AS valor_vencedor,
      r.total_participantes,
      r.detectado_em AS resultado_em,
      kp.id AS participacao_id,
      kp.fase AS participacao_fase,
      kp.resultado AS participacao_resultado,
      kp.versao AS participacao_versao,
      -- Hierarquia: portal é source of truth. Pipeline só vale quando portal silencia
      -- ou para detectar conflito explicitamente.
      CASE
        WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ}                          THEN true   -- portal confirma
        WHEN r.cnpj_vencedor_efetivo IS NULL AND kp.resultado = 'GANHOU'         THEN true   -- portal mudo, pipeline diz ganhou
        ELSE false
      END AS proponente_venceu,
      CASE WHEN kc.numero_licitacao IS NOT NULL THEN true ELSE false END AS venceu_por_convocacao,
      -- Tipagem do tipo de vitória (DIRETA, CONVOCACAO, PIPELINE_ONLY, CONFLITO)
      CASE
        WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} AND kc.numero_licitacao IS NOT NULL THEN 'CONVOCACAO'
        WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ}                                      THEN 'DIRETA'
        WHEN r.cnpj_vencedor_efetivo IS NULL AND kp.resultado = 'GANHOU'                     THEN 'PIPELINE_ONLY'
        WHEN r.cnpj_vencedor_efetivo IS NOT NULL AND r.cnpj_vencedor_efetivo != ${PROPONENTE_CNPJ}
             AND kp.resultado = 'GANHOU'                                             THEN 'CONFLITO'
        ELSE NULL
      END AS vitoria_tipo
    FROM kp_propostas kpr
    LEFT JOIN licitacoes l ON l.numero = kpr.numero_licitacao
    LEFT JOIN resultados_licitacao r ON r.numero_licitacao = kpr.numero_licitacao
    LEFT JOIN kp_part kp ON kp.numero_edital = kpr.numero_licitacao
    LEFT JOIN kp_convocacao kc ON kc.numero_licitacao = kpr.numero_licitacao
    WHERE 1=1
      ${clausulaTempo}
      ${clausulaSegmento}
      ${clausulaSearch}
    ORDER BY COALESCE(r.detectado_em, kpr.proposta_criada_em) DESC NULLS LAST
    LIMIT ${limit}
  `);

  type Row = {
    numero_licitacao:    string;
    licitacao_id:        string | null;
    objeto:              string | null;
    segmento:            string | null;
    empresa:             string | null;
    melhor_posicao:      number | null;
    valor_proposta:      number | null;
    data_proposta:       string | null;
    cnpj_vencedor:       string | null;
    fornecedor_vencedor: string | null;
    valor_vencedor:      number | null;
    total_participantes: number | null;
    resultado_em:        Date | null;
    participacao_id:     string | null;
    participacao_fase:   string | null;
    participacao_resultado: string | null;
    participacao_versao: number | null;
    proponente_venceu:     boolean;
    venceu_por_convocacao: boolean;
    vitoria_tipo:        "DIRETA" | "CONVOCACAO" | "PIPELINE_ONLY" | "CONFLITO" | null;
  };

  const todos: ParticipacaoProponenteItem[] = (r.rows as unknown as Row[]).map((row) => ({
    numeroLicitacao:       row.numero_licitacao,
    licitacaoId:           row.licitacao_id,
    objeto:                row.objeto,
    segmento:              row.segmento,
    empresa:               row.empresa,
    melhorPosicao:         row.melhor_posicao != null ? toNum(row.melhor_posicao) : null,
    valorProposta:         toNumOrNull(row.valor_proposta),
    dataProposta:          row.data_proposta ?? null,
    cnpjVencedorAtual:     row.cnpj_vencedor,
    fornecedorVencedor:    row.fornecedor_vencedor,
    valorVencedor:         toNumOrNull(row.valor_vencedor),
    totalParticipantes:    row.total_participantes != null ? toNum(row.total_participantes) : null,
    resultadoEm:           row.resultado_em ? new Date(row.resultado_em).toISOString() : null,
    participacaoId:        row.participacao_id,
    participacaoFase:      row.participacao_fase,
    participacaoResultado: row.participacao_resultado,
    participacaoVersao:    row.participacao_versao,
    proponenteVenceu:        row.proponente_venceu,
    vitoriaTipo:           row.vitoria_tipo,
    venceuPorConvocacao:   row.venceu_por_convocacao,
  }));

  // Filtros derivados da hierarquia portal > eventos > pipeline
  const isVitoria   = (p: ParticipacaoProponenteItem) => p.proponenteVenceu;
  const isPerdaPort = (p: ParticipacaoProponenteItem) =>
    !p.proponenteVenceu && !!p.cnpjVencedorAtual && p.cnpjVencedorAtual !== PROPONENTE_CNPJ;
  const isPerda     = (p: ParticipacaoProponenteItem) =>
    isPerdaPort(p) || (p.participacaoResultado === "PERDEU" && !p.proponenteVenceu);
  const isConflito  = (p: ParticipacaoProponenteItem) => p.vitoriaTipo === "CONFLITO";

  let data = todos;
  if (filtroStatus === "GANHOU") {
    data = todos.filter(isVitoria);
  } else if (filtroStatus === "PERDEU") {
    data = todos.filter((p) => !p.proponenteVenceu && isPerda(p) && p.participacaoResultado !== "CANCELADA");
  } else if (filtroStatus === "CANCELADA") {
    data = todos.filter((p) => p.participacaoResultado === "CANCELADA");
  } else if (filtroStatus === "SEM_RESULTADO") {
    data = todos.filter((p) => !p.cnpjVencedorAtual && !p.participacaoResultado);
  } else if (filtroStatus === "SEM_PIPELINE") {
    data = todos.filter((p) => !p.participacaoId);
  } else if (filtroStatus === "CONFLITO") {
    data = todos.filter(isConflito);
  }

  // Totais sempre baseados em `todos`, não no filtrado
  const totais = {
    total:           todos.length,
    ganhou:          todos.filter(isVitoria).length,
    perdeu:          todos.filter((p) => !p.proponenteVenceu && isPerda(p) && p.participacaoResultado !== "CANCELADA").length,
    cancelou:        todos.filter((p) => p.participacaoResultado === "CANCELADA").length,
    semResultado:    todos.filter((p) => !p.cnpjVencedorAtual && !p.participacaoResultado).length,
    semParticipacao: todos.filter((p) => !p.participacaoId).length,
  };

  return { data, totais };
}

// ── 6. Ficha de Concorrente 360 (dossiê por CNPJ) ───────────────────────────

async function _getDossieConcorrenteImpl(cnpj: string, meses: number): Promise<DossieConcorrente> {
  const [
    globalResult, h2hResult, familiasResult, serieResult, tendResult, contratosResult,
    transpResumoResult, transpAnoResult, transpUnidadesResult, transpModalidadesResult, transpMaioresResult,
  ] = await Promise.all([
    // Histórico global de disputas + agressividade de preço + desclassificações
    db.execute(sql`
      WITH encontros AS (
        SELECT DISTINCT numero_licitacao FROM propostas_licitacao
        WHERE cnpj = ${cnpj} AND declinou = false
      ),
      vitorias AS (
        SELECT r.numero_licitacao, r.valor_efetivo AS vv, r.maior_valor::numeric AS maior
        FROM resultados_licitacao r
        WHERE r.cnpj_vencedor_efetivo = ${cnpj}
          AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
      )
      SELECT
        (SELECT COUNT(*)::int FROM encontros)                                      AS encontros,
        (SELECT COUNT(*)::int FROM vitorias)                                       AS vitorias,
        (SELECT AVG(CASE WHEN maior > 0 THEN (maior - vv) / maior * 100 END)::float
           FROM vitorias WHERE maior > 0)                                          AS desconto_medio,
        (SELECT MAX(p.fornecedor) FROM propostas_licitacao p WHERE p.cnpj = ${cnpj}) AS fornecedor,
        (SELECT COUNT(*)::int FROM licitacao_eventos_vencedor
          WHERE cnpj = ${cnpj} AND tipo = 'DESCLASSIFICADO')                       AS desclassificacoes
    `),

    // Head-to-head vs Proponente
    db.execute(sql`
      WITH conjuntas AS (
        SELECT DISTINCT pk.numero_licitacao
        FROM propostas_licitacao pk
        JOIN propostas_licitacao pc ON pc.numero_licitacao = pk.numero_licitacao
        WHERE pk.cnpj = ${PROPONENTE_CNPJ} AND pk.declinou = false
          AND pc.cnpj = ${cnpj} AND pc.declinou = false
      )
      SELECT
        COUNT(*)::int                                                              AS encontros,
        COUNT(CASE WHEN r.cnpj_vencedor_efetivo = ${cnpj} THEN 1 END)::int         AS vit_dele,
        COUNT(CASE WHEN r.cnpj_vencedor_efetivo = ${PROPONENTE_CNPJ} THEN 1 END)::int AS vit_kp
      FROM conjuntas c
      LEFT JOIN resultados_licitacao r ON r.numero_licitacao = c.numero_licitacao
    `),

    // Famílias/segmentos onde mais vence
    db.execute(sql`
      SELECT
        r.segmento,
        (SELECT f.codigo_normalizado
           FROM resultados_licitacao r2
           JOIN licitacoes l2 ON l2.numero = r2.numero_licitacao
           JOIN licitacoes_familias_match lfm ON lfm.licitacao_id = l2.id
           JOIN jsonb_array_elements(COALESCE(lfm.familias_usadas, '[]'::jsonb)) fu ON true
           JOIN familias f ON f.id = (fu->>'familiaId')::uuid
           WHERE r2.cnpj_vencedor_efetivo = ${cnpj}
             AND r2.segmento = r.segmento
           GROUP BY f.codigo_normalizado
           ORDER BY COUNT(*) DESC
           LIMIT 1)                                                  AS familia_codigo,
        COUNT(*)::int                                                AS vitorias,
        AVG(r.valor_efetivo)::float                                  AS ticket_medio
      FROM resultados_licitacao r
      WHERE r.cnpj_vencedor_efetivo = ${cnpj}
        AND r.segmento IS NOT NULL
        AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
      GROUP BY r.segmento
      ORDER BY vitorias DESC
      LIMIT 8
    `),

    // Série temporal mensal de vitórias
    db.execute(sql`
      SELECT
        to_char(date_trunc('month', detectado_em), 'YYYY-MM') AS mes,
        COUNT(*)::int                                         AS vitorias,
        COALESCE(SUM(valor_efetivo), 0)::float                AS valor_ganho
      FROM resultados_licitacao
      WHERE cnpj_vencedor_efetivo = ${cnpj}
        AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
      GROUP BY date_trunc('month', detectado_em)
      ORDER BY date_trunc('month', detectado_em) ASC
    `),

    // Tendência: ritmo 3m vs 12m
    db.execute(sql`
      SELECT
        COUNT(CASE WHEN detectado_em >= CURRENT_DATE - interval '3 months' THEN 1 END)::int AS v3m,
        COUNT(CASE WHEN detectado_em >= CURRENT_DATE - interval '12 months' THEN 1 END)::int AS v12m
      FROM resultados_licitacao
      WHERE cnpj_vencedor_efetivo = ${cnpj}
    `),

    // Contratos revelados via Portal da Transparência (valor real + vigência)
    db.execute(sql`
      SELECT
        numero_licitacao,
        licitacao_id,
        objeto,
        segmento,
        valor_contrato_real::float AS valor,
        contrato_transparencia     AS contrato,
        contrato_situacao          AS situacao,
        contrato_aditivos          AS aditivos,
        contrato_vigencia_inicio   AS vigencia_inicio,
        contrato_vigencia_fim      AS vigencia_fim
      FROM resultados_licitacao
      WHERE cnpj_vencedor_efetivo = ${cnpj}
        AND valor_contrato_real IS NOT NULL
      ORDER BY contrato_vigencia_fim DESC NULLS LAST
      LIMIT 20
    `),

    // ── Histórico Petrobras completo (Transparência, all-time por CNPJ) ───────
    // Alimentado pela tabela transparencia_contratos (sweep semanal). Pode estar
    // vazia (0 linhas) → historicoTransparencia = null (degrada graciosamente).

    // Resumo agregado
    db.execute(sql`
      SELECT
        COUNT(*)::int                                          AS total_contratos,
        COALESCE(SUM(valor), 0)::float                         AS valor_total,
        COUNT(*) FILTER (WHERE situacao = 'Ativo')::int        AS ativos,
        MIN(left(vigencia_inicio, 4)) FILTER (WHERE vigencia_inicio ~ '^[0-9]{4}') AS primeiro_ano,
        MAX(left(vigencia_fim, 4))    FILTER (WHERE vigencia_fim    ~ '^[0-9]{4}') AS ultimo_ano
      FROM transparencia_contratos
      WHERE cnpj = ${cnpj}
    `),

    // Série por ano (agrupada por ano de vigencia_inicio; só anos válidos)
    db.execute(sql`
      SELECT
        left(vigencia_inicio, 4)       AS ano,
        COUNT(*)::int                  AS quantidade,
        COALESCE(SUM(valor), 0)::float AS valor
      FROM transparencia_contratos
      WHERE cnpj = ${cnpj}
        AND vigencia_inicio ~ '^[0-9]{4}'
      GROUP BY left(vigencia_inicio, 4)
      ORDER BY ano ASC
    `),

    // Top 5 unidades (geografia) por valor
    db.execute(sql`
      SELECT
        unidade,
        COUNT(*)::int                  AS quantidade,
        COALESCE(SUM(valor), 0)::float AS valor
      FROM transparencia_contratos
      WHERE cnpj = ${cnpj} AND unidade IS NOT NULL
      GROUP BY unidade
      ORDER BY valor DESC NULLS LAST
      LIMIT 5
    `),

    // Top modalidades por quantidade
    db.execute(sql`
      SELECT
        modalidade,
        COUNT(*)::int AS quantidade
      FROM transparencia_contratos
      WHERE cnpj = ${cnpj} AND modalidade IS NOT NULL
      GROUP BY modalidade
      ORDER BY quantidade DESC
      LIMIT 10
    `),

    // Maiores contratos (top 15 por valor)
    db.execute(sql`
      SELECT
        processo,
        objeto,
        valor::float    AS valor,
        situacao,
        unidade,
        vigencia_inicio AS vigencia_inicio,
        vigencia_fim    AS vigencia_fim
      FROM transparencia_contratos
      WHERE cnpj = ${cnpj}
      ORDER BY valor DESC NULLS LAST
      LIMIT 15
    `),
  ]);

  const g = globalResult.rows[0] as unknown as {
    encontros: number; vitorias: number; desconto_medio: number | null;
    fornecedor: string | null; desclassificacoes: number;
  };
  const h = h2hResult.rows[0] as unknown as { encontros: number; vit_dele: number; vit_kp: number };
  const t = tendResult.rows[0] as unknown as { v3m: number; v12m: number };

  const familias: DossieConcorrenteFamilia[] = (familiasResult.rows as unknown as {
    segmento: string | null; familia_codigo: string | null; vitorias: number; ticket_medio: number;
  }[]).map((f) => ({
    familiaCodigo: f.familia_codigo,
    segmento:      f.segmento,
    vitorias:      toNum(f.vitorias),
    ticketMedio:   Math.round(toNum(f.ticket_medio) * 100) / 100,
  }));

  const serie: DossieConcorrenteSerie[] = (serieResult.rows as unknown as {
    mes: string; vitorias: number; valor_ganho: number;
  }[]).map((s) => ({
    mes:        s.mes,
    vitorias:   toNum(s.vitorias),
    valorGanho: Math.round(toNum(s.valor_ganho) * 100) / 100,
  }));

  const contratosRevelados: DossieConcorrenteContrato[] = (contratosResult.rows as unknown as {
    numero_licitacao: string; licitacao_id: string | null; objeto: string | null; segmento: string | null;
    valor: number; contrato: string | null; situacao: string | null; aditivos: number | null;
    vigencia_inicio: string | null; vigencia_fim: string | null;
  }[]).map((c) => ({
    numeroLicitacao: c.numero_licitacao,
    licitacaoId:     c.licitacao_id,
    objeto:          c.objeto,
    segmento:        c.segmento,
    valor:           Math.round(toNum(c.valor) * 100) / 100,
    contrato:        c.contrato,
    situacao:        c.situacao,
    aditivos:        c.aditivos != null ? toNum(c.aditivos) : null,
    vigenciaInicio:  c.vigencia_inicio,
    vigenciaFim:     c.vigencia_fim,
  }));

  // ── Histórico Petrobras completo (Transparência) ──────────────────────────
  // null quando não há nenhum contrato all-time para o CNPJ (sweep ainda vazio).
  const tr = transpResumoResult.rows[0] as unknown as {
    total_contratos: number; valor_total: number; ativos: number;
    primeiro_ano: string | null; ultimo_ano: string | null;
  } | undefined;

  let historicoTransparencia: DossieHistoricoTransparencia | null = null;
  if (tr && toNum(tr.total_contratos) > 0) {
    const porAno = (transpAnoResult.rows as unknown as {
      ano: string; quantidade: number; valor: number;
    }[]).map((r) => ({
      ano:        toNum(r.ano),
      quantidade: toNum(r.quantidade),
      valor:      Math.round(toNum(r.valor) * 100) / 100,
    }));

    const unidades = (transpUnidadesResult.rows as unknown as {
      unidade: string; quantidade: number; valor: number;
    }[]).map((r) => ({
      unidade:    r.unidade,
      quantidade: toNum(r.quantidade),
      valor:      Math.round(toNum(r.valor) * 100) / 100,
    }));

    const modalidades = (transpModalidadesResult.rows as unknown as {
      modalidade: string; quantidade: number;
    }[]).map((r) => ({
      modalidade: r.modalidade,
      quantidade: toNum(r.quantidade),
    }));

    const maioresContratos = (transpMaioresResult.rows as unknown as {
      processo: string | null; objeto: string | null; valor: number | null;
      situacao: string | null; unidade: string | null;
      vigencia_inicio: string | null; vigencia_fim: string | null;
    }[]).map((r) => ({
      processo:       r.processo,
      objeto:         r.objeto,
      valor:          Math.round(toNum(r.valor) * 100) / 100,
      situacao:       r.situacao,
      unidade:        r.unidade,
      vigenciaInicio: r.vigencia_inicio,
      vigenciaFim:    r.vigencia_fim,
    }));

    historicoTransparencia = {
      resumo: {
        totalContratos: toNum(tr.total_contratos),
        valorTotal:     Math.round(toNum(tr.valor_total) * 100) / 100,
        ativos:         toNum(tr.ativos),
        primeiroAno:    toNumOrNull(tr.primeiro_ano),
        ultimoAno:      toNumOrNull(tr.ultimo_ano),
      },
      porAno,
      unidades,
      modalidades,
      maioresContratos,
    };
  }

  const encontrosGlobais = toNum(g.encontros);
  const vitoriasGlobais = toNum(g.vitorias);
  const v3m = toNum(t.v3m);
  const v12m = toNum(t.v12m);
  const ritmo3m = v3m / 3;
  const ritmo12m = v12m > 0 ? v12m / 12 : 0;
  let tendencia: DossieConcorrente["tendencia"] = "ESTAVEL";
  if (ritmo3m > ritmo12m * 1.2) tendencia = "ALTA";
  else if (ritmo3m < ritmo12m * 0.8) tendencia = "QUEDA";

  return {
    cnpj,
    fornecedor:             g.fornecedor,
    encontrosGlobais,
    vitoriasGlobais,
    winRateGlobal:          encontrosGlobais > 0 ? Math.round((vitoriasGlobais / encontrosGlobais) * 1000) / 10 : 0,
    encontrosProponente:      toNum(h.encontros),
    vitoriasDeleVsProponente: toNum(h.vit_dele),
    vitoriasProponenteVsDele: toNum(h.vit_kp),
    descontoMedio:          g.desconto_medio != null ? Math.round(toNum(g.desconto_medio) * 10) / 10 : 0,
    desclassificacoes:      toNum(g.desclassificacoes),
    vitorias3m:             v3m,
    vitorias12m:            v12m,
    tendencia,
    familias,
    serie,
    contratosRevelados,
    historicoTransparencia,
    periodoMeses:           meses,
  };
}

// ── Cached wrappers ─────────────────────────────────────────────────────────
//
// `unstable_cache` envelopa as 4 funções pesadas. Cache key é gerado a partir
// dos argumentos serializáveis. Tag global "analytics" permite invalidação
// ampla (ex.: revalidateTag("analytics") após sync grande); tags por domínio
// permitem invalidação granular.
//
// Atenção: `getParticipacoesProponente` NÃO está cacheada — aceita `search` em
// texto livre, criando cardinalidade alta de cache key sem benefício real.

const _cachedPerformance = unstable_cache(
  _getPerformanceTrimestralImpl,
  ["analytics:performance"],
  { tags: [...CACHE_TAGS_BASE, "analytics:performance"], revalidate: CACHE_REVALIDATE_S },
);

const _cachedMercado = unstable_cache(
  _getMercadoImpl,
  ["analytics:mercado"],
  { tags: [...CACHE_TAGS_BASE, "analytics:mercado"], revalidate: CACHE_REVALIDATE_S },
);

const _cachedConcorrencia = unstable_cache(
  _getConcorrenciaImpl,
  ["analytics:concorrencia"],
  { tags: [...CACHE_TAGS_BASE, "analytics:concorrencia"], revalidate: CACHE_REVALIDATE_S },
);

const _cachedOportunidadesPerdidas = unstable_cache(
  _getOportunidadesPerdidasImpl,
  ["analytics:oportunidades-perdidas"],
  { tags: [...CACHE_TAGS_BASE, "analytics:oportunidades-perdidas"], revalidate: CACHE_REVALIDATE_S },
);

export function getPerformanceTrimestral(trimestres = 6): Promise<PerformanceResponse> {
  return _cachedPerformance(trimestres);
}

export function getMercado(periodoMeses = 12): Promise<MercadoResponse> {
  return _cachedMercado(periodoMeses);
}

export function getConcorrencia(periodoMeses = 12): Promise<ConcorrenciaResponse> {
  return _cachedConcorrencia(periodoMeses);
}

export function getOportunidadesPerdidas(input: {
  scoreMin?:     number;
  periodoMeses?: number;
  limit?:        number;
} = {}): Promise<OportunidadePerdida[]> {
  return _cachedOportunidadesPerdidas({
    scoreMin:     input.scoreMin     ?? 70,
    periodoMeses: input.periodoMeses ?? 12,
    limit:        input.limit        ?? 50,
  });
}

// ── Cached wrappers das features 25 ──────────────────────────────────────────

const _cachedDossieConcorrente = unstable_cache(
  _getDossieConcorrenteImpl,
  ["analytics:dossie-concorrente"],
  { tags: [...CACHE_TAGS_BASE, "analytics:dossie-concorrente"], revalidate: CACHE_REVALIDATE_S },
);

export function getDossieConcorrente(cnpj: string, meses = 12): Promise<DossieConcorrente> {
  const cnpjLimpo = cnpj.replace(/\D/g, "");
  return _cachedDossieConcorrente(cnpjLimpo, meses);
}
