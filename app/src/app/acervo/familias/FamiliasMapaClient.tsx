"use client";

/**
 * MAPA DE FAMÍLIAS — o mercado observado cruzado com o nosso cadastro.
 *
 * A aba irmã (/acervo/familias) lista as famílias em que a Proponente está
 * CADASTRADA. Esta lista o mercado: as famílias que apareceram nas licitações
 * coletadas, marcando quais estão no cadastro e quais não.
 *
 * DUAS HONESTIDADES QUE A TELA TEM DE CARREGAR, e por isso estão em destaque em
 * vez de escondidas no código:
 *
 *   1. O catálogo NÃO é o oficial da Petrobras — é o que nós observamos. Parte das
 *      famílias cadastradas não aparece em licitação nenhuma da base.
 *      Ausência aqui não prova que a família não existe.
 *   2. INDÍCIO NÃO É PROVA, e a base nasce só com indício: apontamentos da máquina,
 *      sem vínculo confirmado por gente. O rótulo tem de
 *      distinguir os dois graus — e "sem indício" só vale para família que foi
 *      avaliada (menos da metade do catálogo); dizer "não comprovada" das demais seria
 *      mentir com cara de rigor.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, CalendarClock, ChevronRight, HelpCircle, Info, Loader2, Plus, Search, TrendingUp,
} from "lucide-react";
import { cn, diasRestantes, formatDate } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/Button";

type Quadrante = "NUCLEO" | "RISCO" | "OPORTUNIDADE" | "FORA_DE_ALCANCE" | "A_APURAR";

type EstadoProva = "COM_PROVA" | "COM_INDICIO" | "SEM_INDICIO" | "INDETERMINADO";

interface LinhaMapa {
  codigo: string;
  nome: string | null;
  segmento: "MATERIAL" | "SERVICO" | "OUTRO";
  escopo: string | null;
  grupo: string | null;
  segmentoPetrobras: string | null;
  licitacoes: number;
  ultimaVezEm: string | null;
  familiaId: string | null;
  cadastrada: boolean;
  statusFluxoCrc: string | null;
  validadeFim: string | null;
  documentosVinculados: number;
  documentosComIndicio: number;
  indiciosConfirmados: number;
  indiciosPendentes: number;
  maiorConfianca: number | null;
  melhorVeredito: string | null;
  justificativa: string | null;
  avaliada: boolean;
  prova: EstadoProva;
  quadrante: Quadrante;
}

interface Resposta {
  linhas: LinhaMapa[];
  truncado?: boolean;
  resumo: {
    porQuadrante: Partial<Record<Quadrante, { familias: number; licitacoes: number }>>;
    total: number;
    cadastradas: number;
    cadastradasSemDemanda: number;
    demandaTotal: number;
  };
  ressalva: {
    catalogoParcial: boolean; texto: string;
    provaIndisponivel: boolean; textoProva: string;
  };
}

/**
 * As três situações que a página existe para responder, na ordem em que quem decide
 * as pede. São VISÕES sobre a mesma lista — filtro, não tabelas diferentes.
 */
/**
 * As abas são as DECISÕES, não os estados.
 *
 * Antes havia uma aba "Não ativas" só, com centenas de linhas — e as poucas candidatas a
 * cadastro ficavam enterradas entre as que o acervo não sustenta. Quem abre
 * esta tela não quer "as não ativas": quer saber onde pedir CRC, e onde está
 * disputando sem poder provar.
 */
type Situacao = "DISPUTAVEL" | "RISCO" | "OPORTUNIDADE" | "FORA" | "TODAS";

const SITUACAO: Record<Situacao, { rotulo: string; ajuda: string; cor: string }> = {
  DISPUTAVEL: {
    rotulo: "Disputáveis",
    ajuda: "Cadastradas no CRC e com documento do acervo que as sustenta. É o que dá para disputar hoje.",
    cor: "border-emerald-300 bg-emerald-50",
  },
  RISCO: {
    rotulo: "Risco",
    ajuda: "Cadastradas, mas o acervo não as sustenta — disputa e perde na habilitação.",
    cor: "border-red-300 bg-red-50",
  },
  OPORTUNIDADE: {
    rotulo: "Oportunidade",
    ajuda: "O acervo sustenta e não temos o CRC. Candidatas a pedir cadastro.",
    cor: "border-amber-300 bg-amber-50",
  },
  FORA: {
    rotulo: "Fora de alcance",
    ajuda: "Sem cadastro e sem nada no acervo que sustente.",
    cor: "border-gray-200 bg-gray-50",
  },
  TODAS: { rotulo: "Todas", ajuda: "A lista inteira do recorte.", cor: "border-gray-200 bg-white" },
};

