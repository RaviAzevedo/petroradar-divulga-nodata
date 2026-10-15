"use client";

import { useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { useModalA11y } from "./useModalA11y";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const tituloId = useId();
  // Foco inicial no botão de confirmar (ação primária do diálogo).
  const confirmarRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: open,
    onClose: onCancel,
    initialFocusRef: confirmarRef,
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-sm mx-4 p-6"
      >
        <div className="flex items-start gap-3 mb-4">
          <div className={`p-2 rounded-lg ${variant === "danger" ? "bg-red-50" : "bg-amber-50"}`}>
            <AlertTriangle className={`h-5 w-5 ${variant === "danger" ? "text-red-500" : "text-amber-500"}`} />
          </div>
          <div>
            <h3 id={tituloId} className="text-sm font-semibold text-gray-900">{title}</h3>
            <p className="text-sm text-gray-500 mt-1">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} className="font-normal">
            {cancelLabel}
          </Button>
          <Button
            ref={confirmarRef}
            variant="danger"
            onClick={onConfirm}
            className={variant === "danger" ? undefined : "bg-brand-black hover:bg-gray-800"}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
