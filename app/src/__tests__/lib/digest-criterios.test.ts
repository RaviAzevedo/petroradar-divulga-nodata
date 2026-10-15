/**
 * Unit — funções puras do digest de e-mail (0026, lib/digest/criterios.ts).
 * Cobre: normalização defensiva do jsonb, montagem da regex de keywords
 * (escape contra regex-injection + acentos), cadência e janela de retroação.
 */

import { describe, it, expect } from "vitest";
import {
  normalizarCriterios,
  montarRegexKeywords,
  cadenciaVencida,
  janelaDesde,
  SCORE_POR_RELEVANCIA,
} from "@/lib/digest/criterios";

describe("normalizarCriterios", () => {
  it("devolve shape canônico para entrada vazia/nula/lixo", () => {
    for (const raw of [null, undefined, "texto", 42, []]) {
      const c = normalizarCriterios(raw);
      expect(c.keywords_incluir).toEqual([]);
      expect(c.min_relevancia).toBe("TODAS");
    }
  });

  it("filtra não-strings e strings vazias das listas", () => {
    const c = normalizarCriterios({
      keywords_incluir: ["apoio", "", 7, null, "  "],
      naturezas: ["SERVIÇO"],
    });
    expect(c.keywords_incluir).toEqual(["apoio"]);
    expect(c.naturezas).toEqual(["SERVIÇO"]);
  });

  it("normaliza min_relevancia (case-insensitive; inválido vira TODAS)", () => {
    expect(normalizarCriterios({ min_relevancia: "alta" }).min_relevancia).toBe("ALTA");
    expect(normalizarCriterios({ min_relevancia: "media" }).min_relevancia).toBe("MEDIA");
    expect(normalizarCriterios({ min_relevancia: "banana" }).min_relevancia).toBe("TODAS");
  });

  it("estados: só UFs válidas sobrevivem, normalizadas p/ maiúsculas", () => {
    const c = normalizarCriterios({ estados: ["rj", " sp ", "XX", "%", "Bahia", "_"] });
    expect(c.estados).toEqual(["RJ", "SP"]); // lixo/curinga ILIKE/nome por extenso caem
  });
});

describe("montarRegexKeywords", () => {
  it("null para lista vazia", () => {
    expect(montarRegexKeywords([])).toBeNull();
    expect(montarRegexKeywords(["  ", ""])).toBeNull();
  });

  it("monta alternância com \\m/\\M por keyword", () => {
    expect(montarRegexKeywords(["apoio", "suporte"])).toBe("(?:\\mapoio\\M|\\msuporte\\M)");
  });

  it("remove acentos (paridade com f_unaccent do banco)", () => {
    expect(montarRegexKeywords(["manutenção elétrica"])).toBe("(?:\\mmanutencao eletrica\\M)");
  });

  it("escapa metacaracteres de regex (input malicioso do painel)", () => {
    const r = montarRegexKeywords(["a)|(b", "x.y*"]);
    expect(r).toBe("(?:\\ma\\)\\|\\(b\\M|\\mx\\.y\\*)");
    // a regex resultante deve ser um pattern VÁLIDO (não lança ao compilar)
    expect(() => new RegExp(r!.replace(/\\m|\\M/g, "\\b"))).not.toThrow();
  });

  it("borda não alfanumérica NÃO ganha âncora (\\m antes de '(' é insatisfazível)", () => {
    // "(EPC)": sem \m no início e sem \M no fim — o branch continua casável
    expect(montarRegexKeywords(["(EPC)"])).toBe("(?:\\(EPC\\))");
    // misto: keyword normal ancorada + keyword com borda de pontuação sem âncora
    expect(montarRegexKeywords(["epc", "S.A."])).toBe("(?:\\mepc\\M|\\mS\\.A\\.)");
  });
});

describe("cadenciaVencida", () => {
  const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000);

  it("sem envio anterior: qualquer cadência vence", () => {
    expect(cadenciaVencida("diario", null)).toBe(true);
    expect(cadenciaVencida("semanal", null)).toBe(true);
  });

  it("tempo-real vence em toda rodada", () => {
    expect(cadenciaVencida("tempo-real", horasAtras(0.1))).toBe(true);
  });

  // 4h, não 20h: o commit 443c17e trocou a cadência diária pelas JANELAS do dia
  // (07:00 e 13:00 BRT) — a folga só precisa liberar as duas janelas e barrar
  // disparo repetido do mesmo slot. Ver criterios.ts:112-123.
  it("diario: 4h de folga (libera as janelas de 07h e 13h)", () => {
    expect(cadenciaVencida("diario", horasAtras(3))).toBe(false);
    expect(cadenciaVencida("diario", horasAtras(5))).toBe(true);
  });

  it("semanal: 6,5 dias", () => {
    expect(cadenciaVencida("semanal", horasAtras(150))).toBe(false);
    expect(cadenciaVencida("semanal", horasAtras(160))).toBe(true);
  });

  it("frequência desconhecida nunca vence (fail-safe)", () => {
    expect(cadenciaVencida("mensal", horasAtras(1000))).toBe(false);
  });
});

describe("janelaDesde", () => {
  it("sem envio anterior: teto de 7 dias", () => {
    const d = janelaDesde(null);
    const dias = (Date.now() - d.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(6.9);
    expect(dias).toBeLessThan(7.1);
  });

  it("envio recente vira o início da janela", () => {
    const ontem = new Date(Date.now() - 86_400_000);
    expect(janelaDesde(ontem).getTime()).toBe(ontem.getTime());
  });

  it("envio muito antigo é capado no teto de 7 dias", () => {
    const mesAtras = new Date(Date.now() - 30 * 86_400_000);
    const d = janelaDesde(mesAtras);
    expect((Date.now() - d.getTime()) / 86_400_000).toBeLessThan(7.1);
  });
});

describe("SCORE_POR_RELEVANCIA", () => {
  it("réguas do motor: ALTA=75, MEDIA=55, TODAS=0", () => {
    expect(SCORE_POR_RELEVANCIA.ALTA).toBe(75);
    expect(SCORE_POR_RELEVANCIA.MEDIA).toBe(55);
    expect(SCORE_POR_RELEVANCIA.TODAS).toBe(0);
  });
});
