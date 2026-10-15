"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import {
  Mail, Filter, Plus, X, Check, Loader2, AlertCircle, Pencil,
  Trash2, Send, Eye, ToggleLeft, ToggleRight, Info, BellRing, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import {
  FORMATO_LABELS, FREQUENCIA_LABELS, FREQUENCIA_DESC, RELEVANCIA_OPCOES,
  resumirCriterios, parseLista,
} from "../emails-ui";
import {
  CATALOGO_EMAIL, GRUPOS_EMAIL, papelElegivel,
  type TipoEmail, type GrupoEmail,
} from "@/lib/email/tipos";
import type { UserRole } from "@/lib/permissions";

/**
 * Painel de E-mails (digest 0026): FILTROS DE E-MAIL (entidade própria,
 * independente dos perfis do sistema) + ASSINATURAS (quem recebe qual filtro,
 * formato e recorrência). O Briefing/Checklist são gerados só na plataforma —
 * o e-mail lista e linka.
 */

// ── Tipos ────────────────────────────────────────────────────────────────────

interface Criterios {
  keywords_incluir?: string[];
  keywords_excluir?: string[];
  naturezas?: string[];
  tipos_servico?: string[];
  segmentos?: string[];
  estados?: string[];
  min_relevancia?: string;
}

interface FiltroEmail {
  id: string;
  nome: string;
  descricao: string | null;
  criterios: Criterios;
  ativo: boolean;
  assinantes: number;
}

interface Opcoes { naturezas: string[]; tipos_servico: string[]; segmentos: string[] }

interface Assinatura {
  id: string;
  formato: string;
  frequencia: string;
  ativo: boolean;
  ultimoEnvioEm: string | null;
  userId: string;
  userNome: string | null;
  userEmail: string;
  userAtivo: boolean;
  filtroId: string;
  filtroNome: string | null;
  perfilNome: string | null;
  perfilId:   string | null;
  relevanciaMinima: string;
  /** Rotulo exibido: perfil (padrao) ou filtro (legado). */
  filtroAtivo: boolean | null;
  perfilAtivo: boolean | null;
}

interface UsuarioOpt { id: string; nome: string | null; email: string; ativo: boolean; pendente: boolean }

interface UsuarioPref { id: string; nome: string | null; email: string; role: UserRole; ativo: boolean }
interface Desligado  { userId: string; tipo: TipoEmail }

interface PreviewResult { total: number; janelaDias: number; exemplos: { numero: string; objetoResumido: string; relevancia: string | null }[] }

// ── Form de filtro (criar/editar) ────────────────────────────────────────────

interface FormFiltroState {
  nome: string; descricao: string; kwIncluir: string; kwExcluir: string;
  naturezas: string[]; tipos: string[]; segmentos: string[]; estados: string; minRelevancia: string;
}

const FORM_FILTRO_VAZIO: FormFiltroState = {
  nome: "", descricao: "", kwIncluir: "", kwExcluir: "",
  naturezas: [], tipos: [], segmentos: [], estados: "", minRelevancia: "TODAS",
};

function criteriosDoForm(f: FormFiltroState): Criterios {
  return {
    keywords_incluir: parseLista(f.kwIncluir),
    keywords_excluir: parseLista(f.kwExcluir),
    naturezas:        f.naturezas,
    tipos_servico:    f.tipos,
    segmentos:        f.segmentos,
    estados:          parseLista(f.estados).map((uf) => uf.toUpperCase()),
    min_relevancia:   f.minRelevancia as Criterios["min_relevancia"],
  };
}

function formDoFiltro(fl: FiltroEmail): FormFiltroState {
  const c = fl.criterios ?? {};
  return {
    nome: fl.nome, descricao: fl.descricao ?? "",
    kwIncluir: (c.keywords_incluir ?? []).join(", "),
    kwExcluir: (c.keywords_excluir ?? []).join(", "),
    naturezas: c.naturezas ?? [], tipos: c.tipos_servico ?? [], segmentos: c.segmentos ?? [],
    estados: (c.estados ?? []).join(", "),
    minRelevancia: c.min_relevancia ?? "TODAS",
  };
}

// ── Página ───────────────────────────────────────────────────────────────────

