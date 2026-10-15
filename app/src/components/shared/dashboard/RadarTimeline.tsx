import Link from "next/link";
import { cn, relevanciaColor, diasRestantes } from "@/lib/utils";
import { Clock, ArrowRight, Zap, Radar } from "lucide-react";

interface OportunidadeItem {
  id: string;
  numero: string;
  objeto: string | null;
  empresa: string | null;
  relevancia: string | null;
  dataFim: string | null;
  horaFim?: string | null;
  isNova?: boolean;
}

interface RadarTimelineProps {
  urgentes: OportunidadeItem[];
  novas: OportunidadeItem[];
}

function groupByUrgency(items: OportunidadeItem[]): Record<string, OportunidadeItem[]> {
  const groups: Record<string, OportunidadeItem[]> = { "Hoje": [], "Amanhã": [], "Esta semana": [] };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const item of items) {
    if (!item.dataFim) continue;
    const fim = new Date(item.dataFim);
    const diffDays = Math.floor((fim.getTime() - today.getTime()) / 86400000);
    if (diffDays <= 0) groups["Hoje"].push(item);
    else if (diffDays === 1) groups["Amanhã"].push(item);
    else groups["Esta semana"].push(item);
  }
  return groups;
}

const GROUP_STYLES: Record<string, { dot: string; text: string; line: string }> = {
  "Hoje":         { dot: "bg-red-500",   text: "text-red-600",   line: "border-red-200" },
  "Amanhã":       { dot: "bg-amber-500", text: "text-amber-600", line: "border-amber-200" },
  "Esta semana":  { dot: "bg-blue-400",  text: "text-blue-500",  line: "border-blue-200" },
};

function TimelineItem({ item }: { item: OportunidadeItem }) {
  const dias = diasRestantes(item.dataFim);
  return (
    <Link href={`/licitacoes/${item.id}`}
      className="flex items-start gap-3 py-3 px-3.5 rounded-xl hover:bg-gray-50 transition-all group border border-transparent hover:border-gray-200">
      {/* Countdown badge */}
      <div className={cn(
        "flex-shrink-0 w-10 h-10 rounded-xl flex flex-col items-center justify-center",
        dias !== null && dias <= 1 ? "bg-red-100 text-red-700"
          : dias !== null && dias <= 3 ? "bg-amber-100 text-amber-700"
          : "bg-gray-100 text-gray-500"
      )}>
        <span className="text-sm font-extrabold leading-none">{dias ?? "—"}</span>
        <span className="text-[8px] font-bold uppercase leading-none mt-0.5">dias</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[13px] font-bold text-brand-orange">{item.numero}</span>
          <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold border", relevanciaColor(item.relevancia))}>
            {item.relevancia}
          </span>
          {item.isNova && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-50 text-green-700 border border-green-200 flex items-center gap-0.5">
              <Zap className="h-2.5 w-2.5" /> NOVA
            </span>
          )}
        </div>
        <p className="text-[13px] text-gray-600 truncate mt-0.5 group-hover:text-gray-900 transition-colors">{item.objeto || "-"}</p>
        <p className="text-[11px] text-gray-400 mt-0.5">{item.empresa}</p>
      </div>
    </Link>
  );
}

export function RadarTimeline({ urgentes, novas }: RadarTimelineProps) {
  const groups = groupByUrgency(urgentes);
  const novasMarked = novas.map(n => ({ ...n, isNova: true }));
  const hasContent = urgentes.length > 0 || novas.length > 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-transparent">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-orange/10 flex items-center justify-center">
            <Radar className="h-4 w-4 text-brand-orange" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">Radar de Oportunidades</h2>
            <p className="text-[11px] text-gray-400">Licitações que precisam de atenção</p>
          </div>
        </div>
        <Link href="/explorar?prazo=7d" className="text-xs font-medium text-brand-orange hover:underline flex items-center gap-1">
          Ver todas <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2" style={{ maxHeight: "440px" }}>
        {!hasContent && (
          <div className="py-12 text-center">
            <Clock className="h-8 w-8 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">Nenhuma oportunidade urgente</p>
            <p className="text-xs text-gray-300 mt-1">Licitações com prazo próximo aparecerão aqui</p>
          </div>
        )}

        {Object.entries(groups).map(([label, items]) => items.length > 0 && (
          <div key={label}>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className={cn("w-2 h-2 rounded-full", GROUP_STYLES[label]?.dot ?? "bg-gray-300")} />
              <span className={cn("text-[10px] font-bold uppercase tracking-wider", GROUP_STYLES[label]?.text ?? "text-gray-400")}>
                {label}
              </span>
              <span className="text-[10px] text-gray-300">({items.length})</span>
            </div>
            <div className="space-y-1">
              {items.map(item => <TimelineItem key={item.id} item={item} />)}
            </div>
          </div>
        ))}

        {novasMarked.length > 0 && (
          <div>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-green-600 flex items-center gap-1">
                Novas (24h)
              </span>
              <span className="text-[10px] text-gray-300">({novasMarked.length})</span>
            </div>
            <div className="space-y-1">
              {novasMarked.slice(0, 5).map(item => <TimelineItem key={item.id} item={item} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
