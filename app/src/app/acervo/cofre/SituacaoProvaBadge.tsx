"use client";

/**
 * Selo de `situacao_prova` — A21 do plano (03-FRONTEND §2.2).
 *
 * Labels e cores desta tabela são CONTRATO com o usuário (§13.2 do plano):
 * o selo é sempre texto + cor, nunca só cor (acessibilidade). Os textos daqui
 * divergem de propósito dos `SITUACAO_PROVA_LABELS` genéricos do domínio
 * ("Assinada pelo cliente" em vez de "Assinada (cliente)") porque o selo fala
 * com quem lê a lista, não com quem preenche formulário — o plano fixa as
 * strings exatas.
 */

import { cn } from "@/lib/utils";
import type { SituacaoProva } from "@/lib/conformidade/operacoes";

/** Label exata + classes por valor (03-FRONTEND §2.2 — padrão dos selos atuais). */
export const SITUACAO_PROVA_BADGE: Record<SituacaoProva, { label: string; classes: string }> = {
  RASCUNHO:          { label: "Rascunho",              classes: "bg-gray-100 text-gray-600 border-gray-200" },
  ASSINADA_PROPONENTE: { label: "Assinada (Proponente)",   classes: "bg-blue-50 text-blue-700 border-blue-200" },
  ASSINADA_CLIENTE:  { label: "Assinada pelo cliente", classes: "bg-green-50 text-green-700 border-green-200" },
  SUPERADA:          { label: "Superada",              classes: "bg-amber-50 text-amber-700 border-amber-200" },
  CANCELADA:         { label: "Cancelada",             classes: "bg-red-50 text-red-700 border-red-200" },
  MODELO:            { label: "Modelo",                classes: "bg-purple-50 text-purple-700 border-purple-200" },
  INDEFINIDA:        { label: "Situação indefinida",   classes: "bg-gray-50 text-gray-400 border-gray-100" },
};

interface Props {
  situacao: SituacaoProva | null;
  /**
   * Com `forcarExibicao` (seções 2 e 3 da ficha), `null` renderiza como
   * "Situação indefinida". Sem ela (cofre, detalhe), `null` e `INDEFINIDA`
   * NÃO renderizam — é o "coluna só quando diz algo" do escopo.
   */
  forcarExibicao?: boolean;
}

export function SituacaoProvaBadge({ situacao, forcarExibicao = false }: Props) {
  if (!forcarExibicao && (situacao === null || situacao === "INDEFINIDA")) return null;

  const efetiva: SituacaoProva = situacao ?? "INDEFINIDA";
  const { label, classes } = SITUACAO_PROVA_BADGE[efetiva];

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap",
        classes
      )}
    >
      {label}
    </span>
  );
}
