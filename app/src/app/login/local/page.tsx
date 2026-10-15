import { notFound } from "next/navigation";
import { LoginLocalForm } from "./LoginLocalForm";

/**
 * /login/local — break-glass: login por e-mail/senha (o formulário que era o
 * /login antes do SSO). Só existe quando AUTH_BREAKGLASS=1 no ambiente — em
 * operação normal (SSO-only) a rota responde 404 e o provider Credentials nem
 * está registrado no NextAuth (lib/auth.ts).
 */
export const dynamic = "force-dynamic";

export default function LoginLocalPage() {
  if (process.env.AUTH_BREAKGLASS !== "1") notFound();
  return <LoginLocalForm />;
}
