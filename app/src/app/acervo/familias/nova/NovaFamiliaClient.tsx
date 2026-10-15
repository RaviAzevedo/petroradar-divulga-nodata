"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Loader2, AlertCircle, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";

type StatusFamilia = "ATIVA" | "EM_RENOVACAO" | "SUSPENSA" | "VENCIDA" | "REJEITADA";
type NivelFamilia = "FAMILIA" | "SUBFAMILIA" | "GRUPO" | "ITEM";
type SegmentoPetrobras = "" | "YELLOW_PAGES" | "OPERACIONAL" | "CRITICA" | "ESTRATEGICA";
type StatusFluxoCrc = "" | "D" | "Q" | "A" | "X";
type StatusCriterio = "" | "APROVADO" | "QUALIFICADO" | "EM_AVALIACAO" | "REJEITADO" | "CANCELADO";
type CriterioKey = "JURIDICO" | "ECONOMICO" | "TECNICO" | "TECNICO_SMS" | "LFO" | "REVENDEDOR" | "INTEGRIDADE";

interface CritState { status: StatusCriterio; validadeFim: string; observacao: string; }

interface FormState {
  codigoCrc: string;
  nome: string;
  descricao: string;
  nivel: NivelFamilia;
  cadastroCorporativo: boolean;
  segmentoPetrobras: SegmentoPetrobras;
  statusFluxoCrc: StatusFluxoCrc;
  status: StatusFamilia;
  validadeFim: string;
  observacoes: string;
  tags: string;
  escoposCobertos: string;
  criterios: Record<CriterioKey, CritState>;
}

const CRITERIOS: { key: CriterioKey; label: string; descricao: string }[] = [
  { key: "JURIDICO",    label: "Jurídico",     descricao: "capacidade legal" },
  { key: "ECONOMICO",   label: "Econômico",    descricao: "balanços e índices" },
  { key: "TECNICO",     label: "Técnico",      descricao: "performance histórica" },
  { key: "TECNICO_SMS", label: "Técnico-SMS",  descricao: "obrigatório serviços" },
  { key: "LFO",         label: "LFO",          descricao: "Linha de Fornecimento (autodecl.)" },
  { key: "REVENDEDOR",  label: "Revendedor",   descricao: "se for distribuidor" },
  { key: "INTEGRIDADE", label: "Integridade",  descricao: "due diligence" },
];

const STATUS_CRIT_LABEL: Record<Exclude<StatusCriterio, "">, string> = {
  APROVADO:     "Aprovado (A)",
  QUALIFICADO:  "Qualificado (Q)",
  EM_AVALIACAO: "Em avaliação (D)",
  REJEITADO:    "Rejeitado (R)",
  CANCELADO:    "Cancelado (X)",
};

const INITIAL: FormState = {
  codigoCrc: "",
  nome: "",
  descricao: "",
  nivel: "FAMILIA",
  cadastroCorporativo: true,
  segmentoPetrobras: "",
  statusFluxoCrc: "",
  status: "ATIVA",
  validadeFim: "",
  observacoes: "",
  tags: "",
  escoposCobertos: "",
  criterios: Object.fromEntries(
    CRITERIOS.map((c) => [c.key, { status: "", validadeFim: "", observacao: "" }]),
  ) as Record<CriterioKey, CritState>,
};

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-red-600">{message}</p>;
}

