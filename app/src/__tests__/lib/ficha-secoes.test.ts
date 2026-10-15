/**
 * Funções puras da ficha da operação (secoes.ts).
 *
 * Dois contratos em jogo:
 *  - `contadoresBarra` tem de reproduzir os agregados de R1 (FILTER de
 *    contagensPorOperacao em operacoes/queries.ts) — barra da ficha e coluna
 *    do índice saem da MESMA regra;
 *  - `fatiarParaDownload` tem de respeitar os tetos de R12 na ordem estável
 *    do servidor (criado_em ASC, id ASC) — bloco errado vira 422 em produção.
 */

import { describe, it, expect } from "vitest";
import {
  anoDaProva,
  contaNaBarra,
  contadoresBarra,
  estouraTetoZip,
  fatiarParaDownload,
  formatarPeriodo,
  montarSecoes,
  montarTimeline,
  normalizarBusca,
  numeroAditivo,
  secaoDaFicha,
  tokenSignificativo,
  type DocDossie,
} from "@/app/acervo/operacoes/[id]/secoes";

/** Fixture mínima: só se sobrescreve o que o caso testa. */
let seq = 0;
function doc(parcial: Partial<DocDossie>): DocDossie {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    titulo: `Documento ${seq}`,
    papel: null,
    tipoDocumento: null,
    situacaoProva: null,
    detentora: null,
    restrito: false,
    subcategoria: "OUTRO",
    nomeArquivo: `doc-${seq}.pdf`,
    tamanhoBytes: 1024,
    contentType: "application/pdf",
    versao: 1,
    numeroDocumento: null,
    emitidoEm: null,
    validadeFim: null,
    status: "VIGENTE",
    sha256: "a".repeat(64),
    origemPath: null,
    familias: [],
    criadoEm: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    ...parcial,
  };
}

describe("contaNaBarra / contadoresBarra (espelho de R1)", () => {
  it("NULL conta; RASCUNHO/SUPERADA/CANCELADA/MODELO não; assinadas e INDEFINIDA contam", () => {
    expect(contaNaBarra(doc({ situacaoProva: null }))).toBe(true);
    expect(contaNaBarra(doc({ situacaoProva: "INDEFINIDA" }))).toBe(true);
    expect(contaNaBarra(doc({ situacaoProva: "ASSINADA_PROPONENTE" }))).toBe(true);
    expect(contaNaBarra(doc({ situacaoProva: "ASSINADA_CLIENTE" }))).toBe(true);
    expect(contaNaBarra(doc({ situacaoProva: "RASCUNHO" }))).toBe(false);
    expect(contaNaBarra(doc({ situacaoProva: "SUPERADA" }))).toBe(false);
    expect(contaNaBarra(doc({ situacaoProva: "CANCELADA" }))).toBe(false);
    expect(contaNaBarra(doc({ situacaoProva: "MODELO" }))).toBe(false);
  });

  it("reproduz os agregados de R1 com tipo, fallback por papel e rascunhos fora", () => {
    const docs = [
      doc({ tipoDocumento: "ATESTADO" }),
      doc({ tipoDocumento: null, papel: "ATESTADO" }),            // legado → conta
      doc({ tipoDocumento: "ATESTADO", situacaoProva: "RASCUNHO" }), // fora da barra
      doc({ tipoDocumento: "ART" }),
      doc({ tipoDocumento: "CAT" }),
      doc({ tipoDocumento: null, papel: "CAT_ART" }),
      doc({ tipoDocumento: "CONTRATO" }),
      doc({ tipoDocumento: "ADITIVO" }),
      doc({ tipoDocumento: "ANEXO_CONTRATO" }),
      doc({ tipoDocumento: null, papel: "CONTRATO" }),
      doc({ tipoDocumento: "CONTRATO", situacaoProva: "SUPERADA" }), // fora
      doc({ tipoDocumento: "NF" }),                                  // nem A nem ART nem C
    ];
    const c = contadoresBarra(docs);
    expect(c.atestados).toBe(2);
    expect(c.artCat).toBe(3);
    expect(c.contratos).toBe(4);
    expect(c.total).toBe(12);
    expect(c.naoContam).toBe(2);
  });
});

