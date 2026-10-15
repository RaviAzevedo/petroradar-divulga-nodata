"use client";

import { useState, useCallback, useEffect, useId } from "react";
import Link from "next/link";
import {
  X, Loader2, ExternalLink, AlertCircle, Building2,
} from "lucide-react";
import { useModalA11y } from "@/components/ui/useModalA11y";
import { cn, formatDate } from "@/lib/utils";
import { formatBRL, formatCNPJ, isValorSimbolico } from "@/lib/format";
import { config } from "@/lib/config";
import { ConfidenceBadge, type ConfidenceLevel } from "@/components/resultados/ConfidenceBadge";

interface Props {
  /** Pelo menos um dos dois deve ser passado. */
  numeroLicitacao?: string;
  resultadoId?:     string;
  licitacaoId?:     string;
  onClose:          () => void;
  /** Aceito por retrocompat com chamadas antigas — sem efeito. */
  tabInicial?:      string;
  podeRegistrar?:   boolean;
}

interface Proposta {
  posicao:         number;
  fornecedor:      string;
  cnpj:            string | null;
  itemNumero:      string | null;
  itemDescricao:   string | null;
  valorUnitario:   number | null;
  valorTotal:      number | null;
  meEpp:           boolean;
  declinou:        boolean;
  characteristic?: string | null;  // V2: 'Adjudicada', 'Homologada', 'Proposta não Avaliada', ...
}

interface ResultadoDetalhe {
  resultado: {
    id?:                 string;
    licitacaoId?:        string | null;
    numero?:             string;
    numeroLicitacao?:    string;
    objeto:              string | null;
    empresa:             string | null;
    segmento:            string | null;
    natureza:            string | null;
    fornecedorVencedor:  string | null;
    cnpjVencedor:        string | null;
    valorVencedor:       number | null;
    /** Valor REAL do contrato (Portal da Transparência) — preferido quando >0. */
    valorContratoReal?:     number | null;
    contratoTransparencia?: string | null;
    contratoVigenciaFim?:   string | null;
    /** Vencedor + metadados do contrato assinado (migration 0020) — fallback
        rotulado quando o Petronect ainda não expôs o vencedor. */
    contratoFornecedor?:     string | null;
    contratoCnpj?:           string | null;
    contratoSituacao?:       string | null;
    contratoAditivos?:       number | null;
    contratoMoeda?:          string | null;
    contratoVigenciaInicio?: string | null;
    statusResultado:     string | null;
    confidenceLevel?:    ConfidenceLevel;
    totalParticipantes:  number | null;
    totalPropostas?:     number | null;
    detectadoEm?:        string | null;
    subStatus?:          string | null;
    disputeMode?:        string | null;
    endDate?:            string | null;
    isEqualized?:        boolean | null;
  };
  propostas: Proposta[];
}

const SUB_STATUS_LABEL: Record<string, string> = {
  "01": "Aguardando Lance", "02": "Aberto p/ Lance", "03": "Em Disputa",
  "04": "Em Análise", "05": "Resultado Divulgado", "06": "Habilitação",
};
const DM_LABEL: Record<string, string> = { "01": "Aberta", "02": "Fechada", "03": "Pregão" };

/** Formata o valor REAL do contrato respeitando a moeda do Portal da
    Transparência — contratos podem ser em US$; fora de "R$" não usa formatBRL. */