export default function NovaFamiliaPagina() {
  const router = useRouter();
  // PRÉ-PREENCHIMENTO vindo do dossiê. Quem chega aqui por "Pedir cadastro"
  // acabou de ler o escopo oficial de uma família específica; fazer a pessoa
  // redigitar o código de 8 dígitos e o nome é convite a erro de digitação
  // justamente na chave que junta cadastro, catálogo e indício.
  const qp = useSearchParams();
  const [form, setForm] = useState<FormState>(() => {
    const codigo = (qp.get("codigo") ?? "").trim().slice(0, 50);
    const nome = (qp.get("nome") ?? "").trim().slice(0, 200);
    const descricao = (qp.get("escopo") ?? "").trim().slice(0, 2000);
    const segmento = (qp.get("segmento") ?? "").trim().toUpperCase();
    const segmentosValidos = ["YELLOW_PAGES", "OPERACIONAL", "CRITICA", "ESTRATEGICA"];
    return {
      ...INITIAL,
      codigoCrc: codigo || INITIAL.codigoCrc,
      nome: nome || INITIAL.nome,
      descricao: descricao || INITIAL.descricao,
      segmentoPetrobras: (segmentosValidos.includes(segmento)
        ? segmento
        : INITIAL.segmentoPetrobras) as SegmentoPetrobras,
      // `status` e `statusFluxoCrc` NÃO são pré-preenchidos de propósito. Vir
      // do dossiê diz o que a família É no catálogo da Petrobras; não diz nada
      // sobre onde o nosso pedido está no fluxo do CRC. Chutar "ATIVA" seria
      // afirmar cadastro que não existe, e nenhum dos outros valores significa
      // "pedido em elaboração" — quem sabe é quem preenche.
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [erroGeral, setErroGeral] = useState<string | null>(null);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (form.codigoCrc.trim().length < 2) e.codigoCrc = "Mínimo 2 caracteres";
    if (form.codigoCrc.trim().length > 50) e.codigoCrc = "Máximo 50 caracteres";
    if (form.nome.trim().length < 2) e.nome = "Mínimo 2 caracteres";
    if (form.nome.trim().length > 200) e.nome = "Máximo 200 caracteres";
    if (form.descricao.length > 2000) e.descricao = "Máximo 2000 caracteres";
    if (form.observacoes.length > 2000) e.observacoes = "Máximo 2000 caracteres";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setErroGeral(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const escoposCobertos = form.escoposCobertos.split(",").map((t) => t.trim()).filter(Boolean);

      // Critérios: só envia os que tem status preenchido
      const criterios: Record<string, { status: string; validadeFim: string | null; observacao?: string }> = {};
      for (const [key, c] of Object.entries(form.criterios) as [CriterioKey, CritState][]) {
        if (c.status) {
          criterios[key] = {
            status: c.status,
            validadeFim: c.validadeFim ? new Date(c.validadeFim).toISOString() : null,
            ...(c.observacao ? { observacao: c.observacao } : {}),
          };
        }
      }

      const payload: Record<string, unknown> = {
        codigoCrc:           form.codigoCrc.trim(),
        nome:                form.nome.trim(),
        descricao:           form.descricao.trim() || undefined,
        nivel:               form.nivel,
        cadastroCorporativo: form.cadastroCorporativo,
        status:              form.status,
        validadeFim:         form.validadeFim ? new Date(form.validadeFim).toISOString() : undefined,
        observacoes:         form.observacoes.trim() || undefined,
        tags:                tags.length > 0 ? tags : undefined,
        escoposCobertos:     escoposCobertos.length > 0 ? escoposCobertos : undefined,
      };
      if (form.segmentoPetrobras) payload.segmentoPetrobras = form.segmentoPetrobras;
      if (form.statusFluxoCrc) payload.statusFluxoCrc = form.statusFluxoCrc;
      if (Object.keys(criterios).length > 0) payload.criterios = criterios;

      const res = await fetch("/api/conformidade/familias", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 422 && data.detalhes) {
          setErrors(data.detalhes);
          setErroGeral("Há campos com erro — verifique abaixo");
        } else if (res.status === 409) {
          setErroGeral(data.error ?? "Família com este código já existe");
        } else {
          setErroGeral(data.error ?? `Erro ${res.status}`);
        }
        setSubmitting(false);
        return;
      }

      const nova = await res.json();
      router.push(`/acervo/familias/${nova.id}`);
    } catch (e) {
      setErroGeral(e instanceof Error ? e.message : "Erro ao salvar");
      setSubmitting(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((p) => ({ ...p, [key]: value }));
    if (errors[key as string]) {
      setErrors((p) => { const c = { ...p }; delete c[key as string]; return c; });
    }
  }

  function updateCrit(key: CriterioKey, field: keyof CritState, value: string) {
    setForm((p) => ({
      ...p,
      criterios: { ...p.criterios, [key]: { ...p.criterios[key], [field]: value } },
    }));
  }

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/acervo/familias" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ChevronLeft className="h-4 w-4" /> Voltar para famílias
      </Link>

      <h1 className="text-2xl font-bold text-brand-black mb-1">Nova Família CRC</h1>
      <p className="text-sm text-gray-500 mb-6">
        Cadastre uma família do CRC Petrobras. Critérios são opcionais agora — você pode preencher depois pela tela de detalhe.
      </p>

      {erroGeral && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-3 mb-5 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {erroGeral}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-5">
        {/* Identidade */}
        <fieldset className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <legend className="px-2 text-xs font-bold text-gray-500 uppercase tracking-wider">Identidade</legend>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <FieldLabel required>Código CRC</FieldLabel>
              <input
                type="text"
                value={form.codigoCrc}
                onChange={(e) => update("codigoCrc", e.target.value.toUpperCase())}
                placeholder="ex: G02.01.05"
                className={cn(
                  "w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange font-mono",
                  errors.codigoCrc ? "border-red-400" : "border-gray-200"
                )}
              />
              <FieldError message={errors.codigoCrc} />
            </div>

            <div>
              <FieldLabel required>Nível</FieldLabel>
              <select
                value={form.nivel}
                onChange={(e) => update("nivel", e.target.value as NivelFamilia)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              >
                <option value="FAMILIA">Família</option>
                <option value="SUBFAMILIA">Subfamília</option>
                <option value="GRUPO">Grupo</option>
                <option value="ITEM">Item</option>
              </select>
            </div>
          </div>

          <div>
            <FieldLabel required>Nome</FieldLabel>
            <input
              type="text"
              value={form.nome}
              onChange={(e) => update("nome", e.target.value)}
              placeholder="Bombas centrífugas para alta pressão"
              className={cn(
                "w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30",
                errors.nome ? "border-red-400" : "border-gray-200"
              )}
            />
            <FieldError message={errors.nome} />
          </div>

          <div>
            <FieldLabel>Descrição</FieldLabel>
            <textarea
              value={form.descricao}
              onChange={(e) => update("descricao", e.target.value)}
              placeholder="Detalhe o escopo de fornecimento desta família..."
              rows={3}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 resize-none"
            />
            <p className="mt-1 text-xs text-gray-400 text-right tabular-nums">{form.descricao.length} / 2000</p>
          </div>
        </fieldset>

        {/* Petrobras */}
        <fieldset className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <legend className="px-2 text-xs font-bold text-gray-500 uppercase tracking-wider">Classificação Petrobras</legend>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Segmento</FieldLabel>
              <select
                value={form.segmentoPetrobras}
                onChange={(e) => update("segmentoPetrobras", e.target.value as SegmentoPetrobras)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              >
                <option value="">— não definido —</option>
                <option value="YELLOW_PAGES">Yellow Pages (baixa complexidade)</option>
                <option value="OPERACIONAL">Operacional</option>
                <option value="CRITICA">Crítica</option>
                <option value="ESTRATEGICA">Estratégica</option>
              </select>
            </div>

            <div>
              <FieldLabel>Status fluxo CRC oficial</FieldLabel>
              <select
                value={form.statusFluxoCrc}
                onChange={(e) => update("statusFluxoCrc", e.target.value as StatusFluxoCrc)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              >
                <option value="">— não definido —</option>
                <option value="D">D — Declaração de Interesse</option>
                <option value="Q">Q — Tecnicamente Qualificado</option>
                <option value="A">A — Aprovado</option>
                <option value="X">X — Cancelado</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel>Modalidade</FieldLabel>
              <select
                value={form.cadastroCorporativo ? "corp" : "simp"}
                onChange={(e) => update("cadastroCorporativo", e.target.value === "corp")}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              >
                <option value="corp">Cadastro Corporativo</option>
                <option value="simp">Registro Simplificado</option>
              </select>
            </div>

            <div>
              <FieldLabel>Status interno</FieldLabel>
              <select
                value={form.status}
                onChange={(e) => update("status", e.target.value as StatusFamilia)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              >
                <option value="ATIVA">Ativa</option>
                <option value="EM_RENOVACAO">Em renovação</option>
                <option value="SUSPENSA">Suspensa</option>
                <option value="VENCIDA">Vencida</option>
                <option value="REJEITADA">Rejeitada</option>
              </select>
            </div>

            <div>
              <FieldLabel>Validade do CRC</FieldLabel>
              <input
                type="date"
                value={form.validadeFim}
                onChange={(e) => update("validadeFim", e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              />
            </div>
          </div>
        </fieldset>

        {/* 7 Critérios */}
        <fieldset className="bg-white rounded-xl border border-gray-200 p-6">
          <legend className="px-2 text-xs font-bold text-gray-500 uppercase tracking-wider">Critérios CRC oficiais</legend>
          <p className="text-xs text-gray-500 mb-4 flex items-center gap-1.5">
            <ListChecks className="h-3.5 w-3.5" /> Preencha os que se aplicam. Pode editar depois.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {CRITERIOS.map((c) => (
              <div key={c.key} className="border border-gray-100 rounded-lg p-3 bg-gray-50/40">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-700">{c.label}</span>
                  <span className="text-[10px] text-gray-400 italic">{c.descricao}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={form.criterios[c.key].status}
                    onChange={(e) => updateCrit(c.key, "status", e.target.value)}
                    className="px-2 py-1.5 text-xs border border-gray-200 rounded"
                  >
                    <option value="">— não avaliado —</option>
                    {Object.entries(STATUS_CRIT_LABEL).map(([k, l]) => (
                      <option key={k} value={k}>{l}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={form.criterios[c.key].validadeFim}
                    onChange={(e) => updateCrit(c.key, "validadeFim", e.target.value)}
                    placeholder="validade"
                    className="px-2 py-1.5 text-xs border border-gray-200 rounded"
                  />
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        {/* Tags + Escopos + Observações */}
        <fieldset className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <legend className="px-2 text-xs font-bold text-gray-500 uppercase tracking-wider">Metadados</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Tags (vírgula)</FieldLabel>
              <input
                type="text"
                value={form.tags}
                onChange={(e) => update("tags", e.target.value)}
                placeholder="alta pressão, inox 316L, offshore"
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <FieldLabel>Escopos cobertos (vírgula)</FieldLabel>
              <input
                type="text"
                value={form.escoposCobertos}
                onChange={(e) => update("escoposCobertos", e.target.value)}
                placeholder="Inspeção NR-13, Manutenção corretiva"
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg"
              />
            </div>
          </div>
          <div>
            <FieldLabel>Observações internas</FieldLabel>
            <textarea
              value={form.observacoes}
              onChange={(e) => update("observacoes", e.target.value)}
              placeholder="Notas técnicas, restrições, contatos do auditor..."
              rows={3}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg resize-none"
            />
          </div>
        </fieldset>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={submitting} className="gap-2 px-5 py-2.5">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? "Salvando..." : "Cadastrar família"}
          </Button>
          <Link href="/acervo/familias" className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700">
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
