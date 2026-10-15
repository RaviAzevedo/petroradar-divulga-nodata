"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import {
  Sparkles, Search, Loader2, AlertCircle, FileText, ShieldCheck,
  Library, Quote, ExternalLink, Filter, Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";

// ── Tipos do contrato de /api/acervo/buscar ───────────────────────────────────

type OrigemTipo = "ANEXO_EDITAL" | "DOC_HABILITACAO" | "PROJETO";

interface ArquivoOrigem {
  nome:         string;
  tipo:         string | null;
  numero:       string | null;
  emitidoEm:    string | null;
  situacao:     string | null;
  detentora:    string | null;   // PROPONENTE | COLIGADA | PARCEIRO
  operacao:     string | null;
  contrato:     string | null;
  cliente:      string | null;
  clienteGrupo: string | null;
  unidade:      string | null;
  escopo:       string | null;   // o que foi executado
  periodo:      string | null;   // "2018–2021"
  href:         string | null;
  download:     string | null;
}

interface TrechoRetrieval {
  numero:       number;
  origemTipo:   OrigemTipo;
  origemId:     string;
  licitacaoId:  string | null;
  chunkIndex:   number;
  similaridade: number;
  texto:        string;
  metadata:     Record<string, unknown> | null;
  arquivo?: ArquivoOrigem;
  /** Posição na lista textual da busca híbrida. Não-nulo = o texto encontrou
   *  este trecho; nulo = veio só pelo vetor. */
  posTexto?: number | null;
}

interface BuscaResponse {
  disponivel: boolean;
  resposta:   string | null;
  motivo?:    string;
  fontes:     unknown[];
  trechos:    TrechoRetrieval[];
  _meta?:     { modelo: string; tokensInput: number; tokensOutput: number };
}

// ── Metadados de origem para UI ───────────────────────────────────────────────

const ORIGEM_META: Record<OrigemTipo, { label: string; icon: typeof FileText; cor: string }> = {
  ANEXO_EDITAL:    { label: "Edital",      icon: FileText,    cor: "bg-blue-100 text-blue-700" },
  DOC_HABILITACAO: { label: "Habilitação", icon: ShieldCheck, cor: "bg-green-100 text-green-700" },
  PROJETO:         { label: "Projeto",     icon: Library,     cor: "bg-purple-100 text-purple-700" },
};

/** Empresa detentora da operação. Distinguir Proponente de COLIGADA na hora da
 *  leitura evita o erro caro: oferecer prova da coligada como se fosse nossa. */
const DETENTORA_COR: Record<string, string> = {
  PROPONENTE: "bg-brand-orange/10 text-brand-orange border-brand-orange/30",
  COLIGADA:    "bg-slate-100 text-slate-700 border-slate-300",
  PARCEIRO: "bg-amber-50 text-amber-800 border-amber-300",
};

type Detentora = "PROPONENTE" | "COLIGADA" | "PARCEIRO";

const FILTROS_EMPRESA: { id: Detentora; label: string }[] = [
  { id: "PROPONENTE", label: "Proponente" },
  { id: "COLIGADA",    label: "COLIGADA" },
];

/** Tipos de documento que valem como filtro no dia a dia. ATESTADO e CAT andam
 *  juntos porque é a distinção que decide habilitação: papel do cliente. */
const FILTROS_DOCUMENTO: { id: string[]; label: string }[] = [
  { id: ["ATESTADO", "CAT"], label: "Atestado / CAT" },
  { id: ["ART"],             label: "ART" },
  { id: ["CONTRATO", "ADITIVO"], label: "Contrato" },
];

const FILTROS_DESDE = [
  { valor: 0,    label: "qualquer período" },
  { valor: 2015, label: "desde 2015" },
  { valor: 2018, label: "desde 2018" },
  { valor: 2020, label: "desde 2020" },
  { valor: 2022, label: "desde 2022" },
];

/** Quantos trechos o retrieval devolve. O default do servidor é 8 — por isso
 *  toda busca trazia exatamente 8 fontes, independentemente da pergunta. */
