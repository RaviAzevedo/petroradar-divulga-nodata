/**
 * Primitivos do Design System de E-mail Proponente — Petro Radar.
 *
 * REGRA SOBERANA: o alvo real é o motor Word do Outlook/Exchange. Tudo aqui é
 * escrito para ele. Se um recurso não sobrevive ao Word, ele não entra.
 *
 * Os 12 "nãos" aplicados neste arquivo:
 *   1. Sem azul (nenhum hex da família "blue" do Tailwind).
 *   2. Sem slate/zinc (o preto é #1D1D1B, não o slate-900 azulado).
 *   3. Sem o laranja antigo/errado — o laranja é #F59C00.
 *   4. Laranja NUNCA é texto (só fundo/filete/tarja/rail; ou sobre preto).
 *   5. Sem inline-block, flex, grid, float ou position.
 *   6. padding SÓ em <td>.
 *   7. Sem margin em layout — espaço vertical é <td height="N">.
 *   8. Sempre bgcolor="#XXX" + background-color:#XXX (nunca o shorthand).
 *   9. Sem sombra, sem raio estrutural, sem pre-wrap, sem lista nativa HTML.
 *  10. Todo dado externo passa por esc()/trunc()/nl2br().
 *  11. Sem emoji.
 *  12. Todo <td> com texto tem background-color explícito (defesa de dark mode).
 *
 * LOGO — DESVIO CONSCIENTE DA SPEC §2.3 (header em tarja preta):
 *   lib/email/logo-proponente.ts está congelado nesta lane e contém o PNG RGBA
 *   (fundo transparente) com a ARTE ESCURA. Sobre uma tarja #1D1D1B esse ativo
 *   simplesmente DESAPARECE. Enquanto o asset knockout (branco/laranja achatado
 *   sobre #1D1D1B, sem alpha) não existir, o header fica em #FFFFFF explícito e
 *   a marca aparece como ESTRUTURA no filete laranja de 4px logo abaixo + na
 *   tarja preta do rodapé. Assim que o knockout entrar, basta trocar o bgcolor
 *   do header para #1D1D1B e a cor do wordmark para #FFFFFF — nada mais muda.
 */

import { esc, escAttr, escUrl, subjectTexto } from "./escape";
import {
  BORDA,
  CANVAS,
  CARD,
  DIVISOR,
  ESTADO,
  FONTE,
  FONTE_MARCA,
  FONTE_MONO,
  LARANJA,
  PRETO,
  SUPERF,
  TXT_CORPO,
  TXT_FORTE,
  TXT_FRACO,
  TXT_INV_FRACO,
  type Severidade,
} from "./tokens";

export const LOGO_CID = "logo-proponente";

// ════════════════════════════════════════════════════════════════════════════
// SHELL — o layout ÚNICO. Substitui layout() e layoutProponente().
// ════════════════════════════════════════════════════════════════════════════

export interface ShellParams {
  /** == subject (vai no <title>). Escapado internamente. */
  titulo: string;
  /** Texto do preview do Outlook. Já escapado pelo chamador (preheaderTexto). */
  preheader: string;
  /** HTML do corpo, montado com os primitivos. */
  conteudo: string;
  /** Base URL do app (deep-links do rodapé). */
  baseUrl: string;
}

/** Espaçador invisível que empurra o corpo para fora do snippet da caixa. */
const PREHEADER_PAD =
  "&#8199;&#65279;&#847;".repeat(12);

