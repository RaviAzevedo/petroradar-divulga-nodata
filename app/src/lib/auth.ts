import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { db } from "@/db";
import { users, auditLog } from "@/db/schema";
import { eq, and, count } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { DEFAULT_ROLE, type UserRole } from "@/lib/permissions";
import { rateLimit, rateLimitReset, isRateLimitDistributed } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";
import { revokeJti } from "@/lib/security/revocation";

// ── SSO Microsoft 365 (Entra ID) ─────────────────────────────────────────────
//
// O login normal é EXCLUSIVAMENTE via conta Microsoft do tenant Proponente
// (App Registration single-tenant). O provider Credentials (senha local) vira
// break-glass: só entra no array quando AUTH_BREAKGLASS=1 — emergência
// (secret expirado, Microsoft fora do ar) ou modo air-gap.
//
// Controle de acesso (callback signIn):
//   1. tenant do token (tid) precisa ser o tenant Proponente;
//   2. domínio do e-mail ∈ AUTH_ALLOWED_EMAIL_DOMAINS (barra convidados B2B);
//   3. conta desconhecida vira solicitação PENDENTE (não entra) — o ADMIN
//      aprova em /admin/solicitacoes; exceção: SEED_ADMIN_EMAIL em banco sem
//      ADMIN ativo vira ADMIN direto (bootstrap de instalação limpa);
//   4. pendente/desativado não entra.
// Roles moram no BANCO (não no Azure): o callback jwt busca o usuário e monta
// o token exatamente como o fluxo por senha montava — o BFF não vê diferença.

const ENTRA_CLIENT_ID     = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const ENTRA_CLIENT_SECRET = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
const ENTRA_TENANT_ID     = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
const ENTRA_CONFIGURADO   = Boolean(ENTRA_CLIENT_ID && ENTRA_CLIENT_SECRET && ENTRA_TENANT_ID);

const BREAKGLASS = process.env.AUTH_BREAKGLASS === "1";

/** Domínios de e-mail aceitos no SSO (CSV; default example.com). */
const DOMINIOS_PERMITIDOS = (process.env.AUTH_ALLOWED_EMAIL_DOMAINS ?? "example.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/** Bootstrap: e-mail que vira ADMIN no 1º login quando não há ADMIN ativo. */
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.toLowerCase().trim();

function dominioPermitido(email: string): boolean {
  const dominio = email.split("@")[1] ?? "";
  return DOMINIOS_PERMITIDOS.includes(dominio);
}

// Não avisar durante o `next build` (sem envs por design — o Docker injeta em
// runtime via env_file): o módulo é importado por dezenas de rotas e o log
// repetiria uma vez por rota compilada.
if (!ENTRA_CONFIGURADO && !BREAKGLASS && process.env.NEXT_PHASE !== "phase-production-build") {
  logger.error(
    "NENHUM provider de login ativo: configure AUTH_MICROSOFT_ENTRA_ID_ID/SECRET/TENANT_ID " +
    "(SSO) ou AUTH_BREAKGLASS=1 (login local de emergência).",
  );
}

// ── Rate limit de login (break-glass) ─────────────────────────────────────────
//
// Limita por email E por IP: 5 tentativas em 15 minutos cada. Implementação real
// está em lib/rate-limit (Upstash Redis se UPSTASH_REDIS_REST_* estiver setado;
// fallback in-process caso contrário). Após login OK, o contador do email é zerado.
// Só se aplica ao Credentials — no SSO quem segura força-bruta é a Microsoft.
//
// Fail-closed: em produção sem backend distribuído (Upstash/Redis), o fallback
// in-process é por-instância e inútil contra força-bruta. Com AUTH_FAILCLOSED=1
// negamos o login em vez de aceitar sem proteção real (default 0 → dev/on-prem
// bem configurado nunca trava). Ver bloco no authorize().

const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const IS_PROD           = process.env.NODE_ENV === "production";

// Fail-closed opcional do rate-limit de login. Só tem efeito em produção E
// quando o rate-limit NÃO está distribuído (sem Upstash e sem REDIS_URL).
// Default desligado para não travar dev nem ambientes sem Redis proposital.
const AUTH_FAILCLOSED   = process.env.AUTH_FAILCLOSED === "1";

/** Extrai o IP do request a partir de x-forwarded-for / x-real-ip. */
function getClientIp(request?: Request): string {
  if (!request) return "unknown";
  const xff = request.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Extrai o User-Agent do request (truncado para não inflar o audit). */
function getUserAgent(request?: Request): string {
  if (!request) return "unknown";
  return (request.headers.get("user-agent") ?? "unknown").slice(0, 512);
}

/**
 * Registra uma tentativa de login no `audit_log` (best-effort).
 *
 * NUNCA grava a senha. Guarda e-mail, IP e user-agent DENTRO de `detalhes`
 * (jsonb) — sem coluna nova. Falha do insert NUNCA quebra o login: capturamos
 * a exceção e apenas logamos, pois auditoria degradada não pode negar acesso.
 *
 * No fluxo OAuth o NextAuth não expõe o Request nos callbacks — ip/userAgent
 * chegam como "oauth" e `detalhes.provider` identifica o Entra ID.
 */
async function registrarLoginAudit(params: {
  acao:      "LOGIN_OK" | "LOGIN_FALHA";
  email:     string;
  userId:    string | null;
  ip:        string;
  userAgent: string;
  motivo?:   string;
  provider?: string;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId:     params.userId,
      acao:       params.acao,
      entidade:   "auth",
      entidadeId: params.userId ?? params.email,
      detalhes: {
        email:     params.email,
        ip:        params.ip,
        userAgent: params.userAgent,
        ...(params.motivo   ? { motivo:   params.motivo }   : {}),
        ...(params.provider ? { provider: params.provider } : {}),
      },
    });
  } catch (err) {
    logger.error("Falha ao gravar auditoria de login (best-effort)", err);
  }
}

