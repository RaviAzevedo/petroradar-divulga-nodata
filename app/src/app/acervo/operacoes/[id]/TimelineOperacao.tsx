"use client";

/**
 * D9 — a linha do tempo da obra (spec ONDA-5 §7.3), na ficha da operação.
 *
 * Bloco à parte, como Disciplinas (D3): NÃO é uma décima
 * seção. Por isso o id é `timeline-operacao` e não `secao-N` — o trilho, o
 * `IntersectionObserver` das nove seções, o filtro local e o ZIP não a
 * conhecem (§6.4).
 *
 * Duas camadas, e a divisão é deliberada:
 *  1. o EIXO em SVG (`role="img"`), que é a figura — nenhuma ação mora nele;
 *  2. a LISTA em HTML (`<ol>`), que é a camada navegável por teclado e por
 *     leitor de tela. Escrever os marcos só dentro do SVG deixaria a timeline
 *     inutilizável por Tab, e `<a>` dentro de `<svg>` não recebe as classes de
 *     foco do Tailwind do resto da tela.
 *
 * Nenhum `fetch`, nenhum estado: tudo vem pronto de `montarTimeline` (§4.4),
 * que é pura e testada em `ficha-secoes.test.ts`.
 */

import { CalendarRange } from "lucide-react";
import type { EventoTimeline, TimelineOperacao as DadosTimeline } from "./secoes";

interface Props {
  timeline: DadosTimeline;
  /** Código da operação — só para o `aria-label` da figura. */
  codigo: string;
  /** Abre a GavetaDocumento que a ficha já tem, sem sair dela. */
  onAbrirDocumento: (documentoId: string) => void;
}

/**
 * Cópia DELIBERADA dos hex de `painel/_graficos/paleta.ts`: aquela pasta é
 * privada da rota do painel (`_graficos`, com underscore) e nenhum arquivo
 * fora de `app/acervo/painel/**` a importa — puxá-la para a ficha criaria o
 * primeiro import cruzado de pasta privada (§6). Se a paleta mudar, esta
 * constante muda junto, à mão: são quatro linhas.
 *
 * Os dois marcos de período saem em cinza porque não são prova de nada — são
 * o eixo em que as provas se penduram.
 */
const COR_MARCO: Record<EventoTimeline["tipo"], string> = {
  PERIODO_INICIO: "#9ca3af",
  PERIODO_FIM: "#9ca3af",
  CONTRATO: "#0284c7", // azul
  ADITIVO: "#7c3aed", // violeta
  ATESTADO: "#16a34a", // verde
  CAT_ART: "#F59C00", // laranja Proponente
};

const NOME_TIPO: Record<EventoTimeline["tipo"], string> = {
  PERIODO_INICIO: "Início do período",
  PERIODO_FIM: "Fim do período",
  CONTRATO: "Contrato",
  ADITIVO: "Aditivo",
  ATESTADO: "Atestado",
  CAT_ART: "CAT / ART",
};

// ── Geometria do eixo ────────────────────────────────────────────────────────

const LARGURA = 1000;
const ALTURA = 90;
const MARGEM = 20;
const UTIL = LARGURA - MARGEM * 2; // 960
const Y_EIXO = 46;

