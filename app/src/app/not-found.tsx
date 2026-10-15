import Link from "next/link";
import { Search, Home, ArrowRight } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        {/* 404 */}
        <div className="mb-6">
          <div className="text-8xl font-black text-gray-100 leading-none select-none">
            404
          </div>
          <div className="relative -mt-6">
            <div className="flex items-center justify-center w-14 h-14 mx-auto rounded-2xl bg-amber-50 border border-amber-200">
              <Search className="h-6 w-6 text-amber-500" />
            </div>
          </div>
        </div>

        {/* Text */}
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          Página não encontrada
        </h1>
        <p className="text-sm text-gray-500 mb-6 leading-relaxed">
          A página que você está procurando não existe ou foi movida. Verifique
          o endereço ou use o menu de navegação.
        </p>

        {/* Quick links */}
        <div className="space-y-2 mb-6">
          {[
            { href: "/", label: "Painel Principal" },
            { href: "/explorar", label: "Explorar Licitações" },
            { href: "/downloads", label: "Downloads" },
            { href: "/perfis", label: "Perfis de Interesse" },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-100 hover:border-gray-300 transition-colors group"
            >
              <span>{link.label}</span>
              <ArrowRight className="h-3.5 w-3.5 text-gray-400 group-hover:text-brand-orange transition-colors" />
            </Link>
          ))}
        </div>

        {/* Back home */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-black text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors"
        >
          <Home className="h-4 w-4" />
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
