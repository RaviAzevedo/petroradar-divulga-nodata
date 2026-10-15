/**
 * Schemas das anotações do acervo (migration 0044 — spec ONDA-5 §4.2, §8.7).
 *
 * Como em `operacoes-validations` e `profissionais-validations`: estes testes
 * travam as MENSAGENS, não só o aceita/rejeita — o `detalhes` do 422 é
 * renderizado campo a campo dentro do `BlocoAnotacoes`, então mudar uma vírgula
 * aqui é mudar o que o usuário lê.
 *
 * Três guardas que não são sobre forma, e por isso estão escritos com nome
 * próprio:
 *
 * 1. **Autoria não é campo de formulário** (§4.2). `autorId`/`autorNome` vêm da
 *    sessão; um cliente que os mandasse no body teria o campo descartado pelo
 *    strip do `z.object()`. O caso prova o comportamento observável — o body
 *    passa, mas o `data` sai SEM as duas chaves —, que é o que impede alguém de
 *    "aceitar" autoria vinda de fora ao escrever o handler.
 * 2. **`resolvidas` tem default `false` e o default é ECOADO** (Q10.3: default é
 *    corte, e corte aparece). Se alguém tirar o `.default(false)`, a chave some
 *    do `data`, o eco na resposta some junto e a tela passa a esconder as
 *    resolvidas sem dizer — que é exatamente o corte escondido que a onda
 *    inteira existe para não repetir.
 * 3. **PATCH vazio é 422, não 200.** O `refine` com `path: ["texto"]` é o que
 *    põe a mensagem num campo que o formulário sabe destacar; responder 200 a um
 *    `{}` esconderia o bug do cliente.
 *
 * O que NÃO está aqui, por não caber em schema sem banco: a existência do alvo
 * (`alvoExiste`, 422 `{ alvoId: "Alvo não encontrado" }`), a barreira do
 * documento restrito (`paiRestritoInvisivel`, ADR-05) e a redação de PII
 * (`redigirPii`, aplicada pela ROTA antes de gravar). As três são §5.1/§5.2 e
 * têm critério próprio em §8.14.
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  ALVOS_ANOTACAO,
  ALVO_ANOTACAO_LABELS,
  CriarAnotacaoSchema,
  EditarAnotacaoSchema,
  FiltrosAnotacaoSchema,
} from "@/lib/conformidade/anotacoes/validations";
import { formatZodErrors } from "@/lib/conformidade/operacoes/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

// ── O vocabulário fechado dos alvos ──────────────────────────────────────────

describe("ALVOS_ANOTACAO — espelho do CHECK `chk_anot_alvo` (0044)", () => {
  it("tem exatamente os três valores do CHECK, na mesma ordem", () => {
    // A ordem importa porque a tupla é a fonte do `z.enum` E do CHECK do banco:
    // um valor a mais aqui passa no zod e é recusado pelo Postgres com 23514
    // (500 na cara do usuário); um a menos faz o contrário.
    expect(ALVOS_ANOTACAO).toEqual(["OPERACAO", "DOCUMENTO", "PROFISSIONAL"]);
    expect(ALVOS_ANOTACAO).toHaveLength(3);
  });

  it("todo alvo tem rótulo em pt-BR (é o que a tela escreve no cabeçalho)", () => {
    for (const alvo of ALVOS_ANOTACAO) {
      expect(ALVO_ANOTACAO_LABELS[alvo], alvo).toBeTruthy();
    }
    expect(Object.keys(ALVO_ANOTACAO_LABELS).sort()).toEqual([...ALVOS_ANOTACAO].sort());
  });
});

// ── GET /anotacoes — os filtros ──────────────────────────────────────────────

describe("FiltrosAnotacaoSchema — alvo obrigatório e `resolvidas` ecoado", () => {
  it("com alvo válido aplica o default `resolvidas: false` (o corte que aparece)", () => {
    const r = FiltrosAnotacaoSchema.safeParse({ alvoTipo: "OPERACAO", alvoId: UUID });
    expect(r.success && r.data.resolvidas).toBe(false);
    expect(r.success && r.data).toEqual({ alvoTipo: "OPERACAO", alvoId: UUID, resolvidas: false });
  });

  it("`resolvidas: true` preserva o valor (é o link 'ver as resolvidas')", () => {
    const r = FiltrosAnotacaoSchema.safeParse({ alvoTipo: "DOCUMENTO", alvoId: UUID, resolvidas: true });
    expect(r.success && r.data.resolvidas).toBe(true);
  });

  it("aceita os três alvos — inclusive PROFISSIONAL", () => {
    for (const alvoTipo of ALVOS_ANOTACAO) {
      expect(FiltrosAnotacaoSchema.safeParse({ alvoTipo, alvoId: UUID }).success, alvoTipo).toBe(true);
    }
  });

  it("`alvoTipo` ausente falha: não existe 'listar todas as anotações'", () => {
    // Uma lista global viraria um mural que ninguém mantém (§4.2) — e, pior,
    // atravessaria a barreira de documento restrito, que é por alvo.
    expect(erros(FiltrosAnotacaoSchema, { alvoId: UUID })).toEqual({
      alvoTipo: 'Invalid option: expected one of "OPERACAO"|"DOCUMENTO"|"PROFISSIONAL"',
    });
  });

  it("`alvoTipo: 'OBRA'` falha NO CAMPO (o CHECK do banco diria o mesmo)", () => {
    expect(erros(FiltrosAnotacaoSchema, { alvoTipo: "OBRA", alvoId: UUID })).toEqual({
      alvoTipo: 'Invalid option: expected one of "OPERACAO"|"DOCUMENTO"|"PROFISSIONAL"',
    });
  });

  it("`alvoId` que não é uuid dá 'ID inválido' (é o que evita 500 no cast)", () => {
    expect(erros(FiltrosAnotacaoSchema, { alvoTipo: "OPERACAO", alvoId: "abc" })).toEqual({
      alvoId: "ID inválido",
    });
  });
});

// ── POST /anotacoes — criar ──────────────────────────────────────────────────

describe("CriarAnotacaoSchema — o texto e a autoria", () => {
  const base = { alvoTipo: "OPERACAO" as const, alvoId: UUID };

  it("aceita uma frase normal e devolve o texto já aparado", () => {
    const r = CriarAnotacaoSchema.safeParse({
      ...base,
      texto: "  o atestado 90008 tem a data de emissao errada  ",
    });
    expect(r.success && r.data.texto).toBe("o atestado 90008 tem a data de emissao errada");
  });

  it("`texto: '   '` → 'Escreva a anotação' (o .trim() vem antes do .min(1))", () => {
    // O CHECK `chk_anot_texto` faz `length(btrim(texto)) >= 1` do lado do banco:
    // os dois lados fecham o mesmo caso, e este é o que vira 422 legível.
    expect(erros(CriarAnotacaoSchema, { ...base, texto: "   " })).toEqual({
      texto: "Escreva a anotação",
    });
  });

  it("4.000 caracteres passam; 4.001 dão 'Anotação muito longa'", () => {
    // O mesmo teto do CHECK do banco e de `operacoes.escopo`: anotação é frase,
    // não anexo.
    expect(CriarAnotacaoSchema.safeParse({ ...base, texto: "x".repeat(4000) }).success).toBe(true);
    expect(erros(CriarAnotacaoSchema, { ...base, texto: "x".repeat(4001) })).toEqual({
      texto: "Anotação muito longa",
    });
  });

  it("autoria não é campo de formulário: `data` sai sem `autorId` e sem `autorNome`", () => {
    // O caso tem de estar escrito com este nome (§8.7). `autorId`/`autorNome`
    // vêm da SESSÃO; aceitar os do body deixaria qualquer um assinar anotação
    // com o nome de outra pessoa — e o PATCH/DELETE de §5.2 decide permissão
    // justamente por `autorId`.
    const r = CriarAnotacaoSchema.safeParse({
      ...base,
      texto: "conferir a ART com o contrato",
      autorId: "x",
      autorNome: "y",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({
      alvoTipo: "OPERACAO",
      alvoId: UUID,
      texto: "conferir a ART com o contrato",
    });
    expect(r.success && "autorId" in r.data).toBe(false);
    expect(r.success && "autorNome" in r.data).toBe(false);
  });

  it("exige alvo e texto juntos (o POST não herda alvo de lugar nenhum)", () => {
    expect(erros(CriarAnotacaoSchema, {})).toEqual({
      alvoTipo: 'Invalid option: expected one of "OPERACAO"|"DOCUMENTO"|"PROFISSIONAL"',
      alvoId: "Invalid input: expected string, received undefined",
      texto: "Invalid input: expected string, received undefined",
    });
  });
});

// ── PATCH /anotacoes/[id] — editar e resolver ────────────────────────────────

describe("EditarAnotacaoSchema — PATCH vazio é erro de cliente", () => {
  it("`{}` falha com `detalhes.texto === 'Informe texto ou resolvida'`", () => {
    // `path: ["texto"]` de propósito: a mensagem tem de cair num campo que o
    // formulário sabe destacar. Responder 200 a um PATCH que não muda nada
    // esconderia o bug do cliente (mesmo critério do PATCH de operação).
    expect(erros(EditarAnotacaoSchema, {})).toEqual({
      texto: "Informe texto ou resolvida",
    });
  });

  it("`{ resolvida: false }` passa — reabrir é mudança", () => {
    const r = EditarAnotacaoSchema.safeParse({ resolvida: false });
    expect(r.success && r.data).toEqual({ resolvida: false });
  });

  it("`{ resolvida: true }` e `{ texto }` passam sozinhos, e os dois juntos também", () => {
    expect(EditarAnotacaoSchema.safeParse({ resolvida: true }).success).toBe(true);
    expect(EditarAnotacaoSchema.safeParse({ texto: "corrigido" }).success).toBe(true);
    const r = EditarAnotacaoSchema.safeParse({ texto: "corrigido", resolvida: true });
    expect(r.success && r.data).toEqual({ texto: "corrigido", resolvida: true });
  });

  it("`{ texto: ' ' }` falha com a MESMA mensagem do POST", () => {
    // Uma mensagem só para a mesma regra nos dois verbos: quem lê a tela não
    // tem de descobrir que "editar" e "criar" exigem coisas diferentes.
    expect(erros(EditarAnotacaoSchema, { texto: " " })).toEqual({
      texto: "Escreva a anotação",
    });
    expect(erros(EditarAnotacaoSchema, { texto: "x".repeat(4001) })).toEqual({
      texto: "Anotação muito longa",
    });
  });

  it("também faz strip da autoria (ninguém reescreve autor por PATCH)", () => {
    const r = EditarAnotacaoSchema.safeParse({ resolvida: true, autorId: "x", autorNome: "y" });
    expect(r.success && r.data).toEqual({ resolvida: true });
  });
});
