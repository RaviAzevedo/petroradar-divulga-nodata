import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Resultados",
  description: "Registro factual de resultados de licitações Petronect.",
};

export default function ResultadosLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
