"use client";

/**
 * Tela "Subir provas da operação" (antiga "Subir documento").
 *
 * O que mudou e por quê: o cofre foi desenhado para CERTIDÃO (uma por tipo, que
 * vence e é substituída), mas o que entra aqui é ATESTADO (vários por obra, que
 * não vencem e se somam). A tela antiga tinha um formulário só para o lote
 * inteiro e a obra existia apenas como prefixo digitado no título
 * ("12345 - ..."). Resultado: operações fantasma (código digitado que não
 * existia) e duplicata exata passando porque ninguém conferia o conteúdo.
 *
 * A ordem da tela é a ordem da decisão:
 *   1. de que OPERAÇÃO são estas provas (uma vez, no topo);
 *   2. o que é cada ARQUIVO (uma linha editável por arquivo);
 *   3. subir — com duplicata avisada ANTES, no navegador.
 *
 * Preservado da versão anterior: validação de título (2..200), a regra "informe
 * a validade ou marque que não vence", descrição e tags valendo para o lote,
 * seleção de categoria/subcategoria, e a navegação pós-sucesso (documento único
 * abre o detalhe; lote volta para a lista).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ChevronLeft, RefreshCw, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import {
  classificarRelacao,
  DETENTORAS,
  DETENTORA_LABELS,
  PAPEIS_DOCUMENTO,
  sha256Hex,
  tituloSugerido,
  TIPOS_DOCUMENTO,
  type Detentora,
  type DuplicataNoCofre,
  type PapelDocumento,
  type RelacaoArquivo,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { SeletorOperacao } from "./SeletorOperacao";
import { LinhaArquivoCard, type CampoAplicavel } from "./LinhaArquivoCard";
import {
  criarLinha,
  emBlocos,
  executarComLimite,
  mensagemDoErro,
  montarFormData,
  mudancaDeTipo,
  operacaoResumoDoDetalhe,
  papelNaoVence,
  paraArquivoDoLote,
  separarTags,
  subirDocumento,
  validarLinha,
  type DocumentoDaOperacao,
  type LinhaArquivo,
  type OperacaoDetalhe,
  type OperacaoResumo,
  type RespostaDocumentos,
} from "./lote";

/** Uploads simultâneos. Ver o comentário de `executarComLimite`. */
const MAX_EM_PARALELO = 3;

/** /verificar aceita no máximo 50 hashes por chamada. */
const HASHES_POR_CHAMADA = 50;

/** Erro de um campo → chave do erro que a linha exibe. */
const CAMPO_PARA_ERRO: Partial<Record<keyof LinhaArquivo, string>> = {
  titulo:                "titulo",
  numeroDocumento:       "numeroDocumento",
  validadeFim:           "validadeFim",
  validadeIndeterminada: "validadeFim",
  tipoDocumento:         "tipoDocumento",
  situacaoProva:         "situacaoProva",
  restrito:              "restrito",
};

// ── Parâmetros de entrada (?operacaoId=…&papel=…&tipo=…) ─────────────────────
// A ficha manda para cá com a operação já decidida. Valor inválido é IGNORADO
// em silêncio (link velho não pode quebrar a tela).

function papelDaUrl(raw: string | null): PapelDocumento | undefined {
  return raw && (PAPEIS_DOCUMENTO as readonly string[]).includes(raw)
    ? (raw as PapelDocumento)
    : undefined;
}

function tipoDaUrl(raw: string | null): TipoDocumento | undefined {
  return raw && (TIPOS_DOCUMENTO as readonly string[]).includes(raw)
    ? (raw as TipoDocumento)
    : undefined;
}

/** Resposta de POST /api/conformidade/cofre/documentos/verificar. */
interface RespostaVerificar {
  existentes?: Record<
    string,
    { id: string; titulo: string; criadoEm: string | null; operacaoCodigo: string | null }
  >;
  error?: string;
}

