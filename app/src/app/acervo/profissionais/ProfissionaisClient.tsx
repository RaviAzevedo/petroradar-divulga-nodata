"use client";

/**
 * /acervo/profissionais — a lista de responsáveis técnicos (spec ONDA-4 §7.6).
 *
 * A divisão de responsabilidades é a mesma da bancada (onda 3 §7.2):
 *   - FILTRO muda a URL (`router.replace` dentro de `startTransition`) e o
 *     SERVIDOR recalcula a lista e o total. Sem `useEffect` de sincronia, sem
 *     um segundo lugar decidindo o que é "ativo" — a barra de endereços é o
 *     link compartilhável e recarregar reproduz a mesma lista.
 *   - AÇÃO (criar profissional) é `fetch` na rota e, no sucesso,
 *     `router.refresh()` mais a navegação para o currículo do recém-criado.
 *
 * O modal de escrita mora AQUI dentro, sem arquivo próprio (§6): é o padrão
 * literal do `ModalNovoProjeto`, que vive dentro de `acervo/cofre/[id]/page.tsx`.
 *
 * O que é privado em outros clients (`CLASSE_INPUT`, `ErroCampo`) é COPIADO,
 * como as ondas 2 e 3 fizeram: exportar de um client component para outro só
 * para poupar 20 linhas engorda o bundle de quem não usa.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ChevronLeft, HardHat, Loader2, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChip";
import { HelpTooltip } from "@/components/ui/HelpTooltip";
import { useModalA11y } from "@/components/ui/useModalA11y";
import type {
  CriarProfissionalInput,
  FiltrosProfissionalInput,
} from "@/lib/conformidade/profissionais/validations";
import type { ProfissionalLista } from "@/lib/conformidade/profissionais/queries";

// ── Props (vêm do server component) ──────────────────────────────────────────

/** O que veio na URL, cru — estado inicial dos filtros. */
export interface EntradaProfissionais {
  busca: string;
  /** "1" | "0" | "" — a mesma leitura de `lerBooleano` em page.tsx. */
  ativo: string;
  comDocumento: string;
}

/**
 * A lista calculada em page.tsx. Erro de forma (zod) chega como `detalhes`
 * campo a campo, igual ao 422 da rota (§5.4). `filtros` é o que o SERVIDOR
 * aplicou — é dele que falam os chips, nunca do formulário em edição.
 */
export type ResultadoProfissionais =
  | { estado: "erro"; detalhes: Record<string, string> }
  | {
      estado: "ok";
      filtros: FiltrosProfissionalInput;
      profissionais: ProfissionalLista[];
      total: number;
    };

interface Props {
  entrada: EntradaProfissionais;
  resultado: ResultadoProfissionais;
  podeGerenciar: boolean;
}

// ── Contrato da rota (§5.4) ──────────────────────────────────────────────────

/** POST /api/conformidade/profissionais: 201 devolve a linha crua; erro traz `error`/`detalhes`. */
interface RespostaCriar {
  id?: string;
  error?: string;
  detalhes?: Record<string, string>;
}

// ── Filtros ──────────────────────────────────────────────────────────────────

interface EstadoFiltros {
  busca: string;
  /** "" = Todos (sem filtro), "1" = ativos, "0" = inativos */
  ativo: string;
  comDocumento: boolean;
}

const LIMITE_PADRAO = 50;
const DEBOUNCE_MS = 400;

const CLASSE_INPUT =
  "w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange disabled:bg-gray-50 disabled:text-gray-400";

const CLASSE_ROTULO = "block text-[10px] font-semibold uppercase tracking-wide text-gray-400";

const OPCOES_SITUACAO: ReadonlyArray<{ valor: string; rotulo: string }> = [
  { valor: "", rotulo: "Todos" },
  { valor: "1", rotulo: "Ativos" },
  { valor: "0", rotulo: "Inativos" },
];

/**
 * A URL da lista. Filtro desligado é chave AUSENTE, nunca "=false": `ativo`
 * ausente significa "ativos E inativos" (§4.4), e escrever `ativo=false`
 * pediria só os inativos.
 *
 * `limit` só entra quando não é o default (o servidor aplica 50 de qualquer
 * jeito) e `offset` só quando há paginação — URL curta é URL compartilhável.
 */
