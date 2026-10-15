"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, Power, PowerOff, Pencil,
  X, ChevronDown, ChevronUp, Eye, Loader2,
  CheckSquare, Square, Tag, AlertCircle, AlertTriangle, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SEGMENTOS, NATUREZAS, TIPOS_SERVICO } from "@/lib/constants";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface Filtros {
  peso?: number;
  natureza?: string[];
  tipo_servico?: string[];
  segmento?: string[];
  keywords_incluir?: string[];
  keywords_excluir?: string[];
  prazo_minimo_dias?: number;
}

interface Perfil {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean | null;
  filtros: Filtros;
}

interface FormState {
  nome: string;
  descricao: string;
  peso: number;
  natureza: string[];
  tipo_servico: string[];
  segmento: string[];
  keywords_incluir: string[];
  keywords_excluir: string[];
  prazo_minimo_dias: number;
}

const FORM_DEFAULT: FormState = {
  nome: "",
  descricao: "",
  peso: 5,
  natureza: [],
  tipo_servico: [],
  segmento: [],
  keywords_incluir: [],
  keywords_excluir: [],
  prazo_minimo_dias: 5,
};

function perfilToForm(p: Perfil): FormState {
  const f = p.filtros ?? {};
  return {
    nome: p.nome,
    descricao: p.descricao ?? "",
    peso: f.peso ?? 5,
    natureza: f.natureza ?? [],
    tipo_servico: f.tipo_servico ?? [],
    segmento: f.segmento ?? [],
    keywords_incluir: f.keywords_incluir ?? [],
    keywords_excluir: f.keywords_excluir ?? [],
    prazo_minimo_dias: f.prazo_minimo_dias ?? 5,
  };
}

function formToFiltros(f: FormState): Filtros {
  return {
    peso: f.peso,
    natureza: f.natureza.length > 0 ? f.natureza : undefined,
    tipo_servico: f.tipo_servico.length > 0 ? f.tipo_servico : undefined,
    segmento: f.segmento.length > 0 ? f.segmento : undefined,
    keywords_incluir: f.keywords_incluir,
    keywords_excluir: f.keywords_excluir,
    prazo_minimo_dias: f.prazo_minimo_dias,
  };
}

// ─── Tag Input ────────────────────────────────────────────────────────────────

