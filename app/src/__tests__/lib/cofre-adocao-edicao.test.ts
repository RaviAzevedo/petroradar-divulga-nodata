/**
 * Fluxos de correção do cofre — a parte pura.
 *
 * Trava as frases de resumo da adoção em lote (são
 * contrato com o usuário, não sugestão) e o diff do PATCH do editor estendido
 * (R8: mandar campo intacto sujaria o audit de antes/depois).
 */

import { describe, it, expect } from "vitest";
import {
  fatiarIds,
  resumoVinculacao,
  LIMITE_IDS_POR_CHAMADA,
} from "@/app/acervo/cofre/vincular-operacao";
import {
  formularioInicial,
  montarPatchDocumento,
  tipoESubcategoriaDivergem,
  type DocumentoEditavel,
} from "@/app/acervo/cofre/editar-documento-form";

const UUID_OP = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_OP2 = "aa2504e0-4f89-11d3-9a0c-0305e82c3302";
const UUID_DISC = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const UUID_DISC2 = "b1a7e6c4-2f3d-4a5b-8c9d-0e1f2a3b4c5d";

describe("fatiarIds — blocos de até 200 para R11", () => {
  it("lote vazio não gera bloco nenhum", () => {
    expect(fatiarIds([])).toEqual([]);
  });

  it("até o teto vai numa chamada só", () => {
    const ids = Array.from({ length: LIMITE_IDS_POR_CHAMADA }, (_, i) => `id${i}`);
    expect(fatiarIds(ids)).toHaveLength(1);
  });

  it("acima do teto fatia preservando ordem e sem perder id", () => {
    const ids = Array.from({ length: 401 }, (_, i) => `id${i}`);
    const blocos = fatiarIds(ids);
    expect(blocos.map((b) => b.length)).toEqual([200, 200, 1]);
    expect(blocos.flat()).toEqual(ids);
  });

  it("tamanho inválido explode em vez de laço infinito", () => {
    expect(() => fatiarIds(["a"], 0)).toThrow();
  });
});

describe("resumoVinculacao — frases exatas do modal (§6.3-4)", () => {
  it("sem pulados: singular e plural com ponto final", () => {
    expect(resumoVinculacao(3, [])).toBe("3 vinculadas.");
    expect(resumoVinculacao(1, [])).toBe("1 vinculada.");
  });

  it("exemplo do plano: 218 vinculadas · 3 puladas (2 já vinculadas, 1 restrita)", () => {
    expect(
      resumoVinculacao(218, [
        { id: "a", motivo: "JA_VINCULADO" },
        { id: "b", motivo: "JA_VINCULADO" },
        { id: "c", motivo: "RESTRITO" },
      ])
    ).toBe("218 vinculadas · 3 puladas (2 já vinculadas, 1 restrita)");
  });

  it("motivos na ordem fixa e NAO_ENCONTRADO traduzido", () => {
    expect(
      resumoVinculacao(0, [
        { id: "a", motivo: "NAO_ENCONTRADO" },
        { id: "b", motivo: "JA_VINCULADO" },
      ])
    ).toBe("0 vinculadas · 2 puladas (1 já vinculada, 1 não encontrada)");
  });

  it("motivo desconhecido não some da contagem", () => {
    expect(resumoVinculacao(1, [{ id: "a", motivo: "MOTIVO_NOVO" }])).toBe(
      "1 vinculada · 1 pulada (1 motivo novo)"
    );
  });
});

// ── Diff do PATCH (editor estendido, R8) ─────────────────────────────────────

/** Documento de base: órfão, sem tipo, sem restrição. */
function docBase(sobrescreve: Partial<DocumentoEditavel> = {}): DocumentoEditavel {
  return {
    titulo: "ART BA20240000001",
    descricao: null,
    categoria: "QUALIFICACAO_PESSOAL",
    subcategoria: "ART_CAT",
    numeroDocumento: "BA20240000001",
    status: "VIGENTE",
    emitidoEm: "2024-08-14T00:00:00.000Z",
    validadeFim: null,
    validadeIndeterminada: false,
    tags: ["art"],
    operacaoId: null,
    papel: null,
    tipoDocumento: null,
    situacaoProva: null,
    detentora: null,
    restrito: false,
    ...sobrescreve,
  };
}

