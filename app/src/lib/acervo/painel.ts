// Lógica pura do Painel do Acervo (/acervo/painel) — SEM React, SEM fetch.
// Recebe o recorte da listagem de operações (GET /api/conformidade/operacoes)
// e resume: quanto do executado conseguimos PROVAR, onde agir primeiro
// (fila de atestados) e a qualidade do cadastro.

export type SituacaoDossie =
  | "COMPLETO"
  | "COMPROVA_INCOMPLETO"
  | "SEM_ATESTADO"
  | "VAZIO";

export interface OperacaoPainel {
  // recorte da resposta da listagem
  id: string;
  codigo: string;
  clienteNome: string;
  clienteGrupo: string | null;
  contratoNumero: string | null;
  detentora: "PROPONENTE" | "COLIGADA" | "PARCEIRO";
  periodoInicio: string | null;
  periodoFim: string | null;
  valor: string | number | null;
  escopo: string | null;
  totalDocumentos: number;
  totalAtestados: number;
  totalArtCat: number;
  totalContratos: number;
  /**
   * 0043 — disciplinas declaradas pela obra (R1 traz `[]` quando não há).
   * OPCIONAL: a fábrica `op()` de `painel.test.ts` não preenche a chave, e um
   * campo obrigatório novo quebraria a compilação do teste (spec ONDA-4 §1f).
   * Lido com `?? []`.
   */
  disciplinas?: Array<{ id: string; codigo: string; nome: string }>;
}

export interface ResumoPainel {
  porSituacao: Record<SituacaoDossie, number>;
  porDetentora: Record<string, Record<SituacaoDossie, number>>;
  /** espelho de `porDetentora`, com o CÓDIGO da disciplina como chave (C5) */
  porDisciplina: Record<string, Record<SituacaoDossie, number>>;
  valorTotal: number; // Σ valor (ops com valor)
  valorComprovavel: number; // Σ valor onde A>0
  valorSemAtestado: number; // Σ valor onde SEM_ATESTADO
  valorVazio: number; // Σ valor onde VAZIO (op com valor cadastrado e zero documento)
  cadastral: {
    valor: number;
    periodo: number;
    contratoNumero: number;
    grupo: number;
    escopo: number;
  };
  filaAtestado: OperacaoPainel[]; // SEM_ATESTADO, valor desc (sem valor no fim, por docs desc)
  topClientes: Array<{
    grupo: string;
    valorComprovavel: number;
    valorTotal: number;
    ops: number;
  }>; // agrupado por clienteGrupo||clienteNome, ordenado por valorTotal desc
}

/**
 * Situação do dossiê de uma operação, a partir dos contadores da listagem
 * (que já filtram rascunho/superada — CONTA_NA_BARRA):
 * - COMPLETO: atestado + ART/CAT + contrato;
 * - COMPROVA_INCOMPLETO: tem atestado, falta ART/CAT ou contrato;
 * - SEM_ATESTADO: tem documento mas nenhum atestado;
 * - VAZIO: nenhum documento.
 */
export function situacaoDossie(op: OperacaoPainel): SituacaoDossie {
  if (op.totalAtestados > 0) {
    return op.totalArtCat > 0 && op.totalContratos > 0
      ? "COMPLETO"
      : "COMPROVA_INCOMPLETO";
  }
  return op.totalDocumentos > 0 ? "SEM_ATESTADO" : "VAZIO";
}

/**
 * Converte o `valor` como ele chega do Postgres (string numeric, ex.
 * "1234567.89") em number. null, string vazia e qualquer coisa não numérica
 * viram 0 — o painel soma sem se preocupar com lixo de origem.
 */
export function paraNumero(valor: string | number | null): number {
  if (valor == null) return 0;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0;
  const texto = valor.trim();
  if (texto === "") return 0;
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : 0;
}

const ESCALAS: ReadonlyArray<{ divisor: number; sufixo: string }> = [
  { divisor: 1_000_000_000, sufixo: "bi" },
  { divisor: 1_000_000, sufixo: "mi" },
  { divisor: 1_000, sufixo: "mil" },
];

