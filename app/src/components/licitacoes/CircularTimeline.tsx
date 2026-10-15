"use client";

import { useState } from "react";
import {
  FileText,
  MessageSquare,
  AlertCircle,
  Info,
  ChevronDown,
  ChevronUp,
  Download,
  Zap,
  Calendar,
  Wrench,
  ShieldAlert,
  DollarSign,
  CircleSlash,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TipoCircular = "MENSAGEM" | "ADENDO" | "COMUNICADO" | "ESCLARECIMENTO" | "OUTRO";

// Classificação rápida de impacto via Haiku (circulares.impacto_ia). A avaliação
// detalhada (resumo + ação recomendada + reorçamento) vive em circulares_impacto.
type ImpactoCircular = "NENHUM" | "PRAZO" | "ESCOPO" | "HABILITACAO" | "VALOR";

interface CircularItem {
  id: string;
  tipo: TipoCircular;
  autor: string | null;
  mensagem: string | null;
  dataPublicacao: string | null;
  anexoPhioObjid: string | null;
  anexoDescricao: string | null;
  criadoEm: string | null;
  // ── Avaliação de impacto IA (opcionais — preenchidos quando o feed já trouxe
  //    a classificação de circulares-watch; mantém compatibilidade com a página).
  impactoIa?: ImpactoCircular | null;
  impactoResumo?: string | null;
  impactoAcaoRecomendada?: string | null;
  reorcamentoSugerido?: boolean | null;
}

// Config visual por nível de impacto (badge + ícone + banner de ação).
const IMPACTO_CONFIG: Record<
  Exclude<ImpactoCircular, "NENHUM">,
  { icon: typeof Zap; label: string; chip: string; banner: string }
> = {
  PRAZO:       { icon: Calendar,    label: "Impacto: Prazo",       chip: "bg-blue-50 text-blue-700 border-blue-200",       banner: "bg-blue-50 border-blue-200 text-blue-800" },
  ESCOPO:      { icon: Wrench,      label: "Impacto: Escopo",      chip: "bg-purple-50 text-purple-700 border-purple-200", banner: "bg-purple-50 border-purple-200 text-purple-800" },
  HABILITACAO: { icon: ShieldAlert, label: "Impacto: Habilitação", chip: "bg-red-50 text-red-700 border-red-200",          banner: "bg-red-50 border-red-200 text-red-800" },
  VALOR:       { icon: DollarSign,  label: "Impacto: Valor",       chip: "bg-amber-50 text-amber-700 border-amber-200",    banner: "bg-amber-50 border-amber-200 text-amber-800" },
};

const IMPACTO_NENHUM = { icon: CircleSlash, label: "Sem impacto", chip: "bg-gray-50 text-gray-500 border-gray-200" };

const TIPO_CONFIG: Record<TipoCircular, { icon: typeof FileText; label: string; color: string }> = {
  ADENDO:          { icon: FileText,       label: "Adendo",          color: "text-amber-600 bg-amber-50 border-amber-200" },
  COMUNICADO:      { icon: Info,           label: "Comunicado",      color: "text-blue-600 bg-blue-50 border-blue-200" },
  ESCLARECIMENTO:  { icon: AlertCircle,    label: "Esclarecimento",  color: "text-purple-600 bg-purple-50 border-purple-200" },
  MENSAGEM:        { icon: MessageSquare,  label: "Mensagem",        color: "text-gray-600 bg-gray-50 border-gray-200" },
  OUTRO:           { icon: FileText,       label: "Outro",           color: "text-gray-500 bg-gray-50 border-gray-200" },
};

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function CircularCard({ item }: { item: CircularItem }) {
  const [expanded, setExpanded] = useState(false);
  const config = TIPO_CONFIG[item.tipo] || TIPO_CONFIG.OUTRO;
  const Icon = config.icon;
  const mensagem = item.mensagem || "";
  const isLong = mensagem.length > 200;

  // Avaliação de impacto IA (quando disponível). NENHUM/null não renderiza banner.
  const impacto = item.impactoIa ?? null;
  const impactoCfg = impacto && impacto !== "NENHUM" ? IMPACTO_CONFIG[impacto] : null;
  const ImpactoIcon = impactoCfg?.icon ?? IMPACTO_NENHUM.icon;
  const temAvaliacaoDetalhada = !!(item.impactoResumo || item.impactoAcaoRecomendada || item.reorcamentoSugerido);

  return (
    <div className="relative flex gap-3">
      {/* Timeline dot */}
      <div className="flex flex-col items-center">
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", config.color)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="w-px flex-1 bg-gray-200" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-4">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className={cn("px-2 py-0.5 rounded text-[10px] font-semibold uppercase border", config.color)}>
            {config.label}
          </span>
          {impactoCfg && (
            <span
              className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase border", impactoCfg.chip)}
              title="Classificação de impacto por IA"
            >
              <ImpactoIcon className="h-3 w-3" /> {impactoCfg.label}
            </span>
          )}
          {item.reorcamentoSugerido && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase border border-amber-300 bg-amber-100 text-amber-800">
              <Zap className="h-3 w-3" /> Reorçar
            </span>
          )}
          {item.autor && (
            <span className="text-xs text-gray-500">{item.autor}</span>
          )}
          <span className="text-xs text-gray-400 ml-auto">
            {formatDateTime(item.dataPublicacao)}
          </span>
        </div>

        <div className={cn("text-sm text-gray-700 mt-1", !expanded && isLong && "line-clamp-3")}>
          {mensagem}
        </div>

        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-brand-orange hover:underline mt-1"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "Recolher" : "Ver tudo"}
          </button>
        )}

        {/* Banner de avaliação de impacto (resumo + ação recomendada) */}
        {impactoCfg && temAvaliacaoDetalhada && (
          <div className={cn("mt-2 rounded-lg border px-3 py-2", impactoCfg.banner)}>
            {item.impactoResumo && (
              <p className="text-xs leading-relaxed">{item.impactoResumo}</p>
            )}
            {item.impactoAcaoRecomendada && (
              <p className="mt-1 text-xs font-medium">
                Ação recomendada: {item.impactoAcaoRecomendada}
              </p>
            )}
          </div>
        )}

        {item.anexoPhioObjid && (
          <a
            href={`/api/download?phio=${encodeURIComponent(item.anexoPhioObjid)}&filename=${encodeURIComponent(item.anexoDescricao || "documento")}`}
            className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 text-xs font-medium bg-gray-50 text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <Download className="h-3 w-3" />
            {item.anexoDescricao || "Baixar documento"}
          </a>
        )}
      </div>
    </div>
  );
}

