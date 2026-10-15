"use client";

/**
 * /acervo/profissionais/[id] — o currículo técnico do RT (spec ONDA-4 §7.7).
 *
 * Tudo o que esta tela mostra vem de `curriculoDoProfissional()` (§4.5), a
 * MESMA função que o relatório C1 gera em XLSX e PDF: os botões de download
 * não recalculam nada, e um número diferente entre a tela e o anexo de
 * habilitação significaria uma segunda regra de currículo — exatamente o que
 * Q10.6 proíbe. Por isso não há fetch de dados aqui: o server component
 * entrega o `CurriculoRt` inteiro por prop.
 *
 * O modal de edição mora AQUI dentro, sem arquivo próprio (§6), no padrão do
 * `ModalNovoProjeto`. `baixar()` e `nomeDoHeader()` são cópia dos privados de
 * `RelatorioCard.tsx`.
 */

import { useCallback, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ChevronLeft,
  FileSpreadsheet,
  FileText,
  Info,
  ListTree,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useModalA11y } from "@/components/ui/useModalA11y";
import { ChipTipoDocumento } from "@/app/acervo/_componentes/ChipTipoDocumento";
import { TIPOS_DOCUMENTO, type TipoDocumento } from "@/lib/conformidade/operacoes";
import { formatarPeriodo } from "@/app/acervo/operacoes/[id]/secoes";
import { PAPEL_PROFISSIONAL_LABELS } from "@/lib/conformidade/profissionais/validations";
import type { EditarProfissionalInput } from "@/lib/conformidade/profissionais/validations";
import type {
  AtividadeDoDocumento,
  CurriculoRt,
  DocumentoDoCurriculo,
  OperacaoDoCurriculo,
} from "@/lib/conformidade/profissionais/queries";

interface Props {
  curriculo: CurriculoRt;
  podeGerenciar: boolean;
}

/** PATCH /api/conformidade/profissionais/[id] (§5.5): erro traz `error`/`detalhes`. */
interface RespostaPatch {
  error?: string;
  detalhes?: Record<string, string>;
}

type Formato = "xlsx" | "pdf";

// ── Formatação ───────────────────────────────────────────────────────────────

/** O currículo traz o tipo como string solta; só vira chip o que é do domínio (mesma regra da GavetaDocumento). */
function comoTipo(valor: string | null): TipoDocumento | null {
  return valor && (TIPOS_DOCUMENTO as readonly string[]).includes(valor) ? (valor as TipoDocumento) : null;
}

const CLASSE_INPUT =
  "w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange disabled:bg-gray-50 disabled:text-gray-400";

const CLASSE_ROTULO = "block text-[10px] font-semibold uppercase tracking-wide text-gray-400";

const CLASSE_CHIP_DISCIPLINA =
  "inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium text-gray-600 bg-gray-100 border border-gray-200 rounded-full";

/** Nome do arquivo baixado — cópia do privado de `RelatorioCard.tsx`. */
function nomeDoHeader(disposition: string | null, contentType: string | null, slug: string): string {
  if (disposition) {
    const estrela = /filename\*=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition);
    if (estrela?.[1]) return decodeURIComponent(estrela[1]);
    const simples = /filename=["']?([^"';]+)/i.exec(disposition);
    if (simples?.[1]) return simples[1];
  }
  const dataSlug = new Date().toISOString().slice(0, 10);
  const ext = contentType?.includes("pdf") ? "pdf" : "xlsx";
  return `relatorio-${slug}-${dataSlug}.${ext}`;
}

// ── Componente ───────────────────────────────────────────────────────────────

