/**
 * Relatório "Currículo técnico do responsável técnico" (slug "curriculo-rt") — C1:
 * o acervo de UMA pessoa em arquivo. Obras, disciplinas e atividades de ART
 * de um profissional, com os documentos que provam — o anexo que
 * acompanha o atestado numa habilitação ou numa diligência.
 *
 * É um relatório PARAMETRIZADO: recebe `profissionalId` pela query string que o
 * handler único de /api/relatorios/[tipo] repassa em `params` (spec ONDA-2 §1a /
 * ONDA-4 §1k). Por isso é `ocultoNoHub`: um card sem o campo "profissional" só
 * produziria erro — quem o chama são os dois botões da página
 * /acervo/profissionais/[id] (§5.10).
 *
 * Quatro regras deste arquivo:
 *
 * 1. UMA SÓ FUNÇÃO DECIDE O QUE É O CURRÍCULO. `coletarCurriculoRt` valida com o
 *    MESMO `CurriculoQuerySchema` da rota e chama a MESMA `curriculoDoProfissional`
 *    que a tela usa (Q10.6). Nada é recalculado aqui — nem `restricaoVisivel`:
 *    o arquivo é o retrato exato da tela.
 *
 * 2. QUANTIDADE É TEXTO. `quantidadeTexto` da atividade é a quantidade como
 *    está ESCRITA na ART ("3.600,00 HH"): texto do documento, que não entra em
 *    soma nenhuma (§1c).
 *
 * 3. PDF SEM FALLBACK SILENCIOSO (§1e da onda 2). Falha ao gerar o PDF SOBE para
 *    a rota (500 logado); nunca se devolve `.xlsx` a quem pediu `.pdf` — é um
 *    anexo de habilitação. Parâmetro inválido sobe como `ApiError(422,
 *    "VALIDATION")` e profissional inexistente como `ApiError(404, "NOT_FOUND")`;
 *    o handler único converte os dois antes do 500 genérico.
 *
 * 4. `@/lib/api/guards` NÃO entra no import estático. Ele puxa `@/lib/auth` →
 *    next-auth → `next/server`, que o vitest não resolve — e este módulo tem de
 *    ser importável num teste PURO (§8.6: `linhasCurriculo` sobre um snapshot fixo, sem mock). Por isso `requireConformidade` e
 *    `ApiError` entram por `import()` só onde são usados. Em runtime é o MESMO
 *    módulo (cache do ESM): o `instanceof ApiError` do handler único continua
 *    valendo.
 *
 * `coletar…` é o ÚNICO ponto com banco; os geradores são puros sobre o
 * snapshot `DadosCurriculoRt`.
 */

import ExcelJS from "exceljs";
import type { ApiError } from "@/lib/api/guards"; // só tipo — o valor entra por import() (regra 4)
import { isConformidade } from "@/lib/permissions";
import {
  CurriculoQuerySchema,
  PAPEL_PROFISSIONAL_LABELS,
} from "@/lib/conformidade/profissionais/validations";
import {
  curriculoDoProfissional,
  type CurriculoRt,
  type LinhaCurriculo,
} from "@/lib/conformidade/profissionais/queries";
import { fonteRodape, fonteValor } from "./estilo-proponente";
import { addAbaTabela, type ColunaAba } from "./aba-helpers";
import { CT_PDF, CT_XLSX, type RelatorioDef } from "./tipos";

/** O snapshot do relatório: o currículo como `curriculoDoProfissional` o devolveu. */
export interface DadosCurriculoRt {
  geradoEm:  string;
  curriculo: CurriculoRt;
}

// ── Frases fixas (contrato de leitura — XLSX e PDF) ──────────────────────────

/** §1c: a quantidade da ART é evidência LITERAL, e não existe soma sobre texto. */
export const NOTA_QUANTIDADE_ART =
  "Quantidade escrita na ART é texto do documento e não entra em soma.";

// ── Derivações puras (compartilhadas com o PDF) ──────────────────────────────

/**
 * "AAAA-MM-DD" → "DD/MM/AAAA" sem passar por `Date` (que aplicaria fuso e
 * empurraria 01/01 para 31/12 do ano anterior em GMT-3). Mesma regra da ficha
 * da operação (`app/acervo/operacoes/[id]/secoes.ts`, privada lá).
 */
