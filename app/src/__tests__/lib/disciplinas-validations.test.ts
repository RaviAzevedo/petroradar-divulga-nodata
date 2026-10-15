/**
 * Schemas de disciplinas do acervo (migration 0043).
 *
 * Como em operacoes-validations: estes testes travam
 * as MENSAGENS, não só o aceita/rejeita. O `detalhes` do 422 é renderizado campo
 * a campo na tela (o modal de disciplinas da ficha e a chamada da cobertura),
 * então mudar uma vírgula aqui é mudar o que o usuário lê.
 *
 * O que NÃO está aqui, de propósito:
 * - a EXISTÊNCIA da disciplina no catálogo. O schema não tem acesso ao banco;
 *   quem confere é `conferirDisciplina()` na rota (spec ONDA-4 §1a), e o 422 de
 *   lista (`disciplinaIds: "Disciplina não encontrada: <id>"`) nasce lá;
 * - qualquer tupla de códigos ou `Record` de rótulos. Disciplina é linha de
 *   CATÁLOGO, não enum (§1g): o conjunto cresce com o uso e o rótulo vem do
 *   banco pelo `GET /api/conformidade/disciplinas`. Um teste que travasse
 *   "TUB, ELE, INS…" aqui criaria o segundo lugar onde o catálogo vive;
 * - a soma da cobertura (C3), que é SQL com `count(DISTINCT …) FILTER (…)` e é
 *   provada no Postgres temporário (§6.1) — reimplementá-la em TS seria criar
 *   duas regras de cobertura.
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  CoberturaQuerySchema,
  DisciplinasOperacaoSchema,
  FiltrosDisciplinaSchema,
} from "@/lib/conformidade/disciplinas/validations";
import { formatZodErrors } from "@/lib/conformidade/operacoes/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID2 = "9b2b7a3e-0c1d-4e5f-8a6b-7c8d9e0f1a2b";
const UUID3 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// ── PUT /operacoes/[id]/disciplinas ──────────────────────────────────────────

describe("DisciplinasOperacaoSchema — o conjunto INTEIRO da obra", () => {
  it("lista vazia passa: é o gesto 'esta obra não tem nenhuma disciplina'", () => {
    // O PUT não é delta: manda-se o conjunto todo, e o conjunto vazio é um
    // conjunto válido. Sem este caso, desmarcar o último chip seria impossível.
    const r = DisciplinasOperacaoSchema.safeParse({ disciplinaIds: [] });
    expect(r.success && r.data).toEqual({ disciplinaIds: [] });
  });

  it("campo ausente falha — omitir não é o mesmo que esvaziar", () => {
    // `{}` seria "não mexa" e `{disciplinaIds: []}` é "apague tudo". Aceitar o
    // primeiro como o segundo apagaria o cadastro de quem mandou body errado.
    expect(erros(DisciplinasOperacaoSchema, {})).toEqual({
      disciplinaIds: "Invalid input: expected array, received undefined",
    });
  });

  it("null no lugar da lista falha com a mesma clareza", () => {
    expect(erros(DisciplinasOperacaoSchema, { disciplinaIds: null })).toEqual({
      disciplinaIds: "Invalid input: expected array, received null",
    });
  });

  it("aceita 20 ids e recusa 21 com a mensagem do teto", () => {
    const vinte = Array.from({ length: 20 }, () => UUID);
    expect(DisciplinasOperacaoSchema.safeParse({ disciplinaIds: vinte }).success).toBe(true);
    expect(erros(DisciplinasOperacaoSchema, { disciplinaIds: [...vinte, UUID] })).toEqual({
      disciplinaIds: "No máximo 20 disciplinas",
    });
  });

  it("id malformado aponta a POSIÇÃO no array (disciplinaIds.0)", () => {
    // O path com índice é o que a tela usa para marcar o chip errado; um
    // `detalhes.disciplinaIds` genérico não diria qual dos 16 está errado.
    expect(erros(DisciplinasOperacaoSchema, { disciplinaIds: ["abc"] })).toEqual({
      "disciplinaIds.0": "ID inválido",
    });
  });

  it("a posição é a real, não sempre a primeira", () => {
    expect(erros(DisciplinasOperacaoSchema, { disciplinaIds: [UUID, UUID2, "TUB"] })).toEqual({
      "disciplinaIds.2": "ID inválido",
    });
  });

  it("duplicata no array PASSA — quem deduplica é a query, não o schema", () => {
    // Duas abas marcando o mesmo chip não podem virar 500 pelo PK composto de
    // `operacao_disciplinas`: `setDisciplinasDaOperacao` passa um Set antes do
    // INSERT (spec §4.3). Recusar aqui seria erro de UX, não de dado.
    const r = DisciplinasOperacaoSchema.safeParse({ disciplinaIds: [UUID, UUID2, UUID] });
    expect(r.success && r.data.disciplinaIds).toEqual([UUID, UUID2, UUID]);
  });

  it("não inventa campo: chave desconhecida no body é descartada pelo z.object()", () => {
    const r = DisciplinasOperacaoSchema.safeParse({ disciplinaIds: [UUID], codigos: ["TUB"] });
    expect(r.success && r.data).toEqual({ disciplinaIds: [UUID] });
  });
});

// ── GET /disciplinas (o catálogo) ────────────────────────────────────────────

describe("FiltrosDisciplinaSchema — o catálogo", () => {
  it("ausente aplica o default ativas: true", () => {
    // Default É corte, e corte aparece: a rota ecoa `ativas` na resposta
    // (Q10.3). A tela usa o default; a auditoria pede `?ativas=0` e vê tudo.
    const r = FiltrosDisciplinaSchema.safeParse({});
    expect(r.success && r.data).toEqual({ ativas: true });
  });

  it("ativas: false traz o catálogo inteiro", () => {
    const r = FiltrosDisciplinaSchema.safeParse({ ativas: false });
    expect(r.success && r.data).toEqual({ ativas: false });
  });

  it("a rota converte a query string ANTES do zod (boolean, nunca '0')", () => {
    // Mesmo desenho de `comProva` em FiltrosOperacaoSchema e de `semOperacao`
    // no cofre: a leitura do searchParams vira boolean no handler. Um
    // `z.coerce.boolean()` aqui faria a string "0" virar `true`.
    expect(erros(FiltrosDisciplinaSchema, { ativas: "0" })).toEqual({
      ativas: "Invalid input: expected boolean, received string",
    });
  });
});

// ── GET /disciplinas/cobertura (C3) ──────────────────────────────────────────

describe("CoberturaQuerySchema — C3, todo recorte explícito", () => {
  it("sem parâmetro nenhum: só o default incluirInativas: false", () => {
    // Nenhum `de`/`ate` escondido — é exatamente o defeito do sistema de origem
    // (`initial_date > '2019-03-08'` literal em 5 consultas). Sem janela, a
    // operação sem período ENTRA na contagem.
    const r = CoberturaQuerySchema.safeParse({});
    expect(r.success && r.data).toEqual({ incluirInativas: false });
  });

  it("aceita a janela completa e ecoa o que foi pedido", () => {
    const r = CoberturaQuerySchema.safeParse({
      cliente: "petro",
      de: "2018-01-01",
      ate: "2024-12-31",
      incluirInativas: true,
    });
    expect(r.success && r.data).toEqual({
      cliente: "petro",
      de: "2018-01-01",
      ate: "2024-12-31",
      incluirInativas: true,
    });
  });

  it("data inválida no CALENDÁRIO, não só na regex: 2020-13-01 cai", () => {
    // Passa em `/^\d{4}-\d{2}-\d{2}$/` e o Postgres recusaria com 22008 — isto
    // é, um 500 no lugar de um 422. É `ehDataIso` que segura.
    expect(erros(CoberturaQuerySchema, { de: "2020-13-01" })).toEqual({
      de: "Data no formato AAAA-MM-DD",
    });
  });

  it("31 de fevereiro também cai (a prova de que é calendário)", () => {
    expect(erros(CoberturaQuerySchema, { de: "2019-02-31" })).toEqual({
      de: "Data no formato AAAA-MM-DD",
    });
    expect(erros(CoberturaQuerySchema, { ate: "2019-02-31" })).toEqual({
      ate: "Data no formato AAAA-MM-DD",
    });
  });

  it("formato sem zero à esquerda não passa", () => {
    expect(erros(CoberturaQuerySchema, { de: "2020-1-1" })).toEqual({
      de: "Data no formato AAAA-MM-DD",
    });
  });

  it("janela invertida reclama no campo `ate`", () => {
    // O path é `ate` porque é o segundo campo do par: a tela marca o input que
    // a pessoa acabou de mexer, não o de cima.
    expect(erros(CoberturaQuerySchema, { de: "2024-01-01", ate: "2020-01-01" })).toEqual({
      ate: "Data inicial maior que a final",
    });
  });

  it("de igual a ate é janela de um dia, e passa", () => {
    const r = CoberturaQuerySchema.safeParse({ de: "2020-01-01", ate: "2020-01-01" });
    expect(r.success && r.data).toEqual({
      de: "2020-01-01",
      ate: "2020-01-01",
      incluirInativas: false,
    });
  });

  it("só `de` (ou só `ate`) é janela aberta de um lado, e passa", () => {
    expect(CoberturaQuerySchema.safeParse({ de: "2020-01-01" }).success).toBe(true);
    expect(CoberturaQuerySchema.safeParse({ ate: "2020-01-01" }).success).toBe(true);
  });

  it("cliente com 201 caracteres cai; 200 passa", () => {
    expect(erros(CoberturaQuerySchema, { cliente: "x".repeat(201) })).toEqual({
      cliente: "Cliente muito longo",
    });
    expect(CoberturaQuerySchema.safeParse({ cliente: "x".repeat(200) }).success).toBe(true);
  });

  it("cliente é aparado antes de medir — e só-espaço não é filtro", () => {
    const r = CoberturaQuerySchema.safeParse({ cliente: "  petro  " });
    expect(r.success && r.data.cliente).toBe("petro");
    expect(erros(CoberturaQuerySchema, { cliente: "   " })).toEqual({
      cliente: "Too small: expected string to have >=1 characters",
    });
  });

  it("não existe filtro por id de disciplina aqui: a cobertura é do catálogo inteiro", () => {
    // A resposta traz UMA LINHA POR DISCIPLINA, inclusive as com zero obra
    // ("não temos nada provado em Telecom"). Um `disciplinaId` no recorte
    // esconderia justamente a linha que interessa.
    const r = CoberturaQuerySchema.safeParse({ disciplinaId: UUID3 });
    expect(r.success && r.data).toEqual({ incluirInativas: false });
  });
});
