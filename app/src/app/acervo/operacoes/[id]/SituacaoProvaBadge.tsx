"use client";

/**
 * Selo de `situacao_prova` (03-FRONTEND §2.2).
 *
 * Regra de exibição em duas camadas:
 *  - com `forcarExibicao` (seções 2 e 3 da ficha, onde a situação é decisão de
 *    habilitação): `null` vira "Situação indefinida" — o avaliador precisa VER
 *    que ninguém avaliou;
 *  - sem ela: `null` e `INDEFINIDA` não renderizam nada — selo só quando diz
 *    algo ("coluna só quando diz algo").
 * Sempre texto + cor, nunca só cor (acessibilidade).
 *
 * NOTA: a spec (A21) manda este selo para `components/conformidade/cofre/`,
 * compartilhado com o cofre/upload — extração a fazer quando a frente do cofre
 * o criar; a ficha então troca o import e apaga este arquivo.
 */

import { cn } from "@/lib/utils";
import {
  SITUACAO_PROVA_LABELS,
  type SituacaoProva,
} from "@/lib/conformidade/operacoes";

const COR_SITUACAO: Record<SituacaoProva, string> = {
  RASCUNHO:          "bg-gray-100 text-gray-600 border-gray-200",
  ASSINADA_PROPONENTE: "bg-blue-50 text-blue-700 border-blue-200",
  ASSINADA_CLIENTE:  "bg-green-50 text-green-700 border-green-200",
  SUPERADA:          "bg-amber-50 text-amber-700 border-amber-200",
  CANCELADA:         "bg-red-50 text-red-700 border-red-200",
  MODELO:            "bg-purple-50 text-purple-700 border-purple-200",
  INDEFINIDA:        "bg-gray-50 text-gray-400 border-gray-100",
};

interface Props {
  situacao: SituacaoProva | null;
  forcarExibicao?: boolean;
}

export function SituacaoProvaBadge({ situacao, forcarExibicao = false }: Props) {
  if (!forcarExibicao && (situacao === null || situacao === "INDEFINIDA")) return null;

  const label = situacao === null ? "Situação indefinida" : SITUACAO_PROVA_LABELS[situacao];
  const cor = situacao === null ? COR_SITUACAO.INDEFINIDA : COR_SITUACAO[situacao];

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap",
        cor
      )}
    >
      {label}
    </span>
  );
}
