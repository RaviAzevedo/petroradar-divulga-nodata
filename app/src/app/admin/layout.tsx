import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/permissions";
import { AdminNav } from "./AdminNav";

export const metadata: Metadata = {
  title: "Administração",
};

/**
 * Admin Center — casca comum de /admin/*: guard de ADMIN + abas de navegação
 * entre as seções (Usuários, Solicitações, Auditoria, Saúde do Scraper).
 *
 * RBAC hardening (FRENTE D, item 2): a área /admin é exclusiva de ADMIN. A
 * sidebar esconde os links por papel, mas as páginas abriam a "casca" por URL
 * direta (o client component só falha no fetch, que já retorna 403). Guard
 * server-side no layout (cobre TODO /admin/*) espelhando relatorios/page.tsx:
 * sem sessão → /login; não-admin → home. As rotas /api/admin/* revalidam com
 * requireAdmin.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isAdmin(session.user.role)) redirect("/");

  return (
    <div>
      <AdminNav />
      {children}
    </div>
  );
}
