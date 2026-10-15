import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade } from "@/lib/permissions";

export const metadata: Metadata = {
  title: "Cofre de Habilitação",
  description: "Cofre de documentos de habilitação versionado, com OCR opt-in e alertas de vencimento.",
};

/**
 * RBAC hardening (FRENTE D, item 2): Cofre de Habilitação é módulo de
 * Conformidade (ADMIN/LIDER/SGI). Guard server-side no layout (cobre page +
 * subpáginas novo/[id]) espelhando relatorios/page.tsx: sem sessão → /login;
 * fora da Conformidade → home. As rotas /api/conformidade/cofre/* revalidam.
 */
export default async function CofreLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  return <>{children}</>;
}
