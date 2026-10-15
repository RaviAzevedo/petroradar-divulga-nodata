"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Loader2, ArrowLeft, FileText, Tag, Download,
  Plus, X, Trash2, History as HistoryIcon, AlertCircle, ListTree, Building2, Pencil,
  Paperclip, Upload, Lock, Copy,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { HistoricoAuditoria } from "@/components/conformidade/HistoricoAuditoria";
import { podeExcluirDocumentoHabilitacao, podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import {
  DETENTORA_LABELS,
  PAPEL_DOCUMENTO_LABELS,
  TIPO_DOCUMENTO_LABELS,
  type Detentora,
  type PapelDocumento,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { BlocoAnotacoes } from "../../_componentes/BlocoAnotacoes";
import { SituacaoProvaBadge } from "../SituacaoProvaBadge";
import { ModalEditarDocumento, type OperacaoDoDocumento } from "../ModalEditarDocumento";
import { ProfissionaisDoDocumento } from "./ProfissionaisDoDocumento";
import { AtividadesDoDocumento } from "./AtividadesDoDocumento";
import { ItensTagDoDocumento } from "./ItensTagDoDocumento";

interface DocDetalhe {
  id: string;
  categoria: string;
  subcategoria: string;
  titulo: string;
  descricao: string | null;
  nomeArquivo: string;
  numeroDocumento: string | null;
  /**
   * 0044 (B6) — revisão de engenharia carimbada no documento ("R0", "02A").
   * OBRIGATÓRIO aqui, ao contrário do `DocumentoEditavel` (§1i): este é tipo de
   * tela, montado pelo `fetch`, e sem a chave o modal de edição abriria com o
   * campo em branco num documento que TEM revisão gravada — o diff não mandaria
   * nada e o campo "sumiria" ao editar.
   */
  revisao: string | null;
  emitidoEm: string | null;
  validadeFim: string | null;
  validadeIndeterminada: boolean;
  status: string;
  versao: number;
  tags: string[] | null;
  contentType: string | null;
  tamanhoBytes: number | null;
  ocrTexto: string | null;
  ocrConfianca: number | null;
  uploadadoPorNome: string | null;
  criadoEm: string;
  // 0033/0034 — vínculo com a operação e campos do dossiê (R17 §16.1)
  operacaoId: string | null;
  papel: PapelDocumento | null;
  tipoDocumento: TipoDocumento | null;
  situacaoProva: SituacaoProva | null;
  detentora: Detentora | null;
  restrito: boolean;
  importJobId: string | null;
  origemPath: string | null;
  /** 0043 — disciplina do documento; alimenta o `<select>` do modal de edição. */
  disciplinaId: string | null;
  operacao: OperacaoDoDocumento | null;
  familias: Array<{ familiaId: string; codigoCrc: string; nome: string; status: string; observacao: string | null }>;
  projetos: Array<{ id: string; clienteNome: string; projetoNome: string; valorContrato: string | null;
                    periodoInicio: string | null; periodoFim: string | null }>;
  anexos: Array<{
    id: string;
    tipo: string;
    titulo: string | null;
    nomeArquivo: string;
    tamanhoBytes: number | null;
    contentType: string | null;
    uploadadoPorNome: string | null;
    criadoEm: string;
  }>;
}

interface FamiliaSugerida { id: string; codigoCrc: string; nome: string; }

export default function DocCofreDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: session } = useSession();
  const [doc, setDoc] = useState<DocDetalhe | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [vinculoModal, setVinculoModal] = useState(false);
  const [projetoModal, setProjetoModal] = useState(false);
  // "operacao" abre o editor já na busca de operação (botão Vincular do card).
  const [editModal, setEditModal] = useState<false | "normal" | "operacao">(false);
  const [confirmaExclusao, setConfirmaExclusao] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const [erroExclusao, setErroExclusao] = useState<string | null>(null);
  const [ingestaoCopiada, setIngestaoCopiada] = useState(false);

  // Botão só existe para quem PODE excluir (ADMIN) — regra de não anunciar
  // poder que o papel não tem; a barreira real é a API (R9).
  const podeExcluir = Boolean(session?.user && podeExcluirDocumentoHabilitacao(session.user.role));
  /**
   * Escrita dos dois blocos novos (RT e atividades da ART). Hoje é sempre
   * `true` para quem chega aqui — o `layout.tsx` do cofre já barra em
   * `isConformidade`, que está contido em `podeGerenciarDocumentosHabilitacao`.
   * Existe assim mesmo porque o botão tem de NOMEAR a permissão de que depende:
   * se o guard do segmento afrouxar, os botões não vão junto sozinhos. A
   * barreira real continua sendo a rota, que revalida (§5.6/§5.7).
   */
  const podeGerenciar = Boolean(session?.user && podeGerenciarDocumentosHabilitacao(session.user.role));

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${id}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = (await r.json()) as DocDetalhe;
      // Defesa contra API anterior à 0034 (implantação em ondas): os campos
      // novos ganham default para a tela não quebrar com `undefined`.
      setDoc({
        ...d,
        operacaoId: d.operacaoId ?? null,
        papel: d.papel ?? null,
        tipoDocumento: d.tipoDocumento ?? null,
        situacaoProva: d.situacaoProva ?? null,
        detentora: d.detentora ?? null,
        restrito: d.restrito ?? false,
        importJobId: d.importJobId ?? null,
        origemPath: d.origemPath ?? null,
        disciplinaId: d.disciplinaId ?? null,
        // 0044 — mesma defesa: antes do commit 2 o BFF ainda não devolve a
        // chave, e `undefined` no formulário do modal viraria "undefined".
        revisao: d.revisao ?? null,
        operacao: d.operacao ?? null,
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar documento");
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { carregar(); }, [carregar]);

  async function excluir() {
    setExcluindo(true);
    setErroExclusao(null);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${id}`, { method: "DELETE" });
      // 404 = já não existia — o destino é o mesmo do sucesso: voltar ao cofre.
      if (r.ok || r.status === 404) {
        router.push("/acervo/cofre");
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setErroExclusao(j.error ?? `Erro ${r.status}`);
      setConfirmaExclusao(false);
    } catch (e) {
      setErroExclusao(e instanceof Error ? e.message : "Erro ao excluir");
      setConfirmaExclusao(false);
    } finally {
      setExcluindo(false);
    }
  }

  async function copiarIngestao(importJobId: string) {
    try {
      await navigator.clipboard.writeText(importJobId);
      setIngestaoCopiada(true);
      setTimeout(() => setIngestaoCopiada(false), 2000);
    } catch {
      // clipboard indisponível (HTTP puro) — sem drama, o id está no title.
    }
  }

  async function desvincularFamilia(familiaId: string) {
    await fetch(`/api/conformidade/cofre/documentos/${id}/familias?familiaId=${familiaId}`, { method: "DELETE" });
    carregar();
  }
  async function removerProjeto(projetoId: string) {
    await fetch(`/api/conformidade/cofre/documentos/${id}/projetos?projetoId=${projetoId}`, { method: "DELETE" });
    carregar();
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-brand-orange" /></div>;
  }

  if (erro) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertCircle className="h-8 w-8 text-red-500 mb-3" />
        <p className="text-sm font-semibold text-gray-700 mb-1">Não foi possível carregar o documento</p>
        <p className="text-xs text-gray-500 mb-4">{erro}</p>
        <Button onClick={carregar}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <FileText className="h-8 w-8 text-gray-300 mb-3" />
        <p className="text-sm font-semibold text-gray-700 mb-1">Documento não encontrado</p>
        <Link href="/acervo/cofre" className="text-xs text-brand-orange hover:underline mt-2">Voltar pro cofre</Link>
      </div>
    );
  }

  const isPdf = doc.contentType === "application/pdf" || doc.nomeArquivo.toLowerCase().endsWith(".pdf");

  return (
    <div>
      <Link href="/acervo/cofre" className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 mb-2">
        <ArrowLeft className="h-3.5 w-3.5" /> Voltar pro cofre
      </Link>

      <div className="flex items-start justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-black flex items-center gap-3">
            <FileText className="h-6 w-6 text-brand-orange" />
            {doc.titulo}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{doc.subcategoria.replace(/_/g, " ")} · v{doc.versao}</span>
            {doc.tipoDocumento && (
              <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">
                {TIPO_DOCUMENTO_LABELS[doc.tipoDocumento]}
              </span>
            )}
            <SituacaoProvaBadge situacao={doc.situacaoProva} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setEditModal("normal")} className="rounded-md">
            <Pencil className="h-3.5 w-3.5" /> Editar
          </Button>
          {podeExcluir && (
            <button
              onClick={() => setConfirmaExclusao(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-md hover:bg-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" /> Excluir
            </button>
          )}
          <a
            href={`/api/conformidade/cofre/documentos/${id}/download`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-md hover:bg-gray-700"
          >
            <Download className="h-3.5 w-3.5" /> Baixar
          </a>
        </div>
      </div>

      {erroExclusao && (
        <div role="alert" className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" /> {erroExclusao}
        </div>
      )}

      {/* Faixa de restrito — acima do preview (03-FRONTEND §8.2). O fluxo (f)
          do plano acrescenta a pista do espelho permanente para quem audita. */}
      {doc.restrito && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 text-sm text-amber-800">
          <Lock className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">
              Documento restrito — visível apenas para Conformidade. Cada download fica
              registrado em espelho de auditoria permanente.
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              registro permanente de downloads: consulte a Conformidade
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
        {/* Preview */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-3 min-h-[400px]">
          {isPdf ? (
            <object
              data={`/api/conformidade/cofre/documentos/${id}/download?inline=1`}
              type="application/pdf"
              className="w-full h-[600px] rounded-md"
            >
              <p className="p-6 text-sm text-gray-500 text-center">
                Não foi possível visualizar o PDF inline.
                <a href={`/api/conformidade/cofre/documentos/${id}/download`} className="text-brand-orange ml-1 hover:underline">
                  Baixar arquivo
                </a>
              </p>
            </object>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <FileText className="h-12 w-12 mb-3" />
              <p className="text-sm">Preview disponível só pra PDF.</p>
              <a href={`/api/conformidade/cofre/documentos/${id}/download`} className="mt-3 text-xs text-brand-orange hover:underline">
                Baixar arquivo
              </a>
            </div>
          )}
        </div>

        {/* Metadados */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Metadados</h2>
          <Meta label="Categoria" value={doc.categoria} />
          <Meta label="Subcategoria" value={doc.subcategoria} />
          <Meta label="Status" value={doc.status} />
          {doc.numeroDocumento && <Meta label="Número" value={doc.numeroDocumento} />}
          {/* B6 — logo depois do número: número e revisão são a identidade que a
              ENGENHARIA carimbou. "Versão" (v2 substitui v1) é outra coisa. */}
          {doc.revisao && <Meta label="Revisão" value={doc.revisao} />}
          {doc.emitidoEm && <Meta label="Emitido em" value={formatDate(doc.emitidoEm)} />}
          {doc.validadeIndeterminada
            ? <Meta label="Validade" value="Indeterminada" />
            : doc.validadeFim
              ? <Meta label="Validade" value={formatDate(doc.validadeFim)} />
              : <Meta label="Validade" value="—" />}
          <Meta label="Tamanho" value={doc.tamanhoBytes ? `${(doc.tamanhoBytes/1024).toFixed(1)} KB` : "—"} />
          {/* Campos do dossiê (0034). Tipo NULL exibe sempre "Sem tipo definido",
              nunca "—" (§2.1 do plano); situação só quando diz algo (selo A21). */}
          <Meta
            label="Tipo (dossiê)"
            value={doc.tipoDocumento ? TIPO_DOCUMENTO_LABELS[doc.tipoDocumento] : "Sem tipo definido"}
          />
          {doc.situacaoProva && doc.situacaoProva !== "INDEFINIDA" && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">Situação da prova</p>
              <div className="mt-0.5"><SituacaoProvaBadge situacao={doc.situacaoProva} /></div>
            </div>
          )}
          {doc.detentora && <Meta label="Detentora" value={DETENTORA_LABELS[doc.detentora]} />}
          {doc.origemPath && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">Origem</p>
              <p className="font-mono text-[11px] text-gray-600 truncate" title={doc.origemPath}>
                {doc.origemPath}
              </p>
            </div>
          )}
          {doc.importJobId && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">Ingestão</p>
              <p className="text-sm text-gray-700 flex items-center gap-1.5">
                <span className="font-mono text-xs" title={doc.importJobId}>
                  {doc.importJobId.slice(0, 8)}
                </span>
                <button
                  onClick={() => copiarIngestao(doc.importJobId as string)}
                  className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                  aria-label="Copiar identificador da ingestão"
                  title="Copiar identificador completo"
                >
                  <Copy className="h-3 w-3" />
                </button>
                <span aria-live="polite" className="text-[10px] text-emerald-600">
                  {ingestaoCopiada ? "copiado" : ""}
                </span>
              </p>
            </div>
          )}
          {doc.uploadadoPorNome && <Meta label="Upload por" value={doc.uploadadoPorNome} />}
          {doc.tags && doc.tags.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-1">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {doc.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-[11px] text-gray-700">
                    <Tag className="h-2.5 w-2.5" /> {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {doc.ocrConfianca != null && (
            <div className="pt-3 border-t border-gray-100">
              <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 mb-1">OCR</p>
              <p className="text-xs text-gray-500">Confiança: {(doc.ocrConfianca * 100).toFixed(0)}%</p>
              {doc.ocrTexto && <p className="text-xs text-gray-600 mt-1 line-clamp-3">{doc.ocrTexto}</p>}
            </div>
          )}
        </div>
      </div>

      {/* Operação (0033) — o caminho UNITÁRIO de adoção (ADR-04): o botão
          Vincular abre o editor direto na busca de operação. */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-brand-black flex items-center gap-2 mb-3">
          <Building2 className="h-4 w-4 text-brand-orange" /> Operação
        </h2>
        {doc.operacao ? (
          <div className="flex items-center gap-2.5 flex-wrap">
            <Link
              href={`/acervo/operacoes/${doc.operacao.id}`}
              className="font-mono text-sm font-bold text-brand-orange hover:underline"
            >
              {doc.operacao.codigo}
            </Link>
            <Link
              href={`/acervo/operacoes/${doc.operacao.id}`}
              className="text-sm text-gray-800 hover:text-brand-orange"
            >
              {doc.operacao.clienteNome}
            </Link>
            {doc.papel && (
              <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">
                {PAPEL_DOCUMENTO_LABELS[doc.papel]}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-sm text-gray-500">
              Sem operação — esta prova não entra em nenhum dossiê.
            </p>
            <button
              onClick={() => setEditModal("operacao")}
              className="text-xs px-3 py-1.5 bg-orange-50 text-brand-orange border border-orange-200 rounded hover:bg-orange-100 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" /> Vincular
            </button>
          </div>
        )}
      </div>

      {/* Famílias vinculadas */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-brand-black flex items-center gap-2">
            <ListTree className="h-4 w-4 text-brand-orange" /> Famílias CRC vinculadas ({doc.familias.length})
          </h2>
          <button
            onClick={() => setVinculoModal(true)}
            className="text-xs px-3 py-1.5 bg-orange-50 text-brand-orange border border-orange-200 rounded hover:bg-orange-100 flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Vincular família
          </button>
        </div>
        {doc.familias.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            Nenhuma família vinculada. Use o botão acima pra associar.
          </p>
        ) : (
          <div className="space-y-1.5">
            {doc.familias.map((f) => (
              <div key={f.familiaId} className="flex items-center justify-between p-2 border border-gray-100 rounded-md">
                <div>
                  <Link href={`/acervo/familias/${f.familiaId}`} className="font-mono text-xs font-bold text-brand-orange hover:underline">{f.codigoCrc}</Link>
                  <p className="text-sm text-gray-700">{f.nome}</p>
                </div>
                <button
                  onClick={() => desvincularFamilia(f.familiaId)}
                  className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                  aria-label="Desvincular"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Projetos (ACTs) */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-brand-black flex items-center gap-2">
            <Building2 className="h-4 w-4 text-brand-orange" /> Projetos / clientes ({doc.projetos.length})
          </h2>
          <button
            onClick={() => setProjetoModal(true)}
            className="text-xs px-3 py-1.5 bg-orange-50 text-brand-orange border border-orange-200 rounded hover:bg-orange-100 flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Adicionar projeto
          </button>
        </div>
        {doc.projetos.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            Nenhum projeto registrado. Útil pra ACTs que comprovam capacidade técnica.
          </p>
        ) : (
          <div className="space-y-1.5">
            {doc.projetos.map((p) => (
              <div key={p.id} className="flex items-start justify-between p-2 border border-gray-100 rounded-md">
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-800">{p.projetoNome}</p>
                  <p className="text-xs text-gray-500">
                    {p.clienteNome}
                    {p.periodoInicio && ` · ${formatDate(p.periodoInicio)}`}
                    {p.periodoFim && ` → ${formatDate(p.periodoFim)}`}
                    {p.valorContrato && ` · R$ ${parseFloat(p.valorContrato).toLocaleString("pt-BR")}`}
                  </p>
                </div>
                <button
                  onClick={() => removerProjeto(p.id)}
                  className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                  aria-label="Remover"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Responsáveis técnicos e atividades da ART (0043) — cada um com o
          próprio fetch da satélite, para a página não crescer. A GavetaDocumento
          NÃO ganha estes blocos (§1l): a gaveta é prévia, não segunda página. */}
      <ProfissionaisDoDocumento docId={id} podeGerenciar={podeGerenciar} />
      <AtividadesDoDocumento docId={id} podeGerenciar={podeGerenciar} />

      {/* Itens com TAG (Q9, 0044) — depois de "Projetos" e ao lado dos blocos
          da onda 4: a ordem do miolo é "quem assinou → o que fez → o que tem
          TAG", que é a ordem em que se lê uma ART. Sem tela própria e sem nada
          no Sidebar/nav-access/CommandPalette (§1f). */}
      <ItensTagDoDocumento docId={id} podeEditar={podeGerenciar} />

      {/* Anexos extras */}
      <AnexosSection docId={id} anexos={doc.anexos ?? []} onChange={carregar} />

      {/* Anotações (B7) — ANTES do "Histórico" de propósito: anotação é o que
          uma pessoa escreveu; o histórico é o que o sistema registrou. Ler na
          ordem "o que se sabe → o que aconteceu" é a ordem em que se investiga
          um documento. */}
      <BlocoAnotacoes
        alvoTipo="DOCUMENTO"
        alvoId={id}
        titulo="Anotações"
        podeEscrever={podeGerenciar}
        usuarioId={session?.user?.id ?? null}
        ehAdmin={session?.user?.role === "ADMIN"}
      />

      {/* Histórico */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-brand-black mb-3 flex items-center gap-2">
          <HistoryIcon className="h-4 w-4 text-gray-400" /> Histórico
        </h2>
        <HistoricoAuditoria entidade="documento_habilitacao" entidadeId={id} maxHeight="280px" />
      </div>

      {vinculoModal && (
        <ModalVincularFamilia
          docId={id}
          onClose={() => setVinculoModal(false)}
          onSelect={async (familiaId) => {
            await fetch(`/api/conformidade/cofre/documentos/${id}/familias`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ familiaId }),
            });
            setVinculoModal(false);
            carregar();
          }}
        />
      )}

      {projetoModal && (
        <ModalNovoProjeto
          docId={id}
          onClose={() => setProjetoModal(false)}
          onCreated={() => { setProjetoModal(false); carregar(); }}
        />
      )}

      {editModal && (
        <ModalEditarDocumento
          doc={doc}
          focoInicial={editModal === "operacao" ? "operacao" : undefined}
          onClose={() => setEditModal(false)}
          onSaved={() => { setEditModal(false); carregar(); }}
        />
      )}

      {/* Confirmação de exclusão (R9 — só ADMIN chega aqui). O texto diz o que
          acontece com o blob: é contrato com o usuário (03-FRONTEND §8.4). */}
      <ConfirmDialog
        open={confirmaExclusao}
        title={`Excluir "${doc.titulo}"?`}
        message="O registro sai do cofre e o arquivo é removido do MinIO (a remoção do arquivo é best-effort: se o storage falhar, o registro some assim mesmo e o blob órfão é recolhido pela rotina de manutenção). Vínculos com famílias, alertas e presença em dossiês somem juntos. Esta ação não pode ser desfeita."
        confirmLabel={excluindo ? "Excluindo..." : "Excluir"}
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={excluir}
        onCancel={() => setConfirmaExclusao(false)}
      />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">{label}</p>
      <p className="text-sm text-gray-700">{value}</p>
    </div>
  );
}

function ModalVincularFamilia({
  docId, onClose, onSelect,
}: { docId: string; onClose: () => void; onSelect: (familiaId: string) => void }) {
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<FamiliaSugerida[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca), 300);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    setLoading(true);
    const p = new URLSearchParams();
    p.set("limit", "20");
    p.set("status", "ATIVA");
    if (debounced) p.set("busca", debounced);
    fetch(`/api/conformidade/familias?${p}`)
      .then((r) => r.json())
      .then((j) => { setResults(j.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [debounced]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 className="text-sm font-bold">Vincular família CRC</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 border-b border-gray-100">
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por código ou nome..."
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-orange/30"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Buscando...</div>
          ) : results.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">Nenhuma família ativa encontrada.</p>
          ) : (
            <div className="space-y-1">
              {results.map((f) => (
                <button
                  key={f.id}
                  onClick={() => onSelect(f.id)}
                  className="w-full text-left p-3 border border-gray-100 rounded-lg hover:border-brand-orange hover:bg-orange-50/50"
                >
                  <span className="font-mono text-xs font-bold text-gray-800">{f.codigoCrc}</span>
                  <p className="text-sm text-gray-700">{f.nome}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ModalNovoProjeto({
  docId, onClose, onCreated,
}: { docId: string; onClose: () => void; onCreated: () => void }) {
  const [clienteNome, setClienteNome] = useState("");
  const [projetoNome, setProjetoNome] = useState("");
  const [valor, setValor] = useState("");
  const [inicio, setInicio] = useState("");
  const [fim, setFim] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function submit() {
    setErro(null);
    if (!clienteNome.trim() || !projetoNome.trim()) {
      setErro("Cliente e nome do projeto são obrigatórios");
      return;
    }
    setSubmitting(true);
    try {
      const valorNum = valor ? parseFloat(valor.replace(",", ".")) : undefined;
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/projetos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clienteNome: clienteNome.trim(),
          projetoNome: projetoNome.trim(),
          valorContrato: valorNum && !isNaN(valorNum) ? valorNum : undefined,
          periodoInicio: inicio ? new Date(inicio).toISOString() : undefined,
          periodoFim:    fim    ? new Date(fim).toISOString()    : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErro(j.error ?? `Erro ${r.status}`); setSubmitting(false); return; }
      onCreated();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Adicionar projeto / cliente</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Cliente</label>
            <input value={clienteNome} onChange={(e) => setClienteNome(e.target.value)} placeholder="Petrobras / Cenpes / ..." className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Nome do projeto</label>
            <input value={projetoNome} onChange={(e) => setProjetoNome(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Início</label>
              <input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Fim</label>
              <input type="date" value={fim} onChange={(e) => setFim(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Valor (R$)</label>
            <input type="text" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>
          {erro && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5" /> {erro}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">Cancelar</button>
          <Button onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Adicionar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Anexos extras ───────────────────────────────────────────────────────────

const TIPO_ANEXO_LABEL: Record<string, string> = {
  ANEXO:        "Anexo",
  COMPLEMENTAR: "Complementar",
  RETIFICACAO:  "Retificação",
  OUTRO:        "Outro",
};

interface AnexoRow {
  id: string;
  tipo: string;
  titulo: string | null;
  nomeArquivo: string;
  tamanhoBytes: number | null;
  contentType: string | null;
  uploadadoPorNome: string | null;
  criadoEm: string;
}

function AnexosSection({
  docId, anexos, onChange,
}: { docId: string; anexos: AnexoRow[]; onChange: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [novoTipo, setNovoTipo] = useState("ANEXO");
  const [novoTitulo, setNovoTitulo] = useState("");
  const [editando, setEditando] = useState<string | null>(null);
  // ID do anexo aguardando confirmação de exclusão (substitui window.confirm)
  const [excluindoId, setExcluindoId] = useState<string | null>(null);

  async function uploadFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setErro(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("tipo", novoTipo);
      if (novoTitulo.trim()) fd.append("titulo", novoTitulo.trim());
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/anexos`, { method: "POST", body: fd });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErro(j.error ?? `Erro ${r.status}`);
      } else {
        setNovoTitulo("");
        onChange();
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro");
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  async function confirmarExclusao() {
    const anexoId = excluindoId;
    if (!anexoId) return;
    setExcluindoId(null);
    setErro(null);
    const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/anexos/${anexoId}`, { method: "DELETE" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErro(j.error ?? `Erro ${r.status}`);
      return;
    }
    onChange();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-brand-black flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-brand-orange" />
          Anexos extras ({anexos.length})
        </h2>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={novoTipo}
            onChange={(e) => setNovoTipo(e.target.value)}
            disabled={uploading}
            className="px-2 py-1.5 text-xs border border-gray-200 rounded"
          >
            {Object.entries(TIPO_ANEXO_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <input
            type="text"
            value={novoTitulo}
            onChange={(e) => setNovoTitulo(e.target.value)}
            disabled={uploading}
            placeholder="Título (opcional)"
            className="px-2 py-1.5 text-xs border border-gray-200 rounded w-40"
          />
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-50 text-brand-orange border border-orange-200 rounded text-xs font-semibold cursor-pointer hover:bg-orange-100 transition-colors">
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            {uploading ? "Enviando..." : "Adicionar anexo"}
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.doc,.docx,.png,.jpg,.jpeg"
              onChange={uploadFile}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      </div>

      <p className="text-xs text-gray-400 mb-3">
        Use para anexar documentos auxiliares — ART + CAT do mesmo engenheiro, balanço + DRE, retificações etc.
      </p>

      {erro && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700 mb-3">
          <AlertCircle className="h-3.5 w-3.5" /> {erro}
        </div>
      )}

      {anexos.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">
          Nenhum anexo extra. Use o botão acima para subir.
        </p>
      ) : (
        <div className="space-y-1.5">
          {anexos.map((a) => (
            editando === a.id ? (
              <AnexoEditarRow
                key={a.id}
                docId={docId}
                anexo={a}
                onCancel={() => setEditando(null)}
                onSaved={() => { setEditando(null); onChange(); }}
              />
            ) : (
              <div key={a.id} className="flex items-start justify-between p-2 border border-gray-100 rounded-md gap-2">
                <a
                  href={`/api/conformidade/cofre/documentos/${docId}/anexos/${a.id}/download`}
                  className="flex items-start gap-2 flex-1 min-w-0 hover:bg-gray-50 rounded p-1 -m-1"
                >
                  <FileText className="h-4 w-4 text-gray-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {a.titulo || a.nomeArquivo}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 mr-1.5 text-[10px] font-medium">
                        {TIPO_ANEXO_LABEL[a.tipo] ?? a.tipo}
                      </span>
                      {a.nomeArquivo}
                      {a.tamanhoBytes && ` · ${(a.tamanhoBytes / 1024).toFixed(0)} KB`}
                      {a.uploadadoPorNome && ` · por ${a.uploadadoPorNome}`}
                    </p>
                  </div>
                </a>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => setEditando(a.id)}
                    className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                    aria-label="Editar"
                    title="Editar título/tipo"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setExcluindoId(a.id)}
                    className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                    aria-label="Remover"
                    title="Remover"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )
          ))}
        </div>
      )}

      <ConfirmDialog
        open={excluindoId !== null}
        title="Remover anexo"
        message="Tem certeza que deseja remover este anexo? Esta ação não pode ser desfeita."
        confirmLabel="Remover"
        variant="danger"
        onConfirm={confirmarExclusao}
        onCancel={() => setExcluindoId(null)}
      />
    </div>
  );
}

function AnexoEditarRow({
  docId, anexo, onCancel, onSaved,
}: { docId: string; anexo: AnexoRow; onCancel: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState(anexo.tipo);
  const [titulo, setTitulo] = useState(anexo.titulo ?? "");
  const [saving, setSaving] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar() {
    setErro(null);
    setSaving(true);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/anexos/${anexo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo, titulo: titulo.trim() || null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErro(j.error ?? `Erro ${r.status}`);
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro");
      setSaving(false);
    }
  }

  return (
    <div className="border border-orange-200 bg-orange-50/40 rounded-md p-3 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="md:col-span-1">
          <label className="block text-[10px] uppercase tracking-wide font-semibold text-gray-500 mb-0.5">Tipo</label>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded">
            {Object.entries(TIPO_ANEXO_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="block text-[10px] uppercase tracking-wide font-semibold text-gray-500 mb-0.5">Título</label>
          <input
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder={anexo.nomeArquivo}
            className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded"
          />
        </div>
      </div>
      <p className="text-[10px] text-gray-400">Arquivo: {anexo.nomeArquivo} (não pode ser substituído — exclua e adicione um novo se precisar)</p>
      {erro && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-1.5 text-[11px] text-red-700">
          <AlertCircle className="h-3 w-3" /> {erro}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 rounded">Cancelar</button>
        <Button size="sm" onClick={salvar} disabled={saving} className="gap-1 px-3 py-1 rounded">
          {saving && <Loader2 className="h-3 w-3 animate-spin" />} Salvar
        </Button>
      </div>
    </div>
  );
}

