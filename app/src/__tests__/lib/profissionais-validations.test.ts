/**
 * Schemas de profissionais, vínculos e atividades de ART (migration 0043).
 *
 * Como em operacoes-validations: estes testes travam
 * as MENSAGENS, não só o aceita/rejeita — o `detalhes` do 422 é renderizado campo
 * a campo no formulário de profissional e no modal de atividade, então mudar uma
 * vírgula aqui é mudar o que o usuário lê.
 *
 * Dois guardas que não são sobre forma, e por isso estão escritos com nome próprio:
 *
 * 1. **Nenhum schema deste arquivo tem `cpf`** (spec §1d / LGPD).
 *    `lib/seguranca/pii.ts` redige CPF do `ocrTexto` antes de gravar e o BFF
 *    espelha; guardar CPF do profissional contrariaria a política do próprio
 *    módulo. O teste prova o comportamento observável: mandar `cpf` no body não
 *    derruba a requisição, mas o campo **não chega** ao `data` — o `z.object()`
 *    faz strip, e não existe coluna para ele cair.
 * 2. **`quantidadeTexto` é STRING** (§1c). É a evidência literal da ART
 *    ("3.600,00 HH"), exibida como texto e nunca somada. Trocar por
 *    `z.coerce.number()` derruba o caso abaixo de propósito.
 *
 * O que NÃO está aqui: a existência do profissional, a colisão de CREA
 * (`uniq_profissional_crea`) e a visibilidade do documento restrito — nenhuma
 * delas cabe num schema sem banco; são `getProfissionalPorCrea`,
 * `paraRestritoInvisivel` e `restricaoVisivel` nas rotas (§5.4-§5.7).
 */

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  CriarAtividadeSchema,
  CriarProfissionalSchema,
  CurriculoQuerySchema,
  EditarProfissionalSchema,
  FiltrosProfissionalSchema,
  PAPEIS_PROFISSIONAL,
  PAPEL_PROFISSIONAL_LABELS,
  VincularProfissionalSchema,
} from "@/lib/conformidade/profissionais/validations";
import { formatZodErrors } from "@/lib/conformidade/operacoes/validations";

/** Mesmo caminho do handler: safeParse → formatZodErrors → `detalhes`. */
function erros(schema: ZodType, input: unknown): Record<string, string> {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("esperava falha de validação");
  return formatZodErrors(r.error);
}

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID2 = "9b2b7a3e-0c1d-4e5f-8a6b-7c8d9e0f1a2b";
const PAPEL_INVALIDO = 'Invalid option: expected one of "RT"|"CORRESPONSAVEL"|"EQUIPE"';

// ── LGPD: a prova executável de §1d ──────────────────────────────────────────

describe("SEM CPF em nenhum schema de profissional (§1d / LGPD)", () => {
  it("CriarProfissionalSchema: `data` sai sem `cpf`", () => {
    const r = CriarProfissionalSchema.safeParse({ nome: "João", cpf: "000.000.000-00" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ nome: "João" });
    expect(r.success && "cpf" in r.data).toBe(false);
  });

  it("EditarProfissionalSchema: `data` sai sem `cpf`", () => {
    const r = EditarProfissionalSchema.safeParse({ ativo: true, cpf: "000.000.000-00" });
    expect(r.success && r.data).toEqual({ ativo: true });
  });

  it("nenhum dos seis schemas conhece a chave `cpf`", () => {
    // Varredura: se alguém acrescentar `cpf` a qualquer um deles, este caso cai
    // antes de o campo chegar ao banco, ao XLSX ou ao PDF do currículo.
    const casos: Array<[string, ZodType, Record<string, unknown>]> = [
      ["CriarProfissionalSchema", CriarProfissionalSchema, { nome: "João Silva" }],
      ["EditarProfissionalSchema", EditarProfissionalSchema, {}],
      ["FiltrosProfissionalSchema", FiltrosProfissionalSchema, {}],
      ["VincularProfissionalSchema", VincularProfissionalSchema, { profissionalId: UUID }],
      ["CriarAtividadeSchema", CriarAtividadeSchema, { atividade: "Montagem de tubulação" }],
      ["CurriculoQuerySchema", CurriculoQuerySchema, { profissionalId: UUID }],
    ];
    for (const [nome, schema, base] of casos) {
      const r = schema.safeParse({ ...base, cpf: "000.000.000-00" });
      expect(r.success, nome).toBe(true);
      expect(Object.keys((r as { data: object }).data), nome).not.toContain("cpf");
    }
  });
});