function TagInput({
  tags,
  onChange,
  placeholder,
  color = "blue",
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  placeholder?: string;
  color?: "blue" | "red";
}) {
  const [input, setInput] = useState("");

  function add() {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
        {tags.map((tag) => (
          <span
            key={tag}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
              color === "blue"
                ? "bg-blue-50 text-blue-700 border border-blue-200"
                : "bg-red-50 text-red-700 border border-red-200"
            )}
          >
            <Tag className="h-2.5 w-2.5" />
            {tag}
            <button onClick={() => remove(tag)} className="hover:opacity-70 ml-0.5" aria-label={`Remover ${tag}`}>
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {tags.length === 0 && (
          <span className="text-xs text-gray-400 italic">Nenhuma palavra adicionada</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder ?? "Digite e pressione Enter..."}
          className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
        />
        <button
          onClick={add}
          disabled={!input.trim()}
          type="button"
          className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 disabled:opacity-40 transition-colors"
        >
          + Adicionar
        </button>
      </div>
    </div>
  );
}

// ─── Checkbox Group ───────────────────────────────────────────────────────────

function CheckboxGroup({
  options,
  selected,
  onChange,
  columns = 2,
}: {
  options: readonly string[];
  selected: string[];
  onChange: (v: string[]) => void;
  columns?: number;
}) {
  function toggle(opt: string) {
    if (selected.includes(opt)) {
      onChange(selected.filter((s) => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  }

  return (
    <div className={cn("grid gap-2", columns === 2 ? "grid-cols-2" : "grid-cols-3")}>
      {options.map((opt) => {
        const checked = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg border text-xs text-left transition-colors",
              checked
                ? "bg-brand-orange/10 border-brand-orange text-brand-orange font-medium"
                : "border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            )}
          >
            {checked ? <CheckSquare className="h-3.5 w-3.5 flex-shrink-0" /> : <Square className="h-3.5 w-3.5 flex-shrink-0" />}
            <span className="line-clamp-1">{opt}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Preview de matches ────────────────────────────────────────────────────────

interface PreviewResult {
  count: number;
  abertas?: number;
  distribuicao?: { ALTA?: number; MEDIA?: number; BAIXA?: number };
  sample: { numero: string; objeto: string | null; relevancia: string | null; score?: number | null }[];
}

function PreviewPanel({ filtros }: { filtros: Filtros }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");

  async function testar() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/perfis/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filtros),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: PreviewResult = await res.json();
      setResult(json);
    } catch {
      setError("Erro ao testar filtros");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Preview de matches</span>
        <button
          onClick={testar}
          disabled={loading}
          type="button"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
          Testar filtros
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-500">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      )}

      {result && !error && (
        <div>
          <p className="text-sm font-bold text-brand-black mb-2">
            {result.count === 0
              ? "Nenhuma licitação encontrada"
              : `≈ ${result.count} licitação${result.count !== 1 ? "ões" : ""} capturada${result.count !== 1 ? "s" : ""}`}
            {result.count > 0 && typeof result.abertas === "number" && (
              <span className="font-normal text-gray-500"> ({result.abertas} aberta{result.abertas !== 1 ? "s" : ""})</span>
            )}
          </p>
          {result.distribuicao && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-[10px] font-medium">
                ALTA {result.distribuicao.ALTA ?? 0}
              </span>
              <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px] font-medium">
                MÉDIA {result.distribuicao.MEDIA ?? 0}
              </span>
              <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-[10px] font-medium">
                BAIXA {result.distribuicao.BAIXA ?? 0}
              </span>
            </div>
          )}
          {result.sample.length > 0 && (
            <div className="space-y-1.5">
              {result.sample.map((s) => (
                <div key={s.numero} className="flex items-start gap-2 text-xs">
                  <span className="font-mono text-brand-orange flex-shrink-0">{s.numero}</span>
                  <span className="text-gray-600 line-clamp-1 flex-1">{s.objeto}</span>
                  {s.relevancia && (
                    <span className="text-gray-400 flex-shrink-0 whitespace-nowrap">
                      {s.relevancia}{s.score != null ? ` · ${s.score}` : ""}
                    </span>
                  )}
                </div>
              ))}
              {result.count > 5 && (
                <p className="text-xs text-gray-400">...e mais {result.count - 5}</p>
              )}
            </div>
          )}
        </div>
      )}

      {!result && !loading && (
        <p className="text-xs text-gray-400">Clique em "Testar filtros" para ver quantas licitações este perfil capturaria.</p>
      )}
    </div>
  );
}

// ─── Formulário de Perfil ─────────────────────────────────────────────────────

/**
 * Componente externalizado (não pode ser nested para evitar
 * `react-hooks/static-components`).
 */
function FormSection({
  id, title, badge, children, openSection, onToggle,
}: {
  id: string;
  title: string;
  badge?: string | number;
  children: React.ReactNode;
  openSection: string;
  onToggle: (next: string) => void;
}) {
  const open = openSection === id;
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(open ? "" : id)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <span className="text-sm font-medium text-gray-700">{title}</span>
        <div className="flex items-center gap-2">
          {badge !== undefined && badge !== 0 && badge !== "" && (
            <span className="text-xs bg-brand-orange text-black px-2 py-0.5 rounded-full font-medium">
              {badge}
            </span>
          )}
          {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
        </div>
      </button>
      {open && <div className="p-4 bg-white">{children}</div>}
    </div>
  );
}


function PerfilForm({
  initial,
  onSave,
  onCancel,
  isEditing,
}: {
  initial: FormState;
  onSave: (form: FormState) => Promise<void>;
  onCancel: () => void;
  isEditing: boolean;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [openSection, setOpenSection] = useState<string>("basico");

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSave() {
    if (!form.nome.trim()) {
      setSaveError("Nome do perfil é obrigatório");
      return;
    }
    setSaveError("");
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  }

  // (FormSection é externalizado — chamadas diretas abaixo passam
  // openSection e setOpenSection.)

  const filtrosPreview = formToFiltros(form);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h3 className="text-base font-semibold text-brand-black">
          {isEditing ? "Editar Perfil" : "Novo Perfil de Interesse"}
        </h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 transition-colors" aria-label="Fechar formulário">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="p-6 space-y-4">

        {/* ── Seção 1: Identificação ── */}
        <FormSection openSection={openSection} onToggle={setOpenSection}id="basico" title="Identificação" badge={form.nome ? "✓" : undefined}>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">
                Nome do perfil <span className="text-red-400">*</span>
              </label>
              <input
                value={form.nome}
                onChange={(e) => {
                  set("nome", e.target.value);
                  if (saveError) setSaveError("");
                }}
                placeholder="Ex: Engenharia Offshore"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
              />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">
                Prioridade (1 = baixa, 10 = alta)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={form.peso}
                  onChange={(e) => set("peso", Number(e.target.value))}
                  className="flex-1 accent-brand-orange"
                />
                <span className={cn(
                  "text-lg font-bold w-8 text-center",
                  form.peso >= 8 ? "text-red-600" : form.peso >= 5 ? "text-amber-600" : "text-gray-500"
                )}>
                  {form.peso}
                </span>
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Descrição</label>
              <textarea
                value={form.descricao}
                onChange={(e) => set("descricao", e.target.value)}
                rows={2}
                placeholder="Descreva o que este perfil captura..."
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 resize-none"
              />
            </div>
          </div>
        </FormSection>

        {/* ── Seção 2: Natureza ── */}
        <FormSection openSection={openSection} onToggle={setOpenSection}
          id="natureza"
          title="Natureza da licitação"
          badge={form.natureza.length > 0 ? form.natureza.length : undefined}
        >
          <p className="text-xs text-gray-400 mb-3">
            Deixe todos desmarcados para aceitar qualquer natureza.
          </p>
          <CheckboxGroup
            options={NATUREZAS}
            selected={form.natureza}
            onChange={(v) => set("natureza", v)}
            columns={3}
          />
        </FormSection>

        {/* ── Seção 3: Tipo de Serviço ── */}
        <FormSection openSection={openSection} onToggle={setOpenSection}
          id="tipo_servico"
          title="Tipo de serviço"
          badge={form.tipo_servico.length > 0 ? form.tipo_servico.length : undefined}
        >
          <p className="text-xs text-gray-400 mb-3">
            Aplica-se apenas a licitações de serviço. Deixe vazio para qualquer tipo.
          </p>
          <CheckboxGroup
            options={TIPOS_SERVICO}
            selected={form.tipo_servico}
            onChange={(v) => set("tipo_servico", v)}
            columns={2}
          />
        </FormSection>

        {/* ── Seção 4: Segmento ── */}
        <FormSection openSection={openSection} onToggle={setOpenSection}
          id="segmento"
          title="Segmento / área"
          badge={form.segmento.length > 0 ? form.segmento.length : undefined}
        >
          <p className="text-xs text-gray-400 mb-3">
            Categorização automática pelo objeto da licitação. Deixe vazio para qualquer segmento.
          </p>
          <CheckboxGroup
            options={SEGMENTOS}
            selected={form.segmento}
            onChange={(v) => set("segmento", v)}
            columns={2}
          />
        </FormSection>

        {/* ── Seção 5: Palavras-chave ── */}
        <FormSection openSection={openSection} onToggle={setOpenSection}
          id="keywords"
          title="Palavras-chave"
          badge={form.keywords_incluir.length + form.keywords_excluir.length > 0
            ? `${form.keywords_incluir.length}+${form.keywords_excluir.length}`
            : undefined}
        >
          <div className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-green-700 mb-2">
                ✓ Palavras que INCLUEM (qualquer uma é suficiente)
              </label>
              <TagInput
                tags={form.keywords_incluir}
                onChange={(v) => set("keywords_incluir", v)}
                placeholder='Ex: "engenharia" e pressione Enter...'
                color="blue"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-red-600 mb-2">
                ✗ Palavras que EXCLUEM (presença elimina a licitação)
              </label>
              <TagInput
                tags={form.keywords_excluir}
                onChange={(v) => set("keywords_excluir", v)}
                placeholder='Ex: "software" e pressione Enter...'
                color="red"
              />
            </div>
          </div>
        </FormSection>

        {/* ── Seção 6: Restrições ── */}
        <FormSection openSection={openSection} onToggle={setOpenSection}id="restricoes" title="Restrições de prazo">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">
              Prazo mínimo restante (dias)
            </label>
            <div className="flex items-center gap-3 max-w-xs">
              <input
                type="number"
                min={0}
                max={365}
                value={form.prazo_minimo_dias}
                onChange={(e) => set("prazo_minimo_dias", Number(e.target.value))}
                className="w-24 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-center"
              />
              <span className="text-sm text-gray-500">dias restantes (0 = sem restrição)</span>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Licitações com prazo menor que este valor receberão score reduzido.
            </p>
          </div>
        </FormSection>

        {/* ── Preview ── */}
        <PreviewPanel filtros={filtrosPreview} />

        {/* ── Ações ── */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-100">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-black text-white rounded-xl text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Salvando..." : isEditing ? "Salvar alterações" : "Criar perfil"}
          </button>
          {saveError && (
            <p className="text-sm text-red-600">{saveError}</p>
          )}
          <button
            onClick={onCancel}
            className="px-5 py-2.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Card de Perfil ───────────────────────────────────────────────────────────

function PerfilCard({
  perfil,
  onEdit,
  onToggle,
  onDelete,
}: {
  perfil: Perfil;
  onEdit: (p: Perfil) => void;
  onToggle: (p: Perfil) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const f = perfil.filtros;

  const pesoLabel = f.peso
    ? f.peso >= 8 ? "Alta" : f.peso >= 5 ? "Média" : "Baixa"
    : "—";
  const pesoColor = f.peso
    ? f.peso >= 8 ? "text-red-600 bg-red-50" : f.peso >= 5 ? "text-amber-600 bg-amber-50" : "text-gray-500 bg-gray-100"
    : "text-gray-400 bg-gray-50";

  return (
    <div className={cn(
      "bg-white rounded-xl border transition-all",
      perfil.ativo ? "border-gray-200" : "border-gray-100 opacity-60"
    )}>
      {/* Header do card */}
      <div className="flex items-center gap-4 p-5">
        {/* Prioridade */}
        <div className={cn("w-10 h-10 rounded-xl flex flex-col items-center justify-center flex-shrink-0", pesoColor)}>
          <span className="text-base font-black leading-none">{f.peso ?? "—"}</span>
          <span className="text-[8px] font-medium uppercase leading-none mt-0.5">{pesoLabel}</span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-brand-black">{perfil.nome}</h3>
            <span className={cn(
              "px-2 py-0.5 rounded-full text-[10px] font-medium",
              perfil.ativo ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
            )}>
              {perfil.ativo ? "Ativo" : "Inativo"}
            </span>
          </div>
          {perfil.descricao && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{perfil.descricao}</p>
          )}

          {/* Tags resumo */}
          <div className="flex flex-wrap gap-1 mt-2">
            {f.natureza?.map((n) => (
              <span key={n} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-[10px] rounded font-medium">{n}</span>
            ))}
            {f.tipo_servico?.slice(0, 2).map((t) => (
              <span key={t} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 text-[10px] rounded font-medium">{t}</span>
            ))}
            {(f.tipo_servico?.length ?? 0) > 2 && (
              <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 text-[10px] rounded">+{(f.tipo_servico?.length ?? 0) - 2}</span>
            )}
            {f.segmento?.slice(0, 2).map((s) => (
              <span key={s} className="px-1.5 py-0.5 bg-amber-50 text-amber-700 text-[10px] rounded font-medium">{s}</span>
            ))}
            {(f.segmento?.length ?? 0) > 2 && (
              <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 text-[10px] rounded">+{(f.segmento?.length ?? 0) - 2}</span>
            )}
            {(f.keywords_incluir?.length ?? 0) > 0 && (
              <span className="px-1.5 py-0.5 bg-green-50 text-green-700 text-[10px] rounded font-medium">
                {f.keywords_incluir!.length} keywords
              </span>
            )}
          </div>
        </div>

        {/* Ações */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            title="Ver detalhes"
            aria-label={expanded ? "Recolher detalhes" : "Ver detalhes"}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <button
            onClick={() => onEdit(perfil)}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            title="Editar"
            aria-label="Editar perfil"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={() => onToggle(perfil)}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title={perfil.ativo ? "Desativar" : "Ativar"}
            aria-label={perfil.ativo ? "Desativar perfil" : "Ativar perfil"}
          >
            {perfil.ativo
              ? <Power className="h-4 w-4 text-green-500" />
              : <PowerOff className="h-4 w-4 text-gray-400" />}
          </button>
          <button
            onClick={() => onDelete(perfil.id)}
            className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
            title="Excluir"
            aria-label="Excluir perfil"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Detalhes expandidos */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 grid grid-cols-2 gap-4 text-xs">
          <div>
            <p className="font-medium text-gray-500 mb-1.5">Natureza aceita</p>
            <p className="text-gray-700">{f.natureza?.join(", ") || "Qualquer"}</p>
          </div>
          <div>
            <p className="font-medium text-gray-500 mb-1.5">Tipo de serviço</p>
            <p className="text-gray-700">{f.tipo_servico?.join(", ") || "Qualquer"}</p>
          </div>
          <div>
            <p className="font-medium text-gray-500 mb-1.5">Segmento</p>
            <p className="text-gray-700">{f.segmento?.join(", ") || "Qualquer"}</p>
          </div>
          <div>
            <p className="font-medium text-gray-500 mb-1.5">Prazo mínimo</p>
            <p className="text-gray-700">{f.prazo_minimo_dias ? `${f.prazo_minimo_dias} dias` : "Sem restrição"}</p>
          </div>
          {(f.keywords_incluir?.length ?? 0) > 0 && (
            <div className="col-span-2">
              <p className="font-medium text-green-600 mb-1.5">✓ Palavras que incluem</p>
              <div className="flex flex-wrap gap-1">
                {f.keywords_incluir!.map((k) => (
                  <span key={k} className="px-2 py-0.5 bg-green-50 text-green-700 rounded-full border border-green-200">{k}</span>
                ))}
              </div>
            </div>
          )}
          {(f.keywords_excluir?.length ?? 0) > 0 && (
            <div className="col-span-2">
              <p className="font-medium text-red-600 mb-1.5">✗ Palavras que excluem</p>
              <div className="flex flex-wrap gap-1">
                {f.keywords_excluir!.map((k) => (
                  <span key={k} className="px-2 py-0.5 bg-red-50 text-red-700 rounded-full border border-red-200">{k}</span>
                ))}
              </div>
            </div>
          )}

          {/* Mini preview inline */}
          <div className="col-span-2">
            <PreviewPanel filtros={f} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function PerfisPage() {
  const [perfis, setPerfis] = useState<Perfil[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"list" | "new" | "edit">("list");
  const [editingPerfil, setEditingPerfil] = useState<Perfil | null>(null);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyResult, setReclassifyResult] = useState<{ stats: Record<string, number>; total: number } | null>(null);

  const [erro, setErro] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<"reclassify" | "delete" | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pctSemInteresse, setPctSemInteresse] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [resSem, resBase] = await Promise.all([
          fetch("/api/licitacoes?relevancia=SEM%20INTERESSE&limit=1"),
          fetch("/api/licitacoes?limit=1"),
        ]);
        if (!resSem.ok || !resBase.ok) return;
        const [jsonSem, jsonBase] = await Promise.all([resSem.json(), resBase.json()]);
        const totalSem = jsonSem?.meta?.total;
        const totalBase = jsonBase?.meta?.total;
        if (
          !cancelled &&
          typeof totalSem === "number" &&
          typeof totalBase === "number" &&
          totalBase > 0
        ) {
          setPctSemInteresse(totalSem / totalBase);
        }
      } catch {
        // Falha silenciosa: banner simplesmente não mostra esta parte.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const fetchPerfis = useCallback(async () => {
    setErro(null);
    try {
      const res = await fetch("/api/perfis");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setPerfis(json.data || []);
    } catch {
      setErro("Erro ao carregar perfis. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPerfis(); }, [fetchPerfis]);

  async function handleSave(form: FormState) {
    const body = {
      nome: form.nome.trim(),
      descricao: form.descricao.trim(),
      filtros: formToFiltros(form),
    };

    try {
      const url = mode === "edit" && editingPerfil
        ? `/api/perfis/${editingPerfil.id}`
        : "/api/perfis";
      const method = mode === "edit" && editingPerfil ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Erro ao salvar perfil");
      }

      setMode("list");
      setEditingPerfil(null);
      fetchPerfis();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao salvar perfil");
    }
  }

  function handleEdit(perfil: Perfil) {
    setEditingPerfil(perfil);
    setMode("edit");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleCancel() {
    setMode("list");
    setEditingPerfil(null);
  }

  async function handleToggle(perfil: Perfil) {
    try {
      const res = await fetch(`/api/perfis/${perfil.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativo: !perfil.ativo }),
      });
      if (!res.ok) throw new Error("Erro ao alterar status");
      fetchPerfis();
    } catch {
      setErro("Erro ao alterar status do perfil");
    }
  }

  function openReclassifyDialog() {
    setErro(null);
    setConfirmDialog("reclassify");
  }

  async function executeReclassify() {
    setConfirmDialog(null);
    setReclassifying(true);
    setReclassifyResult(null);
    setErro(null);
    try {
      const res = await fetch("/api/licitacoes/reclassify", { method: "POST" });
      const json = await res.json();
      if (res.ok) setReclassifyResult({ stats: json.stats ?? {}, total: json.total ?? 0 });
      else setErro(json.error || "Erro ao reclassificar");
    } catch {
      setErro("Erro de conexão");
    } finally {
      setReclassifying(false);
    }
  }

  function requestDelete(id: string) {
    setErro(null);
    setPendingDeleteId(id);
    setConfirmDialog("delete");
  }

  async function executeDelete() {
    const id = pendingDeleteId;
    setConfirmDialog(null);
    setPendingDeleteId(null);
    if (!id) return;
    try {
      const res = await fetch(`/api/perfis/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Erro ao excluir");
      fetchPerfis();
    } catch {
      setErro("Erro ao excluir perfil");
    }
  }

  function cancelConfirmDialog() {
    setConfirmDialog(null);
    setPendingDeleteId(null);
  }

  const ativos = perfis.filter((p) => p.ativo);
  const inativos = perfis.filter((p) => !p.ativo);

  // ── Saúde dos perfis ──
  const nAtivos = ativos.length;
  const e2eAtivo = ativos.some((p) => p.nome.toLowerCase().includes("e2e"));
  const healthMsgs: string[] = [];
  if (!loading) {
    if (nAtivos === 0) {
      healthMsgs.push("Nenhum perfil ativo — todas as licitações novas ficarão SEM INTERESSE.");
    }
    if (nAtivos <= 1 && e2eAtivo) {
      healthMsgs.push("Apenas o perfil de teste (e2e) está ativo — o radar de produção está efetivamente desligado. Ative os perfis reais.");
    }
  }
  if (pctSemInteresse !== null && pctSemInteresse > 0.85) {
    healthMsgs.push(`${Math.round(pctSemInteresse * 100)}% da base está SEM INTERESSE — revise os perfis ativos ou rode a reclassificação.`);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Perfis de Interesse</h1>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-medium text-green-600">{ativos.length} ativos</span>
            {inativos.length > 0 && (
              <span className="text-gray-400 ml-2">· {inativos.length} inativos</span>
            )}
          </p>
        </div>
        {mode === "list" && (
          <div className="flex items-center gap-2">
            <button
              onClick={openReclassifyDialog}
              disabled={reclassifying || ativos.length === 0}
              className="inline-flex items-center gap-2 px-3 py-2 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="Reclassifica todas as licitações com os perfis ativos"
            >
              {reclassifying
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              {reclassifying ? "Reclassificando..." : "Reclassificar licitações"}
            </button>
            <button
              onClick={() => setMode("new")}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-brand-black text-white rounded-xl text-sm font-medium hover:bg-gray-800 transition-colors shadow-sm"
            >
              <Plus className="h-4 w-4" /> Novo Perfil
            </button>
          </div>
        )}
      </div>

      {/* Banner de saúde dos perfis */}
      {healthMsgs.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <ul className="text-sm text-amber-800 space-y-1">
            {healthMsgs.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Resultado de reclassificação */}
      {reclassifyResult && mode === "list" && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-5 flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-green-800 mb-1">
              ✓ {reclassifyResult.total} licitações reclassificadas
            </p>
            <div className="flex flex-wrap gap-3 text-xs text-green-700 items-center">
              <span className="inline-flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-xs font-medium">Alta</span>
                <strong>{reclassifyResult.stats["ALTA"] ?? 0}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-xs font-medium">Média</span>
                <strong>{reclassifyResult.stats["MÉDIA"] ?? 0}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">Baixa</span>
                <strong>{reclassifyResult.stats["BAIXA"] ?? 0}</strong>
              </span>
              <span>— Sem interesse: <strong>{reclassifyResult.stats["SEM INTERESSE"] ?? 0}</strong></span>
            </div>
          </div>
          <button onClick={() => setReclassifyResult(null)} className="text-green-400 hover:text-green-600" aria-label="Fechar resultado">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Error banner */}
      {erro && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{erro}</span>
          <button
            onClick={fetchPerfis}
            className="ml-4 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* Como funciona */}
      {mode === "list" && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 text-xs text-blue-700">
          <p className="font-semibold mb-1">Como funcionam os perfis</p>
          <p>
            Cada perfil define critérios (natureza, tipo de serviço, segmento, palavras-chave) que são aplicados automaticamente
            em cada sync com o Petronect. Licitações que se encaixam recebem <strong>relevância ALTA/MÉDIA/BAIXA</strong> e
            score de 0–100. Perfis com prioridade maior influenciam mais o score final.
          </p>
        </div>
      )}

      {/* Formulário (novo ou editar) */}
      {(mode === "new" || mode === "edit") && (
        <div className="mb-8">
          <PerfilForm
            initial={mode === "edit" && editingPerfil ? perfilToForm(editingPerfil) : FORM_DEFAULT}
            onSave={handleSave}
            onCancel={handleCancel}
            isEditing={mode === "edit"}
          />
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Carregando perfis...</span>
        </div>
      ) : perfis.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-base mb-2">Nenhum perfil configurado.</p>
          <p className="text-sm">Clique em &quot;Novo Perfil&quot; para começar.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Perfis ativos */}
          {ativos.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Ativos ({ativos.length})
              </h2>
              <div className="space-y-3">
                {ativos
                  .sort((a, b) => (b.filtros?.peso ?? 5) - (a.filtros?.peso ?? 5))
                  .map((p) => (
                    <PerfilCard
                      key={p.id}
                      perfil={p}
                      onEdit={handleEdit}
                      onToggle={handleToggle}
                      onDelete={requestDelete}
                    />
                  ))}
              </div>
            </div>
          )}

          {/* Perfis inativos */}
          {inativos.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Inativos ({inativos.length})
              </h2>
              <div className="space-y-3">
                {inativos.map((p) => (
                  <PerfilCard
                    key={p.id}
                    perfil={p}
                    onEdit={handleEdit}
                    onToggle={handleToggle}
                    onDelete={requestDelete}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDialog === "reclassify"}
        title="Reclassificar licitações"
        message={`Reclassificar todas as licitações com os ${ativos.length} perfis ativos? Isso atualiza relevância e score de todas as licitações no banco.`}
        confirmLabel="Reclassificar"
        cancelLabel="Cancelar"
        variant="default"
        onConfirm={executeReclassify}
        onCancel={cancelConfirmDialog}
      />
      <ConfirmDialog
        open={confirmDialog === "delete"}
        title="Excluir perfil"
        message="Excluir este perfil de interesse? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={executeDelete}
        onCancel={cancelConfirmDialog}
      />
    </div>
  );
}
