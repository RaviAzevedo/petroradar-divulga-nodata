import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade } from "@/lib/permissions";

// Metadata do segmento (0043, D5): o layout cobre a LISTA e o CURRÍCULO.
export const metadata: Metadata = {
  title: "Profissionais do Acervo",
  description: "Responsáveis técnicos, o registro no CREA e as obras que cada um assina.",
};

/**
 * Guard server-side do segmento, cópia literal do de `acervo/operacoes/layout.tsx`.
 *
 * Existe porque `acervo/layout.tsx` NÃO checa nada: sem este arquivo,
 * /acervo/profissionais* nasceria aberto a qualquer sessão, expondo nome,
 * CREA e formação de pessoas — e, pelas obras que cada uma assina, o acervo
 * inteiro. O corte de papel é o mesmo do cofre (Conformidade), e é o que faz
 * a tela continuar segura mesmo que alguém esqueça `nav-access.ts` (§7.10).
 * As rotas /api/conformidade/profissionais* revalidam por conta própria.
 */
export default async function ProfissionaisLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  return <>{children}</>;
}
