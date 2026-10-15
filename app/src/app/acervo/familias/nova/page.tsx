import { Suspense } from "react";
import NovaFamiliaClient from "./NovaFamiliaClient";

export const dynamic = "force-dynamic";

// Suspense obrigatorio: o formulario le useSearchParams() para o
// pre-preenchimento vindo do dossie de uma familia.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <NovaFamiliaClient />
    </Suspense>
  );
}