const OPCOES_TOPK = [8, 12, 20];

const FILTROS_ORIGEM: { id: OrigemTipo; label: string }[] = [
  { id: "ANEXO_EDITAL",    label: "Editais" },
  { id: "DOC_HABILITACAO", label: "Habilitação" },
  { id: "PROJETO",         label: "Projetos" },
];

const EXEMPLOS = [
  "Quais atestados temos de obras de tubulação industrial?",
  "Já executamos serviço de inspeção de vasos de pressão na REF-A?",
  "Quais editais exigiram acervo técnico de caldeiraria nos últimos meses?",
];

export function AcervoClient() {
  const [pergunta, setPergunta]   = useState("");
  const [origens, setOrigens]     = useState<OrigemTipo[]>([]);
  const [topK, setTopK]           = useState(12);
  const [empresas, setEmpresas]   = useState<Detentora[]>([]);
  const [docs, setDocs]           = useState<string[]>([]);
  const [desde, setDesde]         = useState(0);
  const [loading, setLoading]     = useState(false);
  const [erro, setErro]           = useState<string | null>(null);
  const [resultado, setResultado] = useState<BuscaResponse | null>(null);

  const toggleEmpresa = (d: Detentora) =>
    setEmpresas((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));

  // Um chip de documento carrega 1..n tipos (Atestado/CAT são um botão só).
  const toggleDoc = (ids: string[]) =>
    setDocs((p) =>
      ids.every((i) => p.includes(i))
        ? p.filter((x) => !ids.includes(x))
        : [...p, ...ids.filter((i) => !p.includes(i))],
    );

  const toggleOrigem = (o: OrigemTipo) => {
    setOrigens((prev) =>
      prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o],
    );
  };

  const buscar = useCallback(async (q: string) => {
    const termo = q.trim();
    if (termo.length < 3) {
      setErro("Digite uma pergunta com pelo menos 3 caracteres.");
      return;
    }
    setLoading(true);
    setErro(null);
    setResultado(null);
    try {
      const res = await fetch("/api/acervo/buscar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pergunta: termo,
          origemTipo: origens.length > 0 ? origens : undefined,
          topK,
          detentora: empresas.length > 0 ? empresas : undefined,
          tipoDocumento: docs.length > 0 ? docs : undefined,
          desde: desde > 0 ? desde : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as BuscaResponse;
      setResultado(data);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro inesperado na busca.");
    } finally {
      setLoading(false);
    }
  }, [origens, topK, empresas, docs, desde]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    buscar(pergunta);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-brand-black flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-brand-orange" /> Acervo Técnico
        </h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Pergunte em linguagem natural sobre editais, documentos de habilitação e
          projetos da Proponente. As respostas citam a fonte de cada afirmação.
        </p>
      </div>

      {/* Caixa de busca */}
      <form onSubmit={onSubmit} className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            placeholder="Ex.: já executamos inspeção de vasos de pressão na REF-A?"
            className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
          />
        </div>

        {/* Filtros de origem */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <Filter className="h-3.5 w-3.5" /> Origem:
          </span>
          {FILTROS_ORIGEM.map((f) => {
            const ativo = origens.includes(f.id);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => toggleOrigem(f.id)}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-full border transition-colors",
                  ativo
                    ? "bg-brand-orange text-black border-brand-orange"
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
                )}
              >
                {f.label}
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="topk" className="text-xs text-gray-400">Trechos:</label>
            <select
              id="topk"
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            >
              {OPCOES_TOPK.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Buscar
            </Button>
          </div>
        </div>

        {/* Recorte do universo. Metade da imprecisão relatada era o usuário
            querendo buscar em menos coisa — só Proponente, só atestado, só
            recente. O metadado já vinha no JOIN; faltava deixar filtrar. */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
          <span className="text-xs text-gray-400">Empresa:</span>
          {FILTROS_EMPRESA.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => toggleEmpresa(f.id)}
              className={cn(
                "px-2.5 py-1 text-xs font-semibold rounded-full border transition-colors",
                empresas.includes(f.id)
                  ? DETENTORA_COR[f.id]
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
              )}
            >
              {f.label}
            </button>
          ))}

          <span className="ml-2 text-xs text-gray-400">Documento:</span>
          {FILTROS_DOCUMENTO.map((f) => {
            const ativo = f.id.every((i) => docs.includes(i));
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => toggleDoc(f.id)}
                className={cn(
                  "px-2.5 py-1 text-xs font-semibold rounded-full border transition-colors",
                  ativo
                    ? "bg-brand-black text-white border-brand-black"
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
                )}
              >
                {f.label}
              </button>
            );
          })}

          <select
            value={desde}
            onChange={(e) => setDesde(Number(e.target.value))}
            className="ml-auto text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
          >
            {FILTROS_DESDE.map((d) => (
              <option key={d.valor} value={d.valor}>{d.label}</option>
            ))}
          </select>
        </div>
      </form>

      {/* Exemplos (só antes da primeira busca) */}
      {!resultado && !loading && !erro && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Exemplos</p>
          <div className="flex flex-wrap gap-2">
            {EXEMPLOS.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => { setPergunta(ex); buscar(ex); }}
                className="text-left text-xs text-gray-600 bg-white border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-orange hover:text-brand-black transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Erro */}
      {erro && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {erro}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
          <span className="ml-2 text-sm text-gray-500">Pesquisando no acervo…</span>
        </div>
      )}

      {/* Resultado */}
      {!loading && resultado && (
        <div className="space-y-4">
          {/* Indisponível (gate gracioso do backend) */}
          {!resultado.disponivel && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Busca semântica indisponível</p>
                <p className="mt-0.5 text-amber-700">
                  {resultado.motivo ?? "O provider de embeddings não está configurado neste ambiente."}
                </p>
              </div>
            </div>
          )}

          {/* Resposta sintetizada com citações */}
          {resultado.disponivel && resultado.resposta && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-brand-orange" />
                <h2 className="text-sm font-semibold text-brand-black">Resposta</h2>
              </div>
              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
                {resultado.resposta}
              </p>
            </div>
          )}

          {/* Síntese indisponível mas trechos recuperados */}
          {resultado.disponivel && !resultado.resposta && resultado.motivo && (
            <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <p>{resultado.motivo}</p>
            </div>
          )}

          {/* Trechos / fontes */}
          {resultado.trechos.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                {agruparPorDocumento(resultado.trechos).length} documento
                {agruparPorDocumento(resultado.trechos).length === 1 ? "" : "s"}
                {" · "}{resultado.trechos.length} trecho
                {resultado.trechos.length === 1 ? "" : "s"}
              </p>
              {agruparPorDocumento(resultado.trechos).map((g) => (
                <FonteCard key={g.chave} grupo={g} />
              ))}
            </div>
          ) : (
            resultado.disponivel && (
              <p className="text-sm text-gray-500 text-center py-8">
                Nenhum trecho relevante encontrado no acervo para essa pergunta.
              </p>
            )
          )}

          {resultado._meta && (
            <p className="text-[10px] text-gray-300 text-right">
              {resultado._meta.modelo} · {resultado._meta.tokensInput} tokens entrada ·{" "}
              {resultado._meta.tokensOutput} tokens saída
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Agrupamento por documento ─────────────────────────────────────────────────

interface GrupoFonte {
  chave:    string;
  numero:   number;              // posição do melhor trecho no ranking
  arquivo:  ArquivoOrigem | null;
  origemTipo: OrigemTipo;
  licitacaoId: string | null;
  metadata: Record<string, unknown> | null;
  melhorSim: number;
  trechos:  TrechoRetrieval[];
}

/**
 * Junta os trechos que vieram do MESMO documento.
 *
 * O retrieval é k-NN sobre CHUNKS, não sobre documentos: um atestado de 40
 * páginas facilmente ocupa 3 das 8 vagas com pedaços vizinhos do mesmo texto.
 * Renderizar um card por chunk repetia a mesma ficha três vezes e escondia a
 * diversidade real do resultado. Aqui a ordem do ranking é preservada (o grupo
 * herda a posição do seu melhor trecho) — nada é reordenado por relevância
 * agregada, que daria a impressão falsa de que documento com mais chunks é
 * mais pertinente.
 */
function agruparPorDocumento(trechos: TrechoRetrieval[]): GrupoFonte[] {
  const grupos: GrupoFonte[] = [];
  const indice = new Map<string, GrupoFonte>();

  for (const t of trechos) {
    const chave = `${t.origemTipo}:${t.origemId}`;
    const g = indice.get(chave);
    if (g) {
      g.trechos.push(t);
      g.melhorSim = Math.max(g.melhorSim, t.similaridade);
      continue;
    }
    const novo: GrupoFonte = {
      chave,
      numero: t.numero,
      arquivo: t.arquivo ?? null,
      origemTipo: t.origemTipo,
      licitacaoId: t.licitacaoId,
      metadata: t.metadata,
      melhorSim: t.similaridade,
      trechos: [t],
    };
    indice.set(chave, novo);
    grupos.push(novo);
  }
  return grupos;
}

// ── Card de fonte (um documento, com seus trechos) ────────────────────────────

/** Uma linha da ficha: rótulo fixo à esquerda, valor à direita. */
function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[11px] leading-snug">
      <span className="w-[4.5rem] flex-shrink-0 text-gray-400 uppercase tracking-wide">
        {rotulo}
      </span>
      <span className="min-w-0 text-gray-700">{children}</span>
    </div>
  );
}

