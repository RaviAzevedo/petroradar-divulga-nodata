/**
 * Templates de E-mail — Petro Radar
 *
 * UM ÚNICO LAYOUT: todos os templates passam por shell() (lib/email/primitivos).
 * Os antigos layout() (slate/azul-marinho, 13 e-mails) e layoutProponente()
 * (branded, 1 e-mail, com o laranja errado) foram APAGADOS.
 *
 * Identidade (Manual da Marca 2025): laranja #F59C00 + preto #1D1D1B. Azul é
 * PROIBIDO. Laranja é ESTRUTURA (filete/rail/fundo de CTA), nunca texto.
 *
 * Alvo real: motor Word do Outlook/Exchange (transporte Microsoft Graph).
 * Tabelas, padding só em <td>, bgcolor + background-color, sem inline-block.
 *
 * Todo dado externo (Petronect, IA, usuário, scraper, Receita) passa por
 * esc()/trunc()/nl2br() — ver lib/email/escape.ts.
 *
 * O logo (cid:logo-proponente) é anexado AUTOMATICAMENTE por lib/email/send.ts —
 * nenhum call-site precisa passar inlineImages.
 *
 * Contrato preservado: todos os templates devolvem { subject, html, text } e as
 * interfaces de params são as mesmas (só ganharam campos OPCIONAIS).
 */

import { esc, nl2br, preheaderTexto, trunc, truncNl } from "./escape";
import {
  alerta,
  assunto,
  badge,
  badgeLinha,
  bloco,
  botao,
  card,
  divisor,
  espaco,
  h1,
  h2,
  infoBox,
  infoRow,
  kicker,
  kpiGrid,
  lista,
  meta,
  numeroEdital,
  paragrafo,
  shell,
  type KpiCelula,
  type Token,
} from "./primitivos";
import { ESTADO, FONTE, LARANJA, TXT_FORTE, TXT_FRACO, type Severidade } from "./tokens";

// ── Formatação ───────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  return date.toLocaleDateString("pt-BR", {
    day:      "2-digit",
    month:    "long",
    year:     "numeric",
    hour:     "2-digit",
    minute:   "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

/** Data curta (dd/mm) — usada no preheader, onde cada caractere conta. */
function formatDateCurta(date: Date): string {
  return date.toLocaleDateString("pt-BR", {
    day:      "2-digit",
    month:    "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

function formatDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", {
    day:   "2-digit",
    month: "long",
    year:  "numeric",
  });
}

function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

function linkLicitacao(id: string): string {
  return `${baseUrl}/licitacoes/${id}`;
}

function linkCofreDocumento(id: string): string {
  return `${baseUrl}/acervo/cofre/${id}`;
}

function linkFamilia(id: string): string {
  return `${baseUrl}/acervo/familias/${id}`;
}

// Envelopes e Contratos saíram da UI do Acervo (só restam Cofre, Famílias CRC e
// Busca Semântica): /acervo/envelopes/{id} e /acervo/contratos/{id} não existem
// mais. O deep-link cai no Cofre — e o RÓTULO do CTA diz "Abrir o Cofre", para
// o botão não prometer um destino que não entrega. O id fica na assinatura para
// não quebrar os call-sites (e para religar o deep-link quando as páginas
// voltarem).
function linkEnvelope(_id: string): string {
  return `${baseUrl}/acervo/cofre`;
}

function linkContrato(_id: string): string {
  return `${baseUrl}/acervo/cofre`;
}

/** Monta o HTML final com o shell único. */
function render(titulo: string, preheader: string, conteudo: string): string {
  return shell({ titulo, preheader, conteudo, baseUrl });
}

/** Rodapé em texto puro — espelha o footer do shell nas versões text/. */
function rodapeTexto(): string {
  return `\n—\nPetro Radar · Petro Radar — e-mail automático, não responda.\nPreferências: ${baseUrl}/admin/emails`;
}

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO PARTICIPAÇÕES — PRAZOS
// ════════════════════════════════════════════════════════════════════════════

// ── Template 3: Prazos Críticos de Licitação (CONSOLIDADO) ──────────────────

export interface PrazoCriticoItem {
  licitacaoId:   string;
  numero:        string;
  objeto:        string;
  empresa:       string;
  relevancia:    string;
  dataFim:       string;    // YYYY-MM-DD
  horaFim:       string | null;
  diasRestantes: number;
}

export interface PrazosCriticosParams {
  /** Itens que CRUZARAM uma banda desde o último alerta. Nunca vazio. */
  itens:      PrazoCriticoItem[];
  /** Horizonte da varredura, só para o texto ("janela de 7 dias"). */
  janelaDias: number;
  teste?:     boolean;
}

/** ALTA relevância = VERMELHO (convenção da UI: "quente, exige ação agora"). */
function sevRelevancia(relevancia: string | null): Severidade {
  const r = (relevancia ?? "").toUpperCase();
  if (r === "ALTA") return "CRITICO";
  if (r === "MÉDIA" || r === "MEDIA") return "ATENCAO";
  return "NEUTRO"; // BAIXA/null — era AZUL na UI; no e-mail vira NEUTRO
}

/**
 * As três faixas do e-mail. Espelham as BANDAS de disparo do cron (0/1/3/7) —
 * a pessoa vê o mesmo agrupamento que decidiu o envio, em vez de uma lista
 * corrida onde "vence hoje" e "vence em 6 dias" pesam igual.
 */
const FAIXAS: Array<{ ate: number; titulo: string; sev: Severidade }> = [
  { ate: 0, titulo: "Vence hoje",          sev: "CRITICO" },
  { ate: 3, titulo: "Vence em até 3 dias", sev: "ATENCAO" },
  { ate: Infinity, titulo: "Esta semana",  sev: "NEUTRO"  },
];

