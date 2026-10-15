"use client";

/**
 * /acervo/painel — dashboard BI do acervo (ACERVO-PAINEL v2 §4).
 *
 * Duas fontes independentes (§1), carregadas em paralelo:
 *  - catálogo de operações, paginado em blocos de 200 (padrão do índice);
 *  - TODOS os documentos do cofre, paginados em blocos de 500 até `total`
 *    (teto de 6 páginas).
 * Cada fonte degrada sozinha: falha vira card com retry, nunca derruba o
 * painel inteiro. AbortController por fonte (refresh aborta a carga anterior).
 *
 * Toda a agregação vem de `@/lib/acervo/painel` (lógica pura, testada à parte);
 * os gráficos são SVG/div próprios de `./_graficos` (presentational, zero
 * fetch). Este arquivo só busca, deriva via memo e desenha a grade:
 *   linha 1 — Nota (Medidor) · Provabilidade (Rosca) · Dinheiro;
 *   linha 2 — Linha do tempo (Colunas) · Documentos por tipo (BarrasH);
 *   linha 3 — Situação das provas (Rosca) · Qualidade do cadastro · Alertas;
 *   linha 4 — Completude por contrato (tabs Pendentes/Completos/Vazios).
 * Interação de filtro navega por deep-link já existente (?provas=,
 * ?semOperacao=, ?status=, ?vencendoEm=, ?tipoDocumento=) — o painel não
 * guarda estado na URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileQuestion,
  FileX2,
  Hourglass,
  RefreshCw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Skeleton, SkeletonTableRow } from "@/components/ui/Skeleton";
import {
  analisarDocs,
  moedaCompacta,
  notaAcervo,
  nuvemDisciplinas,
  operacoesPorAno,
  paraNumero,
  resumirPainel,
  tabelaCompletude,
  type AnaliseDocs,
  type DocPainel,
  type FaixaAno,
  type LinhaCoberturaPainel,
  type LinhaCompletude,
  type OperacaoPainel,
  type ResumoPainel,
  type SituacaoDossie,
} from "@/lib/acervo/painel";
import {
  SITUACAO_PROVA_LABELS,
  TIPO_DOCUMENTO_LABELS,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { PALETA, corDaNota } from "./_graficos/paleta";
import { Rosca, type FatiaRosca } from "./_graficos/Rosca";
import { BarrasH, type ItemBarraH } from "./_graficos/BarrasH";
import { Colunas, type ColunaEmpilhada, type SegmentoColuna } from "./_graficos/Colunas";
import { Medidor } from "./_graficos/Medidor";
import { Nuvem } from "./_graficos/Nuvem";

// ── Fontes de dados (§1) ─────────────────────────────────────────────────────

/** Página de R1 (máximo do schema) e teto de segurança do laço — como o índice. */
const PAGINA_CATALOGO = 200;
const TETO_CATALOGO = 1000;

/** Cofre: máximo do schema (500) e teto de 6 páginas = 3.000 documentos (§1). */
const PAGINA_COFRE = 500;
const TETO_PAGINAS_COFRE = 6;

/** O recorte da lib + `restrito` (só o painel conta, a lib não precisa dele). */
interface DocCofre extends DocPainel {
  restrito: boolean;
}

type EstadoCatalogo =
  | { fase: "carregando" }
  | { fase: "erro" }
  | { fase: "ok"; ops: OperacaoPainel[]; totalServidor: number };

type EstadoCofre =
  | { fase: "carregando" }
  | { fase: "erro" }
  | { fase: "ok"; docs: DocCofre[]; totalServidor: number };

/**
 * D10 — terceira fonte: o C3 (`GET /api/conformidade/disciplinas/cobertura`,
 * onda 4), contado em SQL sobre a base INTEIRA. Não deriva de
 * `resumo.porDisciplina`, que conta o catálogo paginado até `TETO_CATALOGO`
 * (§4.6) — é por isso que o card diz, no subtítulo, de onde vem o número.
 */
type EstadoCobertura =
  | { fase: "carregando" }
  | { fase: "erro" }
  | { fase: "ok"; linhas: LinhaCoberturaPainel[] };

type Fase = "carregando" | "erro" | "ok";

/** Fase de um card que depende de DUAS fontes: erro ganha de carregando. */
function combinarFases(a: Fase, b: Fase): Fase {
  if (a === "erro" || b === "erro") return "erro";
  if (a === "carregando" || b === "carregando") return "carregando";
  return "ok";
}

// ── Paleta da provabilidade (compartilhada por rosca, colunas e legendas) ────

const SITUACOES: ReadonlyArray<{
  situacao: SituacaoDossie;
  rotulo: string;
  cor: string;
  href: string;
}> = [
  {
    situacao: "COMPLETO",
    rotulo: "Dossiê completo",
    cor: PALETA.verde,
    href: "/acervo/operacoes?provas=com-atestado",
  },
  {
    situacao: "COMPROVA_INCOMPLETO",
    rotulo: "Comprova, dossiê incompleto",
    cor: PALETA.verdeClaro,
    href: "/acervo/operacoes?provas=com-atestado",
  },
  {
    situacao: "SEM_ATESTADO",
    rotulo: "Sem atestado",
    cor: PALETA.ambar,
    href: "/acervo/operacoes?provas=sem-atestado",
  },
  {
    situacao: "VAZIO",
    rotulo: "Sem documentos",
    cor: PALETA.cinza,
    href: "/acervo/operacoes?provas=sem-documento",
  },
];

function situacoesZeradas(): Record<SituacaoDossie, number> {
  return { COMPLETO: 0, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 };
}

// ── Linha do tempo (§4.2) — colunas a partir de operacoesPorAno ──────────────

function rotuloAnoCurto(ano: number): string {
  return `’${String(ano % 100).padStart(2, "0")}`;
}

function segmentosDe(
  porSituacao: Record<SituacaoDossie, number> | null,
  periodo: string
): SegmentoColuna[] {
  if (!porSituacao) return [];
  return SITUACOES.map((s) => ({
    valor: porSituacao[s.situacao],
    cor: s.cor,
    titulo: `${periodo} · ${s.rotulo}: ${porSituacao[s.situacao].toLocaleString("pt-BR")}`,
  }));
}

/**
 * Faixas anuais → colunas do gráfico. Anos ausentes entre o primeiro e o
 * último viram coluna vazia (eixo do tempo de verdade, sem "pular" anos);
 * série com mais de 25 anos de extensão agrega em quinquênios ("95–99");
 * a faixa sem período (ano null) vira a célula "s/ data" cinza no fim.
 */
