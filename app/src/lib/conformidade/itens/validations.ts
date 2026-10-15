/**
 * Schemas de Validação — Itens com TAG do documento (Q9, migration 0044)
 *
 * Cobre a rota-satélite GET|POST|DELETE
 * /api/conformidade/cofre/documentos/[id]/itens. Molde: as duas satélites da
 * onda 4 (`profissionais`, `atividades`).
 *
 * MENSAGENS em pt-BR porque caem direto na tela: o `detalhes` do 422 é
 * renderizado campo a campo, então cada mensagem daqui é contrato de API.
 *
 * ⚠️ NÃO EXISTE `quantidade` NEM `unidade` AQUI (spec ONDA-5 §1f). A TAG diz
 * QUAL equipamento, não quanto. Um cliente que mandasse `quantidade` tem o
 * campo descartado pelo strip do `z.object()`; a regra escrita é: não existe
 * coluna, não existe campo.
 *
 * ⚠️ `tag` daqui NÃO é `documentosHabilitacao.tags`: aquilo é rótulo livre de
 * arquivamento do ARQUIVO ("urgente", "REF-A"); isto é a TAG de EQUIPAMENTO
 * citada dentro do documento ("P-101 A/B", "TQ-4210"). Nomes parecidos, coisas
 * diferentes — o `COMMENT ON` da 0044 diz o mesmo no banco.
 *
 * Não há schema de edição: corrigir é apagar e recriar (§5.8), a mesma decisão
 * de `documento_atividades` na onda 4.
 */

import { z } from "zod";

/**
 * POST /api/conformidade/cofre/documentos/[id]/itens.
 *
 * `documentoId` NÃO entra no body: vem do path. `ordem` ausente vira
 * `max(ordem) + 1` calculado NO BANCO (§4.8) — duas abas abertas no mesmo
 * documento calculariam a mesma ordem e as linhas sairiam embaralhadas.
 *
 * A TAG repetida no mesmo documento não é recusada aqui (é conferida na query,
 * contra o índice `uniq_docitem_tag`, antes do INSERT): o zod valida forma, e
 * unicidade é fato do banco, não do formato.
 */
export const CriarItemTagSchema = z.object({
  tag:       z.string().trim().min(1, "Informe a TAG").max(100, "TAG muito longa"),
  descricao: z.string().trim().max(500).optional().nullable(),
  /**
   * Chave→valor de uma linha só (material, diâmetro, classe, spec). Objeto
   * aninhado é recusado de propósito: `especificacao` é ficha de equipamento,
   * não documento — e um jsonb livre vira o lugar onde tudo cabe.
   */
  especificacao: z.record(z.string().max(60), z.string().max(200)).optional().nullable(),
  ordem: z.coerce.number().int().min(0).max(9999).optional(),
});
export type CriarItemTagInput = z.infer<typeof CriarItemTagSchema>;
