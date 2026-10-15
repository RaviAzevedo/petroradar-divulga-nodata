"use client";

/**
 * B7 — o bloco de anotações (spec ONDA-5 §7.5). UM componente, DOIS lugares: a
 * ficha da operação (`alvoTipo="OPERACAO"`) e a página do documento
 * (`alvoTipo="DOCUMENTO"`) — por isso mora em `acervo/_componentes/`, que é
 * exatamente o que essa pasta já guarda (a `GavetaDocumento` é usada pelos dois).
 *
 * O que se sabe e não cabe em campo: "a ART do 12345 não bate com o
 * contrato". Três regras que vêm do contrato e não são de tela:
 *
 *  - **o texto volta REDIGIDO.** `redigirPii` roda no handler ANTES de gravar
 *    (§1d, §5.1): quem escreve um CPF vê `[CPF-REMOVIDO]` de volta, e é assim
 *    que descobre a regra. Esta tela mostra SEMPRE o que o servidor devolveu,
 *    nunca o que foi digitado — por isso o POST/PATCH substituem a linha pela
 *    resposta, e não pelo rascunho local;
 *  - **o corte aparece.** O default traz só as abertas; os dois contadores vêm
 *    na mesma resposta e o botão "ver as N resolvidas" refaz a chamada com o
 *    filtro explícito (Q10.3). Lista que esconde linha e não diz é o defeito
 *    que o módulo inteiro existe para não repetir;
 *  - **editar e apagar são de quem escreveu, ou do ADMIN.** A barreira real é a
 *    rota (§5.2); aqui a regra é cortesia — não anunciar poder que o papel não
 *    tem. Anotação de autor apagado (`autorId === null`) só o ADMIN mexe:
 *    ninguém herda a autoria de quem saiu.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { AlertCircle, Check, Loader2, MessageSquare, Pencil, RotateCcw, Send, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import type { AlvoAnotacao } from "@/db/schema";
import { ALVO_ANOTACAO_LABELS } from "@/lib/conformidade/anotacoes/validations";

/** Uma anotação como ela viaja em JSON: as datas são ISO, não `Date`. */
interface Anotacao {
  id: string;
  alvoTipo: AlvoAnotacao;
  alvoId: string;
  autorId: string | null;
  autorNome: string;
  texto: string;
  criadoEm: string | null;
  atualizadoEm: string | null;
  resolvidaEm: string | null;
}

interface RespostaLista {
  anotacoes?: Anotacao[];
  abertas?: number;
  resolvidas?: number;
  error?: string;
}

/** Teto do zod e do CHECK do banco (§4.2): anotação é frase, não anexo. */
const MAX_TEXTO = 4000;
/** A partir daqui o contador fica âmbar — o limite chega sem susto. */
const AVISO_TEXTO = 3800;

interface Props {
  alvoTipo: AlvoAnotacao;
  alvoId: string;
  /** Rótulo do bloco. Default "Anotações". */
  titulo?: string;
  /** `podeGerenciarDocumentosHabilitacao(role)` — o botão só existe com ele. */
  podeEscrever: boolean;
  /** Id da sessão, para decidir quem edita/apaga sem uma segunda fonte. */
  usuarioId: string | null;
  ehAdmin: boolean;
}

/**
 * "há 3 d" a partir do instante em que a lista foi carregada — e não de
 * `Date.now()` no render, que é chamada impura (react-hooks/purity) e daria
 * rótulos que mudam sozinhos a cada re-render. O ISO exato vai no `title`.
 */
function relativoCurto(iso: string | null, agora: number): string {
  if (!iso) return "";
  const ms = agora - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutos = Math.floor(ms / 60000);
  if (minutos < 1) return "agora";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 30) return `há ${dias} d`;
  const meses = Math.floor(dias / 30);
  if (meses < 12) return `há ${meses} mes${meses === 1 ? "" : "es"}`;
  const anos = Math.floor(dias / 365);
  return `há ${anos} ano${anos === 1 ? "" : "s"}`;
}

