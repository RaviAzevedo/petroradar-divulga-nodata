"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, History, User, AlertCircle } from "lucide-react";

interface AuditEntry {
  id:        number;
  acao:      string;
  detalhes:  Record<string, unknown> | null;
  criadoEm:  string | null;
  userNome:  string | null;
  userEmail: string | null;
}

interface Props {
  entidade: string;
  entidadeId: string;
  /** Limita altura da timeline (default: sem limite) */
  maxHeight?: string;
}

const ACAO_LABEL: Record<string, string> = {
  CRIAR_FAMILIA:                  "Família criada",
  EDITAR_FAMILIA:                 "Família editada",
  UPLOAD_ANEXO_FAMILIA:           "Anexo adicionado",
  REMOVER_ANEXO_FAMILIA:          "Anexo removido",
  UPLOAD_DOCUMENTO_HABILITACAO:   "Documento enviado",
  EDITAR_DOCUMENTO_HABILITACAO:   "Documento editado",
  EXCLUIR_DOCUMENTO_HABILITACAO:  "Documento excluído",
  BULK_DELETE_DOCUMENTOS_HABILITACAO: "Exclusão em massa",
  VINCULAR_DOC_FAMILIA:           "Documento vinculado a família",
  DESVINCULAR_DOC_FAMILIA:        "Vínculo removido",
  ADICIONAR_PROJETO_DOC:          "Projeto adicionado",
  REMOVER_PROJETO_DOC:            "Projeto removido",
  CRIAR_ENVELOPE:                 "Envelope criado",
  EDITAR_ENVELOPE:                "Envelope atualizado",
  ATRIBUIR_DOC_ENVELOPE:          "Documento atribuído ao envelope",
  DESATRIBUIR_DOC_ENVELOPE:       "Documento desatribuído",
  CRIAR_CONTRATO:                 "Contrato cadastrado",
  EDITAR_CONTRATO:                "Contrato editado",
  REGISTRAR_IQF:                  "IQF registrado",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `há ${hr}h`;
  const dia = Math.floor(hr / 24);
  if (dia < 30) return `há ${dia}d`;
  return d.toLocaleDateString("pt-BR");
}

export function HistoricoAuditoria({ entidade, entidadeId, maxHeight }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const r = await fetch(`/api/admin/audit-log?entidade=${entidade}&entidadeId=${entidadeId}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      setEntries(j.data ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar histórico");
    } finally {
      setLoading(false);
    }
  }, [entidade, entidadeId]);
  useEffect(() => { carregar(); }, [carregar]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando histórico...
      </div>
    );
  }

  if (erro) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <div className="flex items-center gap-1.5 text-sm text-red-600">
          <AlertCircle className="h-4 w-4" /> Não foi possível carregar o histórico.
        </div>
        <button
          onClick={carregar}
          className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">Sem histórico ainda.</p>;
  }

  return (
    <div className="relative" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-200" aria-hidden="true" />
      <ul className="space-y-3">
        {entries.map((e) => (
          <li key={e.id} className="relative pl-6">
            <span className="absolute left-0 top-1.5 w-3.5 h-3.5 rounded-full bg-brand-orange ring-4 ring-white" />
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-semibold text-gray-700">
                {ACAO_LABEL[e.acao] ?? e.acao}
              </span>
              <span className="text-[11px] text-gray-400">{formatRelative(e.criadoEm)}</span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
              <User className="h-3 w-3" />
              {e.userNome ?? e.userEmail ?? "Sistema"}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
