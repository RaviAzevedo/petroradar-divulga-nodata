"use client";

/**
 * Acordeão de UMA seção do dossiê (03-FRONTEND §5.4).
 *
 * Regras que o componente carrega:
 *  - teto de 8 linhas + rodapé "ver as outras N" (expande tudo, não pagina) —
 *    fita recolhida conta como 1 linha, então uma operação com mais de cem ART em poucas fitas
 *    de ano abre inteira sem virar lista de centenas de linhas;
 *  - com filtro local ativo, teto e recolhimento são SUSPENSOS: a seção mostra
 *    só as linhas que casam, achatadas (fita viraria ruído no meio da busca);
 *  - botão de download muda de cara quando a seção estoura teto de R12:
 *    "baixar seção" → "baixar em N partes" (o fatiamento é do chamador; aqui
 *    só se exibe estado e progresso).
 *
 * O estado inicial aberto/recolhido é do PAI (seções 7 e 8 nascem recolhidas;
 * 1–6 e 9 dependem do tamanho) — o componente não adivinha.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocDossie, FitaSub, SecaoMontada } from "./secoes";

/** Linhas visíveis antes do rodapé "ver as outras" — FICHA §3.2. */
const TETO_LINHAS = 8;

export interface EstadoDownloadSecao {
  baixando: boolean;
  /** "Gerando parte 2 de 3…" quando fatiado; "Gerando ZIP..." quando inteiro. */
  rotuloProgresso: string | null;
}

interface Props {
  secao: SecaoMontada;
  aberta: boolean;
  onToggle: () => void;
  /** Docs a exibir quando há filtro local (§5.9); null = sem filtro. */
  docsFiltrados: DocDossie[] | null;
  /** Quantas chamadas de R12 a seção exige (1 = cabe num ZIP só). */
  partesDownload: number;
  download: EstadoDownloadSecao;
  onBaixar: () => void;
  renderLinha: (doc: DocDossie) => ReactNode;
}

