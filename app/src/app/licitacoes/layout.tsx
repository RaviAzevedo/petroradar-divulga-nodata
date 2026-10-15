import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Licitação",
  description: "Detalhe da licitação Petronect — briefing, dossiê, habilitação, circulares e propostas.",
};

export default function LicitacoesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
