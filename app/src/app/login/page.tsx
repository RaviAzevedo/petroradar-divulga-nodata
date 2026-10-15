"use client";

import { useState, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Login SSO-only: a única forma de entrar é a conta Microsoft corporativa
 * (Entra ID, tenant Proponente). O formulário
 * de senha vive em /login/local (break-glass, 404 sem AUTH_BREAKGLASS=1).
 *
 * Os códigos em ?error= vêm do callback signIn (pendente/desativado/dominio/
 * conflito) ou do próprio NextAuth (AccessDenied, Configuration, …).
 */

const MENSAGENS_ERRO: Record<string, string> = {
  pendente:
    "Seu acesso foi solicitado e aguarda aprovação do administrador. " +
    "Você será avisado quando for liberado.",
  desativado: "Seu acesso foi desativado. Fale com o administrador.",
  dominio:    "Use sua conta corporativa Proponente (@example.com).",
  conflito:   "Conflito de identidade na sua conta. Fale com o administrador.",
  AccessDenied:  "Acesso negado. Fale com o administrador.",
  Configuration: "Login indisponível (erro de configuração). Avise o administrador.",
};

/** Logomarca da Microsoft (4 quadrados) — inline para funcionar offline. */
function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="0"  y="0"  width="10" height="10" fill="#F25022" />
      <rect x="11" y="0"  width="10" height="10" fill="#7FBA00" />
      <rect x="0"  y="11" width="10" height="10" fill="#00A4EF" />
      <rect x="11" y="11" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

function LoginSso() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";
  const errorCode = searchParams.get("error");
  const [loading, setLoading] = useState(false);

  const erro = errorCode
    ? MENSAGENS_ERRO[errorCode] ?? "Não foi possível entrar. Tente novamente."
    : "";
  // "Aguardando aprovação" é informativo, não falha — banner âmbar, não vermelho.
  const isPendente = errorCode === "pendente";

  function handleEntrar() {
    setLoading(true);
    // HOME ÚNICA (decisão de produto): sem callbackUrl explícito, mobile abre
    // /hoje e desktop abre / (Painel). No OAuth o redirect é obrigatório
    // (não há redirect:false), então o destino é decidido AQUI, antes do
    // round-trip à Microsoft — matchMedia é a fonte de verdade do viewport
    // (767px = breakpoint md do Tailwind, o mesmo do AppShell). callbackUrl
    // explícito (deep-link que caiu no login) continua sendo respeitado.
    const destino = callbackUrl === "/"
      ? (window.matchMedia("(max-width: 767px)").matches ? "/hoje" : "/")
      : callbackUrl;
    signIn("microsoft-entra-id", { callbackUrl: destino });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 ml-0">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          {/* Marca completa com slogan */}
          <div className="flex justify-center mb-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="Petro Radar"
              className="h-auto w-full max-w-[300px]"
            />
          </div>
          {/* Divisor com nome do produto */}
          <div className="flex items-center gap-3 mb-1">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs font-semibold text-gray-400 tracking-widest uppercase">
              Petro Radar
            </span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          <p className="text-xs text-gray-400">Monitoramento inteligente de licitações</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 sm:p-8">
          <h2 className="text-base font-semibold text-brand-black mb-6 text-center">
            Entrar na plataforma
          </h2>

          {erro && (
            <div
              className={
                isPendente
                  ? "mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 text-center"
                  : "mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 text-center"
              }
            >
              {erro}
            </div>
          )}

          <button
            type="button"
            onClick={handleEntrar}
            disabled={loading}
            className="w-full py-2.5 bg-brand-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors flex items-center justify-center gap-2.5"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MicrosoftLogo />}
            {loading ? "Redirecionando..." : "Entrar com a conta Microsoft"}
          </button>

          <p className="mt-4 text-center text-xs text-gray-500">
            Use sua conta corporativa Proponente (Microsoft 365).
          </p>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Petro Radar v2.0
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400">Carregando...</div>}>
      <LoginSso />
    </Suspense>
  );
}
