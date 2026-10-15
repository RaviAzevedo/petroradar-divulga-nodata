/**
 * Relatório "Currículo técnico do RT" (C1) — a parte PURA.
 *
 * O que está em jogo: este arquivo é o anexo que acompanha o atestado numa
 * habilitação. Três coisas nele não podem mudar de sentido caladas, e são as
 * que este teste trava — sem abrir ExcelJS nem pdf-lib (o arquivo em si é
 * conferido gerando XLSX/PDF de verdade a partir deste mesmo snapshot):
 *
 * 1. `linhasCurriculo` — a aba "Obras e atividades": UMA linha por atividade E
 *    UMA linha por documento SEM atividade. Sem a segunda regra, o documento
 *    sumiria do currículo justamente quando ninguém cadastrou a ART ainda — o
 *    currículo mentiria por omissão, e ninguém veria.
 *
 * 2. QUANTIDADE É TEXTO. `quantidadeTexto` é a quantidade como está ESCRITA na
 *    ART ("3.600,00 HH") — texto do documento, que não entra em soma nenhuma
 *    (§1c). Um `z.coerce.number()` ou um `Number()` em qualquer ponto deste
 *    caminho cai aqui.
 *
 * 3. O papel do profissional sai de `PAPEL_PROFISSIONAL_LABELS`, nunca do enum
 *    cru: "RT" numa célula do anexo não diz nada a quem o lê.
 */

import { describe, it, expect } from "vitest";
import { PAPEL_PROFISSIONAL_LABELS } from "@/lib/conformidade/profissionais/validations";
import type { CurriculoRt } from "@/lib/conformidade/profissionais/queries";
import {
  NOTA_QUANTIDADE_ART,
  linhasCurriculo,
  textoCrea,
  type DadosCurriculoRt,
} from "@/lib/relatorios/curriculo-rt";

// ── Snapshot fixo ────────────────────────────────────────────────────────────

/**
 * O currículo como `curriculoDoProfissional` o devolve, JÁ ordenado pelo SQL
 * (obra mais recente primeiro; documentos por papel e emissão; atividades por
 * `ordem`). Cada caso que o §8.6 exige aparece uma vez:
 *
 * - documento COM duas atividades, uma com quantidade e outra sem;
 * - documento SEM nenhuma atividade (o caso que não pode sumir);
 * - obra com grupo e obra sem grupo; período fechado e período aberto;
 * - `tipoDocumento`, `numeroArt` e `disciplina` nulos.
 */
const CURRICULO: CurriculoRt = {
  geradoEm: "2026-09-12T12:00:00.000Z",
  profissional: {
    id: "prof-1", nome: "Joao A. Silva", crea: "0101234567", creaUf: "BA",
    formacao: "Engenheiro Mecanico", ativo: true,
  },
  operacoes: [
    {
      operacaoId: "op-1", codigo: "90002", clienteNome: "Transpetro", clienteGrupo: "Transpetro",
      periodoInicio: "2021-01-01", periodoFim: "2022-12-31",
      disciplinasDaOperacao: [
        { id: "d-tub", codigo: "TUB", nome: "Tubulação" },
        { id: "d-ele", codigo: "ELE", nome: "Elétrica" },
      ],
      documentos: [
        {
          documentoId: "doc-a", titulo: "Atestado TSSE", tipoDocumento: "ATESTADO",
          papelProfissional: "RT", numeroArt: "BA20210001",
          emitidoEm: new Date("2022-03-10T00:00:00.000Z"),
          disciplina: { id: "d-tub", codigo: "TUB", nome: "Tubulação" },
          atividades: [
            {
              id: "at-1", atividade: "Montagem de tubulação em aço carbono",
              quantidadeTexto: "12.000,00 m", ordem: 1,
            },
            {
              id: "at-2", atividade: "Testes hidrostáticos", quantidadeTexto: null, ordem: 2,
            },
          ],
        },
        {
          // O caso do §8.6: documento SEM atividade cadastrada.
          documentoId: "doc-b", titulo: "CAT 2021/123", tipoDocumento: "CAT",
          papelProfissional: "CORRESPONSAVEL", numeroArt: null,
          emitidoEm: null, disciplina: null, atividades: [],
        },
      ],
    },
    {
      operacaoId: "op-2", codigo: "90001", clienteNome: "Petrobras", clienteGrupo: null,
      periodoInicio: "2019-05-01", periodoFim: null,
      disciplinasDaOperacao: [],
      documentos: [
        {
          documentoId: "doc-c", titulo: "ART 2019/0099", tipoDocumento: null,
          papelProfissional: "EQUIPE", numeroArt: "BA20190099",
          emitidoEm: new Date("2019-06-01T00:00:00.000Z"),
          disciplina: { id: "d-ele", codigo: "ELE", nome: "Elétrica" },
          atividades: [
            {
              id: "at-3", atividade: "Supervisão de montagem elétrica",
              quantidadeTexto: "3.600,00 HH", ordem: 1,
            },
          ],
        },
      ],
    },
  ],
  contagens: { operacoes: 2, documentos: 3, atividades: 3 },
  ignorados: { semOperacao: 1 },
};

