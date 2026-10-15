"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ScrollText, Loader2, AlertCircle, ChevronLeft, ChevronRight,
  LogIn, LogOut, ShieldOff, UserPlus, UserCheck, UserX, CircleDot,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Viewer do audit log (/api/admin/audit-log, modo lista geral — só ADMIN).
 * Foco operacional do Admin Center: logins (OK/falha, com motivo), logouts,
 * criação/aprovação/recusa de usuários e revogações de sessão — mas lista
 * TODAS as ações auditadas (uploads, mudanças de fase etc.).
 */

interface Evento {
  id: number;
  acao: string;
  entidade: string | null;
  entidadeId: string | null;
  detalhes: Record<string, unknown> | null;
  criadoEm: string | null;
  userId: string | null;
  userNome: string | null;
  userEmail: string | null;
}

const PAGE_SIZE = 50;

/** Ações com filtro dedicado (as demais aparecem em "Todas"). */
const FILTROS_ACAO: { value: string; label: string }[] = [
  { value: "",                 label: "Todas as ações" },
  { value: "LOGIN_OK",         label: "Login OK" },
  { value: "LOGIN_FALHA",      label: "Login falhou" },
  { value: "LOGOUT",           label: "Logout" },
  { value: "USER_CRIADO",      label: "Usuário criado" },
  { value: "USER_APROVADO",    label: "Acesso aprovado" },
  { value: "USER_RECUSADO",    label: "Acesso recusado" },
  { value: "USER_EXCLUIDO",    label: "Usuário excluído" },
  { value: "SESSOES_REVOGADAS", label: "Sessões revogadas" },
];

const ACAO_ESTILO: Record<string, { icon: React.ElementType; cls: string }> = {
  LOGIN_OK:          { icon: LogIn,     cls: "bg-green-50 text-green-700 border-green-200" },
  LOGIN_FALHA:       { icon: LogIn,     cls: "bg-red-50 text-red-700 border-red-200" },
  LOGOUT:            { icon: LogOut,    cls: "bg-gray-50 text-gray-600 border-gray-200" },
  USER_CRIADO:       { icon: UserPlus,  cls: "bg-blue-50 text-blue-700 border-blue-200" },
  USER_APROVADO:     { icon: UserCheck, cls: "bg-green-50 text-green-700 border-green-200" },
  USER_RECUSADO:     { icon: UserX,     cls: "bg-red-50 text-red-700 border-red-200" },
  USER_EXCLUIDO:     { icon: UserX,     cls: "bg-red-50 text-red-700 border-red-200" },
  SESSOES_REVOGADAS: { icon: ShieldOff, cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

/** Resumo legível dos detalhes (e-mail, motivo, role…) sem despejar o JSON. */
function resumirDetalhes(e: Evento): string {
  const d = e.detalhes ?? {};
  const partes: string[] = [];
  if (typeof d.email === "string") partes.push(d.email);
  if (typeof d.motivo === "string") partes.push(`motivo: ${d.motivo}`);
  if (typeof d.role === "string") partes.push(`role: ${d.role}`);
  if (typeof d.provider === "string") partes.push("via Microsoft");
  else if (typeof d.ip === "string" && d.ip !== "oauth" && d.ip !== "unknown") partes.push(`ip: ${d.ip}`);
  return partes.join(" · ");
}

export default function AdminAuditoriaPage() {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [erro, setErro]       = useState("");
  const [acao, setAcao]       = useState("");
  const [pagina, setPagina]   = useState(0);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro("");
    try {
      const params = new URLSearchParams({
        limit:  String(PAGE_SIZE),
        offset: String(pagina * PAGE_SIZE),
      });
      if (acao) params.set("acao", acao);
      const res = await fetch(`/api/admin/audit-log?${params}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao carregar auditoria");
        return;
      }
      const d = await res.json();
      setEventos(d.rows ?? []);
      setTotal(d.total ?? 0);
    } catch {
      setErro("Erro de conexão");
    } finally {
      setLoading(false);
    }
  }, [acao, pagina]);

  useEffect(() => { carregar(); }, [carregar]);

  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <p className="text-sm text-gray-500">
          Trilha de auditoria do sistema — logins, aprovações de acesso e demais
          ações registradas.
        </p>
        <select
          value={acao}
          onChange={(e) => { setAcao(e.target.value); setPagina(0); }}
          aria-label="Filtrar por ação"
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 bg-white"
        >
          {FILTROS_ACAO.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-700">
            Eventos {!loading && `(${total})`}
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
        ) : eventos.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-gray-400">
            Nenhum evento encontrado
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {eventos.map((e) => {
              const estilo = ACAO_ESTILO[e.acao] ?? { icon: CircleDot, cls: "bg-gray-50 text-gray-600 border-gray-200" };
              const Icon = estilo.icon;
              const resumo = resumirDetalhes(e);
              return (
                <div key={e.id} className="px-6 py-3 flex items-center gap-3">
                  <span className={cn("flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold border flex-shrink-0", estilo.cls)}>
                    <Icon className="h-3 w-3" />
                    {e.acao}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-700 truncate">
                      {e.userNome || e.userEmail || "Sistema"}
                      {e.entidade && e.entidade !== "auth" && (
                        <span className="text-gray-400"> · {e.entidade}</span>
                      )}
                    </p>
                    {resumo && <p className="text-[11px] text-gray-400 truncate">{resumo}</p>}
                  </div>
                  <span className="text-[10px] text-gray-400 flex-shrink-0">
                    {e.criadoEm
                      ? new Date(e.criadoEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
                      : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Paginação */}
        {!loading && !erro && total > PAGE_SIZE && (
          <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              Página {pagina + 1} de {totalPaginas}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPagina((p) => Math.max(0, p - 1))}
                disabled={pagina === 0}
                aria-label="Página anterior"
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPagina((p) => Math.min(totalPaginas - 1, p + 1))}
                disabled={pagina >= totalPaginas - 1}
                aria-label="Próxima página"
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