describe("secaoDaFicha (fallback dos legados)", () => {
  it("tipo NULL + papel ATESTADO cai na seção 2 (critério de aceite nº 5)", () => {
    expect(secaoDaFicha(doc({ tipoDocumento: null, papel: "ATESTADO" }))).toBe(2);
  });
  it("tipo vence papel; sem nada, seção 9", () => {
    expect(secaoDaFicha(doc({ tipoDocumento: "NF", papel: "ATESTADO" }))).toBe(7);
    expect(secaoDaFicha(doc({ tipoDocumento: null, papel: null }))).toBe(9);
  });
});

describe("anoDaProva", () => {
  it("emitidoEm vence tudo", () => {
    expect(anoDaProva(doc({ emitidoEm: "2024-08-14", numeroDocumento: "BA20250000001" }))).toBe("2024");
  });
  it("sem emissão, acha o ano dentro do número da ART", () => {
    expect(anoDaProva(doc({ numeroDocumento: "BA20250000001" }))).toBe("2025");
  });
  it("sem número, procura no título; sem nada, 'sem ano'", () => {
    expect(anoDaProva(doc({ titulo: "ART Mecânica 2019 - Acme" }))).toBe("2019");
    expect(anoDaProva(doc({ titulo: "ART sem pista nenhuma" }))).toBe("sem ano");
  });
});

describe("numeroAditivo", () => {
  it("numérico com e sem ordinal masculino", () => {
    expect(numeroAditivo("3º ADITIVO ao contrato")).toBe(3);
    expect(numeroAditivo("12 ADITIVO")).toBe(12);
  });
  it("por extenso, inclusive compostos e com acento", () => {
    expect(numeroAditivo("PRIMEIRO ADITIVO")).toBe(1);
    expect(numeroAditivo("Décimo Sétimo Aditivo do contrato")).toBe(17);
    expect(numeroAditivo("DECIMO ADITIVO")).toBe(10);
    expect(numeroAditivo("VIGÉSIMO ADITIVO")).toBe(20);
  });
  it("sem menção a aditivo → null (é o contrato-raiz)", () => {
    expect(numeroAditivo("Contrato 12.0001.000001 ACME")).toBeNull();
  });
});

describe("montarSecoes", () => {
  it("só devolve seções não vazias, na ordem 1..9", () => {
    const secoes = montarSecoes([
      doc({ tipoDocumento: "ART" }),
      doc({ tipoDocumento: "CONTRATO" }),
    ]);
    expect(secoes.map((s) => s.numero)).toEqual([1, 3]);
  });

  it("seção 1: contrato-raiz primeiro, aditivos por emissão e número", () => {
    const aditivo2 = doc({ tipoDocumento: "ADITIVO", titulo: "2º ADITIVO", emitidoEm: "2020-01-01" });
    const aditivo1 = doc({ tipoDocumento: "ADITIVO", titulo: "PRIMEIRO ADITIVO", emitidoEm: "2019-06-01" });
    const raiz = doc({ tipoDocumento: "CONTRATO", titulo: "Contrato original", emitidoEm: "2018-05-01" });
    const [secao1] = montarSecoes([aditivo2, aditivo1, raiz]);
    expect(secao1.numero).toBe(1);
    expect(secao1.docs.map((d) => d.titulo)).toEqual([
      "Contrato original", "PRIMEIRO ADITIVO", "2º ADITIVO",
    ]);
  });

  it("seção 3: fitas por ano DESC, 'sem ano' por último, e docs achatados na mesma ordem", () => {
    const a2025 = doc({ tipoDocumento: "ART", numeroDocumento: "BA20250000001" });
    const a2019 = doc({ tipoDocumento: "ART", emitidoEm: "2019-03-01" });
    const semAno = doc({ tipoDocumento: "CAT", titulo: "CAT sem pista" });
    const [secao3] = montarSecoes([semAno, a2019, a2025]);
    expect(secao3.fitas?.map((f) => f.chave)).toEqual(["2025", "2019", "sem ano"]);
    expect(secao3.docs[0].id).toBe(a2025.id);
    expect(secao3.docs.at(-1)?.id).toBe(semAno.id);
  });

  it("seção 7: fitas na ordem fixa de tipo; legado papel NOTA_FISCAL entra na fita NF", () => {
    const carta = doc({ tipoDocumento: "CARTA" });
    const nfLegada = doc({ tipoDocumento: null, papel: "NOTA_FISCAL" });
    const pedido = doc({ tipoDocumento: "PEDIDO" });
    const [secao7] = montarSecoes([carta, nfLegada, pedido]);
    expect(secao7.numero).toBe(7);
    expect(secao7.fitas?.map((f) => f.chave)).toEqual(["PEDIDO", "NF", "CARTA"]);
  });

  it("naoContam e ordemProvisoria alimentam o cabeçalho da seção", () => {
    const [secao1] = montarSecoes([
      doc({ tipoDocumento: "CONTRATO", situacaoProva: "RASCUNHO" }),
      doc({ tipoDocumento: "ADITIVO", titulo: "1º ADITIVO" }),
    ]);
    expect(secao1.naoContam).toBe(1);
    // Nenhum dos 2 tem emitidoEm → a ordem exibida é palpite declarado.
    expect(secao1.ordemProvisoria).toBe(true);
  });
});

