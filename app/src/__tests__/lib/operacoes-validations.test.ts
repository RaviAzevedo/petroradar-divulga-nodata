/**
 * Schemas do cofre por operação (migration 0033).
 *
 * Estes testes travam as MENSAGENS, não só o aceita/rejeita: o BFF replica cada
 * string literalmente (o `detalhes` de 400/422 é comparado byte a byte na
 * paridade), então mudar uma vírgula aqui é mudar contrato de API.
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  CriarOperacaoSchema,
  CriarDocumentoComOperacaoSchema,
  EditarOperacaoSchema,
  FiltrosDocumentoComOperacaoSchema,
  FiltrosOperacaoSchema,
  VerificarHashesSchema,
  ehUuid,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const SHA = "a".repeat(64);

describe("FiltrosOperacaoSchema", () => {
  // Como o handler monta o input: `?? "50"` / `?? "0"` e comProva já booleano.
  const semFiltro = { comProva: false, limit: "50", offset: "0" };

  it("aplica os defaults de paginação", () => {
    const r = FiltrosOperacaoSchema.safeParse(semFiltro);
    expect(r.success && r.data).toEqual({ comProva: false, limit: 50, offset: 0 });
  });

  it("aceita o teto de 200 por página", () => {
    const r = FiltrosOperacaoSchema.safeParse({ ...semFiltro, limit: "200" });
    expect(r.success && r.data.limit).toBe(200);
  });

  it("rejeita limit acima de 200", () => {
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, limit: "201" })).toEqual({
      limit: "Too big: expected number to be <=200",
    });
  });

  it("trata limit presente-e-vazio como 0 e reprova (Number('') === 0)", () => {
    // Não é capricho: `searchParams.get()` devolve '' quando o param veio vazio,
    // o `??` não troca '' por default, e o BFF replica exatamente isto.
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, limit: "" })).toEqual({
      limit: "Too small: expected number to be >=1",
    });
  });

  it("rejeita limit não-inteiro antes de olhar o range", () => {
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, limit: "1.5" })).toEqual({
      limit: "Invalid input: expected int, received number",
    });
  });

  it("rejeita limit não-numérico", () => {
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, limit: "abc" })).toEqual({
      limit: "Invalid input: expected number, received NaN",
    });
  });

  it("aceita offset 0 e rejeita negativo", () => {
    expect(FiltrosOperacaoSchema.safeParse({ ...semFiltro, offset: "0" }).success).toBe(true);
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, offset: "-1" })).toEqual({
      offset: "Too small: expected number to be >=0",
    });
  });

  it("aceita as três detentoras e recusa o resto", () => {
    for (const d of ["PROPONENTE", "COLIGADA", "PARCEIRO"]) {
      expect(FiltrosOperacaoSchema.safeParse({ ...semFiltro, detentora: d }).success).toBe(true);
    }
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, detentora: "OUTRA" })).toEqual({
      detentora: 'Invalid option: expected one of "PROPONENTE"|"COLIGADA"|"PARCEIRO"',
    });
  });

  it("limita a busca a 200 caracteres", () => {
    expect(FiltrosOperacaoSchema.safeParse({ ...semFiltro, busca: "x".repeat(200) }).success).toBe(true);
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, busca: "x".repeat(201) })).toEqual({
      busca: "Busca muito longa",
    });
  });

  // ── D11: o recorte explícito do índice — `ativo`, `de` e `ate` ──────
  //
  // É aqui que D11 morre se alguém puser default. Hoje `/acervo/operacoes`
  // mostra ativas E inativas; um `ativo: z.boolean().default(true)` esconderia
  // as inativas de todo mundo sem que ninguém tivesse pedido, e o dia seguinte
  // seria "sumiram obras do índice" — o corte escondido que este recorte
  // explícito existe para NÃO repetir.

  it("`parse({})` não traz `ativo`, nem `de`, nem `ate`: a CHAVE não existe no objeto", () => {
    // `undefined` e "chave ausente" não são a mesma coisa aqui: a query só
    // empilha predicado quando a chave veio, e a resposta ecoa `filtros` com
    // SÓ o que foi aplicado. Um `true` neste caso invalida o recorte inteiro.
    const data = FiltrosOperacaoSchema.parse({});
    expect(data).toEqual({ comProva: false, limit: 50, offset: 0 });
    expect("ativo" in data).toBe(false);
    expect("de" in data).toBe(false);
    expect("ate" in data).toBe(false);
    expect(data.ativo).toBeUndefined();
    expect(data.de).toBeUndefined();
    expect(data.ate).toBeUndefined();
  });

  it("`ativo` é TRI-ESTADO: `true` e `false` passam e o valor é preservado", () => {
    // `false` tem de sobreviver ao parse: é o recorte "só inativas", e um
    // `?? true` em qualquer ponto do caminho o transformaria em "só ativas".
    const so_ativas = FiltrosOperacaoSchema.parse({ ...semFiltro, ativo: true });
    expect(so_ativas.ativo).toBe(true);
    const so_inativas = FiltrosOperacaoSchema.parse({ ...semFiltro, ativo: false });
    expect(so_inativas.ativo).toBe(false);
    expect("ativo" in so_inativas).toBe(true);
  });

  it("`de`/`ate` aceitam data real e recusam CALENDÁRIO inválido, não só formato", () => {
    // "2020-13-01" passa em qualquer regex; o Postgres o recusa com 22008 e a
    // rota devolveria 500 em vez de 400. Por isso é `ehDataIso`, que faz o
    // round-trip pelo `Date` (mesma função do `periodoInicio`).
    expect(FiltrosOperacaoSchema.safeParse({ ...semFiltro, de: "2016-02-29" }).success).toBe(true);
    const msg = "Data no formato AAAA-MM-DD";
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, de: "2020-13-01" })).toEqual({ de: msg });
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, de: "2019-02-31" })).toEqual({ de: msg });
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, ate: "01/01/2020" })).toEqual({ ate: msg });
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, ate: "2019-12-31T00:00:00.000Z" })).toEqual({ ate: msg });
  });

  it("janela invertida morre no campo `ate` com 'Data inicial maior que a final'", () => {
    // Comparação de STRING vale porque o formato já é AAAA-MM-DD validado: em
    // AAAA-MM-DD a ordem lexicográfica e a cronológica coincidem.
    expect(erros(FiltrosOperacaoSchema, { ...semFiltro, de: "2024-01-01", ate: "2023-01-01" })).toEqual({
      ate: "Data inicial maior que a final",
    });
    // Janela de um dia só (de === ate) é válida: quem digitou pediu aquele dia.
    expect(
      FiltrosOperacaoSchema.safeParse({ ...semFiltro, de: "2024-01-01", ate: "2024-01-01" }).success
    ).toBe(true);
    // Um extremo sozinho também é recorte legítimo — e não dispara o superRefine.
    expect(FiltrosOperacaoSchema.safeParse({ ...semFiltro, de: "2024-01-01" }).success).toBe(true);
    expect(FiltrosOperacaoSchema.safeParse({ ...semFiltro, ate: "2024-01-01" }).success).toBe(true);
  });

  it("o recorte completo ecoa os três parâmetros junto dos filtros de sempre", () => {
    // É este objeto que a rota devolve em `filtros` (§5.7) e que a tela escreve
    // por extenso no cabeçalho — recorte aplicado é recorte que aparece.
    const data = FiltrosOperacaoSchema.parse({
      ...semFiltro,
      busca: "REF-A",
      detentora: "PROPONENTE",
      ativo: true,
      de: "2018-01-01",
      ate: "2024-12-31",
    });
    expect(data).toEqual({
      busca: "REF-A",
      comProva: false,
      detentora: "PROPONENTE",
      ativo: true,
      de: "2018-01-01",
      ate: "2024-12-31",
      limit: 50,
      offset: 0,
    });
  });
});

// ── B5: `area` da planta ──────────────────────────────────────────────

describe("`area` da planta em Criar/EditarOperacaoSchema (B5)", () => {
  const minimo = { codigo: "90008", clienteNome: "Petrobras" };

  it("aceita 200 caracteres e recusa 201 com 'Área muito longa'", () => {
    expect(CriarOperacaoSchema.safeParse({ ...minimo, area: "U".repeat(200) }).success).toBe(true);
    expect(erros(CriarOperacaoSchema, { ...minimo, area: "U".repeat(201) })).toEqual({
      area: "Área muito longa",
    });
    expect(erros(EditarOperacaoSchema, { area: "U".repeat(201) })).toEqual({
      area: "Área muito longa",
    });
  });

  it("é TEXTO LIVRE e convive com `unidade` — não há catálogo de áreas (§1l)", () => {
    // "U-32" é a área DENTRO da planta; `unidade` é a planta/base ("REF-A").
    // As duas ficam, e a normalização, se vier, é migration futura com de-para
    // escrito à mão.
    const r = CriarOperacaoSchema.safeParse({ ...minimo, unidade: "REF-A", area: "U-32" });
    expect(r.success && r.data.unidade).toBe("REF-A");
    expect(r.success && r.data.area).toBe("U-32");
    for (const area of ["Área 30", "Off-site", "U-32 / U-39"]) {
      expect(CriarOperacaoSchema.safeParse({ ...minimo, area }).success, area).toBe(true);
    }
  });

  it("`area: null` passa nos dois schemas: limpar o campo é intenção", () => {
    expect(CriarOperacaoSchema.safeParse({ ...minimo, area: null }).success).toBe(true);
    const r = EditarOperacaoSchema.safeParse({ area: null });
    expect(r.success && r.data).toEqual({ area: null });
  });

  it("ausente continua ausente: cadastro antigo não ganha `area` de graça", () => {
    const r = CriarOperacaoSchema.safeParse(minimo);
    expect(r.success && "area" in r.data).toBe(false);
  });
});

describe("CriarOperacaoSchema", () => {
  const minimo = { codigo: "90008", clienteNome: "Petrobras" };

  it("aceita só código e cliente, com detentora PROPONENTE por padrão", () => {
    const r = CriarOperacaoSchema.safeParse(minimo);
    expect(r.success && r.data).toEqual({
      codigo: "90008",
      clienteNome: "Petrobras",
      detentora: "PROPONENTE",
    });
  });

  it("exige código e cliente", () => {
    expect(erros(CriarOperacaoSchema, {})).toEqual({
      codigo: "Invalid input: expected string, received undefined",
      clienteNome: "Invalid input: expected string, received undefined",
    });
  });

  it("recusa código curto, com espaço ou longo demais", () => {
    const msg =
      "Código inválido. Use de 2 a 32 caracteres entre letras, números, ponto, hífen e sublinhado.";
    expect(erros(CriarOperacaoSchema, { ...minimo, codigo: "1" })).toEqual({ codigo: msg });
    expect(erros(CriarOperacaoSchema, { ...minimo, codigo: "900 08" })).toEqual({ codigo: msg });
    expect(erros(CriarOperacaoSchema, { ...minimo, codigo: "x".repeat(33) })).toEqual({ codigo: msg });
  });

  it("aceita código com ponto, hífen e sublinhado (cadastro manual)", () => {
    for (const codigo of ["90008-A", "SC.12345", "OP_2026"]) {
      expect(CriarOperacaoSchema.safeParse({ ...minimo, codigo }).success).toBe(true);
    }
  });

  it("trata null como campo em branco nos opcionais", () => {
    const r = CriarOperacaoSchema.safeParse({
      ...minimo,
      clienteGrupo: null,
      valor: null,
      periodoInicio: null,
      familiasSugeridas: null,
    });
    expect(r.success).toBe(true);
  });

  it("aceita data real e recusa data que não existe no calendário", () => {
    // 2016 é bissexto: 29/02 passa. 31/02 e mês 13 não podem virar erro do
    // Postgres (500) — têm de morrer no 422.
    expect(CriarOperacaoSchema.safeParse({ ...minimo, periodoInicio: "2016-02-29" }).success).toBe(true);
    const msg = "Data inválida. Use o formato AAAA-MM-DD.";
    expect(erros(CriarOperacaoSchema, { ...minimo, periodoInicio: "2019-02-31" })).toEqual({ periodoInicio: msg });
    expect(erros(CriarOperacaoSchema, { ...minimo, periodoFim: "2019-13-01" })).toEqual({ periodoFim: msg });
    expect(erros(CriarOperacaoSchema, { ...minimo, periodoFim: "2019-12-31T00:00:00.000Z" })).toEqual({ periodoFim: msg });
  });

  it("aceita valor e HH como número e recusa negativo ou string", () => {
    const r = CriarOperacaoSchema.safeParse({ ...minimo, valor: 1234.5, hh: 12345.67 });
    expect(r.success && r.data.valor).toBe(1234.5);
    expect(erros(CriarOperacaoSchema, { ...minimo, valor: -1 })).toEqual({
      valor: "Valor não pode ser negativo",
    });
    expect(erros(CriarOperacaoSchema, { ...minimo, valor: "1234.50" })).toEqual({
      valor: "Invalid input: expected number, received string",
    });
  });

  it("valida CNPJ com 14 dígitos e a detentora", () => {
    expect(erros(CriarOperacaoSchema, { ...minimo, clienteCnpj: "11222333" })).toEqual({
      clienteCnpj: "CNPJ deve conter 14 dígitos",
    });
    expect(erros(CriarOperacaoSchema, { ...minimo, detentora: "TERCEIRO" })).toEqual({
      detentora: 'Invalid option: expected one of "PROPONENTE"|"COLIGADA"|"PARCEIRO"',
    });
  });

  it("não deixa o cliente escolher a origem (CATALOGO é do seed)", () => {
    const r = CriarOperacaoSchema.safeParse({ ...minimo, origem: "CATALOGO" });
    expect(r.success && "origem" in r.data).toBe(false);
  });
});

describe("VerificarHashesSchema", () => {
  it("aceita de 1 a 50 hashes", () => {
    expect(VerificarHashesSchema.safeParse({ sha256: [SHA] }).success).toBe(true);
    expect(VerificarHashesSchema.safeParse({ sha256: Array(50).fill(SHA) }).success).toBe(true);
  });

  it("recusa lote vazio e lote acima de 50", () => {
    expect(erros(VerificarHashesSchema, { sha256: [] })).toEqual({
      sha256: "Informe ao menos um hash",
    });
    expect(erros(VerificarHashesSchema, { sha256: Array(51).fill(SHA) })).toEqual({
      sha256: "Máximo de 50 hashes por chamada",
    });
  });

  it("exige hex minúsculo de 64 caracteres, apontando o índice do item", () => {
    const msg = "Hash inválido. Informe o SHA-256 com 64 caracteres hexadecimais minúsculos.";
    expect(erros(VerificarHashesSchema, { sha256: ["A".repeat(64)] })).toEqual({ "sha256.0": msg });
    expect(erros(VerificarHashesSchema, { sha256: [SHA, "abc"] })).toEqual({ "sha256.1": msg });
  });
});

describe("extensões dos schemas do cofre", () => {
  const doc = { categoria: "TECNICA", subcategoria: "ATESTADO_ACT", titulo: "Atestado Alfa" };

  it("mantém o upload sem operação funcionando igual", () => {
    const r = CriarDocumentoComOperacaoSchema.safeParse(doc);
    expect(r.success && r.data.operacaoId).toBeUndefined();
    expect(r.success && r.data.papel).toBeUndefined();
  });

  it("aceita operação e papel", () => {
    const r = CriarDocumentoComOperacaoSchema.safeParse({ ...doc, operacaoId: UUID, papel: "CAT_ART" });
    expect(r.success && r.data.papel).toBe("CAT_ART");
  });

  it("recusa papel fora da lista e operacaoId que não é uuid", () => {
    expect(erros(CriarDocumentoComOperacaoSchema, { ...doc, papel: "PROVA" })).toEqual({
      papel:
        'Invalid option: expected one of "ATESTADO"|"CAT_ART"|"CONTRATO"|"ADITIVO"|"NOTA_FISCAL"|"DECLARACAO"|"OUTRO"',
    });
    expect(erros(CriarDocumentoComOperacaoSchema, { ...doc, operacaoId: "90008" })).toEqual({
      operacaoId: "ID inválido",
    });
  });

  it("adiciona o filtro operacaoId sem mexer no resto da listagem", () => {
    const base = { page: "1", limit: "50", order: "validade", dir: "asc" };
    const r = FiltrosDocumentoComOperacaoSchema.safeParse({ ...base, operacaoId: UUID });
    expect(r.success && r.data.operacaoId).toBe(UUID);
    expect(FiltrosDocumentoComOperacaoSchema.safeParse(base).success).toBe(true);
    expect(erros(FiltrosDocumentoComOperacaoSchema, { ...base, operacaoId: "90008" })).toEqual({
      operacaoId: "ID inválido",
    });
  });
});

describe("ehUuid", () => {
  it("aceita uuid e recusa o resto (é o que devolve 404 em vez de 500)", () => {
    expect(ehUuid(UUID)).toBe(true);
    expect(ehUuid("90008")).toBe(false);
    expect(ehUuid("")).toBe(false);
    expect(ehUuid(`${UUID} `)).toBe(false);
  });
});
