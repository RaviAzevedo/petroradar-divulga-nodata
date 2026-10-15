/**
 * Logger estruturado pra Petro Radar.
 *
 * Em produção:  JSON por linha — Vercel Logs faz parse, fica filtrável.
 * Em dev:       pretty print com tag de nível.
 *
 * Uso típico:
 *   import { logger, loggerFor } from "@/lib/observability/logger";
 *
 *   const log = loggerFor(req, { route: "cofre/download", docId });
 *   log.info("download iniciado");
 *   try { ... } catch (e) { log.error("falha R2", e); }
 *
 * Pra integrar Sentry/Datadog futuramente, basta wrappar a função `emit`
 * abaixo — toda observability flui por ela.
 */

import type { NextRequest } from "next/server";
import { captureException } from "./sentry";

type Level = "debug" | "info" | "warn" | "error";

interface LogContext {
  [k: string]: unknown;
}

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getMinLevel(): Level {
  const env = process.env.LOG_LEVEL as Level | undefined;
  if (env && env in LEVEL_RANK) return env;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const MIN_LEVEL_RANK = LEVEL_RANK[getMinLevel()];
const IS_PROD = process.env.NODE_ENV === "production";

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  return value;
}

function emit(level: Level, msg: string, ctx?: LogContext): void {
  if (LEVEL_RANK[level] < MIN_LEVEL_RANK) return;

  const payload = { level, msg, ts: new Date().toISOString(), ...ctx };

  if (IS_PROD) {
    const line = JSON.stringify(payload, replacer);
    if (level === "error")     console.error(line);
    else if (level === "warn") console.warn(line);
    else                       console.log(line);
    return;
  }

  // Dev: pretty
  const tag = `[${level.toUpperCase().padEnd(5)}]`;
  const ctxStr = ctx && Object.keys(ctx).length > 0
    ? " " + JSON.stringify(ctx, replacer)
    : "";
  if (level === "error")     console.error(tag, msg + ctxStr);
  else if (level === "warn") console.warn(tag, msg + ctxStr);
  else                       console.log(tag, msg + ctxStr);
}

class Logger {
  private base: LogContext;

  constructor(base: LogContext = {}) {
    this.base = base;
  }

  /** Logger filho com contexto adicional (requestId, route, userId etc.). */
  child(ctx: LogContext): Logger {
    return new Logger({ ...this.base, ...ctx });
  }

  debug(msg: string, ctx?: LogContext) { emit("debug", msg, { ...this.base, ...ctx }); }
  info (msg: string, ctx?: LogContext) { emit("info",  msg, { ...this.base, ...ctx }); }
  warn (msg: string, ctx?: LogContext) { emit("warn",  msg, { ...this.base, ...ctx }); }

  /**
   * Loga erro com stack serializado. Aceita Error, unknown, ou nada.
   * Também despacha pro Sentry quando configurado (no-op caso contrário).
   *   log.error("falha ao baixar", err);
   *   log.error("payload inválido", null, { recebido });
   */
  error(msg: string, err?: unknown, ctx?: LogContext) {
    const errPart = err !== undefined ? { err: serializeError(err) } : {};
    emit("error", msg, { ...this.base, ...errPart, ...ctx });
    // Fire-and-forget pro Sentry — não bloqueia o handler
    if (err !== undefined) {
      void captureException(err, { msg, ...this.base, ...ctx });
    }
  }
}

export const logger = new Logger();

/**
 * Cria logger filho atrelado ao request — extrai correlation ID dos headers.
 * Ordem: x-request-id (injetado pelo middleware) → x-vercel-id → fallback random.
 */
export function loggerFor(req: NextRequest | Request, ctx?: LogContext): Logger {
  const headers = req.headers;
  const requestId =
    headers.get("x-request-id") ||
    headers.get("x-vercel-id") ||
    Math.random().toString(36).slice(2, 10);
  return logger.child({ requestId, ...ctx });
}
