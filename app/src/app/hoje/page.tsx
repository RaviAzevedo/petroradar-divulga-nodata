"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  CalendarClock, Loader2, AlertCircle, Clock, Sparkles, RefreshCw, Inbox, Flame,
} from "lucide-react";
import { cn, diasRestantes } from "@/lib/utils";

// ── Tipos dos contratos consumidos ────────────────────────────────────────────

interface LicitacaoRow {
  id:             string;
  numero:         string;
  objeto:         string | null;
  empresa:        string | null;
  segmento:       string | null;
  relevancia:     string | null;
  scoreInteresse: number | null;
  dataFim:        string | null;
}

interface LicitacoesResp {
  data: LicitacaoRow[];
  meta: { total: number };
}

const SCORE_MINIMO = 70;
const JANELA_PRAZO_H = 72;

/** Data local (não UTC) — à noite em BRT o toISOString já virou o dia seguinte. */
function dataLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function horasAte(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms / (1000 * 60 * 60);
}

function rotuloPrazo(iso: string | null): { texto: string; urgente: boolean } {
  const h = horasAte(iso);
  if (h == null) return { texto: "sem prazo", urgente: false };
  if (h < 0) return { texto: "vencido", urgente: true };
  if (h < 24) return { texto: `${Math.round(h)}h restantes`, urgente: true };
  return { texto: `${Math.round(h / 24)}d restantes`, urgente: h < 48 };
}

export default function HojePage() {
  const [prazos, setPrazos]   = useState<LicitacaoRow[]>([]);
  const [editais, setEditais] = useState<LicitacaoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro]       = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const hoje = new Date();
      const hojeLocal = dataLocal(hoje);
      // `data_fim <= X` compara texto; um dia de folga cobre data_fim com hora,
      // e o recorte exato das 72h é feito abaixo, por horas.
      const limite = dataLocal(new Date(hoje.getTime() + (JANELA_PRAZO_H + 24) * 3600 * 1000));
      const [pRes, lRes] = await Promise.all([
        // Licitações de relevância ALTA/MÉDIA que encerram nas próximas 72h —
        // o mesmo recorte do e-mail de prazo crítico (cron prazos).
        fetch(`/api/licitacoes?relevancia=ALTA,MEDIA&data_fim_de=${hojeLocal}&data_fim_ate=${limite}&sort=data_fim&order=asc&limit=50`),
        // Novos editais (últimas 24h: novas=1) de alto score, excluindo prazo vencido.
        fetch(`/api/licitacoes?sort=score_interesse&order=desc&limit=20&novas=1&data_fim_de=${hojeLocal}`),
      ]);
      if (!pRes.ok || !lRes.ok) throw new Error("Falha ao carregar o painel de hoje");

      const pJson = (await pRes.json()) as LicitacoesResp;
      const lJson = (await lRes.json()) as LicitacoesResp;

      setPrazos(
        (pJson.data ?? []).filter((l) => {
          const h = horasAte(l.dataFim);
          return h != null && h >= 0 && h < JANELA_PRAZO_H;
        }),
      );
      setEditais((lJson.data ?? []).filter((l) => (l.scoreInteresse ?? 0) >= SCORE_MINIMO));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  if (loading && prazos.length === 0 && editais.length === 0) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
        <span className="ml-2 text-sm text-gray-500">Carregando o seu dia…</span>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-black flex items-center gap-2">
            <CalendarClock className="h-6 w-6 text-brand-orange" /> Hoje
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            O que precisa da sua atenção agora.
          </p>
        </div>
        <button
          onClick={carregar}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 text-xs font-semibold text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Atualizar
        </button>
      </div>

      {erro && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {erro}
          <button onClick={carregar} className="ml-auto text-xs underline">Tentar de novo</button>
        </div>
      )}

      {/* SEÇÃO 1 — Prazos 72h (licitações ALTA/MÉDIA) */}
      <Secao
        titulo="Encerram nas próximas 72h"
        icon={Clock}
        cor="text-red-500"
        contador={prazos.length}
        vazio="Nenhuma licitação de relevância alta ou média encerra nas próximas 72 horas."
      >
        {prazos.map((l) => {
          const prazo = rotuloPrazo(l.dataFim);
          return (
            <Link
              key={l.id}
              href={`/licitacoes/${l.id}`}
              className={cn(
                "block rounded-xl border p-3 transition-colors",
                prazo.urgente
                  ? "bg-red-50/60 border-red-200 hover:border-red-300"
                  : "bg-white border-gray-200 hover:border-gray-300",
              )}
            >
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <span className="font-mono text-xs font-bold text-gray-700">{l.numero}</span>
                <span className={cn(
                  "text-[11px] font-semibold px-2 py-0.5 rounded-full",
                  prazo.urgente ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600",
                )}>
                  {prazo.texto}
                </span>
              </div>
              {l.objeto && <p className="text-sm text-gray-800 line-clamp-2">{l.objeto}</p>}
              <p className="text-[11px] text-gray-500 mt-1">
                {l.relevancia && <span className="uppercase">{l.relevancia}</span>}
                {l.relevancia && l.segmento && " · "}
                {l.segmento && <span className="uppercase">{l.segmento}</span>}
              </p>
            </Link>
          );
        })}
      </Secao>

      {/* SEÇÃO 2 — Novos editais alto score */}
      <Secao
        titulo={`Novos editais (score ≥ ${SCORE_MINIMO})`}
        icon={Flame}
        cor="text-amber-500"
        contador={editais.length}
        vazio="Nenhum edital de alto score no momento."
      >
        {editais.map((l) => {
          const dias = diasRestantes(l.dataFim);
          return (
            <Link
              key={l.id}
              href={`/licitacoes/${l.id}`}
              className="block rounded-xl border border-gray-200 bg-white p-3 hover:border-brand-orange transition-colors"
            >
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <span className="font-mono text-xs font-bold text-gray-700">{l.numero}</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-600">
                  <Sparkles className="h-3 w-3" /> {l.scoreInteresse}
                </span>
              </div>
              {l.objeto && <p className="text-sm text-gray-800 line-clamp-2">{l.objeto}</p>}
              <p className="text-[11px] text-gray-500 mt-1">
                {l.segmento && <span className="uppercase">{l.segmento}</span>}
                {l.segmento && dias != null && " · "}
                {dias != null && (dias >= 0 ? `encerra em ${dias}d` : "prazo encerrado")}
              </p>
            </Link>
          );
        })}
      </Secao>

    </div>
  );
}

// ── Seção colapsável-friendly (mobile-first) ──────────────────────────────────

function Secao({
  titulo, icon: Icon, cor, contador, vazio, children,
}: {
  titulo:   string;
  icon:     React.ComponentType<{ className?: string }>;
  cor:      string;
  contador: number;
  vazio:    string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn("h-4 w-4", cor)} />
        <h2 className="text-sm font-bold text-brand-black">{titulo}</h2>
        <span className="text-xs font-semibold text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
          {contador}
        </span>
      </div>
      {contador === 0 ? (
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-xl p-4">
          <Inbox className="h-4 w-4" /> {vazio}
        </div>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}
