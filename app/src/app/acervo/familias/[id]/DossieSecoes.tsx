"use client";

/**
 * OS BLOCOS DO DOSSIÊ — o que o acervo diz sobre uma família.
 *
 * A página de detalhe mostrava só o que NÓS digitamos: nome, tags, critérios,
 * validade. Estes blocos trazem o que decide o cadastro e estava invisível:
 * o ESCOPO OFICIAL da Petrobras, os INDÍCIOS do acervo com sua justificativa,
 * a DEMANDA observada e — o que faltava por inteiro — o botão que transforma
 * indício em prova.
 *
 * A REVISÃO É O PONTO. Antes desta tela, `revisao` estava NULL em todos os
 * indícios: a máquina apontava e ninguém tinha onde dizer sim ou não. Uma fila
 * de revisão sem tela de revisão é um relatório, não um processo.
 */

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, FileText, Loader2,
  ScrollText, ShieldQuestion, Undo2, X,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";

export interface Indicio {
  id: string;
  documentoId: string;
  titulo: string;
  categoria: string;
  subcategoria: string;
  restrito: boolean;
  veredito: string;
  confianca: number | null;
  justificativa: string | null;
  procedencia: string;
  modelo: string | null;
  revisao: string | null;
  revisadoEm: string | null;
  revisadoPorNome: string | null;
  criadoEm: string;
}

export interface Dossie {
  codigo: string;
  nome: string | null;
  catalogo: {
    nome: string | null; escopo: string | null; grupo: string | null;
    segmentoPetrobras: string | null; segmento: string; oficial: boolean;
  } | null;
  cadastro: {
    familiaId: string; nome: string; descricao: string | null; status: string;
    statusFluxoCrc: string | null; validadeFim: string | null; cadastroCorporativo: boolean;
  } | null;
  demanda: {
    licitacoes: number; itens: number;
    primeiraVezEm: string | null; ultimaVezEm: string | null;
    recentes: { numero: string; vistoEm: string | null; licitacaoId: string | null; objeto: string | null }[];
  };
  provas: {
    vinculoId: string; documentoId: string; titulo: string; categoria: string;
    subcategoria: string; status: string; validadeFim: string | null;
    observacao: string | null; vinculadoEm: string | null; restrito: boolean;
  }[];
  indicios: Indicio[];
  refutacoes: Indicio[];
  restritosOcultos: number;
  avaliada: boolean;
  prova: "COM_PROVA" | "COM_INDICIO" | "SEM_INDICIO" | "INDETERMINADO";
  quadrante: "NUCLEO" | "RISCO" | "OPORTUNIDADE" | "FORA_DE_ALCANCE" | "A_APURAR";
  ressalva?: { texto: string; demandaObservada: string };
}

/**
 * A frase que a página existe para dizer. Uma por quadrante, no imperativo:
 * quem abre este dossiê está decidindo se pede CRC, se disputa ou se desiste —
 * e um rótulo ("oportunidade") não é uma decisão, é um adjetivo.
 */
const DECISAO: Record<Dossie["quadrante"], { titulo: string; texto: string; acao: string; cor: string }> = {
  NUCLEO: {
    titulo: "Cadastrada e sustentada pelo acervo",
    texto: "Estamos no CRC e há documento que comprova o escopo. É disputa em pé.",
    acao: "Confira a validade do CRC antes de cada proposta.",
    cor: "border-emerald-300 bg-emerald-50 text-emerald-900",
  },
  RISCO: {
    titulo: "Cadastrada, mas o acervo não sustenta",
    texto:
      "Estamos no CRC e nada no acervo comprova este escopo. É o cenário que faz " +
      "perder na habilitação depois de orçar.",
    acao: "Ou aparece atestado que sustente, ou esta família não deve entrar em proposta como própria.",
    cor: "border-red-300 bg-red-50 text-red-900",
  },
  OPORTUNIDADE: {
    titulo: "Não cadastrada — e o acervo sustenta",
    texto:
      "Há documento no acervo que comprova este escopo e não temos o CRC. Cada " +
      "licitação desta família passa sem que possamos participar.",
    acao: "Candidata a pedido de cadastro: confirme os indícios abaixo e leve-os como prova.",
    cor: "border-amber-300 bg-amber-50 text-amber-900",
  },
  FORA_DE_ALCANCE: {
    titulo: "Fora de alcance hoje",
    texto: "Não estamos cadastrados e o acervo foi lido sem encontrar nada que sustente.",
    acao: "Só entra na conta com parceria, subcontratação ou acervo novo.",
    cor: "border-gray-300 bg-gray-50 text-gray-700",
  },
  A_APURAR: {
    titulo: "Nunca avaliada",
    texto:
      "Esta família não entrou no vocabulário de nenhuma carga de classificação. " +
      "Não sabemos se o acervo sustenta — o que é diferente de saber que não.",
    acao: "Rodar a classificação com esta família no vocabulário antes de concluir qualquer coisa.",
    cor: "border-blue-200 bg-blue-50 text-blue-900",
  },
};

