/**
 * preview-emails.ts — Renderiza os 14 templates de e-mail com dados falsos.
 *
 * Rodar (a partir de app/):
 *   npx tsx scripts/preview-emails.ts
 *   OUT=/tmp/emails npx tsx scripts/preview-emails.ts
 *
 * Saída: <OUT>/<slug>.html (14 arquivos) + <OUT>/index.html (galeria).
 *
 * POR QUE FUNCIONA SEM CONFIG DE ALIAS:
 *   src/lib/email/templates.ts NÃO tem nenhum import (zero `@/`). É um módulo
 *   puro: só usa process.env.NEXTAUTH_URL. Então tsx importa por caminho
 *   relativo e não precisa de tsconfig-paths / next / db / rede.
 *
 * cid:logo-proponente — o <img> do layoutProponente só resolve no Outlook via
 * inlineImages do sendEmail(). Aqui trocamos por um data: URI para o browser
 * mostrar o logo. O relatório de fidelidade continua válido porque a troca é
 * puramente do transporte, não do markup.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import * as T from "../src/lib/email/templates";
import { LOGO_PROPONENTE_BASE64, LOGO_PROPONENTE_CID } from "../src/lib/email/logo-proponente";

const OUT = resolve(process.env.OUT ?? "/tmp/petro-emails");

// Datas fixas => saída determinística (bom p/ diff e p/ screenshot estável).
const D = (iso: string) => new Date(iso);

const kpis: T.DigestKpi[] = [
  { rotulo: "Licitações novas", valor: "42", variacao: "+12% vs. semana anterior", tendencia: "up" },
  { rotulo: "Em disputa",       valor: "8",  variacao: "-2 vs. semana anterior",   tendencia: "down" },
  { rotulo: "Valor mapeado",    valor: "R$ 100,0 MM", variacao: null, tendencia: "neutral" },
];

const itensDigest: T.DigestFiltroItem[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    numero: "7004991005", objeto: "Serviços de engenharia consultiva para a Unidade Exemplo A.",
    objetoResumido: "Engenharia consultiva — Unidade Exemplo A",
    empresa: "PETROBRAS", dataFim: "2026-08-12",
    relevancia: "ALTA", scoreInteresse: 92, tipoServico: "Engenharia", segmento: "Refino", fonte: "petronect",
    coberturaCrc: "COBERTO",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    numero: "7004991003", objeto: "Serviços de apoio técnico (exemplo fictício), 10 postos, 12 meses.",
    objetoResumido: "Apoio técnico — 10 postos",
    empresa: "TRANSPETRO", dataFim: "2026-07-06",
    relevancia: "MEDIA", scoreInteresse: 71, tipoServico: "Apoio Técnico", segmento: "Logística", fonte: "petronect",
    coberturaCrc: "PARCIAL",
  },
  {
    // NENHUM e um estado muito comum — precisa estar no preview,
    // senao a revisao visual so olha o caso bonito.
    id: "44444444-4444-4444-4444-444444444444",
    numero: "7004991010", objeto: "Serviços de movimentação de cargas (exemplo fictício), 100 diárias, 12 meses.",
    objetoResumido: "Movimentação de cargas — 100 diárias",
    empresa: "TRANSPETRO", dataFim: "2026-09-30",
    relevancia: "MEDIA", scoreInteresse: 64, tipoServico: "Apoio Técnico", segmento: "Logística", fonte: "petronect",
    coberturaCrc: "NENHUM",
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    numero: "7004991009", objeto: "Serviços de manutenção industrial em unidade de processo.",
    objetoResumido: "Manutenção industrial — unidade de processo",
    empresa: "PETROBRAS", dataFim: "2026-08-09",
    relevancia: "ALTA", scoreInteresse: 81, tipoServico: "Manutenção", segmento: "Refino", fonte: "petronect",
    coberturaCrc: "SEM_ITENS",
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    numero: "7004991015", objeto: null, objetoResumido: null,
    empresa: null, dataFim: null,
    relevancia: null, scoreInteresse: null, tipoServico: null, segmento: null, fonte: "transparencia",
    // sem coberturaCrc: prova que o badge SOME quando nao ha resposta
  },
];

// Um caso por template. O nome vira o arquivo .html.
const CASOS: Array<{ slug: string; render: () => { subject: string; html: string; text: string } }> = [
  // Cobre as TRÊS faixas do e-mail consolidado (hoje / até 3 dias / semana).
  { slug: "03-prazo-critico-licitacao", render: () => T.templatePrazosCriticos({
      janelaDias: 7,
      itens: [
        { licitacaoId: "aaaa-3333", numero: "7004991002",
          objeto: "Postos de serviço (exemplo fictício) — Lotes A e B.", empresa: "PETROBRAS",
          relevancia: "ALTA", dataFim: "2026-08-07", horaFim: "17:00", diasRestantes: 0 },
        { licitacaoId: "bbbb-4444", numero: "7004991013",
          objeto: "Controle de resíduos e efluentes (exemplo fictício), 10 postos.",
          empresa: "TRANSPETRO",
          relevancia: "ALTA", dataFim: "2026-08-07", horaFim: "14:30", diasRestantes: 0 },
        { licitacaoId: "cccc-5555", numero: "7004991011",
          objeto: "Operação e manutenção de instalação terrestre (exemplo fictício), 24 meses.",
          empresa: "PETROBRAS",
          relevancia: "ALTA", dataFim: "2026-08-10", horaFim: "09:00", diasRestantes: 3 },
        { licitacaoId: "dddd-6666", numero: "7004991016",
          objeto: "Serviços de engenharia (exemplo fictício).", empresa: "PETROBRAS",
          relevancia: "MÉDIA", dataFim: "2026-08-13", horaFim: null, diasRestantes: 6 },
      ] }) },

  { slug: "04-sync-falhou", render: () => T.templateSyncFalhou({
      tipo: "petronect", executadoEm: "2026-07-14 03:15", erros: 3, totalEncontradas: 128,
      detalhes: "Timeout no OData GET_PUB_LIC_IN_PROGRESS_SRV após 3 tentativas.",
      horasSemSync: 26, githubRepo: "owner/petro-radar" }) },

  { slug: "05-vencimento-documento", render: () => T.templateVencimentoDocumento({
      documentoId: "aaaa-5555", titulo: "CND Federal — Receita Federal", categoria: "Fiscal",
      subcategoria: "Certidão Negativa", validadeFim: D("2026-08-13T00:00:00Z"),
      diasRestantes: 30, tipoAlerta: "D-30" }) },

  { slug: "06-vencimento-familia", render: () => T.templateVencimentoFamilia({
      familiaId: "aaaa-6666", codigoCrc: "99000001", nome: "Família de exemplo",
      validadeFim: D("2026-09-01T00:00:00Z"), diasRestantes: 49, segmentoPetrobras: "Refino" }) },

  { slug: "07-envelope-incompleto", render: () => T.templateEnvelopeIncompleto({
      envelopeId: "aaaa-7777", numeroEdital: "7004991001",
      prazoProtocolo: D("2026-07-18T18:00:00Z"), totalItens: 24, itensFaltantes: 5, itensVencidos: 2 }) },

  { slug: "08-contrato-critico", render: () => T.templateContratoCritico({
      contratoId: "aaaa-8888", numero: "CT-EXEMPLO-001", objeto: "Contrato de exemplo (dados fictícios).",
      periodoFim: D("2026-10-31T00:00:00Z"),
      motivosCriticos: ["CND Federal vencida há 3 dias", "ISO 9001 vence antes do fim do contrato"] }) },

  { slug: "09-cnpj-situacao", render: () => T.templateCnpjSituacao({
      cnpj: "11.222.333/0001-81", razaoSocial: "PROPONENTE ENGENHARIA LTDA",
      situacaoAnterior: "ATIVA", situacaoAtual: "SUSPENSA",
      motivo: "Pendência cadastral na Receita Federal.", ultimaAtualizacao: D("2026-07-13T09:00:00Z") }) },

  { slug: "11-convocacao-remanescente", render: () => T.templateConvocacaoRemanescente({
      licitacaoId: "aaaa-1111b", numero: "7004991006",
      objeto: "Serviços de facilities (exemplo fictício).", posicaoProponente: 2,
      empresaAnterior: "EMPRESA EXEMPLO LTDA", tipoEvento: "DESCLASSIFICADO",
      motivo: "Atestado técnico não atendeu ao item D.3.1.", dataEvento: D("2026-07-11T10:00:00Z"),
      valorPropostaProponente: "1000000.00" }) },

  { slug: "12-digest-executivo", render: () => T.templateDigestExecutivo({
      periodoLabel: "Semana de 07 a 13/07/2026", kpis,
      secoes: [
        { titulo: "Maiores oportunidades", itens: [
          { texto: "Licitação 7004991005 — Score 92", href: "https://radar.example.com/licitacoes/1" },
          { texto: "Licitação 7004991003 — Score 71", href: null },
        ] },
        { titulo: "Prazos desta semana", itens: [{ texto: "7004991002 encerra em 2 dias" }] },
      ],
      alertasCrc: ["Família 99000002 sem atestado — 3 licitações bloqueadas (exemplo)"] }) },

  { slug: "13-relatorio-mensal", render: () => T.templateRelatorioMensal({
      mesLabel: "Junho/2026", kpis,
      observacoes: ["Família 99000003 segue sem atestado no acervo (exemplo).", "2 CRCs vencem em agosto."] }) },

  { slug: "14-digest-filtro", render: () => T.templateDigestFiltro({
      nomeFiltro: "Filtro de exemplo", formato: "completo",
      itens: itensDigest, totalEncontradas: 12, teste: false, familiasAtivas: 10 }) },
];

/** Troca cid:<id> por data: URI só para o browser conseguir exibir o logo. */
function cidParaDataUri(html: string): string {
  return html.replaceAll(
    `cid:${LOGO_PROPONENTE_CID}`,
    `data:image/png;base64,${LOGO_PROPONENTE_BASE64}`,
  );
}

