"use client";

/**
 * Escolha de família CRC para vínculo — usado pelo chip da linha (1 documento)
 * e pela barra de seleção em massa das seções 2/3 (03-FRONTEND §5.7).
 *
 * Quem faz o POST é o CHAMADOR (a ficha): este modal só busca famílias ativas
 * e devolve a escolhida — mesma divisão do modal homônimo do detalhe do cofre.
 *
 * NOTA: a spec (A20) pede este modal extraído de `cofre/[id]/page.tsx` para
 * `components/conformidade/cofre/` e compartilhado; a extração pertence à
 * frente do cofre — quando ela acontecer, a ficha troca o import e apaga este
 * arquivo (o contrato de props já é o do A20).
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useModalA11y } from "@/components/ui/useModalA11y";

interface FamiliaAtiva {
  id: string;
  codigoCrc: string;
  nome: string;
}

interface Props {
  onClose: () => void;
  onSelect: (familiaId: string) => void | Promise<void>;
  /** "Vincular família CRC" (default) | "Marcar família nas 24 selecionadas". */
  titulo?: string;
}

export function ModalVincularFamilia({ onClose, onSelect, titulo = "Vincular família CRC" }: Props) {
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<FamiliaAtiva[]>([]);
  const [loading, setLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose,
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca), 300);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    setLoading(true);
    const p = new URLSearchParams();
    p.set("limit", "20");
    p.set("status", "ATIVA");
    if (debounced) p.set("busca", debounced);
    fetch(`/api/conformidade/familias?${p}`)
      .then((r) => r.json())
      .then((j: { data?: FamiliaAtiva[] }) => {
        setResults(j.data ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [debounced]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 className="text-sm font-bold">{titulo}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 border-b border-gray-100">
          <input
            ref={inputRef}
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por código ou nome..."
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-orange/30"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Buscando...
            </div>
          ) : results.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              Nenhuma família ativa encontrada.
            </p>
          ) : (
            <div className="space-y-1">
              {results.map((f) => (
                <button
                  key={f.id}
                  onClick={() => onSelect(f.id)}
                  className="w-full text-left p-3 border border-gray-100 rounded-lg hover:border-brand-orange hover:bg-orange-50/50"
                >
                  <span className="font-mono text-xs font-bold text-gray-800">{f.codigoCrc}</span>
                  <p className="text-sm text-gray-700">{f.nome}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
