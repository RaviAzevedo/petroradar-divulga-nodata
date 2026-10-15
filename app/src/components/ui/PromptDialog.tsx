"use client";

import { useId, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button } from "./Button";
import { useModalA11y } from "./useModalA11y";

interface PromptDialogProps {
  open: boolean;
  title: string;
  /** Texto de apoio exibido sob o título (ex.: identificação do registro). */
  message?: string;
  /** Label programático do textarea (obrigatório para acessibilidade). */
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * Variação do ConfirmDialog com textarea — substitui window.prompt().
 * Mesmo design (card branco, botões brand-black, acento laranja Proponente):
 * a11y via useModalA11y (focus trap, retorno de foco, Escape) com foco
 * inicial no textarea. Confirmar fica desabilitado enquanto o texto estiver vazio.
 */
export function PromptDialog({
  open,
  title,
  message,
  label,
  placeholder,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tituloId = useId();
  const labelId = useId();

  // O reset do texto acontece nos handlers de fechamento (cancelar/confirmar),
  // não em effect — assim cada abertura começa vazia sem setState em render.
  const cancelar = () => { setValue(""); onCancel(); };
  const confirmar = () => {
    const v = value.trim();
    if (!v) return;
    setValue("");
    onConfirm(v);
  };

  const { dialogRef, handleTrapTab } = useModalA11y({
    active: open,
    onClose: cancelar,
    initialFocusRef: textareaRef,
  });

  if (!open) return null;

  const valorLimpo = value.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={cancelar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-sm mx-4 p-6"
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-amber-50">
            <MessageSquareText className="h-5 w-5 text-brand-orange" />
          </div>
          <div>
            <h3 id={tituloId} className="text-sm font-semibold text-gray-900">{title}</h3>
            {message && <p className="text-sm text-gray-500 mt-1">{message}</p>}
          </div>
        </div>

        <label id={labelId} htmlFor={`${labelId}-textarea`} className="block text-xs font-medium text-gray-500 mb-1.5">
          {label}
        </label>
        <textarea
          id={`${labelId}-textarea`}
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
        />

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={cancelar} className="font-normal">
            {cancelLabel}
          </Button>
          <Button
            variant="danger"
            onClick={confirmar}
            disabled={!valorLimpo}
            className="bg-brand-black hover:bg-gray-800"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