/** Grau de sustentação — a diferença entre indício e prova é o que impede um NO-GO errado. */
const PROVA: Record<EstadoProva, { rotulo: string; cor: string; ajuda: string }> = {
  COM_PROVA: {
    rotulo: "Comprovada",
    cor: "bg-emerald-50 text-emerald-800 border-emerald-200",
    ajuda: "Uma pessoa revisou e vinculou o documento. É o único grau que sustenta um NO-GO.",
  },
  COM_INDICIO: {
    rotulo: "Indício",
    cor: "bg-amber-50 text-amber-900 border-amber-200",
    ajuda: "A máquina apontou documento que sustenta, mas ninguém revisou ainda.",
  },
  SEM_INDICIO: {
    rotulo: "Sem lastro",
    cor: "bg-red-50 text-red-800 border-red-200",
    ajuda: "A família foi avaliada e nenhum documento do acervo a sustenta.",
  },
  INDETERMINADO: {
    rotulo: "A apurar",
    cor: "bg-sky-50 text-sky-800 border-sky-200",
    ajuda: "Ninguém perguntou por esta família ainda. Não é o mesmo que não termos.",
  },
};

const QUADRANTE: Record<Quadrante, { rotulo: string; ajuda: string; cor: string }> = {
  NUCLEO: {
    rotulo: "Núcleo",
    ajuda: "Cadastrados e com prova no acervo — o que dá para disputar hoje.",
    cor: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
  RISCO: {
    rotulo: "Risco",
    ajuda: "Cadastrados, mas sem prova no acervo — disputa e perde na habilitação.",
    cor: "bg-red-50 text-red-800 border-red-200",
  },
  OPORTUNIDADE: {
    rotulo: "Oportunidade",
    ajuda: "Temos a prova, falta o cadastro CRC.",
    cor: "bg-amber-50 text-amber-900 border-amber-200",
  },
  FORA_DE_ALCANCE: {
    rotulo: "Fora de alcance",
    ajuda: "Sem cadastro e sem prova.",
    cor: "bg-gray-50 text-gray-600 border-gray-200",
  },
  A_APURAR: {
    rotulo: "A apurar",
    ajuda: "Ainda não sabemos se o acervo prova esta família — não é o mesmo que não provar.",
    cor: "bg-sky-50 text-sky-800 border-sky-200",
  },
};

export default function MapaFamiliasClient() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [busca, setBusca] = useState("");
  const [buscaDebounce, setBuscaDebounce] = useState("");
  const [segmento, setSegmento] = useState<"SERVICO" | "MATERIAL">("SERVICO");
  const [soComNome, setSoComNome] = useState(true);
  const [situacao, setSituacao] = useState<Situacao>("OPORTUNIDADE");
  const [demandaMinima, setDemandaMinima] = useState("");
  const [grupo, setGrupo] = useState("");
  const [segPetrobras, setSegPetrobras] = useState("");
  const [ordem, setOrdem] = useState<"demanda" | "prova" | "recente" | "nome">("prova");
  const [revisao, setRevisao] = useState<"" | "PENDENTE" | "REVISADA">("");
  const [expandida, setExpandida] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounce(busca), 300);
    return () => clearTimeout(t);
  }, [busca]);

  const carregar = useCallback(() => {
    const p = new URLSearchParams({ segmento, limite: "1000" });
    if (soComNome) p.set("somenteComNome", "true");
    if (demandaMinima) p.set("demandaMinima", demandaMinima);
    if (revisao) p.set("revisao", revisao);
    if (buscaDebounce.trim()) p.set("busca", buscaDebounce.trim());

    setCarregando(true);
    setErro(null);
    fetch(`/api/conformidade/familias/mapa?${p}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Erro ${r.status}`);
        return r.json();
      })
      .then((d: Resposta) => { setDados(d); setCarregando(false); })
      .catch((e: Error) => { setErro(e.message || "Erro ao carregar"); setCarregando(false); });
  }, [segmento, soComNome, demandaMinima, buscaDebounce, revisao]);

  useEffect(() => { carregar(); }, [carregar]);

  const todas = dados?.linhas ?? [];
  const sustenta = (l: LinhaMapa) => l.prova === "COM_PROVA" || l.prova === "COM_INDICIO";
  const porSituacao: Record<Situacao, LinhaMapa[]> = {
    DISPUTAVEL: todas.filter((l) => l.cadastrada && sustenta(l)),
    RISCO: todas.filter((l) => l.cadastrada && !sustenta(l)),
    OPORTUNIDADE: todas.filter((l) => !l.cadastrada && sustenta(l)),
    FORA: todas.filter((l) => !l.cadastrada && !sustenta(l)),
    TODAS: todas,
  };

  const ordenar = (a: LinhaMapa, b: LinhaMapa) => {
    if (ordem === "prova") {
      // PROVA antes de PARCIAL antes do resto; depois, mais documentos primeiro.
      const forca = (l: LinhaMapa) =>
        l.melhorVeredito === "PROVA" ? 0 : l.melhorVeredito === "PARCIAL" ? 1 : 2;
      const d = forca(a) - forca(b);
      if (d) return d;
      return b.documentosComIndicio - a.documentosComIndicio;
    }
    if (ordem === "recente") {
      return (b.ultimaVezEm ?? "").localeCompare(a.ultimaVezEm ?? "");
    }
    if (ordem === "nome") return (a.nome ?? a.codigo).localeCompare(b.nome ?? b.codigo, "pt-BR");
    return b.licitacoes - a.licitacoes;
  };

  const linhas = porSituacao[situacao]
    .filter((l) => (grupo ? l.grupo === grupo : true))
    .filter((l) => (segPetrobras ? l.segmentoPetrobras === segPetrobras : true))
    .sort(ordenar);

  const grupos = Array.from(new Set(todas.map((l) => l.grupo).filter(Boolean) as string[])).sort();
  const segsPb = Array.from(
    new Set(todas.map((l) => l.segmentoPetrobras).filter(Boolean) as string[]),
  ).sort();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Famílias CRC</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            O que temos cadastrado, o que o mercado exigiu, e o que o acervo sustenta.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/acervo/familias/cadastro"
            className={buttonVariants({ variant: "secondary", className: "shadow-sm" })}
          >
            Lista do cadastro
          </Link>
          <Link href="/acervo/familias/nova" className={buttonVariants({ className: "shadow-sm" })}>
            <Plus className="h-4 w-4" /> Nova família
          </Link>
        </div>
      </div>

      {/* As duas ressalvas. Ficam no topo de propósito: sem elas a tela induz
          a ler ausência como negativa. */}
      {dados?.truncado && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          A lista foi cortada no teto de resultados — há mais famílias fora dela.
          Estreite o recorte (segmento, demanda, busca) para ver o resto.
        </div>
      )}

      {dados?.ressalva && (
        <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          <div className="flex gap-2">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="space-y-1.5">
              <p>{dados.ressalva.texto}</p>
              {dados.ressalva.provaIndisponivel && (
                <p className="font-medium">{dados.ressalva.textoProva}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {dados && !carregando && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          {(["DISPUTAVEL", "RISCO", "OPORTUNIDADE", "FORA", "TODAS"] as Situacao[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSituacao(k)}
              aria-pressed={situacao === k}
              title={SITUACAO[k].ajuda}
              className={cn(
                "text-left rounded-xl border p-3 transition-colors",
                situacao === k
                  ? cn(SITUACAO[k].cor, "ring-2 ring-brand-orange/40")
                  : "border-gray-200 bg-white hover:bg-gray-50",
              )}
            >
              <div className="text-xs text-gray-600">{SITUACAO[k].rotulo}</div>
              <div className="mt-0.5 text-2xl font-bold text-brand-black tabular-nums">
                {porSituacao[k].length.toLocaleString("pt-BR")}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-gray-400">
                <TrendingUp className="h-3 w-3" />
                {porSituacao[k].reduce((s, l) => s + l.licitacoes, 0).toLocaleString("pt-BR")} licitações
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 mb-5 p-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Buscar por código ou nome..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/40"
          />
        </div>

        <select
          value={segmento}
          onChange={(e) => setSegmento(e.target.value as "SERVICO" | "MATERIAL")}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
        >
          {/* MATERIAL existe mas é ruído aqui: a maior parte do catálogo
              é bem (válvula, transmissor) e as do cadastro são todas 99*. */}
          <option value="SERVICO">Serviços (99*)</option>
          <option value="MATERIAL">Materiais (98*)</option>
        </select>

        <select
          value={demandaMinima}
          onChange={(e) => setDemandaMinima(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
        >
          <option value="">Qualquer demanda</option>
          <option value="1">Exigida ao menos 1×</option>
          <option value="3">3× ou mais</option>
          <option value="5">5× ou mais</option>
          <option value="10">10× ou mais</option>
        </select>

        {/* Taxonomia do catálogo oficial: as famílias vêm com grupo e segmento.
            Sem estes dois filtros, achar "as de Estudos e Projetos" numa lista de
            centenas de linhas é rolagem, não busca. */}
        <select
          value={grupo}
          onChange={(e) => setGrupo(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white max-w-[230px]"
        >
          <option value="">Todos os grupos</option>
          {grupos.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>

        <select
          value={segPetrobras}
          onChange={(e) => setSegPetrobras(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
        >
          <option value="">Todo segmento</option>
          {segsPb.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>

        <select
          value={ordem}
          onChange={(e) => setOrdem(e.target.value as typeof ordem)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
        >
          <option value="prova">Ordenar: força da prova</option>
          <option value="demanda">Ordenar: demanda</option>
          <option value="recente">Ordenar: exigida há menos tempo</option>
          <option value="nome">Ordenar: nome</option>
        </select>

        {/* A FILA DE TRABALHO. São centenas de indícios; sem este filtro,
            descobrir o que ainda não passou por uma pessoa exigia abrir família
            por família. */}
        <select
          value={revisao}
          onChange={(e) => setRevisao(e.target.value as typeof revisao)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
        >
          <option value="">Revisão: qualquer</option>
          <option value="PENDENTE">Tem indício por revisar</option>
          <option value="REVISADA">Já confirmada por alguém</option>
        </select>

        <Alternador ativo={soComNome} onClick={() => setSoComNome((v) => !v)}>
          Só com nome
        </Alternador>
      </div>

      {erro && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {erro}
        </div>
      )}

      {carregando && (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando…
        </div>
      )}

      {!carregando && !erro && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Código</th>
                  <th className="text-left font-medium px-4 py-2.5">Família</th>
                  <th className="text-right font-medium px-4 py-2.5">Exigida em</th>
                  <th className="text-left font-medium px-4 py-2.5">Última vez</th>
                  <th className="text-left font-medium px-4 py-2.5">Cadastro</th>
                  <th className="text-left font-medium px-4 py-2.5">Validade</th>
                  <th className="text-left font-medium px-4 py-2.5">Acervo sustenta?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {linhas.map((l) => (
                  <Fragment key={l.codigo}>
                  <tr
                    className={cn("hover:bg-gray-50/70",
                      (l.escopo || l.justificativa) && "cursor-pointer")}
                    onClick={() => (l.escopo || l.justificativa)
                      && setExpandida(expandida === l.codigo ? null : l.codigo)}
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-700 whitespace-nowrap">
                      {(l.escopo || l.justificativa) && (
                        <ChevronRight className={cn("inline h-3 w-3 mr-1 text-gray-400 transition-transform",
                          expandida === l.codigo && "rotate-90")} />
                      )}
                      {l.codigo}
                    </td>
                    <td className="px-4 py-2.5">
                      {/* TODA linha abre o dossiê — inclusive a não cadastrada.
                          Antes só as do cadastro tinham link, e as do
                          catálogo (onde estão as oportunidades) eram texto
                          morto: a tela apontava a decisão e não deixava abri-la.
                          O detalhe aceita as duas chaves — uuid ou código. */}
                      <Link
                        href={`/acervo/familias/${l.familiaId ?? encodeURIComponent(l.codigo)}`}
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "hover:text-brand-orange",
                          l.nome ? "text-brand-black font-medium" : "text-gray-400 italic",
                        )}
                      >
                        {l.nome ?? "(sem nome no catálogo)"}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {l.licitacoes || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">
                      {l.ultimaVezEm ? formatDate(l.ultimaVezEm) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {l.cadastrada ? (
                        <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 border border-emerald-200">
                          CRC {l.statusFluxoCrc ?? "—"}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">não cadastrada</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {/* O aviso de renovação vencendo é o motivo de a aba de
                          cadastro existir. Trazê-lo para cá é o que permite
                          fundir as duas telas sem perder o operacional. */}
                      {l.validadeFim ? (
                        <ValidadeCrc iso={l.validadeFim} />
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        title={PROVA[l.prova].ajuda}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
                          PROVA[l.prova].cor,
                        )}
                      >
                        {l.melhorVeredito === "PARCIAL" ? "Parcial" : PROVA[l.prova].rotulo}
                        {l.prova === "INDETERMINADO" && <HelpCircle className="h-3 w-3" />}
                      </span>
                      {(l.documentosComIndicio > 0 || l.documentosVinculados > 0) && (
                        <span className="ml-1.5 text-xs text-gray-500 tabular-nums">
                          {l.documentosVinculados || l.documentosComIndicio} doc
                          {(l.documentosVinculados || l.documentosComIndicio) !== 1 ? "s" : ""}
                        </span>
                      )}
                      {/* O trabalho humano feito, visível no mapa. Sem isto,
                          revisar 16 indícios não muda nada nesta tela e a fila
                          parece parada mesmo quando alguém está trabalhando. */}
                      {l.indiciosConfirmados > 0 && (
                        <span
                          title={`${l.indiciosConfirmados} indício(s) já confirmados por uma pessoa. Só vira prova quando há vínculo — o que exige a família cadastrada.`}
                          className="ml-1.5 inline-flex items-center gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 tabular-nums"
                        >
                          ✓ {l.indiciosConfirmados} revisado{l.indiciosConfirmados !== 1 ? "s" : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                  {expandida === l.codigo && (
                    <tr className="bg-gray-50/80">
                      <td colSpan={7} className="px-4 py-3">
                        <div className="grid md:grid-cols-2 gap-4 text-sm">
                          {l.escopo && (
                            <div>
                              <div className="text-xs font-semibold text-gray-500 mb-1">
                                ESCOPO OFICIAL DA PETROBRAS
                                {l.grupo && <span className="ml-2 font-normal">· {l.grupo}</span>}
                              </div>
                              <p className="text-gray-700 whitespace-pre-line">{l.escopo.slice(0, 900)}</p>
                            </div>
                          )}
                          {l.justificativa && (
                            <div>
                              <div className="text-xs font-semibold text-gray-500 mb-1">
                                POR QUE O ACERVO SUSTENTA
                                {l.maiorConfianca != null && (
                                  <span className="ml-2 font-normal">
                                    · confiança {(l.maiorConfianca * 100).toFixed(0)}%
                                  </span>
                                )}
                              </div>
                              <p className="text-gray-700">{l.justificativa}</p>
                              {/* Este é o ponto em que a tela para de ser um placar e
                                  vira um argumento. Sem o trecho, "oportunidade" é
                                  uma palavra; com ele, é uma decisão de cadastro. */}
                              <p className="mt-1.5 text-xs text-amber-800">
                                Indício da máquina, ainda sem revisão humana — não sustenta um NO-GO.
                              </p>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
                {linhas.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                      Nenhuma família neste recorte.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Validade do CRC com o alerta de renovação — vermelho vence, âmbar 60 dias. */
function ValidadeCrc({ iso }: { iso: string }) {
  const dias = diasRestantes(iso);
  const critico = dias !== null && dias <= 0;
  const proximo = dias !== null && dias > 0 && dias <= 60;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        critico ? "text-red-700 font-medium" : proximo ? "text-amber-700 font-medium" : "text-gray-500",
      )}
      title={critico ? "CRC vencido" : proximo ? `Vence em ${dias} dias` : undefined}
    >
      {(critico || proximo) && <CalendarClock className="h-3 w-3" />}
      {formatDate(iso)}
    </span>
  );
}

function Cartao({ titulo, valor, icone, destaque }: {
  titulo: string; valor: number; icone?: React.ReactNode; destaque?: boolean;
}) {
  return (
    <div className={cn(
      "rounded-xl border p-4",
      destaque ? "border-brand-orange/30 bg-brand-orange/5" : "border-gray-200 bg-white",
    )}>
      <div className="flex items-center gap-1.5 text-xs text-gray-500">{icone}{titulo}</div>
      <div className="mt-1 text-2xl font-bold text-brand-black tabular-nums">
        {valor.toLocaleString("pt-BR")}
      </div>
    </div>
  );
}

function Alternador({ ativo, onClick, children }: {
  ativo: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className={cn(
        "px-3 py-2 text-sm rounded-lg border transition-colors",
        ativo
          ? "border-brand-orange bg-brand-orange/10 text-brand-black font-medium"
          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
      )}
    >
      {children}
    </button>
  );
}