function colunasDaLinhaDoTempo(faixas: FaixaAno[]): ColunaEmpilhada[] {
  // Janela sã do eixo: um typo de ano ("0219-05-01" passa no ehDataIso) faria o
  // eixo cobrir séculos de colunas vazias. Fora da janela → junta em "s/ data".
  const anoMaximo = new Date().getFullYear() + 1;
  const comAno = faixas.filter(
    (f): f is FaixaAno & { ano: number } =>
      f.ano !== null && f.ano >= 1950 && f.ano <= anoMaximo
  );
  const forasDaJanela = faixas.filter(
    (f) => f.ano !== null && (f.ano < 1950 || f.ano > anoMaximo)
  );
  const semAnoOriginal = faixas.find((f) => f.ano === null) ?? null;
  const semAno: FaixaAno | null =
    forasDaJanela.length === 0
      ? semAnoOriginal
      : {
          ano: null,
          porSituacao: [semAnoOriginal, ...forasDaJanela].reduce(
            (soma, f) => {
              if (!f) return soma;
              for (const s of SITUACOES) soma[s.situacao] += f.porSituacao[s.situacao];
              return soma;
            },
            situacoesZeradas()
          ),
        };
  const colunas: ColunaEmpilhada[] = [];

  if (comAno.length > 0) {
    const primeiro = comAno[0].ano;
    const ultimo = comAno[comAno.length - 1].ano;

    if (ultimo - primeiro + 1 > 25) {
      const grupos = new Map<number, Record<SituacaoDossie, number>>();
      for (const faixa of comAno) {
        const inicio = Math.floor(faixa.ano / 5) * 5;
        const grupo = grupos.get(inicio) ?? situacoesZeradas();
        for (const s of SITUACOES) grupo[s.situacao] += faixa.porSituacao[s.situacao];
        grupos.set(inicio, grupo);
      }
      const inicioPrimeiro = Math.floor(primeiro / 5) * 5;
      const inicioUltimo = Math.floor(ultimo / 5) * 5;
      for (let inicio = inicioPrimeiro; inicio <= inicioUltimo; inicio += 5) {
        const rotulo = `${String(inicio % 100).padStart(2, "0")}–${String((inicio + 4) % 100).padStart(2, "0")}`;
        colunas.push({
          rotulo,
          segmentos: segmentosDe(grupos.get(inicio) ?? null, `${inicio}–${inicio + 4}`),
        });
      }
    } else {
      const porAno = new Map(comAno.map((f) => [f.ano, f.porSituacao]));
      for (let ano = primeiro; ano <= ultimo; ano++) {
        colunas.push({
          rotulo: rotuloAnoCurto(ano),
          segmentos: segmentosDe(porAno.get(ano) ?? null, String(ano)),
        });
      }
    }
  }

  if (semAno) {
    const totalSem = SITUACOES.reduce((soma, s) => soma + semAno.porSituacao[s.situacao], 0);
    colunas.push({
      rotulo: "s/ data",
      segmentos: [
        {
          valor: totalSem,
          cor: PALETA.cinza,
          titulo: `Sem período informado: ${totalSem.toLocaleString("pt-BR")} operações`,
        },
      ],
    });
  }

  return colunas;
}

// ── Documentos por tipo (§4.2) — top 8 + Sem tipo + Outros ───────────────────

const TOP_TIPOS = 8;

function rotuloTipo(tipo: string): string {
  return TIPO_DOCUMENTO_LABELS[tipo as TipoDocumento] ?? tipo;
}

function itensDocsPorTipo(analise: AnaliseDocs): ItemBarraH[] {
  const tipados = analise.porTipo.filter((t) => t.tipo !== "Sem tipo");
  const top = tipados.slice(0, TOP_TIPOS);
  const outrosN = tipados.slice(TOP_TIPOS).reduce((soma, t) => soma + t.n, 0);
  const outrosTipos = tipados.length - top.length;

  const itens: ItemBarraH[] = top.map((t) => ({
    rotulo: rotuloTipo(t.tipo),
    valor: t.n,
    cor: PALETA.laranja,
    titulo: `${rotuloTipo(t.tipo)}: ${t.n.toLocaleString("pt-BR")} — ver no cofre`,
    href: `/acervo/cofre?tipoDocumento=${encodeURIComponent(t.tipo)}`,
  }));

  // "Sem tipo" sempre visível (âmbar) quando existe — é fila de classificação.
  if (analise.semTipo > 0) {
    itens.push({
      rotulo: "Sem tipo",
      valor: analise.semTipo,
      cor: PALETA.ambar,
      titulo: `${analise.semTipo.toLocaleString("pt-BR")} documentos sem tipo — classificar no cofre`,
      href: "/acervo/cofre",
    });
  }
  itens.sort((a, b) => b.valor - a.valor);

  if (outrosN > 0) {
    itens.push({
      rotulo: "Outros",
      valor: outrosN,
      cor: PALETA.azul,
      titulo: `${outrosTipos.toLocaleString("pt-BR")} outros tipos agregados`,
    });
  }
  return itens;
}

// ── Provabilidade por disciplina (C5, spec ONDA-4 §7.9) — top 8 + "+N" ───────

const TOP_DISCIPLINAS = 8;

/**
 * `resumo.porDisciplina` → barras. `valor` são os dossiês COMPLETOS daquela
 * disciplina (a pergunta do card é "em que disciplinas conseguimos provar?"),
 * e o `title` traz também o total de obras da disciplina, senão uma barra
 * baixa não distingue "temos poucas obras" de "temos obras e não provamos".
 *
 * ⚠️ Uma obra com três disciplinas conta nas TRÊS: somar as barras não dá o
 * total de operações, e isso é de propósito (§4.6). A frase abaixo do gráfico
 * diz isso por extenso — sem ela, alguém soma, compara com o total do painel e
 * conclui que o painel está errado.
 *
 * Teto de 8, com um nono item agregando o resto (o molde de "Outros" em
 * `itensDocsPorTipo`): 16 barras num card de 4 colunas viram um borrão. O item
 * agregado NÃO tem `href` — não existe um filtro "as outras disciplinas".
 */
