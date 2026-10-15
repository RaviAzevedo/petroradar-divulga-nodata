"use client";

/**
 * Uma linha editável por arquivo.
 *
 * A versão anterior da tela tinha UM formulário para o lote inteiro: todo mundo
 * herdava a mesma categoria, a mesma validade e o mesmo título (com o nome do
 * arquivo colado num prefixo). Para certidão até servia; para prova de operação
 * não serve — cada atestado tem seu número, sua data e seu papel.
 *
 * O que ainda é igual para todos (descrição e tags) continua num bloco único
 * fora daqui, e os campos que costumam repetir têm "aplicar a todos".
 */

import { useId } from "react";
import {
  AlertTriangle,
  Check,
  FileText,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";
import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import {
  PAPEIS_DOCUMENTO,
  PAPEL_DOCUMENTO_LABELS,
  SITUACOES_PROVA,
  SITUACAO_PROVA_LABELS,
  TIPOS_DOCUMENTO,
  TIPO_DOCUMENTO_LABELS,
  type PapelDocumento,
  type RelacaoArquivo,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { SUBCATEGORIA_LABELS, CATEGORIA_LABELS } from "@/lib/conformidade/cofre/validations";
import type { SubcategoriaDocHab } from "@/db/schema";
import {
  CATEGORIAS_ORDENADAS,
  SUBCATEGORIAS_POR_CATEGORIA,
  categoriaDaLinha,
  formatarTamanho,
  mudancaDeTipo,
  type LinhaArquivo,
} from "./lote";

/** Campos que valem a pena repetir no lote inteiro. */
export type CampoAplicavel =
  | "papel"
  | "subcategoria"
  | "tipoDocumento"
  | "situacaoProva"
  | "emitidoEm"
  | "validade";

interface Props {
  linha: LinhaArquivo;
  /** Resultado de `classificarRelacao` para esta linha (duplicata, versão, irmã...). */
  relacao: RelacaoArquivo | null;
  operacaoEscolhida: boolean;
  mostrarAplicarATodos: boolean;
  travado: boolean;
  onAtualizar: (chave: string, mudanca: Partial<LinhaArquivo>) => void;
  onRemover: (chave: string) => void;
  onAplicarATodos: (campo: CampoAplicavel, origem: LinhaArquivo) => void;
  onForcarDuplicata: (chave: string) => void;
  onReenviar: (chave: string) => void;
}

const CLASSE_CAMPO =
  "w-full px-2.5 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30";

export function LinhaArquivoCard({
  linha,
  relacao,
  operacaoEscolhida,
  mostrarAplicarATodos,
  travado,
  onAtualizar,
  onRemover,
  onAplicarATodos,
  onForcarDuplicata,
  onReenviar,
}: Props) {
  const idBase = useId();
  const enviado = linha.estado === "ENVIADO";
  const enviando = linha.estado === "ENVIANDO";
  const camposTravados = travado || enviando || enviado;

  const bloqueada = Boolean(relacao?.bloqueia) && !linha.forcarDuplicata;
  // Com tipo escolhido, papel e subcategoria derivam dele e os selects travam
  // ("o tipo é UMA decisão"); "— sem tipo" devolve os dois à mão do usuário.
  const derivado = linha.tipoDocumento !== null;
  const erroCampo = (campo: string) => linha.errosCampo[campo];

  const classe = (campo: string) =>
    cn(CLASSE_CAMPO, erroCampo(campo) ? "border-red-400" : "border-gray-200");

  return (
    <li
      className={cn(
        "rounded-xl border p-3 transition-colors",
        enviado ? "border-emerald-200 bg-emerald-50/40" :
        linha.estado === "ERRO" ? "border-red-200 bg-red-50/30" :
        bloqueada ? "border-amber-300 bg-amber-50/40" :
        "border-gray-200 bg-white"
      )}
    >
      {/* Cabeçalho: arquivo, hash, estado */}
      <div className="flex items-start gap-2.5">
        <FileText className="h-4 w-4 text-brand-orange flex-shrink-0 mt-0.5" aria-hidden="true" />

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p
              className="text-sm font-medium text-gray-800 truncate min-w-0"
              title={linha.file.name}
            >
              {linha.file.name}
            </p>
            {/* Informação, não bloqueio: rascunho sobe normalmente, só não
                soma na barra de comprovação da ficha. */}
            {linha.situacaoProva === "RASCUNHO" && (
              <span className="inline-flex flex-shrink-0 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                Rascunho — não contará na comprovação
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-400">
            {formatarTamanho(linha.file.size)}
            {" · "}
            {linha.hashErro ? (
              <span className="text-amber-700">
                sem verificação de duplicata ({linha.hashErro})
              </span>
            ) : linha.sha256 ? (
              <span className="font-mono">{linha.sha256.slice(0, 12)}…</span>
            ) : (
              "calculando impressão digital..."
            )}
            {" · "}
            {CATEGORIA_LABELS[categoriaDaLinha(linha)]}
          </p>
        </div>

        <EstadoDaLinha linha={linha} />

        {!enviado && (
          <button
            type="button"
            onClick={() => onRemover(linha.chave)}
            // Travado durante o envio do lote: a fila trabalha sobre a lista
            // congelada no clique, então sumir com a linha agora só esconderia
            // da tela um arquivo que já está subindo.
            disabled={travado || enviando}
            className="p-1 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40"
            aria-label={`Remover ${linha.file.name} do lote`}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Campos editáveis */}
      <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5 mt-3">
        <div className="sm:col-span-6">
          <label htmlFor={`${idBase}-titulo`} className="block text-[11px] font-semibold text-gray-500 mb-1">
            Título <span className="text-red-500">*</span>
          </label>
          <input
            id={`${idBase}-titulo`}
            type="text"
            value={linha.titulo}
            disabled={camposTravados}
            onChange={(e) => onAtualizar(linha.chave, { titulo: e.target.value, tituloTocado: true })}
            aria-invalid={Boolean(erroCampo("titulo"))}
            aria-describedby={erroCampo("titulo") ? `${idBase}-titulo-erro` : undefined}
            className={classe("titulo")}
          />
          {erroCampo("titulo") && (
            <p id={`${idBase}-titulo-erro`} className="mt-1 text-[11px] text-red-600">
              {erroCampo("titulo")}
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <RotuloComAtalho
            htmlFor={`${idBase}-tipo`}
            texto="Tipo (dossiê)"
            mostrar={mostrarAplicarATodos}
            aoAplicar={() => onAplicarATodos("tipoDocumento", linha)}
            campoDescrito="o tipo do dossiê"
          />
          <select
            id={`${idBase}-tipo`}
            value={linha.tipoDocumento ?? ""}
            disabled={camposTravados}
            onChange={(e) =>
              onAtualizar(
                linha.chave,
                mudancaDeTipo(
                  e.target.value === "" ? null : (e.target.value as TipoDocumento),
                  linha.file.name
                )
              )
            }
            aria-invalid={Boolean(erroCampo("tipoDocumento"))}
            aria-describedby={`${idBase}-tipo-ajuda`}
            className={cn(classe("tipoDocumento"), "text-gray-700 disabled:bg-gray-50")}
          >
            <option value="">— sem tipo</option>
            {TIPOS_DOCUMENTO.map((t) => (
              <option key={t} value={t}>
                {TIPO_DOCUMENTO_LABELS[t]}
              </option>
            ))}
          </select>
          {erroCampo("tipoDocumento") && (
            <p className="mt-1 text-[11px] text-red-600">{erroCampo("tipoDocumento")}</p>
          )}
          <p id={`${idBase}-tipo-ajuda`} className="mt-1 text-[11px] text-gray-400">
            Define a seção na ficha da operação.
          </p>
        </div>

        <div className="sm:col-span-2">
          <RotuloComAtalho
            htmlFor={`${idBase}-situacao`}
            texto="Situação da prova"
            mostrar={mostrarAplicarATodos}
            aoAplicar={() => onAplicarATodos("situacaoProva", linha)}
            campoDescrito="a situação da prova"
          />
          <select
            id={`${idBase}-situacao`}
            value={linha.situacaoProva ?? ""}
            disabled={camposTravados}
            onChange={(e) =>
              onAtualizar(linha.chave, {
                situacaoProva:
                  e.target.value === "" ? null : (e.target.value as SituacaoProva),
              })
            }
            aria-invalid={Boolean(erroCampo("situacaoProva"))}
            className={cn(classe("situacaoProva"), "text-gray-700 disabled:bg-gray-50")}
          >
            <option value="">— não avaliada</option>
            {SITUACOES_PROVA.map((s) => (
              <option key={s} value={s}>
                {SITUACAO_PROVA_LABELS[s]}
              </option>
            ))}
          </select>
          {erroCampo("situacaoProva") && (
            <p className="mt-1 text-[11px] text-red-600">{erroCampo("situacaoProva")}</p>
          )}
        </div>

        <div className="sm:col-span-2">
          <RotuloComAtalho
            htmlFor={`${idBase}-papel`}
            texto="Papel na operação"
            mostrar={mostrarAplicarATodos && operacaoEscolhida && !derivado}
            aoAplicar={() => onAplicarATodos("papel", linha)}
            campoDescrito="o papel"
          />
          <select
            id={`${idBase}-papel`}
            value={linha.papel}
            disabled={camposTravados || !operacaoEscolhida || derivado}
            title={derivado ? "derivado do tipo" : undefined}
            onChange={(e) => onAtualizar(linha.chave, { papel: e.target.value as PapelDocumento })}
            aria-describedby={!operacaoEscolhida && !derivado ? `${idBase}-papel-ajuda` : undefined}
            className={cn(CLASSE_CAMPO, "border-gray-200 text-gray-700 disabled:bg-gray-50")}
          >
            {PAPEIS_DOCUMENTO.map((p) => (
              <option key={p} value={p}>
                {PAPEL_DOCUMENTO_LABELS[p]}
              </option>
            ))}
          </select>
          {!operacaoEscolhida && !derivado && (
            <p id={`${idBase}-papel-ajuda`} className="mt-1 text-[11px] text-gray-400">
              Escolha a operação para definir o papel.
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <RotuloComAtalho
            htmlFor={`${idBase}-sub`}
            texto="Subcategoria (certidões)"
            mostrar={mostrarAplicarATodos && !derivado}
            aoAplicar={() => onAplicarATodos("subcategoria", linha)}
            campoDescrito="a subcategoria"
          />
          <select
            id={`${idBase}-sub`}
            value={linha.subcategoria}
            disabled={camposTravados || derivado}
            title={derivado ? "derivado do tipo" : undefined}
            onChange={(e) =>
              onAtualizar(linha.chave, { subcategoria: e.target.value as SubcategoriaDocHab })
            }
            className={cn(CLASSE_CAMPO, "border-gray-200 text-gray-700 disabled:bg-gray-50")}
          >
            {CATEGORIAS_ORDENADAS.map((categoria) => (
              <optgroup key={categoria} label={CATEGORIA_LABELS[categoria]}>
                {SUBCATEGORIAS_POR_CATEGORIA[categoria].map((sub) => (
                  <option key={sub} value={sub}>
                    {SUBCATEGORIA_LABELS[sub]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={`${idBase}-numero`} className="block text-[11px] font-semibold text-gray-500 mb-1">
            Número do documento
          </label>
          <input
            id={`${idBase}-numero`}
            type="text"
            value={linha.numeroDocumento}
            disabled={camposTravados}
            placeholder="ACT 123/2024"
            onChange={(e) => onAtualizar(linha.chave, { numeroDocumento: e.target.value })}
            aria-invalid={Boolean(erroCampo("numeroDocumento"))}
            className={classe("numeroDocumento")}
          />
          {erroCampo("numeroDocumento") && (
            <p className="mt-1 text-[11px] text-red-600">{erroCampo("numeroDocumento")}</p>
          )}
        </div>

        <div className="sm:col-span-2">
          <RotuloComAtalho
            htmlFor={`${idBase}-emitido`}
            texto="Emitido em"
            mostrar={mostrarAplicarATodos}
            aoAplicar={() => onAplicarATodos("emitidoEm", linha)}
            campoDescrito="a data de emissão"
          />
          <input
            id={`${idBase}-emitido`}
            type="date"
            value={linha.emitidoEm}
            disabled={camposTravados}
            onChange={(e) => onAtualizar(linha.chave, { emitidoEm: e.target.value })}
            className={cn(classe("emitidoEm"), "text-gray-700")}
          />
        </div>

        <div className="sm:col-span-4">
          <RotuloComAtalho
            htmlFor={`${idBase}-validade`}
            texto="Validade"
            mostrar={mostrarAplicarATodos}
            aoAplicar={() => onAplicarATodos("validade", linha)}
            campoDescrito="a validade"
          />
          <div className="flex items-center gap-3">
            <input
              id={`${idBase}-validade`}
              type="date"
              value={linha.validadeFim}
              disabled={camposTravados || linha.validadeIndeterminada}
              onChange={(e) =>
                onAtualizar(linha.chave, { validadeFim: e.target.value, validadeTocada: true })
              }
              aria-invalid={Boolean(erroCampo("validadeFim"))}
              aria-describedby={erroCampo("validadeFim") ? `${idBase}-validade-erro` : undefined}
              className={cn(
                classe("validadeFim"),
                "text-gray-700 flex-1",
                linha.validadeIndeterminada && "opacity-50"
              )}
            />
            <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap cursor-pointer select-none">
              <input
                type="checkbox"
                checked={linha.validadeIndeterminada}
                disabled={camposTravados}
                onChange={(e) =>
                  onAtualizar(linha.chave, {
                    validadeIndeterminada: e.target.checked,
                    validadeTocada: true,
                  })
                }
                className="w-4 h-4 rounded border-gray-300 accent-brand-orange"
              />
              Não vence
            </label>
          </div>
          {erroCampo("validadeFim") && (
            <p id={`${idBase}-validade-erro`} className="mt-1 text-[11px] text-red-600">
              {erroCampo("validadeFim")}
            </p>
          )}
        </div>

        {/* A tela é Conformidade-only (guard de layout), então o controle
            sempre renderiza; um 403 do POST cai no erro da linha normalmente. */}
        <div className="sm:col-span-2">
          <span className="block text-[11px] font-semibold text-gray-500 mb-1" aria-hidden="true">
            &nbsp;
          </span>
          <label className="flex items-center gap-1.5 py-1.5 text-xs text-gray-600 whitespace-nowrap cursor-pointer select-none">
            <input
              type="checkbox"
              checked={linha.restrito}
              disabled={camposTravados}
              onChange={(e) => onAtualizar(linha.chave, { restrito: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 accent-brand-orange"
            />
            <Lock className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
            Restrito
          </label>
          {linha.restrito && (
            <p className="mt-1 text-[11px] text-amber-700">
              Some das listas e do ZIP fora da Conformidade; downloads são auditados em espelho
              permanente.
            </p>
          )}
          {erroCampo("restrito") && (
            <p className="mt-1 text-[11px] text-red-600">{erroCampo("restrito")}</p>
          )}
        </div>
      </div>

      {/* Aviso de relação (duplicata, versão, prova irmã) */}
      {relacao && relacao.relacao !== "NOVO" && !enviado && (
        <AvisoRelacao
          relacao={relacao}
          forcada={linha.forcarDuplicata}
          onRemover={() => onRemover(linha.chave)}
          onForcar={() => onForcarDuplicata(linha.chave)}
        />
      )}

      {/* Progresso / resultado */}
      {enviando && (
        <div className="mt-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={linha.progresso}
            aria-label={`Envio de ${linha.file.name}`}
            className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden"
          >
            <div
              className="h-full bg-brand-orange transition-all duration-200"
              style={{ width: `${linha.progresso}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            {linha.progresso >= 100
              ? "Enviado — o servidor está guardando o arquivo..."
              : `Enviando... ${linha.progresso}%`}
          </p>
        </div>
      )}

      {linha.estado === "ERRO" && linha.erro && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-white p-2.5"
        >
          <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-px" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-red-700">{linha.erro}</p>
            {linha.duplicataDoServidorId && (
              <Link
                href={`/acervo/cofre/${linha.duplicataDoServidorId}`}
                className="text-[11px] text-brand-orange hover:underline"
              >
                Ver o documento que já está no cofre
              </Link>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {linha.duplicataDoServidorId && !linha.forcarDuplicata && (
              <button
                type="button"
                onClick={() => onForcarDuplicata(linha.chave)}
                className="text-[11px] font-semibold text-amber-700 hover:underline"
              >
                Subir mesmo assim
              </button>
            )}
            <button
              type="button"
              onClick={() => onReenviar(linha.chave)}
              disabled={travado}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-600 hover:text-gray-900 disabled:opacity-40"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> Tentar de novo
            </button>
          </div>
        </div>
      )}

      {enviado && linha.documentoId && (
        <p className="mt-2 text-[11px] text-emerald-700">
          Guardado no cofre.{" "}
          <Link href={`/acervo/cofre/${linha.documentoId}`} className="underline underline-offset-2">
            Abrir documento
          </Link>
        </p>
      )}
    </li>
  );
}

// ── Peças ────────────────────────────────────────────────────────────────────

function EstadoDaLinha({ linha }: { linha: LinhaArquivo }) {
  if (linha.estado === "ENVIANDO") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {linha.progresso}%
      </span>
    );
  }
  if (linha.estado === "ENVIADO") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
        <Check className="h-3.5 w-3.5" aria-hidden="true" /> Enviado
      </span>
    );
  }
  if (linha.estado === "ERRO") {
    return (
      <span className="text-[11px] font-semibold text-red-600">Falhou</span>
    );
  }
  return null;
}

function RotuloComAtalho({
  htmlFor,
  texto,
  mostrar,
  aoAplicar,
  campoDescrito,
}: {
  htmlFor: string;
  texto: string;
  mostrar: boolean;
  aoAplicar: () => void;
  campoDescrito: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 mb-1">
      <label htmlFor={htmlFor} className="block text-[11px] font-semibold text-gray-500">
        {texto}
      </label>
      {mostrar && (
        <button
          type="button"
          onClick={aoAplicar}
          className="text-[10px] font-semibold text-brand-orange hover:underline"
          aria-label={`Aplicar ${campoDescrito} deste arquivo a todos os arquivos do lote`}
        >
          aplicar a todos
        </button>
      )}
    </div>
  );
}

function AvisoRelacao({
  relacao,
  forcada,
  onRemover,
  onForcar,
}: {
  relacao: RelacaoArquivo;
  forcada: boolean;
  onRemover: () => void;
  onForcar: () => void;
}) {
  const duplicata = relacao.relacao === "DUPLICATA";
  const doCofre = relacao.duplicataNoCofre;

  return (
    <div
      role="status"
      className={cn(
        "mt-3 flex items-start gap-2 rounded-lg border p-2.5",
        duplicata ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-gray-50"
      )}
    >
      {duplicata ? (
        <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-px" aria-hidden="true" />
      ) : (
        <Info className="h-4 w-4 text-gray-400 flex-shrink-0 mt-px" aria-hidden="true" />
      )}

      <div className="flex-1 min-w-0">
        <p className={cn("text-xs", duplicata ? "text-amber-900" : "text-gray-600")}>
          {relacao.motivo}
        </p>
        {doCofre && (
          <p className="text-[11px] text-gray-500 mt-0.5">
            Guardado em {formatDate(doCofre.criadoEm)}
            {doCofre.operacaoCodigo ? ` · operação ${doCofre.operacaoCodigo}` : ""}
            {" · "}
            <Link
              href={`/acervo/cofre/${doCofre.id}`}
              className="text-brand-orange hover:underline"
            >
              abrir
            </Link>
          </p>
        )}
        {duplicata && forcada && (
          <p className="text-[11px] font-semibold text-amber-800 mt-1">
            Vai subir mesmo assim — o cofre ficará com duas cópias deste arquivo.
          </p>
        )}
      </div>

      {duplicata && !forcada && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onRemover}
            className="text-[11px] font-semibold text-gray-600 hover:text-gray-900"
          >
            Remover
          </button>
          <button
            type="button"
            onClick={onForcar}
            className="text-[11px] font-semibold text-amber-700 hover:underline"
          >
            Subir mesmo assim
          </button>
        </div>
      )}
    </div>
  );
}
