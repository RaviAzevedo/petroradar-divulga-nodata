import { db } from "@/db";
import {
  licitacaoEventosVencedor,
  resultadosLicitacao,
  participacoesLicitacao,
  envelopesHabilitacao,
  licitacoes,
  users,
  auditLog,
} from "@/db/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { config } from "@/lib/config";
import { criarEnvelopeAposVitoria, criarEnvelopeAvulso } from "@/lib/conformidade/envelopes";
import type {
  EventoVencedor, AguardandoConvocacao, EstatisticasConvocacoes,
  TipoEventoVencedor, MotivoEventoVencedor, FonteEventoVencedor,
} from "./types";

const PROPONENTE_CNPJ = config.proponente.cnpj;
const PRAZO_PROTOCOLO_DIAS_UTEIS = 5;

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

function addDiasUteis(de: Date, dias: number): Date {
  const d = new Date(de);
  let restantes = dias;
  while (restantes > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0 = dom, 6 = sáb
    if (dow !== 0 && dow !== 6) restantes--;
  }
  return d;
}

// ── Listar eventos de uma licitação ────────────────────────────────────────

export async function listarEventos(numeroLicitacao: string): Promise<EventoVencedor[]> {
  const rows = await db
    .select({
      id:               licitacaoEventosVencedor.id,
      numeroLicitacao:  licitacaoEventosVencedor.numeroLicitacao,
      ordem:            licitacaoEventosVencedor.ordem,
      cnpj:             licitacaoEventosVencedor.cnpj,
      fornecedor:       licitacaoEventosVencedor.fornecedor,
      tipo:             licitacaoEventosVencedor.tipo,
      dataEvento:       licitacaoEventosVencedor.dataEvento,
      motivo:           licitacaoEventosVencedor.motivo,
      motivoDetalhe:    licitacaoEventosVencedor.motivoDetalhe,
      fonte:            licitacaoEventosVencedor.fonte,
      observacao:       licitacaoEventosVencedor.observacao,
      registradoPor:    licitacaoEventosVencedor.registradoPor,
      registradoEm:     licitacaoEventosVencedor.registradoEm,
      registradoPorNome: users.nome,
    })
    .from(licitacaoEventosVencedor)
    .leftJoin(users, eq(licitacaoEventosVencedor.registradoPor, users.id))
    .where(eq(licitacaoEventosVencedor.numeroLicitacao, numeroLicitacao))
    .orderBy(licitacaoEventosVencedor.ordem);

  return rows.map((r) => ({
    id:              r.id,
    numeroLicitacao: r.numeroLicitacao,
    ordem:           r.ordem,
    cnpj:            r.cnpj,
    fornecedor:      r.fornecedor,
    tipo:            r.tipo,
    dataEvento:      r.dataEvento ? new Date(r.dataEvento).toISOString() : "",
    motivo:          r.motivo,
    motivoDetalhe:   r.motivoDetalhe,
    fonte:           r.fonte,
    observacao:      r.observacao,
    registradoPor:   r.registradoPor,
    registradoPorNome: r.registradoPorNome,
    registradoEm:    r.registradoEm ? new Date(r.registradoEm).toISOString() : "",
  }));
}

// ── Registrar evento (com workflow automático) ─────────────────────────────

export interface RegistrarEventoArgs {
  numeroLicitacao: string;
  cnpj:            string;        // só dígitos (14)
  fornecedor:      string;
  tipo:            TipoEventoVencedor;
  dataEvento?:     Date;
  motivo?:         MotivoEventoVencedor;
  motivoDetalhe?:  string;
  fonte:           FonteEventoVencedor;
  observacao?:     string;
  userId:          string;
}

export interface RegistrarEventoResult {
  evento:                EventoVencedor;
  envelopeCriado:        { envelopeId: string; tipo: "PARTICIPACAO" | "AVULSO" } | null;
  participacaoAtualizada: boolean;
  cnpjVencedorAtualizado: boolean;
}

/**
 * Registra um evento na linha do tempo e, se aplicável, dispara workflows:
 *
 *  - tipo CONVOCADO ou HOMOLOGADO       → atualiza resultados_licitacao.cnpj_vencedor
 *                                         (sempre representa o vencedor atual)
 *  - tipo CONVOCADO + cnpj = Proponente   → cria envelope (de participação se houver,
 *                                         senão avulso) com prazo_protocolo de 5 dias úteis
 *  - tipo CONVOCADO + cnpj = Proponente   → marca participação como GANHOU se existe
 *  - sempre                             → registra no audit_log
 */
