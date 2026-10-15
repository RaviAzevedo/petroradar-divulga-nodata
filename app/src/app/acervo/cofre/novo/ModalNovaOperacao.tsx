"use client";

/**
 * Cadastro de operação sem sair da tela de upload.
 *
 * Existe porque o caso real é este: a licitação está aberta, o atestado está na
 * mão e a obra não veio no catálogo. Mandar o usuário para outra tela
 * (que ainda por cima não existe) significa perder o lote que ele já montou.
 *
 * Só os dois campos obrigatórios do POST são obrigatórios aqui (código e
 * cliente); o resto é o que costuma estar à mão no atestado.
 */

import { useId, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import { cn } from "@/lib/utils";
import { DETENTORAS, DETENTORA_LABELS, type Detentora } from "@/lib/conformidade/operacoes";
import type { OperacaoResumo } from "./lote";

interface Props {
  /** Pré-preenche o código quando o usuário já digitou algo na busca. */
  codigoInicial?: string;
  onFechar: () => void;
  onCriada: (operacao: OperacaoResumo) => void;
}

/** Resposta do POST /api/conformidade/operacoes (201 = a linha inteira). */
interface RespostaCriacao {
  id?: string;
  codigo?: string;
  clienteNome?: string;
  clienteGrupo?: string | null;
  contratoNumero?: string | null;
  unidade?: string | null;
  detentora?: Detentora;
  error?: string;
  detalhes?: Record<string, string>;
}

export function ModalNovaOperacao({ codigoInicial = "", onFechar, onCriada }: Props) {
  const idBase = useId();
  const primeiroCampo = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: onFechar,
    initialFocusRef: primeiroCampo,
  });

  const [codigo, setCodigo] = useState(codigoInicial);
  const [clienteNome, setClienteNome] = useState("");
  const [clienteGrupo, setClienteGrupo] = useState("");
  const [contratoNumero, setContratoNumero] = useState("");
  const [unidade, setUnidade] = useState("");
  const [detentora, setDetentora] = useState<Detentora>("PROPONENTE");

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [errosCampo, setErrosCampo] = useState<Record<string, string>>({});

  async function salvar() {
    setErro(null);
    setErrosCampo({});

    const erros: Record<string, string> = {};
    if (!/^[A-Za-z0-9._-]{2,32}$/.test(codigo.trim())) {
      erros.codigo = "De 2 a 32 caracteres: letras, números, ponto, hífen e sublinhado";
    }
    if (clienteNome.trim().length < 2) erros.clienteNome = "Mínimo 2 caracteres";
    if (Object.keys(erros).length > 0) {
      setErrosCampo(erros);
      return;
    }

    setSalvando(true);
    try {
      const r = await fetch("/api/conformidade/operacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigo:         codigo.trim(),
          clienteNome:    clienteNome.trim(),
          // Campo em branco vira null, não "" — o banco distingue os dois.
          clienteGrupo:   clienteGrupo.trim()   || null,
          contratoNumero: contratoNumero.trim() || null,
          unidade:        unidade.trim()        || null,
          detentora,
        }),
      });

      const corpo = (await r.json().catch(() => null)) as RespostaCriacao | null;

      if (!r.ok) {
        // 409 é sempre do código (é a única unicidade da tabela): mostra no campo
        // e não só no topo, senão o usuário não sabe o que corrigir.
        if (r.status === 409) setErrosCampo({ codigo: corpo?.error ?? "Código já usado" });
        if (corpo?.detalhes) setErrosCampo((p) => ({ ...p, ...corpo.detalhes }));
        setErro(corpo?.error ?? `Não foi possível cadastrar (HTTP ${r.status})`);
        setSalvando(false);
        return;
      }

      if (!corpo?.id || !corpo.codigo || !corpo.clienteNome) {
        setErro("O servidor respondeu sem os dados da operação.");
        setSalvando(false);
        return;
      }

      onCriada({
        id:              corpo.id,
        codigo:          corpo.codigo,
        clienteNome:     corpo.clienteNome,
        clienteGrupo:    corpo.clienteGrupo    ?? null,
        contratoNumero:  corpo.contratoNumero  ?? null,
        unidade:         corpo.unidade         ?? null,
        detentora:       corpo.detentora       ?? detentora,
        // Operação recém-criada não tem prova nenhuma — por definição.
        totalDocumentos: 0,
        totalAtestados:  0,
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha de rede ao cadastrar a operação.");
      setSalvando(false);
    }
  }

  const classeInput = (campo: string) =>
    cn(
      "w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30",
      errosCampo[campo] ? "border-red-400" : "border-gray-200"
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${idBase}-titulo`}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onFechar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-lg mx-4 p-6 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 id={`${idBase}-titulo`} className="text-sm font-bold text-gray-900">
              Cadastrar operação
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Para obra que não veio no catálogo. O que faltar dá para completar depois.
            </p>
          </div>
          <button
            type="button"
            onClick={onFechar}
            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            aria-label="Fechar cadastro de operação"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {erro && (
          <div
            role="alert"
            className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-xs text-red-700"
          >
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-px" />
            <span>{erro}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor={`${idBase}-codigo`}
              className="block text-xs font-semibold text-gray-600 mb-1"
            >
              Código <span className="text-red-500">*</span>
            </label>
            <input
              ref={primeiroCampo}
              id={`${idBase}-codigo`}
              type="text"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              placeholder="12345"
              aria-invalid={Boolean(errosCampo.codigo)}
              aria-describedby={errosCampo.codigo ? `${idBase}-codigo-erro` : undefined}
              className={classeInput("codigo")}
            />
            {errosCampo.codigo && (
              <p id={`${idBase}-codigo-erro`} className="mt-1 text-xs text-red-600">
                {errosCampo.codigo}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor={`${idBase}-detentora`}
              className="block text-xs font-semibold text-gray-600 mb-1"
            >
              Detentora do acervo
            </label>
            <select
              id={`${idBase}-detentora`}
              value={detentora}
              onChange={(e) => setDetentora(e.target.value as Detentora)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            >
              {DETENTORAS.map((d) => (
                <option key={d} value={d}>
                  {DETENTORA_LABELS[d]}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label
              htmlFor={`${idBase}-cliente`}
              className="block text-xs font-semibold text-gray-600 mb-1"
            >
              Cliente <span className="text-red-500">*</span>
            </label>
            <input
              id={`${idBase}-cliente`}
              type="text"
              value={clienteNome}
              onChange={(e) => setClienteNome(e.target.value)}
              placeholder="Petróleo Brasileiro S.A."
              aria-invalid={Boolean(errosCampo.clienteNome)}
              aria-describedby={errosCampo.clienteNome ? `${idBase}-cliente-erro` : undefined}
              className={classeInput("clienteNome")}
            />
            {errosCampo.clienteNome && (
              <p id={`${idBase}-cliente-erro`} className="mt-1 text-xs text-red-600">
                {errosCampo.clienteNome}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor={`${idBase}-grupo`}
              className="block text-xs font-semibold text-gray-600 mb-1"
            >
              Grupo do cliente
            </label>
            <input
              id={`${idBase}-grupo`}
              type="text"
              value={clienteGrupo}
              onChange={(e) => setClienteGrupo(e.target.value)}
              placeholder="Petrobras"
              className={classeInput("clienteGrupo")}
            />
          </div>

          <div>
            <label
              htmlFor={`${idBase}-contrato`}
              className="block text-xs font-semibold text-gray-600 mb-1"
            >
              Contrato nº
            </label>
            <input
              id={`${idBase}-contrato`}
              type="text"
              value={contratoNumero}
              onChange={(e) => setContratoNumero(e.target.value)}
              placeholder="5900012345"
              className={classeInput("contratoNumero")}
            />
          </div>

          <div className="sm:col-span-2">
            <label
              htmlFor={`${idBase}-unidade`}
              className="block text-xs font-semibold text-gray-600 mb-1"
            >
              Unidade / local
            </label>
            <input
              id={`${idBase}-unidade`}
              type="text"
              value={unidade}
              onChange={(e) => setUnidade(e.target.value)}
              placeholder="REF-A — Cidade/UF"
              className={classeInput("unidade")}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5 pt-4 border-t border-gray-100">
          <Button variant="secondary" onClick={onFechar} className="font-normal">
            Cancelar
          </Button>
          <Button onClick={salvar} loading={salvando}>
            Cadastrar e usar
          </Button>
        </div>
      </div>
    </div>
  );
}
