"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Botão padrão do design system Petro Radar.
 *
 * Decisões de auditoria (WCAG AA):
 *   - `primary` usa laranja Proponente com TEXTO PRETO (contraste 7,7:1).
 *     Laranja + texto branco (2,2:1) REPROVA e não deve voltar a existir.
 *   - Um único hover por variante (primary = amber-500, o que já predominava).
 *
 * Para CTAs que são navegação (<Link>/<a>), use `buttonVariants()` direto no
 * className do link — mantém o comportamento de navegação do Next intacto.
 */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 font-semibold rounded-lg " +
  "transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none";

const VARIANTES: Record<ButtonVariant, string> = {
  primary:   "bg-brand-orange text-black hover:bg-amber-500",
  secondary: "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50",
  danger:    "bg-red-600 text-white hover:bg-red-700",
  ghost:     "bg-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-700",
};

const TAMANHOS: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function buttonVariants(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  const { variant = "primary", size = "md", className } = opts;
  return cn(BASE, VARIANTES[variant], TAMANHOS[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Mostra spinner e desabilita o botão (mantém o label visível). */
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className, children, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={buttonVariants({ variant, size, className })}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});
