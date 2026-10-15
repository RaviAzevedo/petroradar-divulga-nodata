"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Search, FileDown, Building2, Trophy, Users,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  BarChart3, SlidersHorizontal,
  X, Loader2, DollarSign, PackageOpen,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { config } from "@/lib/config";
import { normalizeCnpj } from "@/lib/format";
import { SEGMENTOS, NATUREZAS } from "@/lib/constants";
import { formatBRL, formatCNPJ, isValorSimbolico } from "@/lib/format";
import { FilterChip } from "@/components/ui/FilterChip";
import { Skeleton, SkeletonRow } from "@/components/ui/Skeleton";
import { ModuloEmReconstrucao } from "@/components/ui/ModuloEmReconstrucao";
import { ConfidenceBadge } from "@/components/resultados/ConfidenceBadge";
import { useSession } from "next-auth/react";
import { LicitacaoDetalheModal } from "@/components/licitacoes/LicitacaoDetalheModal";

const ROLES_CONFORMIDADE = ["ADMIN", "LIDER", "SGI"] as const;

// Cor do dot de situação do contrato (Portal da Transparência):
// verde=Ativo, cinza=Concluído/Encerrado, vermelho=Cancelado/Rescindido.
function situacaoDotClass(situacao: string): string {
  const s = situacao.toLowerCase();
  if (s.includes("cancel") || s.includes("rescind")) return "bg-red-500";
  if (s.includes("conclu") || s.includes("encerr")) return "bg-gray-400";
  if (s.includes("ativo")) return "bg-green-500";
  return "bg-gray-300";
}

// ─── Tipos ─────────────────────────────────────────────────────────────────

interface Resultado {
  id: string;
  licitacaoId: string | null;
  numeroLicitacao: string;
  objeto: string | null;
  empresa: string | null;
  segmento: string | null;
  natureza: string | null;
  fornecedorVencedor: string | null;
  cnpjVencedor: string | null;
  valorVencedor: number | null;
  /** Valor REAL do contrato (Portal da Transparência) — preferido quando >0. */
  valorContratoReal: number | null;
  contratoTransparencia: string | null;
  contratoVigenciaFim: string | null;
  /** Vencedor + metadados do contrato assinado (migration 0020) — fallback
      rotulado quando o Petronect ainda não expôs o vencedor. */
  contratoFornecedor: string | null;
  contratoCnpj: string | null;
  contratoSituacao: string | null;
  contratoAditivos: number | null;
  contratoMoeda: string | null;
  contratoVigenciaInicio: string | null;
  totalParticipantes: number | null;
  totalPropostas: number | null;
  menorValor: number | null;
  maiorValor: number | null;
  valorMedio: number | null;
  statusResultado: string | null;
  confidenceLevel: "OFFICIAL" | "RANKED" | "PENDING" | null;
  dataFim: string | null;
  detectadoEm: string | null;
  proponenteParticipou: boolean;
}

interface Proposta {
  posicao: number;
  fornecedor: string;
  cnpj: string | null;
  itemNumero: string | null;
  itemDescricao: string | null;
  valorUnitario: number | null;
  valorTotal: number | null;
  meEpp: boolean;
  declinou: boolean;
}

interface ResultadoDetalhe {
  resultado: {
    id: string;
    licitacaoId: string | null;
    numeroLicitacao: string;
    objeto: string | null;
    empresa: string | null;
    segmento: string | null;
    fornecedorVencedor: string | null;
    cnpjVencedor: string | null;
    valorVencedor: number | null;
    statusResultado: string | null;
    totalParticipantes: number | null;
    menorValor: number | null;
    maiorValor: number | null;
  };
  propostas: Proposta[];
}

interface ApiMeta { total: number; page: number; limit: number; pages: number }

// ─── Página ───────────────────────────────────────────────────────────────

