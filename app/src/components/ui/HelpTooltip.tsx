"use client";

import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  texto:    string;
  size?:    "xs" | "sm";
  className?: string;
}

/**
 * Ícone de ajuda inline (?) que abre tooltip ao hover (desktop) ou ao tocar (mobile).
 * Use ao lado de métricas/labels quando o significado não for óbvio.
 */
export function HelpTooltip({ texto, size = "xs", className }: Props) {
  const [aberto, setAberto] = useState(false);

  const iconSize = size === "xs" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <span
      className={cn("relative inline-flex items-center align-middle", className)}
      onMouseEnter={() => setAberto(true)}
      onMouseLeave={() => setAberto(false)}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setAberto((v) => !v); }}
        className="text-gray-300 hover:text-gray-500 cursor-help"
        aria-label="Ajuda"
      >
        <HelpCircle className={iconSize} />
      </button>
      {aberto && (
        <span
          className="absolute z-50 left-1/2 -translate-x-1/2 bottom-full mb-1 px-2 py-1.5 bg-gray-900 text-white text-[10px] leading-relaxed rounded-md shadow-lg whitespace-normal w-56 text-left"
          role="tooltip"
        >
          {texto}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
        </span>
      )}
    </span>
  );
}
