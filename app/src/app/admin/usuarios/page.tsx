"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Users, Plus, Pencil, X, Check, Loader2,
  Eye, AlertCircle, Search, Trash2, Lock, LockOpen,
  ShieldOff, UserPlus, Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLE_LABELS } from "@/lib/permissions";
import type { UserRole } from "@/lib/permissions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { ROLES_OPCOES, ROLE_COLORS, MicrosoftBadge } from "../roles-ui";

// ── Tipos ────────────────────────────────────────────────────────────────────

interface Usuario {
  id: string;
  nome: string | null;
  email: string;
  role: UserRole;
  ativo: boolean;
  pendente: boolean;
  vinculoMicrosoft: boolean;
  ultimoLogin: string | null;
  criadoEm: string | null;
}

interface ResultadoDiretorio {
  oid: string;
  nome: string | null;
  email: string | null;
  jaCadastrado: boolean;
}

// ── Componente principal ─────────────────────────────────────────────────────

export default function AdminUsuariosPage() {
  const { data: session } = useSession();

  const [usuarios, setUsuarios]     = useState<Usuario[]>([]);
  const [pendentes, setPendentes]   = useState(0);
  const [loading,  setLoading]      = useState(true);
  const [erro,     setErro]         = useState("");
  const [showNovo, setShowNovo]     = useState(false);
  const [editando, setEditando]     = useState<string | null>(null);
  const [salvando, setSalvando]     = useState(false);
  const [filtro,   setFiltro]       = useState("");

  // Form novo usuário (pré-cadastro SSO: sem senha — entra com a conta Microsoft)
  const [novoNome,  setNovoNome]   = useState("");
  const [novoEmail, setNovoEmail]  = useState("");
  const [novoOid,   setNovoOid]    = useState<string | null>(null);
  // Todo novo usuário nasce VISUALIZADOR (menor privilégio); só ADMIN eleva.
  const [novoRole,  setNovoRole]   = useState<UserRole>("VISUALIZADOR");
  const [erroForm,  setErroForm]   = useState("");

  // Busca no diretório Microsoft (Graph)
  const [buscaDir,      setBuscaDir]      = useState("");
  const [resultadosDir, setResultadosDir] = useState<ResultadoDiretorio[]>([]);
  const [buscandoDir,   setBuscandoDir]   = useState(false);
  const [avisoDir,      setAvisoDir]      = useState("");

  // Edição inline
  const [editRole,  setEditRole]   = useState<UserRole>("VISUALIZADOR");
  const [editNome,  setEditNome]   = useState("");

  const [confirmBloqueio, setConfirmBloqueio] = useState<Usuario | null>(null);
  const [confirmRevoke,   setConfirmRevoke]   = useState<Usuario | null>(null);
  const [confirmExcluir,  setConfirmExcluir]  = useState<Usuario | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro("");
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        const d = await res.json();
        setErro(d.error ?? "Erro ao carregar usuários");
        return;
      }
      const d = await res.json();
      const todos: Usuario[] = d.users ?? [];
      // Pendentes moram em /admin/solicitacoes — aqui só a contagem p/ o aviso.
      setUsuarios(todos.filter((u) => !u.pendente));
      setPendentes(todos.filter((u) => u.pendente).length);
    } catch {
      setErro("Erro de conexão");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  // ── Busca no diretório Microsoft (debounce 400ms) ──────────────────────────

  useEffect(() => {
    if (buscaDir.trim().length < 2) {
      setResultadosDir([]);
      setBuscandoDir(false);
      return;
    }
    setBuscandoDir(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/entra/usuarios?q=${encodeURIComponent(buscaDir.trim())}`);
        const d = await res.json();
        setResultadosDir(d.usuarios ?? []);
        setAvisoDir(d.error ?? "");
      } catch {
        setResultadosDir([]);
        setAvisoDir("Não foi possível buscar no diretório agora.");
      } finally {
        setBuscandoDir(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [buscaDir]);

  function escolherDoDiretorio(r: ResultadoDiretorio) {
    if (r.jaCadastrado || !r.email) return;
    setNovoNome(r.nome ?? "");
    setNovoEmail(r.email);
    setNovoOid(r.oid);
    setBuscaDir("");
    setResultadosDir([]);
  }

  function limparFormNovo() {
    setNovoNome(""); setNovoEmail(""); setNovoOid(null);
    setNovoRole("VISUALIZADOR"); setBuscaDir(""); setResultadosDir([]);
    setAvisoDir(""); setErroForm("");
  }

  // ── Criar usuário (pré-cadastro SSO) ───────────────────────────────────────

  async function handleCriar(e: React.FormEvent) {
    e.preventDefault();
    setErroForm("");
    setSalvando(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: novoNome, email: novoEmail, role: novoRole, entraOid: novoOid }),
      });
      const d = await res.json();
      if (!res.ok) { setErroForm(d.error ?? "Erro ao criar usuário"); return; }
      setShowNovo(false);
      limparFormNovo();
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  // ── Editar usuário ─────────────────────────────────────────────────────────

  function iniciarEdicao(u: Usuario) {
    setEditando(u.id);
    setEditRole(u.role);
    setEditNome(u.nome ?? "");
  }

  async function handleSalvar(id: string) {
    setSalvando(true);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: editNome, role: editRole }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao salvar alterações");
        return;
      }
      setEditando(null);
      await carregar();
    } catch {
      setErro("Erro de conexão ao salvar");
    } finally {
      setSalvando(false);
    }
  }

  // ── Bloquear/desbloquear acesso ────────────────────────────────────────────

  async function handleConfirmBloqueio() {
    if (!confirmBloqueio) return;
    const alvo = confirmBloqueio;
    setConfirmBloqueio(null);
    try {
      const res = await fetch(`/api/admin/users/${alvo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativo: !alvo.ativo }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao alterar acesso do usuário");
        return;
      }
      await carregar();
    } catch {
      setErro("Erro de conexão");
    }
  }

  // ── Revogar sessões (derruba tokens na hora, sem bloquear) ─────────────────

  async function handleConfirmRevoke() {
    if (!confirmRevoke) return;
    const alvo = confirmRevoke;
    setConfirmRevoke(null);
    try {
      const res = await fetch(`/api/admin/users/${alvo.id}/revogar-sessoes`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao revogar sessões");
      }
    } catch {
      setErro("Erro de conexão");
    }
  }

  // ── Excluir definitivamente ────────────────────────────────────────────────

  async function handleConfirmExcluir() {
    if (!confirmExcluir) return;
    const alvo = confirmExcluir;
    setConfirmExcluir(null);
    try {
      const res = await fetch(`/api/admin/users/${alvo.id}?forcar=1`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setErro(d.error ?? "Erro ao excluir usuário");
        return;
      }
      await carregar();
    } catch {
      setErro("Erro de conexão");
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const filtroNorm = filtro.trim().toLowerCase();
  const usuariosVisiveis = filtroNorm
    ? usuarios.filter((u) =>
        (u.nome ?? "").toLowerCase().includes(filtroNorm) ||
        u.email.toLowerCase().includes(filtroNorm))
    : usuarios;

  return (
    <div className="max-w-4xl">
      {/* Header da seção */}
      <div className="flex items-center justify-between mb-6 gap-4">
        <p className="text-sm text-gray-500">
          Quem pode acessar a plataforma e com qual papel. Novos usuários entram
          sempre como <strong>Visualizador</strong> — só administradores mudam papéis.
        </p>
        <Button onClick={() => { setShowNovo(true); limparFormNovo(); }} className="gap-2 flex-shrink-0">
          <Plus className="h-4 w-4" />
          Novo Usuário
        </Button>
      </div>

      {/* Aviso de solicitações pendentes */}
      {pendentes > 0 && (
        <Link
          href="/admin/solicitacoes"
          className="flex items-center gap-2 mb-6 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800 hover:bg-amber-100 transition-colors"
        >
          <UserPlus className="h-4 w-4 flex-shrink-0" />
          <span>
            <strong>{pendentes}</strong> {pendentes === 1 ? "solicitação de acesso aguarda" : "solicitações de acesso aguardam"} aprovação
          </span>
        </Link>
      )}

      {/* Roles legenda */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
        {ROLES_OPCOES.map((r) => (
          <div key={r.value} className={cn("flex items-start gap-2 px-3 py-2 rounded-lg border text-xs", ROLE_COLORS[r.value])}>
            <span className="font-semibold">{r.label}</span>
            <span className="text-[10px] opacity-70 leading-tight">{r.desc}</span>
          </div>
        ))}
      </div>

      {/* Form novo usuário */}
      {showNovo && (
        <div className="bg-white rounded-2xl border border-brand-orange/30 p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-brand-black flex items-center gap-2">
              <Plus className="h-4 w-4 text-brand-orange" /> Novo Usuário
            </h2>
            <button onClick={() => setShowNovo(false)} className="text-gray-400 hover:text-gray-600" aria-label="Fechar formulário">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Busca no diretório Microsoft */}
          <div className="relative mb-4">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Buscar no diretório Microsoft (Proponente)
            </label>
            <div className="relative">
              <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              {buscandoDir && <Loader2 className="h-4 w-4 text-gray-400 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
              <input
                value={buscaDir} onChange={(e) => setBuscaDir(e.target.value)}
                placeholder="Digite o nome ou e-mail da pessoa…"
                className="w-full pl-9 pr-9 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              />
            </div>
            {resultadosDir.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                {resultadosDir.map((r) => (
                  <button
                    key={r.oid}
                    type="button"
                    onClick={() => escolherDoDiretorio(r)}
                    disabled={r.jaCadastrado || !r.email}
                    className={cn(
                      "w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors",
                      r.jaCadastrado || !r.email ? "opacity-50 cursor-not-allowed bg-gray-50" : "hover:bg-orange-50/60",
                    )}
                  >
                    <div className="w-7 h-7 rounded-full bg-brand-black text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {(r.nome ?? r.email ?? "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{r.nome ?? "—"}</p>
                      <p className="text-xs text-gray-500 truncate">{r.email ?? "sem e-mail"}</p>
                    </div>
                    {r.jaCadastrado && (
                      <span className="text-[10px] font-semibold text-gray-400 flex-shrink-0">já cadastrado</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {avisoDir && (
              <p className="mt-1.5 text-[11px] text-amber-700 flex items-center gap-1">
                <Info className="h-3 w-3 flex-shrink-0" /> {avisoDir}
              </p>
            )}
          </div>

          <form onSubmit={handleCriar} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Nome</label>
                <input
                  value={novoNome} onChange={e => setNovoNome(e.target.value)}
                  placeholder="Nome completo"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email corporativo *</label>
                <input
                  type="email" required value={novoEmail}
                  onChange={e => { setNovoEmail(e.target.value); setNovoOid(null); }}
                  placeholder="usuario@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Role *</label>
                <select
                  required value={novoRole} onChange={e => setNovoRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 bg-white"
                >
                  {ROLES_OPCOES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-gray-500 flex items-center gap-1.5">
              {novoOid ? (
                <>
                  <MicrosoftBadge /> Conta do diretório selecionada — entra direto no primeiro login.
                </>
              ) : (
                "Sem senha: a pessoa entra com a conta Microsoft Proponente deste e-mail."
              )}
            </p>
            {erroForm && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {erroForm}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowNovo(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
                Cancelar
              </button>
              <button type="submit" disabled={salvando}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Criar Usuário
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista de usuários */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-semibold text-gray-700">
              Usuários {!loading && `(${usuariosVisiveis.length}${filtroNorm ? ` de ${usuarios.length}` : ""})`}
            </span>
          </div>
          <div className="relative ml-auto">
            <Search className="h-3.5 w-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={filtro} onChange={(e) => setFiltro(e.target.value)}
              placeholder="Filtrar por nome ou e-mail…"
              className="w-56 pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
          </div>
        ) : erro ? (
          <div className="flex items-center justify-center py-16 text-sm text-red-500 gap-2 flex-wrap">
            <AlertCircle className="h-4 w-4" /> {erro}
            <button onClick={() => { setErro(""); carregar(); }} className="ml-4 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 transition-colors">
              Tentar novamente
            </button>
          </div>
        ) : usuariosVisiveis.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-gray-400">
            {filtroNorm ? "Nenhum usuário corresponde ao filtro" : "Nenhum usuário cadastrado"}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {usuariosVisiveis.map((u) => (
              <div key={u.id} className={cn("px-6 py-4", !u.ativo && "opacity-50 bg-gray-50/50")}>
                {editando === u.id ? (
                  /* ── Modo edição ── */
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-medium text-gray-500 mb-1">Nome</label>
                        <input
                          value={editNome} onChange={e => setEditNome(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-gray-500 mb-1">Role</label>
                        <select
                          value={editRole} onChange={e => setEditRole(e.target.value as UserRole)}
                          className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 bg-white"
                        >
                          {ROLES_OPCOES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditando(null)}
                        className="px-3 py-1.5 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
                        Cancelar
                      </button>
                      <button onClick={() => handleSalvar(u.id)} disabled={salvando}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                        {salvando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Salvar
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── Modo visualização ── */
                  <div className="flex items-center gap-4">
                    {/* Avatar */}
                    <div className="w-9 h-9 rounded-full bg-brand-black text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                      {(u.nome ?? u.email).charAt(0).toUpperCase()}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">{u.nome ?? "—"}</span>
                        <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border", ROLE_COLORS[u.role as UserRole] ?? "bg-gray-100 text-gray-600 border-gray-200")}>
                          {ROLE_LABELS[u.role as UserRole] ?? u.role}
                        </span>
                        {u.vinculoMicrosoft && <MicrosoftBadge />}
                        {!u.ativo && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-600 border border-red-200 flex items-center gap-1">
                            <Lock className="h-2.5 w-2.5" /> Bloqueado
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 truncate">{u.email}</p>
                    </div>

                    {/* Último login / criação */}
                    <div className="text-right hidden sm:block flex-shrink-0">
                      <p className="text-[10px] text-gray-400">
                        {u.ultimoLogin
                          ? `Último login ${new Date(u.ultimoLogin).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
                          : "Nunca entrou"}
                      </p>
                      <p className="text-[10px] text-gray-300">
                        {u.criadoEm ? `Desde ${new Date(u.criadoEm).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : ""}
                      </p>
                    </div>

                    {/* Ações */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {u.id === session?.user?.id ? (
                        <span className="text-[10px] text-gray-400 flex items-center gap-1 px-2">
                          <Eye className="h-3 w-3" /> Você
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => setConfirmRevoke(u)}
                            title="Revogar sessões (derruba o acesso atual sem bloquear a conta)"
                            aria-label="Revogar sessões"
                            className="p-1.5 rounded-lg text-gray-400 hover:text-amber-700 hover:bg-amber-50 transition-colors"
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setConfirmBloqueio(u)}
                            title={u.ativo ? "Bloquear acesso" : "Desbloquear acesso"}
                            aria-label={u.ativo ? "Bloquear acesso" : "Desbloquear acesso"}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                          >
                            {u.ativo ? <LockOpen className="h-4 w-4 text-green-600" /> : <Lock className="h-4 w-4 text-red-500" />}
                          </button>
                          <button
                            onClick={() => iniciarEdicao(u)}
                            title="Editar nome e role"
                            aria-label="Editar usuário"
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setConfirmExcluir(u)}
                            title="Excluir definitivamente"
                            aria-label="Excluir usuário"
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!confirmBloqueio}
        title={confirmBloqueio?.ativo ? "Bloquear acesso" : "Desbloquear acesso"}
        message={
          confirmBloqueio?.ativo
            ? `Bloquear o acesso de ${confirmBloqueio?.nome || confirmBloqueio?.email || ""}? As sessões ativas são derrubadas na hora e a pessoa não consegue mais entrar.`
            : `Desbloquear ${confirmBloqueio?.nome || confirmBloqueio?.email || ""}? A pessoa volta a conseguir entrar com a conta Microsoft.`
        }
        confirmLabel={confirmBloqueio?.ativo ? "Bloquear" : "Desbloquear"}
        variant={confirmBloqueio?.ativo ? "danger" : "default"}
        onConfirm={handleConfirmBloqueio}
        onCancel={() => setConfirmBloqueio(null)}
      />
      <ConfirmDialog
        open={!!confirmRevoke}
        title="Revogar sessões"
        message={`Derrubar todas as sessões ativas de ${confirmRevoke?.nome || confirmRevoke?.email || ""}? A conta continua ativa — a pessoa só precisa entrar de novo.`}
        confirmLabel="Revogar sessões"
        variant="danger"
        onConfirm={handleConfirmRevoke}
        onCancel={() => setConfirmRevoke(null)}
      />
      <ConfirmDialog
        open={!!confirmExcluir}
        title="Excluir usuário"
        message={`Excluir DEFINITIVAMENTE ${confirmExcluir?.nome || confirmExcluir?.email || ""}? Esta ação não tem volta. Se o usuário tiver histórico no sistema, a exclusão será recusada — nesse caso, bloqueie o acesso.`}
        confirmLabel="Excluir"
        variant="danger"
        onConfirm={handleConfirmExcluir}
        onCancel={() => setConfirmExcluir(null)}
      />
    </div>
  );
}