interface CircularTimelineProps {
  licitacaoId: string;
  initialData?: CircularItem[];
  initialTotal?: number;
}

export function CircularTimeline({ licitacaoId, initialData, initialTotal }: CircularTimelineProps) {
  const [data, setData] = useState<CircularItem[] | null>(initialData ?? null);
  const [total, setTotal] = useState(initialTotal ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<TipoCircular | "ALL">("ALL");

  const loadData = async () => {
    if (data !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/licitacoes/${licitacaoId}/circulares`);
      if (!res.ok) throw new Error("Erro ao carregar circulares");
      const json = await res.json();
      setData(json.data);
      setTotal(json.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  };

  const filtered = data
    ? filterType === "ALL"
      ? data
      : data.filter((c) => c.tipo === filterType)
    : [];

  const typeCounts = data?.reduce<Record<string, number>>((acc, c) => {
    acc[c.tipo] = (acc[c.tipo] || 0) + 1;
    return acc;
  }, {}) ?? {};

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-brand-black">
          Circulares
          {total > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-brand-orange/10 text-brand-orange rounded-full">
              {total}
            </span>
          )}
        </h2>

        {data === null && total === 0 && !loading && (
          <button
            onClick={loadData}
            className="text-xs text-brand-orange hover:underline"
          >
            Carregar circulares
          </button>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-orange" />
          Carregando circulares...
        </div>
      )}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3 mb-4">
          {error}
          <button onClick={() => { setData(null); loadData(); }} className="ml-2 underline">
            Tentar novamente
          </button>
        </div>
      )}

      {data !== null && data.length === 0 && (
        <p className="text-sm text-gray-500 py-2">Nenhuma circular registrada para esta licitação</p>
      )}

      {data !== null && data.length > 0 && (
        <>
          {/* Filter pills */}
          {Object.keys(typeCounts).length > 1 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              <button
                onClick={() => setFilterType("ALL")}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-full border transition-colors",
                  filterType === "ALL"
                    ? "bg-brand-orange text-black border-brand-orange"
                    : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                )}
              >
                Todas ({data.length})
              </button>
              {(Object.entries(typeCounts) as [TipoCircular, number][]).map(([tipo, count]) => {
                const cfg = TIPO_CONFIG[tipo] || TIPO_CONFIG.OUTRO;
                return (
                  <button
                    key={tipo}
                    onClick={() => setFilterType(tipo)}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-full border transition-colors",
                      filterType === tipo
                        ? "bg-brand-orange text-black border-brand-orange"
                        : `${cfg.color} hover:opacity-80`
                    )}
                  >
                    {cfg.label} ({count})
                  </button>
                );
              })}
            </div>
          )}

          {/* Timeline */}
          <div className="space-y-0">
            {filtered.map((item) => (
              <CircularCard key={item.id} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
