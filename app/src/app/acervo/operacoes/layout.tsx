import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade } from "@/lib/permissions";

// Metadata genérica do segmento (A4): o layout agora cobre o índice E a ficha.
export const metadata: Metadata = {
  title: "Operações do Acervo",
  description: "Catálogo de operações e o dossiê de provas de cada obra no cofre.",
};

/**
 * Guard server-side do segmento, cópia literal do de `acervo/cofre/layout.tsx`.
 *
 * Existe porque `acervo/layout.tsx` NÃO checa nada: sem este arquivo,
 * /acervo/operacoes* nasceria aberto a qualquer sessão, expondo cliente,
 * contrato e valor de obra. O índice e a ficha mostram o mesmo acervo do
 * cofre, então o corte de papel é o mesmo (Conformidade). As rotas
 * /api/conformidade/operacoes* revalidam por conta própria.
 */
export default async function OperacoesLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  return <>{children}</>;
}
