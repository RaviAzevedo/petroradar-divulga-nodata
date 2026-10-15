import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explorar",
  description: "Busca avançada e classificação de licitações Petronect por perfil de interesse.",
};

export default function ExplorarLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