// ── POST /profissionais ──────────────────────────────────────────────────────

describe("CriarProfissionalSchema — cadastro", () => {
  it("só o nome é obrigatório; CREA, UF e formação são opcionais", () => {
    const r = CriarProfissionalSchema.safeParse({ nome: "Joao Silva" });
    expect(r.success && r.data).toEqual({ nome: "Joao Silva" });
    expect(erros(CriarProfissionalSchema, {})).toEqual({
      nome: "Invalid input: expected string, received undefined",
    });
  });

  it("nome de uma letra: 'Nome muito curto'", () => {
    expect(erros(CriarProfissionalSchema, { nome: "A" })).toEqual({ nome: "Nome muito curto" });
  });

  it("nome só com espaço cai pelo mesmo mínimo (trim antes de medir)", () => {
    // É o `chk_prof_nome` do banco, antecipado para o campo: sem isto, o INSERT
    // estouraria e a tela receberia 500 em vez de 422.
    expect(erros(CriarProfissionalSchema, { nome: "   " })).toEqual({ nome: "Nome muito curto" });
  });

  it("nome com 201 caracteres: 'Nome muito longo'", () => {
    expect(erros(CriarProfissionalSchema, { nome: "x".repeat(201) })).toEqual({
      nome: "Nome muito longo",
    });
  });

  it("crea de dois caracteres: 'Registro muito curto'", () => {
    // min(3) e não min(1): string de um ou dois caracteres é resto de digitação,
    // e string VAZIA é o que o `chk_prof_crea` recusa (dois "sem registro" não
    // podem colidir no índice único parcial).
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", crea: "12" })).toEqual({
      crea: "Registro muito curto",
    });
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", crea: "" })).toEqual({
      crea: "Registro muito curto",
    });
  });

  it("crea com 51 caracteres: 'Registro muito longo'", () => {
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", crea: "x".repeat(51) })).toEqual({
      crea: "Registro muito longo",
    });
  });

  it("creaUf minúscula: 'UF com duas letras maiúsculas' (o mesmo CHECK do banco)", () => {
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", creaUf: "ba" })).toEqual({
      creaUf: "UF com duas letras maiúsculas",
    });
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", creaUf: "BAH" })).toEqual({
      creaUf: "UF com duas letras maiúsculas",
    });
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", creaUf: "B1" })).toEqual({
      creaUf: "UF com duas letras maiúsculas",
    });
  });

  it("formação com 201 caracteres: 'Formação muito longa'", () => {
    expect(erros(CriarProfissionalSchema, { nome: "Joao Silva", formacao: "x".repeat(201) })).toEqual({
      formacao: "Formação muito longa",
    });
  });

  it("apara os quatro campos e aceita null explícito nos três opcionais", () => {
    const cheio = CriarProfissionalSchema.safeParse({
      nome: "  Joao A. Silva  ",
      crea: " 0101234567 ",
      creaUf: "BA",
      formacao: "  Engenheiro Mecânico  ",
    });
    expect(cheio.success && cheio.data).toEqual({
      nome: "Joao A. Silva",
      crea: "0101234567",
      creaUf: "BA",
      formacao: "Engenheiro Mecânico",
    });

    // `null` é "sem registro" e é diferente de ausente: o formulário manda null
    // quando a pessoa apaga o campo.
    const vazio = CriarProfissionalSchema.safeParse({
      nome: "Joao Silva",
      crea: null,
      creaUf: null,
      formacao: null,
    });
    expect(vazio.success && vazio.data).toEqual({
      nome: "Joao Silva",
      crea: null,
      creaUf: null,
      formacao: null,
    });
  });
});

