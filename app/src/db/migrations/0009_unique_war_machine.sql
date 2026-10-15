CREATE TABLE "licitacao_eventos_vencedor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero_licitacao" text NOT NULL,
	"ordem" integer NOT NULL,
	"cnpj" text NOT NULL,
	"fornecedor" text NOT NULL,
	"tipo" text NOT NULL,
	"data_evento" timestamp with time zone NOT NULL,
	"motivo" text,
	"motivo_detalhe" text,
	"fonte" text DEFAULT 'CONFIRMACAO_INTERNA' NOT NULL,
	"observacao" text,
	"registrado_por" uuid,
	"registrado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "licitacao_eventos_vencedor" ADD CONSTRAINT "licitacao_eventos_vencedor_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_levev_lic" ON "licitacao_eventos_vencedor" USING btree ("numero_licitacao");--> statement-breakpoint
CREATE INDEX "idx_levev_cnpj" ON "licitacao_eventos_vencedor" USING btree ("cnpj");--> statement-breakpoint
CREATE INDEX "idx_levev_tipo" ON "licitacao_eventos_vencedor" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "idx_levev_data" ON "licitacao_eventos_vencedor" USING btree ("data_evento");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_levev_lic_ordem" ON "licitacao_eventos_vencedor" USING btree ("numero_licitacao","ordem");