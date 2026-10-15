"use client";

/**
 * Chip do tipo de documento no dossiê (ACERVO-UI-V2 §2.2).
 *
 * Cor por GRUPO de tipo (contratual/atestado/responsabilidade técnica/empresa/
 * técnico/administrativo) — a cor diz de que família a prova é sem exigir
 * leitura do rótulo. `null` renderiza "sem tipo" em âmbar de propósito: tipo
 * ausente é lacuna a resolver, não estado neutro.
 */

import { cn } from "@/lib/utils";
import { TIPO_DOCUMENTO_LABELS, type TipoDocumento } from "@/lib/conformidade/operacoes";

const CONTRATUAL = "bg-sky-50 text-sky-700 border-sky-200";
const ATESTADO = "bg-green-50 text-green-700 border-green-200";
const RESP_TECNICA = "bg-violet-50 text-violet-700 border-violet-200";
const EMPRESA = "bg-teal-50 text-teal-700 border-teal-200";
const TECNICO = "bg-gray-50 text-gray-600 border-gray-200";
const ADMINISTRATIVO = "bg-gray-100 text-gray-500 border-gray-200";

const CLASSES_POR_TIPO: Record<TipoDocumento, string> = {
  CONTRATO: CONTRATUAL, ADITIVO: CONTRATUAL, ANEXO_CONTRATO: CONTRATUAL, PEDIDO: CONTRATUAL,
  ATESTADO,
  ART: RESP_TECNICA, CAT: RESP_TECNICA,
  CREA_PJ: EMPRESA, ISO: EMPRESA, DECLARACAO: EMPRESA,
  PROPOSTA: TECNICO, ANEXO_ET: TECNICO, DOC_PROJETO: TECNICO, RELATORIO: TECNICO,
  NF: ADMINISTRATIVO, CARTA: ADMINISTRATIVO, PESSOAL: ADMINISTRATIVO,
  CAPA_OP: ADMINISTRATIVO, COMPACTADO: ADMINISTRATIVO, OUTRO: ADMINISTRATIVO,
};

export function ChipTipoDocumento({ tipo }: { tipo: TipoDocumento | null }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap",
        tipo ? CLASSES_POR_TIPO[tipo] : "bg-amber-50 text-amber-700 border-amber-200"
      )}
    >
      {tipo ? TIPO_DOCUMENTO_LABELS[tipo] : "sem tipo"}
    </span>
  );
}
