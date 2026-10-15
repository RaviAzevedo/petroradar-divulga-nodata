import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hoje — Petro Radar",
  description:
    "Visão mobile-first do dia: prazos das próximas 72h, fila aguardando decisão e novos editais de alto score.",
};

export default function HojeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
