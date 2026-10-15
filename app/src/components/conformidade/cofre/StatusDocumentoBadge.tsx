import { cn, diasRestantes } from "@/lib/utils";

export type StatusDocHab = "VIGENTE" | "EM_RENOVACAO" | "VENCIDO" | "SUBSTITUIDO";

interface StatusDocumentoBadgeProps {
  status: StatusDocHab;
  validadeFim?: string | Date | null;
  size?: "sm" | "md";
  showDot?: boolean;
}

const STATUS_CONFIG: Record<
  StatusDocHab,
  { label: string; bg: string; text: string; border: string; dot: string }
> = {
  VIGENTE: {
    label:  "Vigente",
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
  VENCIDO: {
    label:  "Vencido",
    bg:     "bg-red-50",
    text:   "text-red-700",
    border: "border-red-200",
    dot:    "bg-red-500",
  },
  SUBSTITUIDO: {
    label:  "Substituído",
    bg:     "bg-gray-100",
    text:   "text-gray-500",
    border: "border-gray-200",
    dot:    "bg-gray-400",
  },
};

export function StatusDocumentoBadge({
  status,
  validadeFim,
  size = "md",
  showDot = true,
}: StatusDocumentoBadgeProps) {
  // Atualiza o status visual com base na data efetiva, mesmo que o banco esteja desatualizado
  let statusEfetivo: StatusDocHab = status;
  if (validadeFim && status === "VIGENTE") {
    const dias = diasRestantes(typeof validadeFim === "string" ? validadeFim : validadeFim.toISOString());
    if (dias !== null) {
      if (dias < 0) statusEfetivo = "VENCIDO";
      else if (dias <= 30) statusEfetivo = "EM_RENOVACAO";
    }
  }

  // C5: fallback se status vier fora do enum (BFF devolve o valor do banco verbatim).
  const cfg = STATUS_CONFIG[statusEfetivo] ?? { label: statusEfetivo ?? "—", bg: "bg-gray-100", text: "text-gray-500", border: "border-gray-200", dot: "bg-gray-400" };

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
