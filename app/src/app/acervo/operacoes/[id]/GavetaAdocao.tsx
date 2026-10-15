"use client";

/**
 * Gaveta "Adotar prova órfã" (03-FRONTEND §5.10 — WP-12).
 *
 * A ficha já sabe a operação; a gaveta só escolhe DOCUMENTOS: lista os órfãos
 * do cofre (R6 `semOperacao=1`), pré-filtra pelo nome do cliente e vincula em
 * lote via R11. O espelho dela no cofre (ModalVincularOperacao) faz o inverso —
 * já sabe os documentos e escolhe a operação.
 *
 * Motivos de `pulados` de R11 traduzidos aqui (JA_VINCULADO/RESTRITO/
 * NAO_ENCONTRADO) — a resposta crua tem código, não frase.
 */

import { useCallback, useMemo, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Lock } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import {
  DETENTORA_LABELS,
  PAPEIS_DOCUMENTO,
  PAPEL_DOCUMENTO_LABELS,
  TIPO_DOCUMENTO_LABELS,
  type Detentora,
  type PapelDocumento,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { normalizarBusca, tokenSignificativo } from "./secoes";

/** Recorte do item de R6 que a gaveta usa. */
interface Orfao {
  id: string;
  titulo: string;
  tipoDocumento: TipoDocumento | null;
  detentora: Detentora | null;
  restrito: boolean;
  criadoEm: string;
}

interface RespostaOrfaos {
  data?: Orfao[];
  total?: number;
  error?: string;
}

interface RespostaVinculo {
  ok?: boolean;
  vinculados?: number;
  pulados?: Array<{ id: string; motivo: string }>;
  error?: string;
}

const MOTIVO_TRADUZIDO: Record<string, string> = {
  JA_VINCULADO: "já vinculada a outra operação",
  RESTRITO: "restrita",
  NAO_ENCONTRADO: "não encontrada (recarregue a lista)",
};

interface Props {
  operacao: { id: string; codigo: string; clienteNome: string };
  /** Chamado com ≥1 vinculada — a ficha recarrega o dossiê. */
  onVinculado: () => void;
}

export function GavetaAdocao({ operacao, onVinculado }: Props) {
  const [aberta, setAberta] = useState(false);
  const [orfaos, setOrfaos] = useState<Orfao[] | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [papel, setPapel] = useState<PapelDocumento | "">("");
  const [vinculando, setVinculando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch(
        "/api/conformidade/cofre/documentos?semOperacao=1&limit=200&order=criado_em&dir=desc"
      );
      const corpo = (await r.json().catch(() => null)) as RespostaOrfaos | null;
      if (!r.ok) throw new Error(corpo?.error ?? `Erro ${r.status}`);
      setOrfaos(corpo?.data ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao listar as provas sem operação");
    } finally {
      setCarregando(false);
    }
  }, []);

  function abrir() {
    setAberta(true);
    setResultado(null);
    setSelecionados(new Set());
    // Pré-filtro pelo primeiro token significativo do cliente ("ZYX", "ACME")
    // — editável/limpável; é ponto de partida, não algema.
    setFiltro(tokenSignificativo(operacao.clienteNome));
    void carregar();
  }

  const filtrados = useMemo(() => {
    if (!orfaos) return [];
    const termo = normalizarBusca(filtro.trim());
    if (!termo) return orfaos;
    return orfaos.filter((o) => normalizarBusca(o.titulo).includes(termo));
  }, [orfaos, filtro]);

  function toggle(id: string) {
    setSelecionados((p) => {
      const c = new Set(p);
      if (c.has(id)) c.delete(id);
      else c.add(id);
      return c;
    });
  }

  async function vincular() {
    setVinculando(true);
    setErro(null);
    setResultado(null);
    try {
      const ids = Array.from(selecionados);
      const r = await fetch("/api/conformidade/cofre/documentos/vincular-operacao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids,
          operacaoId: operacao.id,
          ...(papel ? { papel } : {}),
        }),
      });
      const corpo = (await r.json().catch(() => null)) as RespostaVinculo | null;
      if (!r.ok) {
        // 422 OPERACAO_NAO_ENCONTRADA e 400 mostram a frase do servidor.
        setErro(corpo?.error ?? `Erro ${r.status}`);
        return;
      }

      const vinculados = corpo?.vinculados ?? 0;
      const pulados = corpo?.pulados ?? [];
      if (pulados.length === 0) {
        setResultado(`${vinculados} vinculada${vinculados !== 1 ? "s" : ""}.`);
      } else {
        const motivos = pulados
          .map((p) => MOTIVO_TRADUZIDO[p.motivo] ?? p.motivo)
          .join("; ");
        setResultado(
          `${vinculados} vinculada${vinculados !== 1 ? "s" : ""} · ` +
            `${pulados.length} pulada${pulados.length !== 1 ? "s" : ""}: ${motivos}.`
        );
      }

      if (vinculados > 0) {
        setSelecionados(new Set());
        onVinculado();
        void carregar();
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao vincular as provas");
    } finally {
      setVinculando(false);
    }
  }

  if (!aberta) {
    return (
      <button
        type="button"
        onClick={abrir}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-5"
      >
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> + Adotar prova órfã
      </button>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
      <button
        type="button"
        onClick={() => setAberta(false)}
        aria-expanded={true}
        className="flex items-center gap-1.5 text-sm font-semibold text-brand-black mb-2"
      >
        <ChevronDown className="h-4 w-4 text-gray-400" aria-hidden="true" /> Adotar prova órfã
      </button>
      <p className="text-xs text-gray-500 mb-3">
        Provas no cofre ainda sem operação. Marque as que pertencem à {operacao.codigo} e
        vincule — elas entram no dossiê na hora.
      </p>

      {erro && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-red-600 mb-2">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erro}
        </p>
      )}

      {carregando ? (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Carregando as provas sem
          operação...
        </div>
      ) : orfaos !== null && orfaos.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">
          Nenhuma prova sem operação no cofre — não há nada para adotar.
        </p>
      ) : (
        <>
          <input
            type="text"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Filtrar por título..."
            aria-label="Filtrar provas órfãs"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 mb-2"
          />

          <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg mb-3">
            {filtrados.length === 0 ? (
              <p className="text-xs text-gray-400 p-3">
                Nenhuma prova órfã casa com esse filtro — limpe o campo para ver todas.
              </p>
            ) : (
              filtrados.map((o) => (
                <label
                  key={o.id}
                  className={cn(
                    "flex items-start gap-2 p-2.5 cursor-pointer hover:bg-gray-50",
                    selecionados.has(o.id) && "bg-orange-50/40"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selecionados.has(o.id)}
                    onChange={() => toggle(o.id)}
                    className="mt-0.5 rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
                    aria-label={`Selecionar ${o.titulo}`}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm text-gray-800">{o.titulo}</span>
                      <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">
                        {o.tipoDocumento
                          ? TIPO_DOCUMENTO_LABELS[o.tipoDocumento]
                          : "Sem tipo definido"}
                      </span>
                      {o.detentora && (
                        <span className="px-1.5 py-0.5 rounded border border-gray-200 bg-white text-gray-600 text-[10px] font-semibold uppercase">
                          {DETENTORA_LABELS[o.detentora]}
                        </span>
                      )}
                      {o.restrito && (
                        <span role="img" aria-label="Documento restrito" className="inline-flex">
                          <Lock className="h-3 w-3 text-gray-500" aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-gray-400">
                      guardada em {formatDate(o.criadoEm)}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-xs text-gray-600 inline-flex items-center gap-2">
              Papel na operação
              <select
                value={papel}
                onChange={(e) => setPapel(e.target.value as PapelDocumento | "")}
                className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              >
                <option value="">— definir depois</option>
                {PAPEIS_DOCUMENTO.map((p) => (
                  <option key={p} value={p}>
                    {PAPEL_DOCUMENTO_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>

            <Button
              size="sm"
              onClick={vincular}
              disabled={selecionados.size === 0 || vinculando}
            >
              {vinculando && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Vincular {selecionados.size} prova{selecionados.size !== 1 ? "s" : ""} à{" "}
              {operacao.codigo}
            </Button>

            {resultado && (
              <span aria-live="polite" className="text-xs font-semibold text-gray-700">
                {resultado}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