export async function registrarEvento(args: RegistrarEventoArgs): Promise<RegistrarEventoResult> {
  const dataEvento = args.dataEvento ?? new Date();

  // NOTA: o driver neon-http não suporta transações; os statements abaixo rodam
  // sequencialmente com `db`. O cálculo de ordem + INSERT do evento + UPDATE do
  // vencedor + audit log são executados em sequência (cada um atômico por si).
  return await (async () => {
    // 1. Calcula próxima ordem
    const [{ max }] = await db
      .select({ max: sql<number>`COALESCE(MAX(${licitacaoEventosVencedor.ordem}), 0)` })
      .from(licitacaoEventosVencedor)
      .where(eq(licitacaoEventosVencedor.numeroLicitacao, args.numeroLicitacao));

    const ordem = (max ?? 0) + 1;

    // 2. Insere o evento
    const [evento] = await db
      .insert(licitacaoEventosVencedor)
      .values({
        numeroLicitacao: args.numeroLicitacao,
        ordem,
        cnpj:            args.cnpj,
        fornecedor:      args.fornecedor,
        tipo:            args.tipo,
        dataEvento,
        motivo:          args.motivo ?? null,
        motivoDetalhe:   args.motivoDetalhe ?? null,
        fonte:           args.fonte,
        observacao:      args.observacao ?? null,
        registradoPor:   args.userId,
      })
      .returning();

    // 3. Se é CONVOCADO ou HOMOLOGADO, atualiza o cnpj_vencedor "atual"
    let cnpjVencedorAtualizado = false;
    if (args.tipo === "CONVOCADO" || args.tipo === "HOMOLOGADO") {
      await db
        .update(resultadosLicitacao)
        .set({
          cnpjVencedor:       args.cnpj,
          fornecedorVencedor: args.fornecedor,
        })
        .where(eq(resultadosLicitacao.numeroLicitacao, args.numeroLicitacao));
      cnpjVencedorAtualizado = true;
    }

    // 4. Audit log
    await db.insert(auditLog).values({
      userId:     args.userId,
      acao:       `EVENTO_VENCEDOR_${args.tipo}`,
      entidade:   "resultado_licitacao",
      entidadeId: args.numeroLicitacao,
      detalhes:   {
        ordem,
        cnpj:       args.cnpj,
        fornecedor: args.fornecedor,
        motivo:     args.motivo,
        fonte:      args.fonte,
      },
    });

    return {
      evento: {
        id:                 evento.id,
        numeroLicitacao:    evento.numeroLicitacao,
        ordem:              evento.ordem,
        cnpj:               evento.cnpj,
        fornecedor:         evento.fornecedor,
        tipo:               evento.tipo,
        dataEvento:         evento.dataEvento ? new Date(evento.dataEvento).toISOString() : "",
        motivo:             evento.motivo,
        motivoDetalhe:      evento.motivoDetalhe,
        fonte:              evento.fonte,
        observacao:         evento.observacao,
        registradoPor:      evento.registradoPor,
        registradoPorNome:  null,
        registradoEm:       evento.registradoEm ? new Date(evento.registradoEm).toISOString() : "",
      },
      envelopeCriado:        null,    // preenchido fora da transação (próximo passo)
      participacaoAtualizada: false,  // idem
      cnpjVencedorAtualizado,
    };
  })().then(async (result) => {
    // 5. Workflow pós-escrita inicial: criar envelope + atualizar participação
    //    (executado em sequência, depois da gravação do evento)
    if (args.tipo !== "CONVOCADO" || args.cnpj !== PROPONENTE_CNPJ) {
      return result;
    }

    const prazoProtocolo = addDiasUteis(args.dataEvento ?? new Date(), PRAZO_PROTOCOLO_DIAS_UTEIS);

    // Existe participação Proponente para esta licitação?
    const [participacao] = await db
      .select({
        id:             participacoesLicitacao.id,
        resultado:      participacoesLicitacao.resultado,
      })
      .from(participacoesLicitacao)
      .where(and(
        eq(participacoesLicitacao.numeroEdital, args.numeroLicitacao),
        isNull(participacoesLicitacao.deletadoEm),
      ))
      .limit(1);

    let envelopeCriado: RegistrarEventoResult["envelopeCriado"] = null;
    let participacaoAtualizada = false;

    if (participacao) {
      const env = await criarEnvelopeAposVitoria(participacao.id, args.userId);
      if (env) {
        // Define prazo_protocolo (criarEnvelopeAposVitoria deixa null por padrão)
        await db
          .update(envelopesHabilitacao)
          .set({ prazoProtocolo })
          .where(eq(envelopesHabilitacao.id, env.envelopeId));
        envelopeCriado = { envelopeId: env.envelopeId, tipo: "PARTICIPACAO" };
      }

      // Marca participação como GANHOU
      if (participacao.resultado !== "GANHOU") {
        await db
          .update(participacoesLicitacao)
          .set({ resultado: "GANHOU", atualizadoEm: new Date() })
          .where(eq(participacoesLicitacao.id, participacao.id));
        participacaoAtualizada = true;
      }
    } else {
      // Sem participação: cria envelope avulso vinculado à licitação se houver
      const [lic] = await db
        .select({ id: licitacoes.id, objeto: licitacoes.objeto, empresa: licitacoes.empresa })
        .from(licitacoes)
        .where(eq(licitacoes.numero, args.numeroLicitacao))
        .limit(1);

      const env = await criarEnvelopeAvulso({
        numeroEdital:       args.numeroLicitacao,
        empresaContratante: lic?.empresa ?? "Petrobras",
        objeto:             lic?.objeto ?? "",
        licitacaoId:        lic?.id ?? null,
        prazoProtocolo,
        responsavelSgi:     args.userId,
        observacoes:        `Envelope criado automaticamente após convocação (evento #${result.evento.ordem}).`,
      });
      envelopeCriado = { envelopeId: env.envelopeId, tipo: "AVULSO" };
    }

    return { ...result, envelopeCriado, participacaoAtualizada };
  });
}

