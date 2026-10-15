import type { Metadata } from "next";
import { AcervoClient } from "./AcervoClient";

export const metadata: Metadata = {
  title: "Acervo Técnico — Busca Semântica",
};

/**
 * Página /acervo — busca semântica (RAG) sobre o acervo técnico e editais.
 *
 * O acesso é protegido pelo middleware (proxy.ts) a nível de sessão e a rota
 * /api/acervo/buscar reforça o gate de papel (requireAcervo) + anti-IDOR. Aqui
 * só renderizamos o shell; toda a interação (pergunta → trechos + síntese
 * citada) vive no client component AcervoClient.
 */
export default function AcervoPage() {
  return <AcervoClient />;
}
