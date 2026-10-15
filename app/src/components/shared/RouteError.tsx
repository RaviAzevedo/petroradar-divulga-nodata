"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, ArrowLeft } from "lucide-react";

/**
 * UI compartilhado pros error.tsx das rotas. Cada rota pode passar um título
 * específico — o resto do layout e mensagem padrão é igual.
 *
 * Uso:
 *   "use client";
 *   import { RouteError } from "@/components/shared/RouteError";
 *   export default function E(p) { return <RouteError title="Erro em X" {...p} />; }
 */
export function RouteError({
  title,
  error,
  reset,
}: {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logger client-side: console.error é capturado pelo Vercel client logs.
    console.error(`[Petro Radar] ${title}:`, error);
  }, [title, error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="flex items-center justify-center w-16 h-16 mx-auto mb-6 rounded-2xl bg-red-50 border border-red-200">
          <AlertTriangle className="h-8 w-8 text-red-500" />
        </div>

        <h1 className="text-xl font-bold text-gray-900 mb-2">{title}</h1>
        <p className="text-sm text-gray-500 mb-6 leading-relaxed">
          Não foi possível carregar esta página. Verifique sua conexão e tente novamente.
        </p>

        {error.message && (
          <div className="mb-6 p-3 bg-gray-50 border border-gray-200 rounded-lg text-left">
            <p className="text-xs font-mono text-red-600 break-all">{error.message}</p>
            {error.digest && (
              <p className="text-[10px] text-gray-400 mt-1">digest: {error.digest}</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="flex items-center gap-2 px-4 py-2.5 bg-brand-black text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Tentar novamente
          </button>
          <Link
            href="/"
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Link>
        </div>
      </div>
    </div>
  );
}