function itensPorDisciplina(resumo: ResumoPainel): ItemBarraH[] {
  const linhas = Object.entries(resumo.porDisciplina).map(([codigo, porSituacao]) => ({
    codigo,
    completos: porSituacao.COMPLETO,
    obras: SITUACOES.reduce((soma, s) => soma + porSituacao[s.situacao], 0),
  }));

  // Valor desc, código asc: a ordem tem de ser estável entre renders, e
  // disciplinas empatadas em zero apareceriam em ordem aleatória sem o desempate.
  linhas.sort((a, b) => b.completos - a.completos || a.codigo.localeCompare(b.codigo, "pt-BR"));

  const top = linhas.slice(0, TOP_DISCIPLINAS);
  const resto = linhas.slice(TOP_DISCIPLINAS);

  const itens: ItemBarraH[] = top.map((l) => ({
    rotulo: l.codigo,
    valor: l.completos,
    cor: PALETA.laranja,
    titulo: `${l.completos.toLocaleString("pt-BR")} obras com dossiê completo · ${l.obras.toLocaleString("pt-BR")} obras ao todo`,
    href: `/acervo/operacoes?disciplina=${encodeURIComponent(l.codigo)}`,
  }));

  if (resto.length > 0) {
    itens.push({
      rotulo: `+${resto.length} disciplinas`,
      valor: resto.reduce((soma, l) => soma + l.completos, 0),
      cor: PALETA.azul,
      titulo: `${resto.length.toLocaleString("pt-BR")} disciplinas fora do teto de ${TOP_DISCIPLINAS}, agregadas`,
    });
  }
  return itens;
}

// ── Situação das provas (§4.3) — cores por situação, resto violeta ───────────

const COR_SITUACAO_PROVA: Record<string, string> = {
  ASSINADA_CLIENTE: PALETA.verde,
  ASSINADA_PROPONENTE: PALETA.azul,
  INDEFINIDA: PALETA.cinza,
  Indefinida: PALETA.cinza, // fallback da lib para situacaoProva null
  RASCUNHO: PALETA.ambar,
};

const TOP_SITUACOES = 5;

function rotuloSituacaoProva(situacao: string): string {
  return SITUACAO_PROVA_LABELS[situacao as SituacaoProva] ?? situacao;
}

function fatiasSituacaoProva(analise: AnaliseDocs): FatiaRosca[] {
  // Agrega por RÓTULO antes do corte: o enum "INDEFINIDA" e o null legado
  // ("Indefinida") são a mesma coisa para o leitor — sem agregar, a rosca
  // renderia duas fatias cinza idênticas com a MESMA key React.
  const porRotulo = new Map<string, { valor: number; cor: string }>();
  for (const s of analise.porSituacao) {
    const rotulo = rotuloSituacaoProva(s.situacao);
    const atual = porRotulo.get(rotulo);
    if (atual) atual.valor += s.n;
    else
      porRotulo.set(rotulo, {
        valor: s.n,
        cor: COR_SITUACAO_PROVA[s.situacao] ?? PALETA.violeta,
      });
  }
  const ordenadas = [...porRotulo.entries()]
    .map(([rotulo, { valor, cor }]) => ({ rotulo, valor, cor }))
    .sort((a, b) => b.valor - a.valor || a.rotulo.localeCompare(b.rotulo, "pt-BR"));

  const top = ordenadas.slice(0, TOP_SITUACOES);
  const resto = ordenadas.slice(TOP_SITUACOES).reduce((soma, s) => soma + s.valor, 0);
  if (resto > 0) top.push({ rotulo: "Outras", valor: resto, cor: PALETA.violeta });
  return top;
}

// ── Qualidade do cadastro (§4.3) ─────────────────────────────────────────────

const LINHAS_QUALIDADE: ReadonlyArray<{
  chave: keyof ResumoPainel["cadastral"];
  rotulo: string;
}> = [
  { chave: "valor", rotulo: "Valor" },
  { chave: "periodo", rotulo: "Período" },
  { chave: "contratoNumero", rotulo: "Nº do contrato" },
  { chave: "grupo", rotulo: "Grupo do cliente" },
  { chave: "escopo", rotulo: "Objeto/escopo" },
];

// ── Tabela de completude (§4.4) ──────────────────────────────────────────────

type TabCompletude = "pendentes" | "completos" | "vazios";

const TABS_COMPLETUDE: ReadonlyArray<{
  chave: TabCompletude;
  rotulo: string;
  href: string;
  vazioMsg: string;
}> = [
  {
    chave: "pendentes",
    rotulo: "Pendentes",
    href: "/acervo/operacoes?provas=sem-atestado",
    vazioMsg: "Nenhuma operação com dossiê pendente.",
  },
  {
    chave: "completos",
    rotulo: "Completos",
    href: "/acervo/operacoes?provas=com-atestado",
    vazioMsg: "Nenhuma operação com dossiê completo ainda.",
  },
  {
    chave: "vazios",
    rotulo: "Vazios",
    href: "/acervo/operacoes?provas=sem-documento",
    vazioMsg: "Nenhuma operação sem documentos — catálogo todo lastreado.",
  },
];

const TOP_TABELA = 20;

// ── Componente ───────────────────────────────────────────────────────────────

