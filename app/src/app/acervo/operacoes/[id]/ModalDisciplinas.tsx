"use client";

/**
 * D3 — modal de disciplinas da obra (spec ONDA-4 §7.2).
 *
 * Molde: `ModalVincularFamilia.tsx` (mesma pasta) — backdrop, painel, focus
 * trap por `useModalA11y`. TRÊS diferenças declaradas em relação ao molde:
 *
 * 1. é MULTI-seleção: o gesto não é "escolher uma disciplina" e sim "este é o
 *    conjunto de disciplinas desta obra", então o estado é um `Set` de ids;
 * 2. quem faz o PUT é ESTE arquivo, não o chamador. O molde deixa o POST para
 *    a ficha porque serve ao vínculo unitário e ao vínculo em massa; aqui há um
 *    caminho só, e dividir o ato entre dois arquivos espalharia o 422;
 * 3. SEM busca com debounce: o catálogo tem 16 linhas e cabe inteiro na lista —
 *    `GET /api/conformidade/disciplinas` é chamado UMA vez, ao abrir.
 *
 * ⚠️ Disciplina INATIVA que a obra JÁ tem continua aparecendo (no fim da lista,
 * em cinza): esconder o vínculo existente falsearia o histórico. Desmarcar é
 * possível; remarcar depois de salvar, não — o catálogo do GET só traz ativas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useModalA11y } from "@/components/ui/useModalA11y";

/** O que a ficha (R3) e o PUT devolvem por disciplina vinculada. */
export interface DisciplinaDaObra {
  id: string;
  codigo: string;
  nome: string;
}

/** Linha do catálogo (GET /api/conformidade/disciplinas). */
interface DisciplinaCatalogo extends DisciplinaDaObra {
  ordem: number;
  ativo: boolean;
}

/** Corpo de erro do módulo: 422 traz `detalhes`; 403 inline só traz `error`. */
interface CorpoPut {
  error?: string;
  detalhes?: Record<string, string>;
  disciplinas?: DisciplinaDaObra[];
}

interface Props {
  operacaoId: string;
  /** Código da obra — só para o título do diálogo ("Disciplinas da obra 12345"). */
  codigo: string;
  /** Conjunto atual, vindo do R3: é ele que marca os checkboxes ao abrir. */
  atuais: DisciplinaDaObra[];
  onClose: () => void;
  /** Recebe o conjunto NOVO que o PUT devolveu — a resposta já é a verdade. */
  onSalvo: (disciplinas: DisciplinaDaObra[]) => void;
}

export function ModalDisciplinas({ operacaoId, codigo, atuais, onClose, onSalvo }: Props) {
  const [catalogo, setCatalogo] = useState<DisciplinaCatalogo[] | null>(null);
  const [selecionadas, setSelecionadas] = useState<Set<string>>(() => new Set(atuais.map((d) => d.id)));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const primeiroRef = useRef<HTMLInputElement>(null);

  // Fechar é bloqueado enquanto salva (Escape e backdrop): perder a escolha da
  // pessoa no meio de uma requisição é o pior momento possível para fechar.
  const fechar = useCallback(() => {
    if (!salvando) onClose();
  }, [salvando, onClose]);

  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: fechar,
    initialFocusRef: primeiroRef,
  });

  // UMA chamada ao abrir. `AbortController` no cleanup para o modal fechado
  // não tentar mexer em estado desmontado.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/conformidade/disciplinas", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
      .then((j: { disciplinas?: DisciplinaCatalogo[] }) => setCatalogo(j.disciplinas ?? []))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setCatalogo([]);
        setErro(e instanceof Error ? e.message : "Falha ao carregar o catálogo de disciplinas");
      });
    return () => ac.abort();
  }, []);

  /**
   * Catálogo ativo + as disciplinas JÁ vinculadas que não estão nele (as
   * desativadas), no fim e marcadas como tal. Sem isso, salvar o modal apagaria
   * em silêncio um vínculo que a pessoa nem viu.
   */
  const itens = useMemo(() => {
    const ativas = catalogo ?? [];
    const idsAtivas = new Set(ativas.map((d) => d.id));
    return [
      ...ativas.map((d) => ({ id: d.id, codigo: d.codigo, nome: d.nome, inativa: false })),
      ...atuais
        .filter((d) => !idsAtivas.has(d.id))
        .map((d) => ({ id: d.id, codigo: d.codigo, nome: d.nome, inativa: true })),
    ];
  }, [catalogo, atuais]);

  function alternar(id: string) {
    setSelecionadas((atual) => {
      const copia = new Set(atual);
      if (copia.has(id)) copia.delete(id);
      else copia.add(id);
      return copia;
    });
  }

  async function salvar() {
    setErro(null);
    setSalvando(true);
    try {
      const r = await fetch(`/api/conformidade/operacoes/${operacaoId}/disciplinas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disciplinaIds: Array.from(selecionadas) }),
      });
      const j = (await r.json().catch(() => ({}))) as CorpoPut;
      if (!r.ok) {
        // 422 → a frase de `detalhes.disciplinaIds`; 403 inline → só `error`.
        setErro(j.detalhes?.disciplinaIds ?? j.error ?? `Erro ${r.status}`);
        setSalvando(false);
        return;
      }
      onSalvo(j.disciplinas ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao salvar as disciplinas");
      setSalvando(false);
    }
  }

  const titulo = `Disciplinas da obra ${codigo}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={fechar} />
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
          <button
            type="button"
            onClick={fechar}
            className="p-1 rounded hover:bg-gray-100"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {erro && (
            <p
              role="alert"
              className="flex items-start gap-2 bg-red-50 border border-red-200 rounded p-2 mb-3 text-xs text-red-700"
            >
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" aria-hidden="true" /> {erro}
            </p>
          )}

          {catalogo === null ? (
            <div className="space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : itens.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              O catálogo de disciplinas está vazio.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {itens.map((d, i) => (
                <li key={d.id}>
                  <label className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      ref={i === 0 ? primeiroRef : undefined}
                      type="checkbox"
                      checked={selecionadas.has(d.id)}
                      onChange={() => alternar(d.id)}
                      className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
                    />
                    <span className="font-mono text-xs font-bold text-gray-700">{d.codigo}</span>
                    <span
                      className={d.inativa ? "text-sm text-gray-400" : "text-sm text-gray-700"}
                      title={d.inativa ? "disciplina desativada no catálogo" : undefined}
                    >
                      {d.nome}
                      {d.inativa && " (desativada)"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 p-4 border-t border-gray-100">
          {/* O teto é 20 (§4.2): a pessoa precisa ver que está longe dele. */}
          <span className="text-xs text-gray-400">{selecionadas.size} selecionadas</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={fechar} disabled={salvando}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={salvando}>
              {salvando && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Salvar disciplinas
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
