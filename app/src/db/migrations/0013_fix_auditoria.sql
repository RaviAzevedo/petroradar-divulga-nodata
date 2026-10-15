-- NOTA: a tabela "documentos_habilitacao_anexos" e seus FKs/índice já são criados
-- pela migração 0012_documentos_anexos. O drizzle-kit os re-emitiu aqui apenas
-- porque o snapshot 0012 estava ausente (migração 0012 foi adicionada à mão).
-- Removido o CREATE TABLE/ADD CONSTRAINT/CREATE INDEX redundantes para que esta
-- migração seja idempotente em bancos que já rodaram a 0012. O snapshot 0013
-- mantém a tabela no estado desejado para diffs futuros.
ALTER TABLE "contratos_execucao" DROP CONSTRAINT "contratos_execucao_responsavel_sgi_users_id_fk";
--> statement-breakpoint
ALTER TABLE "documentos_habilitacao" DROP CONSTRAINT "documentos_habilitacao_atualizado_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "envelope_carta_versoes" DROP CONSTRAINT "envelope_carta_versoes_criado_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "envelope_itens" DROP CONSTRAINT "envelope_itens_atribuido_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" DROP CONSTRAINT "envelopes_habilitacao_responsavel_sgi_users_id_fk";
--> statement-breakpoint
ALTER TABLE "familias" DROP CONSTRAINT "familias_criado_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "familias" DROP CONSTRAINT "familias_atualizado_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "iqf_avaliacoes" DROP CONSTRAINT "iqf_avaliacoes_registrado_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" DROP CONSTRAINT "participacoes_licitacao_lider_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" DROP CONSTRAINT "participacoes_licitacao_responsavel_tecnico_users_id_fk";
--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" DROP CONSTRAINT "participacoes_licitacao_responsavel_orcamento_users_id_fk";
--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" DROP CONSTRAINT "participacoes_licitacao_editando_por_users_id_fk";
--> statement-breakpoint
ALTER TABLE "contratos_execucao" ADD CONSTRAINT "contratos_execucao_responsavel_sgi_users_id_fk" FOREIGN KEY ("responsavel_sgi") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_habilitacao" ADD CONSTRAINT "documentos_habilitacao_atualizado_por_users_id_fk" FOREIGN KEY ("atualizado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_carta_versoes" ADD CONSTRAINT "envelope_carta_versoes_criado_por_users_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_itens" ADD CONSTRAINT "envelope_itens_atribuido_por_users_id_fk" FOREIGN KEY ("atribuido_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD CONSTRAINT "envelopes_habilitacao_responsavel_sgi_users_id_fk" FOREIGN KEY ("responsavel_sgi") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias" ADD CONSTRAINT "familias_criado_por_users_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias" ADD CONSTRAINT "familias_atualizado_por_users_id_fk" FOREIGN KEY ("atualizado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_avaliacoes" ADD CONSTRAINT "iqf_avaliacoes_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_lider_id_users_id_fk" FOREIGN KEY ("lider_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_responsavel_tecnico_users_id_fk" FOREIGN KEY ("responsavel_tecnico") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_responsavel_orcamento_users_id_fk" FOREIGN KEY ("responsavel_orcamento") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_editando_por_users_id_fk" FOREIGN KEY ("editando_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_part_ativas" ON "participacoes_licitacao" USING btree ("fase","prazo_portal") WHERE deletado_em IS NULL;--> statement-breakpoint
-- Índice de expressão para o filtro de CNPJ Proponente (não-sargável: REGEXP_REPLACE
-- normaliza máscara/pontuação antes de comparar só os dígitos)
CREATE INDEX IF NOT EXISTS idx_prop_cnpj_digits ON propostas_licitacao (REGEXP_REPLACE(cnpj, '[^0-9]', '', 'g'));