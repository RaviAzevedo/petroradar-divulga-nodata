import { PainelClient } from "./PainelClient";

/**
 * /acervo/painel — dashboard de provabilidade/qualidade do acervo (ACERVO-PAINEL).
 *
 * Server component fino de propósito: o guard vive em `layout.tsx` e todo o
 * comportamento (4 chamadas em paralelo, agregação, deep-links) mora no client.
 */
export default function PainelAcervoPage() {
  return <PainelClient />;
}
