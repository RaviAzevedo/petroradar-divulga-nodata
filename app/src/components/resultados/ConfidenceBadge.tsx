import { ShieldCheck, Trophy, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type ConfidenceLevel = "OFFICIAL" | "RANKED" | "PENDING" | null;

interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  statusResultado?: string | null;
  className?: string;
  compact?: boolean;
}

/**
 * Badge visual indicando o nível de confiança do vencedor de uma licitação:
 *
 *   OFFICIAL (verde)  — Homologada/Adjudicada explícita pela Petrobras
 *   RANKED   (amarelo)— Classificação oficial agregada do portal
 *   PENDING  (cinza)  — Licitação em curso, sem vencedor definido
 *   null     (cinza claro) — Dado legado, não migrado para v2
 */
export function ConfidenceBadge({ level, statusResultado, className, compact }: ConfidenceBadgeProps) {
  const cfg = configByLevel(level);
  const Icon = cfg.icon;

  if (compact) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center w-2 h-2 rounded-full",
          cfg.dotClassName,
          className,
        )}
        title={statusResultado || cfg.tooltip}
        aria-label={cfg.tooltip}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold",
        cfg.badgeClassName,
        className,
      )}
      title={statusResultado || cfg.tooltip}
    >
      <Icon className="h-2.5 w-2.5" />
      {cfg.label}
    </span>
  );
}

function configByLevel(level: ConfidenceLevel) {
  switch (level) {
    case "OFFICIAL":
      return {
        icon: ShieldCheck,
        label: "Oficial",
        tooltip: "Vencedor confirmado pela Petrobras (Homologada/Adjudicada)",
        badgeClassName: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70",
        dotClassName: "bg-emerald-500",
      };
    case "RANKED":
      return {
        icon: Trophy,
        label: "Classificado",
        tooltip: "1º colocado oficial do portal (ranking agregado)",
        badgeClassName: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/70",
        dotClassName: "bg-amber-500",
      };
    case "PENDING":
      return {
        icon: Clock,
        label: "Em curso",
        tooltip: "Licitação em análise — sem vencedor definido",
        badgeClassName: "bg-slate-100 text-slate-600 ring-1 ring-slate-200/70",
        dotClassName: "bg-slate-400",
      };
    default:
      return {
        icon: AlertCircle,
        label: "Legado",
        tooltip: "Dado antigo (pré-migração V2) — confiança desconhecida",
        badgeClassName: "bg-slate-50 text-slate-400 ring-1 ring-slate-100",
        dotClassName: "bg-slate-300",
      };
  }
}
