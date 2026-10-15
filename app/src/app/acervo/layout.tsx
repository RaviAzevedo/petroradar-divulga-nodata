import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Acervo Técnico",
  description:
    "Busca semântica em linguagem natural sobre o acervo técnico da Proponente (editais, documentos de habilitação e projetos) com citação da fonte.",
};

export default function AcervoLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