// ── PATCH /profissionais/[id] ────────────────────────────────────────────────

describe("EditarProfissionalSchema — edição", () => {
  it("body vazio passa: PATCH que não muda nada é PATCH válido", () => {
    const r = EditarProfissionalSchema.safeParse({});
    expect(r.success && r.data).toEqual({});
  });

  it("`ativo: false` é o 'excluir' desta entidade — e passa sozinho", () => {
    // Não existe DELETE de profissional: apagar levaria junto os vínculos
    // (CASCADE), isto é, o rastro de quem assinou o quê.
    const r = EditarProfissionalSchema.safeParse({ ativo: false });
    expect(r.success && r.data).toEqual({ ativo: false });
  });

  it("herda as mensagens do cadastro campo a campo", () => {
    expect(erros(EditarProfissionalSchema, { nome: "A" })).toEqual({ nome: "Nome muito curto" });
    expect(erros(EditarProfissionalSchema, { crea: "12" })).toEqual({
      crea: "Registro muito curto",
    });
    expect(erros(EditarProfissionalSchema, { creaUf: "ba" })).toEqual({
      creaUf: "UF com duas letras maiúsculas",
    });
  });

  it("`ativo` não é coerção: a rota manda boolean, nunca a string 'false'", () => {
    expect(erros(EditarProfissionalSchema, { ativo: "false" })).toEqual({
      ativo: "Invalid input: expected boolean, received string",
    });
  });
});

// ── GET /profissionais ───────────────────────────────────────────────────────

describe("FiltrosProfissionalSchema — lista", () => {
  it("sem `ativo` a CHAVE não existe em data (ausente = sem filtro, nunca true)", () => {
    // Q10.3 / D11: histórico é parâmetro explícito, nunca default por papel. Um
    // `.default(true)` aqui esconderia os inativos de quem não pediu.
    const r = FiltrosProfissionalSchema.safeParse({});
    expect(r.success && r.data).toEqual({ limit: 50, offset: 0 });
    expect(r.success && "ativo" in r.data).toBe(false);
    expect(r.success && "comDocumento" in r.data).toBe(false);
    expect(r.success && "busca" in r.data).toBe(false);
  });

  it("`limit` ausente vira 50 e `offset` vira 0", () => {
    const r = FiltrosProfissionalSchema.safeParse({});
    expect(r.success && r.data.limit).toBe(50);
    expect(r.success && r.data.offset).toBe(0);
  });

  it("limit 500 é recusado; 200 é o teto e passa", () => {
    expect(erros(FiltrosProfissionalSchema, { limit: "500" })).toEqual({
      limit: "Too big: expected number to be <=200",
    });
    expect(FiltrosProfissionalSchema.safeParse({ limit: "200" }).success).toBe(true);
  });

  it("limit zero e offset negativo caem", () => {
    expect(erros(FiltrosProfissionalSchema, { limit: "0" })).toEqual({
      limit: "Too small: expected number to be >=1",
    });
    expect(erros(FiltrosProfissionalSchema, { offset: "-1" })).toEqual({
      offset: "Too small: expected number to be >=0",
    });
  });

  it("aceita os três recortes juntos e apara a busca", () => {
    const r = FiltrosProfissionalSchema.safeParse({
      busca: "  silva  ",
      ativo: false,
      comDocumento: true,
      limit: "10",
      offset: "20",
    });
    expect(r.success && r.data).toEqual({
      busca: "silva",
      ativo: false,
      comDocumento: true,
      limit: 10,
      offset: 20,
    });
  });

  it("busca com 201 caracteres: 'Busca muito longa'", () => {
    expect(erros(FiltrosProfissionalSchema, { busca: "x".repeat(201) })).toEqual({
      busca: "Busca muito longa",
    });
  });
});