export default function NovoCofreClient() {
  const router = useRouter();

  // Link de entrada: o dossiê manda ?operacaoId=…&papel=…&tipo=… — a operação
  // chega pré-travada e toda linha nova nasce com o papel/tipo do botão clicado.
  const searchParams = useSearchParams();
  const operacaoIdDoLink = searchParams.get("operacaoId");
  const papelDoLink = papelDaUrl(searchParams.get("papel"));
  const tipoDoLink = tipoDaUrl(searchParams.get("tipo"));

  const [operacao, setOperacao] = useState<OperacaoResumo | null>(null);
  const [provasDaOperacao, setProvasDaOperacao] = useState<DocumentoDaOperacao[]>([]);
  const [carregandoProvas, setCarregandoProvas] = useState(false);
  const [carregandoDoLink, setCarregandoDoLink] = useState(Boolean(operacaoIdDoLink));
  const [avisoDoLink, setAvisoDoLink] = useState<string | null>(null);

  const [linhas, setLinhas] = useState<LinhaArquivo[]>([]);
  const [existentesPorSha, setExistentesPorSha] = useState<Record<string, DuplicataNoCofre>>({});

  const [descricao, setDescricao] = useState("");
  const [tags, setTags] = useState("");
  const [detentora, setDetentora] = useState<Detentora | "">("");

  const [enviando, setEnviando] = useState(false);
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [erroArquivos, setErroArquivos] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");

  /** Hashes já perguntados ao cofre — evita repetir /verificar a cada arquivo novo. */
  const shasVerificados = useRef<Set<string>>(new Set());

  /** O link resolve UMA vez (o StrictMode monta duas — sem isto, dois GETs). */
  const linkJaResolvido = useRef(false);

  // ── Edição das linhas ──────────────────────────────────────────────────────

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

  /**
   * Copia um campo da linha de origem para todas as outras. Não toca no que já
   * foi enviado (o registro já existe no banco) nem no que está subindo.
   *
   * A mudança é calculada POR LINHA (e não uma só) por causa do tipo: aplicar
   * um tipo re-deriva papel/subcategoria em cada destino — e a exceção ISO
   * olha o NOME de cada arquivo (14001/45001), então o resultado pode diferir
   * de linha para linha.
   */
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
        // Papel/subcategoria de linha com tipo são derivados (select travado):
        // aplicar por cima quebraria a regra "o tipo é UMA decisão".
        if ((campo === "papel" || campo === "subcategoria") && linha.tipoDocumento !== null) {
          return linha;
        }
        return aplicarMudanca(linha, mudancaPara(linha));
      })
    );
  }

  // ── Entrada de arquivos: hash no navegador + consulta de duplicata ─────────

  async function adicionarArquivos(selecionados: File[]) {
    if (selecionados.length === 0) return;
    setErroArquivos(null);

    const novas = selecionados.map((file) =>
      criarLinha(file, operacao?.codigo ?? null, { papel: papelDoLink, tipo: tipoDoLink })
    );
    setLinhas((atuais) => [...atuais, ...novas]);

    // Um arquivo por vez: `sha256Hex` carrega o arquivo inteiro na memória e o
    // lote pode ter 40 PDFs de dezenas de MB.
    const calculados: string[] = [];
    for (const linha of novas) {
      try {
        const sha = await sha256Hex(linha.file);
        calculados.push(sha);
        atualizarLinha(linha.chave, { sha256: sha });
      } catch (e) {
        // Sem hash a tela perde só o AVISO prévio: o servidor continua recusando
        // duplicata com 409 no POST. Por isso isto não trava o envio.
        atualizarLinha(linha.chave, {
          hashErro: e instanceof Error ? e.message : "não foi possível calcular",
        });
      }
    }

    await verificarNoCofre(calculados);
  }

  async function verificarNoCofre(hashes: string[]) {
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
          // Libera os hashes para nova tentativa no próximo arquivo adicionado.
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
  }

  // ── Operação ───────────────────────────────────────────────────────────────

  async function escolherOperacao(nova: OperacaoResumo) {
    // Antes do setOperacao: senão o cartão pisca "nenhuma prova ainda" no
    // primeiro render, enquanto o GET das provas ainda nem saiu.
    setCarregandoProvas(true);
    setOperacao(nova);
    setErroGeral(null);

    // Título sugerido some com o prefixo "12345 - " agora que o código é coluna.
    // Só reescreve o que o usuário ainda não editou.
    setLinhas((atuais) =>
      atuais.map((linha) =>
        linha.tituloTocado || linha.estado === "ENVIADO"
          ? linha
          : { ...linha, titulo: tituloSugerido(linha.file.name, nova.codigo) }
      )
    );

    try {
      const r = await fetch(
        `/api/conformidade/cofre/documentos?operacaoId=${encodeURIComponent(nova.id)}&limit=200`
      );
      const corpo = (await r.json().catch(() => null)) as
        | (RespostaDocumentos & { error?: string })
        | null;
      if (!r.ok) {
        setProvasDaOperacao([]);
        setErroGeral(
          corpo?.error ?? `Não foi possível ler as provas desta operação (HTTP ${r.status})`
        );
        return;
      }
      setProvasDaOperacao(corpo?.data ?? []);
    } catch (e) {
      setProvasDaOperacao([]);
      setErroGeral(
        e instanceof Error ? `Falha ao ler as provas da operação: ${e.message}` : "Falha de rede."
      );
    } finally {
      setCarregandoProvas(false);
    }
  }

  function limparOperacao() {
    setOperacao(null);
    setProvasDaOperacao([]);
  }

  /**
   * Chegada por link (?operacaoId=…): busca o dossiê (R3) e trava a operação
   * no topo pelo MESMO `escolherOperacao` do fluxo manual — "Trocar operação"
   * continua valendo, o parâmetro é ponto de partida, não algema. 404 (id
   * inexistente OU não-UUID) vira aviso e a busca aparece normalmente: link
   * velho nunca quebra a tela.
   */
  useEffect(() => {
    if (!operacaoIdDoLink || linkJaResolvido.current) return;
    linkJaResolvido.current = true;

    void (async () => {
      try {
        const r = await fetch(
          `/api/conformidade/operacoes/${encodeURIComponent(operacaoIdDoLink)}`
        );
        const corpo = (await r.json().catch(() => null)) as
          | (OperacaoDetalhe & { error?: string })
          | null;

        if (r.status === 404) {
          setAvisoDoLink("A operação do link não existe mais — escolha outra.");
          return;
        }
        if (!r.ok || !corpo) {
          setErroGeral(
            corpo?.error ??
              `Não foi possível carregar a operação do link (HTTP ${r.status}). Busque a operação abaixo.`
          );
          return;
        }
        await escolherOperacao(operacaoResumoDoDetalhe(corpo));
      } catch (e) {
        setErroGeral(
          e instanceof Error
            ? `Falha ao carregar a operação do link: ${e.message}`
            : "Falha de rede ao carregar a operação do link."
        );
      } finally {
        setCarregandoDoLink(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leitura única no mount
  }, [operacaoIdDoLink]);

  // ── Relações (duplicata / versão / prova irmã) ─────────────────────────────

  /**
   * Quem decide é o domínio compartilhado, não a tela: a mesma função responde
   * no servidor. Aqui só se traduz o resultado em aviso por linha.
   */
  const relacoesPorChave = useMemo(() => {
    const operacaoId = operacao?.id ?? null;
    const resultado = classificarRelacao({
      arquivos: linhas.map((linha) => paraArquivoDoLote(linha, operacaoId)),
      existentesPorSha,
      documentosNoCofre: provasDaOperacao.map((d) => ({
        id:              d.id,
        titulo:          d.titulo,
        operacaoId:      d.operacaoId,
        numeroDocumento: d.numeroDocumento,
      })),
    });
    const mapa = new Map<string, RelacaoArquivo>();
    for (const relacao of resultado) mapa.set(relacao.chave, relacao);
    return mapa;
  }, [linhas, existentesPorSha, provasDaOperacao, operacao]);

  // ── Envio ──────────────────────────────────────────────────────────────────

  const pendentes = linhas.filter((l) => l.estado !== "ENVIADO");
  const comFalha = linhas.filter((l) => l.estado === "ERRO");
  const enviados = linhas.filter((l) => l.estado === "ENVIADO").length;

  async function enviar(chavesAlvo?: string[]) {
    setErroGeral(null);
    setErroArquivos(null);

    if (linhas.length === 0) {
      setErroArquivos("Selecione um ou mais arquivos PDF, XLSX, DOC ou DOCX");
      return;
    }

    const alvo = linhas.filter((linha) =>
      chavesAlvo ? chavesAlvo.includes(linha.chave) : linha.estado !== "ENVIADO"
    );
    if (alvo.length === 0) return;

    // 1. Campos obrigatórios de cada linha.
    const errosPorChave = new Map<string, Record<string, string>>();
    for (const linha of alvo) {
      const erros = validarLinha(linha);
      if (Object.keys(erros).length > 0) errosPorChave.set(linha.chave, erros);
    }

    // 2. Duplicata bloqueante que o usuário não resolveu (remover ou forçar).
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

    const comuns = { descricao, tags: separarTags(tags), detentora };
    let sucessos = 0;
    let falhas = 0;
    // Array e não `let id: string | null`: o TypeScript zera a narrowing de
    // variável atribuída dentro de callback e a leitura lá embaixo viraria
    // `never`. Empurrar num array não tem esse problema.
    const idsCriados: string[] = [];

    await executarComLimite(alvo, MAX_EM_PARALELO, async (linha) => {
      try {
        const resposta = await subirDocumento(
          montarFormData(linha, operacao?.id ?? null, comuns),
          (porcentagem) => atualizarLinha(linha.chave, { progresso: porcentagem })
        );

        if (resposta.status === 201 && resposta.corpo?.id) {
          sucessos += 1;
          idsCriados.push(resposta.corpo.id);
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
          // 422 vem com `detalhes` campo→mensagem: o erro gruda no input certo.
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
    setAnuncio(
      `${sucessos} de ${alvo.length} ${alvo.length === 1 ? "arquivo enviado" : "arquivos enviados"}` +
        (falhas > 0 ? `, ${falhas} com erro.` : ".")
    );

    if (falhas > 0) {
      setErroGeral(
        `${sucessos} de ${alvo.length} enviados. O motivo de cada falha está na linha do arquivo — corrija e use "tentar de novo".`
      );
      return;
    }

    // Só navega quando não sobrou nada para enviar (numa nova tentativa parcial,
    // ainda pode haver arquivo pendente fora do alvo).
    const restantes = linhas.filter((l) => l.estado !== "ENVIADO" && !chaves.has(l.chave));
    if (restantes.length > 0) return;

    if (operacao) {
      // Com operação, o destino natural é o dossiê dela: é lá que a prova recém
      // subida faz sentido junto das outras.
      router.push(`/acervo/operacoes/${operacao.id}`);
    } else if (linhas.length === 1 && idsCriados.length === 1) {
      router.push(`/acervo/cofre/${idsCriados[0]}`);
    } else {
      router.push("/acervo/cofre");
    }
  }

  // ── Tela ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        href="/acervo/cofre"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Voltar para o cofre
      </Link>

      <h1 className="text-2xl font-bold text-brand-black mb-1">Subir provas da operação</h1>
      <p className="text-sm text-gray-500 mb-5">
        Escolha a obra, revise cada arquivo e suba tudo de uma vez. Atestado, CAT/ART, contrato e
        nota fiscal se somam na mesma operação — nada substitui nada. Certidões e declarações
        continuam podendo entrar sem operação.
      </p>

      {erroGeral && (
        <div
          role="alert"
          className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm text-red-700"
        >
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>{erroGeral}</span>
        </div>
      )}

      {/* 1. Operação — fora do <form> de propósito: Enter na busca não pode enviar o lote. */}
      <div className="mb-4">
        <SeletorOperacao
          operacao={operacao}
          provasNoCofre={operacao ? provasDaOperacao.length : null}
          carregandoProvas={carregandoProvas}
          carregandoDoLink={carregandoDoLink}
          avisoDoLink={avisoDoLink}
          onEscolher={escolherOperacao}
          onLimpar={limparOperacao}
        />
      </div>

      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void enviar();
        }}
        className="space-y-5"
      >
        {/* 2. Arquivos */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Arquivos {linhas.length > 0 && `(${linhas.length})`}
            </h2>
            <p className="text-xs text-gray-500" aria-live="polite">
              {enviados > 0 && `${enviados} de ${linhas.length} no cofre`}
            </p>
          </div>

          {linhas.length > 0 && (
            <ul className="space-y-2.5 mb-3">
              {linhas.map((linha) => (
                <LinhaArquivoCard
                  key={linha.chave}
                  linha={linha}
                  relacao={relacoesPorChave.get(linha.chave) ?? null}
                  operacaoEscolhida={operacao !== null}
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

          {/* `sr-only` e não `hidden` no input: escondido com `hidden` ele sai da
              ordem de tabulação e não há como abrir o seletor de arquivos pelo
              teclado. O anel de foco no label mostra onde o foco está. */}
          <label
            className={cn(
              "flex flex-col items-center justify-center px-4 py-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors",
              "focus-within:ring-2 focus-within:ring-brand-orange/40 focus-within:border-brand-orange",
              erroArquivos ? "border-red-300 bg-red-50" : "border-gray-200 hover:bg-gray-50"
            )}
          >
            <Upload className="h-6 w-6 text-gray-400 mb-2" aria-hidden="true" />
            <span className="text-sm text-gray-600">
              {linhas.length === 0 ? "Clique para selecionar arquivos" : "Adicionar mais arquivos"}
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
                // Zera o input para o mesmo arquivo poder ser escolhido de novo
                // depois de removido da lista.
                e.target.value = "";
                void adicionarArquivos(selecionados);
              }}
              className="sr-only"
            />
          </label>
          {erroArquivos && <p className="mt-1 text-xs text-red-600">{erroArquivos}</p>}
        </div>

        {/* 3. Campos que valem para o lote inteiro */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-4">
          <h2 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
            Vale para todos os arquivos
          </h2>

          <div>
            <label htmlFor="lote-descricao" className="block text-xs font-semibold text-gray-500 mb-1">
              Descrição
            </label>
            <textarea
              id="lote-descricao"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Notas internas sobre estas provas..."
              rows={2}
              disabled={enviando}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange resize-none"
            />
          </div>

          <div>
            <label htmlFor="lote-tags" className="block text-xs font-semibold text-gray-500 mb-1">
              Tags (separadas por vírgula)
            </label>
            <input
              id="lote-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="cliente, unidade, soldagem"
              disabled={enviando}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            />
          </div>

          <div>
            <label
              htmlFor="lote-detentora"
              className="block text-xs font-semibold text-gray-500 mb-1"
            >
              Detentora das provas
            </label>
            <select
              id="lote-detentora"
              value={detentora}
              onChange={(e) => setDetentora(e.target.value as Detentora | "")}
              disabled={enviando}
              aria-describedby="lote-detentora-ajuda"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
            >
              <option value="">— herdar da operação</option>
              {DETENTORAS.map((d) => (
                <option key={d} value={d}>
                  {DETENTORA_LABELS[d]}
                </option>
              ))}
            </select>
            <p id="lote-detentora-ajuda" className="mt-1 text-[11px] text-gray-400">
              De quem é a prova. Sem escolha, vale a detentora da operação (R7 herda no servidor).
            </p>
          </div>
        </div>

        {/* 4. Ações */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {/* Sem arquivo nenhum o botão CONTINUA ativo de propósito: o clique é o
              que explica "selecione um ou mais arquivos". Botão morto não ensina. */}
          <Button
            type="submit"
            loading={enviando}
            disabled={linhas.length > 0 && pendentes.length === 0}
          >
            {enviando
              ? "Enviando..."
              : pendentes.length <= 1
                ? "Subir prova"
                : `Subir ${pendentes.length} provas`}
          </Button>

          {comFalha.length > 0 && !enviando && (
            <Button
              variant="secondary"
              onClick={() => void enviar(comFalha.map((l) => l.chave))}
              className="gap-1.5"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Tentar de novo ({comFalha.length})
            </Button>
          )}

          <Link
            href="/acervo/cofre"
            className="px-2 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancelar
          </Link>
        </div>
      </form>

      {/* Leitor de tela acompanha o lote sem precisar varrer as linhas. */}
      <p className="sr-only" role="status" aria-live="polite">
        {anuncio}
      </p>
    </div>
  );
}

// ── Regras de edição ─────────────────────────────────────────────────────────

/**
 * Aplica a mudança na linha, com dois efeitos colaterais deliberados:
 *
 *  1. editar um campo apaga o erro DAQUELE campo (era o comportamento da tela
 *     antiga — o erro some quando o usuário começa a corrigir);
 *  2. trocar o papel religa (ou desliga) o "não vence" enquanto o usuário não
 *     tiver mexido na validade: atestado/CAT/contrato não vencem, declaração
 *     vence. Depois que ele mexe, a escolha dele manda.
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
