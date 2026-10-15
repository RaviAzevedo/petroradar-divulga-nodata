import { describe, it, expect } from "vitest";
import { SEGMENTOS, NATUREZAS, FASES_LICITACAO, TIPOS_SERVICO } from "@/lib/constants";

describe("constants", () => {
  describe("SEGMENTOS", () => {
    it("contém 15 segmentos", () => {
      expect(SEGMENTOS).toHaveLength(15);
    });

    it("contém 'Válvulas e Atuadores'", () => {
      expect(SEGMENTOS).toContain("Válvulas e Atuadores");
    });

    it("contém 'Geral / Multidisciplinar' como último", () => {
      expect(SEGMENTOS[SEGMENTOS.length - 1]).toBe("Geral / Multidisciplinar");
    });

    it("não tem duplicatas", () => {
      expect(new Set(SEGMENTOS).size).toBe(SEGMENTOS.length);
    });
  });

  describe("NATUREZAS", () => {
    it("contém 7 naturezas", () => {
      expect(NATUREZAS).toHaveLength(7);
    });

    it("contém SERVIÇO e AQUISIÇÃO", () => {
      expect(NATUREZAS).toContain("SERVIÇO");
      expect(NATUREZAS).toContain("AQUISIÇÃO");
    });
  });

  describe("FASES_LICITACAO", () => {
    it("contém 12 fases", () => {
      expect(FASES_LICITACAO).toHaveLength(12);
    });

    it("começa com 'Recebendo Propostas'", () => {
      expect(FASES_LICITACAO[0]).toBe("Recebendo Propostas");
    });

    it("contém fases terminais", () => {
      expect(FASES_LICITACAO).toContain("Cancelado");
      expect(FASES_LICITACAO).toContain("Concluído");
    });
  });

  describe("TIPOS_SERVICO", () => {
    it("contém 14 tipos de serviço", () => {
      expect(TIPOS_SERVICO).toHaveLength(14);
    });

    it("não tem duplicatas", () => {
      expect(new Set(TIPOS_SERVICO).size).toBe(TIPOS_SERVICO.length);
    });
  });
});
