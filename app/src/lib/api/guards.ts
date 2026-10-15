/**
 * Guards de autenticação/autorização pra rotas API.
 *
 * Padrão: cada handler chamava 4 linhas duplicadas (await auth, check user,
 * check role). Esses helpers retornam a sessão validada ou jogam ApiError
 * que o `handleApiError` converte em NextResponse.
 *
 * Uso típico:
 *   import { requireConformidade, handleApiError } from "@/lib/api/guards";
 *
 *   export async function GET(req: NextRequest) {
 *     try {
 *       const { user } = await requireConformidade();
 *       // ... lógica do handler ...
 *     } catch (e) {
 *       return handleApiError(e);
 *     }
 *   }
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { loggerFor } from "@/lib/observability/logger";
import {
  podeVisualizar,
  podeProporParticipacao,
  isGestao,
  isAdmin,
  isConformidade,
  type UserRole,
} from "@/lib/permissions";

// ── ApiError ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code:   string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code   = code;
    this.name   = "ApiError";
  }
}

/**
 * Converte ApiError em NextResponse JSON. Erros não-Api repassam como 500.
 *
 * O segundo argumento `req` é opcional (retrocompatível com chamadas antigas
 * `handleApiError(e)`). Quando presente, erros inesperados são logados via
 * loggerFor com o requestId ANTES de retornar 500 — assim os 500s deixam de
 * ser silenciosos.
 */
export function handleApiError(err: unknown, req?: NextRequest | Request): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  // Erro inesperado: loga (com requestId quando há req) antes de retornar 500.
  const log = req ? loggerFor(req) : undefined;
  if (log) log.error("Erro inesperado em handler de API", err);
  return NextResponse.json({ error: "Erro interno" }, { status: 500 });
}

// ── Tipos ───────────────────────────────────────────────────────────────────

export interface AuthedSession {
  session: Session;
  user:    NonNullable<Session["user"]>;
}

// ── Guards principais ───────────────────────────────────────────────────────

/**
 * Garante que existe sessão válida. Throws ApiError(401) se não houver.
 * Retorna a sessão pra encadear checks adicionais.
 */
export async function requireAuth(): Promise<AuthedSession> {
  const session = await auth();
  if (!session?.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Não autenticado");
  }
  return { session, user: session.user };
}

/**
 * Garante sessão + role na lista. Throws 403 se não tiver permissão.
 */
async function requireRole(roles: readonly UserRole[]): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!(roles as readonly string[]).includes(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Permissão negada");
  }
  return ctx;
}

// ── Helpers semânticos ──────────────────────────────────────────────────────

/** Sessão + permissão de visualização (todos exceto EXTERNO). */
export async function requireVisualizar(): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!podeVisualizar(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Permissão negada");
  }
  return ctx;
}

/** Sessão + permissão de gestão (ADMIN, LIDER). */
export async function requireGestao(): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!isGestao(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Apenas gestão");
  }
  return ctx;
}

/** Sessão + setor Conformidade (ADMIN, LIDER, SGI). */
export async function requireConformidade(): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!isConformidade(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Apenas Conformidade");
  }
  return ctx;
}

/** Sessão + role ADMIN. */
export async function requireAdmin(): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!isAdmin(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Apenas administrador");
  }
  return ctx;
}

/** Sessão + permissão pra propor participação. */
export async function requirePropor(): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!podeProporParticipacao(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Sem permissão de propor");
  }
  return ctx;
}

// ── Autorização a nível de objeto (acervo / RAG — anti-IDOR) ─────────────────

/**
 * Gate de acesso ao acervo técnico (RAG). Hoje a regra é por papel: qualquer
 * usuário interno (podeVisualizar) consulta o acervo; EXTERNO é barrado.
 *
 * Reforço anti-IDOR a nível de OBJETO: rotas do acervo NUNCA devem expor chunks
 * de origens fora do escopo do usuário. Como ainda não há ACL por documento, a
 * superfície segura é "tudo do tenant interno". Quando houver ACL fina, este
 * guard centraliza a decisão (e `assertAcessoObjeto` aplica por linha).
 */
export async function requireAcervo(): Promise<AuthedSession> {
  const ctx = await requireAuth();
  if (!podeVisualizar(ctx.user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Sem acesso ao acervo");
  }
  return ctx;
}

/** O papel da sessão — para o relatório filtrar documento restrito. */
export async function roleDaSessao(): Promise<string> {
  const ctx = await requireAuth();
  return ctx.user.role;
}


/**
 * Asserção a nível de objeto pra prevenir IDOR: lança 403 se o recurso não
 * pertence/visível ao usuário. Use no retrieval do acervo pra filtrar/validar
 * cada origem antes de devolver trechos ou citações.
 *
 *   assertAcessoObjeto(podeVer, "Chunk fora do escopo");
 */
export function assertAcessoObjeto(podeVer: boolean, msg = "Acesso negado ao recurso"): void {
  if (!podeVer) {
    throw new ApiError(403, "FORBIDDEN", msg);
  }
}
