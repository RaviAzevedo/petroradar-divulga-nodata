"use client";

// Nuvem de disciplinas (D10 — spec ONDA-5 §7.10) — presentational, zero fetch,
// zero estado, como os outros quatro desta pasta.
//
// ⚠️ HTML, não SVG, e a razão é de tela: cada palavra é um LINK para o
// deep-link do índice, e link dentro de `<svg>` não recebe o foco nem as
// classes de foco do resto da aplicação; além disso, `<text>` de SVG não quebra
// linha, e o card tem de funcionar a 400px.
//
// `peso` DIMENSIONA e `provado` COLORE — duas variáveis visuais para as duas
// perguntas ("quanto fizemos" e "quanto está provado"), sem multiplicá-las num
// índice que ninguém sabe ler. Nenhuma informação existe só na cor ou só no
// tamanho: as duas estão no `title` e no resumo `sr-only`.

import Link from "next/link";
import { PALETA, inteiroBR } from "./paleta";
import type { ItemNuvem } from "@/lib/acervo/painel";

export interface NuvemProps {
  /** De `nuvemDisciplinas` (lib/acervo/painel.ts) — já sem as de zero obra. */
  itens: ItemNuvem[];
  /** Disciplinas do catálogo com ZERO operação — listadas por extenso embaixo. */
  semCobertura: Array<{ codigo: string; nome: string }>;
  hrefDe: (codigo: string) => string;
}

/**
 * Degrau 1..6 → classe FIXA de tamanho. Escrita uma a uma de propósito: o
 * Tailwind v4 não gera classe que não está literal no fonte, então nem
 * `style={{fontSize}}` calculado nem classe montada por template servem aqui.
 */
const TAMANHO_POR_PESO: Record<ItemNuvem["peso"], string> = {
  1: "text-[11px]",
  2: "text-xs",
  3: "text-sm",
  4: "text-base",
  5: "text-lg",
  6: "text-xl",
};

/**
 * Régua de cor do percentual provado — a mesma do painel (≥85 verde, ≥70
 * laranja Proponente, ≥55 âmbar, abaixo disso vermelho), aqui em fração 0..1
 * com os cortes de §7.10: 0,85 · 0,60 · 0,30.
 */
function corDoProvado(provado: number): string {
  if (provado >= 0.85) return PALETA.verde;
  if (provado >= 0.6) return PALETA.laranja;
  if (provado >= 0.3) return PALETA.ambar;
  return PALETA.vermelho;
}

/** "62%" a partir da fração — o número exato mora no `title`. */
function pct(provado: number): string {
  return `${Math.round(provado * 100)}%`;
}

export function Nuvem({ itens, semCobertura, hrefDe }: NuvemProps) {
  const maior = itens.reduce<ItemNuvem | null>(
    (topo, i) => (topo === null || i.operacoes > topo.operacoes ? i : topo),
    null
  );

  return (
    <div className="min-w-0">
      {/* O resumo que o leitor de tela recebe no lugar da forma. */}
      <p className="sr-only">
        {itens.length === 0
          ? "Nenhuma disciplina com obra."
          : `Nuvem de ${inteiroBR(itens.length)} disciplinas; maior: ${maior?.nome} com ${inteiroBR(
              maior?.operacoes ?? 0
            )} obras; ${inteiroBR(semCobertura.length)} sem nenhuma obra.`}
      </p>

      {itens.length > 0 && (
        <ul className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {itens.map((i) => (
            <li key={i.codigo} className="min-w-0">
              <Link
                href={hrefDe(i.codigo)}
                title={`${i.nome} — ${inteiroBR(i.operacoes)} obras, ${inteiroBR(
                  i.comAtestado
                )} com atestado (${pct(i.provado)})`}
                style={{ color: corDoProvado(i.provado) }}
                className={`inline-flex items-baseline gap-1 rounded px-0.5 font-semibold hover:underline ${
                  TAMANHO_POR_PESO[i.peso]
                }`}
              >
                {/* O código dá âncora de leitura sem depender da cor. */}
                <span className="font-mono text-[10px] text-gray-400">{i.codigo}</span>
                {i.nome}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* SEMPRE — inclusive quando não há nenhuma: a disciplina sem obra é a
          resposta mais importante do C3, e com fonte mínima ela se esconderia
          justamente quando é o achado (§4.6). */}
      <p className="mt-3 text-xs text-gray-500">
        {semCobertura.length === 0
          ? "Todas as disciplinas do catálogo têm ao menos uma obra."
          : `Sem nenhuma obra: ${semCobertura.map((d) => d.nome).join(", ")}.`}
      </p>
    </div>
  );
}
