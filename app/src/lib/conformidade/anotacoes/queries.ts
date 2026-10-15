/**
 * Queries Reutilizáveis — Anotações do acervo (migration 0044)
 *
 * Regra da casa: handler não monta SQL. Tudo o que as rotas
 * /api/conformidade/anotacoes e /api/conformidade/anotacoes/[id] leem e
 * escrevem no banco está aqui.
 *
 * As rotas desta pasta são WEB-ONLY (spec ONDA-5 §1j): não há espelho Python a
 * manter em paridade — o que muda aqui não quebra o BFF. A dívida do espelho
 * está registrada na própria spec.
 *
 * Três decisões valem para o arquivo inteiro:
 *
 * 1. NENHUMA QUERY DAQUI FILTRA POR PAPEL. O recorte de visibilidade é do
 *    ALVO, não da anotação: quem pode ver o documento pode ver as anotações
 *    dele. Por isso a barreira é `paiRestritoInvisivel` na ROTA (§5.1) e não um
 *    `restricaoVisivel` no WHERE — que aqui nem existiria, porque
 *    `acervo_anotacoes` não tem coluna de restrição.
 *
 * 2. `redigirPii` É DA ROTA, NÃO DAQUI (§4.3). As duas escritas (POST e PATCH)
 *    recebem o texto JÁ redigido. Redigir aqui dentro funcionaria igual hoje e
 *    esconderia a regra de quem lê o handler — e é no handler que a política do
 *    módulo está escrita para o `ocrTexto`.
 *
 * 3. `atualizado_em` NÃO TEM TRIGGER em tabela nenhuma deste banco: todo UPDATE
 *    daqui seta `atualizadoEm: new Date()` na mão, senão o campo mente.
 *
 * `count(*)` leva `::int` porque `count` é bigint e o driver `pg` entrega
 * bigint como string — a tela espera 0, não "0".
 */

import { db } from "@/db";
import {
  acervoAnotacoes,
  documentosHabilitacao,
  operacoes,
  profissionais,
  type AcervoAnotacao,
  type AlvoAnotacao,
} from "@/db/schema";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { FiltrosAnotacaoInput } from "./validations";

export type AnotacaoLista = {
  id: string;
  alvoTipo: AlvoAnotacao;
  alvoId: string;
  autorId: string | null;
  autorNome: string;
  texto: string;
  criadoEm: Date | null;
  atualizadoEm: Date | null;
  resolvidaEm: Date | null;
};

/**
 * As colunas que a lista, o INSERT e o UPDATE devolvem — uma função (e não uma
 * constante) para cada query receber o seu próprio objeto.
 *
 * Lista explícita, nunca `SELECT *`: coluna nova na tabela tem de passar por
 * aqui para chegar à resposta, e é isso que faz o shape ser decisão e não
 * consequência.
 */
function colunasAnotacao() {
  return {
    id:           acervoAnotacoes.id,
    alvoTipo:     acervoAnotacoes.alvoTipo,
    alvoId:       acervoAnotacoes.alvoId,
    autorId:      acervoAnotacoes.autorId,
    autorNome:    acervoAnotacoes.autorNome,
    texto:        acervoAnotacoes.texto,
    criadoEm:     acervoAnotacoes.criadoEm,
    atualizadoEm: acervoAnotacoes.atualizadoEm,
    resolvidaEm:  acervoAnotacoes.resolvidaEm,
  };
}

/**
 * O par (alvo_tipo, alvo_id) — o WHERE de TODA consulta deste arquivo, e a
 * ordem exata das duas primeiras colunas de `idx_anot_alvo` (0044).
 */
function doAlvo(alvoTipo: AlvoAnotacao, alvoId: string): SQL | undefined {
  return and(eq(acervoAnotacoes.alvoTipo, alvoTipo), eq(acervoAnotacoes.alvoId, alvoId));
}

