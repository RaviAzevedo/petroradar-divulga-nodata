"use client";

/**
 * GoNoGoPanel — semáforo VERDE/AMARELO/VERMELHO de habilitabilidade da licitação.
 *
 * Cruza, ANTES de orçar, três sinais (aderência de famílias CRC, cobertura dos
 * requisitos do edital pelo cofre e status das famílias CRC envolvidas) num
 * veredito rápido. Consome GET /api/licitacoes/[id]/go-no-go (read-only, não
 * persiste — a materialização do gap vive no GapHabilitacaoPanel).
 *
 * Carrega sob demanda (1 clique) para não onerar o SSR da página da licitação.
 */

import { useState } from "react";
import {
  TrafficCone,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  CircleDashed,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Semaforo = "VERDE" | "AMARELO" | "VERMELHO" | "SEM_DADOS";
type StatusReq = "ATENDIDO" | "PARCIAL" | "FALTANTE" | "VENCE_ANTES_DA_DATA";

interface RequisitoCobertura {
  requisitoId: string;
  codigo: string;
  descricao: string;
  obrigatorio: boolean;
  status: StatusReq;
  documentoId: string | null;
  documentoTitulo: string | null;
  venceEm: string | null;
}

interface GoNoGoResult {
  licitacaoId: string;
  numero: string;
  semaforo: Semaforo;
  scoreAderencia: number;
  totalItens: number;
  itensCobertos: number;
  familiasFaltantes: string[];
  familiasHabilitadas: {
    codigoCrc: string;
    nome: string;
    itensCobertos: number;
  }[];
  totalRequisitos: number;
  requisitosAtendidos: number;
  requisitosFaltantes: number;
  requisitosVencendo: number;
  requisitos: RequisitoCobertura[];
  familiasComProblema: {
    codigoCrc: string;
    nome: string;
    statusFluxoCrc: string | null;
    validadeFim: string | null;
  }[];
  dataReferencia: string | null;
  recomendacao: string;
}

const SEMAFORO_CONFIG: Record<
  Semaforo,
  { label: string; icon: typeof CheckCircle2; dot: string; chip: string; bar: string }
> = {
  VERDE: {
    label: "Habilitação coberta",
    icon: CheckCircle2,
    dot: "bg-green-500",
    chip: "bg-green-50 text-green-700 border-green-200",
    bar: "bg-green-500",
  },
  AMARELO: {
    label: "Atenção — cobertura parcial",
    icon: AlertTriangle,
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    bar: "bg-amber-500",
  },
  VERMELHO: {
    label: "Bloqueado — gaps de habilitação",
    icon: XCircle,
    dot: "bg-red-500",
    chip: "bg-red-50 text-red-700 border-red-200",
    bar: "bg-red-500",
  },
  SEM_DADOS: {
    label: "Habilitação não avaliada",
    icon: CircleDashed,
    dot: "bg-gray-400",
    chip: "bg-gray-50 text-gray-600 border-gray-200",
    bar: "bg-gray-300",
  },
};

const STATUS_REQ_CONFIG: Record<StatusReq, { label: string; cls: string }> = {
  ATENDIDO: { label: "Atendido", cls: "bg-green-50 text-green-700 border-green-200" },
  PARCIAL: { label: "Parcial", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  FALTANTE: { label: "Faltante", cls: "bg-red-50 text-red-700 border-red-200" },
  VENCE_ANTES_DA_DATA: { label: "Vence antes da data", cls: "bg-orange-50 text-orange-700 border-orange-200" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return iso;
  }
}

interface GoNoGoPanelProps {
  licitacaoId: string;
}

export function GoNoGoPanel({ licitacaoId }: GoNoGoPanelProps) {
  const [data, setData] = useState<GoNoGoResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function carregar() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/licitacoes/${licitacaoId}/go-no-go`);
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(
          typeof json.error === "string" ? json.error : json.error?.message || "Erro ao calcular Go/No-Go",
        );
      }
      setData(json.data as GoNoGoResult);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-brand-black flex items-center gap-2">
          <TrafficCone className="h-4 w-4 text-brand-orange" /> Go/No-Go
        </h2>
        {data && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {expanded ? "Recolher" : "Detalhar"}
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

      {!data && !error && (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500 mb-4">
            Avalie a habilitabilidade (aderência CRC + cobertura de requisitos do cofre) antes de orçar.
          </p>
          <button
            onClick={carregar}
            disabled={loading}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-brand-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrafficCone className="h-4 w-4" />}
            {loading ? "Calculando..." : "Calcular Go/No-Go"}
          </button>
        </div>
      )}

      {data && <GoNoGoBody data={data} expanded={expanded} />}
    </div>
  );
}

function GoNoGoBody({ data, expanded }: { data: GoNoGoResult; expanded: boolean }) {
  // C5: semaforo vem verbatim do BFF; fora do enum -> cfg undefined -> cfg.icon
  // estouraria (classe do bug g.stats.ALTA). Fallback para SEM_DADOS.
  const cfg = SEMAFORO_CONFIG[data.semaforo] ?? SEMAFORO_CONFIG.SEM_DADOS;
  const Icon = cfg.icon;

  return (
    <div className="space-y-4">
      {/* Veredito */}
      <div className={cn("flex items-start gap-3 p-4 rounded-lg border", cfg.chip)}>
        <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white", cfg.dot)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{cfg.label}</p>
          <p className="text-sm mt-0.5 leading-relaxed">{data.recomendacao}</p>
        </div>
      </div>

      {/* Métricas resumidas */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric titulo="Aderência CRC" valor={`${data.scoreAderencia}%`} />
        <Metric
          titulo="Itens cobertos"
          valor={`${data.itensCobertos}/${data.totalItens}`}
        />
        <Metric
          titulo="Requisitos OK"
          valor={`${data.requisitosAtendidos}/${data.totalRequisitos}`}
        />
        <Metric
          titulo="Vencendo / Faltam"
          valor={`${data.requisitosVencendo} / ${data.requisitosFaltantes}`}
          alerta={data.requisitosFaltantes > 0 || data.requisitosVencendo > 0}
        />
      </div>

      {/* Barra de aderência */}
      <div>
        <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", cfg.bar)}
            style={{ width: `${Math.max(0, Math.min(100, data.scoreAderencia))}%` }}
          />
        </div>
      </div>

      {expanded && (
        <>
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

          {/* Famílias com problema */}
          {data.familiasComProblema.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">
                Famílias CRC com problema ({data.familiasComProblema.length})
              </h3>
              <div className="space-y-1.5">
                {data.familiasComProblema.map((f) => (
                  <div
                    key={f.codigoCrc}
                    className="flex items-center justify-between py-1.5 px-3 bg-red-50 border border-red-100 rounded text-sm"
                  >
                    <span className="min-w-0 truncate text-gray-700">
                      <span className="font-mono text-xs text-gray-500">{f.codigoCrc}</span> {f.nome}
                    </span>
                    <span className="shrink-0 text-xs text-red-600">
                      {f.statusFluxoCrc && f.statusFluxoCrc !== "A" ? `Status ${f.statusFluxoCrc}` : null}
                      {f.validadeFim ? ` · vence ${formatDate(f.validadeFim)}` : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Famílias do edital sem match */}
          {data.familiasFaltantes.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">
                Famílias do edital sem cobertura ({data.familiasFaltantes.length})
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {data.familiasFaltantes.map((f) => (
                  <span
                    key={f}
                    className="px-2 py-0.5 text-xs rounded border bg-gray-50 text-gray-600 border-gray-200"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Requisitos do edital */}
          {data.requisitos.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">
                Requisitos de habilitação ({data.requisitos.length})
              </h3>
              <div className="space-y-1.5">
                {data.requisitos.map((r) => {
                  // C5: fallback se status vier fora do enum (BFF verbatim).
                  const sc = STATUS_REQ_CONFIG[r.status] ?? { label: r.status ?? "—", cls: "bg-gray-50 text-gray-600 border-gray-200" };
                  return (
                    <div
                      key={r.requisitoId}
                      className="flex items-start justify-between gap-3 py-1.5 px-3 bg-gray-50 rounded"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-gray-700">
                          {r.descricao}
                          {r.obrigatorio && <span className="ml-1 text-red-500">*</span>}
                        </p>
                        {r.documentoTitulo && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            {r.documentoTitulo}
                            {r.venceEm ? ` · validade ${formatDate(r.venceEm)}` : ""}
                          </p>
                        )}
                      </div>
                      <span className={cn("shrink-0 px-2 py-0.5 rounded text-xs font-medium border", sc.cls)}>
                        {sc.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {data.dataReferencia && (
            <p className="text-xs text-gray-400 pt-2 border-t border-gray-100">
              Validade testada contra a data de referência {formatDate(data.dataReferencia)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ titulo, valor, alerta }: { titulo: string; valor: string; alerta?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-[10px] font-medium uppercase text-gray-400">{titulo}</p>
      <p className={cn("text-sm font-semibold", alerta ? "text-red-600" : "text-brand-black")}>{valor}</p>
    </div>
  );
}
