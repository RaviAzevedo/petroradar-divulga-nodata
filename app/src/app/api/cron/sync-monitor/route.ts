export const runtime = "nodejs";

/**
 * GET  /api/cron/sync-monitor — disparado pelo scheduler (Celery beat, 00/06/12/18 UTC)
 * POST /api/cron/sync-monitor — disparado pelo WORKER quando um job de coleta falha
 *
 * Monitora a saúde do pipeline de coleta (containers do worker → DB).
 * Envia alertas por e-mail para admins quando:
 *   - Sync não roda há mais de 6 horas
 *   - Último sync registrou erros
 *   - Último sync encontrou 0 licitações
 *
 * ON-PREM: não existe mais GitHub Actions. A coleta roda em containers Docker e
 * o e-mail de alerta aponta para o painel interno do app (NEXTAUTH_URL), nunca
 * para github.com/.../actions — em air-gap aquele host nem resolve DNS.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { syncLog } from "@/db/schema";
import { MAX_HORAS_POR_TIPO, tiposEmExecucao } from "@/lib/observability/scraper-health";
import { sql, desc, eq } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { emailsPorPapel } from "@/lib/email/destinatarios";
import { templateSyncFalhou } from "@/lib/email/templates";
import { loggerFor } from "@/lib/observability/logger";
import { verifyCronAuth, verifyBearer } from "@/lib/security/secrets";
import { revalidateTag } from "next/cache";

// O alerta ia também para um webhook Teams/Slack (NOTIFY_WEBHOOK_URL), que nunca
// chegou a ser configurado e foi removido. O canal é o e-mail.

// GITHUB_REPOSITORY foi removido: era o repo do SaaS, usado só para montar o
// link do GitHub Actions no e-mail. O templateSyncFalhou hoje monta o CTA a
// partir de NEXTAUTH_URL (link interno do app) e ignora `githubRepo`.

// 14h: a maior janela sem coleta e a noturna (~10h no calendario atual).
// Era 6h — resquicio da era SaaS, quando o sync rodava de 30 em 30 min. Com a
// coleta em janelas diarias, 6h fazia o monitor das 06:00 UTC acusar parada TODA
// madrugada, sem nada estar parado (1 falso alarme/dia).
const MAX_HORAS_SEM_SYNC = 14;

// A tabela de limites POR TIPO vive em lib/observability/scraper-health.ts —
// fonte unica do lado Next, importada no topo. Antes havia uma copia aqui, e as
// duas divergiram: o painel classificava CRITICO com um limite e o e-mail com
// outro.

/** ADMINs ativos que não desligaram "Falha ou atraso na coleta" em /admin/emails. */
const getAdminEmails = () => emailsPorPapel("SYNC_FALHOU");

