CREATE TABLE "cnpj_status_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cnpj" text NOT NULL,
	"situacao" text NOT NULL,
	"motivo_situacao" text,
	"razao_social" text,
	"ultima_atualizacao" timestamp with time zone,
	"fonte" text DEFAULT 'BrasilAPI' NOT NULL,
	"dados_brutos" jsonb,
	"mudou" boolean DEFAULT false NOT NULL,
	"alertado" boolean DEFAULT false NOT NULL,
	"checado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contratos_execucao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"edital_numero" text,
	"participacao_id" uuid,
	"envelope_id" uuid,
	"objeto" text NOT NULL,
	"empresa_contratante" text DEFAULT 'Petrobras' NOT NULL,
	"periodo_inicio" timestamp with time zone NOT NULL,
	"periodo_fim" timestamp with time zone NOT NULL,
	"valor_contratado" numeric(18, 2),
	"status" text DEFAULT 'ATIVO' NOT NULL,
	"status_saude" text DEFAULT 'OK' NOT NULL,
	"iqf_atual" real,
	"documentos_obrigatorios" jsonb,
	"responsavel_sgi" uuid,
	"observacoes" text,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contratos_execucao_numero_unique" UNIQUE("numero")
);
--> statement-breakpoint
CREATE TABLE "envelope_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"requisito_id" uuid NOT NULL,
	"documento_id" uuid,
	"status" text DEFAULT 'PENDENTE' NOT NULL,
	"score_sugestao" real,
	"observacao" text,
	"atribuido_por" uuid,
	"atribuido_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "envelopes_habilitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participacao_id" uuid NOT NULL,
	"status" text DEFAULT 'EM_MONTAGEM' NOT NULL,
	"prazo_protocolo" timestamp with time zone,
	"contrato_numero" text,
	"contrato_assinado_em" timestamp with time zone,
	"responsavel_sgi" uuid,
	"observacoes" text,
	"motivo_rejeicao" text,
	"protocolado_em" timestamp with time zone,
	"decidido_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now(),
	CONSTRAINT "envelopes_habilitacao_participacao_id_unique" UNIQUE("participacao_id")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fonte" text NOT NULL,
	"iniciado_por" uuid,
	"status" text DEFAULT 'EM_ANDAMENTO' NOT NULL,
	"total_arquivos" integer DEFAULT 0 NOT NULL,
	"processados" integer DEFAULT 0 NOT NULL,
	"novos" integer DEFAULT 0 NOT NULL,
	"atualizados" integer DEFAULT 0 NOT NULL,
	"ignorados" integer DEFAULT 0 NOT NULL,
	"erros" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"observacao" text,
	"iniciado_em" timestamp with time zone DEFAULT now(),
	"finalizado_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "iqf_avaliacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contrato_id" uuid NOT NULL,
	"periodo_ref" text NOT NULL,
	"indice" real NOT NULL,
	"classificacao" text,
	"observacoes" text,
	"blob_url" text,
	"blob_key" text,
	"registrado_por" uuid,
	"registrado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "requisitos_edital" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"codigo" text NOT NULL,
	"descricao" text NOT NULL,
	"obrigatorio" boolean DEFAULT true NOT NULL,
	"fonte" text DEFAULT 'ANALISE_IA' NOT NULL,
	"observacao" text,
	"ordem" integer DEFAULT 0 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "familias" ADD COLUMN "segmento_petrobras" text;--> statement-breakpoint
