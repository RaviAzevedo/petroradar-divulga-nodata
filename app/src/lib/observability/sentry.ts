/**
 * Adapter opcional pra Sentry. NO-OP até `SENTRY_DSN` ser setado E
 * `@sentry/nextjs` ser instalado (`npm install @sentry/nextjs`).
 *
 * Como ativar:
 *   1. `npm install @sentry/nextjs`
 *   2. Setar `SENTRY_DSN` em Vercel production
 *   3. (Opcional) `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` (default 0)
 *
 * Sem essas duas condições, todas as funções abaixo viram no-op silencioso —
 * código no logger pode chamar `captureException(err)` sem if guards.
 *
 * Por que não importar `@sentry/nextjs` direto: o pacote não está instalado.
 * Importar dispararia erro de build. `import("...")` dinâmico só executa
 * quando a função é chamada, e é envolvido em try/catch.
 */

let sentryReady = false;
let sentryFailed = false;

// `Sentry` aqui é um shape opaco — não tipamos exatamente porque o pacote
// pode não estar instalado.
type SentryAdapter = {
  init: (opts: { dsn: string; environment?: string; tracesSampleRate?: number }) => void;
  captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
  setContext: (name: string, ctx: Record<string, unknown>) => void;
};

let cachedSentry: SentryAdapter | null = null;

async function initSentryOnce(): Promise<SentryAdapter | null> {
  if (sentryReady) return cachedSentry;
  if (sentryFailed) return null;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    sentryFailed = true; // marcado pra evitar tentativa repetida
    return null;
  }

  try {
    // @ts-expect-error — pacote pode não estar instalado, intencional
    const sentryModule = await import("@sentry/nextjs");
    const Sentry = sentryModule as unknown as SentryAdapter;
    Sentry.init({
      dsn,
      environment:      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    });
    cachedSentry = Sentry;
    sentryReady = true;
    return Sentry;
  } catch {
    // Pacote não instalado ou falhou em carregar → degrade pra no-op
    sentryFailed = true;
    return null;
  }
}

/**
 * Envia um erro pro Sentry se o adapter estiver pronto.
 * No-op silencioso caso contrário — chame sem if guards.
 */
export async function captureException(
  err: unknown,
  ctx?: Record<string, unknown>,
): Promise<void> {
  const sentry = await initSentryOnce();
  if (!sentry) return;
  try {
    if (ctx) sentry.setContext("petro-radar", ctx);
    sentry.captureException(err);
  } catch {
    // proteção dupla — Sentry quebrado nunca quebra a aplicação
  }
}
