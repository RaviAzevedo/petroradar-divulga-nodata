"use client";

/**
 * Modal de edição do documento — estendido para os campos da 0033/0034
 * (03-FRONTEND §8.3): operação (vincular/trocar/desvincular), papel, tipo do
 * dossiê, situação da prova, detentora e restrito, além dos metadados que o
 * modal antigo já editava (título, descrição, categoria, datas, tags).
 *
 * O PATCH manda SÓ o que mudou (diff em `montarPatchDocumento`) — o audit de
 * R8 registra antes/depois apenas dos campos presentes no body. Erros de campo
 * de R8 grudam no campo certo: 422 OPERACAO_NAO_ENCONTRADA no campo Operação,
 * 403 de restrição no toggle Restrito (o resto do formulário segue editável).
 */

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Building2, Info, Loader2, Lock, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import {
  CATEGORIA_LABELS,
  SUBCATEGORIA_LABELS,
  SUBCATEGORIA_TO_CATEGORIA,
} from "@/lib/conformidade/cofre/validations";
import {
  DETENTORAS,
  DETENTORA_LABELS,
  PAPEIS_DOCUMENTO,
  PAPEL_DOCUMENTO_LABELS,
  SITUACOES_PROVA,
  TIPOS_DOCUMENTO,
  TIPO_DOCUMENTO_LABELS,
  type Detentora,
  type PapelDocumento,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { SITUACAO_PROVA_BADGE } from "./SituacaoProvaBadge";
import { BuscaOperacaoCombobox } from "./BuscaOperacaoCombobox";
import {
  formularioInicial,
  montarPatchDocumento,
  tipoESubcategoriaDivergem,
  type DocumentoEditavel,
} from "./editar-documento-form";

/** Linha do catálogo (GET /api/conformidade/disciplinas) — popula o `<select>`. */
interface DisciplinaCatalogo {
  id: string;
  codigo: string;
  nome: string;
}

/** Recorte da operação vinculada, como R17 devolve no objeto `operacao`. */
export interface OperacaoDoDocumento {
  id: string;
  codigo: string;
  clienteNome: string;
}

interface Props {
  doc: DocumentoEditavel & { id: string; operacao: OperacaoDoDocumento | null };
  /** "operacao" abre o modal já na busca de operação (botão Vincular do card). */
  focoInicial?: "operacao";
  onClose: () => void;
  onSaved: () => void;
}

/** Corpo de erro das rotas do módulo (422 traz `detalhes`, alguns 422 trazem `code`). */
interface CorpoErro {
  error?: string;
  code?: string;
  detalhes?: Record<string, string>;
}

export function ModalEditarDocumento({ doc, focoInicial, onClose, onSaved }: Props) {
  const tituloId = useId();
  const buscaRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose,
    initialFocusRef: focoInicial === "operacao" ? buscaRef : undefined,
  });

  const [form, setForm] = useState(() => formularioInicial(doc));
  // Cartão da operação vinculada (código + cliente). Muda junto com form.operacaoId.
  const [opCartao, setOpCartao] = useState<OperacaoDoDocumento | null>(doc.operacao);
  const [buscandoOperacao, setBuscandoOperacao] = useState(focoInicial === "operacao");

  // 0043 — catálogo de disciplinas: sem este `<select>`, `disciplina_id`
  // nasceria e morreria vazia e o filtro do cofre nunca teria o que filtrar.
  const [catalogoDisciplinas, setCatalogoDisciplinas] = useState<DisciplinaCatalogo[]>([]);

  const [saving, setSaving] = useState(false);
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [erroOperacao, setErroOperacao] = useState<string | null>(null);
  const [erroRestrito, setErroRestrito] = useState<string | null>(null);

  // UMA chamada ao abrir (o modal já busca operações; esta é a segunda), com
  // `AbortController` no cleanup. Falha deixa o `<select>` só com "— sem
  // disciplina": o resto do formulário continua editável.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/conformidade/disciplinas", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { disciplinas?: DisciplinaCatalogo[] } | null) => {
        if (j?.disciplinas) setCatalogoDisciplinas(j.disciplinas);
      })
      .catch(() => {
        /* best-effort: sem catálogo, o campo fica vazio */
      });
    return () => ac.abort();
  }, []);

  function mudar<K extends keyof typeof form>(campo: K, valor: (typeof form)[K]) {
    setForm((f) => ({ ...f, [campo]: valor }));
  }

  function onChangeSub(novo: string) {
    mudar("subcategoria", novo);
    const inferida = SUBCATEGORIA_TO_CATEGORIA[novo as keyof typeof SUBCATEGORIA_TO_CATEGORIA];
    if (inferida) mudar("categoria", inferida);
  }

  function escolherOperacao(op: OperacaoDoDocumento) {
    setOpCartao(op);
    mudar("operacaoId", op.id);
    setBuscandoOperacao(false);
    setErroOperacao(null);
  }

  function desvincular() {
    setOpCartao(null);
    mudar("operacaoId", null);
    setBuscandoOperacao(false);
  }

  const desvinculando = doc.operacaoId !== null && form.operacaoId === null;
  const divergencia = tipoESubcategoriaDivergem(form.tipoDocumento, form.subcategoria);

  async function salvar() {
    setErroGeral(null);
    setErroOperacao(null);
    setErroRestrito(null);

    if (form.titulo.trim().length < 2) {
      setErroGeral("Título precisa de pelo menos 2 caracteres");
      return;
    }

    const body = montarPatchDocumento(doc, form);
    if (Object.keys(body).length === 0) {
      // Nada mudou — fechar sem PATCH evita audit vazio.
      onClose();
      return;
    }

    setSaving(true);
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const corpo = (await r.json().catch(() => ({}))) as CorpoErro;
        // Erro de campo gruda no campo (regras de R8); o resto segue editável.
        if (r.status === 422 && corpo.code === "OPERACAO_NAO_ENCONTRADA") {
          setErroOperacao(corpo.error ?? "Operação não encontrada");
        } else if (r.status === 403 && "restrito" in body) {
          setErroRestrito(corpo.error ?? "Apenas Conformidade pode alterar a restrição de acesso");
        } else if (corpo.detalhes && Object.keys(corpo.detalhes).length > 0) {
          setErroGeral(
            Object.entries(corpo.detalhes)
              .map(([campo, msg]) => `${campo}: ${msg}`)
              .join(" · ")
          );
        } else {
          setErroGeral(corpo.error ?? `Erro ${r.status}`);
        }
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) {
      setErroGeral(e instanceof Error ? e.message : "Erro");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh] pb-[5vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 id={tituloId} className="text-sm font-bold flex items-center gap-2">
            <Pencil className="h-4 w-4 text-brand-orange" /> Editar documento
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Título</label>
            <input
              value={form.titulo}
              onChange={(e) => mudar("titulo", e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Descrição</label>
            <textarea
              value={form.descricao}
              onChange={(e) => mudar("descricao", e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Subcategoria</label>
              <select
                value={form.subcategoria}
                onChange={(e) => onChangeSub(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              >
                {(Object.keys(SUBCATEGORIA_LABELS) as Array<keyof typeof SUBCATEGORIA_LABELS>).map((k) => (
                  <option key={k} value={k}>{SUBCATEGORIA_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Categoria</label>
              <select
                value={form.categoria}
                onChange={(e) => mudar("categoria", e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              >
                {(Object.keys(CATEGORIA_LABELS) as Array<keyof typeof CATEGORIA_LABELS>).map((k) => (
                  <option key={k} value={k}>{CATEGORIA_LABELS[k]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Número do documento</label>
              <input
                value={form.numeroDocumento}
                onChange={(e) => mudar("numeroDocumento", e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            {/* B6 (0044) — revisão de engenharia, ao lado do NÚMERO e nunca ao
                lado da "Versão": `versao` é o versionamento de certidão do
                cofre (v2 substitui v1), e "R1" ali pareceria segunda versão de
                um documento que nunca foi substituído (§1h). O placeholder com
                três formatos é a tela dizendo que não há gramática única — o
                carimbo do cliente não é recusado. */}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Revisão</label>
              <input
                value={form.revisao}
                onChange={(e) => mudar("revisao", e.target.value)}
                maxLength={20}
                placeholder="R0, 02A, Rev. C"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => mudar("status", e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              >
                <option value="VIGENTE">Vigente</option>
                <option value="EM_RENOVACAO">Em renovação</option>
                <option value="VENCIDO">Vencido</option>
                <option value="SUBSTITUIDO">Substituído</option>
              </select>
            </div>
          </div>

          {/* ── Campos do dossiê (0033/0034) — acima do bloco de datas (§8.3) ── */}
          <div className="border border-gray-100 rounded-lg p-3 space-y-3 bg-gray-50/50">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Operação</label>
              {opCartao ? (
                <div className="rounded-lg border border-brand-orange/40 bg-orange-50/40 p-2.5 flex items-center gap-2.5">
                  <Building2 className="h-4 w-4 text-brand-orange flex-shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-xs font-bold text-gray-900 mr-2">{opCartao.codigo}</span>
                    <span className="text-sm text-gray-800">{opCartao.clienteNome}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBuscandoOperacao(true)}
                    className="text-xs font-semibold text-gray-500 hover:text-gray-800 underline underline-offset-2"
                  >
                    Trocar
                  </button>
                  <button
                    type="button"
                    onClick={desvincular}
                    className="text-xs font-semibold text-gray-500 hover:text-red-600 underline underline-offset-2"
                  >
                    Desvincular
                  </button>
                </div>
              ) : buscandoOperacao ? (
                <BuscaOperacaoCombobox
                  onEscolher={(op) =>
                    escolherOperacao({ id: op.id, codigo: op.codigo, clienteNome: op.clienteNome })
                  }
                  rotulo="Operação que esta prova comprova"
                  inputRef={buscaRef}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500 italic">
                    Sem operação — esta prova não entra em nenhum dossiê.
                  </span>
                  <button
                    type="button"
                    onClick={() => setBuscandoOperacao(true)}
                    className="text-xs font-semibold text-brand-orange hover:underline"
                  >
                    Vincular
                  </button>
                </div>
              )}

              {desvinculando && (
                <label className="mt-2 flex items-center gap-2 text-xs text-amber-700">
                  <input
                    type="checkbox"
                    checked={form.limparPapelAoDesvincular}
                    onChange={(e) => mudar("limparPapelAoDesvincular", e.target.checked)}
                    className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
                  />
                  Limpar também o papel
                </label>
              )}

              {erroOperacao && (
                <p role="alert" className="mt-1.5 text-xs text-red-600 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {erroOperacao}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Papel na operação</label>
                <select
                  value={form.papel}
                  onChange={(e) => mudar("papel", e.target.value as PapelDocumento | "")}
                  disabled={form.operacaoId === null}
                  title={form.operacaoId === null ? "Escolha uma operação primeiro" : undefined}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50 disabled:text-gray-400"
                >
                  <option value="">— sem papel</option>
                  {PAPEIS_DOCUMENTO.map((p) => (
                    <option key={p} value={p}>{PAPEL_DOCUMENTO_LABELS[p]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Tipo (dossiê)</label>
                <select
                  value={form.tipoDocumento}
                  onChange={(e) => mudar("tipoDocumento", e.target.value as TipoDocumento | "")}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
                >
                  <option value="">— sem tipo</option>
                  {TIPOS_DOCUMENTO.map((t) => (
                    <option key={t} value={t}>{TIPO_DOCUMENTO_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Disciplina</label>
                <select
                  value={form.disciplinaId}
                  onChange={(e) => mudar("disciplinaId", e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
                >
                  <option value="">— sem disciplina</option>
                  {catalogoDisciplinas.map((d) => (
                    <option key={d.id} value={d.id}>{d.codigo} — {d.nome}</option>
                  ))}
                </select>
              </div>
            </div>

            {divergencia && (
              <p className="text-xs text-gray-500 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
                tipo e subcategoria divergem da tabela canônica
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Situação da prova</label>
                <select
                  value={form.situacaoProva}
                  onChange={(e) => mudar("situacaoProva", e.target.value as SituacaoProva | "")}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
                >
                  <option value="">— não avaliada</option>
                  {SITUACOES_PROVA.map((s) => (
                    <option key={s} value={s}>{SITUACAO_PROVA_BADGE[s].label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Detentora</label>
                <select
                  value={form.detentora}
                  onChange={(e) => mudar("detentora", e.target.value as Detentora | "")}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
                >
                  <option value="">— sem marca</option>
                  {DETENTORAS.map((d) => (
                    <option key={d} value={d}>{DETENTORA_LABELS[d]}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.restrito}
                  onChange={(e) => mudar("restrito", e.target.checked)}
                  className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
                />
                <Lock className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
                Restrito
              </label>
              <p className="text-[11px] text-gray-500 mt-1 ml-6">
                Restrito: some das listas, da busca e do ZIP para papéis fora da Conformidade;
                o detalhe e o download passam a responder 404 para eles. Downloads por
                Conformidade são espelhados em auditoria permanente.
              </p>
              {erroRestrito && (
                <p role="alert" className="mt-1.5 ml-6 text-xs text-red-600 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {erroRestrito}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Emitido em</label>
              <input
                type="date"
                value={form.emitidoEm}
                onChange={(e) => mudar("emitidoEm", e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Validade</label>
              <input
                type="date"
                value={form.validadeFim}
                onChange={(e) => mudar("validadeFim", e.target.value)}
                disabled={form.validadeIndeterminada}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50 disabled:text-gray-400"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.validadeIndeterminada}
              onChange={(e) => mudar("validadeIndeterminada", e.target.checked)}
              className="rounded border-gray-300"
            />
            Validade indeterminada
          </label>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Tags (separadas por vírgula)</label>
            <input
              value={form.tagsTexto}
              onChange={(e) => mudar("tagsTexto", e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            />
          </div>

          {erroGeral && (
            <div role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {erroGeral}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-gray-100">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">
            Cancelar
          </button>
          <Button onClick={salvar} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Salvar alterações
          </Button>
        </div>
      </div>
    </div>
  );
}
