"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { Sidebar } from "./Sidebar";
import { Menu, Search } from "lucide-react";
import { CommandPalette, openCommandPalette } from "@/components/ui/CommandPalette";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <SessionProvider>
      {!isLoginPage && (
        <a
          href="#conteudo-principal"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[110] focus:px-4 focus:py-2 focus:bg-brand-black focus:text-white focus:text-sm focus:font-medium focus:rounded-lg focus:shadow-lg"
        >
          Pular para o conteúdo
        </a>
      )}
      {!isLoginPage && <CommandPalette />}
      {isLoginPage ? (
        <main className="min-h-screen">{children}</main>
      ) : (
        <div className="flex min-h-screen">
          {/* ── Mobile backdrop ── */}
          {mobileOpen && (
            <div
              className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm md:hidden"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* ── Sidebar ── */}
          <Sidebar
            mobileOpen={mobileOpen}
            onClose={() => setMobileOpen(false)}
          />

          {/* ── Main area ── */}
          <div className="flex-1 flex flex-col min-w-0 md:ml-56">
            {/* Mobile top bar */}
            <header className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 bg-white/95 backdrop-blur border-b border-gray-200 md:hidden">
              <button
                onClick={() => setMobileOpen(true)}
                className="p-2 -ml-1 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
                aria-label="Abrir menu"
              >
                <Menu className="h-5 w-5" />
              </button>

              {/* Brand */}
              <div className="flex items-center gap-2.5 flex-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/logo-mark.svg"
                  alt="Proponente"
                  className="flex-shrink-0 w-5"
                />
                <span className="text-sm font-bold text-brand-black tracking-wide">
                  PETRO RADAR
                </span>
              </div>

              {/* Busca (Command Palette) — mobile: só o ícone */}
              <button
                type="button"
                onClick={openCommandPalette}
                className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
                aria-label="Buscar (⌘K)"
              >
                <Search className="h-5 w-5" />
              </button>

            </header>

            {/* Page content */}
            <main id="conteudo-principal" tabIndex={-1} className="flex-1 focus:outline-none">
              <div className="max-w-[1400px] mx-auto px-4 sm:px-5 lg:px-6 py-4 sm:py-6">
                {children}
              </div>
            </main>
          </div>
        </div>
      )}
    </SessionProvider>
  );
}
