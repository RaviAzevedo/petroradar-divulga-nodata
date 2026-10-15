import { describe, it, expect } from "vitest";
import {
  situacaoDossie,
  resumirPainel,
  paraNumero,
  moedaCompacta,
  analisarDocs,
  operacoesPorAno,
  notaAcervo,
  nuvemDisciplinas,
  tabelaCompletude,
  type OperacaoPainel,
  type DocPainel,
  type AnaliseDocs,
  type LinhaCoberturaPainel,
  type ResumoPainel,
} from "@/lib/acervo/painel";

// Fábrica de operação do painel — evita repetir os campos que o caso não exercita.
function op(over: Partial<OperacaoPainel> & { id: string }): OperacaoPainel {
  return {
    codigo: over.id.toUpperCase(),
    clienteNome: "Cliente Exemplo",
    clienteGrupo: null,
    contratoNumero: null,
    detentora: "PROPONENTE",
    periodoInicio: null,
    periodoFim: null,
    valor: null,
    escopo: null,
    totalDocumentos: 0,
    totalAtestados: 0,
    totalArtCat: 0,
    totalContratos: 0,
    ...over,
  };
}

describe("painel (lógica pura do Painel do Acervo)", () => {
  describe("situacaoDossie", () => {
    it("COMPLETO quando há atestado, ART/CAT e contrato", () => {
      const completa = op({
        id: "op-1",
        totalDocumentos: 3,
        totalAtestados: 1,
        totalArtCat: 1,
        totalContratos: 1,
      });
      expect(situacaoDossie(completa)).toBe("COMPLETO");
    });

    it("COMPROVA_INCOMPLETO quando há atestado mas falta o contrato", () => {
      const semContrato = op({
        id: "op-2",
        totalDocumentos: 2,
        totalAtestados: 1,
        totalArtCat: 1,
        totalContratos: 0,
      });
      expect(situacaoDossie(semContrato)).toBe("COMPROVA_INCOMPLETO");
    });

    it("COMPROVA_INCOMPLETO quando há atestado mas falta a ART/CAT", () => {
      const semArt = op({
        id: "op-3",
        totalDocumentos: 2,
        totalAtestados: 2,
        totalArtCat: 0,
        totalContratos: 1,
      });
      expect(situacaoDossie(semArt)).toBe("COMPROVA_INCOMPLETO");
    });

    it("SEM_ATESTADO quando há documentos mas nenhum atestado, mesmo com ART e contrato", () => {
      const soApoio = op({
        id: "op-4",
        totalDocumentos: 2,
        totalAtestados: 0,
        totalArtCat: 1,
        totalContratos: 1,
      });
      expect(situacaoDossie(soApoio)).toBe("SEM_ATESTADO");
    });

    it("VAZIO quando a operação não tem documento nenhum", () => {
      expect(situacaoDossie(op({ id: "op-5" }))).toBe("VAZIO");
    });
  });

  describe("paraNumero", () => {
    it("converte a string numeric do Postgres", () => {
      expect(paraNumero("1234567.89")).toBe(1234567.89);
      expect(paraNumero("3450000000.00")).toBe(3450000000);
      expect(paraNumero("-100.50")).toBe(-100.5);
    });

    it("deixa number passar direto", () => {
      expect(paraNumero(42.5)).toBe(42.5);
      expect(paraNumero(0)).toBe(0);
    });

    it("trata null, NaN e lixo como 0", () => {
      expect(paraNumero(null)).toBe(0);
      expect(paraNumero(Number.NaN)).toBe(0);
      expect(paraNumero(Number.POSITIVE_INFINITY)).toBe(0);
      expect(paraNumero("abc")).toBe(0);
      expect(paraNumero("")).toBe(0);
      expect(paraNumero("   ")).toBe(0);
    });
  });

  describe("moedaCompacta", () => {
    it("zero e negativos viram travessão", () => {
      expect(moedaCompacta(0)).toBe("—");
      expect(moedaCompacta(-5000)).toBe("—");
      expect(moedaCompacta(Number.NaN)).toBe("—");
    });

    it("bate com os exemplos da spec", () => {
      expect(moedaCompacta(950_000)).toBe("R$ 950 mil");
      expect(moedaCompacta(127_400_000)).toBe("R$ 127,4 mi");
      expect(moedaCompacta(3_450_000_000)).toBe("R$ 3,45 bi");
    });

    it("não mostra casa decimal desnecessária", () => {
      expect(moedaCompacta(2_000_000)).toBe("R$ 2 mi");
      expect(moedaCompacta(2_500_000)).toBe("R$ 2,5 mi");
      expect(moedaCompacta(1_000)).toBe("R$ 1 mil");
      expect(moedaCompacta(2_000_000_000)).toBe("R$ 2 bi");
    });

    it("arredonda com vírgula pt-BR", () => {
      expect(moedaCompacta(127_460_000)).toBe("R$ 127,5 mi");
      expect(moedaCompacta(12_300)).toBe("R$ 12,3 mil");
      expect(moedaCompacta(3_499_000_000)).toBe("R$ 3,5 bi");
    });

    it("sobe de escala quando o arredondamento estoura", () => {
      expect(moedaCompacta(999_960)).toBe("R$ 1 mi");
      expect(moedaCompacta(999_960_000)).toBe("R$ 1 bi");
    });

    it("abaixo de mil mostra o valor cheio", () => {
      expect(moedaCompacta(500)).toBe("R$ 500");
    });
  });

  describe("resumirPainel", () => {
    // Fixture canônica de 6 operações — cobre as 4 situações, valores em
    // string/number/null, grupo com espaço em volta e fallback para o nome.
    const OPS: OperacaoPainel[] = [
      op({
        id: "op-1",
        clienteNome: "Petrobras S.A.",
        clienteGrupo: "PETROBRAS",
        contratoNumero: "CT-0001",
        detentora: "PROPONENTE",
        periodoInicio: "2020-01-01",
        periodoFim: "2021-12-31",
        valor: "1000000.00",
        escopo: "Manutenção de poços",
        totalDocumentos: 4,
        totalAtestados: 2,
        totalArtCat: 1,
        totalContratos: 1,
      }), // COMPLETO
      op({
        id: "op-2",
        clienteNome: "Indústria Beta S.A.",
        clienteGrupo: null,
        detentora: "PROPONENTE",
        periodoInicio: "2021-01-01",
        periodoFim: null,
        valor: 500_000,
        totalDocumentos: 2,
        totalAtestados: 1,
        totalArtCat: 1,
        totalContratos: 0,
      }), // COMPROVA_INCOMPLETO
      op({
        id: "op-3",
        clienteNome: "Transpetro",
        clienteGrupo: "PETROBRAS",
        contratoNumero: "CT-0002",
        detentora: "COLIGADA",
        periodoInicio: "2019-05-01",
        periodoFim: "2020-04-30",
        valor: "2000000.50",
        escopo: "Dutos e faixas",
        totalDocumentos: 3,
      }), // SEM_ATESTADO com valor
      op({
        id: "op-4",
        clienteNome: "Indústria Beta S.A.",
        clienteGrupo: null,
        detentora: "PROPONENTE",
        valor: null,
        totalDocumentos: 2,
      }), // SEM_ATESTADO sem valor
      op({
        id: "op-5",
        clienteNome: "Mineradora Gama",
        clienteGrupo: "GAMA",
        contratoNumero: "C-1",
        detentora: "PARCEIRO",
        periodoInicio: "2022-01-01",
        periodoFim: "2022-06-30",
        valor: "0",
        escopo: "Estudo conceitual",
      }), // VAZIO
      op({
        id: "op-6",
        clienteNome: "Petrobras Biocombustível",
        clienteGrupo: "  PETROBRAS  ",
        detentora: "COLIGADA",
        valor: "250000.00",
        totalDocumentos: 5,
        totalAtestados: 1,
        totalArtCat: 2,
        totalContratos: 1,
      }), // COMPLETO, grupo com espaços em volta
    ];

    it("conta as 4 situações", () => {
      const resumo = resumirPainel(OPS);
      expect(resumo.porSituacao).toEqual({
        COMPLETO: 2,
        COMPROVA_INCOMPLETO: 1,
        SEM_ATESTADO: 2,
        VAZIO: 1,
      });
    });

    it("quebra as situações por detentora, só para detentoras presentes", () => {
      const resumo = resumirPainel(OPS);
      expect(Object.keys(resumo.porDetentora).sort()).toEqual([
        "COLIGADA",
        "PARCEIRO",
        "PROPONENTE",
      ]);
      expect(resumo.porDetentora.PROPONENTE).toEqual({
        COMPLETO: 1,
        COMPROVA_INCOMPLETO: 1,
        SEM_ATESTADO: 1,
        VAZIO: 0,
      });
      expect(resumo.porDetentora.COLIGADA).toEqual({
        COMPLETO: 1,
        COMPROVA_INCOMPLETO: 0,
        SEM_ATESTADO: 1,
        VAZIO: 0,
      });
      expect(resumo.porDetentora.PARCEIRO).toEqual({
        COMPLETO: 0,
        COMPROVA_INCOMPLETO: 0,
        SEM_ATESTADO: 0,
        VAZIO: 1,
      });
    });

    it("soma valor total, comprovável (com atestado) e sem atestado", () => {
      const resumo = resumirPainel(OPS);
      expect(resumo.valorTotal).toBeCloseTo(3_750_000.5, 2);
      expect(resumo.valorComprovavel).toBeCloseTo(1_750_000, 2);
      expect(resumo.valorSemAtestado).toBeCloseTo(2_000_000.5, 2);
    });

    it("valorVazio soma o valor das operações VAZIO (fora das barras do card Dinheiro)", () => {
      const resumo = resumirPainel([
        op({ id: "v-a", valor: "300000", totalDocumentos: 0, totalAtestados: 0, totalArtCat: 0, totalContratos: 0 }),
        op({ id: "v-b", valor: "700000", totalDocumentos: 2, totalAtestados: 0 }),
      ]);
      expect(resumo.valorVazio).toBe(300_000);
      expect(resumo.valorSemAtestado).toBe(700_000);
    });

    it("mede a qualidade do cadastro campo a campo", () => {
      const resumo = resumirPainel(OPS);
      // Valor: op-4 é null e op-5 é "0" — não contam.
      // Período: só conta com início E fim (op-2 tem só início).
      expect(resumo.cadastral).toEqual({
        valor: 4,
        periodo: 3,
        contratoNumero: 3,
        grupo: 4,
        escopo: 3,
      });
    });

    it("monta a fila de atestado com valor desc e sem-valor no fim", () => {
      const resumo = resumirPainel(OPS);
      expect(resumo.filaAtestado.map((o) => o.id)).toEqual(["op-3", "op-4"]);
    });

    it("ordena a fila: valor desc; sem valor vai pro fim por documentos desc", () => {
      const fila = resumirPainel([
        op({ id: "f-a", valor: "500000", totalDocumentos: 1 }),
        op({ id: "f-b", valor: "1200000.00", totalDocumentos: 2 }),
        op({ id: "f-c", valor: null, totalDocumentos: 4 }),
        op({ id: "f-d", valor: "0", totalDocumentos: 9 }),
      ]).filaAtestado;
      expect(fila.map((o) => o.id)).toEqual(["f-b", "f-a", "f-d", "f-c"]);
    });

    it("agrupa topClientes por grupo (com trim) e cai no nome quando não há grupo", () => {
      const resumo = resumirPainel(OPS);
      expect(resumo.topClientes.map((c) => c.grupo)).toEqual([
        "PETROBRAS",
        "Indústria Beta S.A.",
        "GAMA",
      ]);

      const petrobras = resumo.topClientes[0];
      expect(petrobras.ops).toBe(3);
      expect(petrobras.valorTotal).toBeCloseTo(3_250_000.5, 2);
      expect(petrobras.valorComprovavel).toBeCloseTo(1_250_000, 2);

      const clienteBeta = resumo.topClientes[1];
      expect(clienteBeta.ops).toBe(2);
      expect(clienteBeta.valorTotal).toBe(500_000);
      expect(clienteBeta.valorComprovavel).toBe(500_000);

      const clienteGama = resumo.topClientes[2];
      expect(clienteGama.ops).toBe(1);
      expect(clienteGama.valorTotal).toBe(0);
      expect(clienteGama.valorComprovavel).toBe(0);
    });

    it("aceita lista vazia sem inventar agregados", () => {
      const resumo = resumirPainel([]);
      expect(resumo.porSituacao).toEqual({
        COMPLETO: 0,
        COMPROVA_INCOMPLETO: 0,
        SEM_ATESTADO: 0,
        VAZIO: 0,
      });
      expect(resumo.porDetentora).toEqual({});
      expect(resumo.valorTotal).toBe(0);
      expect(resumo.valorComprovavel).toBe(0);
      expect(resumo.valorSemAtestado).toBe(0);
      expect(resumo.cadastral).toEqual({
        valor: 0,
        periodo: 0,
        contratoNumero: 0,
        grupo: 0,
        escopo: 0,
      });
      expect(resumo.filaAtestado).toEqual([]);
      expect(resumo.topClientes).toEqual([]);
    });
  });

  describe("porDisciplina (C5 — provabilidade por disciplina)", () => {
    // A disciplina chega da R1 já como objeto ({id, codigo, nome}); o eixo do
    // painel é o CÓDIGO, que é o que a tela mostra e o que vai para a URL do
    // filtro do índice de operações.
    const TUB = { id: "d-1", codigo: "TUB", nome: "Tubulação" };
    const ELE = { id: "d-2", codigo: "ELE", nome: "Elétrica" };
    const INS = { id: "d-3", codigo: "INS", nome: "Instrumentação" };

    it("uma operação com três disciplinas conta 1 em CADA eixo — e a soma das colunas NÃO fecha", () => {
      // É a propriedade do card, não um defeito: "temos quantas obras completas
      // em Instrumentação?" só tem resposta se a mesma obra contar nos três
      // eixos. O card diz isso em texto; aqui a afirmação fica executável.
      const resumo = resumirPainel([
        op({
          id: "op-1",
          disciplinas: [TUB, ELE, INS],
          totalDocumentos: 4,
          totalAtestados: 2,
          totalArtCat: 1,
          totalContratos: 1,
        }), // COMPLETO
      ]);

      expect(resumo.porDisciplina).toEqual({
        TUB: { COMPLETO: 1, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 },
        ELE: { COMPLETO: 1, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 },
        INS: { COMPLETO: 1, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 },
      });

      // A soma das colunas é 3 e o total de operações é 1: o número é maior de
      // propósito. Quem "consertar" isso (contando 1/3 por disciplina, ou só a
      // primeira) quebra a pergunta que o card responde.
      const somaDasColunas = Object.values(resumo.porDisciplina).reduce(
        (acc, s) => acc + s.COMPLETO + s.COMPROVA_INCOMPLETO + s.SEM_ATESTADO + s.VAZIO,
        0,
      );
      expect(somaDasColunas).toBe(3);
      expect(Object.values(resumo.porSituacao).reduce((a, n) => a + n, 0)).toBe(1);
      expect(somaDasColunas).not.toBe(1);

      // E o eixo antigo continua contando a operação UMA vez.
      expect(resumo.porDetentora).toEqual({
        PROPONENTE: { COMPLETO: 1, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 },
      });
    });

    it("operação SEM a chave `disciplinas` não entra em eixo nenhum e não lança", () => {
      // A fábrica `op()` não preenche a chave — é o caso de respostas antigas
      // da API e o motivo de o campo ser OPCIONAL. O `?? []` cuida
      // disso; um "SEM_DISCIPLINA" inventado seria um eixo que ninguém pediu.
      const resumo = resumirPainel([
        op({ id: "op-sem", totalDocumentos: 2, totalAtestados: 1, totalArtCat: 1, totalContratos: 1 }),
      ]);
      expect(resumo.porDisciplina).toEqual({});
      expect(resumo.porSituacao.COMPLETO).toBe(1);
    });

    it("lista de disciplinas vazia é o mesmo que ausente (obra sem disciplina declarada)", () => {
      const resumo = resumirPainel([op({ id: "op-vazia", disciplinas: [], totalDocumentos: 1 })]);
      expect(resumo.porDisciplina).toEqual({});
      expect(resumo.porSituacao.SEM_ATESTADO).toBe(1);
    });

    it("acumula as quatro situações por disciplina, cada obra na situação dela", () => {
      const resumo = resumirPainel([
        op({
          id: "c-1",
          disciplinas: [TUB, ELE],
          totalDocumentos: 4,
          totalAtestados: 2,
          totalArtCat: 1,
          totalContratos: 1,
        }), // COMPLETO
        op({
          id: "c-2",
          disciplinas: [TUB],
          totalDocumentos: 2,
          totalAtestados: 1,
          totalArtCat: 1,
        }), // COMPROVA_INCOMPLETO (sem contrato)
        op({ id: "c-3", disciplinas: [TUB], totalDocumentos: 3 }), // SEM_ATESTADO
        op({ id: "c-4", disciplinas: [ELE] }), // VAZIO
      ]);

      expect(resumo.porDisciplina).toEqual({
        TUB: { COMPLETO: 1, COMPROVA_INCOMPLETO: 1, SEM_ATESTADO: 1, VAZIO: 0 },
        ELE: { COMPLETO: 1, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 1 },
      });
    });

    it("a chave é o CÓDIGO — nunca o uuid nem o nome da disciplina", () => {
      const resumo = resumirPainel([op({ id: "op-k", disciplinas: [TUB], totalDocumentos: 1 })]);
      expect(Object.keys(resumo.porDisciplina)).toEqual(["TUB"]);
      expect(resumo.porDisciplina[TUB.id]).toBeUndefined();
      expect(resumo.porDisciplina[TUB.nome]).toBeUndefined();
    });

    it("duas obras na mesma disciplina somam no MESMO eixo", () => {
      const resumo = resumirPainel([
        op({ id: "m-1", disciplinas: [TUB], totalDocumentos: 3 }),
        op({ id: "m-2", disciplinas: [TUB], totalDocumentos: 1 }),
      ]);
      expect(resumo.porDisciplina.TUB.SEM_ATESTADO).toBe(2);
    });

    it("lista vazia não inventa eixo de disciplina", () => {
      expect(resumirPainel([]).porDisciplina).toEqual({});
    });
  });

  describe("analisarDocs", () => {
    // Fábrica de documento do cofre — default saudável (com tipo, com operação).
    function doc(over: Partial<DocPainel> = {}): DocPainel {
      return {
        tipoDocumento: "ATESTADO",
        situacaoProva: null,
        categoria: "PROVA",
        operacaoId: "op-1",
        status: "VIGENTE",
        validadeFim: null,
        validadeIndeterminada: false,
        criadoEm: "2026-01-01T00:00:00.000Z",
        detentora: "PROPONENTE",
        ...over,
      };
    }

    const HOJE = new Date(2026, 7, 14); // 14/08/2026 local

    it("conta total, órfãos e sem tipo (null e string em branco)", () => {
      const analise = analisarDocs(
        [
          doc(),
          doc({ operacaoId: null }),
          doc({ operacaoId: "   " }),
          doc({ tipoDocumento: null }),
          doc({ tipoDocumento: "  " }),
        ],
        HOJE,
      );
      expect(analise.total).toBe(5);
      expect(analise.orfaos).toBe(2);
      expect(analise.semTipo).toBe(2);
    });

    it("vencidos vêm do status, nunca recalculados pela data", () => {
      const analise = analisarDocs(
        [
          // Validade no passado mas status VIGENTE: NÃO é vencido.
          doc({ validadeFim: "2020-01-01", status: "VIGENTE" }),
          // Status VENCIDO com validade no futuro: é vencido mesmo assim.
          doc({ validadeFim: "2030-01-01", status: "VENCIDO" }),
          doc({ status: "VENCIDO" }),
        ],
        HOJE,
      );
      expect(analise.vencidos).toBe(2);
    });

    it("agrega porTipo desc com 'Sem tipo' e porSituacao desc com 'Indefinida'", () => {
      const analise = analisarDocs(
        [
          doc({ tipoDocumento: "ATESTADO", situacaoProva: "ASSINADA_CLIENTE" }),
          doc({ tipoDocumento: "ATESTADO", situacaoProva: "ASSINADA_CLIENTE" }),
          doc({ tipoDocumento: "ATESTADO", situacaoProva: "RASCUNHO" }),
          doc({ tipoDocumento: "CONTRATO", situacaoProva: null }),
          doc({ tipoDocumento: "CONTRATO", situacaoProva: null }),
          doc({ tipoDocumento: null, situacaoProva: null }),
        ],
        HOJE,
      );
      expect(analise.porTipo).toEqual([
        { tipo: "ATESTADO", n: 3 },
        { tipo: "CONTRATO", n: 2 },
        { tipo: "Sem tipo", n: 1 },
      ]);
      expect(analise.porSituacao).toEqual([
        { situacao: "Indefinida", n: 3 },
        { situacao: "ASSINADA_CLIENTE", n: 2 },
        { situacao: "RASCUNHO", n: 1 },
      ]);
    });

    it("desempata contagens iguais por rótulo asc pt-BR", () => {
      const analise = analisarDocs(
        [doc({ tipoDocumento: "CAT" }), doc({ tipoDocumento: "ART" })],
        HOJE,
      );
      expect(analise.porTipo).toEqual([
        { tipo: "ART", n: 1 },
        { tipo: "CAT", n: 1 },
      ]);
    });

    // Janela = a MESMA do filtro ?vencendoEm=90 do cofre (destino do clique):
    // dias 1..90 — quem vence HOJE já ficou de fora lá; +90 entra.
    it("vencendo90d: amanhã e +90 entram; hoje e +91 ficam fora", () => {
      const analise = analisarDocs(
        [
          doc({ validadeFim: "2026-08-14" }), // hoje (dia 0) → fora (regra do cofre)
          doc({ validadeFim: "2026-08-15" }), // amanhã → conta
          doc({ validadeFim: "2026-11-12" }), // hoje + 90 → conta
          doc({ validadeFim: "2026-11-13" }), // hoje + 91 → fora
          doc({ validadeFim: "2026-08-13" }), // ontem → fora
        ],
        HOJE,
      );
      expect(analise.vencendo90d).toBe(2);
    });

    it("vencendo90d ignora a hora de `hoje` (compara só o dia)", () => {
      const docs = [doc({ validadeFim: "2026-08-15" }), doc({ validadeFim: "2026-11-12" })];
      const madrugada = analisarDocs(docs, new Date(2026, 7, 14, 0, 0, 1));
      const quaseMeiaNoite = analisarDocs(docs, new Date(2026, 7, 14, 23, 59, 59));
      expect(madrugada.vencendo90d).toBe(2);
      expect(quaseMeiaNoite.vencendo90d).toBe(2);
    });

    it("vencendo90d exclui indeterminadas, sem validade e lixo; status NÃO exclui (regra do cofre)", () => {
      const analise = analisarDocs(
        [
          doc({ validadeFim: "2026-09-01", status: "VENCIDO" }), // contradição de dados: conta, como no cofre
          doc({ validadeFim: "2026-09-01", validadeIndeterminada: true }),
          doc({ validadeFim: null }),
          doc({ validadeFim: "não é data" }),
          doc({ validadeFim: "2026-09-01" }),
        ],
        HOJE,
      );
      expect(analise.vencendo90d).toBe(2);
    });

    it("saudaveis conta docs com operação E tipo; órfão+sem-tipo é um defeito só", () => {
      const analise = analisarDocs(
        [
          doc({ operacaoId: "op-1", tipoDocumento: "ART" }), // saudável
          doc({ operacaoId: null, tipoDocumento: null }), // órfão E sem tipo
          doc({ operacaoId: "op-1", tipoDocumento: null }), // só sem tipo
          doc({ operacaoId: null, tipoDocumento: "CAT" }), // só órfão
        ],
        HOJE,
      );
      expect(analise.saudaveis).toBe(1);
      expect(analise.orfaos).toBe(2);
      expect(analise.semTipo).toBe(2);
    });

    it("lista vazia devolve tudo zerado", () => {
      expect(analisarDocs([], HOJE)).toEqual({
        total: 0,
        orfaos: 0,
        semTipo: 0,
        saudaveis: 0,
        vencidos: 0,
        porTipo: [],
        porSituacao: [],
        vencendo90d: 0,
      });
    });
  });

  describe("operacoesPorAno", () => {
    it("agrupa pelo ano de periodoInicio, ordena asc e põe sem-período no fim", () => {
      const faixas = operacoesPorAno([
        op({ id: "a", periodoInicio: "2021-03-01", totalDocumentos: 1 }), // SEM_ATESTADO
        op({ id: "b", periodoInicio: null }), // VAZIO → faixa null
        op({
          id: "c",
          periodoInicio: "2019-01-01",
          totalDocumentos: 3,
          totalAtestados: 1,
          totalArtCat: 1,
          totalContratos: 1,
        }), // COMPLETO
        op({
          id: "d",
          periodoInicio: "2021-07-15",
          totalDocumentos: 2,
          totalAtestados: 1,
        }), // COMPROVA_INCOMPLETO
      ]);

      expect(faixas.map((f) => f.ano)).toEqual([2019, 2021, null]);
      expect(faixas[0].porSituacao).toEqual({
        COMPLETO: 1,
        COMPROVA_INCOMPLETO: 0,
        SEM_ATESTADO: 0,
        VAZIO: 0,
      });
      expect(faixas[1].porSituacao).toEqual({
        COMPLETO: 0,
        COMPROVA_INCOMPLETO: 1,
        SEM_ATESTADO: 1,
        VAZIO: 0,
      });
      expect(faixas[2].porSituacao).toEqual({
        COMPLETO: 0,
        COMPROVA_INCOMPLETO: 0,
        SEM_ATESTADO: 0,
        VAZIO: 1,
      });
    });

    it("periodoInicio em branco ou lixo cai na faixa sem período", () => {
      const faixas = operacoesPorAno([
        op({ id: "a", periodoInicio: "   " }),
        op({ id: "b", periodoInicio: "sem data" }),
      ]);
      expect(faixas).toHaveLength(1);
      expect(faixas[0].ano).toBeNull();
      expect(faixas[0].porSituacao.VAZIO).toBe(2);
    });

    it("sem operações sem período, não inventa a faixa null", () => {
      const faixas = operacoesPorAno([op({ id: "a", periodoInicio: "2020-01-01" })]);
      expect(faixas.map((f) => f.ano)).toEqual([2020]);
    });

    it("lista vazia devolve lista vazia", () => {
      expect(operacoesPorAno([])).toEqual([]);
    });
  });

  describe("notaAcervo", () => {
    function resumoBase(over: Partial<ResumoPainel> = {}): ResumoPainel {
      return {
        porSituacao: { COMPLETO: 0, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 },
        porDetentora: {},
        porDisciplina: {},
        valorTotal: 0,
        valorComprovavel: 0,
        valorSemAtestado: 0,
        valorVazio: 0,
        cadastral: { valor: 0, periodo: 0, contratoNumero: 0, grupo: 0, escopo: 0 },
        filaAtestado: [],
        topClientes: [],
        ...over,
      };
    }

    function analiseBase(over: Partial<AnaliseDocs> = {}): AnaliseDocs {
      return {
        total: 0,
        orfaos: 0,
        semTipo: 0,
        saudaveis: 0,
        vencidos: 0,
        porTipo: [],
        porSituacao: [],
        vencendo90d: 0,
        ...over,
      };
    }

    // Cenário em que os 4 componentes valem exatamente x% → nota = x.
    function cenario(x: number) {
      const resumo = resumoBase({
        valorTotal: 100,
        valorComprovavel: x,
        porSituacao: { COMPLETO: x, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 100 - x },
        cadastral: { valor: x, periodo: x, contratoNumero: x, grupo: x, escopo: x },
      });
      const analise = analiseBase({ total: 100, saudaveis: x });
      return notaAcervo(resumo, analise, 100);
    }

    it("expõe as 4 componentes com pesos 40/25/20/15 e rótulos pt-BR", () => {
      const nota = cenario(50);
      expect(nota.componentes.map((c) => [c.chave, c.peso])).toEqual([
        ["provabilidade", 40],
        ["dossies", 25],
        ["cadastro", 20],
        ["higiene", 15],
      ]);
      for (const componente of nota.componentes) {
        expect(componente.rotulo).not.toBe("");
        expect(componente.valor).toBe(50);
      }
      expect(nota.nota).toBe(50);
    });

    it("cada peso puxa a nota na proporção certa quando só um componente vale 100", () => {
      const soProvabilidade = notaAcervo(
        resumoBase({ valorTotal: 100, valorComprovavel: 100 }),
        analiseBase({ total: 10, orfaos: 10 }),
        10,
      );
      expect(soProvabilidade.nota).toBe(40);

      const soDossies = notaAcervo(
        resumoBase({
          porSituacao: { COMPLETO: 10, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 },
        }),
        analiseBase({ total: 10, semTipo: 10 }),
        10,
      );
      expect(soDossies.nota).toBe(25);

      const soCadastro = notaAcervo(
        resumoBase({
          cadastral: { valor: 10, periodo: 10, contratoNumero: 10, grupo: 10, escopo: 10 },
        }),
        analiseBase({ total: 10, orfaos: 10 }),
        10,
      );
      expect(soCadastro.nota).toBe(20);

      const soHigiene = notaAcervo(
        resumoBase(),
        analiseBase({ total: 10, saudaveis: 10 }),
        10,
      );
      expect(soHigiene.nota).toBe(15);
    });

    it("média do cadastro pondera os 5 campos sobre o total de operações", () => {
      // 3 campos cheios (10/10) e 2 vazios → média 60%.
      const nota = notaAcervo(
        resumoBase({
          cadastral: { valor: 10, periodo: 10, contratoNumero: 10, grupo: 0, escopo: 0 },
        }),
        analiseBase(),
        10,
      );
      const cadastro = nota.componentes.find((c) => c.chave === "cadastro");
      expect(cadastro?.valor).toBe(60);
    });

    it("higiene é a contagem direta de saudáveis sobre o total", () => {
      const nota = notaAcervo(
        resumoBase(),
        analiseBase({ total: 100, orfaos: 20, semTipo: 30, saudaveis: 50 }),
        0,
      );
      const higiene = nota.componentes.find((c) => c.chave === "higiene");
      expect(higiene?.valor).toBe(50);
    });

    it("conceito nas fronteiras exatas: 85/70/55/40 e um ponto abaixo", () => {
      expect(cenario(100).conceito).toBe("A");
      expect(cenario(85).conceito).toBe("A");
      expect(cenario(84).conceito).toBe("B");
      expect(cenario(70).conceito).toBe("B");
      expect(cenario(69).conceito).toBe("C");
      expect(cenario(55).conceito).toBe("C");
      expect(cenario(54).conceito).toBe("D");
      expect(cenario(40).conceito).toBe("D");
      expect(cenario(39).conceito).toBe("E");
      expect(cenario(0).conceito).toBe("E");
    });

    it("arredonda a nota (e o conceito segue a nota arredondada)", () => {
      // Só provabilidade, 61.25% → 40 × 0,6125 = 24,5 → nota 25.
      const nota = notaAcervo(
        resumoBase({ valorTotal: 1000, valorComprovavel: 612.5 }),
        analiseBase(),
        0,
      );
      expect(nota.nota).toBe(25);
      expect(nota.conceito).toBe("E");

      // Os 4 componentes em 84,6% → 84,6 arredonda para 85 → conceito A.
      const resumo = resumoBase({
        valorTotal: 1000,
        valorComprovavel: 846,
        porSituacao: { COMPLETO: 423, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 77 },
        cadastral: { valor: 423, periodo: 423, contratoNumero: 423, grupo: 423, escopo: 423 },
      });
      const quaseA = notaAcervo(resumo, analiseBase({ total: 500, saudaveis: 423 }), 500);
      expect(quaseA.nota).toBe(85);
      expect(quaseA.conceito).toBe("A");
    });

    it("degenerados: 0 ops, 0 docs e valorTotal 0 dão nota 0 sem NaN", () => {
      const nota = notaAcervo(resumoBase(), analiseBase(), 0);
      expect(nota.nota).toBe(0);
      expect(nota.conceito).toBe("E");
      for (const componente of nota.componentes) {
        expect(componente.valor).toBe(0);
        expect(Number.isFinite(componente.valor)).toBe(true);
      }
    });

    it("órfão e sem-tipo sobrepostos contam um defeito só (fim da dupla subtração)", () => {
      // 2 docs: um saudável e um que é AO MESMO TEMPO órfão e sem tipo → 50%.
      const nota = notaAcervo(
        resumoBase(),
        analiseBase({ total: 2, orfaos: 1, semTipo: 1, saudaveis: 1 }),
        0,
      );
      const higiene = nota.componentes.find((c) => c.chave === "higiene");
      expect(higiene?.valor).toBe(50);
    });
  });

  describe("tabelaCompletude", () => {
    const OPS: OperacaoPainel[] = [
      op({
        id: "c-1",
        codigo: "OP-COMPLETA-MENOR",
        valor: "100000",
        totalDocumentos: 3,
        totalAtestados: 1,
        totalArtCat: 1,
        totalContratos: 1,
      }), // COMPLETO, valor menor
      op({
        id: "c-2",
        codigo: "OP-COMPLETA-MAIOR",
        valor: "900000",
        totalDocumentos: 4,
        totalAtestados: 2,
        totalArtCat: 1,
        totalContratos: 2,
      }), // COMPLETO, valor maior
      op({
        id: "p-1",
        codigo: "OP-SEM-ATESTADO",
        valor: "500000",
        totalDocumentos: 2,
        totalContratos: 1,
      }), // SEM_ATESTADO
      op({
        id: "p-2",
        codigo: "OP-INCOMPLETA",
        valor: "800000",
        totalDocumentos: 2,
        totalAtestados: 1,
        totalArtCat: 1,
      }), // COMPROVA_INCOMPLETO
      op({
        id: "p-3",
        codigo: "OP-SEM-VALOR-4DOCS",
        valor: null,
        totalDocumentos: 4,
        totalAtestados: 1,
      }), // COMPROVA_INCOMPLETO sem valor
      op({
        id: "p-4",
        codigo: "OP-SEM-VALOR-9DOCS",
        valor: "0",
        totalDocumentos: 9,
      }), // SEM_ATESTADO valor zero
      op({ id: "v-2", codigo: "OP-VAZIA-B", valor: "999999999" }), // VAZIO
      op({ id: "v-1", codigo: "OP-VAZIA-A" }), // VAZIO
    ];

    it("classifica cada operação na aba certa", () => {
      const tabela = tabelaCompletude(OPS);
      expect(tabela.pendentes.map((l) => l.op.id).sort()).toEqual([
        "p-1",
        "p-2",
        "p-3",
        "p-4",
      ]);
      expect(tabela.completos.map((l) => l.op.id).sort()).toEqual(["c-1", "c-2"]);
      expect(tabela.vazios.map((l) => l.op.id).sort()).toEqual(["v-1", "v-2"]);
    });

    it("pendentes: valor desc, sem valor no fim por documentos desc", () => {
      const tabela = tabelaCompletude(OPS);
      expect(tabela.pendentes.map((l) => l.op.id)).toEqual(["p-2", "p-1", "p-4", "p-3"]);
    });

    it("completos: valor desc; vazios: código asc mesmo com valor alto", () => {
      const tabela = tabelaCompletude(OPS);
      expect(tabela.completos.map((l) => l.op.id)).toEqual(["c-2", "c-1"]);
      expect(tabela.vazios.map((l) => l.op.codigo)).toEqual(["OP-VAZIA-A", "OP-VAZIA-B"]);
    });

    it("preenche situacao e os três checks de `tem`", () => {
      const tabela = tabelaCompletude(OPS);
      const incompleta = tabela.pendentes.find((l) => l.op.id === "p-2");
      expect(incompleta?.situacao).toBe("COMPROVA_INCOMPLETO");
      expect(incompleta?.tem).toEqual({ contrato: false, artCat: true, atestado: true });

      const semAtestado = tabela.pendentes.find((l) => l.op.id === "p-1");
      expect(semAtestado?.situacao).toBe("SEM_ATESTADO");
      expect(semAtestado?.tem).toEqual({ contrato: true, artCat: false, atestado: false });

      const completa = tabela.completos.find((l) => l.op.id === "c-2");
      expect(completa?.situacao).toBe("COMPLETO");
      expect(completa?.tem).toEqual({ contrato: true, artCat: true, atestado: true });
    });

    it("lista vazia devolve as três abas vazias", () => {
      expect(tabelaCompletude([])).toEqual({ pendentes: [], completos: [], vazios: [] });
    });
  });

  // ── D10 — nuvem de cobertura por disciplina ────────────────────────────────
  //
  // A fonte é a resposta de GET /disciplinas/cobertura, recortada
  // em `LinhaCoberturaPainel` — tipo ESTRUTURAL declarado no próprio painel.ts
  // porque `disciplinas/queries.ts` importa `@/db` e este arquivo de teste roda
  // sem Postgres. A fábrica `op()` acima não serve aqui (a nuvem não deriva de
  // `OperacaoPainel`) e por isso não foi tocada.
  describe("nuvemDisciplinas (D10 — cobertura por disciplina)", () => {
    /** Uma linha do C3: código, nome, quantas obras e quantas com atestado. */
    function cob(
      codigo: string,
      operacoes: number,
      comAtestado: number
    ): LinhaCoberturaPainel {
      return { codigo, nome: `Disciplina ${codigo}`, operacoes, comAtestado };
    }

    it("disciplina com ZERO operação não vira palavra: sai de `itens` e entra em `semCobertura`", () => {
      // As duas afirmações juntas são o caso. Desenhá-la com fonte mínima a
      // esconderia justamente quando ela é o achado ("não temos nada provado em
      // Telecom"); desenhá-la com fonte legível mentiria sobre o tamanho.
      const nuvem = nuvemDisciplinas([cob("TUB", 10, 6), cob("TEL", 0, 0), cob("ELE", 4, 3)]);

      expect(nuvem.itens.map((i) => i.codigo)).toEqual(["TUB", "ELE"]);
      expect(nuvem.itens.some((i) => i.codigo === "TEL")).toBe(false);
      expect(nuvem.semCobertura).toEqual([{ codigo: "TEL", nome: "Disciplina TEL" }]);
    });

    it("`peso` é inteiro de 1 a 6, e quem tem `operacoes === maximo` tem peso 6", () => {
      // Degrau tipográfico, não proporção: `1 + round(5 * sqrt(ops / maximo))`.
      // Raiz porque a área percebida de um texto cresce com o QUADRADO do
      // corpo — 4× mais obras não podem parecer 16× maiores.
      const nuvem = nuvemDisciplinas([
        cob("MAX", 400, 100),
        cob("MED", 144, 50),
        cob("MIN", 1, 0),
      ]);

      expect(nuvem.maximo).toBe(400);
      for (const item of nuvem.itens) {
        expect(Number.isInteger(item.peso), item.codigo).toBe(true);
        expect(item.peso, item.codigo).toBeGreaterThanOrEqual(1);
        expect(item.peso, item.codigo).toBeLessThanOrEqual(6);
      }
      expect(nuvem.itens[0].peso).toBe(6); // ops === maximo
      expect(nuvem.itens[1].peso).toBe(4); // sqrt(144/400) = 0,6 → 1 + 3
      expect(nuvem.itens[2].peso).toBe(1); // sqrt(1/400) = 0,05 → 1 + 0, preso no piso
    });

    it("`maximo === 0` (nenhuma disciplina tem obra): `itens` vazio e nenhuma divisão por zero", () => {
      const nuvem = nuvemDisciplinas([cob("TEL", 0, 0), cob("AUT", 0, 0)]);
      expect(nuvem.maximo).toBe(0);
      expect(nuvem.itens).toEqual([]);
      expect(nuvem.semCobertura.map((s) => s.codigo)).toEqual(["TEL", "AUT"]);
    });

    it("nenhum `peso` ou `provado` sai NaN/Infinity num catálogo misto", () => {
      // `ops / maximo` e `comAtestado / operacoes` são as duas divisões da
      // função. A primeira só roda com `maximo > 0` (quem tem 0 obra já saiu) e
      // a segunda só com `operacoes > 0`, pelo mesmo motivo — este caso é o que
      // trava as duas guardas juntas.
      const nuvem = nuvemDisciplinas([
        cob("TEL", 0, 0),
        cob("TUB", 300, 300),
        cob("ELE", 1, 0),
        cob("CIV", 0, 0),
      ]);
      for (const item of nuvem.itens) {
        expect(Number.isFinite(item.peso), item.codigo).toBe(true);
        expect(Number.isFinite(item.provado), item.codigo).toBe(true);
        expect(item.provado, item.codigo).toBeGreaterThanOrEqual(0);
        expect(item.provado, item.codigo).toBeLessThanOrEqual(1);
      }
      expect(nuvem.itens.map((i) => i.codigo)).toEqual(["TUB", "ELE"]);
    });

    it("`provado` é comAtestado/operacoes — 0,75 em {4, 3}; e 0 quando não há obra", () => {
      // `provado` COLORE e `peso` DIMENSIONA: duas variáveis visuais para as
      // duas perguntas ("quanto fizemos" e "quanto está provado"), sem
      // multiplicá-las num índice que ninguém sabe ler.
      const nuvem = nuvemDisciplinas([cob("ELE", 4, 3), cob("TUB", 5, 0), cob("CIV", 2, 2)]);
      expect(nuvem.itens[0].provado).toBe(0.75);
      expect(nuvem.itens[1].provado).toBe(0);
      expect(nuvem.itens[2].provado).toBe(1);

      // Com `operacoes: 0` o `provado` seria 0/0 — a linha nem chega a `itens`.
      const semObra = nuvemDisciplinas([cob("TEL", 0, 0)]);
      expect(semObra.itens).toEqual([]);
    });

    it("não ordena por peso: `itens` sai na ordem de entrada (a do catálogo)", () => {
      // Ordem estável na função = teste estável; quem embaralha para o layout é
      // a tela.
      const nuvem = nuvemDisciplinas([cob("ZZZ", 1, 0), cob("AAA", 50, 40), cob("MMM", 7, 2)]);
      expect(nuvem.itens.map((i) => i.codigo)).toEqual(["ZZZ", "AAA", "MMM"]);
      expect(nuvem.semCobertura).toEqual([]);
    });

    it("`nuvemDisciplinas([])` devolve `{ itens: [], semCobertura: [], maximo: 0 }`", () => {
      expect(nuvemDisciplinas([])).toEqual({ itens: [], semCobertura: [], maximo: 0 });
    });

    it("carrega código, nome e os dois contadores para dentro do item", () => {
      const [item] = nuvemDisciplinas([cob("TUB", 12, 9)]).itens;
      expect(item).toEqual({
        codigo: "TUB",
        nome: "Disciplina TUB",
        operacoes: 12,
        comAtestado: 9,
        provado: 0.75,
        peso: 6,
      });
    });
  });
});
