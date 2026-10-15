"use client";

/**
 * GapHabilitacaoPanel — semáforo + lista materializada do Gap de Habilitação
 * Inteligente (edital × cofre × CRC).
 *
 * GET  /api/licitacoes/[id]/gap-habilitacao  → lê o gap já materializado (null se
 *      nunca calculado → mostra CTA "Calcular gap").
 * POST /api/licitacoes/[id]/gap-habilitacao  → recalcula (Claude só nos requisitos
 *      ambíguos). Apenas quem pode propor (podeRecalcular) dispara o POST.
 *
 * Diferente do Go/No-Go (veredito read-only), aqui o resultado é PERSISTIDO em
 * gap_habilitacao, com método de match (CÓDIGO/IA) e confiança por requisito.
 */

import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, CheckCircle2, AlertTriangle, XCircle, CircleDashed, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Semaforo = "VERDE" | "AMARELO" | "VERMELHO" | "SEM_DADOS";
type StatusCobertura = "ATENDIDO" | "PARCIAL" | "FALTANTE" | "VENCE_ANTES_DA_DATA";
type MetodoMatch = "CODIGO" | "IA";

interface GapItem {
  requisitoId: string | null;
  requisitoCodigo: string | null;
  descricao: string;
  statusCobertura: StatusCobertura;
  documentoId: string | null;
  documentoTitulo: string | null;
  venceEm: string | null;
  metodoMatch: MetodoMatch | null;
  confianca: number | null;
  justificativa: string | null;
}

interface GapResult {
  licitacaoId: string;
  numero: string;
  semaforo: Semaforo;
  totais: {
    total: number;
    atendidos: number;
    parciais: number;
    faltantes: number;
    venceAntesDaData: number;
  };
  itens: GapItem[];
  familiasHabilitadas: {
    codigoCrc: string;
    nome: string;
    itensCobertos: number;
  }[];
  calculadoEm: string;
}

