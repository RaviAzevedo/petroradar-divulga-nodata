"use client";

/**
 * Edição do cadastro da operação (03-FRONTEND §5.11 — consome R4).
 *
 * Regras que vêm do contrato de R4:
 *  - `codigo` e `origem` aparecem read-only com "não pode ser alterado" e NUNCA
 *    entram no PATCH (o 422 do servidor é rede de segurança, não fluxo);
 *  - o corpo leva SOMENTE os campos alterados (diff contra o dossiê carregado)
 *    — o audit de R4 registra antes/depois só do que mudou;
 *  - `valor`/`hh` vão como NÚMERO no JSON (o schema é z.number()), embora o
 *    dossiê os devolva como string de numeric — a conversão é daqui;
 *  - datas em "AAAA-MM-DD": é o que o `input date` já produz.
 *
 * Prop `focoInicial="contratoNumero"` atende o botão [informar] do subtítulo.
 */

import { useMemo, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import { cn } from "@/lib/utils";
import {
  DETENTORAS,
  DETENTORA_LABELS,
  ORIGEM_OPERACAO_LABELS,
  type Detentora,
  type OrigemOperacao,
} from "@/lib/conformidade/operacoes";

/** Recorte do dossiê (R3) que o editor lê — tipagem estrutural, sem importar a page. */
export interface OperacaoEditavel {
  id: string;
  codigo: string;
  origem: OrigemOperacao;
  clienteNome: string;
  clienteGrupo: string | null;
  clienteCnpj: string | null;
  contratoNumero: string | null;
  unidade: string | null;
  /** 0044 (B5) — área da planta, texto livre ao lado de `unidade` (§7.2). */
  area: string | null;
  detentora: Detentora;
  ramo: string | null;
  onshoreOffshore: string | null;
  periodoInicio: string | null;
  periodoFim: string | null;
  valor?: string | null;
  hh?: string | null;
  escopo: string | null;
  familiasSugeridas: string[] | null;
  ativo: boolean;
}

interface RespostaPatch {
  error?: string;
  detalhes?: Record<string, string>;
}

interface Props {
  operacao: OperacaoEditavel;
  focoInicial?: "contratoNumero";
  onFechar: () => void;
  /** 200 do PATCH: a ficha recarrega o dossiê e anuncia "Cadastro atualizado". */
  onSalvo: () => void;
  /** 404 no meio da edição: a operação sumiu — a ficha mostra o estado próprio. */
  onNaoEncontrada: () => void;
}

/** "1234.56" (numeric da API) → "1234,56" para exibição. */
function numericParaTela(valor: string | null | undefined): string {
  return valor ? valor.replace(".", ",") : "";
}

/**
 * Texto do usuário → número para R4. `null` = campo limpo; `undefined` = não
 * parseia ("12,3,4") — vira erro de campo ANTES do request.
 */
function telaParaNumero(texto: string): number | null | undefined {
  const t = texto.trim();
  if (!t) return null;
  // Com vírgula, ponto é milhar ("1.234,56"); sem vírgula, ponto é decimal.
  const normalizado = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = Number(normalizado);
  return Number.isNaN(n) ? undefined : n;
}

export function ModalEditarOperacao({
  operacao,
  focoInicial,
  onFechar,
  onSalvo,
  onNaoEncontrada,
}: Props) {
  const contratoRef = useRef<HTMLInputElement>(null);
  const primeiroCampoRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: onFechar,
    initialFocusRef: focoInicial === "contratoNumero" ? contratoRef : primeiroCampoRef,
  });

  const [clienteNome, setClienteNome] = useState(operacao.clienteNome);
  const [clienteGrupo, setClienteGrupo] = useState(operacao.clienteGrupo ?? "");
  const [clienteCnpj, setClienteCnpj] = useState(operacao.clienteCnpj ?? "");
  const [contratoNumero, setContratoNumero] = useState(operacao.contratoNumero ?? "");
  const [unidade, setUnidade] = useState(operacao.unidade ?? "");
  const [area, setArea] = useState(operacao.area ?? "");
  const [detentora, setDetentora] = useState<Detentora>(operacao.detentora);
  const [ramo, setRamo] = useState(operacao.ramo ?? "");
  const [onshoreOffshore, setOnshoreOffshore] = useState(operacao.onshoreOffshore ?? "");
  const [periodoInicio, setPeriodoInicio] = useState(operacao.periodoInicio ?? "");
  const [periodoFim, setPeriodoFim] = useState(operacao.periodoFim ?? "");
  const [valor, setValor] = useState(numericParaTela(operacao.valor));
  const [hh, setHh] = useState(numericParaTela(operacao.hh));
  const [escopo, setEscopo] = useState(operacao.escopo ?? "");
  const [familias, setFamilias] = useState((operacao.familiasSugeridas ?? []).join(", "));
  const [ativo, setAtivo] = useState(operacao.ativo);

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [errosCampo, setErrosCampo] = useState<Record<string, string>>({});

  /** `valor`/`hh` originais como número, para o diff não acusar "1234.5" ≠ 1234.5. */
  const valorOriginal = useMemo(
    () => (operacao.valor != null ? Number(operacao.valor) : null),
    [operacao.valor]
  );
  const hhOriginal = useMemo(
    () => (operacao.hh != null ? Number(operacao.hh) : null),
    [operacao.hh]
  );

  async function salvar() {
    setErro(null);
    setErrosCampo({});

    const erros: Record<string, string> = {};
    if (clienteNome.trim().length < 2) erros.clienteNome = "Mínimo 2 caracteres";

    const valorNum = telaParaNumero(valor);
    if (valorNum === undefined) erros.valor = "Número inválido — use vírgula para os centavos";
    const hhNum = telaParaNumero(hh);
    if (hhNum === undefined) erros.hh = "Número inválido";

    if (Object.keys(erros).length > 0) {
      setErrosCampo(erros);
      return;
    }

    // Diff campo a campo: só o que mudou entra no PATCH. Campo de texto limpo
    // vira null (apagar é intenção); igual ao original, nem viaja.
    const body: Record<string, unknown> = {};
    const texto = (v: string) => v.trim() || null;

    if (texto(clienteNome) !== operacao.clienteNome) body.clienteNome = clienteNome.trim();
    if (texto(clienteGrupo) !== operacao.clienteGrupo) body.clienteGrupo = texto(clienteGrupo);
    if (texto(clienteCnpj) !== operacao.clienteCnpj) body.clienteCnpj = texto(clienteCnpj);
    if (texto(contratoNumero) !== operacao.contratoNumero) body.contratoNumero = texto(contratoNumero);
    if (texto(unidade) !== operacao.unidade) body.unidade = texto(unidade);
    if (texto(area) !== operacao.area) body.area = texto(area);
    if (detentora !== operacao.detentora) body.detentora = detentora;
    if (texto(ramo) !== operacao.ramo) body.ramo = texto(ramo);
    if (texto(onshoreOffshore) !== operacao.onshoreOffshore) body.onshoreOffshore = texto(onshoreOffshore);
    if ((periodoInicio || null) !== operacao.periodoInicio) body.periodoInicio = periodoInicio || null;
    if ((periodoFim || null) !== operacao.periodoFim) body.periodoFim = periodoFim || null;
    if (valorNum !== valorOriginal) body.valor = valorNum;
    if (hhNum !== hhOriginal) body.hh = hhNum;
    if (texto(escopo) !== operacao.escopo) body.escopo = texto(escopo);
    if (ativo !== operacao.ativo) body.ativo = ativo;

    const familiasNovas = familias
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const familiasOriginais = operacao.familiasSugeridas ?? [];
    if (JSON.stringify(familiasNovas) !== JSON.stringify(familiasOriginais)) {
      body.familiasSugeridas = familiasNovas.length > 0 ? familiasNovas : null;
    }

    if (Object.keys(body).length === 0) {
      // Nada mudou: fechar é o resultado honesto — sem request, sem audit vazio.
      onFechar();
      return;
    }

    setSalvando(true);
    try {
      const r = await fetch(`/api/conformidade/operacoes/${operacao.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (r.status === 404) {
        onNaoEncontrada();
        return;
      }

      if (!r.ok) {
        const corpo = (await r.json().catch(() => null)) as RespostaPatch | null;
        if (corpo?.detalhes) setErrosCampo(corpo.detalhes);
        setErro(corpo?.error ?? `Não foi possível salvar (HTTP ${r.status})`);
        return;
      }

      onSalvo();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha de rede ao salvar o cadastro");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onFechar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editar-operacao-titulo"
        className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[86vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 id="editar-operacao-titulo" className="text-sm font-bold">
            Editar cadastro — {operacao.codigo}
          </h3>
          <button onClick={onFechar} className="p-1 rounded hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {erro && (
            <p role="alert" className="flex items-center gap-1.5 text-xs text-red-600">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" /> {erro}
            </p>
          )}

          {/* Imutáveis: mostrar dá contexto; editar não existe (chave de negócio
              e proveniência do seed — R4 os recusa/ignora). */}
          <div className="grid grid-cols-2 gap-3">
            <CampoRO rotulo="Código" valor={operacao.codigo} />
            <CampoRO rotulo="Origem" valor={ORIGEM_OPERACAO_LABELS[operacao.origem]} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <CampoTexto
              rotulo="Cliente (nome)"
              valor={clienteNome}
              onChange={setClienteNome}
              erro={errosCampo.clienteNome}
              inputRef={primeiroCampoRef}
            />
            <CampoTexto
              rotulo="Grupo do cliente"
              valor={clienteGrupo}
              onChange={setClienteGrupo}
              erro={errosCampo.clienteGrupo}
            />
            <CampoTexto
              rotulo="CNPJ do cliente (14 dígitos)"
              valor={clienteCnpj}
              onChange={setClienteCnpj}
              erro={errosCampo.clienteCnpj}
            />
            <CampoTexto
              rotulo="Contrato nº"
              valor={contratoNumero}
              onChange={setContratoNumero}
              erro={errosCampo.contratoNumero}
              inputRef={contratoRef}
            />
            <CampoTexto
              rotulo="Unidade / local"
              valor={unidade}
              onChange={setUnidade}
              erro={errosCampo.unidade}
            />
            {/* B5 — texto livre, como `unidade`: não há catálogo de áreas nesta
                onda, e a normalização, se vier, é migration futura (§1l). */}
            <CampoTexto
              rotulo="Área da planta"
              valor={area}
              onChange={setArea}
              erro={errosCampo.area}
            />
            <label className="block text-xs text-gray-600">
              <span className="font-semibold uppercase tracking-wide text-[10px] text-gray-400">
                Detentora
              </span>
              <select
                value={detentora}
                onChange={(e) => setDetentora(e.target.value as Detentora)}
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              >
                {DETENTORAS.map((d) => (
                  <option key={d} value={d}>
                    {DETENTORA_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
            <CampoTexto rotulo="Ramo" valor={ramo} onChange={setRamo} erro={errosCampo.ramo} />
            <label className="block text-xs text-gray-600">
              <span className="font-semibold uppercase tracking-wide text-[10px] text-gray-400">
                Onshore / offshore
              </span>
              <select
                value={onshoreOffshore}
                onChange={(e) => setOnshoreOffshore(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              >
                <option value="">—</option>
                <option value="ONSHORE">ONSHORE</option>
                <option value="OFFSHORE">OFFSHORE</option>
              </select>
              {errosCampo.onshoreOffshore && <ErroCampo msg={errosCampo.onshoreOffshore} />}
            </label>
            <CampoTexto
              rotulo="Período — início"
              tipo="date"
              valor={periodoInicio}
              onChange={setPeriodoInicio}
              erro={errosCampo.periodoInicio}
            />
            <CampoTexto
              rotulo="Período — fim"
              tipo="date"
              valor={periodoFim}
              onChange={setPeriodoFim}
              erro={errosCampo.periodoFim}
            />
            <CampoTexto
              rotulo="Valor (R$)"
              valor={valor}
              onChange={setValor}
              erro={errosCampo.valor}
              inputMode="decimal"
            />
            <CampoTexto
              rotulo="Homem-hora (HH)"
              valor={hh}
              onChange={setHh}
              erro={errosCampo.hh}
              inputMode="decimal"
            />
          </div>

          <label className="block text-xs text-gray-600">
            <span className="font-semibold uppercase tracking-wide text-[10px] text-gray-400">
              Escopo (objeto do contrato)
            </span>
            <textarea
              value={escopo}
              onChange={(e) => setEscopo(e.target.value)}
              rows={4}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            />
            {errosCampo.escopo && <ErroCampo msg={errosCampo.escopo} />}
          </label>

          <label className="block text-xs text-gray-600">
            <span className="font-semibold uppercase tracking-wide text-[10px] text-gray-400">
              Famílias sugeridas (códigos CRC separados por vírgula)
            </span>
            <input
              type="text"
              value={familias}
              onChange={(e) => setFamilias(e.target.value)}
              placeholder="99000001, 99000002"
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 font-mono"
            />
            {errosCampo.familiasSugeridas && <ErroCampo msg={errosCampo.familiasSugeridas} />}
          </label>

          <label className="inline-flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={ativo}
              onChange={(e) => setAtivo(e.target.checked)}
              className="rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
            />
            Operação ativa
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-100">
          <Button variant="secondary" size="sm" onClick={onFechar} disabled={salvando}>
            Cancelar
          </Button>
          <Button size="sm" onClick={salvar} disabled={salvando}>
            {salvando ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Campos de apoio ──────────────────────────────────────────────────────────

function CampoRO({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="text-xs">
      <span className="font-semibold uppercase tracking-wide text-[10px] text-gray-400">
        {rotulo}
      </span>
      <p className="mt-1 px-3 py-2 text-sm bg-gray-50 border border-gray-100 rounded-lg text-gray-600 font-mono">
        {valor}
      </p>
      <p className="text-[10px] text-gray-400 mt-0.5">não pode ser alterado</p>
    </div>
  );
}

function ErroCampo({ msg }: { msg: string }) {
  return (
    <span role="alert" className="block text-[11px] text-red-600 mt-0.5">
      {msg}
    </span>
  );
}

function CampoTexto({
  rotulo,
  valor,
  onChange,
  erro,
  tipo = "text",
  inputMode,
  inputRef,
}: {
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
  erro?: string;
  tipo?: "text" | "date";
  inputMode?: "decimal";
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="block text-xs text-gray-600">
      <span className="font-semibold uppercase tracking-wide text-[10px] text-gray-400">
        {rotulo}
      </span>
      <input
        ref={inputRef}
        type={tipo}
        inputMode={inputMode}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "mt-1 w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30",
          erro ? "border-red-300" : "border-gray-200"
        )}
      />
      {erro && <ErroCampo msg={erro} />}
    </label>
  );
}
