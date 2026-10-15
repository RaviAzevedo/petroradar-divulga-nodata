import { describe, it, expect } from "vitest";
import { config } from "@/lib/config";

describe("config", () => {
  it("tem CNPJ da Proponente com fallback", () => {
    expect(config.proponente.cnpj).toBeDefined();
    expect(typeof config.proponente.cnpj).toBe("string");
    expect(config.proponente.cnpj.length).toBeGreaterThan(0);
  });

  it("tem nome da Proponente", () => {
    expect(config.proponente.nome).toBe("Proponente");
  });

  it("tem URL do Petronect", () => {
    expect(config.petronect.portalUrl).toContain("petronect.com.br");
  });

  it("CNPJ fallback tem 14 dígitos", () => {
    const digits = config.proponente.cnpj.replace(/\D/g, "");
    expect(digits.length).toBe(14);
  });
});
