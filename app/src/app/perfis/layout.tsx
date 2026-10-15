import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Perfis de Interesse",
  description: "Configuração de perfis de classificação automática de licitações.",
};

export default function PerfisLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
