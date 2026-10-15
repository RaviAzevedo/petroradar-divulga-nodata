"use client";

/**
 * Bloco "Responsáveis técnicos" da página do documento (spec ONDA-4 §7.8).
 *
 * Cartão copiado linha a linha do bloco "Projetos / clientes" da mesma página,
 * com o próprio `fetch` da satélite `…/documentos/[id]/profissionais` ao montar
 * (a página do documento não carrega os vínculos no R17).
 *
 * ⚠️ `GavetaDocumento.tsx` e `LinhaDocumento.tsx` continuam INTOCADOS (§1l):
 * a gaveta é uma prévia, e encher a prévia de blocos com fetch próprio a
 * transformaria numa segunda página do documento, com dois lugares para manter.
 *
 * O modal de vincular mora AQUI dentro, e não em arquivo próprio — é o padrão
 * literal do `ModalNovoProjeto`, que vive dentro de `cofre/[id]/page.tsx`.
 *
 * Vincular quem JÁ está vinculado ATUALIZA papel e ART e responde 200 (§4.5):
 * repetir o gesto da tela não é erro, e a tela diz "vínculo atualizado".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, HardHat, Loader2, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import {
  PAPEIS_PROFISSIONAL,
  PAPEL_PROFISSIONAL_LABELS,
} from "@/lib/conformidade/profissionais/validations";
import type { PapelProfissional } from "@/db/schema";

/** Item de `GET …/documentos/[id]/profissionais` (§5.6). */
interface VinculoDoDocumento {
  vinculoId: string;
  profissionalId: string;
  nome: string;
  crea: string | null;
  creaUf: string | null;
  papel: PapelProfissional;
  numeroArt: string | null;
}

/** Recorte de `GET /api/conformidade/profissionais` usado pela busca do modal. */
interface ProfissionalBusca {
  id: string;
  nome: string;
  crea: string | null;
  creaUf: string | null;
  formacao: string | null;
}

interface Props {
  docId: string;
  podeGerenciar: boolean;
}

