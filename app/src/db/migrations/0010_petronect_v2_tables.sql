CREATE TABLE "petronect_lic_andamento" (
	"numero" text PRIMARY KEY NOT NULL,
	"dispute_mode" text NOT NULL,
	"status" text,
	"status_desc" text,
	"sub_status" text,
	"opport_type" text,
	"company" text,
	"company_desc" text,
	"opport_descr" text,
	"desc_obj_contrat" text,
	"posting_date" text,
	"dou_publ_date" text,
	"dou_num" text,
	"start_date" text,
	"start_hour" text,
	"end_date" text,
	"end_hour" text,
	"open_date" text,
	"open_hour" text,
	"auc_start_date" text,
	"auc_start_time" text,
	"pq_vendor_list_date" text,
	"pq_vendor_list_hour" text,
	"is_equalized" boolean DEFAULT false,
	"has_prequalified" boolean DEFAULT false,
	"is_prequali" boolean DEFAULT false,
	"limit_in_days" integer DEFAULT 0,
	"nat_coverage" text,
	"regions" jsonb DEFAULT '[]'::jsonb,
	"raw_payload" jsonb,
	"captured_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "petronect_lic_anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"description" text NOT NULL,
	"phio_objid" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "petronect_lic_eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"tipo" text NOT NULL,
	"campo" text,
	"valor_anterior" text,
	"valor_novo" text,
	"payload" jsonb,
	"detectado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "petronect_lic_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"item_num" text NOT NULL,
	"exlin" text,
	"item_desc" text,
	"unit" text,
	"quantity" numeric(18, 4),
	"deliv_date" text,
	"grouping_level" text,
	"item_process_typ" text,
	"family" text,
	"family_descr" text,
	"num_material" text,
	"family_classif" text,
	"item_notes" jsonb DEFAULT '[]'::jsonb,
	"captured_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "petronect_lic_propostas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"item_numero_int" text,
	"item_descricao" text,
	"cnpj" text,
	"fornecedor" text,
	"me_epp" boolean DEFAULT false,
	"unit_value" numeric(18, 2),
	"total_value" numeric(18, 2),
	"quantity" numeric(18, 4),
	"characteristic" text,
	"declinou" boolean DEFAULT false,
	"data_proposta" text,
	"posicao" integer,
	"captured_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "petronect_lic_resultado" (
	"numero" text PRIMARY KEY NOT NULL,
	"cnpj_vencedor" text,
	"fornecedor_vencedor" text,
	"valor_vencedor" numeric(18, 2),
	"total_participantes" integer DEFAULT 0,
	"total_propostas" integer DEFAULT 0,
	"menor_valor" numeric(18, 2),
	"maior_valor" numeric(18, 2),
	"status_resultado" text,
	"detectado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "petronect_lic_anexos" ADD CONSTRAINT "petronect_lic_anexos_numero_petronect_lic_andamento_numero_fk" FOREIGN KEY ("numero") REFERENCES "public"."petronect_lic_andamento"("numero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petronect_lic_eventos" ADD CONSTRAINT "petronect_lic_eventos_numero_petronect_lic_andamento_numero_fk" FOREIGN KEY ("numero") REFERENCES "public"."petronect_lic_andamento"("numero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petronect_lic_items" ADD CONSTRAINT "petronect_lic_items_numero_petronect_lic_andamento_numero_fk" FOREIGN KEY ("numero") REFERENCES "public"."petronect_lic_andamento"("numero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petronect_lic_propostas" ADD CONSTRAINT "petronect_lic_propostas_numero_petronect_lic_andamento_numero_fk" FOREIGN KEY ("numero") REFERENCES "public"."petronect_lic_andamento"("numero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petronect_lic_resultado" ADD CONSTRAINT "petronect_lic_resultado_numero_petronect_lic_andamento_numero_fk" FOREIGN KEY ("numero") REFERENCES "public"."petronect_lic_andamento"("numero") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_petronect_andamento_dispute" ON "petronect_lic_andamento" USING btree ("dispute_mode");--> statement-breakpoint
CREATE INDEX "idx_petronect_andamento_substatus" ON "petronect_lic_andamento" USING btree ("sub_status");--> statement-breakpoint
CREATE INDEX "idx_petronect_andamento_status" ON "petronect_lic_andamento" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_petronect_andamento_captured" ON "petronect_lic_andamento" USING btree ("captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_petronect_anexo_numero_phio" ON "petronect_lic_anexos" USING btree ("numero","phio_objid");--> statement-breakpoint
CREATE INDEX "idx_petronect_evento_numero" ON "petronect_lic_eventos" USING btree ("numero");--> statement-breakpoint
CREATE INDEX "idx_petronect_evento_tipo" ON "petronect_lic_eventos" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "idx_petronect_evento_data" ON "petronect_lic_eventos" USING btree ("detectado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_petronect_item_numero_itemnum" ON "petronect_lic_items" USING btree ("numero","item_num");--> statement-breakpoint
CREATE INDEX "idx_petronect_item_family" ON "petronect_lic_items" USING btree ("family");--> statement-breakpoint
CREATE INDEX "idx_petronect_proposta_numero" ON "petronect_lic_propostas" USING btree ("numero");--> statement-breakpoint
CREATE INDEX "idx_petronect_proposta_cnpj" ON "petronect_lic_propostas" USING btree ("cnpj");--> statement-breakpoint
CREATE INDEX "idx_petronect_proposta_characteristic" ON "petronect_lic_propostas" USING btree ("characteristic");--> statement-breakpoint
CREATE INDEX "idx_petronect_resultado_cnpj" ON "petronect_lic_resultado" USING btree ("cnpj_vencedor");