// ── Aguardando convocação ──────────────────────────────────────────────────

/**
 * Licitações onde Proponente foi 2º/3º colocado, anunciadas há ≤ N dias, e que
 * ainda NÃO têm evento de DESCLASSIFICADO/CONVOCADO/HOMOLOGADO registrado.
 * Estas estão "no radar" — Petrobras pode chamar a qualquer momento.
 */
export async function listarAguardandoConvocacao(diasMax = 90): Promise<AguardandoConvocacao[]> {
  const r = await db.execute(sql`
    WITH kp_posicao AS (
      SELECT
        pl.numero_licitacao,
        MIN(pl.posicao) AS posicao,
        MAX(pl.valor_total::numeric) AS valor_proposta
      FROM propostas_licitacao pl
      WHERE pl.cnpj = ${PROPONENTE_CNPJ}
        AND pl.declinou = false
        AND pl.posicao IS NOT NULL
        AND pl.posicao > 1
      GROUP BY pl.numero_licitacao
    ),
    licitacoes_com_evento AS (
      SELECT DISTINCT numero_licitacao
      FROM licitacao_eventos_vencedor
      WHERE tipo IN ('DESCLASSIFICADO', 'CONVOCADO', 'HOMOLOGADO', 'DESISTIU')
    )
    SELECT
      r.numero_licitacao,
      l.id AS licitacao_id,
      r.objeto,
      r.segmento,
      r.empresa,
      r.cnpj_vencedor,
      r.fornecedor_vencedor,
      kp.posicao,
      kp.valor_proposta,
      r.detectado_em,
      EXTRACT(DAY FROM CURRENT_DATE - r.detectado_em)::int AS dias
    FROM resultados_licitacao r
    INNER JOIN kp_posicao kp ON kp.numero_licitacao = r.numero_licitacao
    LEFT JOIN licitacoes l ON l.id = r.licitacao_id
    WHERE r.numero_licitacao NOT IN (SELECT numero_licitacao FROM licitacoes_com_evento)
      AND r.cnpj_vencedor != ${PROPONENTE_CNPJ}
      AND r.detectado_em >= CURRENT_DATE - interval '${sql.raw(String(diasMax))} days'
    ORDER BY r.detectado_em DESC
    LIMIT 50
  `);

  type Row = {
    numero_licitacao:    string;
    licitacao_id:        string | null;
    objeto:              string | null;
    segmento:            string | null;
    empresa:             string | null;
    cnpj_vencedor:       string | null;
    fornecedor_vencedor: string | null;
    posicao:             number;
    valor_proposta:      number | null;
    detectado_em:        Date;
    dias:                number;
  };

  return (r.rows as unknown as Row[]).map((row) => ({
    numeroLicitacao:        row.numero_licitacao,
    licitacaoId:            row.licitacao_id,
    objeto:                 row.objeto,
    segmento:               row.segmento,
    empresa:                row.empresa,
    cnpjVencedorAtual:      row.cnpj_vencedor,
    fornecedorVencedor:     row.fornecedor_vencedor,
    posicaoProponente:        toNum(row.posicao),
    valorPropostaProponente:  row.valor_proposta != null ? toNum(row.valor_proposta) : null,
    detectadoEm:            new Date(row.detectado_em).toISOString(),
    diasDesdeAnuncio:       toNum(row.dias),
  }));
}

