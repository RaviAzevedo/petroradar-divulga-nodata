CREATE INDEX "idx_perfis_ativo" ON "perfis_interesse" USING btree ("ativo");--> statement-breakpoint
CREATE INDEX "idx_sync_executado_em" ON "sync_log" USING btree ("executado_em");