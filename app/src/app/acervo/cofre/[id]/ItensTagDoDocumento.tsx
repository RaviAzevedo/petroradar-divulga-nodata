"use client";

/**
 * Bloco "Itens com TAG" da página do documento (Q9 — spec ONDA-5 §7.8).
 *
 * A TAG diz QUAL equipamento o documento lista ("P-101 A/B", "TQ-4210").
 *
 * ⚠️ `documento_itens_tag.tag` não é `documentos_habilitacao.tags`. O segundo é
 * rótulo livre de arquivamento ("urgente", "REF-A") e continua no editor do
 * documento; esta é a TAG de EQUIPAMENTO. Nomes parecidos, coisas diferentes —
 * por isso o estado vazio traz os exemplos: é o que ensina a diferença.
 *
 * `especificacao` (jsonb) existe no banco e na API, mas NÃO tem campo nesta
 * onda (§7.8): um formulário de chave→valor livre aqui
 * viraria o lugar onde tudo cabe. A tela que os edita entra quando for pedida.
 *
 * Não há PATCH na rota (§5.8): corrigir é remover e acrescentar — o item tem
 * TAG, descrição e um jsonb, nenhuma história própria.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Plus, Tags, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Item de `GET …/documentos/[id]/itens` (§4.8/§5.8). */
interface ItemTagDoDocumento {
  id: string;
  tag: string;
  descricao: string | null;
  especificacao: Record<string, string> | null;
  ordem: number;
}

interface Props {
  docId: string;
  /** `podeGerenciarDocumentosHabilitacao(role)` — o formulário só existe com ele. */
  podeEditar: boolean;
}

