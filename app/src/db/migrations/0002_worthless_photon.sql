CREATE TABLE "propostas_licitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid,
	"numero_licitacao" text NOT NULL,
	"item_numero" text,
	"item_descricao" text,
	"cnpj" text NOT NULL,
	"fornecedor" text NOT NULL,
	"me_epp" boolean DEFAULT false,
	"valor_unitario" numeric(18, 2),
	"valor_total" numeric(18, 2),
	"declinou" boolean DEFAULT false,
	"data_proposta" text,
	"posicao" integer,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "resultados_licitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid,
	"numero_licitacao" text NOT NULL,
	"cnpj_vencedor" text,
	"fornecedor_vencedor" text,
	"valor_vencedor" numeric(18, 2),
	"total_participantes" integer DEFAULT 0,
	"total_propostas" integer DEFAULT 0,
	"menor_valor" numeric(18, 2),
	"maior_valor" numeric(18, 2),
	"status_resultado" text,
	"objeto" text,
	"empresa" text,
	"segmento" text,
	"natureza" text,
	"data_fim" text,
	"detectado_em" timestamp with time zone DEFAULT now(),
	"criado_em" timestamp with time zone DEFAULT now(),
	CONSTRAINT "resultados_licitacao_numero_licitacao_unique" UNIQUE("numero_licitacao")
);
--> statement-breakpoint
ALTER TABLE "propostas_licitacao" ADD CONSTRAINT "propostas_licitacao_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resultados_licitacao" ADD CONSTRAINT "resultados_licitacao_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prop_licitacao" ON "propostas_licitacao" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_prop_numero" ON "propostas_licitacao" USING btree ("numero_licitacao");--> statement-breakpoint
CREATE INDEX "idx_prop_cnpj" ON "propostas_licitacao" USING btree ("cnpj");--> statement-breakpoint
CREATE INDEX "idx_prop_fornecedor" ON "propostas_licitacao" USING btree ("fornecedor");--> statement-breakpoint
CREATE INDEX "idx_res_licitacao" ON "resultados_licitacao" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_res_numero" ON "resultados_licitacao" USING btree ("numero_licitacao");--> statement-breakpoint
CREATE INDEX "idx_res_vencedor_cnpj" ON "resultados_licitacao" USING btree ("cnpj_vencedor");--> statement-breakpoint
CREATE INDEX "idx_res_segmento" ON "resultados_licitacao" USING btree ("segmento");--> statement-breakpoint
CREATE INDEX "idx_res_natureza" ON "resultados_licitacao" USING btree ("natureza");