function FonteCard({ grupo }: { grupo: GrupoFonte }) {
  // A5: o BFF (acervo_buscar.py) devolve `origem_tipo` VERBATIM do banco, sem
  // restringir ao enum. Um trecho com origem fora das 3 conhecidas (fonte nova,
  // dado legado, NULL) tornaria `meta` undefined e `meta.icon` estouraria
  // "undefined is not an object" (mesma classe do bug g.stats.ALTA). Fallback:
  const meta = ORIGEM_META[grupo.origemTipo] ?? {
    label: "Outro", icon: FileText, cor: "bg-gray-100 text-gray-600",
  };
  const Icon = meta.icon;
  const arq = grupo.arquivo;
  const metaObj = grupo.metadata ?? {};
  const familia = typeof metaObj.familiaCrc === "string" ? metaObj.familiaCrc : null;

  // Cliente e escopo do metadata do chunk só entram quando a operação não os
  // tem — o banco é a fonte boa; o metadata é resíduo da indexação.
  const clienteMeta = typeof metaObj.cliente === "string" ? metaObj.cliente : null;
  const escopoMeta  = typeof metaObj.escopo === "string" ? metaObj.escopo : null;

  const cliente = arq?.cliente ?? clienteMeta;
  const escopo  = arq?.escopo ?? escopoMeta;
  const grupoCliente =
    arq?.clienteGrupo && arq.clienteGrupo !== arq.cliente ? arq.clienteGrupo : null;

  const suspeita = arq?.situacao
    && ["RASCUNHO", "CANCELADA", "MODELO", "SUPERADA"].includes(arq.situacao);

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Cabeçalho: identidade do documento */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-gray-100 text-xs font-bold text-gray-600 flex-shrink-0">
              {grupo.numero}
            </span>
            <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase", meta.cor)}>
              <Icon className="h-3 w-3" /> {arq?.tipo ?? meta.label}
            </span>
            {arq?.detentora && (
              <span className={cn(
                "px-2 py-0.5 rounded text-[10px] font-bold uppercase border",
                DETENTORA_COR[arq.detentora] ?? "bg-gray-100 text-gray-600 border-gray-200",
              )}>
                {arq.detentora}
              </span>
            )}
            {suspeita && (
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-red-50 text-red-700 border border-red-200">
                {arq!.situacao}
              </span>
            )}
            {familia && <span className="text-[10px] text-gray-400">{familia}</span>}
            {/* Achado pelo texto: o casamento foi lexical (número de contrato,
                sigla de unidade), não semântico. Vale sinalizar porque a
                relevância exibida é a de cosseno, que nesses casos é baixa e
                pareceria contradizer o resultado estar no topo. */}
            {grupo.trechos.some((x) => x.posTexto != null) && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                <Search className="h-2.5 w-2.5" /> texto
              </span>
            )}
          </div>
          <span className="text-[10px] text-gray-400 tabular-nums flex-shrink-0 pt-1">
            {(grupo.melhorSim * 100).toFixed(0)}% relevância
          </span>
        </div>

        {/* O ARQUIVO. Antes o card mostrava só tipo e relevância — quem lia não
            sabia de qual documento veio o trecho, e não tinha como abrir. */}
        {arq && (
          <>
            {arq.href ? (
              <Link
                href={arq.href}
                className="group inline-flex items-start gap-1.5 text-sm font-semibold text-gray-900 hover:text-brand-orange"
              >
                <FileText className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-400 group-hover:text-brand-orange" />
                <span className="underline decoration-gray-300 underline-offset-2 group-hover:decoration-brand-orange">
                  {arq.nome}
                </span>
              </Link>
            ) : (
              <span className="inline-flex items-start gap-1.5 text-sm font-semibold text-gray-900">
                <FileText className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-400" />
                {arq.nome}
              </span>
            )}
            {(arq.numero || arq.emitidoEm) && (
              <p className="mt-0.5 ml-[1.375rem] text-[11px] text-gray-400">
                {arq.numero && <>nº {arq.numero}</>}
                {arq.numero && arq.emitidoEm && " · "}
                {arq.emitidoEm && <>emitido em {arq.emitidoEm}</>}
              </p>
            )}
          </>
        )}
      </div>

      {/* Ficha: de onde a prova vem e o que ela cobre */}
      {(arq?.operacao || cliente || escopo) && (
        <div className="mx-4 mb-3 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 space-y-1.5">
          {arq?.operacao && (
            <Campo rotulo="Operação">
              <span className="font-semibold tabular-nums">{arq.operacao}</span>
              {arq.contrato && <span className="text-gray-500"> · contrato {arq.contrato}</span>}
              {arq.periodo && <span className="text-gray-500"> · {arq.periodo}</span>}
            </Campo>
          )}
          {cliente && (
            <Campo rotulo="Cliente">
              <span className="font-medium">{cliente}</span>
              {arq?.unidade && <span className="text-gray-500"> · {arq.unidade}</span>}
              {grupoCliente && <span className="text-gray-400"> ({grupoCliente})</span>}
            </Campo>
          )}
          {escopo && (
            <Campo rotulo="Executou">
              <span className="line-clamp-2">{escopo}</span>
            </Campo>
          )}
        </div>
      )}

      {/* Os trechos que casaram com a pergunta */}
      <div className="border-t border-gray-100 divide-y divide-gray-100">
        {grupo.trechos.map((t) => (
          <div key={t.chunkIndex} className="flex gap-2 px-4 py-3 text-sm text-gray-700 leading-relaxed">
            <Quote className="h-3.5 w-3.5 text-gray-300 flex-shrink-0 mt-1" />
            <p className="line-clamp-6 min-w-0 flex-1">{t.texto}</p>
            <span className="text-[10px] text-gray-300 tabular-nums flex-shrink-0 pt-1">
              {(t.similaridade * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>

      {/* Ações */}
      {(arq?.download || grupo.licitacaoId) && (
        <div className="flex items-center gap-3 bg-gray-50 border-t border-gray-100 px-4 py-2 text-[11px]">
          {arq?.download && (
            <a
              href={arq.download}
              className="inline-flex items-center gap-1 font-medium text-brand-orange hover:underline"
            >
              <Download className="h-3 w-3" /> Baixar arquivo
            </a>
          )}
          {grupo.licitacaoId && (
            <Link
              href={`/licitacoes/${grupo.licitacaoId}`}
              className="ml-auto inline-flex items-center gap-1 text-gray-500 hover:text-brand-orange"
            >
              Ver licitação <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