export function ProfissionaisDoDocumento({ docId, podeGerenciar }: Props) {
  const [vinculos, setVinculos] = useState<VinculoDoDocumento[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [modal, setModal] = useState(false);

  const carregar = useCallback(
    (signal?: AbortSignal) => {
      // Sem `setCarregando(true)` aqui: o estado já nasce `true` e o efeito de
      // montagem chama esta função direto — ligar o spinner no corpo do efeito
      // é uma renderização em cascata (react-hooks/set-state-in-effect). Nas
      // recargas pós-escrita a lista simplesmente se atualiza.
      fetch(`/api/conformidade/cofre/documentos/${docId}/profissionais`, { signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
        .then((j: { data?: VinculoDoDocumento[] }) => {
          setVinculos(j.data ?? []);
          setErro(null);
          setCarregando(false);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setErro(e instanceof Error ? e.message : "Falha ao carregar os responsáveis");
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

  async function desvincular(profissionalId: string) {
    setErro(null);
    setAviso(null);
    const r = await fetch(
      `/api/conformidade/cofre/documentos/${docId}/profissionais?profissionalId=${profissionalId}`,
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
          <HardHat className="h-4 w-4 text-brand-orange" /> Responsáveis técnicos ({vinculos.length})
        </h2>
        {podeGerenciar && (
          <button
            type="button"
            onClick={() => { setAviso(null); setModal(true); }}
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
      {aviso && (
        <p className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded p-2 mb-3 text-xs text-gray-600">
          {aviso}
        </p>
      )}

      {carregando ? (
        <p className="flex items-center justify-center gap-2 text-sm text-gray-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Carregando...
        </p>
      ) : vinculos.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">
          Nenhum responsável técnico vinculado. É o que liga esta prova ao currículo do engenheiro.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {vinculos.map((v) => (
            <li
              key={v.vinculoId}
              className="flex items-start justify-between p-2 border border-gray-100 rounded-md gap-2"
            >
              <div className="flex-1 min-w-0">
                <Link
                  href={`/acervo/profissionais/${v.profissionalId}`}
                  className="text-sm font-medium text-gray-800 hover:text-brand-orange hover:underline"
                >
                  {v.nome}
                </Link>
                <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                  {v.crea ? (
                    <span className="font-mono">
                      {v.crea}
                      {v.creaUf && `/${v.creaUf}`}
                    </span>
                  ) : (
                    <span className="italic text-gray-400">CREA não informado</span>
                  )}
                  <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-medium">
                    {PAPEL_PROFISSIONAL_LABELS[v.papel]}
                  </span>
                  {v.numeroArt && <span className="font-mono">ART {v.numeroArt}</span>}
                </p>
              </div>
              {podeGerenciar && (
                <button
                  type="button"
                  onClick={() => desvincular(v.profissionalId)}
                  className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                  aria-label={`Desvincular ${v.nome}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {modal && (
        <ModalVincularProfissional
          docId={docId}
          onClose={() => setModal(false)}
          onVinculado={(atualizou) => {
            setModal(false);
            setAviso(atualizou ? "Vínculo atualizado." : null);
            carregar();
          }}
        />
      )}
    </div>
  );
}

// ── Modal de vínculo (mora aqui, como o ModalNovoProjeto da página) ─────────

function ModalVincularProfissional({
  docId,
  onClose,
  onVinculado,
}: {
  docId: string;
  onClose: () => void;
  /** `true` quando o servidor respondeu 200 (vínculo já existia e foi atualizado). */
  onVinculado: (atualizou: boolean) => void;
}) {
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [resultados, setResultados] = useState<ProfissionalBusca[]>([]);
  /** Termo cuja resposta JÁ chegou — `null` enquanto a primeira busca não voltou. */
  const [termoCarregado, setTermoCarregado] = useState<string | null>(null);
  const [escolhido, setEscolhido] = useState<ProfissionalBusca | null>(null);
  const [papel, setPapel] = useState<PapelProfissional>("RT");
  const [numeroArt, setNumeroArt] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const buscaRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose,
    initialFocusRef: buscaRef,
  });

  // Debounce de 300 ms — o mesmo do ModalVincularFamilia.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca), 300);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    const ac = new AbortController();
    const p = new URLSearchParams();
    p.set("limit", "20");
    p.set("ativo", "1");
    if (debounced) p.set("busca", debounced);
    fetch(`/api/conformidade/profissionais?${p}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))))
      .then((j: { profissionais?: ProfissionalBusca[] }) => {
        setResultados(j.profissionais ?? []);
        setTermoCarregado(debounced);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setErro(e instanceof Error ? e.message : "Falha na busca");
        setTermoCarregado(debounced);
      });
    return () => ac.abort();
  }, [debounced]);

  // Spinner DERIVADO, nunca ligado no evento: cobre a janela do debounce
  // (`busca !== debounced`) e a da rede (a resposta de `debounced` ainda não
  // chegou). Ligá-lo no `onChange` travava em "Buscando..." quando o termo
  // voltava ao valor já aplicado — `setDebounced` gravava o MESMO valor e o
  // efeito, com dep `[debounced]`, não rodava de novo para desligá-lo.
  const buscando = busca !== debounced || termoCarregado !== debounced;

  async function vincular() {
    if (!escolhido) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/profissionais`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profissionalId: escolhido.id,
          papel,
          numeroArt: numeroArt.trim() || null,
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
      // 201 = vínculo novo; 200 = já existia e teve papel/ART atualizados.
      onVinculado(r.status === 200);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao vincular");
      setSalvando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        role="dialog"
        aria-modal="true"
        aria-label="Vincular responsável técnico"
        className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 className="text-sm font-bold">Vincular responsável técnico</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 border-b border-gray-100">
          <input
            ref={buscaRef}
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome ou CREA..."
            aria-label="Buscar profissional"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-orange/30"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {buscando ? (
            <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Buscando...
            </div>
          ) : resultados.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              Nenhum profissional encontrado. Cadastre em /acervo/profissionais.
            </p>
          ) : (
            <div className="space-y-1">
              {resultados.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setEscolhido(p)}
                  aria-pressed={escolhido?.id === p.id}
                  className={
                    escolhido?.id === p.id
                      ? "w-full text-left p-3 border border-brand-orange bg-orange-50/50 rounded-lg"
                      : "w-full text-left p-3 border border-gray-100 rounded-lg hover:border-brand-orange hover:bg-orange-50/50"
                  }
                >
                  <p className="text-sm text-gray-800 font-medium">{p.nome}</p>
                  <p className="text-xs text-gray-500">
                    {p.crea ? (
                      <span className="font-mono">
                        {p.crea}
                        {p.creaUf && `/${p.creaUf}`}
                      </span>
                    ) : (
                      "CREA não informado"
                    )}
                    {p.formacao && ` · ${p.formacao}`}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1" htmlFor="papel-profissional">
                Papel
              </label>
              <select
                id="papel-profissional"
                value={papel}
                onChange={(e) => setPapel(e.target.value as PapelProfissional)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              >
                {PAPEIS_PROFISSIONAL.map((p) => (
                  <option key={p} value={p}>
                    {PAPEL_PROFISSIONAL_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1" htmlFor="numero-art">
                Nº da ART
              </label>
              <input
                id="numero-art"
                type="text"
                value={numeroArt}
                onChange={(e) => setNumeroArt(e.target.value)}
                placeholder="opcional"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
          </div>

          {erro && (
            <p role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erro}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-400">
              {escolhido ? escolhido.nome : "Escolha um profissional na lista"}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose} disabled={salvando}>
                Cancelar
              </Button>
              <Button onClick={vincular} disabled={salvando || !escolhido}>
                {salvando && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Vincular
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
