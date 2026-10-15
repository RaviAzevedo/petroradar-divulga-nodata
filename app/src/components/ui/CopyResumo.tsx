"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CopyResumoProps {
  edital: string;
  empresa: string;
  prazo: string;
  fase: string;
  url: string;
}

export function CopyResumo({ edital, empresa, prazo, fase, url }: CopyResumoProps) {
  const [feedback, setFeedback] = useState<"idle" | "copied" | "error">("idle");

  async function copiar() {
    const texto = [
      `Edital: ${edital}`,
      `Empresa: ${empresa}`,
      `Prazo: ${prazo}`,
      `Fase: ${fase}`,
      `Link: ${url}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(texto);
      setFeedback("copied");
      setTimeout(() => setFeedback("idle"), 2000);
    } catch {
      setFeedback("error");
      setTimeout(() => setFeedback("idle"), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={copiar}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
    >
      {feedback === "copied" ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-500" />
          <span className="text-green-600">Copiado!</span>
        </>
      ) : feedback === "error" ? (
        <span className="text-red-600">Erro ao copiar</span>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          Copiar resumo
        </>
      )}
    </button>
  );
}