// Skeleton coerente com o layout da página (header + painel de filtros + tabela),
// exibido enquanto o boundary de Suspense resolve — evita tela em branco.
function ResultadosLoading() {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-3.5 w-32" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-24 rounded-lg" />
          <Skeleton className="h-7 w-16 rounded-lg" />
          <Skeleton className="h-7 w-16 rounded-lg" />
        </div>
      </div>

      {/* Painel de filtros */}
      <div className="bg-white rounded-xl border border-gray-200 mb-4 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 flex-1 rounded-lg" />
          <Skeleton className="h-10 w-40 rounded-lg" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-36 rounded-lg" />
          <Skeleton className="h-9 w-36 rounded-lg" />
          <Skeleton className="h-9 w-44 rounded-lg" />
        </div>
      </div>

      {/* Tabela */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-200 bg-gray-50">
          <Skeleton className="h-3 w-20 flex-shrink-0" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-24 flex-shrink-0" />
          <Skeleton className="h-3 w-24 flex-shrink-0" />
          <Skeleton className="h-3 w-12 flex-shrink-0" />
          <Skeleton className="h-3 w-20 flex-shrink-0" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonRow key={i} cols={6} />
        ))}
      </div>
    </div>
  );
}

export default function ResultadosPage() {
  if (!config.features.resultados) {
    return <ModuloEmReconstrucao modulo="Resultados" />;
  }
  // useSearchParams (dentro de ResultadosPageInternal) exige um boundary de Suspense.
  return (
    <Suspense fallback={<ResultadosLoading />}>
      <ResultadosPageInternal />
    </Suspense>
  );
}

