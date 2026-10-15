/**
 * Schemas novos do dossiê da operação (migration 0034 — R4/R6/R7/R11/R14).
 *
 * Como em operacoes-validations.test.ts: estes testes travam as MENSAGENS, não
 * só o aceita/rejeita — o BFF replica cada string literalmente (o `detalhes` de
 * 400/422 é comparado byte a byte na paridade), então mudar uma vírgula aqui é
 * mudar contrato de API.
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  CriarDocumentoComOperacaoSchema,
  EditarOperacaoSchema,
  FiltrosDocumentoComOperacaoSchema,
  ListarImportJobsSchema,
  VincularOperacaoEmLoteSchema,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const MSG_TIPO_DOCUMENTO =
  'Invalid option: expected one of "ART"|"CAT"|"ATESTADO"|"CONTRATO"|"ADITIVO"|"ANEXO_CONTRATO"|"CREA_PJ"|"ISO"|"DECLARACAO"|"PROPOSTA"|"ANEXO_ET"|"DOC_PROJETO"|"PEDIDO"|"NF"|"CARTA"|"RELATORIO"|"PESSOAL"|"CAPA_OP"|"COMPACTADO"|"OUTRO"';
const MSG_SITUACAO_PROVA =
  'Invalid option: expected one of "RASCUNHO"|"ASSINADA_PROPONENTE"|"ASSINADA_CLIENTE"|"SUPERADA"|"CANCELADA"|"MODELO"|"INDEFINIDA"';

describe("EditarOperacaoSchema (R4)", () => {
  it("aceita body vazio: PATCH sem campo nenhum não muda nada", () => {
    const r = EditarOperacaoSchema.safeParse({});
    expect(r.success && r.data).toEqual({});
  });

  it("não tem codigo nem origem: chegam no body, saem no strip", () => {
    // O 422 de `codigo` é checagem do handler ANTES do parse ("codigo" in body);
    // aqui trava-se que o schema em si nunca os deixa passar para o UPDATE.
    const r = EditarOperacaoSchema.safeParse({ codigo: "90099", origem: "MANUAL" });
    expect(r.success && "codigo" in r.data).toBe(false);
    expect(r.success && "origem" in r.data).toBe(false);
  });

  it("clienteNome e detentora são optional SEM nullable: dá para não mexer, não para apagar", () => {
    expect(erros(EditarOperacaoSchema, { clienteNome: null })).toEqual({
      clienteNome: "Invalid input: expected string, received null",
    });
    expect(erros(EditarOperacaoSchema, { detentora: null })).toEqual({
      detentora: 'Invalid option: expected one of "PROPONENTE"|"COLIGADA"|"PARCEIRO"',
    });
  });

  it("valida os campos com as MESMAS mensagens do CriarOperacaoSchema", () => {
    expect(erros(EditarOperacaoSchema, { clienteNome: "x" })).toEqual({
      clienteNome: "Nome do cliente deve ter pelo menos 2 caracteres",
    });
    expect(erros(EditarOperacaoSchema, { clienteCnpj: "11222333" })).toEqual({
      clienteCnpj: "CNPJ deve conter 14 dígitos",
    });
    expect(erros(EditarOperacaoSchema, { periodoInicio: "2019-02-31" })).toEqual({
      periodoInicio: "Data inválida. Use o formato AAAA-MM-DD.",
    });
    expect(erros(EditarOperacaoSchema, { valor: -1 })).toEqual({
      valor: "Valor não pode ser negativo",
    });
  });

  it("null limpa os nullable e ativo aceita boolean (o único campo que só existe no PATCH)", () => {
    const r = EditarOperacaoSchema.safeParse({
      clienteGrupo: null,
      periodoFim: null,
      valor: null,
      familiasSugeridas: null,
      ativo: false,
    });
    expect(r.success && r.data).toEqual({
      clienteGrupo: null,
      periodoFim: null,
      valor: null,
      familiasSugeridas: null,
      ativo: false,
    });
  });
});

describe("VincularOperacaoEmLoteSchema (R11)", () => {
  const minimo = { ids: [UUID], operacaoId: UUID };

  it("aceita o mínimo (papel é opcional) e papel quando presente", () => {
    expect(VincularOperacaoEmLoteSchema.safeParse(minimo).success).toBe(true);
    const r = VincularOperacaoEmLoteSchema.safeParse({ ...minimo, papel: "ATESTADO" });
    expect(r.success && r.data.papel).toBe("ATESTADO");
  });

  it("recusa lote vazio e lote acima de 200 com issue no path ids (vira o 422 fixo do handler)", () => {
    expect(erros(VincularOperacaoEmLoteSchema, { ...minimo, ids: [] })).toEqual({
      ids: "Too small: expected array to have >=1 items",
    });
    expect(
      erros(VincularOperacaoEmLoteSchema, { ...minimo, ids: Array(201).fill(UUID) })
    ).toEqual({
      ids: "Too big: expected array to have <=200 items",
    });
  });

  it("aponta o índice do id inválido — path ids.N também cai no 422 fixo", () => {
    expect(erros(VincularOperacaoEmLoteSchema, { ...minimo, ids: [UUID, "90008"] })).toEqual({
      "ids.1": "ID inválido",
    });
  });

  it("exige operacaoId uuid", () => {
    expect(erros(VincularOperacaoEmLoteSchema, { ids: [UUID] })).toEqual({
      operacaoId: "Invalid input: expected string, received undefined",
    });
    expect(erros(VincularOperacaoEmLoteSchema, { ids: [UUID], operacaoId: "90008" })).toEqual({
      operacaoId: "ID inválido",
    });
  });

  it("recusa papel fora da tupla da 0033", () => {
    expect(erros(VincularOperacaoEmLoteSchema, { ...minimo, papel: "PROVA" })).toEqual({
      papel:
        'Invalid option: expected one of "ATESTADO"|"CAT_ART"|"CONTRATO"|"ADITIVO"|"NOTA_FISCAL"|"DECLARACAO"|"OUTRO"',
    });
  });
});

describe("ListarImportJobsSchema (R14)", () => {
  it("aplica os defaults de paginação (20/0) e aceita o teto de 100", () => {
    const r = ListarImportJobsSchema.safeParse({});
    expect(r.success && r.data).toEqual({ limit: 20, offset: 0 });
    expect(ListarImportJobsSchema.safeParse({ limit: "100" }).success).toBe(true);
  });

  it("rejeita limit fora de 1..100 e offset negativo", () => {
    expect(erros(ListarImportJobsSchema, { limit: "101" })).toEqual({
      limit: "Too big: expected number to be <=100",
    });
    expect(erros(ListarImportJobsSchema, { limit: "0" })).toEqual({
      limit: "Too small: expected number to be >=1",
    });
    expect(erros(ListarImportJobsSchema, { offset: "-1" })).toEqual({
      offset: "Too small: expected number to be >=0",
    });
  });

  it("aceita os 4 status de import_jobs e recusa o resto", () => {
    for (const status of ["EM_ANDAMENTO", "CONCLUIDO", "FALHOU", "CANCELADO"]) {
      expect(ListarImportJobsSchema.safeParse({ status }).success).toBe(true);
    }
    expect(erros(ListarImportJobsSchema, { status: "PENDENTE" })).toEqual({
      status:
        'Invalid option: expected one of "EM_ANDAMENTO"|"CONCLUIDO"|"FALHOU"|"CANCELADO"',
    });
  });
});

describe("campos 0034 nos schemas do cofre", () => {
  const doc = { categoria: "TECNICA", subcategoria: "ATESTADO_ACT", titulo: "Atestado Alfa" };

  it("upload sem os campos novos continua funcionando igual (retrocompat)", () => {
    const r = CriarDocumentoComOperacaoSchema.safeParse(doc);
    expect(r.success && r.data.tipoDocumento).toBeUndefined();
    expect(r.success && r.data.situacaoProva).toBeUndefined();
    expect(r.success && r.data.detentora).toBeUndefined();
  });

  it("aceita tipo/situação/detentora do dossiê no upload", () => {
    const r = CriarDocumentoComOperacaoSchema.safeParse({
      ...doc,
      operacaoId: UUID,
      papel: "CAT_ART",
      tipoDocumento: "ART",
      situacaoProva: "ASSINADA_CLIENTE",
      detentora: "PROPONENTE",
    });
    expect(r.success && r.data.tipoDocumento).toBe("ART");
    expect(r.success && r.data.situacaoProva).toBe("ASSINADA_CLIENTE");
    expect(r.success && r.data.detentora).toBe("PROPONENTE");
  });

  it("recusa valores fora das tuplas, com a mensagem de enum do Zod v4", () => {
    expect(erros(CriarDocumentoComOperacaoSchema, { ...doc, tipoDocumento: "ATESTADOS" })).toEqual({
      tipoDocumento: MSG_TIPO_DOCUMENTO,
    });
    expect(erros(CriarDocumentoComOperacaoSchema, { ...doc, situacaoProva: "ASSINADA" })).toEqual({
      situacaoProva: MSG_SITUACAO_PROVA,
    });
    expect(erros(CriarDocumentoComOperacaoSchema, { ...doc, detentora: "Proponente" })).toEqual({
      detentora: 'Invalid option: expected one of "PROPONENTE"|"COLIGADA"|"PARCEIRO"',
    });
  });

  it("a listagem ganha semOperacao (default false) e tipoDocumento sem mexer no resto", () => {
    const base = { page: "1", limit: "50", order: "validade", dir: "asc" };
    const r = FiltrosDocumentoComOperacaoSchema.safeParse({ ...base, tipoDocumento: "ART" });
    expect(r.success && r.data.tipoDocumento).toBe("ART");
    expect(r.success && r.data.semOperacao).toBe(false);

    // O handler resolve "1"/"true" → true ANTES do parse (padrão comProva).
    const r2 = FiltrosDocumentoComOperacaoSchema.safeParse({ ...base, semOperacao: true });
    expect(r2.success && r2.data.semOperacao).toBe(true);

    expect(erros(FiltrosDocumentoComOperacaoSchema, { ...base, tipoDocumento: "XPTO" })).toEqual({
      tipoDocumento: MSG_TIPO_DOCUMENTO,
    });
  });
});
