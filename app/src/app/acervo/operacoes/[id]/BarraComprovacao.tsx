"use client";

/**
 * Barra de comprovação como cartões clicáveis (ACERVO-UI-V2 §3-2): os três
 * números que dizem se a operação serve em habilitação — atestado (empresa),
 * ART/CAT (profissional) e contrato (lastro jurídico). O cartão rola até a
 * seção correspondente (2, 3, 1); zerado fica âmbar com CTA "subir", que abre
 * a gaveta de upload já com o tipo da lacuna.
 *
 * A fonte segue `contadoresBarra` (secoes.ts), que reproduz os agregados de
 * R1 — o número daqui e o da coluna do índice saem da MESMA regra.
 */

import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContadoresBarra } from "./secoes";

export interface BarraComprovacaoProps {
  contadores: ContadoresBarra;
  /** Clique no cartão rola até a seção correspondente. */
  onIrParaSecao: (numero: 1 | 2 | 3) => void;
  /** CTA "subir" do cartão zerado — abre a GavetaUpload com o tipo da lacuna. */
  onSubirLacuna: (numero: 1 | 2 | 3) => void;
}

const CARTOES: ReadonlyArray<{
  numero: 1 | 2 | 3;
  rotulo: string;
  titulo: (n: number) => string;
}> = [
  {
    numero: 2,
    rotulo: "Atestados",
    titulo: (n) => `${n} atestado${n !== 1 ? "s" : ""} contam na comprovação — ir para a seção 2`,
  },
  {
    numero: 3,
    rotulo: "ART/CAT",
    titulo: (n) => `${n} ART/CAT contam na comprovação — ir para a seção 3`,
  },
  {
    numero: 1,
    rotulo: "Contrato",
    titulo: (n) => `${n} peça${n !== 1 ? "s" : ""} de contrato contam na comprovação — ir para a seção 1`,
  },
];

export function BarraComprovacao({ contadores, onIrParaSecao, onSubirLacuna }: BarraComprovacaoProps) {
  const { atestados, artCat, contratos, total, naoContam } = contadores;
  const valores: Record<1 | 2 | 3, number> = { 1: contratos, 2: atestados, 3: artCat };

  return (
    <div className="mb-3">
      <div className="grid grid-cols-3 gap-2">
        {CARTOES.map((c) => {
          const valor = valores[c.numero];
          const zerado = valor === 0;
          return (
            <div
              key={c.numero}
              className={cn(
                "flex items-center gap-2 rounded-xl border p-3 min-w-0",
                zerado ? "border-amber-200 bg-amber-50/60" : "border-gray-200 bg-white"
              )}
            >
              <button
                type="button"
                onClick={() => onIrParaSecao(c.numero)}
                title={c.titulo(valor)}
                className="flex-1 min-w-0 text-left group"
              >
                <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 group-hover:text-gray-600 truncate transition-colors">
                  {c.rotulo}
                </p>
                <p
                  className={cn(
                    "text-2xl font-bold tabular-nums leading-tight",
                    zerado ? "text-amber-600" : "text-green-700"
                  )}
                >
                  {valor}
                </p>
              </button>
              {zerado && (
                <button
                  type="button"
                  onClick={() => onSubirLacuna(c.numero)}
                  aria-label={`Subir ${c.rotulo.toLowerCase()} — a lacuna impede o uso em habilitação`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-300 bg-white text-[11px] font-semibold text-amber-700 hover:bg-amber-100 flex-shrink-0 transition-colors"
                >
                  <Upload className="h-3 w-3" aria-hidden="true" /> subir
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 tabular-nums mt-1.5">
        {total} documento{total !== 1 ? "s" : ""} no dossiê
        {naoContam > 0 && (
          <span className="text-gray-400"> · {naoContam} rascunhos/superadas não contam na barra</span>
        )}
      </p>
    </div>
  );
}