/** Atalho para auditoria do fluxo SSO (sem Request disponível nos callbacks). */
function auditSso(
  acao: "LOGIN_OK" | "LOGIN_FALHA",
  email: string,
  userId: string | null,
  motivo?: string,
): Promise<void> {
  return registrarLoginAudit({
    acao, email, userId, ip: "oauth", userAgent: "oauth",
    motivo, provider: "microsoft-entra-id",
  });
}

// ── NextAuth ──────────────────────────────────────────────────────────────────

// signIn/signOut do NextAuth não são re-exportados: o front usa next-auth/react.
export const { handlers, auth } = NextAuth({
  providers: [
    // ── SSO Microsoft 365 (login padrão) ────────────────────────────────────
    // Só entra no array com as 3 envs configuradas — sem elas o app sobe (dev/
    // testes) e o erro aparece no log + na tentativa de login.
    ...(ENTRA_CONFIGURADO
      ? [
          MicrosoftEntraID({
            clientId:     ENTRA_CLIENT_ID!,
            clientSecret: ENTRA_CLIENT_SECRET!,
            // Issuer com tenant explícito = só contas do diretório Proponente
            // (o default /common/ aceitaria qualquer conta Microsoft).
            issuer: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`,
            // Sem User.Read: o default do provider busca a foto de perfil no
            // Graph (graph.microsoft.com) — dispensado para o único egress do
            // login ser login.microsoftonline.com (requisito on-prem).
            authorization: { params: { scope: "openid profile email" } },
            profile(profile) {
              return {
                // oid = identidade imutável no tenant (o e-mail pode mudar).
                id:    (profile.oid as string | undefined) ?? profile.sub!,
                name:  profile.name ?? null,
                email: ((profile.email ?? profile.preferred_username) as string | undefined)
                  ?.toLowerCase() ?? null,
                // Placeholder para satisfazer o tipo User estendido — o role
                // REAL vem do banco no callback jwt, nunca do token do Azure.
                role: DEFAULT_ROLE,
              };
            },
          }),
        ]
      : []),
    // ── Break-glass (senha local) — só com AUTH_BREAKGLASS=1 ────────────────
    ...(BREAKGLASS
      ? [
          Credentials({
            name: "credentials",
            credentials: {
              email:    { label: "Email",  type: "email"    },
              password: { label: "Senha",  type: "password" },
            },
            async authorize(credentials, request) {
              if (!credentials?.email || !credentials?.password) return null;

              const email     = (credentials.email as string).toLowerCase().trim();
              const password  = credentials.password as string;
              const rateKey   = `login:${email}`;
              const ip        = getClientIp(request);
              const ipKey     = `login-ip:${ip}`;
              const userAgent = getUserAgent(request);

              // Rate-limit sem backend distribuído em produção: o limiter cai para o
              // Map in-process (por-instância, inútil contra força-bruta). Dois modos:
              //   - fail-CLOSED (AUTH_FAILCLOSED=1): negamos o login com erro claro e
              //     logamos em nível crítico. Proteção acima de disponibilidade.
              //   - fail-OPEN (default): apenas avisamos — não derrubar o acesso de
              //     todos por falta de Redis. Mantém o comportamento legado em dev.
              if (IS_PROD && !isRateLimitDistributed()) {
                if (AUTH_FAILCLOSED) {
                  logger.error("CRÍTICO: rate limit de login não distribuído (sem Upstash/REDIS_URL) e AUTH_FAILCLOSED=1 — negando login. Configure UPSTASH_REDIS_REST_URL/TOKEN ou REDIS_URL.");
                  await registrarLoginAudit({
                    acao: "LOGIN_FALHA", email, userId: null, ip, userAgent,
                    motivo: "ratelimit_indisponivel_failclosed",
                  });
                  throw new Error("Serviço de login temporariamente indisponível. Tente novamente em instantes.");
                }
                logger.warn("Rate limit de login não distribuído (Upstash/REDIS_URL ausente) — usando limiter in-process degradado. Configure UPSTASH_REDIS_REST_URL/TOKEN ou REDIS_URL para proteção real (ou AUTH_FAILCLOSED=1 para negar em vez de degradar).");
              }

              // Verifica rate limit por email E por IP ANTES de consultar o banco
              const [rlEmail, rlIp] = await Promise.all([
                rateLimit({ key: rateKey, max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW }),
                rateLimit({ key: ipKey,   max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW }),
              ]);
              if (!rlEmail.allowed || !rlIp.allowed) {
                await registrarLoginAudit({
                  acao: "LOGIN_FALHA", email, userId: null, ip, userAgent,
                  motivo: "rate_limit_excedido",
                });
                throw new Error("Muitas tentativas de login. Aguarde 15 minutos e tente novamente.");
              }

              const [user] = await db
                .select()
                .from(users)
                .where(eq(users.email, email))
                .limit(1);

              if (!user || user.ativo === false) {
                // Não zera o rate limit em usuário não encontrado — continua contando
                await registrarLoginAudit({
                  acao: "LOGIN_FALHA", email, userId: user?.id ?? null, ip, userAgent,
                  motivo: user ? "usuario_inativo" : "usuario_inexistente",
                });
                return null;
              }

              // Usuário só-SSO não tem senha local (password_hash NULL pós-0025).
              if (!user.passwordHash) {
                await registrarLoginAudit({
                  acao: "LOGIN_FALHA", email, userId: user.id, ip, userAgent,
                  motivo: "sem_senha_local",
                });
                return null;
              }

              const valid = await bcrypt.compare(password, user.passwordHash);
              if (!valid) {
                // Não zera em senha errada — continua contando tentativas
                await registrarLoginAudit({
                  acao: "LOGIN_FALHA", email, userId: user.id, ip, userAgent,
                  motivo: "senha_invalida",
                });
                return null;
              }

              // Login bem-sucedido → zera o contador deste email
              await rateLimitReset(rateKey);

              // Auditoria de sucesso (best-effort; nunca bloqueia o login)
              await registrarLoginAudit({
                acao: "LOGIN_OK", email, userId: user.id, ip, userAgent,
              });

              // Normaliza roles legados para o novo padrão
              const role = normalizeRole(user.role);

              return {
                id:    user.id,
                email: user.email,
                name:  user.nome,
                role,
              };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    // Controle de acesso do SSO — roda ANTES do jwt, a cada login OAuth.
    // Retornar string redireciona para ela (banners de erro em /login).
    async signIn({ user, account, profile }) {
      if (account?.provider !== "microsoft-entra-id") return true;

      const oid   = (profile?.oid as string | undefined) ?? (profile?.sub as string | undefined) ?? "";
      const tid   = (profile?.tid as string | undefined) ?? "";
      const email = user.email?.toLowerCase().trim() ?? "";

      // 1) Tenant: cinto e suspensório com o issuer single-tenant.
      if (!tid || tid !== ENTRA_TENANT_ID) {
        await auditSso("LOGIN_FALHA", email, null, "tenant_invalido");
        return "/login?error=dominio";
      }

      // 2) Domínio do e-mail: barra convidados B2B do tenant.
      if (!email || !dominioPermitido(email)) {
        await auditSso("LOGIN_FALHA", email, null, "dominio_invalido");
        return "/login?error=dominio";
      }

      // 3) Lookup: oid primeiro (identidade imutável), e-mail como fallback
      //    (contas pré-cadastradas pelo ADMIN ou migradas do login por senha).
      let [conta] = oid
        ? await db.select().from(users).where(eq(users.entraOid, oid)).limit(1)
        : [];
      if (!conta) {
        [conta] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        // E-mail bate mas o oid gravado é de OUTRA identidade → conta do M365
        // recriada/reciclada. Não entra sozinho: ADMIN precisa resolver.
        if (conta?.entraOid && conta.entraOid !== oid) {
          await auditSso("LOGIN_FALHA", email, conta.id, "entra_oid_divergente");
          return "/login?error=conflito";
        }
      }

      // 4) Conta desconhecida
      if (!conta) {
        // Bootstrap de instalação limpa: SEED_ADMIN_EMAIL vira ADMIN quando
        // não existe nenhum ADMIN ativo (depois disso a env fica inerte).
        if (SEED_ADMIN_EMAIL && email === SEED_ADMIN_EMAIL) {
          const [{ n: admins }] = await db
            .select({ n: count() })
            .from(users)
            .where(and(eq(users.role, "ADMIN"), eq(users.ativo, true)));
          if (admins === 0) {
            const [novo] = await db
              .insert(users)
              .values({
                email, nome: user.name ?? null, entraOid: oid,
                role: "ADMIN", ativo: true, pendente: false,
                ultimoLogin: new Date(),
              })
              .returning({ id: users.id });
            await auditSso("LOGIN_OK", email, novo.id, "seed_admin_bootstrap");
            return true;
          }
        }
        // Fila de aprovação: registra a solicitação e nega o acesso.
        await db
          .insert(users)
          .values({
            email, nome: user.name ?? null, entraOid: oid,
            role: DEFAULT_ROLE, ativo: false, pendente: true,
          })
          .onConflictDoNothing({ target: users.email });
        await auditSso("LOGIN_FALHA", email, null, "acesso_pendente");
        // Avisa os ADMINs. Sem isto a fila e SILENCIOSA: a pessoa ve "acesso
        // pendente" e espera ate alguem abrir /admin por acaso (o badge de
        // pendentes so existe la dentro). Best-effort — falha de e-mail nao pode
        // transformar um login negado em erro 500.
        void avisarAdminsDeSolicitacao(email, user.name ?? null);
        return "/login?error=pendente";
      }

      // 5) Aguardando aprovação do ADMIN
      if (conta.pendente) {
        await auditSso("LOGIN_FALHA", email, conta.id, "acesso_pendente");
        return "/login?error=pendente";
      }

      // 6) Desativado pelo ADMIN
      if (!conta.ativo) {
        await auditSso("LOGIN_FALHA", email, conta.id, "usuario_inativo");
        return "/login?error=desativado";
      }

      // 7) OK — backfill do oid (1º login de conta pré-cadastrada/migrada) e
      //    carimbo do último login.
      await db
        .update(users)
        .set({ entraOid: conta.entraOid ?? oid, ultimoLogin: new Date() })
        .where(eq(users.id, conta.id));
      await auditSso("LOGIN_OK", email, conta.id);
      return true;
    },
    authorized({ auth, request }) {
      const isLoggedIn  = !!auth?.user;
      // /login e /login/local (break-glass) são públicas.
      const isLoginPage = request.nextUrl.pathname === "/login" ||
                          request.nextUrl.pathname === "/login/local";
      const isAuthApi   = request.nextUrl.pathname.startsWith("/api/auth");
      const isCronApi   = request.nextUrl.pathname.startsWith("/api/cron");

      // Permitir acesso a rotas de auth e cron sempre
      if (isAuthApi || isCronApi) return true;

      // Se logado e na página de login, redirecionar para home (mobile → /hoje).
      if (isLoggedIn && isLoginPage) {
        const ua = request.headers.get("user-agent") ?? "";
        const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
        const dest = mobile ? "/hoje" : "/";
        return Response.redirect(new URL(dest, request.nextUrl.origin));
      }

      // Se não logado e não na página de login, redirecionar para login
      if (!isLoggedIn && !isLoginPage) {
        return false;
      }

      return true;
    },
    async jwt({ token, user, account }) {
      if (account?.provider === "microsoft-entra-id" && user) {
        // Login SSO: id/role vêm do BANCO (o `user` aqui é o profile do Entra —
        // user.id é o oid, e o role é placeholder). O signIn já validou e fez
        // o backfill do oid, então a linha existe.
        const oid = user.id;
        let [conta] = oid
          ? await db.select().from(users).where(eq(users.entraOid, oid)).limit(1)
          : [];
        if (!conta && user.email) {
          [conta] = await db
            .select()
            .from(users)
            .where(eq(users.email, user.email.toLowerCase()))
            .limit(1);
        }
        if (!conta) {
          // Não deve acontecer (signIn aprovou) — falha fechada, sem sessão.
          throw new Error("Usuário aprovado no signIn não encontrado no banco.");
        }
        token.id   = conta.id;
        token.role = normalizeRole(conta.role);
        // Decisão 4 (revogação imediata): cada sessão ganha um jti único no
        // LOGIN. O BFF (core/revocation.py) rejeita tokens cujo jti esteja na
        // denylist OU cujo iat seja anterior ao corte auth:revogado:user:<id>.
        token.jti = crypto.randomUUID();
      } else if (user) {
        // Login break-glass (Credentials): authorize() devolveu id/role do banco.
        token.role = user.role;
        token.id   = user.id!;
        token.jti  = crypto.randomUUID();
      }
      // Normaliza roles legados gravados em JWTs antigos
      if (token.role) {
        token.role = normalizeRole(token.role as string);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = normalizeRole(token.role as string ?? "");
        session.user.id   = token.id as string;
      }
      return session;
    },
  },
  events: {
    // Auditoria de logout. Na strategy JWT o payload é `{ token }`. Best-effort:
    // NUNCA lança. Os eventos do NextAuth não expõem o Request, então não há
    // IP/user-agent aqui — registramos apenas o usuário e o jti da sessão.
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      const userId = (token?.id as string | undefined) ?? null;
      const jti = (token?.jti as string | undefined) ?? null;
      // Revogação imediata do jti no logout (Decisão 4 / WP09): o BFF passa a
      // rejeitar este token na hora (denylist auth:revogados), sem esperar o
      // maxAge de 8h. Best-effort — revokeJti nunca lança.
      await revokeJti(jti);
      try {
        await db.insert(auditLog).values({
          userId,
          acao:       "LOGOUT",
          entidade:   "auth",
          entidadeId: userId ?? "desconhecido",
          detalhes: { jti },
        });
      } catch (err) {
        logger.error("Falha ao gravar auditoria de logout (best-effort)", err);
      }
    },
  },
  pages: {
    signIn: "/login",
    // Erros de OAuth (Configuration, OAuthCallbackError, AccessDenied…) caem
    // em /login?error=<código> — a página mapeia para mensagens amigáveis.
    error: "/login",
  },
  session: {
    strategy: "jwt",
    // Decisão 4: sessão de 8h (antes herdava o default de ~30 dias). Com a
    // revogação por jti/corte (BFF) + maxAge curto, desativar usuário tem
    // efeito imediato no BFF e janela máxima de 8h nas páginas do Next.
    maxAge: 8 * 60 * 60,
  },
  trustHost: true,
});

// ── Normalização de roles ─────────────────────────────────────────────────────

/**
 * Normaliza roles legados (admin/editor/viewer) para o novo padrão.
 * Garante retrocompatibilidade com usuários criados antes da migração.
 */
function normalizeRole(role: string): UserRole {
  switch (role) {
    case "admin":        return "ADMIN";
    case "editor":       return "LIDER";
    case "viewer":       return "VISUALIZADOR";
    case "ADMIN":        return "ADMIN";
    case "LIDER":        return "LIDER";
    case "ORCAMENTISTA": return "ORCAMENTISTA";
    case "TECNICO":      return "TECNICO";
    case "SGI":          return "SGI";
    case "VISUALIZADOR": return "VISUALIZADOR";
    case "EXTERNO":      return "EXTERNO";
    default:             return DEFAULT_ROLE;
  }
}


/**
 * Notifica os ADMINs de que alguem entrou na fila de aprovacao.
 *
 * Isolado e sempre best-effort: importa sob demanda (evita puxar a cadeia de
 * e-mail no bundle de auth quando nao ha pendente) e engole qualquer erro.
 */
async function avisarAdminsDeSolicitacao(email: string, nome: string | null): Promise<void> {
  try {
    const [{ templateSolicitacaoAcesso }, { sendEmail }, { emailsPorPapel }] = await Promise.all([
      import("@/lib/email/templates"),
      import("@/lib/email/send"),
      import("@/lib/email/destinatarios"),
    ]);
    // Reusa o publico de "falha na coleta" = ADMINs ativos que nao desligaram o
    // aviso. Nao criei tipo novo na matriz para nao exigir migracao de
    // preferencias; se um dia virar tipo proprio, e so trocar aqui.
    const destinos = await emailsPorPapel("SYNC_FALHOU");
    if (destinos.length === 0) return;
    const { subject, html, text } = templateSolicitacaoAcesso({ nome, email });
    await sendEmail({ to: destinos, subject, html, text });
  } catch (e) {
    logger.warn("nao foi possivel avisar os admins do pedido de acesso", {
      email,
      erro: e instanceof Error ? e.message : String(e),
    });
  }
}