function linhaPrazo(it: PrazoCriticoItem): string {
  const href = linkLicitacao(it.licitacaoId);
  const horaStr = it.horaFim ? ` às ${it.horaFim}` : "";
  const quando = `${formatDateStr(it.dataFim)}${horaStr}`;
  const cabecalho = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
    <td valign="middle" class="stack dm-txt-fraco" style="font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;color:${TXT_FRACO};">${numeroEdital(it.numero, href)}</td>
    <td align="right" valign="middle" class="stack">${badge(sevRelevancia(it.relevancia), it.relevancia || "SEM RELEVÂNCIA")}</td>
  </tr></table>`;
  const objeto = `<p class="dm-txt" style="margin:8px 0 0;font-family:${FONTE};font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:${TXT_FORTE};">${it.objeto ? esc(trunc(it.objeto, 160)) : "—"}</p>`;
  const rodape = `<p class="dm-txt-fraco" style="margin:6px 0 0;font-family:${FONTE};font-size:13px;line-height:19px;mso-line-height-rule:exactly;color:${TXT_FRACO};">Encerra ${esc(quando)}${it.empresa ? ` &middot; ${esc(it.empresa)}` : ""}</p>`;
  return cabecalho + objeto + rodape;
}

/**
 * UM e-mail com TODAS as licitações que ficaram críticas — não um e-mail por
 * licitação. Com várias encerrando no mesmo dia, o
 * modelo antigo mandava N e-mails idênticos em estrutura para as mesmas pessoas;
 * o efeito prático era ninguém abrir nenhum.
 */
export function templatePrazosCriticos(p: PrazosCriticosParams) {
  const hoje = p.itens.filter((i) => i.diasRestantes <= 0).length;
  const n = p.itens.length;

  // O assunto lidera pelo que é ACIONÁVEL hoje. "27 licitações em 7 dias" some
  // na caixa de entrada; "6 vencem hoje" não.
  const fato = hoje > 0
    ? `${hoje} ${hoje === 1 ? "licitação vence" : "licitações vencem"} hoje`
    : `${n} ${n === 1 ? "licitação entra" : "licitações entram"} em prazo crítico`;
  const token: Token = hoje > 0 ? "URGENTE" : "ATENÇÃO";
  const subject = `${p.teste ? "[TESTE] " : ""}${assunto(token, fato, null)}`;

  const alta = p.itens.filter((i) => (i.relevancia ?? "").toUpperCase() === "ALTA").length;
  const preheader = preheaderTexto(
    hoje > 0 && n > hoje ? `mais ${n - hoje} nos próximos dias` : null,
    alta > 0 ? `${alta} de alta relevância` : null,
    `janela de ${p.janelaDias} dias`,
  );

  // Cada faixa vira UM card com as licitações dentro, separadas por divisor.
  // Faixa vazia não renderiza — um card "Vence hoje" vazio seria pior que ausente.
  let restantes = [...p.itens].sort((a, b) => a.diasRestantes - b.diasRestantes);
  const secoes: string[] = [];
  for (const faixa of FAIXAS) {
    const desta = restantes.filter((i) => i.diasRestantes <= faixa.ate);
    restantes = restantes.filter((i) => i.diasRestantes > faixa.ate);
    if (desta.length === 0) continue;
    const corpo = desta.map(linhaPrazo).join(espaco(12) + divisor() + espaco(12));
    secoes.push(
      h2(`${faixa.titulo} (${desta.length})`) +
        card(faixa.sev, corpo),
    );
  }

  const conteudo = bloco(
    kicker("Prazos de licitação"),
    h1(fato),
    meta(
      `Licitações <strong style="color:${TXT_FORTE};">ALTA</strong> e <strong style="color:${TXT_FORTE};">MÉDIA</strong> em Recebendo Propostas, na janela de ${esc(String(p.janelaDias))} dias. Você recebe cada licitação quando ela cruza uma faixa — não todo dia.`,
    ),
    ...secoes,
    botao(`${baseUrl}/explorar`, "Abrir o Petro Radar"),
  );

  const textItens = p.itens
    .slice()
    .sort((a, b) => a.diasRestantes - b.diasRestantes)
    .map((it) => {
      const quandoTxt = it.diasRestantes <= 0
        ? "HOJE"
        : it.diasRestantes === 1
          ? "amanhã"
          : `em ${it.diasRestantes} dias`;
      return [
        `- ${it.numero} [${it.relevancia}] — vence ${quandoTxt} (${formatDateStr(it.dataFim)}${it.horaFim ? ` às ${it.horaFim}` : ""})`,
        `  ${it.objeto || "—"}`,
        `  ${linkLicitacao(it.licitacaoId)}`,
      ].join("\n");
    })
    .join("\n\n");

  const text = [
    `${token}: ${fato}`,
    `Janela de ${p.janelaDias} dias — ALTA e MÉDIA em Recebendo Propostas.`,
    "",
    textItens,
    "",
    `Abrir o Petro Radar: ${baseUrl}/explorar`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ── Template 4: Sync/Coleta Falhou ───────────────────────────────────────────

export function templateSyncFalhou(dados: {
  tipo: string;
  executadoEm: string;
  erros: number;
  totalEncontradas: number;
  detalhes: string;
  horasSemSync?: number;
  /** Legado do SaaS — IGNORADO no on-prem (não existe GitHub Actions aqui). */
  githubRepo?: string;
}): { subject: string; html: string; text: string } {
  const desatualizado = (dados.horasSemSync ?? 0) > 0;
  const sev: Severidade = desatualizado ? "ATENCAO" : "CRITICO";

  const subject = desatualizado
    ? assunto("SISTEMA", `Coleta parada há ${dados.horasSemSync}h`)
    : assunto("SISTEMA", `Coleta falhou (${dados.erros} ${dados.erros === 1 ? "erro" : "erros"})`);

  const preheader = preheaderTexto(
    `Última execução ${dados.executadoEm}`,
    `Fonte: ${dados.tipo}`,
    "Verificar os containers da coleta",
  );

  // On-prem: a coleta roda em containers Docker. O link do GitHub Actions era
  // herança do SaaS — em air-gap nem resolve DNS.
  //
  // O painel é /admin/saude-scraper (AdminNav: "Saúde do Scraper"). NÃO existe
  // /admin/coleta — este é o ÚNICO CTA da mensagem e um 404 aqui é o admin
  // clicando no meio da madrugada e caindo no vazio, com a coleta parada.
  const linkColeta = `${baseUrl}/admin/saude-scraper`;

  const conteudo = bloco(
    kicker("Sistema"),
    h1(desatualizado ? "A coleta está parada" : "A coleta registrou erros"),
    badgeLinha(
      badge(sev, desatualizado ? "Desatualizado" : "Falha", true),
      badge("NEUTRO", dados.tipo),
    ),
    card(
      sev,
      infoBox([
        infoRow("Fonte", esc(dados.tipo)),
        infoRow("Executado em", esc(dados.executadoEm)),
        infoRow("Total encontradas", esc(String(dados.totalEncontradas))),
        infoRow("Erros", esc(String(dados.erros))),
        dados.horasSemSync ? infoRow("Horas sem coleta", esc(`${dados.horasSemSync}h`)) : "",
      ]),
    ),
    dados.detalhes
      ? alerta(sev, "Detalhes", `<span style="font-size:14px;line-height:20px;">${truncNl(dados.detalhes, 500)}</span>`)
      : "",
    paragrafo(
      desatualizado
        ? "A coleta não roda há mais de 6 horas. Verifique os containers da coleta no servidor on-prem."
        : "A última execução da coleta registrou erros. Verifique os logs dos containers da coleta.",
    ),
    botao(linkColeta, "Abrir o painel de coleta"),
  );

  const text = [
    desatualizado
      ? `SISTEMA: coleta parada há ${dados.horasSemSync}h`
      : `SISTEMA: coleta falhou — ${dados.erros} erro(s)`,
    "",
    `Fonte: ${dados.tipo}`,
    `Executado em: ${dados.executadoEm}`,
    `Total encontradas: ${dados.totalEncontradas}`,
    `Erros: ${dados.erros}`,
    dados.horasSemSync ? `Horas sem coleta: ${dados.horasSemSync}h` : "",
    dados.detalhes ? `\nDetalhes:\n${dados.detalhes.slice(0, 500)}` : "",
    "",
    `Painel de coleta: ${linkColeta}`,
    rodapeTexto(),
  ].filter(Boolean).join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO CONFORMIDADE
// ════════════════════════════════════════════════════════════════════════════

// ── Template 5: Documento de Habilitação Vencendo ───────────────────────────

export interface VencimentoDocumentoParams {
  documentoId:   string;
  titulo:        string;
  categoria:     string;
  subcategoria:  string;
  validadeFim:   Date;
  diasRestantes: number;
  /** "D-60" | "D-30" | "D-15" | "D-7" | "D-1" | "VENCIDO" */
  tipoAlerta:    string;
}

export function templateVencimentoDocumento(p: VencimentoDocumentoParams) {
  const vencido = p.diasRestantes < 0;
  const urgente = !vencido && p.diasRestantes <= 7;

  // VENCIDO e URGENTE são estados DIFERENTES (o código antigo pintava os dois
  // de #dc2626 num ternário redundante). VENCIDO = sólido; URGENTE = tint.
  const sev: Severidade = vencido || urgente ? "CRITICO" : p.diasRestantes <= 30 ? "ATENCAO" : "NEUTRO";
  const token = vencido ? "VENCIDO" : urgente ? "URGENTE" : p.diasRestantes <= 30 ? "ATENÇÃO" : "AVISO";

  const prazoLabel = vencido
    ? `há ${Math.abs(p.diasRestantes)} dia(s)`
    : p.diasRestantes === 0 ? "hoje"
    : p.diasRestantes === 1 ? "amanhã"
    : `em ${p.diasRestantes} dias`;

  const subject = vencido
    ? assunto("VENCIDO", p.titulo)
    : assunto(token, `${p.titulo} vence ${prazoLabel}`);

  const preheader = preheaderTexto(
    `${p.categoria} / ${p.subcategoria}`,
    vencido ? `Venceu ${formatDateCurta(p.validadeFim)}` : `Vence ${formatDateCurta(p.validadeFim)}`,
    "Bloqueia envelopes de habilitação",
  );

  const conteudo = bloco(
    kicker("Documento de habilitação"),
    h1(vencido ? "Documento vencido" : `Documento vence ${prazoLabel}`),
    badgeLinha(badge(sev, token, vencido)),
    card(
      sev,
      infoBox([
        infoRow("Documento", esc(p.titulo)),
        infoRow("Categoria", esc(p.categoria)),
        infoRow("Subcategoria", esc(p.subcategoria)),
        infoRow("Validade", esc(formatDate(p.validadeFim))),
        infoRow("Alerta", esc(p.tipoAlerta)),
      ]),
    ),
    paragrafo(
      vencido
        ? "Inicie a renovação imediatamente: documento vencido bloqueia envelopes de habilitação e expõe contratos em execução."
        : "Inicie a renovação antes do vencimento para não travar licitações ativas nem contratos em execução.",
    ),
    botao(linkCofreDocumento(p.documentoId), "Abrir o documento no Cofre"),
  );

  const text = [
    `${token}: ${p.titulo} ${vencido ? "venceu" : "vence"} ${prazoLabel}`,
    "",
    `Categoria: ${p.categoria} / ${p.subcategoria}`,
    `Validade: ${formatDate(p.validadeFim)}`,
    `Alerta: ${p.tipoAlerta}`,
    "",
    `Abrir no Cofre: ${linkCofreDocumento(p.documentoId)}`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ── Template 6: Família CRC em Renovação ─────────────────────────────────────

export interface VencimentoFamiliaParams {
  familiaId:         string;
  codigoCrc:         string;
  nome:              string;
  validadeFim:       Date;
  diasRestantes:     number;
  segmentoPetrobras: string | null;
}

export function templateVencimentoFamilia(p: VencimentoFamiliaParams) {
  const sev: Severidade = p.diasRestantes <= 30 ? "CRITICO" : p.diasRestantes <= 60 ? "ATENCAO" : "MARCA";
  const token = p.diasRestantes <= 30 ? "URGENTE" : "AVISO";

  const subject = assunto(
    token,
    `Família CRC ${p.codigoCrc} em renovação (${p.diasRestantes}d)`,
  );

  const preheader = preheaderTexto(
    "Janela de renovação aberta",
    `Renovar até ${formatDateCurta(p.validadeFim)}`,
    p.segmentoPetrobras ? `Segmento ${p.segmentoPetrobras}` : null,
  );

  const conteudo = bloco(
    kicker("Família CRC"),
    h1("Janela de renovação aberta"),
    badgeLinha(badge(sev, token, sev === "CRITICO"), badge("MARCA", `${p.diasRestantes} dias`)),
    card(
      sev,
      infoBox([
        infoRow("Código CRC", numeroEdital(p.codigoCrc, linkFamilia(p.familiaId))),
        infoRow("Nome", esc(p.nome)),
        p.segmentoPetrobras ? infoRow("Segmento", esc(p.segmentoPetrobras)) : "",
        infoRow("Validade", esc(formatDate(p.validadeFim))),
      ]),
    ),
    paragrafo(
      "A Petrobras recomenda iniciar a renovação 60 dias antes do vencimento dos critérios Jurídico e Econômico.",
    ),
    botao(linkFamilia(p.familiaId), "Abrir a família CRC"),
  );

  const text = [
    `${token}: família CRC ${p.codigoCrc} vence em ${p.diasRestantes} dias`,
    "",
    `Nome: ${p.nome}`,
    p.segmentoPetrobras ? `Segmento: ${p.segmentoPetrobras}` : "",
    `Validade: ${formatDate(p.validadeFim)}`,
    "",
    `Abrir a família: ${linkFamilia(p.familiaId)}`,
    rodapeTexto(),
  ].filter(Boolean).join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ── Template 7: Envelope Incompleto ──────────────────────────────────────────

export interface EnvelopeIncompletoParams {
  envelopeId:     string;
  numeroEdital:   string;
  prazoProtocolo: Date | null;
  totalItens:     number;
  itensFaltantes: number;
  itensVencidos:  number;
}

export function templateEnvelopeIncompleto(p: EnvelopeIncompletoParams) {
  const pendencias = p.itensFaltantes + p.itensVencidos;
  const sev: Severidade = p.itensVencidos > 0 ? "CRITICO" : "ATENCAO";

  const subject = assunto(
    "ATENÇÃO",
    `Envelope com ${pendencias} ${pendencias === 1 ? "pendência" : "pendências"}`,
    p.numeroEdital,
  );

  const prazoLabel = p.prazoProtocolo ? formatDate(p.prazoProtocolo) : "—";
  const preheader = preheaderTexto(
    p.prazoProtocolo ? `Protocolo ${formatDateCurta(p.prazoProtocolo)}` : "Sem prazo de protocolo",
    `${p.itensVencidos} vencidos`,
    `${p.itensFaltantes} faltando`,
  );

  const conteudo = bloco(
    kicker("Envelope de habilitação"),
    h1(`${pendencias} de ${p.totalItens} itens precisam de ação`),
    badgeLinha(
      badge(sev, "Pendência", p.itensVencidos > 0),
      badge("NEUTRO", `${p.totalItens} itens`),
    ),
    card(
      sev,
      infoBox([
        infoRow("Edital", numeroEdital(p.numeroEdital)),
        infoRow("Prazo de protocolo", esc(prazoLabel)),
        infoRow("Itens faltando", esc(String(p.itensFaltantes))),
        infoRow("Itens vencidos", esc(String(p.itensVencidos))),
      ]),
    ),
    paragrafo("Atribua os documentos faltantes ou substitua os vencidos antes do protocolo."),
    botao(linkEnvelope(p.envelopeId), "Abrir o Cofre"),
  );

  const text = [
    `ATENÇÃO: envelope ${p.numeroEdital} com ${pendencias} pendência(s)`,
    "",
    `Itens faltando: ${p.itensFaltantes}`,
    `Itens vencidos: ${p.itensVencidos}`,
    `Total de itens: ${p.totalItens}`,
    `Prazo de protocolo: ${prazoLabel}`,
    "",
    `Abrir o Cofre: ${linkEnvelope(p.envelopeId)}`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ── Template 8: Contrato Crítico ─────────────────────────────────────────────

export interface ContratoCriticoParams {
  contratoId:      string;
  numero:          string;
  objeto:          string;
  periodoFim:      Date;
  motivosCriticos: string[];
}

export function templateContratoCritico(p: ContratoCriticoParams) {
  const subject = assunto("URGENTE", `Contrato ${p.numero} em estado crítico`);
  const preheader = preheaderTexto(
    `${p.motivosCriticos.length} pendência(s) de habilitação`,
    `Vigente até ${formatDateCurta(p.periodoFim)}`,
  );

  const conteudo = bloco(
    kicker("Contrato em execução"),
    h1("Contrato em risco"),
    badgeLinha(badge("CRITICO", "Crítico", true)),
    card(
      "CRITICO",
      infoBox([
        infoRow("Contrato", numeroEdital(p.numero)),
        infoRow("Objeto", trunc(p.objeto, 180)),
        infoRow("Fim do contrato", esc(formatDate(p.periodoFim))),
      ]),
    ),
    h2("Pendências detectadas"),
    lista(p.motivosCriticos.map((m) => esc(m))),
    paragrafo(
      "A Petrobras pode aplicar penalidades e até rescisão se documentos obrigatórios estiverem vencidos durante a execução.",
    ),
    botao(linkContrato(p.contratoId), "Abrir o Cofre"),
  );

  const text = [
    `URGENTE: contrato ${p.numero} em estado crítico`,
    "",
    "Pendências detectadas:",
    ...p.motivosCriticos.map((m) => `- ${m}`),
    "",
    `Objeto: ${p.objeto}`,
    `Fim do contrato: ${formatDate(p.periodoFim)}`,
    "",
    `Abrir o Cofre: ${linkContrato(p.contratoId)}`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ── Template 9: CNPJ com Situação Cadastral Alterada ─────────────────────────

export interface CnpjSituacaoParams {
  cnpj:              string;
  razaoSocial:       string;
  situacaoAnterior:  string;
  situacaoAtual:     string;
  motivo:            string | null;
  ultimaAtualizacao: Date | null;
}

export function templateCnpjSituacao(p: CnpjSituacaoParams) {
  const subject = assunto("URGENTE", `CNPJ mudou para ${p.situacaoAtual}`, p.razaoSocial);
  const preheader = preheaderTexto(
    p.cnpj,
    `De ${p.situacaoAnterior} para ${p.situacaoAtual}`,
    "Petrobras suspende fornecedor irregular",
  );

  const conteudo = bloco(
    kicker("Situação cadastral"),
    h1(`CNPJ mudou para ${p.situacaoAtual}`),
    badgeLinha(
      badge("CRITICO", "Urgente", true),
      badge("NEUTRO", p.situacaoAnterior),
      badge("CRITICO", p.situacaoAtual),
    ),
    card(
      "CRITICO",
      infoBox([
        infoRow("CNPJ", numeroEdital(p.cnpj)),
        infoRow("Razão social", esc(p.razaoSocial)),
        infoRow("Situação anterior", esc(p.situacaoAnterior)),
        infoRow("Situação atual", esc(p.situacaoAtual)),
        p.motivo ? infoRow("Motivo", trunc(p.motivo, 200)) : "",
        p.ultimaAtualizacao ? infoRow("Atualização RF", esc(formatDate(p.ultimaAtualizacao))) : "",
      ]),
    ),
    alerta(
      "CRITICO",
      "Ação necessária",
      `<span style="font-size:14px;line-height:20px;">A Petrobras suspende automaticamente fornecedores com CNPJ irregular. Regularize junto à Receita Federal o quanto antes.</span>`,
    ),
    botao(baseUrl, "Abrir o Petro Radar"),
  );

  const text = [
    `URGENTE: CNPJ ${p.razaoSocial} mudou para ${p.situacaoAtual}`,
    "",
    `CNPJ: ${p.cnpj}`,
    `Situação anterior: ${p.situacaoAnterior}`,
    `Situação atual: ${p.situacaoAtual}`,
    `Motivo: ${p.motivo ?? "—"}`,
    p.ultimaAtualizacao ? `Atualização RF: ${formatDate(p.ultimaAtualizacao)}` : "",
    "",
    "A Petrobras suspende automaticamente fornecedores com CNPJ irregular.",
    rodapeTexto(),
  ].filter(Boolean).join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO LICITAÇÃO — CONVOCAÇÃO
// ════════════════════════════════════════════════════════════════════════════

// ── Template 11: Convocação do Remanescente ──────────────────────────────────

export interface ConvocacaoRemanescenteParams {
  licitacaoId:     string;
  numero:          string;
  objeto:          string | null;
  posicaoProponente: number;
  empresaAnterior: string;
  tipoEvento:      string;   // DESCLASSIFICADO | DESISTIU
  motivo:          string | null;
  dataEvento:      Date;
  valorPropostaProponente?: string | null;
}

export function templateConvocacaoRemanescente(p: ConvocacaoRemanescenteParams) {
  const subject = assunto("OPORTUNIDADE", "Proponente é a próxima", p.numero);

  const motivoLabel = p.tipoEvento === "DESISTIU"
    ? `${p.empresaAnterior} desistiu`
    : `${p.empresaAnterior} foi desclassificada`;

  const preheader = preheaderTexto(
    motivoLabel,
    `${p.posicaoProponente}ª posição`,
    "Prazo de convocação costuma ser curto e fatal",
  );

  const conteudo = bloco(
    kicker("Convocação de remanescente"),
    h1("Proponente é a próxima elegível"),
    badgeLinha(badge("OK", "Remanescente", true), badge("NEUTRO", `${p.posicaoProponente}ª posição`)),
    alerta(
      "OK",
      "Vaga aberta na fila",
      `<span style="font-size:14px;line-height:22px;">${esc(motivoLabel)}${p.motivo ? ` — ${trunc(p.motivo, 200)}` : ""}. A Proponente pode ser convocada para apresentar documentação como remanescente.</span>`,
    ),
    card(
      "OK",
      infoBox([
        infoRow("Licitação", numeroEdital(p.numero, linkLicitacao(p.licitacaoId))),
        p.objeto ? infoRow("Objeto", trunc(p.objeto, 180)) : "",
        infoRow("Posição Proponente", esc(`${p.posicaoProponente}ª`)),
        infoRow("Evento", esc(`${p.tipoEvento} — ${formatDate(p.dataEvento)}`)),
        p.valorPropostaProponente
          ? infoRow("Nossa proposta", esc(formatCurrency(p.valorPropostaProponente)))
          : "",
      ]),
    ),
    paragrafo(
      "Prepare a documentação de habilitação: a convocação como remanescente costuma ter prazo curto e fatal.",
    ),
    botao(linkLicitacao(p.licitacaoId), "Abrir a licitação"),
  );

  const text = [
    `OPORTUNIDADE: Proponente é a próxima elegível na licitação ${p.numero}`,
    "",
    `Posição: ${p.posicaoProponente}ª`,
    `${motivoLabel}${p.motivo ? ` (${p.motivo})` : ""}`,
    `Evento: ${p.tipoEvento} em ${formatDate(p.dataEvento)}`,
    p.valorPropostaProponente ? `Nossa proposta: ${formatCurrency(p.valorPropostaProponente)}` : "",
    "",
    `Abrir a licitação: ${linkLicitacao(p.licitacaoId)}`,
    rodapeTexto(),
  ].filter(Boolean).join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO INTELIGÊNCIA — DIGEST EXECUTIVO + RELATÓRIO MENSAL
// ════════════════════════════════════════════════════════════════════════════

export interface DigestKpi {
  rotulo: string;
  valor:  string;
  /** Variação textual já formatada (ex.: "+12% vs. trimestre anterior"). */
  variacao?: string | null;
  /** "up" pinta verde, "down" vermelho, undefined/neutral cinza. */
  tendencia?: "up" | "down" | "neutral" | null;
}

export interface DigestSecaoLista {
  titulo: string;
  itens: { texto: string; href?: string | null }[];
}

export interface DigestExecutivoParams {
  periodoLabel: string;
  kpis: DigestKpi[];
  secoes: DigestSecaoLista[];
  alertasCrc?: string[];
}

function paraKpiCelula(k: DigestKpi): KpiCelula {
  const sev: Severidade =
    k.tendencia === "up" ? "OK" : k.tendencia === "down" ? "CRITICO" : "NEUTRO";
  return { label: k.rotulo, valor: k.valor, nota: k.variacao ?? null, sev };
}

/** Link de lista: preto + sublinhado (o azul do helper antigo saiu). */
function itemLista(it: { texto: string; href?: string | null }): string {
  return it.href
    ? `<a href="${esc(it.href)}" target="_blank" style="color:${TXT_FORTE};text-decoration:underline;">${esc(it.texto)}</a>`
    : esc(it.texto);
}

function secaoLista(s: DigestSecaoLista): string {
  if (s.itens.length === 0) return "";
  return bloco(h2(s.titulo), lista(s.itens.map(itemLista)));
}

export function templateDigestExecutivo(p: DigestExecutivoParams) {
  const subject = assunto("RESUMO", "Painel executivo", p.periodoLabel);

  const preheader = preheaderTexto(
    ...p.kpis.slice(0, 3).map((k) => `${k.valor} ${k.rotulo.toLowerCase()}`),
    p.alertasCrc && p.alertasCrc.length > 0 ? `${p.alertasCrc.length} alerta(s) de CRC` : null,
  );

  const conteudo = bloco(
    kicker("Painel executivo"),
    h1("Painel executivo"),
    meta(esc(p.periodoLabel)),
    kpiGrid(p.kpis.map(paraKpiCelula)),
    p.alertasCrc && p.alertasCrc.length > 0
      ? alerta(
          "CRITICO",
          "Alertas de CRC",
          `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">${p.alertasCrc
            .map(
              (a) =>
                `<tr><td style="padding:4px 0;font-family:${FONTE};font-size:14px;line-height:20px;color:${ESTADO.CRITICO.txt};">&bull;&nbsp;${esc(a)}</td></tr>`,
            )
            .join("")}</table>`,
        )
      : "",
    p.secoes.map(secaoLista).filter(Boolean).join(espaco(24)),
    botao(`${baseUrl}/resultados`, "Abrir os Resultados"),
  );

  const textKpis = p.kpis
    .map((k) => `- ${k.rotulo}: ${k.valor}${k.variacao ? ` (${k.variacao})` : ""}`)
    .join("\n");
  const textAlertas =
    p.alertasCrc && p.alertasCrc.length > 0
      ? `\nAlertas de CRC:\n${p.alertasCrc.map((a) => `  • ${a}`).join("\n")}`
      : "";
  const textSecoes = p.secoes
    .map((s) => `\n${s.titulo}\n${s.itens.map((it) => `  • ${it.texto}`).join("\n")}`)
    .join("\n");

  const text = [
    `RESUMO: painel executivo — ${p.periodoLabel}`,
    "",
    textKpis,
    textAlertas,
    textSecoes,
    "",
    `Abrir os Resultados: ${baseUrl}/resultados`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ── Template 13: Relatório Mensal ────────────────────────────────────────────

export interface RelatorioMensalParams {
  /** Rótulo do mês de referência (ex.: "Maio/2026"). */
  mesLabel: string;
  kpis: DigestKpi[];
  observacoes?: string[];
}

export function templateRelatorioMensal(p: RelatorioMensalParams) {
  const subject = assunto("RESUMO", "Relatório executivo", p.mesLabel);

  const preheader = preheaderTexto(
    ...p.kpis.slice(0, 2).map((k) => `${k.valor} ${k.rotulo.toLowerCase()}`),
    "Detalhes em Resultados",
  );

  // O relatório para download (XLSX do hub /relatorios) saiu na limpeza de
  // 2026-09: o e-mail traz os KPIs e leva aos Resultados, sem prometer arquivo.
  const linkPainel = `${baseUrl}/resultados`;

  const conteudo = bloco(
    kicker("Relatório mensal"),
    h1("Relatório executivo mensal"),
    meta(`Referência: <strong style="color:${TXT_FORTE};">${esc(p.mesLabel)}</strong>`),
    kpiGrid(p.kpis.map(paraKpiCelula)),
    p.observacoes && p.observacoes.length > 0
      ? bloco(h2("Destaques do mês"), lista(p.observacoes.map((o) => esc(o))))
      : "",
    botao(linkPainel, "Abrir os Resultados"),
  );

  const textKpis = p.kpis
    .map((k) => `- ${k.rotulo}: ${k.valor}${k.variacao ? ` (${k.variacao})` : ""}`)
    .join("\n");
  const textObs =
    p.observacoes && p.observacoes.length > 0
      ? `\nDestaques do mês:\n${p.observacoes.map((o) => `  • ${o}`).join("\n")}`
      : "";

  const text = [
    `RESUMO: relatório executivo — ${p.mesLabel}`,
    "",
    textKpis,
    textObs,
    "",
    `Abrir os Resultados: ${linkPainel}`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// ════════════════════════════════════════════════════════════════════════════
// DIGEST DE LICITAÇÕES POR FILTRO (0026)
// ════════════════════════════════════════════════════════════════════════════
//
// Decisão do dono: objeto COMPLETO em primeiro plano, prazo em destaque com
// urgência, e o e-mail NÃO anexa nada — Briefing/Checklist só na plataforma.

export interface DigestFiltroItem {
  id:             string;
  numero:         string;
  objeto:         string | null;
  objetoResumido: string | null;
  empresa:        string | null;
  dataFim:        string | null;   // YYYY-MM-DD
  relevancia:     string | null;
  scoreInteresse: number | null;
  tipoServico:    string | null;
  segmento:       string | null;
  fonte:          string;          // petronect | transparencia
  /**
   * "Habilitamos?" — cobertura de famílias CRC (o mesmo sinal da coluna do
   * Explorar). OPCIONAL de propósito: `buscarLicitacoesParaFiltro` devolve o
   * resultado cru do SELECT com um cast, e o fixture de `preview-emails.ts` é
   * estático — campo obrigatório quebraria os dois na compilação.
   */
  coberturaCrc?:  "SEM_ITENS" | "COBERTO" | "PARCIAL" | "NENHUM";
}

export interface DigestFiltroParams {
  nomeFiltro:       string;
  formato:          "resumido" | "completo";
  itens:            DigestFiltroItem[];
  totalEncontradas: number;
  teste?:           boolean;
  /**
   * Quantas famílias CRC ativas a Proponente tem — vira a nota de rodapé que
   * explica o badge. Opcional: sem ela (e sem nenhum item carregando o sinal)
   * o e-mail simplesmente não fala de CRC, em vez de falar com número errado.
   */
  familiasAtivas?:  number;
}

/** Dias até o prazo (dataFim YYYY-MM-DD, fuso de Brasília). null = sem prazo. */
function diasAtePrazo(dataFim: string | null): number | null {
  if (!dataFim || !/^\d{4}-\d{2}-\d{2}/.test(dataFim)) return null;
  const [y, m, d] = dataFim.slice(0, 10).split("-").map(Number);
  const hoje = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }));
  const prazo = new Date(y, m - 1, d);
  return Math.round((prazo.getTime() - hoje.getTime()) / 86_400_000);
}

/** Prazo com severidade: ≤3d crítico, ≤7d atenção, senão neutro. */
function badgePrazo(dataFim: string | null): string {
  const dias = diasAtePrazo(dataFim);
  if (dias === null) return badge("NEUTRO", "Prazo não informado");

  const dataFmt = formatDateStr(dataFim!.slice(0, 10));
  if (dias < 0) return badge("NEUTRO", `${dataFmt} · encerrada`);
  if (dias === 0) return badge("CRITICO", `${dataFmt} · último dia`, true);
  if (dias === 1) return badge("CRITICO", `${dataFmt} · falta 1 dia`, true);
  if (dias <= 3) return badge("CRITICO", `${dataFmt} · faltam ${dias} dias`, true);
  if (dias <= 7) return badge("ATENCAO", `${dataFmt} · faltam ${dias} dias`);
  return badge("NEUTRO", `${dataFmt} · faltam ${dias} dias`);
}

function badgeRelevancia(relevancia: string | null): string {
  const r = (relevancia ?? "").toUpperCase();
  if (r === "ALTA") return badge("CRITICO", "Alta");
  if (r === "MÉDIA" || r === "MEDIA") return badge("ATENCAO", "Média");
  if (r === "BAIXA") return badge("NEUTRO", "Baixa"); // era AZUL na UI
  return "";
}

/** Fonte: Petronect = OK (é a fonte primária); Transparência = NEUTRO. */
function badgeFonte(fonte: string): string {
  return fonte === "transparencia" ? badge("NEUTRO", "Transparência") : badge("OK", "Petronect");
}

/**
 * Badge de cobertura CRC — responde "temos habilitação para isto?".
 *
 * Sem o campo, devolve string vazia: o e-mail não inventa um "não" quando a
 * resposta real é "não sei". SEM_ITENS e NENHUM são estados DIFERENTES e têm
 * textos diferentes — o portal simplesmente não publicou os itens em boa parte
 * das licitações, e tratar isso como "não temos CRC" seria mentira.
 *
 * Nunca sólido: o único badge sólido do card é o de prazo ≤3 dias, e dois
 * elementos sólidos competindo tiram a urgência do prazo, que é o que decide.
 */
/** Rótulo textual da cobertura — usado no formato completo e na versão text/. */
function rotuloCoberturaCrc(c: NonNullable<DigestFiltroItem["coberturaCrc"]>): string {
  switch (c) {
    case "COBERTO":   return "Temos CRC para todos os itens";
    case "PARCIAL":   return "Temos CRC para parte dos itens";
    case "NENHUM":    return "Nenhum item coberto pelo nosso CRC";
    case "SEM_ITENS": return "O portal não publicou os itens — não dá para saber";
  }
}

function badgeCoberturaCrc(item: DigestFiltroItem): string {
  switch (item.coberturaCrc) {
    case "COBERTO":  return badge("OK",      "Temos CRC");
    case "PARCIAL":  return badge("ATENCAO", "CRC parcial");
    // NEUTRO, nao CRITICO: "sem CRC" e um estado muito comum entre as licitacoes que casam
    // com perfil assinado. Pintar boa parte do digest de
    // vermelho seria fadiga de alarme e ainda tiraria peso do unico badge solido
    // do e-mail, o de prazo <= 3 dias. Nao ter CRC nao veta participar — muda o
    // preparo. O texto ja distingue de SEM_ITENS, que e "nao da para saber".
    case "NENHUM":   return badge("NEUTRO",  "Sem CRC");
    case "SEM_ITENS":return badge("NEUTRO",  "Itens não publicados");
    default:         return "";
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ACESSO — SOLICITAÇÃO PENDENTE
// ════════════════════════════════════════════════════════════════════════════

export interface SolicitacaoAcessoParams {
  nome:  string | null;
  email: string;
}

/**
 * Alguém do tenant entrou pelo SSO e caiu na fila de aprovação.
 *
 * Sem este aviso a fila era SILENCIOSA: a pessoa via "acesso pendente" e ficava
 * esperando até um ADMIN abrir o Admin Center por acaso — o badge de pendentes
 * só aparece dentro de /admin. Com o "Assignment required" desligado no Entra
 * (06/08/2026), a fila passou a ser o ÚNICO portão, então avisar virou requisito.
 */
export function templateSolicitacaoAcesso(p: SolicitacaoAcessoParams) {
  const quem = p.nome?.trim() || p.email;
  const subject = assunto("AVISO", "Novo pedido de acesso", quem);
  const preheader = preheaderTexto(quem, p.email, "aguardando aprovação");

  const conteudo = bloco(
    kicker("ACESSO"),
    h1("Novo pedido de acesso"),
    espaco(16),
    card(
      "MARCA",
      infoBox([
        infoRow("Nome", esc(quem)),
        infoRow("E-mail", esc(p.email)),
        infoRow("Situação", "Aguardando aprovação — <strong>ainda não entra</strong>"),
      ]),
    ),
    espaco(16),
    paragrafo(
      "A pessoa autenticou pela conta Microsoft do tenant, mas fica sem acesso "
      + "até um administrador aprovar e definir o papel.",
    ),
    espaco(20),
    botao(`${baseUrl}/admin/solicitacoes`, "Analisar o pedido"),
  );

  const text = [
    `Novo pedido de acesso — ${quem}`,
    "",
    `Nome: ${quem}`,
    `E-mail: ${p.email}`,
    "Situacao: aguardando aprovacao (ainda nao entra)",
    "",
    `Analisar: ${baseUrl}/admin/solicitacoes`,
    rodapeTexto(),
  ].join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

/**
 * Bloco obrigatório (decisão do dono): briefing/checklist só na plataforma.
 *
 * O texto acompanha a chave FEATURE_BRIEFING_IA. Com a geração de briefing
 * desligada (05/08/2026), prometer briefing no e-mail mandaria o usuário clicar
 * para encontrar um botão que não existe mais — então só o Checklist é citado.
 */
function briefingLigado(): boolean {
  return process.env.FEATURE_BRIEFING_IA === "1";
}

function blocoBriefingPlataforma(): string {
  const corpo = briefingLigado()
    ? `O <strong style="color:${TXT_FORTE};">Briefing</strong> e o <strong style="color:${TXT_FORTE};">Checklist</strong> de cada licitação são gerados <strong style="color:${TXT_FORTE};">exclusivamente na plataforma Petro Radar</strong> — abra a licitação para gerar.`
    : `O <strong style="color:${TXT_FORTE};">Checklist</strong> de cada licitação é gerado <strong style="color:${TXT_FORTE};">exclusivamente na plataforma Petro Radar</strong> — abra a licitação para gerar.`;
  return card("MARCA", `<span style="font-size:14px;line-height:22px;">${corpo}</span>`);
}

export function templateDigestFiltro(p: DigestFiltroParams) {
  const n = p.totalEncontradas;
  const fato = `${n} ${n === 1 ? "licitação nova" : "licitações novas"}`;
  const subject = `${p.teste ? "[TESTE] " : ""}${assunto("AVISO", fato, p.nomeFiltro)}`;

  const comPrazoCurto = p.itens.filter((i) => {
    const d = diasAtePrazo(i.dataFim);
    return d !== null && d >= 0 && d <= 7;
  }).length;
  const altaRelevancia = p.itens.filter((i) => (i.relevancia ?? "").toUpperCase() === "ALTA").length;
  // Só COBERTO conta como "com CRC". PARCIAL fica de fora de propósito: no
  // preview da caixa de entrada não cabe a ressalva, e "3 com CRC" contando
  // parciais prometeria mais do que o card entrega.
  const comCrc = p.itens.filter((i) => i.coberturaCrc === "COBERTO").length;

  const preheader = preheaderTexto(
    p.nomeFiltro,
    comPrazoCurto > 0 ? `${comPrazoCurto} com prazo <= 7 dias` : null,
    altaRelevancia > 0 ? `${altaRelevancia} de alta relevância` : null,
    comCrc > 0 ? `${comCrc} com CRC` : null,
  );

  const cards = p.itens
    .map((item, i) => {
      const objetoCompleto = item.objeto || item.objetoResumido || null;
      const sev: Severidade = sevRelevancia(item.relevancia);
      const href = linkLicitacao(item.id);

      // .stack nas DUAS células: no mobile o nº do edital e os badges caem em
      // linhas próprias. Sem isso, o par (nº mono + badge "Transparência") não
      // tem ponto de quebra e impõe um min-width de ~252px que, somado ao rail
      // + padding do card, ainda estourava o viewport de 320px mesmo depois de
      // os badges passarem a quebrar (medido: 341px num iPhone SE).
      const cabecalho = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td valign="middle" class="stack dm-txt-fraco" style="font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;color:${TXT_FRACO};">
          ${esc(String(i + 1).padStart(2, "0"))}&nbsp;&nbsp;${numeroEdital(item.numero, href)}
        </td>
        <td align="right" valign="middle" class="stack">${badgeLinha(badgeRelevancia(item.relevancia), badgeFonte(item.fonte))}</td>
      </tr></table>`;

      const objetoHtml = `<p class="dm-txt" style="margin:12px 0 0;font-family:${FONTE};font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:${TXT_FORTE};">${objetoCompleto ? esc(objetoCompleto) : "—"}</p>`;

      // Prazo + cobertura CRC na MESMA linha: sao os dois sinais que decidem
      // participacao. Score diz "interessa"; CRC diz "podemos".
      const prazoHtml = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;"><tr><td height="14" style="height:14px;font-size:0;line-height:0;">&nbsp;</td></tr><tr><td>${badgeLinha(badgePrazo(item.dataFim), badgeCoberturaCrc(item))}</td></tr></table>`;

      // Linha SÓ entra se tiver valor. Antes toda linha vazia virava um "—", e um
      // item da Transparência (que chega sem empresa/tipo/segmento/score) produzia
      // uma caixa com quatro travessões — parecia dado corrompido. Sem valor
      // nenhum, a caixa inteira some.
      const linhasMeta = [
        item.empresa ? infoRow("Empresa", esc(item.empresa)) : null,
        item.tipoServico ? infoRow("Tipo de serviço", esc(item.tipoServico)) : null,
        item.segmento ? infoRow("Segmento", esc(item.segmento)) : null,
        item.scoreInteresse != null
          ? infoRow("Score de interesse", esc(`${item.scoreInteresse} / 100`))
          : null,
        item.coberturaCrc ? infoRow("Habilitação (CRC)", esc(rotuloCoberturaCrc(item.coberturaCrc))) : null,
      ].filter((l): l is string => l !== null);

      const metaHtml = p.formato === "completo"
        ? (linhasMeta.length > 0 ? espaco(12) + infoBox(linhasMeta) : "")
        : item.empresa
          ? `<p class="dm-txt-fraco" style="margin:10px 0 0;font-family:${FONTE};font-size:14px;line-height:20px;mso-line-height-rule:exactly;color:${TXT_FRACO};">Empresa: ${esc(item.empresa)}</p>`
          : "";

      const conteudoCard = [
        cabecalho,
        objetoHtml,
        prazoHtml,
        metaHtml,
        espaco(14),
        botao(href, "Abrir no Petro Radar"),
      ].join("");

      return card(sev, conteudoCard);
    })
    .join(espaco(16));

  const maisNaPlataforma = n > p.itens.length
    ? card(
        "NEUTRO",
        `<span style="font-size:14px;line-height:22px;">E mais <strong style="color:${TXT_FORTE};">${esc(String(n - p.itens.length))}</strong> licitações casaram com este filtro. <a href="${esc(`${baseUrl}/explorar`)}" target="_blank" style="color:${TXT_FORTE};text-decoration:underline;">Ver todas no Explorar</a>.</span>`,
      )
    : "";

  // Nota que explica o badge — SÓ entra se algum card realmente exibiu o sinal.
  // Sem essa guarda, um digest todo de itens sem item publicado (SEM_ITENS não
  // gera badge visível de cobertura) traria um rodapé explicando um selo que
  // ninguém viu. Fica ABAIXO dos cards: é ressalva, não manchete.
  const notaCrc = p.familiasAtivas != null && p.itens.some((i) => i.coberturaCrc)
    ? card(
        "NEUTRO",
        `<span style="font-size:14px;line-height:22px;">A Proponente tem <strong style="color:${TXT_FORTE};">${esc(String(p.familiasAtivas))}</strong> famílias CRC ativas. <strong style="color:${TXT_FORTE};">Temos CRC</strong> quer dizer que todos os itens já publicados caem em famílias que possuímos — <strong style="color:${TXT_FORTE};">não é habilitação garantida</strong>: atestado, acervo e as demais exigências do edital continuam valendo.</span>`,
      )
    : "";

  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", timeZone: "America/Sao_Paulo",
  });

  const conteudo = bloco(
    kicker("Digest de licitações"),
    h1(`${n} ${n === 1 ? "licitação nova" : "licitações novas"}`),
    meta(
      `Filtro <strong style="color:${TXT_FORTE};">${esc(p.nomeFiltro)}</strong> &middot; ${esc(hoje)}${
        p.itens.length < n ? ` &middot; exibindo as ${esc(String(p.itens.length))} mais relevantes` : ""
      }`,
    ),
    blocoBriefingPlataforma(),
    cards,
    maisNaPlataforma,
    notaCrc,
  );

  const textItens = p.itens
    .map((item, i) => {
      const dias = diasAtePrazo(item.dataFim);
      const prazoTxt = item.dataFim
        ? `${formatDateStr(item.dataFim.slice(0, 10))}${dias !== null && dias >= 0 ? ` (faltam ${dias} dias)` : ""}`
        : "não informado";
      return [
        `${String(i + 1).padStart(2, "0")}. ${item.numero}${
          (item.relevancia ?? "").toUpperCase() === "ALTA" ? " [ALTA]" : ""
        } — ${item.fonte === "transparencia" ? "Transparência" : "Petronect"}`,
        `    ${item.objeto || item.objetoResumido || "—"}`,
        `    Prazo: ${prazoTxt}`,
        ...(item.coberturaCrc ? [`    Habilitação: ${rotuloCoberturaCrc(item.coberturaCrc)}`] : []),
        `    ${linkLicitacao(item.id)}`,
      ].join("\n");
    })
    .join("\n\n");

  const text = [
    `${n} ${n === 1 ? "licitação nova" : "licitações novas"} — filtro ${p.nomeFiltro}`,
    "",
    textItens,
    n > p.itens.length ? `\nE mais ${n - p.itens.length} na plataforma: ${baseUrl}/explorar` : "",
    "",
    notaCrc
      ? `A Proponente tem ${p.familiasAtivas} famílias CRC ativas. "Temos CRC" quer dizer que todos os itens já publicados caem em famílias que possuímos — não é habilitação garantida: atestado, acervo e as demais exigências do edital continuam valendo.\n`
      : "",
    briefingLigado()
      ? "O Briefing e o Checklist são gerados exclusivamente na plataforma Petro Radar."
      : "O Checklist é gerado exclusivamente na plataforma Petro Radar.",
    rodapeTexto(),
  ].filter(Boolean).join("\n");

  return { subject, html: render(subject, preheader, conteudo), text };
}

// Reexport para os call-sites que só precisam do laranja da marca (nenhum hoje);
// mantido para evitar que alguém redeclare o hex fora dos tokens.
export { LARANJA as PROPONENTE_LARANJA };

// nl2br é usado por truncNl; reexportado para uso futuro em campos multi-linha.
export { nl2br };
