"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileText, FolderTree, Info,
  ListTree, Loader2, MoreHorizontal, Pencil, Upload, UploadCloud, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { podeExcluirDocumentoHabilitacao, podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import {
  DETENTORA_LABELS,
  ORIGEM_OPERACAO_LABELS,
  TIPO_DOCUMENTO_LABELS,
  tituloOperacao,
  type Detentora,
  type OrigemOperacao,
  type PapelDocumento,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { executarComLimite } from "@/app/acervo/cofre/novo/lote";
import { GavetaDocumento } from "@/app/acervo/_componentes/GavetaDocumento";
import { BlocoAnotacoes } from "@/app/acervo/_componentes/BlocoAnotacoes";
import {
  contadoresBarra,
  estouraTetoZip,
  fatiarParaDownload,
  formatarPeriodo,
  montarSecoes,
  montarTimeline,
  normalizarBusca,
  somaBytes,
  LIMITE_ZIP_BYTES,
  LIMITE_ZIP_DOCS,
  type DocDossie,
  type SecaoMontada,
} from "./secoes";
import { BarraComprovacao } from "./BarraComprovacao";
import { SecaoDossie, type EstadoDownloadSecao } from "./SecaoDossie";
import { LinhaDocumento } from "./LinhaDocumento";
import { GavetaAdocao } from "./GavetaAdocao";
import { GavetaUpload } from "./GavetaUpload";
import { ModalEditarOperacao } from "./ModalEditarOperacao";
import { ModalVincularFamilia } from "./ModalVincularFamilia";
import { BlocoDisciplinas } from "./BlocoDisciplinas";
import { TimelineOperacao } from "./TimelineOperacao";

/**
 * /acervo/operacoes/[id] — a FICHA da operação como WORKSPACE (ACERVO-UI-V2 §3).
 *
 * Consome R3 (GET /api/conformidade/operacoes/{id}) UMA vez e calcula tudo em
 * memória: cartões de comprovação (mesma regra de R1), 9 seções por
 * `tipo_documento`, filtro local sem rede. Tudo que se faz com um documento —
 * ver, baixar, editar, excluir, subir — acontece SEM sair daqui: prévia e ações
 * na GavetaDocumento, upload na GavetaUpload (com drag-and-drop na página
 * inteira). O guard de papel segue em `../layout.tsx` — a API revalida sozinha.
 */

// ── Tipos da resposta (R3) ───────────────────────────────────────────────────

interface OperacaoDossie {
  id: string;
  codigo: string;
  clienteNome: string;
  clienteGrupo: string | null;
  clienteCnpj: string | null;
  contratoNumero: string | null;
  unidade: string | null;
  /**
   * 0044 (B5) — área da planta, texto livre. OBRIGATÓRIO no tipo: não há
   * fábrica de teste para `OperacaoDossie` (é tipo de tela, montado pelo
   * `fetch`) e R3 devolve a chave sempre, porque `getOperacaoById` faz
   * `.select()` cru (spec ONDA-5 §1i). Convive com `unidade`: são dois textos
   * livres, e a normalização, se vier, é migration futura (§1l).
   */
  area: string | null;
  detentora: Detentora;
  ramo: string | null;
  onshoreOffshore: string | null;
  /** Colunas `date`: chegam como "AAAA-MM-DD", nunca com hora. */
  periodoInicio: string | null;
  periodoFim: string | null;
  /**
   * OPCIONAIS no tipo: R3 OMITE as chaves para papéis fora de Conformidade
   * (§2.4) — a tela usa `"valor" in dossie` e mostra "restrito ao setor" quando
   * a chave some. `numeric` sai como STRING, nunca number.
   */
  valor?: string | null;
  hh?: string | null;
  escopo: string | null;
  familiasSugeridas: string[] | null;
  origem: OrigemOperacao;
  ativo: boolean;
  criadoEm: string | null;
  atualizadoEm: string | null;
  /**
   * 0043 — disciplinas da obra (R3 §5.8e). SEMPRE vem (array vazio quando não
   * há vínculo); o `?? []` no uso é cinto de segurança para o intervalo entre
   * o deploy do front e o do BFF.
   */
  disciplinas: Array<{ id: string; codigo: string; nome: string }>;
  documentos: DocDossie[];
}

// ── Formatação ───────────────────────────────────────────────────────────────

function formatarMoeda(valor: string | null): string | null {
  if (!valor) return null;
  const numero = Number(valor);
  return Number.isNaN(numero)
    ? valor
    : numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarHh(hh: string | null): string | null {
  if (!hh) return null;
  const numero = Number(hh);
  return Number.isNaN(numero)
    ? hh
    : `${numero.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} HH`;
}

const COR_DETENTORA: Record<Detentora, string> = {
  PROPONENTE: "bg-orange-50 text-orange-700 border-orange-200",
  COLIGADA:    "bg-blue-50 text-blue-700 border-blue-200",
  PARCEIRO: "bg-gray-100 text-gray-600 border-gray-200",
};

// ── Vazios esperados e nomes curtos (§5.4) ───────────────────────────────────

/** Seções 1–3 vazias viram linha âmbar com CTA que abre a gaveta já tipada. */
const VAZIOS_ESPERADOS: ReadonlyArray<{
  numero: 1 | 2 | 3;
  texto: string;
  botao: string;
  tipo: TipoDocumento;
  papel: PapelDocumento;
}> = [
  {
    numero: 1,
    texto: "Sem contrato no cofre — o dossiê não tem o instrumento que originou a obra.",
    botao: "Subir contrato",
    tipo: "CONTRATO",
    papel: "CONTRATO",
  },
  {
    numero: 2,
    texto: "Sem atestado de capacidade técnica — esta obra não comprova execução em habilitação.",
    botao: "Subir atestado",
    tipo: "ATESTADO",
    papel: "ATESTADO",
  },
  {
    numero: 3,
    texto: "Sem ART/CAT — falta o acervo do profissional responsável pela obra.",
    botao: "Subir ART/CAT",
    tipo: "ART",
    papel: "CAT_ART",
  },
];

/** Seções opcionais (4–8) vazias: rodapé de uma frase, não caixa. */
const NOME_CURTO_OPCIONAL: Record<number, string> = {
  4: "habilitação técnica",
  5: "proposta",
  6: "anexos técnicos",
  7: "execução/administrativo",
  8: "compactados a inspecionar",
};

/** Nomes curtos do trilho de seções (§3-3). */
const NOME_TRILHO: Record<number, string> = {
  1: "Contrato", 2: "Atestados", 3: "ART/CAT", 4: "Habilitação", 5: "Proposta",
  6: "Anexos técnicos", 7: "Execução", 8: "A inspecionar", 9: "Sem tipo",
};

// ── Download helpers ─────────────────────────────────────────────────────────

function nomeDoContentDisposition(r: Response): string | null {
  const cd = r.headers.get("Content-Disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(cd);
  return m ? m[1] : null;
}

function salvarBlob(blob: Blob, nome: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `scrollIntoView` suave, exceto para quem pediu menos movimento. */
function rolarAte(id: string): void {
  const suave = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: suave ? "auto" : "smooth", block: "start" });
}

// ── Página ───────────────────────────────────────────────────────────────────

export default function DossieOperacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const { data: session } = useSession();
  // Mesma condição do detalhe do cofre — não anunciar poder que o papel não tem.
  const podeExcluir = Boolean(session?.user && podeExcluirDocumentoHabilitacao(session.user.role));
  /**
   * Botão de editar disciplinas (D3). Hoje este booleano é sempre `true` para
   * quem chega aqui — o `layout.tsx` do segmento já barra em `isConformidade`,
   * e `isConformidade` está contido em `podeGerenciarDocumentosHabilitacao`.
   * Existe assim mesmo porque a condição do botão tem de NOMEAR a permissão de
   * que ele depende: se um dia o guard do segmento afrouxar, o botão não vai
   * junto sozinho. A barreira real continua sendo a rota, que revalida.
   */
  const podeGerenciar = Boolean(session?.user && podeGerenciarDocumentosHabilitacao(session.user.role));

  const [dossie, setDossie] = useState<OperacaoDossie | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [naoEncontrada, setNaoEncontrada] = useState(false);

  /** Anúncios para leitores de tela (copiar código, cadastro atualizado…). */
  const [anuncio, setAnuncio] = useState("");

  const [filtro, setFiltro] = useState("");
  const [filtroTipo, setFiltroTipo] = useState<TipoDocumento | null>(null);
  const [secoesAbertas, setSecoesAbertas] = useState<Record<number, boolean>>({});
  const [secaoAtiva, setSecaoAtiva] = useState<number | null>(null);
  const [escopoAberto, setEscopoAberto] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);

  // Gavetas do workspace (§3): prévia de documento e upload sem sair da ficha.
  const [gavetaDocIndice, setGavetaDocIndice] = useState<number | null>(null);
  const [gavetaUpload, setGavetaUpload] = useState<{
    aberta: boolean;
    tipo?: TipoDocumento;
    papel?: PapelDocumento;
  }>({ aberta: false });
  const [arquivosSoltos, setArquivosSoltos] = useState<File[] | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const contadorDrag = useRef(0);

  // Seleção para vínculo de família em massa (seções 2/3 — §5.7).
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [errosVinculo, setErrosVinculo] = useState<Record<string, string>>({});
  const [mensagemMassa, setMensagemMassa] = useState<string | null>(null);
  const [modalFamilia, setModalFamilia] = useState<
    | { modo: "doc"; doc: DocDossie }
    | { modo: "massa" }
    | null
  >(null);

  const [modalEditar, setModalEditar] = useState<{ foco?: "contratoNumero" } | null>(null);

  // Download: um por vez (as chamadas fatiadas são sequenciais de propósito).
  const [baixandoDossie, setBaixandoDossie] = useState(false);
  /** C6 — o ZIP por disciplina é outro botão e outro estado (spec ONDA-5 §7.4). */
  const [baixandoDisciplina, setBaixandoDisciplina] = useState(false);
  const [downloadSecao, setDownloadSecao] = useState<{ numero: number; rotulo: string | null } | null>(null);
  const [erroDownload, setErroDownload] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    setNaoEncontrada(false);
    try {
      const r = await fetch(`/api/conformidade/operacoes/${id}`);
      if (r.status === 404) {
        setNaoEncontrada(true);
        return;
      }
      if (!r.ok) {
        // Mostra a mensagem que o backend mandou, não um "Erro interno" mudo.
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `Erro ${r.status}`);
      }
      setDossie((await r.json()) as OperacaoDossie);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar a operação");
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    setCarregando(true);
    void carregar();
  }, [carregar]);

  const documentos = useMemo(() => dossie?.documentos ?? [], [dossie]);
  const contadores = useMemo(() => contadoresBarra(documentos), [documentos]);
  const secoes = useMemo(() => montarSecoes(documentos), [documentos]);
  /**
   * D9 — a linha do tempo (spec ONDA-5 §7.3). `dossie` é `OperacaoDossie | null`
   * até a carga terminar e os `useMemo` da ficha ficam ANTES do early-return —
   * daí o `?? null` nos dois extremos. `montarTimeline([], null, null)` devolve
   * `eventos: []`, e o componente não renderiza nada.
   */
  const timeline = useMemo(
    () => montarTimeline(documentos, dossie?.periodoInicio ?? null, dossie?.periodoFim ?? null),
    [documentos, dossie?.periodoInicio, dossie?.periodoFim]
  );

  // Estado inicial de abertura (§5.4): 1–6 e 9 abrem com ≤8 docs; 7 e 8 nascem
  // SEMPRE recolhidas. Recalculado a cada recarga do dossiê.
  useEffect(() => {
    const inicial: Record<number, boolean> = {};
    for (const s of secoes) {
      inicial[s.numero] = s.numero !== 7 && s.numero !== 8 && s.docs.length <= 8;
    }
    setSecoesAbertas(inicial);
  }, [secoes]);

  // Filtro local (§5.9): texto (título, nº, nome do arquivo) e/ou tipo — sem rede.
  const filtroNorm = normalizarBusca(filtro.trim());
  const matchesPorSecao = useMemo(() => {
    if (!filtroNorm && !filtroTipo) return null;
    const mapa = new Map<number, DocDossie[]>();
    for (const s of secoes) {
      const casam = s.docs.filter((d) => {
        if (filtroTipo && d.tipoDocumento !== filtroTipo) return false;
        if (!filtroNorm) return true;
        return (
          normalizarBusca(d.titulo).includes(filtroNorm) ||
          (d.numeroDocumento !== null && normalizarBusca(d.numeroDocumento).includes(filtroNorm)) ||
          normalizarBusca(d.nomeArquivo).includes(filtroNorm)
        );
      });
      if (casam.length > 0) mapa.set(s.numero, casam);
    }
    return mapa;
  }, [filtroNorm, filtroTipo, secoes]);

  // Chips de tipo do trilho (§3-3): só os tipos presentes no dossiê, com contagem.
  const tiposPresentes = useMemo(() => {
    const cont = new Map<TipoDocumento, number>();
    for (const s of secoes) {
      for (const d of s.docs) {
        if (d.tipoDocumento) cont.set(d.tipoDocumento, (cont.get(d.tipoDocumento) ?? 0) + 1);
      }
    }
    return Array.from(cont.entries()).sort((a, b) => b[1] - a[1]);
  }, [secoes]);
  const totalMatches = useMemo(
    () => (matchesPorSecao ? Array.from(matchesPorSecao.values()).reduce((a, d) => a + d.length, 0) : 0),
    [matchesPorSecao]
  );
  const filtroAtivo = matchesPorSecao !== null;

  // Lista de navegação da gaveta: docs VISÍVEIS na ordem da tela — seções
  // 1..9 concatenadas, cada uma na sua ordenação, respeitando o filtro (§3).
  const docsNavegacao = useMemo(() => {
    const lista: DocDossie[] = [];
    for (const s of secoes) {
      if (matchesPorSecao) {
        const m = matchesPorSecao.get(s.numero);
        if (m) lista.push(...m);
      } else {
        lista.push(...s.docs);
      }
    }
    return lista;
  }, [secoes, matchesPorSecao]);

  const abrirDocumento = useCallback(
    (doc: DocDossie) => {
      const indice = docsNavegacao.findIndex((d) => d.id === doc.id);
      if (indice >= 0) setGavetaDocIndice(indice);
    },
    [docsNavegacao]
  );

  const irParaSecao = useCallback((numero: number) => {
    setSecoesAbertas((p) => ({ ...p, [numero]: true }));
    setSecaoAtiva(numero);
    rolarAte(`secao-${numero}`);
  }, []);

  const abrirUpload = useCallback((lacuna?: { tipo: TipoDocumento; papel: PapelDocumento }) => {
    // A gaveta de documento fecha antes: dois painéis com focus trap brigariam.
    setGavetaDocIndice(null);
    setGavetaUpload({ aberta: true, tipo: lacuna?.tipo, papel: lacuna?.papel });
  }, []);

  const abrirUploadLacuna = useCallback(
    (numero: 1 | 2 | 3) => {
      const vazio = VAZIOS_ESPERADOS.find((v) => v.numero === numero);
      abrirUpload(vazio ? { tipo: vazio.tipo, papel: vazio.papel } : undefined);
    },
    [abrirUpload]
  );

  // Trilho ativo: a última seção cujo topo já passou da âncora de leitura.
  useEffect(() => {
    if (secoes.length === 0) return;
    let raf = 0;
    const calcular = () => {
      raf = 0;
      let ativa: number | null = null;
      for (const s of secoes) {
        const el = document.getElementById(`secao-${s.numero}`);
        if (el && el.getBoundingClientRect().top <= 140) ativa = s.numero;
      }
      setSecaoAtiva(ativa ?? secoes[0].numero);
    };
    const aoRolar = () => {
      if (!raf) raf = requestAnimationFrame(calcular);
    };
    window.addEventListener("scroll", aoRolar, { passive: true });
    calcular();
    return () => {
      window.removeEventListener("scroll", aoRolar);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [secoes]);

  // Drag-and-drop global (§3.1): soltar arquivos em qualquer lugar da página
  // abre a GavetaUpload com eles. O drop DENTRO da dropzone da gaveta não chega
  // aqui (stopPropagation lá).
  useEffect(() => {
    const temArquivo = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const aoEntrar = (e: DragEvent) => {
      if (!temArquivo(e)) return;
      contadorDrag.current += 1;
      setArrastando(true);
    };
    const aoSobrevoar = (e: DragEvent) => {
      if (temArquivo(e)) e.preventDefault();
    };
    const aoSair = (e: DragEvent) => {
      if (!temArquivo(e)) return;
      contadorDrag.current = Math.max(0, contadorDrag.current - 1);
      if (contadorDrag.current === 0) setArrastando(false);
    };
    const aoSoltar = (e: DragEvent) => {
      if (!temArquivo(e)) return;
      e.preventDefault();
      contadorDrag.current = 0;
      setArrastando(false);
      const arquivos = Array.from(e.dataTransfer?.files ?? []);
      if (arquivos.length === 0) return;
      setArquivosSoltos(arquivos);
      setGavetaDocIndice(null);
      setGavetaUpload((g) => ({ ...g, aberta: true }));
    };

    // Fase de CAPTURA: TODO drop (inclusive na dropzone da gaveta, que faz
    // stopPropagation na bolha) zera o estado — senão o overlay fica preso.
    const aoSoltarCaptura = () => {
      contadorDrag.current = 0;
      setArrastando(false);
    };

    window.addEventListener("dragenter", aoEntrar);
    window.addEventListener("dragover", aoSobrevoar);
    window.addEventListener("dragleave", aoSair);
    window.addEventListener("drop", aoSoltar);
    window.addEventListener("drop", aoSoltarCaptura, true);
    return () => {
      window.removeEventListener("dragenter", aoEntrar);
      window.removeEventListener("dragover", aoSobrevoar);
      window.removeEventListener("dragleave", aoSair);
      window.removeEventListener("drop", aoSoltar);
      window.removeEventListener("drop", aoSoltarCaptura, true);
    };
  }, []);

  // ── Downloads (§5.6) ───────────────────────────────────────────────────────

  const baixarZip = useCallback(
    async (
      // C6: `arvore` é campo do BODY (§1a — esta rota não lê query string) e
      // NUNCA viaja junto de `ids`: a forma com ids é a que o servidor recusa
      // com 422, e a ficha nunca a envia com árvore.
      body: { operacaoId: string; secao?: number; ids?: string[]; arvore?: "secao" | "disciplina" },
      nomeLocal: string
    ) => {
      const r = await fetch("/api/conformidade/cofre/documentos/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Erro ${r.status}`);
      }
      const blob = await r.blob();
      // Nome do servidor quando houver; nas PARTES o front renomeia (o servidor
      // não sabe qual parte é — comentário do próprio R12).
      salvarBlob(blob, body.ids ? nomeLocal : nomeDoContentDisposition(r) ?? nomeLocal);
    },
    []
  );

  async function baixarDossie() {
    if (!dossie) return;
    setErroDownload(null);
    setBaixandoDossie(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await baixarZip({ operacaoId: dossie.id }, `dossie_${dossie.codigo}_${stamp}.zip`);
    } catch (e) {
      setErroDownload(e instanceof Error ? e.message : "Falha ao gerar o ZIP");
    } finally {
      setBaixandoDossie(false);
    }
  }

  /**
   * C6 — o dossiê inteiro, organizado por disciplina em vez de por seção. O
   * conjunto é o MESMO (a árvore não filtra nada), e por isso o teto de
   * `estouraTetoZip` vale para os dois botões sem nenhuma mudança.
   */
  async function baixarPorDisciplina() {
    if (!dossie) return;
    setErroDownload(null);
    setBaixandoDisciplina(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await baixarZip(
        { operacaoId: dossie.id, arvore: "disciplina" },
        `dossie_${dossie.codigo}_disciplina_${stamp}.zip`
      );
    } catch (e) {
      setErroDownload(e instanceof Error ? e.message : "Falha ao gerar o ZIP");
    } finally {
      setBaixandoDisciplina(false);
    }
  }

  async function baixarSecao(secao: SecaoMontada) {
    if (!dossie) return;
    setErroDownload(null);
    const stamp = new Date().toISOString().slice(0, 10);

    if (!estouraTetoZip(secao.docs)) {
      setDownloadSecao({ numero: secao.numero, rotulo: "Gerando ZIP..." });
      try {
        await baixarZip(
          { operacaoId: dossie.id, secao: secao.numero },
          `dossie_${dossie.codigo}_secao${secao.numero}_${stamp}.zip`
        );
      } catch (e) {
        setErroDownload(e instanceof Error ? e.message : "Falha ao gerar o ZIP");
      } finally {
        setDownloadSecao(null);
      }
      return;
    }

    // Seção que estoura teto: K chamadas SEQUENCIAIS com recorte de ids na
    // ordem estável de R12; falha no meio interrompe — as partes já baixadas
    // são independentes e valem.
    const blocos = fatiarParaDownload(secao.docs);
    for (let k = 0; k < blocos.length; k++) {
      setDownloadSecao({
        numero: secao.numero,
        rotulo: `Gerando parte ${k + 1} de ${blocos.length}…`,
      });
      try {
        await baixarZip(
          { operacaoId: dossie.id, secao: secao.numero, ids: blocos[k] },
          `dossie_${dossie.codigo}_secao${secao.numero}_parte${k + 1}de${blocos.length}.zip`
        );
      } catch {
        setErroDownload(
          `Parte ${k + 1} de ${blocos.length} falhou — as partes já baixadas valem.`
        );
        break;
      }
    }
    setDownloadSecao(null);
  }

  // ── Vínculo de família (§5.7) ──────────────────────────────────────────────

  function toggleSelecao(docId: string) {
    setSelecionados((p) => {
      const c = new Set(p);
      if (c.has(docId)) c.delete(docId);
      else c.add(docId);
      return c;
    });
  }

  async function vincularFamiliaEmDoc(docId: string, familiaId: string): Promise<string | null> {
    try {
      const r = await fetch(`/api/conformidade/cofre/documentos/${docId}/familias`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ familiaId }),
      });
      if (r.ok) return null;
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      return j?.error ?? `Erro ${r.status}`;
    } catch (e) {
      return e instanceof Error ? e.message : "Falha de rede";
    }
  }

  async function aoEscolherFamilia(familiaId: string) {
    if (!modalFamilia) return;
    const alvo = modalFamilia;
    setModalFamilia(null);

    if (alvo.modo === "doc") {
      const falha = await vincularFamiliaEmDoc(alvo.doc.id, familiaId);
      if (falha) {
        setErrosVinculo((p) => ({ ...p, [alvo.doc.id]: falha }));
      } else {
        setErrosVinculo((p) => {
          const resto = { ...p };
          delete resto[alvo.doc.id];
          return resto;
        });
        setAnuncio("Família vinculada");
        await carregar();
      }
      return;
    }

    // Em massa: laço client-side (3 em voo) sobre a rota unitária — decisão
    // declarada §5.7, nenhuma rota nova.
    const ids = Array.from(selecionados);
    const falhas: Record<string, string> = {};
    let ok = 0;
    await executarComLimite(ids, 3, async (docId) => {
      const falha = await vincularFamiliaEmDoc(docId, familiaId);
      if (falha) falhas[docId] = falha;
      else ok++;
    });
    setErrosVinculo(falhas);
    const nFalhas = Object.keys(falhas).length;
    const resumo =
      nFalhas > 0
        ? `Vinculadas ${ok} de ${ids.length} · ${nFalhas} falharam (veja o motivo na linha)`
        : `Vinculadas ${ok} de ${ids.length}`;
    setMensagemMassa(resumo);
    setAnuncio(resumo);
    setSelecionados(new Set());
    if (ok > 0) await carregar();
  }

  // ── Estados de tela ────────────────────────────────────────────────────────

  if (carregando) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
        <span className="ml-2 text-sm text-gray-500">Carregando...</span>
      </div>
    );
  }

  if (naoEncontrada) {
    return (
      <div className="max-w-3xl mx-auto">
        <VoltarParaOperacoes />
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="h-8 w-8 text-gray-300 mb-3" />
          <p className="text-sm font-semibold text-gray-700 mb-1">Operação não encontrada</p>
          <p className="text-xs text-gray-500">
            Ela pode ter sido excluída, ou o endereço está errado.
          </p>
        </div>
      </div>
    );
  }

  if (erro || !dossie) {
    return (
      <div className="max-w-3xl mx-auto">
        <VoltarParaOperacoes />
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {erro ?? "Não foi possível carregar a operação"}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCarregando(true);
              void carregar();
            }}
            className="ml-auto rounded-md"
          >
            Tentar novamente
          </Button>
        </div>
      </div>
    );
  }

  // ── Derivados de render ────────────────────────────────────────────────────

  const temValorHh = "valor" in dossie;
  const periodo = formatarPeriodo(dossie.periodoInicio, dossie.periodoFim);

  // Título padronizado sai da lib (tituloOperacao) — aqui só se recorta para
  // colorir o código e acinzentar o objeto.
  const tituloCompleto = tituloOperacao(dossie);
  const partesTitulo = tituloCompleto.split(" — ");
  const tituloCliente = partesTitulo[1] ?? dossie.clienteNome;
  const tituloObjeto = partesTitulo.length > 2 ? partesTitulo.slice(2).join(" — ") : null;

  /** Fatos-chave do hero (§3-1). `foco` liga o fato vazio ao campo do editor. */
  const fatos: Array<{
    rotulo: string;
    valor: string | null;
    mono?: boolean;
    restritoAoSetor?: boolean;
    foco?: "contratoNumero";
  }> = [
    { rotulo: "Contrato nº", valor: dossie.contratoNumero, mono: true, foco: "contratoNumero" },
    { rotulo: "Período", valor: periodo },
    temValorHh
      ? { rotulo: "Valor", valor: formatarMoeda(dossie.valor ?? null) }
      : { rotulo: "Valor", valor: null, restritoAoSetor: true },
    temValorHh
      ? { rotulo: "Homem-hora", valor: formatarHh(dossie.hh ?? null) }
      : { rotulo: "Homem-hora", valor: null, restritoAoSetor: true },
    { rotulo: "Unidade / local", valor: dossie.unidade },
    { rotulo: "Área da planta", valor: dossie.area },
    { rotulo: "CNPJ do cliente", valor: dossie.clienteCnpj, mono: true },
    { rotulo: "Ramo de atividade", valor: dossie.ramo },
    { rotulo: "Onshore / offshore", valor: dossie.onshoreOffshore },
  ];

  // Completude do cadastro (§3-1): 8 dados; valor sai da conta quando a chave
  // é omitida por papel (restrito não é lacuna).
  const completude = [
    Boolean(dossie.clienteNome.trim()),
    Boolean(dossie.clienteGrupo?.trim()),
    Boolean(dossie.clienteCnpj),
    Boolean(dossie.contratoNumero),
    periodo !== null,
    ...(temValorHh ? [Boolean(dossie.valor)] : []),
    Boolean(dossie.unidade),
    Boolean((dossie.escopo ?? "").trim()),
  ];
  const totalDados = completude.length;
  const dadosPreenchidos = completude.filter(Boolean).length;

  const dossieEstoura = estouraTetoZip(documentos);
  const motivoDossieEstoura =
    documentos.length > LIMITE_ZIP_DOCS
      ? `${documentos.length} peças — o ZIP aceita ${LIMITE_ZIP_DOCS}. Baixe por seção.`
      : `Pacote de ${(somaBytes(documentos) / 1048576).toFixed(0)} MB — o máximo é ${(LIMITE_ZIP_BYTES / 1048576).toFixed(0)} MB. Baixe por seção.`;

  // C6 — quantas peças cairiam em `0_Sem_disciplina`. Quem baixa por disciplina
  // está montando resposta de edital: descobrir depois de descompactar que
  // metade caiu no balde é caro, então o número vai no `title` ANTES do clique.
  // `disciplinaId?` existe em DocDossie desde a onda 4; `?? null` cobre o
  // intervalo entre o deploy do front e o do BFF.
  const semDisciplina = documentos.filter((d) => (d.disciplinaId ?? null) === null).length;
  const semNenhumaDisciplina = documentos.length > 0 && semDisciplina === documentos.length;
  const tituloBotaoDisciplina = semNenhumaDisciplina
    ? "Nenhum documento tem disciplina — o ZIP sairia com uma pasta só."
    : semDisciplina > 0
      ? `${semDisciplina} de ${documentos.length} peças sem disciplina — vão para a pasta 0_Sem_disciplina.`
      : "As pastas do ZIP saem por disciplina, não por seção do dossiê.";

  const numerosPresentes = new Set<number>(secoes.map((s) => s.numero));
  const opcionaisFaltando = [4, 5, 6, 7, 8].filter((n) => !numerosPresentes.has(n));
  const fraseOpcionais =
    opcionaisFaltando.length > 0
      ? `Sem ${opcionaisFaltando
          .map((n) => NOME_CURTO_OPCIONAL[n])
          .join(", sem ")
          .replace(/, sem ([^,]+)$/, " e sem $1")} nesta operação.`
      : null;

  const itensTrilho = secoes
    .map((s) => ({
      numero: s.numero,
      nome: NOME_TRILHO[s.numero],
      contagem: matchesPorSecao ? matchesPorSecao.get(s.numero)?.length ?? 0 : s.docs.length,
    }))
    .filter((i) => !filtroAtivo || i.contagem > 0);

  return (
    <div className="max-w-6xl mx-auto">
      <p aria-live="polite" className="sr-only">
        {anuncio}
      </p>

      {/* Overlay do arrasto global — pointer-events-none: o drop cai no window. */}
      {arrastando && (
        <div className="fixed inset-0 z-[60] pointer-events-none bg-black/30 p-6 flex items-center justify-center">
          <div className="rounded-2xl border-2 border-dashed border-brand-orange bg-white px-8 py-6 text-center shadow-2xl">
            <UploadCloud className="h-8 w-8 text-brand-orange mx-auto mb-2" aria-hidden="true" />
            <p className="text-sm font-semibold text-brand-black">
              Solte para subir na {dossie.codigo}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Os arquivos entram no lote para revisão antes de qualquer envio.
            </p>
          </div>
        </div>
      )}

      {/* ── Hero (§3-1) ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
        <Link
          href="/acervo/operacoes"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Operações
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1
              title={tituloCompleto}
              className="text-xl font-bold text-brand-black leading-snug flex items-baseline gap-2 flex-wrap"
            >
              <span className="font-mono text-brand-orange">{dossie.codigo}</span>
              <span aria-hidden="true">—</span>
              <span>{tituloCliente}</span>
              {tituloObjeto && (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="font-normal text-gray-600">{tituloObjeto}</span>
                </>
              )}
            </h1>
            {dossie.clienteGrupo && dossie.clienteGrupo.trim() !== dossie.clienteNome && (
              <p className="text-xs text-gray-500 mt-0.5">Razão social: {dossie.clienteNome}</p>
            )}

            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span
                title={`Detentora do acervo: ${DETENTORA_LABELS[dossie.detentora]}`}
                className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
                  COR_DETENTORA[dossie.detentora]
                )}
              >
                {DETENTORA_LABELS[dossie.detentora]}
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px] font-medium uppercase tracking-wide">
                {ORIGEM_OPERACAO_LABELS[dossie.origem]}
              </span>
              {!dossie.ativo && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 text-[10px] font-semibold uppercase tracking-wide">
                  Inativa
                </span>
              )}
            </div>
          </div>

          {/* Ações do workspace */}
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            {/* `flex-wrap justify-end`: com o quarto controle (C6), abaixo de lg
                o menu seria empurrado para fora do cartão sem isso (§7.4). */}
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Button size="sm" onClick={() => abrirUpload()}>
                <Upload className="h-3.5 w-3.5" aria-hidden="true" /> Subir documentos
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={baixarDossie}
                disabled={dossieEstoura || baixandoDossie || documentos.length === 0}
              >
                {baixandoDossie ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {baixandoDossie ? "Gerando ZIP..." : `Baixar dossiê (${documentos.length})`}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={baixarPorDisciplina}
                disabled={dossieEstoura || baixandoDisciplina || semNenhumaDisciplina}
                title={tituloBotaoDisciplina}
              >
                {baixandoDisciplina ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FolderTree className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Por disciplina
              </Button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuAberto((v) => !v)}
                  aria-expanded={menuAberto}
                  aria-haspopup="menu"
                  aria-label="Mais ações"
                  className="p-2 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  <MoreHorizontal className="h-4 w-4 text-gray-500" aria-hidden="true" />
                </button>
                {menuAberto && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenuAberto(false)} />
                    <div
                      role="menu"
                      className="absolute right-0 mt-1 z-40 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-48"
                    >
                      <button
                        role="menuitem"
                        onClick={() => {
                          void navigator.clipboard.writeText(dossie.codigo);
                          setAnuncio(`Código ${dossie.codigo} copiado`);
                          setMenuAberto(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 text-left"
                      >
                        <Copy className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" /> Copiar código
                      </button>
                      <Link
                        role="menuitem"
                        href={`/acervo/cofre?operacaoId=${dossie.id}`}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        <FileText className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" /> Ver no cofre
                      </Link>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setModalEditar({});
                          setMenuAberto(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 text-left"
                      >
                        <Pencil className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" /> Editar cadastro
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            {dossieEstoura && (
              /* Motivo escrito ao lado, não em tooltip (§5.6). */
              <p className="text-[11px] text-amber-700 text-right max-w-64">{motivoDossieEstoura}</p>
            )}
          </div>
        </div>

        {/* Grid de fatos-chave */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-x-4 gap-y-3 mt-4">
          {fatos.map((f) => (
            <Fato
              key={f.rotulo}
              rotulo={f.rotulo}
              valor={f.valor}
              mono={f.mono}
              restritoAoSetor={f.restritoAoSetor}
              onInformar={() => setModalEditar(f.foco ? { foco: f.foco } : {})}
            />
          ))}
        </div>

        {/* Disciplinas da obra (0043) — bloco à parte, NUNCA uma 10ª seção
            (spec ONDA-4 §1b): é atributo da operação, não pilha de documentos.
            Por isso também NÃO entra na barra "N de M dados" logo abaixo. */}
        <BlocoDisciplinas
          operacaoId={dossie.id}
          codigo={dossie.codigo}
          disciplinas={dossie.disciplinas ?? []}
          podeEditar={podeGerenciar}
          onAtualizado={(novas) => setDossie((d) => (d ? { ...d, disciplinas: novas } : d))}
        />

        {/* Completude do cadastro */}
        <div className="flex items-center gap-3 mt-4">
          <div
            role="img"
            aria-label={`Cadastro com ${dadosPreenchidos} de ${totalDados} dados preenchidos`}
            className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden"
          >
            <div
              className="h-full bg-brand-orange rounded-full"
              style={{ width: `${totalDados > 0 ? Math.round((dadosPreenchidos / totalDados) * 100) : 0}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
            {dadosPreenchidos} de {totalDados} dados
          </span>
        </div>
      </div>

      {/* ── Cartões de comprovação (§3-2) ── */}
      <BarraComprovacao
        contadores={contadores}
        onIrParaSecao={irParaSecao}
        onSubirLacuna={abrirUploadLacuna}
      />
      {dossie.detentora !== "PROPONENTE" && (
        <p className="flex items-start gap-1.5 text-xs text-gray-600 mb-3">
          <Info className="h-3.5 w-3.5 text-gray-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
          Acervo de {DETENTORA_LABELS[dossie.detentora]}: confirme no edital se atestado de
          terceiro é aceito antes de usar em habilitação.
        </p>
      )}

      {/* Linha do tempo da obra (D9) — bloco à parte, como Disciplinas: NÃO é
          uma 10ª seção, não entra no trilho, não entra
          no ZIP e o observer das nove seções não a conhece. */}
      <TimelineOperacao
        timeline={timeline}
        codigo={dossie.codigo}
        onAbrirDocumento={(docId) => {
          const i = docsNavegacao.findIndex((d) => d.id === docId);
          if (i >= 0) setGavetaDocIndice(i);
        }}
      />

      {erroDownload && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl p-3 mb-3 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1">{erroDownload}</span>
          <button onClick={() => setErroDownload(null)} aria-label="Fechar aviso">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Corpo do dossiê: trilho + seções (§3-3) ── */}
      {documentos.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 mb-5 text-center">
          <p className="text-sm text-gray-400 mb-4">
            Nenhuma prova guardada. Enquanto o cofre não tiver atestado desta operação, ela não
            comprova nada em habilitação.
          </p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {VAZIOS_ESPERADOS.map((v) => (
              <Button
                key={v.numero}
                variant="secondary"
                size="sm"
                onClick={() => abrirUpload({ tipo: v.tipo, papel: v.papel })}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" /> {v.botao}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="xl:grid xl:grid-cols-[240px_1fr] xl:gap-6 xl:items-start">
          {/* Trilho sticky: seções + busca. Abaixo de xl vira linha rolável. */}
          <aside className="mb-4 xl:mb-0 xl:sticky xl:top-6 xl:self-start">
            <nav
              aria-label="Seções do dossiê"
              className="flex gap-1 overflow-x-auto pb-1 xl:pb-0 xl:flex-col xl:overflow-visible"
            >
              {itensTrilho.map((item) => {
                const ativa = secaoAtiva === item.numero;
                return (
                  <button
                    key={item.numero}
                    type="button"
                    onClick={() => irParaSecao(item.numero)}
                    aria-current={ativa ? "true" : undefined}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-lg text-left flex-shrink-0 xl:w-full transition-colors",
                      ativa ? "bg-orange-50 text-brand-orange" : "text-gray-600 hover:bg-gray-50"
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-5 w-5 rounded bg-gray-100 font-mono text-[10px] font-semibold flex items-center justify-center flex-shrink-0",
                        ativa ? "bg-brand-orange/15 text-brand-orange" : "text-gray-500"
                      )}
                    >
                      {item.numero}
                    </span>
                    <span className="text-xs font-semibold whitespace-nowrap xl:whitespace-normal min-w-0 truncate">
                      {item.nome}
                    </span>
                    <span className="text-[11px] text-gray-400 tabular-nums ml-auto pl-1">
                      {item.contagem}
                    </span>
                  </button>
                );
              })}
            </nav>

            {/* Busca local (§5.9): mesma lógica de filtro, agora no trilho. */}
            <div className="mt-3">
              <input
                type="text"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="Filtrar dentro desta operação..."
                aria-label="Filtrar dentro desta operação"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              />
              {tiposPresentes.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Filtrar por tipo de documento">
                  {tiposPresentes.map(([tipo, n]) => {
                    const ativo = filtroTipo === tipo;
                    return (
                      <button
                        key={tipo}
                        type="button"
                        aria-pressed={ativo}
                        onClick={() => setFiltroTipo(ativo ? null : tipo)}
                        className={cn(
                          "px-1.5 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap transition-colors tabular-nums",
                          ativo
                            ? "bg-brand-orange/15 text-brand-orange border-brand-orange/40"
                            : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100"
                        )}
                      >
                        {TIPO_DOCUMENTO_LABELS[tipo]} {n}
                      </button>
                    );
                  })}
                </div>
              )}
              {(filtro || filtroTipo) && (
                <button
                  type="button"
                  onClick={() => {
                    setFiltro("");
                    setFiltroTipo(null);
                  }}
                  className="mt-1.5 text-xs text-gray-400 hover:text-red-500 inline-flex items-center gap-1"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> limpar
                </button>
              )}
              {filtroAtivo && (
                <p aria-live="polite" className="text-xs text-gray-500 mt-1.5">
                  {filtro.trim()
                    ? totalMatches > 0
                      ? `${totalMatches} documento${totalMatches !== 1 ? "s" : ""} ${totalMatches !== 1 ? "casam" : "casa"} com "${filtro.trim()}"`
                      : `Nada nesta operação casa com "${filtro.trim()}".`
                    : filtroTipo
                      ? `${totalMatches} documento${totalMatches !== 1 ? "s" : ""} do tipo ${TIPO_DOCUMENTO_LABELS[filtroTipo]}`
                      : null}
                </p>
              )}
            </div>
          </aside>

          <div className="min-w-0">
            {mensagemMassa && (
              <p className="text-xs font-semibold text-gray-700 mb-2" role="status">
                {mensagemMassa}
              </p>
            )}

            {/* Seções 1..9 na ordem, com vazios esperados no lugar (§5.4). */}
            {([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((numero) => {
              const secao = secoes.find((s) => s.numero === numero);
              if (!secao) {
                if (filtroAtivo) return null;
                const vazio = VAZIOS_ESPERADOS.find((v) => v.numero === numero);
                if (!vazio) return null;
                return (
                  <div
                    key={numero}
                    id={`secao-${numero}`}
                    className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3 text-sm text-amber-800 flex-wrap scroll-mt-24"
                  >
                    <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-[200px]">{vazio.texto}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => abrirUpload({ tipo: vazio.tipo, papel: vazio.papel })}
                    >
                      {vazio.botao}
                    </Button>
                  </div>
                );
              }

              const docsFiltrados = filtroAtivo ? matchesPorSecao?.get(numero) ?? null : null;
              if (filtroAtivo && docsFiltrados === null) return null;

              const partes = estouraTetoZip(secao.docs) ? fatiarParaDownload(secao.docs).length : 1;
              const download: EstadoDownloadSecao = {
                baixando: downloadSecao?.numero === numero,
                rotuloProgresso: downloadSecao?.numero === numero ? downloadSecao.rotulo : null,
              };

              return (
                <SecaoDossie
                  key={numero}
                  secao={secao}
                  aberta={secoesAbertas[numero] ?? false}
                  onToggle={() => setSecoesAbertas((p) => ({ ...p, [numero]: !(p[numero] ?? false) }))}
                  docsFiltrados={docsFiltrados}
                  partesDownload={partes}
                  download={download}
                  onBaixar={() => void baixarSecao(secao)}
                  renderLinha={(doc) => (
                    <LinhaDocumento
                      key={doc.id}
                      doc={doc}
                      operacaoDetentora={dossie.detentora}
                      secaoNumero={numero}
                      selecionavel={numero === 2 || numero === 3}
                      selecionado={selecionados.has(doc.id)}
                      onToggleSelecao={toggleSelecao}
                      onClickFamilia={(d) => setModalFamilia({ modo: "doc", doc: d })}
                      onAbrir={abrirDocumento}
                      erroVinculo={errosVinculo[doc.id] ?? null}
                    />
                  )}
                />
              );
            })}

            {!filtroAtivo && fraseOpcionais && (
              <p className="text-xs text-gray-400 mb-5">{fraseOpcionais}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Escopo colapsável depois das seções (§3-4): o objeto já está no título. ── */}
      {dossie.escopo && (
        <div className="bg-white border border-gray-200 rounded-xl mb-3 overflow-hidden">
          <button
            type="button"
            onClick={() => setEscopoAberto((v) => !v)}
            aria-expanded={escopoAberto}
            aria-controls="escopo-operacao"
            className="w-full flex items-center gap-2 px-4 py-3 text-left"
          >
            {escopoAberto ? (
              <ChevronDown className="h-4 w-4 text-gray-400" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4 text-gray-400" aria-hidden="true" />
            )}
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Escopo (objeto do contrato)
            </span>
          </button>
          {escopoAberto && (
            <p id="escopo-operacao" className="px-4 pb-4 text-sm text-gray-700 whitespace-pre-line">
              {dossie.escopo}
            </p>
          )}
        </div>
      )}

      {/* Famílias sugeridas pelo catálogo — referência, não vínculo (§5.7). */}
      {dossie.familiasSugeridas && dossie.familiasSugeridas.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400 mb-2">
            <ListTree className="h-3 w-3" /> Famílias CRC sugeridas
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Referência do catálogo para triagem. O vínculo que vale em habilitação continua sendo o
            de cada documento com a família, feito na página do documento.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {dossie.familiasSugeridas.map((codigo) => (
              <span
                key={codigo}
                className="px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 text-xs font-mono"
              >
                {codigo}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Anotações da obra (B7). O que se sabe e não cabe em campo: "a ART da
          obra 12345 cita uma área que o contrato não traz". */}
      <BlocoAnotacoes
        alvoTipo="OPERACAO"
        alvoId={dossie.id}
        titulo="Anotações da obra"
        podeEscrever={podeGerenciar}
        usuarioId={session?.user?.id ?? null}
        ehAdmin={session?.user?.role === "ADMIN"}
      />

      {/* Adoção de órfãos (§5.10) — mantida no fim. */}
      <GavetaAdocao
        operacao={{ id: dossie.id, codigo: dossie.codigo, clienteNome: dossie.clienteNome }}
        onVinculado={() => void carregar()}
      />

      {/* Barra contextual da seleção (§5.7) */}
      {selecionados.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-gray-900 text-white rounded-full px-5 py-3 shadow-2xl flex items-center gap-4">
          <span className="text-sm">
            <strong>{selecionados.size}</strong> selecionada{selecionados.size !== 1 ? "s" : ""}
          </span>
          <button
            onClick={() => setSelecionados(new Set())}
            className="text-xs text-gray-300 hover:text-white"
          >
            Limpar
          </button>
          <Button size="sm" onClick={() => setModalFamilia({ modo: "massa" })} className="rounded-full">
            Marcar família
          </Button>
        </div>
      )}

      {modalFamilia && (
        <ModalVincularFamilia
          titulo={
            modalFamilia.modo === "massa"
              ? `Marcar família nas ${selecionados.size} selecionadas`
              : "Vincular família CRC"
          }
          onClose={() => setModalFamilia(null)}
          onSelect={(familiaId) => void aoEscolherFamilia(familiaId)}
        />
      )}

      {modalEditar && (
        <ModalEditarOperacao
          operacao={dossie}
          focoInicial={modalEditar.foco}
          onFechar={() => setModalEditar(null)}
          onSalvo={() => {
            setModalEditar(null);
            setAnuncio("Cadastro atualizado");
            void carregar();
          }}
          onNaoEncontrada={() => {
            setModalEditar(null);
            setNaoEncontrada(true);
          }}
        />
      )}

      {/* Gaveta de documento (§2.3): prévia + ações sem sair da ficha. */}
      {gavetaDocIndice !== null && docsNavegacao.length > 0 && (
        <GavetaDocumento
          docs={docsNavegacao}
          indice={gavetaDocIndice}
          onFechar={() => setGavetaDocIndice(null)}
          onNavegar={setGavetaDocIndice}
          onMudou={() => void carregar()}
          podeExcluir={podeExcluir}
          contexto="ficha"
        />
      )}

      {/* Gaveta de upload (§3.1) — montada junto da ficha, lote sobrevive ao fechar. */}
      <GavetaUpload
        operacao={{
          id: dossie.id,
          codigo: dossie.codigo,
          clienteNome: dossie.clienteNome,
          detentora: dossie.detentora,
        }}
        aberta={gavetaUpload.aberta}
        onFechar={() => {
          setGavetaUpload((g) => ({ ...g, aberta: false }));
          setArquivosSoltos(null);
        }}
        onConcluido={() => void carregar()}
        tipoInicial={gavetaUpload.tipo}
        papelInicial={gavetaUpload.papel}
        arquivosIniciais={arquivosSoltos ?? undefined}
      />
    </div>
  );
}

// ── Componentes de apoio ─────────────────────────────────────────────────────

/** A migalha mudou de pai: o índice de operações é o caminho natural (§3). */
function VoltarParaOperacoes() {
  return (
    <Link
      href="/acervo/operacoes"
      className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
    >
      <ChevronLeft className="h-4 w-4" /> Operações
    </Link>
  );
}

/**
 * Fato-chave do hero. Vazio vira "—" clicável que abre o editor de cadastro;
 * chave omitida por R3 (papel fora de Conformidade) vira "restrito ao setor" —
 * não é lacuna de cadastro, dizer "não informado" mentiria.
 */
function Fato({
  rotulo,
  valor,
  mono = false,
  restritoAoSetor = false,
  onInformar,
}: {
  rotulo: string;
  valor: string | null;
  mono?: boolean;
  restritoAoSetor?: boolean;
  onInformar: () => void;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">{rotulo}</p>
      {valor ? (
        <p
          className={cn("text-sm text-gray-700 tabular-nums break-words", mono && "font-mono text-[13px]")}
          title={valor}
        >
          {valor}
        </p>
      ) : restritoAoSetor ? (
        <p className="text-sm text-gray-400 italic">restrito ao setor</p>
      ) : (
        <button
          type="button"
          onClick={onInformar}
          aria-label={`Informar ${rotulo}`}
          title="Não informado — clique para editar o cadastro"
          className="text-sm font-semibold text-gray-300 hover:text-brand-orange leading-tight transition-colors"
        >
          —
        </button>
      )}
    </div>
  );
}