export function CurriculoClient({ curriculo, podeGerenciar }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editando, setEditando] = useState(false);
  const [baixando, setBaixando] = useState<Formato | null>(null);
  const [erroDownload, setErroDownload] = useState<string | null>(null);

  const { profissional, contagens, ignorados, operacoes } = curriculo;

  /**
   * Cópia do `baixar()` privado de `RelatorioCard.tsx`: o blob vem da MESMA
   * rota parametrizada `/api/relatorios/[tipo]`, e o nome do arquivo sai do
   * `Content-Disposition` — quem nomeia é o handler, num lugar só.
   */
  const baixar = useCallback(
    async (formato: Formato) => {
      setErroDownload(null);
      setBaixando(formato);
      try {
        const r = await fetch(
          `/api/relatorios/curriculo-rt?formato=${formato}&profissionalId=${profissional.id}`
        );
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          // Mensagem do servidor nunca é trocada por genérica (regra do módulo).
          setErroDownload(j.error ?? `Erro ${r.status} ao gerar o currículo`);
          return;
        }
        const blob = await r.blob();
        const nomeArq = nomeDoHeader(
          r.headers.get("Content-Disposition"),
          r.headers.get("Content-Type"),
          "curriculo-rt"
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = nomeArq;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setErroDownload(e instanceof Error ? e.message : "Erro ao baixar o currículo");
      } finally {
        setBaixando(null);
      }
    },
    [profissional.id]
  );

  const editado = useCallback(() => {
    setEditando(false);
    startTransition(() => router.refresh());
  }, [router]);

  const ocupado = baixando !== null;

  return (
    <div className="flex flex-col h-full">
      {/* ── 1. Cabeçalho da pessoa ────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/acervo/profissionais"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
          >
            <ChevronLeft className="h-3 w-3" /> Profissionais
          </Link>
          <h1 className="text-2xl font-bold text-brand-black">{profissional.nome}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
            <span className="font-mono">
              {profissional.crea
                ? `CREA ${profissional.crea}${profissional.creaUf ? `/${profissional.creaUf}` : ""}`
                : "CREA não informado"}
            </span>
            {profissional.formacao && (
              <>
                <span aria-hidden="true">·</span>
                <span>{profissional.formacao}</span>
              </>
            )}
            <span
              className={
                profissional.ativo
                  ? "inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-700"
                  : "inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500"
              }
            >
              {profissional.ativo ? "Ativo" : "Inativo"}
            </span>
          </p>
        </div>
        {podeGerenciar && (
          <Button type="button" variant="secondary" onClick={() => setEditando(true)} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Editar
          </Button>
        )}
      </div>

      {/* ── 2. Faixa de contagens + o que ficou de fora (Q4) ──────────────── */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3">
        <p className="text-sm text-gray-700 tabular-nums">
          <strong>{contagens.operacoes.toLocaleString("pt-BR")}</strong> obras ·{" "}
          <strong>{contagens.documentos.toLocaleString("pt-BR")}</strong> documentos ·{" "}
          <strong>{contagens.atividades.toLocaleString("pt-BR")}</strong> atividades de ART
        </p>
        {/*
          Q4 aplicado ao currículo: o documento que NÃO entrou na hierarquia
          aparece contado, nunca some. `semOperacao` fica fora porque a
          hierarquia começa na obra — somado a `contagens.documentos` dá o
          total de documentos visíveis do profissional.
        */}
        <p className="mt-1 text-[11px] text-gray-400">
          Fora do currículo: {ignorados.semOperacao.toLocaleString("pt-BR")} documentos sem operação.
        </p>
      </div>

      {/* ── 3. Os dois botões do C1 + o atalho para o cofre ───────────────── */}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => baixar("pdf")}
            loading={baixando === "pdf"}
            disabled={ocupado}
            className="gap-1.5"
          >
            <FileText className="h-4 w-4" aria-hidden="true" /> Baixar currículo PDF
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => baixar("xlsx")}
            loading={baixando === "xlsx"}
            disabled={ocupado}
            className="gap-1.5"
          >
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" /> Baixar currículo XLSX
          </Button>
          <Link
            href={`/acervo/cofre?profissionalId=${profissional.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          >
            Ver documentos deste profissional no cofre
          </Link>
        </div>
        {erroDownload && (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {erroDownload}
          </p>
        )}
      </div>

      {/* ── 4. A hierarquia: obra → documento → atividade ─────────────────── */}
      {operacoes.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-10 text-center">
          <ListTree className="mx-auto h-6 w-6 text-gray-200" aria-hidden="true" />
          <p className="mt-2 text-sm text-gray-500">
            Nenhuma obra no currículo — este profissional ainda não está vinculado a documento de operação
            alguma.
          </p>
          <p className="mt-1 text-xs text-gray-400">
            O vínculo nasce na página do documento, no bloco &quot;Responsáveis técnicos&quot;.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {operacoes.map((op) => (
            <BlocoOperacao key={op.operacaoId} operacao={op} />
          ))}
        </div>
      )}

      {/* ── 5. Legenda ────────────────────────────────────────────────────── */}
      <div className="mt-5">
        <Legenda icone={Info} titulo="Como ler este currículo">
          <ul className="space-y-1 text-xs text-gray-600">
            <li>Quantidade escrita na ART é texto do documento e não entra em soma.</li>
          </ul>
        </Legenda>
      </div>

      {editando && (
        <ModalEditarProfissional profissional={profissional} onFechar={() => setEditando(false)} onSalvo={editado} />
      )}
    </div>
  );
}

// ── Uma obra do currículo ────────────────────────────────────────────────────

function BlocoOperacao({ operacao }: { operacao: OperacaoDoCurriculo }) {
  const tituloId = `curriculo-op-${operacao.operacaoId}`;
  const periodo = formatarPeriodo(operacao.periodoInicio, operacao.periodoFim);

  return (
    <section aria-labelledby={tituloId} className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id={tituloId} className="text-sm font-bold text-brand-black">
          <Link href={`/acervo/operacoes/${operacao.operacaoId}`} className="hover:text-brand-orange">
            {operacao.codigo}
          </Link>
          <span className="ml-2 font-normal text-gray-600">
            {operacao.clienteNome}
            {operacao.clienteGrupo && <span className="text-gray-400"> ({operacao.clienteGrupo})</span>}
          </span>
        </h2>
        <span className="text-xs text-gray-400">{periodo ?? "período não informado"}</span>
      </div>

      {/* Disciplinas DA OBRA — o chip leva ao índice filtrado por código (§7.4). */}
      {operacao.disciplinasDaOperacao.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {operacao.disciplinasDaOperacao.map((d) => (
            <li key={d.id}>
              <Link
                href={`/acervo/operacoes?disciplina=${d.codigo}`}
                title={d.nome}
                className={`${CLASSE_CHIP_DISCIPLINA} hover:border-brand-orange hover:bg-orange-50/50`}
              >
                <span className="font-mono">{d.codigo}</span> {d.nome}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-3">
        {operacao.documentos.map((doc) => (
          <BlocoDocumento key={doc.documentoId} documento={doc} />
        ))}
      </div>
    </section>
  );
}

// ── Um documento da obra ─────────────────────────────────────────────────────

function BlocoDocumento({ documento }: { documento: DocumentoDoCurriculo }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/40 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          href={`/acervo/cofre/${documento.documentoId}`}
          className="text-sm font-medium text-brand-black hover:text-brand-orange"
        >
          {documento.titulo}
        </Link>
        <ChipTipoDocumento tipo={comoTipo(documento.tipoDocumento)} />
        <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
          {PAPEL_PROFISSIONAL_LABELS[documento.papelProfissional]}
        </span>
        {documento.numeroArt && (
          <span className="font-mono text-[11px] text-gray-500">ART {documento.numeroArt}</span>
        )}
        {documento.disciplina && (
          <span className={CLASSE_CHIP_DISCIPLINA} title={documento.disciplina.nome}>
            <span className="font-mono">{documento.disciplina.codigo}</span> {documento.disciplina.nome}
          </span>
        )}
      </div>

      {documento.atividades.length === 0 ? (
        /* O documento sem atividade aparece assim mesmo: sumir com ele seria
           esconder justamente o que falta preencher. */
        <p className="mt-1.5 text-xs text-gray-400">Nenhuma atividade cadastrada</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {documento.atividades.map((a) => (
            <LinhaAtividade key={a.id} atividade={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LinhaAtividade({ atividade }: { atividade: AtividadeDoDocumento }) {
  return (
    <li className="text-xs">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 text-gray-700">— {atividade.atividade}</span>
        {atividade.quantidadeTexto && (
          <span
            className="shrink-0 font-mono text-gray-500"
            title="quantidade escrita na ART — texto do documento, não entra em soma"
          >
            {atividade.quantidadeTexto}
          </span>
        )}
      </span>
    </li>
  );
}

// ── Legenda ──────────────────────────────────────────────────────────────

function Legenda({
  icone: Icone,
  titulo,
  children,
}: {
  icone: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <Icone className="h-4 w-4 text-gray-300" aria-hidden={true} />
        {titulo}
      </h2>
      {children}
    </div>
  );
}

// ── Modal "Editar profissional" (§6: sem arquivo próprio) ────────────────────

function ErroCampo({ mensagem }: { mensagem?: string }) {
  if (!mensagem) return null;
  return (
    <span role="alert" className="mt-0.5 block text-[11px] text-red-600">
      {mensagem}
    </span>
  );
}

/**
 * Os mesmos quatro campos do cadastro, mais `ativo` — que é o "excluir" desta
 * entidade: não existe DELETE, porque apagar o profissional levaria junto os
 * vínculos (CASCADE), isto é, o rastro de quem assinou o quê (§5.5).
 *
 * SEM CPF, aqui como em todo lugar (§1d / LGPD).
 */
function ModalEditarProfissional({
  profissional,
  onFechar,
  onSalvo,
}: {
  profissional: CurriculoRt["profissional"];
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const tituloId = useId();
  const nomeRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: onFechar,
    initialFocusRef: nomeRef,
  });

  const [nome, setNome] = useState(profissional.nome);
  const [crea, setCrea] = useState(profissional.crea ?? "");
  const [creaUf, setCreaUf] = useState(profissional.creaUf ?? "");
  const [formacao, setFormacao] = useState(profissional.formacao ?? "");
  const [ativo, setAtivo] = useState(profissional.ativo);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Record<string, string>>({});

  async function salvar() {
    if (salvando) return;
    setSalvando(true);
    setErro(null);
    setDetalhes({});
    try {
      // Tipado com o INPUT do schema da rota (§4.4) — a tela não monta corpo
      // que o `EditarProfissionalSchema` recusaria por forma.
      const corpoEnvio: EditarProfissionalInput = {
        nome,
        // Campo em branco é AUSÊNCIA (null limpa), nunca string vazia: o
        // CHECK `chk_prof_crea` do banco recusa `''` de propósito.
        crea: crea.trim() === "" ? null : crea,
        creaUf: creaUf.trim() === "" ? null : creaUf.toUpperCase(),
        formacao: formacao.trim() === "" ? null : formacao,
        ativo,
      };
      const r = await fetch(`/api/conformidade/profissionais/${profissional.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpoEnvio),
      });
      if (!r.ok) {
        const corpo = (await r.json().catch(() => ({}))) as RespostaPatch;
        setErro(corpo.error ?? `Erro ${r.status} ao salvar.`);
        setDetalhes(corpo.detalhes ?? {});
        return;
      }
      onSalvo();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha de rede ao salvar.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
    >
      <div className="absolute inset-0 bg-black/40" onClick={salvando ? undefined : onFechar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-gray-100 p-4">
          <h3 id={tituloId} className="flex items-center gap-2 text-sm font-bold">
            <Pencil className="h-4 w-4 text-brand-orange" aria-hidden="true" />
            Editar profissional
          </h3>
          <button
            type="button"
            onClick={onFechar}
            disabled={salvando}
            className="rounded p-1 hover:bg-gray-100 disabled:opacity-40"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4">
          {erro && (
            <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {erro}
            </p>
          )}

          <div>
            <label htmlFor={`${tituloId}-nome`} className={CLASSE_ROTULO}>
              Nome <span className="text-brand-orange">*</span>
            </label>
            <input
              id={`${tituloId}-nome`}
              ref={nomeRef}
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              className={`${CLASSE_INPUT} mt-1`}
              disabled={salvando}
            />
            <ErroCampo mensagem={detalhes.nome} />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor={`${tituloId}-crea`} className={CLASSE_ROTULO}>
                CREA
              </label>
              <input
                id={`${tituloId}-crea`}
                value={crea}
                onChange={(e) => setCrea(e.target.value)}
                className={`${CLASSE_INPUT} mt-1 font-mono`}
                disabled={salvando}
              />
              <ErroCampo mensagem={detalhes.crea} />
            </div>
            <div className="w-24">
              <label htmlFor={`${tituloId}-uf`} className={CLASSE_ROTULO}>
                UF
              </label>
              <input
                id={`${tituloId}-uf`}
                value={creaUf}
                onChange={(e) => setCreaUf(e.target.value.toUpperCase())}
                maxLength={2}
                className={`${CLASSE_INPUT} mt-1 font-mono uppercase`}
                disabled={salvando}
              />
              <ErroCampo mensagem={detalhes.creaUf} />
            </div>
          </div>

          <div>
            <label htmlFor={`${tituloId}-formacao`} className={CLASSE_ROTULO}>
              Formação
            </label>
            <input
              id={`${tituloId}-formacao`}
              value={formacao}
              onChange={(e) => setFormacao(e.target.value)}
              className={`${CLASSE_INPUT} mt-1`}
              disabled={salvando}
            />
            <ErroCampo mensagem={detalhes.formacao} />
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={ativo}
              onChange={(e) => setAtivo(e.target.checked)}
              disabled={salvando}
              className="h-3.5 w-3.5 rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
            />
            Profissional ativo
          </label>
          <p className="text-[11px] text-gray-400">
            Desmarcar é o desligamento: os vínculos e o histórico de quem assinou o quê continuam intactos.
          </p>
          <ErroCampo mensagem={detalhes.ativo} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 p-4">
          <Button type="button" variant="ghost" onClick={onFechar} disabled={salvando}>
            Cancelar
          </Button>
          <Button type="button" onClick={salvar} loading={salvando} disabled={nome.trim().length < 2}>
            Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}