function formatarPt(v: number, casas: number): string {
  return v.toLocaleString("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: casas,
  });
}

/**
 * Moeda compacta em pt-BR, sem casa decimal desnecessária:
 * 0 → "—" · 950_000 → "R$ 950 mil" · 2_000_000 → "R$ 2 mi" ·
 * 2_500_000 → "R$ 2,5 mi" · 125_300_000 → "R$ 125,3 mi" ·
 * 3_450_000_000 → "R$ 3,45 bi".
 * Regra de casas: valor na escala < 10 → até 2 casas; ≥ 10 → até 1 casa;
 * zeros à direita sempre caem ("2,0" vira "2").
 */
export function moedaCompacta(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v < 1_000) return `R$ ${formatarPt(v, 0)}`;

  for (let i = 0; i < ESCALAS.length; i++) {
    const escala = ESCALAS[i];
    if (v < escala.divisor) continue;

    const naEscala = v / escala.divisor;
    const casas = naEscala < 10 ? 2 : 1;
    const fator = 10 ** casas;
    const arredondado = Math.round(naEscala * fator) / fator;

    // Arredondamento que estoura a escala ("999,96 mil") sobe um degrau.
    if (arredondado >= 1_000 && i > 0) {
      const maior = ESCALAS[i - 1];
      return `R$ ${formatarPt(v / maior.divisor, 2)} ${maior.sufixo}`;
    }
    return `R$ ${formatarPt(arredondado, casas)} ${escala.sufixo}`;
  }

  // Inalcançável (v >= 1_000 sempre casa numa escala); satisfaz o TS.
  return `R$ ${formatarPt(v, 0)}`;
}

function temTexto(texto: string | null): boolean {
  return texto != null && texto.trim() !== "";
}

function situacoesZeradas(): Record<SituacaoDossie, number> {
  return { COMPLETO: 0, COMPROVA_INCOMPLETO: 0, SEM_ATESTADO: 0, VAZIO: 0 };
}

/**
 * Comparador compartilhado: valor desc; operações sem valor vão para o fim,
 * ordenadas por quantidade de documentos desc (mais docs = mais perto de
 * virar dossiê). Usado pela fila de atestado e pela tabela de completude.
 */
function compararValorDesc(a: OperacaoPainel, b: OperacaoPainel): number {
  const valorA = paraNumero(a.valor);
  const valorB = paraNumero(b.valor);
  const aTemValor = valorA > 0;
  const bTemValor = valorB > 0;
  if (aTemValor && bTemValor) return valorB - valorA;
  if (aTemValor) return -1;
  if (bTemValor) return 1;
  return b.totalDocumentos - a.totalDocumentos;
}

