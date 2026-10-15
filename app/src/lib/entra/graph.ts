import { logger } from "@/lib/observability/logger";

/**
 * Microsoft Graph — busca de usuários do tenant Proponente para o Admin Center
 * (pré-cadastro sem digitar e-mail). Usa o MESMO App Registration do login
 * (client credentials, app-only): exige a permissão de APLICAÇÃO
 * `User.Read.All` com admin consent (Azure → App registrations → API
 * permissions). Sem ela o Graph responde 403 e a UI degrada para o cadastro
 * manual por e-mail — a busca é conveniência, nunca dependência.
 *
 * Egress: login.microsoftonline.com (token) + graph.microsoft.com (busca).
 */

const TENANT  = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
const CLIENT  = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const SECRET  = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;

// Mesmos domínios aceitos pelo login (lib/auth.ts): o tenant pode conter
// contas de terceiros (convidados, prestadores) que NUNCA passariam
// no signIn — escondê-las da busca evita pré-cadastrar quem não pode entrar.
const DOMINIOS_PERMITIDOS = (process.env.AUTH_ALLOWED_EMAIL_DOMAINS ?? "example.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export interface UsuarioTenant {
  /** Claim oid — mesmo identificador que o login SSO grava em users.entra_oid. */
  oid: string;
  nome: string | null;
  email: string | null;
}

/** Erro tipado para a rota devolver mensagens acionáveis ao admin. */
export class GraphError extends Error {
  constructor(
    message: string,
    public readonly code: "NAO_CONFIGURADO" | "SEM_PERMISSAO" | "INDISPONIVEL",
  ) {
    super(message);
  }
}

// Token app-only com cache em módulo (expira em ~1h; renova 5min antes).
let tokenCache: { token: string; expiraEm: number } | null = null;

// Exportado (0026): o transporte de e-mail via Graph (lib/email/graph-mail.ts)
// compartilha o MESMO token app-only — o scope .default carrega todas as
// permissões de aplicação consentidas (User.Read.All + Mail.Send).
export async function obterToken(): Promise<string> {
  if (!TENANT || !CLIENT || !SECRET) {
    throw new GraphError("SSO Microsoft não configurado no ambiente.", "NAO_CONFIGURADO");
  }
  if (tokenCache && Date.now() < tokenCache.expiraEm) return tokenCache.token;

  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     CLIENT,
      client_secret: SECRET,
      scope:         "https://graph.microsoft.com/.default",
    }),
  });

  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    logger.error(`Graph: falha ao obter token app-only (${res.status}): ${corpo.slice(0, 300)}`);
    throw new GraphError("Não foi possível autenticar no Microsoft Graph.", "INDISPONIVEL");
  }

  const dados = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token:    dados.access_token,
    expiraEm: Date.now() + (dados.expires_in - 300) * 1000,
  };
  return tokenCache.token;
}

/**
 * Busca usuários do diretório por prefixo de nome, e-mail ou UPN (até 8).
 * 403 do Graph = admin consent de `User.Read.All` (Application) pendente.
 */
export async function buscarUsuariosTenant(query: string): Promise<UsuarioTenant[]> {
  const q = query.trim().replace(/'/g, "''"); // escape de aspas do OData
  if (q.length < 2) return [];

  const token = await obterToken();

  const filtro = [
    `startswith(displayName,'${q}')`,
    `startswith(mail,'${q}')`,
    `startswith(userPrincipalName,'${q}')`,
  ].join(" or ");

  const url =
    "https://graph.microsoft.com/v1.0/users" +
    `?$filter=${encodeURIComponent(filtro)}` +
    "&$select=id,displayName,mail,userPrincipalName" +
    "&$top=8";

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 403) {
    throw new GraphError(
      "O App Registration não tem a permissão de aplicação User.Read.All (admin consent). " +
      "Conceda no Azure ou cadastre pelo e-mail manualmente.",
      "SEM_PERMISSAO",
    );
  }
  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    logger.error(`Graph: busca de usuários falhou (${res.status}): ${corpo.slice(0, 300)}`);
    throw new GraphError("Microsoft Graph indisponível no momento.", "INDISPONIVEL");
  }

  const dados = (await res.json()) as {
    value: { id: string; displayName: string | null; mail: string | null; userPrincipalName: string | null }[];
  };

  return dados.value
    .map((u) => ({
      oid:   u.id,
      nome:  u.displayName,
      // mail pode ser null (contas sem caixa Exchange) — UPN é o fallback usual.
      email: (u.mail ?? u.userPrincipalName)?.toLowerCase() ?? null,
    }))
    .filter((u) => u.email && DOMINIOS_PERMITIDOS.includes(u.email.split("@")[1] ?? ""));
}
