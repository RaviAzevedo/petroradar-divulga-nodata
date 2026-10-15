/**
 * Snapshot de dados do relatório executivo — alimenta os KPIs do e-mail mensal
 * (cron relatorio-mensal).
 *
 * Reaproveita as queries de analytics (getPerformanceTrimestral / getMercado /
 * getConcorrencia / getOportunidadesPerdidas / getParticipacoesProponente) + as
 * lacunas CRC (familias + licitacoes_familias_match). Read-only.
 *
 * Até 2026-09 este módulo também gerava o XLSX multi-aba do hub /relatorios
 * (`gerarRelatorioXlsx`); o hub saiu na limpeza geral e o gerador foi junto.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  getPerformanceTrimestral,
  getMercado,
  getConcorrencia,
  getOportunidadesPerdidas,
  getParticipacoesProponente,
} from "@/lib/analytics/queries";
import type {
  PerformanceResponse,
  MercadoResponse,
  ConcorrenciaResponse,
  OportunidadePerdida,
  ParticipacoesProponenteResponse,
} from "@/lib/analytics/types";

interface LacunaCrc {
  codigoCrc:        string;
  nome:             string;
  segmentoPetrobras: string | null;
  statusFluxoCrc:   string | null;
  validadeFim:      string | null;
  /** Nº de licitações recentes que dependeriam desta família. */
  demandaRecente:   number;
}

export interface DadosRelatorio {
  periodoMeses:  number;
  geradoEm:      string;
  performance:   PerformanceResponse;
  mercado:       MercadoResponse;
  concorrencia:  ConcorrenciaResponse;
  oportunidades: OportunidadePerdida[];
  participacoes: ParticipacoesProponenteResponse;
  lacunasCrc:    LacunaCrc[];
}

/** Coleta TODOS os dados do relatório (único acesso a DB). */
export async function coletarDadosRelatorio(periodoMeses = 12): Promise<DadosRelatorio> {
  const trimestres = Math.max(2, Math.ceil(periodoMeses / 3));

  const [performance, mercado, concorrencia, oportunidades, participacoes, lacunasRows] =
    await Promise.all([
      getPerformanceTrimestral(trimestres),
      getMercado(periodoMeses),
      getConcorrencia(periodoMeses),
      getOportunidadesPerdidas({ scoreMin: 60, periodoMeses, limit: 100 }),
      getParticipacoesProponente({ periodoMeses, limit: 300 }),
      // Lacunas CRC: famílias cujo statusFluxoCrc != 'A' (não aprovado) com
      // demanda recente (licitações com match nessa família no período).
      db.execute(sql`
        SELECT
          f.codigo_crc,
          f.nome,
          f.segmento_petrobras,
          f.status_fluxo_crc,
          f.validade_fim,
          COUNT(DISTINCT lfm.licitacao_id)::int AS demanda_recente
        FROM familias f
        LEFT JOIN licitacoes_familias_match lfm
          ON lfm.familias_usadas @> jsonb_build_array(jsonb_build_object('codigoCrc', f.codigo_crc))
        WHERE f.deletado_em IS NULL
          AND (f.status_fluxo_crc IS DISTINCT FROM 'A')
        GROUP BY f.codigo_crc, f.nome, f.segmento_petrobras, f.status_fluxo_crc, f.validade_fim
        ORDER BY demanda_recente DESC, f.validade_fim ASC NULLS LAST
        LIMIT 100
      `),
    ]);

  type LacRow = {
    codigo_crc: string; nome: string; segmento_petrobras: string | null;
    status_fluxo_crc: string | null; validade_fim: Date | string | null; demanda_recente: number;
  };
  const lacunasCrc: LacunaCrc[] = (lacunasRows.rows as unknown as LacRow[]).map((r) => ({
    codigoCrc:         r.codigo_crc,
    nome:              r.nome,
    segmentoPetrobras: r.segmento_petrobras,
    statusFluxoCrc:    r.status_fluxo_crc,
    validadeFim:       r.validade_fim ? new Date(r.validade_fim).toISOString() : null,
    demandaRecente:    Number(r.demanda_recente) || 0,
  }));

  return {
    periodoMeses,
    geradoEm: new Date().toISOString(),
    performance,
    mercado,
    concorrencia,
    oportunidades,
    participacoes,
    lacunasCrc,
  };
}
