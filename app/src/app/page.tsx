// EXCEÇÃO REGISTRADA (decisão de arquitetura do strangler): RSC lê Postgres
// direto — não converter para fetch no BFF.
export const dynamic = "force-dynamic";

import { db } from "@/db";
import {
  licitacoes, historicoAlteracoes, syncLog, circulares, resultadosLicitacao,
} from "@/db/schema";
import { sql, count, desc, inArray } from "drizzle-orm";
import { AlertTriangle, Clock, CheckCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { podeVisualizar } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { KpiCard } from "@/components/shared/dashboard/KpiCard";
import { RadarTimeline } from "@/components/shared/dashboard/RadarTimeline";
import { PerformancePanel } from "@/components/shared/dashboard/PerformancePanel";
import { VencedoresProponente } from "@/components/shared/dashboard/VencedoresProponente";
import { ActivityFeed } from "@/components/shared/dashboard/ActivityFeed";
import { normalizeCnpj } from "@/lib/format";
import { config } from "@/lib/config";

async function getDashboardData() {
  const propCnpj = normalizeCnpj(config.proponente.cnpj);

  const [
    [totalRow],
    porRelevancia,
    [novasSemanaRow],
    [vencendo7dRow],
    sparkDaily,
    urgentes,
    novas24h,
    [ultimoSyncRow],
    movimentacoes,
    circularesFeed,
    ultimosResultadosRaw,
  ] = await Promise.all([
    db.select({ count: count() }).from(licitacoes),

    db.select({ relevancia: licitacoes.relevancia, count: count() })
      .from(licitacoes).groupBy(licitacoes.relevancia),

    db.select({ count: count() }).from(licitacoes)
      .where(sql`criado_em >= NOW() - INTERVAL '7 days'`),

    db.select({ count: count() }).from(licitacoes)
      .where(sql`data_fim IS NOT NULL AND data_fim != '' AND date(data_fim) BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`),

    // Sparkline: novas por dia nos ultimos 14 dias
    db.execute(sql`
      SELECT d::date as dia, COALESCE(c.cnt, 0)::int as v
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, '1 day') d
      LEFT JOIN (
        SELECT criado_em::date as dia, COUNT(*)::int as cnt
        FROM licitacoes WHERE criado_em >= NOW() - INTERVAL '14 days'
        GROUP BY criado_em::date
      ) c ON c.dia = d::date
      ORDER BY d
    `),

    // Urgentes: ALTA/MEDIA vencendo em 7 dias
    db.select({
      id: licitacoes.id, numero: licitacoes.numero, objeto: licitacoes.objeto,
      relevancia: licitacoes.relevancia, dataFim: licitacoes.dataFim,
      horaFim: licitacoes.horaFim, empresa: licitacoes.empresa,
    }).from(licitacoes).where(sql`
      relevancia IN ('ALTA','MÉDIA') AND data_fim IS NOT NULL AND data_fim != ''
      AND date(data_fim) BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
    `).orderBy(licitacoes.dataFim, desc(licitacoes.scoreInteresse)).limit(12),

    // Novas nas ultimas 24h
    db.select({
      id: licitacoes.id, numero: licitacoes.numero, objeto: licitacoes.objeto,
      relevancia: licitacoes.relevancia, dataFim: licitacoes.dataFim,
      empresa: licitacoes.empresa,
    }).from(licitacoes).where(sql`criado_em >= NOW() - INTERVAL '24 hours'`)
      .orderBy(desc(licitacoes.scoreInteresse)).limit(5),

    // Ultimo sync
    db.select().from(syncLog).orderBy(desc(syncLog.executadoEm)).limit(1),

    // Feed: movimentacoes de licitacoes (7 dias)
    db.select({
      id: historicoAlteracoes.id, licitacaoId: historicoAlteracoes.licitacaoId,
      campo: historicoAlteracoes.campo, valorNovo: historicoAlteracoes.valorNovo,
      detectadoEm: historicoAlteracoes.detectadoEm,
    }).from(historicoAlteracoes).where(sql`campo IN ('fase','data_fim','natureza') AND detectado_em >= NOW() - INTERVAL '7 days'`)
      .orderBy(desc(historicoAlteracoes.detectadoEm)).limit(8),

    // Feed: circulares recentes
    db.select({
      id: circulares.id, licitacaoId: circulares.licitacaoId,
      tipo: circulares.tipo, mensagem: circulares.mensagem,
      criadoEm: circulares.criadoEm,
    }).from(circulares).where(sql`criado_em >= NOW() - INTERVAL '7 days'`)
      .orderBy(desc(circulares.criadoEm)).limit(5),

    // Ultimos resultados da Proponente
    db.select({
      numeroLicitacao: resultadosLicitacao.numeroLicitacao,
      licitacaoId: resultadosLicitacao.licitacaoId,
      cnpjVencedor: resultadosLicitacao.cnpjVencedor,
      fornecedorVencedor: resultadosLicitacao.fornecedorVencedor,
    }).from(resultadosLicitacao)
      .where(sql`cnpj_vencedor IS NOT NULL`)
      .orderBy(desc(resultadosLicitacao.criadoEm)).limit(10),
  ]);

  // Derived
  const relMap = Object.fromEntries(porRelevancia.map(r => [r.relevancia ?? "N/A", r.count]));

  // Sparkline data
  const spark = (sparkDaily.rows ?? sparkDaily) as { dia: string; v: number }[];

  // Enrich movimentacoes with licitacao numbers
  const movLicIds = [...new Set(movimentacoes.map(m => m.licitacaoId))];
  const circLicIds = [...new Set(circularesFeed.map(c => c.licitacaoId))];
  const allIds = [...new Set([...movLicIds, ...circLicIds])];
  const licLookup = allIds.length > 0
    ? await db.select({ id: licitacoes.id, numero: licitacoes.numero })
        .from(licitacoes).where(inArray(licitacoes.id, allIds))
    : [];
  const licMap = new Map(licLookup.map(l => [l.id, l.numero]));

  // Build feed items
  type FeedItem = { id: string; type: "nova" | "fase" | "circular" | "resultado" | "sync"; title: string; detail?: string; link?: string; timestamp: string | null };
  const feedItems: FeedItem[] = [];

  for (const m of movimentacoes) {
    const num = licMap.get(m.licitacaoId) ?? "?";
    feedItems.push({
      id: `mov-${m.id}`, type: "fase",
      title: `${m.campo === "fase" ? "Fase alterada" : "Data alterada"}: ${num}`,
      detail: m.valorNovo ? `→ ${m.valorNovo}` : undefined,
      link: `/licitacoes/${m.licitacaoId}` , timestamp: m.detectadoEm?.toISOString() ?? null,
    });
  }
  for (const c of circularesFeed) {
    const num = licMap.get(c.licitacaoId) ?? "?";
    feedItems.push({
      id: `circ-${c.id}`, type: "circular",
      title: `Circular em ${num}`,
      detail: (c.mensagem ?? "").slice(0, 60),
      link: `/licitacoes/${c.licitacaoId}`, timestamp: c.criadoEm?.toISOString() ?? null,
    });
  }
  feedItems.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));

  // Ultimos resultados processados
  const resultados = ultimosResultadosRaw.slice(0, 5).map(r => ({
    numero: r.numeroLicitacao,
    licitacaoId: r.licitacaoId,
    ganhou: normalizeCnpj(r.cnpjVencedor) === propCnpj,
    fornecedor: r.fornecedorVencedor,
  }));

  return {
    total: totalRow.count,
    alta: relMap["ALTA"] ?? 0,
    novasSemana: novasSemanaRow.count,
    vencendo7d: vencendo7dRow.count,
    spark: spark.map(s => ({ v: Number(s.v) })),
    urgentes, novas24h,
    ultimoSync: ultimoSyncRow,
    feedItems,
    resultados,
  };
}

