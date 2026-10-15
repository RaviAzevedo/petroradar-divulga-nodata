"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Search, FileText, BarChart3, Download,
  Settings, Users, Target, ArrowRight, Loader2,
  Command, ListTree,
  Sparkles, CalendarClock, LayoutDashboard, Building2, HardHat,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { podeAcessarRota } from "@/lib/nav-access";
import { useModalA11y } from "./useModalA11y";

/**
 * Evento global que abre a palette de qualquer lugar do shell (ex.: botão de
 * busca da Sidebar/topbar) — equivalente ao atalho ⌘K/Ctrl+K.
 */
const OPEN_COMMAND_PALETTE_EVENT = "petro-radar:open-command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

interface SearchResult {
  licitacoes: Array<{
    id: string;
    numero: string;
    objeto: string | null;
    empresa: string | null;
    relevancia: string | null;
  }>;
}

const PAGES = [
  { label: "Painel", href: "/", icon: BarChart3 },
  { label: "Hoje", href: "/hoje", icon: CalendarClock },
  { label: "Explorar Licitações", href: "/explorar", icon: Search },
  ...(config.features.resultados ? [{ label: "Resultados", href: "/resultados", icon: Target }] : []),
  // Acervo (painel + busca semântica RAG + Famílias CRC + Cofre / Conformidade SGI)
  { label: "Painel do Acervo", href: "/acervo/painel", icon: LayoutDashboard },
  // Nenhum papel ganha atalho novo: `visiblePages` filtra por `podeAcessarRota`,
  // e as duas já têm regra em ROTAS_RESTRITAS (isConformidade).
  { label: "Acervo — Operações", href: "/acervo/operacoes", icon: Building2 },
  { label: "Acervo — Profissionais", href: "/acervo/profissionais", icon: HardHat },
  { label: "Acervo — Busca Semântica", href: "/acervo", icon: Sparkles },
  { label: "Acervo — Famílias CRC", href: "/acervo/familias", icon: ListTree },
  { label: "Acervo — Cofre", href: "/acervo/cofre", icon: FileText },
  // Demais
  { label: "Downloads", href: "/downloads", icon: Download },
  { label: "Perfis de Interesse", href: "/perfis", icon: Users },
  { label: "Administração", href: "/admin/usuarios", icon: Settings },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { data: session } = useSession();
  const role = session?.user?.role;

  // a11y: focus trap, foco inicial no input, retorno de foco e Escape
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: open,
    onClose: () => setOpen(false),
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const abrir = () => setOpen(true);
    window.addEventListener("keydown", handler);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, abrir);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, abrir);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults(null);
      setSelectedIndex(0);
    }
  }, [open]);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/licitacoes/search?q=${encodeURIComponent(q)}`);
      if (res.ok) setResults(await res.json());
    } catch { /* silencioso */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  // Mesma regra rota→papel da Sidebar (nav-access): não oferecer atalho que
  // "rebate" em redirect/403 (Famílias CRC, Cofre, Configurações etc.).
  const visiblePages = PAGES.filter((p) => podeAcessarRota(p.href, role));

  const filteredPages = query.length > 0
    ? visiblePages.filter((p) => p.label.toLowerCase().includes(query.toLowerCase()))
    : visiblePages;

  const allItems: Array<{ type: string; label: string; sub?: string; href: string; icon: typeof Search }> = [];

  if (results?.licitacoes.length) {
    for (const l of results.licitacoes) {
      allItems.push({
        type: "Licitação",
        label: l.numero,
        sub: l.objeto?.slice(0, 60) ?? undefined,
        href: `/licitacoes/${l.id}`,
        icon: FileText,
      });
    }
  }

  for (const p of filteredPages) {
    allItems.push({ type: "Página", label: p.label, href: p.href, icon: p.icon });
  }

  const navigate = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && allItems.length > 0) {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp" && allItems.length > 0) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && allItems[selectedIndex]) {
      e.preventDefault();
      navigate(allItems[selectedIndex].href);
    }
  };

  useEffect(() => { setSelectedIndex(0); }, [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />

      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-2xl border border-gray-200 shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Busca rápida"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search className="h-5 w-5 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Buscar licitação ou navegar..."
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-gray-400"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-gray-400 bg-gray-100 rounded border border-gray-200">
            ESC
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-y-auto py-2">
          {allItems.length === 0 && query.length >= 2 && !loading && (
            <p className="px-4 py-6 text-sm text-gray-400 text-center">
              Nenhum resultado para &ldquo;{query}&rdquo;
            </p>
          )}

          {allItems.map((item, i) => {
            const Icon = item.icon;
            const isSelected = i === selectedIndex;
            const showHeader = i === 0 || allItems[i - 1].type !== item.type;

            return (
              <div key={`${item.type}-${item.href}-${i}`}>
                {showHeader && (
                  <p className="px-4 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                    {item.type === "Licitação" ? "Licitações" : "Páginas"}
                  </p>
                )}
                <button
                  onClick={() => navigate(item.href)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-2 text-left transition-colors",
                    isSelected ? "bg-brand-orange/10 text-brand-orange" : "text-gray-700 hover:bg-gray-50"
                  )}
                >
                  <Icon className={cn("h-4 w-4 flex-shrink-0", isSelected ? "text-brand-orange" : "text-gray-400")} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.label}</p>
                    {item.sub && <p className="text-xs text-gray-400 truncate">{item.sub}</p>}
                  </div>
                  {isSelected && <ArrowRight className="h-3.5 w-3.5 flex-shrink-0" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center gap-3 text-[10px] text-gray-400">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200 font-mono">↑↓</kbd> navegar
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200 font-mono">↵</kbd> abrir
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-white rounded border border-gray-200 font-mono">esc</kbd> fechar
            </span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-gray-400">
            <Command className="h-3 w-3" />K
          </div>
        </div>
      </div>
    </div>
  );
}
