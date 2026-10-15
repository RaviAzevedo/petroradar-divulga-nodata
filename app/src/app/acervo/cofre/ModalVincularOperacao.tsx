"use client";

/**
 * Modal de adoção em lote (A18 — 03-FRONTEND §6.3): vincula N provas órfãs a
 * uma operação via R11 `POST /cofre/documentos/vincular-operacao`.
 *
 * O chamador (CofreClient) filtra os órfãos ANTES de abrir — este modal nunca
 * manda documento que já tem operação; se mandar por corrida, R11 pula com
 * `JA_VINCULADO`, que o resumo reporta. Acima de 200 ids (teto de R11) o envio
 * é fatiado em blocos sequenciais e os resultados são somados — transparente.
 */

import { useId, useRef, useState } from "react";
import { AlertCircle, Building2, Link2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import {
  PAPEIS_DOCUMENTO,
  PAPEL_DOCUMENTO_LABELS,
  type PapelDocumento,
} from "@/lib/conformidade/operacoes";
import { BuscaOperacaoCombobox } from "./BuscaOperacaoCombobox";
import {
  fatiarIds,
  resumoVinculacao,
  type PuladoVinculo,
  type ResultadoVinculacao,
} from "./vincular-operacao";
import type { OperacaoResumo } from "./novo/lote";

interface Props {
  /** Documentos a vincular — o chamador garante que são órfãos. */
  ids: string[];
  onFechar: () => void;
  /** Disparado UMA vez ao fim do envio (mesmo parcial) — o chamador recarrega a lista ao fechar. */
  onVinculado: (resultado: ResultadoVinculacao) => void;
}

/** Corpo de erro que as rotas do módulo devolvem. */
interface CorpoErro {
  error?: string;
}

export function ModalVincularOperacao({ ids, onFechar, onVinculado }: Props) {
  const tituloId = useId();
  const buscaRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: onFechar,
    initialFocusRef: buscaRef,
  });

  const [operacao, setOperacao] = useState<OperacaoResumo | null>(null);
  const [papel, setPapel] = useState<PapelDocumento | "">("");
  const [enviando, setEnviando] = useState(false);
  const [resumo, setResumo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const plural = ids.length !== 1;
  const rotuloProvas = `${ids.length} prova${plural ? "s" : ""}`;

  async function vincular() {
    if (!operacao || enviando) return;
    setEnviando(true);
    setErro(null);

    let vinculados = 0;
    const pulados: PuladoVinculo[] = [];
    let falhou = false;

    // Blocos em SÉRIE (não em paralelo): R11 aceita 200 ids por chamada e o
    // servidor é quem serializa o UPDATE — paralelizar só criaria corrida.
    for (const bloco of fatiarIds(ids)) {
      try {
        const r = await fetch("/api/conformidade/cofre/documentos/vincular-operacao", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: bloco,
            operacaoId: operacao.id,
            ...(papel ? { papel } : {}),
          }),
        });
        if (!r.ok) {
          const corpo = (await r.json().catch(() => ({}))) as CorpoErro;
          // Mensagem do servidor nunca é trocada por genérica (regra do módulo).
          setErro(corpo.error ?? `Erro ${r.status} ao vincular.`);
          falhou = true;
          break;
        }
        const corpo = (await r.json()) as ResultadoVinculacao;
        vinculados += corpo.vinculados;
        pulados.push(...corpo.pulados);
      } catch (e) {
        setErro(e instanceof Error ? e.message : "Falha de rede ao vincular.");
        falhou = true;
        break;
      }
    }

    setEnviando(false);

    // Mesmo com falha no meio, o que já vinculou vale — o chamador precisa
    // recarregar a lista ao fechar para o grupo "Sem operação" encolher.
    if (vinculados > 0 || pulados.length > 0) {
      onVinculado({ vinculados, pulados });
    }
    if (!falhou) {
      setResumo(resumoVinculacao(vinculados, pulados));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onFechar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 id={tituloId} className="text-sm font-bold flex items-center gap-2">
            <Link2 className="h-4 w-4 text-brand-orange" aria-hidden="true" />
            Vincular {rotuloProvas} a uma operação
          </h3>
          <button onClick={onFechar} className="p-1 rounded hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          {operacao ? (
            <div className="rounded-lg border border-brand-orange/40 bg-orange-50/40 p-3 flex items-center gap-3">
              <Building2 className="h-4 w-4 text-brand-orange flex-shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <span className="font-mono text-sm font-bold text-gray-900 mr-2">{operacao.codigo}</span>
                <span className="text-sm text-gray-800">{operacao.clienteNome}</span>
              </div>
              {!resumo && (
                <button
                  type="button"
                  onClick={() => setOperacao(null)}
                  disabled={enviando}
                  className="text-xs font-semibold text-gray-500 hover:text-gray-800 underline underline-offset-2 disabled:opacity-50"
                >
                  Trocar operação
                </button>
              )}
            </div>
          ) : (
            <BuscaOperacaoCombobox
              onEscolher={setOperacao}
              rotulo="Operação que recebe as provas"
              inputRef={buscaRef}
            />
          )}

          {!resumo && (
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">
                Papel na operação
              </label>
              <select
                value={papel}
                onChange={(e) => setPapel(e.target.value as PapelDocumento | "")}
                disabled={enviando}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-700"
              >
                <option value="">— definir depois</option>
                {PAPEIS_DOCUMENTO.map((p) => (
                  <option key={p} value={p}>{PAPEL_DOCUMENTO_LABELS[p]}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                Quando escolhido, o papel vale para todas as provas do lote.
              </p>
            </div>
          )}

          {erro && (
            <div role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-2.5 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {erro}
            </div>
          )}

          <p aria-live="polite" className={resumo ? "text-sm font-semibold text-gray-800" : "sr-only"}>
            {resumo ?? (enviando ? "Vinculando provas" : "")}
          </p>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-gray-100">
          {resumo ? (
            <Button onClick={onFechar}>Fechar</Button>
          ) : (
            <>
              <button
                onClick={onFechar}
                disabled={enviando}
                className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg disabled:opacity-50"
              >
                Cancelar
              </button>
              <Button onClick={vincular} disabled={!operacao || enviando}>
                {enviando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {enviando ? "Vinculando..." : `Vincular ${rotuloProvas}`}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
