import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade } from "@/lib/permissions";

export const metadata: Metadata = {
  title: "Famílias CRC",
  description: "Catálogo hierárquico de famílias do Cadastro de Registro Cadastral Petrobras (CRC).",
};

/**
 * RBAC hardening (FRENTE D, item 2): Famílias CRC é módulo de Conformidade
 * (ADMIN/LIDER/SGI). A sidebar esconde o link por papel, mas a página abria a
 * "casca" por URL direta. Guard server-side no layout (cobre page + subpáginas
 * nova/[id]) espelhando o padrão de relatorios/page.tsx: sem sessão → /login;
 * fora da Conformidade → home. As rotas /api/conformidade/* revalidam o papel.
 */
export default async function FamiliasLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  return <>{children}</>;
}