export function ItensTagDoDocumento({ docId, podeEditar }: Props) {
  const [itens, setItens] = useState<ItemTagDoDocumento[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  /**
   * `detalhes` do 422, campo a campo — `tag` é o nome que a rota devolve
   * (§4.8). A duplicata é o caso COMUM e tem de ler
   * como aviso embaixo do campo, não como falha do sistema.
   */
  const [erroCampo, setErroCampo] = useState<Record<string, string>>({});
  const [tag, setTag] = useState("");
  const [descricao, setDescricao] = useState("");
  const [salvando, setSalvando] = useState(false);
  /** Item aguardando confirmação de exclusão (o padrão da página). */
  const [removendoId, setRemovendoId] = useState<string | null>(null);
  /** Anúncio de mutação para leitor de tela (a11y §7.8). */
  const [anuncio, setAnuncio] = useState("");

  const tagRef = useRef<HTMLInputElement>(null);

  const carregar = useCallback(
    (signal?: AbortSignal) => {
      // Sem `setCarregando(true)` aqui: o estado já nasce `true` e o efeito de
      // montagem chama esta função direto — ligar o spinner no corpo do efeito
      // é renderização em cascata (react-hooks/set-state-in-effect).
      fetch(`/api/conformidade/cofre/documentos/${docId}/itens`, { signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
        .then((j: { data?: ItemTagDoDocumento[] }) => {
          setItens(j.data ?? []);
          setErro(null);
          setCarregando(false);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setErro(e instanceof Error ? e.message : "Falha ao carregar os itens");
          setCarregando(false);
        });
    },
    [docId]
  );

  useEffect(() => {
    const ac = new AbortController();
    carregar(ac.signal);
    return () => ac.abort();
  }, [carregar]);

  async function adicionar() {
    const tagLimpa = tag.trim();
    if (!tagLimpa || salvando) return;
    setErro(null);
    setErroCampo({});
    setSalvando(true);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/itens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: tagLimpa, descricao: descricao.trim() || null }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as {
          error?: string;
          detalhes?: Record<string, string>;
        };
        // 422 com `detalhes` gruda no campo; o resto vira faixa do bloco.
        if (j.detalhes && Object.keys(j.detalhes).length > 0) setErroCampo(j.detalhes);
        else setErro(j.error ?? `Erro ${r.status}`);
        setSalvando(false);
        return;
      }
      setTag("");
      setDescricao("");
      setAnuncio(`item ${tagLimpa} adicionado`);
      setSalvando(false);
      tagRef.current?.focus();
      carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao adicionar o item");
      setSalvando(false);
    }
  }

  async function confirmarRemocao() {
    const itemId = removendoId;
    if (!itemId) return;
    const removido = itens.find((i) => i.id === itemId);
    setRemovendoId(null);
    setErro(null);
    const r = await fetch(
      `/api/conformidade/cofre/documentos/${docId}/itens?itemId=${itemId}`,
      { method: "DELETE" }
    );
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setErro(j.error ?? `Erro ${r.status}`);
      return;
    }
    setAnuncio(`item ${removido?.tag ?? ""} removido`);
    carregar();
  }

  return (
    <section
      aria-labelledby="titulo-itens-tag"
      className="bg-white border border-gray-200 rounded-xl p-5 mb-5"
    >
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2
          id="titulo-itens-tag"
          className="text-sm font-semibold text-brand-black flex items-center gap-2"
        >
          <Tags className="h-4 w-4 text-brand-orange" aria-hidden="true" /> Itens com TAG (
          {itens.length})
        </h2>
      </div>

      <p aria-live="polite" className="sr-only">
        {anuncio}
      </p>

      {erro && (
        <p
          role="alert"
          className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 mb-3 text-xs text-red-700"
        >
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erro}
        </p>
      )}

      {/* Formulário de UMA LINHA — nada de modal (§6): é o padrão literal do
          AnexosSection, que faz upload, edição e exclusão sem diálogo próprio. */}
      {podeEditar && (
        <div className="mb-3 flex flex-wrap items-start gap-2">
          <div className="min-w-[9rem] flex-1">
            <label className="sr-only" htmlFor="campo-item-tag">
              TAG do equipamento
            </label>
            <input
              id="campo-item-tag"
              ref={tagRef}
              type="text"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void adicionar();
              }}
              maxLength={100}
              placeholder="P-101 A/B"
              aria-invalid={erroCampo.tag ? true : undefined}
              className="w-full px-2 py-1.5 text-xs font-mono border border-gray-200 rounded"
            />
            {erroCampo.tag && <p className="mt-1 text-xs text-red-600">{erroCampo.tag}</p>}
          </div>
          <div className="min-w-[12rem] flex-[2]">
            <label className="sr-only" htmlFor="campo-item-descricao">
              Descrição do item
            </label>
            <input
              id="campo-item-descricao"
              type="text"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void adicionar();
              }}
              maxLength={500}
              placeholder="Descrição (opcional)"
              className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded"
            />
          </div>
          <Button size="sm" onClick={adicionar} disabled={salvando || tag.trim().length === 0}>
            {salvando ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="h-3 w-3" aria-hidden="true" />
            )}
            Adicionar
          </Button>
        </div>
      )}

      {carregando ? (
        <p className="flex items-center justify-center gap-2 text-sm text-gray-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Carregando...
        </p>
      ) : itens.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">
          Nenhum item com TAG registrado. Serve para o equipamento que o documento lista —
          P-101 A/B, TQ-4210.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {itens.map((i) => (
            <li
              key={i.id}
              className="flex items-start justify-between p-2 border border-gray-100 rounded-md gap-2"
            >
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm font-medium text-gray-800">{i.tag}</p>
                {i.descricao && <p className="text-xs text-gray-500 mt-0.5">{i.descricao}</p>}
              </div>
              {podeEditar && (
                <button
                  type="button"
                  onClick={() => setRemovendoId(i.id)}
                  className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                  aria-label={`Remover item ${i.tag}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removendoId !== null}
        title="Remover item"
        message="O item sai deste documento."
        confirmLabel="Remover"
        variant="danger"
        onConfirm={confirmarRemocao}
        onCancel={() => setRemovendoId(null)}
      />
    </section>
  );
}
