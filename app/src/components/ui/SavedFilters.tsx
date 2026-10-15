"use client";

import { useState, useEffect, useRef } from "react";
import { Bookmark, Trash2, X } from "lucide-react";
import { Button } from "./Button";

interface SavedFilter {
  nome: string;
  params: string;
}

interface SavedFiltersProps {
  storageKey: string;
  currentParams: string;
  onApply: (params: string) => void;
}

const MAX_FILTERS = 10;

function readFilters(storageKey: string): SavedFilter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as SavedFilter[]) : [];
  } catch {
    return [];
  }
}

export function SavedFilters({ storageKey, currentParams, onApply }: SavedFiltersProps) {
  const [open, setOpen] = useState(false);
  // Lazy init: lê do localStorage no primeiro render (client). No SSR retorna []
  // e o React reconcilia ao hidratar, evitando set-state-in-effect.
  const [filters, setFilters] = useState<SavedFilter[]>(() => readFilters(storageKey));
  const [showInput, setShowInput] = useState(false);
  const [nome, setNome] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  function persist(next: SavedFilter[]) {
    setFilters(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  function salvar() {
    const trimmed = nome.trim();
    if (!trimmed) return;
    const next = [{ nome: trimmed, params: currentParams }, ...filters].slice(0, MAX_FILTERS);
    persist(next);
    setNome("");
    setShowInput(false);
  }

  function remover(index: number) {
    persist(filters.filter((_, i) => i !== index));
  }

  function aplicar(params: string) {
    onApply(params);
    setOpen(false);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowInput(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-2.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors text-gray-600"
      >
        <Bookmark className="h-4 w-4" />
        Filtros salvos
        {filters.length > 0 && (
          <span className="ml-0.5 bg-gray-200 text-gray-600 text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
            {filters.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Filtros salvos</span>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="max-h-60 overflow-y-auto">
            {filters.length === 0 && (
              <p className="px-3 py-4 text-xs text-gray-400 text-center">Nenhum filtro salvo.</p>
            )}
            {filters.map((f, i) => (
              <div
                key={`${f.nome}-${i}`}
                className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 group transition-colors"
              >
                <button
                  onClick={() => aplicar(f.params)}
                  className="flex-1 text-left text-sm text-gray-700 truncate hover:text-brand-orange"
                >
                  {f.nome}
                </button>
                <button
                  onClick={() => remover(i)}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                  aria-label={`Remover filtro ${f.nome}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-100 p-2">
            {showInput ? (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") salvar(); if (e.key === "Escape") setShowInput(false); }}
                  placeholder="Nome do filtro..."
                  className="flex-1 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
                <Button size="sm" onClick={salvar} disabled={!nome.trim()}>
                  Salvar
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setShowInput(true)}
                disabled={filters.length >= MAX_FILTERS}
                className="w-full text-xs text-center py-1.5 text-brand-orange font-semibold hover:bg-brand-orange/5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {filters.length >= MAX_FILTERS ? `Limite de ${MAX_FILTERS} filtros` : "Salvar filtro atual"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
