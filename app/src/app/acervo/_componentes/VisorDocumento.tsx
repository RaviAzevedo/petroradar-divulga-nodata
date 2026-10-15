"use client";

/**
 * Prévia embutida de um documento do cofre (ACERVO-UI-V2 §2.1).
 *
 * Usa o contrato existente `GET .../download?inline=1` — o servidor só honra
 * inline para PDF/imagem/texto; para o resto este componente nem tenta e mostra
 * o painel "sem prévia" com o link de download (URL SEM query, que força
 * attachment). Skeleton cobre a área até o `onLoad` do object/img.
 */

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";

export interface VisorDocumentoProps {
  docId: string;
  nomeArquivo: string;
  contentType?: string | null;
  alturaClassName?: string; // default "h-[60vh] min-h-[320px]"
  /**
   * Página inicial — só PDF (PDF Open Parameters `#page=N`: o visor nativo do
   * Chromium/Firefox honra o fragmento em <object>; ele NÃO chega ao servidor,
   * a rota de download não muda). Ausente/null/inválida = comportamento de
   * sempre: mesma URL, mesma key.
   */
  pagina?: number | null;
}

const TIPOS_IMAGEM = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXTENSAO_IMAGEM = /\.(png|jpe?g|gif|webp)$/i;

export function VisorDocumento({
  docId,
  nomeArquivo,
  contentType,
  alturaClassName = "h-[60vh] min-h-[320px]",
  pagina,
}: VisorDocumentoProps) {
  const nome = nomeArquivo.toLowerCase();
  const ehPdf = contentType === "application/pdf" || nome.endsWith(".pdf");
  const ehImagem =
    !ehPdf && ((contentType != null && TIPOS_IMAGEM.has(contentType)) || EXTENSAO_IMAGEM.test(nome));

  // Só PDF abre numa página, e só inteiro ≥ 1 — lixo na URL de um link velho
  // (p. 0, "abc") é ignorado, nunca quebra a prévia.
  const paginaValida =
    ehPdf && typeof pagina === "number" && Number.isInteger(pagina) && pagina >= 1 ? pagina : null;
  // Key do <object>: com página, trocar de página remonta o visor (é um GET
  // novo do arquivo); sem página é o `docId` de sempre — os consumidores que
  // não passam `pagina` remontam exatamente como antes.
  const chaveVisor = paginaValida ? `${docId}#${paginaValida}` : docId;

  const [carregado, setCarregado] = useState(false);
  const [falhou, setFalhou] = useState(false);

  // Navegar para outro doc (ou outra página) reinicia o skeleton — o object/img
  // remonta via key. Ajuste DURANTE o render (padrão "adjusting state when a
  // prop changes" do React), não em effect: um setState síncrono em effect
  // pintaria um frame com o estado do doc anterior antes de zerar.
  const [chaveAnterior, setChaveAnterior] = useState(chaveVisor);
  if (chaveVisor !== chaveAnterior) {
    setChaveAnterior(chaveVisor);
    setCarregado(false);
    setFalhou(false);
  }

  // Rede/5xx no inline não disparam onLoad (e <object> não tem onError
  // confiável): sem pintura em 15s, troca o pulso pelo painel de download.
  // Depende da chave (doc + página): trocar de página reinicia os 15 s.
  useEffect(() => {
    if (carregado || falhou) return;
    const t = setTimeout(() => setFalhou(true), 15000);
    return () => clearTimeout(t);
  }, [carregado, falhou, chaveVisor]);

  // O fragmento fica no client: o navegador não o manda na requisição.
  const urlInline =
    `/api/conformidade/cofre/documentos/${docId}/download?inline=1` +
    (paginaValida ? `#page=${paginaValida}` : "");
  const urlDownload = `/api/conformidade/cofre/documentos/${docId}/download`;

  if (falhou && !carregado && (ehPdf || ehImagem)) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center",
          alturaClassName
        )}
      >
        <FileText className="h-8 w-8 text-gray-300" aria-hidden="true" />
        <p className="text-sm font-medium text-gray-700 break-all">{nomeArquivo}</p>
        <p className="text-xs text-gray-500">Não foi possível carregar a prévia.</p>
        <a href={urlDownload} className="text-xs font-semibold text-brand-orange hover:underline">
          Baixar arquivo
        </a>
      </div>
    );
  }

  if (ehPdf) {
    return (
      <div className={cn("relative rounded-lg overflow-hidden", alturaClassName)}>
        {/* Atrás do object: enquanto o PDF não pinta, o object é transparente e
            o pulso aparece; se o inline falhar, o fallback fica legível por cima. */}
        {!carregado && <Skeleton className="absolute inset-0" />}
        <object
          key={chaveVisor}
          data={urlInline}
          type="application/pdf"
          onLoad={() => setCarregado(true)}
          className="relative w-full h-full"
          aria-label={`Prévia de ${nomeArquivo}`}
        >
          <p className="p-6 text-sm text-gray-500 text-center">
            Não foi possível visualizar o PDF aqui.
            <a href={urlDownload} className="text-brand-orange ml-1 hover:underline">
              Baixar arquivo
            </a>
          </p>
        </object>
      </div>
    );
  }

  if (ehImagem) {
    return (
      <div
        className={cn(
          "relative flex items-center justify-center rounded-lg bg-gray-100 overflow-hidden",
          alturaClassName
        )}
      >
        {!carregado && <Skeleton className="absolute inset-0" />}
        {/* eslint-disable-next-line @next/next/no-img-element -- blob autenticado do cofre, fora do otimizador */}
        <img
          key={docId}
          src={urlInline}
          alt={nomeArquivo}
          onLoad={() => setCarregado(true)}
          onError={() => setFalhou(true)}
          className="relative max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center",
        alturaClassName
      )}
    >
      <FileText className="h-8 w-8 text-gray-300" aria-hidden="true" />
      <p className="text-sm font-medium text-gray-700 break-all">{nomeArquivo}</p>
      <p className="text-xs text-gray-500">Prévia não disponível para este formato.</p>
      <a href={urlDownload} className="text-xs font-semibold text-brand-orange hover:underline">
        Baixar arquivo
      </a>
    </div>
  );
}
