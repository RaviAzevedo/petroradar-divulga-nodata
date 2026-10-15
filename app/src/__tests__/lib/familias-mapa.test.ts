import { describe, expect, it } from "vitest";
import { estadoProva, quadranteDe, resumirMapa, type FamiliaNoMapa } from "@/lib/conformidade/familias/mapa";

/**
 * A regra dos quadrantes é a peça que decide o que a tela chama de OPORTUNIDADE
 * e o que ela chama de RISCO. Errar aqui não quebra nada visivelmente — só passa
 * a recomendar a família errada, que é o modo de falha caro deste módulo.
 */
/**
 * A regra que separa "não temos" de "não sabemos". Errar aqui faz a tela
 * afirmar ausência de capacidade onde ninguém sequer perguntou — e é o erro que
 * este módulo inteiro existe para não cometer.
 */
describe("estadoProva", () => {
  it("vínculo confirmado por pessoa ganha de tudo", () => {
    expect(estadoProva(3, 10, true)).toBe("COM_PROVA");
  });

  it("indício da máquina sustenta, mas não é prova", () => {
    expect(estadoProva(0, 5, true)).toBe("COM_INDICIO");
  });

  it("ausência SÓ vira 'não' quando a família foi avaliada", () => {
    // A extração usa o catálogo das famílias cadastradas como vocabulário, então
    // as outras famílias de serviço nunca foram olhadas. Chamá-las de
    // "sem prova" seria inventar.
    expect(estadoProva(0, 0, true)).toBe("SEM_INDICIO");
    expect(estadoProva(0, 0, false)).toBe("INDETERMINADO");
  });

  it("indício em família não avaliada ainda conta (o dado manda, não o universo)", () => {
    expect(estadoProva(0, 2, false)).toBe("COM_INDICIO");
  });
});

describe("quadranteDe", () => {
  it("cadastrado com prova é o núcleo disputável", () => {
    expect(quadranteDe(true, "COM_PROVA")).toBe("NUCLEO");
  });

  it("indício também sustenta o núcleo — mas a tela precisa rotular a diferença", () => {
    expect(quadranteDe(true, "COM_INDICIO")).toBe("NUCLEO");
    expect(quadranteDe(false, "COM_INDICIO")).toBe("OPORTUNIDADE");
  });

  it("cadastrado SEM prova é RISCO — disputa e perde na habilitação", () => {
    // É o caso da família em que se está cadastrado e não se consegue provar.
    expect(quadranteDe(true, "SEM_INDICIO")).toBe("RISCO");
  });

  it("não cadastrado COM prova é OPORTUNIDADE — capacidade pronta, falta pedir o CRC", () => {
    expect(quadranteDe(false, "COM_PROVA")).toBe("OPORTUNIDADE");
  });

  it("não cadastrado e sem prova está fora de alcance hoje", () => {
    expect(quadranteDe(false, "SEM_INDICIO")).toBe("FORA_DE_ALCANCE");
  });

  describe("INDETERMINADO nunca vira um veredito", () => {
    // Enquanto `documentos_familias` está vazia, ausência de vínculo é
    // DESCONHECIMENTO, não negativa. Uma tela que dissesse "não comprovada" para
    // centenas de famílias seria ativamente enganosa — e é exatamente o erro que esta
    // regra existe para impedir.
    it.each([true, false])("cadastrada=%s → A_APURAR", (cadastrada) => {
      expect(quadranteDe(cadastrada, "INDETERMINADO")).toBe("A_APURAR");
    });

    it("NÃO colapsa em FORA_DE_ALCANCE nem em RISCO", () => {
      expect(quadranteDe(false, "INDETERMINADO")).not.toBe("FORA_DE_ALCANCE");
      expect(quadranteDe(true, "INDETERMINADO")).not.toBe("RISCO");
    });
  });
});

function linha(p: Partial<FamiliaNoMapa>): FamiliaNoMapa {
  return {
    codigo: "99000000", nome: null, segmento: "SERVICO", licitacoes: 0,
    escopo: null, grupo: null, segmentoPetrobras: null,
    melhorVeredito: null, justificativa: null,
    ultimaVezEm: null, familiaId: null, cadastrada: false, statusFluxoCrc: null,
    validadeFim: null, documentosVinculados: 0, documentosComIndicio: 0,
    indiciosConfirmados: 0, indiciosPendentes: 0,
    maiorConfianca: null, avaliada: false, prova: "INDETERMINADO",
    quadrante: "A_APURAR", ...p,
  };
}

describe("resumirMapa", () => {
  it("soma famílias e demanda por quadrante", () => {
    const r = resumirMapa([
      linha({ codigo: "99000001", licitacoes: 12, quadrante: "RISCO", cadastrada: true }),
      linha({ codigo: "99000002", licitacoes: 16, quadrante: "OPORTUNIDADE" }),
      linha({ codigo: "99000003", licitacoes: 10, quadrante: "OPORTUNIDADE" }),
    ]);
    expect(r.porQuadrante.OPORTUNIDADE).toEqual({ familias: 2, licitacoes: 26 });
    expect(r.porQuadrante.RISCO).toEqual({ familias: 1, licitacoes: 12 });
    expect(r.demandaTotal).toBe(38);
    expect(r.total).toBe(3);
  });

  it("conta cadastro que o mercado nunca exigiu", () => {
    // Boa parte do cadastro pode cair aqui. NÃO é "cadastro inútil" — pode ser cobertura de
    // raspagem. O resumo dá o número; o julgamento é humano.
    const r = resumirMapa([
      linha({ cadastrada: true, licitacoes: 0 }),
      linha({ cadastrada: true, licitacoes: 5 }),
      linha({ cadastrada: false, licitacoes: 0 }),
    ]);
    expect(r.cadastradasSemDemanda).toBe(1);
    expect(r.cadastradas).toBe(2);
  });

  it("aguenta lista vazia sem explodir", () => {
    const r = resumirMapa([]);
    expect(r.total).toBe(0);
    expect(r.demandaTotal).toBe(0);
    expect(r.porQuadrante).toEqual({});
  });
});
