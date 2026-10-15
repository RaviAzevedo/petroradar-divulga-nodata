import { describe, expect, it } from "vitest";
import { sanitizarWebsearch } from "@/lib/acervo/retrieval";

/**
 * Contrato desta função: neutralizar a SINTAXE de operador do
 * `websearch_to_tsquery` sem tocar no CONTEÚDO.
 *
 * Todos os casos abaixo foram conferidos contra o parser real do PostgreSQL
 * 16 — o valor esperado é o que o Postgres precisa receber para
 * NÃO montar operador, não uma opinião sobre estética de string.
 *
 * O espelho em Python é `_sanitizar_websearch` em
 * bff/app/routers/migrated/acervo_buscar.py. Divergir aqui e lá significa a
 * mesma busca dar resultados diferentes conforme o backend que atende — que é
 * exatamente o modo de falha que o estrangulador já produziu antes.
 */
describe("sanitizarWebsearch", () => {
  describe("neutraliza operador que texto colado dispara sem querer", () => {
    it("mata a negação do hífen solto — o bug que zerava o braço estrito", () => {
      // "- REFX" virava !'refx': a busca EXCLUÍA a refinaria procurada.
      expect(sanitizarWebsearch("Refinaria Exemplo Norte - REFX - SP"))
        .toBe("Refinaria Exemplo Norte REFX SP");
    });

    it("trata travessão Unicode, não só o hífen ASCII", () => {
      // f_unaccent roda DEPOIS, no SQL, e converte 15 codepoints para "-".
      // Pergunta colada de documento costuma trazer U+2014 junto do identificador.
      expect(sanitizarWebsearch("Contrato 4600001234 — que documentos temos?"))
        .toBe("Contrato 4600001234 que documentos temos?");
      expect(sanitizarWebsearch("Refinaria – REFX")).toBe("Refinaria REFX");
      expect(sanitizarWebsearch("traço ― longo")).toBe("traço longo");
    });

    it("remove aspas, inclusive tipográficas e ímpares", () => {
      // Aspa ÍMPAR faz busca de FRASE até o fim da string.
      expect(sanitizarWebsearch("“abertura curva ímpar")).toBe("abertura curva ímpar");
      expect(sanitizarWebsearch('aspa " solta')).toBe("aspa solta");
    });

    it("remove o token 'or', que o parser lê como OR", () => {
      expect(sanitizarWebsearch("alfa or beta")).toBe("alfa beta");
      expect(sanitizarWebsearch("or")).toBe("");
    });
  });

  describe("NÃO cria operador que não existia", () => {
    // Remover o "or" DEPOIS do hífen descolaria um hífen já preservado e
    // transformaria "alfa or-beta" em "alfa -beta" = 'alfa' & !'bet'.
    // Por isso a ordem é ASPAS -> OR -> HÍFEN.
    it.each([
      ["alfa or-beta", "alfa or-beta"],
      ["OR-2024", "OR-2024"],
      ["2024-or-2025", "2024-or-2025"],
    ])("preserva %s", (entrada, esperado) => {
      expect(sanitizarWebsearch(entrada)).toBe(esperado);
    });
  });

  describe("preserva identificador, que é o caso de uso mais afiado", () => {
    // O hífen COLADO à esquerda fica DENTRO do lexema: "PJ-1230006" indexa como
    // 'pj' + '-1230006'. Trocá-lo por espaço geraria '1230006', que não casa.
    it.each([
      "contrato PJ-1230006",
      "reator U-32 e R-301",
      "CNPJ 11.222.333/0001-81",
      "1234.0001111.17.2",
      "90001/90002",
      "pré-operação anti-corrosivo",
      "ORCAMENTO",
      "alfa/or beta",
    ])("mantém %s intacto", (entrada) => {
      expect(sanitizarWebsearch(entrada)).toBe(entrada);
    });
  });

  describe("entrada degenerada não explode", () => {
    it.each([
      ["", ""],
      ["   ", ""],
      ["- - - -", ""],
      ['"', ""],
      ["﻿REFX teste", "REFX teste"],
      ["muito   espaço", "muito espaço"],
    ])("%s -> %s", (entrada, esperado) => {
      expect(sanitizarWebsearch(entrada)).toBe(esperado);
    });

    it("aceita nulo e indefinido sem lançar", () => {
      expect(sanitizarWebsearch(undefined as unknown as string)).toBe("");
      expect(sanitizarWebsearch(null as unknown as string)).toBe("");
    });
  });
});
