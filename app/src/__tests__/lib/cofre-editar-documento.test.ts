/**
 * EditarDocumentoSchema estendido (migration 0034 — R8/B1).
 *
 * Como em dossie-validations.test.ts: trava as MENSAGENS, não só o
 * aceita/rejeita — o BFF replica cada string literalmente (o `detalhes` do 422
 * é comparado byte a byte na paridade), então mudar uma vírgula aqui é mudar
 * contrato de API.
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  EditarDocumentoSchema,
  formatZodErrors,
} from "@/lib/conformidade/cofre/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const MSG_PAPEL =
  'Invalid option: expected one of "ATESTADO"|"CAT_ART"|"CONTRATO"|"ADITIVO"|"NOTA_FISCAL"|"DECLARACAO"|"OUTRO"';
const MSG_TIPO_DOCUMENTO =
  'Invalid option: expected one of "ART"|"CAT"|"ATESTADO"|"CONTRATO"|"ADITIVO"|"ANEXO_CONTRATO"|"CREA_PJ"|"ISO"|"DECLARACAO"|"PROPOSTA"|"ANEXO_ET"|"DOC_PROJETO"|"PEDIDO"|"NF"|"CARTA"|"RELATORIO"|"PESSOAL"|"CAPA_OP"|"COMPACTADO"|"OUTRO"';
const MSG_SITUACAO_PROVA =
  'Invalid option: expected one of "RASCUNHO"|"ASSINADA_PROPONENTE"|"ASSINADA_CLIENTE"|"SUPERADA"|"CANCELADA"|"MODELO"|"INDEFINIDA"';
const MSG_DETENTORA =
  'Invalid option: expected one of "PROPONENTE"|"COLIGADA"|"PARCEIRO"';

describe("EditarDocumentoSchema — campos 0033/0034 (R8)", () => {
  it("aceita body vazio: PATCH sem campo nenhum não muda nada", () => {
    const r = EditarDocumentoSchema.safeParse({});
    expect(r.success && r.data).toEqual({});
  });

  it("operacaoId aceita uuid (vincular) e null (desvincular)", () => {
    const vincula = EditarDocumentoSchema.safeParse({ operacaoId: UUID });
    expect(vincula.success && vincula.data.operacaoId).toBe(UUID);

    // `null` desvincula e NÃO limpa `papel` — a limpeza de papel é decisão
    // separada (regra do handler; aqui trava-se só que null é aceito).
    const desvincula = EditarDocumentoSchema.safeParse({ operacaoId: null });
    expect(desvincula.success && desvincula.data.operacaoId).toBeNull();
  });

  it("operacaoId que não é uuid → mensagem custom (a MESMA do resto do módulo)", () => {
    expect(erros(EditarDocumentoSchema, { operacaoId: "abc" })).toEqual({
      operacaoId: "ID inválido",
    });
  });

  it("papel/tipoDocumento/situacaoProva/detentora: null limpa, valor troca", () => {
    const r = EditarDocumentoSchema.safeParse({
      papel:         "ATESTADO",
      tipoDocumento: null,
      situacaoProva: "ASSINADA_CLIENTE",
      detentora:     null,
    });
    expect(r.success && r.data).toEqual({
      papel:         "ATESTADO",
      tipoDocumento: null,
      situacaoProva: "ASSINADA_CLIENTE",
      detentora:     null,
    });
  });

  it("enums inválidos saem com a mensagem de opção do Zod v4 (inglês literal)", () => {
    expect(erros(EditarDocumentoSchema, { papel: "XX" })).toEqual({ papel: MSG_PAPEL });
    expect(erros(EditarDocumentoSchema, { tipoDocumento: "XX" })).toEqual({
      tipoDocumento: MSG_TIPO_DOCUMENTO,
    });
    expect(erros(EditarDocumentoSchema, { situacaoProva: "XX" })).toEqual({
      situacaoProva: MSG_SITUACAO_PROVA,
    });
    expect(erros(EditarDocumentoSchema, { detentora: "XX" })).toEqual({
      detentora: MSG_DETENTORA,
    });
  });

  it("restrito é boolean SEM nullable: não existe 'limpar' em flag binária", () => {
    const liga = EditarDocumentoSchema.safeParse({ restrito: true });
    expect(liga.success && liga.data.restrito).toBe(true);

    expect(erros(EditarDocumentoSchema, { restrito: "true" })).toEqual({
      restrito: "Invalid input: expected boolean, received string",
    });
    expect(erros(EditarDocumentoSchema, { restrito: null })).toEqual({
      restrito: "Invalid input: expected boolean, received null",
    });
  });

  it("os dez campos antigos continuam passando juntos dos novos (retrocompat)", () => {
    const r = EditarDocumentoSchema.safeParse({
      titulo: "CND Federal 2026",
      status: "VIGENTE",
      operacaoId: UUID,
      papel: "CONTRATO",
      tipoDocumento: "CONTRATO",
      situacaoProva: "INDEFINIDA",
      detentora: "COLIGADA",
      restrito: false,
    });
    expect(r.success).toBe(true);
  });
});
