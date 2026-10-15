"use client";

/**
 * /acervo/operacoes — o ÍNDICE de operações (portfólio — ACERVO-UI-V2 §4).
 *
 * Carrega o catálogo INTEIRO client-side (algumas centenas de operações em poucas requisições a R1)
 * porque o cartão-resumo precisa de contagens exatas sobre todas e os filtros
 * "sem prova" não existem server-side (a query de R1 é travada — `comProva` só
 * filtra o positivo). Busca, filtros, ordenação e paginação são locais sobre o
 * array; a busca server-side de R1 continua servindo o SeletorOperacao do
 * upload, que não muda.
 *
 * Estado na URL (?busca&detentora&provas&pagina) via router.replace, padrão do
 * cofre — link compartilhado abre a mesma tela.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle, ChevronLeft, ChevronRight, FileCheck2, FileQuestion, FileX2,
  Layers, Plus, Search, SearchX, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Skeleton, SkeletonTableRow } from "@/components/ui/Skeleton";
import {
  DETENTORAS,
  DETENTORA_LABELS,
  tituloOperacao,
  type Detentora,
} from "@/lib/conformidade/operacoes";
import { ModalNovaOperacao } from "@/app/acervo/cofre/novo/ModalNovaOperacao";
import { formatarPeriodo, normalizarBusca } from "./[id]/secoes";

// ── Tipos (item de R1, com os 2 agregados novos da 0034) ─────────────────────

interface OperacaoLista {
  id: string;
  codigo: string;
  clienteNome: string;
  clienteGrupo: string | null;
  contratoNumero: string | null;
  unidade: string | null;
  detentora: Detentora;
  periodoInicio: string | null;
  periodoFim: string | null;
  valor: string | null;
  escopo: string | null;
  totalDocumentos: number;
  totalAtestados: number;
  totalArtCat: number;
  totalContratos: number;
  /**
   * 0043 — disciplinas da obra (R1 §5.8d). OPCIONAL de propósito: a chave só
   * existe depois do commit 2, e operação sem ela não pode quebrar a tela.
   */
  disciplinas?: Array<{ id: string; codigo: string; nome: string }>;
}

/** Linha do catálogo (GET /api/conformidade/disciplinas) — popula o `<select>`. */
interface DisciplinaCatalogo {
  id: string;
  codigo: string;
  nome: string;
}

interface RespostaR1 {
  operacoes?: OperacaoLista[];
  total?: number;
  /**
   * 0044 (D11) — quantas obras ficaram FORA da janela por não terem período
   * informado. Vem sempre (0 sem janela) e é o número que faz a conta fechar
   * (Q4): sem ele, o total encolhe e ninguém explica a diferença.
   */
  semPeriodo?: number;
  /**
   * ECO do recorte aplicado pelo servidor — chave ausente = filtro ausente.
   * Serve de CONFERÊNCIA, não de fonte: quem escreve a frase do cabeçalho é a
   * tela, com o que ela pediu. Se os dois divergirem, é bug do servidor (§7.9).
   */
  filtros?: Record<string, unknown>;
  error?: string;
}

/** Página de R1 (máximo do schema) e teto de segurança do laço (5 × 200). */
const PAGINA_R1 = 200;
const TETO_CATALOGO = 1000;
/** Paginação local da tabela. */
const POR_PAGINA = 50;

// ── Filtro "Provas" (todas as combinações client-side — §4.4) ────────────────

type FiltroProvas =
  | ""
  | "com-documento"
  | "sem-documento"
  | "com-atestado"
  | "sem-atestado"
  | "sem-art-cat"
  | "sem-contrato";

const FILTROS_PROVAS: ReadonlyArray<{ valor: FiltroProvas; label: string }> = [
  { valor: "", label: "Todas" },
  { valor: "com-documento", label: "Com documento" },
  { valor: "sem-documento", label: "Sem documento" },
  { valor: "com-atestado", label: "Com atestado" },
  { valor: "sem-atestado", label: "Sem atestado" },
  { valor: "sem-art-cat", label: "Sem ART/CAT" },
  { valor: "sem-contrato", label: "Sem contrato" },
];

