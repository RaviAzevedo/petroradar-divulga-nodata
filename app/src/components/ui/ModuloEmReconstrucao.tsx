import { Wrench } from "lucide-react";

interface ModuloEmReconstrucaoProps {
  modulo: string;
  descricao?: string;
}

export function ModuloEmReconstrucao({ modulo, descricao }: ModuloEmReconstrucaoProps) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-orange-50 flex items-center justify-center mb-6">
          <Wrench className="h-8 w-8 text-brand-orange" />
        </div>
        <h1 className="text-2xl font-bold text-brand-black mb-2">
          {modulo} em reconstrução
        </h1>
        <p className="text-sm text-gray-500 leading-relaxed">
          {descricao ??
            "Este módulo está sendo refeito. A lógica e a interface serão atualizadas em breve."}
        </p>
        <div className="mt-8 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-100 text-xs text-gray-500">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse" />
          Indisponível temporariamente
        </div>
      </div>
    </div>
  );
}