export default function AdminEmailsPage() {
  const [filtros, setFiltros]         = useState<FiltroEmail[]>([]);
  // Perfis de Interesse = a origem PADRAO das assinaturas.
  // Antes a tela mantinha uma lista de filtros PROPRIA, duplicando o que os
  // perfis ja definem — duas listas para manter e dois lugares para divergir.
  const [perfis, setPerfis]           = useState<Array<{ id: string; nome: string; ativo: boolean }>>([]);
  const [salvandoAss, setSalvandoAss] = useState<string | null>(null);
  // Filtros viraram LEGADO: a origem das assinaturas passou a ser o
  // Perfil de Interesse. A secao some do caminho quando nenhum filtro tem
  // assinante — nao apago nada, so paro de disputar a atencao no topo da tela.
  const [opcoes, setOpcoes]           = useState<Opcoes>({ naturezas: [], tipos_servico: [], segmentos: [] });
  const [assinaturas, setAssinaturas] = useState<Assinatura[]>([]);
  const [usuarios, setUsuarios]       = useState<UsuarioOpt[]>([]);
  const [loading, setLoading]         = useState(true);
  const [erro, setErro]               = useState("");
  const [aviso, setAviso]             = useState("");

  // Filtros: form/edição/preview
  const [showFormFiltro, setShowFormFiltro] = useState(false);
  const [editandoFiltro, setEditandoFiltro] = useState<string | null>(null);
  const [formFiltro, setFormFiltro]         = useState<FormFiltroState>(FORM_FILTRO_VAZIO);
  const [salvando, setSalvando]             = useState(false);
  const [erroForm, setErroForm]             = useState("");
  const [previews, setPreviews]             = useState<Record<string, PreviewResult | "loading">>({});
  const [confirmExcluirFiltro, setConfirmExcluirFiltro] = useState<FiltroEmail | null>(null);

  // Assinaturas: form/edição
  const [showFormAss, setShowFormAss] = useState(false);
  const [novaAss, setNovaAss]         = useState({ userId: "", filtroId: "", formato: "resumido", frequencia: "diario" });
  const [editandoAss, setEditandoAss] = useState<string | null>(null);
  const [editAss, setEditAss]         = useState({ formato: "resumido", frequencia: "diario", relevanciaMinima: "TODAS" });
  const [testando, setTestando]       = useState<string | null>(null);
  const [confirmExcluirAss, setConfirmExcluirAss] = useState<Assinatura | null>(null);

  // Tipos de e-mail: matriz usuário × tipo. `desligados` guarda só as EXCEÇÕES
  // ("userId|tipo"), porque ausência de linha = habilitado (ver lib/email/tipos.ts).
  const [usuariosPref, setUsuariosPref] = useState<UsuarioPref[]>([]);
  const [desligados, setDesligados]     = useState<Set<string>>(new Set());
  const [salvandoPref, setSalvandoPref] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro("");
    try {
      const [rf, ra, ru, rp] = await Promise.all([
        fetch("/api/admin/emails/filtros"),
        fetch("/api/admin/emails/assinaturas"),
        fetch("/api/admin/users"),
        fetch("/api/admin/emails/preferencias"),
      ]);
      if (!rf.ok || !ra.ok || !ru.ok || !rp.ok) {
        setErro("Erro ao carregar dados do painel");
        return;
      }
      const df = await rf.json();
      const da = await ra.json();
      const du = await ru.json();
      const dp = await rp.json();
      setFiltros(df.filtros ?? []);
      try {
        const rp = await fetch("/api/perfis");
        const dp = await rp.json();
        setPerfis((dp.perfis ?? dp.data ?? []).filter((x: { ativo: boolean }) => x.ativo));
      } catch { setPerfis([]); }
      setOpcoes(df.opcoes ?? { naturezas: [], tipos_servico: [], segmentos: [] });
      setAssinaturas(da.assinaturas ?? []);
      setUsuarios((du.users ?? []).filter((u: UsuarioOpt) => u.ativo && !u.pendente));
      setUsuariosPref((dp.usuarios ?? []).filter((u: UsuarioPref) => u.ativo));
      // Só as exceções trafegam: o que não está aqui está ligado.
      setDesligados(new Set((dp.desligados ?? []).map((d: Desligado) => `${d.userId}|${d.tipo}`)));
    } catch {
      setErro("Erro de conexão");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  // ── Ações: tipos de e-mail ─────────────────────────────────────────────────

  async function togglePreferencia(u: UsuarioPref, tipo: TipoEmail) {
    const chave = `${u.id}|${tipo}`;
    const habilitado = desligados.has(chave); // se está desligado, o clique LIGA

    setSalvandoPref(chave);
    setErro("");
    const res = await fetch("/api/admin/emails/preferencias", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: u.id, tipo, habilitado }),
    });
    setSalvandoPref(null);

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setErro(d.error ?? "Erro ao salvar preferência");
      return;
    }

    // Toggle local: o PATCH devolve o estado final e não há dado derivado a
    // recomputar, então um refetch da página inteira só piscaria a tela.
    setDesligados((prev) => {
      const proximo = new Set(prev);
      if (habilitado) proximo.delete(chave);
      else proximo.add(chave);
      return proximo;
    });
  }

  // ── Ações: filtros ─────────────────────────────────────────────────────────

  async function salvarFiltro(e: React.FormEvent) {
    e.preventDefault();
    setErroForm("");
    setSalvando(true);
    try {
      const body = {
        nome: formFiltro.nome,
        descricao: formFiltro.descricao,
        criterios: criteriosDoForm(formFiltro),
      };
      const res = editandoFiltro
        ? await fetch(`/api/admin/emails/filtros/${editandoFiltro}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          })
        : await fetch("/api/admin/emails/filtros", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErroForm(d.error ?? "Erro ao salvar filtro"); return; }
      setShowFormFiltro(false);
      setEditandoFiltro(null);
      setFormFiltro(FORM_FILTRO_VAZIO);
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  async function toggleFiltro(fl: FiltroEmail) {
    const res = await fetch(`/api/admin/emails/filtros/${fl.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ativo: !fl.ativo }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setErro(d.error ?? "Erro"); return; }
    await carregar();
  }

  async function excluirFiltro() {
    if (!confirmExcluirFiltro) return;
    const alvo = confirmExcluirFiltro;
    setConfirmExcluirFiltro(null);
    const res = await fetch(`/api/admin/emails/filtros/${alvo.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setErro(d.error ?? "Erro ao excluir"); return; }
    await carregar();
  }

  async function verPreview(fl: FiltroEmail) {
    setPreviews((p) => ({ ...p, [fl.id]: "loading" }));
    try {
      const res = await fetch(`/api/admin/emails/filtros/${fl.id}/preview`);
      const d = await res.json();
      if (!res.ok) { setErro(d.error ?? "Erro no preview"); setPreviews((p) => { const q = { ...p }; delete q[fl.id]; return q; }); return; }
      setPreviews((p) => ({ ...p, [fl.id]: d }));
    } catch {
      setPreviews((p) => { const q = { ...p }; delete q[fl.id]; return q; });
    }
  }

  // ── Ações: assinaturas ─────────────────────────────────────────────────────

  /**
   * Liga/desliga a assinatura de UM usuário a UM perfil.
   *
   * O caminho antigo era abrir um formulário e escolher em dois dropdowns — dava
   * para fazer, mas não dava para VER quem recebe o quê. Numa matriz a pergunta
   * "de quais licitações o Fulano recebe?" se responde olhando a coluna.
   * Formato e recorrência ficam no padrão (resumido/diário) e são ajustados na
   * lista de detalhe abaixo.
   */
  async function toggleAssinaturaPerfil(userId: string, perfilId: string) {
    const chave = `${userId}|${perfilId}`;
    const existente = assinaturas.find((a) => a.userId === userId && a.perfilId === perfilId);
    setSalvandoAss(chave);
    try {
      if (existente) {
        await fetch(`/api/admin/emails/assinaturas/${existente.id}`, { method: "DELETE" });
      } else {
        await fetch("/api/admin/emails/assinaturas", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, perfilId, formato: "resumido", frequencia: "diario" }),
        });
      }
      await carregar();
    } finally {
      setSalvandoAss(null);
    }
  }

  async function criarAssinatura(e: React.FormEvent) {
    e.preventDefault();
    setErroForm("");
    setSalvando(true);
    try {
      const res = await fetch("/api/admin/emails/assinaturas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // O <select> guarda o id no campo `filtroId` por historia; hoje
        // ele carrega um PERFIL, entao vai como `perfilId` para a API.
        body: JSON.stringify({
          userId:     novaAss.userId,
          perfilId:   novaAss.filtroId,
          formato:    novaAss.formato,
          frequencia: novaAss.frequencia,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErroForm(d.error ?? "Erro ao criar assinatura"); return; }
      setShowFormAss(false);
      setNovaAss({ userId: "", filtroId: "", formato: "resumido", frequencia: "diario" });
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  async function salvarAssinatura(id: string) {
    setSalvando(true);
    try {
      const res = await fetch(`/api/admin/emails/assinaturas/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editAss),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErro(d.error ?? "Erro ao salvar"); return; }
      setEditandoAss(null);
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  async function toggleAssinatura(a: Assinatura) {
    const res = await fetch(`/api/admin/emails/assinaturas/${a.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ativo: !a.ativo }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setErro(d.error ?? "Erro"); return; }
    await carregar();
  }

  async function excluirAssinatura() {
    if (!confirmExcluirAss) return;
    const alvo = confirmExcluirAss;
    setConfirmExcluirAss(null);
    const res = await fetch(`/api/admin/emails/assinaturas/${alvo.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setErro(d.error ?? "Erro ao excluir"); return; }
    await carregar();
  }

  async function enviarTeste(a: Assinatura) {
    setTestando(a.id);
    setAviso("");
    setErro("");
    try {
      const res = await fetch(`/api/admin/emails/assinaturas/${a.id}/enviar-teste`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErro(d.error ?? "Falha no teste de envio"); return; }
      setAviso(
        d.enviado
          ? `✉️ Teste enviado para ${d.para} — ${d.itens} licitação(ões) no e-mail (de ${d.total} que casaram nos últimos 7 dias).`
          : `Nenhuma licitação casou com "${a.perfilNome ?? a.filtroNome}" nos últimos 7 dias — nada foi enviado.`,
      );
    } finally {
      setTestando(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const multiSelect = (
    label: string, valores: string[], todas: string[],
    onChange: (v: string[]) => void,
  ) => (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label} <span className="text-gray-400">(vazio = todas)</span></label>
      <select
        multiple
        size={Math.min(5, Math.max(3, todas.length))}
        value={valores}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 bg-white"
      >
        {todas.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );

  return (
    <div className="max-w-5xl">
      <p className="text-sm text-gray-500 mb-4">
        Cada gestor assina um <strong>Perfil de Interesse</strong>, com formato e
        recorrência próprios — chega por e-mail o mesmo que o Explorar mostra
        naquele perfil. Para mudar o que um perfil captura, edite-o em{" "}
        <a href="/perfis" className="text-brand-orange hover:underline">Perfis de Interesse</a>.
        O <strong>Checklist é gerado somente na plataforma</strong> — o e-mail lista
        as licitações e leva o gestor até elas.
      </p>

      {aviso && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-sm text-green-800 flex items-start gap-2">
          <Info className="h-4 w-4 flex-shrink-0 mt-0.5" /> {aviso}
        </div>
      )}
      {erro && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /> {erro}
          <button onClick={() => { setErro(""); carregar(); }} className="ml-auto text-xs underline">recarregar</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
        </div>
      ) : (
        <>
          {/* ══ Matriz: DE QUAIS LICITAÇÕES cada um recebe ══════════════════ */}
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <span className="text-sm font-semibold text-gray-700">
                De quais licitações cada um recebe ({perfis.length} perfis)
              </span>
            </div>

            <div className="px-6 py-4 border-b border-gray-100 bg-blue-50/40 flex items-start gap-2">
              <Info className="h-4 w-4 flex-shrink-0 mt-0.5 text-blue-500" />
              <p className="text-xs text-blue-900 leading-relaxed">
                Ligue o cruzamento <strong>perfil × pessoa</strong> e ela passa a receber, no digest,
                as licitações que casam com aquele perfil — as mesmas que o{" "}
                <a href="/explorar" className="underline">Explorar</a> mostra ao filtrar por ele.
                Começa <strong>resumido/diário</strong>; formato e recorrência se ajustam na lista
                abaixo. Para mudar o que um perfil captura, edite em{" "}
                <a href="/perfis" className="underline">Perfis de Interesse</a>.
              </p>
            </div>

            {perfis.length === 0 || usuariosPref.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-gray-400">
                {perfis.length === 0 ? "Nenhum perfil de interesse ativo." : "Nenhum usuário ativo."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="sticky left-0 z-10 bg-white text-left px-6 py-3 font-semibold text-gray-700 min-w-[220px]">
                        Perfil de Interesse
                      </th>
                      {usuariosPref.map((u) => (
                        <th key={u.id} className="px-3 py-3 text-center font-medium min-w-[110px]">
                          <div className="text-xs text-gray-700 truncate max-w-[110px] mx-auto" title={u.email}>
                            {u.nome ?? u.email.split("@")[0]}
                          </div>
                          <div className="text-[10px] font-normal text-gray-400">{u.role}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {perfis.map((pf) => (
                      <tr key={pf.id} className="border-b border-gray-50 hover:bg-gray-50/40">
                        <td className="sticky left-0 z-10 bg-white px-6 py-3">
                          <div className="font-medium text-gray-800">{pf.nome}</div>
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            {assinaturas.filter((a) => a.perfilId === pf.id).length} assinante(s)
                          </div>
                        </td>
                        {usuariosPref.map((u) => {
                          const chave    = `${u.id}|${pf.id}`;
                          const assinado = assinaturas.some((a) => a.userId === u.id && a.perfilId === pf.id);
                          const salvando = salvandoAss === chave;
                          return (
                            <td key={u.id} className="px-3 py-3 text-center">
                              <button
                                onClick={() => toggleAssinaturaPerfil(u.id, pf.id)}
                                disabled={salvando}
                                title={assinado
                                  ? `${u.email} recebe as licitações de "${pf.nome}" — clique para parar`
                                  : `${u.email} NÃO recebe "${pf.nome}" — clique para assinar`}
                                aria-label={`${pf.nome} para ${u.email}`}
                                aria-pressed={assinado}
                                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-40"
                              >
                                {salvando ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : assinado ? (
                                  <ToggleRight className="h-4 w-4 text-green-600" />
                                ) : (
                                  <ToggleLeft className="h-4 w-4" />
                                )}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ══ Seção 3: Tipos de e-mail por usuário (0028) ═════════════════ */}
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <BellRing className="h-4 w-4 text-gray-400" />
              <span className="text-sm font-semibold text-gray-700">
                Quais alertas cada um recebe ({CATALOGO_EMAIL.length} tipos)
              </span>
            </div>

            <div className="px-6 py-4 border-b border-gray-100 bg-blue-50/40 flex items-start gap-2">
              <Info className="h-4 w-4 flex-shrink-0 mt-0.5 text-blue-500" />
              <p className="text-xs text-blue-900 leading-relaxed">
                Tudo começa <strong>ligado</strong>: desligue aqui o que o usuário não deve receber.
                O <strong>papel continua mandando</strong> — quem não tem o papel exigido pelo tipo
                aparece travado (<span className="text-gray-400">—</span>) e nunca recebe, mesmo que
                você tente ligar. Estes são os <strong>alertas do sistema</strong> (prazos,
                vencimentos, falha na coleta). O digest de licitações NÃO está aqui — ele se
                controla na matriz <strong>&ldquo;De quais licitações cada um recebe&rdquo;</strong>, acima.
              </p>
            </div>

            {usuariosPref.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-gray-400">Nenhum usuário ativo.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="sticky left-0 z-10 bg-white text-left px-6 py-3 font-semibold text-gray-700 min-w-[220px]">
                        Tipo de e-mail
                      </th>
                      {usuariosPref.map((u) => (
                        <th key={u.id} className="px-3 py-3 text-center font-medium min-w-[110px]">
                          <div className="text-xs text-gray-700 truncate max-w-[110px] mx-auto" title={u.email}>
                            {u.nome ?? u.email.split("@")[0]}
                          </div>
                          <div className="text-[10px] font-normal text-gray-400">{u.role}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {GRUPOS_EMAIL.map((grupo: GrupoEmail) => {
                      const tipos = CATALOGO_EMAIL.filter((t) => t.grupo === grupo);
                      if (tipos.length === 0) return null;
                      return (
                        <Fragment key={grupo}>
                          <tr className="bg-gray-50/70">
                            <td
                              colSpan={usuariosPref.length + 1}
                              className="px-6 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
                            >
                              {grupo}
                            </td>
                          </tr>
                          {tipos.map((t) => (
                            <tr key={t.chave} className="border-b border-gray-50 hover:bg-gray-50/40">
                              <td className="sticky left-0 z-10 bg-white px-6 py-3">
                                <div className="font-medium text-gray-800">{t.label}</div>
                                <div className="text-[11px] text-gray-400 mt-0.5">
                                  {t.cadencia}
                                  {t.origem !== "PAPEL" && " · quem está no registro"}
                                </div>
                                <div className="text-[11px] text-gray-500 mt-1 max-w-md">{t.descricao}</div>
                              </td>
                              {usuariosPref.map((u) => {
                                const chave    = `${u.id}|${t.chave}`;
                                const elegivel = papelElegivel(t.chave, u.role);
                                const ligado   = !desligados.has(chave);
                                const salvando = salvandoPref === chave;

                                if (!elegivel) {
                                  return (
                                    <td key={u.id} className="px-3 py-3 text-center">
                                      <span
                                        className="text-gray-300 select-none"
                                        title={`O papel ${u.role} não recebe este tipo (só ${t.papeis.join(", ")}).`}
                                      >
                                        —
                                      </span>
                                    </td>
                                  );
                                }

                                return (
                                  <td key={u.id} className="px-3 py-3 text-center">
                                    <button
                                      onClick={() => togglePreferencia(u, t.chave)}
                                      disabled={salvando}
                                      title={ligado ? `${u.email} recebe — clique para desligar` : `${u.email} NÃO recebe — clique para ligar`}
                                      aria-label={`${t.label} para ${u.email}`}
                                      aria-pressed={ligado}
                                      className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-40"
                                    >
                                      {salvando ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                      ) : ligado ? (
                                        <ToggleRight className="h-4 w-4 text-green-600" />
                                      ) : (
                                        <ToggleLeft className="h-4 w-4" />
                                      )}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {/* ══ Seção 2: Assinaturas ═════════════════════════════════════════ */}
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-8">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <Mail className="h-4 w-4 text-gray-400" />
              <span className="text-sm font-semibold text-gray-700">
                Detalhe das assinaturas ({assinaturas.length})
              </span>
              <span className="text-xs text-gray-400 hidden sm:inline">
                · formato, recorrência e último envio
              </span>
              <Button
                onClick={() => { setShowFormAss(true); setErroForm(""); }}
                disabled={perfis.length === 0}
                className="gap-2 ml-auto"
              >
                <Plus className="h-4 w-4" /> Nova Assinatura
              </Button>
            </div>

            {showFormAss && (
              <form onSubmit={criarAssinatura} className="px-6 py-5 border-b border-brand-orange/30 bg-orange-50/30 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-brand-black">Nova assinatura</h3>
                  <button type="button" onClick={() => setShowFormAss(false)} aria-label="Fechar" className="text-gray-400 hover:text-gray-600">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Gestor *</label>
                    <select required value={novaAss.userId} onChange={(e) => setNovaAss({ ...novaAss, userId: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30">
                      <option value="">Selecione…</option>
                      {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome ?? u.email}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Perfil de Interesse *</label>
                    <select required value={novaAss.filtroId} onChange={(e) => setNovaAss({ ...novaAss, filtroId: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30">
                      <option value="">Selecione…</option>
                      {perfis.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                    </select>
                    <p className="text-[11px] text-gray-400 mt-1">
                      Chega o mesmo que o Explorar mostra com este perfil.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Formato *</label>
                    <select value={novaAss.formato} onChange={(e) => setNovaAss({ ...novaAss, formato: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30">
                      {Object.entries(FORMATO_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Recorrência *</label>
                    <select value={novaAss.frequencia} onChange={(e) => setNovaAss({ ...novaAss, frequencia: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange/30">
                      {Object.entries(FREQUENCIA_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-gray-500">{FREQUENCIA_DESC[novaAss.frequencia]}</p>
                {erroForm && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <AlertCircle className="h-4 w-4" /> {erroForm}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowFormAss(false)}
                    className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
                    Cancelar
                  </button>
                  <button type="submit" disabled={salvando}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                    {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Criar assinatura
                  </button>
                </div>
              </form>
            )}

            <div className="divide-y divide-gray-50">
              {assinaturas.length === 0 && !showFormAss && (
                <p className="px-6 py-10 text-center text-sm text-gray-400">
                  Nenhuma assinatura — crie um filtro acima e assine um gestor
                </p>
              )}
              {assinaturas.map((a) => (
                <div key={a.id} className={cn("px-6 py-4", !a.ativo && "opacity-50 bg-gray-50/50")}>
                  {editandoAss === a.id ? (
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">{a.userNome ?? a.userEmail}</span>
                      <span className="text-xs text-gray-400">·</span>
                      <span className="text-xs text-gray-600">{a.perfilNome ?? a.filtroNome}</span>
                      <select value={editAss.formato} onChange={(e) => setEditAss({ ...editAss, formato: e.target.value })}
                        className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white">
                        {Object.entries(FORMATO_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <select value={editAss.frequencia} onChange={(e) => setEditAss({ ...editAss, frequencia: e.target.value })}
                        className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white">
                        {Object.entries(FREQUENCIA_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      {/* Piso de relevancia (0030): sem ele o digest mistura score
                          91 com score 0 no mesmo e-mail. */}
                      <select value={editAss.relevanciaMinima ?? "TODAS"} onChange={(e) => setEditAss({ ...editAss, relevanciaMinima: e.target.value })}
                        title="Só manda licitação a partir deste nível de relevância"
                        className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white">
                        {RELEVANCIA_OPCOES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <div className="ml-auto flex gap-2">
                        <button onClick={() => setEditandoAss(null)}
                          className="px-3 py-1.5 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">Cancelar</button>
                        <button onClick={() => salvarAssinatura(a.id)} disabled={salvando}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                          {salvando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Salvar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{a.userNome ?? a.userEmail}</p>
                        <p className="text-xs text-gray-500 truncate">{a.userEmail}</p>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-50 text-orange-700 border border-orange-200">{a.perfilNome ?? a.filtroNome}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-600 border border-gray-200">{FORMATO_LABELS[a.formato] ?? a.formato}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-600 border border-gray-200">{FREQUENCIA_LABELS[a.frequencia] ?? a.frequencia}</span>
                      {a.relevanciaMinima && a.relevanciaMinima !== "TODAS" && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200"
                              title={RELEVANCIA_OPCOES.find((o) => o.value === a.relevanciaMinima)?.desc}>
                          {RELEVANCIA_OPCOES.find((o) => o.value === a.relevanciaMinima)?.label ?? a.relevanciaMinima}
                        </span>
                      )}
                      {/* A origem desativada e que importa: perfil (padrao) ou filtro
                          (legado). Antes o teste era so `!filtroAtivo`, e toda
                          assinatura por PERFIL — que nao tem filtro — aparecia como
                          "filtro desativado" mesmo funcionando. */}
                      {a.perfilNome
                        ? !a.perfilAtivo && <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700 border border-amber-200">perfil inativo — não envia</span>
                        : !a.filtroAtivo && <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700 border border-amber-200">filtro desativado</span>}
                      {!a.userAtivo && <span className="px-2 py-0.5 rounded-full text-[10px] bg-red-50 text-red-600 border border-red-200">usuário bloqueado</span>}
                      <span className="text-[10px] text-gray-400 hidden sm:inline">
                        {a.ultimoEnvioEm ? `Último envio ${new Date(a.ultimoEnvioEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : "Nunca enviado"}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        <button onClick={() => enviarTeste(a)} disabled={testando === a.id} title="Enviar teste agora (ignora recorrência; não marca como enviado)"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                          {testando === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => toggleAssinatura(a)} title={a.ativo ? "Desativar" : "Ativar"}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                          {a.ativo ? <ToggleRight className="h-4 w-4 text-green-600" /> : <ToggleLeft className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => { setEditandoAss(a.id); setEditAss({ formato: a.formato, frequencia: a.frequencia, relevanciaMinima: a.relevanciaMinima ?? "TODAS" }); }}
                          title="Editar" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setConfirmExcluirAss(a)} title="Excluir"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ══ Seção LEGADO: Filtros de E-mail ═════════════════════════════ */}
          <details className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-8 group" open={assinaturas.some((a) => !a.perfilNome)}>
            <summary className="px-6 py-4 border-b border-gray-100 flex items-center gap-2 cursor-pointer list-none hover:bg-gray-50">
              <Filter className="h-4 w-4 text-gray-400" />
              <span className="text-sm font-semibold text-gray-500">
                Filtros de e-mail — legado ({filtros.length})
              </span>
              <span className="text-xs text-gray-400 hidden sm:inline">
                · substituídos pelos Perfis de Interesse; mantidos para assinaturas antigas
              </span>
              <ChevronDown className="h-4 w-4 text-gray-400 ml-auto transition-transform group-open:rotate-180" />
            </summary>
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <span className="text-xs text-gray-500">Criar um filtro novo só faz sentido para um recorte que nenhum perfil cobre.</span>
              <Button
                onClick={() => { setShowFormFiltro(true); setEditandoFiltro(null); setFormFiltro(FORM_FILTRO_VAZIO); setErroForm(""); }}
                className="gap-2 ml-auto"
              >
                <Plus className="h-4 w-4" /> Novo Filtro
              </Button>
            </div>

            {showFormFiltro && (
              <form onSubmit={salvarFiltro} className="px-6 py-5 border-b border-brand-orange/30 bg-orange-50/30 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-brand-black">
                    {editandoFiltro ? "Editar filtro" : "Novo filtro"}
                  </h3>
                  <button type="button" onClick={() => { setShowFormFiltro(false); setEditandoFiltro(null); }} aria-label="Fechar" className="text-gray-400 hover:text-gray-600">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Nome *</label>
                    <input
                      required value={formFiltro.nome}
                      onChange={(e) => setFormFiltro({ ...formFiltro, nome: e.target.value })}
                      placeholder="Ex.: Apoio Técnico"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Descrição</label>
                    <input
                      value={formFiltro.descricao}
                      onChange={(e) => setFormFiltro({ ...formFiltro, descricao: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Palavras-chave (incluir) <span className="text-gray-400">separadas por vírgula</span></label>
                    <textarea
                      rows={2} value={formFiltro.kwIncluir}
                      onChange={(e) => setFormFiltro({ ...formFiltro, kwIncluir: e.target.value })}
                      placeholder="apoio técnico, suporte técnico, assistência técnica"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Palavras-chave (excluir)</label>
                    <textarea
                      rows={2} value={formFiltro.kwExcluir}
                      onChange={(e) => setFormFiltro({ ...formFiltro, kwExcluir: e.target.value })}
                      placeholder="hotelaria, embarcação"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                    />
                  </div>
                  {multiSelect("Natureza", formFiltro.naturezas, opcoes.naturezas, (v) => setFormFiltro({ ...formFiltro, naturezas: v }))}
                  {multiSelect("Tipo de serviço", formFiltro.tipos, opcoes.tipos_servico, (v) => setFormFiltro({ ...formFiltro, tipos: v }))}
                  {multiSelect("Segmento", formFiltro.segmentos, opcoes.segmentos, (v) => setFormFiltro({ ...formFiltro, segmentos: v }))}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Estados (UF) <span className="text-gray-400">vírgula; vazio = todos</span></label>
                      <input
                        value={formFiltro.estados}
                        onChange={(e) => setFormFiltro({ ...formFiltro, estados: e.target.value })}
                        placeholder="BA, RJ, SP"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Prioridade mínima</label>
                      <select
                        value={formFiltro.minRelevancia}
                        onChange={(e) => setFormFiltro({ ...formFiltro, minRelevancia: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 bg-white"
                      >
                        {RELEVANCIA_OPCOES.map((r) => <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
                {erroForm && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <AlertCircle className="h-4 w-4" /> {erroForm}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setShowFormFiltro(false); setEditandoFiltro(null); }}
                    className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
                    Cancelar
                  </button>
                  <button type="submit" disabled={salvando}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-brand-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                    {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {editandoFiltro ? "Salvar alterações" : "Criar filtro"}
                  </button>
                </div>
              </form>
            )}

            <div className="divide-y divide-gray-50">
              {filtros.length === 0 && !showFormFiltro && (
                <p className="px-6 py-10 text-center text-sm text-gray-400">Nenhum filtro criado ainda</p>
              )}
              {filtros.map((fl) => {
                const pv = previews[fl.id];
                return (
                  <div key={fl.id} className={cn("px-6 py-4", !fl.ativo && "opacity-50 bg-gray-50/50")}>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{fl.nome}</span>
                      {resumirCriterios(fl.criterios as Record<string, unknown>).map((b, i) => (
                        <span key={i} className="px-2 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-600 border border-gray-200">{b}</span>
                      ))}
                      <span className="text-[10px] text-gray-400">{fl.assinantes} assinante(s)</span>
                      <div className="ml-auto flex items-center gap-1">
                        <button onClick={() => verPreview(fl)} title="Preview: quantas casaram nos últimos 7 dias"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                          {pv === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => toggleFiltro(fl)} title={fl.ativo ? "Desativar filtro" : "Ativar filtro"}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                          {fl.ativo ? <ToggleRight className="h-4 w-4 text-green-600" /> : <ToggleLeft className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => { setEditandoFiltro(fl.id); setFormFiltro(formDoFiltro(fl)); setShowFormFiltro(true); setErroForm(""); }}
                          title="Editar" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setConfirmExcluirFiltro(fl)} title="Excluir"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    {fl.descricao && <p className="mt-1 text-xs text-gray-500">{fl.descricao}</p>}
                    {pv && pv !== "loading" && (
                      <div className="mt-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-900">
                        Últimos {pv.janelaDias} dias: <strong>{pv.total}</strong> licitação(ões) casariam.
                        {pv.exemplos.length > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {pv.exemplos.map((ex) => (
                              <li key={ex.numero} className="truncate">• {ex.numero} — {ex.objetoResumido}{ex.relevancia === "ALTA" ? " 🔴" : ""}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </details>

        </>
      )}

      <ConfirmDialog
        open={!!confirmExcluirFiltro}
        title="Excluir filtro"
        message={`Excluir o filtro "${confirmExcluirFiltro?.nome ?? ""}"? ${confirmExcluirFiltro?.assinantes ? `As ${confirmExcluirFiltro.assinantes} assinatura(s) dele serão removidas junto.` : ""}`}
        confirmLabel="Excluir"
        variant="danger"
        onConfirm={excluirFiltro}
        onCancel={() => setConfirmExcluirFiltro(null)}
      />
      <ConfirmDialog
        open={!!confirmExcluirAss}
        title="Excluir assinatura"
        message={`Excluir a assinatura de ${confirmExcluirAss?.userNome ?? confirmExcluirAss?.userEmail ?? ""} em "${confirmExcluirAss?.perfilNome ?? confirmExcluirAss?.filtroNome ?? ""}"?`}
        confirmLabel="Excluir"
        variant="danger"
        onConfirm={excluirAssinatura}
        onCancel={() => setConfirmExcluirAss(null)}
      />
    </div>
  );
}
