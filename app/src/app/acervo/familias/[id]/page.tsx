"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ChevronLeft, Loader2, AlertCircle, FileText, Tag, ListTree, CalendarClock,
  Building2, ScrollText, Pencil, Plus, X,
} from "lucide-react";
import { cn, formatDate, diasRestantes } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/Button";
import { podeGerenciarFamilias } from "@/lib/permissions";
import { StatusFamiliaBadge, type StatusFamilia } from "@/components/conformidade/familias/StatusFamiliaBadge";
import { DossieSecoes, type Dossie } from "./DossieSecoes";

type SegmentoPetrobras = "YELLOW_PAGES" | "OPERACIONAL" | "CRITICA" | "ESTRATEGICA";
type StatusFluxoCrc = "D" | "Q" | "A" | "X";

const SEGMENTO_LABEL: Record<SegmentoPetrobras, string> = {
  YELLOW_PAGES: "Yellow Pages",
  OPERACIONAL:  "Operacional",
  CRITICA:      "Crítica",
  ESTRATEGICA:  "Estratégica",
};
const SEGMENTO_COR: Record<SegmentoPetrobras, string> = {
  YELLOW_PAGES: "bg-yellow-50 text-yellow-700 border-yellow-200",
  OPERACIONAL:  "bg-blue-50 text-blue-700 border-blue-200",
  CRITICA:      "bg-orange-50 text-orange-700 border-orange-200",
  ESTRATEGICA:  "bg-red-50 text-red-700 border-red-200",
};
const STATUS_FLUXO_LABEL: Record<StatusFluxoCrc, string> = {
  D: "Declaração de Interesse",
  Q: "Tecnicamente Qualificado",
  A: "Aprovado",
  X: "Cancelado",
};

interface FamiliaDetalhe {
  id: string;
  codigoCrc: string;
  nome: string;
  descricao: string | null;
  nivel: string;
  status: StatusFamilia;
  segmentoPetrobras: SegmentoPetrobras | null;
  statusFluxoCrc: StatusFluxoCrc | null;
  validadeFim: string | null;
  cadastroCorporativo: boolean;
  tags: string[] | null;
  escoposCobertos: string[] | null;
  observacoes: string | null;
  criterios: Record<string, { status: string; validadeFim: string | null; observacao?: string }> | null;
  criadoEm: string;
  atualizadoEm: string | null;
  aliases: { id: string; codigoAlternativo: string; observacao: string | null }[];
  anexos: {
    id: string;
    tipo: string;
    nomeArquivo: string;
    blobUrl: string;
    tamanhoBytes: number | null;
    validadeFim: string | null;
    uploadadoPorNome: string | null;
    criadoEm: string;
  }[];
  documentos: {
    documentoId: string;
    titulo: string;
    categoria: string;
    subcategoria: string;
    status: string;
    validadeFim: string | null;
    observacao: string | null;
  }[];
}

const CRITERIO_LABELS: Record<string, string> = {
  JURIDICO:    "Jurídico",
  ECONOMICO:   "Econômico",
  TECNICO:     "Técnico",
  TECNICO_SMS: "Técnico-SMS",
  LFO:         "LFO (Linha de Fornecimento)",
  REVENDEDOR:  "Revendedor / Distribuidor",
  INTEGRIDADE: "Integridade",
  GERENCIAL:   "Gerencial (legado)", // só aparece se vier de import antigo
};

const STATUS_CRITERIO_COR: Record<string, string> = {
  APROVADO:     "bg-green-100 text-green-700 border-green-200",
  QUALIFICADO:  "bg-blue-100 text-blue-700 border-blue-200",
  EM_AVALIACAO: "bg-amber-100 text-amber-700 border-amber-200",
  REJEITADO:    "bg-red-100 text-red-700 border-red-200",
  CANCELADO:    "bg-gray-100 text-gray-500 border-gray-200",
};

