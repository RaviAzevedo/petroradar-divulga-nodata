"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body className="bg-gray-50">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center max-w-md px-4">
            <h2 className="text-lg font-semibold text-gray-800 mb-2">Erro crítico</h2>
            <p className="text-sm text-gray-500 mb-6">
              Ocorreu um erro inesperado na aplicação. Tente recarregar.
            </p>
            <button
              onClick={reset}
              className="px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