mkdirSync(OUT, { recursive: true });

const gerados: Array<{ slug: string; subject: string; temCid: boolean }> = [];

for (const caso of CASOS) {
  const { subject, html } = caso.render();
  const temCid = html.includes(`cid:${LOGO_PROPONENTE_CID}`);
  const doc = cidParaDataUri(html);
  writeFileSync(resolve(OUT, `${caso.slug}.html`), doc, "utf8");
  gerados.push({ slug: caso.slug, subject, temCid });
  console.log(`✓ ${caso.slug.padEnd(28)} ${temCid ? "[cid:logo]" : "[sem logo]"}  ${subject}`);
}

const index = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Preview — e-mails Petro Radar</title>
<style>body{font-family:Inter,'Segoe UI',Arial,sans-serif;margin:24px;background:#F5F5F5;color:#1D1D1B}
h1{font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;border-bottom:3px solid #F59C00;padding-bottom:8px}
li{margin:6px 0}code{background:#fff;padding:2px 6px;border:1px solid #e5e5e5}</style></head><body>
<h1>Preview — ${gerados.length} e-mails</h1><ol>
${gerados.map((g) => `<li><a href="./${g.slug}.html">${g.slug}</a> — ${g.subject}${g.temCid ? " <strong>(usa cid:logo)</strong>" : ""}</li>`).join("\n")}
</ol></body></html>`;
writeFileSync(resolve(OUT, "index.html"), index, "utf8");

console.log(`\n${gerados.length} arquivos em ${OUT}`);
console.log(`Galeria: file://${resolve(OUT, "index.html")}`);