function formatTimestamp(date: Date): string {
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

// ── GET: Vercel Cron — verifica saúde do sync a cada 2h ──────────────────────

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log   = loggerFor(req, { route: "cron/sync-monitor" });
  const agora = new Date();

  // Última execução por tipo (não só a global) — detecta gap de modos especializados
  const ultimosPorTipo = await db
    .select({
      tipo:             syncLog.tipo,
      // C1: gap por tipo sobre o ultimo run que NAO foi FALHA de task. Linhas de
      // falha (_grava_sync_log_falha grava detalhes 'FALHA na task do worker: ...'
      // com executado_em=NOW()) refrescariam o MAX e um scraper que roda-e-sempre
      // -falha NUNCA dispararia o alerta de gap. (sync_log.erros e contador de
      // falhas por-item de runs de SUCESSO, nao um flag de falha-da-task.)
      maxExecutadoEm:   sql<Date>`MAX(${syncLog.executadoEm}) FILTER (WHERE COALESCE(detalhes, '') NOT LIKE ${'FALHA na task do worker:%'})`.as("max_executado_em"),
    })
    .from(syncLog)
    .groupBy(syncLog.tipo);

  if (ultimosPorTipo.length === 0) {
    return NextResponse.json({
      ok: true,
      alerta: false,
      motivo: "Nenhum sync_log encontrado",
    });
  }

  const emExecucao = await tiposEmExecucao();

  // Detecta tipos críticos com gap excedente
  type GapAlerta = { tipo: string; horasSemSync: number; limite: number };
  const tiposEmAtraso: GapAlerta[] = [];

  for (const linha of ultimosPorTipo) {
    if (!linha.maxExecutadoEm) continue;
    const limite = MAX_HORAS_POR_TIPO[linha.tipo];
    if (!limite) continue; // tipo desconhecido — ignora
    const horas = Math.floor(
      (agora.getTime() - new Date(linha.maxExecutadoEm).getTime()) / (1000 * 60 * 60),
    );
    // Rodando AGORA nao e atraso: o sync_log so ganha a linha quando termina, e a
    // circulares completa leva ~2h30. Sem esta guarda o alerta acusava parada no
    // meio de um job legitimo — e o painel (que ja distingue) diria o contrario.
    if (horas >= limite && !emExecucao.has(linha.tipo)) {
      tiposEmAtraso.push({ tipo: linha.tipo, horasSemSync: horas, limite });
    }
  }

  // Último sync_log global (para detectar erros do último run e legacy)
  const [ultimoSync] = await db
    .select()
    .from(syncLog)
    .orderBy(desc(syncLog.executadoEm))
    .limit(1);

  const executadoEm = ultimoSync?.executadoEm ?? agora;
  const horasSemSyncGlobal = Math.floor(
    (agora.getTime() - executadoEm.getTime()) / (1000 * 60 * 60),
  );

  let motivo: string | null = null;

  if (tiposEmAtraso.length > 0) {
    motivo =
      "Tipos de sync com gap excedido: " +
      tiposEmAtraso
        .map((g) => `${g.tipo} (${g.horasSemSync}h, limite ${g.limite}h)`)
        .join("; ");
  } else if (horasSemSyncGlobal >= MAX_HORAS_SEM_SYNC) {
    motivo = `Sync global não roda há ${horasSemSyncGlobal}h (limite: ${MAX_HORAS_SEM_SYNC}h)`;
  } else if ((ultimoSync?.erros ?? 0) > 0) {
    motivo = `Último sync registrou ${ultimoSync?.erros} erro(s)`;
  } else if ((ultimoSync?.totalEncontradas ?? 0) === 0 && ultimoSync?.tipo === "todas") {
    motivo = "Último sync 'todas' encontrou 0 licitações";
  }

  if (!motivo) {
    // Sync OK + recente → invalida cache de analytics pra próximo request
    // pegar dados frescos sem esperar revalidate de 1h.
    if (horasSemSyncGlobal < 1) {
      // Next 16: revalidateTag exige profile ('max' = expira imediato).
      revalidateTag("analytics", "max");
      log.info("cache de analytics invalidado (sync recente)");
    }
    return NextResponse.json({
      ok: true,
      alerta: false,
      ultimoSync: ultimoSync?.id,
      horasSemSyncGlobal,
      tiposVerificados: ultimosPorTipo.length,
    });
  }

  // Idempotência: se for alerta de gap por tipo, usa chave própria.
  // Se for alerta do último log, usa o flag [ALERTED] no detalhes.
  const chaveIdempotencia =
    tiposEmAtraso.length > 0
      ? `[ALERTED-GAP:${tiposEmAtraso.map((t) => t.tipo).sort().join(",")}]`
      : "[ALERTED]";

  const jaAlertado = (ultimoSync?.detalhes ?? "").includes(chaveIdempotencia);
  if (jaAlertado) {
    return NextResponse.json({
      ok: true,
      alerta: false,
      motivo: "Alerta já enviado",
      ultimoSync: ultimoSync?.id,
    });
  }

  const emails = await getAdminEmails();
  if (emails.length === 0) {
    log.warn("nenhum admin com email encontrado");
    return NextResponse.json({
      ok: true,
      alerta: true,
      motivo,
      emailEnviado: false,
      razao: "Sem admins",
    });
  }

  const template = templateSyncFalhou({
    tipo: tiposEmAtraso.length > 0
      ? `gap por tipo: ${tiposEmAtraso.map((t) => t.tipo).join(", ")}`
      : ultimoSync?.tipo ?? "?",
    executadoEm: formatTimestamp(executadoEm),
    erros: ultimoSync?.erros ?? 0,
    totalEncontradas: ultimoSync?.totalEncontradas ?? 0,
    detalhes: motivo,
    horasSemSync:
      tiposEmAtraso.length > 0
        ? Math.max(...tiposEmAtraso.map((t) => t.horasSemSync))
        : horasSemSyncGlobal >= MAX_HORAS_SEM_SYNC
        ? horasSemSyncGlobal
        : undefined,
  });

  const resultado = await sendEmail({
    to: emails,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  if (resultado.ok && ultimoSync) {
    const novoDetalhe = [ultimoSync.detalhes ?? "", chaveIdempotencia]
      .filter(Boolean)
      .join(" ");

    await db
      .update(syncLog)
      .set({ detalhes: novoDetalhe })
      .where(eq(syncLog.id, ultimoSync.id));
  }

  log.info("alerta enviado", {
    motivo,
    tiposEmAtraso,
    destinatarios: emails.length,
    emailOk:       resultado.ok,
  });

  return NextResponse.json({
    ok: true,
    alerta: true,
    motivo,
    tiposEmAtraso,
    emailEnviado: resultado.ok,
    destinatarios: emails.length,
  });
}

// ── POST: hook de falha do worker de coleta ──────────────────────────────────
//
// NÃO é órfão: no SaaS quem POSTava era o GitHub Actions "on failure"; no
// on-prem quem POSTa é o WORKER, quando um job de coleta sai com rc != 0
// (`_notificar_falha_scraper`). O contrato do
// body {evento, modo, erro} foi mantido de propósito para essa paridade, e é
// coberto por tests/e2e/crons_api.py. Só a origem mudou — a rota fica.

interface PostBody {
  evento: string;
  modo: string;
  erro: string;
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  // Em produção (CRON_SECRET configurado) exige Bearer constant-time;
  // em dev/local (sem secret) o POST do worker passa direto.
  if (cronSecret && !verifyBearer(req, cronSecret)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/sync-monitor", method: "POST" });

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const { evento, modo, erro } = body;

  const emails = await getAdminEmails();
  if (emails.length === 0) {
    log.warn("nenhum admin com email encontrado");
    return NextResponse.json({ ok: true, emailEnviado: false });
  }

  const template = templateSyncFalhou({
    tipo: `${evento} (${modo})`,
    executadoEm: formatTimestamp(new Date()),
    erros: 1,
    totalEncontradas: 0,
    detalhes: erro,
  });

  const resultado = await sendEmail({
    to: emails,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  log.info("alerta de falha do worker de coleta", {
    evento,
    modo,
    emailOk: resultado.ok,
  });

  return NextResponse.json({
    ok: true,
    emailEnviado: resultado.ok,
    destinatarios: emails.length,
  });
}