/**
 * As anotações de UM alvo. `resolvidas = false` (default) traz só as abertas
 * (`resolvida_em IS NULL`); `true` traz tudo. Os dois contadores voltam SEMPRE,
 * com os dois números, para a tela poder dizer "3 abertas · 2 resolvidas" sem
 * uma segunda chamada — e para o corte do default ser visível (Q10.3).
 *
 * ⚠️ Os contadores NÃO levam o filtro de `resolvidas`: eles contam o alvo
 * inteiro. Se levassem, `resolvidas: false` devolveria `resolvidas: 0` e a
 * frase da tela esconderia exatamente o que o eco existe para mostrar.
 *
 * ORDER BY criado_em DESC, id DESC: a mais recente em cima; `id` desempata
 * (duas anotações do mesmo segundo existem, e sem o desempate a ordem muda
 * entre chamadas — o mesmo defeito de D8, em escala menor).
 *
 * Sem paginação: anotações de um alvo são dezenas, não milhares, e a lista
 * nasce dentro de um bloco da ficha. Se um dia passar de 200 numa obra, o teto
 * entra com a tela que o pedir — não antes.
 */
export async function listAnotacoes(
  filtros: FiltrosAnotacaoInput,
): Promise<{ anotacoes: AnotacaoLista[]; abertas: number; resolvidas: number; filtros: FiltrosAnotacaoInput }> {
  const alvo = doAlvo(filtros.alvoTipo, filtros.alvoId);

  const anotacoes = await db
    .select(colunasAnotacao())
    .from(acervoAnotacoes)
    .where(filtros.resolvidas ? alvo : and(alvo, isNull(acervoAnotacoes.resolvidaEm)))
    .orderBy(desc(acervoAnotacoes.criadoEm), desc(acervoAnotacoes.id));

  // Uma segunda query, não um segundo laço em JS: contar em TS só contaria o
  // que a primeira trouxe, e a primeira já está recortada pelo default.
  const [contagens] = await db
    .select({
      abertas:    sql<number>`count(*) FILTER (WHERE ${acervoAnotacoes.resolvidaEm} IS NULL)::int`,
      resolvidas: sql<number>`count(*) FILTER (WHERE ${acervoAnotacoes.resolvidaEm} IS NOT NULL)::int`,
    })
    .from(acervoAnotacoes)
    .where(alvo);

  return {
    anotacoes,
    abertas:    contagens?.abertas ?? 0,
    resolvidas: contagens?.resolvidas ?? 0,
    // Eco do recorte aplicado (Q10.3) — inclusive do default que a tela não pediu.
    filtros,
  };
}

/**
 * O alvo existe? É a checagem que o POST faz ANTES de gravar, para o 422 sair
 * no campo em vez de a anotação nascer apontando para nada — não há FK em
 * `alvo_id`, de propósito (§2.3), então ninguém segura isso no banco.
 *
 * Um `switch` sobre as TRÊS tabelas, cada uma com o seu `SELECT 1 … LIMIT 1`.
 * Sem `restricaoVisivel` aqui: existência não é visibilidade, e o documento
 * restrito já foi barrado por `paiRestritoInvisivel` na rota, ANTES desta
 * chamada (§5.1). Trocar o 404 de lá pelo 422 daqui diria ao papel errado que
 * o documento existe (ADR-05).
 *
 * ⚠️ `PROFISSIONAL` consulta `profissionais`, que é da 0043: numa instalação
 * sem a onda 4 isto estouraria 42P01 → 500. §0.1 manda a ROTA recusar o alvo
 * ANTES, com 422 `{ alvoTipo: "Alvo indisponível nesta instalação" }` — esta
 * função assume a 0043 aplicada.
 *
 * ⚠️ O GET NÃO chama esta função (§5.1): alvo inexistente devolve lista vazia
 * com 200, que é a verdade ("não há anotação"), e a checagem custaria uma query
 * em toda abertura de ficha.
 */