// ── Estatísticas de convocações no período ────────────────────────────────

export async function getEstatisticasConvocacoes(meses = 12): Promise<EstatisticasConvocacoes> {
  const [convResult, descResult, topVencResult] = await Promise.all([
    // Total convocações + para Proponente
    db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN cnpj = ${PROPONENTE_CNPJ} THEN 1 END)::int AS para_proponente
      FROM licitacao_eventos_vencedor
      WHERE tipo = 'CONVOCADO'
        AND data_evento >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
    `),

    // Total desclassificações observadas
    db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM licitacao_eventos_vencedor
      WHERE tipo = 'DESCLASSIFICADO'
        AND data_evento >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
    `),

    // Top 5 vencedores que mais foram desclassificados (relativo às vitórias)
    db.execute(sql`
      WITH vencidas AS (
        SELECT cnpj_vencedor, fornecedor_vencedor, COUNT(*)::int AS qtd
        FROM resultados_licitacao
        WHERE cnpj_vencedor IS NOT NULL
          AND detectado_em >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
        GROUP BY cnpj_vencedor, fornecedor_vencedor
      ),
      desclass AS (
        SELECT cnpj, COUNT(*)::int AS qtd
        FROM licitacao_eventos_vencedor
        WHERE tipo = 'DESCLASSIFICADO'
          AND data_evento >= CURRENT_DATE - interval '${sql.raw(String(meses))} months'
        GROUP BY cnpj
      )
      SELECT v.cnpj_vencedor AS cnpj, v.fornecedor_vencedor AS fornecedor,
             v.qtd AS vencidas, COALESCE(d.qtd, 0)::int AS desclassificadas
      FROM vencidas v
      LEFT JOIN desclass d ON d.cnpj = v.cnpj_vencedor
      WHERE v.qtd >= 3 AND COALESCE(d.qtd, 0) > 0
      ORDER BY (COALESCE(d.qtd, 0)::float / v.qtd) DESC
      LIMIT 5
    `),
  ]);

  const conv = convResult.rows[0] as unknown as { total: number; para_proponente: number };
  const desc = descResult.rows[0] as unknown as { total: number };

  type TopRow = { cnpj: string; fornecedor: string; vencidas: number; desclassificadas: number };
  const top = (topVencResult.rows as unknown as TopRow[]).map((r) => ({
    cnpj:             r.cnpj,
    fornecedor:       r.fornecedor,
    vencidas:         toNum(r.vencidas),
    desclassificadas: toNum(r.desclassificadas),
    taxa:             r.vencidas > 0 ? Math.round((r.desclassificadas / r.vencidas) * 1000) / 10 : 0,
  }));

  return {
    periodoMeses:                meses,
    totalConvocacoes:            toNum(conv?.total),
    convocacoesParaProponente:     toNum(conv?.para_proponente),
    desclassificacoesObservadas: toNum(desc?.total),
    topVencedoresQueDesclassificam: top,
  };
}

// ── Helper auxiliar para Performance Trimestral (vitórias diretas vs convocação)

/**
 * Retorna o conjunto de numero_licitacao em que Proponente venceu por convocação
 * (ou seja, há um evento CONVOCADO ou HOMOLOGADO para Proponente). Útil para
 * separar "vitórias diretas" de "vitórias por convocação" em métricas.
 */
async function listarLicitacoesVitoriaPorConvocacao(): Promise<Set<string>> {
  const r = await db
    .select({ numeroLicitacao: licitacaoEventosVencedor.numeroLicitacao })
    .from(licitacaoEventosVencedor)
    .where(and(
      eq(licitacaoEventosVencedor.cnpj, PROPONENTE_CNPJ),
      sql`${licitacaoEventosVencedor.tipo} IN ('CONVOCADO', 'HOMOLOGADO')`,
    ));

  return new Set(r.map((row) => row.numeroLicitacao));
}
