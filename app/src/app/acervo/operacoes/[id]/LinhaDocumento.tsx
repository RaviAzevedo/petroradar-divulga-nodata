"use client";

/**
 * Linha v2 do documento na ficha (03-FRONTEND §5.5 + ACERVO-UI-V2 §3).
 *
 * Linha 1: título (botão que abre a GavetaDocumento com a prévia, sem sair da
 * ficha) + nº do documento + chips que dizem algo — tipo, situação (forçada
 * nas seções 2/3), família, detentora divergente da operação (a marca
 * anti-falso-positivo do ESTUDO §3.4) e cadeado de restrito. O ícone
 * `ExternalLink` segue para a página completa do cofre. Linha 2: tamanho ·
 * versão · emitida em · guardada em.
 *
 * Checkbox de seleção só nas seções 2 e 3 (vínculo de família em massa, §5.7).
 */

import Link from "next/link";
import { Download, ExternalLink, FileText, Lock } from "lucide-react";
import { cn, formatDate, diasRestantes } from "@/lib/utils";
import {
  DETENTORA_LABELS,
  type Detentora,
} from "@/lib/conformidade/operacoes";
import { ChipTipoDocumento } from "@/app/acervo/_componentes/ChipTipoDocumento";
import { StatusDocumentoBadge } from "@/components/conformidade/cofre/StatusDocumentoBadge";
import { SituacaoProvaBadge } from "./SituacaoProvaBadge";
import { formatarTamanhoBytes, type DocDossie } from "./secoes";

const TITLE_RESTRITO =
  "Restrito — invisível fora da Conformidade; downloads ficam em auditoria permanente.";

interface Props {
  doc: DocDossie;
  /** Detentora da OPERAÇÃO — o chip do documento só aparece quando diverge. */
  operacaoDetentora: Detentora;
  secaoNumero: number;
  selecionavel: boolean;
  selecionado: boolean;
  onToggleSelecao?: (id: string) => void;
  onClickFamilia?: (doc: DocDossie) => void;
  /** Clique no título — a ficha abre a GavetaDocumento neste documento. */
  onAbrir: (doc: DocDossie) => void;
  /** Falha do vínculo em massa desta linha ("veja o motivo na linha" — §5.7). */
  erroVinculo?: string | null;
}

export function LinhaDocumento({
  doc,
  operacaoDetentora,
  secaoNumero,
  selecionavel,
  selecionado,
  onToggleSelecao,
  onClickFamilia,
  onAbrir,
  erroVinculo,
}: Props) {
  const tamanho = formatarTamanhoBytes(doc.tamanhoBytes);
  const secaoDeProva = secaoNumero === 2 || secaoNumero === 3;
  const vencido =
    secaoNumero === 4 && doc.validadeFim !== null && (diasRestantes(doc.validadeFim) ?? 0) < 0;

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-2 p-2 border border-gray-100 rounded-md transition-colors",
        selecionado ? "bg-orange-50/40 border-orange-200" : "hover:bg-gray-50"
      )}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1">
        {selecionavel && (
          <input
            type="checkbox"
            checked={selecionado}
            onChange={() => onToggleSelecao?.(doc.id)}
            className="mt-1 rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
            aria-label={`Selecionar ${doc.titulo}`}
          />
        )}
        <FileText className="h-4 w-4 text-gray-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => onAbrir(doc)}
              aria-label={`Abrir prévia de ${doc.titulo}`}
              className="text-sm font-medium text-gray-800 hover:text-brand-orange text-left"
            >
              {doc.titulo}
            </button>
            {doc.numeroDocumento && (
              <span className="font-mono text-[11px] text-gray-500">nº {doc.numeroDocumento}</span>
            )}
            {/* B6 — a revisão fica ao lado do NÚMERO, não dos chips de
                classificação: número e revisão são a identidade que a
                engenharia carimbou; tipo, situação e família são o que NÓS
                dissemos sobre a peça. E jamais na linha de baixo, ao lado de
                `v{versao}`: aquilo é o versionamento de certidão do cofre, e
                "R1" ali pareceria segunda versão de um documento que nunca foi
                substituído (spec ONDA-5 §1h). */}
            {doc.revisao && (
              <span
                title="Revisão de engenharia, como carimbada no documento — não é a versão do cofre"
                className="px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 text-[10px] font-mono uppercase whitespace-nowrap"
              >
                {doc.revisao}
              </span>
            )}
            <ChipTipoDocumento tipo={doc.tipoDocumento} />
            {/* Sem forçar, o selo só sai quando a situação diz algo (fora da
                barra ou assinada) — é o "coluna só quando diz algo" da spec. */}
            <SituacaoProvaBadge situacao={doc.situacaoProva} forcarExibicao={secaoDeProva} />
            {vencido && <StatusDocumentoBadge status={doc.status} validadeFim={doc.validadeFim} size="sm" />}
            {secaoDeProva && (
              <ChipFamilia doc={doc} onClick={onClickFamilia} />
            )}
            {doc.detentora !== null && doc.detentora !== operacaoDetentora && (
              <span
                title={`Prova de ${DETENTORA_LABELS[doc.detentora]} em operação ${DETENTORA_LABELS[operacaoDetentora]} — confira antes de usar em habilitação.`}
                className="px-1.5 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap"
              >
                {DETENTORA_LABELS[doc.detentora]}
              </span>
            )}
            {doc.restrito && (
              <span
                title={TITLE_RESTRITO}
                aria-label="Documento restrito"
                role="img"
                className="inline-flex flex-shrink-0"
              >
                <Lock className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {[
              tamanho,
              doc.versao > 1 ? `v${doc.versao}` : null,
              doc.emitidoEm ? `emitida em ${formatDate(doc.emitidoEm)}` : null,
              `guardada em ${formatDate(doc.criadoEm)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {erroVinculo && (
            <p role="alert" className="text-xs text-red-600 mt-0.5">
              {erroVinculo}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Link
          href={`/acervo/cofre/${doc.id}`}
          aria-label={`Abrir página completa de ${doc.titulo}`}
          title="Abrir página completa"
          className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        <a
          href={`/api/conformidade/cofre/documentos/${doc.id}/download`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-md bg-white hover:bg-gray-50"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Baixar
        </a>
      </div>
    </div>
  );
}

/**
 * Chip de família CRC (§5.7): primeira família + "+N" quando várias;
 * "[sem família]" cinza quando nenhuma. Clique abre o modal de vínculo sem
 * sair da ficha (o chamador faz o POST e recarrega).
 */
function ChipFamilia({ doc, onClick }: { doc: DocDossie; onClick?: (doc: DocDossie) => void }) {
  const conteudo =
    doc.familias.length > 0 ? (
      <>
        <span className="font-mono">{doc.familias[0].codigo}</span>
        {doc.familias.length > 1 && <span className="ml-0.5">+{doc.familias.length - 1}</span>}
      </>
    ) : (
      <span className="italic">sem família</span>
    );

  const classes = cn(
    "px-1.5 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap",
    doc.familias.length > 0
      ? "border-gray-200 bg-white text-gray-700"
      : "border-gray-100 bg-gray-50 text-gray-400"
  );

  if (!onClick) return <span className={classes}>{conteudo}</span>;

  return (
    <button
      type="button"
      onClick={() => onClick(doc)}
      title={
        doc.familias.length > 0
          ? `Famílias: ${doc.familias.map((f) => f.codigo).join(", ")} — clique para vincular outra`
          : "Sem família CRC — clique para vincular"
      }
      className={cn(classes, "hover:border-brand-orange hover:text-brand-orange")}
    >
      {conteudo}
    </button>
  );
}