const SEMAFORO_CONFIG: Record<Semaforo, { label: string; icon: typeof CheckCircle2; dot: string; chip: string }> = {
  VERDE: { label: "Habilitação coberta", icon: CheckCircle2, dot: "bg-green-500", chip: "bg-green-50 text-green-700 border-green-200" },
  AMARELO: { label: "Cobertura parcial / vencendo", icon: AlertTriangle, dot: "bg-amber-500", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  VERMELHO: { label: "Requisitos faltantes", icon: XCircle, dot: "bg-red-500", chip: "bg-red-50 text-red-700 border-red-200" },
  SEM_DADOS: { label: "Habilitação não avaliada", icon: CircleDashed, dot: "bg-gray-400", chip: "bg-gray-50 text-gray-600 border-gray-200" },
};

const STATUS_CONFIG: Record<StatusCobertura, { label: string; cls: string }> = {
  ATENDIDO: { label: "Atendido", cls: "bg-green-50 text-green-700 border-green-200" },
  PARCIAL: { label: "Parcial", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  FALTANTE: { label: "Faltante", cls: "bg-red-50 text-red-700 border-red-200" },
  VENCE_ANTES_DA_DATA: { label: "Vence antes da data", cls: "bg-orange-50 text-orange-700 border-orange-200" },
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return iso;
  }
}

interface GapHabilitacaoPanelProps {
  licitacaoId: string;
  podeRecalcular: boolean;
}

export function GapHabilitacaoPanel({ licitacaoId, podeRecalcular }: GapHabilitacaoPanelProps) {
  const [data, setData] = useState<GapResult | null>(null);
  const [carregado, setCarregado] = useState(false);
  const [loading, setLoading] = useState(false);
  const [recalculando, setRecalculando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/licitacoes/${licitacaoId}/gap-habilitacao`);
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(typeof json.error === "string" ? json.error : json.error?.message || "Erro ao carregar gap");
      }
      setData((json.data as GapResult | null) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setLoading(false);
      setCarregado(true);
    }
  }, [licitacaoId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function recalcular() {
    setRecalculando(true);
    setError(null);
    try {
      const res = await fetch(`/api/licitacoes/${licitacaoId}/gap-habilitacao`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usarIA: true }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(typeof json.error === "string" ? json.error : json.error?.message || "Erro ao recalcular gap");
      }
      setData(json.data as GapResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setRecalculando(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-brand-black flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-brand-orange" /> Gap de Habilitação
        </h2>
        {podeRecalcular && data && (
          <button
            onClick={recalcular}
            disabled={recalculando}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {recalculando ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Recalcular
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={carregar} className="ml-2 underline">
            Tentar novamente
          </button>
        </div>
      )}

      {loading && !carregado && (
        <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando gap de habilitação...
        </div>
      )}

      {/* Nunca calculado */}
      {carregado && !data && !error && (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500 mb-4">
            Cruze os requisitos do edital contra o cofre e as famílias CRC para mapear os gaps de habilitação.
          </p>
          {podeRecalcular ? (
            <button
              onClick={recalcular}
              disabled={recalculando}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-brand-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {recalculando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {recalculando ? "Calculando..." : "Calcular gap"}
            </button>
          ) : (
            <p className="text-xs text-gray-400">Gap ainda não calculado para esta licitação.</p>
          )}
        </div>
      )}

      {data && <GapBody data={data} />}
    </div>
  );
}

function GapBody({ data }: { data: GapResult }) {
  // C5: fallback se semaforo vier fora do enum (BFF devolve verbatim).
  const cfg = SEMAFORO_CONFIG[data.semaforo] ?? SEMAFORO_CONFIG.SEM_DADOS;
  const Icon = cfg.icon;
  const { totais } = data;

  return (
    <div className="space-y-4">
      <div className={cn("flex items-center gap-3 p-4 rounded-lg border", cfg.chip)}>
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white", cfg.dot)}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold">{cfg.label}</p>
          <p className="text-xs mt-0.5">
            {data.semaforo === "SEM_DADOS"
              ? "Nenhum requisito de habilitação mapeado — rode a análise IA do edital."
              : `${totais.atendidos} atendidos · ${totais.parciais} parciais · ${totais.venceAntesDaData} vencendo · ${totais.faltantes} faltantes (de ${totais.total})`}
          </p>
        </div>
      </div>

      {/* Famílias CRC em que nos habilitamos */}
      <div>
        <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">
          Famílias CRC em que nos habilitamos
          {data.familiasHabilitadas.length > 0 ? ` (${data.familiasHabilitadas.length})` : ""}
        </h3>
        {data.familiasHabilitadas.length > 0 ? (
          <div className="space-y-1.5">
            {data.familiasHabilitadas.map((f) => (
              <div
                key={f.codigoCrc}
                className="flex items-center justify-between py-1.5 px-3 bg-green-50 border border-green-100 rounded text-sm"
              >
                <span className="min-w-0 truncate text-gray-700">
                  <span className="font-mono text-xs text-gray-500">{f.codigoCrc}</span> {f.nome}
                </span>
                <span className="shrink-0 text-xs text-green-700">
                  {f.itensCobertos} {f.itensCobertos === 1 ? "item" : "itens"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            Nenhuma família CRC sua cobre os itens desta licitação.
          </p>
        )}
      </div>

      {data.itens.length === 0 ? (
        <p className="text-sm text-gray-500 py-2">
          Nenhum requisito de habilitação mapeado. Rode a análise IA do edital para extrair os requisitos.
        </p>
      ) : (
        <div className="space-y-1.5">
          {data.itens.map((it, i) => {
            // C5: fallback se statusCobertura vier fora do enum (BFF verbatim).
            const sc = STATUS_CONFIG[it.statusCobertura] ?? { label: it.statusCobertura ?? "—", cls: "bg-gray-50 text-gray-600 border-gray-200" };
            return (
              <div key={it.requisitoId ?? `gap-${i}`} className="flex items-start justify-between gap-3 py-2 px-3 bg-gray-50 rounded">
                <div className="min-w-0">
                  <p className="text-sm text-gray-700">{it.descricao || it.requisitoCodigo || "Requisito"}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    {it.requisitoCodigo && (
                      <span className="font-mono text-[10px] text-gray-400">{it.requisitoCodigo}</span>
                    )}
                    {it.metodoMatch && (
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded text-[10px] font-medium border",
                          it.metodoMatch === "IA"
                            ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                            : "bg-gray-100 text-gray-600 border-gray-200",
                        )}
                        title={it.justificativa ?? undefined}
                      >
                        {it.metodoMatch === "IA" ? "match IA" : "match código"}
                        {it.metodoMatch === "IA" && typeof it.confianca === "number"
                          ? ` ${Math.round(it.confianca * 100)}%`
                          : ""}
                      </span>
                    )}
                    {it.documentoTitulo && (
                      <span className="text-[10px] text-gray-400">
                        {it.documentoTitulo}
                        {it.venceEm ? ` · validade ${formatDate(it.venceEm)}` : ""}
                      </span>
                    )}
                  </div>
                </div>
                <span className={cn("shrink-0 px-2 py-0.5 rounded text-xs font-medium border", sc.cls)}>
                  {sc.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-400 pt-2 border-t border-gray-100">
        Calculado em {formatDateTime(data.calculadoEm)}.
      </p>
    </div>
  );
}
