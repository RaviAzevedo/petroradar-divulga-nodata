"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, UserPlus, ScrollText, Activity, ShieldCheck, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Abas do Admin Center. O badge de Solicitações mostra quantos acessos SSO
 * aguardam aprovação (users.pendente) — recarrega a cada troca de rota para
 * refletir aprovações/recusas feitas na própria área.
 */

const SECOES = [
  { href: "/admin/usuarios",      label: "Usuários",         icon: Users },
  { href: "/admin/solicitacoes",  label: "Solicitações",     icon: UserPlus },
  { href: "/admin/emails",        label: "E-mails",          icon: Mail },
  { href: "/admin/auditoria",     label: "Auditoria",        icon: ScrollText },
  { href: "/admin/saude-scraper", label: "Saúde do Scraper", icon: Activity },
];

export function AdminNav() {
  const pathname = usePathname();
  const [pendentes, setPendentes] = useState(0);

  useEffect(() => {
    let ativo = true;
    fetch("/api/admin/users")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (ativo && d?.users) {
          setPendentes(d.users.filter((u: { pendente?: boolean }) => u.pendente).length);
        }
      })
      .catch(() => {});
    return () => { ativo = false; };
  }, [pathname]);

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="h-5 w-5 text-brand-orange" />
        <h1 className="text-2xl font-bold text-brand-black">Administração</h1>
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {SECOES.map(({ href, label, icon: Icon }) => {
          const ativo = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                ativo
                  ? "border-brand-orange text-brand-black"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              {href === "/admin/solicitacoes" && pendentes > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-brand-orange text-white leading-none">
                  {pendentes}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
