import { cn } from "@/lib/utils";

export type StatusFamilia =
  | "ATIVA"
  | "EM_RENOVACAO"
  | "SUSPENSA"
  | "VENCIDA"
  | "REJEITADA";

interface StatusFamiliaBadgeProps {
  status: StatusFamilia;
  size?: "sm" | "md";
  showDot?: boolean;
}

const STATUS_CONFIG: Record<
  StatusFamilia,
  { label: string; bg: string; text: string; border: string; dot: string }
> = {
  ATIVA: {
    label:  "Ativa",
    bg:     "bg-green-50",
    text:   "text-green-700",
    border: "border-green-200",
    dot:    "bg-green-500",
  },
  EM_RENOVACAO: {
    label:  "Em renovação",
    bg:     "bg-amber-50",
    text:   "text-amber-700",
    border: "border-amber-200",
    dot:    "bg-amber-500",
  },
  SUSPENSA: {
    label:  "Suspensa",
    bg:     "bg-orange-50",
    text:   "text-orange-700",
    border: "border-orange-200",
    dot:    "bg-orange-500",
  },
  VENCIDA: {
    label:  "Vencida",
    bg:     "bg-red-50",
    text:   "text-red-700",
    border: "border-red-200",
    dot:    "bg-red-500",
  },
  REJEITADA: {
    label:  "Rejeitada",
    bg:     "bg-gray-100",
    text:   "text-gray-600",
    border: "border-gray-300",
    dot:    "bg-gray-400",
  },
};

export function StatusFamiliaBadge({
  status,
  size = "md",
  showDot = true,
}: StatusFamiliaBadgeProps) {
  // C5: fallback se status vier fora do enum (BFF devolve o valor do banco verbatim).
  const cfg = STATUS_CONFIG[status] ?? { label: status ?? "—", bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-300", dot: "bg-gray-400" };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap",
        cfg.bg,
        cfg.text,
        cfg.border,
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      )}
    >
      {showDot && <span className={cn("w-1.5 h-1.5 rounded-full", cfg.dot)} />}
      {cfg.label}
    </span>
  );
}

function getStatusFamiliaConfig(status: StatusFamilia) {
  return STATUS_CONFIG[status];
}