// ── POST /cofre/documentos/[id]/profissionais ────────────────────────────────

describe("VincularProfissionalSchema — vínculo com o documento", () => {
  it("papel ausente vira 'RT' (o gesto de 9 em cada 10 vínculos)", () => {
    const r = VincularProfissionalSchema.safeParse({ profissionalId: UUID });
    expect(r.success && r.data).toEqual({ profissionalId: UUID, papel: "RT" });
  });

  it("aceita os três papéis da tupla e recusa o resto", () => {
    for (const papel of PAPEIS_PROFISSIONAL) {
      const r = VincularProfissionalSchema.safeParse({ profissionalId: UUID, papel });
      expect(r.success && r.data.papel).toBe(papel);
    }
    expect(erros(VincularProfissionalSchema, { profissionalId: UUID, papel: "CHEFE" })).toEqual({
      papel: PAPEL_INVALIDO,
    });
  });

  it("papel em minúscula não vale: o CHECK do banco é sensível a caixa", () => {
    expect(erros(VincularProfissionalSchema, { profissionalId: UUID, papel: "rt" })).toEqual({
      papel: PAPEL_INVALIDO,
    });
  });

  it("profissionalId não-uuid: 'ID inválido'", () => {
    expect(erros(VincularProfissionalSchema, { profissionalId: "90008" })).toEqual({
      profissionalId: "ID inválido",
    });
    expect(erros(VincularProfissionalSchema, {})).toEqual({
      profissionalId: "Invalid input: expected string, received undefined",
    });
  });

  it("numeroArt mora no VÍNCULO, é aparado e aceita null", () => {
    // Dois corresponsáveis do mesmo atestado têm números de ART diferentes — por
    // isso o número é do PAR, não do documento.
    const r = VincularProfissionalSchema.safeParse({
      profissionalId: UUID2,
      papel: "CORRESPONSAVEL",
      numeroArt: "  BA20240000001  ",
    });
    expect(r.success && r.data).toEqual({
      profissionalId: UUID2,
      papel: "CORRESPONSAVEL",
      numeroArt: "BA20240000001",
    });
    expect(
      VincularProfissionalSchema.safeParse({ profissionalId: UUID, numeroArt: null }).success,
    ).toBe(true);
    expect(
      erros(VincularProfissionalSchema, { profissionalId: UUID, numeroArt: "x".repeat(51) }),
    ).toEqual({ numeroArt: "Número de ART muito longo" });
  });
});

// ── POST /cofre/documentos/[id]/atividades ───────────────────────────────────

