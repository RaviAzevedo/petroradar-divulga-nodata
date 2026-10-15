export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/digest-executivo — digest executivo semanal por e-mail.
 *
 * Reaproveita getPerformanceTrimestral/getMercado/getConcorrencia/
 * getOportunidadesPerdidas + status de famílias CRC, monta os KPIs e seções do
 * templateDigestExecutivo e envia via Microsoft Graph para ADMIN/LIDER ativos.
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 * Gate gracioso por config.crons.digestExecutivo.habilitado.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { familias } from "@/db/schema";
import { and, ne, isNotNull, sql } from "drizzle-orm";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { emailsPorPapel } from "@/lib/email/destinatarios";
import {
  templateDigestExecutivo,
  type DigestKpi,
  type DigestSecaoLista,
  baseUrl,
} from "@/lib/email/templates";
import {
  getPerformanceTrimestral,
  getMercado,
  getConcorrencia,
  getOportunidadesPerdidas,
} from "@/lib/analytics/queries";
import { loggerFor } from "@/lib/observability/logger";

function autorizarCron(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    return authHeader === `Bearer ${cronSecret}`;
  }
  return req.headers.get("x-vercel-cron") === "1";
}

/** ADMIN/LIDER ativos que não desligaram "Painel executivo semanal". */
const getDestinatariosGestao = () => emailsPorPapel("DIGEST_EXECUTIVO");

