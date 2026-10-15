/**
 * A REGRA QUE DECIDE IR OU NÃO IR.
 *
 * Esta é a única parte do briefing que fala do que a Proponente TEM, e não do que
 * o edital exige. Um erro aqui não produz um documento feio — produz uma
 * decisão errada de participar (ou de não participar) numa licitação de dezenas
 * de milhões.
 *
 * Os dois erros que estes testes existem para impedir:
 *   1. dizer "podemos" com base em INDÍCIO, que é apontamento de máquina sem
 *      revisão humana e não sustenta habilitação;
 *   2. tratar "nunca perguntamos ao acervo" como "não temos".
 */

import { describe, it, expect } from "vitest";
import {
  vereditoDaFamilia,
  resumirVeredito,
  montarResumo,
  type VeredictoFamilia,
} from "@/lib/licitacoes/habilitacao-familias";

const base = {
  cadastrada: true,
  statusCadastro: "ATIVA" as string | null,
  venceAntes: false,
  prova: "COM_PROVA" as const,
};

describe("vereditoDaFamilia", () => {
  it("PODE só com prova confirmada por uma pessoa", () => {
    expect(vereditoDaFamilia({ ...base }).veredito).toBe("PODE");
  });

  it("INDÍCIO nunca vira PODE — vira PODE_COM_RESSALVA", () => {
    // O erro que custa caro: o acervo aponta, ninguém revisou, e o briefing
    // afirma habilitação. Hoje `documentos_familias` está VAZIA, então este é
    // o melhor caso possível na base inteira — e ainda assim não é "pode".
    const r = vereditoDaFamilia({ ...base, prova: "COM_INDICIO" });
    expect(r.veredito).toBe("PODE_COM_RESSALVA");
    expect(r.porque).toMatch(/não foi revisado/i);
  });

  it("cadastrado e acervo sem lastro = RISCO, não NAO_PODE", () => {
    // Estar cadastrado permite disputar. O risco é cair na habilitação técnica
    // depois de orçar — que é diferente de estar impedido de participar.
    expect(vereditoDaFamilia({ ...base, prova: "SEM_INDICIO" }).veredito).toBe("RISCO");
  });

  it("nunca avaliada = A_APURAR, jamais RISCO", () => {
    // "Não perguntamos" não é "não temos". Rebaixar para RISCO faria a tela
    // desaconselhar licitações que talvez tenhamos como provar.
    const r = vereditoDaFamilia({ ...base, prova: "INDETERMINADO" });
    expect(r.veredito).toBe("A_APURAR");
    expect(r.porque).toMatch(/diferente de saber que não temos/i);
  });

  it("sem cadastro é NAO_PODE mesmo com prova no acervo", () => {
    // Ter o atestado não habilita sem o CRC da família. Mas o motivo muda o que
    // se faz: aqui a saída é pedir cadastro, não desistir.
    const r = vereditoDaFamilia({ ...base, cadastrada: false });
    expect(r.veredito).toBe("NAO_PODE");
    expect(r.porque).toMatch(/pedido de CRC/i);
  });

  it("CRC que vence ANTES da licitação derruba tudo, inclusive com prova", () => {
    // O erro silencioso: a tela de cadastro diz ATIVA, e a sessão acontece
    // depois do vencimento. Válido hoje não é válido na data que importa.
    const r = vereditoDaFamilia({ ...base, venceAntes: true });
    expect(r.veredito).toBe("NAO_PODE");
    expect(r.porque).toMatch(/vence ANTES/);
  });

  it("cadastro que não está ATIVA vira RISCO", () => {
    expect(
      vereditoDaFamilia({ ...base, statusCadastro: "EM_RENOVACAO" }).veredito,
    ).toBe("RISCO");
  });
});

describe("resumirVeredito — habilitação é elo mais fraco", () => {
  const f = (veredito: VeredictoFamilia) => ({ veredito });

  it("uma família impedida derruba o conjunto, mesmo com o resto perfeito", () => {
    expect(resumirVeredito([f("PODE"), f("PODE"), f("NAO_PODE")])).toBe("NAO_PODE");
  });

  it("não faz média: um RISCO no meio de PODEs devolve RISCO", () => {
    expect(resumirVeredito([f("PODE"), f("RISCO"), f("PODE")])).toBe("RISCO");
  });

  it("A_APURAR pesa menos que RISCO e mais que ressalva", () => {
    expect(resumirVeredito([f("PODE_COM_RESSALVA"), f("A_APURAR")])).toBe("A_APURAR");
    expect(resumirVeredito([f("A_APURAR"), f("RISCO")])).toBe("RISCO");
  });

  it("sem família não inventa veredito", () => {
    expect(resumirVeredito([])).toBe("SEM_FAMILIA");
  });
});

describe("montarResumo", () => {
  it("sem família, diz que não dá para afirmar NEM negar", () => {
    // A tentação seria escrever "não podemos participar". Sem família
    // identificada não sabemos nada — e afirmar seria inventar.
    const t = montarResumo([]);
    expect(t).toMatch(/nem negar/i);
  });

  it("concorda em número — \"1 sustentadas\" é descuido que derruba a confiança", () => {
    const t = montarResumo([{ veredito: "PODE_COM_RESSALVA", codigo: "1" }]);
    expect(t).toContain("1 família CRC exigida");
    expect(t).toContain("1 sustentada por indício");
    expect(t).not.toContain("sustentadas");
  });

  it("conta cada estado e não some com nenhum", () => {
    const t = montarResumo([
      { veredito: "PODE_COM_RESSALVA", codigo: "1" },
      { veredito: "PODE_COM_RESSALVA", codigo: "2" },
      { veredito: "NAO_PODE", codigo: "3" },
    ]);
    expect(t).toContain("3 famílias");
    expect(t).toContain("2 sustentadas por indício");
    expect(t).toContain("1 sem cadastro");
  });
});
