import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";

// next/font/LOCAL (não /google) — o .woff2 do Inter (latin, variable) é versionado
// em ./fonts/, então o build standalone NÃO precisa de egress p/ fonts.gstatic.com
// (fecha o air-gap do build; antes quebrava offline). Mesmo inter.className de antes.
const inter = localFont({
  src: "./fonts/Inter-latin.woff2",
  display: "swap",
  weight: "100 900", // arquivo variável (eixo wght 100..900)
});

// Toda a app exige autenticação NextAuth (session via cookies), o que torna a
// renderização inerentemente dinâmica. force-dynamic global desabilita o SSG
// (que é incompatível com auth via session) e contorna bug conhecido do Vercel
// CLI 53 + Next 16.2 com páginas client component estáticas dentro de pastas
// que também têm subpaths dinâmicos.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F59C00",
};

export const metadata: Metadata = {
  // Liga o PWA: o link <manifest> é injetado a partir de /manifest.webmanifest.
  manifest: "/manifest.webmanifest",
  // App instalável no iOS (que ignora o manifest p/ standalone): usa o título e
  // a status bar padrão, combinando com o laranja Proponente do viewport themeColor.
  appleWebApp: {
    capable: true,
    title: "Petro Radar",
    statusBarStyle: "default",
  },
  title: {
    default: "Petro Radar",
    template: "%s | Petro Radar",
  },
  description:
    "Plataforma de monitoramento inteligente de licitações Petronect do setor de petróleo e gás.",
  keywords: [
    "licitações",
    "Petronect",
    "petróleo",
    "gás",
    "Proponente",
    "engenharia",
    "monitoramento",
    "offshore",
    "oil and gas",
  ],
  authors: [{ name: "Petro Radar" }],
  creator: "Petro Radar",
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    // iOS ignora o manifest ao instalar: precisa do apple-touch-icon (180x180 PNG).
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    locale: "pt_BR",
    title: "Petro Radar",
    description:
      "Monitoramento inteligente de licitações Petronect do setor de petróleo e gás.",
    siteName: "Petro Radar",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className={`${inter.className} bg-gray-50 antialiased`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
