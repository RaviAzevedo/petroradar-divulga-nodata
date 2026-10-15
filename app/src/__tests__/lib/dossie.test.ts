/**
 * Domínio do dossiê da operação (migration 0034).
 *
 * Trava os 20 valores de `tipo_documento`, as 7 situações de prova e o de-para
 * tipo→seção→nome/slug. Não é teste de "código funciona": é teste de CONTRATO —
 * o CHECK do banco (0034), o dict espelho do BFF (conf_dossie_secoes.py) e a
 * árvore do ZIP dependem destes valores byte a byte; mudar um aqui sem mudar lá
 * é quebrar paridade em produção.
 */

import { describe, it, expect } from "vitest";
import type {
  TipoDocumento as TipoDocumentoDb,
  SituacaoProva as SituacaoProvaDb,
} from "@/db/schema";
import type { TipoDocumento, SituacaoProva } from "@/lib/conformidade/operacoes";
import {
  PAPEIS_DOCUMENTO,
  TIPOS_DOCUMENTO,
  TIPO_DOCUMENTO_LABELS,
  SITUACOES_PROVA,
  SITUACAO_PROVA_LABELS,
  SITUACOES_QUE_CONTAM,
  SECAO_POR_TIPO,
  SECAO_POR_PAPEL,
  SECOES_FICHA,
  secaoDoDocumento,
} from "@/lib/conformidade/operacoes";

describe("TIPOS_DOCUMENTO (0034)", () => {
  it("são exatamente os 20 valores do CHECK, na ordem canônica", () => {
    expect(TIPOS_DOCUMENTO).toEqual([
      "ART", "CAT", "ATESTADO", "CONTRATO", "ADITIVO", "ANEXO_CONTRATO",
      "CREA_PJ", "ISO", "DECLARACAO", "PROPOSTA", "ANEXO_ET", "DOC_PROJETO",
      "PEDIDO", "NF", "CARTA", "RELATORIO", "PESSOAL", "CAPA_OP",
      "COMPACTADO", "OUTRO",
    ]);
  });

  it("espelha o tipo TipoDocumento de schema.ts valor a valor (paridade TS↔TS)", () => {
    // A checagem que vale é de COMPILAÇÃO, nos dois sentidos: se a união de
    // schema.ts e a tupla daqui divergirem em UM valor, o tsc quebra AQUI.
    const tuplaCabeNoSchema: readonly TipoDocumentoDb[] = TIPOS_DOCUMENTO;
    const schemaCabeNaTupla: readonly TipoDocumento[] =
      tuplaCabeNoSchema as readonly TipoDocumentoDb[];
    expect(schemaCabeNaTupla).toHaveLength(20);
  });

  it("todo tipo tem label pt-BR não vazio", () => {
    for (const tipo of TIPOS_DOCUMENTO) {
      expect(TIPO_DOCUMENTO_LABELS[tipo]).toBeTruthy();
    }
    // Spot-checks dos que a tela exibe em lista (mudança aqui é mudança de UI):
    expect(TIPO_DOCUMENTO_LABELS.ATESTADO).toBe("Atestado de capacidade técnica");
    expect(TIPO_DOCUMENTO_LABELS.CREA_PJ).toBe("CREA Pessoa Jurídica");
    expect(TIPO_DOCUMENTO_LABELS.CAPA_OP).toBe("Capa de operação");
  });
});

describe("SITUACOES_PROVA (0034)", () => {
  it("são exatamente as 7 do CHECK", () => {
    expect(SITUACOES_PROVA).toEqual([
      "RASCUNHO", "ASSINADA_PROPONENTE", "ASSINADA_CLIENTE",
      "SUPERADA", "CANCELADA", "MODELO", "INDEFINIDA",
    ]);
  });

  it("espelha o tipo SituacaoProva de schema.ts valor a valor (paridade TS↔TS)", () => {
    const tuplaCabeNoSchema: readonly SituacaoProvaDb[] = SITUACOES_PROVA;
    const schemaCabeNaTupla: readonly SituacaoProva[] =
      tuplaCabeNoSchema as readonly SituacaoProvaDb[];
    expect(schemaCabeNaTupla).toHaveLength(7);
  });

  it("toda situação tem label pt-BR não vazio", () => {
    for (const situacao of SITUACOES_PROVA) {
      expect(SITUACAO_PROVA_LABELS[situacao]).toBeTruthy();
    }
  });

  it("na barra contam só as assinadas e INDEFINIDA (regra §1.2)", () => {
    expect(SITUACOES_QUE_CONTAM).toEqual([
      "ASSINADA_PROPONENTE", "ASSINADA_CLIENTE", "INDEFINIDA",
    ]);
    // O complemento é o que NÃO conta — rascunho/superada/cancelada/modelo.
    const foraDaBarra = SITUACOES_PROVA.filter(
      (s) => !SITUACOES_QUE_CONTAM.includes(s)
    );
    expect(foraDaBarra).toEqual(["RASCUNHO", "SUPERADA", "CANCELADA", "MODELO"]);
  });
});

