import { Skeleton, SkeletonRow } from "@/components/ui/Skeleton";

export default function ExplorarLoading() {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-lg" />
        <Skeleton className="h-10 w-10 rounded-lg" />
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>

      {/* Quick filters */}
      <div className="flex gap-2 flex-wrap">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-lg" />
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Header row */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-200 bg-gray-50">
          <Skeleton className="h-3 w-24 flex-shrink-0" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16 flex-shrink-0" />
          <Skeleton className="h-3 w-20 flex-shrink-0" />
          <Skeleton className="h-3 w-20 flex-shrink-0" />
          <Skeleton className="h-3 w-16 flex-shrink-0" />
        </div>
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonRow key={i} cols={6} />
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-40" />
        <div className="flex gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-8 rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