export async function alvoExiste(alvoTipo: AlvoAnotacao, alvoId: string): Promise<boolean> {
  switch (alvoTipo) {
    case "OPERACAO": {
      const [linha] = await db
        .select({ um: sql<number>`1` })
        .from(operacoes)
        .where(eq(operacoes.id, alvoId))
        .limit(1);
      return linha !== undefined;
    }
    case "DOCUMENTO": {
      const [linha] = await db
        .select({ um: sql<number>`1` })
        .from(documentosHabilitacao)
        .where(eq(documentosHabilitacao.id, alvoId))
        .limit(1);
      return linha !== undefined;
    }
    case "PROFISSIONAL": {
      const [linha] = await db
        .select({ um: sql<number>`1` })
        .from(profissionais)
        .where(eq(profissionais.id, alvoId))
        .limit(1);
      return linha !== undefined;
    }
  }
}

/**
 * Grava. `texto` chega JÁ redigido pela rota (§1d) — esta função não redige.
 *
 * `autorNome` é desnormalizado de propósito e chega pronto (`nome ?? email`):
 * `users.nome` é NULLABLE e o usuário pode ser desligado — sem o nome na linha,
 * a anotação viraria "alguém escreveu isto", que é pior do que não ter.
 */
export async function criarAnotacao(args: {
  alvoTipo: AlvoAnotacao;
  alvoId: string;
  autorId: string;
  autorNome: string;
  texto: string;
}): Promise<AnotacaoLista> {
  const [linha] = await db
    .insert(acervoAnotacoes)
    .values({
      alvoTipo:  args.alvoTipo,
      alvoId:    args.alvoId,
      autorId:   args.autorId,
      autorNome: args.autorNome,
      texto:     args.texto,
    })
    .returning(colunasAnotacao());

  return linha!;
}

/**
 * A linha crua, para a rota decidir sobre existência e autoria sem pagar JOIN
 * (molde de `getProfissionalRow`, onda 4). A rota precisa de `autorId` para a
 * regra "quem escreveu ou ADMIN" e de `alvoTipo`/`alvoId` para aplicar o
 * `paiRestritoInvisivel` do alvo DOCUMENTO antes de qualquer efeito (§5.2).
 */
export async function getAnotacaoRow(id: string): Promise<AcervoAnotacao | null> {
  const [row] = await db
    .select()
    .from(acervoAnotacoes)
    .where(eq(acervoAnotacoes.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Edita texto e/ou resolve. `atualizadoEm: new Date()` SEMPRE explícito (não há
 * trigger); `resolvidaEm` recebe `new Date()` ou `null`. Devolve a linha nova.
 *
 * Os dois campos entram no `set` só quando vieram no patch: o zod já recusou o
 * body vazio (§4.2), e um `undefined` que virasse `null` apagaria o texto de
 * quem só quis resolver a anotação.
 *
 * `resolvida: false` volta `resolvida_em` para NULL — resolver é reversível, e
 * é por isso que resolver é UPDATE e não DELETE.
 */
export async function editarAnotacao(
  id: string,
  patch: { texto?: string; resolvida?: boolean },
): Promise<AnotacaoLista | null> {
  const valores: { texto?: string; resolvidaEm?: Date | null; atualizadoEm: Date } = {
    atualizadoEm: new Date(),
  };
  if (patch.texto !== undefined) valores.texto = patch.texto;
  if (patch.resolvida !== undefined) valores.resolvidaEm = patch.resolvida ? new Date() : null;

  const [linha] = await db
    .update(acervoAnotacoes)
    .set(valores)
    .where(eq(acervoAnotacoes.id, id))
    .returning(colunasAnotacao());

  return linha ?? null;
}

/**
 * DELETE de verdade (a anotação é do autor, e apagar o que se escreveu é
 * direito dele). Não há "arquivar": resolver já existe e é reversível — apagar
 * é para o que não devia ter sido escrito.
 *
 * `false` quando a anotação não existe; a rota já conferiu existência e autoria
 * por `getAnotacaoRow`, e este retorno é a rede contra a corrida entre as duas
 * chamadas.
 */
export async function removerAnotacao(id: string): Promise<boolean> {
  const apagadas = await db
    .delete(acervoAnotacoes)
    .where(eq(acervoAnotacoes.id, id))
    .returning({ id: acervoAnotacoes.id });

  return apagadas.length > 0;
}
