ALTER TABLE "envelopes_habilitacao" DROP CONSTRAINT "envelopes_habilitacao_participacao_id_unique";--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" DROP CONSTRAINT "envelopes_habilitacao_participacao_id_participacoes_licitacao_id_fk";
--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ALTER COLUMN "participacao_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "origem" text DEFAULT 'PARTICIPACAO' NOT NULL;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "licitacao_id" uuid;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "numero_edital" text NOT NULL;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "empresa_contratante" text DEFAULT 'Petrobras' NOT NULL;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "objeto" text NOT NULL;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD CONSTRAINT "envelopes_habilitacao_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD CONSTRAINT "envelopes_habilitacao_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_env_origem" ON "envelopes_habilitacao" USING btree ("origem");--> statement-breakpoint
CREATE INDEX "idx_env_lic" ON "envelopes_habilitacao" USING btree ("licitacao_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_env_part_unique" ON "envelopes_habilitacao" USING btree ("participacao_id") WHERE participacao_id IS NOT NULL;