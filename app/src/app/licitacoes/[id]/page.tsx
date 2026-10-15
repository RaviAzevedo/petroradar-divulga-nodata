// EXCEÇÃO REGISTRADA (decisão de arquitetura do strangler): RSC lê Postgres
// direto — não converter para fetch no BFF.
export const dynamic = "force-dynamic";

import { db } from "@/db";
import { licitacoes, itens, anexos, historicoAlteracoes, analisesIa, circulares } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Calendar, MapPin, Building2, Tag, Satellite, Download } from "lucide-react";
import { cn, relevanciaColor, formatDate, diasRestantes } from "@/lib/utils";
import { DossiePanel } from "@/components/licitacoes/DossiePanel";
import { briefingIaHabilitado } from "@/lib/licitacoes/briefing-flag";
import { CircularTimeline } from "@/components/licitacoes/CircularTimeline";
import { GoNoGoPanel } from "@/components/licitacoes/GoNoGoPanel";
import { GapHabilitacaoPanel } from "@/components/licitacoes/GapHabilitacaoPanel";
import { auth } from "@/lib/auth";
import {
  podeVisualizar,
  podeProporParticipacao,
} from "@/lib/permissions";

export default async function LicitacaoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Gate de papel (mesmo padrão de /relatorios): o detalhe expõe itens, anexos,
  // dossiê — dado interno vedado ao papel EXTERNO.
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!podeVisualizar(session.user.role)) redirect("/sem-acesso");

  const lic = await db.select().from(licitacoes).where(eq(licitacoes.id, id)).limit(1).then(r => r[0]);
  if (!lic) notFound();

  const [licItens, licAnexos, anexosTextoResult, licHistorico, analiseRow, licCirculares, circCountResult] = await Promise.all([
    db.select().from(itens).where(eq(itens.licitacaoId, id)),
    // Colunas explícitas: NÃO trazer textoCache (pode ter MBs) só pra renderizar a lista.
    db.select({
      id: anexos.id,
      descricao: anexos.descricao,
      tamanhoBytes: anexos.tamanhoBytes,
      baixadoEm: anexos.baixadoEm,
    }).from(anexos).where(eq(anexos.licitacaoId, id)).orderBy(anexos.descricao),
    // Booleano calculado no banco: existe algum anexo com texto extraído?
    db.select({ temTexto: sql<boolean>`bool_or(length(${anexos.textoCache}) > 100)` })
      .from(anexos).where(eq(anexos.licitacaoId, id)).then(r => r[0]),
    db.select().from(historicoAlteracoes).where(eq(historicoAlteracoes.licitacaoId, id)).orderBy(desc(historicoAlteracoes.detectadoEm)),
    // Só a existência importa: com análise persistida, rebaixar o dossiê não gasta IA.
    db.select({ id: analisesIa.id }).from(analisesIa).where(eq(analisesIa.licitacaoId, id)).limit(1).then(r => r[0]),
    db.select({
      id: circulares.id,
      tipo: circulares.tipo,
      autor: circulares.autor,
      mensagem: circulares.mensagem,
      dataPublicacao: circulares.dataPublicacao,
      anexoPhioObjid: circulares.anexoPhioObjid,
      anexoDescricao: circulares.anexoDescricao,
      criadoEm: circulares.criadoEm,
    }).from(circulares).where(eq(circulares.licitacaoId, id)).orderBy(desc(circulares.dataPublicacao)),
    db.select({ count: sql<number>`count(*)::int` }).from(circulares).where(eq(circulares.licitacaoId, id)).then(r => r[0]),
  ]);

  const dias = diasRestantes(lic.dataFim);
  // #9: temTexto vem do booleano calculado no banco (anexosTextoResult) — a lista
  // licAnexos já NÃO traz textoCache (colunas explícitas, evita MBs no payload).
  const temTexto = (anexosTextoResult?.temTexto ?? false) || (lic.objeto?.length ?? 0) > 50;
  const role = session?.user?.role ?? "";
  const podePropor = podeProporParticipacao(role);

  // Triagem semântica do feed (Haiku) — {score,segmento,aderencia,justificativa,perfil_sugerido}
  const triagem = (lic.classificacaoIa ?? null) as {
    score?: number;
    segmento?: string;
    aderencia?: string;
    justificativa?: string;
    perfil_sugerido?: string;
  } | null;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link href="/explorar" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="h-3 w-3" /> Voltar
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 mb-1">
              <span className="font-mono text-base font-bold text-brand-black">{lic.numero}</span>
              <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border", relevanciaColor(lic.relevancia))}>
                {lic.relevancia ?? "N/A"} ({lic.scoreInteresse ?? 0}pts)
              </span>
              {/* Triagem semântica do feed (badge de segmento + aderência) */}
              {triagem && (typeof triagem.score === "number" || triagem.aderencia) && (
                <span
                  title={triagem.justificativa ?? undefined}
                  className="px-2 py-0.5 rounded-full text-xs font-medium border bg-indigo-50 text-indigo-700 border-indigo-200"
                >
                  Triagem IA{typeof triagem.score === "number" ? ` · ${triagem.score}` : ""}
                  {triagem.aderencia ? ` · ${triagem.aderencia}` : ""}
                </span>
              )}
            </h1>
            <p className="text-sm text-gray-600 mt-1 max-w-3xl">{lic.objeto}</p>

            {/* Aviso de origem: descoberta no Portal da Transparência (fonte fina;
                objeto e anexos foram recuperados do Petronect por número). */}
            {lic.fonte === "transparencia" && (
              <div className="mt-2 flex items-start gap-2 max-w-3xl rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
                <Satellite className="h-4 w-4 text-indigo-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-indigo-800">
                  Descoberta no <strong>Portal da Transparência</strong> (o scraper Petronect não a
                  coletou nativamente). Objeto e anexos foram recuperados do Petronect por número;
                  itens, circulares e propostas podem estar limitados.{" "}
                  <a
                    href="https://transparencia.petrobras.com.br/licitacoes"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold underline hover:text-indigo-900"
                  >
                    Ver no Portal
                  </a>
                </p>
              </div>
            )}

            {/* Download completo */}
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {/* Baixar tudo (ZIP): anexos + circulares num pacote — análise
                  offline antes do Go/No-Go e do GAP. Âncora simples: a
                  rota devolve attachment (sem JS). */}
              <a
                href={`/api/licitacoes/${id}/anexos-zip`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-brand-orange transition-colors"
                title="Baixa todos os anexos da licitação e as circulares (texto + anexos) num único ZIP"
              >
                <Download className="h-3.5 w-3.5" />
                Baixar tudo (ZIP)
              </a>
            </div>
          </div>
          {dias !== null && (
            <div className={cn(
              "px-4 py-2 rounded-lg text-center flex-shrink-0",
              dias <= 3 ? "bg-red-50 text-red-700" : dias <= 7 ? "bg-amber-50 text-amber-700" : "bg-gray-50 text-gray-600"
            )}>
              <div className="text-2xl font-bold">{dias}</div>
              <div className="text-xs">dias</div>
            </div>
          )}
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1"><Building2 className="h-3 w-3" /> Empresa</div>
          <div className="text-sm font-medium">{lic.empresa || "-"}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1"><Tag className="h-3 w-3" /> Classificação</div>
          <div className="text-sm font-medium">{lic.natureza || "-"}</div>
          <div className="text-xs text-gray-400">{lic.tipoServico} · {lic.segmento}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1"><Calendar className="h-3 w-3" /> Prazo</div>
          <div className="text-sm font-medium">{formatDate(lic.dataFim)} {lic.horaFim || ""}</div>
          <div className="text-xs text-gray-400">Fase: {lic.fase || "-"}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1"><MapPin className="h-3 w-3" /> Regiões</div>
          <div className="text-sm font-medium line-clamp-2">{lic.regioes || "-"}</div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Dossiê — um clique: anexos + análise IA + briefing PDF + CHECK-LIST num ZIP */}
        <DossiePanel
          licitacaoId={id}
          jaAnalisada={!!analiseRow}
          temTexto={temTexto}
          podePropor={podePropor}
          briefingHabilitado={briefingIaHabilitado()}
        />

        {/* Go/No-Go — semáforo de aderência CRC + habilitabilidade */}
        <GoNoGoPanel licitacaoId={id} />

        {/* Gap de Habilitação Inteligente — edital × cofre × CRC */}
        <GapHabilitacaoPanel licitacaoId={id} podeRecalcular={podePropor} />

        {/* Circulares */}
        <CircularTimeline
          licitacaoId={id}
          initialData={licCirculares.map(c => ({
            ...c,
            dataPublicacao: c.dataPublicacao?.toISOString() ?? null,
            criadoEm: c.criadoEm?.toISOString() ?? null,
          }))}
          initialTotal={circCountResult?.count ?? 0}
        />

        {/* Itens */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-brand-black mb-4">Itens ({licItens.length})</h2>
          {licItens.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left py-2.5 px-3 text-xs text-gray-500 uppercase font-medium">#</th>
                    <th className="text-left py-2.5 px-3 text-xs text-gray-500 uppercase font-medium">Descrição</th>
                    <th className="text-left py-2.5 px-3 text-xs text-gray-500 uppercase font-medium">Família</th>
                    <th className="text-right py-2.5 px-3 text-xs text-gray-500 uppercase font-medium">Qtd</th>
                    <th className="text-left py-2.5 px-3 text-xs text-gray-500 uppercase font-medium">Unidade</th>
                  </tr>
                </thead>
                <tbody>
                  {licItens.map((item) => (
                    <tr key={item.id} className="border-b border-gray-50">
                      <td className="py-2 text-gray-500">{item.itemNumero}</td>
                      <td className="py-2">{item.descricao || "-"}</td>
                      <td className="py-2 text-xs text-gray-500">{item.familiaDescricao || "-"}</td>
                      <td className="py-2 text-right">{item.quantidade || "-"}</td>
                      <td className="py-2 text-gray-500">{item.unidade || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-2">Nenhum item registrado para esta licitação</p>
          )}
        </div>

        {/* Anexos */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-brand-black mb-4">Anexos ({licAnexos.length})</h2>
          {licAnexos.length > 0 ? (
            <div className="space-y-2">
              {licAnexos.map((anx) => (
                <div key={anx.id} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-700">{anx.descricao || "Anexo"}</span>
                  <div className="flex items-center gap-3">
                    {anx.tamanhoBytes && (
                      <span className="text-xs text-gray-400">{(anx.tamanhoBytes / 1024).toFixed(0)} KB</span>
                    )}
                    <span className={cn(
                      "text-xs font-medium px-2 py-0.5 rounded",
                      anx.baixadoEm ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
                    )}>
                      {anx.baixadoEm ? "Baixado" : "Pendente"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-2">Nenhum anexo sincronizado</p>
          )}
        </div>

        {/* Histórico */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-brand-black mb-4">Histórico ({licHistorico.length})</h2>
          {licHistorico.length > 0 ? (
            <div className="space-y-2">
              {licHistorico.map((h) => (
                <div key={h.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <span className="text-sm text-gray-700">
                    <span className="font-medium">{h.campo}</span>: {h.valorAnterior || "(vazio)"} → {h.valorNovo}
                  </span>
                  <span className="text-xs text-gray-400">
                    {h.detectadoEm ? new Date(h.detectadoEm).toLocaleString("pt-BR") : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-2">Nenhuma alteração registrada</p>
          )}
        </div>
      </div>
    </div>
  );
}