describe("seções da ficha (derivadas — ADR-02)", () => {
  it("o de-para tipo→seção é o da tabela canônica §1.2", () => {
    expect(SECAO_POR_TIPO).toEqual({
      CONTRATO: 1, ADITIVO: 1, ANEXO_CONTRATO: 1,
      ATESTADO: 2,
      ART: 3, CAT: 3,
      CREA_PJ: 4, ISO: 4, DECLARACAO: 4,
      PROPOSTA: 5,
      ANEXO_ET: 6, DOC_PROJETO: 6,
      PEDIDO: 7, NF: 7, CARTA: 7, RELATORIO: 7, PESSOAL: 7, CAPA_OP: 7,
      COMPACTADO: 8,
      OUTRO: 9,
    });
  });

  it("o fallback papel→seção cobre os 7 papéis da 0033", () => {
    expect(SECAO_POR_PAPEL).toEqual({
      ATESTADO: 2, CAT_ART: 3, CONTRATO: 1, ADITIVO: 1,
      NOTA_FISCAL: 7, DECLARACAO: 4, OUTRO: 9,
    });
  });

  it("as 9 seções têm nome e slug canônicos (tela E árvore do ZIP)", () => {
    expect(SECOES_FICHA).toEqual({
      1: { nome: "Contrato e aditivos",             slug: "1_Contrato_e_aditivos" },
      2: { nome: "Atestados de capacidade técnica", slug: "2_Atestados" },
      3: { nome: "ART e CAT",                       slug: "3_ART_e_CAT" },
      4: { nome: "Habilitação técnica da empresa",  slug: "4_Habilitacao_tecnica" },
      5: { nome: "Proposta e orçamento",            slug: "5_Proposta_e_orcamento" },
      6: { nome: "Anexos técnicos do contrato",     slug: "6_Anexos_tecnicos" },
      7: { nome: "Execução e administrativo",       slug: "7_Execucao_e_administrativo" },
      8: { nome: "A inspecionar",                   slug: "8_A_inspecionar" },
      9: { nome: "Sem tipo definido",               slug: "9_Sem_tipo" },
    });
  });

  it("todo tipo e todo papel apontam para uma seção que existe", () => {
    for (const tipo of TIPOS_DOCUMENTO) {
      expect(SECOES_FICHA[SECAO_POR_TIPO[tipo]]).toBeDefined();
    }
    for (const papel of PAPEIS_DOCUMENTO) {
      expect(SECOES_FICHA[SECAO_POR_PAPEL[papel]]).toBeDefined();
    }
  });
});

describe("secaoDoDocumento", () => {
  it("o tipo manda: com tipo presente, o papel é ignorado", () => {
    // NF na operação com papel ATESTADO: a seção é a do TIPO (7), não a 2.
    expect(secaoDoDocumento("NF", "ATESTADO")).toBe(7);
    expect(secaoDoDocumento("CONTRATO", null)).toBe(1);
  });

  it("sem tipo, cai no papel (os 35 legados pós-backfill 0033)", () => {
    expect(secaoDoDocumento(null, "ATESTADO")).toBe(2);
    expect(secaoDoDocumento(null, "CAT_ART")).toBe(3);
    expect(secaoDoDocumento(null, "NOTA_FISCAL")).toBe(7);
  });

  it("sem tipo e sem papel, seção 9 (fila de trabalho)", () => {
    expect(secaoDoDocumento(null, null)).toBe(9);
  });

  it("OUTRO explícito e NULL caem ambos na 9 — a distinção é de origem, não de seção", () => {
    expect(secaoDoDocumento("OUTRO", "ATESTADO")).toBe(9);
    expect(secaoDoDocumento(null, "OUTRO")).toBe(9);
  });
});
