/**
 * Radar de Convocação do Remanescente (2º colocado) — lógica de detecção.
 *
 * Quando um concorrente à frente da Proponente é DESCLASSIFICADO ou DESISTIU, a
 * Proponente sobe na fila e pode ser a próxima elegível à convocação. Este módulo
 * cruza:
 *   - propostas_licitacao onde cnpj = Proponente e posicao >= posicaoMinima (config)
 *   - eventos DESCLASSIFICADO/DESISTIU recém-inseridos (convocacao_notificada_em IS NULL)
 *
 * e devolve as licitações onde a Proponente virou (ou se aproximou de virar) a
 * próxima elegível, ainda sem CONVOCADO/HOMOLOGADO para a Proponente.
 *
 * Dedup: o cron marca licitacao_eventos_vencedor.convocacao_notificada_em após
 * disparar o alerta — evita re-disparo para o mesmo evento.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { config } from "@/lib/config";

const PROPONENTE_CNPJ = config.proponente.cnpj;

export interface GatilhoConvocacao {
  /** id do evento DESCLASSIFICADO/DESISTIU que disparou o radar (para dedup). */
  eventoId:           string;
  numeroLicitacao:    string;
  licitacaoId:        string | null;
  objeto:             string | null;
  segmento:           string | null;
  empresa:            string | null;
  /** Posição original da Proponente nas propostas. */
  posicaoProponente:    number;
  valorPropostaProponente: number | null;
  /** Quem saiu da frente (gerou o gatilho). */
  cnpjQueSaiu:        string;
  fornecedorQueSaiu:  string;
  tipoEvento:         "DESCLASSIFICADO" | "DESISTIU";
  motivo:             string | null;
  dataEvento:         string;     // ISO
}

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Lista os gatilhos de convocação não notificados.
 *
 * Um gatilho é um evento DESCLASSIFICADO/DESISTIU (ainda não notificado) numa
 * licitação onde:
 *   - a Proponente tem proposta com posicao >= posicaoMinima (remanescente);
 *   - a empresa que saiu NÃO é a Proponente;
 *   - a Proponente ainda não foi CONVOCADA/HOMOLOGADA nessa licitação.
 */
export async function listarGatilhosConvocacao(): Promise<GatilhoConvocacao[]> {
  const posicaoMin = config.crons.convocacaoWatch.posicaoMinima;

  const r = await db.execute(sql`
    WITH kp_posicao AS (
      SELECT
        pl.numero_licitacao,
        MIN(pl.posicao)               AS posicao,
        MAX(pl.valor_total::numeric)  AS valor_proposta
      FROM propostas_licitacao pl
      WHERE pl.cnpj = ${PROPONENTE_CNPJ}
        AND pl.declinou = false
        AND pl.posicao IS NOT NULL
        AND pl.posicao >= ${sql.raw(String(posicaoMin))}
      GROUP BY pl.numero_licitacao
    ),
    kp_convocada AS (
      -- Licitações onde a Proponente já foi convocada/homologada (não alertar de novo)
      SELECT DISTINCT numero_licitacao
      FROM licitacao_eventos_vencedor
      WHERE cnpj = ${PROPONENTE_CNPJ}
        AND tipo IN ('CONVOCADO', 'HOMOLOGADO')
    )
    SELECT
      ev.id                AS evento_id,
      ev.numero_licitacao  AS numero_licitacao,
      ev.cnpj              AS cnpj_que_saiu,
      ev.fornecedor        AS fornecedor_que_saiu,
      ev.tipo              AS tipo_evento,
      ev.motivo            AS motivo,
      ev.data_evento       AS data_evento,
      kp.posicao           AS posicao,
      kp.valor_proposta    AS valor_proposta,
      r.licitacao_id       AS licitacao_id,
      r.objeto             AS objeto,
      r.segmento           AS segmento,
      r.empresa            AS empresa
    FROM licitacao_eventos_vencedor ev
    INNER JOIN kp_posicao kp ON kp.numero_licitacao = ev.numero_licitacao
    LEFT JOIN resultados_licitacao r ON r.numero_licitacao = ev.numero_licitacao
    WHERE ev.tipo IN ('DESCLASSIFICADO', 'DESISTIU')
      AND ev.convocacao_notificada_em IS NULL
      AND ev.cnpj <> ${PROPONENTE_CNPJ}
      AND ev.numero_licitacao NOT IN (SELECT numero_licitacao FROM kp_convocada)
    ORDER BY ev.data_evento DESC
    LIMIT 100
  `);

  type Row = {
    evento_id:           string;
    numero_licitacao:    string;
    cnpj_que_saiu:       string;
    fornecedor_que_saiu: string;
    tipo_evento:         "DESCLASSIFICADO" | "DESISTIU";
    motivo:              string | null;
    data_evento:         Date;
    posicao:             number;
    valor_proposta:      number | null;
    licitacao_id:        string | null;
    objeto:              string | null;
    segmento:            string | null;
    empresa:             string | null;
  };

  return (r.rows as unknown as Row[]).map((row) => ({
    eventoId:              row.evento_id,
    numeroLicitacao:       row.numero_licitacao,
    licitacaoId:           row.licitacao_id,
    objeto:                row.objeto,
    segmento:              row.segmento,
    empresa:               row.empresa,
    posicaoProponente:       toNum(row.posicao),
    valorPropostaProponente: row.valor_proposta != null ? toNum(row.valor_proposta) : null,
    cnpjQueSaiu:           row.cnpj_que_saiu,
    fornecedorQueSaiu:     row.fornecedor_que_saiu,
    tipoEvento:            row.tipo_evento,
    motivo:                row.motivo,
    dataEvento:            row.data_evento ? new Date(row.data_evento).toISOString() : "",
  }));
}