const VEREDITO: Record<string, { rotulo: string; cor: string; ajuda: string }> = {
  PROVA: {
    rotulo: "Prova",
    cor: "bg-emerald-100 text-emerald-800 border-emerald-300",
    ajuda: "O texto do documento cobre o escopo da família por inteiro.",
  },
  PARCIAL: {
    rotulo: "Parcial",
    cor: "bg-amber-100 text-amber-900 border-amber-300",
    ajuda: "O documento tangencia o escopo — sustenta em parte, não por inteiro.",
  },
  ABSTEM: {
    rotulo: "Sem veredito",
    cor: "bg-gray-100 text-gray-600 border-gray-300",
    ajuda: "Candidato levantado pela extração, ainda sem julgamento de escopo.",
  },
  NAO: {
    rotulo: "Não sustenta",
    cor: "bg-red-50 text-red-700 border-red-200",
    ajuda: "A família foi lida contra este documento e ele não a sustenta.",
  },
};

const REVISAO_ROTULO: Record<string, { rotulo: string; cor: string }> = {
  CONFIRMADA: { rotulo: "Confirmado", cor: "bg-emerald-600 text-white" },
  PARCIAL:    { rotulo: "Parcial",    cor: "bg-amber-500 text-white" },
  REJEITADA:  { rotulo: "Rejeitado",  cor: "bg-gray-500 text-white" },
};

function Cartao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <h2 className="text-sm font-semibold text-brand-black mb-3">{titulo}</h2>
      {children}
    </div>
  );
}

/** Confiança da máquina. Número cru engana; a faixa é honesta. */
function Confianca({ valor }: { valor: number | null }) {
  if (valor == null) return null;
  const pct = Math.round(valor * 100);
  const faixa = pct >= 80 ? "alta" : pct >= 60 ? "média" : "baixa";
  return (
    <span
      title={`Confiança declarada pelo extrator: ${pct}%. É a certeza da máquina sobre a própria leitura, não a força jurídica do documento.`}
      className={cn(
        "px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums border",
        pct >= 80 ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : pct >= 60 ? "bg-amber-50 text-amber-700 border-amber-200"
                              : "bg-gray-50 text-gray-500 border-gray-200",
      )}
    >
      confiança {faixa} · {pct}%
    </span>
  );
}

