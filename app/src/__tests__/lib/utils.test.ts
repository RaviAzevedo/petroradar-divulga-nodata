import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cn, formatDate, diasRestantes, relevanciaColor, faseAtualizada } from "@/lib/utils";

describe("utils", () => {
  describe("cn", () => {
    it("combina classes simples", () => {
      expect(cn("px-2", "py-1")).toBe("px-2 py-1");
    });

    it("resolve conflitos tailwind (última vence)", () => {
      expect(cn("px-2", "px-4")).toBe("px-4");
    });

    it("filtra valores falsy", () => {
      expect(cn("px-2", false && "py-1", undefined, null, "text-sm")).toBe("px-2 text-sm");
    });

    it("funciona com arrays e objetos (clsx)", () => {
      expect(cn("base", { "text-red": true, "text-blue": false })).toBe("base text-red");
    });
  });

  describe("formatDate", () => {
    it("retorna '-' para null/undefined", () => {
      expect(formatDate(null)).toBe("-");
      expect(formatDate(undefined)).toBe("-");
    });

    it("formata data YYYY-MM-DD como data local pt-BR", () => {
      const result = formatDate("2026-04-01");
      expect(result).toBe("01/04/2026");
    });

    it("formata objeto Date", () => {
      const result = formatDate(new Date(2026, 3, 1));
      expect(result).toBe("01/04/2026");
    });

    it("retorna string original se data inválida", () => {
      expect(formatDate("nao-e-data")).toBe("nao-e-data");
    });
  });

  describe("diasRestantes", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 3, 4, 12, 0, 0)); // 04/04/2026
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retorna null para null/undefined", () => {
      expect(diasRestantes(null)).toBeNull();
      expect(diasRestantes(undefined)).toBeNull();
    });

    it("retorna 0 para data de hoje", () => {
      expect(diasRestantes("2026-04-04")).toBe(0);
    });

    it("retorna positivo para data futura", () => {
      expect(diasRestantes("2026-04-07")).toBe(3);
    });

    it("retorna negativo para data passada", () => {
      expect(diasRestantes("2026-04-01")).toBe(-3);
    });

    it("retorna null para data inválida", () => {
      expect(diasRestantes("invalido")).toBeNull();
    });
  });

  describe("faseAtualizada", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 3, 4, 12, 0, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retorna 'Prazo Encerrado' se Recebendo Propostas e data_fim passou", () => {
      expect(faseAtualizada("Recebendo Propostas", "2026-04-01")).toBe("Prazo Encerrado");
    });

    it("retorna 'Prazo Encerrado' se Agendada (Futura) e data_fim passou", () => {
      expect(faseAtualizada("Agendada (Futura)", "2026-04-01")).toBe("Prazo Encerrado");
    });

    it("mantém 'Recebendo Propostas' se data_fim é futura", () => {
      expect(faseAtualizada("Recebendo Propostas", "2026-04-10")).toBe("Recebendo Propostas");
    });

    it("não muda fases terminais mesmo com data_fim passada", () => {
      expect(faseAtualizada("Cancelado", "2026-01-01")).toBe("Cancelado");
      expect(faseAtualizada("Concluído", "2026-01-01")).toBe("Concluído");
      expect(faseAtualizada("Em Análise", "2026-01-01")).toBe("Em Análise");
    });

    it("retorna fase original se data_fim é null", () => {
      expect(faseAtualizada("Recebendo Propostas", null)).toBe("Recebendo Propostas");
    });

    it("retorna '—' se fase é null", () => {
      expect(faseAtualizada(null, "2026-04-01")).toBe("—");
    });
  });

  describe("relevanciaColor", () => {
    it("retorna cores corretas para ALTA", () => {
      expect(relevanciaColor("ALTA")).toContain("text-red-600");
    });

    it("retorna cores corretas para MÉDIA (com acento)", () => {
      expect(relevanciaColor("MÉDIA")).toContain("text-amber-600");
    });

    it("retorna cores corretas para MEDIA (sem acento)", () => {
      expect(relevanciaColor("MEDIA")).toContain("text-amber-600");
    });

    it("retorna cores corretas para BAIXA", () => {
      expect(relevanciaColor("BAIXA")).toContain("text-blue-600");
    });

    it("retorna cores de fallback para null e valores desconhecidos", () => {
      expect(relevanciaColor(null)).toContain("text-gray-500");
      expect(relevanciaColor("DESCONHECIDO")).toContain("text-gray-500");
    });
  });
});