/** "AAAA-MM-DD" → ms UTC. Formato já validado por `dataDoEixo` (§4.4 regra 3). */
function emMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** "AAAA-MM-DD" → "12/03/2018", sem passar por fuso (o `Date` empurraria o dia). */
function dataCurta(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// ── Componente ───────────────────────────────────────────────────────────────

export function TimelineOperacao({ timeline, codigo, onAbrirDocumento }: Props) {
  const { eventos, inicio, fim, semData, foraDaLinha } = timeline;

  // Operação sem documento nenhum e sem período: a ficha já tem o vazio grande
  // de "Nenhuma prova guardada" — um cartão vazio aqui seria ruído.
  if (eventos.length === 0 && semData.length === 0 && foraDaLinha === 0) return null;

  const vazados = eventos.filter((e) => e.naoConta).length;

  // Eixo de largura zero mente sobre a duração da obra (§4.4 regra 8): com um
  // marco só, ou com todos no mesmo dia, fica só a lista.
  const desenhaEixo = eventos.length >= 2 && inicio !== null && fim !== null && inicio !== fim;

  const inicioMs = inicio !== null ? emMs(inicio) : 0;
  const fimMs = fim !== null ? emMs(fim) : 0;
  const vao = fimMs - inicioMs;
  const xDe = (data: string) => MARGEM + ((emMs(data) - inicioMs) / vao) * UTIL;

  // A faixa translúcida do período contratual só existe com os DOIS extremos:
  // um deles sozinho não delimita intervalo nenhum.
  const marcoInicio = eventos.find((e) => e.tipo === "PERIODO_INICIO") ?? null;
  const marcoFim = eventos.find((e) => e.tipo === "PERIODO_FIM") ?? null;

  const rotuloFigura =
    inicio !== null && fim !== null
      ? `Linha do tempo da operação ${codigo}: ${eventos.length} marco${eventos.length === 1 ? "" : "s"}, de ${dataCurta(inicio)} a ${dataCurta(fim)}.`
      : `Linha do tempo da operação ${codigo}: nenhum marco datado.`;

  return (
    <section
      id="timeline-operacao"
      aria-labelledby="timeline-titulo"
      className="bg-white border border-gray-200 rounded-xl p-5 mb-3"
    >
      <h2
        id="timeline-titulo"
        className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-3"
      >
        <CalendarRange className="h-3 w-3" aria-hidden="true" /> Linha do tempo da obra
      </h2>

      {desenhaEixo ? (
        <svg
          role="img"
          aria-label={rotuloFigura}
          viewBox={`0 0 ${LARGURA} ${ALTURA}`}
          /* `preserveAspectRatio="none"` + `width:100%` é o que faz a linha de
             base ocupar a largura toda em qualquer tela (§7.3). O texto fica
             FORA do SVG (camada 2), então nada legível estica; os marcos são
             pontos de 5px de raio, onde a diferença de escala não se lê. */
          preserveAspectRatio="none"
          className="w-full h-[90px] min-h-[90px] mb-3"
        >
          <g aria-hidden="true">
            {/* Faixa do período contratual, quando os dois extremos existem. */}
            {marcoInicio !== null && marcoFim !== null && (
              <rect
                x={xDe(marcoInicio.data)}
                y={Y_EIXO - 14}
                width={Math.max(1, xDe(marcoFim.data) - xDe(marcoInicio.data))}
                height={28}
                fill="#F59C00"
                fillOpacity={0.08}
              />
            )}

            <line
              x1={MARGEM}
              y1={Y_EIXO}
              x2={LARGURA - MARGEM}
              y2={Y_EIXO}
              stroke="#e5e7eb"
              strokeWidth={2}
            />

            {eventos.map((e) => {
              const x = xDe(e.data);
              const cor = COR_MARCO[e.tipo];
              const titulo = `${e.rotulo} — ${dataCurta(e.data)}`;
              const periodo = e.tipo === "PERIODO_INICIO" || e.tipo === "PERIODO_FIM";

              // Losango para os marcos de período (são o eixo, não prova) e
              // círculo para os documentos; vazado quando `naoConta`.
              return periodo ? (
                <rect
                  key={e.chave}
                  x={x - 5}
                  y={Y_EIXO - 5}
                  width={10}
                  height={10}
                  transform={`rotate(45 ${x} ${Y_EIXO})`}
                  fill="white"
                  stroke={cor}
                  strokeWidth={2}
                >
                  <title>{titulo}</title>
                </rect>
              ) : (
                <circle
                  key={e.chave}
                  cx={x}
                  cy={Y_EIXO}
                  r={5}
                  fill={e.naoConta ? "white" : cor}
                  stroke={cor}
                  strokeWidth={2}
                >
                  <title>{titulo}</title>
                </circle>
              );
            })}
          </g>
        </svg>
      ) : (
        eventos.length > 0 && (
          <p className="text-[11px] text-gray-400 mb-3">
            {eventos.length === 1
              ? "Um marco só: não há duração para desenhar."
              : "Todos os marcos no mesmo dia: não há duração para desenhar."}
          </p>
        )
      )}

      {eventos.length > 0 && (
        <ol className="space-y-1">
          {eventos.map((e) => {
            const documentoId = e.documentoId;
            return (
            <li key={e.chave} className="flex items-baseline gap-2 text-sm">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full flex-shrink-0 translate-y-[1px]"
                style={{
                  backgroundColor: e.naoConta ? "white" : COR_MARCO[e.tipo],
                  boxShadow: `inset 0 0 0 2px ${COR_MARCO[e.tipo]}`,
                }}
              />
              <span className="font-mono text-[11px] text-gray-500 tabular-nums whitespace-nowrap">
                {dataCurta(e.data)}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-gray-400 whitespace-nowrap">
                {NOME_TIPO[e.tipo]}
              </span>
              {documentoId !== null ? (
                <button
                  type="button"
                  onClick={() => onAbrirDocumento(documentoId)}
                  className="text-left text-gray-800 hover:text-brand-orange min-w-0"
                >
                  {e.rotulo}
                </button>
              ) : (
                <span className="text-gray-500 min-w-0">{e.rotulo}</span>
              )}
              {e.naoConta && (
                <span
                  title="Rascunho, superada, cancelada ou modelo: aparece na história, não conta na barra de comprovação."
                  className="text-[10px] text-gray-400 whitespace-nowrap"
                >
                  (não conta)
                </span>
              )}
            </li>
            );
          })}
        </ol>
      )}

      {/* Rodapé — é onde a conta fecha (Q4): nada some calado. */}
      {(semData.length > 0 || foraDaLinha > 0 || vazados > 0) && (
        <div className="mt-3 space-y-1 border-t border-gray-100 pt-2 text-[11px] text-gray-500">
          {semData.length > 0 && (
            <p>
              {semData.length} peça{semData.length === 1 ? "" : "s"} sem data de emissão:{" "}
              {semData.map((s, i) => (
                <span key={s.documentoId}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    onClick={() => onAbrirDocumento(s.documentoId)}
                    className="underline decoration-dotted hover:text-brand-orange"
                    title="O ano é rótulo, tirado do número e do título — nunca posição no eixo."
                  >
                    {s.titulo} ({s.ano})
                  </button>
                </span>
              ))}
              .
            </p>
          )}
          {foraDaLinha > 0 && (
            <p>
              {foraDaLinha} peça{foraDaLinha === 1 ? "" : "s"} fora da linha (certidões, notas, RH)
              — estão nas seções abaixo.
            </p>
          )}
          {vazados > 0 && (
            <p>
              {vazados} marco{vazados === 1 ? "" : "s"} vazado{vazados === 1 ? "" : "s"}: peça em
              rascunho, superada, cancelada ou modelo — aparece na história, não conta na barra de
              comprovação.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
