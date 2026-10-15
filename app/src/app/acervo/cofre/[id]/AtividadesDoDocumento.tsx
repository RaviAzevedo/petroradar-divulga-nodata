"use client";

/**
 * Bloco "Atividades da ART" da página do documento (spec ONDA-4 §7.8).
 *
 * ⚠️ A quantidade da atividade é TEXTO e nunca soma (§1c): é a evidência
 * LITERAL do que está escrito na ART ("3.600,00 HH").
 *
 * Não há edição de atividade (§5.7): corrigir é remover e acrescentar — a
 * linha tem três campos e nenhuma história própria.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ListTree, Loader2, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useModalA11y } from "@/components/ui/useModalA11y";

/** Item de `GET …/documentos/[id]/atividades` (§5.7). */
interface AtividadeDoDocumento {
  id: string;
  atividade: string;
  /** ⚠️ TEXTO, nunca número — exibido e jamais somado. */
  quantidadeTexto: string | null;
  ordem: number;
}

interface Props {
  docId: string;
  podeGerenciar: boolean;
}

export function AtividadesDoDocumento({ docId, podeGerenciar }: Props) {
  const [atividades, setAtividades] = useState<AtividadeDoDocumento[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  /** Atividade aguardando confirmação de exclusão (o padrão da página). */
  const [removendoId, setRemovendoId] = useState<string | null>(null);

  const carregar = useCallback(
    (signal?: AbortSignal) => {
      // Sem `setCarregando(true)` aqui: o estado já nasce `true` e o efeito de
      // montagem chama esta função direto — ligar o spinner no corpo do efeito
      // é uma renderização em cascata (react-hooks/set-state-in-effect). Nas
      // recargas pós-escrita a lista simplesmente se atualiza.
      fetch(`/api/conformidade/cofre/documentos/${docId}/atividades`, { signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
        .then((j: { data?: AtividadeDoDocumento[] }) => {
          setAtividades(j.data ?? []);
          setErro(null);
          setCarregando(false);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setErro(e instanceof Error ? e.message : "Falha ao carregar as atividades");
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

  async function confirmarRemocao() {
    const atividadeId = removendoId;
    if (!atividadeId) return;
    setRemovendoId(null);
    setErro(null);
    const r = await fetch(
      `/api/conformidade/cofre/documentos/${docId}/atividades?atividadeId=${atividadeId}`,
      { method: "DELETE" }
    );
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setErro(j.error ?? `Erro ${r.status}`);
      return;
    }
    carregar();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-brand-black flex items-center gap-2">
          <ListTree className="h-4 w-4 text-brand-orange" /> Atividades da ART ({atividades.length})
        </h2>
        {podeGerenciar && (
          <button
            type="button"
            onClick={() => setModal(true)}
            className="text-xs px-3 py-1.5 bg-orange-50 text-brand-orange border border-orange-200 rounded hover:bg-orange-100 flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Adicionar
          </button>
        )}
      </div>

      {erro && (
        <p role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 mb-3 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erro}
        </p>
      )}

      {carregando ? (
        <p className="flex items-center justify-center gap-2 text-sm text-gray-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Carregando...
        </p>
      ) : atividades.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">
          Nenhuma atividade cadastrada. É o que a ART descreve, copiado como está escrito.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {atividades.map((a) => (
            <li
              key={a.id}
              className="flex items-start justify-between p-2 border border-gray-100 rounded-md gap-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800">
                  <span className="text-gray-400 tabular-nums">{a.ordem}.</span> {a.atividade}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                  {a.quantidadeTexto && (
                    <span
                      className="font-mono text-xs text-gray-500"
                      title="quantidade escrita na ART — texto do documento, não entra em soma"
                    >
                      {a.quantidadeTexto}
                    </span>
                  )}
                </p>
              </div>
              {podeGerenciar && (
                <button
                  type="button"
                  onClick={() => setRemovendoId(a.id)}
                  className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                  aria-label="Remover atividade"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removendoId !== null}
        title="Remover atividade"
        message="A atividade sai da ART neste sistema."
        confirmLabel="Remover"
        variant="danger"
        onConfirm={confirmarRemocao}
        onCancel={() => setRemovendoId(null)}
      />

      {modal && (
        <ModalNovaAtividade
          docId={docId}
          onClose={() => setModal(false)}
          onCriada={() => {
            setModal(false);
            carregar();
          }}
        />
      )}
    </div>
  );
}

// ── Modal de nova atividade (mora aqui, como o ModalNovoProjeto da página) ──

function ModalNovaAtividade({
  docId,
  onClose,
  onCriada,
}: {
  docId: string;
  onClose: () => void;
  onCriada: () => void;
}) {
  const [atividade, setAtividade] = useState("");
  const [quantidadeTexto, setQuantidadeTexto] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const atividadeRef = useRef<HTMLTextAreaElement>(null);
  const fechar = useCallback(() => {
    if (!salvando) onClose();
  }, [salvando, onClose]);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: fechar,
    initialFocusRef: atividadeRef,
  });

  async function salvar() {
    setErro(null);
    setSalvando(true);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/atividades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          atividade: atividade.trim(),
          quantidadeTexto: quantidadeTexto.trim() || null,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as {
          error?: string;
          detalhes?: Record<string, string>;
        };
        const primeiro = j.detalhes ? Object.values(j.detalhes)[0] : undefined;
        setErro(primeiro ?? j.error ?? `Erro ${r.status}`);
        setSalvando(false);
        return;
      }
      onCriada();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao salvar a atividade");
      setSalvando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={fechar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        role="dialog"
        aria-modal="true"
        aria-label="Adicionar atividade da ART"
        className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Adicionar atividade da ART</h3>
          <button type="button" onClick={fechar} className="p-1 rounded hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1" htmlFor="campo-atividade">
              Atividade
            </label>
            <textarea
              id="campo-atividade"
              ref={atividadeRef}
              value={atividade}
              onChange={(e) => setAtividade(e.target.value)}
              rows={3}
              placeholder="Copie da ART, como está escrito"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1" htmlFor="campo-quantidade">
              Quantidade (texto)
            </label>
            <input
              id="campo-quantidade"
              type="text"
              value={quantidadeTexto}
              onChange={(e) => setQuantidadeTexto(e.target.value)}
              placeholder="3.600,00 HH"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              copie do documento, como está escrito — este campo não entra em soma
            </p>
          </div>

          {erro && (
            <p role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erro}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={fechar} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={salvando || atividade.trim().length < 2}>
            {salvando && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Adicionar
          </Button>
        </div>
      </div>
    </div>
  );
}
