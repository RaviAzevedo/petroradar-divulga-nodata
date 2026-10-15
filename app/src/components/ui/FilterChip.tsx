"use client";

import { X } from "lucide-react";

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-brand-orange/10 text-brand-orange rounded-full text-xs font-medium">
      {label}
      <button onClick={onRemove} className="hover:opacity-70" aria-label="Remover filtro">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
