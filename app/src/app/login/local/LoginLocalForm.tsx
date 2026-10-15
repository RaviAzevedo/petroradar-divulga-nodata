"use client";

import { useState, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Eye, EyeOff, ShieldAlert } from "lucide-react";

/**
 * Formulário de login por senha (break-glass). É o antigo /login pré-SSO,
 * movido para cá — a página server (page.tsx) já garantiu AUTH_BREAKGLASS=1.
 */
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (result?.error) {
        setError("Email ou senha incorretos.");
      } else {
        // HOME ÚNICA (decisão de produto): sem callbackUrl explícito, mobile abre
        // /hoje e desktop abre / (Painel). Feito aqui no client pós-signIn —
        // é o ponto único do redirect de login (signIn usa redirect:false) e
        // matchMedia é a fonte de verdade do viewport (nada de UA-sniffing no
        // middleware). 767px casa com o breakpoint md do Tailwind, o mesmo do
        // layout mobile do AppShell. callbackUrl explícito (deep-link que caiu
        // no login) continua sendo respeitado.
        const destino = callbackUrl === "/"
          ? (window.matchMedia("(max-width: 767px)").matches ? "/hoje" : "/")
          : callbackUrl;
        router.push(destino);
      }
    } catch {
      setError("Não foi possível entrar. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 ml-0">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="Petro Radar"
              className="h-auto w-full max-w-[300px]"
            />
          </div>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs font-semibold text-gray-400 tracking-widest uppercase">
              Petro Radar
            </span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          <p className="text-xs text-gray-400">Monitoramento inteligente de licitações</p>
        </div>

        {/* Aviso break-glass */}
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong>Acesso de emergência.</strong> Este login local só está ativo
            porque o modo break-glass foi habilitado no servidor. O acesso normal
            é pela conta Microsoft em <a href="/login" className="underline">/login</a>.
          </span>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 sm:p-8">
          <h2 className="text-base font-semibold text-brand-black mb-6 text-center">Entrar com senha local</h2>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="text-sm font-medium text-gray-500 block mb-1.5">Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
                placeholder="seu@email.com"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="text-sm font-medium text-gray-500 block mb-1.5">Senha</label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 pr-11 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
                  placeholder="Sua senha"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-brand-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Entrando..." : "Entrar"}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-gray-500">
            Esqueceu a senha? Contate o administrador.
          </p>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Petro Radar v2.0
        </p>
      </div>
    </div>
  );
}

export function LoginLocalForm() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400">Carregando...</div>}>
      <LoginForm />
    </Suspense>
  );
}