describe("montarPatchDocumento — PATCH manda só o que mudou", () => {
  it("formulário intacto → body vazio (nenhum PATCH, nenhum audit)", () => {
    const doc = docBase();
    expect(montarPatchDocumento(doc, formularioInicial(doc))).toEqual({});
  });

  it("adoção unitária: vincular órfão manda só operacaoId (e papel quando escolhido)", () => {
    const doc = docBase();
    const form = { ...formularioInicial(doc), operacaoId: UUID_OP, papel: "CAT_ART" as const };
    expect(montarPatchDocumento(doc, form)).toEqual({
      operacaoId: UUID_OP,
      papel: "CAT_ART",
    });
  });

  it("desvincular com 'Limpar também o papel' manda {operacaoId: null, papel: null} num PATCH só", () => {
    const doc = docBase({ operacaoId: UUID_OP, papel: "CAT_ART" });
    const form = {
      ...formularioInicial(doc),
      operacaoId: null,
      limparPapelAoDesvincular: true,
    };
    expect(montarPatchDocumento(doc, form)).toEqual({ operacaoId: null, papel: null });
  });

  it("desvincular SEM limpar papel não toca em papel (regra de R8)", () => {
    const doc = docBase({ operacaoId: UUID_OP, papel: "CAT_ART" });
    const form = {
      ...formularioInicial(doc),
      operacaoId: null,
      limparPapelAoDesvincular: false,
    };
    expect(montarPatchDocumento(doc, form)).toEqual({ operacaoId: null });
  });

  it("trocar vínculo manda o novo uuid sem mexer no resto", () => {
    const doc = docBase({ operacaoId: UUID_OP, papel: "CAT_ART" });
    const form = { ...formularioInicial(doc), operacaoId: UUID_OP2 };
    expect(montarPatchDocumento(doc, form)).toEqual({ operacaoId: UUID_OP2 });
  });

  it("campos do dossiê: '' limpa (null), valor troca, intacto não entra", () => {
    const doc = docBase({ tipoDocumento: "ART", situacaoProva: "RASCUNHO", detentora: "COLIGADA" });
    const form = {
      ...formularioInicial(doc),
      tipoDocumento: "" as const,
      situacaoProva: "ASSINADA_CLIENTE" as const,
    };
    expect(montarPatchDocumento(doc, form)).toEqual({
      tipoDocumento: null,
      situacaoProva: "ASSINADA_CLIENTE",
    });
  });

  it("restrito só entra quando alterado (o 403 de campo é para quem mexeu)", () => {
    const doc = docBase();
    const form = { ...formularioInicial(doc), restrito: true };
    expect(montarPatchDocumento(doc, form)).toEqual({ restrito: true });
  });

  it("validade indeterminada zera a data no mesmo body", () => {
    const doc = docBase({ validadeFim: "2027-01-31T00:00:00.000Z" });
    const form = { ...formularioInicial(doc), validadeIndeterminada: true };
    expect(montarPatchDocumento(doc, form)).toEqual({
      validadeFim: null,
      validadeIndeterminada: true,
    });
  });

  it("tags: mesma lista em outra grafia de texto não gera PATCH", () => {
    const doc = docBase({ tags: ["art", "acervo"] });
    const form = { ...formularioInicial(doc), tagsTexto: " art ,  acervo " };
    expect(montarPatchDocumento(doc, form)).toEqual({});
  });

  // ── Disciplina do documento (0043, onda 4) ─────────────────────────────────
  // `docBase` NÃO preenche `disciplinaId`: o campo entrou OPCIONAL em
  // `DocumentoEditavel` justamente para a fixture compilar sem alteração
  // (spec ONDA-4 §1f). O diff compara com `?? null`, então documento antigo
  // (sem a chave) e `<select>` vazio são a mesma coisa: nada mudou.

  it("escolher disciplina manda só disciplinaId — e trocar por outra também", () => {
    // Sem este caso, "trocar a disciplina" ficaria sem prova de que entra no
    // PATCH; e mandar campo intacto junto sujaria o {antes, depois} do audit.
    const semDisciplina = docBase();
    const marcou = { ...formularioInicial(semDisciplina), disciplinaId: UUID_DISC };
    expect(montarPatchDocumento(semDisciplina, marcou)).toEqual({ disciplinaId: UUID_DISC });

    const comDisciplina = docBase({ disciplinaId: UUID_DISC });
    const trocou = { ...formularioInicial(comDisciplina), disciplinaId: UUID_DISC2 };
    expect(montarPatchDocumento(comDisciplina, trocou)).toEqual({ disciplinaId: UUID_DISC2 });
  });

  it("limpar a disciplina manda {disciplinaId: null}; sem disciplina e select vazio não geram PATCH", () => {
    const doc = docBase({ disciplinaId: UUID_DISC });
    const limpou = { ...formularioInicial(doc), disciplinaId: "" };
    expect(montarPatchDocumento(doc, limpou)).toEqual({ disciplinaId: null });

    // "" no `<select>` de um documento que já não tinha disciplina é o estado
    // inicial, não uma limpeza: um `disciplinaId: null` aqui viraria audit de
    // uma mudança que não houve.
    const nunca = docBase();
    expect(montarPatchDocumento(nunca, formularioInicial(nunca))).toEqual({});

    // A mesma disciplina escolhida de novo também não é mudança.
    const igual = { ...formularioInicial(doc), disciplinaId: UUID_DISC };
    expect(montarPatchDocumento(doc, igual)).toEqual({});
  });

  // ── Revisão de engenharia (0044, B6 — spec ONDA-5 §1h / §8.13) ────────────
  // `docBase` NÃO preenche `revisao`: o campo entrou OPCIONAL em
  // `DocumentoEditavel` justamente para esta fixture compilar sem uma linha de
  // alteração (spec ONDA-5 §1i) — e é isso que mantém a `GavetaDocumento.tsx`,
  // arquivo PROIBIDO nesta onda (§6.4), funcionando sem ser tocada. Se este
  // bloco tivesse exigido acrescentar `revisao` ao `docBase`, o campo teria
  // nascido obrigatório e a gaveta estaria quebrada.
  //
  // ⚠️ `revisao` NÃO é `versao`: aquela é o versionamento de certidão do cofre
  // (v2 substitui v1, cadeia navegável); esta é o carimbo da engenharia ("R0",
  // "02A", "Rev. C"), texto livre que não ordena e não substitui nada.

  it("trocar a revisão manda `{ revisao }` e só isso", () => {
    // Campo sem caso é campo que não entra no PATCH e ninguém percebe: o modal
    // salvaria "R1" e o documento continuaria sem revisão, calado.
    const semRevisao = docBase();
    const carimbou = { ...formularioInicial(semRevisao), revisao: "R1" };
    expect(montarPatchDocumento(semRevisao, carimbou)).toEqual({ revisao: "R1" });

    const comRevisao = docBase({ revisao: "R0" });
    const trocou = { ...formularioInicial(comRevisao), revisao: "R1" };
    expect(montarPatchDocumento(comRevisao, trocou)).toEqual({ revisao: "R1" });

    // Espaço em volta não é revisão nova — o `.trim()` é o mesmo do zod (max 20).
    const mesmaComEspaco = { ...formularioInicial(comRevisao), revisao: "  R0  " };
    expect(montarPatchDocumento(comRevisao, mesmaComEspaco)).toEqual({});
  });

  it("limpar a revisão manda `{ revisao: null }`; formulário intacto continua devolvendo `{}`", () => {
    const doc = docBase({ revisao: "R1" });
    const limpou = { ...formularioInicial(doc), revisao: "" };
    expect(montarPatchDocumento(doc, limpou)).toEqual({ revisao: null });

    // "" num documento que já não tinha revisão é o estado inicial, não uma
    // limpeza: um `revisao: null` aqui viraria audit de uma mudança que não
    // houve — a mesma regra da disciplina, logo acima.
    const nunca = docBase();
    expect(montarPatchDocumento(nunca, formularioInicial(nunca))).toEqual({});

    // E o documento COM revisão, sem ninguém mexer, também não gera PATCH.
    expect(montarPatchDocumento(doc, formularioInicial(doc))).toEqual({});
  });
});

describe("tipoESubcategoriaDivergem — aviso informativo do editor (§8.3-3)", () => {
  it("par canônico não diverge; par trocado diverge", () => {
    expect(tipoESubcategoriaDivergem("ART", "ART_CAT")).toBe(false);
    expect(tipoESubcategoriaDivergem("ART", "OUTRO")).toBe(true);
  });

  it("exceção ISO: qualquer ISO_9001/14001/45001 é canônica", () => {
    expect(tipoESubcategoriaDivergem("ISO", "ISO_14001")).toBe(false);
    expect(tipoESubcategoriaDivergem("ISO", "ISO_45001")).toBe(false);
    expect(tipoESubcategoriaDivergem("ISO", "OUTRO")).toBe(true);
  });

  it("sem tipo escolhido nunca diverge", () => {
    expect(tipoESubcategoriaDivergem("", "OUTRO")).toBe(false);
  });
});
