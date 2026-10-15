"use client";

import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCAVEIS =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UseModalA11yOptions {
  /** O modal está aberto/montado? Todos os efeitos só rodam quando true. */
  active: boolean;
  /** Chamado no Escape. */
  onClose: () => void;
  /**
   * Elemento que recebe o foco inicial (ex.: textarea do PromptDialog).
   * Sem ele, foca o primeiro elemento interativo dentro do dialog.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Base de acessibilidade para modais (WCAG 2.4.3 / ARIA dialog pattern):
 *   - foco inicial no primeiro elemento interativo (ou no initialFocusRef);
 *   - focus trap: Tab cicla dentro do dialog, Shift+Tab no sentido inverso;
 *   - retorno do foco ao elemento que abriu o modal, ao fechar;
 *   - Escape fecha; scroll do body travado enquanto aberto.
 *
 * Uso: espalhe `dialogRef` e `handleTrapTab` no container do dialog —
 * junto de role="dialog", aria-modal="true" e aria-labelledby no título.
 */
export function useModalA11y({ active, onClose, initialFocusRef }: UseModalA11yOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Foco inicial + retorno do foco + scroll lock (roda 1x por abertura)
  useEffect(() => {
    if (!active) return;

    const abriuCom = document.activeElement as HTMLElement | null;
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Após o mount do conteúdo do dialog
    const t = setTimeout(() => {
      const alvo =
        initialFocusRef?.current ??
        dialogRef.current?.querySelector<HTMLElement>(FOCAVEIS) ??
        dialogRef.current;
      alvo?.focus?.();
    }, 0);

    return () => {
      clearTimeout(t);
      document.body.style.overflow = overflowAnterior;
      abriuCom?.focus?.();
    };
    // initialFocusRef é um ref estável; só reagimos à abertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Escape fecha
  useEffect(() => {
    if (!active) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, onClose]);

  // Focus trap — anexar como onKeyDown do container do dialog
  function handleTrapTab(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const ativaveis = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCAVEIS)
    );
    if (ativaveis.length === 0) return;
    const primeiro = ativaveis[0];
    const ultimo = ativaveis[ativaveis.length - 1];
    const atual = document.activeElement;

    if (e.shiftKey && (atual === primeiro || atual === dialogRef.current)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && atual === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  }

  return { dialogRef, handleTrapTab };
}