export function SecaoDossie({
  secao,
  aberta,
  onToggle,
  docsFiltrados,
  partesDownload,
  download,
  onBaixar,
  renderLinha,
}: Props) {
  const [verTudo, setVerTudo] = useState(false);
  const corpoId = `secao-corpo-${secao.numero}`;
  const filtroAtivo = docsFiltrados !== null;

  return (
    <section
      id={`secao-${secao.numero}`}
      aria-labelledby={`secao-titulo-${secao.numero}`}
      className="bg-white border border-gray-200 rounded-xl mb-3 overflow-hidden scroll-mt-24"
    >
      <div className="flex items-center gap-2 px-4 py-3 flex-wrap">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={filtroAtivo || aberta}
          aria-controls={corpoId}
          disabled={filtroAtivo}
          className="flex items-center gap-2.5 text-left min-w-0 flex-1 disabled:cursor-default"
        >
          {filtroAtivo || aberta ? (
            <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
          )}
          <span
            aria-hidden="true"
            className="h-6 w-6 rounded-md bg-gray-100 font-mono text-xs font-semibold text-gray-600 flex items-center justify-center flex-shrink-0"
          >
            {secao.numero}
          </span>
          <h2
            id={`secao-titulo-${secao.numero}`}
            className="text-sm font-semibold text-brand-black"
          >
            {secao.nome}
          </h2>
          <span className="text-xs text-gray-400 tabular-nums">
            ({secao.docs.length}
            {secao.naoContam > 0 && ` · ${secao.naoContam} não contam na barra`})
          </span>
          {secao.fitas !== null && secao.numero === 3 && (
            <span className="text-[10px] text-gray-400 uppercase tracking-wide">por ano</span>
          )}
        </button>

        {secao.docs.length > 0 && (
          <button
            type="button"
            onClick={onBaixar}
            disabled={download.baixando}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50 flex-shrink-0"
          >
            {download.baixando ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {download.rotuloProgresso ??
              (partesDownload > 1 ? `baixar em ${partesDownload} partes` : "baixar seção")}
          </button>
        )}
      </div>

      {(filtroAtivo || aberta) && (
        <div id={corpoId} className="px-4 pb-4">
          {secao.ordemProvisoria && !filtroAtivo && (
            <p className="text-xs text-gray-500 mb-2">
              ⓘ ordem provisória: nenhuma das {secao.docs.length} peças tem data de emissão
              preenchida.
            </p>
          )}

          {filtroAtivo ? (
            <div className="space-y-1.5">{docsFiltrados.map((d) => renderLinha(d))}</div>
          ) : (
            <CorpoComTeto
              secao={secao}
              verTudo={verTudo}
              onVerTudo={() => setVerTudo(true)}
              renderLinha={renderLinha}
            />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Corpo normal (sem filtro): fitas quando a seção as tem, linhas soltas quando
 * não. O teto conta LINHAS — fita recolhida vale 1 — e o rodapé fala em
 * DOCUMENTOS, que é a grandeza que o usuário entende.
 */
function CorpoComTeto({
  secao,
  verTudo,
  onVerTudo,
  renderLinha,
}: {
  secao: SecaoMontada;
  verTudo: boolean;
  onVerTudo: () => void;
  renderLinha: (doc: DocDossie) => ReactNode;
}) {
  if (secao.fitas !== null) {
    const fitasVisiveis = verTudo ? secao.fitas : secao.fitas.slice(0, TETO_LINHAS);
    const docsOcultos = secao.fitas
      .slice(fitasVisiveis.length)
      .reduce((acc, f) => acc + f.docs.length, 0);
    return (
      <div className="space-y-2">
        {fitasVisiveis.map((fita) => (
          <Fita key={fita.chave} secaoNumero={secao.numero} fita={fita} renderLinha={renderLinha} />
        ))}
        {docsOcultos > 0 && <RodapeVerMais quantos={docsOcultos} onClick={onVerTudo} />}
      </div>
    );
  }

  const visiveis = verTudo ? secao.docs : secao.docs.slice(0, TETO_LINHAS);
  const ocultos = secao.docs.length - visiveis.length;
  return (
    <div className="space-y-1.5">
      {visiveis.map((d) => renderLinha(d))}
      {ocultos > 0 && <RodapeVerMais quantos={ocultos} onClick={onVerTudo} />}
    </div>
  );
}

function RodapeVerMais({ quantos, onClick }: { quantos: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-center text-xs font-semibold text-gray-500 hover:text-brand-orange py-1.5 border border-dashed border-gray-200 rounded-md"
    >
      ver {quantos === 1 ? "a outra" : `as outras ${quantos}`} ▾
    </button>
  );
}

/** Acordeão interno da fita (ano na seção 3, tipo na 7). Nasce recolhida. */
function Fita({
  secaoNumero,
  fita,
  renderLinha,
}: {
  secaoNumero: number;
  fita: FitaSub;
  renderLinha: (doc: DocDossie) => ReactNode;
}) {
  const [aberta, setAberta] = useState(false);
  const corpoId = `fita-${secaoNumero}-${fita.chave}`;

  return (
    <div className="border border-gray-100 rounded-md">
      <button
        type="button"
        onClick={() => setAberta((v) => !v)}
        aria-expanded={aberta}
        aria-controls={corpoId}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left",
          aberta ? "bg-gray-50" : "hover:bg-gray-50"
        )}
      >
        {aberta ? (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
        )}
        <span className="text-xs font-semibold text-gray-700">{fita.rotulo}</span>
        <span className="text-xs text-gray-400 tabular-nums">
          ({fita.docs.length} documento{fita.docs.length !== 1 ? "s" : ""})
        </span>
      </button>
      {aberta && (
        <div id={corpoId} className="px-3 pb-2 space-y-1.5">
          {fita.docs.map((d) => renderLinha(d))}
        </div>
      )}
    </div>
  );
}
