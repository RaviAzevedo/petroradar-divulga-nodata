import { OperacoesClient } from "./OperacoesClient";

/**
 * /acervo/operacoes — índice de operações (WP-10).
 *
 * Server component fino de propósito: o guard vive em `layout.tsx` e todo o
 * comportamento (catálogo inteiro client-side, filtros, URL) mora no client.
 */
export default function OperacoesPage() {
  return <OperacoesClient />;
}
