import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * Middleware (convenção Next.js 16: `proxy.ts`) compõe duas responsabilidades:
 *
 *   1. Auth (NextAuth v5) — redireciona pra /login quem não tem sessão.
 *   2. Correlation ID — propaga x-request-id pro handler e response, pra todos
 *      os logs do mesmo request poderem ser correlacionados.
 *
 * IMPORTANTE — por que a checagem de sessão é feita AQUI e não no callback
 * `authorized` de lib/auth.ts: ao embrulhar o middleware numa função
 * (`export default auth((req) => …)`), o NextAuth v5 **ignora** o callback
 * `authorized`. Ele só vale na forma sem wrapper (`export { auth as middleware }`).
 * Como aqui precisamos do wrapper (pra setar o x-request-id), a proteção de rota
 * TEM que ser feita explicitamente abaixo, lendo `req.auth`. Antes disso o gate
 * era um no-op e TODAS as rotas ficavam públicas (app acessível sem login).
 *
 * Cobertura de proteção (via matcher + checagem abaixo): TODAS as rotas de
 * app/páginas — incluindo /hoje, /acervo e /admin/* — passam
 * pelo gate de sessão. Exceções intencionais:
 *   - /api/auth/*  — handlers do próprio NextAuth.
 *   - /api/cron/*  — gate por CRON_SECRET (verifyCronAuth), não por sessão.
 *   - assets estáticos (_next, favicon, manifest, sw.js, imagens/fontes).
 */

export default auth((req) => {
  const { pathname, search, origin } = req.nextUrl;
  const isLoggedIn  = !!req.auth?.user;
  // /login (SSO) e /login/local (break-glass — a página dá 404 quando
  // AUTH_BREAKGLASS != 1) são as únicas páginas públicas.
  const isLoginPage = pathname === "/login" || pathname === "/login/local";
  // Liberados sem sessão — também já fora da matcher, mas guardados aqui por
  // segurança caso a matcher mude.
  const isAuthApi   = pathname.startsWith("/api/auth");
  const isCronApi   = pathname.startsWith("/api/cron");

  // ── Gate de sessão ──────────────────────────────────────────────────────────

  // Não logado em rota protegida:
  //   - /api/*  → 401 JSON (contrato programático; clientes fetch/curl não devem
  //     receber redirect 307 p/ HTML de login — paridade com o BFF e gate G2).
  //   - páginas → redirect pro login guardando o destino em ?callbackUrl.
  if (!isLoggedIn && !isLoginPage && !isAuthApi && !isCronApi) {
    if (pathname.startsWith("/api/")) {
      // Mesmo shape do requireAuth()/handleApiError (guards.ts) p/ paridade.
      return NextResponse.json(
        { error: "Não autenticado", code: "UNAUTHENTICATED" },
        { status: 401 },
      );
    }
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // Já logado e indo pra /login → manda pra home.
  if (isLoggedIn && isLoginPage) {
    return NextResponse.redirect(new URL("/", origin));
  }

  // ── Correlation ID (request autorizado segue o fluxo) ─────────────────────────
  const requestId =
    req.headers.get("x-request-id") ||
    req.headers.get("x-vercel-id") ||
    crypto.randomUUID();

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
});

export const config = {
  // Protege tudo, exceto: handlers de auth do NextAuth, crons (gate por
  // CRON_SECRET) e assets estáticos
  // (_next, favicon, manifest, sw.js, imagens/fontes — inclui o logo da própria
  // tela de login, que precisa carregar sem sessão).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|api/auth|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf)$).*)",
  ],
};
