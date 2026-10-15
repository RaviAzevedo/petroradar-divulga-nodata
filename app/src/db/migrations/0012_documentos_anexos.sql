CREATE TABLE "documentos_habilitacao_anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documento_id" uuid NOT NULL,
	"tipo" text DEFAULT 'ANEXO' NOT NULL,
	"titulo" text,
	"nome_arquivo" text NOT NULL,
	"blob_url" text NOT NULL,
	"blob_key" text NOT NULL,
	"tamanho_bytes" integer,
	"content_type" text,
	"uploadado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "documentos_habilitacao_anexos" ADD CONSTRAINT "documentos_habilitacao_anexos_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documentos_habilitacao_anexos" ADD CONSTRAINT "documentos_habilitacao_anexos_uploadado_por_users_id_fk" FOREIGN KEY ("uploadado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_doch_anexo_doc" ON "documentos_habilitacao_anexos" USING btree ("documento_id");
