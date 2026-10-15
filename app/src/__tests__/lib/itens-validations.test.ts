/**
 * Schema do item com TAG do documento (Q9, migration 0044 — spec ONDA-5 §4.8,
 * §8.8).
 *
 * Como nos demais `*-validations.test.ts` do módulo, os casos travam as
 * MENSAGENS: o `detalhes` do 422 é renderizado campo a campo no formulário de
 * uma linha do `ItensTagDoDocumento`, então mudar uma vírgula aqui é mudar o
 * que o usuário lê.
 *
 * Dois guardas que não são sobre forma, e por isso estão escritos com nome
 * próprio:
 *
 * 1. **NÃO EXISTE `quantidade` NEM `unidade`** (§1f). A TAG diz QUAL
 *    equipamento, não quanto. O caso prova o comportamento observável: mandar `quantidade` no body não derruba a
 *    requisição, mas o campo não chega ao `data` (strip do `z.object()`), e não
 *    existe coluna para ele cair.
 * 2. **`especificacao` é chave→valor de UMA linha só.** Objeto aninhado é
 *    recusado de propósito: ficha de equipamento, não documento — um jsonb livre
 *    vira o lugar onde tudo cabe, e ninguém consegue mais consultá-lo.
 *
 * O que NÃO está aqui, por não caber em schema sem banco: a TAG repetida no
 * mesmo documento (conferida por `criarItemTag` contra a MESMA expressão do
 * índice `uniq_docitem_tag`, antes do INSERT) — §4.8, com critério próprio em
 * §8.15.
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { CriarItemTagSchema } from "@/lib/conformidade/itens/validations";
import { formatZodErrors } from "@/lib/conformidade/operacoes/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

// ── A prova executável de que o item não tem quantidade ─────────────────────

describe("SEM `quantidade` e SEM `unidade` no item tagueado (§1f)", () => {
  it("`{ tag, quantidade, unidade }` → `data` sai sem `quantidade` e sem `unidade`", () => {
    // O caso tem de estar escrito com este nome (§8.8): a TAG diz qual
    // equipamento, e não existe coluna para a quantidade cair.
    const r = CriarItemTagSchema.safeParse({ tag: "P-101", quantidade: 12, unidade: "un" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ tag: "P-101" });
    expect(r.success && "quantidade" in r.data).toBe(false);
    expect(r.success && "unidade" in r.data).toBe(false);
  });

  it("nem por dentro da `especificacao` a medida vira número", () => {
    // `especificacao` é Record<string,string>: "12" entra como TEXTO de ficha
    // ("material", "diametro"), e 12 como número é recusado. Ou seja, não há
    // porta lateral para a quantidade voltar como valor somável.
    const r = CriarItemTagSchema.safeParse({
      tag: "P-101",
      especificacao: { quantidade: "12" },
    });
    expect(r.success && r.data.especificacao).toEqual({ quantidade: "12" });
    expect(erros(CriarItemTagSchema, { tag: "P-101", especificacao: { quantidade: 12 } })).toEqual({
      "especificacao.quantidade": "Invalid input: expected string, received number",
    });
  });
});

// ── A TAG ────────────────────────────────────────────────────────────────────

describe("CriarItemTagSchema — a TAG do equipamento", () => {
  it("aceita a TAG real, com espaço e barra, já aparada", () => {
    // "P-101 A/B" é a TAG de duas bombas em paralelo — não é rótulo de
    // arquivamento (`documentosHabilitacao.tags`), é o equipamento citado
    // DENTRO do documento.
    const r = CriarItemTagSchema.safeParse({ tag: "  P-101 A/B  " });
    expect(r.success && r.data.tag).toBe("P-101 A/B");
  });

  it("`tag: ' '` → 'Informe a TAG' (o .trim() vem antes do .min(1))", () => {
    // O CHECK `chk_docitem_tag` faz `length(btrim(tag)) >= 1` do lado do banco:
    // os dois lados fecham o mesmo caso.
    expect(erros(CriarItemTagSchema, { tag: " " })).toEqual({ tag: "Informe a TAG" });
  });

  it("100 caracteres passam; 101 dão 'TAG muito longa'", () => {
    expect(CriarItemTagSchema.safeParse({ tag: "T".repeat(100) }).success).toBe(true);
    expect(erros(CriarItemTagSchema, { tag: "T".repeat(101) })).toEqual({ tag: "TAG muito longa" });
  });

  it("`tag` é obrigatória — item sem TAG não descreve nada", () => {
    expect(erros(CriarItemTagSchema, {})).toEqual({
      tag: "Invalid input: expected string, received undefined",
    });
  });
});

// ── `especificacao` ──────────────────────────────────────────────────────────

describe("CriarItemTagSchema — `especificacao` é ficha, não documento", () => {
  it("`{ material: 'AISI 316' }` passa e continua Record<string,string>", () => {
    const r = CriarItemTagSchema.safeParse({ tag: "P-101", especificacao: { material: "AISI 316" } });
    expect(r.success).toBe(true);
    const especificacao: Record<string, string> | null | undefined =
      r.success ? r.data.especificacao : undefined;
    expect(especificacao).toEqual({ material: "AISI 316" });
  });

  it("`{ x: { y: 1 } }` FALHA: objeto aninhado é recusado de propósito", () => {
    // Um jsonb livre vira o lugar onde tudo cabe — e o dia seguinte é uma
    // especificação com estrutura diferente por documento, que nenhuma consulta
    // alcança.
    const r = CriarItemTagSchema.safeParse({ tag: "P-101", especificacao: { x: { y: 1 } } });
    expect(r.success).toBe(false);
    expect(erros(CriarItemTagSchema, { tag: "P-101", especificacao: { x: { y: 1 } } })).toEqual({
      "especificacao.x": "Invalid input: expected string, received object",
    });
  });

  it("aceita várias chaves de uma linha e recusa chave ou valor longos demais", () => {
    const r = CriarItemTagSchema.safeParse({
      tag: "TQ-4210",
      especificacao: { material: "ASTM A36", diametro: '12"', classe: "150#" },
    });
    expect(r.success && r.data.especificacao).toEqual({
      material: "ASTM A36",
      diametro: '12"',
      classe: "150#",
    });
    expect(
      Object.keys(erros(CriarItemTagSchema, { tag: "P-101", especificacao: { ["k".repeat(61)]: "v" } }))
    ).toHaveLength(1);
    expect(
      Object.keys(erros(CriarItemTagSchema, { tag: "P-101", especificacao: { material: "v".repeat(201) } }))
    ).toEqual(["especificacao.material"]);
  });

  it("`null` e ausente são a mesma coisa — sem especificação", () => {
    expect(CriarItemTagSchema.safeParse({ tag: "P-101", especificacao: null }).success).toBe(true);
    expect(CriarItemTagSchema.safeParse({ tag: "P-101" }).success).toBe(true);
  });
});

// ── `descricao` e `ordem` ───────────────────────────────────────────────────

describe("CriarItemTagSchema — descrição e posição", () => {
  it("`descricao` é aparada, aceita 500 e recusa 501", () => {
    const r = CriarItemTagSchema.safeParse({ tag: "P-101", descricao: "  Bomba centrifuga  " });
    expect(r.success && r.data.descricao).toBe("Bomba centrifuga");
    expect(CriarItemTagSchema.safeParse({ tag: "P-101", descricao: "d".repeat(500) }).success).toBe(true);
    expect(Object.keys(erros(CriarItemTagSchema, { tag: "P-101", descricao: "d".repeat(501) }))).toEqual([
      "descricao",
    ]);
  });

  it("`ordem` é coagida de string, aceita 0..9999 e recusa fora da faixa", () => {
    // `z.coerce` porque a posição pode chegar de um `<input type=number>` como
    // texto — o mesmo padrão de `limit`/`offset` em FiltrosOperacaoSchema.
    const r = CriarItemTagSchema.safeParse({ tag: "P-101", ordem: "3" });
    expect(r.success && r.data.ordem).toBe(3);
    expect(CriarItemTagSchema.safeParse({ tag: "P-101", ordem: 0 }).success).toBe(true);
    expect(CriarItemTagSchema.safeParse({ tag: "P-101", ordem: 9999 }).success).toBe(true);
    expect(Object.keys(erros(CriarItemTagSchema, { tag: "P-101", ordem: -1 }))).toEqual(["ordem"]);
    expect(Object.keys(erros(CriarItemTagSchema, { tag: "P-101", ordem: 10000 }))).toEqual(["ordem"]);
  });

  it("`ordem` ausente NÃO ganha default: quem calcula é o banco (max+1)", () => {
    // Um default aqui faria duas abas abertas no mesmo documento calcularem a
    // mesma posição e as linhas sairiam embaralhadas (§4.8).
    const r = CriarItemTagSchema.safeParse({ tag: "P-101" });
    expect(r.success && "ordem" in r.data).toBe(false);
  });

  it("`documentoId` não é campo de body: vem do path da rota-satélite", () => {
    const r = CriarItemTagSchema.safeParse({ tag: "P-101", documentoId: UUID });
    expect(r.success && r.data).toEqual({ tag: "P-101" });
  });
});