/** Resume as operações da listagem nos agregados que o painel exibe. */
export function resumirPainel(ops: OperacaoPainel[]): ResumoPainel {
  const porSituacao = situacoesZeradas();
  const porDetentora: Record<string, Record<SituacaoDossie, number>> = {};
  const porDisciplina: Record<string, Record<SituacaoDossie, number>> = {};
  const cadastral = { valor: 0, periodo: 0, contratoNumero: 0, grupo: 0, escopo: 0 };
  const filaAtestado: OperacaoPainel[] = [];
  const clientes = new Map<
    string,
    { grupo: string; valorComprovavel: number; valorTotal: number; ops: number }
  >();

  let valorTotal = 0;
  let valorComprovavel = 0;
  let valorSemAtestado = 0;
  let valorVazio = 0;

  for (const op of ops) {
    const situacao = situacaoDossie(op);
    porSituacao[situacao] += 1;

    const daDetentora = porDetentora[op.detentora] ?? situacoesZeradas();
    daDetentora[situacao] += 1;
    porDetentora[op.detentora] = daDetentora;

    // Uma operação com 3 disciplinas conta em 3 eixos — e é isso que se quer
    // ("temos quantas obras completas em Instrumentação?"). A soma das colunas
    // NÃO fecha com o total de operações, de propósito; o card diz isso.
    // Operação sem disciplina (ou vinda de uma R1 antiga, sem a chave) não
    // entra em eixo nenhum — daí o `?? []`, nunca um "SEM_DISCIPLINA" inventado.
    for (const d of op.disciplinas ?? []) {
      const daDisciplina = porDisciplina[d.codigo] ?? situacoesZeradas();
      daDisciplina[situacao] += 1;
      porDisciplina[d.codigo] = daDisciplina;
    }

    const valor = paraNumero(op.valor);
    valorTotal += valor;
    if (op.totalAtestados > 0) valorComprovavel += valor;
    if (situacao === "SEM_ATESTADO") {
      valorSemAtestado += valor;
      filaAtestado.push(op);
    }
    if (situacao === "VAZIO") valorVazio += valor;

    if (valor > 0) cadastral.valor += 1;
    if (temTexto(op.periodoInicio) && temTexto(op.periodoFim)) cadastral.periodo += 1;
    if (temTexto(op.contratoNumero)) cadastral.contratoNumero += 1;
    if (temTexto(op.clienteGrupo)) cadastral.grupo += 1;
    if (temTexto(op.escopo)) cadastral.escopo += 1;

    // Agrupamento por grupo econômico, com fallback no nome do cliente.
    const rotulo = (op.clienteGrupo ?? "").trim() || op.clienteNome.trim() || op.clienteNome;
    const cliente = clientes.get(rotulo) ?? {
      grupo: rotulo,
      valorComprovavel: 0,
      valorTotal: 0,
      ops: 0,
    };
    cliente.valorTotal += valor;
    if (op.totalAtestados > 0) cliente.valorComprovavel += valor;
    cliente.ops += 1;
    clientes.set(rotulo, cliente);
  }

  // Fila: maior valor executado não comprovável primeiro; operações sem valor
  // vão para o fim, ordenadas por quantidade de documentos.
  filaAtestado.sort(compararValorDesc);

  const topClientes = [...clientes.values()].sort(
    (a, b) =>
      b.valorTotal - a.valorTotal ||
      b.ops - a.ops ||
      a.grupo.localeCompare(b.grupo, "pt-BR"),
  );

  return {
    porSituacao,
    porDetentora,
    porDisciplina,
    valorTotal,
    valorComprovavel,
    valorSemAtestado,
    valorVazio,
    cadastral,
    filaAtestado,
    topClientes,
  };
}

// ───────────────────────────── Documentos (cofre) ─────────────────────────────

export interface DocPainel {
  // recorte da resposta de GET /api/conformidade/cofre/documentos
  tipoDocumento: string | null;
  situacaoProva: string | null;
  categoria: string;
  operacaoId: string | null;
  status: string;
  validadeFim: string | null; // date-string "AAAA-MM-DD"
  validadeIndeterminada: boolean;
  criadoEm: string;
  detentora: string | null;
}

export interface AnaliseDocs {
  total: number;
  orfaos: number; // sem operacaoId
  semTipo: number; // sem tipoDocumento
  saudaveis: number; // com operação E com tipo (um doc órfão+semTipo conta UMA vez)
  vencidos: number; // status === "VENCIDO" (o status manda; não recalcular por data)
  porTipo: Array<{ tipo: string; n: number }>; // desc; null → "Sem tipo"
  porSituacao: Array<{ situacao: string; n: number }>; // desc; null → "Indefinida"
  vencendo90d: number; // validadeFim de amanhã a hoje+90 (semântica do ?vencendoEm=90 do cofre)
}

const MS_POR_DIA = 86_400_000;