const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export async function GET(req: NextRequest) {
  if (!autorizarCron(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/digest-executivo" });

  if (!config.crons.digestExecutivo.habilitado) {
    return NextResponse.json({ ok: true, skipped: true, motivo: "cron desabilitado" });
  }

  const destinatarios = await getDestinatariosGestao();
  if (destinatarios.length === 0) {
    log.warn("nenhum destinatário de gestão");
    return NextResponse.json({ ok: true, enviado: false, motivo: "sem destinatários" });
  }

  // ── Coleta dados (reusa queries cacheadas de analytics) ──────────────────
  const [perf, mercado, concorrencia, oportunidades, familiasVencendo] = await Promise.all([
    getPerformanceTrimestral(6),
    getMercado(12),
    getConcorrencia(3),
    getOportunidadesPerdidas({ scoreMin: 70, periodoMeses: 1, limit: 5 }),
    // Famílias CRC vencidas ou não aprovadas (alerta executivo)
    db
      .select({
        codigoCrc:      familias.codigoCrc,
        nome:           familias.nome,
        statusFluxoCrc: familias.statusFluxoCrc,
        validadeFim:    familias.validadeFim,
      })
      .from(familias)
      .where(and(isNotNull(familias.statusFluxoCrc), ne(familias.statusFluxoCrc, "A")))
      .limit(8),
  ]);

  const r = perf.resumo;

  const kpis: DigestKpi[] = [
    {
      rotulo: "Taxa de sucesso",
      valor:  `${r.taxaSucessoAtual}%`,
      variacao: `${r.delta >= 0 ? "+" : ""}${r.delta} p.p. vs. trimestre anterior`,
      tendencia: r.delta > 0 ? "up" : r.delta < 0 ? "down" : "neutral",
    },
    { rotulo: "Valor ganho (12m)", valor: fmtBRL(r.valorGanho12m) },
    { rotulo: "Mercado (12m)", valor: fmtBRL(mercado.totais.valorTotalPeriodo) },
    { rotulo: "Concentração top 5", valor: `${mercado.totais.concentracaoTop5}%` },
  ];

  const secoes: DigestSecaoLista[] = [];

  if (oportunidades.length > 0) {
    secoes.push({
      titulo: "Oportunidades de alto interesse (última semana)",
      itens: oportunidades.map((o) => ({
        texto: `${o.numero} — ${(o.objeto ?? "").slice(0, 70)} (aderência ${o.scoreAderencia}%)`,
        href:  o.licitacaoId ? `${baseUrl}/licitacoes/${o.licitacaoId}` : null,
      })),
    });
  }

  if (concorrencia.emAscensao.length > 0) {
    secoes.push({
      titulo: "Concorrentes em ascensão",
      itens: concorrencia.emAscensao.slice(0, 5).map((c) => ({
        texto: `${c.fornecedor} — ${c.vitorias3m} vitórias nos últimos 3 meses`,
      })),
    });
  }

  // ── Renovações de contratos de concorrentes ────────────────────────────────
  //
  // Um contrato que vence é uma licitação que vai nascer. O aviso precisa chegar
  // com folga para preparar habilitação — daí DUAS bandas: ~90 dias (dá tempo de
  // correr atrás de atestado/CRC) e ~45 dias (última chamada).
  //
  // DEDUP SEM LEDGER: este digest é SEMANAL (seg 08:00 UTC) e cada banda tem
  // exatamente 7 dias de largura. Um contrato atravessa cada janela numa única
  // rodada — não há como repetir, e não há estado para manter em sincronia.
  // Mexer na cadência do digest sem mexer na largura da banda QUEBRA isso: com
  // rodada diária o mesmo contrato sairia 7 vezes.
  const renovacoes = await db.execute(sql`
    SELECT fornecedor, objeto, valor, vigencia_fim, aditivos_qtd, unidade,
           (vigencia_fim::date - CURRENT_DATE) AS dias,
           max(capturado_em) OVER () AS vintage
    FROM transparencia_contratos
    WHERE vigencia_fim ~ '^[0-9]{4}-'
      AND (
        vigencia_fim::date BETWEEN CURRENT_DATE + 84 AND CURRENT_DATE + 90
        OR vigencia_fim::date BETWEEN CURRENT_DATE + 39 AND CURRENT_DATE + 45
      )
      -- Contrato nosso não é oportunidade de disputa; é renovação a defender,
      -- que já tem acompanhamento próprio.
      AND coalesce(regexp_replace(cnpj, '[^0-9]', '', 'g'), '') NOT LIKE '11222333%'
      AND valor IS NOT NULL
    ORDER BY valor DESC
    LIMIT 6
  `);
  const linhasRenov = (Array.isArray(renovacoes)
    ? renovacoes
    : (renovacoes as { rows?: unknown[] }).rows ?? []) as Array<{
      fornecedor: string | null; objeto: string | null; valor: string | null;
      vigencia_fim: string; aditivos_qtd: number | null; unidade: string | null;
      dias: number; vintage: string | null;
    }>;

  if (linhasRenov.length > 0) {
    // A data de captura vai NO TÍTULO de propósito. O sweep da Transparência é
    // semanal e pode atrasar; sem o carimbo, um "vence em 90 dias" de dado velho
    // parece fato de hoje. Com ele, quem lê sabe o quanto confiar.
    const vintage = linhasRenov[0].vintage
      ? new Date(linhasRenov[0].vintage).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })
      : null;
    secoes.push({
      titulo: `Contratos de concorrentes vencendo${vintage ? ` (dado de ${vintage})` : ""}`,
      itens: linhasRenov.map((c) => {
        // aditivos_qtd > 0 é a ressalva honesta: contrato que já foi aditivado
        // pode ter sido aditivado DE NOVO depois da última captura, e aí a data
        // abaixo já não vale. Quem lê decide se confere no portal.
        const aditivo = (c.aditivos_qtd ?? 0) > 0 ? ` · ${c.aditivos_qtd} aditivo(s) — confira vigência` : "";
        const val = c.valor ? fmtBRL(Number(c.valor)) : "valor não informado";
        return {
          texto: `${c.fornecedor ?? "—"} — vence em ${c.dias} dias (${val})${aditivo}: ${(c.objeto ?? "").slice(0, 60)}`,
          href:  `${baseUrl}/resultados`,
        };
      }),
    });
  }

  const alertasCrc = familiasVencendo.map((f) => {
    const venc = f.validadeFim ? ` (validade ${new Date(f.validadeFim).toLocaleDateString("pt-BR")})` : "";
    return `${f.codigoCrc} — ${f.nome}: status ${f.statusFluxoCrc ?? "?"}${venc}`;
  });

  const hoje = new Date();
  const inicioSemana = new Date(hoje.getTime() - 6 * 24 * 60 * 60 * 1000);
  const periodoLabel = `Semana de ${inicioSemana.toLocaleDateString("pt-BR")} a ${hoje.toLocaleDateString("pt-BR")}`;

  const tpl = templateDigestExecutivo({ periodoLabel, kpis, secoes, alertasCrc });

  const resultado = await sendEmail({
    to: destinatarios,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });

  log.info("digest enviado", { destinatarios: destinatarios.length, emailOk: resultado.ok });

  return NextResponse.json({
    ok: true,
    enviado: resultado.ok,
    destinatarios: destinatarios.length,
    kpis: kpis.length,
    secoes: secoes.length,
    alertasCrc: alertasCrc.length,
  });
}