/**
 * O path aceita DUAS chaves, e a diferença é o ponto desta tela.
 *
 *   uuid    → família do NOSSO cadastro. Detalhe completo + dossiê.
 *   código  → família do CATÁLOGO da Petrobras. Só o dossiê existe.
 *
 * Sem o segundo modo, as famílias não cadastradas não tinham página nenhuma:
 * no mapa eram linha sem link — e são justamente as que exigem decisão. Um mapa
 * que mostra a oportunidade e não deixa abri-la é um beco.
 */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function FamiliaDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const ehUuid = RE_UUID.test(id);
  const { data: session } = useSession();
  const podeRevisar = !!session?.user && podeGerenciarFamilias(session.user.role);

  const [familia, setFamilia] = useState<FamiliaDetalhe | null>(null);
  const [dossie, setDossie] = useState<Dossie | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (ehUuid) {
        const r = await fetch(`/api/conformidade/familias/${id}`);
        if (!r.ok) throw new Error(`Erro ${r.status}`);
        const d: FamiliaDetalhe = await r.json();
        setFamilia(d);
        // O dossiê é chaveado por CÓDIGO — é o que junta cadastro, catálogo
        // oficial e indício. Falha dele não derruba a página: o detalhe do
        // cadastro continua útil sozinho.
        const rd = await fetch(
          `/api/conformidade/familias/dossie/${encodeURIComponent(d.codigoCrc)}`,
        );
        setDossie(rd.ok ? await rd.json() : null);
      } else {
        setFamilia(null);
        const rd = await fetch(`/api/conformidade/familias/dossie/${encodeURIComponent(id)}`);
        if (!rd.ok) {
          throw new Error(rd.status === 404 ? "Família não encontrada" : `Erro ${rd.status}`);
        }
        setDossie(await rd.json());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar");
    } finally {
      setLoading(false);
    }
  }, [id, ehUuid]);

  useEffect(() => { void carregar(); }, [carregar]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
        <span className="ml-2 text-sm text-gray-500">Carregando...</span>
      </div>
    );
  }

  if (error || (!familia && !dossie)) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link href="/acervo/familias" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ChevronLeft className="h-4 w-4" /> Voltar
        </Link>
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5" />
          {error ?? "Família não encontrada"}
        </div>
      </div>
    );
  }

  // MODO CATÁLOGO: família da Petrobras em que não estamos cadastrados.
  if (!familia) {
    return dossie ? (
      <NaoCadastrada dossie={dossie} podeRevisar={podeRevisar} onRevisado={carregar} />
    ) : null;
  }

  const dias = diasRestantes(familia.validadeFim);

  return (
    <div className="max-w-5xl mx-auto">
      <Link href="/acervo/familias" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ChevronLeft className="h-4 w-4" /> Voltar para famílias
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4 mb-6 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <span className="font-mono text-xs font-bold text-brand-orange">{familia.codigoCrc}</span>
            <StatusFamiliaBadge status={familia.status} />
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px] font-medium uppercase tracking-wide">
              {familia.nivel.toLowerCase()}
            </span>
            {familia.segmentoPetrobras && (
              <span
                title={`Segmento Petrobras: ${SEGMENTO_LABEL[familia.segmentoPetrobras]}`}
                className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
                  SEGMENTO_COR[familia.segmentoPetrobras],
                )}
              >
                {SEGMENTO_LABEL[familia.segmentoPetrobras]}
              </span>
            )}
            {familia.statusFluxoCrc && (
              <span
                title={`Fluxo CRC oficial: ${STATUS_FLUXO_LABEL[familia.statusFluxoCrc]}`}
                className="inline-flex items-center px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-bold font-mono"
              >
                {familia.statusFluxoCrc} — {STATUS_FLUXO_LABEL[familia.statusFluxoCrc]}
              </span>
            )}
            <span className="text-[10px] text-gray-500">
              {familia.cadastroCorporativo ? "Cadastro Corporativo" : "Registro Simplificado"}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-brand-black">{familia.nome}</h1>
          {familia.descricao && (
            <p className="text-sm text-gray-500 mt-1">{familia.descricao}</p>
          )}
        </div>

        <Button size="sm" onClick={() => setEditOpen(true)} className="rounded-md">
          <Pencil className="h-3.5 w-3.5" /> Editar família
        </Button>

        {familia.validadeFim && (
          <div className="bg-white border border-gray-200 rounded-xl p-4 min-w-[200px]">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <CalendarClock className="h-3 w-3" /> Validade do CRC
            </div>
            <p className="text-sm font-bold text-gray-800 tabular-nums">{formatDate(familia.validadeFim)}</p>
            {dias !== null && (
              <p className={cn(
                "text-xs mt-0.5 tabular-nums",
                dias < 0 ? "text-red-600 font-bold" :
                dias <= 30 ? "text-red-600" :
                dias <= 60 ? "text-amber-600" : "text-gray-500"
              )}>
                {dias < 0 ? `Vencido há ${Math.abs(dias)} dias` :
                 dias === 0 ? "Vence hoje" : `Faltam ${dias} dias`}
              </p>
            )}
          </div>
        )}
      </div>

      {/* O DOSSIÊ — o que o acervo e o catálogo oficial dizem desta família.
          Vem ANTES do que nós digitamos, porque é o que decide. */}
      {dossie && (
        <DossieSecoes dossie={dossie} podeRevisar={podeRevisar} onRevisado={carregar} />
      )}

      {/* Tags + escopos */}
      {(familia.tags?.length || familia.escoposCobertos?.length) && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5 space-y-3">
          {familia.tags && familia.tags.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400 mb-2">
                <Tag className="h-3 w-3" /> Tags
              </div>
              <div className="flex flex-wrap gap-1.5">
                {familia.tags.map((t) => (
                  <span key={t} className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {familia.escoposCobertos && familia.escoposCobertos.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400 mb-2">
                <ListTree className="h-3 w-3" /> Escopos cobertos
              </div>
              <div className="flex flex-wrap gap-1.5">
                {familia.escoposCobertos.map((e) => (
                  <span key={e} className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                    {e}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Critérios CRC */}
      {familia.criterios && Object.keys(familia.criterios).length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-brand-black mb-3">Critérios CRC</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(familia.criterios).map(([key, c]) => (
              <div key={key} className="border border-gray-200 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wide text-gray-400">
                  {CRITERIO_LABELS[key] ?? key}
                </p>
                <span className={cn(
                  "inline-block mt-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold",
                  STATUS_CRITERIO_COR[c.status] ?? "bg-gray-100 text-gray-600 border-gray-200"
                )}>
                  {c.status}
                </span>
                {c.validadeFim && (
                  <p className="text-xs text-gray-600 mt-1">Até {formatDate(c.validadeFim)}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* O bloco "Documentos comprobatórios" saiu daqui: o dossiê já mostra as
          MESMAS linhas de `documentos_familias` em "Provas confirmadas", e ver a
          mesma lista duas vezes na mesma página faz parecer que são coisas
          diferentes. */}

      {/* Anexos da família */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-brand-black">
            Anexos ({familia.anexos.length})
          </h2>
          <UploadAnexoButton familiaId={id} />
        </div>
        {familia.anexos.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">
            Nenhum certificado CRC, ata ou anexo. Use o botão acima pra subir.
          </p>
        ) : (
          <div className="space-y-2">
            {familia.anexos.map((a) => (
              <a
                key={a.id}
                href={`/api/conformidade/familias/${id}/anexos/${a.id}/download`}
                className="flex items-center gap-3 p-3 border border-gray-100 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <ScrollText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{a.nomeArquivo}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {a.tipo.replace(/_/g, " ")}
                    {a.tamanhoBytes && ` · ${(a.tamanhoBytes / 1024).toFixed(0)} KB`}
                    {a.uploadadoPorNome && ` · por ${a.uploadadoPorNome}`}
                  </p>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Aliases */}
      {familia.aliases.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-brand-black mb-3">
            Códigos alternativos ({familia.aliases.length})
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Códigos antigos que a Petrobras usou para esta mesma família — facilita match com licitações históricas.
          </p>
          <div className="flex flex-wrap gap-2">
            {familia.aliases.map((a) => (
              <span
                key={a.id}
                title={a.observacao ?? undefined}
                className="px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 text-xs font-mono"
              >
                {a.codigoAlternativo}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Observações */}
      {familia.observacoes && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400 mb-2">
            <Building2 className="h-3 w-3" /> Observações
          </div>
          <p className="text-sm text-gray-700 whitespace-pre-line">{familia.observacoes}</p>
        </div>
      )}

      {editOpen && (
        <EditarFamiliaModal
          familia={familia}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); carregar(); }}
        />
      )}
    </div>
  );
}

/**
 * MODO CATÁLOGO — família da Petrobras em que NÃO estamos cadastrados.
 *
 * Não há cadastro para editar, critérios para mostrar nem anexo para baixar:
 * tudo que existe é o dossiê. E é o caso mais valioso da tela — a grande maioria das
 * famílias cai aqui, e é entre elas que estão as candidatas a pedido de CRC.
 *
 * O botão leva ao formulário de cadastro já preenchido com código, nome e
 * escopo oficial: quem chega aqui acabou de ler exatamente esses três campos, e
 * redigitar um código de 8 dígitos é convite a erro na chave que junta cadastro,
 * catálogo e indício.
 */
function NaoCadastrada({
  dossie, podeRevisar, onRevisado,
}: { dossie: Dossie; podeRevisar: boolean; onRevisado: () => void }) {
  const c = dossie.catalogo;
  const params = new URLSearchParams({ codigo: dossie.codigo });
  if (dossie.nome) params.set("nome", dossie.nome);
  if (c?.escopo) params.set("escopo", c.escopo);
  if (c?.segmentoPetrobras) params.set("segmento", c.segmentoPetrobras);

  return (
    <div className="max-w-5xl mx-auto">
      <Link href="/acervo/familias" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ChevronLeft className="h-4 w-4" /> Voltar para o mapa de famílias
      </Link>

      <div className="flex items-start gap-4 mb-6 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <span className="font-mono text-xs font-bold text-brand-orange">{dossie.codigo}</span>
            <span
              title="Família do catálogo da Petrobras que não consta do nosso CRC."
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 text-[10px] font-semibold uppercase tracking-wide"
            >
              não cadastrada
            </span>
            {c?.oficial && (
              <span
                title="Consta da relação oficial de famílias da Petrobras."
                className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold uppercase tracking-wide"
              >
                catálogo oficial
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold text-brand-black">
            {dossie.nome ?? "Família sem nome no catálogo"}
          </h1>
        </div>

        {podeRevisar && (
          <Link
            href={`/acervo/familias/nova?${params.toString()}`}
            className={buttonVariants({ className: "shadow-sm" })}
          >
            <Plus className="h-3.5 w-3.5" /> Pedir cadastro nesta família
          </Link>
        )}
      </div>

      <DossieSecoes dossie={dossie} podeRevisar={podeRevisar} onRevisado={onRevisado} />
    </div>
  );
}

function EditarFamiliaModal({
  familia, onClose, onSaved,
}: { familia: FamiliaDetalhe; onClose: () => void; onSaved: () => void }) {
  const [codigoCrc, setCodigoCrc] = useState(familia.codigoCrc);
  const [nome, setNome] = useState(familia.nome);
  const [descricao, setDescricao] = useState(familia.descricao ?? "");
  const [nivel, setNivel] = useState(familia.nivel);
  const [status, setStatus] = useState<StatusFamilia>(familia.status);
  const [segmentoPetrobras, setSegmentoPetrobras] = useState<SegmentoPetrobras | "">(
    familia.segmentoPetrobras ?? ""
  );
  const [statusFluxoCrc, setStatusFluxoCrc] = useState<StatusFluxoCrc | "">(
    familia.statusFluxoCrc ?? ""
  );
  const [cadastroCorporativo, setCadastroCorporativo] = useState(familia.cadastroCorporativo);
  const [validadeFim, setValidadeFim] = useState(
    familia.validadeFim ? familia.validadeFim.slice(0, 10) : ""
  );
  const [tagsTxt, setTagsTxt] = useState((familia.tags ?? []).join(", "));
  const [escoposTxt, setEscoposTxt] = useState((familia.escoposCobertos ?? []).join(", "));
  const [observacoes, setObservacoes] = useState(familia.observacoes ?? "");
  const [saving, setSaving] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function parseList(v: string): string[] {
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }

  async function salvar() {
    setErro(null);
    if (codigoCrc.trim().length < 2 || nome.trim().length < 2) {
      setErro("Código CRC e nome precisam de pelo menos 2 caracteres");
      return;
    }
    setSaving(true);
    try {
      const body = {
        codigoCrc: codigoCrc.trim(),
        nome: nome.trim(),
        descricao: descricao.trim() || null,
        nivel,
        status,
        segmentoPetrobras: segmentoPetrobras || null,
        statusFluxoCrc: statusFluxoCrc || null,
        cadastroCorporativo,
        validadeFim: validadeFim ? new Date(validadeFim).toISOString() : null,
        tags: parseList(tagsTxt),
        escoposCobertos: parseList(escoposTxt),
        observacoes: observacoes.trim() || null,
      };
      const r = await fetch(`/api/conformidade/familias/${familia.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh] pb-[5vh] overflow-y-auto">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Pencil className="h-4 w-4 text-brand-orange" /> Editar família CRC
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Código CRC</label>
              <input value={codigoCrc} onChange={(e) => setCodigoCrc(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Nível</label>
              <select value={nivel} onChange={(e) => setNivel(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg">
                <option value="FAMILIA">Família</option>
                <option value="SUBFAMILIA">Subfamília</option>
                <option value="GRUPO">Grupo</option>
                <option value="ITEM">Item</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Nome</label>
            <input value={nome} onChange={(e) => setNome(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Descrição</label>
            <textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as StatusFamilia)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg">
                <option value="ATIVA">Ativa</option>
                <option value="EM_RENOVACAO">Em renovação</option>
                <option value="SUSPENSA">Suspensa</option>
                <option value="VENCIDA">Vencida</option>
                <option value="REJEITADA">Rejeitada</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Validade do CRC</label>
              <input type="date" value={validadeFim} onChange={(e) => setValidadeFim(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
            </div>
          </div>

          {/* Classificação Petrobras */}
          <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3">
            <legend className="px-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Classificação Petrobras
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">
                  Segmento
                </label>
                <select
                  value={segmentoPetrobras}
                  onChange={(e) => setSegmentoPetrobras(e.target.value as SegmentoPetrobras | "")}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
                >
                  <option value="">— não definido —</option>
                  <option value="YELLOW_PAGES">Yellow Pages (baixa complexidade)</option>
                  <option value="OPERACIONAL">Operacional</option>
                  <option value="CRITICA">Crítica</option>
                  <option value="ESTRATEGICA">Estratégica</option>
                </select>
                <p className="mt-1 text-[10px] text-gray-400">
                  Define o rigor da auditoria do CRC pela Petrobras.
                </p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">
                  Status fluxo CRC oficial
                </label>
                <select
                  value={statusFluxoCrc}
                  onChange={(e) => setStatusFluxoCrc(e.target.value as StatusFluxoCrc | "")}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
                >
                  <option value="">— não definido —</option>
                  <option value="D">D — Declaração de Interesse</option>
                  <option value="Q">Q — Tecnicamente Qualificado</option>
                  <option value="A">A — Aprovado (apto a licitar)</option>
                  <option value="X">X — Cancelado</option>
                </select>
              </div>
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={cadastroCorporativo} onChange={(e) => setCadastroCorporativo(e.target.checked)} className="rounded border-gray-300" />
            Cadastro corporativo (CRC oficial)
          </label>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Tags (separadas por vírgula)</label>
            <input value={tagsTxt} onChange={(e) => setTagsTxt(e.target.value)} placeholder="ex.: caldeiraria, montagem" className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Escopos cobertos (separados por vírgula)</label>
            <input value={escoposTxt} onChange={(e) => setEscoposTxt(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Observações</label>
            <textarea value={observacoes} onChange={(e) => setObservacoes(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>

          {erro && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5" /> {erro}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-gray-100">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">Cancelar</button>
          <Button onClick={salvar} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Salvar alterações
          </Button>
        </div>
      </div>
    </div>
  );
}

function UploadAnexoButton({ familiaId }: { familiaId: string }) {
  const [uploading, setUploading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function onPick(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setErro(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const tipo = /certificado|crc/i.test(file.name) ? "CERTIFICADO_CRC"
                 : /ata|auditoria/i.test(file.name)   ? "ATA_AUDITORIA"
                 : "OUTRO";
      fd.append("tipo", tipo);
      const r = await fetch(`/api/conformidade/familias/${familiaId}/anexos`, { method: "POST", body: fd });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErro(j.error ?? `Erro ${r.status}`);
      } else {
        // Recarrega página
        window.location.reload();
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro");
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  return (
    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-50 text-brand-orange border border-orange-200 rounded text-xs font-semibold cursor-pointer hover:bg-orange-100 transition-colors">
      {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
      {uploading ? "Enviando..." : "Subir anexo"}
      <input type="file" accept=".pdf,.xlsx,.xls,.doc,.docx" onChange={onPick} disabled={uploading} className="hidden" />
      {erro && <span className="text-red-600 ml-2 text-[10px]">{erro}</span>}
    </label>
  );
}
