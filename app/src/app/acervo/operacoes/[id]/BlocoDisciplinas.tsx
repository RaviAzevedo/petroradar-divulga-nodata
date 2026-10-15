"use client";

/**
 * D3 — bloco "Disciplinas da obra" na ficha (spec ONDA-4 §7.1).
 *
 * ⚠️ É um bloco À PARTE, NUNCA uma 10ª seção (§1b): as seções da ficha são
 * fechadas em 1..9 em cinco lugares que se conferem entre si (`SecaoMontada`,
 * `montarSecoes`, o laço `[1..9]` da página, `SECOES_FICHA` e o espelho
 * `conf_dossie_secoes.py`), e disciplina não é pilha de documentos — é atributo
 * da operação. Por isso `id="bloco-disciplinas"` e não `secao-N`: o bloco não
 * entra no trilho, nem no `IntersectionObserver`, nem na árvore do ZIP.
 *
 * ⚠️ Também NÃO entra na barra "N de M dados": ela conta campos do CADASTRO, e
 * um vínculo N:N ali faria toda operação já cadastrada cair de "8 de 8" para
 * "8 de 9" sem ninguém ter mexido em nada.
 *
 * Sem `useEffect`, sem `Skeleton` e sem fetch: os dados chegam por prop, do
 * MESMO R3 que já carrega a ficha — uma segunda viagem aqui seria uma
 * requisição por ficha aberta para exibir três chips.
 */

import { useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { ModalDisciplinas, type DisciplinaDaObra } from "./ModalDisciplinas";

interface Props {
  operacaoId: string;
  codigo: string;
  disciplinas: DisciplinaDaObra[];
  podeEditar: boolean;
  /** A ficha guarda o conjunto novo no estado local — sem `router.refresh()`. */
  onAtualizado: (novas: DisciplinaDaObra[]) => void;
}

export function BlocoDisciplinas({
  operacaoId,
  codigo,
  disciplinas,
  podeEditar,
  onAtualizado,
}: Props) {
  const [modal, setModal] = useState(false);

  return (
    <section id="bloco-disciplinas" aria-labelledby="bloco-disciplinas-titulo" className="mt-4">
      <div className="flex items-center gap-2 mb-1.5">
        <h2
          id="bloco-disciplinas-titulo"
          className="text-[11px] font-semibold uppercase tracking-wide text-gray-500"
        >
          Disciplinas da obra
        </h2>
        {podeEditar && (
          <button
            type="button"
            onClick={() => setModal(true)}
            aria-label="Editar disciplinas da obra"
            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-brand-orange"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {disciplinas.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {disciplinas.map((d) => (
            <li key={d.id}>
              {/* O chip é LINK para o índice filtrado (§7.4): "esta obra teve
                  Instrumentação" e "quais outras obras tiveram Instrumentação"
                  são a mesma pergunta, e o caminho tem de ser um clique. */}
              <Link
                href={`/acervo/operacoes?disciplina=${d.codigo}`}
                title={d.nome}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-200 rounded-full hover:border-brand-orange hover:bg-orange-50/50"
              >
                <span className="font-mono">{d.codigo}</span> {d.nome}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        // Nunca um vazio que esconde o gesto: obra sem disciplina é a regra
        // hoje (a coluna nasce vazia), e a tela existe para mudar isso.
        <p className="text-xs text-gray-400">
          Nenhuma disciplina declarada.{" "}
          {podeEditar && (
            <button
              type="button"
              onClick={() => setModal(true)}
              className="text-xs text-brand-orange hover:underline"
            >
              Declarar disciplinas
            </button>
          )}
        </p>
      )}

      {modal && (
        <ModalDisciplinas
          operacaoId={operacaoId}
          codigo={codigo}
          atuais={disciplinas}
          onClose={() => setModal(false)}
          onSalvo={(novas) => {
            onAtualizado(novas);
            setModal(false);
          }}
        />
      )}
    </section>
  );
}
