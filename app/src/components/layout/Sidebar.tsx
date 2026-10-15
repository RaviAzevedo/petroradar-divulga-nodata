"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Search,
  Download,
  SlidersHorizontal,
  Settings,
  LogOut,
  X,
  Building2,
  Trophy,
  ListTree,
  Lock,
  CalendarClock,
  Sparkles,
  Mail, HardHat
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { isAdmin } from "@/lib/permissions";
import { podeAcessarRota } from "@/lib/nav-access";
import { openCommandPalette } from "@/components/ui/CommandPalette";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Quando true, o realce ativo exige match exato (evita acender pai + filho). */
  exact?: boolean;
}

interface NavSection {
  /** Heading discreto da seção; vazio para a primeira (monitoramento). */
  heading?: string;
  items: NavItem[];
}

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { data: session } = useSession();

  const role = session?.user?.role;
  const ehAdmin = role ? isAdmin(role) : false;

  // ── MONITORAMENTO ──────────────────────────────────────────────────────
  const monitoramento: NavItem[] = [
    { href: "/", label: "Painel", icon: LayoutDashboard, exact: true },
    // Visão diária mobile-first (PWA): novos editais de alto score.
    { href: "/hoje", label: "Hoje", icon: CalendarClock },
    { href: "/explorar", label: "Explorar", icon: Search },
    ...(config.features.resultados
      ? [{ href: "/resultados", label: "Resultados", icon: Trophy }]
      : []),
  ];

  // ── ACERVO ─────────────────────────────────────────────────────────────
  // Busca Semântica (RAG) é aberta a todos que podem visualizar; os itens de
  // habilitação (Famílias CRC, Cofre) ficam restritos ao setor de Conformidade
  // (regras rota→papel centralizadas em nav-access, compartilhadas com a palette).
  const acervo: NavItem[] = [
    // Painel do acervo (ACERVO-PAINEL): visão de relance de provabilidade e
    // qualidade — primeiro da seção. Sem conflito de realce: /acervo é exact.
    { href: "/acervo/painel", label: "Painel", icon: LayoutDashboard },
    { href: "/acervo", label: "Busca Semântica", icon: Sparkles, exact: true },
    // Índice de operações (0034/A22): a porta de entrada do fluxo "subir prova
    // por obra" — sem ela a tela /acervo/operacoes só existiria por URL digitada.
    { href: "/acervo/operacoes", label: "Operações", icon: Building2 },
    // Profissionais do acervo (0043, onda 4): quem assina cada prova e o
    // curriculo tecnico do RT. Mesmo recorte de papel do cofre — a regra vive
    // em nav-access ("/acervo/profissionais": isConformidade), como as demais.
    // Sem `exact`: o realce por startsWith acende tambem em /acervo/profissionais/<id>.
    { href: "/acervo/profissionais", label: "Profissionais", icon: HardHat },
    { href: "/acervo/familias", label: "Famílias CRC", icon: ListTree },
    { href: "/acervo/cofre", label: "Cofre", icon: Lock },
  ];

  // ── FERRAMENTAS ────────────────────────────────────────────────────────
  const ferramentas: NavItem[] = [
    { href: "/downloads", label: "Downloads", icon: Download },
    { href: "/perfis", label: "Perfis de Interesse", icon: SlidersHorizontal },
    { href: "/preferencias", label: "Preferências de e-mail", icon: Mail },
  ];

  const sections: NavSection[] = [
    { items: monitoramento },
    { heading: "Acervo", items: acervo },
    { heading: "Ferramentas", items: ferramentas },
  ]
    .map((s) => ({ ...s, items: s.items.filter((i) => podeAcessarRota(i.href, role)) }))
    .filter((s) => s.items.length > 0);

  // Realce de ativo: itens `exact` só acendem em match exato (ex.: /acervo
  // não acende junto de /acervo/familias). Demais usam startsWith.
  const isActive = (item: NavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(item.href + "/");

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen w-64 md:w-56 border-r border-gray-200 bg-white flex flex-col",
        "transition-transform duration-300 ease-in-out",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        "md:translate-x-0"
      )}
    >
      {/* ── Logo / Marca ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100">
        <Link href="/" onClick={onClose} className="flex items-center gap-3 min-w-0">
          {/* Logograma real */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-mark.svg"
            alt="Proponente"
            className="flex-shrink-0 w-8"
          />
          {/* Texto */}
          <div className="min-w-0">
            <div className="text-sm font-bold text-brand-black tracking-wide leading-tight">
              PETRO RADAR
            </div>
            <div className="text-[10px] text-gray-400 font-medium tracking-wider leading-tight truncate">
              PROPONENTE ENGENHARIA
            </div>
          </div>
        </Link>

        {/* Close — mobile only */}
        <button
          onClick={onClose}
          className="md:hidden p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition-colors flex-shrink-0"
          aria-label="Fechar menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── Busca (abre a Command Palette — mesmo que ⌘K) ────────────── */}
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => { onClose?.(); openCommandPalette(); }}
          aria-label="Buscar (⌘K)"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600 transition-colors"
        >
          <Search className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1 text-left">Buscar</span>
          <kbd className="hidden md:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-gray-400 bg-gray-100 rounded border border-gray-200">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* ── Nav ──────────────────────────────────────────────────────── */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {sections.map((section, idx) => (
          <div key={section.heading ?? "monitoramento"} className={cn(idx > 0 && "mt-4")}>
            {section.heading && (
              <div className="px-3 mb-1 text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                {section.heading}
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                      active
                        ? "bg-gray-100 text-brand-black"
                        : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                    )}
                  >
                    <item.icon
                      className={cn(
                        "h-4 w-4 flex-shrink-0",
                        active ? "text-brand-orange" : "text-gray-400"
                      )}
                    />
                    <span className="truncate">{item.label}</span>
                    {active && (
                      <div className="ml-auto w-1.5 h-1.5 rounded-full bg-brand-orange flex-shrink-0" />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Marca com slogan no rodapé ───────────────────────────────── */}
      <div className="px-4 py-3 border-t border-gray-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.svg"
          alt="Petro Radar"
          className="w-full opacity-75 hover:opacity-100 transition-opacity"
        />
      </div>

      {/* ── Footer: usuário + ações ───────────────────────────────────── */}
      <div className="px-3 pb-4 space-y-0.5">
        {session?.user && (
          <div className="px-3 py-2 mb-1 min-w-0">
            <div className="text-xs font-medium text-gray-700 truncate">
              {session.user.name || session.user.email}
            </div>
            <div className="text-[10px] text-gray-400 truncate">
              {session.user.email}
            </div>
          </div>
        )}
        {/* ── ADMIN ─────────────────────────────────────────────────── */}
        {/* Admin Center (/admin): usuários+roles, solicitações de acesso SSO,
            auditoria e saúde do scraper — as seções viraram abas do layout. */}
        {ehAdmin && (
          <Link
            href="/admin/usuarios"
            onClick={onClose}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            <Settings className="h-4 w-4 flex-shrink-0 text-gray-400" />
            Administração
          </Link>
        )}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 w-full text-left transition-colors"
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          Sair
        </button>
      </div>
    </aside>
  );
}
