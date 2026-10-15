"use client";

import { useState, useEffect, useCallback } from "react";
import {
  UserPlus, Loader2, AlertCircle, Check, X, Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/permissions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ROLES_OPCOES, ROLE_COLORS, MicrosoftBadge } from "../roles-ui";

/**
 * Fila de aprovação do SSO: contas do tenant Proponente que autenticaram na
 * Microsoft mas ainda não foram liberadas (users.pendente=true — criadas pelo
 * callback signIn de lib/auth.ts). Aprovar escolhe o role e libera o acesso;
 * recusar remove a solicitação (a pessoa pode pedir de novo).
 */

interface Solicitacao {
  id: string;
  nome: string | null;
  email: string;
  criadoEm: string | null;
  vinculoMicrosoft: boolean;
}

export default function AdminSolicitacoesPage() {
  const [solicitacoes, setSolicitacoes] = useState<Solicitacao[]>([]);
  const [loading, setLoading]           = useState(true);
  const [erro, setErro]                 = useState("");
  const [processando, setProcessando]   = useState<string | null>(null);
  // Role escolhido por solicitação (default VISUALIZADOR — menor privilégio)
  const [roles, setRoles]               = useState<Record<string, UserRole>>({});
  const [confirmRecusa, setConfirmRecusa] = useState<Solicitacao | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro("");
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        const d = await res.json();
        setErro(d.error ?? "Erro ao carregar solicitações");
        return;
      }
      const d = await res.json();
      setSolicitacoes((d.users ?? []).filter((u: { pendente?: boolean }) => u.pendente));
    } catch {
      setErro("Erro de conexão");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  async function aprovar(s: Solicitacao) {
    setProcessando(s.id);
    try {
      const res = await fetch(`/api/admin/users/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aprovar: true, role: roles[s.id] ?? "VISUALIZADOR" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao aprovar solicitação");
        return;
      }
      await carregar();
    } catch {
      setErro("Erro de conexão");
    } finally {
      setProcessando(null);
    }
  }

  async function handleConfirmRecusa() {
    if (!confirmRecusa) return;
    const alvo = confirmRecusa;
    setConfirmRecusa(null);
    setProcessando(alvo.id);
    try {
      const res = await fetch(`/api/admin/users/${alvo.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao recusar solicitação");
        return;
      }
      await carregar();
    } catch {
      setErro("Erro de conexão");
    } finally {
      setProcessando(null);
    }
  }

  return (
    <div className="max-w-4xl">
      <p className="text-sm text-gray-500 mb-6">
        Contas Proponente que entraram com a Microsoft e aguardam liberação.
        Escolha o papel e aprove — a pessoa entra direto no próximo login.
      </p>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-700">
            Solicitações pendentes {!loading && `(${solicitacoes.length})`}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
          </div>
        ) : erro ? (
          <div className="flex items-center justify-center py-16 text-sm text-red-500 gap-2 flex-wrap">
            <AlertCircle className="h-4 w-4" /> {erro}
            <button onClick={carregar} className="ml-4 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 transition-colors">
              Tentar novamente
            </button>
          </div>
        ) : solicitacoes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Inbox className="h-10 w-10 mb-2 text-gray-200" />
            <p className="text-sm">Nenhuma solicitação pendente</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {solicitacoes.map((s) => (
              <div key={s.id} className="px-6 py-4 flex flex-wrap items-center gap-4">
                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                  {(s.nome ?? s.email).charAt(0).toUpperCase()}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-[180px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900">{s.nome ?? "—"}</span>
                    {s.vinculoMicrosoft && <MicrosoftBadge />}
                  </div>
                  <p className="text-xs text-gray-500 truncate">{s.email}</p>
                  <p className="text-[10px] text-gray-400">
                    Solicitado em {s.criadoEm ? new Date(s.criadoEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}
                  </p>
                </div>

                {/* Role + ações */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <select
                    value={roles[s.id] ?? "VISUALIZADOR"}
                    onChange={(e) => setRoles((r) => ({ ...r, [s.id]: e.target.value as UserRole }))}
                    aria-label={`Role para ${s.email}`}
                    className={cn(
                      "px-2.5 py-1.5 text-xs font-medium border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 bg-white",
                      ROLE_COLORS[roles[s.id] ?? "VISUALIZADOR"],
                    )}
                  >
                    {ROLES_OPCOES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => aprovar(s)}
                    disabled={processando === s.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
                  >
                    {processando === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Aprovar
                  </button>
                  <button
                    onClick={() => setConfirmRecusa(s)}
                    disabled={processando === s.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
                  >
                    <X className="h-3 w-3" />
                    Recusar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmRecusa}
        title="Recusar solicitação"
        message={`Recusar o acesso de ${confirmRecusa?.nome || confirmRecusa?.email || ""}? A solicitação é removida — a pessoa pode pedir de novo tentando entrar.`}
        confirmLabel="Recusar"
        variant="danger"
        onConfirm={handleConfirmRecusa}
        onCancel={() => setConfirmRecusa(null)}
      />
    </div>
  );
}
