import { describe, it, expect } from "vitest";
import {
  PAPEIS_DOCUMENTO,
  PAPEL_DOCUMENTO_LABELS,
  DETENTORAS,
  DETENTORA_LABELS,
  ORIGENS_OPERACAO,
  ORIGEM_OPERACAO_LABELS,
  sha256Hex,
  classificarRelacao,
  normalizarNumeroDocumento,
  tituloSugerido,
  type ArquivoDoLote,
  type DocumentoNoCofre,
  type DuplicataNoCofre,
  type RelacaoArquivo,
} from "@/lib/conformidade/operacoes";

// Fábrica de arquivo do lote — evita repetir os campos que o caso não exercita.
function arquivo(over: Partial<ArquivoDoLote> & { chave: string }): ArquivoDoLote {
  return {
    nomeArquivo: `${over.chave}.pdf`,
    sha256: "",
    operacaoId: null,
    numeroDocumento: null,
    ...over,
  };
}

function porChave(relacoes: RelacaoArquivo[], chave: string): RelacaoArquivo {
  const achada = relacoes.find((r) => r.chave === chave);
  if (!achada) throw new Error(`relação não encontrada para a chave ${chave}`);
  return achada;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const DOC_NO_COFRE: DuplicataNoCofre = {
  id: "doc-cofre-1",
  titulo: "90008 - ACT Planta Alfa",
  criadoEm: "2026-01-10T12:00:00.000Z",
  operacaoCodigo: "90008",
};

describe("operacoes (domínio do cofre por operação)", () => {
  describe("rótulos e tuplas", () => {
    it("mantém a ordem de exibição dos papéis (atestado primeiro)", () => {
      expect(PAPEIS_DOCUMENTO[0]).toBe("ATESTADO");
      expect([...PAPEIS_DOCUMENTO]).toEqual([
        "ATESTADO",
        "CAT_ART",
        "CONTRATO",
        "ADITIVO",
        "NOTA_FISCAL",
        "DECLARACAO",
        "OUTRO",
      ]);
    });

    it("tem rótulo em pt-BR para todo papel, detentora e origem", () => {
      for (const papel of PAPEIS_DOCUMENTO) {
        expect(PAPEL_DOCUMENTO_LABELS[papel].length).toBeGreaterThan(1);
      }
      for (const detentora of DETENTORAS) {
        expect(DETENTORA_LABELS[detentora].length).toBeGreaterThan(1);
      }
      for (const origem of ORIGENS_OPERACAO) {
        expect(ORIGEM_OPERACAO_LABELS[origem].length).toBeGreaterThan(1);
      }
    });

    it("cobre os três valores de detentora do CHECK da migration", () => {
      expect([...DETENTORAS]).toEqual(["PROPONENTE", "COLIGADA", "PARCEIRO"]);
    });
  });

  describe("sha256Hex", () => {
    it("bate com o vetor conhecido de \"abc\"", async () => {
      const hash = await sha256Hex(new Blob(["abc"]));
      expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("bate com o vetor conhecido do arquivo vazio", async () => {
      const hash = await sha256Hex(new Blob([]));
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("devolve 64 caracteres hexadecimais minúsculos", async () => {
      const hash = await sha256Hex(new Blob([new Uint8Array([0, 1, 15, 16, 255])]));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("dá o mesmo hash para o mesmo conteúdo em arquivos de nomes diferentes", async () => {
      const um = await sha256Hex(new File(["conteúdo idêntico"], "ACT-2021.pdf"));
      const outro = await sha256Hex(new File(["conteúdo idêntico"], "copia (1).pdf"));
      expect(um).toBe(outro);
    });
  });

  describe("normalizarNumeroDocumento", () => {
    it("ignora pontuação e caixa", () => {
      expect(normalizarNumeroDocumento("123/2021")).toBe("1232021");
      expect(normalizarNumeroDocumento("123-2021")).toBe("1232021");
      expect(normalizarNumeroDocumento(" act 123/2021 ")).toBe("ACT1232021");
    });

    it("trata ausência de número como string vazia", () => {
      expect(normalizarNumeroDocumento(null)).toBe("");
      expect(normalizarNumeroDocumento(undefined)).toBe("");
      expect(normalizarNumeroDocumento("   ")).toBe("");
    });
  });

  describe("classificarRelacao — DUPLICATA", () => {
    it("marca o arquivo cujo hash o /verificar devolveu", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: SHA_A })],
        existentesPorSha: { [SHA_A]: DOC_NO_COFRE },
      });

      const r = porChave(relacoes, "f1");
      expect(r.relacao).toBe("DUPLICATA");
      expect(r.origem).toBe("COFRE");
      expect(r.documentoRelacionadoId).toBe("doc-cofre-1");
      expect(r.duplicataNoCofre).toEqual(DOC_NO_COFRE);
      expect(r.bloqueia).toBe(true);
      expect(r.motivo).toContain("já está no cofre");
    });

    it("pega dois arquivos idênticos DENTRO do mesmo lote (o caso que passava batido)", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", nomeArquivo: "ACT-90008.pdf", sha256: SHA_A }),
          arquivo({ chave: "f2", nomeArquivo: "ACT-90008 (1).pdf", sha256: SHA_A }),
        ],
        existentesPorSha: {},
      });

      // A primeira ocorrência sobrevive; só a segunda é duplicata.
      expect(porChave(relacoes, "f1").relacao).toBe("NOVO");
      expect(porChave(relacoes, "f1").bloqueia).toBe(false);

      const segunda = porChave(relacoes, "f2");
      expect(segunda.relacao).toBe("DUPLICATA");
      expect(segunda.origem).toBe("LOTE");
      expect(segunda.chaveRelacionada).toBe("f1");
      expect(segunda.bloqueia).toBe(true);
      expect(segunda.motivo).toContain("ACT-90008.pdf");
    });

    it("marca a terceira cópia também, apontando sempre a primeira", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A }),
          arquivo({ chave: "f2", sha256: SHA_A }),
          arquivo({ chave: "f3", sha256: SHA_A }),
        ],
        existentesPorSha: {},
      });

      expect(relacoes.map((r) => r.relacao)).toEqual(["NOVO", "DUPLICATA", "DUPLICATA"]);
      expect(porChave(relacoes, "f3").chaveRelacionada).toBe("f1");
    });

    it("compara hash sem se importar com caixa nem espaço em volta", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: ` ${SHA_A.toUpperCase()} ` })],
        existentesPorSha: { [SHA_A]: DOC_NO_COFRE },
      });
      expect(porChave(relacoes, "f1").relacao).toBe("DUPLICATA");
    });

    it("vence ANEXO, VERSAO e IRMAO — duplicata é a relação de maior precedência", () => {
      const cofre: DocumentoNoCofre[] = [
        { id: "d1", titulo: "Contrato 90008", operacaoId: "op-1", numeroDocumento: "123/2021" },
      ];
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({
            chave: "f1",
            sha256: SHA_A,
            operacaoId: "op-1",
            numeroDocumento: "123/2021",
            anexoDeDocumentoId: "d1",
          }),
        ],
        existentesPorSha: { [SHA_A]: DOC_NO_COFRE },
        documentosNoCofre: cofre,
      });
      expect(porChave(relacoes, "f1").relacao).toBe("DUPLICATA");
    });

    it("não acusa duplicata quando o hash ainda não foi calculado", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: "" }), arquivo({ chave: "f2", sha256: "" })],
        existentesPorSha: {},
      });
      expect(relacoes.every((r) => r.relacao !== "DUPLICATA")).toBe(true);
    });
  });

  describe("classificarRelacao — ANEXO", () => {
    it("usa o título do pai quando ele está na lista do cofre", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: SHA_A, anexoDeDocumentoId: "d1" })],
        existentesPorSha: {},
        documentosNoCofre: [
          { id: "d1", titulo: "ACT Planta Alfa", operacaoId: "op-1", numeroDocumento: null },
        ],
      });

      const r = porChave(relacoes, "f1");
      expect(r.relacao).toBe("ANEXO");
      expect(r.origem).toBe("COFRE");
      expect(r.documentoRelacionadoId).toBe("d1");
      expect(r.motivo).toContain("ACT Planta Alfa");
      expect(r.bloqueia).toBe(false);
    });

    it("aceita pai do cofre mesmo sem conhecer o título dele", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: SHA_A, anexoDeDocumentoId: "d-desconhecido" })],
        existentesPorSha: {},
      });

      const r = porChave(relacoes, "f1");
      expect(r.relacao).toBe("ANEXO");
      expect(r.documentoRelacionadoId).toBe("d-desconhecido");
      expect(r.motivo).toBe("Anexo de um documento já existente no cofre.");
    });

    it("aceita pai que é outro arquivo do mesmo lote (a CAT que instrui o atestado)", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", nomeArquivo: "ATESTADO.pdf", sha256: SHA_A, operacaoId: "op-1" }),
          arquivo({ chave: "f2", nomeArquivo: "CAT.pdf", sha256: SHA_B, operacaoId: "op-1", anexoDeChave: "f1" }),
        ],
        existentesPorSha: {},
      });

      const r = porChave(relacoes, "f2");
      expect(r.relacao).toBe("ANEXO");
      expect(r.origem).toBe("LOTE");
      expect(r.chaveRelacionada).toBe("f1");
      expect(r.motivo).toContain("ATESTADO.pdf");
    });

    it("ganha de VERSAO e IRMAO quando o usuário aponta o pai", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
          arquivo({
            chave: "f2",
            sha256: SHA_B,
            operacaoId: "op-1",
            numeroDocumento: "123/2021",
            anexoDeChave: "f1",
          }),
        ],
        existentesPorSha: {},
      });
      expect(porChave(relacoes, "f2").relacao).toBe("ANEXO");
    });

    it("ignora ponteiro quebrado e cai na heurística", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", nomeArquivo: "ATESTADO.pdf", sha256: SHA_A, operacaoId: "op-1" }),
          arquivo({ chave: "f2", sha256: SHA_B, operacaoId: "op-1", anexoDeChave: "nao-existe" }),
        ],
        existentesPorSha: {},
      });
      expect(porChave(relacoes, "f2").relacao).toBe("IRMAO");
    });

    it("ignora arquivo que aponta para si mesmo", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: SHA_A, anexoDeChave: "f1" })],
        existentesPorSha: {},
      });
      expect(porChave(relacoes, "f1").relacao).toBe("NOVO");
    });
  });

  describe("classificarRelacao — VERSAO", () => {
    it("reconhece mesmo número de documento na mesma operação já no cofre", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
        ],
        existentesPorSha: {},
        documentosNoCofre: [
          { id: "d1", titulo: "ACT 123", operacaoId: "op-1", numeroDocumento: "123-2021" },
        ],
      });

      const r = porChave(relacoes, "f1");
      expect(r.relacao).toBe("VERSAO");
      expect(r.origem).toBe("COFRE");
      expect(r.documentoRelacionadoId).toBe("d1");
      expect(r.motivo).toContain("nova versão");
      expect(r.bloqueia).toBe(false);
    });

    it("marca os DOIS lados quando as versões estão no mesmo lote", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", nomeArquivo: "ACT rev0.pdf", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
          arquivo({ chave: "f2", nomeArquivo: "ACT rev1.pdf", sha256: SHA_B, operacaoId: "op-1", numeroDocumento: "123/2021" }),
        ],
        existentesPorSha: {},
      });

      expect(relacoes.map((r) => r.relacao)).toEqual(["VERSAO", "VERSAO"]);
      expect(porChave(relacoes, "f1").chaveRelacionada).toBe("f2");
      expect(porChave(relacoes, "f2").chaveRelacionada).toBe("f1");
    });

    it("dá preferência ao documento do cofre sobre o irmão do lote", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
          arquivo({ chave: "f2", sha256: SHA_B, operacaoId: "op-1", numeroDocumento: "123/2021" }),
        ],
        existentesPorSha: {},
        documentosNoCofre: [
          { id: "d1", titulo: "ACT 123", operacaoId: "op-1", numeroDocumento: "123/2021" },
        ],
      });
      expect(porChave(relacoes, "f1").origem).toBe("COFRE");
      expect(porChave(relacoes, "f1").documentoRelacionadoId).toBe("d1");
    });

    it("não confunde mesmo número em OPERAÇÕES diferentes", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
        ],
        existentesPorSha: {},
        documentosNoCofre: [
          { id: "d1", titulo: "Outra operação", operacaoId: "op-2", numeroDocumento: "123/2021" },
        ],
      });
      expect(porChave(relacoes, "f1").relacao).toBe("NOVO");
    });
  });

  describe("classificarRelacao — IRMAO", () => {
    it("reconhece prova adicional de operação que já tem documento no cofre", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "999/2022" }),
        ],
        existentesPorSha: {},
        documentosNoCofre: [
          { id: "d1", titulo: "ACT 123", operacaoId: "op-1", numeroDocumento: "123/2021" },
        ],
      });

      const r = porChave(relacoes, "f1");
      expect(r.relacao).toBe("IRMAO");
      expect(r.origem).toBe("COFRE");
      expect(r.documentoRelacionadoId).toBe("d1");
      expect(r.bloqueia).toBe(false);
    });

    it("marca os dois lados quando os irmãos estão no mesmo lote", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", nomeArquivo: "ATESTADO.pdf", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
          arquivo({ chave: "f2", nomeArquivo: "CONTRATO.pdf", sha256: SHA_B, operacaoId: "op-1", numeroDocumento: "456/2021" }),
        ],
        existentesPorSha: {},
      });

      expect(relacoes.map((r) => r.relacao)).toEqual(["IRMAO", "IRMAO"]);
      expect(porChave(relacoes, "f1").chaveRelacionada).toBe("f2");
      expect(porChave(relacoes, "f2").chaveRelacionada).toBe("f1");
    });

    it("trata como irmãos os arquivos da mesma operação SEM número", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1" }),
          arquivo({ chave: "f2", sha256: SHA_B, operacaoId: "op-1" }),
        ],
        existentesPorSha: {},
      });
      expect(relacoes.map((r) => r.relacao)).toEqual(["IRMAO", "IRMAO"]);
    });
  });

  describe("classificarRelacao — NOVO e contrato de saída", () => {
    it("não inventa relação quando a operação ainda não foi escolhida", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, numeroDocumento: "123/2021" }),
          arquivo({ chave: "f2", sha256: SHA_B, numeroDocumento: "123/2021" }),
        ],
        existentesPorSha: {},
      });

      expect(relacoes.map((r) => r.relacao)).toEqual(["NOVO", "NOVO"]);
      expect(porChave(relacoes, "f1").motivo).toContain("operação ainda não foi escolhida");
    });

    it("chama de NOVO a primeira prova de uma operação sem nada no cofre", () => {
      const relacoes = classificarRelacao({
        arquivos: [arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1" })],
        existentesPorSha: {},
        documentosNoCofre: [
          { id: "d1", titulo: "Outra", operacaoId: "op-2", numeroDocumento: null },
        ],
      });

      const r = porChave(relacoes, "f1");
      expect(r.relacao).toBe("NOVO");
      expect(r.origem).toBeNull();
      expect(r.chaveRelacionada).toBeNull();
      expect(r.documentoRelacionadoId).toBeNull();
      expect(r.duplicataNoCofre).toBeNull();
    });

    it("devolve um resultado por arquivo, na mesma ordem da entrada", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A }),
          arquivo({ chave: "f2", sha256: SHA_B }),
          arquivo({ chave: "f3", sha256: SHA_A }),
        ],
        existentesPorSha: {},
      });
      expect(relacoes.map((r) => r.chave)).toEqual(["f1", "f2", "f3"]);
    });

    it("aceita lote vazio", () => {
      expect(classificarRelacao({ arquivos: [], existentesPorSha: {} })).toEqual([]);
    });

    it("só bloqueia duplicata", () => {
      const relacoes = classificarRelacao({
        arquivos: [
          arquivo({ chave: "f1", sha256: SHA_A, operacaoId: "op-1", numeroDocumento: "123/2021" }),
          arquivo({ chave: "f2", sha256: SHA_B, operacaoId: "op-1", numeroDocumento: "123/2021" }),
          arquivo({ chave: "f3", sha256: SHA_A, operacaoId: "op-1" }),
        ],
        existentesPorSha: {},
      });
      expect(relacoes.filter((r) => r.bloqueia).map((r) => r.chave)).toEqual(["f3"]);
    });
  });

  describe("tituloSugerido", () => {
    it("tira o código da operação digitado à mão no começo do nome", () => {
      expect(tituloSugerido("90008 - Planta Alfa.pdf", "90008")).toBe("Planta Alfa");
    });

    it("tira o código quando ele vem colado por underscore", () => {
      expect(tituloSugerido("90008_ACT_Transpetro.pdf", "90008")).toBe("ACT Transpetro");
    });

    it("tira o código repetido", () => {
      expect(tituloSugerido("90008 - 90008 - ACT.pdf", "90008")).toBe("ACT");
    });

    it("mantém o nome quando não há código a remover", () => {
      expect(tituloSugerido("Contrato de manutenção.pdf")).toBe("Contrato de manutenção");
      expect(tituloSugerido("Contrato de manutenção.pdf", null)).toBe("Contrato de manutenção");
    });

    it("não corta número que apenas começa igual ao código", () => {
      expect(tituloSugerido("900081 - ACT.pdf", "90008")).toBe("900081 ACT");
    });

    it("não devolve título vazio quando o nome é só o código", () => {
      expect(tituloSugerido("90008.pdf", "90008")).toBe("90008");
    });

    it("trata código com pontuação sem quebrar a regex", () => {
      expect(tituloSugerido("90.008 - ACT.pdf", "90.008")).toBe("ACT");
    });

    it("respeita o limite de 200 caracteres do título do cofre", () => {
      const titulo = tituloSugerido(`${"A".repeat(300)}.pdf`, "90008");
      expect(titulo).toHaveLength(200);
    });
  });
});
