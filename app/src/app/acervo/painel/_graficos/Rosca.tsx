"use client";

// Rosca (donut) em SVG puro — presentational, zero fetch, zero estado.
// Spec do Painel do Acervo §3. Fatias via stroke-dasharray com gap de
// 1% da circunferência, rotação -90° (12h como origem), <title> nativo por fatia.

import type { ReactNode } from "react";
import { PALETA, inteiroBR } from "./paleta";

export interface FatiaRosca {
  rotulo: string;
  valor: number;
  cor: string;
}

export interface RoscaProps {
  fatias: FatiaRosca[];
  /** Diâmetro em px (default 180). */
  tamanho?: number;
  /** Espessura do anel em px (default 22). */
  espessura?: number;
  /** Conteúdo do miolo (número grande + sub), centrado em absoluto. */
  centro?: ReactNode;
}

export function Rosca({ fatias, tamanho = 180, espessura = 22, centro }: RoscaProps) {
  const visiveis = fatias.filter((f) => f.valor > 0);
  const total = visiveis.reduce((soma, f) => soma + f.valor, 0);

  const c = tamanho / 2; // centro (cx = cy)
  const r = Math.max((tamanho - espessura) / 2, 1);
  const circ = 2 * Math.PI * r;
  // Gap de 1% entre fatias — só faz sentido com 2+ fatias visíveis.
  const gap = visiveis.length > 1 ? circ * 0.01 : 0;

  // Pré-calcula traço/offset de cada fatia (dashoffset negativo empurra a fatia
  // no sentido horário a partir da origem já rotacionada para as 12h).
  let acumulado = 0;
  const desenho = visiveis.map((f) => {
    const comprimento = total > 0 ? (f.valor / total) * circ : 0;
    const offset = acumulado;
    acumulado += comprimento;
    return {
      ...f,
      traco: Math.max(comprimento - gap, 0.5), // fatia mínima visível
      offset,
      pct: total > 0 ? Math.round((f.valor / total) * 100) : 0,
    };
  });

  const aria =
    total > 0
      ? `Gráfico de rosca: ${desenho
          .map((f) => `${f.rotulo} ${inteiroBR(f.valor)} (${f.pct}%)`)
          .join("; ")}.`
      : "Gráfico de rosca sem dados.";

  return (
    <div
      role="img"
      aria-label={aria}
      className="relative inline-block shrink-0"
      style={{ width: tamanho, height: tamanho }}
    >
      <svg
        width={tamanho}
        height={tamanho}
        viewBox={`0 0 ${tamanho} ${tamanho}`}
        aria-hidden="true"
        className="block"
      >
        <g transform={`rotate(-90 ${c} ${c})`}>
          {total === 0 ? (
            // Estado vazio: anel cinza inteiro (nenhuma fatia para desenhar).
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={PALETA.cinza}
              strokeWidth={espessura}
            />
          ) : (
            desenho.map((f, i) => (
              <circle
                key={`${f.rotulo}-${i}`}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={f.cor}
                strokeWidth={espessura}
                strokeLinecap="butt"
                strokeDasharray={`${f.traco} ${circ}`}
                strokeDashoffset={-f.offset}
                className="transition-opacity hover:opacity-75"
              >
                <title>{`${f.rotulo}: ${inteiroBR(f.valor)} (${f.pct}%)`}</title>
              </circle>
            ))
          )}
        </g>
      </svg>
      {centro !== undefined && centro !== null ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {centro}
        </div>
      ) : null}
    </div>
  );
}