ALTER TABLE "familias" ADD COLUMN "status_fluxo_crc" text;--> statement-breakpoint
ALTER TABLE "familias" ADD COLUMN "proxima_renovacao_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contratos_execucao" ADD CONSTRAINT "contratos_execucao_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contratos_execucao" ADD CONSTRAINT "contratos_execucao_envelope_id_envelopes_habilitacao_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes_habilitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contratos_execucao" ADD CONSTRAINT "contratos_execucao_responsavel_sgi_users_id_fk" FOREIGN KEY ("responsavel_sgi") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_itens" ADD CONSTRAINT "envelope_itens_envelope_id_envelopes_habilitacao_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."envelopes_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_itens" ADD CONSTRAINT "envelope_itens_requisito_id_requisitos_edital_id_fk" FOREIGN KEY ("requisito_id") REFERENCES "public"."requisitos_edital"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_itens" ADD CONSTRAINT "envelope_itens_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelope_itens" ADD CONSTRAINT "envelope_itens_atribuido_por_users_id_fk" FOREIGN KEY ("atribuido_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD CONSTRAINT "envelopes_habilitacao_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes_habilitacao" ADD CONSTRAINT "envelopes_habilitacao_responsavel_sgi_users_id_fk" FOREIGN KEY ("responsavel_sgi") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_iniciado_por_users_id_fk" FOREIGN KEY ("iniciado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_avaliacoes" ADD CONSTRAINT "iqf_avaliacoes_contrato_id_contratos_execucao_id_fk" FOREIGN KEY ("contrato_id") REFERENCES "public"."contratos_execucao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iqf_avaliacoes" ADD CONSTRAINT "iqf_avaliacoes_registrado_por_users_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitos_edital" ADD CONSTRAINT "requisitos_edital_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cnpj_log_cnpj" ON "cnpj_status_log" USING btree ("cnpj");--> statement-breakpoint
CREATE INDEX "idx_cnpj_log_data" ON "cnpj_status_log" USING btree ("checado_em");--> statement-breakpoint
CREATE INDEX "idx_cnpj_log_mudou" ON "cnpj_status_log" USING btree ("mudou");--> statement-breakpoint
CREATE INDEX "idx_contrato_numero" ON "contratos_execucao" USING btree ("numero");--> statement-breakpoint
CREATE INDEX "idx_contrato_status" ON "contratos_execucao" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_contrato_saude" ON "contratos_execucao" USING btree ("status_saude");--> statement-breakpoint
CREATE INDEX "idx_contrato_periodo_fim" ON "contratos_execucao" USING btree ("periodo_fim");--> statement-breakpoint
CREATE INDEX "idx_contrato_resp" ON "contratos_execucao" USING btree ("responsavel_sgi");--> statement-breakpoint
CREATE INDEX "idx_env_item_env" ON "envelope_itens" USING btree ("envelope_id");--> statement-breakpoint
CREATE INDEX "idx_env_item_req" ON "envelope_itens" USING btree ("requisito_id");--> statement-breakpoint
CREATE INDEX "idx_env_item_doc" ON "envelope_itens" USING btree ("documento_id");--> statement-breakpoint
CREATE INDEX "idx_env_item_status" ON "envelope_itens" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_env_status" ON "envelopes_habilitacao" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_env_prazo" ON "envelopes_habilitacao" USING btree ("prazo_protocolo");--> statement-breakpoint
CREATE INDEX "idx_env_resp" ON "envelopes_habilitacao" USING btree ("responsavel_sgi");--> statement-breakpoint
CREATE INDEX "idx_env_contrato" ON "envelopes_habilitacao" USING btree ("contrato_numero");--> statement-breakpoint
CREATE INDEX "idx_import_status" ON "import_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_import_iniciado" ON "import_jobs" USING btree ("iniciado_em");--> statement-breakpoint
CREATE INDEX "idx_import_user" ON "import_jobs" USING btree ("iniciado_por");--> statement-breakpoint
CREATE INDEX "idx_iqf_contrato" ON "iqf_avaliacoes" USING btree ("contrato_id");--> statement-breakpoint
CREATE INDEX "idx_iqf_periodo" ON "iqf_avaliacoes" USING btree ("periodo_ref");--> statement-breakpoint
CREATE INDEX "idx_req_lic" ON "requisitos_edital" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_req_codigo" ON "requisitos_edital" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "idx_fam_segmento" ON "familias" USING btree ("segmento_petrobras");--> statement-breakpoint
CREATE INDEX "idx_fam_status_fluxo" ON "familias" USING btree ("status_fluxo_crc");--> statement-breakpoint
CREATE INDEX "idx_fam_renovacao" ON "familias" USING btree ("proxima_renovacao_em");