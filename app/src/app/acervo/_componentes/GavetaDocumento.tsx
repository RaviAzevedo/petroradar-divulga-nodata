"use client";

/**
 * Gaveta de Documento — a peça central da v2 (ACERVO-UI-V2 §2.3): painel
 * lateral com prévia embutida, metadados e ações (baixar/editar/excluir), com
 * navegação ←/→ dentro da lista corrente. Ficha e cofre montam a MESMA gaveta;
 * o que muda é a lista que alimenta `docs` e o que `onMudou` recarrega.
 *
 * Nenhuma rota nova: detalhe via R17 (`GET /cofre/documentos/{id}`), edição
 * pelo `ModalEditarDocumento` existente, exclusão pelo DELETE do cofre.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ChevronLeft, ChevronRight, Download, ExternalLink,
  FileText, Lock, Pencil, Trash2, X,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { useModalA11y } from "@/components/ui/useModalA11y";
import { cn, formatDate } from "@/lib/utils";
import {
  DETENTORA_LABELS,
  PAPEL_DOCUMENTO_LABELS,
  SITUACOES_PROVA,
  TIPOS_DOCUMENTO,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { SituacaoProvaBadge } from "@/app/acervo/cofre/SituacaoProvaBadge";
import {
  ModalEditarDocumento,
  type OperacaoDoDocumento,
} from "@/app/acervo/cofre/ModalEditarDocumento";
import type { DocumentoEditavel } from "@/app/acervo/cofre/editar-documento-form";
import { ChipTipoDocumento } from "./ChipTipoDocumento";
import { VisorDocumento } from "./VisorDocumento";

export interface DocGaveta {
  id: string;
  titulo: string;
  nomeArquivo?: string | null;
  contentType?: string | null;
  tipoDocumento?: string | null;
  situacaoProva?: string | null;
  numeroDocumento?: string | null;
  restrito?: boolean;
}

export interface GavetaDocumentoProps {
  /** Lista ordenada corrente — fonte da navegação ←/→. */
  docs: DocGaveta[];
  /** Doc aberto (0-based). */
  indice: number;
  onFechar(): void;
  onNavegar(indice: number): void;
  /** Depois de PATCH/DELETE ok — o chamador recarrega a lista. */
  onMudou?(): void;
  /** ADMIN. */
  podeExcluir: boolean;
  contexto: "ficha" | "cofre";
}

/**
 * Recorte de R17 que a gaveta usa: o `DocumentoEditavel` (contrato do
 * ModalEditarDocumento) mais o que o corpo exibe. O detalhe completo (famílias,
 * projetos, anexos, OCR) continua na página do cofre — "Abrir página completa".
 */
interface DetalheDocumento extends DocumentoEditavel {
  id: string;
  nomeArquivo: string;
  contentType: string | null;
  tamanhoBytes: number | null;
  versao: number;
  criadoEm: string;
  origemPath: string | null;
  operacao: OperacaoDoDocumento | null;
}

/** Listas de origem trazem strings soltas; só vira chip/selo o que é do domínio. */
function comoTipo(valor: string | null | undefined): TipoDocumento | null {
  return valor && (TIPOS_DOCUMENTO as readonly string[]).includes(valor)
    ? (valor as TipoDocumento)
    : null;
}
function comoSituacao(valor: string | null | undefined): SituacaoProva | null {
  return valor && (SITUACOES_PROVA as readonly string[]).includes(valor)
    ? (valor as SituacaoProva)
    : null;
}

