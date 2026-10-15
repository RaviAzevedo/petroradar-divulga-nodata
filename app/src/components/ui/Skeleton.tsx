import { cn } from "@/lib/utils";

// ─── Átomo ────────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-gray-200", className)} />;
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function SkeletonKpiCard({ className }: { className?: string }) {
  return (
    <div className={cn("bg-white rounded-xl border border-gray-200 p-4", className)}>
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-4 w-4 rounded" />
      </div>
      <Skeleton className="h-7 w-12 mb-1.5" />
      <Skeleton className="h-2 w-20" />
    </div>
  );
}

// ─── Linha de tabela ─────────────────────────────────────────────────────────

export function SkeletonRow({ cols = 5 }: { cols?: number }) {
  const widths = ["w-24", "flex-1", "w-20", "w-16", "w-12"];
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === 1 ? "flex-1" : widths[i] ?? "w-16")}
        />
      ))}
    </div>
  );
}

// ─── Linha de tabela real (<tr>/<td>) — para usar dentro de <tbody> ──────────

export function SkeletonTableRow({ cols = 5 }: { cols?: number }) {
  const widths = ["w-20", "w-full", "w-16", "w-12", "w-14", "w-16", "w-20", "w-14", "w-16", "w-8"];
  return (
    <tr className="border-b border-gray-100 last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3.5">
          <Skeleton className={cn("h-3.5", widths[i] ?? "w-16")} />
        </td>
      ))}
    </tr>
  );
}

// ─── Card de licitação (visão mobile) ─────────────────────────────────────────

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-4 w-10" />
      </div>
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-2/3" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-14 rounded-full" />
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

// ─── Painel com linhas ────────────────────────────────────────────────────────

function SkeletonPanel({ rows = 5, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {title && (
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

// ─── Dashboard skeleton ───────────────────────────────────────────────────────

export function SkeletonDashboard() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonKpiCard key={i} />
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <SkeletonPanel rows={6} />
        </div>
        <SkeletonPanel rows={5} />
      </div>

      {/* Bottom grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <SkeletonPanel rows={5} />
        <SkeletonPanel rows={3} />
      </div>
    </div>
  );
}

