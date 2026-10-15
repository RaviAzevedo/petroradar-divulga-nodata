/**
 * Escaping de dado externo no HTML de e-mail.
 *
 * É bug de RENDERIZAÇÃO antes de ser de segurança: um "&" em "Manutenção &
 * Montagem" (objeto comuníssimo do Petronect) já produz entidade inválida, e um
 * "<" trunca a mensagem no Outlook.
 *
 * Fontes externas que chegam nestes templates: Petronect (objeto, empresa,
 * circular), IA Haiku (acaoRecomendada), usuário (motivo de extensão), scraper
 * (detalhes do erro), Receita Federal (razaoSocial).
 */

const MAPA: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapa para CONTEÚDO de elemento. Use em TODA interpolação de dado externo. */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, (c) => MAPA[c]);
}

/** Escapa para valor de ATRIBUTO (href/alt/title). Mesma tabela. */
export function escAttr(v: unknown): string {
  return esc(v);
}

/** URL segura: só http/https, e escapada. Bloqueia javascript:/data:. */
export function escUrl(v: unknown): string {
  const s = String(v ?? "");
  return /^https?:\/\//i.test(s) ? esc(s) : "#";
}

/** Texto multi-linha → <br>. SEMPRE escapa ANTES de injetar os <br>. */
export function nl2br(v: unknown): string {
  return esc(v).replace(/\r?\n/g, "<br>");
}

/** Corta texto longo preservando o escaping (corta ANTES de escapar). */
export function trunc(v: unknown, n: number): string {
  const s = String(v ?? "");
  return esc(s.length > n ? `${s.slice(0, n - 1)}…` : s);
}

/** Igual a trunc(), mas converte as quebras de linha remanescentes em <br>. */
export function truncNl(v: unknown, n: number): string {
  const s = String(v ?? "");
  return nl2br(s.length > n ? `${s.slice(0, n - 1)}…` : s);
}

/** Preheader: texto puro, sem HTML, junto por " · " e clampado em 100. */
export function preheaderTexto(...partes: Array<string | null | undefined | false>): string {
  return esc(
    partes
      .filter((p): p is string => Boolean(p))
      .join(" · ")
      .slice(0, 100),
  );
}

/**
 * Normaliza o SUBJECT. O Graph envia o subject como TEXTO PURO
 * (message.subject) — nunca colocar HTML nem escapar aqui; só normalizar o
 * espaço em branco. O clamp de 60 caracteres é feito por assunto() (primitivos).
 */
export function subjectTexto(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
