"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to error tracking service if available
    console.error("[Petro Radar] Erro não tratado:", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        {/* Icon */}
        <div className="flex items-center justify-center w-16 h-16 mx-auto mb-6 rounded-2xl bg-red-50 border border-red-200">
          <AlertTriangle className="h-8 w-8 text-red-500" />
        </div>

        {/* Title */}
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          Algo deu errado
        </h1>
        <p className="text-sm text-gray-500 mb-6 leading-relaxed">
          Ocorreu um erro inesperado ao carregar esta página. Nossa equipe foi
          notificada. Tente novamente ou volte ao painel.
        </p>

        {/* Error detail (dev only) */}
        {process.env.NODE_ENV === "development" && error.message && (
          <div className="mb-6 p-3 bg-gray-50 border border-gray-200 rounded-lg text-left">
            <p className="text-xs font-mono text-red-600 break-all">
              {error.message}
            </p>
            {error.digest && (
              <p className="text-[10px] text-gray-400 mt-1">
                digest: {error.digest}
              </p>
            )}
          </div>
        )}

        {/* Actions */}
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
            <Home className="h-4 w-4" />
            Ir ao Painel
          </Link>
        </div>
      </div>
    </div>
  );
}
