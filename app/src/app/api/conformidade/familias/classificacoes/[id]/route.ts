export const runtime = "nodejs";

/**
 * PATCH /api/conformidade/familias/classificacoes/[id] — revisa UM indício.
 *
 * POR QUE ESTA ROTA EXISTE
 * ────────────────────────
 * A classificação grava indícios por família. Nenhum deles vira prova
 * sozinho: por decisão da migração 0041, prova é `documentos_familias`, e lá só
 * se entra pela mão de uma pessoa. Até esta rota existir, `revisao` estava NULL
 * em todas as linhas — a fila era só de leitura, e o mapa não tinha como sair
 * de "com indício" para "com prova" em família nenhuma.
 *
 * O QUE CADA DECISÃO FAZ
 * ──────────────────────
 *   CONFIRMADA  cria o vínculo em `documentos_familias` e aponta `vinculo_id`.
 *               É o único caminho de indício → prova. Se a família NÃO está
 *               cadastrada não há a que vincular (a FK exige `familias.id`): a
 *               revisão fica gravada e a resposta diz `viraProva: false` — o
 *               indício confirmado passa a ser o ARGUMENTO do pedido de CRC.
 *   PARCIAL     sustenta em parte. Não cria vínculo — meia prova não habilita.
 *   REJEITADA   não sustenta. Precisa PERSISTIR (e não sumir): representar o
 *               "não" por ausência de linha faria a próxima carga ressuscitar a
 *               sugestão e a revisão virar Sísifo.
 *
 * REJEITAR NÃO APAGA VÍNCULO. Se já havia prova vinculada, ela fica e a resposta
 * devolve `vinculoMantido: true`. Um vínculo pode ter sido criado à mão, no
 * cofre, por outra pessoa e por outra razão; apagá-lo por causa de um veredito
 * de máquina rejeitado destruiria trabalho humano — e apagar não é reversível,
 * enquanto deixar é.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { requireConformidade, handleApiError } from "@/lib/api/guards";
import { redigirPii } from "@/lib/seguranca/pii";

type Params = { params: Promise<{ id: string }> };

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RevisarSchema = z.object({
  // null = desfazer a revisão e devolver o indício para a fila. Precisa existir:
  // sem ele, um clique errado em REJEITADA é definitivo pela tela.
  revisao: z.enum(["CONFIRMADA", "REJEITADA", "PARCIAL"]).nullable(),
  motivo: z.string().trim().max(2000).nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  let session: Awaited<ReturnType<typeof requireConformidade>>;
  try {
    session = await requireConformidade();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!RE_UUID.test(id)) {
    return NextResponse.json({ error: "Indício não encontrado" }, { status: 404 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ code: "VALIDACAO", error: "JSON inválido" }, { status: 422 });
  }

  const parsed = RevisarSchema.safeParse(corpo);
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "VALIDACAO",
        error: "Revisão inválida",
        campos: parsed.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  }
  const { revisao } = parsed.data;
  const motivo = parsed.data.motivo?.trim() || null;

  try {
    const resultado = await db.transaction(async (tx) => {
      // FOR UPDATE em `familias_classificacoes`: duas pessoas revisando o mesmo
      // indício ao mesmo tempo criariam dois vínculos para o mesmo par — o
      // índice único barraria o segundo com 23505, um erro 500 em vez de uma
      // segunda decisão coerente.
      const atualR = await tx.execute(sql`
        SELECT fc.id, fc.documento_id, fc.familia_codigo, fc.veredito,
               fc.revisao, fc.vinculo_id, d.restrito
          FROM familias_classificacoes fc
          JOIN documentos_habilitacao d ON d.id = fc.documento_id
         WHERE fc.id = ${id}::uuid
         FOR UPDATE OF fc
      `);
      const atual = ((atualR as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
      if (!atual) return { status: 404 as const };

      const codigo = String(atual.familia_codigo);
      const documentoId = String(atual.documento_id);
      const revisaoAntes = atual.revisao == null ? null : String(atual.revisao);
      const vinculoAntes = atual.vinculo_id == null ? null : String(atual.vinculo_id);

      // A família cadastrada, quando existe. f_codigo_crc dos dois lados: o
      // indício grava o código já normalizado, o cadastro grava com o padding
      // do SAP, e comparar cru erraria em toda família com zero à esquerda.
      const famR = await tx.execute(sql`
        SELECT id FROM familias
         WHERE deletado_em IS NULL AND f_codigo_crc(codigo_crc) = ${codigo}
         LIMIT 1
      `);
      const familiaId =
        ((famR as unknown as { rows: { id: string }[] }).rows ?? [])[0]?.id ?? null;

      let vinculoId = vinculoAntes;
      let vinculoMantido = false;

      if (revisao === "CONFIRMADA" && familiaId) {
        // ON CONFLICT: o par pode já estar vinculado à mão pelo cofre. Nesse
        // caso a confirmação apenas ADOTA o vínculo existente — criar outro é
        // impossível (índice único) e falhar seria absurdo, já que o estado
        // desejado é exatamente o que está lá.
        const vR = await tx.execute(sql`
          WITH novo AS (
            INSERT INTO documentos_familias (documento_id, familia_id, observacao)
            VALUES (${documentoId}::uuid, ${familiaId}::uuid,
                    ${motivo ?? "Confirmado a partir de indício da classificação do acervo"})
            ON CONFLICT (documento_id, familia_id) DO NOTHING
            RETURNING id
          )
          SELECT id FROM novo
          UNION ALL
          SELECT id FROM documentos_familias
           WHERE documento_id = ${documentoId}::uuid AND familia_id = ${familiaId}::uuid
          LIMIT 1
        `);
        vinculoId = ((vR as unknown as { rows: { id: string }[] }).rows ?? [])[0]?.id ?? null;
      } else if (revisao !== "CONFIRMADA") {
        // Solta o ponteiro, preserva a linha de prova. Ver cabeçalho.
        if (vinculoAntes) vinculoMantido = true;
        vinculoId = null;
      }

      const atualizadoR = await tx.execute(sql`
        UPDATE familias_classificacoes
           SET revisao        = ${revisao},
               revisado_por   = ${revisao ? session.user.id : null}::uuid,
               revisado_em    = ${revisao ? sql`now()` : sql`NULL`},
               motivo_revisao = ${motivo},
               vinculo_id     = ${vinculoId}::uuid
         WHERE id = ${id}::uuid
        RETURNING id, familia_codigo, documento_id, veredito, confianca,
                  justificativa, revisao, revisado_em, motivo_revisao, vinculo_id
      `);
      const linha = ((atualizadoR as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];

      await tx.execute(sql`
        INSERT INTO audit_log (user_id, acao, entidade, entidade_id, detalhes)
        VALUES (${session.user.id}::uuid, 'REVISAR_INDICIO_FAMILIA',
                'familia_classificacao', ${id},   -- entidade_id e TEXT no schema: cast
                                 -- para uuid quebraria o INSERT.
                ${JSON.stringify({
                  familiaCodigo: codigo,
                  documentoId,
                  veredito: String(atual.veredito),
                  antes: { revisao: revisaoAntes, vinculoId: vinculoAntes },
                  depois: { revisao, vinculoId },
                  familiaCadastrada: Boolean(familiaId),
                  motivo,
                })}::jsonb)
      `);

      return {
        status: 200 as const,
        indicio: linha
          ? { ...linha, justificativa: redigirPii(linha.justificativa as string | null) }
          : null,
        familiaCadastrada: Boolean(familiaId),
        // A distinção que a tela precisa dizer em voz alta: confirmar um indício
        // de família NÃO cadastrada não gera prova — gera argumento para pedir o
        // CRC. Sem isto a pessoa confirma vários indícios e acha que habilitou.
        viraProva: revisao === "CONFIRMADA" && Boolean(familiaId),
        vinculoMantido,
      };
    });

    if (resultado.status === 404) {
      return NextResponse.json({ error: "Indício não encontrado" }, { status: 404 });
    }
    return NextResponse.json(resultado);
  } catch (e) {
    return handleApiError(e);
  }
}
