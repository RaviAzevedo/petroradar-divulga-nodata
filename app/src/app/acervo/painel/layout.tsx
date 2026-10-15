import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade } from "@/lib/permissions";

export const metadata: Metadata = {
  title: "Painel do Acervo",
  description:
    "Dashboard de provabilidade e qualidade do acervo: dossiês completos, fila de atestados a pedir e pendências do cofre.",
};

/**
 * Guard server-side do segmento, cópia literal do de `acervo/operacoes/layout.tsx`.
 *
 * O painel agrega cliente, contrato e VALOR de obra — o mesmo recorte que a
 * listagem de operações expõe, então o corte de papel é o mesmo (Conformidade,
 * regra P10). `acervo/layout.tsx` não checa nada; sem este arquivo a rota
 * nasceria aberta a qualquer sessão.
 */
export default async function PainelAcervoLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  return <>{children}</>;
}