/** Dia da data local, ancorado em UTC — compara datas SEM hora. */
function diaUtcDeData(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Date-string "AAAA-MM-DD" → dia em UTC; lixo/null → null. */
function diaUtcDeTexto(texto: string | null): number | null {
  if (texto == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Ordena um Map de contagens em lista desc por n (empate: rótulo asc pt-BR). */
function contagemDesc(mapa: Map<string, number>): Array<{ rotulo: string; n: number }> {
  return [...mapa.entries()]
    .map(([rotulo, n]) => ({ rotulo, n }))
    .sort((a, b) => b.n - a.n || a.rotulo.localeCompare(b.rotulo, "pt-BR"));
}

/**
 * Análise de TODOS os documentos do cofre. `hoje` chega como Date (com hora);
 * a janela de vencimento compara só o dia — um doc que vence hoje às 00h conta
 * como "vencendo", nunca como passado, independente da hora de `hoje`.
 */
export function analisarDocs(docs: DocPainel[], hoje: Date): AnaliseDocs {
  const hojeUtc = diaUtcDeData(hoje);
  const tipos = new Map<string, number>();
  const situacoes = new Map<string, number>();
  let orfaos = 0;
  let semTipo = 0;
  let saudaveis = 0;
  let vencidos = 0;
  let vencendo90d = 0;

  for (const doc of docs) {
    const temOperacao = temTexto(doc.operacaoId);
    if (!temOperacao) orfaos += 1;

    const tipo = temTexto(doc.tipoDocumento)
      ? (doc.tipoDocumento as string).trim()
      : "Sem tipo";
    if (tipo === "Sem tipo") semTipo += 1;
    else if (temOperacao) saudaveis += 1;
    tipos.set(tipo, (tipos.get(tipo) ?? 0) + 1);

    const situacao = temTexto(doc.situacaoProva)
      ? (doc.situacaoProva as string).trim()
      : "Indefinida";
    situacoes.set(situacao, (situacoes.get(situacao) ?? 0) + 1);

    if (doc.status === "VENCIDO") vencidos += 1;

    // Mesma janela do filtro ?vencendoEm=90 do cofre (dias 1..90: quem vence
    // HOJE já ficou de fora lá; +90 entra) — o número do card e a lista de
    // destino do clique precisam bater. Status não exclui: VENCIDO com
    // validade futura é contradição de dados e aparece nos dois lugares.
    if (!doc.validadeIndeterminada) {
      const fim = diaUtcDeTexto(doc.validadeFim);
      if (fim != null) {
        const dias = Math.round((fim - hojeUtc) / MS_POR_DIA);
        if (dias >= 1 && dias <= 90) vencendo90d += 1;
      }
    }
  }

  return {
    total: docs.length,
    orfaos,
    semTipo,
    saudaveis,
    vencidos,
    porTipo: contagemDesc(tipos).map(({ rotulo, n }) => ({ tipo: rotulo, n })),
    porSituacao: contagemDesc(situacoes).map(({ rotulo, n }) => ({
      situacao: rotulo,
      n,
    })),
    vencendo90d,
  };
}

// ───────────────────────────── Linha do tempo ─────────────────────────────

export interface FaixaAno {
  ano: number | null; // null = operações sem período (faixa própria no fim)
  porSituacao: Record<SituacaoDossie, number>;
}

/** Ano de um date-string "AAAA-MM-DD"; lixo/null → null. */
function anoDe(texto: string | null): number | null {
  if (texto == null) return null;
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(texto.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Operações agrupadas pelo ano de periodoInicio, com a quebra pelas 4
 * situações do dossiê. Ordenado por ano asc; quem não tem período cai numa
 * faixa própria (ano: null) SEMPRE no fim — e a faixa só existe se houver
 * operação nela.
 */
export function operacoesPorAno(ops: OperacaoPainel[]): FaixaAno[] {
  const porAno = new Map<number, Record<SituacaoDossie, number>>();
  let semAno: Record<SituacaoDossie, number> | null = null;

  for (const op of ops) {
    const situacao = situacaoDossie(op);
    const ano = anoDe(op.periodoInicio);
    if (ano == null) {
      semAno = semAno ?? situacoesZeradas();
      semAno[situacao] += 1;
    } else {
      const faixa = porAno.get(ano) ?? situacoesZeradas();
      faixa[situacao] += 1;
      porAno.set(ano, faixa);
    }
  }

  const faixas: FaixaAno[] = [...porAno.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ano, porSituacao]) => ({ ano, porSituacao }));
  if (semAno != null) faixas.push({ ano: null, porSituacao: semAno });
  return faixas;
}

// ───────────────────────────── Nota do acervo ─────────────────────────────

export interface NotaAcervo {
  nota: number; // 0..100, inteiro
  conceito: "A" | "B" | "C" | "D" | "E"; // ≥85 A, ≥70 B, ≥55 C, ≥40 D, senão E
  componentes: Array<{
    chave: "provabilidade" | "dossies" | "cadastro" | "higiene";
    rotulo: string;
    peso: number;
    valor: number; // 0..100
  }>;
}

/** parte/todo em %, clampado em 0..100; todo ≤ 0 → 0 (sem divisão por zero). */
function porcento(parte: number, todo: number): number {
  if (todo <= 0) return 0;
  return Math.min(100, Math.max(0, (parte / todo) * 100));
}

/**
 * Nota 0..100 do acervo — média ponderada de 4 componentes:
 * - provabilidade (40): valorComprovavel/valorTotal;
 * - dossiês (25): COMPLETO/totalOps;
 * - cadastro (20): média dos 5 % cadastrais;
 * - higiene (15): docs com tipo E com operação / total (contagem direta
 *   `saudaveis` — um doc órfão E sem tipo conta um defeito só).
 * Componentes carregam o valor sem arredondar (a nota arredonda no fim);
 * casos degenerados (0 ops, 0 docs, valorTotal 0) valem 0, nunca NaN.
 */
export function notaAcervo(
  resumo: ResumoPainel,
  analise: AnaliseDocs,
  totalOps: number,
): NotaAcervo {
  const provabilidade = porcento(resumo.valorComprovavel, resumo.valorTotal);
  const dossies = porcento(resumo.porSituacao.COMPLETO, totalOps);

  const c = resumo.cadastral;
  const cadastro = porcento(
    c.valor + c.periodo + c.contratoNumero + c.grupo + c.escopo,
    5 * totalOps,
  );

  const higiene = porcento(analise.saudaveis, analise.total);

  const componentes: NotaAcervo["componentes"] = [
    { chave: "provabilidade", rotulo: "Provabilidade", peso: 40, valor: provabilidade },
    { chave: "dossies", rotulo: "Dossiês completos", peso: 25, valor: dossies },
    { chave: "cadastro", rotulo: "Qualidade do cadastro", peso: 20, valor: cadastro },
    { chave: "higiene", rotulo: "Higiene documental", peso: 15, valor: higiene },
  ];

  const somaPesos = componentes.reduce((soma, comp) => soma + comp.peso, 0);
  const ponderada = componentes.reduce((soma, comp) => soma + comp.peso * comp.valor, 0);
  const nota = Math.round(ponderada / somaPesos);

  const conceito: NotaAcervo["conceito"] =
    nota >= 85 ? "A" : nota >= 70 ? "B" : nota >= 55 ? "C" : nota >= 40 ? "D" : "E";

  return { nota, conceito, componentes };
}

// ───────────────────────── Completude por contrato ─────────────────────────

export interface LinhaCompletude {
  op: OperacaoPainel;
  situacao: SituacaoDossie;
  tem: { contrato: boolean; artCat: boolean; atestado: boolean };
}

/**
 * As operações repartidas nas 3 abas da tabela de completude:
 * - pendentes: SEM_ATESTADO + COMPROVA_INCOMPLETO, valor desc (sem valor no
 *   fim, por docs desc — mesmo critério da fila de atestado);
 * - completos: COMPLETO, valor desc;
 * - vazios: VAZIO, código asc.
 */
export function tabelaCompletude(ops: OperacaoPainel[]): {
  pendentes: LinhaCompletude[];
  completos: LinhaCompletude[];
  vazios: LinhaCompletude[];
} {
  const pendentes: LinhaCompletude[] = [];
  const completos: LinhaCompletude[] = [];
  const vazios: LinhaCompletude[] = [];

  for (const op of ops) {
    const situacao = situacaoDossie(op);
    const linha: LinhaCompletude = {
      op,
      situacao,
      tem: {
        contrato: op.totalContratos > 0,
        artCat: op.totalArtCat > 0,
        atestado: op.totalAtestados > 0,
      },
    };
    if (situacao === "COMPLETO") completos.push(linha);
    else if (situacao === "VAZIO") vazios.push(linha);
    else pendentes.push(linha);
  }

  pendentes.sort((a, b) => compararValorDesc(a.op, b.op));
  completos.sort((a, b) => compararValorDesc(a.op, b.op));
  vazios.sort((a, b) => a.op.codigo.localeCompare(b.op.codigo, "pt-BR"));

  return { pendentes, completos, vazios };
}

// ─────────────── Nuvem de cobertura por disciplina (D10, 0044) ───────────────

/**
 * Recorte ESTRUTURAL da resposta do C3 (GET /api/conformidade/disciplinas/
 * cobertura, onda 4 §5.3). Declarado aqui, e não importado de
 * `lib/conformidade/disciplinas/queries.ts`, porque AQUELE arquivo importa
 * `@/db` e este módulo é puro — `painel.test.ts` roda sem Postgres.
 */
export interface LinhaCoberturaPainel {
  codigo: string;
  nome: string;
  operacoes: number;
  comAtestado: number;
}

export interface ItemNuvem {
  codigo: string;
  nome: string;
  operacoes: number;
  comAtestado: number;
  /** 0..1 — comAtestado / operacoes; 0 quando não há operação. */
  provado: number;
  /** 1..6 — degrau tipográfico. Ver a regra abaixo. */
  peso: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface NuvemCobertura {
  itens: ItemNuvem[];
  /** Disciplinas do catálogo com ZERO operação — a resposta mais importante do C3. */
  semCobertura: Array<{ codigo: string; nome: string }>;
  maximo: number;
}

/**
 * Degrau tipográfico da palavra na nuvem: `1 + round(5 * sqrt(ops / maximo))`,
 * preso em 1..6.
 *
 * Raiz e não proporção direta porque a área percebida de um texto cresce com o
 * QUADRADO do corpo — uma disciplina com 4× mais obras não pode parecer 16×
 * maior. Seis degraus porque a folha da nuvem tem seis tamanhos de fonte e
 * nada entre eles. `maximo <= 0` devolve 1 e não divide por zero.
 */
function pesoNaNuvem(operacoes: number, maximo: number): ItemNuvem["peso"] {
  if (maximo <= 0) return 1;
  const degrau = 1 + Math.round(5 * Math.sqrt(operacoes / maximo));
  return Math.min(6, Math.max(1, degrau)) as ItemNuvem["peso"];
}

/**
 * D10 — a nuvem de cobertura do painel, a partir da resposta do C3.
 *
 * Três decisões (spec ONDA-5 §4.6):
 *  - disciplina com ZERO operação NÃO vira palavra: vira item de
 *    `semCobertura`, listado por extenso embaixo. Desenhá-la com fonte mínima
 *    a esconderia justamente quando ela é o achado ("não temos nada provado em
 *    Telecom"), e com fonte legível mentiria sobre o tamanho;
 *  - `provado` COLORE e `peso` DIMENSIONA — duas variáveis visuais para as
 *    duas perguntas ("quanto fizemos" e "quanto está provado"), sem
 *    multiplicá-las num índice que ninguém sabe ler;
 *  - a função NÃO ordena por peso: devolve na ordem em que o C3 mandou
 *    (`ordem, codigo` do catálogo) e é a tela que embaralha para o layout.
 *    Ordem estável na função = teste estável.
 */
export function nuvemDisciplinas(linhas: readonly LinhaCoberturaPainel[]): NuvemCobertura {
  let maximo = 0;
  for (const linha of linhas) {
    if (linha.operacoes > maximo) maximo = linha.operacoes;
  }

  const itens: ItemNuvem[] = [];
  const semCobertura: Array<{ codigo: string; nome: string }> = [];

  for (const linha of linhas) {
    if (linha.operacoes <= 0) {
      semCobertura.push({ codigo: linha.codigo, nome: linha.nome });
      continue;
    }
    itens.push({
      codigo: linha.codigo,
      nome: linha.nome,
      operacoes: linha.operacoes,
      comAtestado: linha.comAtestado,
      provado: linha.comAtestado / linha.operacoes,
      peso: pesoNaNuvem(linha.operacoes, maximo),
    });
  }

  return { itens, semCobertura, maximo };
}
