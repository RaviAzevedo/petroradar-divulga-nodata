"use client";

import { useState, useEffect, useCallback, Suspense, useMemo, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search, ChevronLeft, ChevronRight, FileSpreadsheet,
  SlidersHorizontal, X, ChevronUp, ChevronDown,
  ArrowUpDown, Building2, Calendar, Clock, Zap, FileText,
  Flame, MapPin, Globe, Target, Sparkles, Satellite,
} from "lucide-react";
import { cn, relevanciaColor, formatDate, diasRestantes } from "@/lib/utils";
import { SEGMENTOS, FASES_LICITACAO, ESTADOS_BR } from "@/lib/constants";
import { faseColor } from "@/lib/format";
import { FilterChip } from "@/components/ui/FilterChip";
import { SavedFilters } from "@/components/ui/SavedFilters";
import { SkeletonTableRow, SkeletonCard } from "@/components/ui/Skeleton";
import ExplorarLoading from "./loading";

// ─── Tipos ─────────────────────────────────────────────────────────────────

interface Licitacao {
  id: string;
  numero: string;
  fonte: "petronect" | "transparencia" | string | null;
  objeto: string | null;
  empresa: string | null;
  subStatus: string | null;
  fase: string | null;
  modalidade: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  horaFim: string | null;
  dataPublicacao: string | null;
  dataDisputa: string | null;
  natureza: string | null;
  tipoServico: string | null;
  segmento: string | null;
  relevancia: string | null;
  scoreInteresse: number | null;
  regioes: string | null;
  abrangencia: string | null;
  perfisMatch: string | null;
  melhorPerfil: string | null;
  criadoEm: string | null;
  habilitacao?: "COBERTO" | "PARCIAL" | "NENHUM" | "SEM_ITENS" | null;
}

interface ApiMeta { total: number; page: number; limit: number; pages: number }

const SORT_FIELDS = ["score_interesse", "data_inicio", "data_fim", "data_publicacao", "numero", "empresa", "relevancia"] as const;
type SortField = typeof SORT_FIELDS[number];
type SortOrder = "asc" | "desc";

// ─── Helpers ──────────────────────────────────────────────────────────────

function isNovaLicitacao(criadoEm: string | null): boolean {
  if (!criadoEm) return false;
  const created = new Date(criadoEm).getTime();
  const now = Date.now();
  return (now - created) < 24 * 60 * 60 * 1000;
}

// Badge distintivo p/ licitações descobertas no Portal da Transparência.
// As nativas ('petronect') NÃO recebem badge — a ausência é o diferenciador.
function FonteTransparenciaBadge() {
  return (
    <span
      title="Descoberta no Portal da Transparência (não coletada nativamente pelo Petronect) — dados podem ser limitados"
      className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase bg-indigo-50 text-indigo-600 border border-indigo-200 rounded flex-shrink-0"
    >
      <Satellite className="h-3 w-3" />
      Transparência
    </span>
  );
}

function SortIcon({ field, current, order }: { field: SortField; current: SortField; order: SortOrder }) {
  if (field !== current) return <ArrowUpDown className="h-3 w-3 text-gray-300 ml-1 inline" />;
  return order === "asc"
    ? <ChevronUp className="h-3 w-3 text-brand-orange ml-1 inline" />
    : <ChevronDown className="h-3 w-3 text-brand-orange ml-1 inline" />;
}

// ─── Página ───────────────────────────────────────────────────────────────

function ExplorarPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [initialized, setInitialized] = useState(false);

  // Filtros
  const [search,     setSearch]     = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [empresa,    setEmpresa]    = useState("");
  const [fonte,      setFonte]      = useState("");   // "" | "petronect" | "transparencia"
  const [relevancia, setRelevancia] = useState("");
  const [natureza,   setNatureza]   = useState("");
  const [fase,       setFase]       = useState("");
  const [segmento,   setSegmento]   = useState("");
  const [scoreMin,   setScoreMin]   = useState("");   // "" | "40" | "70" ... (>= X)
  const [estado,     setEstado]     = useState("");   // UF por nome completo
  const [abrangencia,setAbrangencia]= useState("");   // "N" | "I"
  const [perfil,     setPerfil]     = useState("");   // nome do perfil de interesse
  const [prazo,      setPrazo]      = useState(""); // "hoje" | "7d" | "30d" | "vencidas"
  const [novas,         setNovas]         = useState(false);
  const [comCirculares, setComCirculares] = useState(false);
  const [dataFimDe,  setDataFimDe]  = useState("");
  const [dataFimAte, setDataFimAte] = useState("");
  const [dataPubDe,     setDataPubDe]     = useState("");
  const [dataPubAte,    setDataPubAte]    = useState("");
  const [dataInicioDe,  setDataInicioDe]  = useState("");
  const [dataInicioAte, setDataInicioAte] = useState("");

  // Ordenação
  const [sortBy, setSortBy] = useState<SortField>("score_interesse");
  const [order,  setOrder]  = useState<SortOrder>("desc");

  // Perfis de interesse ATIVOS (opções do select "Perfil de interesse").
  // null = ainda não carregou ou fetch falhou → select fica escondido.
  const [perfisOpcoes, setPerfisOpcoes] = useState<{ id: string; nome: string }[] | null>(null);

  // UI
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [page,  setPage]  = useState(1);
  const [data,  setData]  = useState<{ data: Licitacao[]; meta: ApiMeta } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Última query string escrita por nós via router.replace — permite ignorar o
  // "eco" da própria escrita quando searchParams muda (evita loop replace ↔ state).
  const lastWrittenQsRef = useRef<string | null>(null);

  // Lê query string na montagem (e quando a URL muda) antes de aplicar fetch/reset de página
  useEffect(() => {
    // Mudança de URL originada pelo nosso próprio updateURL: estado já está correto.
    if (lastWrittenQsRef.current !== null && searchParams.toString() === lastWrittenQsRef.current) return;

    const r = searchParams.get("relevancia");
    const f = searchParams.get("fase");
    const s = searchParams.get("segmento");
    const e = searchParams.get("empresa");
    const fo = searchParams.get("fonte");
    const p = searchParams.get("prazo");
    const n = searchParams.get("natureza");
    const q = searchParams.get("search");
    const nv = searchParams.get("novas");
    const cc = searchParams.get("com_circulares");
    if (r) setRelevancia(r);
    if (f) setFase(f);
    if (s) setSegmento(s);
    if (e) setEmpresa(e);
    if (fo) setFonte(fo);
    if (p) setPrazo(p);
    if (n) setNatureza(n);
    const sm = searchParams.get("score_min");
    const es = searchParams.get("estado");
    const ab = searchParams.get("abrangencia");
    const pf = searchParams.get("perfil");
    if (sm) setScoreMin(sm);
    if (es) setEstado(es);
    if (ab) setAbrangencia(ab);
    if (pf) setPerfil(pf);
    setNovas(nv === "1");
    setComCirculares(cc === "1");
    if (q) {
      setSearch(q);
      setDebouncedSearch(q);
    }
    // Datas (deep-link compartilhável de busca filtrada)
    const dfd = searchParams.get("data_fim_de");
    const dfa = searchParams.get("data_fim_ate");
    const dpd = searchParams.get("data_pub_de");
    const dpa = searchParams.get("data_pub_ate");
    const did = searchParams.get("data_inicio_de");
    const dia = searchParams.get("data_inicio_ate");
    if (dfd) setDataFimDe(dfd);
    if (dfa) setDataFimAte(dfa);
    if (dpd) setDataPubDe(dpd);
    if (dpa) setDataPubAte(dpa);
    if (did) setDataInicioDe(did);
    if (dia) setDataInicioAte(dia);
    // Ordenação e página
    const so = searchParams.get("sort");
    const or = searchParams.get("order");
    const pg = Number(searchParams.get("page"));
    if (so && (SORT_FIELDS as readonly string[]).includes(so)) setSortBy(so as SortField);
    if (or === "asc" || or === "desc") setOrder(or);
    if (Number.isInteger(pg) && pg >= 1) setPage(pg);
    setInitialized(true);
  }, [searchParams]);

  // Debounce do search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  // Carrega os perfis de interesse (opções do filtro) uma vez no mount.
  // Falha do fetch é tolerada: perfisOpcoes fica null e o select não aparece.
  useEffect(() => {
    let cancelado = false;
    fetch("/api/perfis")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { data?: { id: string; nome: string; ativo: boolean | null }[] }) => {
        if (cancelado) return;
        const ativos = (d.data ?? [])
          .filter((pf) => pf.ativo)
          .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
          .map((pf) => ({ id: pf.id, nome: pf.nome }));
        setPerfisOpcoes(ativos);
      })
      .catch(() => { if (!cancelado) setPerfisOpcoes(null); });
    return () => { cancelado = true; };
  }, []);

  // Construir URL e buscar.
  // Aceita um AbortSignal para cancelar o fetch anterior quando os filtros mudam
  // (evita race condition / waterfall ao trocar filtros rapidamente).
  const fetchData = useCallback((signal?: AbortSignal) => {
    const p = new URLSearchParams();
    p.set("page",  String(page));
    p.set("limit", "20");
    p.set("sort",  sortBy);
    p.set("order", order);
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (empresa)    p.set("empresa",    empresa);
    if (fonte)      p.set("fonte",      fonte);
    if (relevancia) p.set("relevancia", relevancia);
    if (natureza)   p.set("natureza",   natureza);
    if (fase)       p.set("fase",       fase);
    if (segmento)   p.set("segmento",   segmento);
    if (scoreMin)   p.set("score_min",  scoreMin);
    if (estado)     p.set("estado",     estado);
    if (abrangencia)p.set("abrangencia",abrangencia);
    if (perfil)     p.set("perfil",     perfil);
    if (prazo) {
      p.set("prazo", prazo);
    } else {
      if (dataFimDe)  p.set("data_fim_de",  dataFimDe);
      if (dataFimAte) p.set("data_fim_ate", dataFimAte);
    }
    if (dataPubDe)     p.set("data_pub_de",     dataPubDe);
    if (dataPubAte)    p.set("data_pub_ate",    dataPubAte);
    if (dataInicioDe)  p.set("data_inicio_de",  dataInicioDe);
    if (dataInicioAte) p.set("data_inicio_ate", dataInicioAte);
    if (novas) p.set("novas", "1");
    if (comCirculares) p.set("com_circulares", "1");

    setLoading(true);
    setError(null);
    // Tolera falhas TRANSITÓRIAS (erro de rede / 5xx — ex.: janela de restart de
    // container num deploy) com retry + backoff curto. Em 401 (sessão expirada)
    // manda para o login em vez do erro genérico. Aborts são ignorados.
    const carregar = async (tentativasRestantes: number): Promise<void> => {
      try {
        const r = await fetch(`/api/licitacoes?${p}`, { signal });
        if (r.status === 401) { window.location.href = "/login"; return; }
        if (!r.ok) {
          // 5xx é transitório -> tenta de novo; 4xx (exceto 401) é definitivo.
          if (r.status >= 500 && tentativasRestantes > 0) {
            await new Promise((res) => setTimeout(res, 500 * (3 - tentativasRestantes)));
            return carregar(tentativasRestantes - 1);
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const d = await r.json();
        setData(d); setLoading(false);
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return; // fetch substituído
        // Erro de rede (TypeError) é transitório -> retry com backoff.
        if (e instanceof TypeError && tentativasRestantes > 0) {
          await new Promise((res) => setTimeout(res, 500 * (3 - tentativasRestantes)));
          return carregar(tentativasRestantes - 1);
        }
        setError("Erro ao carregar licitações. Tente novamente.");
        setLoading(false);
      }
    };
    void carregar(2); // 1 tentativa + 2 retries (≈0.5s, 1.0s)
  }, [page, debouncedSearch, empresa, fonte, relevancia, natureza, fase, segmento, scoreMin, estado, abrangencia, perfil, prazo, dataFimDe, dataFimAte, dataPubDe, dataPubAte, dataInicioDe, dataInicioAte, novas, comCirculares, sortBy, order]);

  useEffect(() => {
    if (!initialized) return;
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [initialized, fetchData]);

  // Query string canônica derivada do estado atual (deep-link completo).
  // Defaults (sort padrão, página 1) ficam fora da URL para mantê-la limpa.
  const stateQs = useMemo(() => {
    const p = new URLSearchParams();
    if (relevancia)      p.set("relevancia", relevancia);
    if (fase)            p.set("fase", fase);
    if (segmento)        p.set("segmento", segmento);
    if (empresa)         p.set("empresa", empresa);
    if (fonte)           p.set("fonte", fonte);
    if (prazo)           p.set("prazo", prazo);
    if (natureza)        p.set("natureza", natureza);
    if (scoreMin)        p.set("score_min", scoreMin);
    if (estado)          p.set("estado", estado);
    if (abrangencia)     p.set("abrangencia", abrangencia);
    if (perfil)          p.set("perfil", perfil);
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (novas)           p.set("novas", "1");
    if (comCirculares)   p.set("com_circulares", "1");
    if (dataFimDe)       p.set("data_fim_de", dataFimDe);
    if (dataFimAte)      p.set("data_fim_ate", dataFimAte);
    if (dataPubDe)       p.set("data_pub_de", dataPubDe);
    if (dataPubAte)      p.set("data_pub_ate", dataPubAte);
    if (dataInicioDe)    p.set("data_inicio_de", dataInicioDe);
    if (dataInicioAte)   p.set("data_inicio_ate", dataInicioAte);
    if (sortBy !== "score_interesse") p.set("sort", sortBy);
    if (order !== "desc")             p.set("order", order);
    if (page > 1)                     p.set("page", String(page));
    return p.toString();
  }, [relevancia, fase, segmento, empresa, fonte, prazo, natureza, scoreMin, estado, abrangencia, perfil, debouncedSearch, novas, comCirculares, dataFimDe, dataFimAte, dataPubDe, dataPubAte, dataInicioDe, dataInicioAte, sortBy, order, page]);

  // Reset página ao mudar filtros (após URL inicial estar aplicada).
  // Quando o estado (sem `page`) ainda espelha a URL, a mudança veio da própria
  // URL (deep-link / back-forward) e o ?page= dela deve ser preservado.
  useEffect(() => {
    if (!initialized) return;
    const doEstado = new URLSearchParams(stateQs);
    const daUrl = new URLSearchParams(searchParams.toString());
    doEstado.delete("page");
    daUrl.delete("page");
    doEstado.sort();
    daUrl.sort();
    if (doEstado.toString() === daUrl.toString()) return;
    setPage(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dispara apenas em mudança de filtro/ordenação
  }, [initialized, debouncedSearch, empresa, fonte, relevancia, natureza, fase, segmento, scoreMin, estado, abrangencia, perfil, prazo, dataFimDe, dataFimAte, dataPubDe, dataPubAte, dataInicioDe, dataInicioAte, novas, comCirculares, sortBy, order]);

  // Sincroniza estado -> URL do navegador (replace raso, sem scroll).
  // Só faz replace quando a query string efetivamente muda (evita loop).
  useEffect(() => {
    if (!initialized) return;
    if (stateQs === searchParams.toString()) return;
    lastWrittenQsRef.current = stateQs;
    router.replace(stateQs ? `/explorar?${stateQs}` : "/explorar", { scroll: false });
  }, [initialized, stateQs, searchParams, router]);

  const currentFilterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (relevancia)      p.set("relevancia", relevancia);
    if (fase)            p.set("fase", fase);
    if (segmento)        p.set("segmento", segmento);
    if (empresa)         p.set("empresa", empresa);
    if (fonte)           p.set("fonte", fonte);
    if (prazo)           p.set("prazo", prazo);
    if (natureza)        p.set("natureza", natureza);
    if (scoreMin)        p.set("score_min", scoreMin);
    if (estado)          p.set("estado", estado);
    if (abrangencia)     p.set("abrangencia", abrangencia);
    if (perfil)          p.set("perfil", perfil);
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (dataFimDe)       p.set("data_fim_de", dataFimDe);
    if (dataFimAte)      p.set("data_fim_ate", dataFimAte);
    if (dataPubDe)       p.set("data_pub_de", dataPubDe);
    if (dataPubAte)      p.set("data_pub_ate", dataPubAte);
    if (dataInicioDe)    p.set("data_inicio_de", dataInicioDe);
    if (dataInicioAte)   p.set("data_inicio_ate", dataInicioAte);
    if (novas)           p.set("novas", "1");
    if (comCirculares)   p.set("com_circulares", "1");
    return p.toString();
  }, [
    relevancia, fase, segmento, empresa, fonte, prazo, natureza, scoreMin, estado, abrangencia, perfil, debouncedSearch,
    dataFimDe, dataFimAte, dataPubDe, dataPubAte, dataInicioDe, dataInicioAte, novas, comCirculares,
  ]);

  function handleApplySaved(params: string) {
    const p = new URLSearchParams(params);
    setRelevancia(p.get("relevancia") ?? "");
    setFase(p.get("fase") ?? "");
    setSegmento(p.get("segmento") ?? "");
    setEmpresa(p.get("empresa") ?? "");
    setFonte(p.get("fonte") ?? "");
    setPrazo(p.get("prazo") ?? "");
    setNatureza(p.get("natureza") ?? "");
    setScoreMin(p.get("score_min") ?? "");
    setEstado(p.get("estado") ?? "");
    setAbrangencia(p.get("abrangencia") ?? "");
    setPerfil(p.get("perfil") ?? "");
    setDataFimDe(p.get("data_fim_de") ?? "");
    setDataFimAte(p.get("data_fim_ate") ?? "");
    setDataPubDe(p.get("data_pub_de") ?? "");
    setDataPubAte(p.get("data_pub_ate") ?? "");
    setDataInicioDe(p.get("data_inicio_de") ?? "");
    setDataInicioAte(p.get("data_inicio_ate") ?? "");
    setNovas(p.get("novas") === "1");
    setComCirculares(p.get("com_circulares") === "1");
    const q = p.get("search") ?? "";
    setSearch(q);
    setDebouncedSearch(q);
  }

  function handleSort(field: SortField) {
    if (field === sortBy) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setOrder("desc");
    }
  }

  function clearAll() {
    setSearch(""); setEmpresa(""); setFonte(""); setRelevancia(""); setNatureza("");
    setFase(""); setSegmento(""); setScoreMin(""); setEstado(""); setAbrangencia(""); setPerfil("");
    setPrazo(""); setDataFimDe(""); setDataFimAte("");
    setDataPubDe(""); setDataPubAte("");
    setDataInicioDe(""); setDataInicioAte("");
    setNovas(false);
    setComCirculares(false);
    setPage(1);
  }

  // Chips de filtros ativos
  const chips: { label: string; clear: () => void }[] = [
    ...(relevancia ? [{ label: `Relevância: ${relevancia}`, clear: () => setRelevancia("") }] : []),
    ...(natureza   ? [{ label: `Natureza: ${natureza}`,     clear: () => setNatureza("") }]   : []),
    ...(fase       ? [{ label: `Fase: ${fase}`,             clear: () => setFase("") }]       : []),
    ...(segmento   ? [{ label: `Segmento: ${segmento}`,     clear: () => setSegmento("") }]   : []),
    ...(scoreMin   ? [{ label: `Score ≥ ${scoreMin}`,       clear: () => setScoreMin("") }]   : []),
    ...(estado     ? [{ label: `Estado: ${estado}`,         clear: () => setEstado("") }]     : []),
    ...(abrangencia ? [{ label: abrangencia === "N" ? "Nacional" : "Internacional", clear: () => setAbrangencia("") }] : []),
    ...(perfil     ? [{ label: `Perfil: ${perfil}`,         clear: () => setPerfil("") }]     : []),
    ...(empresa    ? [{ label: `Empresa: ${empresa}`,       clear: () => setEmpresa("") }]    : []),
    ...(fonte      ? [{ label: `Fonte: ${fonte === "petronect" ? "Petronect" : "Transparência"}`, clear: () => setFonte("") }] : []),
    ...(prazo === "hoje"    ? [{ label: "Vence hoje",    clear: () => setPrazo("") }] : []),
    ...(prazo === "7d"      ? [{ label: "Vence em 7d",   clear: () => setPrazo("") }] : []),
    ...(prazo === "30d"     ? [{ label: "Vence em 30d",  clear: () => setPrazo("") }] : []),
    ...(prazo === "vencidas"? [{ label: "Vencidas",      clear: () => setPrazo("") }] : []),
    ...(dataFimDe  ? [{ label: `Prazo a partir de ${dataFimDe}`,  clear: () => setDataFimDe("") }]  : []),
    ...(dataFimAte ? [{ label: `Prazo até ${dataFimAte}`,      clear: () => setDataFimAte("") }] : []),
    ...(dataPubDe     ? [{ label: `Publicado desde ${dataPubDe}`,       clear: () => setDataPubDe("") }]     : []),
    ...(dataPubAte    ? [{ label: `Publicado até ${dataPubAte}`,      clear: () => setDataPubAte("") }]    : []),
    ...(dataInicioDe  ? [{ label: `Início desde ${dataInicioDe}`,     clear: () => setDataInicioDe("") }]  : []),
    ...(dataInicioAte ? [{ label: `Início até ${dataInicioAte}`,      clear: () => setDataInicioAte("") }] : []),
    ...(novas ? [{ label: "Somente novas (24h)", clear: () => setNovas(false) }] : []),
    ...(comCirculares ? [{ label: "Com circulares", clear: () => setComCirculares(false) }] : []),
  ];

  const temFiltro = chips.length > 0 || search;

  // Estados visuais de carregamento (padrão stale-while-revalidate):
  // - Primeiro load (sem dados ainda): skeletons no lugar das linhas/cards.
  // - Re-fetch com dados anteriores: mantém o conteúdo visível com opacidade
  //   reduzida + indicador discreto, em vez de trocar tudo por spinner.
  const isFirstLoad = loading && !data;
  const isRefetching = loading && !!data;

  // URL de export com os filtros ativos
  function exportUrl(format: string) {
    const p = new URLSearchParams();
    // A planilha tem rota propria (/export/xlsx) e nao usa "format"; o limite
    // dela e o teto de 5000 do servidor, nao os 1000 da paginacao da tela.
    if (format !== "xlsx") {
      p.set("format", format);
      p.set("limit",  "1000");
    }
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (empresa)    p.set("empresa",    empresa);
    if (fonte)      p.set("fonte",      fonte);
    if (relevancia) p.set("relevancia", relevancia);
    if (natureza)   p.set("natureza",   natureza);
    if (fase)       p.set("fase",       fase);
    if (segmento)   p.set("segmento",   segmento);
    if (scoreMin)   p.set("score_min",  scoreMin);
    if (estado)     p.set("estado",     estado);
    if (abrangencia)p.set("abrangencia",abrangencia);
    if (perfil)     p.set("perfil",     perfil);
    if (prazo)      p.set("prazo",      prazo);
    if (dataFimDe)  p.set("data_fim_de",  dataFimDe);
    if (dataFimAte) p.set("data_fim_ate", dataFimAte);
    if (dataPubDe)     p.set("data_pub_de",     dataPubDe);
    if (dataPubAte)    p.set("data_pub_ate",    dataPubAte);
    if (dataInicioDe)  p.set("data_inicio_de",  dataInicioDe);
    if (dataInicioAte) p.set("data_inicio_ate", dataInicioAte);
    const base = format === "xlsx" ? "/api/licitacoes/export/xlsx" : "/api/licitacoes/export";
    return `${base}?${p}`;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Explorar Licitações</h1>
          {data && (
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="font-medium text-gray-700">{data.meta.total.toLocaleString("pt-BR")}</span> resultado{data.meta.total !== 1 ? "s" : ""}
              {temFiltro && <span className="text-brand-orange ml-1">· filtros ativos</span>}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {/* Um botao so: Excel. O CSV saia deslocado quando o segmento tinha
              virgula e o Excel pt-BR ainda pedia o assistente de importacao; o
              JSON nunca teve publico na tela. As rotas antigas continuam de pe
              para quem tiver link salvo. */}
          <button
            onClick={() => window.open(exportUrl("xlsx"), "_blank")}
            title="Baixa a seleção atual da tela em Excel, com objeto completo, datas e classificação"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <FileSpreadsheet className="h-3 w-3" /> Excel
          </button>
        </div>
      </div>

      {/* Painel de filtros */}
      <div className="bg-white rounded-xl border border-gray-200 mb-4 overflow-hidden">

        {/* Linha 1: busca principal + toggle avançado */}
        <div className="flex items-center gap-3 p-4 flex-wrap">
          {/* Busca */}
          <div className="relative flex-1 min-w-[260px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por número, objeto, empresa ou região..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); }}
              aria-label="Buscar"
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
            />
          </div>

          {/* Relevância */}
          <select
            value={relevancia}
            onChange={(e) => setRelevancia(e.target.value)}
            aria-label="Filtrar por relevância"
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todas relevâncias</option>
            <option value="ALTA">Alta</option>
            <option value="MÉDIA">Média</option>
            <option value="BAIXA">Baixa</option>
            <option value="SEM INTERESSE">— Sem interesse</option>
          </select>

          {/* Fonte (origem: scraper nativo Petronect vs. descoberta na Transparência) */}
          <select
            value={fonte}
            onChange={(e) => setFonte(e.target.value)}
            aria-label="Filtrar por fonte"
            title="Origem da licitação: coletada nativamente no Petronect ou descoberta no Portal da Transparência"
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todas as fontes</option>
            <option value="petronect">Petronect</option>
            <option value="transparencia">Transparência</option>
          </select>

          {/* Prazo rápido */}
          <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden">
            {[
              { v: "",         label: "Todos" },
              { v: "hoje",     label: "Hoje" },
              { v: "7d",       label: "7 dias" },
              { v: "30d",      label: "30 dias" },
              { v: "vencidas", label: "Vencidas" },
            ].map(({ v, label }) => (
              <button
                key={v}
                onClick={() => { setPrazo(v); if (v) { setDataFimDe(""); setDataFimAte(""); } }}
                className={cn(
                  "px-3 py-2 text-xs font-medium transition-colors",
                  prazo === v
                    ? "bg-brand-black text-white"
                    : "text-gray-500 hover:bg-gray-50"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Alto interesse (score ≥ 70) — atalho rápido */}
          <button
            onClick={() => setScoreMin((v) => (v === "70" ? "" : "70"))}
            title="Somente licitações com score de interesse ≥ 70"
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm rounded-lg border transition-colors",
              scoreMin === "70"
                ? "bg-red-50 text-red-700 border-red-300"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            )}
          >
            <Flame className="h-4 w-4" />
            Alto interesse
          </button>

          {/* Somente novas (24h) */}
          <button
            onClick={() => setNovas((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm rounded-lg border transition-colors",
              novas
                ? "bg-green-50 text-green-700 border-green-300"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            )}
          >
            <Zap className="h-4 w-4" />
            Novas 24h
          </button>

          {/* Com circulares */}
          <button
            onClick={() => setComCirculares((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm rounded-lg border transition-colors",
              comCirculares
                ? "bg-blue-50 text-blue-700 border-blue-300"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            )}
          >
            <FileText className="h-4 w-4" />
            Com circulares
          </button>

          {/* Botão avançado */}
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm rounded-lg border transition-colors",
              showAdvanced
                ? "bg-brand-black text-white border-brand-black"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filtros avançados
            {chips.length > 0 && (
              <span className="ml-1 bg-brand-orange text-black text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
                {chips.length}
              </span>
            )}
          </button>

          {/* Filtros salvos */}
          <SavedFilters
            storageKey="explorar-filters"
            currentParams={currentFilterParams}
            onApply={handleApplySaved}
          />

          {/* Limpar tudo */}
          {temFiltro && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
              aria-label="Limpar todos os filtros"
            >
              <X className="h-3.5 w-3.5" /> Limpar
            </button>
          )}
        </div>

        {/* Linha 2: Filtros avançados (colapsável) */}
        {showAdvanced && (
          <div className="border-t border-gray-100 bg-gray-50 px-4 py-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">

              {/* Natureza */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Natureza</label>
                <select
                  value={natureza}
                  onChange={(e) => setNatureza(e.target.value)}
                  aria-label="Filtrar por natureza"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                >
                  <option value="">Todas</option>
                  <option value="AQUISIÇÃO">Aquisição</option>
                  <option value="SERVIÇO">Serviço</option>
                  <option value="EPC / OBRA">EPC / Obra</option>
                  <option value="FORNECIMENTO COM SERVIÇO">Fornecimento c/ Serviço</option>
                  <option value="AFRETAMENTO / LOCAÇÃO">Afretamento / Locação</option>
                  <option value="LICENCIAMENTO / CREDENCIAMENTO">Licenciamento</option>
                  <option value="OUTROS">Outros</option>
                </select>
              </div>

              {/* Fase */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Fase</label>
                <select
                  value={fase}
                  onChange={(e) => setFase(e.target.value)}
                  aria-label="Filtrar por fase"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                >
                  <option value="">Todas as fases</option>
                  {FASES_LICITACAO.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>

              {/* Segmento */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Segmento</label>
                <select
                  value={segmento}
                  onChange={(e) => setSegmento(e.target.value)}
                  aria-label="Filtrar por segmento"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                >
                  <option value="">Todos os segmentos</option>
                  {SEGMENTOS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {/* Empresa */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Building2 className="h-3 w-3" /> Empresa contratante
                </label>
                <input
                  type="text"
                  value={empresa}
                  onChange={(e) => setEmpresa(e.target.value)}
                  placeholder="Ex: Petrobras..."
                  aria-label="Filtrar por empresa contratante"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Score mínimo de interesse */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Target className="h-3 w-3" /> Score mínimo
                </label>
                <select
                  value={scoreMin}
                  onChange={(e) => setScoreMin(e.target.value)}
                  aria-label="Filtrar por score mínimo de interesse"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                >
                  <option value="">Qualquer</option>
                  <option value="40">≥ 40</option>
                  <option value="60">≥ 60</option>
                  <option value="70">≥ 70 (alto)</option>
                  <option value="85">≥ 85 (altíssimo)</option>
                </select>
              </div>

              {/* Estado / UF */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Estado (UF)
                </label>
                <select
                  value={estado}
                  onChange={(e) => setEstado(e.target.value)}
                  aria-label="Filtrar por estado de atuação"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                >
                  <option value="">Todos os estados</option>
                  {ESTADOS_BR.map((uf) => (
                    <option key={uf} value={uf}>{uf}</option>
                  ))}
                </select>
              </div>

              {/* Abrangência */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Globe className="h-3 w-3" /> Abrangência
                </label>
                <select
                  value={abrangencia}
                  onChange={(e) => setAbrangencia(e.target.value)}
                  aria-label="Filtrar por abrangência"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                >
                  <option value="">Todas</option>
                  <option value="N">Nacional</option>
                  <option value="I">Internacional</option>
                </select>
              </div>

              {/* Perfil de interesse */}
              {perfisOpcoes && perfisOpcoes.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Perfil de interesse
                  </label>
                  <select
                    value={perfil}
                    onChange={(e) => setPerfil(e.target.value)}
                    aria-label="Filtrar por perfil de interesse"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                  >
                    <option value="">Todos os perfis</option>
                    {perfisOpcoes.map((pf) => (
                      <option key={pf.id} value={pf.nome}>{pf.nome}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Data Início — De */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Início cotação: de
                </label>
                <input
                  type="date"
                  value={dataInicioDe}
                  onChange={(e) => setDataInicioDe(e.target.value)}
                  aria-label="Início da cotação: a partir de"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Data Início — Até */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Início cotação: até
                </label>
                <input
                  type="date"
                  value={dataInicioAte}
                  onChange={(e) => setDataInicioAte(e.target.value)}
                  aria-label="Início da cotação: até"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Data Fim — De */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Data fim: de
                </label>
                <input
                  type="date"
                  value={dataFimDe}
                  onChange={(e) => { setDataFimDe(e.target.value); setPrazo(""); }}
                  aria-label="Data fim: a partir de"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Data Fim — Até */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Data fim: até
                </label>
                <input
                  type="date"
                  value={dataFimAte}
                  onChange={(e) => { setDataFimAte(e.target.value); setPrazo(""); }}
                  aria-label="Data fim: até"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Data Publicação — De */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Publicado: de
                </label>
                <input
                  type="date"
                  value={dataPubDe}
                  onChange={(e) => setDataPubDe(e.target.value)}
                  aria-label="Publicado: a partir de"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Data Publicação — Até */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Publicado: até
                </label>
                <input
                  type="date"
                  value={dataPubAte}
                  onChange={(e) => setDataPubAte(e.target.value)}
                  aria-label="Publicado: até"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>

              {/* Ordenar por */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Ordenar por
                </label>
                <div className="flex gap-2">
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortField)}
                    aria-label="Ordenar resultados por"
                    className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                  >
                    <option value="score_interesse">Score</option>
                    <option value="data_inicio">Data Início</option>
                    <option value="data_fim">Data Fim</option>
                    <option value="data_publicacao">Publicação</option>
                    <option value="numero">Número</option>
                    <option value="empresa">Empresa</option>
                    <option value="relevancia">Relevância</option>
                  </select>
                  <button
                    onClick={() => setOrder((o) => o === "asc" ? "desc" : "asc")}
                    className="px-3 py-2 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 text-gray-600"
                    aria-label={order === "desc" ? "Ordenar ascendente" : "Ordenar descendente"}
                  >
                    {order === "desc" ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Linha 3: chips de filtros ativos */}
        {chips.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 border-t border-gray-100">
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

      {/* Resultados — tabela (md+) e cards (mobile) */}
      <div className="relative bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Indicador discreto de revalidação: dados anteriores continuam visíveis */}
        {isRefetching && (
          <div className="absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-full bg-white/95 border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-500 shadow-sm">
            <div className="w-3 h-3 border-2 border-gray-300 border-t-brand-orange rounded-full animate-spin" />
            Atualizando…
          </div>
        )}

        <div
          className={cn(
            "hidden md:block overflow-x-auto transition-opacity duration-200",
            isRefetching && "opacity-50 pointer-events-none",
          )}
          aria-busy={loading}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  <button onClick={() => handleSort("numero")} className="flex items-center hover:text-gray-700" aria-label="Ordenar por número">
                    Número <SortIcon field="numero" current={sortBy} order={order} />
                  </button>
                </th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Objeto / Empresa</th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  <button onClick={() => handleSort("relevancia")} className="flex items-center hover:text-gray-700" aria-label="Ordenar por relevância">
                    Relevância <SortIcon field="relevancia" current={sortBy} order={order} />
                  </button>
                </th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">Habilitamos?</th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">Fase</th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">Natureza</th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">Segmento</th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  <button onClick={() => handleSort("data_inicio")} className="flex items-center hover:text-gray-700" aria-label="Ordenar por data de início">
                    Início <SortIcon field="data_inicio" current={sortBy} order={order} />
                  </button>
                </th>
                <th scope="col" className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  <button onClick={() => handleSort("data_fim")} className="flex items-center hover:text-gray-700" aria-label="Ordenar por data fim">
                    Fim <SortIcon field="data_fim" current={sortBy} order={order} />
                  </button>
                </th>
                <th scope="col" className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  <button onClick={() => handleSort("score_interesse")} className="flex items-center justify-end hover:text-gray-700" aria-label="Ordenar por score de interesse">
                    Score <SortIcon field="score_interesse" current={sortBy} order={order} />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {isFirstLoad ? (
                // Primeiro load: skeletons no formato da tabela (10 colunas)
                Array.from({ length: 10 }).map((_, i) => (
                  <SkeletonTableRow key={i} cols={10} />
                ))
              ) : data?.data.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400 text-sm">
                    Nenhuma licitação encontrada com os filtros aplicados.
                  </td>
                </tr>
              ) : (
                data?.data.map((lic) => {
                  const dias = diasRestantes(lic.dataFim);
                  return (
                    <tr key={lic.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">

                      {/* Número */}
                      <td className="px-4 py-3">
                        <div className="flex items-center">
                          <Link
                            href={`/licitacoes/${lic.id}`}
                            className="font-mono text-xs font-semibold text-brand-orange hover:underline whitespace-nowrap"
                          >
                            {lic.numero}
                          </Link>
                          {isNovaLicitacao(lic.criadoEm) && lic.fonte !== "transparencia" && (
                            <span
                              className="ml-1.5 px-1.5 py-0.5 text-[10px] font-bold uppercase bg-green-50 text-green-600 border border-green-200 rounded"
                              title={`Adicionada em ${new Date(lic.criadoEm!).toLocaleString("pt-BR")}`}
                            >
                              Nova
                            </span>
                          )}
                          {lic.fonte === "transparencia" && <FonteTransparenciaBadge />}
                        </div>
                      </td>

                      {/* Objeto + empresa */}
                      <td className="px-4 py-3 max-w-xs">
                        <Link href={`/licitacoes/${lic.id}`} title={lic.objeto || ""}>
                          <p className="text-sm text-gray-800 line-clamp-1 hover:text-gray-900 font-medium">
                            {lic.objeto || "-"}
                          </p>
                        </Link>
                        {lic.empresa && (
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{lic.empresa}</p>
                        )}
                      </td>

                      {/* Relevância */}
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border", relevanciaColor(lic.relevancia))}>
                          {lic.relevancia || "-"}
                        </span>
                        {lic.melhorPerfil && (
                          <p className="text-[10px] text-gray-400 mt-0.5 truncate" title={lic.perfisMatch ?? ""}>{lic.melhorPerfil}</p>
                        )}
                      </td>

                      {/* Habilitamos? (cobertura de famílias CRC da Proponente) */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        {lic.habilitacao === "COBERTO" ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-green-50 text-green-700 border-green-200" title="Todos os itens com família estão cobertos">
                            Sim
                          </span>
                        ) : lic.habilitacao === "PARCIAL" ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200" title="Parte dos itens com família está coberta">
                            Parcial
                          </span>
                        ) : lic.habilitacao === "NENHUM" ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-red-50 text-red-700 border-red-200" title="Nenhum item com família está coberto">
                            Não
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-gray-50 text-gray-400 border-gray-200" title="Sem itens com família cadastrada">
                            –
                          </span>
                        )}
                      </td>


                      {/* Fase */}
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap", faseColor(lic.fase))}>
                          {lic.fase || "-"}
                        </span>
                      </td>

                      {/* Natureza */}
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{lic.natureza || "-"}</td>

                      {/* Segmento */}
                      <td className="px-4 py-3 text-xs text-gray-500 max-w-[140px]">
                        <span className="line-clamp-1" title={lic.segmento ?? ""}>{lic.segmento || "-"}</span>
                      </td>

                      {/* Data Início */}
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {formatDate(lic.dataInicio)}
                      </td>

                      {/* Data Fim */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="text-xs text-gray-600">{formatDate(lic.dataFim)}</p>
                        {dias !== null && (
                          <p className={cn(
                            "text-xs font-semibold mt-0.5",
                            dias < 0    ? "text-gray-400 line-through" :
                            dias <= 3   ? "text-red-600" :
                            dias <= 7   ? "text-amber-600" :
                                          "text-gray-500"
                          )}>
                            {dias < 0 ? `${Math.abs(dias)}d atrás` : `${dias}d restantes`}
                          </p>
                        )}
                      </td>

                      {/* Score */}
                      <td className="px-4 py-3 text-right">
                        <span className={cn(
                          "text-sm font-bold tabular-nums",
                          (lic.scoreInteresse ?? 0) >= 70 ? "text-red-600" :
                          (lic.scoreInteresse ?? 0) >= 45 ? "text-amber-600" :
                          "text-gray-400"
                        )}>
                          {lic.scoreInteresse ?? "-"}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Cards (mobile, < md) — mesmo dataset e paginação da tabela */}
        <div
          className={cn(
            "md:hidden p-3 space-y-2.5 transition-opacity duration-200",
            isRefetching && "opacity-50 pointer-events-none",
          )}
          aria-busy={loading}
        >
          {isFirstLoad ? (
            Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          ) : data?.data.length === 0 ? (
            <p className="py-10 text-center text-gray-400 text-sm">
              Nenhuma licitação encontrada com os filtros aplicados.
            </p>
          ) : (
            data?.data.map((lic) => {
              const dias = diasRestantes(lic.dataFim);
              return (
                <Link
                  key={lic.id}
                  href={`/licitacoes/${lic.id}`}
                  className="block rounded-xl border border-gray-200 bg-white p-3 hover:border-brand-orange transition-colors"
                >
                  {/* Número + Nova + score */}
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="flex items-center min-w-0">
                      <span className="font-mono text-xs font-bold text-brand-orange truncate">{lic.numero}</span>
                      {isNovaLicitacao(lic.criadoEm) && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-bold uppercase bg-green-50 text-green-600 border border-green-200 rounded flex-shrink-0">
                          Nova
                        </span>
                      )}
                      {lic.fonte === "transparencia" && <FonteTransparenciaBadge />}
                    </span>
                    <span className={cn(
                      "text-sm font-bold tabular-nums flex-shrink-0",
                      (lic.scoreInteresse ?? 0) >= 70 ? "text-red-600" :
                      (lic.scoreInteresse ?? 0) >= 45 ? "text-amber-600" :
                      "text-gray-400"
                    )}>
                      {lic.scoreInteresse ?? "-"}
                    </span>
                  </div>

                  {/* Objeto (2 linhas) + empresa */}
                  <p className="text-sm text-gray-800 font-medium line-clamp-2">{lic.objeto || "-"}</p>
                  {lic.empresa && (
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{lic.empresa}</p>
                  )}

                  {/* Badges: relevância + fase */}
                  <div className="flex items-center gap-1.5 flex-wrap mt-2">
                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border", relevanciaColor(lic.relevancia))}>
                      {lic.relevancia || "-"}
                    </span>
                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold", faseColor(lic.fase))}>
                      {lic.fase || "-"}
                    </span>
                  </div>
                  {lic.melhorPerfil && (
                    <p className="text-[10px] text-gray-400 mt-0.5 truncate" title={lic.perfisMatch ?? ""}>{lic.melhorPerfil}</p>
                  )}

                  {/* Prazo */}
                  <p className="text-[11px] text-gray-500 mt-1.5">
                    {formatDate(lic.dataFim)}
                    {dias !== null && (
                      <span className={cn(
                        "ml-1.5 font-semibold",
                        dias < 0    ? "text-gray-400 line-through" :
                        dias <= 3   ? "text-red-600" :
                        dias <= 7   ? "text-amber-600" :
                                      "text-gray-500"
                      )}>
                        {dias < 0 ? `${Math.abs(dias)}d atrás` : `${dias}d restantes`}
                      </span>
                    )}
                  </p>
                </Link>
              );
            })
          )}
        </div>

        {/* Paginação */}
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
                «
              </button>
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                aria-label="Página anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              {/* Números de página */}
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
                »
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ExplorarPage() {
  return (
    <Suspense fallback={<ExplorarLoading />}>
      <ExplorarPageContent />
    </Suspense>
  );
}
