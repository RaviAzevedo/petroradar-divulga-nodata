"use client";

// Barras horizontais com valor — presentational, zero fetch, zero estado.
// Spec do Painel do Acervo §3. Cada item em DUAS linhas: rótulo
// inteiro + valor à direita em cima, barra de largura total embaixo — coluna
// fixa de rótulo truncava "Dossiês complet..." nos cards estreitos.
// `href` presente → o item inteiro vira Link (nunca âncora vazia: rótulo e
// valor são o conteúdo textual do link).

import Link from "next/link";
import { PALETA, inteiroBR } from "./paleta";

export interface ItemBarraH {
  rotulo: string;
  valor: number;
  /** Cor da barra (default: laranja Proponente). */
  cor?: string;
  /** Tooltip da linha (default: o próprio rótulo). */
  titulo?: string;
  /** Presente → linha vira Link para este destino. */
  href?: string;
}

export interface BarrasHProps {
  itens: ItemBarraH[];
  /** Escala comum (default: maior valor dos itens). */
  maximo?: number;
  /** Formatação do valor à direita (default: toLocaleString pt-BR). */
  formatar?: (v: number) => string;
}

export function BarrasH({ itens, maximo, formatar }: BarrasHProps) {
  if (itens.length === 0) return null;

  const fmt = formatar ?? inteiroBR;
  const maiorItem = itens.reduce((maior, i) => Math.max(maior, i.valor), 0);
  const escala = maximo !== undefined && maximo > 0 ? maximo : maiorItem;
  const base = escala > 0 ? escala : 1; // evita divisão por zero (tudo 0 → barras vazias)

  return (
    <ul className="flex flex-col gap-2.5">
      {itens.map((item, i) => {
        const pct = Math.max(0, Math.min(100, (item.valor / base) * 100));
        const linha = (
          <>
            <span className="flex items-baseline justify-between gap-3">
              <span
                className="min-w-0 truncate text-[13px] text-gray-600"
                title={item.titulo ?? item.rotulo}
              >
                {item.rotulo}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-800">
                {fmt(item.valor)}
              </span>
            </span>
            <span className="relative block h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <span
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${pct}%`, backgroundColor: item.cor ?? PALETA.laranja }}
              />
            </span>
          </>
        );
        return (
          <li key={`${item.rotulo}-${i}`} className="min-w-0">
            {item.href ? (
              <Link
                href={item.href}
                className="-mx-1.5 flex flex-col gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-gray-50"
              >
                {linha}
              </Link>
            ) : (
              <div className="flex flex-col gap-1 py-0.5">{linha}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
