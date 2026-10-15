"use client";

// Medidor (gauge) semicircular em SVG puro — presentational, zero fetch, zero
// estado. Spec do Painel do Acervo §3. Arco de fundo cinza + arco de
// valor com a régua de cor da nota (corDaNota), número central text-3xl
// tabular-nums e conceito em badge.

import { PALETA, corDaNota } from "./paleta";

export interface MedidorProps {
  /** 0..100 (valores fora da faixa são grampeados). */
  valor: number;
  /** Legenda abaixo do medidor (ex.: "Nota do acervo"). */
  rotulo: string;
  /** Conceito A..E exibido em badge sob o número. */
  conceito?: string;
  /** Largura em px (default 180); a altura é a metade + espessura. */
  tamanho?: number;
}

export function Medidor({ valor, rotulo, conceito, tamanho = 180 }: MedidorProps) {
  // NaN propagaria até o stroke-dasharray e o miolo mostraria "NaN".
  const v = Number.isFinite(valor) ? Math.max(0, Math.min(100, valor)) : 0;
  const cor = corDaNota(v);

  const espessura = Math.max(12, Math.round(tamanho * 0.085));
  const r = Math.max((tamanho - espessura) / 2, 1);
  const cy = tamanho / 2; // linha de base do semicírculo
  const alturaSvg = tamanho / 2 + espessura / 2 + 1; // sobra p/ os terminais arredondados
  const arco = Math.PI * r; // comprimento do semicírculo
  const d = `M ${espessura / 2} ${cy} A ${r} ${r} 0 0 1 ${tamanho - espessura / 2} ${cy}`;

  const aria = `${rotulo}: ${Math.round(v)} de 100${conceito ? `, conceito ${conceito}` : ""}.`;

  return (
    <div role="img" aria-label={aria} className="inline-flex flex-col items-center">
      <div className="relative" style={{ width: tamanho, height: alturaSvg }}>
        <svg
          width={tamanho}
          height={alturaSvg}
          viewBox={`0 0 ${tamanho} ${alturaSvg}`}
          aria-hidden="true"
          className="block"
        >
          {/* arco de fundo */}
          <path
            d={d}
            fill="none"
            stroke={PALETA.cinza}
            strokeWidth={espessura}
            strokeLinecap="round"
          />
          {/* arco de valor (linecap round faria um ponto em 0 → não desenha) */}
          {v > 0 ? (
            <path
              d={d}
              fill="none"
              stroke={cor}
              strokeWidth={espessura}
              strokeLinecap="round"
              strokeDasharray={`${(v / 100) * arco} ${arco + espessura}`}
              className="transition-[stroke-dasharray] duration-500 ease-out"
            />
          ) : null}
        </svg>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1">
          <span className="text-3xl font-bold tabular-nums text-gray-900">
            {Math.round(v)}
          </span>
          {conceito ? (
            <span
              className="rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{ backgroundColor: `${cor}1f`, color: cor }}
            >
              {conceito}
            </span>
          ) : null}
        </div>
      </div>
      <span className="mt-2 text-center text-xs font-medium text-gray-500">{rotulo}</span>
    </div>
  );
}
