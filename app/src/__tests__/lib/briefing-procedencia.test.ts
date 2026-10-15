/**
 * A TARJA TEM DE PODER ACENDER.
 *
 * Este teste existe por causa de um defeito que passou por uma auditoria inteira
 * sem ser visto: a tarja "BRIEFING PARCIAL — SEM LASTRO DOCUMENTAL" estava
 * escrita, compilada e no ar — e era inalcançável. `fonteTexto` era opcional no
 * tipo, os montadores de `AnaliseRow` o omitiam, e o teste `fonteTexto ===
 * "OBJETO"` comparava contra `undefined`. Sempre falso.
 *
 * O efeito prático: um briefing de 12 seções construído sobre 71 caracteres de
 * objeto saía com exatamente a mesma cara de um feito sobre 350.000 caracteres
 * de edital, e quem lia não tinha como saber a diferença.
 *
 * Um teste de tipo não pegaria isso (omitir opcional é legal) e um teste de rota
 * também não (a rota devolvia 200 nos dois casos). Só pega quem verifica o TEXTO
 * DE SAÍDA nas duas procedências.
 */

import { describe, it, expect } from "vitest";
import { montarBriefingMarkdown, type AnaliseRow, type BriefingMeta } from "@/lib/licitacoes/briefing";

const META: BriefingMeta = {
  numero: "7004991008",
  objeto: "Serviço de manutenção industrial",
  empresa: "PETROBRAS",
  segmento: "Manutenção",
};

function analise(p: Partial<AnaliseRow>): AnaliseRow {
  return {
    resumo: "resumo", objetoDetalhado: "objeto detalhado",
    checklist: null, requisitos: null, criteriosHabilitacao: null,
    criteriosJulgamento: null, valorEstimado: null, prazos: null, riscos: null,
    recomendacao: null, modeloUsado: "claude-sonnet-5",
    fonteTexto: "ANEXOS", charsEntrada: 350_167,
    erroParse: false, schemaVersao: 1, probVitoria: null, analisadoEm: null,
    ...p,
  };
}

const TARJA = "BRIEFING PARCIAL";

describe("procedência no briefing", () => {
  it("ACENDE a tarja quando a análise leu só o objeto", () => {
    const md = montarBriefingMarkdown(META, analise({ fonteTexto: "OBJETO", charsEntrada: 71 }), null);
    expect(md).toContain(TARJA);
    // O número tem de aparecer: "parcial" sem tamanho não diz nada a quem lê.
    expect(md).toContain("71");
  });

  it("NÃO acende quando a análise leu os anexos", () => {
    expect(montarBriefingMarkdown(META, analise({}), null)).not.toContain(TARJA);
  });

  it("não acende para análise antiga, de procedência desconhecida", () => {
    // null = anterior à 0032. Não sabemos se leu o edital — e afirmar "parcial"
    // sobre uma análise que pode ter lido tudo seria inventar defeito.
    const md = montarBriefingMarkdown(META, analise({ fonteTexto: null, charsEntrada: null }), null);
    expect(md).not.toContain(TARJA);
  });

  it("o campo é OBRIGATÓRIO no tipo — a omissão não compila", () => {
    // Este caso é sobre o compilador, não sobre o runtime: se alguém voltar
    // `fonteTexto` para opcional, o @ts-expect-error abaixo passa a ser um erro
    // ("unused ts-expect-error") e a suíte quebra. É a guarda contra a REGRESSÃO
    // do defeito, não contra o defeito.
    // @ts-expect-error — falta fonteTexto/charsEntrada de propósito
    const incompleta: AnaliseRow = {
      resumo: null, objetoDetalhado: null, checklist: null, requisitos: null,
      criteriosHabilitacao: null, criteriosJulgamento: null, valorEstimado: null,
      prazos: null, riscos: null, recomendacao: null, modeloUsado: null,
      erroParse: null, schemaVersao: null, probVitoria: null, analisadoEm: null,
    };
    expect(incompleta).toBeDefined();
  });
});
