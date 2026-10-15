"use client";

/**
 * Escolha da operação — o primeiro passo da tela.
 *
 * A operação é escolhida UMA vez, no topo, e vale para o lote inteiro: era isso
 * que antes existia só como prefixo digitado no título ("12345 - ..."), sem
 * ninguém garantir que o número existia de verdade.
 *
 * A busca enxerga todas as operações do catálogo; a lista inicial (sem digitar
 * nada) mostra só as que JÁ têm prova no cofre, que é de onde vem a maioria dos
 * uploads — quem sobe um atestado novo costuma estar completando uma obra que já
 * tem alguma prova guardada.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Building2, Check, Loader2, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DETENTORA_LABELS } from "@/lib/conformidade/operacoes";
import { ModalNovaOperacao } from "./ModalNovaOperacao";
import type { OperacaoResumo, RespostaOperacoes } from "./lote";

interface Props {
  operacao: OperacaoResumo | null;
  /** Provas que a operação já tem no cofre (vem do GET de documentos). */
  provasNoCofre: number | null;
  carregandoProvas: boolean;
  /** Chegada por link (?operacaoId=…): o GET do dossiê ainda não respondeu. */
  carregandoDoLink: boolean;
  /** Link apontou operação que não existe mais — a busca continua funcionando. */
  avisoDoLink: string | null;
  onEscolher: (operacao: OperacaoResumo) => void;
  onLimpar: () => void;
}

export function SeletorOperacao({
  operacao,
  provasNoCofre,
  carregandoProvas,
  carregandoDoLink,
  avisoDoLink,
  onEscolher,
  onLimpar,
}: Props) {
  if (operacao) {
    return (
      <OperacaoEscolhida
        operacao={operacao}
        provasNoCofre={provasNoCofre}
        carregandoProvas={carregandoProvas}
        onLimpar={onLimpar}
      />
    );
  }
  // Esqueleto no lugar da busca enquanto o link resolve: mostrar o combobox
  // por um instante e trocá-lo pelo cartão logo depois só faria a tela pular.
  if (carregandoDoLink) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p
          className="inline-flex items-center gap-2 text-sm text-gray-500"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Carregando a operação…
        </p>
      </div>
    );
  }
  return <BuscaOperacao onEscolher={onEscolher} aviso={avisoDoLink} />;
}

// ── Cartão da operação já escolhida ──────────────────────────────────────────

function OperacaoEscolhida({
  operacao,
  provasNoCofre,
  carregandoProvas,
  onLimpar,
}: {
  operacao: OperacaoResumo;
  provasNoCofre: number | null;
  carregandoProvas: boolean;
  onLimpar: () => void;
}) {
  // Enquanto o GET de provas não volta, o número da listagem já serve de prévia.
  const provas = provasNoCofre ?? operacao.totalDocumentos;

  return (
    <div className="rounded-xl border border-brand-orange/40 bg-orange-50/40 p-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-white border border-orange-100">
          <Building2 className="h-4 w-4 text-brand-orange" aria-hidden="true" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-bold text-gray-900">{operacao.codigo}</span>
            <span className="text-sm text-gray-800 truncate">{operacao.clienteNome}</span>
            <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 bg-white border border-gray-200 rounded px-1.5 py-0.5">
              {DETENTORA_LABELS[operacao.detentora] ?? operacao.detentora}
            </span>
          </div>

          <p className="text-xs text-gray-500 mt-1">
            {[
              operacao.contratoNumero ? `Contrato ${operacao.contratoNumero}` : null,
              operacao.unidade,
              operacao.clienteGrupo,
            ]
              .filter(Boolean)
              .join(" · ") || "Sem contrato, unidade ou grupo cadastrados"}
          </p>

          <p className="text-xs mt-2" aria-live="polite">
            {carregandoProvas ? (
              <span className="inline-flex items-center gap-1.5 text-gray-500">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Conferindo o que esta operação já tem no cofre...
              </span>
            ) : provas > 0 ? (
              <span className="font-semibold text-gray-700">
                {provas === 1 ? "1 prova já no cofre" : `${provas} provas já no cofre`}
              </span>
            ) : (
              <span className="text-gray-500">Nenhuma prova desta operação no cofre ainda</span>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={onLimpar}
          className="text-xs font-semibold text-gray-500 hover:text-gray-800 underline underline-offset-2"
        >
          Trocar operação
        </button>
      </div>
    </div>
  );
}

// ── Busca (combobox) ─────────────────────────────────────────────────────────

function BuscaOperacao({
  onEscolher,
  aviso,
}: {
  onEscolher: (operacao: OperacaoResumo) => void;
  aviso: string | null;
}) {
  const idBase = useId();
  const listaId = `${idBase}-lista`;

  const [busca, setBusca] = useState("");
  const [buscaDebounced, setBuscaDebounced] = useState("");
  const [resultados, setResultados] = useState<OperacaoResumo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ativo, setAtivo] = useState(-1);
  const [modalAberto, setModalAberto] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // 300 ms: o suficiente para não disparar uma consulta por tecla e curto o
  // bastante para a lista parecer instantânea enquanto se digita o código.
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
    // Sem termo digitado: só as operações que já têm prova. Ordenar centenas de obras por
    // código e mostrar as 20 primeiras não ajudaria ninguém.
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
    } else if (e.key === "Escape") {
      setBusca("");
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      {aviso && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          {aviso}
        </p>
      )}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <label
            htmlFor={`${idBase}-busca`}
            className="block text-xs font-semibold text-gray-700 uppercase tracking-wide"
          >
            Operação que estas provas comprovam
          </label>
          <p className="text-xs text-gray-500 mt-0.5">
            Busque por código, cliente ou número do contrato. Sem operação, os arquivos entram no
            cofre como documento avulso.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalAberto(true)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-orange hover:underline whitespace-nowrap"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Cadastrar operação
        </button>
      </div>

      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
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
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
            aria-label="Limpar busca"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {carregando
          ? "Buscando operações"
          : `${resultados.length} operações encontradas`}
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
              ? "Nenhuma operação com esse código, cliente ou contrato. Use “Cadastrar operação” para criá-la."
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

      {modalAberto && (
        <ModalNovaOperacao
          codigoInicial={busca.trim()}
          onFechar={() => setModalAberto(false)}
          onCriada={(nova) => {
            setModalAberto(false);
            onEscolher(nova);
          }}
        />
      )}
    </div>
  );
}
