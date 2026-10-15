"use client";

/**
 * Combobox de busca de operação — o mesmo desenho do `BuscaOperacao` do upload
 * (`novo/SeletorOperacao.tsx`), reusado pelos fluxos de correção do cofre:
 * adoção em lote (ModalVincularOperacao) e vínculo unitário no editor do
 * detalhe (ModalEditarDocumento).
 *
 * Consome R1 como o original: sem termo digitado, `comProva=1` (só operações
 * que já têm prova); com termo, `busca=`. Efeito P10 declarado no plano: com o
 * guard novo de R1 este combobox só funciona para Conformidade — exatamente
 * quem alcança as telas que o usam.
 *
 * Diferenças conscientes em relação ao original: sem o cartão de escolhida
 * (responsabilidade do chamador) e sem o botão "Cadastrar operação" — adoção
 * vincula a operação EXISTENTE; cadastrar no meio de um modal viraria modal
 * sobre modal.
 */

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Check, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DETENTORA_LABELS } from "@/lib/conformidade/operacoes";
import type { OperacaoResumo, RespostaOperacoes } from "./novo/lote";

interface Props {
  onEscolher: (operacao: OperacaoResumo) => void;
  /** Rótulo acima do campo. Default: o texto do combobox do upload. */
  rotulo?: string;
  /** Ajuda curta sob o rótulo. `null` esconde. */
  ajuda?: string | null;
  /** Ref externo do input — os modais o usam como foco inicial (useModalA11y). */
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function BuscaOperacaoCombobox({
  onEscolher,
  rotulo = "Operação",
  ajuda = "Busque por código, cliente ou número do contrato.",
  inputRef,
}: Props) {
  const idBase = useId();
  const listaId = `${idBase}-lista`;

  const [busca, setBusca] = useState("");
  const [buscaDebounced, setBuscaDebounced] = useState("");
  const [resultados, setResultados] = useState<OperacaoResumo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ativo, setAtivo] = useState(-1);

  const inputRefLocal = useRef<HTMLInputElement>(null);
  const refDoInput = inputRef ?? inputRefLocal;

  // 300 ms — o mesmo debounce do combobox do upload.
  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounced(busca.trim()), 300);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    setErro(null);

    const p = new URLSearchParams();
    p.set("limit", "20");
    if (buscaDebounced) p.set("busca", buscaDebounced);
    else p.set("comProva", "1");

    fetch(`/api/conformidade/operacoes?${p}`)
      .then(async (r) => {
        const corpo = (await r.json().catch(() => null)) as
          | (RespostaOperacoes & { error?: string })
          | null;
        if (cancelado) return;
        if (!r.ok) {
          setErro(corpo?.error ?? `Não foi possível buscar operações (HTTP ${r.status})`);
          setResultados([]);
          return;
        }
        setResultados(corpo?.operacoes ?? []);
        setAtivo(-1);
      })
      .catch((e: unknown) => {
        if (cancelado) return;
        setErro(e instanceof Error ? e.message : "Falha de rede ao buscar operações.");
        setResultados([]);
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });

    return () => {
      cancelado = true;
    };
  }, [buscaDebounced]);

  function aoTeclar(e: React.KeyboardEvent<HTMLInputElement>) {
    if (resultados.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAtivo((i) => (i + 1) % resultados.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAtivo((i) => (i <= 0 ? resultados.length - 1 : i - 1));
    } else if (e.key === "Enter" && ativo >= 0) {
      e.preventDefault();
      onEscolher(resultados[ativo]);
    } else if (e.key === "Escape" && busca) {
      // Escape com termo limpa a busca; sem termo, sobe para o modal fechar.
      e.stopPropagation();
      setBusca("");
    }
  }

  return (
    <div>
      <label
        htmlFor={`${idBase}-busca`}
        className="block text-xs font-semibold text-gray-700 uppercase tracking-wide"
      >
        {rotulo}
      </label>
      {ajuda && <p className="text-xs text-gray-500 mt-0.5 mb-2">{ajuda}</p>}

      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          aria-hidden="true"
        />
        <input
          ref={refDoInput}
          id={`${idBase}-busca`}
          type="text"
          role="combobox"
          aria-expanded={resultados.length > 0}
          aria-controls={listaId}
          aria-autocomplete="list"
          aria-activedescendant={ativo >= 0 ? `${listaId}-opcao-${ativo}` : undefined}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={aoTeclar}
          placeholder="12345, Petrobras, 5900012345..."
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
        />
        {busca && (
          <button
            type="button"
            onClick={() => {
              setBusca("");
              refDoInput.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
            aria-label="Limpar busca"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {carregando ? "Buscando operações" : `${resultados.length} operações encontradas`}
      </p>

      {erro && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {erro}
        </p>
      )}

      <ul
        id={listaId}
        role="listbox"
        aria-label="Operações encontradas"
        className="mt-2 max-h-64 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg"
      >
        {carregando && resultados.length === 0 && (
          <li className="flex items-center gap-2 px-3 py-4 text-xs text-gray-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Buscando...
          </li>
        )}

        {!carregando && resultados.length === 0 && !erro && (
          <li className="px-3 py-4 text-xs text-gray-500">
            {buscaDebounced
              ? "Nenhuma operação com esse código, cliente ou contrato."
              : "Nenhuma operação com prova no cofre ainda. Digite para buscar no catálogo."}
          </li>
        )}

        {resultados.map((op, i) => (
          <li key={op.id} id={`${listaId}-opcao-${i}`} role="option" aria-selected={i === ativo}>
            <button
              type="button"
              // preventDefault no mousedown mantém o foco no input: sem isso o
              // blur fecharia a lista antes do clique virar seleção.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onEscolher(op)}
              onMouseEnter={() => setAtivo(i)}
              className={cn(
                "w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors",
                i === ativo ? "bg-orange-50" : "hover:bg-gray-50"
              )}
            >
              <span className="font-mono text-xs font-bold text-gray-900 w-16 flex-shrink-0">
                {op.codigo}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-gray-800 truncate">{op.clienteNome}</span>
                <span className="block text-[11px] text-gray-500 truncate">
                  {[
                    DETENTORA_LABELS[op.detentora] ?? op.detentora,
                    op.contratoNumero ? `Contrato ${op.contratoNumero}` : null,
                    op.unidade,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {op.totalDocumentos > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-1.5 py-0.5 flex-shrink-0">
                  <Check className="h-3 w-3" aria-hidden="true" />
                  {op.totalDocumentos}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