describe("fatiarParaDownload (tetos de R12)", () => {
  it("respeita o teto de docs e mantém a ordem estável criadoEm ASC, id ASC", () => {
    const docs = Array.from({ length: 7 }, (_, i) =>
      doc({ criadoEm: `2026-01-0${7 - i}T00:00:00.000Z` })
    );
    const blocos = fatiarParaDownload(docs, 3, 1024 * 1024);
    expect(blocos.map((b) => b.length)).toEqual([3, 3, 1]);
    // Primeiro bloco começa no criadoEm mais antigo (2026-01-01).
    expect(blocos[0][0]).toBe(docs[6].id);
  });

  it("fecha o bloco por bytes antes do teto de docs", () => {
    const grandes = [
      doc({ tamanhoBytes: 90 }),
      doc({ tamanhoBytes: 90 }),
      doc({ tamanhoBytes: 90 }),
    ];
    const blocos = fatiarParaDownload(grandes, 100, 180);
    expect(blocos.map((b) => b.length)).toEqual([2, 1]);
  });

  it("estouraTetoZip: 139 ART estouram; 4 docs não", () => {
    const muitos = Array.from({ length: 139 }, () => doc({ tamanhoBytes: 1024 }));
    expect(estouraTetoZip(muitos)).toBe(true);
    expect(fatiarParaDownload(muitos).length).toBe(2); // "baixar em 2 partes"
    expect(estouraTetoZip(muitos.slice(0, 4))).toBe(false);
  });
});

describe("apoios de tela", () => {
  it("formatarPeriodo cobre as quatro combinações sem virar '—' mudo", () => {
    expect(formatarPeriodo("2015-01-01", "2018-12-31")).toBe("01/01/2015 → 31/12/2018");
    expect(formatarPeriodo("2015-01-01", null)).toBe("desde 01/01/2015");
    expect(formatarPeriodo(null, "2018-12-31")).toBe("até 31/12/2018");
    expect(formatarPeriodo(null, null)).toBeNull();
  });

  it("normalizarBusca ignora acento e caixa", () => {
    expect(normalizarBusca("AÇOS ALFA")).toBe(normalizarBusca("aços alfa"));
  });

  it("tokenSignificativo pula a stoplist e aceita o 'XYZ' de 3 letras", () => {
    expect(tokenSignificativo("XYZ BRASIL S.A.")).toBe("XYZ");
    expect(tokenSignificativo("ACME SIDERURGIA S/A")).toBe("ACME");
    expect(tokenSignificativo("LTDA")).toBe("");
  });
});

// ── D9 — a linha do tempo da operação (0044, spec §4.4 / §8.10) ───────