function formatarDataCurta(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Período da operação como a ficha mostra: "01/01/2020 → 31/12/2021", "desde …", "até …". */
export function formatarPeriodo(inicio: string | null, fim: string | null): string | null {
  if (inicio && fim) return `${formatarDataCurta(inicio)} → ${formatarDataCurta(fim)}`;
  if (inicio) return `desde ${formatarDataCurta(inicio)}`;
  if (fim) return `até ${formatarDataCurta(fim)}`;
  return null;
}

/** "Petrobras (Petrobras)" só quando há grupo — o grupo entre parênteses, como na tela. */
export function rotuloCliente(nome: string, grupo: string | null): string {
  return grupo ? `${nome} (${grupo})` : nome;
}

/** "0101234567/BA", "0101234567" (sem UF) ou "não informado" — nunca CPF (§1d). */
export function textoCrea(profissional: CurriculoRt["profissional"]): string {
  if (!profissional.crea) return "não informado";
  return profissional.creaUf ? `${profissional.crea}/${profissional.creaUf}` : profissional.crea;
}

/**
 * Os códigos DISTINTOS das disciplinas dos DOCUMENTOS (não as da obra), na ordem
 * em que aparecem no currículo. É a resposta a "em que este profissional tem
 * acervo?" — e sai vazia quando ninguém classificou documento nenhum ainda.
 */
function disciplinasDoCurriculo(curriculo: CurriculoRt): string[] {
  const codigos = new Set<string>();
  for (const operacao of curriculo.operacoes) {
    for (const documento of operacao.documentos) {
      if (documento.disciplina) codigos.add(documento.disciplina.codigo);
    }
  }
  return [...codigos];
}

/** "2 documentos sem operação" (Q4). */
export function textoIgnorados(ignorados: CurriculoRt["ignorados"]): string {
  return `${ignorados.semOperacao} documentos sem operação`;
}

// ── Aba 2: "Obras e atividades" ──────────────────────────────────────────────

const COLUNAS_CURRICULO: ColunaAba[] = [
  { header: "Operação",         width: 14 },
  { header: "Cliente",          width: 30 },
  { header: "Período",          width: 24 },
  { header: "Disciplina",       width: 12 },
  { header: "Documento",        width: 42 },
  { header: "Tipo",             width: 14 },
  { header: "Papel",            width: 20 },
  { header: "Nº ART",           width: 16 },
  { header: "Atividade",        width: 52 },
  { header: "Quantidade (ART)", width: 18 },
];

/** Uma linha da aba 2 mais o documento de onde ela saiu (o hyperlink da célula). */
interface LinhaComDocumento {
  linha:       LinhaCurriculo;
  documentoId: string;
}

/**
 * A hierarquia achatada em linhas, PRESERVANDO a ordem da resposta (operações da
 * mais recente para a mais antiga; documentos por papel e emissão; atividades por
 * `ordem`). Operação e documento REPETEM — é uma planilha, não uma árvore.
 *
 * ⚠️ Documento SEM atividade rende UMA linha, com `atividade` vazia: sem isso o
 * documento sumiria do currículo justamente quando ninguém cadastrou a ART ainda
 * — e o currículo passaria a mentir por omissão (§5.10 / §8.6).
 */
function montarLinhasCurriculo(dados: DadosCurriculoRt): LinhaComDocumento[] {
  const linhas: LinhaComDocumento[] = [];

  for (const operacao of dados.curriculo.operacoes) {
    const periodo = formatarPeriodo(operacao.periodoInicio, operacao.periodoFim);
    const cliente = rotuloCliente(operacao.clienteNome, operacao.clienteGrupo);

    for (const documento of operacao.documentos) {
      // O comum a toda linha deste documento — o que repete na planilha.
      const base = {
        operacaoCodigo:    operacao.codigo,
        clienteNome:       cliente,
        periodo,
        disciplina:        documento.disciplina?.codigo ?? null,
        documentoTitulo:   documento.titulo,
        tipoDocumento:     documento.tipoDocumento,
        // Rótulo, nunca o enum cru: "RT" na célula não diz nada a quem lê o anexo.
        papelProfissional: PAPEL_PROFISSIONAL_LABELS[documento.papelProfissional],
        numeroArt:         documento.numeroArt,
      };

      if (documento.atividades.length === 0) {
        linhas.push({
          documentoId: documento.documentoId,
          linha: { ...base, atividade: null, quantidadeTexto: null },
        });
        continue;
      }

      for (const atividade of documento.atividades) {
        linhas.push({
          documentoId: documento.documentoId,
          linha: {
            ...base,
            atividade:       atividade.atividade,
            quantidadeTexto: atividade.quantidadeTexto,
          },
        });
      }
    }
  }

  return linhas;
}

/** A linha tipada virando células, na ORDEM de `COLUNAS_CURRICULO`. */
function celulasCurriculo(linha: LinhaCurriculo): (string | number | null)[] {
  return [
    linha.operacaoCodigo,
    linha.clienteNome,
    linha.periodo,
    linha.disciplina,
    linha.documentoTitulo,
    linha.tipoDocumento,
    linha.papelProfissional,
    linha.numeroArt,
    linha.atividade,
    linha.quantidadeTexto,
  ];
}

/**
 * Linhas da aba "Obras e atividades" — pura, testada (§8.6). Uma linha por
 * atividade e uma linha por documento SEM atividade.
 */
export function linhasCurriculo(dados: DadosCurriculoRt): (string | number | null)[][] {
  return montarLinhasCurriculo(dados).map((item) => celulasCurriculo(item.linha));
}

// ── Coleta (único acesso a dados) ────────────────────────────────────────────

/**
 * Os erros do relatório, nas DUAS formas que o handler único converte antes do
 * 500 genérico (onda 2 §1a item 4). A classe chega por `import()` (regra 4).
 */
async function erroApi(status: number, code: string, mensagem: string): Promise<ApiError> {
  const { ApiError: ErroApi } = await import("@/lib/api/guards");
  return new ErroApi(status, code, mensagem);
}

/**
 * ÚNICO acesso a dados: valida `profissionalId` com o MESMO schema da rota e
 * chama a MESMA `curriculoDoProfissional` que a tela usa (Q10.6 — um só lugar
 * decide o que é o currículo).
 *
 * `role`: o relatório roda depois do `guard` = `requireConformidade`, então o
 * papel é sempre Conformidade — lê-se o papel DA SESSÃO mesmo assim, para
 * `restricaoVisivel` continuar sendo a única fonte da regra (nunca um `true`
 * hard-coded aqui dentro). A segunda chamada ao guard é a leitura da sessão que
 * já está em memória, e mantém o 401/403 idêntico ao da rota.
 *
 * Não exportada: o único chamador é a `curriculoRtDef` abaixo (§8.1 — export
 * novo sem consumidor é achado de knip).
 */
async function coletarCurriculoRt(params: URLSearchParams): Promise<DadosCurriculoRt> {
  const parsed = CurriculoQuerySchema.safeParse({ profissionalId: params.get("profissionalId") ?? undefined });
  if (!parsed.success) {
    throw await erroApi(422, "VALIDATION", "Informe o profissional (profissionalId)");
  }

  const { requireConformidade } = await import("@/lib/api/guards");
  const sessao = await requireConformidade();

  const curriculo = await curriculoDoProfissional(parsed.data.profissionalId, sessao.user.role);
  if (!curriculo) {
    throw await erroApi(404, "NOT_FOUND", "Profissional não encontrado");
  }

  return { geradoEm: curriculo.geradoEm, curriculo };
}

// ── Geração XLSX (pura sobre o snapshot) ─────────────────────────────────────

/** Uma linha de nota mesclada abaixo da tabela (fonte de rodapé) — molde do C2. */
function nota(ws: ExcelJS.Worksheet, row: number, colCount: number, texto: string) {
  ws.mergeCells(row, 1, row, colCount);
  const cell = ws.getCell(row, 1);
  cell.value = texto;
  cell.font = fonteRodape;
}

/**
 * Gera o .xlsx do currículo (2 abas). Não exportada — como `coletar…`, só a
 * `curriculoRtDef` deste arquivo a chama (§8.1: export sem consumidor é achado
 * de knip; o teste puro de §8.6 não abre ExcelJS de propósito).
 */
async function gerarCurriculoRtXlsx(dados: DadosCurriculoRt): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Petro Radar";
  wb.created = new Date(dados.geradoEm);

  const { geradoEm, curriculo } = dados;
  const { profissional, contagens, ignorados } = curriculo;
  const disciplinas = disciplinasDoCurriculo(curriculo);
  const subtitulo =
    `CREA ${textoCrea(profissional)} · ${contagens.operacoes} obras · ` +
    `${contagens.documentos} documentos`;

  // ── Aba 1: Currículo (destaque; a tabela fica vazia de propósito — tudo nos KPIs) ──
  {
    const colunas: ColunaAba[] = [{ header: "Indicador", width: 26 }, { header: "Valor", width: 92 }];
    const ws = addAbaTabela(wb, {
      nome:     "Currículo",
      titulo:   `Currículo técnico — ${profissional.nome}`,
      subtitulo,
      destaque: true,
      colunas,
      linhas:   [],
      vazioMsg: "Detalhamento na aba “Obras e atividades” (uma linha por atividade).",
      kpis: {
        titulo: profissional.nome,
        itens: [
          ["CREA",              textoCrea(profissional)],
          ["Formação",          profissional.formacao ?? "não informada"],
          ["Situação",          profissional.ativo ? "Ativo" : "Inativo"],
          ["Obras",             String(contagens.operacoes)],
          ["Documentos",        String(contagens.documentos)],
          ["Atividades de ART", String(contagens.atividades)],
          ["Disciplinas",       disciplinas.length > 0 ? disciplinas.join(" · ") : "nenhuma classificada"],
          ["Fora do currículo", textoIgnorados(ignorados)],
        ],
      },
      geradoEm,
    });
    // Abaixo do rodapé que `addAbaTabela` já escreveu: a frase fixa do §5.10 —
    // a convenção aparece onde o número aparece (Q10.3).
    nota(ws, ws.rowCount + 2, colunas.length, NOTA_QUANTIDADE_ART);
  }

  // ── Aba 2: Obras e atividades (uma linha por atividade) ───────────────────
  {
    // Só vira hyperlink quando NEXTAUTH_URL é absoluta; senão a célula fica com o título em texto.
    const base = process.env.NEXTAUTH_URL ?? "";
    const COL_DOCUMENTO = 5; // a coluna "Documento" de COLUNAS_CURRICULO
    const itens = montarLinhasCurriculo(dados);

    const ws = addAbaTabela(wb, {
      nome:      "Obras e atividades",
      titulo:    "Obras, documentos e atividades",
      subtitulo: `${subtitulo} · ordem: obra mais recente primeiro`,
      colunas:   COLUNAS_CURRICULO,
      linhas:    itens.map((item) => celulasCurriculo(item.linha)),
      vazioMsg:  "Nenhum documento com operação — veja “Fora do currículo” na aba Currículo.",
      geradoEm,
    });

    // As linhas de dados começam logo depois do cabeçalho; `itens` está na MESMA
    // ordem, então o índice da linha é o do item (é por isso que `montarLinhas…`
    // devolve o documentoId junto: sem ele, o link exigiria uma 2ª varredura da
    // hierarquia, que poderia discordar desta).
    if (itens.length > 0 && base.startsWith("http")) {
      const primeiraLinha = ws.rowCount - itens.length - 1; // -1 = a linha em branco antes do rodapé
      itens.forEach((item, i) => {
        const cell = ws.getCell(primeiraLinha + i, COL_DOCUMENTO);
        cell.value = { text: item.linha.documentoTitulo, hyperlink: `${base}/acervo/cofre/${item.documentoId}` };
        cell.font = { ...fonteValor, underline: true };
      });
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── RelatorioDef ─────────────────────────────────────────────────────────────

export const curriculoRtDef: RelatorioDef = {
  slug:      "curriculo-rt",
  nome:      "Currículo técnico do responsável técnico",
  descricao: "Obras, disciplinas e atividades de ART de um profissional, com os documentos que provam.",
  publico:   "operacional", // o union NÃO muda (§1k)
  formatos:  ["xlsx", "pdf"],
  // requireConformidade por import() — cabeçalho, regra 4 (mesma barreira, mesmo 401/403).
  guard:     () => import("@/lib/api/guards").then((g) => g.requireConformidade()),
  podeVer:   isConformidade,
  usaPeriodo: false,  // o recorte é o profissional, não uma janela de meses
  ocultoNoHub: true,  // parametrizado: um card sem o campo "profissional" só daria erro
  gerar: async (_periodoMeses, formato, params) => {
    const dados = await coletarCurriculoRt(params ?? new URLSearchParams());
    if (formato === "pdf") {
      const { gerarCurriculoRtPdf } = await import("./curriculo-rt-pdf");
      // SEM try/catch: falha no PDF sobe para a rota → 500 logado (onda 2 §1e).
      // Nunca .xlsx disfarçado — é um anexo de habilitação.
      return { buffer: await gerarCurriculoRtPdf(dados), contentType: CT_PDF, ext: "pdf" };
    }
    return { buffer: await gerarCurriculoRtXlsx(dados), contentType: CT_XLSX, ext: "xlsx" };
  },
};
