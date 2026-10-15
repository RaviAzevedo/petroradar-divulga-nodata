import { describe, it, expect } from "vitest";
import {
  criarLinha,
  categoriaDaLinha,
  montarFormData,
  mudancaDeTipo,
  operacaoResumoDoDetalhe,
  palpitarSituacaoProva,
  palpitarTipoDocumento,
  type CamposComuns,
  type DocumentoDoDossie,
  type OperacaoDetalhe,
} from "@/app/acervo/cofre/novo/lote";

// Fábrica de arquivo — o conteúdo não importa, os palpites olham só o nome.
function arquivo(nome: string): File {
  return new File(["conteudo"], nome, { type: "application/pdf" });
}

function comuns(over: Partial<CamposComuns> = {}): CamposComuns {
  return { descricao: "", tags: [], detentora: "", ...over };
}

describe("lote (tela Subir provas da operação — upload v2)", () => {
  describe("palpitarTipoDocumento", () => {
    it("primeira regra que casa vence: CAT antes de ATESTADO", () => {
      expect(palpitarTipoDocumento("ATESTADO CAT 890-2015.pdf")).toBe("CAT");
    });

    it("ART pelo termo, pelo prefixo AP_ART e pelo número BA20…", () => {
      expect(palpitarTipoDocumento("ART Rascunho BA20230012345.pdf")).toBe("ART");
      expect(palpitarTipoDocumento("AP_ART_90008.pdf")).toBe("ART");
      expect(palpitarTipoDocumento("BA20230012345.pdf")).toBe("ART");
    });

    it("CATÁLOGO não vira CAT (lookahead do plano)", () => {
      expect(palpitarTipoDocumento("CATÁLOGO de bombas.pdf")).toBeNull();
    });

    it("reconhece os demais tipos da tabela", () => {
      expect(palpitarTipoDocumento("Atestado de Capacidade Técnica ACME.pdf")).toBe("ATESTADO");
      expect(palpitarTipoDocumento("Contrato ICJ 4600.pdf")).toBe("CONTRATO");
      expect(palpitarTipoDocumento("NFSE 1234 Camaçari.pdf")).toBe("NF");
      expect(palpitarTipoDocumento("acervo 2015.zip")).toBe("COMPACTADO");
      expect(palpitarTipoDocumento("ISO 14001 certificado.pdf")).toBe("ISO");
      expect(palpitarTipoDocumento("Declaração de idoneidade.pdf")).toBe("DECLARACAO");
    });

    it("sem regra casando devolve null, nunca OUTRO (OUTRO é decisão humana)", () => {
      expect(palpitarTipoDocumento("documento sem cara.pdf")).toBeNull();
    });
  });

  describe("palpitarSituacaoProva", () => {
    it("cobre os cinco gatilhos do plano", () => {
      expect(palpitarSituacaoProva("Minuta contrato.pdf")).toBe("RASCUNHO");
      expect(palpitarSituacaoProva("atestado superado.pdf")).toBe("SUPERADA");
      expect(palpitarSituacaoProva("contrato cancelado.pdf")).toBe("CANCELADA");
      expect(palpitarSituacaoProva("modelo de proposta.pdf")).toBe("MODELO");
      // "ASSINAD" vira Proponente — promover a cliente é decisão humana.
      expect(palpitarSituacaoProva("ACT assinado ACME.pdf")).toBe("ASSINADA_PROPONENTE");
    });

    it("nome mudo devolve null (não avaliada)", () => {
      expect(palpitarSituacaoProva("atestado acme.pdf")).toBeNull();
    });
  });

  describe("mudancaDeTipo (derivação: o tipo é UMA decisão)", () => {
    it("tipo novo reescreve papel e subcategoria pelo mapa canônico", () => {
      expect(mudancaDeTipo("ATESTADO", "x.pdf")).toEqual({
        tipoDocumento: "ATESTADO",
        papel: "ATESTADO",
        subcategoria: "ATESTADO_ACT",
      });
    });

    it("exceção ISO: a norma sai do nome do arquivo", () => {
      expect(mudancaDeTipo("ISO", "ISO 14001.pdf").subcategoria).toBe("ISO_14001");
      expect(mudancaDeTipo("ISO", "ISO 45001.pdf").subcategoria).toBe("ISO_45001");
      expect(mudancaDeTipo("ISO", "certificado ISO.pdf").subcategoria).toBe("ISO_9001");
    });

    it("voltar a '— sem tipo' só destrava: não mexe em papel/subcategoria", () => {
      expect(mudancaDeTipo(null, "x.pdf")).toEqual({ tipoDocumento: null });
    });
  });

  describe("categoriaDaLinha", () => {
    it("com tipo, vale o mapa canônico (contrato é JURIDICA mesmo com subcategoria OUTRO)", () => {
      expect(categoriaDaLinha({ tipoDocumento: "CONTRATO", subcategoria: "OUTRO" })).toBe(
        "JURIDICA"
      );
    });

    it("sem tipo, vale a categoria da subcategoria (caminho antigo)", () => {
      expect(categoriaDaLinha({ tipoDocumento: null, subcategoria: "OUTRO" })).toBe("DECLARACAO");
    });
  });

  describe("criarLinha", () => {
    it("palpita tipo e situação pelo nome e deriva papel/subcategoria", () => {
      const linha = criarLinha(arquivo("ART Rascunho BA20230012345.pdf"), null);
      expect(linha.tipoDocumento).toBe("ART");
      expect(linha.papel).toBe("CAT_ART");
      expect(linha.subcategoria).toBe("ART_CAT");
      expect(linha.situacaoProva).toBe("RASCUNHO");
      expect(linha.restrito).toBe(false);
    });

    it("chamada antiga (sem o 3º parâmetro) continua valendo", () => {
      const linha = criarLinha(arquivo("documento sem cara.pdf"), "90008");
      expect(linha.tipoDocumento).toBeNull();
      expect(linha.situacaoProva).toBeNull();
      expect(linha.restrito).toBe(false);
    });

    it("tipo do link vence o palpite e deriva papel/subcategoria (?papel=&tipo=)", () => {
      const linha = criarLinha(arquivo("documento sem cara.pdf"), null, {
        papel: "ATESTADO",
        tipo: "ATESTADO",
      });
      expect(linha.tipoDocumento).toBe("ATESTADO");
      expect(linha.papel).toBe("ATESTADO");
      expect(linha.subcategoria).toBe("ATESTADO_ACT");
    });

    it("papel do link vence palpitarPapel quando não há tipo", () => {
      const linha = criarLinha(arquivo("documento sem cara.pdf"), null, { papel: "CONTRATO" });
      expect(linha.tipoDocumento).toBeNull();
      expect(linha.papel).toBe("CONTRATO");
    });
  });

  describe("montarFormData (campos novos de R7)", () => {
    it("manda tipo, situação, restrito e detentora quando presentes", () => {
      const linha = criarLinha(arquivo("Contrato ICJ 4600.pdf"), null);
      linha.situacaoProva = "ASSINADA_PROPONENTE";
      linha.restrito = true;
      linha.validadeIndeterminada = true;

      const fd = montarFormData(linha, null, comuns({ detentora: "PROPONENTE" }));
      expect(fd.get("tipoDocumento")).toBe("CONTRATO");
      expect(fd.get("situacaoProva")).toBe("ASSINADA_PROPONENTE");
      expect(fd.get("restrito")).toBe("true");
      expect(fd.get("detentora")).toBe("PROPONENTE");
      // Categoria do mapa canônico, não da subcategoria OUTRO (→ DECLARACAO).
      expect(fd.get("categoria")).toBe("JURIDICA");
    });

    it("retrocompatível: sem os campos novos, nada deles vai no multipart", () => {
      const linha = criarLinha(arquivo("documento sem cara.pdf"), null);
      linha.validadeIndeterminada = true;

      const fd = montarFormData(linha, null, comuns());
      expect(fd.has("tipoDocumento")).toBe(false);
      expect(fd.has("situacaoProva")).toBe(false);
      expect(fd.has("restrito")).toBe(false);
      expect(fd.has("detentora")).toBe(false);
    });
  });

  describe("operacaoResumoDoDetalhe (chegada por ?operacaoId=)", () => {
    it("conta atestados pela regra da barra (rascunho fora; legado por papel dentro)", () => {
      const documentos: DocumentoDoDossie[] = [
        { tipoDocumento: "ATESTADO", papel: "ATESTADO", situacaoProva: null },
        { tipoDocumento: "ATESTADO", papel: "ATESTADO", situacaoProva: "RASCUNHO" },
        { tipoDocumento: null, papel: "ATESTADO", situacaoProva: "INDEFINIDA" },
        { tipoDocumento: "CONTRATO", papel: "CONTRATO", situacaoProva: null },
      ];
      const detalhe: OperacaoDetalhe = {
        id: "op-1",
        codigo: "90006",
        clienteNome: "ACME BRASIL",
        clienteGrupo: "Acme",
        contratoNumero: "12.0001.000001",
        unidade: null,
        detentora: "PROPONENTE",
        documentos,
      };

      const resumo = operacaoResumoDoDetalhe(detalhe);
      expect(resumo.totalDocumentos).toBe(4);
      expect(resumo.totalAtestados).toBe(2);
      expect(resumo.codigo).toBe("90006");
      expect(resumo.detentora).toBe("PROPONENTE");
    });
  });
});