describe("CriarAtividadeSchema — atividade da ART", () => {
  it("quantidadeTexto '3.600,00 HH' passa E CONTINUA STRING em data (§1c)", () => {
    // Se alguém trocar por `z.coerce.number()`, este caso cai. A quantidade da
    // ART é evidência literal, exibida como texto e nunca somada.
    const r = CriarAtividadeSchema.safeParse({
      atividade: "Montagem de tubulação",
      quantidadeTexto: "3.600,00 HH",
    });
    expect(r.success && r.data.quantidadeTexto).toBe("3.600,00 HH");
    expect(r.success && typeof r.data.quantidadeTexto).toBe("string");
  });

  it("quantidade com unidade por extenso também é só texto", () => {
    const r = CriarAtividadeSchema.safeParse({
      atividade: "Lançamento de dutos",
      quantidadeTexto: "12.000 m",
    });
    expect(r.success && r.data.quantidadeTexto).toBe("12.000 m");
  });

  it("atividade em branco: 'Descreva a atividade'", () => {
    expect(erros(CriarAtividadeSchema, { atividade: " " })).toEqual({
      atividade: "Descreva a atividade",
    });
    expect(erros(CriarAtividadeSchema, { atividade: "a" })).toEqual({
      atividade: "Descreva a atividade",
    });
  });

  it("atividade com 501 caracteres: 'Atividade muito longa'", () => {
    expect(erros(CriarAtividadeSchema, { atividade: "x".repeat(501) })).toEqual({
      atividade: "Atividade muito longa",
    });
  });

  it("quantidadeTexto com 101 caracteres: 'Quantidade muito longa'", () => {
    expect(
      erros(CriarAtividadeSchema, { atividade: "Montagem", quantidadeTexto: "x".repeat(101) }),
    ).toEqual({ quantidadeTexto: "Quantidade muito longa" });
  });

  it("ordem é opcional: ausente, quem calcula max(ordem)+1 é o banco", () => {
    // Cálculo no cliente faria duas abas abertas gerarem a mesma ordem.
    const semOrdem = CriarAtividadeSchema.safeParse({ atividade: "Montagem" });
    expect(semOrdem.success && "ordem" in semOrdem.data).toBe(false);

    const comOrdem = CriarAtividadeSchema.safeParse({ atividade: "Montagem", ordem: "7" });
    expect(comOrdem.success && comOrdem.data.ordem).toBe(7);
    expect(erros(CriarAtividadeSchema, { atividade: "Montagem", ordem: "1000" })).toEqual({
      ordem: "Too big: expected number to be <=999",
    });
  });

  it("não tem `quantidade` numérica nem `unidadeId` — e um body com eles não os grava", () => {
    // §1c, fechado: a tabela `documento_atividades` não tem as duas colunas. Se
    // elas voltarem ao schema, este caso cai.
    const r = CriarAtividadeSchema.safeParse({
      atividade: "Montagem de tubulação",
      quantidade: 3600,
      unidadeId: UUID,
    });
    expect(r.success && r.data).toEqual({ atividade: "Montagem de tubulação" });
  });
});

// ── Parâmetro do relatório C1 ────────────────────────────────────────────────

describe("CurriculoQuerySchema — o único parâmetro do currículo do RT", () => {
  it("aceita o uuid e recusa ausente e malformado", () => {
    const r = CurriculoQuerySchema.safeParse({ profissionalId: UUID });
    expect(r.success && r.data).toEqual({ profissionalId: UUID });
    expect(erros(CurriculoQuerySchema, {})).toEqual({
      profissionalId: "Invalid input: expected string, received undefined",
    });
    expect(erros(CurriculoQuerySchema, { profissionalId: "abc" })).toEqual({
      profissionalId: "ID inválido",
    });
  });

  it("não tem período: o recorte do relatório é a PESSOA, não a janela", () => {
    const r = CurriculoQuerySchema.safeParse({ profissionalId: UUID, periodoMeses: 12 });
    expect(r.success && r.data).toEqual({ profissionalId: UUID });
  });
});

// ── Tupla e rótulos ──────────────────────────────────────────────────────────

describe("PAPEIS_PROFISSIONAL e os rótulos de tela", () => {
  it("três papéis, com RT primeiro (é a ordem de exibição e do CASE da query)", () => {
    expect(PAPEIS_PROFISSIONAL).toEqual(["RT", "CORRESPONSAVEL", "EQUIPE"]);
  });

  it("todo papel tem rótulo em pt-BR, e nenhum rótulo sobra", () => {
    // O relatório C1 e os blocos da página do documento escrevem o RÓTULO, não o
    // enum cru: um papel sem entrada aqui apareceria como "CORRESPONSAVEL".
    expect(Object.keys(PAPEL_PROFISSIONAL_LABELS).sort()).toEqual([...PAPEIS_PROFISSIONAL].sort());
    expect(PAPEL_PROFISSIONAL_LABELS.RT).toBe("Responsável técnico");
    expect(PAPEL_PROFISSIONAL_LABELS.CORRESPONSAVEL).toBe("Corresponsável");
    expect(PAPEL_PROFISSIONAL_LABELS.EQUIPE).toBe("Equipe técnica");
  });

  it("não existe papel 'CHEFE' — a tupla é o espelho do chk_profdoc_papel", () => {
    expect(PAPEIS_PROFISSIONAL).not.toContain("CHEFE");
  });
});