function formatarTamanho(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Defesa contra API anterior à 0034 (mesma da página do cofre). */
function normalizarDetalhe(d: DetalheDocumento): DetalheDocumento {
  return {
    ...d,
    operacaoId: d.operacaoId ?? null,
    papel: d.papel ?? null,
    tipoDocumento: d.tipoDocumento ?? null,
    situacaoProva: d.situacaoProva ?? null,
    detentora: d.detentora ?? null,
    restrito: d.restrito ?? false,
    origemPath: d.origemPath ?? null,
    operacao: d.operacao ?? null,
  };
}

export function GavetaDocumento({
  docs, indice, onFechar, onNavegar, onMudou, podeExcluir, contexto,
}: GavetaDocumentoProps) {
  const tituloId = useId();
  const docLista: DocGaveta | undefined = docs[indice];
  const docId = docLista?.id;

  const [detalhe, setDetalhe] = useState<DetalheDocumento | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erroDetalhe, setErroDetalhe] = useState<"nao-encontrado" | "falha" | null>(null);
  const [editando, setEditando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const [erroExclusao, setErroExclusao] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Docs já excluídos aqui: até o chamador recarregar a lista, o índice ainda
  // aponta pra eles — mostrar skeleton em vez de buscar um 404 transitório.
  const excluidosRef = useRef<Set<string>>(new Set());

  // Slide de entrada: monta fora da tela e transiciona no frame seguinte
  // (rAF duplo garante que o estado inicial foi pintado antes da transição).
  const [entrou, setEntrou] = useState(false);
  useEffect(() => {
    let rafInterno = 0;
    const raf = requestAnimationFrame(() => {
      rafInterno = requestAnimationFrame(() => setEntrou(true));
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(rafInterno);
    };
  }, []);

  // Esc da gaveta não pode disparar por baixo do modal/confirm abertos —
  // ambos também escutam o Escape no window.
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: () => {
      if (!editando && !confirmando) onFechar();
    },
  });

  const carregarDetalhe = useCallback(async () => {
    if (!docId || excluidosRef.current.has(docId)) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setCarregando(true);
    setErroDetalhe(null);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}`, {
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      if (r.status === 404) {
        // Restrito fora de Conformidade ou removido — R17 devolve o mesmo 404.
        setDetalhe(null);
        setErroDetalhe("nao-encontrado");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as DetalheDocumento;
      if (ctrl.signal.aborted) return;
      setDetalhe(normalizarDetalhe(d));
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setDetalhe(null);
      setErroDetalhe("falha");
    } finally {
      if (!ctrl.signal.aborted) setCarregando(false);
    }
  }, [docId]);

  // Ao abrir/navegar: zera o que era do doc anterior e busca o novo detalhe.
  useEffect(() => {
    setDetalhe(null);
    setErroDetalhe(null);
    setErroExclusao(null);
    setEditando(false);
    setConfirmando(false);
    carregarDetalhe();
    return () => abortRef.current?.abort();
  }, [carregarDetalhe]);

  // Lista recarregou e o índice ficou fora do intervalo — nada a mostrar.
  useEffect(() => {
    if (indice >= docs.length) onFechar();
  }, [indice, docs.length, onFechar]);

  // Âncora por ID: quando o chamador recarrega `docs` (após editar), o doc pode
  // mudar de posição (título/tipo/data alteram a ordenação) — reancorar pelo id
  // para a gaveta não trocar de documento em silêncio. Exceção: doc excluído
  // aqui fica no comportamento por índice (avança pro vizinho).
  const idAncoraRef = useRef<string | undefined>(docId);
  const docsAntRef = useRef(docs);
  useEffect(() => {
    if (docsAntRef.current !== docs) {
      docsAntRef.current = docs;
      const ancora = idAncoraRef.current;
      if (ancora && !excluidosRef.current.has(ancora)) {
        const idx = docs.findIndex((d) => d.id === ancora);
        if (idx >= 0 && idx !== indice) {
          onNavegar(idx);
          return;
        }
      }
    }
    idAncoraRef.current = docs[indice]?.id;
  }, [docs, indice, onNavegar]);

  // Exclusão confirmada mas o reload do chamador falhou/nunca veio: sem lista
  // nova em 6s a gaveta fecharia sozinha em vez de pulsar para sempre.
  const aguardandoListaAgora = docLista != null && excluidosRef.current.has(docLista.id);
  useEffect(() => {
    if (!aguardandoListaAgora) return;
    const t = setTimeout(onFechar, 6000);
    return () => clearTimeout(t);
  }, [aguardandoListaAgora, onFechar]);

  // ←/→ navegam; ignorados com foco em campo de texto ou com modal aberto.
  useEffect(() => {
    function aoTeclar(e: KeyboardEvent) {
      if (editando || confirmando) return;
      const alvo = e.target as HTMLElement | null;
      if (
        alvo &&
        (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" ||
         alvo.tagName === "SELECT" || alvo.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft" && indice > 0) onNavegar(indice - 1);
      else if (e.key === "ArrowRight" && indice < docs.length - 1) onNavegar(indice + 1);
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [indice, docs.length, editando, confirmando, onNavegar]);

  async function excluir() {
    if (!docLista || excluindo) return;
    setExcluindo(true);
    setErroExclusao(null);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docLista.id}`, {
        method: "DELETE",
      });
      // 404 = já não existia — pro fluxo dá no mesmo: sumiu do cofre.
      if (r.ok || r.status === 404) {
        excluidosRef.current.add(docLista.id);
        setConfirmando(false);
        const temProximo = indice < docs.length - 1;
        onMudou?.();
        // Com próximo na lista, a gaveta fica aberta: quando o chamador
        // recarregar, este índice passa a apontar pro doc seguinte.
        if (!onMudou || !temProximo) onFechar();
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setErroExclusao(j.error ?? `Erro ${r.status}`);
      setConfirmando(false);
    } catch (e) {
      setErroExclusao(e instanceof Error ? e.message : "Erro ao excluir");
      setConfirmando(false);
    } finally {
      setExcluindo(false);
    }
  }

  if (!docLista) return null;

  const aguardandoLista = excluidosRef.current.has(docLista.id);
  const titulo = detalhe?.titulo ?? docLista.titulo;
  const numeroDocumento = detalhe?.numeroDocumento ?? docLista.numeroDocumento ?? null;
  const tipo = detalhe ? detalhe.tipoDocumento : comoTipo(docLista.tipoDocumento);
  const situacao = detalhe ? detalhe.situacaoProva : comoSituacao(docLista.situacaoProva);
  const restrito = detalhe?.restrito ?? docLista.restrito ?? false;
  const nomeArquivo = detalhe?.nomeArquivo ?? docLista.nomeArquivo ?? docLista.titulo;
  const contentType = detalhe?.contentType ?? docLista.contentType ?? null;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none",
          entrou ? "opacity-100" : "opacity-0"
        )}
        onClick={() => {
          if (!editando && !confirmando) onFechar();
        }}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        data-contexto={contexto}
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full max-w-3xl bg-white shadow-2xl flex flex-col",
          "transition-transform duration-200 motion-reduce:transition-none",
          entrou ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* ── Header ── */}
        <div className="flex items-start gap-3 p-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <ChipTipoDocumento tipo={tipo} />
              <SituacaoProvaBadge situacao={situacao} />
            </div>
            <h2 id={tituloId} className="text-sm font-bold text-brand-black truncate" title={titulo}>
              {titulo}
            </h2>
            {numeroDocumento && (
              <p className="text-xs text-gray-500 tabular-nums truncate" title={numeroDocumento}>
                nº {numeroDocumento}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
            <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap mr-1">
              {indice + 1} de {docs.length}
            </span>
            <button
              onClick={() => onNavegar(indice - 1)}
              disabled={indice === 0}
              aria-label="Documento anterior"
              className="p-1.5 rounded text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => onNavegar(indice + 1)}
              disabled={indice >= docs.length - 1}
              aria-label="Próximo documento"
              className="p-1.5 rounded text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              onClick={onFechar}
              aria-label="Fechar"
              className="p-1.5 rounded text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors ml-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Corpo ── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {erroDetalhe === "nao-encontrado" ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <FileText className="h-8 w-8 text-gray-300" aria-hidden="true" />
              <p className="text-sm font-semibold text-gray-700">Documento restrito ou removido</p>
              <p className="text-xs text-gray-500">
                Use as setas para seguir pros outros documentos da lista.
              </p>
            </div>
          ) : aguardandoLista ? (
            <>
              <Skeleton className="h-[58vh] min-h-[320px] rounded-lg" />
              <MetadadosSkeleton />
            </>
          ) : (
            <>
              {erroDetalhe === "falha" && (
                <div role="alert" className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                  <span className="flex items-center gap-2">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                    Não foi possível carregar os detalhes do documento.
                  </span>
                  <button
                    onClick={carregarDetalhe}
                    className="font-semibold underline underline-offset-2 hover:text-red-900 whitespace-nowrap"
                  >
                    Tentar de novo
                  </button>
                </div>
              )}

              <VisorDocumento
                docId={docLista.id}
                nomeArquivo={nomeArquivo}
                contentType={contentType}
                alturaClassName="h-[58vh] min-h-[320px]"
              />

              {detalhe ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Meta label="Categoria" valor={detalhe.categoria.replace(/_/g, " ")} />
                  <Meta label="Subcategoria" valor={detalhe.subcategoria.replace(/_/g, " ")} />
                  <Meta
                    label="Papel"
                    valor={detalhe.papel ? PAPEL_DOCUMENTO_LABELS[detalhe.papel] : "—"}
                  />
                  <Meta
                    label="Detentora"
                    valor={detalhe.detentora ? DETENTORA_LABELS[detalhe.detentora] : "—"}
                  />
                  <Meta
                    label="Emitido em"
                    valor={detalhe.emitidoEm ? formatDate(detalhe.emitidoEm) : "—"}
                  />
                  <Meta
                    label="Validade"
                    valor={
                      detalhe.validadeIndeterminada
                        ? "Indeterminada"
                        : detalhe.validadeFim
                          ? formatDate(detalhe.validadeFim)
                          : "—"
                    }
                  />
                  <Meta label="Versão" valor={`v${detalhe.versao}`} />
                  <Meta label="Tamanho" valor={formatarTamanho(detalhe.tamanhoBytes)} />
                  <Meta label="Guardado em" valor={formatDate(detalhe.criadoEm)} />
                  {detalhe.origemPath && (
                    <div className="col-span-2 min-w-0">
                      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">
                        Origem
                      </p>
                      <p
                        className="font-mono text-[11px] text-gray-600 truncate"
                        title={detalhe.origemPath}
                      >
                        {detalhe.origemPath}
                      </p>
                    </div>
                  )}
                </div>
              ) : carregando ? (
                <MetadadosSkeleton />
              ) : null}

              {restrito && (
                <div className="flex items-center gap-2.5 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                  <Lock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  Documento restrito — visível apenas para Conformidade; cada download fica
                  registrado em espelho de auditoria permanente.
                </div>
              )}
            </>
          )}
        </div>

        {erroExclusao && (
          <div role="alert" className="flex items-center gap-2 mx-4 mb-3 bg-red-50 border border-red-200 rounded-lg p-2.5 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erroExclusao}
          </div>
        )}

        {/* ── Rodapé ── */}
        <div className="flex items-center gap-2 flex-wrap p-4 border-t border-gray-100">
          <a
            href={`/api/conformidade/cofre/documentos/${docLista.id}/download`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            aria-label={`Baixar ${titulo}`}
          >
            <Download className="h-4 w-4" aria-hidden="true" /> Baixar
          </a>
          <Link
            href={`/acervo/cofre/${docLista.id}`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            aria-label={`Abrir página completa de ${titulo}`}
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir página completa
          </Link>
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditando(true)}
            disabled={!detalhe}
            title={!detalhe ? "Aguarde o detalhe carregar" : undefined}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" /> Editar
          </Button>
          {podeExcluir && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmando(true)}
              disabled={excluindo || aguardandoLista}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Excluir
            </Button>
          )}
        </div>

      </div>

      {/* Fora do painel: o translate-x do slide cria containing block e
          prenderia um `fixed` aninhado dentro da gaveta. Como irmãos (e depois
          no DOM), overlay e diálogo cobrem o viewport e ficam por cima. */}
      {editando && detalhe && (
        <ModalEditarDocumento
          doc={detalhe}
          onClose={() => setEditando(false)}
          onSaved={() => {
            setEditando(false);
            carregarDetalhe();
            onMudou?.();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmando}
        title={`Excluir "${titulo}"?`}
        message="O registro sai do cofre e o arquivo é removido do storage. Vínculos com famílias, alertas e presença em dossiês somem juntos. Esta ação não pode ser desfeita."
        confirmLabel={excluindo ? "Excluindo..." : "Excluir"}
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={excluir}
        onCancel={() => setConfirmando(false)}
      />
    </>
  );
}

function Meta({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">{label}</p>
      <p className="text-sm text-gray-700 tabular-nums truncate" title={valor}>
        {valor}
      </p>
    </div>
  );
}

function MetadadosSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      ))}
    </div>
  );
}
