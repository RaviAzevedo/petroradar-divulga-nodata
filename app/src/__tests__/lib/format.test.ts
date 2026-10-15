import { describe, it, expect } from "vitest";
import { formatBRL, formatCNPJ, faseColor, normalizeCnpj } from "@/lib/format";

describe("format", () => {
  describe("formatBRL", () => {
    it("formata valor positivo como moeda brasileira", () => {
      const result = formatBRL(1500.5);
      expect(result).toContain("1.500,50");
      expect(result).toContain("R$");
    });

    it("retorna '-' para null", () => {
      expect(formatBRL(null)).toBe("-");
    });

    it("retorna '-' para undefined", () => {
      expect(formatBRL(undefined)).toBe("-");
    });

    it("formata zero como R$ 0,00", () => {
      const result = formatBRL(0);
      expect(result).toContain("0,00");
    });

    it("formata valores grandes", () => {
      const result = formatBRL(1_000_000);
      expect(result).toContain("1.000.000");
    });
  });

  describe("formatCNPJ", () => {
    it("formata CNPJ de 14 dígitos", () => {
      expect(formatCNPJ("11222333000181")).toBe("11.222.333/0001-81");
    });

    it("retorna '-' para null", () => {
      expect(formatCNPJ(null)).toBe("-");
    });

    it("retorna '-' para undefined", () => {
      expect(formatCNPJ(undefined)).toBe("-");
    });

    it("retorna o valor original se não tem 14 dígitos", () => {
      expect(formatCNPJ("12345")).toBe("12345");
    });

    it("retorna '-' para string vazia", () => {
      expect(formatCNPJ("")).toBe("-");
    });
  });

  describe("normalizeCnpj", () => {
    it("remove pontuação de CNPJ formatado", () => {
      expect(normalizeCnpj("11.222.333/0001-81")).toBe("11222333000181");
    });

    it("mantém CNPJ já só com dígitos", () => {
      expect(normalizeCnpj("11222333000181")).toBe("11222333000181");
    });

    it("retorna vazio para null/undefined", () => {
      expect(normalizeCnpj(null)).toBe("");
      expect(normalizeCnpj(undefined)).toBe("");
    });

    it("retorna vazio para string vazia", () => {
      expect(normalizeCnpj("")).toBe("");
    });
  });

  describe("faseColor", () => {
    it("retorna verde para 'Recebendo Propostas'", () => {
      expect(faseColor("Recebendo Propostas")).toContain("text-green-600");
    });

    it("retorna roxo para 'Em Disputa'", () => {
      expect(faseColor("Em Disputa")).toContain("text-purple-600");
    });

    it("retorna amber para 'Em Análise'", () => {
      expect(faseColor("Em Análise")).toContain("text-amber-600");
    });

    it("retorna azul para 'Adjudicado'", () => {
      expect(faseColor("Adjudicado")).toContain("text-blue-600");
    });

    it("retorna vermelho para 'Cancelado'", () => {
      expect(faseColor("Cancelado")).toContain("text-red-500");
    });

    it("retorna gray para null", () => {
      expect(faseColor(null)).toContain("text-gray-400");
    });

    it("retorna fallback para fase desconhecida", () => {
      expect(faseColor("Desconhecida")).toContain("text-gray-500");
    });
  });
});
