CREATE TABLE "alertas_vencimento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documento_id" uuid NOT NULL,
	"tipo_alerta" text NOT NULL,
	"agendado_para" timestamp with time zone,
	"enviado_em" timestamp with time zone,
	"destinatarios" jsonb,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "circulares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"tipo" text DEFAULT 'MENSAGEM' NOT NULL,
	"autor" text,
	"mensagem" text,
	"data_publicacao" timestamp,
	"anexo_phio_objid" text,
	"anexo_descricao" text,
	"hash_conteudo" text,
	"dados_brutos" jsonb,
	"criado_em" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "consultas_certidoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documento_id" uuid NOT NULL,
	"fonte" text NOT NULL,
	"tentativa_em" timestamp with time zone DEFAULT now(),
	"sucesso" boolean DEFAULT false NOT NULL,
	"status_certidao" text,
	"validade_fim_nova" timestamp with time zone,
	"payload_resposta" jsonb,
	"erro" text
);
--> statement-breakpoint
CREATE TABLE "documentos_familias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documento_id" uuid NOT NULL,
	"familia_id" uuid NOT NULL,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "documentos_habilitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"categoria" text NOT NULL,
	"subcategoria" text NOT NULL,
	"titulo" text NOT NULL,
	"descricao" text,
	"nome_arquivo" text NOT NULL,
	"blob_url" text NOT NULL,
	"blob_key" text NOT NULL,
	"tamanho_bytes" integer,
	"content_type" text,
	"sha256" text,
	"numero_documento" text,
	"emitido_em" timestamp with time zone,
	"validade_fim" timestamp with time zone,
	"validade_indeterminada" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'VIGENTE' NOT NULL,
	"versao" integer DEFAULT 1 NOT NULL,
	"documento_anterior_id" uuid,
	"ocr_texto" text,
	"ocr_metadata" jsonb,
	"ocr_confianca" real,
	"tags" jsonb,
	"uploadado_por" uuid NOT NULL,
	"atualizado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "documentos_projetos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documento_id" uuid NOT NULL,
	"cliente_cnpj" text,
	"cliente_nome" text NOT NULL,
	"projeto_nome" text NOT NULL,
	"valor_contrato" numeric(18, 2),
	"periodo_inicio" timestamp with time zone,
	"periodo_fim" timestamp with time zone,
	"descricao_servico" text,
	"engenheiro_responsavel" text,
	"registro_crea" text,
	"numero_art" text,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "familias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo_crc" text NOT NULL,
	"codigo_normalizado" text NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"nivel" text DEFAULT 'FAMILIA' NOT NULL,
	"parent_id" uuid,
	"path" text,
	"cadastro_corporativo" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'ATIVA' NOT NULL,
	"validade_fim" timestamp with time zone,
	"criterios" jsonb,
	"tags" jsonb,
	"escopos_cobertos" jsonb,
	"observacoes" text,
	"deletado_em" timestamp with time zone,
	"criado_por" uuid,
	"atualizado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now(),
	CONSTRAINT "familias_codigo_crc_unique" UNIQUE("codigo_crc")
);
--> statement-breakpoint
CREATE TABLE "familias_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"familia_id" uuid NOT NULL,
	"codigo_alternativo" text NOT NULL,
	"codigo_alternativo_normalizado" text NOT NULL,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "familias_anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"familia_id" uuid NOT NULL,
	"tipo" text DEFAULT 'OUTRO' NOT NULL,
	"nome_arquivo" text NOT NULL,
	"blob_url" text NOT NULL,
	"blob_key" text NOT NULL,
	"tamanho_bytes" integer,
	"content_type" text,
	"validade_fim" timestamp with time zone,
	"uploadado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "licitacoes_familias_match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"total_itens" integer DEFAULT 0 NOT NULL,
	"itens_cobertos" integer DEFAULT 0 NOT NULL,
	"score_aderencia" real DEFAULT 0 NOT NULL,
	"familias_usadas" jsonb,
	"familias_faltantes" jsonb,
	"calculado_em" timestamp with time zone DEFAULT now(),
	CONSTRAINT "licitacoes_familias_match_licitacao_id_unique" UNIQUE("licitacao_id")
);
--> statement-breakpoint
ALTER TABLE "alertas_vencimento" ADD CONSTRAINT "alertas_vencimento_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circulares" ADD CONSTRAINT "circulares_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultas_certidoes" ADD CONSTRAINT "consultas_certidoes_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_familias" ADD CONSTRAINT "documentos_familias_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_familias" ADD CONSTRAINT "documentos_familias_familia_id_familias_id_fk" FOREIGN KEY ("familia_id") REFERENCES "public"."familias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_habilitacao" ADD CONSTRAINT "documentos_habilitacao_documento_anterior_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_anterior_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_habilitacao" ADD CONSTRAINT "documentos_habilitacao_uploadado_por_users_id_fk" FOREIGN KEY ("uploadado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_habilitacao" ADD CONSTRAINT "documentos_habilitacao_atualizado_por_users_id_fk" FOREIGN KEY ("atualizado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos_projetos" ADD CONSTRAINT "documentos_projetos_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias" ADD CONSTRAINT "familias_parent_id_familias_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."familias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias" ADD CONSTRAINT "familias_criado_por_users_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias" ADD CONSTRAINT "familias_atualizado_por_users_id_fk" FOREIGN KEY ("atualizado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias_aliases" ADD CONSTRAINT "familias_aliases_familia_id_familias_id_fk" FOREIGN KEY ("familia_id") REFERENCES "public"."familias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias_anexos" ADD CONSTRAINT "familias_anexos_familia_id_familias_id_fk" FOREIGN KEY ("familia_id") REFERENCES "public"."familias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "familias_anexos" ADD CONSTRAINT "familias_anexos_uploadado_por_users_id_fk" FOREIGN KEY ("uploadado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licitacoes_familias_match" ADD CONSTRAINT "licitacoes_familias_match_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alerta_doc" ON "alertas_vencimento" USING btree ("documento_id");--> statement-breakpoint
CREATE INDEX "idx_alerta_unique" ON "alertas_vencimento" USING btree ("documento_id","tipo_alerta");--> statement-breakpoint
CREATE INDEX "idx_alerta_agendado" ON "alertas_vencimento" USING btree ("agendado_para");--> statement-breakpoint
CREATE INDEX "idx_circ_lic" ON "circulares" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_circ_tipo" ON "circulares" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "idx_circ_data" ON "circulares" USING btree ("data_publicacao");--> statement-breakpoint
CREATE INDEX "idx_circ_hash" ON "circulares" USING btree ("hash_conteudo");--> statement-breakpoint
CREATE INDEX "idx_consc_doc" ON "consultas_certidoes" USING btree ("documento_id");--> statement-breakpoint
CREATE INDEX "idx_consc_fonte" ON "consultas_certidoes" USING btree ("fonte");--> statement-breakpoint
CREATE INDEX "idx_consc_data" ON "consultas_certidoes" USING btree ("tentativa_em");--> statement-breakpoint
CREATE INDEX "idx_docfam_doc" ON "documentos_familias" USING btree ("documento_id");--> statement-breakpoint
CREATE INDEX "idx_docfam_familia" ON "documentos_familias" USING btree ("familia_id");--> statement-breakpoint
CREATE INDEX "idx_docfam_unique" ON "documentos_familias" USING btree ("documento_id","familia_id");--> statement-breakpoint
CREATE INDEX "idx_doch_categoria" ON "documentos_habilitacao" USING btree ("categoria");--> statement-breakpoint
CREATE INDEX "idx_doch_subcategoria" ON "documentos_habilitacao" USING btree ("subcategoria");--> statement-breakpoint
CREATE INDEX "idx_doch_status" ON "documentos_habilitacao" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_doch_validade" ON "documentos_habilitacao" USING btree ("validade_fim");--> statement-breakpoint
CREATE INDEX "idx_doch_cat_status" ON "documentos_habilitacao" USING btree ("categoria","status");--> statement-breakpoint
CREATE INDEX "idx_doch_sha" ON "documentos_habilitacao" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "idx_docproj_doc" ON "documentos_projetos" USING btree ("documento_id");--> statement-breakpoint
CREATE INDEX "idx_docproj_cnpj" ON "documentos_projetos" USING btree ("cliente_cnpj");--> statement-breakpoint
CREATE INDEX "idx_fam_codigo_norm" ON "familias" USING btree ("codigo_normalizado");--> statement-breakpoint
CREATE INDEX "idx_fam_status" ON "familias" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fam_validade" ON "familias" USING btree ("validade_fim");--> statement-breakpoint
CREATE INDEX "idx_fam_parent" ON "familias" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_fam_path" ON "familias" USING btree ("path");--> statement-breakpoint
CREATE INDEX "idx_fam_deletado" ON "familias" USING btree ("deletado_em");--> statement-breakpoint
CREATE INDEX "idx_fam_alias_familia" ON "familias_aliases" USING btree ("familia_id");--> statement-breakpoint
CREATE INDEX "idx_fam_alias_codigo" ON "familias_aliases" USING btree ("codigo_alternativo_normalizado");--> statement-breakpoint
CREATE INDEX "idx_fam_anexo_familia" ON "familias_anexos" USING btree ("familia_id");--> statement-breakpoint
CREATE INDEX "idx_fam_anexo_tipo" ON "familias_anexos" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "idx_lfm_licitacao" ON "licitacoes_familias_match" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_lfm_score" ON "licitacoes_familias_match" USING btree ("score_aderencia");