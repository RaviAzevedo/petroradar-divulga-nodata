import { Suspense } from "react";
import NovoCofreClient from "./NovoCofreClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    // useSearchParams (operação pré-travada via ?operacaoId=…) exige boundary
    // de Suspense no server component — sem ele o build do Next falha.
    <Suspense fallback={null}>
      <NovoCofreClient />
    </Suspense>
  );
}