describe("montarTimeline (D9)", () => {
  it("recorta as seções 1/2/3, conta o resto em `foraDaLinha` e a soma FECHA (Q4)", () => {
    // A igualdade abaixo é o Q4 aplicado à timeline: toda peça do dossiê está
    // em exatamente um dos três lugares (no eixo, sem data, ou fora do
    // recorte). Sem ela, um documento poderia sumir da tela sem que ninguém
    // percebesse — que é o defeito que este módulo existe para não repetir.
    const docs = [
      doc({ tipoDocumento: "CONTRATO", emitidoEm: "2018-05-01" }),        // seção 1
      doc({ tipoDocumento: "ADITIVO", titulo: "1º ADITIVO", emitidoEm: "2019-06-01" }), // 1
      doc({ tipoDocumento: "ATESTADO", emitidoEm: "2021-03-10" }),        // seção 2
      doc({ tipoDocumento: "ART", emitidoEm: "2021-04-02" }),             // seção 3
      doc({ tipoDocumento: "CAT", numeroDocumento: "BA20250000001" }),    // seção 3, sem data
      doc({ tipoDocumento: "CREA_PJ", emitidoEm: "2020-01-01" }),         // seção 4 — fora
      doc({ tipoDocumento: "NF", emitidoEm: "2020-02-01" }),              // seção 7 — fora
      doc({ tipoDocumento: null, papel: null }),                          // seção 9 — fora
    ];
    const t = montarTimeline(docs, null, null);

    expect(t.eventos.map((e) => e.tipo)).toEqual(["CONTRATO", "ADITIVO", "ATESTADO", "CAT_ART"]);
    expect(t.semData).toHaveLength(1);
    expect(t.foraDaLinha).toBe(3);
    expect(
      t.eventos.filter((e) => e.documentoId).length + t.semData.length + t.foraDaLinha
    ).toBe(docs.length);
  });

  it("o tipo do marco sai da SEÇÃO, com o mesmo fallback por papel das seções", () => {
    // Nenhuma tupla nova e nenhum `Record` de tipo novo: quem já decide isto é
    // `secaoDaFicha` + `tipoDocumento` (§4.4, regra 2). ANEXO_CONTRATO é lastro
    // do contrato e entra como CONTRATO — a história é "contrato → aditivos".
    const t = montarTimeline(
      [
        doc({ tipoDocumento: "ANEXO_CONTRATO", emitidoEm: "2018-01-01" }),
        doc({ tipoDocumento: null, papel: "ADITIVO", titulo: "2º ADITIVO", emitidoEm: "2018-01-02" }),
        doc({ tipoDocumento: null, papel: "ATESTADO", emitidoEm: "2018-01-03" }),
        doc({ tipoDocumento: null, papel: "CAT_ART", emitidoEm: "2018-01-04" }),
      ],
      null,
      null
    );
    expect(t.eventos.map((e) => e.tipo)).toEqual(["CONTRATO", "ADITIVO", "ATESTADO", "CAT_ART"]);
  });

  it("`anoDaProva` NÃO posiciona: ART sem emissão cai em `semData` com o ano só como rótulo", () => {
    // O caso mais importante do describe. `anoDaProva` adivinha o ano pelo
    // número da ART ("BA20250000001" → 2025): ótimo para ROTULAR uma fita,
    // mentira se virasse coordenada no eixo (Q10.1). A peça aparece na lista de
    // baixo, contada e datada por extenso — nunca pendurada na linha.
    const semEmissao = doc({
      tipoDocumento: "ART",
      titulo: "ART Mecânica",
      emitidoEm: null,
      numeroDocumento: "BA20250000001",
    });
    const t = montarTimeline([semEmissao], null, null);

    expect(t.eventos).toEqual([]);
    expect(t.semData).toEqual([
      { documentoId: semEmissao.id, titulo: "ART Mecânica", ano: "2025", tipo: "CAT_ART" },
    ]);
    expect(t.inicio).toBeNull();
    expect(t.fim).toBeNull();
  });

  it("data: `date` e ISO com hora caem no MESMO eixo; formato de gente vai para `semData`", () => {
    // `emitidoEm` chega "2019-05-02" pela ficha e "2019-05-02T00:00:00.000Z"
    // por outros caminhos — cortar em 10 é o que faz as duas formas coincidirem.
    const t = montarTimeline(
      [
        doc({ tipoDocumento: "ATESTADO", emitidoEm: "2019-05-02" }),
        doc({ tipoDocumento: "ATESTADO", emitidoEm: "2019-05-02T00:00:00.000Z" }),
      ],
      null,
      null
    );
    expect(t.eventos.map((e) => e.data)).toEqual(["2019-05-02", "2019-05-02"]);

    // "02/05/2019" não vira palpite: 02 de maio e 05 de fevereiro escrevem-se
    // igual, e um eixo não pode adivinhar qual dos dois é.
    const brasileira = montarTimeline(
      [doc({ tipoDocumento: "ATESTADO", titulo: "Atestado Alfa", emitidoEm: "02/05/2019" })],
      null,
      null
    );
    expect(brasileira.eventos).toEqual([]);
    expect(brasileira.semData.map((s) => s.titulo)).toEqual(["Atestado Alfa"]);
  });

  it("ordem determinística: mesmo dia sai pelo rank de tipo, e duas chamadas são iguais", () => {
    const atestado = doc({ tipoDocumento: "ATESTADO", emitidoEm: "2020-07-07" });
    const aditivo = doc({ tipoDocumento: "ADITIVO", titulo: "1º ADITIVO", emitidoEm: "2020-07-07" });
    const contrato = doc({ tipoDocumento: "CONTRATO", emitidoEm: "2020-07-07" });
    const entrada = [atestado, aditivo, contrato];

    const t = montarTimeline(entrada, null, null);
    expect(t.eventos.map((e) => e.documentoId)).toEqual([contrato.id, aditivo.id, atestado.id]);
    // Função pura tem de ser determinística: rodar de novo sobre a MESMA
    // entrada devolve o MESMO array, senão a tela pisca a cada render.
    expect(montarTimeline(entrada, null, null)).toEqual(t);
  });

  it("dois ADITIVOS do mesmo dia saem por `numeroAditivo`, com `null` ao fim", () => {
    const semNumero = doc({ tipoDocumento: "ADITIVO", titulo: "ADITIVO ao contrato", emitidoEm: "2020-07-07" });
    const terceiro = doc({ tipoDocumento: "ADITIVO", titulo: "3º ADITIVO", emitidoEm: "2020-07-07" });
    const primeiro = doc({ tipoDocumento: "ADITIVO", titulo: "PRIMEIRO ADITIVO", emitidoEm: "2020-07-07" });

    const t = montarTimeline([semNumero, terceiro, primeiro], null, null);
    expect(t.eventos.map((e) => e.numeroAditivo)).toEqual([1, 3, null]);
    expect(t.eventos.map((e) => e.documentoId)).toEqual([primeiro.id, terceiro.id, semNumero.id]);
  });

  it("marcos de período abrem e fecham o eixo; `inicio`/`fim` são os extremos", () => {
    const t = montarTimeline(
      [
        doc({ tipoDocumento: "CONTRATO", emitidoEm: "2015-06-01" }),
        doc({ tipoDocumento: "ATESTADO", emitidoEm: "2018-02-20" }),
      ],
      "2015-01-01",
      "2018-12-31"
    );
    expect(t.eventos[0].tipo).toBe("PERIODO_INICIO");
    expect(t.eventos[0].chave).toBe("periodo:inicio");
    expect(t.eventos[0].documentoId).toBeNull();
    expect(t.eventos.at(-1)?.tipo).toBe("PERIODO_FIM");
    expect(t.inicio).toBe("2015-01-01");
    expect(t.fim).toBe("2018-12-31");
  });

  it("documento emitido ANTES do início vem antes do marco: a ordem é por data", () => {
    // O rank de tipo é só desempate DENTRO do dia. Um contrato assinado antes
    // do período informado é fato do acervo (o cadastro é que está incompleto),
    // e a linha tem de mostrá-lo onde ele aconteceu.
    const anterior = doc({ tipoDocumento: "CONTRATO", emitidoEm: "2014-11-30" });
    const t = montarTimeline([anterior], "2015-01-01", "2018-12-31");
    expect(t.eventos.map((e) => e.chave)).toEqual([
      `doc:${anterior.id}`,
      "periodo:inicio",
      "periodo:fim",
    ]);
    expect(t.inicio).toBe("2014-11-30");
  });

  it("período sem formato utilizável não vira marco nenhum", () => {
    const t = montarTimeline([doc({ tipoDocumento: "CONTRATO", emitidoEm: "2015-06-01" })], "01/01/2015", null);
    expect(t.eventos.map((e) => e.tipo)).toEqual(["CONTRATO"]);
  });

  it("`naoConta`: SUPERADA aparece VAZADA na linha, nunca omitida", () => {
    // Esconder o superado faria a timeline contar uma história diferente da
    // barra de comprovação logo acima dela (§4.4, regra 7).
    const superado = doc({ tipoDocumento: "CONTRATO", emitidoEm: "2018-01-01", situacaoProva: "SUPERADA" });
    const vigente = doc({ tipoDocumento: "ATESTADO", emitidoEm: "2019-01-01" });
    const t = montarTimeline([superado, vigente], null, null);
    expect(t.eventos.map((e) => e.naoConta)).toEqual([true, false]);
    expect(t.eventos).toHaveLength(2);
  });

  it("vazio: `montarTimeline([], null, null)` devolve o retorno completo e NÃO lança", () => {
    expect(montarTimeline([], null, null)).toEqual({
      eventos: [],
      inicio: null,
      fim: null,
      semData: [],
      foraDaLinha: 0,
    });
  });
});

