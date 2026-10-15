import { describe, expect, it } from "vitest";
import { cpfValido, redigirPii } from "@/lib/seguranca/pii";

/**
 * O teste que importa aqui não é "redige CPF" — é "NÃO redige o que não é CPF".
 * A versão anterior deste redator destruía número de ART do CREA
 * (`BA20230012345` → `BA[CPF-REMOVIDO]`), e ART é o tipo mais numeroso do
 * acervo. Perder esse número é perder a busca por identificador.
 */
describe("redigirPii", () => {
  describe("NÃO destrói identificador do acervo", () => {
    it.each([
      "ART BA20230012345 SUBSTITUICAO ART20190012345",
      "CREA-BA ART OBRA/SERVICO No BA20200012345 INICIAL",
      "ART BA20190054321 vinculada",
      "contrato 4600001234 de 2015",
      "CNPJ 11.222.333/0001-81",
      "1234.0001111.17.2",
      // 11 dígitos que não fecham como CPF — um acervo de engenharia é feito disto.
      "protocolo 12345678901 do processo",
      "medicao 19870654321 conforme planilha",
    ])("preserva %s", (texto) => {
      expect(redigirPii(texto)).toBe(texto);
    });

    it("o corte é o dígito verificador, não a aparência do número", () => {
      // 98765432100 PARECE sequência arbitrária e É um CPF válido — os DV fecham.
      // Ele é redigido, e está certo. O oposto também vale: 19870654321 parece
      // uma data colada num número e não fecha, então fica. Aparência não decide;
      // o DV decide. Este caso existe porque eu errei na primeira vez.
      expect(redigirPii("n 98765432100")).toBe("n [CPF-REMOVIDO]");
      expect(redigirPii("n 19870654321")).toBe("n 19870654321");
    });

    it("preserva placeholder de formulário em branco", () => {
      // Os DV de 000.000.000-00 fecham, mas repetido não é CPF de ninguém — e
      // redigir apaga a informação de que o campo estava vazio.
      expect(redigirPii("campo 000.000.000-00 nao preenchido"))
        .toBe("campo 000.000.000-00 nao preenchido");
    });
  });

  describe("redige o que é PII de verdade", () => {
    it("CPF formatado válido", () => {
      expect(redigirPii("CPF 529.982.247-25 do responsavel"))
        .toBe("CPF [CPF-REMOVIDO] do responsavel");
    });

    it("CPF sem pontuação, com fronteira", () => {
      expect(redigirPii("CPF 52998224725 sem pontuacao"))
        .toBe("CPF [CPF-REMOVIDO] sem pontuacao");
    });

    it("e-mail", () => {
      expect(redigirPii("contato joao.silva@example.com agora"))
        .toBe("contato [EMAIL-REMOVIDO] agora");
    });

    it("vários na mesma linha, preservando o que não é PII", () => {
      expect(redigirPii("ART BA20230012345, CPF 529.982.247-25, a@b.com"))
        .toBe("ART BA20230012345, CPF [CPF-REMOVIDO], [EMAIL-REMOVIDO]");
    });
  });

  describe("contratos da função", () => {
    it("é idempotente — redigir duas vezes dá o mesmo", () => {
      const uma = redigirPii("CPF 529.982.247-25 e a@b.com");
      expect(redigirPii(uma)).toBe(uma);
    });

    it("preserva null e undefined em vez de virar string", () => {
      expect(redigirPii(null)).toBeNull();
      expect(redigirPii(undefined)).toBeUndefined();
      expect(redigirPii("")).toBe("");
    });

    it("não vaza estado entre chamadas (regex /g com lastIndex)", () => {
      // Armadilha clássica: RegExp com /g guarda lastIndex. Com .replace() não
      // acontece, mas o teste trava a garantia caso alguém troque por .test().
      const t = "CPF 529.982.247-25";
      expect(redigirPii(t)).toBe(redigirPii(t));
    });
  });
});

describe("cpfValido", () => {
  it.each(["529.982.247-25", "52998224725"])("aceita %s", (c) => {
    expect(cpfValido(c)).toBe(true);
  });

  it.each([
    ["12345678901", "DV errado"],
    ["11111111111", "todos iguais"],
    ["00000000000", "todos zero"],
    ["5299822472", "10 dígitos"],
    ["529982247250", "12 dígitos"],
    ["", "vazio"],
  ])("rejeita %s (%s)", (c) => {
    expect(cpfValido(c)).toBe(false);
  });
});