export default async function DashboardPage() {
  // Gate de papel (mesmo padrão de /relatorios): EXTERNO não pode ver o
  // valores agregados do Painel. Checa ANTES das ~11 queries.
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!podeVisualizar(session.user.role)) redirect("/sem-acesso");

  const stats = await getDashboardData();

  // Sync info in BRT
  let ultimoSyncStr = "Nunca";
  let syncDesatualizado = true;
  let tempoAtras = "";

  if (stats.ultimoSync?.executadoEm) {
    const syncDate = new Date(stats.ultimoSync.executadoEm);
    const diffMs = Date.now() - syncDate.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMs / 3600000);
    const brt = new Date(syncDate.getTime() - 3 * 3600000);
    const dd = String(brt.getUTCDate()).padStart(2, "0");
    const mm = String(brt.getUTCMonth() + 1).padStart(2, "0");
    const hh = String(brt.getUTCHours()).padStart(2, "0");
    const mi = String(brt.getUTCMinutes()).padStart(2, "0");
    ultimoSyncStr = `${dd}/${mm} às ${hh}:${mi}`;
    syncDesatualizado = diffMs > 8 * 3600000;
    if (diffMin < 1) tempoAtras = "agora";
    else if (diffMin < 60) tempoAtras = `há ${diffMin}min`;
    else if (diffH < 24) tempoAtras = `há ${diffH}h`;
    else tempoAtras = `há ${Math.floor(diffH / 24)}d`;
  }

  // Trend: compare this week vs last week
  const sparkArr = stats.spark;
  const thisWeek = sparkArr.slice(-7).reduce((s, d) => s + d.v, 0);
  const lastWeek = sparkArr.slice(0, 7).reduce((s, d) => s + d.v, 0);
  const trendPct = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;

  return (
    <div className="space-y-6">

      {/* ── Header + Sync ── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900 tracking-tight">Painel</h1>
          <p className="text-sm text-gray-400 mt-0.5">Visão geral das licitações</p>
        </div>
        <div className={cn(
          "flex items-center gap-2.5 px-3.5 py-2 rounded-xl text-[11px] font-medium border",
          (stats.ultimoSync?.erros ?? 0) > 0
            ? "bg-red-50 border-red-200 text-red-600"
            : syncDesatualizado
            ? "bg-amber-50 border-amber-200 text-amber-600"
            : "bg-green-50 border-green-100 text-green-600"
        )}>
          {(stats.ultimoSync?.erros ?? 0) > 0 ? <AlertTriangle className="h-3.5 w-3.5" />
            : syncDesatualizado ? <Clock className="h-3.5 w-3.5" />
            : <CheckCircle className="h-3.5 w-3.5" />}
          <span>Sync: <strong>{ultimoSyncStr}</strong> {tempoAtras && `(${tempoAtras})`}</span>
          {(stats.ultimoSync?.novas ?? 0) > 0 && (
            <>
              <span className="w-px h-3 bg-current opacity-20" />
              <span>+{stats.ultimoSync!.novas} novas</span>
            </>
          )}
        </div>
      </div>

      {/* ── ZONA 1: KPI Strip ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Licitações"
          value={stats.total}
          sparkData={sparkArr}
          trend={trendPct !== 0 ? `${trendPct > 0 ? "+" : ""}${trendPct}%` : "Estável"}
          trendUp={trendPct > 0 ? true : trendPct < 0 ? false : undefined}
          color="default"
          href="/explorar"
        />
        <KpiCard
          label="Alta Relevância"
          value={stats.alta}
          color="orange"
          trend={stats.alta > 0 ? `${stats.alta} para avaliar` : "—"}
          href="/explorar?relevancia=ALTA"
        />
        <KpiCard
          label="Novas (7 dias)"
          value={stats.novasSemana}
          sparkData={sparkArr.slice(-7)}
          trend={`+${stats.novasSemana}`}
          trendUp={stats.novasSemana > 0}
          color="green"
          href="/explorar?novas=1"
        />
        <KpiCard
          label="Vencendo (7 dias)"
          value={stats.vencendo7d}
          color={stats.vencendo7d > 5 ? "red" : stats.vencendo7d > 0 ? "amber" : "default"}
          trend={stats.vencendo7d > 0 ? "Atenção" : "Nenhuma"}
          trendUp={stats.vencendo7d === 0 ? true : false}
          href="/explorar?prazo=7d"
        />
      </div>

      {/* ── ZONA 2+3: Radar + Performance ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <RadarTimeline urgentes={stats.urgentes} novas={stats.novas24h} />
        <PerformancePanel ultimosResultados={stats.resultados} />
      </div>

      {/* ── ZONA 3.5: Vencedores Proponente confirmados (V2) ── */}
      {config.features.resultados && (
        <VencedoresProponente />
      )}

      {/* ── ZONA 4: Activity Feed ── */}
      <ActivityFeed items={stats.feedItems} />
    </div>
  );
}