export function PainelClient() {
  const [catalogo, setCatalogo] = useState<EstadoCatalogo>({ fase: "carregando" });
  const [cofre, setCofre] = useState<EstadoCofre>({ fase: "carregando" });
  const [cobertura, setCobertura] = useState<EstadoCobertura>({ fase: "carregando" });
  const [tab, setTab] = useState<TabCompletude>("pendentes");
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);

  /**
   * Um AbortController por fonte: o refresh geral aborta a carga anterior da
   * fonte antes de recomeçar (evita resposta velha atropelando a nova), e o
   * retry de um card só mexe na fonte dele.
   */
  const controllersRef = useRef<
    Partial<Record<"catalogo" | "cofre" | "cobertura", AbortController>>
  >({});

  const carregarCatalogo = useCallback(async () => {
    controllersRef.current.catalogo?.abort();
    const ctrl = new AbortController();
    controllersRef.current.catalogo = ctrl;
    setCatalogo({ fase: "carregando" });
    try {
      const acumulado: OperacaoPainel[] = [];
      let totalServidor = 0;
      for (let offset = 0; offset < TETO_CATALOGO; offset += PAGINA_CATALOGO) {
        const r = await fetch(
          `/api/conformidade/operacoes?limit=${PAGINA_CATALOGO}&offset=${offset}`,
          { signal: ctrl.signal }
        );
        const corpo = (await r.json().catch(() => null)) as {
          operacoes?: OperacaoPainel[];
          total?: number;
        } | null;
        if (!r.ok) throw new Error();
        // 200 sem o shape esperado = contrato quebrado, não catálogo vazio —
        // senão o painel inteiro renderiza zerado em silêncio.
        if (!corpo || !Array.isArray(corpo.operacoes)) throw new Error();
        const pagina = corpo.operacoes;
        acumulado.push(...pagina);
        totalServidor = corpo.total ?? acumulado.length;
        if (acumulado.length >= totalServidor || pagina.length === 0) break;
      }
      if (ctrl.signal.aborted) return;
      setCatalogo({ fase: "ok", ops: acumulado, totalServidor });
      setAtualizadoEm(new Date());
    } catch {
      if (!ctrl.signal.aborted) setCatalogo({ fase: "erro" });
    }
  }, []);

  const carregarCofre = useCallback(async () => {
    controllersRef.current.cofre?.abort();
    const ctrl = new AbortController();
    controllersRef.current.cofre = ctrl;
    setCofre({ fase: "carregando" });
    try {
      const acumulado: DocCofre[] = [];
      let totalServidor = 0;
      for (let pagina = 1; pagina <= TETO_PAGINAS_COFRE; pagina++) {
        const r = await fetch(
          `/api/conformidade/cofre/documentos?limit=${PAGINA_COFRE}&page=${pagina}`,
          { signal: ctrl.signal }
        );
        const corpo = (await r.json().catch(() => null)) as {
          data?: DocCofre[];
          total?: number;
        } | null;
        if (!r.ok) throw new Error();
        if (!corpo || !Array.isArray(corpo.data)) throw new Error();
        acumulado.push(...corpo.data);
        totalServidor = corpo.total ?? acumulado.length;
        if (acumulado.length >= totalServidor || corpo.data.length === 0) break;
      }
      if (ctrl.signal.aborted) return;
      setCofre({ fase: "ok", docs: acumulado, totalServidor });
      setAtualizadoEm(new Date());
    } catch {
      if (!ctrl.signal.aborted) setCofre({ fase: "erro" });
    }
  }, []);

  /**
   * D10 — o C3 SEM nenhum parâmetro: o painel é sobre o acervo inteiro (§7.10).
   * UMA chamada, sem laço: a resposta é uma linha por disciplina do catálogo.
   */
  const carregarCobertura = useCallback(async () => {
    controllersRef.current.cobertura?.abort();
    const ctrl = new AbortController();
    controllersRef.current.cobertura = ctrl;
    setCobertura({ fase: "carregando" });
    try {
      const r = await fetch("/api/conformidade/disciplinas/cobertura", { signal: ctrl.signal });
      const corpo = (await r.json().catch(() => null)) as {
        linhas?: LinhaCoberturaPainel[];
      } | null;
      if (!r.ok) throw new Error();
      // 200 sem o shape esperado = contrato quebrado, não catálogo vazio.
      if (!corpo || !Array.isArray(corpo.linhas)) throw new Error();
      if (ctrl.signal.aborted) return;
      setCobertura({ fase: "ok", linhas: corpo.linhas });
      setAtualizadoEm(new Date());
    } catch {
      if (!ctrl.signal.aborted) setCobertura({ fase: "erro" });
    }
  }, []);

  const carregarTudo = useCallback(() => {
    // As três cargas em paralelo (§1) — cada uma degrada por conta própria.
    void carregarCatalogo();
    void carregarCofre();
    void carregarCobertura();
  }, [carregarCatalogo, carregarCofre, carregarCobertura]);

  useEffect(() => {
    carregarTudo();
    const controllers = controllersRef.current;
    return () => {
      Object.values(controllers).forEach((c) => c?.abort());
    };
  }, [carregarTudo]);

  // ── Derivados (agregação 100% na lib) ──────────────────────────────────────

  const resumo = useMemo(
    () => (catalogo.fase === "ok" ? resumirPainel(catalogo.ops) : null),
    [catalogo]
  );
  const totalOps = catalogo.fase === "ok" ? catalogo.ops.length : 0;

  const analise = useMemo(
    () => (cofre.fase === "ok" ? analisarDocs(cofre.docs, new Date()) : null),
    [cofre]
  );
  const restritos = useMemo(
    () =>
      cofre.fase === "ok"
        ? cofre.docs.reduce((soma, d) => soma + (d.restrito ? 1 : 0), 0)
        : 0,
    [cofre]
  );

  const nota = useMemo(
    () => (resumo && analise ? notaAcervo(resumo, analise, totalOps) : null),
    [resumo, analise, totalOps]
  );

  const colunasTempo = useMemo(
    () => (catalogo.fase === "ok" ? colunasDaLinhaDoTempo(operacoesPorAno(catalogo.ops)) : null),
    [catalogo]
  );

  const completude = useMemo(
    () => (catalogo.fase === "ok" ? tabelaCompletude(catalogo.ops) : null),
    [catalogo]
  );

  // Percentuais da legenda fecham 100% (maior-resto) — arredondar cada fatia
  // isoladamente soma 99/101 em catálogos reais.
  const pctLegenda = useMemo(() => {
    const mapa = {} as Record<SituacaoDossie, number>;
    for (const s of SITUACOES) mapa[s.situacao] = 0;
    if (!resumo || totalOps === 0) return mapa;
    const exatos = SITUACOES.map((s) => (resumo.porSituacao[s.situacao] / totalOps) * 100);
    const finais = exatos.map((v) => Math.floor(v));
    let resto = 100 - finais.reduce((a, b) => a + b, 0);
    const porFracao = exatos
      .map((v, i) => ({ i, fracao: v - Math.floor(v) }))
      .sort((a, b) => b.fracao - a.fracao);
    for (const { i } of porFracao) {
      if (resto <= 0) break;
      finais[i] += 1;
      resto -= 1;
    }
    SITUACOES.forEach((s, i) => {
      mapa[s.situacao] = finais[i];
    });
    return mapa;
  }, [resumo, totalOps]);

  // Miolo da rosca = soma dos dois percentuais JÁ distribuídos pelo maior-resto
  // (um novo Math.round divergiria da legenda em 1 p.p.).
  const pctComprovam = pctLegenda.COMPLETO + pctLegenda.COMPROVA_INCOMPLETO;

  const opsSemValor = resumo ? totalOps - resumo.cadastral.valor : 0;

  /**
   * Operações que não declararam disciplina nenhuma — contadas na LISTA, não
   * derivadas de `porDisciplina`: lá uma obra com três disciplinas aparece em
   * três eixos, então somar os eixos não devolve "quantas obras entraram".
   * Este número é o que torna a soma das barras explicável (§4.6).
   */
  const opsSemDisciplina = useMemo(
    () =>
      catalogo.fase === "ok"
        ? catalogo.ops.reduce((soma, op) => soma + ((op.disciplinas ?? []).length === 0 ? 1 : 0), 0)
        : 0,
    [catalogo]
  );

  /**
   * D10 — a nuvem é 100% derivada; a lib não ordena por peso, a tela desenha na
   * ordem que o C3 mandou (`ordem, codigo` do catálogo).
   */
  const nuvem = useMemo(
    () => (cobertura.fase === "ok" ? nuvemDisciplinas(cobertura.linhas) : null),
    [cobertura]
  );

  // ⚠️ `algoCarregando` e `faseNota` NÃO ganham a cobertura (§7.10): a nota do
  // acervo não depende dela, e amarrá-las deixaria o medidor cinza por causa de
  // um card lateral.
  const algoCarregando = catalogo.fase === "carregando" || cofre.fase === "carregando";
  const faseNota = combinarFases(catalogo.fase, cofre.fase);

  const retryCatalogo = () => void carregarCatalogo();
  const retryCofre = () => void carregarCofre();
  const retryCobertura = () => void carregarCobertura();
  const retryNota = () => {
    if (catalogo.fase === "erro") void carregarCatalogo();
    if (cofre.fase === "erro") void carregarCofre();
  };

  const tabAtual = TABS_COMPLETUDE.find((t) => t.chave === tab) ?? TABS_COMPLETUDE[0];
  const linhasTab = completude ? completude[tabAtual.chave] : [];

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-[96rem]">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <Link
            href="/acervo"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
          >
            <ChevronLeft className="h-3 w-3" /> Acervo
          </Link>
          <h1 className="text-2xl font-bold text-brand-black">Painel do Acervo</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {atualizadoEm ? (
              <>
                dados carregados em{" "}
                <span className="tabular-nums">
                  {atualizadoEm.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                </span>{" "}
                às{" "}
                <span className="tabular-nums">
                  {atualizadoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </>
            ) : (
              "carregando os dados do acervo..."
            )}
          </p>
          {/* Tetos de segurança atingidos: agregados parciais NÃO podem passar
              por totais — avisar (hoje não dispara; bomba-relógio desarmada). */}
          {catalogo.fase === "ok" && catalogo.ops.length < catalogo.totalServidor && (
            <p className="text-xs text-amber-700 mt-1">
              analisando {catalogo.ops.length.toLocaleString("pt-BR")} de{" "}
              {catalogo.totalServidor.toLocaleString("pt-BR")} operações
            </p>
          )}
          {cofre.fase === "ok" && cofre.docs.length < cofre.totalServidor && (
            <p className="text-xs text-amber-700 mt-1">
              analisando {cofre.docs.length.toLocaleString("pt-BR")} de{" "}
              {cofre.totalServidor.toLocaleString("pt-BR")} documentos
            </p>
          )}
        </div>

        <Button variant="ghost" size="sm" onClick={carregarTudo} disabled={algoCarregando}>
          <RefreshCw
            className={cn("h-3.5 w-3.5", algoCarregando && "animate-spin")}
            aria-hidden="true"
          />{" "}
          Atualizar
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* ── Linha 1 — o veredito ─────────────────────────────────────────── */}

        {/* Nota do acervo (Medidor + componentes) — precisa das DUAS fontes. */}
        <Cartao
          className="lg:col-span-3"
          titulo="Nota do acervo"
          estado={faseNota}
          onRetry={retryNota}
          skeleton={<SkeletonGrafico alturaPx={220} />}
        >
          {nota && (
            <>
              <div className="flex justify-center">
                <Medidor
                  valor={nota.nota}
                  conceito={nota.conceito}
                  rotulo="média ponderada de 4 componentes"
                  tamanho={170}
                />
              </div>
              <div className="mt-4">
                <BarrasH
                  itens={nota.componentes.map((c) => ({
                    rotulo: `${c.rotulo} (${c.peso})`,
                    valor: Math.round(c.valor),
                    cor: corDaNota(c.valor),
                    titulo: `${c.rotulo} — peso ${c.peso}: ${Math.round(c.valor)}%`,
                  }))}
                  maximo={100}
                  formatar={(v) => `${v.toLocaleString("pt-BR")}%`}
                />
              </div>
            </>
          )}
        </Cartao>

        {/* Provabilidade (a pergunta nº 1) — Rosca + legenda clicável. */}
        <Cartao
          className="lg:col-span-5"
          titulo="Provabilidade do acervo"
          sub={
            resumo
              ? `${totalOps.toLocaleString("pt-BR")} operações no catálogo`
              : undefined
          }
          estado={catalogo.fase}
          onRetry={retryCatalogo}
          skeleton={<SkeletonGrafico alturaPx={220} redondo />}
        >
          {resumo && (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <Rosca
                fatias={SITUACOES.map((s) => ({
                  rotulo: s.rotulo,
                  valor: resumo.porSituacao[s.situacao],
                  cor: s.cor,
                }))}
                tamanho={180}
                centro={
                  <>
                    <span className="text-3xl font-bold tabular-nums text-brand-black">
                      {pctComprovam}%
                    </span>
                    <span className="text-[11px] text-gray-500">comprovam</span>
                  </>
                }
              />
              <div className="min-w-0 flex-1 space-y-1" style={{ minWidth: "14rem" }}>
                {SITUACOES.map((s) => {
                  const n = resumo.porSituacao[s.situacao];
                  return (
                    <Link
                      key={s.situacao}
                      href={s.href}
                      title={`Filtrar o índice: ${s.rotulo.toLowerCase()}`}
                      className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: s.cor }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 leading-snug">{s.rotulo}</span>
                      <span className="font-semibold tabular-nums text-gray-800">
                        {n.toLocaleString("pt-BR")}
                      </span>
                      <span className="w-10 text-right tabular-nums text-gray-400">
                        {pctLegenda[s.situacao]}%
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </Cartao>

        {/* Dinheiro — quanto do executado o acervo prova. */}
        <Cartao
          className="lg:col-span-4"
          titulo="Dinheiro comprovável"
          estado={catalogo.fase}
          onRetry={retryCatalogo}
          skeleton={<SkeletonGrafico alturaPx={180} />}
        >
          {resumo && (
            <>
              <p className="text-3xl font-bold leading-tight tabular-nums text-brand-orange">
                {moedaCompacta(resumo.valorComprovavel)}
              </p>
              <p className="mb-4 text-xs text-gray-500">
                de{" "}
                <span className="font-semibold tabular-nums">
                  {moedaCompacta(resumo.valorTotal)}
                </span>{" "}
                executados nas operações do catálogo
              </p>
              <BarrasH
                itens={[
                  {
                    rotulo: "Comprovável",
                    valor: resumo.valorComprovavel,
                    cor: PALETA.verde,
                    titulo: "Valor das operações que já têm atestado",
                  },
                  {
                    rotulo: "Sem atestado",
                    valor: resumo.valorSemAtestado,
                    cor: PALETA.ambar,
                    titulo: "Valor executado ainda sem prova (operações sem atestado)",
                  },
                  // Sem esta barra, Comprovável + Sem atestado não fecham com o
                  // total quando há operação com valor e ZERO documento.
                  ...(resumo.valorVazio > 0
                    ? [
                        {
                          rotulo: "Sem documentos",
                          valor: resumo.valorVazio,
                          cor: PALETA.cinza,
                          titulo:
                            "Valor de operações cadastradas sem nenhum documento no cofre",
                        },
                      ]
                    : []),
                ]}
                maximo={resumo.valorTotal}
                formatar={moedaCompacta}
              />
              {opsSemValor > 0 && (
                <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-400">
                  <span className="tabular-nums">{opsSemValor.toLocaleString("pt-BR")}</span>{" "}
                  operaç{opsSemValor === 1 ? "ão" : "ões"} sem valor informado fora da barra
                </p>
              )}
            </>
          )}
        </Cartao>

        {/* ── Linha 2 — o acervo no tempo e por tipo ───────────────────────── */}

        {/* Linha do tempo — colunas empilhadas por ano de início. */}
        <Cartao
          className="lg:col-span-7"
          titulo="Linha do tempo do acervo"
          sub="operações pelo ano de início do período"
          estado={catalogo.fase}
          onRetry={retryCatalogo}
          skeleton={<SkeletonGrafico alturaPx={200} />}
        >
          {colunasTempo && (
            <>
              <Colunas colunas={colunasTempo} alturaPx={160} />
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {SITUACOES.map((s) => (
                  <span
                    key={s.situacao}
                    className="inline-flex items-center gap-1.5 text-[11px] text-gray-500"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: s.cor }}
                      aria-hidden="true"
                    />
                    {s.rotulo}
                  </span>
                ))}
                {colunasTempo.some((c) => c.rotulo === "s/ data") && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
                    <span
                      className="h-2 w-2 rounded-full border border-dashed border-gray-400 bg-gray-100"
                      aria-hidden="true"
                    />
                    sem período informado
                  </span>
                )}
              </div>
            </>
          )}
        </Cartao>

        {/* Documentos por tipo — top 8 + Sem tipo + Outros. */}
        <Cartao
          className="lg:col-span-5"
          titulo="Documentos por tipo"
          sub={
            analise ? (
              <>
                <span className="tabular-nums">{analise.total.toLocaleString("pt-BR")}</span>{" "}
                documentos no cofre
                {restritos > 0 && (
                  <>
                    {" · "}
                    <span className="tabular-nums">{restritos.toLocaleString("pt-BR")}</span>{" "}
                    restritos
                  </>
                )}
              </>
            ) : undefined
          }
          estado={cofre.fase}
          onRetry={retryCofre}
          skeleton={<SkeletonBarras linhas={9} />}
        >
          {analise && <BarrasH itens={itensDocsPorTipo(analise)} />}
        </Cartao>

        {/* ── Linha 3 — saúde documental ───────────────────────────────────── */}

        {/* Situação das provas — rosca pequena do porSituacao. */}
        <Cartao
          className="lg:col-span-4"
          titulo="Situação das provas"
          estado={cofre.fase}
          onRetry={retryCofre}
          skeleton={<SkeletonGrafico alturaPx={150} redondo />}
        >
          {analise && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Rosca
                fatias={fatiasSituacaoProva(analise)}
                tamanho={140}
                espessura={18}
                centro={
                  <>
                    <span className="text-xl font-bold tabular-nums text-brand-black">
                      {analise.total.toLocaleString("pt-BR")}
                    </span>
                    <span className="text-[10px] text-gray-500">docs</span>
                  </>
                }
              />
              <ul className="min-w-0 flex-1 space-y-1.5">
                {fatiasSituacaoProva(analise).map((f) => (
                  <li key={f.rotulo} className="flex items-center gap-2 text-xs text-gray-600">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: f.cor }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate" title={f.rotulo}>
                      {f.rotulo}
                    </span>
                    <span className="font-semibold tabular-nums text-gray-800">
                      {f.valor.toLocaleString("pt-BR")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Cartao>

        {/* Provabilidade por disciplina (C5 — spec ONDA-4 §7.9). Fonte: R1, que
            traz `disciplinas` por operação; a agregação é `resumirPainel`, a
            mesma dos demais cards — nenhum card existente é tocado. */}
        <Cartao
          className="lg:col-span-4"
          titulo="Provabilidade por disciplina"
          estado={catalogo.fase}
          onRetry={retryCatalogo}
          skeleton={<SkeletonBarras linhas={6} />}
        >
          {resumo && <BarrasH itens={itensPorDisciplina(resumo)} />}
          <p className="mt-3 text-[11px] text-gray-400">
            Uma obra com três disciplinas conta nas três — a soma das barras não fecha com o total de
            operações. {opsSemDisciplina.toLocaleString("pt-BR")} operações não declararam disciplina.
          </p>
        </Cartao>

        {/* Qualidade do cadastro — os 5 campos, âmbar abaixo de 60%. */}
        <Cartao
          className="lg:col-span-4"
          titulo="Qualidade do cadastro"
          estado={catalogo.fase}
          onRetry={retryCatalogo}
          skeleton={<SkeletonBarras linhas={5} />}
        >
          {resumo && (
            <>
              <BarrasH
                itens={LINHAS_QUALIDADE.map((l) => {
                  const n = resumo.cadastral[l.chave];
                  const pct = totalOps > 0 ? Math.round((n / totalOps) * 100) : 0;
                  return {
                    rotulo: l.rotulo,
                    valor: n,
                    cor: pct < 60 ? PALETA.ambar : PALETA.laranja,
                    titulo: `${l.rotulo}: preenchido em ${pct}% das operações`,
                    href: "/acervo/operacoes",
                  };
                })}
                maximo={totalOps}
                formatar={(v) => {
                  const pct = totalOps > 0 ? Math.round((v / totalOps) * 100) : 0;
                  return `${v.toLocaleString("pt-BR")}/${totalOps.toLocaleString("pt-BR")} · ${pct}%`;
                }}
              />
              <div className="mt-3 border-t border-gray-100 pt-3">
                <Link
                  href="/acervo/operacoes"
                  className="text-xs text-brand-orange hover:underline"
                >
                  completar pelo índice →
                </Link>
              </div>
            </>
          )}
        </Cartao>

        {/* Alertas — órfãos, vencidos, vencendo, sem tipo. */}
        <Cartao
          className="lg:col-span-4"
          titulo="Alertas"
          estado={cofre.fase}
          onRetry={retryCofre}
          skeleton={<SkeletonBarras linhas={4} />}
        >
          {analise &&
            (analise.orfaos === 0 &&
            analise.vencidos === 0 &&
            analise.vencendo90d === 0 &&
            analise.semTipo === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-500" aria-hidden="true" />
                <p className="text-sm text-green-700">Nenhum alerta no cofre.</p>
              </div>
            ) : (
              <ul className="space-y-1">
                <LinhaAlerta
                  n={analise.orfaos}
                  rotulo="documentos órfãos (sem operação)"
                  href="/acervo/cofre?semOperacao=1"
                  icone={FileQuestion}
                  titulo="Ver documentos sem operação no cofre"
                />
                <LinhaAlerta
                  n={analise.vencidos}
                  rotulo="documentos vencidos"
                  href="/acervo/cofre?status=VENCIDO"
                  icone={Clock}
                  titulo="Ver documentos vencidos no cofre"
                />
                <LinhaAlerta
                  n={analise.vencendo90d}
                  rotulo="vencendo nos próximos 90 dias"
                  href="/acervo/cofre?vencendoEm=90"
                  icone={Hourglass}
                  titulo="Ver documentos que vencem em até 90 dias"
                />
                <LinhaAlerta
                  n={analise.semTipo}
                  rotulo="documentos sem tipo definido"
                  href="/acervo/cofre"
                  icone={FileX2}
                  titulo="Classificar documentos sem tipo no cofre"
                />
              </ul>
            ))}
        </Cartao>

        {/* Cobertura por disciplina (D10 — spec ONDA-5 §7.10). Terceira fonte
            (C3, contado em SQL sobre a base inteira); nenhum card existente é
            tocado. O SUBTÍTULO é obrigatório: o card "Provabilidade por
            disciplina" logo acima conta sobre o catálogo paginado desta tela, e
            com mais de 1.000 obras os dois números deixariam de bater — a tela
            tem de explicar de onde vem cada um em vez de se contradizer. */}
        <Cartao
          className="lg:col-span-4"
          titulo="Cobertura por disciplina"
          sub="obras por disciplina, coloridas pelo percentual com atestado — contado em SQL sobre a base inteira (não pelo catálogo carregado nesta tela)"
          estado={cobertura.fase}
          onRetry={retryCobertura}
          skeleton={<SkeletonBarras linhas={5} />}
        >
          {cobertura.fase === "ok" && nuvem && (
            <Nuvem
              itens={nuvem.itens}
              semCobertura={nuvem.semCobertura}
              hrefDe={(c) => `/acervo/operacoes?disciplina=${c}`}
            />
          )}
        </Cartao>

        {/* ── Linha 4 — completude por contrato (a tabela que o gestor pediu) ── */}

        <section className="lg:col-span-12 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 pb-3 pt-4">
            <div>
              <h2 className="text-sm font-semibold text-brand-black">
                Completude por contrato
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                o que cada dossiê já tem — contrato, ART/CAT e atestado
              </p>
            </div>
            {/* Botões-filtro simples (aria-pressed): o padrão ARIA de tablist
                exige aria-controls + roving tabindex, que não se cumpre aqui. */}
            {completude && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar completude">
                {TABS_COMPLETUDE.map((t) => {
                  const ativo = t.chave === tab;
                  return (
                    <button
                      key={t.chave}
                      type="button"
                      aria-pressed={ativo}
                      onClick={() => setTab(t.chave)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                        ativo
                          ? "border-brand-orange bg-orange-50 text-brand-black"
                          : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                      )}
                    >
                      {t.rotulo}{" "}
                      <span
                        className={cn(
                          "tabular-nums",
                          ativo ? "text-brand-orange" : "text-gray-400"
                        )}
                      >
                        ({completude[t.chave].length.toLocaleString("pt-BR")})
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {catalogo.fase === "carregando" && (
            <table className="w-full text-sm" aria-busy="true">
              <tbody>
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonTableRow key={i} cols={7} />
                ))}
              </tbody>
            </table>
          )}
          {catalogo.fase === "erro" && <FalhaCarga onRetry={retryCatalogo} />}
          {completude &&
            (linhasTab.length === 0 ? (
              <div className="p-10 text-center">
                <CheckCircle2
                  className="mx-auto mb-3 h-8 w-8 text-green-500"
                  aria-hidden="true"
                />
                <p className="text-sm text-gray-600">{tabAtual.vazioMsg}</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                        <th className="px-4 py-2.5 font-semibold">Operação</th>
                        <th className="px-4 py-2.5 text-center font-semibold">Contrato</th>
                        <th className="px-4 py-2.5 text-center font-semibold">ART/CAT</th>
                        <th className="px-4 py-2.5 text-center font-semibold">Atestado</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Valor</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Docs</th>
                        <th className="w-8 px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {linhasTab.slice(0, TOP_TABELA).map((linha) => (
                        <LinhaTabelaCompletude key={linha.op.id} linha={linha} tab={tab} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
                  <span className="text-xs text-gray-400 tabular-nums">
                    mostrando {Math.min(TOP_TABELA, linhasTab.length).toLocaleString("pt-BR")} de{" "}
                    {linhasTab.length.toLocaleString("pt-BR")} operações
                  </span>
                  <Link
                    href={tabAtual.href}
                    className="text-xs text-brand-orange hover:underline"
                  >
                    ver todas no índice →
                  </Link>
                </div>
              </>
            ))}
        </section>
      </div>
    </div>
  );
}

// ── Card genérico da grade (título, skeleton, erro com retry, conteúdo) ──────

function Cartao({
  titulo,
  sub,
  estado,
  onRetry,
  className,
  skeleton,
  children,
}: {
  titulo: string;
  sub?: React.ReactNode;
  estado: Fase;
  onRetry: () => void;
  className?: string;
  skeleton: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-gray-200 bg-white p-4", className)}>
      <div className="mb-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {titulo}
        </h2>
        {sub != null && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
      </div>
      {estado === "carregando" && skeleton}
      {estado === "erro" && <FalhaCarga onRetry={onRetry} />}
      {estado === "ok" && children}
    </section>
  );
}

// ── Linha do card de Alertas ─────────────────────────────────────────────────

function LinhaAlerta({
  n,
  rotulo,
  href,
  icone: Icone,
  titulo,
}: {
  n: number;
  rotulo: string;
  href: string;
  icone: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  titulo: string;
}) {
  return (
    <li>
      <Link
        href={href}
        title={titulo}
        className="-mx-1.5 flex items-center gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-gray-50"
      >
        <Icone
          className={cn("h-4 w-4 shrink-0", n > 0 ? "text-amber-500" : "text-gray-300")}
          aria-hidden={true}
        />
        <span
          className={cn(
            "w-12 shrink-0 text-right text-lg font-bold tabular-nums",
            n > 0 ? "text-amber-600" : "text-gray-400"
          )}
        >
          {n.toLocaleString("pt-BR")}
        </span>
        <span className="min-w-0 flex-1 text-xs leading-snug text-gray-600">{rotulo}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" aria-hidden="true" />
      </Link>
    </li>
  );
}

// ── Linha da tabela de completude (mesmo padrão de linha do índice) ──────────

function LinhaTabelaCompletude({ linha, tab }: { linha: LinhaCompletude; tab: TabCompletude }) {
  const router = useRouter();
  const op = linha.op;
  const cliente = op.clienteGrupo?.trim() || op.clienteNome;
  const objeto = (op.escopo ?? "").split("\n", 1)[0].trim();

  /** Linha inteira navega, mas o código continua <Link> real (a11y, nova aba). */
  function onClickLinha(e: React.MouseEvent<HTMLTableRowElement>) {
    if ((e.target as HTMLElement).closest("a, button")) return;
    router.push(`/acervo/operacoes/${op.id}`);
  }

  return (
    <tr
      onClick={onClickLinha}
      className="cursor-pointer border-b border-gray-100 transition-colors last:border-0 hover:bg-gray-50"
    >
      <td className="max-w-[30rem] px-4 py-3">
        <Link href={`/acervo/operacoes/${op.id}`} className="group block">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs font-bold text-brand-orange group-hover:underline">
              {op.codigo}
            </span>
            <span
              className="truncate text-sm font-semibold text-gray-800"
              title={op.clienteNome}
            >
              {cliente}
            </span>
          </span>
          {objeto && (
            <span className="block max-w-[28rem] truncate text-xs text-gray-500" title={objeto}>
              {objeto}
            </span>
          )}
        </Link>
      </td>
      <CelulaProva tem={linha.tem.contrato} rotulo="contrato" />
      <CelulaProva tem={linha.tem.artCat} rotulo="ART/CAT" />
      {/* No tab Pendentes o atestado é O que falta — o ✗ sobe pra âmbar. */}
      <CelulaProva
        tem={linha.tem.atestado}
        rotulo="atestado"
        corFalta={tab === "pendentes" ? "text-amber-500" : "text-gray-300"}
      />
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <span className="text-sm font-bold tabular-nums text-brand-black">
          {moedaCompacta(paraNumero(op.valor))}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <span className="text-sm tabular-nums text-gray-600">
          {op.totalDocumentos.toLocaleString("pt-BR")}
        </span>
      </td>
      <td className="w-8 px-4 py-3 text-right">
        <ChevronRight className="inline h-4 w-4 text-gray-300" aria-hidden="true" />
      </td>
    </tr>
  );
}

/** ✓/✗ de uma prova do dossiê, com tooltip e texto para leitor de tela. */
function CelulaProva({
  tem,
  rotulo,
  corFalta = "text-gray-300",
}: {
  tem: boolean;
  rotulo: string;
  corFalta?: string;
}) {
  return (
    <td className="px-4 py-3 text-center" title={tem ? `Tem ${rotulo}` : `Falta ${rotulo}`}>
      {tem ? (
        <Check className="inline h-4 w-4 text-green-600" aria-hidden="true" />
      ) : (
        <X className={cn("inline h-4 w-4", corFalta)} aria-hidden="true" />
      )}
      <span className="sr-only">{tem ? `tem ${rotulo}` : `falta ${rotulo}`}</span>
    </td>
  );
}

// ── Estados compartilhados de carga/erro ─────────────────────────────────────

/**
 * Skeleton de card com gráfico: círculo (roscas/medidor) ou bloco (colunas).
 * O tamanho vem por prop, então o bloco é um div com as classes do átomo
 * Skeleton + style inline (o átomo só aceita className).
 */
function SkeletonGrafico({ alturaPx, redondo = false }: { alturaPx: number; redondo?: boolean }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {redondo ? (
        <div className="flex items-center gap-6">
          <div
            className="shrink-0 animate-pulse rounded-full bg-gray-200"
            style={{ width: alturaPx, height: alturaPx }}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ) : (
        <div
          className="w-full animate-pulse rounded-lg bg-gray-200"
          style={{ height: alturaPx }}
        />
      )}
      <div className="flex gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

/** Skeleton de card com barras horizontais. */
function SkeletonBarras({ linhas }: { linhas: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: linhas }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3 w-28 shrink-0" />
          <Skeleton className="h-2.5 flex-1 rounded-full" />
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Degradação por card (§1): "—" + retry, sem derrubar o resto do painel. */
function FalhaCarga({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <span className="inline-flex items-center gap-2 text-2xl font-bold text-gray-300 tabular-nums">
        <AlertCircle className="h-5 w-5 text-gray-300" aria-hidden="true" />—
      </span>
      <p className="text-xs text-gray-500">Não foi possível carregar esta parte do painel.</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}
