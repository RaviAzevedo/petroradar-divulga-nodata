"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity, Loader2, AlertCircle, CheckCircle2, AlertTriangle,
  XCircle, HelpCircle, RefreshCw, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Tipos do contrato de /api/admin/saude-scraper ─────────────────────────────
// Espelha SaudeScraper / SaudeTipoSync de lib/observability/scraper-health.

type StatusTipoSync = "OK" | "ATENCAO" | "CRITICO" | "DESCONHECIDO";

interface SaudeTipoSync {
  tipo:             string;
  ultimaExecucao:   string | null;
  horasDesde:       number | null;
  limiteHoras:      number | null;
  status:           StatusTipoSync;
  erros:            number;
  totalEncontradas: number;
  novas:            number;
}

interface SaudeScraper {
  geradoEm:      string;
  tipos:         SaudeTipoSync[];
  statusGlobal:  StatusTipoSync;
  tiposCriticos: string[];
  ultimoLogId:   number | null;
  ultimoLogEm:   string | null;
}

const STATUS_META: Record<StatusTipoSync, {
  label: string; icon: typeof CheckCircle2; cor: string; pill: string; dot: string;
}> = {
  OK:          { label: "OK",           icon: CheckCircle2, cor: "text-green-600", pill: "bg-green-100 text-green-700", dot: "bg-green-500" },
  ATENCAO:     { label: "Atenção",      icon: AlertTriangle, cor: "text-amber-600", pill: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  CRITICO:     { label: "Crítico",      icon: XCircle,       cor: "text-red-600",   pill: "bg-red-100 text-red-700",     dot: "bg-red-500" },
  DESCONHECIDO:{ label: "Desconhecido", icon: HelpCircle,    cor: "text-gray-400",  pill: "bg-gray-100 text-gray-500",   dot: "bg-gray-300" },
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatHoras(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}min`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

export default function SaudeScraperPage() {
  const [saude, setSaude]     = useState<SaudeScraper | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro]       = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const res = await fetch("/api/admin/saude-scraper");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setSaude(json.data ?? null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar saúde do scraper.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  if (loading && !saude) {
    return (
      <div className="p-6 flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
        <span className="ml-2 text-sm text-gray-500">Carregando saúde do scraper…</span>
      </div>
    );
  }

  const globalMeta = saude ? STATUS_META[saude.statusGlobal] : STATUS_META.DESCONHECIDO;
  const GlobalIcon = globalMeta.icon;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <header className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <Activity className="h-7 w-7 text-brand-orange mt-1" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Saúde do Scraper</h1>
            <p className="text-sm text-gray-500 mt-1 max-w-2xl">
              Observabilidade do pipeline de sync Petronect: última execução,
              gap em horas vs. limite esperado e erros por tipo.
            </p>
          </div>
        </div>
        <button
          onClick={carregar}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 text-sm font-semibold text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Atualizar
        </button>
      </header>

      {erro && (
        <div className="mb-4 flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {erro}
        </div>
      )}

      {saude && (
        <>
          {/* Status global */}
          <div className={cn(
            "rounded-xl border p-5 mb-6 flex items-center gap-4",
            saude.statusGlobal === "CRITICO" ? "bg-red-50 border-red-200" :
            saude.statusGlobal === "ATENCAO" ? "bg-amber-50 border-amber-200" :
            saude.statusGlobal === "OK"      ? "bg-green-50 border-green-200" :
                                               "bg-gray-50 border-gray-200",
          )}>
            <GlobalIcon className={cn("h-10 w-10 flex-shrink-0", globalMeta.cor)} />
            <div className="flex-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Status global</p>
              <p className={cn("text-2xl font-bold", globalMeta.cor)}>{globalMeta.label}</p>
              {saude.tiposCriticos.length > 0 && (
                <p className="text-sm text-red-700 mt-1">
                  Em gap excedido: <span className="font-semibold">{saude.tiposCriticos.join(", ")}</span>
                </p>
              )}
            </div>
            <div className="text-right text-xs text-gray-500">
              <p className="flex items-center gap-1 justify-end">
                <Clock className="h-3.5 w-3.5" /> Gerado em {formatTimestamp(saude.geradoEm)}
              </p>
              {saude.ultimoLogEm && (
                <p className="mt-0.5">
                  Último log #{saude.ultimoLogId ?? "—"} · {formatTimestamp(saude.ultimoLogEm)}
                </p>
              )}
            </div>
          </div>

          {/* Tabela por tipo */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="text-left  px-3 py-2.5 font-semibold">Tipo</th>
                    <th className="text-left  px-3 py-2.5 font-semibold">Status</th>
                    <th className="text-left  px-3 py-2.5 font-semibold">Última execução</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Gap</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Limite</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Encontradas</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Novas</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Erros</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {saude.tipos.map((t) => {
                    // C5: fallback se status vier fora do enum (BFF verbatim).
                    const meta = STATUS_META[t.status] ?? STATUS_META.DESCONHECIDO;
                    return (
                      <tr key={t.tipo} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-700">{t.tipo}</td>
                        <td className="px-3 py-2.5">
                          <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold", meta.pill)}>
                            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{formatTimestamp(t.ultimaExecucao)}</td>
                        <td className={cn(
                          "px-3 py-2.5 text-right tabular-nums whitespace-nowrap",
                          t.status === "CRITICO" ? "text-red-600 font-semibold" : "text-gray-600",
                        )}>
                          {formatHoras(t.horasDesde)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-400 whitespace-nowrap">
                          {t.limiteHoras != null ? `${t.limiteHoras}h` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">{t.totalEncontradas}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">{t.novas}</td>
                        <td className={cn(
                          "px-3 py-2.5 text-right tabular-nums",
                          t.erros > 0 ? "text-red-600 font-semibold" : "text-gray-400",
                        )}>
                          {t.erros}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
