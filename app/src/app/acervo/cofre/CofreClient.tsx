"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  Search, X, Loader2, AlertCircle, RefreshCw, FileText, Upload, ChevronLeft, ChevronRight,
  ChevronDown, Layers, Trash2, Download, Link2, Lock,
} from "lucide-react";
import { cn, formatDate, diasRestantes } from "@/lib/utils";
import { StatusDocumentoBadge, type StatusDocHab } from "@/components/conformidade/cofre/StatusDocumentoBadge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button, buttonVariants } from "@/components/ui/Button";
import {
  PAPEL_DOCUMENTO_LABELS,
  TIPOS_DOCUMENTO,
  TIPO_DOCUMENTO_LABELS,
  type Detentora,
  type PapelDocumento,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { podeExcluirDocumentoHabilitacao } from "@/lib/permissions";
import { GavetaDocumento } from "../_componentes/GavetaDocumento";
import { SituacaoProvaBadge } from "./SituacaoProvaBadge";
import { ModalVincularOperacao } from "./ModalVincularOperacao";

type CategoriaDocHab = "JURIDICA" | "FISCAL" | "ECONOMICA" | "TECNICA" | "QUALIFICACAO_PESSOAL" | "DECLARACAO";

/** Recorte da operação que o GET do cofre devolve embutido em cada documento. */
interface OperacaoResumo {
  id: string;
  codigo: string;
  clienteNome: string;
}

interface DocumentoListItem {
  id: string;
  categoria: CategoriaDocHab;
  subcategoria: string;
  titulo: string;
  descricao: string | null;
  // A lista já traz arquivo e MIME — a prévia da gaveta abre certa antes de o
  // detalhe (R17) chegar.
  nomeArquivo: string;
  contentType: string | null;
  numeroDocumento: string | null;
  validadeFim: string | null;
  validadeIndeterminada: boolean;
  status: StatusDocHab;
  versao: number;
  uploadadoPorNome: string | null;
  criadoEm: string;
  // 0033 — a obra que a prova comprova e o papel dela na obra. `null` em
  // certidão, ISO, declaração e em todo documento legado antes do backfill.
  operacaoId: string | null;
  papel: PapelDocumento | null;
  operacao: OperacaoResumo | null;
  // 0034 — campos novos de R6 (§6.3 do 02-APIS). Opcionais em runtime enquanto
  // a implantação anda em ondas; `undefined` é tratado como ausência.
  tipoDocumento: TipoDocumento | null;
  situacaoProva: SituacaoProva | null;
  detentora: Detentora | null;
  restrito: boolean;
  importJobId: string | null;
}

/** Linha do catálogo (GET /api/conformidade/disciplinas) — popula o `<select>`. */
interface DisciplinaCatalogo {
  id: string;
  codigo: string;
  nome: string;
}

interface ApiResponse {
  data:  DocumentoListItem[];
  total: number;
  page:  number;
  limit: number;
  pages: number;
}

/** Tamanho da página quando a lista é plana (comportamento de sempre). */
const LIMITE_PAGINA = 50;

/**
 * Teto de documentos carregados de uma vez no modo agrupado.
 *
 * Agrupar exige o conjunto INTEIRO: a API não sabe ordenar por operação
 * (`order` só aceita titulo|categoria|status|validade|criado_em), então uma
 * página de 50 espalharia as provas da mesma obra por várias páginas e a
 * contagem de cada grupo sairia mentirosa. Por isso o modo agrupado troca a
 * paginação por um LAÇO de páginas de 500 (o teto que o próprio
 * `FiltrosDocumentoSchema` aceita) até `total` — D8 (§7.6): com alguns milhares de
 * documentos, pedir uma página só truncava sempre, e a contagem de cada grupo
 * saía errada no caso NORMAL.
 */
const LIMITE_AGRUPADO = 500;

/**
 * Teto de segurança do modo agrupado: acima disto a tela AVISA em vez de
 * baixar o cofre inteiro na memória do navegador. O cofre já passa de alguns milhares de documentos;
 * o teto existe para o dia em que forem dezenas de milhares, e é DECLARADO na tela —
 * nunca um corte silencioso (Q10.3).
 */
const TETO_COFRE = 3000;

/** Chave do balde dos documentos sem operação — sempre o último grupo. */
const CHAVE_SEM_OPERACAO = "__sem_operacao__";

interface GrupoOperacao {
  chave: string;
  /** `null` no grupo "Sem operação". */
  operacao: OperacaoResumo | null;
  documentos: DocumentoListItem[];
}

/**
 * Agrupa os documentos carregados pela operação que eles comprovam.
 *
 * Ordem dos grupos: por código da operação (`numeric: true` para que 10009
 * venha antes de 10010, e não a ordem alfabética "10010" < "10009"), a MESMA
 * de GET /api/conformidade/operacoes. Dentro do grupo preserva-se a ordem que
 * veio do servidor (validade ascendente, por padrão).
 *
 * O grupo "Sem operação" vai para o fim de propósito: é fila de trabalho, não
 * lixo — quem abre o cofre precisa ver que aquelas provas ainda não têm obra.
 */
function agruparPorOperacao(documentos: DocumentoListItem[]): GrupoOperacao[] {
  const porOperacao = new Map<string, GrupoOperacao>();
  const semOperacao: DocumentoListItem[] = [];

  for (const doc of documentos) {
    if (!doc.operacao) {
      semOperacao.push(doc);
      continue;
    }
    const grupo = porOperacao.get(doc.operacao.id);
    if (grupo) grupo.documentos.push(doc);
    else porOperacao.set(doc.operacao.id, {
      chave: doc.operacao.id,
      operacao: doc.operacao,
      documentos: [doc],
    });
  }

  const grupos = Array.from(porOperacao.values()).sort((a, b) =>
    (a.operacao?.codigo ?? "").localeCompare(b.operacao?.codigo ?? "", "pt-BR", { numeric: true })
  );

  if (semOperacao.length > 0) {
    grupos.push({ chave: CHAVE_SEM_OPERACAO, operacao: null, documentos: semOperacao });
  }

  return grupos;
}

const CATEGORIA_LABELS: Record<CategoriaDocHab, string> = {
  JURIDICA:             "Habilitação Jurídica",
  FISCAL:               "Fiscal e Trabalhista",
  ECONOMICA:            "Econômico-Financeira",
  TECNICA:              "Habilitação Técnica",
  QUALIFICACAO_PESSOAL: "Qualificação Pessoal",
  DECLARACAO:           "Declarações",
};

const STATUS_LABELS: Record<StatusDocHab, string> = {
  VIGENTE:      "Vigente",
  EM_RENOVACAO: "Em renovação",
  VENCIDO:      "Vencido",
  SUBSTITUIDO:  "Substituído",
};

function DocumentoRow({
  d, selecionado, onToggle, onAbrir, mostrarOperacao,
}: {
  d: DocumentoListItem;
  selecionado: boolean;
  onToggle: (id: string) => void;
  /** Abre a GavetaDocumento neste documento (v2 §5). */
  onAbrir: (id: string) => void;
  /** No modo agrupado o código da obra já está no cabeçalho do grupo — repetir só polui. */
  mostrarOperacao: boolean;
}) {
  const dias = diasRestantes(d.validadeFim);
  const sub = d.subcategoria.replace(/_/g, " ");
  const tipoLabel = d.tipoDocumento ? TIPO_DOCUMENTO_LABELS[d.tipoDocumento] : null;

  return (
    <tr className={cn("border-b border-gray-100 hover:bg-gray-50 transition-colors", selecionado && "bg-orange-50/30")}>
      <td className="px-3 py-3 w-8">
        <input
          type="checkbox"
          checked={selecionado}
          onChange={() => onToggle(d.id)}
          className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
          aria-label={`Selecionar ${d.titulo}`}
        />
      </td>
      {/* O título abre a GavetaDocumento (v2 §5) — a página completa fica no
          rodapé da gaveta. O link da operação segue irmão, nunca filho. */}
      <td className="px-4 py-3">
        <div className="flex items-start gap-2">
          <FileText className="h-4 w-4 text-gray-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="flex items-center gap-1.5">
              <button
                onClick={() => onAbrir(d.id)}
                title={d.titulo}
                aria-label={`Abrir prévia de ${d.titulo}`}
                className="block min-w-0 text-left text-sm font-medium text-gray-800 hover:text-brand-orange truncate"
              >
                {d.titulo}
              </button>
              {/* Cadeado após o título (§6.2): a linha só chega a quem pode
                  vê-la — o predicado de visibilidade é do servidor. */}
              {d.restrito && (
                <span
                  aria-label="Documento restrito"
                  title="Restrito — invisível fora da Conformidade; downloads ficam em auditoria permanente."
                  className="flex-shrink-0"
                >
                  <Lock className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
                </span>
              )}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {/* Na lista plana o código é a ÚNICA pista da obra: o título novo
                  não traz mais o prefixo "12345 - " que se digitava à mão. */}
              {mostrarOperacao && d.operacao && (
                <Link
                  href={`/acervo/operacoes/${d.operacao.id}`}
                  title={`Dossiê da operação ${d.operacao.codigo} — ${d.operacao.clienteNome}`}
                  className="font-mono text-[10px] font-bold text-brand-orange hover:underline"
                >
                  {d.operacao.codigo}
                </Link>
              )}
              {d.papel && (
                <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">
                  {PAPEL_DOCUMENTO_LABELS[d.papel]}
                </span>
              )}
              {/* Chip do tipo (0034) entra ANTES do rótulo categoria·subcategoria (§6.2). */}
              {tipoLabel && (
                <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">
                  {tipoLabel}
                </span>
              )}
              <SituacaoProvaBadge situacao={d.situacaoProva ?? null} />
              <span className="text-[10px] text-gray-400 uppercase tracking-wide">
                {CATEGORIA_LABELS[d.categoria]} · {sub}
              </span>
            </div>
          </div>
        </div>
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        <StatusDocumentoBadge status={d.status} validadeFim={d.validadeFim} />
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        {d.validadeIndeterminada ? (
          <span className="text-xs text-gray-500 italic">Indeterminada</span>
        ) : d.validadeFim ? (
          <>
            <p className="text-xs text-gray-600">{formatDate(d.validadeFim)}</p>
            {dias !== null && (
              <p className={cn(
                "text-xs mt-0.5 tabular-nums",
                dias < 0 ? "text-red-600 font-bold" :
                dias <= 7 ? "text-red-600" :
                dias <= 30 ? "text-amber-600" : "text-gray-500"
              )}>
                {dias < 0 ? `${Math.abs(dias)}d atrás` :
                 dias === 0 ? "Hoje!" : `${dias}d`}
              </p>
            )}
          </>
        ) : (
          <span className="text-gray-300 text-xs">—</span>
        )}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        <span className="text-xs text-gray-500 tabular-nums">v{d.versao}</span>
      </td>

      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
        {d.uploadadoPorNome ?? "—"}
      </td>
    </tr>
  );
}

/**
 * Cabeçalho do grupo: código, cliente e quantas provas a obra tem na lista.
 *
 * A caixa de seleção do grupo é tri-estado — marcada, vazia ou "indeterminada"
 * quando só parte do grupo está selecionada. `indeterminate` não existe como
 * atributo de HTML (só como propriedade do elemento), daí o ref callback.
 */
function LinhaGrupo({
  grupo, recolhido, onToggleRecolhido, onToggleSelecao, selecionadosNoGrupo, onVincular,
}: {
  grupo: GrupoOperacao;
  recolhido: boolean;
  onToggleRecolhido: () => void;
  onToggleSelecao: () => void;
  selecionadosNoGrupo: number;
  /** Só no grupo "Sem operação": abre a adoção em lote (WP-12, §6.3). */
  onVincular?: () => void;
}) {
  const total = grupo.documentos.length;
  const atestados = grupo.documentos.filter((d) => d.papel === "ATESTADO").length;
  const todosSelecionados = selecionadosNoGrupo === total;
  const parcial = selecionadosNoGrupo > 0 && !todosSelecionados;

  const rotulo = grupo.operacao
    ? `${grupo.operacao.codigo} — ${grupo.operacao.clienteNome}`
    : "Sem operação";

  return (
    <tr className="bg-gray-50 border-y border-gray-200">
      <td className="px-3 py-2 w-8">
        <input
          type="checkbox"
          checked={todosSelecionados}
          ref={(el) => { if (el) el.indeterminate = parcial; }}
          onChange={onToggleSelecao}
          className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
          aria-label={`Selecionar as ${total} provas de ${rotulo}`}
        />
      </td>
      <td colSpan={5} className="px-2 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onToggleRecolhido}
            aria-expanded={!recolhido}
            aria-label={recolhido ? `Expandir ${rotulo}` : `Recolher ${rotulo}`}
            className="p-1 rounded hover:bg-gray-200 text-gray-500 transition-colors"
          >
            {recolhido ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>

          {grupo.operacao ? (
            <>
              <Link
                href={`/acervo/operacoes/${grupo.operacao.id}`}
                className="font-mono text-xs font-bold text-brand-orange hover:underline"
              >
                {grupo.operacao.codigo}
              </Link>
              <span className="text-sm font-medium text-gray-800">{grupo.operacao.clienteNome}</span>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700">
              <AlertCircle className="h-3.5 w-3.5" /> Sem operação
            </span>
          )}

          <span className="text-xs text-gray-500 tabular-nums">
            · {total} prova{total !== 1 ? "s" : ""}
            {atestados > 0 && ` · ${atestados} atestado${atestados !== 1 ? "s" : ""}`}
          </span>

          {grupo.operacao ? (
            <Link
              href={`/acervo/operacoes/${grupo.operacao.id}`}
              className="ml-auto text-xs text-gray-500 hover:text-brand-orange"
            >
              Ver dossiê
            </Link>
          ) : (
            /* A fila de trabalho ganhou o botão que a cumpre (WP-12, §6.3):
               a frase deixa de ser passiva — vincular está a um clique. */
            <span className="ml-auto flex items-center gap-2 flex-wrap justify-end">
              <span className="text-[11px] text-amber-600">
                Provas ainda sem obra — vincule para que entrem no dossiê.
              </span>
              {onVincular && (
                <button
                  onClick={onVincular}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-brand-orange bg-orange-50 border border-orange-200 rounded hover:bg-orange-100 transition-colors"
                >
                  <Link2 className="h-3 w-3" aria-hidden="true" /> Vincular a uma operação
                </button>
              )}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function BibliotecaContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session } = useSession();
  const [initialized, setInitialized] = useState(false);

  // Gaveta de documento (v2 §5): índice na lista em ordem exibida; null = fechada.
  // Excluir da gaveta segue a MESMA regra do DELETE do cofre (R9): só ADMIN.
  const [indiceGaveta, setIndiceGaveta] = useState<number | null>(null);
  const podeExcluir = Boolean(session?.user && podeExcluirDocumentoHabilitacao(session.user.role));

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoria, setCategoria] = useState("");
  const [status, setStatus] = useState("");
  const [vencendoEm, setVencendoEm] = useState("");
  // Filtros novos de R6 (WP-12/13): tipo do dossiê (0034), fila "só sem
  // operação" e o recorte por operação — este último SEM widget, chega só pela
  // URL (link "Ver no cofre" da ficha) e vira chip removível na barra.
  const [tipoDocumento, setTipoDocumento] = useState("");
  const [semOperacao, setSemOperacao] = useState(false);
  const [operacaoId, setOperacaoId] = useState("");
  // Código da operação do chip — best-effort via R3; enquanto não chega, o
  // chip mostra "Operação selecionada".
  const [operacaoChipCodigo, setOperacaoChipCodigo] = useState<string | null>(null);
  // 0043 — disciplina (<select> populado pelo catálogo; o VALOR é o uuid,
  // porque o servidor filtra por `documentos_habilitacao.disciplina_id` e
  // mapear código->id no client seria uma segunda tradução para manter, §1g) e
  // profissional (SÓ por URL, como `operacaoId`: o caminho real é o inverso —
  // a pessoa está no currículo do RT e clica em "ver no cofre").
  const [disciplinaId, setDisciplinaId] = useState("");
  const [catalogoDisciplinas, setCatalogoDisciplinas] = useState<DisciplinaCatalogo[]>([]);
  const [profissionalId, setProfissionalId] = useState("");
  // Guarda o par {id, nome}, e nao so o nome: assim o rotulo do chip e
  // DERIVADO no render (comparando com o `profissionalId` corrente) em vez de
  // ser zerado por um setState dentro do efeito — que e o padrao que o
  // `react-hooks/set-state-in-effect` acusa.
  const [profissionalChip, setProfissionalChip] = useState<{ id: string; nome: string } | null>(null);
  const [page, setPage] = useState(1);

  // Agrupamento por operação — ligado por padrão, porque o que entra no cofre
  // são atestados (N por obra), não certidões soltas. Estado na URL como os
  // filtros, para que o link compartilhado abra a mesma tela.
  const [agrupar, setAgrupar] = useState(true);
  const [recolhidos, setRecolhidos] = useState<Set<string>>(new Set());
  const toggleRecolhido = (chave: string) => setRecolhidos((p) => {
    const c = new Set(p);
    if (c.has(chave)) c.delete(chave); else c.add(chave);
    return c;
  });

  // Bulk select
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [confirmaBulk, setConfirmaBulk] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const [baixandoZip, setBaixandoZip] = useState(false);
  const [erroBulk, setErroBulk] = useState<string | null>(null);
  // Adoção em lote (WP-12): ids que vão para o ModalVincularOperacao. O flag
  // marca que houve vínculo — ao FECHAR o modal a lista recarrega e a seleção
  // limpa (§6.3-4: o resultado fica visível até o usuário fechar).
  const [idsVincular, setIdsVincular] = useState<string[] | null>(null);
  const [houveVinculo, setHouveVinculo] = useState(false);
  const toggle = (id: string) => setSelecionados((p) => { const c = new Set(p); if (c.has(id)) c.delete(id); else c.add(id); return c; });
  const selecionarTodos = (ids: string[]) => setSelecionados((p) => {
    const todosSelecionados = ids.every((i) => p.has(i));
    return todosSelecionados ? new Set() : new Set(ids);
  });
  /**
   * Seleciona ou limpa um grupo inteiro SEM tocar no resto da seleção — dá para
   * juntar as provas de duas obras no mesmo ZIP.
   */
  const toggleGrupo = (ids: string[]) => setSelecionados((p) => {
    const c = new Set(p);
    const todosSelecionados = ids.every((i) => c.has(i));
    for (const id of ids) {
      if (todosSelecionados) c.delete(id); else c.add(id);
    }
    return c;
  });
  async function bulkDelete() {
    setExcluindo(true);
    try {
      await fetch("/api/conformidade/cofre/documentos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selecionados) }),
      });
      setSelecionados(new Set());
      setConfirmaBulk(false);
      // dispara recarregamento
      setPage((p) => p);
      window.location.reload();
    } finally {
      setExcluindo(false);
    }
  }

  async function bulkDownload() {
    setErroBulk(null);
    setBaixandoZip(true);
    try {
      const ids = Array.from(selecionados);
      const r = await fetch("/api/conformidade/cofre/documentos/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErroBulk(j.error ?? `Erro ${r.status}`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `cofre_${stamp}_${ids.length}docs.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErroBulk(e instanceof Error ? e.message : "Erro ao gerar ZIP");
    } finally {
      setBaixandoZip(false);
    }
  }

  const [data, setData] = useState<ApiResponse | null>(null);
  // D8: a lista EXIBIDA. `data` continua guardando total/pages/limit da ÚLTIMA
  // resposta — é dele que sai "mostrando N de TOTAL".
  const [docsAcumulados, setDocsAcumulados] = useState<DocumentoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Trava de reentrância: o IntersectionObserver dispara duas vezes na mesma
  // rolagem com frequência. useRef, não useState: o valor tem de ser lido
  // dentro do callback do observer, que fecha sobre o render antigo.
  const carregandoMaisRef = useRef(false);
  const sentinelaRef = useRef<HTMLDivElement>(null);
  // Um AbortController por carga: trocar de filtro (ou o laço do agrupado)
  // aborta a anterior, para resposta velha não atropelar a nova.
  const cargaRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const c = searchParams.get("categoria");
    const s = searchParams.get("status");
    const b = searchParams.get("busca");
    const v = searchParams.get("vencendoEm");
    const a = searchParams.get("agrupar");
    const t = searchParams.get("tipoDocumento");
    const so = searchParams.get("semOperacao");
    const op = searchParams.get("operacaoId");
    if (c) setCategoria(c);
    if (s) setStatus(s);
    if (b) { setSearch(b); setDebouncedSearch(b); }
    if (v) setVencendoEm(v);
    // Só o "0" desliga: o padrão é agrupado, então a URL limpa já é o estado bom.
    if (a === "0") setAgrupar(false);
    // Tipo inválido na URL (link velho) é ignorado — a tela nunca quebra.
    if (t && (TIPOS_DOCUMENTO as readonly string[]).includes(t)) setTipoDocumento(t);
    if (so === "1" || so === "true") setSemOperacao(true);
    if (op) setOperacaoId(op);
    const di = searchParams.get("disciplinaId");
    if (di) setDisciplinaId(di);
    const pr = searchParams.get("profissionalId");
    if (pr) setProfissionalId(pr);
    setInitialized(true);
  }, [searchParams]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  const updateURL = useCallback(() => {
    const p = new URLSearchParams();
    if (categoria)        p.set("categoria", categoria);
    if (status)           p.set("status", status);
    if (debouncedSearch)  p.set("busca", debouncedSearch);
    if (vencendoEm)       p.set("vencendoEm", vencendoEm);
    if (!agrupar)         p.set("agrupar", "0");
    if (tipoDocumento)    p.set("tipoDocumento", tipoDocumento);
    if (semOperacao)      p.set("semOperacao", "1");
    if (operacaoId)       p.set("operacaoId", operacaoId);
    if (disciplinaId)     p.set("disciplinaId", disciplinaId);
    if (profissionalId)   p.set("profissionalId", profissionalId);
    const qs = p.toString();
    router.replace(qs ? `/acervo/cofre?${qs}` : "/acervo/cofre", { scroll: false });
  }, [categoria, status, debouncedSearch, vencendoEm, agrupar, tipoDocumento, semOperacao, operacaoId, disciplinaId, profissionalId, router]);

  useEffect(() => {
    if (!initialized) return;
    updateURL();
  }, [initialized, updateURL]);

  const fetchData = useCallback(() => {
    // Filtros comuns às duas formas de carga (a paginação entra depois).
    const comuns = new URLSearchParams();
    comuns.set("order", "validade");
    comuns.set("dir", "asc");
    if (debouncedSearch) comuns.set("busca", debouncedSearch);
    if (categoria)       comuns.set("categoria", categoria);
    if (status)          comuns.set("status", status);
    if (vencendoEm)      comuns.set("vencendoEm", vencendoEm);
    if (tipoDocumento)   comuns.set("tipoDocumento", tipoDocumento);
    if (semOperacao)     comuns.set("semOperacao", "1");
    if (operacaoId)      comuns.set("operacaoId", operacaoId);
    if (disciplinaId)    comuns.set("disciplinaId", disciplinaId);
    if (profissionalId)  comuns.set("profissionalId", profissionalId);

    cargaRef.current?.abort();
    const ctrl = new AbortController();
    cargaRef.current = ctrl;

    setLoading(true);
    setError(null);

    if (agrupar) {
      // D8 — o agrupado LAÇA páginas de 500 até `total` (molde literal de
      // `carregarCofre` do PainelClient): acumulação em variável LOCAL e UM
      // setState no fim. O setState único não é estilo — `docsOrdenados` é
      // `grupos.flatMap(...)` e a gaveta navega por ÍNDICE nessa lista; uma
      // página nova com mais provas de uma obra já vista entra NO MEIO do
      // achatado, e a gaveta aberta pularia de documento sozinha.
      const maxPaginas = Math.ceil(TETO_COFRE / LIMITE_AGRUPADO);
      void (async () => {
        try {
          const acumulado: DocumentoListItem[] = [];
          let ultima: ApiResponse | null = null;
          for (let pagina = 1; pagina <= maxPaginas; pagina++) {
            const p = new URLSearchParams(comuns);
            p.set("page", String(pagina));
            p.set("limit", String(LIMITE_AGRUPADO));
            const r = await fetch(`/api/conformidade/cofre/documentos?${p}`, { signal: ctrl.signal });
            if (!r.ok) throw new Error(`Erro ${r.status}`);
            const d = (await r.json()) as ApiResponse;
            acumulado.push(...d.data);
            ultima = d;
            if (acumulado.length >= d.total || d.data.length === 0) break;
          }
          if (ctrl.signal.aborted || !ultima) return;
          setData(ultima);
          setDocsAcumulados(acumulado);
          setLoading(false);
          carregandoMaisRef.current = false;
        } catch (e) {
          if (ctrl.signal.aborted) return;
          setError(e instanceof Error ? e.message : "Erro ao carregar o cofre");
          setLoading(false);
          carregandoMaisRef.current = false;
        }
      })();
      return;
    }

    // Plano: a paginação de sempre, agora ACUMULADA (rolagem infinita).
    const p = new URLSearchParams(comuns);
    p.set("page", String(page));
    p.set("limit", String(LIMITE_PAGINA));

    fetch(`/api/conformidade/cofre/documentos?${p}`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Erro ${r.status}`);
        return r.json();
      })
      .then((d: ApiResponse) => {
        setData(d);
        // `page === 1` substitui (é o único lugar onde a lista é apagada);
        // `page > 1` anexa. O filtro por id é a rede: qualquer caminho que
        // refaça a página CORRENTE (o "Tentar novamente" do banner de erro, um
        // retry) anexaria as mesmas linhas duas vezes, e §8.16 exige
        // `new Set(ids).size === ids.length`. ⚠️ O filtro só DESCARTA — ele não
        // remove o que saiu do servidor; por isso recarga de verdade é
        // `recarregar()`, que volta para a página 1.
        setDocsAcumulados((prev) => {
          if (d.page <= 1) return d.data;
          const vistos = new Set(prev.map((x) => x.id));
          return [...prev, ...d.data.filter((x) => !vistos.has(x.id))];
        });
        setLoading(false);
        carregandoMaisRef.current = false;
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Erro ao carregar o cofre");
        setLoading(false);
        carregandoMaisRef.current = false;
      });
  }, [page, agrupar, debouncedSearch, categoria, status, vencendoEm, tipoDocumento, semOperacao, operacaoId, disciplinaId, profissionalId]);

  /**
   * D8 — recarga do COMEÇO, e é ela que "Atualizar" e o `onMudou` da gaveta
   * chamam. Com acumulação, `fetchData()` com `page > 1` refaz a MESMA página e
   * o filtro por id descarta tudo o que volta: a lista fica byte a byte igual,
   * e um documento recém-EXCLUÍDO continuaria na tabela como fantasma. Voltar
   * para a página 1 é o mesmo remédio de `fecharVinculo` — o `setPage` dispara
   * a recarga pelo efeito; quando já se está na 1 (ou no agrupado, que refaz a
   * lista inteira) ele não dispara nada e a chamada explícita é necessária.
   */
  const recarregar = useCallback(() => {
    if (!agrupar && page > 1) setPage(1);
    else fetchData();
  }, [agrupar, page, fetchData]);

  /**
   * D8 — a página seguinte. O botão "Carregar mais" chama isto, e o
   * IntersectionObserver também: o observer é a conveniência, o botão é o
   * contrato (teclado, janela mais alta que a lista, `prefers-reduced-motion`).
   */
  const carregarMais = useCallback(() => {
    if (carregandoMaisRef.current || loading) return;
    // Parada pelo FIM DAS PÁGINAS, antes da parada por `total`: o filtro por id
    // do `.then` pode deixar o acumulado permanentemente abaixo de `total` (um
    // documento inserido no meio desloca as páginas seguintes), e sem esta
    // guarda o observer pediria página após página — todas vazias — sem fim.
    if (!data || data.page >= data.pages) return;
    if (docsAcumulados.length >= data.total) return;
    carregandoMaisRef.current = true;
    setPage((p) => p + 1);
  }, [loading, docsAcumulados.length, data]);

  useEffect(() => {
    const alvo = sentinelaRef.current;
    if (!alvo || agrupar) return;                       // agrupado não pagina
    const obs = new IntersectionObserver(
      (entradas) => { if (entradas[0]?.isIntersecting) carregarMais(); },
      { rootMargin: "200px" },
    );
    obs.observe(alvo);
    return () => obs.disconnect();
  }, [agrupar, carregarMais]);

  useEffect(() => { if (initialized) fetchData(); }, [initialized, fetchData]);
  useEffect(() => { if (initialized) setPage(1); }, [initialized, debouncedSearch, categoria, status, vencendoEm, agrupar, tipoDocumento, semOperacao, operacaoId, disciplinaId, profissionalId]);

  // Código da operação do chip — best-effort: se R3 falhar, o chip fica com o
  // rótulo genérico e o filtro continua funcionando (o id está na URL).
  useEffect(() => {
    if (!operacaoId) { setOperacaoChipCodigo(null); return; }
    let cancelado = false;
    fetch(`/api/conformidade/operacoes/${operacaoId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { codigo?: string } | null) => {
        if (!cancelado && j?.codigo) setOperacaoChipCodigo(j.codigo);
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelado = true; };
  }, [operacaoId]);

  // Catálogo de disciplinas do <select> — UMA chamada ao montar. Enquanto não
  // chega, o <select> fica com "Todas as disciplinas" e `disabled`.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/conformidade/disciplinas", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { disciplinas?: DisciplinaCatalogo[] } | null) => {
        if (j?.disciplinas) setCatalogoDisciplinas(j.disciplinas);
      })
      .catch(() => {
        /* best-effort: sem <select> de disciplina */
      });
    return () => ac.abort();
  }, []);

  // Nome do profissional do chip — best-effort, igual ao código da operação: se
  // falhar, o chip fica com o rótulo genérico e o filtro continua valendo (o id
  // está na URL).
  useEffect(() => {
    if (!profissionalId) return;
    let cancelado = false;
    fetch(`/api/conformidade/profissionais/${profissionalId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { profissional?: { nome?: string } } | null) => {
        if (!cancelado && j?.profissional?.nome) setProfissionalChip({ id: profissionalId, nome: j.profissional.nome });
      })
      .catch(() => { /* best-effort */ });
    return () => { cancelado = true; };
  }, [profissionalId]);

  // O nome so vale para o profissional que esta filtrando AGORA: trocar o
  // `profissionalId` invalida o rotulo antigo sem precisar limpa-lo no efeito.
  const profissionalChipNome =
    profissionalChip && profissionalChip.id === profissionalId ? profissionalChip.nome : null;

  const temFiltro = Boolean(
    debouncedSearch || categoria || status || vencendoEm || tipoDocumento || semOperacao ||
    operacaoId || disciplinaId || profissionalId
  );

  // Agrupamento é client-side: o servidor não sabe ordenar por operação, e com o
  // conjunto inteiro em mãos (LIMITE_AGRUPADO) a contagem por grupo é exata.
  const grupos = agrupar && data ? agruparPorOperacao(docsAcumulados) : [];

  // Navegação da gaveta = a ordem da tela: agrupado, os grupos em sequência
  // (recolhidos INCLUSOS, para o índice não deslizar quando um grupo fecha);
  // plano, a ordem do servidor. As setas atravessam a fronteira dos grupos.
  const docsOrdenados = agrupar && data ? grupos.flatMap((g) => g.documentos) : docsAcumulados;

  function abrirGaveta(id: string) {
    const i = docsOrdenados.findIndex((d) => d.id === id);
    if (i >= 0) setIndiceGaveta(i);
  }

  // Órfãos visíveis: base do botão "Vincular a operação" da barra de bulk — ele
  // só aparece quando TODA a seleção é de documentos sem operação (vincular por
  // cima de vínculo existente é ato unitário via editor, ADR-04).
  // D8: sobre o ACUMULADO, não sobre a última página — senão selecionar um
  // órfão da página 2 faria o botão "Vincular a operação" sumir da barra.
  const idsOrfaosVisiveis = new Set(
    docsAcumulados.filter((d) => !d.operacaoId).map((d) => d.id)
  );
  const selecaoSoOrfaos =
    selecionados.size > 0 && Array.from(selecionados).every((sid) => idsOrfaosVisiveis.has(sid));

  /**
   * Botão do grupo "Sem operação" (§6.3-1): sem seleção no grupo, seleciona o
   * grupo inteiro e abre o modal com ele; com seleção, abre direto com ela.
   */
  function abrirVinculoDoGrupo(grupo: GrupoOperacao) {
    const ids = grupo.documentos.map((d) => d.id);
    const selecaoNoGrupo = ids.filter((gid) => selecionados.has(gid));
    if (selecaoNoGrupo.length === 0) {
      setSelecionados((prev) => {
        const c = new Set(prev);
        for (const gid of ids) c.add(gid);
        return c;
      });
      setIdsVincular(ids);
    } else {
      setIdsVincular(selecaoNoGrupo);
    }
  }

  function fecharVinculo() {
    setIdsVincular(null);
    if (houveVinculo) {
      setHouveVinculo(false);
      setSelecionados(new Set());
      // D8: com acumulação, recarregar na página corrente (>1) não traz linha
      // nova nenhuma. Voltar para a 1 é o que se espera depois de vincular em
      // lote — é exatamente o que `recarregar` faz.
      recarregar();
    }
  }
  // A lista mostra menos do que o servidor tem: no agrupado é o TETO declarado
  // (dizer isso é obrigatório, senão o usuário lê "3 provas" achando que a obra
  // tem 3); no plano é só o "mostrando N de TOTAL" da rolagem.
  const listaTruncada = Boolean(data && docsAcumulados.length < data.total);

  /**
   * Recarga do ZERO (troca de filtro, "Atualizar" na página 1): é a única em
   * que a tela troca a lista pelo spinner. Carregar MAIS mantém a tabela — e o
   * botão "Carregar mais" — no DOM, senão o foco se perde a cada página.
   */
  const recarregandoDoZero = loading && (agrupar || page === 1);

  /**
   * Anúncio de rolagem para leitor de tela. DERIVADO: `data.page > 1` diz que a
   * última resposta foi uma página anexada, e `data.data.length` é quanto ela
   * trouxe. Sem estado novo e sem setState em efeito.
   */
  const anuncioCarga =
    !data || loading
      ? ""
      : data.page > 1
        ? `mais ${data.data.length.toLocaleString("pt-BR")} documentos carregados — ${docsAcumulados.length.toLocaleString("pt-BR")} de ${data.total.toLocaleString("pt-BR")}`
        : `${docsAcumulados.length.toLocaleString("pt-BR")} de ${data.total.toLocaleString("pt-BR")} documentos`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <Link
            href="/acervo"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
          >
            <ChevronLeft className="h-3 w-3" /> Acervo
          </Link>
          <h1 className="text-2xl font-bold text-brand-black">Cofre de Documentos</h1>
          {data && !loading && (
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="font-medium text-gray-700">{data.total.toLocaleString("pt-BR")}</span>{" "}
              documento{data.total !== 1 ? "s" : ""}
              {agrupar && grupos.length > 0 && (
                <span className="ml-1">
                  em <span className="font-medium text-gray-700">{grupos.length.toLocaleString("pt-BR")}</span>{" "}
                  grupo{grupos.length !== 1 ? "s" : ""}
                </span>
              )}
              {temFiltro && <span className="text-brand-orange ml-1">· filtros ativos</span>}
            </p>
          )}
        </div>

        <Link href="/acervo/cofre/novo" className={buttonVariants({ className: "shadow-sm" })}>
          <Upload className="h-4 w-4" /> Subir documento
        </Link>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-gray-200 mb-5 overflow-hidden">
        <div className="flex items-center gap-3 p-4 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar título, número ou descrição..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
            />
          </div>

          <select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todas as categorias</option>
            {Object.entries(CATEGORIA_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>

          <select
            value={vencendoEm}
            onChange={(e) => setVencendoEm(e.target.value)}
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Qualquer prazo</option>
            <option value="7">Vence em 7 dias</option>
            <option value="30">Vence em 30 dias</option>
            <option value="60">Vence em 60 dias</option>
            <option value="90">Vence em 90 dias</option>
          </select>

          <select
            value={tipoDocumento}
            onChange={(e) => setTipoDocumento(e.target.value)}
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
            aria-label="Filtrar por tipo do dossiê"
          >
            <option value="">Todos os tipos</option>
            {TIPOS_DOCUMENTO.map((t) => (
              <option key={t} value={t}>{TIPO_DOCUMENTO_LABELS[t]}</option>
            ))}
          </select>

          <select
            value={disciplinaId}
            onChange={(e) => setDisciplinaId(e.target.value)}
            disabled={catalogoDisciplinas.length === 0}
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600 disabled:opacity-60"
            aria-label="Filtrar por disciplina"
          >
            <option value="">Todas as disciplinas</option>
            {catalogoDisciplinas.map((d) => (
              <option key={d.id} value={d.id}>{d.codigo} — {d.nome}</option>
            ))}
          </select>

          <label className="inline-flex items-center gap-2 px-3 py-2.5 text-xs text-gray-600 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
            <input
              type="checkbox"
              checked={agrupar}
              onChange={(e) => setAgrupar(e.target.checked)}
              className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
            />
            <Layers className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
            Agrupar por operação
          </label>

          <label className="inline-flex items-center gap-2 px-3 py-2.5 text-xs text-gray-600 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
            <input
              type="checkbox"
              checked={semOperacao}
              onChange={(e) => setSemOperacao(e.target.checked)}
              className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
            />
            Só sem operação
          </label>

          {/* Chip do recorte por operação — sem widget de escolha: chega só por
              URL (link "Ver no cofre" da ficha); o × remove e refaz a busca. */}
          {operacaoId && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-brand-orange bg-orange-50 border border-orange-200 rounded-full">
              {operacaoChipCodigo ? `Operação ${operacaoChipCodigo}` : "Operação selecionada"}
              <button
                onClick={() => setOperacaoId("")}
                className="p-0.5 rounded-full hover:bg-orange-100"
                aria-label="Remover filtro de operação"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}

          {/* Chip do recorte por profissional — SÓ por URL, como o de operação:
              não há widget de escolha aqui porque o caminho real é o inverso
              (do currículo do RT para o cofre, §7.7). */}
          {profissionalId && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-brand-orange bg-orange-50 border border-orange-200 rounded-full">
              {profissionalChipNome ?? "Profissional selecionado"}
              <button
                onClick={() => setProfissionalId("")}
                className="p-0.5 rounded-full hover:bg-orange-100"
                aria-label="Remover filtro de profissional"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}

          <button
            onClick={recarregar}
            disabled={loading}
            className="p-2.5 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
            aria-label="Atualizar"
          >
            <RefreshCw className={cn("h-4 w-4 text-gray-500", loading && "animate-spin")} />
          </button>

          {temFiltro && (
            <button
              onClick={() => {
                setSearch(""); setCategoria(""); setStatus(""); setVencendoEm("");
                setTipoDocumento(""); setSemOperacao(false); setOperacaoId("");
                setDisciplinaId(""); setProfissionalId("");
              }}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              <X className="h-3.5 w-3.5" /> Limpar
            </button>
          )}
        </div>

        {/* Quanto da lista está na tela — nota discreta na toolbar (v2 §5). No
            agrupado é o TETO declarado (a contagem por operação sai incompleta
            acima dele, e um corte calado seria o defeito de Q10.3); no plano é
            o "mostrando N de TOTAL" da rolagem, que não é alerta nenhum. */}
        {!loading && !error && listaTruncada && data && (
          <p className={cn(
            "flex items-center gap-1.5 px-4 pb-3 text-xs",
            agrupar ? "text-amber-700" : "text-gray-500"
          )}>
            {agrupar && <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />}
            Mostrando {docsAcumulados.length.toLocaleString("pt-BR")} de{" "}
            {data.total.toLocaleString("pt-BR")}
            {" — "}
            {agrupar
              ? `o agrupamento carrega até ${TETO_COFRE.toLocaleString("pt-BR")} documentos de uma vez; filtre para fechar a conta.`
              : "role a lista ou use “Carregar mais”."}
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {error}
          <button onClick={fetchData} className="ml-auto text-xs underline hover:no-underline">
            Tentar novamente
          </button>
        </div>
      )}

      {recarregandoDoZero && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
          <span className="ml-2 text-sm text-gray-500">Carregando...</span>
        </div>
      )}

      {!recarregandoDoZero && !error && data && data.total > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden" aria-busy={loading}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={docsAcumulados.length > 0 && docsAcumulados.every((d) => selecionados.has(d.id))}
                      onChange={() => selecionarTodos(docsAcumulados.map((d) => d.id))}
                      className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
                      aria-label={`Selecionar os ${docsAcumulados.length} carregados`}
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Documento</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Validade</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Versão</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Subiu por</th>
                </tr>
              </thead>
              {/* Um <tbody> por grupo (HTML válido): o cabeçalho do grupo e as
                  provas dele ficam no mesmo bloco, e a tabela — com filtros,
                  seleção múltipla e ZIP — continua sendo uma só. */}
              {agrupar ? grupos.map((g) => {
                const ids = g.documentos.map((d) => d.id);
                const recolhido = recolhidos.has(g.chave);
                return (
                  <tbody key={g.chave}>
                    <LinhaGrupo
                      grupo={g}
                      recolhido={recolhido}
                      onToggleRecolhido={() => toggleRecolhido(g.chave)}
                      onToggleSelecao={() => toggleGrupo(ids)}
                      selecionadosNoGrupo={ids.filter((id) => selecionados.has(id)).length}
                      onVincular={g.operacao ? undefined : () => abrirVinculoDoGrupo(g)}
                    />
                    {!recolhido && g.documentos.map((d) => (
                      <DocumentoRow
                        key={d.id}
                        d={d}
                        selecionado={selecionados.has(d.id)}
                        onToggle={toggle}
                        onAbrir={abrirGaveta}
                        mostrarOperacao={false}
                      />
                    ))}
                  </tbody>
                );
              }) : (
                <tbody>
                  {/* D8: o ACUMULADO, não a última página — é a lista que a
                      rolagem foi construindo. */}
                  {docsAcumulados.map((d) => (
                    <DocumentoRow
                      key={d.id}
                      d={d}
                      selecionado={selecionados.has(d.id)}
                      onToggle={toggle}
                      onAbrir={abrirGaveta}
                      mostrarOperacao
                    />
                  ))}
                </tbody>
              )}
            </table>
          </div>

          {/* D8 — rolagem infinita só na lista plana: agrupado, a carga é o
              conjunto todo. O botão é o contrato e a sentinela é o atalho. */}
          {!agrupar && (
            <div className="flex flex-col items-center gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50">
              <span className="text-xs text-gray-500 tabular-nums">
                {docsAcumulados.length.toLocaleString("pt-BR")} de {data.total.toLocaleString("pt-BR")}
              </span>
              <p aria-live="polite" className="sr-only">{anuncioCarga}</p>
              {data.page < data.pages && docsAcumulados.length < data.total && (
                <Button size="sm" variant="secondary" onClick={carregarMais} disabled={loading}>
                  {loading ? "Carregando..." : "Carregar mais"}
                </Button>
              )}
              {/* A sentinela é o atalho, não o caminho. */}
              <div ref={sentinelaRef} aria-hidden="true" className="h-px w-full" />
            </div>
          )}
        </div>
      )}

      {!loading && !error && data?.total === 0 && temFiltro && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">Nenhum documento encontrado com os filtros aplicados.</p>
        </div>
      )}

      {!loading && !error && data?.total === 0 && !temFiltro && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
            <FileText className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-700 mb-2">Cofre vazio</h3>
          <p className="text-sm text-gray-500 mb-6 max-w-md">
            Comece subindo certidões, atestados e provas de operação para ter tudo pronto
            quando uma licitação for vencida.
          </p>
          <Link
            href="/acervo/cofre/novo"
            className={buttonVariants({ className: "gap-2 px-5 py-2.5" })}
          >
            <Upload className="h-4 w-4" /> Subir primeiro documento
          </Link>
        </div>
      )}

      {/* Barra de bulk fixa */}
      {selecionados.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2">
          {erroBulk && (
            <div className="bg-red-50 border border-red-200 rounded-full px-3 py-1.5 text-xs text-red-700 flex items-center gap-1.5 shadow">
              <AlertCircle className="h-3.5 w-3.5" /> {erroBulk}
            </div>
          )}
          <div className="bg-gray-900 text-white rounded-full px-5 py-3 shadow-2xl flex items-center gap-4">
            <span className="text-sm">
              <strong>{selecionados.size}</strong> selecionado{selecionados.size !== 1 ? "s" : ""}
            </span>
            <button
              onClick={() => { setSelecionados(new Set()); setErroBulk(null); }}
              className="text-xs text-gray-300 hover:text-white"
            >
              Limpar
            </button>
            {/* Só quando TODA a seleção é órfã: vincular por cima de vínculo
                existente é ato unitário via editor do documento (ADR-04). */}
            {selecaoSoOrfaos && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setIdsVincular(Array.from(selecionados))}
                disabled={baixandoZip}
                className="rounded-full"
              >
                <Link2 className="h-3.5 w-3.5" /> Vincular a operação
              </Button>
            )}
            <Button
              size="sm"
              onClick={bulkDownload}
              disabled={baixandoZip || selecionados.size > 100}
              title={selecionados.size > 100 ? "Máximo 100 documentos por ZIP" : undefined}
              className="rounded-full"
            >
              {baixandoZip ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {baixandoZip ? "Gerando ZIP..." : "Baixar ZIP"}
            </Button>
            <button
              onClick={() => setConfirmaBulk(true)}
              disabled={baixandoZip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-full hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Excluir
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmaBulk}
        title={`Excluir ${selecionados.size} documento${selecionados.size !== 1 ? "s" : ""}?`}
        message="O registro sai do cofre e o arquivo é removido do MinIO (a remoção do arquivo é best-effort: se o storage falhar, o registro some assim mesmo e o blob órfão é recolhido pela rotina de manutenção). Vínculos com famílias, alertas e presença em dossiês somem juntos. Esta ação não pode ser desfeita."
        confirmLabel={excluindo ? "Excluindo..." : "Excluir"}
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={bulkDelete}
        onCancel={() => setConfirmaBulk(false)}
      />

      {/* Adoção em lote (WP-12): o modal soma R11 por blocos de 200; ao fechar
          com vínculo feito, a lista recarrega e a seleção limpa. */}
      {idsVincular && (
        <ModalVincularOperacao
          ids={idsVincular}
          onFechar={fecharVinculo}
          onVinculado={() => setHouveVinculo(true)}
        />
      )}

      {/* Gaveta de documento (v2 §5): prévia, metadados e ações sem sair do
          cofre; editar/excluir recarregam a lista via onMudou — do COMEÇO, senão
          a linha excluída ficaria na tabela (a recarga da página corrente não
          traz linha nenhuma, e o filtro por id descartaria o que voltasse). */}
      {indiceGaveta !== null && (
        <GavetaDocumento
          docs={docsOrdenados}
          indice={indiceGaveta}
          onFechar={() => setIndiceGaveta(null)}
          onNavegar={setIndiceGaveta}
          onMudou={recarregar}
          podeExcluir={podeExcluir}
          contexto="cofre"
        />
      )}
    </div>
  );
}

export default function BibliotecaPagina() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-gray-300 border-t-brand-orange rounded-full animate-spin" />
          <span className="ml-2 text-sm text-gray-500">Carregando...</span>
        </div>
      }
    >
      <BibliotecaContent />
    </Suspense>
  );
}
