"use client";

// Colunas verticais empilhadas (linha do tempo) — presentational, zero fetch,
// zero estado. Spec do Painel do Acervo §3. Flex de colunas com altura
// proporcional ao maior total; rótulo do eixo embaixo (text-[10px], sem rotação
// — o consumidor abrevia, ex.: "’98"); tooltip nativo (title) por segmento.
// Colunas demais (>25) → agregar é responsabilidade do consumidor.

import { inteiroBR } from "./paleta";

export interface SegmentoColuna {
  valor: number;
  cor: string;
  /** Tooltip do segmento (default: "rótulo da coluna: valor"). */
  titulo?: string;
}

export interface ColunaEmpilhada {
  rotulo: string;
  /** Segmentos empilhados da base para o topo, na ordem do array. */
  segmentos: SegmentoColuna[];
}

export interface ColunasProps {
  colunas: ColunaEmpilhada[];
  /** Altura da área de plotagem em px (default 160). */
  alturaPx?: number;
}

function indiceTopo(segmentos: SegmentoColuna[]): number {
  for (let i = segmentos.length - 1; i >= 0; i--) {
    const seg = segmentos[i];
    if (seg && seg.valor > 0) return i;
  }
  return -1;
}

export function Colunas({ colunas, alturaPx = 160 }: ColunasProps) {
  if (colunas.length === 0) return null;

  const totais = colunas.map((col) =>
    col.segmentos.reduce((soma, seg) => soma + Math.max(seg.valor, 0), 0)
  );
  const maior = totais.reduce((m, t) => Math.max(m, t), 0);
  const escala = maior > 0 ? alturaPx / maior : 0;
  const iMaior = totais.indexOf(maior);
  const colunaMaior = colunas[iMaior];

  const aria =
    maior > 0 && colunaMaior
      ? `Gráfico de colunas com ${colunas.length} períodos; maior: ${colunaMaior.rotulo} com ${inteiroBR(maior)}.`
      : `Gráfico de colunas com ${colunas.length} períodos, sem dados.`;

  return (
    <div role="img" aria-label={aria} className="w-full">
      <div aria-hidden="true">
        <div className="flex items-end gap-1" style={{ height: alturaPx }}>
          {colunas.map((col, i) => {
            const topo = indiceTopo(col.segmentos);
            return (
              <div
                key={`${col.rotulo}-${i}`}
                className="flex min-w-0 flex-1 flex-col-reverse"
              >
                {col.segmentos.map((seg, j) => {
                  if (seg.valor <= 0) return null;
                  const altura = Math.max(seg.valor * escala, 1); // segmento >0 nunca some
                  return (
                    <div
                      key={j}
                      className={
                        "transition-opacity hover:opacity-75" +
                        (j === topo ? " rounded-t-[3px]" : "")
                      }
                      style={{ height: altura, backgroundColor: seg.cor }}
                      title={seg.titulo ?? `${col.rotulo}: ${inteiroBR(seg.valor)}`}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex gap-1">
          {colunas.map((col, i) => (
            <div
              key={`${col.rotulo}-rotulo-${i}`}
              className="min-w-0 flex-1 truncate text-center text-[10px] leading-tight text-gray-500"
              title={col.rotulo}
            >
              {col.rotulo}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