/** Uma linha de indício, com as três decisões possíveis. */
function LinhaIndicio({
  ind, podeRevisar, onRevisar, salvando,
}: {
  ind: Indicio;
  podeRevisar: boolean;
  onRevisar: (id: string, revisao: string | null) => void;
  salvando: string | null;
}) {
  const [aberto, setAberto] = useState(false);
  const v = VEREDITO[ind.veredito] ?? VEREDITO.ABSTEM;
  const rev = ind.revisao ? REVISAO_ROTULO[ind.revisao] : null;
  const ocupado = salvando === ind.id;

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setAberto((x) => !x)}
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-gray-50 transition-colors"
      >
        {aberto ? <ChevronDown className="h-4 w-4 text-gray-400 mt-0.5 flex-shrink-0" />
                : <ChevronRight className="h-4 w-4 text-gray-400 mt-0.5 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span title={v.ajuda} className={cn("px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase", v.cor)}>
              {v.rotulo}
            </span>
            <Confianca valor={ind.confianca} />
            {rev && (
              <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold uppercase", rev.cor)}>
                {rev.rotulo}
              </span>
            )}
            {ind.restrito && (
              <span title="Documento restrito — visível só para Conformidade" className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-semibold">
                restrito
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-gray-800 mt-1 truncate">{ind.titulo}</p>
          {!aberto && ind.justificativa && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{ind.justificativa}</p>
          )}
        </div>
      </button>

      {aberto && (
        <div className="px-3 pb-3 pl-10 space-y-3">
          {ind.justificativa && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Por que o acervo sustenta
              </p>
              <p className="text-sm text-gray-700 whitespace-pre-line">{ind.justificativa}</p>
              <p className="text-[10px] text-gray-400 mt-1">
                Argumento do extrator, não citação literal garantida — nem todo
                par tem fragmento ancorável no texto. Abra o documento para conferir.
              </p>
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <Link
              href={`/acervo/cofre/${ind.documentoId}`}
              className="inline-flex items-center gap-1 text-brand-orange hover:underline"
            >
              <FileText className="h-3.5 w-3.5" /> Abrir o documento
            </Link>
            <span className="text-gray-400">
              {ind.categoria} · {ind.subcategoria.replace(/_/g, " ")}
            </span>
            {ind.modelo && <span className="text-gray-400">extraído por {ind.modelo}</span>}
          </div>

          {ind.revisao && (
            <p className="text-xs text-gray-500">
              {REVISAO_ROTULO[ind.revisao]?.rotulo ?? ind.revisao}
              {ind.revisadoPorNome && ` por ${ind.revisadoPorNome}`}
              {ind.revisadoEm && ` em ${formatDate(ind.revisadoEm)}`}
            </p>
          )}

          {podeRevisar && (
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {ocupado && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
              <BotaoRevisao
                ativo={ind.revisao === "CONFIRMADA"} desabilitado={ocupado}
                onClick={() => onRevisar(ind.id, "CONFIRMADA")}
                cor="emerald" icone={<Check className="h-3.5 w-3.5" />}
                titulo="Confirma que este documento comprova o escopo da família. Cria o vínculo de prova quando a família é cadastrada."
              >
                Confirmar
              </BotaoRevisao>
              <BotaoRevisao
                ativo={ind.revisao === "PARCIAL"} desabilitado={ocupado}
                onClick={() => onRevisar(ind.id, "PARCIAL")}
                cor="amber" icone={<ShieldQuestion className="h-3.5 w-3.5" />}
                titulo="Sustenta em parte. Não cria vínculo — meia prova não habilita."
              >
                Parcial
              </BotaoRevisao>
              <BotaoRevisao
                ativo={ind.revisao === "REJEITADA"} desabilitado={ocupado}
                onClick={() => onRevisar(ind.id, "REJEITADA")}
                cor="gray" icone={<X className="h-3.5 w-3.5" />}
                titulo="Não sustenta. Fica gravado para que a próxima carga não ressuscite a sugestão."
              >
                Rejeitar
              </BotaoRevisao>
              {ind.revisao && (
                <button
                  type="button" disabled={ocupado}
                  onClick={() => onRevisar(ind.id, null)}
                  title="Devolve o indício para a fila, sem decisão."
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Desfazer
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BotaoRevisao({
  ativo, desabilitado, onClick, cor, icone, titulo, children,
}: {
  ativo: boolean; desabilitado: boolean; onClick: () => void;
  cor: "emerald" | "amber" | "gray"; icone: React.ReactNode;
  titulo: string; children: React.ReactNode;
}) {
  const cores = {
    emerald: ativo ? "bg-emerald-600 text-white border-emerald-600"
                   : "border-emerald-300 text-emerald-700 hover:bg-emerald-50",
    amber:   ativo ? "bg-amber-500 text-white border-amber-500"
                   : "border-amber-300 text-amber-700 hover:bg-amber-50",
    gray:    ativo ? "bg-gray-600 text-white border-gray-600"
                   : "border-gray-300 text-gray-600 hover:bg-gray-50",
  }[cor];
  return (
    <button
      type="button" onClick={onClick} disabled={desabilitado} title={titulo}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors disabled:opacity-50",
        cores,
      )}
    >
      {icone} {children}
    </button>
  );
}

export function DossieSecoes({
  dossie, podeRevisar, onRevisado,
}: {
  dossie: Dossie;
  podeRevisar: boolean;
  /** Chamado depois de uma revisão gravada, para recarregar o dossiê. */
  onRevisado: () => void;
}) {
  const [salvando, setSalvando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [verRefutados, setVerRefutados] = useState(false);

  const d = DECISAO[dossie.quadrante];

  async function revisar(id: string, revisao: string | null) {
    setSalvando(id); setErro(null); setAviso(null);
    try {
      const r = await fetch(`/api/conformidade/familias/classificacoes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revisao }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Erro ${r.status}`);
      const resp = await r.json();
      // Dizer em voz alta o que o clique NÃO fez: sem cadastro não há vínculo,
      // e sem vínculo não há prova. Quem confirma 16 indícios de família não
      // cadastrada precisa saber que não habilitou nada com isso.
      if (revisao === "CONFIRMADA" && !resp.viraProva) {
        setAviso(
          "Confirmado. Como a família NÃO está cadastrada, isto não gera vínculo de " +
          "prova — passa a ser o argumento do pedido de CRC.",
        );
      }
      if (resp.vinculoMantido) {
        setAviso(
          "Revisão gravada. O vínculo de prova que já existia foi MANTIDO: ele pode " +
          "ter sido criado à mão no cofre. Remova por lá se também estiver errado.",
        );
      }
      onRevisado();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao gravar a revisão");
    } finally {
      setSalvando(null);
    }
  }

  return (
    <>
      {/* A DECISÃO — antes de qualquer dado */}
      <div className={cn("border rounded-xl p-4 mb-5", d.cor)}>
        <p className="text-sm font-bold">{d.titulo}</p>
        <p className="text-sm mt-1 opacity-90">{d.texto}</p>
        <p className="text-xs mt-2 font-medium opacity-80">→ {d.acao}</p>
      </div>

      {erro && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {erro}
        </div>
      )}
      {aviso && (
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-800">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /> {aviso}
        </div>
      )}

      {/* Três números que enquadram a decisão */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Demanda observada</p>
          <p className="text-2xl font-bold text-brand-black tabular-nums">{dossie.demanda.licitacoes}</p>
          <p className="text-xs text-gray-500">
            {dossie.demanda.licitacoes === 0
              ? "nenhuma licitação da base exigiu"
              : `licitações · última em ${formatDate(dossie.demanda.ultimaVezEm)}`}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Provas confirmadas</p>
          <p className="text-2xl font-bold text-brand-black tabular-nums">{dossie.provas.length}</p>
          <p className="text-xs text-gray-500">documento vinculado por uma pessoa</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Indícios na fila</p>
          <p className="text-2xl font-bold text-brand-black tabular-nums">{dossie.indicios.length}</p>
          <p className="text-xs text-gray-500">
            {dossie.indicios.filter((i) => i.revisao).length} já revisados
          </p>
        </div>
      </div>

      {dossie.restritosOcultos > 0 && (
        <p className="text-xs text-gray-500 mb-5">
          {dossie.restritosOcultos} linha(s) ocultas por serem de documento restrito — visíveis só para Conformidade.
        </p>
      )}

      {/* ESCOPO OFICIAL — o gabarito contra o qual o atestado é lido */}
      {dossie.catalogo?.escopo && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-brand-black">
              Escopo oficial da Petrobras
            </h2>
            <div className="flex items-center gap-2 flex-wrap">
              {dossie.catalogo.grupo && (
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px] font-medium">
                  {dossie.catalogo.grupo}
                </span>
              )}
              {dossie.catalogo.segmentoPetrobras && (
                <span className="px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200 text-[10px] font-semibold uppercase">
                  {dossie.catalogo.segmentoPetrobras}
                </span>
              )}
            </div>
          </div>
          <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">
            {dossie.catalogo.escopo}
          </p>
          <p className="text-[10px] text-gray-400 mt-2">
            Texto da relação oficial de famílias da Petrobras. É contra ele que um
            atestado é lido — não contra a descrição que digitamos.
          </p>
        </div>
      )}

      {/* INDÍCIOS — a fila de revisão */}
      <Cartao titulo={`O que o acervo aponta (${dossie.indicios.length})`}>
        {dossie.indicios.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">
            {dossie.avaliada
              ? "O acervo foi lido contra esta família e nada a sustentou."
              : "Esta família nunca entrou no vocabulário da classificação — não sabemos."}
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-3">
              {dossie.ressalva?.texto}
            </p>
            <div className="space-y-2">
              {dossie.indicios.map((i) => (
                <LinhaIndicio
                  key={i.id} ind={i} podeRevisar={podeRevisar}
                  onRevisar={revisar} salvando={salvando}
                />
              ))}
            </div>
          </>
        )}
      </Cartao>

      {/* REFUTAÇÕES — o lastro do "não" */}
      {dossie.refutacoes.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <button
            type="button"
            onClick={() => setVerRefutados((v) => !v)}
            className="w-full flex items-center justify-between text-left"
          >
            <h2 className="text-sm font-semibold text-brand-black">
              Lidos e não sustentam ({dossie.refutacoes.length})
            </h2>
            {verRefutados ? <ChevronDown className="h-4 w-4 text-gray-400" />
                          : <ChevronRight className="h-4 w-4 text-gray-400" />}
          </button>
          <p className="text-xs text-gray-500 mt-1">
            O lastro do &quot;não&quot;: documentos que a máquina leu contra esta família e
            descartou. É a diferença entre &quot;não temos&quot; e &quot;não perguntamos&quot;.
          </p>
          {verRefutados && (
            <div className="space-y-2 mt-3">
              {dossie.refutacoes.map((i) => (
                <LinhaIndicio
                  key={i.id} ind={i} podeRevisar={podeRevisar}
                  onRevisar={revisar} salvando={salvando}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* PROVAS CONFIRMADAS — o único grau que sustenta um NO-GO */}
      {(dossie.cadastro || dossie.provas.length > 0) && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="text-sm font-semibold text-brand-black">
              Provas confirmadas ({dossie.provas.length})
            </h2>
            <Link href="/acervo/cofre" className="text-xs text-brand-orange hover:underline">
              Ir para o cofre
            </Link>
          </div>
          {dossie.provas.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">
              Nenhum documento vinculado ainda. Confirme um indício acima, ou vincule
              pelo cofre — só o vínculo feito por uma pessoa vale como prova.
            </p>
          ) : (
          <div className="space-y-2">
            {dossie.provas.map((p) => (
              <Link
                key={p.vinculoId}
                href={`/acervo/cofre/${p.documentoId}`}
                className="flex items-center gap-3 p-3 border border-emerald-100 bg-emerald-50/40 rounded-lg hover:bg-emerald-50 transition-colors"
              >
                <ScrollText className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{p.titulo}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {p.categoria} · {p.subcategoria.replace(/_/g, " ")}
                    {p.validadeFim && ` · até ${formatDate(p.validadeFim)}`}
                  </p>
                </div>
              </Link>
            ))}
          </div>
          )}
        </div>
      )}

      {/* DEMANDA — as licitações que exigiram */}
      {dossie.demanda.recentes.length > 0 && (
        <Cartao titulo={`Licitações que exigiram esta família (${dossie.demanda.licitacoes})`}>
          <div className="space-y-1.5">
            {dossie.demanda.recentes.map((l) => {
              const conteudo = (
                <>
                  <span className="font-mono text-xs text-gray-700">{l.numero}</span>
                  {l.objeto && (
                    <span className="text-xs text-gray-500 truncate flex-1">{l.objeto}</span>
                  )}
                  <span className="text-xs text-gray-400 tabular-nums flex-shrink-0">
                    {formatDate(l.vistoEm)}
                  </span>
                </>
              );
              return l.licitacaoId ? (
                <Link
                  key={l.numero} href={`/licitacoes/${l.licitacaoId}`}
                  className="flex items-center gap-3 px-3 py-2 border border-gray-100 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {conteudo}
                </Link>
              ) : (
                <div key={l.numero} className="flex items-center gap-3 px-3 py-2 border border-gray-100 rounded-lg">
                  {conteudo}
                </div>
              );
            })}
          </div>
          {dossie.demanda.licitacoes > dossie.demanda.recentes.length && (
            <p className="text-xs text-gray-400 mt-2">
              Mostrando as {dossie.demanda.recentes.length} mais recentes de {dossie.demanda.licitacoes}.
            </p>
          )}
          <p className="text-[10px] text-gray-400 mt-2">{dossie.ressalva?.demandaObservada}</p>
        </Cartao>
      )}
    </>
  );
}