function urlDaLista(f: EstadoFiltros, limit: number, offset: number): string {
  const p = new URLSearchParams();
  if (f.busca) p.set("busca", f.busca);
  if (f.ativo) p.set("ativo", f.ativo);
  if (f.comDocumento) p.set("comDocumento", "1");
  if (limit !== LIMITE_PADRAO) p.set("limit", String(limit));
  if (offset > 0) p.set("offset", String(offset));
  const qs = p.toString();
  return qs ? `/acervo/profissionais?${qs}` : "/acervo/profissionais";
}

function rotuloSituacao(valor: string): string {
  return OPCOES_SITUACAO.find((o) => o.valor === valor)?.rotulo ?? "Todos";
}

// ── Componente ───────────────────────────────────────────────────────────────

export function ProfissionaisClient({ entrada, resultado, podeGerenciar }: Props) {
  const router = useRouter();
  const idBase = useId();
  const [isPending, startTransition] = useTransition();

  const [filtros, setFiltros] = useState<EstadoFiltros>(() => ({
    busca: entrada.busca,
    // Só entra no estado o que o <select> consegue EXIBIR: valor fora das três
    // opções viraria "Todos" na tela enquanto o servidor teria filtrado outra coisa.
    ativo: OPCOES_SITUACAO.some((o) => o.valor === entrada.ativo) ? entrada.ativo : "",
    comDocumento: entrada.comDocumento === "1" || entrada.comDocumento === "true",
  }));

  const [modalAberto, setModalAberto] = useState(false);

  // ── Derivados do resultado ────────────────────────────────────────────────
  const lista = resultado.estado === "ok" ? resultado.profissionais : [];
  const total = resultado.estado === "ok" ? resultado.total : 0;
  const limite = resultado.estado === "ok" ? resultado.filtros.limit : LIMITE_PADRAO;
  const offset = resultado.estado === "ok" ? resultado.filtros.offset : 0;

  /**
   * O corte que o SERVIDOR aplicou (o eco de §5.4) — sem ele não haveria como
   * mostrar que os N da lista são só os ativos, e não o cadastro inteiro.
   *
   * ⚠️ Aqui o padrão ("Todos") NÃO corta nada: `ativo` ausente traz ativos e
   * inativos (§4.4), então não existe chip de default escondido nesta tela —
   * ao contrário da bancada, cujo `status=PENDENTE` é corte e por isso vira
   * chip. O único default que recorta é `limit=50`, e ele aparece por extenso
   * no rodapé ("mostrando N de M").
   */
  const aplicados: EstadoFiltros | null = useMemo(
    () =>
      resultado.estado === "ok"
        ? {
            busca: resultado.filtros.busca ?? "",
            ativo: resultado.filtros.ativo === undefined ? "" : resultado.filtros.ativo ? "1" : "0",
            comDocumento: resultado.filtros.comDocumento === true,
          }
        : null,
    [resultado]
  );

  const temFiltro = aplicados !== null && (aplicados.busca !== "" || aplicados.ativo !== "" || aplicados.comDocumento);

  // ── Navegação (filtro = URL) ──────────────────────────────────────────────

  /** Todo filtro novo volta para a primeira página: manter o offset mostraria "nenhum resultado" numa lista que tem. */
  const aplicar = useCallback(
    (novos: EstadoFiltros) => {
      setFiltros(novos);
      startTransition(() => {
        router.replace(urlDaLista(novos, limite, 0), { scroll: false });
      });
    },
    [router, limite]
  );

  /**
   * Paginar move só a janela: os filtros usados são os que o SERVIDOR aplicou,
   * não o que está em edição no formulário. Usar `filtros` aqui faria "Próximos"
   * aplicar de carona uma busca ainda em debounce — e a pessoa veria uma página
   * vazia de uma lista que ela nem pediu ainda.
   */
  const paginar = useCallback(
    (novoOffset: number) => {
      const base = aplicados ?? filtros;
      startTransition(() => {
        router.replace(urlDaLista(base, limite, Math.max(0, novoOffset)), { scroll: false });
      });
    },
    [router, aplicados, filtros, limite]
  );

  const limparFiltros = useCallback(() => {
    const zerados: EstadoFiltros = { busca: "", ativo: "", comDocumento: false };
    setFiltros(zerados);
    startTransition(() => {
      router.replace("/acervo/profissionais", { scroll: false });
    });
  }, [router]);

  /**
   * Busca com debounce de 400 ms (molde do cofre): a URL só muda quando a
   * pessoa para de digitar. A comparação é com o que o SERVIDOR aplicou — se
   * já é igual, não há navegação, e o efeito não entra em laço depois que a
   * página volta do servidor.
   */
  const buscaAplicada = aplicados?.busca ?? "";
  useEffect(() => {
    if (filtros.busca === buscaAplicada) return;
    const timer = setTimeout(() => {
      startTransition(() => {
        router.replace(urlDaLista(filtros, limite, 0), { scroll: false });
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filtros, buscaAplicada, limite, router]);

  const criado = useCallback(
    (id: string | undefined) => {
      setModalAberto(false);
      startTransition(() => {
        router.refresh();
        // O gesto termina no currículo do recém-criado: quem cadastra um RT
        // cadastra para vincular documento em seguida.
        if (id) router.push(`/acervo/profissionais/${id}`);
      });
    },
    [router]
  );

  const primeiro = total === 0 ? 0 : offset + 1;
  const ultimo = offset + lista.length;

  return (
    <>
      {/* ── Cabeçalho ─────────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/acervo"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
          >
            <ChevronLeft className="h-3 w-3" /> Acervo
          </Link>
          <h1 className="text-2xl font-bold text-brand-black">Profissionais</h1>
          <p className="text-xs text-gray-500 mt-0.5 tabular-nums" aria-live="polite">
            {total.toLocaleString("pt-BR")} {total === 1 ? "profissional" : "profissionais"}
          </p>
        </div>
        {podeGerenciar && (
          <Button type="button" onClick={() => setModalAberto(true)} className="gap-1.5">
            <Plus className="h-4 w-4" aria-hidden="true" /> Novo profissional
          </Button>
        )}
      </div>

      {/* ── Filtros ───────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor={`${idBase}-busca`} className={CLASSE_ROTULO}>
              Buscar
              <HelpTooltip texto="Casa por nome ou por registro no CREA. O termo vai para a URL: recarregar reproduz a mesma lista." />
            </label>
            <div className="relative mt-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-300"
                aria-hidden="true"
              />
              <input
                id={`${idBase}-busca`}
                type="search"
                value={filtros.busca}
                onChange={(e) => setFiltros({ ...filtros, busca: e.target.value })}
                placeholder="nome ou CREA"
                className={`${CLASSE_INPUT} pl-8`}
              />
            </div>
          </div>

          <div className="w-36">
            <label htmlFor={`${idBase}-ativo`} className={CLASSE_ROTULO}>
              Situação
            </label>
            <select
              id={`${idBase}-ativo`}
              value={filtros.ativo}
              onChange={(e) => aplicar({ ...filtros, ativo: e.target.value })}
              className={`${CLASSE_INPUT} mt-1`}
            >
              {OPCOES_SITUACAO.map((o) => (
                <option key={o.rotulo} value={o.valor}>
                  {o.rotulo}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-600 pb-2.5">
            <input
              type="checkbox"
              checked={filtros.comDocumento}
              onChange={(e) => aplicar({ ...filtros, comDocumento: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-gray-300 text-brand-orange focus:ring-brand-orange/30"
            />
            Só com documento
          </label>

          {isPending && (
            <span className="pb-2.5 text-xs text-gray-400 inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> atualizando…
            </span>
          )}
        </div>

        {/* Chips do que o SERVIDOR aplicou. `FilterChip` não declara
            `type="button"`; aqui não há <form>, então não há submit acidental. */}
        {aplicados !== null && temFiltro && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {aplicados.busca !== "" && (
              <FilterChip
                label={`Busca: ${aplicados.busca}`}
                onRemove={() => aplicar({ ...filtros, busca: "" })}
              />
            )}
            {aplicados.ativo !== "" && (
              <FilterChip
                label={rotuloSituacao(aplicados.ativo)}
                onRemove={() => aplicar({ ...filtros, ativo: "" })}
              />
            )}
            {aplicados.comDocumento && (
              <FilterChip
                label="Só com documento"
                onRemove={() => aplicar({ ...filtros, comDocumento: false })}
              />
            )}
            <button
              type="button"
              onClick={limparFiltros}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              Limpar filtros
            </button>
          </div>
        )}
      </div>

      {/* ── Erro de forma (o mesmo `detalhes` do 422) ─────────────────────── */}
      {resultado.estado === "erro" && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> Filtro inválido
          </p>
          <ul className="mt-1 ml-5 list-disc space-y-0.5 text-xs text-red-600">
            {Object.entries(resultado.detalhes).map(([campo, msg]) => (
              <li key={campo}>
                <span className="font-mono">{campo}</span>: {msg}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Tabela ────────────────────────────────────────────────────────── */}
      {resultado.estado === "ok" && lista.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Profissionais do acervo, com o registro no CREA e quantas obras e documentos cada um assina.
              </caption>
              <thead>
                <tr className="border-b border-gray-100 text-[10px] uppercase tracking-wide text-gray-400">
                  <th scope="col" className="px-4 py-2 text-left font-semibold">Nome</th>
                  <th scope="col" className="px-4 py-2 text-left font-semibold">CREA</th>
                  <th scope="col" className="px-4 py-2 text-left font-semibold">Formação</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Obras</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Documentos</th>
                  <th scope="col" className="px-4 py-2 text-left font-semibold">Situação</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                    <td className="px-4 py-2.5">
                      {/* O link é o NOME inteiro, nunca um "ver" — o nome é o que a pessoa procura. */}
                      <Link
                        href={`/acervo/profissionais/${p.id}`}
                        className="font-medium text-brand-black hover:text-brand-orange"
                      >
                        {p.nome}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-600">
                      {p.crea ? `${p.crea}${p.creaUf ? `/${p.creaUf}` : ""}` : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">
                      {p.formacao ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">{p.totalOperacoes}</td>
                    <td
                      className="px-4 py-2.5 text-right tabular-nums text-gray-700"
                      title="documentos visíveis para o seu papel"
                    >
                      {p.totalDocumentos}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          p.ativo
                            ? "inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-700"
                            : "inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500"
                        }
                      >
                        {p.ativo ? "Ativo" : "Inativo"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/*
            A frase é FIXA e aparece sempre: as contagens saem de
            `restricaoVisivel(role)` (§4.5), então dois usuários veem números
            diferentes — e sem a frase nenhum dos dois sabe por quê (Q10.3).
          */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2.5">
            <p className="text-[11px] text-gray-400">
              Contagens consideram apenas os documentos visíveis para o seu papel.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 tabular-nums">
                mostrando {primeiro.toLocaleString("pt-BR")}–{ultimo.toLocaleString("pt-BR")} de{" "}
                {total.toLocaleString("pt-BR")}
              </span>
              {total > limite && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={offset === 0 || isPending}
                    onClick={() => paginar(offset - limite)}
                  >
                    Anterior
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={ultimo >= total || isPending}
                    onClick={() => paginar(offset + limite)}
                  >
                    Próximos
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Vazios, distinguidos: dois vazios que pedem ações OPOSTAS ─────── */}
      {resultado.estado === "ok" && lista.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-10 text-center">
          <HardHat className="mx-auto h-6 w-6 text-gray-200" aria-hidden="true" />
          {temFiltro ? (
            <>
              <p className="mt-2 text-sm text-gray-500">Nenhum profissional com estes filtros.</p>
              <button
                type="button"
                onClick={limparFiltros}
                className="mt-2 text-xs text-brand-orange hover:underline"
              >
                Limpar filtros
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 mx-auto max-w-lg text-sm text-gray-500">
                Nenhum profissional cadastrado. O backfill da 0043 cria um profissional para cada{" "}
                <span className="font-mono text-xs">engenheiro_responsavel</span> dos projetos; se esta lista
                está vazia, o acervo não tem projeto com RT preenchido.
              </p>
              {podeGerenciar && (
                <Button type="button" onClick={() => setModalAberto(true)} className="mt-3 gap-1.5">
                  <Plus className="h-4 w-4" aria-hidden="true" /> Novo profissional
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {modalAberto && <ModalNovoProfissional onFechar={() => setModalAberto(false)} onCriado={criado} />}
    </>
  );
}

// ── Modal "Novo profissional" (§6: sem arquivo próprio) ──────────────────────

/** Mensagem de erro do campo. */
function ErroCampo({ mensagem }: { mensagem?: string }) {
  if (!mensagem) return null;
  return (
    <span role="alert" className="mt-0.5 block text-[11px] text-red-600">
      {mensagem}
    </span>
  );
}

/**
 * Quatro campos e nada mais — `profissionais` não tem CPF, em coluna nenhuma e
 * em campo nenhum (§1d / LGPD). O CREA é o que identifica para efeito de
 * habilitação: é o que o edital pede e o que a CAT traz.
 *
 * O 422 é renderizado CAMPO A CAMPO (`detalhes`), e o caso real é
 * `crea: "Já existe profissional com este CREA"` — a rota confere antes do
 * INSERT para o 23505 do índice único parcial nunca virar 500 (§5.4).
 */
function ModalNovoProfissional({
  onFechar,
  onCriado,
}: {
  onFechar: () => void;
  onCriado: (id: string | undefined) => void;
}) {
  const tituloId = useId();
  const nomeRef = useRef<HTMLInputElement>(null);
  const { dialogRef, handleTrapTab } = useModalA11y({
    active: true,
    onClose: onFechar,
    initialFocusRef: nomeRef,
  });

  const [nome, setNome] = useState("");
  const [crea, setCrea] = useState("");
  const [creaUf, setCreaUf] = useState("");
  const [formacao, setFormacao] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Record<string, string>>({});

  async function salvar() {
    if (salvando) return;
    setSalvando(true);
    setErro(null);
    setDetalhes({});
    try {
      // Tipado com o INPUT do schema da rota: a tela não consegue montar um
      // corpo que o `CriarProfissionalSchema` recusaria por forma.
      const corpoEnvio: CriarProfissionalInput = {
        nome,
        // Campo em branco é AUSÊNCIA, não string vazia: o CHECK `chk_prof_crea`
        // do banco recusa `''` de propósito (é o que impede dois "sem registro"
        // colidirem no índice único parcial).
        crea: crea.trim() === "" ? null : crea,
        creaUf: creaUf.trim() === "" ? null : creaUf.toUpperCase(),
        formacao: formacao.trim() === "" ? null : formacao,
      };
      const r = await fetch("/api/conformidade/profissionais", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpoEnvio),
      });
      const corpo = (await r.json().catch(() => ({}))) as RespostaCriar;
      if (!r.ok) {
        // Mensagem do servidor nunca é trocada por genérica (regra do módulo).
        setErro(corpo.error ?? `Erro ${r.status} ao cadastrar.`);
        setDetalhes(corpo.detalhes ?? {});
        return;
      }
      onCriado(corpo.id);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha de rede ao cadastrar.");
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
      {/* Salvando, o backdrop NÃO fecha: perder o que foi digitado no meio da
          escrita é o jeito mais rápido de a pessoa desistir do cadastro. */}
      <div className="absolute inset-0 bg-black/40" onClick={salvando ? undefined : onFechar} />
      <div
        ref={dialogRef}
        onKeyDown={handleTrapTab}
        className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <h3 id={tituloId} className="text-sm font-bold flex items-center gap-2">
            <HardHat className="h-4 w-4 text-brand-orange" aria-hidden="true" />
            Novo profissional
          </h3>
          <button
            type="button"
            onClick={onFechar}
            disabled={salvando}
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-40"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
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
              placeholder="Engenheiro Mecânico"
              className={`${CLASSE_INPUT} mt-1`}
              disabled={salvando}
            />
            <ErroCampo mensagem={detalhes.formacao} />
          </div>

          <p className="text-[11px] text-gray-400">
            O cadastro guarda nome, CREA e formação — e nada além disso. CPF não entra em campo nenhum desta tela.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 p-4">
          <Button type="button" variant="ghost" onClick={onFechar} disabled={salvando}>
            Cancelar
          </Button>
          <Button type="button" onClick={salvar} loading={salvando} disabled={nome.trim().length < 2}>
            Cadastrar
          </Button>
        </div>
      </div>
    </div>
  );
}