export function BlocoAnotacoes({
  alvoTipo,
  alvoId,
  titulo = "Anotações",
  podeEscrever,
  usuarioId,
  ehAdmin,
}: Props) {
  const tituloId = useId();
  const campoId = useId();

  const [anotacoes, setAnotacoes] = useState<Anotacao[]>([]);
  const [abertas, setAbertas] = useState(0);
  const [resolvidas, setResolvidas] = useState(0);
  /** Instante da carga — base das datas relativas (ver `relativoCurto`). */
  const [carregadoEm, setCarregadoEm] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [tentativa, setTentativa] = useState(0);

  /** Eco do corte: `false` (o default do servidor) mostra só as abertas. */
  const [verResolvidas, setVerResolvidas] = useState(false);

  const [texto, setTexto] = useState("");
  const [focado, setFocado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [textoEdicao, setTextoEdicao] = useState("");
  const [salvandoEdicao, setSalvandoEdicao] = useState(false);
  const [removendo, setRemovendo] = useState<Anotacao | null>(null);

  const carregar = useCallback(
    (signal?: AbortSignal) => {
      // Sem `setCarregando(true)` aqui: o estado nasce `true` e o efeito de
      // montagem chama esta função direto — ligar o spinner no corpo do efeito
      // é renderização em cascata (react-hooks/set-state-in-effect). O molde é
      // o de `AtividadesDoDocumento` (onda 4).
      const p = new URLSearchParams({ alvoTipo, alvoId });
      if (verResolvidas) p.set("resolvidas", "1");
      fetch(`/api/conformidade/anotacoes?${p}`, { signal })
        .then(async (r) => {
          const j = (await r.json().catch(() => null)) as RespostaLista | null;
          if (!r.ok) throw new Error(j?.error ?? `Erro ${r.status}`);
          return j ?? {};
        })
        .then((j) => {
          setAnotacoes(j.anotacoes ?? []);
          setAbertas(j.abertas ?? 0);
          setResolvidas(j.resolvidas ?? 0);
          setCarregadoEm(Date.now());
          setErro(null);
          setCarregando(false);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setErro(e instanceof Error ? e.message : "Falha ao carregar as anotações");
          setCarregando(false);
        });
    },
    [alvoTipo, alvoId, verResolvidas]
  );

  useEffect(() => {
    const ac = new AbortController();
    carregar(ac.signal);
    return () => ac.abort();
  }, [carregar, tentativa]);

  /** Autor ou ADMIN — a mesma regra da rota (§5.2), aqui só como cortesia. */
  function podeMexer(a: Anotacao): boolean {
    if (!podeEscrever) return false;
    if (ehAdmin) return true;
    return a.autorId !== null && a.autorId === usuarioId;
  }

  async function anotar() {
    const corpo = texto.trim();
    if (corpo.length === 0 || enviando) return;
    setEnviando(true);
    setErroAcao(null);
    try {
      const r = await fetch("/api/conformidade/anotacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alvoTipo, alvoId, texto: corpo }),
      });
      const j = (await r.json().catch(() => null)) as (Anotacao & { error?: string }) | null;
      if (!r.ok) {
        setErroAcao(j?.error ?? `Erro ${r.status}`);
        return;
      }
      setTexto("");
      setAnuncio("anotação gravada");
      // Recarrega em vez de empilhar o rascunho: a lista tem de mostrar o texto
      // REDIGIDO que o servidor devolveu, e os contadores vêm com ele.
      setTentativa((t) => t + 1);
    } catch (e) {
      setErroAcao(e instanceof Error ? e.message : "Falha de rede");
    } finally {
      setEnviando(false);
    }
  }

  /** Resolver/reabrir: otimista, com rollback quando o servidor recusa. */
  async function alternarResolvida(a: Anotacao) {
    const resolver = a.resolvidaEm === null;
    const anterior = anotacoes;
    const abertasAntes = abertas;
    const resolvidasAntes = resolvidas;

    setErroAcao(null);
    setAnotacoes((lista) =>
      lista.map((x) =>
        x.id === a.id ? { ...x, resolvidaEm: resolver ? new Date().toISOString() : null } : x
      )
    );
    setAbertas(abertasAntes + (resolver ? -1 : 1));
    setResolvidas(resolvidasAntes + (resolver ? 1 : -1));
    setAnuncio(resolver ? "anotação resolvida" : "anotação reaberta");

    try {
      const r = await fetch(`/api/conformidade/anotacoes/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvida: resolver }),
      });
      const j = (await r.json().catch(() => null)) as (Anotacao & { error?: string }) | null;
      if (!r.ok || !j) {
        setAnotacoes(anterior);
        setAbertas(abertasAntes);
        setResolvidas(resolvidasAntes);
        setErroAcao(j?.error ?? `Erro ${r.status}`);
        return;
      }
      // A linha que o servidor devolveu manda — inclusive no `resolvidaEm`.
      setAnotacoes((lista) => lista.map((x) => (x.id === j.id ? j : x)));
    } catch (e) {
      setAnotacoes(anterior);
      setAbertas(abertasAntes);
      setResolvidas(resolvidasAntes);
      setErroAcao(e instanceof Error ? e.message : "Falha de rede");
    }
  }

  async function salvarEdicao(a: Anotacao) {
    const corpo = textoEdicao.trim();
    if (corpo.length === 0 || salvandoEdicao) return;
    setSalvandoEdicao(true);
    setErroAcao(null);
    try {
      const r = await fetch(`/api/conformidade/anotacoes/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: corpo }),
      });
      const j = (await r.json().catch(() => null)) as (Anotacao & { error?: string }) | null;
      if (!r.ok || !j) {
        setErroAcao(j?.error ?? `Erro ${r.status}`);
        return;
      }
      setAnotacoes((lista) => lista.map((x) => (x.id === j.id ? j : x)));
      setEditandoId(null);
      setAnuncio("anotação editada");
    } catch (e) {
      setErroAcao(e instanceof Error ? e.message : "Falha de rede");
    } finally {
      setSalvandoEdicao(false);
    }
  }

  async function confirmarRemocao() {
    const alvo = removendo;
    if (!alvo) return;
    setRemovendo(null);
    setErroAcao(null);
    try {
      const r = await fetch(`/api/conformidade/anotacoes/${alvo.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        setErroAcao(j?.error ?? `Erro ${r.status}`);
        return;
      }
      setAnotacoes((lista) => lista.filter((x) => x.id !== alvo.id));
      if (alvo.resolvidaEm === null) setAbertas((n) => Math.max(0, n - 1));
      else setResolvidas((n) => Math.max(0, n - 1));
      setAnuncio("anotação apagada");
    } catch (e) {
      setErroAcao(e instanceof Error ? e.message : "Falha de rede");
    }
  }

  return (
    <section
      aria-labelledby={tituloId}
      className="bg-white border border-gray-200 rounded-xl p-5 mb-5"
    >
      <p aria-live="polite" className="sr-only">
        {anuncio}
      </p>

      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h2
          id={tituloId}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
        >
          <MessageSquare className="h-3 w-3" aria-hidden="true" /> {titulo}
        </h2>
        {!carregando && !erro && (
          <p className="flex items-center gap-2 text-[11px] text-gray-400 tabular-nums">
            <span>
              {abertas} aberta{abertas === 1 ? "" : "s"} · {resolvidas} resolvida
              {resolvidas === 1 ? "" : "s"}
            </span>
            {resolvidas > 0 && (
              <button
                type="button"
                onClick={() => setVerResolvidas((v) => !v)}
                className="underline decoration-dotted hover:text-brand-orange"
              >
                {verResolvidas
                  ? "ocultar as resolvidas"
                  : `ver ${resolvidas === 1 ? "a" : `as ${resolvidas}`} resolvida${resolvidas === 1 ? "" : "s"}`}
              </button>
            )}
          </p>
        )}
      </div>

      {carregando && (
        <div className="space-y-2" aria-busy="true" aria-label="Carregando anotações">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      )}

      {!carregando && erro && (
        <div
          role="alert"
          className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600 flex-wrap"
        >
          <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-[200px]">{erro}</span>
          <Button
            size="sm"
            variant="secondary"
            /* O esqueleto volta na hora: sem isto, a faixa vermelha ficaria na
               tela até a resposta chegar e o clique pareceria não ter efeito.
               Aqui é event handler — `setCarregando` fora de efeito é legítimo. */
            onClick={() => {
              setErro(null);
              setCarregando(true);
              setTentativa((t) => t + 1);
            }}
          >
            Tentar de novo
          </Button>
        </div>
      )}

      {!carregando && !erro && (
        <>
          {anotacoes.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhuma anotação.</p>
          ) : (
            <ul className="space-y-2">
              {anotacoes.map((a) => {
                const resolvida = a.resolvidaEm !== null;
                const editando = editandoId === a.id;
                return (
                  <li
                    key={a.id}
                    className={cn(
                      "border border-gray-100 rounded-lg p-3",
                      resolvida && "opacity-60"
                    )}
                  >
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs font-medium text-gray-700">{a.autorNome}</span>
                      <span className="text-[11px] text-gray-400" title={a.criadoEm ?? ""}>
                        {relativoCurto(a.criadoEm, carregadoEm)}
                        {a.atualizadoEm && " (editada)"}
                      </span>
                      {resolvida && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] text-green-700">
                          <Check className="h-3 w-3" aria-hidden="true" /> resolvida
                        </span>
                      )}
                      {podeMexer(a) && !editando && (
                        <span className="ml-auto flex items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => void alternarResolvida(a)}
                            className="inline-flex items-center gap-1 text-gray-500 hover:text-green-700"
                          >
                            {resolvida ? (
                              <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <Check className="h-3 w-3" aria-hidden="true" />
                            )}
                            {resolvida ? "Reabrir" : "Resolver"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditandoId(a.id);
                              setTextoEdicao(a.texto);
                            }}
                            className="inline-flex items-center gap-1 text-gray-500 hover:text-brand-orange"
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" /> Editar
                          </button>
                          <button
                            type="button"
                            onClick={() => setRemovendo(a)}
                            className="inline-flex items-center gap-1 text-gray-500 hover:text-red-600"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" /> Apagar
                          </button>
                        </span>
                      )}
                    </div>

                    {editando ? (
                      <div className="mt-2">
                        <label className="sr-only" htmlFor={`${campoId}-${a.id}`}>
                          Editar anotação
                        </label>
                        <textarea
                          id={`${campoId}-${a.id}`}
                          rows={3}
                          maxLength={MAX_TEXTO}
                          value={textoEdicao}
                          onChange={(e) => setTextoEdicao(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                        />
                        <div className="flex items-center gap-2 mt-1.5">
                          <Button
                            size="sm"
                            onClick={() => void salvarEdicao(a)}
                            disabled={salvandoEdicao || textoEdicao.trim().length === 0}
                          >
                            {salvandoEdicao && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            )}
                            Salvar
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditandoId(null)}
                            disabled={salvandoEdicao}
                          >
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-gray-700 whitespace-pre-line">{a.texto}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {podeEscrever && (
            <div className="mt-3">
              <label className="sr-only" htmlFor={campoId}>
                Nova anotação sobre {ALVO_ANOTACAO_LABELS[alvoTipo].toLowerCase()}
              </label>
              <textarea
                id={campoId}
                rows={focado ? 4 : 2}
                maxLength={MAX_TEXTO}
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onFocus={() => setFocado(true)}
                onBlur={() => setFocado(false)}
                placeholder="O que se sabe e não cabe em campo…"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              />
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <Button
                  size="sm"
                  onClick={() => void anotar()}
                  disabled={enviando || texto.trim().length === 0}
                >
                  {enviando ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Anotar
                </Button>
                <span
                  className={cn(
                    "text-[11px] tabular-nums",
                    texto.length > AVISO_TEXTO ? "text-amber-700" : "text-gray-400"
                  )}
                >
                  {texto.length}/{MAX_TEXTO}
                </span>
              </div>
              {/* Não é aviso legal: é a explicação do que a pessoa vai ver voltar. */}
              <p className="mt-1 text-[11px] text-gray-400">
                CPF e e-mail são removidos antes de gravar.
              </p>
            </div>
          )}

          {erroAcao && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {erroAcao}
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={removendo !== null}
        title="Apagar anotação"
        message="A anotação some para todo mundo. O registro de que ela existiu fica no histórico."
        confirmLabel="Apagar"
        variant="danger"
        onConfirm={() => void confirmarRemocao()}
        onCancel={() => setRemovendo(null)}
      />
    </section>
  );
}
