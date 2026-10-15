import Link from "next/link";
import { cn } from "@/lib/utils";
import { ArrowRight, CheckCircle, XCircle, Trophy } from "lucide-react";
import { config } from "@/lib/config";

interface ResultadoRecente {
  numero: string;
  licitacaoId: string | null;
  ganhou: boolean;
  fornecedor: string | null;
}

interface PerformancePanelProps {
  ultimosResultados: ResultadoRecente[];
}

/**
 * Últimos resultados publicados no portal (resultados_licitacao com vencedor).
 * Até 2026-09 o painel também mostrava o pipeline de participações (fases,
 * ativas, ganhos, taxa de sucesso); o módulo saiu na limpeza geral.
 */
export function PerformancePanel({ ultimosResultados }: PerformancePanelProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-transparent">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-orange/10 flex items-center justify-center">
            <Trophy className="h-4 w-4 text-brand-orange" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">Resultados</h2>
            <p className="text-[11px] text-gray-400">Últimos vencedores publicados no portal</p>
          </div>
        </div>
        {config.features.resultados && (
          <Link href="/resultados" className="text-xs font-medium text-brand-orange hover:underline flex items-center gap-1">
            Ver todos <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>

      <div className="flex-1 px-5 py-4">
        {ultimosResultados.length > 0 ? (
          <div className="space-y-1">
            {ultimosResultados.map((r, i) => (
              <Link key={i} href={r.licitacaoId ? `/licitacoes/${r.licitacaoId}` : (config.features.resultados ? "/resultados" : "/explorar")}
                className="flex items-center gap-3 py-2 px-3 rounded-xl hover:bg-gray-50 transition-all border border-transparent hover:border-gray-200 group">
                <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0",
                  r.ganhou ? "bg-green-100" : "bg-red-50")}>
                  {r.ganhou ? <CheckCircle className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-red-400" />}
                </div>
                <span className="font-mono text-xs font-bold text-gray-700 group-hover:text-gray-900">{r.numero}</span>
                <span className={cn("text-[10px] font-bold uppercase tracking-wide ml-auto",
                  r.ganhou ? "text-green-600" : "text-red-400")}>
                  {r.ganhou ? "Ganhou" : "Perdeu"}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Trophy className="h-10 w-10 text-gray-200 mb-3" />
            <p className="text-sm text-gray-400 font-medium">Nenhum resultado publicado ainda</p>
          </div>
        )}
      </div>
    </div>
  );
}