/**
 * "Sem X" exige ter ALGUM documento: operação vazia já tem filtro próprio, e
 * misturá-la em "sem atestado" esconderia a diferença entre "nunca alimentada"
 * e "alimentada mas sem a prova que habilita".
 */
function passaFiltroProvas(op: OperacaoLista, filtro: FiltroProvas): boolean {
  switch (filtro) {
    case "com-documento": return op.totalDocumentos > 0;
    case "sem-documento": return op.totalDocumentos === 0;
    case "com-atestado":  return op.totalAtestados > 0;
    case "sem-atestado":  return op.totalAtestados === 0 && op.totalDocumentos > 0;
    case "sem-art-cat":   return op.totalArtCat === 0 && op.totalDocumentos > 0;
    case "sem-contrato":  return op.totalContratos === 0 && op.totalDocumentos > 0;
    default: return true;
  }
}

const COR_DETENTORA: Record<Detentora, string> = {
  PROPONENTE: "bg-orange-50 text-orange-700 border-orange-200",
  COLIGADA:    "bg-blue-50 text-blue-700 border-blue-200",
  PARCEIRO: "bg-gray-100 text-gray-600 border-gray-200",
};

// ── Período compacto (§4.5 — a coluna mostra MM/AA; a data cheia vai no title)

/** "AAAA-MM-DD" → "MM/AA" sem passar por `Date` (fuso empurraria o mês). */
function mesAnoCurto(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[1].slice(2)}` : iso;
}

/** "AAAA-MM-DD" → "01/2018" (a frase do recorte fala em mês/ano, não em dia). */
function mesAnoLongo(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[1]}` : iso;
}

/** D11 — a segunda parte da frase do cabeçalho (§7.9). */
const ROTULO_ATIVO: Record<"" | "1" | "0", string> = {
  "": "todas (ativas e inativas)",
  "1": "só ativas",
  "0": "só inativas",
};

/**
 * D11 — a terceira parte da frase. Escrita SEMPRE, inclusive sem janela: é ela,
 * e não o `<select>`, que resolve o D11 — o sistema de origem tinha um corte
 * por data fixo na consulta e não tinha a frase.
 */
function fraseJanela(de: string, ate: string): string {
  if (!de && !ate) return "sem janela de período";
  if (de && ate) return `concluídas entre ${mesAnoLongo(de)} e ${mesAnoLongo(ate)}`;
  if (de) return `concluídas a partir de ${mesAnoLongo(de)}`;
  return `concluídas até ${mesAnoLongo(ate)}`;
}

function periodoCompacto(inicio: string | null, fim: string | null): string | null {
  if (inicio && fim) return `${mesAnoCurto(inicio)}–${mesAnoCurto(fim)}`;
  if (inicio) return `desde ${mesAnoCurto(inicio)}`;
  if (fim) return `até ${mesAnoCurto(fim)}`;
  return null;
}

// ── Conteúdo ─────────────────────────────────────────────────────────────────

function OperacoesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [initialized, setInitialized] = useState(false);

  const [operacoes, setOperacoes] = useState<OperacaoLista[] | null>(null);
  const [truncado, setTruncado] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [busca, setBusca] = useState("");
  const [buscaDebounced, setBuscaDebounced] = useState("");
  const [detentora, setDetentora] = useState<Detentora | "">("");
  const [provas, setProvas] = useState<FiltroProvas>("");
  /**
   * 0043 — filtro por disciplina. A chave da URL é o CÓDIGO (`?disciplina=INS`)
   * e não o uuid (§1g): código é legível, compartilhável e estável entre dev e
   * produção. A filtragem é client-side, como as demais desta tela.
   */
  const [disciplina, setDisciplina] = useState("");
  const [catalogoDisciplinas, setCatalogoDisciplinas] = useState<DisciplinaCatalogo[]>([]);
  /**
   * D11 — o histórico como recorte EXPLÍCITO (spec ONDA-5 §1c, §7.9).
   * TRI-ESTADO: "" = todas (ativas E inativas), que é o conjunto de hoje;
   * "1" = só ativas; "0" = só inativas. Um default "1" aqui seria, ele mesmo,
   * o corte escondido que o D11 existe para não repetir — e o dia seguinte
   * seria "sumiram obras do índice".
   *
   * ⚠️ Diferente de `busca`/`detentora`/`provas`/`disciplina`, estes três NÃO
   * são client-side: mudam o que o servidor devolve, e por isso entram no laço
   * de R1 (ponto 2) e não em `filtradas` (ponto 5).
   */
  const [ativo, setAtivo] = useState<"" | "1" | "0">("");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [semPeriodo, setSemPeriodo] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [ordemDocs, setOrdemDocs] = useState(false);

  const [modalNova, setModalNova] = useState(false);

  // Bloco 4 do cartão-resumo: contagem de órfãos (R6 semOperacao) —
  // best-effort: se falhar, o bloco simplesmente não renderiza.
  const [orfaos, setOrfaos] = useState<number | null>(null);

  /**
   * Laço de páginas de R1 até fechar o total (teto de 5 requisições / 1.000
   * operações — acima disso a faixa âmbar de truncamento avisa).
   */
  const carregarCatalogo = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const acumulado: OperacaoLista[] = [];
      let total = 0;
      let semPeriodoResp = 0;
      let houveTruncamento = false;

      for (let offset = 0; ; offset += PAGINA_R1) {
        if (offset >= TETO_CATALOGO) {
          houveTruncamento = true;
          break;
        }
        // D11: os três parâmetros viajam em TODAS as páginas do laço — o
        // recorte é do servidor, e uma página sem ele traria outro conjunto.
        const p = new URLSearchParams({ limit: String(PAGINA_R1), offset: String(offset) });
        if (ativo) p.set("ativo", ativo);
        if (de) p.set("de", de);
        if (ate) p.set("ate", ate);
        const r = await fetch(`/api/conformidade/operacoes?${p}`);
        const corpo = (await r.json().catch(() => null)) as RespostaR1 | null;
        if (!r.ok) throw new Error(corpo?.error ?? `Erro ${r.status}`);
        acumulado.push(...(corpo?.operacoes ?? []));
        total = corpo?.total ?? acumulado.length;
        semPeriodoResp = corpo?.semPeriodo ?? 0; // vem igual em todas as páginas
        if (acumulado.length >= total || (corpo?.operacoes ?? []).length === 0) break;
      }

      setOperacoes(acumulado);
      setSemPeriodo(semPeriodoResp);
      setTruncado(houveTruncamento);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar o catálogo de operações");
    } finally {
      setCarregando(false);
    }
  }, [ativo, de, ate]);

  useEffect(() => {
    // Só depois de ler a URL: sem esta porta, um deep-link `?ativo=1` pediria
    // o catálogo INTEIRO primeiro e o recortado em seguida — duas chamadas a
    // R1 e um piscar de linhas que o usuário não pediu.
    if (!initialized) return;
    void carregarCatalogo();
  }, [carregarCatalogo, initialized]);

  useEffect(() => {
    fetch("/api/conformidade/cofre/documentos?semOperacao=1&limit=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { total?: number } | null) => {
        if (j && typeof j.total === "number") setOrfaos(j.total);
      })
      .catch(() => {
        /* best-effort: sem bloco 4 */
      });
  }, []);

  // Catálogo de disciplinas para o <select> — UMA chamada ao montar. Se
  // falhar, o <select> fica só com "Todas as disciplinas" e o resto da tela
  // continua funcionando (best-effort, como a contagem de órfãos).
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

  // Estado inicial da URL (uma vez, padrão do cofre).
  useEffect(() => {
    const b = searchParams.get("busca");
    const d = searchParams.get("detentora");
    const p = searchParams.get("provas");
    const pg = searchParams.get("pagina");
    if (b) { setBusca(b); setBuscaDebounced(b); }
    if (d && (DETENTORAS as readonly string[]).includes(d)) setDetentora(d as Detentora);
    if (p && FILTROS_PROVAS.some((f) => f.valor === p)) setProvas(p as FiltroProvas);
    const dis = searchParams.get("disciplina");
    if (dis) setDisciplina(dis.toUpperCase());
    // D11: só os três valores do tri-estado entram; lixo na URL vira "todas",
    // que é o conjunto de hoje — nunca um recorte que ninguém pediu.
    const at = searchParams.get("ativo");
    if (at === "1" || at === "0") setAtivo(at);
    const dDe = searchParams.get("de");
    if (dDe && /^\d{4}-\d{2}-\d{2}$/.test(dDe)) setDe(dDe);
    const dAte = searchParams.get("ate");
    if (dAte && /^\d{4}-\d{2}-\d{2}$/.test(dAte)) setAte(dAte);
    if (pg && /^\d+$/.test(pg)) setPagina(Math.max(1, parseInt(pg, 10)));
    setInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounced(busca), 400);
    return () => clearTimeout(t);
  }, [busca]);

  const updateURL = useCallback(() => {
    const p = new URLSearchParams();
    if (buscaDebounced) p.set("busca", buscaDebounced);
    if (detentora) p.set("detentora", detentora);
    if (provas) p.set("provas", provas);
    if (disciplina) p.set("disciplina", disciplina);
    if (ativo) p.set("ativo", ativo);
    if (de) p.set("de", de);
    if (ate) p.set("ate", ate);
    if (pagina > 1) p.set("pagina", String(pagina));
    const qs = p.toString();
    router.replace(qs ? `/acervo/operacoes?${qs}` : "/acervo/operacoes", { scroll: false });
  }, [buscaDebounced, detentora, provas, disciplina, ativo, de, ate, pagina, router]);

  useEffect(() => {
    if (initialized) updateURL();
  }, [initialized, updateURL]);

  // Filtro muda → volta à página 1. A PRIMEIRA execução pós-inicialização é o
  // próprio deep-link aplicando os valores da URL (busca/detentora/provas mudam
  // no mesmo batch do initialized) — pular, senão ?busca=X&pagina=3 perde a página.
  const resetArmadoRef = useRef(false);
  useEffect(() => {
    if (!initialized) return;
    if (!resetArmadoRef.current) {
      resetArmadoRef.current = true;
      return;
    }
    setPagina(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscaDebounced, detentora, provas, disciplina, ativo, de, ate, initialized]);

  // ── Derivados ──────────────────────────────────────────────────────────────

  const filtradas = useMemo(() => {
    if (!operacoes) return [];
    const termo = normalizarBusca(buscaDebounced.trim());
    let lista = operacoes;
    if (termo) {
      lista = lista.filter((op) =>
        [op.codigo, op.clienteNome, op.clienteGrupo ?? "", op.contratoNumero ?? ""].some((campo) =>
          normalizarBusca(campo).includes(termo)
        )
      );
    }
    if (detentora) lista = lista.filter((op) => op.detentora === detentora);
    // `?? []` e não `!`: operação sem a chave (BFF antigo) SOME do resultado
    // filtrado, que é o certo — o filtro afirma "tem esta disciplina", e "não
    // sei" não é "tem".
    if (disciplina) {
      lista = lista.filter((op) => (op.disciplinas ?? []).some((d) => d.codigo === disciplina));
    }
    if (provas) lista = lista.filter((op) => passaFiltroProvas(op, provas));

    return [...lista].sort((a, b) =>
      ordemDocs
        ? b.totalDocumentos - a.totalDocumentos ||
          a.codigo.localeCompare(b.codigo, "pt-BR", { numeric: true })
        : a.codigo.localeCompare(b.codigo, "pt-BR", { numeric: true })
    );
  }, [operacoes, buscaDebounced, detentora, disciplina, provas, ordemDocs]);

  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / POR_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas);
  const daPagina = filtradas.slice((paginaAtual - 1) * POR_PAGINA, paginaAtual * POR_PAGINA);

  // Referência da barrinha de docs: o maior total DA PÁGINA visível (§4.5).
  const maxDocsPagina = useMemo(
    () => Math.max(1, ...daPagina.map((op) => op.totalDocumentos)),
    [daPagina]
  );

  /** Os quatro filtros CLIENT-SIDE — os que recortam o array já carregado. */
  const temFiltroLocal = Boolean(buscaDebounced || detentora || provas || disciplina);
  /** Com os três do servidor (D11): é o que o botão "limpar" tem de zerar. */
  const temFiltro = temFiltroLocal || Boolean(ativo || de || ate);
  const total = operacoes?.length ?? 0;
  const comAtestado = operacoes?.filter((op) => op.totalAtestados > 0).length ?? 0;
  const semDocumento = operacoes?.filter((op) => op.totalDocumentos === 0).length ?? 0;
  const pctAtestado = total > 0 ? Math.round((comAtestado / total) * 100) : 0;

  function limparFiltros() {
    setBusca("");
    setDetentora("");
    setProvas("");
    setDisciplina("");
    // D11: sem zerar os três, a tela mostraria "nenhuma operação" com um botão
    // que não resolve — o recorte do servidor continuaria valendo.
    setAtivo("");
    setDe("");
    setAte("");
  }

  /** Stat card clicado de novo com o filtro já ativo → desliga (toggle). */
  function toggleProvas(filtro: FiltroProvas) {
    setProvas((atual) => (atual === filtro ? "" : filtro));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <Link
            href="/acervo"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
          >
            <ChevronLeft className="h-3 w-3" /> Acervo
          </Link>
          <h1 className="text-2xl font-bold text-brand-black">Operações</h1>
          {/* D11 — o recorte por extenso, SEMPRE, inclusive quando não há
              recorte. As partes saem do estado que a TELA mandou; o `filtros`
              que o servidor ecoa serve de conferência, não de fonte (§7.9). */}
          {operacoes && !carregando && (
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="font-medium text-gray-700">{total.toLocaleString("pt-BR")}</span>{" "}
              operaç{total !== 1 ? "ões" : "ão"} no catálogo
              {" · "}
              {ROTULO_ATIVO[ativo]}
              {" · "}
              {fraseJanela(de, ate)}
              {(de || ate) && semPeriodo > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => {
                      setDe("");
                      setAte("");
                    }}
                    title="obras sem período informado não entram na janela — cadastre o período na ficha"
                    className="underline decoration-dotted hover:text-brand-orange"
                  >
                    {semPeriodo.toLocaleString("pt-BR")} obra{semPeriodo === 1 ? "" : "s"} fora da
                    janela por não {semPeriodo === 1 ? "ter" : "terem"} período
                  </button>
                </>
              )}
              {temFiltroLocal && <span className="text-brand-orange ml-1">· filtros ativos</span>}
            </p>
          )}
        </div>

        <Button onClick={() => setModalNova(true)} className="shadow-sm">
          <Plus className="h-4 w-4" aria-hidden="true" /> Cadastrar operação
        </Button>
      </div>

      {erro && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {erro}
          <button
            onClick={() => void carregarCatalogo()}
            className="ml-auto text-xs underline hover:no-underline"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {carregando && <SkeletonIndice />}

      {!carregando && !erro && truncado && operacoes && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>
            O índice carrega até {TETO_CATALOGO.toLocaleString("pt-BR")} operações de uma vez.
            Estão na tela {operacoes.length.toLocaleString("pt-BR")} — use a busca para encontrar
            as demais.
          </span>
        </div>
      )}

      {!carregando && !erro && operacoes && operacoes.length > 0 && (
        <>
          {/* Stat cards (§4) — botões-filtro com estado ativo. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard
              onClick={limparFiltros}
              ativo={false}
              icone={Layers}
              valor={total.toLocaleString("pt-BR")}
              rotulo="operações"
              titulo="Limpar filtros e ver todas"
            />
            <StatCard
              onClick={() => toggleProvas("com-atestado")}
              ativo={provas === "com-atestado"}
              icone={FileCheck2}
              valor={comAtestado.toLocaleString("pt-BR")}
              corValor="text-green-700"
              rotulo={`com atestado (${pctAtestado}%)`}
              titulo="Filtrar operações com atestado"
            />
            <StatCard
              onClick={() => toggleProvas("sem-documento")}
              ativo={provas === "sem-documento"}
              icone={FileX2}
              valor={semDocumento.toLocaleString("pt-BR")}
              corValor="text-amber-600"
              rotulo="sem documento nenhum"
              titulo="Filtrar operações sem documento"
            />
            {orfaos !== null && (
              <Link
                href="/acervo/cofre?semOperacao=1"
                className="flex flex-col items-start gap-0.5 bg-white border border-gray-200 rounded-xl p-3 hover:border-brand-orange transition-colors"
              >
                <span className="flex w-full items-center justify-between">
                  <span className="text-2xl font-bold text-amber-600 tabular-nums">
                    {orfaos.toLocaleString("pt-BR")}
                  </span>
                  <FileQuestion className="h-4 w-4 text-gray-300" aria-hidden="true" />
                </span>
                <span className="text-xs text-gray-500">provas sem operação ›</span>
              </Link>
            )}
          </div>

          {/* Busca e filtros (§4.4) */}
          <div className="bg-white rounded-xl border border-gray-200 mb-4">
            <div className="flex items-center gap-3 p-4 flex-wrap">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Buscar código, cliente ou contrato..."
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
                />
              </div>

              <select
                value={detentora}
                onChange={(e) => setDetentora(e.target.value as Detentora | "")}
                aria-label="Filtrar por detentora"
                className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
              >
                <option value="">Todas as detentoras</option>
                {DETENTORAS.map((d) => (
                  <option key={d} value={d}>
                    {DETENTORA_LABELS[d]}
                  </option>
                ))}
              </select>

              <select
                value={disciplina}
                onChange={(e) => setDisciplina(e.target.value)}
                disabled={catalogoDisciplinas.length === 0}
                aria-label="Filtrar por disciplina"
                className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600 disabled:opacity-60"
              >
                <option value="">Todas as disciplinas</option>
                {catalogoDisciplinas.map((d) => (
                  <option key={d.id} value={d.codigo}>
                    {d.codigo} — {d.nome}
                  </option>
                ))}
              </select>

              <select
                value={provas}
                onChange={(e) => setProvas(e.target.value as FiltroProvas)}
                aria-label="Filtrar por provas"
                className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
              >
                {FILTROS_PROVAS.map((f) => (
                  <option key={f.valor} value={f.valor}>
                    {f.label}
                  </option>
                ))}
              </select>

              {/* D11 — TRI-ESTADO, e "Todas" é o valor inicial e o único
                  default: um "Só ativas" por omissão passaria a esconder obras
                  que hoje aparecem (§1c). */}
              <select
                value={ativo}
                onChange={(e) => setAtivo(e.target.value as "" | "1" | "0")}
                aria-label="Filtrar por situação da operação"
                className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
              >
                <option value="">Todas (ativas e inativas)</option>
                <option value="1">Só ativas</option>
                <option value="0">Só inativas</option>
              </select>

              <label className="sr-only" htmlFor="filtro-periodo-de">
                Concluídas de
              </label>
              <input
                id="filtro-periodo-de"
                type="date"
                value={de}
                onChange={(e) => setDe(e.target.value)}
                title="Concluídas de"
                className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
              />
              <label className="sr-only" htmlFor="filtro-periodo-ate">
                até
              </label>
              <input
                id="filtro-periodo-ate"
                type="date"
                value={ate}
                onChange={(e) => setAte(e.target.value)}
                title="até"
                className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
              />

              {temFiltro && (
                <button
                  onClick={limparFiltros}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  <X className="h-3.5 w-3.5" /> limpar
                </button>
              )}
            </div>
          </div>

          {/* Tabela (§4.5) */}
          {filtradas.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
              <SearchX className="h-8 w-8 text-gray-300 mx-auto mb-3" aria-hidden="true" />
              <p className="text-sm text-gray-500 mb-3">
                Nenhuma operação encontrada com os filtros aplicados.
              </p>
              <Button variant="secondary" size="sm" onClick={limparFiltros}>
                Limpar filtros
              </Button>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <Th>Operação</Th>
                      <Th>Contrato nº</Th>
                      <Th>Detentora</Th>
                      <Th>Comprovação</Th>
                      <th
                        scope="col"
                        aria-sort={ordemDocs ? "descending" : "none"}
                        className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        <button
                          type="button"
                          onClick={() => setOrdemDocs((v) => !v)}
                          className="inline-flex items-center gap-1 hover:text-gray-700"
                          title="Ordenar por total de documentos"
                        >
                          Docs {ordemDocs && "↓"}
                        </button>
                      </th>
                      <Th>Período</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {daPagina.map((op) => (
                      <LinhaOperacao key={op.id} op={op} maxDocs={maxDocsPagina} />
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPaginas > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
                  <span className="text-xs text-gray-500">
                    Página <span className="font-medium">{paginaAtual}</span> de{" "}
                    <span className="font-medium">{totalPaginas}</span>
                    <span className="text-gray-400 ml-2">
                      · {filtradas.length.toLocaleString("pt-BR")} no total
                    </span>
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPagina(Math.max(1, paginaAtual - 1))}
                      disabled={paginaAtual <= 1}
                      className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                      aria-label="Página anterior"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setPagina(Math.min(totalPaginas, paginaAtual + 1))}
                      disabled={paginaAtual >= totalPaginas}
                      className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                      aria-label="Próxima página"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!carregando && !erro && operacoes && operacoes.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Layers className="h-10 w-10 text-gray-300 mb-4" aria-hidden="true" />
          <p className="text-sm text-gray-500 mb-6 max-w-md">
            Nenhuma operação cadastrada no catálogo.
          </p>
          <Button onClick={() => setModalNova(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Cadastrar operação
          </Button>
        </div>
      )}

      {modalNova && (
        <ModalNovaOperacao
          onFechar={() => setModalNova(false)}
          onCriada={(nova) => {
            setModalNova(false);
            void carregarCatalogo();
            router.push(`/acervo/operacoes/${nova.id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Skeleton do índice (§4 — stat cards + toolbar + tabela) ──────────────────

function SkeletonIndice() {
  return (
    <div aria-busy="true">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <Skeleton className="h-7 w-12" />
              <Skeleton className="h-4 w-4 rounded" />
            </div>
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="bg-white rounded-xl border border-gray-200 mb-4 p-4">
        <Skeleton className="h-10 w-full max-w-lg" />
      </div>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonTableRow key={i} cols={6} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Peças da tabela ──────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide"
    >
      {children}
    </th>
  );
}

function LinhaOperacao({ op, maxDocs }: { op: OperacaoLista; maxDocs: number }) {
  const router = useRouter();
  const titulo = tituloOperacao(op);
  const cliente = op.clienteGrupo?.trim() || op.clienteNome;
  const objeto = (op.escopo ?? "").split("\n", 1)[0].trim();
  const periodo = periodoCompacto(op.periodoInicio, op.periodoFim);
  const disciplinas = op.disciplinas ?? [];

  /**
   * Linha inteira navega, mas o código continua <Link> real (a11y, nova aba).
   * Clique em qualquer link/botão interno não pode disparar duas navegações.
   */
  function onClickLinha(e: React.MouseEvent<HTMLTableRowElement>) {
    if ((e.target as HTMLElement).closest("a, button")) return;
    router.push(`/acervo/operacoes/${op.id}`);
  }

  return (
    <tr
      onClick={onClickLinha}
      className="border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
    >
      <td className="px-4 py-3 max-w-[30rem]">
        <Link href={`/acervo/operacoes/${op.id}`} className="block group" title={titulo}>
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-xs font-bold text-brand-orange group-hover:underline shrink-0">
              {op.codigo}
            </span>
            {/* Razão social não ganha linha própria — vive só no title (§4). */}
            <span className="text-sm font-semibold text-gray-800 truncate" title={op.clienteNome}>
              {cliente}
            </span>
          </span>
          {objeto && (
            <span className="block text-xs text-gray-500 truncate max-w-[28rem]">{objeto}</span>
          )}
        </Link>
        {/* Até 3 códigos de disciplina (0043): o suficiente para a pessoa ver
            por que aquela linha passou no filtro, sem virar mural. */}
        {disciplinas.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 mt-0.5 font-mono text-[10px] text-gray-500">
            {disciplinas.slice(0, 3).map((d) => (
              <span key={d.id} title={d.nome}>
                {d.codigo}
              </span>
            ))}
            {disciplinas.length > 3 && <span>+{disciplinas.length - 3}</span>}
          </span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        {op.contratoNumero ? (
          <span className="text-xs text-gray-600 font-mono">{op.contratoNumero}</span>
        ) : (
          // A lacuna fica visível — corrigir é na ficha, não aqui (§4.5).
          <span className="text-xs text-gray-400 italic">não informado</span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <span
          className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
            COR_DETENTORA[op.detentora]
          )}
        >
          {DETENTORA_LABELS[op.detentora]}
        </span>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1">
          <PillProva
            rotulo="A"
            valor={op.totalAtestados}
            title={`${op.totalAtestados} atestado${op.totalAtestados === 1 ? "" : "s"} de capacidade técnica`}
          />
          <PillProva rotulo="ART" valor={op.totalArtCat} title={`${op.totalArtCat} ART/CAT`} />
          <PillProva
            rotulo="C"
            valor={op.totalContratos}
            title={`${op.totalContratos} peça${op.totalContratos === 1 ? "" : "s"} de contrato`}
          />
        </span>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs tabular-nums w-6 text-right",
              op.totalDocumentos === 0 ? "text-gray-300" : "text-gray-600"
            )}
          >
            {op.totalDocumentos}
          </span>
          {/* Barrinha proporcional ao maior total da página (§4.5). */}
          <span className="h-1 w-14 rounded-full bg-gray-200 overflow-hidden" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-brand-orange/60"
              style={{ width: `${Math.round((op.totalDocumentos / maxDocs) * 100)}%` }}
            />
          </span>
        </span>
      </td>
      <td
        className="px-4 py-3 whitespace-nowrap text-xs text-gray-500 tabular-nums"
        title={formatarPeriodo(op.periodoInicio, op.periodoFim) ?? undefined}
      >
        {periodo ?? "—"}
      </td>
    </tr>
  );
}

/** Mini-pill de comprovação: ponto verde quando a prova existe, âmbar na lacuna. */
function PillProva({ rotulo, valor, title }: { rotulo: string; valor: number; title: string }) {
  const tem = valor > 0;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
        tem
          ? "bg-green-50 text-green-700 border-green-200"
          : "bg-amber-50 text-amber-700 border-amber-200"
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", tem ? "bg-green-500" : "bg-amber-500")}
        aria-hidden="true"
      />
      {rotulo} {valor}
    </span>
  );
}

// ── Stat card (§4 — botão-filtro com estado ativo) ───────────────────────────

function StatCard({
  onClick,
  ativo,
  icone: Icone,
  valor,
  corValor = "text-brand-black",
  rotulo,
  titulo,
}: {
  onClick: () => void;
  ativo: boolean;
  icone: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  valor: string;
  corValor?: string;
  rotulo: string;
  titulo: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      title={titulo}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-colors",
        ativo
          ? "border-brand-orange ring-1 ring-brand-orange bg-orange-50/40"
          : "bg-white border-gray-200 hover:border-brand-orange"
      )}
    >
      <span className="flex w-full items-center justify-between">
        <span className={cn("text-2xl font-bold tabular-nums", corValor)}>{valor}</span>
        <Icone className="h-4 w-4 text-gray-300" aria-hidden={true} />
      </span>
      <span className="text-xs text-gray-500">{rotulo}</span>
    </button>
  );
}

// ── Export com Suspense (useSearchParams exige boundary) ─────────────────────

export function OperacoesClient() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-gray-300 border-t-brand-orange rounded-full animate-spin" />
          <span className="ml-2 text-sm text-gray-500">Carregando...</span>
        </div>
      }
    >
      <OperacoesContent />
    </Suspense>
  );
}
