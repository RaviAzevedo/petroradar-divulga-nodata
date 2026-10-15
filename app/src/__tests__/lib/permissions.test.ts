import { describe, it, expect } from "vitest";
import {
  ROLES,
  isAdmin,
  isGestao,
  podeProporParticipacao,
  podeVisualizar,
  podeSincronizar,
  ROLE_LABELS,
  DEFAULT_ROLE,
} from "@/lib/permissions";

describe("permissions", () => {
  describe("ROLES", () => {
    it("deve ter 7 roles definidos", () => {
      expect(Object.keys(ROLES)).toHaveLength(7);
    });

    it("deve conter todas as roles esperadas", () => {
      expect(ROLES).toEqual({
        ADMIN: "ADMIN",
        LIDER: "LIDER",
        ORCAMENTISTA: "ORCAMENTISTA",
        TECNICO: "TECNICO",
        SGI: "SGI",
        VISUALIZADOR: "VISUALIZADOR",
        EXTERNO: "EXTERNO",
      });
    });
  });

  describe("isAdmin", () => {
    it("retorna true para ADMIN", () => {
      expect(isAdmin("ADMIN")).toBe(true);
    });

    it("retorna false para qualquer outro role", () => {
      expect(isAdmin("LIDER")).toBe(false);
      expect(isAdmin("VISUALIZADOR")).toBe(false);
      expect(isAdmin("EXTERNO")).toBe(false);
    });
  });

  describe("isGestao", () => {
    it("retorna true para ADMIN e LIDER", () => {
      expect(isGestao("ADMIN")).toBe(true);
      expect(isGestao("LIDER")).toBe(true);
    });

    it("retorna false para roles operacionais", () => {
      expect(isGestao("ORCAMENTISTA")).toBe(false);
      expect(isGestao("TECNICO")).toBe(false);
      expect(isGestao("VISUALIZADOR")).toBe(false);
      expect(isGestao("EXTERNO")).toBe(false);
    });
  });

  describe("podeProporParticipacao", () => {
    it("retorna true para ADMIN, LIDER, ORCAMENTISTA, TECNICO", () => {
      expect(podeProporParticipacao("ADMIN")).toBe(true);
      expect(podeProporParticipacao("LIDER")).toBe(true);
      expect(podeProporParticipacao("ORCAMENTISTA")).toBe(true);
      expect(podeProporParticipacao("TECNICO")).toBe(true);
    });

    it("retorna false para VISUALIZADOR e EXTERNO", () => {
      expect(podeProporParticipacao("VISUALIZADOR")).toBe(false);
      expect(podeProporParticipacao("EXTERNO")).toBe(false);
    });
  });

  describe("podeVisualizar", () => {
    it("retorna true para todos exceto EXTERNO", () => {
      expect(podeVisualizar("ADMIN")).toBe(true);
      expect(podeVisualizar("LIDER")).toBe(true);
      expect(podeVisualizar("ORCAMENTISTA")).toBe(true);
      expect(podeVisualizar("TECNICO")).toBe(true);
      expect(podeVisualizar("VISUALIZADOR")).toBe(true);
    });

    it("retorna false para EXTERNO", () => {
      expect(podeVisualizar("EXTERNO")).toBe(false);
    });
  });

  describe("podeSincronizar", () => {
    it("é equivalente a isGestao", () => {
      expect(podeSincronizar("ADMIN")).toBe(true);
      expect(podeSincronizar("LIDER")).toBe(true);
      expect(podeSincronizar("ORCAMENTISTA")).toBe(false);
      expect(podeSincronizar("TECNICO")).toBe(false);
    });
  });

  describe("ROLE_LABELS", () => {
    it("deve ter label para cada role", () => {
      for (const role of Object.values(ROLES)) {
        expect(ROLE_LABELS[role]).toBeDefined();
        expect(typeof ROLE_LABELS[role]).toBe("string");
      }
    });

    it("ADMIN deve ser 'Administrador'", () => {
      expect(ROLE_LABELS.ADMIN).toBe("Administrador");
    });
  });

  describe("DEFAULT_ROLE", () => {
    it("deve ser VISUALIZADOR", () => {
      expect(DEFAULT_ROLE).toBe("VISUALIZADOR");
    });
  });
});
