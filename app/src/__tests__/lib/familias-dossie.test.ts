/**
 * A regra que decide de que lado da página um documento cai.
 *
 * O dossiê parte os indícios em dois blocos: "o que o acervo aponta" e "lidos e
 * não sustentam". A separação não é cosmética — o primeiro bloco é a fila de
 * revisão e o argumento do pedido de CRC; o segundo é o lastro do "não". Trocar
 * um pelo outro inverte a conclusão da tela.
 */

import { describe, it, expect } from "vitest";
import { indicioNegativo } from "@/lib/conformidade/familias/dossie";

describe("indicioNegativo", () => {
  it("NAO é negativo: a família foi lida contra o documento e ele não a sustenta", () => {
    expect(indicioNegativo("NAO", null)).toBe(true);
  });

  it("PROVA e PARCIAL sustentam", () => {
    expect(indicioNegativo("PROVA", null)).toBe(false);
    expect(indicioNegativo("PARCIAL", null)).toBe(false);
  });

  it("ABSTEM NÃO é negativo — é pendência, não negativa", () => {
    // A maior parte das linhas de uma base real é ABSTEM. Tratá-las como "não sustenta"
    // transformaria a maior parte da fila em veredito negativo silenciosamente.
    expect(indicioNegativo("ABSTEM", null)).toBe(false);
  });

  it("REJEITADA pesa mais que o veredito da máquina", () => {
    // O caso que importa: a máquina disse PROVA, a pessoa disse que não vale.
    // Se o veredito ganhasse, a revisão humana não teria efeito na tela e o
    // indício rejeitado voltaria a aparecer como argumento de cadastro.
    expect(indicioNegativo("PROVA", "REJEITADA")).toBe(true);
    expect(indicioNegativo("PARCIAL", "REJEITADA")).toBe(true);
  });

  it("CONFIRMADA e PARCIAL de revisão não tornam negativo", () => {
    expect(indicioNegativo("PROVA", "CONFIRMADA")).toBe(false);
    expect(indicioNegativo("PARCIAL", "PARCIAL")).toBe(false);
  });

  it("veredito desconhecido não vira negativo por acidente", () => {
    // Se a 0041 ganhar um veredito novo, o default é NÃO descartar: sumir com
    // uma linha da fila é pior que mostrá-la para alguém decidir.
    expect(indicioNegativo("FUTURO", null)).toBe(false);
  });
});
