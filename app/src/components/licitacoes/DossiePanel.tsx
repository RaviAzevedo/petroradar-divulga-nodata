"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Sparkles, RefreshCw, Loader2, Package } from "lucide-react";

interface DossieProps {
  licitacaoId: string;
  /** Já existe análise persistida (analises_ia): baixar de novo não custa IA. */
  jaAnalisada: boolean;
  /** Algum anexo já tem texto extraído — só muda a frase de orientação. */
  temTexto: boolean;
  /** Habilita o "Refazer análise" (gasta API da Anthropic de novo). */
  podePropor?: boolean;
  /**
   * Geração de briefing/dossiê por IA ligada (FEATURE_BRIEFING_IA=1 no servidor).
   * Desligada, escondemos os botões em vez de deixar o usuário clicar e tomar
   * 503 — a rota barra de qualquer jeito, isto é só a UI honesta.
   */
  briefingHabilitado?: boolean;
}

/** Nome do arquivo vindo do Content-Disposition da rota (ex.: DOSSIE_7004990101.zip). */
function nomeDoHeader(contentDisposition: string | null): string | null {
  const m = contentDisposition?.match(/filename="?([^"]+)"?/i);
  return m?.[1] ?? null;
}

/**
 * Salva o corpo de uma Response como download, via blob + <a download>.
 *
 * Não usar window.open: o dossiê termina depois de um await longo (baixar anexos
 * + IA), e um window.open disparado FORA do gesto de clique é tratado como pop-up
 * e bloqueado pelo navegador. O clique sintético num <a download> não é pop-up.
 */
async function baixarBlob(res: Response, nomeFallback: string): Promise<void> {
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = nomeDoHeader(res.headers.get("content-disposition")) ?? nomeFallback;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revogar na hora aborta o download em alguns navegadores — solta depois.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * Dossiê da licitação — UM clique faz o pipeline inteiro.
 *
 * POST /dossie baixa os anexos do Petronect, extrai o texto, manda tudo para o
 * Claude e devolve UM zip com o briefing em PDF, o CHECK-LIST oficial e os
 * documentos originais. A análise em si vive no briefing PDF; até 2026-09 ela
 * também era exibida nesta tela (painel "Análise IA"), que saiu na limpeza geral.
 *
 * É o único lugar do produto que gasta token da Anthropic — a trava de verdade
 * está no servidor (lib/ia/gate.ts), não aqui.
 */
export function DossiePanel({
  licitacaoId, jaAnalisada, temTexto, podePropor = false, briefingHabilitado = false,
}: DossieProps) {
  const router = useRouter();
  const [gerando, setGerando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function gerarDossie(force: boolean = false) {
    setGerando(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/licitacoes/${licitacaoId}/dossie`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `confirmar` é o pedágio da rota: sem ele, ela recusa (400) e não gasta.
        // Existe para que um POST sem corpo — a sonda do harness de paridade, um
        // curl, um retry automático — não dispare Petronect + Haiku + Sonnet.
        body: JSON.stringify({ confirmar: true, force }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error?.message ?? `Falha ao gerar o dossiê (HTTP ${res.status})`);
        return;
      }

      // Telemetria que a rota devolve nos headers — evita abrir o ZIP só para
      // descobrir se algum anexo ficou de fora.
      const docs = res.headers.get("X-Dossie-Documentos") ?? "0";
      const pend = Number(res.headers.get("X-Dossie-Pendencias") ?? "0");
      const reaproveitada = res.headers.get("X-Dossie-Analise-Reaproveitada") === "true";

      await baixarBlob(res, `DOSSIE_${licitacaoId}.zip`);

      const partes = [`Dossiê baixado com ${docs} documento(s)`];
      if (pend > 0) partes.push(`${pend} pendência(s) — veja o 00_LEIA-ME.txt`);
      if (reaproveitada) partes.push("análise reaproveitada (sem novo custo de IA)");
      setMsg(`${partes.join(" · ")}.`);

      // A análise agora existe no banco: o RSC da página passa jaAnalisada=true.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setGerando(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-base font-semibold text-brand-black flex items-center gap-2">
          <Package className="h-4 w-4 text-brand-orange" /> Dossiê
        </h2>
        {briefingHabilitado && jaAnalisada && (
          <div className="flex gap-2">
            {/* Rebaixar NÃO custa nada: a rota reaproveita a análise persistida e
                só remonta o ZIP. Quem paga de novo é o "Refazer". */}
            <Button size="sm" onClick={() => gerarDossie(false)} disabled={gerando}>
              {gerando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
              {gerando ? "Gerando…" : "Baixar dossiê"}
            </Button>
            {podePropor && (
              <button
                onClick={() => gerarDossie(true)}
                disabled={gerando}
                title="Rebaixa os anexos e refaz a análise do zero. ATENÇÃO: consome API da Anthropic de novo (~US$ 0,15)."
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {gerando ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refazer análise
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {!briefingHabilitado ? (
        <p className="text-sm text-gray-500">
          A geração de briefing/dossiê por IA está <strong>temporariamente desabilitada</strong>.
          Go/No-Go e GAP de habilitação seguem disponíveis abaixo.
        </p>
      ) : jaAnalisada ? (
        <p className="text-sm text-gray-500">
          ZIP com o <strong>briefing em PDF</strong>, o <strong>CHECK-LIST oficial</strong> e os
          documentos originais. A análise desta licitação já foi feita — baixar de novo não gera custo de IA.
        </p>
      ) : (
        <div className="text-center py-4">
          <p className="text-sm text-gray-500 mb-1">
            Um clique baixa os documentos da licitação, manda tudo para o Claude analisar e devolve um{" "}
            <strong>ZIP</strong> com o <strong>briefing em PDF</strong>, o{" "}
            <strong>CHECK-LIST oficial</strong> e os documentos originais.
          </p>
          <p className="text-xs text-gray-400 mb-4">
            {temTexto
              ? "Os anexos já estão baixados — a análise usa o texto deles."
              : "Os anexos ainda não foram baixados; o dossiê baixa sozinho antes de analisar."}
          </p>
          <button
            onClick={() => gerarDossie(false)}
            disabled={gerando}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-brand-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {gerando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {gerando ? "Analisando com Claude… (pode levar 1–2 min)" : "Gerar dossiê com IA"}
          </button>
        </div>
      )}

      {(gerando || msg) && (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900 flex items-center gap-2">
          {gerando ? (
            <>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              Baixando os documentos, analisando com o Claude e montando o dossiê…
            </>
          ) : (
            msg
          )}
        </div>
      )}
    </div>
  );
}
