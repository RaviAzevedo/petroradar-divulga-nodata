import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Downloads",
  description: "Histórico de anexos baixados e exports do Petro Radar.",
};

export default function DownloadsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