const SNAPSHOT: DadosCurriculoRt = { geradoEm: CURRICULO.geradoEm, curriculo: CURRICULO };

/** Índices das colunas da aba 2 (a ordem é contrato — §5.10). */
const COL = {
  operacao: 0, cliente: 1, periodo: 2, disciplina: 3, documento: 4, tipo: 5,
  papel: 6, art: 7, atividade: 8, quantidade: 9,
} as const;

// ── linhasCurriculo ──────────────────────────────────────────────────────────

describe("linhasCurriculo", () => {
  const linhas = linhasCurriculo(SNAPSHOT);

  it("devolve uma linha por atividade e uma por documento sem atividade", () => {
    // 2 atividades do doc-a + 1 linha do doc-b (sem atividade) + 1 do doc-c.
    expect(linhas).toHaveLength(4);
    expect(linhas.every((l) => l.length === 10)).toBe(true);
  });

  it("documento sem atividade não some", () => {
    const doDocB = linhas.filter((l) => l[COL.documento] === "CAT 2021/123");
    expect(doDocB).toHaveLength(1);
    // A coluna Atividade fica VAZIA — e com ela a quantidade.
    expect(doDocB[0][COL.atividade]).toBeNull();
    expect(doDocB[0][COL.quantidade]).toBeNull();
    // Mas a obra e o documento continuam identificados.
    expect(doDocB[0][COL.operacao]).toBe("90002");
    expect(doDocB[0][COL.papel]).toBe("Corresponsável");
  });

  it("repete operação e documento na ordem da resposta", () => {
    expect(linhas.map((l) => l[COL.operacao])).toEqual(["90002", "90002", "90002", "90001"]);
    expect(linhas.map((l) => l[COL.documento]))
      .toEqual(["Atestado TSSE", "Atestado TSSE", "CAT 2021/123", "ART 2019/0099"]);
    expect(linhas.map((l) => l[COL.atividade])).toEqual([
      "Montagem de tubulação em aço carbono",
      "Testes hidrostáticos",
      null,
      "Supervisão de montagem elétrica",
    ]);
  });

  it("escreve a linha completa da primeira atividade", () => {
    expect(linhas[0]).toEqual([
      "90002",
      "Transpetro (Transpetro)",
      "01/01/2021 → 31/12/2022",
      "TUB",
      "Atestado TSSE",
      "ATESTADO",
      "Responsável técnico",
      "BA20210001",
      "Montagem de tubulação em aço carbono",
      "12.000,00 m",
    ]);
  });

  it("mantém a quantidade da ART como texto (nada de Number)", () => {
    // A quantidade da ART é TEXTO do documento — vírgula decimal e tudo.
    expect(linhas[0][COL.quantidade]).toBe("12.000,00 m");
    expect(linhas[3][COL.quantidade]).toBe("3.600,00 HH");
    expect(Number(linhas[3][COL.quantidade])).toBeNaN(); // nunca foi número
  });

  it("usa o rótulo do papel, nunca o enum cru", () => {
    const papeis = linhas.map((l) => l[COL.papel]);
    expect(papeis).toEqual([
      PAPEL_PROFISSIONAL_LABELS.RT,
      PAPEL_PROFISSIONAL_LABELS.RT,
      PAPEL_PROFISSIONAL_LABELS.CORRESPONSAVEL,
      PAPEL_PROFISSIONAL_LABELS.EQUIPE,
    ]);
    expect(papeis).not.toContain("RT");
    expect(papeis).not.toContain("CORRESPONSAVEL");
    expect(papeis).not.toContain("EQUIPE");
  });

  it("deixa vazio o que não existe, sem inventar rótulo", () => {
    const docC = linhas[3];
    expect(docC[COL.cliente]).toBe("Petrobras");          // sem grupo: sem parênteses
    expect(docC[COL.periodo]).toBe("desde 01/05/2019");   // período aberto
    expect(docC[COL.tipo]).toBeNull();                    // tipoDocumento null
    expect(docC[COL.disciplina]).toBe("ELE");
  });

  it("devolve lista vazia quando o profissional não tem obra", () => {
    const vazio: DadosCurriculoRt = {
      geradoEm: CURRICULO.geradoEm,
      curriculo: { ...CURRICULO, operacoes: [] },
    };
    expect(linhasCurriculo(vazio)).toEqual([]);
  });
});

// ── Rótulos do cabeçalho (aba 1 e seção PROFISSIONAL do PDF) ─────────────────

describe("textoCrea", () => {
  it("junta registro e UF, e diz “não informado” quando não há registro", () => {
    expect(textoCrea(CURRICULO.profissional)).toBe("0101234567/BA");
    expect(textoCrea({ ...CURRICULO.profissional, creaUf: null })).toBe("0101234567");
    expect(textoCrea({ ...CURRICULO.profissional, crea: null })).toBe("não informado");
    expect(textoCrea({ ...CURRICULO.profissional, crea: null, creaUf: "BA" })).toBe("não informado");
  });
});

describe("notas fixas", () => {
  it("dizem que a quantidade da ART não soma", () => {
    expect(NOTA_QUANTIDADE_ART).toContain("não entra em soma");
  });
});
