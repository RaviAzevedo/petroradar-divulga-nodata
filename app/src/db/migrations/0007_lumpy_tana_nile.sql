CREATE TABLE "envelope_carta_versoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"versao" integer NOT NULL,
	"destinatario" text NOT NULL,
	"referencia" text,
	"assunto" text NOT NULL,
	"vocativo" text DEFAULT 'Prezados Senhores,' NOT NULL,
	"corpo" text NOT NULL,
	"fecho" text DEFAULT 'Atenciosamente,' NOT NULL,
	"signatarios" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"motivo_revisao" text,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "envelope_documentos_extras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"documento_id" uuid NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"observacao" text,
	"adicionado_por" uuid,
	"adicionado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "carta_versao_atual_id" uuid;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD COLUMN "carta_data" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "envelope_carta_versoes" ADD CONSTRAINT "envelope_carta_versoes_envelope_id_envelopes_habilitacao_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_carta_versoes" ADD CONSTRAINT "envelope_carta_versoes_criado_por_users_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_documentos_extras" ADD CONSTRAINT "envelope_documentos_extras_envelope_id_envelopes_habilitacao_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_documentos_extras" ADD CONSTRAINT "envelope_documentos_extras_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_documentos_extras" ADD CONSTRAINT "envelope_documentos_extras_adicionado_por_users_id_fk" FOREIGN KEY ("adicionado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_carta_env" ON "envelope_carta_versoes" USING btree ("envelope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_carta_env_versao" ON "envelope_carta_versoes" USING btree ("envelope_id","versao");--> statement-breakpoint
CREATE INDEX "idx_envextras_env" ON "envelope_documentos_extras" USING btree ("envelope_id");--> statement-breakpoint
CREATE INDEX "idx_envextras_doc" ON "envelope_documentos_extras" USING btree ("documento_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_envextras_env_doc" ON "envelope_documentos_extras" USING btree ("envelope_id","documento_id");