"use client";

/**
 * Upload sem sair da ficha (ACERVO-UI-V2 §3.1): painel lateral no padrão da
 * GavetaDocumento com a operação TRAVADA no topo. O cérebro é o MESMO do
 * /acervo/cofre/novo — `lote.ts` (palpites, validação, multipart, XHR com
 * progresso, dup-check) e o próprio `LinhaArquivoCard`; o /novo segue de pé
 * para o upload transversal do cofre.
 *
 * `tipoInicial`/`papelInicial` chegam dos CTAs de lacuna (contrato/atestado/
 * ART); `arquivosIniciais` chega do drag-and-drop global da página. O painel
 * fica montado junto da ficha: fechar sem enviar preserva o lote em edição.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, RefreshCw, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import {
  classificarRelacao,
  DETENTORA_LABELS,
  sha256Hex,
  type Detentora,
  type DocumentoNoCofre,
  type DuplicataNoCofre,
  type PapelDocumento,
  type RelacaoArquivo,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { LinhaArquivoCard, type CampoAplicavel } from "@/app/acervo/cofre/novo/LinhaArquivoCard";
import {
  criarLinha,
  emBlocos,
  executarComLimite,
  mensagemDoErro,
  montarFormData,
  mudancaDeTipo,
  papelNaoVence,
  paraArquivoDoLote,
  subirDocumento,
  validarLinha,
  type LinhaArquivo,
} from "@/app/acervo/cofre/novo/lote";

/** Uploads simultâneos — ver o comentário de `executarComLimite` em lote.ts. */
const MAX_EM_PARALELO = 3;

/** /verificar aceita no máximo 50 hashes por chamada. */
const HASHES_POR_CHAMADA = 50;

/** Mesmo teto do POST do cofre — recusar aqui poupa um 413 no meio do lote. */
const LIMITE_ARQUIVO_BYTES = 50 * 1024 * 1024;

const EXTENSAO_ACEITA = /\.(pdf|xlsx?|docx?)$/i;

/** Erro de um campo → chave do erro que a linha exibe (cópia do novo/, não exportada lá). */
const CAMPO_PARA_ERRO: Partial<Record<keyof LinhaArquivo, string>> = {
  titulo:                "titulo",
  numeroDocumento:       "numeroDocumento",
  validadeFim:           "validadeFim",
  validadeIndeterminada: "validadeFim",
  tipoDocumento:         "tipoDocumento",
  situacaoProva:         "situacaoProva",
  restrito:              "restrito",
};

/** Resposta de POST /api/conformidade/cofre/documentos/verificar. */
interface RespostaVerificar {
  existentes?: Record<
    string,
    { id: string; titulo: string; criadoEm: string | null; operacaoCodigo: string | null }
  >;
  error?: string;
}

export interface GavetaUploadProps {
  operacao: { id: string; codigo: string; clienteNome: string; detentora: Detentora };
  aberta: boolean;
  onFechar(): void;
  /** ≥1 documento entrou no cofre — a ficha recarrega o dossiê. */
  onConcluido(): void;
  /** CTAs de lacuna: contrato/atestado/ART já chegam com o tipo decidido. */
  tipoInicial?: TipoDocumento;
  papelInicial?: PapelDocumento;
  /** Vindos do drag-and-drop na página. */
  arquivosIniciais?: File[];
}

