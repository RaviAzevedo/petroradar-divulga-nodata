import { Loader2 } from "lucide-react";

/** Skeleton padrão. Cada rota pode usar `RouteLoading` ou criar o seu próprio. */
export function RouteLoading() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
    </div>
  );
}