function formatValorContrato(valor: number, moeda?: string | null): string {
  if (moeda && moeda !== "R$") {
    return `${moeda} ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
  }
  return formatBRL(valor);
}

/**
 * Modal de detalhe de licitação — versão simplificada.
 *
 * Mostra apenas duas seções (sem tabs, scroll único):
 *   1) Resumo — vencedor, valor, status, KPIs
 *   2) Propostas — tabela agrupada por item, com badge de characteristic
 *
 * Removidos: linha do tempo de eventos, análise IA (por decisão do produto).
 */
export function LicitacaoDetalheModal({
  numeroLicitacao, resultadoId, licitacaoId, onClose,
}: Props) {
  const [resolvedResultadoId, setResolvedResultadoId] = useState<string | null>(resultadoId ?? null);
  const [resolvedLicitacaoId, setResolvedLicitacaoId] = useState<string | null>(licitacaoId ?? null);
  const [resolvedNumero,      setResolvedNumero]      = useState<string | null>(numeroLicitacao ?? null);
  const [carregandoIds, setCarregandoIds] = useState(!resultadoId);

  const [detalhe, setDetalhe] = useState<ResultadoDetalhe | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro]       = useState<string | null>(null);

  // Resolve IDs faltantes (só temos numeroLicitacao)
  useEffect(() => {
    if (resolvedResultadoId || !numeroLicitacao) return;
    setCarregandoIds(true);
    fetch(`/api/resultados?search=${encodeURIComponent(numeroLicitacao)}&limit=1`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const first = j.data?.[0];
        if (first) {
          setResolvedResultadoId(first.id ?? first.numeroLicitacao);
          setResolvedLicitacaoId(first.licitacaoId ?? null);
          setResolvedNumero(first.numeroLicitacao);
        } else {
          setErro("Resultado não encontrado para esta licitação");
        }
      })
      .catch(() => setErro("Falha ao localizar resultado"))
      .finally(() => setCarregandoIds(false));
  }, [numeroLicitacao, resolvedResultadoId]);

  // Carrega detalhe (resumo + propostas)
  const carregar = useCallback(async () => {
    if (!resolvedResultadoId) return;
    setLoading(true);
    setErro(null);
    try {
      const r = await fetch(`/api/resultados/${resolvedResultadoId}`);
      if (!r.ok) throw new Error(`Erro ${r.status}`);
      setDetalhe(await r.json());
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar detalhe");
    } finally {
      setLoading(false);
    }
  }, [resolvedResultadoId]);

  useEffect(() => { carregar(); }, [carregar]);

  // a11y: focus trap, foco inicial, retorno de foco e Escape (base comum)
  const { dialogRef, handleTrapTab } = useModalA11y({ active: true, onClose });
  const tituloId = useId();

  const r = detalhe?.resultado;
  const numero = r?.numero ?? r?.numeroLicitacao ?? resolvedNumero;
  const venceuProponente = r?.cnpjVencedor?.replace(/\D/g, "") === config.proponente.cnpj;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col"
      >
        {/* Header — minimalista */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200">
          <div id={tituloId} className="min-w-0 flex-1">
            {(loading || carregandoIds) && !r ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
              </div>
            ) : r ? (
              <>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-mono text-sm font-bold text-brand-black">{numero}</span>
                  <ConfidenceBadge level={r.confidenceLevel ?? null} statusResultado={r.statusResultado} />
                  {venceuProponente && (
                    <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-semibold rounded ring-1 ring-emerald-200/70">
                      Proponente venceu
                    </span>
                  )}
                </div>
                {r.objeto && (
                  <p className="text-sm text-gray-600 line-clamp-2 max-w-3xl" title={r.objeto}>
                    {r.objeto}
                  </p>
                )}
              </>
            ) : (
              <span className="text-sm text-gray-500">{resolvedNumero ?? "Licitação"}</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {resolvedLicitacaoId && (
              <Link
                href={`/licitacoes/${resolvedLicitacaoId}`}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-brand-orange hover:bg-orange-50 rounded transition-colors"
                title="Abrir página completa"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Página
              </Link>
            )}
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded transition-colors"
              aria-label="Fechar"
            >
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Conteúdo */}
        <div className="flex-1 overflow-y-auto">
          {erro && (
            <div className="m-6 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" /> {erro}
            </div>
          )}

          {loading && !erro && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-brand-orange" />
            </div>
          )}

          {!loading && !erro && detalhe && r && (
            <div className="p-6 space-y-8">
              <SecaoResumo detalhe={detalhe} venceuProponente={venceuProponente} />
              <SecaoPropostas propostas={detalhe.propostas} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Seção 1: Resumo ─────────────────────────────────────────────────────

function SecaoResumo({
  detalhe, venceuProponente,
}: { detalhe: ResultadoDetalhe; venceuProponente: boolean }) {
  const r = detalhe.resultado;

  const subStatusLabel = r.subStatus ? (SUB_STATUS_LABEL[r.subStatus] ?? r.subStatus) : null;
  const dmLabel        = r.disputeMode ? (DM_LABEL[r.disputeMode] ?? r.disputeMode) : null;

  // Fallback rotulado: vencedor segundo o contrato assinado (Portal da
  // Transparência) quando a coleta Petronect ainda não expôs o resultado.
  const vencedorViaContrato = !r.fornecedorVencedor && !!r.contratoFornecedor;
  const vencedorNome = r.fornecedorVencedor ?? r.contratoFornecedor ?? null;
  const vencedorCnpj = vencedorViaContrato ? (r.contratoCnpj ?? null) : r.cnpjVencedor;

  // Linha discreta de metadados do contrato: situação · N aditivo(s) · vigência.
  const contratoMeta = [
    r.contratoSituacao || null,
    r.contratoAditivos != null && r.contratoAditivos > 0
      ? `${r.contratoAditivos} aditivo${r.contratoAditivos > 1 ? "s" : ""}`
      : null,
    r.contratoVigenciaInicio && r.contratoVigenciaFim
      ? `vigência ${formatDate(r.contratoVigenciaInicio)}–${formatDate(r.contratoVigenciaFim)}`
      : r.contratoVigenciaInicio
        ? `vigência início ${formatDate(r.contratoVigenciaInicio)}`
        : null,
  ].filter(Boolean).join(" · ");

  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-3">Resumo</h3>

      {/* Cards de overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <InfoCard label="Empresa contratante"
                  valor={r.empresa ?? "—"} />
        <InfoCard label="Modalidade"
                  valor={dmLabel ?? r.natureza ?? "—"} />
        <InfoCard label="Fase"
                  valor={subStatusLabel ?? "—"} />
        <InfoCard label="Participantes"
                  valor={r.totalParticipantes != null ? String(r.totalParticipantes) : "—"} />
      </div>

      {/* Bloco do vencedor — aparece também no fallback via contrato assinado */}
      {vencedorNome ? (
        <div className={cn(
          "rounded-lg p-4 border",
          venceuProponente
            ? "bg-emerald-50 border-emerald-200"
            : "bg-slate-50 border-slate-200",
        )}>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-500 mb-1.5">
            {venceuProponente ? "Proponente venceu" : "Vencedor"}
          </p>
          <div className="flex items-start gap-2.5">
            <Building2
              className={cn("h-4 w-4 mt-0.5 flex-shrink-0",
                venceuProponente ? "text-emerald-600" : "text-slate-500")}
            />
            <div className="flex-1 min-w-0">
              <p className={cn(
                "text-sm font-semibold",
                venceuProponente ? "text-emerald-900" : "text-slate-800",
              )}>
                {vencedorNome}
                {vencedorViaContrato && (
                  <span
                    className="align-middle ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 whitespace-nowrap"
                    title="Vencedor segundo o contrato assinado no Portal da Transparência — a coleta Petronect ainda não expôs o resultado"
                  >
                    Transparência
                  </span>
                )}
              </p>
              {vencedorCnpj && (
                <p className="text-[11px] text-gray-500 font-mono mt-0.5">
                  {formatCNPJ(vencedorCnpj)}
                </p>
              )}
              {r.valorContratoReal != null && r.valorContratoReal > 0 ? (
                /* Valor REAL do contrato (Portal da Transparência) — preferido.
                   O bloco "Valor simbólico" abaixo só aparece quando NÃO há real. */
                <div className="mt-2">
                  <p className="text-base font-bold text-emerald-700 tabular-nums">
                    {formatValorContrato(r.valorContratoReal, r.contratoMoeda)}
                    {isValorSimbolico(r.valorVencedor) && (
                      <span className="align-middle ml-2 text-[11px] font-normal text-gray-400 tabular-nums">
                        ranking: {formatBRL(r.valorVencedor)}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                    Valor real do contrato — Portal da Transparência (contrato{" "}
                    {r.contratoTransparencia}
                    {r.contratoVigenciaFim
                      ? `, vigência até ${formatDate(r.contratoVigenciaFim)}`
                      : ""})
                  </p>
                  {contratoMeta && (
                    <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">
                      {contratoMeta}
                    </p>
                  )}
                </div>
              ) : r.valorVencedor != null && (
                isValorSimbolico(r.valorVencedor) ? (
                  <div className="mt-2">
                    <p className="text-base font-bold text-gray-500 tabular-nums">
                      {formatBRL(r.valorVencedor)}{" "}
                      <span className="align-middle ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                        Valor simbólico
                      </span>
                    </p>
                    <p className="text-[11px] text-amber-700/90 mt-1 leading-snug">
                      Disputa fechada: o Petronect divulga apenas valores simbólicos de
                      ranking — o valor real do contrato é sigiloso.
                    </p>
                  </div>
                ) : (
                  <p className="text-base font-bold text-gray-800 mt-2 tabular-nums">
                    {formatBRL(r.valorVencedor)}
                  </p>
                )
              )}
              {r.statusResultado && (
                <p className="text-[10px] uppercase tracking-wider text-gray-400 mt-1.5">
                  {r.statusResultado}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg p-4 bg-slate-50 border border-slate-200 text-center">
          <p className="text-sm text-slate-500">
            Licitação em análise — sem vencedor definido pelo portal.
          </p>
          {r.endDate && (
            <p className="text-[11px] text-slate-400 mt-1">
              Data fim: {r.endDate}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Seção 2: Propostas ──────────────────────────────────────────────────

function SecaoPropostas({ propostas }: { propostas: Proposta[] }) {
  if (!propostas.length) {
    return (
      <section>
        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-3">Propostas</h3>
        <p className="text-sm text-gray-400 text-center py-8 bg-gray-50 rounded-lg border border-gray-100">
          Nenhuma proposta registrada para esta licitação.
        </p>
      </section>
    );
  }

  // Agrupa por item
  const groups = new Map<string, Proposta[]>();
  for (const p of propostas) {
    const key = p.itemNumero
      ? `${p.itemNumero}||${p.itemDescricao ?? ""}`
      : "__sem__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  // Padrão de disputa FECHADA: todos os valores publicados são centavos de
  // ranking (nenhum real). Sinaliza para o leitor não tratar como preço.
  const valoresConhecidos = propostas.map((p) => p.valorTotal).filter((v): v is number => v != null && v > 0);
  const todosSimbolicos = valoresConhecidos.length > 0 && valoresConhecidos.every((v) => v < 100);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">Propostas</h3>
        <span className="text-[11px] text-gray-400">{propostas.length} no total</span>
      </div>

      {todosSimbolicos && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 leading-snug">
          <strong>Valores simbólicos.</strong> Nesta disputa (modalidade fechada) o
          Petronect publica apenas centavos que indicam a ORDEM do ranking — os
          valores reais das propostas são sigilosos.
        </div>
      )}

      <div className="space-y-5">
        {Array.from(groups.entries()).map(([key, props]) => {
          const [itemNumero, itemDesc] = key === "__sem__" ? ["—", null] : key.split("||");
          const ordenadas = [...props].sort((a, b) => a.posicao - b.posicao);
          return (
            <div key={key} className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs font-bold text-gray-700">Item {itemNumero}</span>
                  {itemDesc && (
                    <span className="text-xs text-gray-500 truncate" title={itemDesc}>{itemDesc}</span>
                  )}
                </div>
                <span className="text-[10px] text-gray-400 flex-shrink-0">{ordenadas.length} propostas</span>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-white">
                  <tr className="border-b border-gray-100">
                    <th className="text-left  px-3 py-2 font-medium text-gray-500 w-10">#</th>
                    <th className="text-left  px-3 py-2 font-medium text-gray-500">Fornecedor</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-500">Valor total</th>
                    <th className="text-left  px-3 py-2 font-medium text-gray-500 hidden md:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ordenadas.map((p, i) => {
                    const ehProponente = p.cnpj?.replace(/\D/g, "") === config.proponente.cnpj;
                    const carac = (p.characteristic ?? "").trim();
                    const isAwarded = /Homolog|Adjudicad|Awarded/.test(carac);
                    const isInvalid = /Did Not Present|Não Apresentou|Desclassif|Declassified|Decline|Declinou/.test(carac);
                    return (
                      <tr key={i} className={cn(
                        "border-b border-gray-50",
                        ehProponente && "bg-orange-50/60",
                        isAwarded && "bg-emerald-50/50",
                        (p.declinou || isInvalid) && "text-gray-400",
                      )}>
                        <td className="px-3 py-2 tabular-nums font-semibold text-gray-600">{p.posicao}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className={cn(
                              "truncate max-w-[260px]",
                              (p.declinou || isInvalid) && "line-through",
                            )}>
                              {p.fornecedor}
                            </span>
                            {ehProponente && (
                              <span className="text-[9px] uppercase text-brand-orange font-bold flex-shrink-0">
                                (Proponente)
                              </span>
                            )}
                            {p.meEpp && (
                              <span className="text-[9px] bg-blue-50 text-blue-700 px-1 py-0.5 rounded ring-1 ring-blue-100 flex-shrink-0">
                                ME/EPP
                              </span>
                            )}
                          </div>
                          {p.cnpj && (
                            <p className="text-[9px] text-gray-400 font-mono mt-0.5">{formatCNPJ(p.cnpj)}</p>
                          )}
                        </td>
                        <td className={cn(
                          "px-3 py-2 text-right tabular-nums font-medium",
                          isAwarded && "text-emerald-700",
                        )}>
                          {p.valorTotal != null ? formatBRL(p.valorTotal) : "—"}
                        </td>
                        <td className="px-3 py-2 hidden md:table-cell">
                          {carac ? (
                            <CharacteristicPill text={carac} isAwarded={isAwarded} isInvalid={isInvalid} />
                          ) : (
                            <span className="text-[10px] text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CharacteristicPill({
  text, isAwarded, isInvalid,
}: { text: string; isAwarded: boolean; isInvalid: boolean }) {
  return (
    <span className={cn(
      "inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ring-1",
      isAwarded
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200/70"
        : isInvalid
          ? "bg-slate-50 text-slate-400 ring-slate-200/70 line-through"
          : "bg-slate-50 text-slate-600 ring-slate-200/70",
    )}>
      {text}
    </span>
  );
}

function InfoCard({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="bg-gray-50 border border-gray-100 rounded-md px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">{label}</p>
      <p className="text-sm font-semibold text-gray-800 truncate mt-0.5" title={valor}>{valor}</p>
    </div>
  );
}

// `formatDate` usado na vigência do contrato (Portal da Transparência).
;