export function GavetaUpload({
  operacao,
  aberta,
  onFechar,
  onConcluido,
  tipoInicial,
  papelInicial,
  arquivosIniciais,
}: GavetaUploadProps) {
  const tituloId = useId();

  const [linhas, setLinhas] = useState<LinhaArquivo[]>([]);
  const [existentesPorSha, setExistentesPorSha] = useState<Record<string, DuplicataNoCofre>>({});
  const [docsDaOperacao, setDocsDaOperacao] = useState<DocumentoNoCofre[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [erroArquivos, setErroArquivos] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");
  const [sobreDropzone, setSobreDropzone] = useState(false);

  /** Hashes já perguntados ao cofre — evita repetir /verificar a cada arquivo novo. */
  const shasVerificados = useRef<Set<string>>(new Set());
  /** Última leva de `arquivosIniciais` já ingerida (identidade do array). */
  const iniciaisRef = useRef<File[] | null>(null);
  const fecharTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enviandoRef = useRef(false);

  useEffect(() => () => {
    if (fecharTimerRef.current) clearTimeout(fecharTimerRef.current);
  }, []);

  // Slide de entrada: monta fora da tela e transiciona no frame seguinte
  // (rAF duplo garante que o estado inicial foi pintado antes da transição).
  const [entrou, setEntrou] = useState(false);
  useEffect(() => {
    if (!aberta) {
      setEntrou(false);
      return;
    }
    let rafInterno = 0;
    const raf = requestAnimationFrame(() => {
      rafInterno = requestAnimationFrame(() => setEntrou(true));
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(rafInterno);
    };
  }, [aberta]);

  const fechar = useCallback(() => {
    if (enviandoRef.current) return;
    // Lote 100% no cofre não precisa reaparecer na próxima abertura.
    setLinhas((atuais) =>
      atuais.length > 0 && atuais.every((l) => l.estado === "ENVIADO") ? [] : atuais
    );
    setSucesso(null);
    onFechar();
  }, [onFechar]);

  const { dialogRef, handleTrapTab } = useModalA11y({ active: aberta, onClose: fechar });

  // Provas já guardadas da operação: alimentam `classificarRelacao` (versão/
  // irmã). Falhar aqui perde só o aviso prévio — o 409 do POST segue valendo.
  useEffect(() => {
    if (!aberta) return;
    let cancelado = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/conformidade/cofre/documentos?operacaoId=${encodeURIComponent(operacao.id)}&limit=200`
        );
        if (!r.ok) return;
        const corpo = (await r.json().catch(() => null)) as {
          data?: Array<{ id: string; titulo: string; operacaoId: string | null; numeroDocumento: string | null }>;
        } | null;
        if (!cancelado && corpo?.data) setDocsDaOperacao(corpo.data);
      } catch {
        // silêncio deliberado — ver acima
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [aberta, operacao.id]);

  // ── Edição das linhas (mesmas regras do NovoCofreClient, não exportadas lá) ─

  const atualizarLinha = useCallback((chave: string, mudanca: Partial<LinhaArquivo>) => {
    setLinhas((atuais) =>
      atuais.map((linha) => (linha.chave === chave ? aplicarMudanca(linha, mudanca) : linha))
    );
  }, []);

  function removerLinha(chave: string) {
    setLinhas((atuais) => atuais.filter((l) => l.chave !== chave));
  }

  function forcarDuplicata(chave: string) {
    atualizarLinha(chave, { forcarDuplicata: true });
  }

  function aplicarATodos(campo: CampoAplicavel, origem: LinhaArquivo) {
    const mudancaPara = (destino: LinhaArquivo): Partial<LinhaArquivo> =>
      campo === "papel"         ? { papel: origem.papel } :
      campo === "subcategoria"  ? { subcategoria: origem.subcategoria } :
      campo === "tipoDocumento" ? mudancaDeTipo(origem.tipoDocumento, destino.file.name) :
      campo === "situacaoProva" ? { situacaoProva: origem.situacaoProva } :
      campo === "emitidoEm"     ? { emitidoEm: origem.emitidoEm } :
      {
        validadeFim: origem.validadeFim,
        validadeIndeterminada: origem.validadeIndeterminada,
        validadeTocada: true,
      };

    setLinhas((atuais) =>
      atuais.map((linha) => {
        if (
          linha.chave === origem.chave ||
          linha.estado === "ENVIADO" ||
          linha.estado === "ENVIANDO"
        ) {
          return linha;
        }
        // Papel/subcategoria de linha com tipo são derivados (select travado).
        if ((campo === "papel" || campo === "subcategoria") && linha.tipoDocumento !== null) {
          return linha;
        }
        return aplicarMudanca(linha, mudancaPara(linha));
      })
    );
  }

  // ── Entrada de arquivos: hash no navegador + consulta de duplicata ─────────

  const verificarNoCofre = useCallback(async (hashes: string[]) => {
    const novosHashes = hashes.filter((sha) => !shasVerificados.current.has(sha));
    if (novosHashes.length === 0) return;
    for (const sha of novosHashes) shasVerificados.current.add(sha);

    for (const bloco of emBlocos(novosHashes, HASHES_POR_CHAMADA)) {
      try {
        const r = await fetch("/api/conformidade/cofre/documentos/verificar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sha256: bloco }),
        });
        const corpo = (await r.json().catch(() => null)) as RespostaVerificar | null;

        if (!r.ok) {
          for (const sha of bloco) shasVerificados.current.delete(sha);
          setErroGeral(
            corpo?.error ??
              `Não foi possível conferir duplicatas agora (HTTP ${r.status}). O envio segue valendo — o cofre recusa duplicata no upload.`
          );
          continue;
        }

        const encontrados = corpo?.existentes ?? {};
        setExistentesPorSha((atuais) => {
          const novo = { ...atuais };
          for (const [sha, doc] of Object.entries(encontrados)) {
            novo[sha] = {
              id:             doc.id,
              titulo:         doc.titulo,
              criadoEm:       doc.criadoEm ?? "",
              operacaoCodigo: doc.operacaoCodigo ?? null,
            };
          }
          return novo;
        });
      } catch (e) {
        for (const sha of bloco) shasVerificados.current.delete(sha);
        setErroGeral(
          e instanceof Error
            ? `Falha ao conferir duplicatas: ${e.message}`
            : "Falha ao conferir duplicatas."
        );
      }
    }
  }, []);

  const adicionarArquivos = useCallback(
    async (selecionados: File[]) => {
      if (selecionados.length === 0) return;
      setErroArquivos(null);
      setSucesso(null);

      const aceitos: File[] = [];
      const recusados: string[] = [];
      for (const file of selecionados) {
        if (!EXTENSAO_ACEITA.test(file.name)) recusados.push(`${file.name} (formato não aceito)`);
        else if (file.size > LIMITE_ARQUIVO_BYTES) recusados.push(`${file.name} (acima de 50 MB)`);
        else aceitos.push(file);
      }
      if (recusados.length > 0) {
        setErroArquivos(
          `Fora do lote: ${recusados.join(", ")}. Aceita PDF, XLS(X) e DOC(X) de até 50 MB.`
        );
      }
      if (aceitos.length === 0) return;

      const novas = aceitos.map((file) =>
        criarLinha(file, operacao.codigo, { papel: papelInicial, tipo: tipoInicial })
      );
      setLinhas((atuais) => [...atuais, ...novas]);

      // Um arquivo por vez: `sha256Hex` carrega o arquivo inteiro na memória.
      const calculados: string[] = [];
      for (const linha of novas) {
        try {
          const sha = await sha256Hex(linha.file);
          calculados.push(sha);
          atualizarLinha(linha.chave, { sha256: sha });
        } catch (e) {
          // Sem hash a tela perde só o aviso prévio — o POST recusa duplicata.
          atualizarLinha(linha.chave, {
            hashErro: e instanceof Error ? e.message : "não foi possível calcular",
          });
        }
      }

      await verificarNoCofre(calculados);
    },
    [operacao.codigo, papelInicial, tipoInicial, atualizarLinha, verificarNoCofre]
  );

  // Arquivos soltos na página: entram no lote assim que a gaveta abre com eles.
  useEffect(() => {
    if (!aberta || !arquivosIniciais || arquivosIniciais.length === 0) return;
    if (iniciaisRef.current === arquivosIniciais) return;
    iniciaisRef.current = arquivosIniciais;
    void adicionarArquivos(arquivosIniciais);
  }, [aberta, arquivosIniciais, adicionarArquivos]);

  // ── Relações (duplicata / versão / prova irmã) ─────────────────────────────

  const relacoesPorChave = useMemo(() => {
    const resultado = classificarRelacao({
      arquivos: linhas.map((linha) => paraArquivoDoLote(linha, operacao.id)),
      existentesPorSha,
      documentosNoCofre: docsDaOperacao,
    });
    const mapa = new Map<string, RelacaoArquivo>();
    for (const relacao of resultado) mapa.set(relacao.chave, relacao);
    return mapa;
  }, [linhas, existentesPorSha, docsDaOperacao, operacao.id]);

  // ── Envio ──────────────────────────────────────────────────────────────────

  const pendentes = linhas.filter((l) => l.estado !== "ENVIADO");
  const comFalha = linhas.filter((l) => l.estado === "ERRO");

  async function enviar(chavesAlvo?: string[]) {
    setErroGeral(null);
    setErroArquivos(null);
    setSucesso(null);

    if (linhas.length === 0) {
      setErroArquivos("Selecione ou solte um ou mais arquivos PDF, XLSX, DOC ou DOCX");
      return;
    }

    const alvo = linhas.filter((linha) =>
      chavesAlvo ? chavesAlvo.includes(linha.chave) : linha.estado !== "ENVIADO"
    );
    if (alvo.length === 0) return;

    const errosPorChave = new Map<string, Record<string, string>>();
    for (const linha of alvo) {
      const erros = validarLinha(linha);
      if (Object.keys(erros).length > 0) errosPorChave.set(linha.chave, erros);
    }

    const bloqueadas = alvo.filter(
      (linha) => relacoesPorChave.get(linha.chave)?.bloqueia && !linha.forcarDuplicata
    );

    if (errosPorChave.size > 0 || bloqueadas.length > 0) {
      setLinhas((atuais) =>
        atuais.map((linha) => ({ ...linha, errosCampo: errosPorChave.get(linha.chave) ?? {} }))
      );
      setErroGeral(
        bloqueadas.length > 0
          ? `${bloqueadas.length} ${bloqueadas.length === 1 ? "arquivo já está" : "arquivos já estão"} no cofre. Remova ou marque "subir mesmo assim" antes de enviar.`
          : "Há campos com erro nos arquivos destacados."
      );
      return;
    }

    const chaves = new Set(alvo.map((l) => l.chave));
    setEnviando(true);
    enviandoRef.current = true;
    setLinhas((atuais) =>
      atuais.map((linha) =>
        chaves.has(linha.chave)
          ? {
              ...linha,
              estado: "ENVIANDO",
              progresso: 0,
              erro: null,
              errosCampo: {},
              duplicataDoServidorId: null,
            }
          : linha
      )
    );
    setAnuncio(`Enviando ${alvo.length} ${alvo.length === 1 ? "arquivo" : "arquivos"}...`);

    const comuns = { descricao: "", tags: [], detentora: "" as const };
    let sucessos = 0;
    let falhas = 0;

    await executarComLimite(alvo, MAX_EM_PARALELO, async (linha) => {
      try {
        const resposta = await subirDocumento(
          montarFormData(linha, operacao.id, comuns),
          (porcentagem) => atualizarLinha(linha.chave, { progresso: porcentagem })
        );

        if (resposta.status === 201 && resposta.corpo?.id) {
          sucessos += 1;
          // O arquivo agora EXISTE no cofre: registrar como duplicata conhecida
          // para o mesmo arquivo readicionado nesta sessão receber o aviso
          // prévio (sem isso só o 409 do servidor seguraria, na hora do envio).
          if (linha.sha256) {
            const docId = resposta.corpo.id;
            setExistentesPorSha((atual) => ({
              ...atual,
              [linha.sha256 as string]: {
                id: docId,
                titulo: linha.titulo,
                criadoEm: new Date().toISOString(),
                operacaoCodigo: operacao.codigo,
              },
            }));
          }
          atualizarLinha(linha.chave, {
            estado: "ENVIADO",
            progresso: 100,
            documentoId: resposta.corpo.id,
            erro: null,
          });
          return;
        }

        falhas += 1;
        atualizarLinha(linha.chave, {
          estado: "ERRO",
          erro: mensagemDoErro(resposta),
          errosCampo: resposta.corpo?.detalhes ?? {},
          duplicataDoServidorId: resposta.corpo?.documentoId ?? null,
        });
      } catch (e) {
        falhas += 1;
        atualizarLinha(linha.chave, {
          estado: "ERRO",
          erro: e instanceof Error ? e.message : "Falha ao enviar o arquivo.",
        });
      }
    });

    setEnviando(false);
    enviandoRef.current = false;
    setAnuncio(
      `${sucessos} de ${alvo.length} ${alvo.length === 1 ? "arquivo enviado" : "arquivos enviados"}` +
        (falhas > 0 ? `, ${falhas} com erro.` : ".")
    );

    // Qualquer sucesso já mudou o dossiê — a ficha recarrega sem full reload.
    if (sucessos > 0) onConcluido();

    if (falhas > 0) {
      setErroGeral(
        `${sucessos} de ${alvo.length} enviados. O motivo de cada falha está na linha do arquivo — corrija e use "tentar de novo".`
      );
      return;
    }

    // Só fecha quando não sobrou nada por enviar fora do alvo desta chamada.
    const restantes = linhas.filter((l) => l.estado !== "ENVIADO" && !chaves.has(l.chave));
    if (restantes.length > 0) return;

    const total = linhas.length;
    setSucesso(`${total} documento${total !== 1 ? "s" : ""} no dossiê`);
    fecharTimerRef.current = setTimeout(() => {
      setLinhas([]);
      setSucesso(null);
      onFechar();
    }, 800);
  }

  if (!aberta) return null;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none",
          entrou ? "opacity-100" : "opacity-0"
        )}
        onClick={fechar}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full max-w-3xl bg-white shadow-2xl flex flex-col",
          "transition-transform duration-200 motion-reduce:transition-none",
          entrou ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* ── Header: operação travada ── */}
        <div className="p-4 border-b border-gray-100 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <h2 id={tituloId} className="text-sm font-bold text-brand-black">
              Subir documentos
            </h2>
            <button
              onClick={fechar}
              disabled={enviando}
              aria-label="Fechar"
              title={enviando ? "Aguarde o envio terminar" : undefined}
              className="p-1.5 rounded text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 min-w-0">
            <span className="font-mono text-sm font-semibold text-brand-orange flex-shrink-0">
              {operacao.codigo}
            </span>
            <span className="text-sm text-gray-700 truncate" title={operacao.clienteNome}>
              {operacao.clienteNome}
            </span>
            <span className="ml-auto text-[10px] uppercase tracking-wide font-semibold text-gray-400 flex-shrink-0">
              {DETENTORA_LABELS[operacao.detentora]}
            </span>
          </div>
          <p className="text-[11px] text-gray-400">
            Tudo que subir aqui entra no dossiê desta operação.
          </p>
        </div>

        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            void enviar();
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          {/* ── Corpo ── */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {erroGeral && (
              <div
                role="alert"
                className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700"
              >
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-px" aria-hidden="true" />
                <span>{erroGeral}</span>
              </div>
            )}

            <label
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSobreDropzone(true);
              }}
              onDragLeave={(e) => {
                // Entrar num filho dispara dragleave do label — ignorar para o
                // realce não piscar enquanto o cursor passeia pela dropzone.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setSobreDropzone(false);
              }}
              onDrop={(e) => {
                // stopPropagation: o drop aqui não pode chegar no handler
                // global da página (abriria/ingeriria em dobro).
                e.preventDefault();
                e.stopPropagation();
                setSobreDropzone(false);
                if (!enviando) void adicionarArquivos(Array.from(e.dataTransfer.files));
              }}
              className={cn(
                "flex flex-col items-center justify-center px-4 py-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors",
                "focus-within:ring-2 focus-within:ring-brand-orange/40 focus-within:border-brand-orange",
                sobreDropzone ? "border-brand-orange bg-orange-50/50" :
                erroArquivos ? "border-red-300 bg-red-50" : "border-gray-200 hover:bg-gray-50"
              )}
            >
              <Upload className="h-6 w-6 text-gray-400 mb-2" aria-hidden="true" />
              <span className="text-sm text-gray-600">
                {linhas.length === 0
                  ? "Solte arquivos aqui ou clique para selecionar"
                  : "Adicionar mais arquivos"}
              </span>
              <span className="text-xs text-gray-400 mt-1">
                PDF, XLSX, DOCX · vários de uma vez · máx. 50 MB cada
              </span>
              <input
                type="file"
                multiple
                accept=".pdf,.xls,.xlsx,.doc,.docx"
                disabled={enviando}
                onChange={(e) => {
                  const selecionados = Array.from(e.target.files ?? []);
                  // Zera o input para o mesmo arquivo poder voltar depois de removido.
                  e.target.value = "";
                  void adicionarArquivos(selecionados);
                }}
                className="sr-only"
              />
            </label>
            {erroArquivos && <p className="text-xs text-red-600">{erroArquivos}</p>}

            {linhas.length > 0 && (
              <ul className="space-y-2.5">
                {linhas.map((linha) => (
                  <LinhaArquivoCard
                    key={linha.chave}
                    linha={linha}
                    relacao={relacoesPorChave.get(linha.chave) ?? null}
                    operacaoEscolhida
                    mostrarAplicarATodos={linhas.length > 1}
                    travado={enviando}
                    onAtualizar={atualizarLinha}
                    onRemover={removerLinha}
                    onAplicarATodos={aplicarATodos}
                    onForcarDuplicata={forcarDuplicata}
                    onReenviar={(chave) => void enviar([chave])}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* ── Rodapé ── */}
          <div className="flex items-center gap-2.5 flex-wrap p-4 border-t border-gray-100">
            <Button type="submit" size="sm" loading={enviando} disabled={linhas.length > 0 && pendentes.length === 0}>
              {enviando
                ? "Enviando..."
                : pendentes.length <= 1
                  ? "Subir documento"
                  : `Subir ${pendentes.length} documentos`}
            </Button>
            {comFalha.length > 0 && !enviando && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void enviar(comFalha.map((l) => l.chave))}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Tentar de novo ({comFalha.length})
              </Button>
            )}
            {sucesso && (
              <p role="status" className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                <Check className="h-3.5 w-3.5" aria-hidden="true" /> {sucesso}
              </p>
            )}
            <button
              type="button"
              onClick={fechar}
              disabled={enviando}
              className="ml-auto px-2 py-1.5 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-40 transition-colors"
            >
              Fechar
            </button>
          </div>
        </form>

        <p className="sr-only" role="status" aria-live="polite">
          {anuncio}
        </p>
      </div>
    </>
  );
}

// ── Regras de edição (espelho do NovoCofreClient — as funções são privadas lá) ─

/**
 * Editar um campo apaga o erro DAQUELE campo; trocar o papel religa o "não
 * vence" enquanto o usuário não tiver mexido na validade.
 */
function aplicarMudanca(linha: LinhaArquivo, mudanca: Partial<LinhaArquivo>): LinhaArquivo {
  const nova: LinhaArquivo = { ...linha, ...mudanca };

  const errosCampo = { ...linha.errosCampo };
  let mexeuEmErro = false;
  for (const campo of Object.keys(mudanca) as (keyof LinhaArquivo)[]) {
    const chaveErro = CAMPO_PARA_ERRO[campo];
    if (chaveErro && errosCampo[chaveErro]) {
      delete errosCampo[chaveErro];
      mexeuEmErro = true;
    }
  }
  if (mexeuEmErro) nova.errosCampo = errosCampo;

  if (mudanca.papel !== undefined && !nova.validadeTocada) {
    nova.validadeIndeterminada = nova.validadeFim === "" && papelNaoVence(nova.papel);
  }

  return nova;
}