export function shell(p: ShellParams): string {
  const base = escUrl(p.baseUrl);
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="pt-BR" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <meta name="x-apple-disable-message-reformatting" />
  <!-- OBRIGATÓRIO: sem isto o iOS transforma "7004991001" em link de TELEFONE azul -->
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no" />
  <title>${esc(p.titulo)}</title>
  <!--[if mso]>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  <style>
    * { font-family: 'Segoe UI', Arial, sans-serif !important; }
    table { border-collapse: collapse; }
  </style>
  <![endif]-->
  <style>
    /* LIGHT ONLY (2026-08-05, decisao do dono): o e-mail tem UM tema, o claro.
       "light only" e o sinal mais forte que existe — o Apple Mail (iOS/macOS) e
       o Outlook macOS param de inverter ao ver isto. */
    :root { color-scheme: light only; supported-color-schemes: light; }
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table { border-collapse:collapse !important; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
    a { text-decoration:underline; }

    @media screen and (max-width:640px) {
      .container { width:100% !important; }
      .p-lat     { padding-left:16px !important; padding-right:16px !important; }
      .stack     { display:block !important; width:100% !important; box-sizing:border-box !important; }
      .hide-sm   { display:none !important; }

      /* BADGES — a linha de badges era a ÚNICA coisa que estourava o viewport.
         Como <td>s de uma única <tr> não têm ponto de quebra, a soma dos badges
         impunha um min-width (medido: 489px num viewport de 380px) e empurrava
         a MENSAGEM INTEIRA para fora da tela — o usuário tinha que arrastar de
         lado. No mobile cada badge vira bloco e cai na sua própria linha; as
         calhas de 8px somem (viram a margem inferior de 8px do bloco). */
      .badge-cel { display:block !important; width:100% !important; padding:0 0 8px 0 !important; }
      .badge-gap { display:none !important; }

      /* KPI — a calha de 6px sobrevivia ao .stack e dava zigue-zague nos cards
         empilhados (esquerda 0/6, direita 6/0). Empilhado não há calha lateral. */
      .kpi-cel   { padding:0 0 12px 0 !important; }
    }

    /* ── DEFESA CONTRA INVERSAO AUTOMATICA ──────────────────────────────────
       Ate 05/08/2026 este bloco DESENHAVA um tema escuro. Foi removido: o dono
       viu o digest chegar preto, com o numero do edital em vinho sobre fundo
       escuro e o nome do filtro sumido — ilegivel. E o cliente dele foi ALEM do
       tema desenhado: inverteu ate o cabecalho, que era para ficar claro.

       Agora as classes dm-* nao escurecem nada; elas REAFIRMAM o claro. O
       Outlook.com carimba [data-ogsc]/[data-ogsb] no que inverte, entao usamos
       o proprio gatilho dele para desfazer a inversao.

       Limite honesto: o app do Gmail no Android inverte por conta propria, sem
       gatilho que se possa interceptar. Contra ele a defesa que resta e o
       bgcolor explicito em cada <td> (ja e assim no markup inteiro). */
    [data-ogsc] .dm-canvas,    [data-ogsb] .dm-canvas    { background-color:${CANVAS} !important; }
    [data-ogsc] .dm-card,      [data-ogsb] .dm-card      { background-color:${CARD} !important; border-color:${BORDA} !important; }
    [data-ogsc] .dm-surface,   [data-ogsb] .dm-surface   { background-color:${SUPERF} !important; border-color:${BORDA} !important; }
    [data-ogsc] .dm-txt        { color:${TXT_CORPO} !important; }
    [data-ogsc] .dm-txt-forte  { color:${TXT_FORTE} !important; }
    [data-ogsc] .dm-txt-fraco  { color:${TXT_FRACO} !important; }
    [data-ogsc] .dm-borda      { border-color:${BORDA} !important; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${CANVAS};" bgcolor="${CANVAS}">

  <!-- PREHEADER (preview do Outlook). Sempre o 1º filho do body. -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
    ${p.preheader}${PREHEADER_PAD}
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${CANVAS}" class="dm-canvas" style="background-color:${CANVAS};">
    <tr>
      <td align="center" style="padding:24px 20px;">

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" class="container" style="width:600px;max-width:600px;">

          <!-- ── HEADER: marca + wordmark do produto ────────────────────────── -->
          <tr>
            <td bgcolor="${CARD}" class="p-lat" style="background-color:${CARD};padding:20px 24px;border:1px solid ${BORDA};border-bottom:0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="left" valign="middle">
                    <img src="cid:${LOGO_CID}" width="200" height="45" alt="Petro Radar" style="display:block;border:0;width:200px;height:45px;" />
                  </td>
                  <td align="right" valign="middle" class="hide-sm" style="font-family:${FONTE_MARCA};font-size:14px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:1px;color:${PRETO};text-transform:uppercase;">
                    Petro&nbsp;Radar
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── FAIXA LARANJA (filete de 4px — a marca como ESTRUTURA) ────── -->
          <tr>
            <td bgcolor="${LARANJA}" height="4" style="background-color:${LARANJA};height:4px;line-height:4px;font-size:0;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>

          <!-- ── CORPO ──────────────────────────────────────────────────────── -->
          <tr>
            <td bgcolor="${CARD}" class="p-lat dm-card" style="background-color:${CARD};padding:24px;border-left:1px solid ${BORDA};border-right:1px solid ${BORDA};border-bottom:1px solid ${BORDA};font-family:${FONTE};font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:${TXT_CORPO};word-break:break-word;overflow-wrap:anywhere;">
              ${p.conteudo}
            </td>
          </tr>

          <!-- ── FOOTER: tarja PRETA ────────────────────────────────────────── -->
          <tr>
            <td bgcolor="${PRETO}" class="p-lat" style="background-color:${PRETO};padding:20px 24px;font-family:${FONTE};font-size:12px;line-height:18px;mso-line-height-rule:exactly;color:${TXT_INV_FRACO};">
              <strong style="color:#FFFFFF;">Petro Radar</strong><br />
              Alerta automático do sistema interno. Não responda a este e-mail.<br />
              <a href="${base}/admin/emails" style="color:${LARANJA};text-decoration:underline;">Preferências de e-mail</a>
              &nbsp;&middot;&nbsp;
              <a href="${base}" style="color:${LARANJA};text-decoration:underline;">Abrir o Petro Radar</a>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════════════
// TÍTULOS
// ════════════════════════════════════════════════════════════════════════════

export function kicker(texto: string): string {
  return `<p class="dm-txt-fraco" style="margin:0 0 4px;font-family:${FONTE_MARCA};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${TXT_FRACO};">${esc(texto)}</p>`;
}

export function h1(texto: string): string {
  return `<h1 class="dm-txt-forte" style="margin:0 0 16px;font-family:${FONTE};font-size:24px;line-height:30px;mso-line-height-rule:exactly;font-weight:700;color:${TXT_FORTE};">${esc(texto)}</h1>`;
}

export function h2(texto: string): string {
  return `<h2 class="dm-txt-forte" style="margin:0 0 8px;font-family:${FONTE};font-size:18px;line-height:24px;mso-line-height-rule:exactly;font-weight:700;color:${TXT_FORTE};">${esc(texto)}</h2>`;
}

/** Parágrafo de corpo. Recebe HTML JÁ ESCAPADO/montado. */
export function paragrafo(html: string): string {
  return `<p class="dm-txt" style="margin:0 0 16px;font-family:${FONTE};font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:${TXT_CORPO};">${html}</p>`;
}

/** Parágrafo secundário (meta, 14px). Recebe HTML JÁ ESCAPADO/montado. */
export function meta(html: string): string {
  return `<p class="dm-txt-fraco" style="margin:0 0 12px;font-family:${FONTE};font-size:14px;line-height:20px;mso-line-height-rule:exactly;color:${TXT_FRACO};">${html}</p>`;
}

/** Nº de edital: mono + bold + PRETO (laranja como texto reprova 2,18:1). */
export function numeroEdital(numero: string, href?: string | null): string {
  const txt = `<span style="font-family:${FONTE_MONO};font-weight:700;color:${TXT_FORTE};">${esc(numero)}</span>`;
  return href
    ? `<a href="${escUrl(href)}" target="_blank" style="color:${TXT_FORTE};text-decoration:underline;">${txt}</a>`
    : txt;
}

// ════════════════════════════════════════════════════════════════════════════
// BADGES — em TABELA, nunca em <span> (o Word ignora padding em inline)
// ════════════════════════════════════════════════════════════════════════════

/**
 * SEM `white-space:nowrap` — DE PROPÓSITO.
 *
 * O nowrap fazia o badge impor um min-width igual à frase inteira. Badges de
 * texto longo ("IMPACTO EM HABILITAÇÃO" = 193px; o badge de prazo
 * "20 de julho de 2026 · faltam 6 dias" = 269px sozinho) não cabiam na faixa
 * útil de ~332px de um iPhone — e, como não podiam quebrar, estouravam o
 * viewport e levavam o e-mail inteiro junto. Sem nowrap o texto quebra DENTRO
 * do badge e a largura passa a ser limitada pelo container, não pela frase.
 * Em 600px (desktop) nada muda: o badge continua cabendo numa linha só.
 */
export function badge(sev: Severidade, texto: string, solido = false): string {
  const e = ESTADO[sev];
  const bg  = solido ? e.solido : e.bg;
  const bd  = solido ? e.solido : e.borda;
  const txt = solido ? e.solidoTxt : e.txt;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display:inline;"><tr>
    <td bgcolor="${bg}" style="background-color:${bg};border:1px solid ${bd};padding:3px 10px;font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${txt};">${esc(texto)}</td>
  </tr></table>`;
}

/**
 * Badges lado a lado — colunas de tabela, nunca &nbsp; solto nem margin.
 *
 * Desktop (>=640px): uma linha, calhas de 8px, célula-filler comendo a sobra à
 * direita (a tabela é 100% para o .badge-cel ter um containing block ao virar
 * bloco no mobile; a filler impede que a sobra estique os badges).
 * Mobile (<640px): .badge-cel vira bloco de 100% e cada badge cai numa linha;
 * .badge-gap (calhas + filler) some. Outlook Desktop ignora a media query e
 * fica no layout de 600px, onde nunca houve estouro.
 */
export function badgeLinha(...badgesHtml: Array<string | null | undefined | false>): string {
  const itens = badgesHtml.filter((b): b is string => Boolean(b));
  if (itens.length === 0) return "";
  const celulas = itens
    .map((b) => `<td valign="middle" class="badge-cel">${b}</td>`)
    .join(`<td width="8" class="badge-gap" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>`);
  const filler = `<td class="badge-gap" style="font-size:0;line-height:0;">&nbsp;</td>`;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;"><tr>${celulas}${filler}</tr></table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// BOTÃO CTA (bulletproof: <td> + bgcolor; VML só p/ o mso, canto reto)
// ════════════════════════════════════════════════════════════════════════════

export function botao(
  href: string,
  texto: string,
  variante: "primario" | "secundario" = "primario",
): string {
  const url = escUrl(href);
  const rot = esc(texto);
  const bg  = variante === "primario" ? LARANJA : CARD;
  // Fundo #F59C00 com texto #1D1D1B = 7,75:1 (AAA). NUNCA texto branco (2,18:1).
  const cor = variante === "primario" ? PRETO : TXT_CORPO;
  const bd  = variante === "primario" ? LARANJA : BORDA;

  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
    <td bgcolor="${bg}" align="center" style="background-color:${bg};border:1px solid ${bd};">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="0%" stroke="f" fillcolor="${bg}">
        <w:anchorlock/>
        <center style="color:${cor};font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold;">${rot}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-- -->
      <a href="${url}" target="_blank" style="display:block;padding:14px 28px;font-family:${FONTE};font-size:16px;line-height:20px;mso-line-height-rule:exactly;font-weight:700;color:${cor};text-decoration:none;mso-padding-alt:14px 28px;">${rot}</a>
      <!--<![endif]-->
    </td>
  </tr></table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// INFO ROW / INFO BOX
// ════════════════════════════════════════════════════════════════════════════

/** Linha rótulo/valor. `label` é escapado; `valorHtml` já vem pronto. */
export function infoRow(label: string, valorHtml: string): string {
  return `<tr>
    <td width="130" valign="top" class="stack dm-txt-fraco" style="padding:6px 12px 6px 0;font-family:${FONTE};font-size:14px;line-height:20px;mso-line-height-rule:exactly;color:${TXT_FRACO};">${esc(label)}</td>
    <td valign="top" class="stack dm-txt" style="padding:6px 0;font-family:${FONTE};font-size:16px;line-height:22px;mso-line-height-rule:exactly;font-weight:600;color:${TXT_FORTE};">${valorHtml}</td>
  </tr>`;
}

/** Caixa cinza que agrupa infoRows. Ignora entradas vazias. */
export function infoBox(linhas: Array<string | null | undefined | false>): string {
  const rows = linhas.filter((l): l is string => Boolean(l)).join("");
  if (!rows) return "";
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${SUPERF}" class="dm-surface" style="background-color:${SUPERF};border:1px solid ${BORDA};">
    <tr><td style="padding:16px 20px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
    </td></tr>
  </table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// CARD com rail de severidade (o filete à prova de Word: célula, não border)
// ════════════════════════════════════════════════════════════════════════════

export function card(sev: Severidade, conteudoHtml: string): string {
  const rail = ESTADO[sev].rail;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${CARD}" class="dm-card" style="background-color:${CARD};border:1px solid ${BORDA};">
    <tr>
      <td width="4" bgcolor="${rail}" style="background-color:${rail};width:4px;font-size:0;line-height:0;">&nbsp;</td>
      <td class="dm-txt" style="padding:16px 20px;font-family:${FONTE};font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:${TXT_CORPO};">${conteudoHtml}</td>
    </tr>
  </table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// ALERTA (bloco tintado por severidade)
// ════════════════════════════════════════════════════════════════════════════

export function alerta(sev: Severidade, titulo: string, corpoHtml: string): string {
  const e = ESTADO[sev];
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${e.bg}" class="dm-surface" style="background-color:${e.bg};border:1px solid ${e.borda};">
    <tr><td style="padding:16px 20px;font-family:${FONTE};font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:${e.txt};">
      <strong style="display:block;font-size:14px;line-height:20px;text-transform:uppercase;letter-spacing:.5px;">${esc(titulo)}</strong>
      ${corpoHtml}
    </td></tr>
  </table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// LISTA (substitui a lista nativa do HTML — o Word injeta indentação própria)
// ════════════════════════════════════════════════════════════════════════════

/** Itens já em HTML pronto. O marcador laranja é ESTRUTURA (glifo decorativo). */
export function lista(itens: string[]): string {
  if (itens.length === 0) return "";
  const linhas = itens
    .map(
      (item) => `<tr>
      <td width="16" valign="top" style="padding:4px 0;font-family:${FONTE};font-size:16px;line-height:22px;mso-line-height-rule:exactly;color:${LARANJA};font-weight:700;">&bull;</td>
      <td valign="top" class="dm-txt" style="padding:4px 0;font-family:${FONTE};font-size:16px;line-height:22px;mso-line-height-rule:exactly;color:${TXT_CORPO};">${item}</td>
    </tr>`,
    )
    .join("");
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">${linhas}</table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// TABELA DE DADOS (máx. 3 colunas em 600px)
// ════════════════════════════════════════════════════════════════════════════

export function tabela(
  colunas: Array<{ label: string; width?: number; align?: "left" | "right" }>,
  linhas: string[][], // células = HTML já pronto
): string {
  const ths = colunas
    .map(
      (c) =>
        `<th align="${c.align ?? "left"}" bgcolor="${SUPERF}" class="dm-surface dm-txt-fraco"${c.width ? ` width="${c.width}"` : ""} style="background-color:${SUPERF};padding:10px 16px;border-bottom:1px solid ${BORDA};font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${TXT_FRACO};">${esc(c.label)}</th>`,
    )
    .join("");

  const corpo =
    linhas.length === 0
      ? `<tr><td colspan="${colunas.length}" align="center" class="dm-txt-fraco" style="padding:40px 16px;font-family:${FONTE};font-size:14px;line-height:20px;color:${TXT_FRACO};background-color:${CARD};">Nada a exibir.</td></tr>`
      : linhas
          .map(
            (celulas) =>
              `<tr>${celulas
                .map(
                  (c, i) =>
                    `<td align="${colunas[i]?.align ?? "left"}" bgcolor="${CARD}" class="dm-txt" style="background-color:${CARD};padding:12px 16px;border-bottom:1px solid ${DIVISOR};font-family:${FONTE};font-size:14px;line-height:20px;mso-line-height-rule:exactly;color:${TXT_CORPO};">${c}</td>`,
                )
                .join("")}</tr>`,
          )
          .join("");

  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${CARD}" class="dm-card" style="background-color:${CARD};border:1px solid ${BORDA};border-collapse:collapse;">
    <tr>${ths}</tr>
    ${corpo}
  </table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// KPI GRID (2 colunas; empilha no mobile via .stack)
// ════════════════════════════════════════════════════════════════════════════

export interface KpiCelula {
  label: string;
  valor: string;
  /** Nota curta abaixo do número (ex.: "+12% vs. semana anterior"). */
  nota?: string | null;
  /** Cor da nota. Default NEUTRO. */
  sev?: Severidade;
}

/**
 * `reservaNota`: reserva a linha da nota mesmo quando o KPI não tem `nota`.
 * Sem isso, dois cards lado a lado em que só UM tem nota saem com alturas
 * diferentes (o Word não equaliza células como o flexbox). A reserva é feita
 * SÓ quando algum KPI do grid tem nota — um grid inteiro sem notas não ganha
 * linha em branco nenhuma.
 */
function kpiCard(k: KpiCelula, reservaNota: boolean): string {
  const corNota = ESTADO[k.sev ?? "NEUTRO"].txt;
  const nota = k.nota
    ? `<p style="margin:4px 0 0;font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;color:${corNota};">${esc(k.nota)}</p>`
    : reservaNota
      ? `<p style="margin:4px 0 0;font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;">&nbsp;</p>`
      : "";
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${CARD}" class="dm-card" style="background-color:${CARD};border:1px solid ${BORDA};">
    <tr><td style="padding:16px 20px;">
      <p class="dm-txt-fraco" style="margin:0 0 4px;font-family:${FONTE};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${TXT_FRACO};">${esc(k.label)}</p>
      <p class="dm-txt-forte" style="margin:0;font-family:${FONTE};font-size:32px;line-height:36px;mso-line-height-rule:exactly;font-weight:800;color:${TXT_FORTE};">${esc(k.valor)}</p>
      ${nota}
    </td></tr>
  </table>`;
}

export function kpiGrid(kpis: KpiCelula[]): string {
  if (kpis.length === 0) return "";
  // Alguma nota no grid? Então TODOS os cards reservam a linha (alturas iguais).
  const reservaNota = kpis.some((k) => Boolean(k.nota));
  const rows: string[] = [];
  for (let i = 0; i < kpis.length; i += 2) {
    const a = `<td width="50%" valign="top" class="stack kpi-cel" style="padding:0 6px 12px 0;">${kpiCard(kpis[i], reservaNota)}</td>`;
    const b = kpis[i + 1]
      ? `<td width="50%" valign="top" class="stack kpi-cel" style="padding:0 0 12px 6px;">${kpiCard(kpis[i + 1], reservaNota)}</td>`
      : `<td width="50%" valign="top" class="stack kpi-cel" style="padding:0 0 12px 6px;font-size:0;line-height:0;">&nbsp;</td>`;
    rows.push(`<tr>${a}${b}</tr>`);
  }
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>`;
}

// ════════════════════════════════════════════════════════════════════════════
// ESPAÇO / DIVISOR
// ════════════════════════════════════════════════════════════════════════════

export function espaco(px = 24): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="${px}" style="height:${px}px;font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`;
}

export function divisor(): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td class="dm-borda" style="border-top:1px solid ${DIVISOR};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
}

/** Empilha blocos com 24px entre eles (e nada no fim). */
export function bloco(...partes: Array<string | null | undefined | false>): string {
  return partes
    .filter((x): x is string => Boolean(x))
    .join(espaco(24));
}

// ════════════════════════════════════════════════════════════════════════════
// SUBJECT
// ════════════════════════════════════════════════════════════════════════════

export type Token =
  | "URGENTE"
  | "VENCIDO"
  | "ATENÇÃO"
  | "AVISO"
  | "OPORTUNIDADE"
  | "RESUMO"
  | "SISTEMA";

const LIMITE_SUBJECT = 60;

/**
 * Monta o subject no padrão `TOKEN: <fato> — <chave>`.
 * Sem emoji, sem "[Petro Radar]" (a origem vem do remetente do Graph).
 * Clampa em 60 caracteres cortando o FATO (a chave é o que identifica o item).
 */
export function assunto(token: Token, fato: string, chave?: string | null): string {
  const prefixo = `${token}: `;
  const f = subjectTexto(fato);
  let c = subjectTexto(chave ?? "");

  // A chave nunca pode sozinha estourar o clamp: no pior caso ela fica com
  // metade do espaço útil, e o fato (o que é ACIONÁVEL) fica com o resto.
  const util = LIMITE_SUBJECT - prefixo.length;
  if (c) {
    const tetoChave = Math.max(0, Math.floor(util / 2) - 3); // 3 = " — "
    if (c.length > tetoChave) c = tetoChave > 1 ? `${c.slice(0, tetoChave - 1)}…` : "";
  }

  const sufixo = c ? ` — ${c}` : "";
  const disponivel = LIMITE_SUBJECT - prefixo.length - sufixo.length;
  const fatoFinal = f.length > disponivel && disponivel > 1 ? `${f.slice(0, disponivel - 1)}…` : f;

  const s = `${prefixo}${fatoFinal}${sufixo}`;
  return s.length > LIMITE_SUBJECT ? `${s.slice(0, LIMITE_SUBJECT - 1)}…` : s;
}

// Reexports de conveniência para os templates (um único ponto de import).
export { esc, escAttr, escUrl };