function ResultadosPageInternal() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  // Só dispara fetch/reset depois de aplicar os filtros vindos da URL (deep-link).
  const [initialized, setInitialized] = useState(false);
  // Número pedido via ?numero= — abre o modal do resultado correspondente quando ele carrega.
  const [pendingNumero, setPendingNumero] = useState<string | null>(null);
  // Filtros
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [segmento, setSegmento] = useState("");
  const [natureza, setNatureza] = useState("");
  const [empresa, setEmpresa] = useState("");
  const [periodo, setPeriodo] = useState(""); // "7d" | "30d" | "90d" | ""
  // V2 — filtro de confiança do vencedor (default: ALL = mostra tudo)
  const [confidence, setConfidence] = useState<"ALL" | "OFFICIAL" | "PENDING" | "UNKNOWN">("ALL");
  // V2 — sub_status granular ("" | "01" | "02" | "03" | "04" | "05" | "06")
  const [subStatus, setSubStatus] = useState<string>("");
  // V2 — modo de disputa ("" | "01"=Aberta | "02"=Fechada | "03"=Pregão)
  const [disputeMode, setDisputeMode] = useState<string>("");
  // Novos: participação Proponente ("" | "participou" | "venceu") e faixa de valor
  const [proponente, setProponente] = useState<string>("");
  const [valorMin, setValorMin] = useState<string>("");
  const [valorMax, setValorMax] = useState<string>("");
  // Contrato real (Transparência): "" (todos) | "com" | "sem"
  const [contrato, setContrato] = useState<string>("");

  // UI
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ data: Resultado[]; meta: ApiMeta } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Lê a query string na montagem (deep-links). Parâmetros aceitos:
  //   ?numero=          → canônico p/ "ver detalhe": filtra e abre o modal do resultado
  //   ?search= / ?busca= → texto livre (número, vencedor, objeto)
  //   ?cnpj_vencedor=   → CNPJ do vencedor (o fetch detecta dígitos e vira cnpj_vencedor)
  //   ?confidence=      → filtro de confiança (OFFICIAL | PENDING | UNKNOWN)
  useEffect(() => {
    const numero = searchParams.get("numero") ?? "";
    const q = searchParams.get("search") ?? searchParams.get("busca") ?? "";
    const cnpj = searchParams.get("cnpj_vencedor") ?? "";
    const conf = searchParams.get("confidence") ?? "";

    const termoInicial = numero || q || cnpj;
    if (termoInicial) {
      setSearch(termoInicial);
      setDebouncedSearch(termoInicial);
    }
    if (conf === "OFFICIAL" || conf === "PENDING" || conf === "UNKNOWN") {
      setConfidence(conf);
    }
    if (numero) setPendingNumero(numero);
    setInitialized(true);
  }, [searchParams]);

  // Debounce do search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  // Construir URL e buscar.
  // Aceita um AbortSignal para cancelar o fetch anterior ao trocar filtros (evita race/waterfall).
  const fetchData = useCallback((signal?: AbortSignal) => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("limit", "20");

    if (debouncedSearch) {
      // Detect if search looks like a CNPJ (digits only, 11-14 chars)
      const cleanSearch = debouncedSearch.replace(/[.\-\/]/g, "");
      const isDigitsOnly = /^\d+$/.test(cleanSearch);
      if (isDigitsOnly && cleanSearch.length >= 11) {
        p.set("cnpj_vencedor", cleanSearch);
      } else {
        p.set("search", debouncedSearch);
      }
    }

    if (segmento) p.set("segmento", segmento);
    if (natureza) p.set("natureza", natureza);
    if (empresa) p.set("empresa", empresa);
    if (periodo) p.set("periodo", periodo);
    if (confidence !== "ALL") p.set("confidence", confidence);
    if (subStatus) p.set("subStatus", subStatus);
    if (disputeMode) p.set("disputeMode", disputeMode);
    if (proponente) p.set("proponente", proponente);
    if (valorMin) p.set("valor_min", valorMin);
    if (valorMax) p.set("valor_max", valorMax);
    if (contrato) p.set("contrato", contrato);

    setLoading(true);
    setError(null);
    fetch(`/api/resultados?${p}`, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        setError("Erro ao carregar resultados. Tente novamente.");
        setLoading(false);
      });
  }, [page, debouncedSearch, segmento, natureza, empresa, periodo, confidence, subStatus, disputeMode, proponente, valorMin, valorMax, contrato]);

  useEffect(() => {
    if (!initialized) return;
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [initialized, fetchData]);

  // Abre o modal do resultado pedido via ?numero= assim que ele aparecer nos dados.
  useEffect(() => {
    if (!pendingNumero || !data) return;
    const match = data.data.find((r) => r.numeroLicitacao === pendingNumero);
    if (match) setSelectedId(match.id);
    setPendingNumero(null);
  }, [pendingNumero, data]);

  // Reset página ao mudar filtros
  useEffect(() => {
    if (!initialized) return;
    setPage(1);
  }, [initialized, debouncedSearch, segmento, natureza, empresa, periodo, confidence, subStatus, disputeMode, proponente, valorMin, valorMax, contrato]);

  function clearAll() {
    setSearch(""); setSegmento(""); setNatureza(""); setEmpresa(""); setPeriodo("");
    setConfidence("ALL");
    setSubStatus(""); setDisputeMode("");
    setProponente(""); setValorMin(""); setValorMax("");
    setContrato("");
    setPage(1);
  }

  // Chips de filtros ativos
  const confidenceLabel: Record<typeof confidence, string> = {
    ALL: "", OFFICIAL: "Apenas oficiais",
    PENDING: "Em curso", UNKNOWN: "Sem dado",
  };
  const SUB_STATUS_LABEL: Record<string, string> = {
    "01": "Aguardando Lance", "02": "Aberto p/ Lance", "03": "Em Disputa",
    "04": "Em Análise", "05": "Resultado Divulgado", "06": "Habilitação",
  };
  const DM_LABEL: Record<string, string> = { "01": "Aberta", "02": "Fechada", "03": "Pregão" };

  const chips: { label: string; clear: () => void }[] = [
    ...(segmento ? [{ label: `Segmento: ${segmento}`, clear: () => setSegmento("") }] : []),
    ...(natureza ? [{ label: `Natureza: ${natureza}`, clear: () => setNatureza("") }] : []),
    ...(empresa  ? [{ label: `Empresa: ${empresa}`,   clear: () => setEmpresa("") }]  : []),
    ...(periodo === "7d"  ? [{ label: "Últimos 7 dias",  clear: () => setPeriodo("") }] : []),
    ...(periodo === "30d" ? [{ label: "Últimos 30 dias", clear: () => setPeriodo("") }] : []),
    ...(periodo === "90d" ? [{ label: "Últimos 90 dias", clear: () => setPeriodo("") }] : []),
    ...(confidence !== "ALL"
      ? [{ label: confidenceLabel[confidence], clear: () => setConfidence("ALL") }]
      : []),
    ...(subStatus
      ? [{ label: `Fase: ${SUB_STATUS_LABEL[subStatus] ?? subStatus}`, clear: () => setSubStatus("") }]
      : []),
    ...(disputeMode
      ? [{ label: `Modo: ${DM_LABEL[disputeMode] ?? disputeMode}`, clear: () => setDisputeMode("") }]
      : []),
    ...(proponente
      ? [{ label: proponente === "venceu" ? "Proponente venceu" : "Proponente participou", clear: () => setProponente("") }]
      : []),
    ...((valorMin || valorMax)
      ? [{ label: `Valor ${valorMin ? `≥ ${valorMin}` : ""}${valorMin && valorMax ? " e " : ""}${valorMax ? `≤ ${valorMax}` : ""}`, clear: () => { setValorMin(""); setValorMax(""); } }]
      : []),
    ...(contrato
      ? [{ label: contrato === "com" ? "Com contrato" : "Sem contrato", clear: () => setContrato("") }]
      : []),
  ];

  const temFiltro = chips.length > 0 || search;

  // Conta filtros avançados ativos (vão no badge do botão "Mais filtros")
  const avancadosCount =
    (confidence !== "ALL" ? 1 : 0) +
    (subStatus ? 1 : 0) +
    (disputeMode ? 1 : 0) +
    (proponente ? 1 : 0) +
    (valorMin || valorMax ? 1 : 0) +
    (contrato ? 1 : 0);

  // URL de export com os filtros ativos
  function exportUrl(format: string) {
    const p = new URLSearchParams();
    p.set("format", format);
    p.set("limit", "1000");
    if (debouncedSearch) {
      const cleanSearch = debouncedSearch.replace(/[.\-\/]/g, "");
      const isDigitsOnly = /^\d+$/.test(cleanSearch);
      if (isDigitsOnly && cleanSearch.length >= 11) {
        p.set("cnpj_vencedor", cleanSearch);
      } else {
        p.set("search", debouncedSearch);
      }
    }
    if (segmento) p.set("segmento", segmento);
    if (natureza) p.set("natureza", natureza);
    if (empresa)  p.set("empresa",  empresa);
    if (periodo)  p.set("periodo",  periodo);
    if (proponente) p.set("proponente", proponente);
    if (valorMin) p.set("valor_min", valorMin);
    if (valorMax) p.set("valor_max", valorMax);
    return `/api/resultados/export?${p}`;
  }

  // Check if we have data loaded and it's empty (no results at all, without filters)
  const isEmptyState = !loading && !error && data && data.meta.total === 0 && !temFiltro;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Resultados de Licitações</h1>
          {data && (
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="font-medium text-gray-700">{data.meta.total.toLocaleString("pt-BR")}</span> resultado{data.meta.total !== 1 ? "s" : ""}
              {temFiltro && <span className="text-brand-orange ml-1">· filtros ativos</span>}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => window.open(exportUrl("csv"), "_blank")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <FileDown className="h-3 w-3" /> CSV
          </button>
          <button
            onClick={() => window.open(exportUrl("json"), "_blank")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <FileDown className="h-3 w-3" /> JSON
          </button>
        </div>
      </div>

      {/* Painel de filtros */}
      <div className="bg-white rounded-xl border border-gray-200 mb-4 overflow-hidden">

        {/* Linha 1: busca principal + período */}
        <div className="flex items-center gap-3 p-4 flex-wrap">
          <div className="relative flex-1 min-w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por número, vencedor, objeto ou CNPJ..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); }}
              aria-label="Buscar"
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
            />
          </div>

          <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden">
            {[
              { v: "",    label: "Todos" },
              { v: "7d",  label: "7d" },
              { v: "30d", label: "30d" },
              { v: "90d", label: "90d" },
            ].map(({ v, label }) => (
              <button
                key={v}
                onClick={() => setPeriodo(v)}
                className={cn(
                  "px-3 py-2 text-xs font-medium transition-colors",
                  periodo === v
                    ? "bg-brand-black text-white"
                    : "text-gray-500 hover:bg-gray-50",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Linha 2: selects básicos + Mais filtros + Limpar */}
        <div className="flex items-center gap-3 px-4 pb-4 flex-wrap border-t border-gray-50 pt-3">
          <select
            value={segmento}
            onChange={(e) => setSegmento(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todos segmentos</option>
            {SEGMENTOS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            value={natureza}
            onChange={(e) => setNatureza(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todas naturezas</option>
            {NATUREZAS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>

          <div className="relative min-w-[180px]">
            <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value)}
              placeholder="Empresa..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            />
          </div>

          <button
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border rounded-lg transition-colors",
              avancadosCount > 0
                ? "border-brand-orange/30 bg-brand-orange/5 text-brand-orange hover:bg-brand-orange/10"
                : "border-gray-200 text-gray-600 hover:bg-gray-50",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Mais filtros
            {avancadosCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-brand-orange text-black text-[10px] font-bold">
                {avancadosCount}
              </span>
            )}
            {showAdvanced
              ? <ChevronUp className="h-3.5 w-3.5" />
              : <ChevronDown className="h-3.5 w-3.5" />}
          </button>

          <div className="ml-auto">
            {temFiltro && (
              <button
                onClick={clearAll}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
                aria-label="Limpar todos os filtros"
              >
                <X className="h-3.5 w-3.5" /> Limpar tudo
              </button>
            )}
          </div>
        </div>

        {/* Painel "Mais filtros" — colapsável */}
        {showAdvanced && (
          <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 min-w-[80px]">
                Confiança
              </span>
              <div
                className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden bg-white"
                title="Filtrar por confiança do dado de vencedor"
              >
                {[
                  { v: "ALL",      label: "Todos",    dot: "bg-gray-300",  title: "Todos os resultados" },
                  { v: "OFFICIAL", label: "Oficial",  dot: "bg-green-500", title: "Vencedor confirmado (Homologada/Adjudicada)" },
                  { v: "PENDING",  label: "Em curso", dot: "bg-amber-400", title: "Licitação em análise, sem vencedor" },
                  { v: "UNKNOWN",  label: "Sem dado", dot: "bg-gray-300",  title: "Confiança indeterminada (legado)" },
                ].map(({ v, label, dot, title }) => (
                  <button
                    key={v}
                    onClick={() => setConfidence(v as typeof confidence)}
                    title={title}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                      confidence === v
                        ? "bg-brand-orange text-black"
                        : "text-gray-500 hover:bg-gray-50",
                    )}
                  >
                    <span className={cn("inline-block w-1.5 h-1.5 rounded-full", confidence === v ? "bg-black" : dot)} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 min-w-[80px]">
                Processo
              </span>
              <select
                value={subStatus}
                onChange={(e) => setSubStatus(e.target.value)}
                className="px-3 py-2 text-xs font-medium border border-gray-200 rounded-lg bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                title="Fase do processo no portal Petronect"
              >
                <option value="">Fase: todas</option>
                <option value="01">Aguardando Lance</option>
                <option value="02">Aberto p/ Lance</option>
                <option value="03">Em Disputa</option>
                <option value="04">Em Análise</option>
                <option value="05">Resultado Divulgado</option>
                <option value="06">Habilitação</option>
              </select>

              <select
                value={disputeMode}
                onChange={(e) => setDisputeMode(e.target.value)}
                className="px-3 py-2 text-xs font-medium border border-gray-200 rounded-lg bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                title="Modalidade de disputa"
              >
                <option value="">Modo: todos</option>
                <option value="01">Aberta</option>
                <option value="02">Fechada</option>
                <option value="03">Pregão</option>
              </select>
            </div>

            {/* Participação da Proponente */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 min-w-[80px]">
                Proponente
              </span>
              <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden bg-white">
                {[
                  { v: "",           label: "Todas" },
                  { v: "participou", label: "Participou" },
                  { v: "venceu",     label: "Venceu" },
                ].map(({ v, label }) => (
                  <button
                    key={v}
                    onClick={() => setProponente(v)}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium transition-colors",
                      proponente === v ? "bg-brand-orange text-black" : "text-gray-500 hover:bg-gray-50",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Contrato real (Portal da Transparência) */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 min-w-[80px]">
                Contrato
              </span>
              <div
                className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden bg-white"
                title="Filtrar por presença de contrato REAL assinado no Portal da Transparência"
              >
                {[
                  { v: "",    label: "Todos", title: "Com ou sem contrato" },
                  { v: "com", label: "Com contrato", title: "Só resultados com valor real de contrato (Transparência)" },
                  { v: "sem", label: "Sem contrato", title: "Só resultados sem contrato assinado publicado" },
                ].map(({ v, label, title }) => (
                  <button
                    key={v}
                    onClick={() => setContrato(v)}
                    title={title}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium transition-colors",
                      contrato === v ? "bg-brand-orange text-black" : "text-gray-500 hover:bg-gray-50",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Faixa de valor do vencedor */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 min-w-[80px]">
                Valor (R$)
              </span>
              <input
                type="number"
                min="0"
                value={valorMin}
                onChange={(e) => setValorMin(e.target.value)}
                placeholder="mínimo"
                aria-label="Valor mínimo do vencedor"
                className="w-32 px-3 py-2 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              />
              <span className="text-xs text-gray-400">até</span>
              <input
                type="number"
                min="0"
                value={valorMax}
                onChange={(e) => setValorMax(e.target.value)}
                placeholder="máximo"
                aria-label="Valor máximo do vencedor"
                className="w-32 px-3 py-2 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              />
            </div>
          </div>
        )}

        {/* Chips de filtros ativos */}
        {chips.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 border-t border-gray-100 bg-white">
            <span className="text-xs text-gray-400">Filtros:</span>
            {chips.map((c) => (
              <FilterChip key={c.label} label={c.label} onRemove={c.clear} />
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button
            onClick={() => fetchData()}
            className="ml-4 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* Empty state - no results exist at all */}
      {isEmptyState ? (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="p-4 bg-gray-50 rounded-full mb-4">
              <PackageOpen className="h-10 w-10 text-gray-300" />
            </div>
            <h3 className="text-lg font-semibold text-gray-700 mb-2">Nenhum resultado disponível ainda</h3>
            <p className="text-sm text-gray-500 text-center max-w-md">
              Os resultados são coletados automaticamente pelo sync diário.
              Quando houver resultados de licitações publicados, eles aparecerão aqui.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Tabela */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      Número
                    </th>
                    <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                      Objeto / Empresa
                    </th>
                    <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <Trophy className="h-3 w-3" /> Vencedor
                      </span>
                    </th>
                    <th scope="col" className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      <span className="flex items-center justify-end gap-1">
                        <DollarSign className="h-3 w-3" /> Valor Vencedor
                      </span>
                    </th>
                    <th scope="col" className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      <span className="flex items-center justify-center gap-1">
                        <Users className="h-3 w-3" /> Part.
                      </span>
                    </th>
                    <th scope="col" className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap" title="Média das propostas válidas submetidas">
                      <span className="flex items-center justify-end gap-1">
                        <BarChart3 className="h-3 w-3" /> Média orçada
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-gray-400 text-sm">
                        <div className="flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin text-brand-orange" />
                          Buscando resultados...
                        </div>
                      </td>
                    </tr>
                  ) : data?.data.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-gray-400 text-sm">
                        Nenhum resultado encontrado com os filtros aplicados.
                      </td>
                    </tr>
                  ) : (
                    data?.data.map((res) => (
                      <tr
                        key={res.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(res.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(res.id);
                          }
                        }}
                        className="border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                      >
                        {/* Numero */}
                        <td className="px-4 py-3">
                          {res.licitacaoId ? (
                            <span
                              className="font-mono text-xs font-semibold text-brand-orange whitespace-nowrap cursor-pointer hover:underline"
                            >
                              {res.numeroLicitacao}
                            </span>
                          ) : (
                            <span className="font-mono text-xs font-semibold text-brand-orange whitespace-nowrap">
                              {res.numeroLicitacao}
                            </span>
                          )}
                          {res.proponenteParticipou && (() => {
                            // Venceu se o CNPJ do vencedor Petronect OU o do contrato
                            // assinado (Transparência) bater com o da Proponente.
                            const ganhou =
                              res.cnpjVencedor?.replace(/\D/g, "") === config.proponente.cnpj ||
                              res.contratoCnpj?.replace(/\D/g, "") === config.proponente.cnpj;
                            return (
                              <span className={cn(
                                "ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded",
                                ganhou
                                  ? "bg-green-100 text-green-700"
                                  : "bg-brand-orange/10 text-brand-orange",
                              )}>
                                {ganhou ? "Proponente venceu" : "Proponente participou"}
                              </span>
                            );
                          })()}
                        </td>

                        {/* Objeto + empresa */}
                        <td className="px-4 py-3 max-w-xs">
                          <p className="text-sm text-gray-800 line-clamp-1 font-medium">
                            {res.objeto || "-"}
                          </p>
                          {res.empresa && (
                            <p className="text-xs text-gray-400 mt-0.5 truncate">{res.empresa}</p>
                          )}
                        </td>

                        {/* Vencedor */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 mb-0.5">
                            <ConfidenceBadge
                              level={res.confidenceLevel}
                              statusResultado={res.statusResultado}
                            />
                          </div>
                          {!res.fornecedorVencedor && res.contratoFornecedor ? (
                            /* Fallback rotulado: vencedor segundo o contrato assinado
                               (Portal da Transparência) — o Petronect ainda não expôs. */
                            <>
                              <span className="flex items-center gap-1.5">
                                <span className="text-sm text-gray-700 font-medium line-clamp-1">
                                  {res.contratoFornecedor}
                                </span>
                                <span
                                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 whitespace-nowrap flex-shrink-0"
                                  title="Vencedor segundo o contrato assinado no Portal da Transparência — a coleta Petronect ainda não expôs o resultado"
                                >
                                  Transparência
                                </span>
                              </span>
                              {res.contratoCnpj && (
                                <p className="text-[10px] text-gray-400 font-mono mt-0.5">{formatCNPJ(res.contratoCnpj)}</p>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="text-sm text-gray-700 font-medium line-clamp-1">
                                {res.fornecedorVencedor || (res.confidenceLevel === "PENDING" ? <span className="italic text-gray-400">— em curso —</span> : "-")}
                              </span>
                              {res.cnpjVencedor && (
                                <p className="text-[10px] text-gray-400 font-mono mt-0.5">{formatCNPJ(res.cnpjVencedor)}</p>
                              )}
                            </>
                          )}
                        </td>

                        {/* Valor vencedor — prefere o valor REAL do contrato
                            (Portal da Transparência) quando o cron já preencheu;
                            senão mantém a lógica Simbólico / valor / Sigiloso. */}
                        <td className="px-4 py-3 text-right tabular-nums">
                          {res.valorContratoReal != null && res.valorContratoReal > 0 ? (
                            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                              <span className="text-sm font-bold text-emerald-700">
                                {formatBRL(res.valorContratoReal)}
                              </span>
                              <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
                                title={`Valor REAL do contrato (Portal da Transparência) — contrato ${res.contratoTransparencia}${res.contratoVigenciaFim ? ", vigência até " + formatDate(res.contratoVigenciaFim) : ""}. O Petronect publicou apenas valor simbólico de ranking.`}
                              >
                                Contrato
                              </span>
                              {res.contratoSituacao && (
                                <span
                                  className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", situacaoDotClass(res.contratoSituacao))}
                                  title={`Situação do contrato: ${res.contratoSituacao}`}
                                />
                              )}
                            </span>
                          ) : isValorSimbolico(res.valorVencedor) ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap"
                              title={`Disputa fechada: o Petronect publica apenas valores SIMBÓLICOS de ranking (${formatBRL(res.valorVencedor)}) — o valor real do contrato é sigiloso.`}
                            >
                              Simbólico · {formatBRL(res.valorVencedor)}
                            </span>
                          ) : (
                            <span className={cn("text-sm whitespace-nowrap", res.valorVencedor && res.valorVencedor > 0 ? "font-semibold text-green-700" : "text-gray-400 italic text-xs")}>
                              {res.valorVencedor && res.valorVencedor > 0 ? formatBRL(res.valorVencedor) : "Sigiloso"}
                            </span>
                          )}
                        </td>

                        {/* Participantes */}
                        <td className="px-4 py-3 text-center">
                          <span className="text-sm text-gray-600 font-medium">
                            {res.totalParticipantes ?? "-"}
                          </span>
                        </td>

                        {/* Média orçada (AVG das propostas válidas) */}
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className="text-xs text-gray-600 whitespace-nowrap">
                            {isValorSimbolico(res.valorMedio) ? (
                              <span className="text-gray-300" title="Valores simbólicos (disputa fechada) — média sem significado monetário.">—</span>
                            ) : res.valorMedio != null && res.valorMedio > 0 ? (
                              formatBRL(res.valorMedio)
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Paginacao */}
            {data && data.meta.pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
                <span className="text-xs text-gray-500">
                  Página <span className="font-medium">{data.meta.page}</span> de <span className="font-medium">{data.meta.pages}</span>
                  <span className="text-gray-400 ml-2">· {data.meta.total.toLocaleString("pt-BR")} total</span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(1)}
                    disabled={page <= 1}
                    className="px-2 py-1 text-xs border border-gray-200 rounded-lg disabled:opacity-30 hover:bg-gray-100 transition-colors"
                    aria-label="Primeira página"
                  >
                    &laquo;
                  </button>
                  <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page <= 1}
                    className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                    aria-label="Página anterior"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>

                  {/* Numeros de pagina */}
                  {Array.from({ length: Math.min(5, data.meta.pages) }, (_, i) => {
                    const mid = Math.min(Math.max(page, 3), data.meta.pages - 2);
                    const p = i + Math.max(1, mid - 2);
                    if (p > data.meta.pages) return null;
                    return (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={cn(
                          "w-7 h-7 text-xs rounded-lg transition-colors",
                          p === page
                            ? "bg-brand-black text-white font-medium"
                            : "hover:bg-gray-100 text-gray-600"
                        )}
                      >
                        {p}
                      </button>
                    );
                  })}

                  <button
                    onClick={() => setPage(Math.min(data.meta.pages, page + 1))}
                    disabled={page >= data.meta.pages}
                    className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                    aria-label="Próxima página"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setPage(data.meta.pages)}
                    disabled={page >= data.meta.pages}
                    className="px-2 py-1 text-xs border border-gray-200 rounded-lg disabled:opacity-30 hover:bg-gray-100 transition-colors"
                    aria-label="Última página"
                  >
                    &raquo;
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Modal de detalhe — usa o componente compartilhado */}
      {selectedId && (
        <LicitacaoDetalheModal
          resultadoId={selectedId}
          podeRegistrar={!!session?.user
            && ROLES_CONFORMIDADE.includes(session.user.role as typeof ROLES_CONFORMIDADE[number])}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
