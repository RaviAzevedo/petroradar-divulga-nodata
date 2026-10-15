export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/relatorio-mensal — relatório executivo mensal por e-mail.
 *
 * Coleta os dados do relatório e notifica a gestão (ADMIN/LIDER) via
 * templateRelatorioMensal (layout único da marca), com os KPIs do mês no corpo.
 *
 * Sem anexo e sem download: o hub /relatorios (e o XLSX executivo que ele
 * servia) foi removido. O e-mail traz os KPIs no corpo.
 *
 * O logo da marca é anexado inline pelo próprio sendEmail() — não passe
 * `inlineImages` aqui.
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 * Gate gracioso por config.crons.relatorioMensal.habilitado.
 */

import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { emailsPorPapel } from "@/lib/email/destinatarios";
import { templateRelatorioMensal, type DigestKpi } from "@/lib/email/templates";
import { coletarDadosRelatorio } from "@/lib/relatorios/executivo-dados";
import { loggerFor } from "@/lib/observability/logger";

function autorizarCron(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    return authHeader === `Bearer ${cronSecret}`;
  }
  return req.headers.get("x-vercel-cron") === "1";
}

/** ADMIN/LIDER ativos que não desligaram "Relatório executivo mensal". */
const getDestinatariosGestao = () => emailsPorPapel("RELATORIO_MENSAL");

const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
               "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

export async function GET(req: NextRequest) {
  if (!autorizarCron(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/relatorio-mensal" });

  if (!config.crons.relatorioMensal.habilitado) {
    return NextResponse.json({ ok: true, skipped: true, motivo: "cron desabilitado" });
  }

  const destinatarios = await getDestinatariosGestao();
  if (destinatarios.length === 0) {
    log.warn("nenhum destinatário de gestão");
    return NextResponse.json({ ok: true, enviado: false, motivo: "sem destinatários" });
  }

  // Mês de referência = mês anterior ao corrente.
  const agora = new Date();
  const refData = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const mesLabel = `${MESES[refData.getMonth()]}/${refData.getFullYear()}`;

  // Os dados alimentam os KPIs do corpo: sem eles não há e-mail. Fatal.
  let dados;
  try {
    dados = await coletarDadosRelatorio(12);
  } catch (e) {
    log.error("falha ao coletar dados do relatório mensal", e);
    return NextResponse.json({ error: "Falha ao gerar relatório" }, { status: 500 });
  }

  const r = dados.performance.resumo;
  const kpis: DigestKpi[] = [
    {
      rotulo: "Taxa de sucesso",
      valor:  `${r.taxaSucessoAtual}%`,
      variacao: `${r.delta >= 0 ? "+" : ""}${r.delta} p.p.`,
      tendencia: r.delta > 0 ? "up" : r.delta < 0 ? "down" : "neutral",
    },
    { rotulo: "Valor ganho (12m)", valor: fmtBRL(r.valorGanho12m) },
    { rotulo: "Participações (12m)", valor: String(dados.participacoes.totais.total) },
    { rotulo: "Vitórias (12m)", valor: String(dados.participacoes.totais.ganhou) },
  ];

  // "Destaques do mês" carrega SÓ conteúdo de negócio.
  const lacunasComDemanda = dados.lacunasCrc.filter((l) => l.demandaRecente > 0);
  const observacoes: string[] = [];
  if (lacunasComDemanda.length > 0) {
    observacoes.push(
      `${lacunasComDemanda.length} família(s) CRC sem aprovação com demanda recente — priorizar renovação.`,
    );
    for (const l of lacunasComDemanda.slice(0, 3)) {
      observacoes.push(`${l.codigoCrc} — ${l.nome}: ${l.demandaRecente} licitação(ões) recente(s).`);
    }
  }

  const tpl = templateRelatorioMensal({ mesLabel, kpis, observacoes });

  const resultado = await sendEmail({
    to: destinatarios,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });

  log.info("relatório mensal enviado", {
    mesLabel,
    destinatarios: destinatarios.length,
    emailOk: resultado.ok,
  });

  return NextResponse.json({
    ok: true,
    enviado: resultado.ok,
    mesLabel,
    destinatarios: destinatarios.length,
  });
}
