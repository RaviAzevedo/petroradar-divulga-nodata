/**
 * Queries Reutilizáveis — Itens com TAG do documento (Q9, migration 0044)
 *
 * Regra da casa: handler não monta SQL. Tudo o que a rota-satélite
 * /api/conformidade/cofre/documentos/[id]/itens lê e escreve está aqui.
 *
 * A rota é WEB-ONLY (spec ONDA-5 §1j): não há espelho Python a manter em
 * paridade. A dívida do espelho está registrada na própria spec.
 *
 * Três decisões valem para o arquivo inteiro:
 *
 * 1. NÃO HÁ COLUNA DE QUANTIDADE (§1f): o item diz QUAL equipamento o
 *    documento lista, não quanto.
 *
 * 2. NENHUMA QUERY DAQUI FILTRA POR PAPEL. A barreira é `paiRestritoInvisivel`
 *    na ROTA, antes de qualquer efeito nos três handlers (§5.8): quem pode ver
 *    o documento pode ver os itens dele, e `documento_itens_tag` não tem coluna
 *    de restrição.
 *
 * 3. O QUE O BANCO GARANTE É CONFERIDO ANTES. O índice `uniq_docitem_tag`
 *    existe para a integridade, não para produzir um 23505 → 500 na cara do
 *    usuário: a TAG repetida é recusada por consulta, com mensagem no campo.
 */

import { db } from "@/db";
import { documentoItensTag } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

export type ItemTagDoDocumento = {
  id: string;
  /** 'P-101 A/B', 'TQ-4210' — TAG de EQUIPAMENTO, não `documentosHabilitacao.tags` (§1f). */
  tag: string;
  descricao: string | null;
  /** Material, diâmetro, classe, spec — chave→valor de uma linha só. */
  especificacao: Record<string, string> | null;
  ordem: number;
};

/** O SELECT dos itens — o mesmo molde de `consultaAtividades()` (onda 4). */
function consultaItens() {
  return db
    .select({
      id:            documentoItensTag.id,
      documentoId:   documentoItensTag.documentoId,
      tag:           documentoItensTag.tag,
      descricao:     documentoItensTag.descricao,
      especificacao: documentoItensTag.especificacao,
      ordem:         documentoItensTag.ordem,
    })
    .from(documentoItensTag);
}

type LinhaItem = Awaited<ReturnType<ReturnType<typeof consultaItens>["execute"]>>[number];

function montarItem(linha: LinhaItem): ItemTagDoDocumento {
  const { documentoId: _documentoId, ...item } = linha;
  return item;
}

/**
 * Os itens de UM documento.
 *
 * ORDER BY ordem ASC, upper(btrim(tag)) ASC, id ASC — `tag` desempata porque
 * `ordem` nasce 0 em tudo que entra sem posição, e sem o segundo critério a
 * lista muda de ordem entre recargas (o mesmo defeito de D8, em escala menor).
 * A normalização da segunda chave é a MESMA do índice único: 'p-101' e 'P-101 '
 * são a mesma bomba, e ordenar pelo texto cru colocaria as duas grafias em
 * lugares diferentes.
 */
export async function listItensDoDocumento(documentoId: string): Promise<ItemTagDoDocumento[]> {
  const rows = await consultaItens()
    .where(eq(documentoItensTag.documentoId, documentoId))
    .orderBy(
      asc(documentoItensTag.ordem),
      asc(sql`upper(btrim(${documentoItensTag.tag}))`),
      asc(documentoItensTag.id),
    );

  return rows.map(montarItem);
}

export type ResultadoItemTag =
  | { ok: true; id: string }
  | { ok: false; detalhes: Record<string, string> };

/**
 * Cadastra um item com TAG.
 *
 * A conferência da TAG repetida é feita ANTES do INSERT, com a MESMA expressão
 * do índice `uniq_docitem_tag` (`upper(btrim(...))`, que é o que o índice
 * indexa — então a consulta o usa em vez de varrer a tabela): o índice existe
 * para a integridade, não para produzir um 23505 → 500 na cara do usuário.
 * Corrida entre duas abas ainda estoura no banco, e isso é o certo — o que não
 * pode é o caminho NORMAL terminar em 500.
 *
 * `ordem` ausente → `max(ordem) + 1` calculado NO BANCO, não no cliente: duas
 * abas abertas no mesmo documento calculariam a mesma ordem e as linhas sairiam
 * embaralhadas. `coalesce(max(...), -1) + 1` faz o primeiro item nascer com
 * ordem 0, que é o default da coluna.
 */
export async function criarItemTag(args: {
  documentoId: string;
  tag: string;
  descricao: string | null;
  especificacao: Record<string, string> | null;
  ordem: number | null;
}): Promise<ResultadoItemTag> {
  const [repetida] = await db
    .select({ id: documentoItensTag.id })
    .from(documentoItensTag)
    .where(
      and(
        eq(documentoItensTag.documentoId, args.documentoId),
        sql`upper(btrim(${documentoItensTag.tag})) = upper(btrim(${args.tag}))`,
      )
    )
    .limit(1);

  if (repetida) {
    return { ok: false, detalhes: { tag: "Este item já está listado neste documento" } };
  }

  const proximaOrdem = sql<number>`(SELECT coalesce(max(${documentoItensTag.ordem}), -1) + 1
    FROM ${documentoItensTag} WHERE ${documentoItensTag.documentoId} = ${args.documentoId})`;

  const [linha] = await db
    .insert(documentoItensTag)
    .values({
      documentoId:   args.documentoId,
      tag:           args.tag,
      descricao:     args.descricao,
      especificacao: args.especificacao,
      ordem:         args.ordem ?? proximaOrdem,
    })
    .returning({ id: documentoItensTag.id });

  return { ok: true, id: linha!.id };
}

/**
 * `false` quando o item não existe OU é de outro documento — o WHERE casa os
 * dois ids juntos (molde do DELETE de projeto), e a rota devolve o mesmo 404
 * nos dois casos, nunca 403: quem não pode saber que o item existe também não
 * pode saber que ele é de outro documento.
 */
export async function removerItemTag(documentoId: string, itemId: string): Promise<boolean> {
  const apagados = await db
    .delete(documentoItensTag)
    .where(
      and(
        eq(documentoItensTag.id, itemId),
        eq(documentoItensTag.documentoId, documentoId),
      )
    )
    .returning({ id: documentoItensTag.id });

  return apagados.length > 0;
}
