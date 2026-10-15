/**
 * Tokens do Design System de E-mail Proponente — Petro Radar.
 *
 * Manual da Marca 2025: SÓ laranja #F59C00 (Pantone 144) e preto #1D1D1B
 * (Pantone Black). AZUL É PROIBIDO — nenhum hex das famílias "blue" e "slate"
 * do Tailwind pode aparecer neste subsistema.
 *
 * Laranja é ESTRUTURA (filete, tarja, rail, fundo de botão), NUNCA texto:
 * #F59C00 sobre branco = 2,18:1, reprova até o piso de 3:1 de texto grande.
 * #1D1D1B sobre #F59C00 = 7,75:1 (AAA) — é a única forma de usar o laranja.
 *
 * Todos os pares fundo/texto abaixo foram verificados >= 4,5:1 (WCAG AA).
 */

// ── Marca ───────────────────────────────────────────────────────────────────
export const LARANJA        = "#F59C00"; // Pantone 144 — estrutura e fundo de CTA
export const LARANJA_ESCURO = "#E85D04"; // apoio (uso raro; NUNCA como texto)
export const PRETO          = "#1D1D1B"; // Pantone Black — tarjas, títulos

// ── Superfícies ─────────────────────────────────────────────────────────────
export const CANVAS  = "#F5F5F5"; // fundo do <body>
export const CARD    = "#FFFFFF"; // fundo do corpo do e-mail e dos cards
export const SUPERF  = "#F5F5F5"; // fundo de <thead>, info-rows, linhas alternadas
export const BORDA   = "#E5E7EB"; // borda estrutural de card/tabela (1px, sempre)
export const DIVISOR = "#EDEDED"; // separador interno

// ── Texto ───────────────────────────────────────────────────────────────────
export const TXT_FORTE     = "#1D1D1B"; // títulos            (16,9:1 sobre branco)
export const TXT_CORPO     = "#333333"; // corpo              (12,6:1)
export const TXT_FRACO     = "#6A7282"; // meta/rótulo        ( 4,8:1) — PISO
export const TXT_INV       = "#FFFFFF"; // texto sobre tarja preta
export const TXT_INV_FRACO = "#B3B3B3"; // meta sobre tarja preta (7,0:1)

// ── Semânticos de estado (SEM AZUL) ─────────────────────────────────────────
// Convenção herdada da UI: VERMELHO = "quente / exige ação agora" (inclui ALTA
// relevância), ÂMBAR = "atenção", VERDE = "novo / bom / ganho", CINZA = inerte,
// LARANJA-MARCA = "em andamento / é do produto" (substitui TODO o azul).
export const ESTADO = {
  CRITICO: { bg: "#FEF2F2", borda: "#FFC9C9", txt: "#C10007", solido: "#DC2626", solidoTxt: "#FFFFFF", rail: "#DC2626" },
  ATENCAO: { bg: "#FFFBEB", borda: "#FEE685", txt: "#B45309", solido: "#B45309", solidoTxt: "#FFFFFF", rail: "#B45309" },
  OK:      { bg: "#F0FDF4", borda: "#B9F8CF", txt: "#15803D", solido: "#15803D", solidoTxt: "#FFFFFF", rail: "#15803D" },
  NEUTRO:  { bg: "#F5F5F5", borda: "#E5E7EB", txt: "#4A4A4A", solido: "#4A4A4A", solidoTxt: "#FFFFFF", rail: "#9CA3AF" },
  MARCA:   { bg: "#FEF5E6", borda: "#F59C00", txt: "#1D1D1B", solido: "#F59C00", solidoTxt: "#1D1D1B", rail: "#F59C00" },
} as const;

export type Severidade = keyof typeof ESTADO;

// ── Tipografia ──────────────────────────────────────────────────────────────
// NUNCA liderar com -apple-system: o motor Word não conhece a família e cai
// para o default SERIFADO (Times New Roman) na mensagem inteira.
// 'Segoe UI' é nativa no Windows/Outlook — o alvo real. Inter é o que o app usa.
export const FONTE       = "'Segoe UI', Inter, Arial, Helvetica, sans-serif";
// Condensada SÓ no wordmark/kicker (uppercase, curto). Barlow Condensed nunca
// carrega no Word — o que renderiza de fato é Arial Narrow / Segoe UI.
export const FONTE_MARCA = "'Barlow Condensed', 'Arial Narrow', 'Segoe UI', Arial, sans-serif";
export const FONTE_MONO  = "Consolas, 'Courier New', monospace"; // nº de edital

// Escala (px INTEIRO — o Word converte px→pt ×0,75 e arredonda em meio ponto)
export const T = {
  h1:     { size: 24, lh: 30, weight: 700 },
  h2:     { size: 18, lh: 24, weight: 700 },
  kicker: { size: 12, lh: 16, weight: 700 },
  corpo:  { size: 16, lh: 24, weight: 400 }, // PISO do corpo
  meta:   { size: 14, lh: 20, weight: 400 },
  micro:  { size: 12, lh: 16, weight: 600 }, // MÍNIMO ABSOLUTO
  kpi:    { size: 32, lh: 36, weight: 800 },
} as const;

// ── Espaçamento / forma ─────────────────────────────────────────────────────
export const SP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const LARGURA_CONTEUDO = 600; // número seguro no painel de leitura do Outlook
export const FILETE = 4;             // altura da faixa laranja / largura do rail
