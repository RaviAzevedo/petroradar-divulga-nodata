CREATE TABLE "analises_ia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"resumo" text,
	"objeto_detalhado" text,
	"checklist" jsonb,
	"requisitos" jsonb,
	"criterios_habilitacao" jsonb,
	"criterios_julgamento" text,
	"valor_estimado" text,
	"prazos" jsonb,
	"riscos" jsonb,
	"recomendacao" text,
	"modelo_usado" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"custo_estimado" real,
	"tempo_segundos" real,
	"resposta_raw" text,
	"analisado_em" timestamp DEFAULT now(),
	CONSTRAINT "analises_ia_licitacao_id_unique" UNIQUE("licitacao_id")
);
--> statement-breakpoint
CREATE TABLE "anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"descricao" text,
	"phio_objid" text,
	"s3_key" text,
	"tamanho_bytes" integer,
	"content_type" text,
	"texto_cache" text,
	"baixado_em" timestamp,
	"erro_download" text,
	"criado_em" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"acao" text NOT NULL,
	"entidade" text,
	"entidade_id" text,
	"detalhes" jsonb,
	"criado_em" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "historico_alteracoes" (
	"id" serial PRIMARY KEY NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"campo" text NOT NULL,
	"valor_anterior" text,
	"valor_novo" text,
	"detectado_em" timestamp DEFAULT now(),
	"notificado" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"item_numero" text,
	"exlin" text,
	"descricao" text,
	"material" text,
	"familia" text,
	"familia_descricao" text,
	"familia_classif" text,
	"quantidade" real,
	"unidade" text,
	"data_entrega" text,
	"tipo_processo" text,
	"nivel_agrupamento" text,
	"notas" text,
	"dados_brutos" jsonb,
	"criado_em" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "licitacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"objeto" text,
	"objeto_resumido" text,
	"empresa" text,
	"empresa_codigo" text,
	"status_code" text,
	"status" text,
	"sub_status" text,
	"fase" text,
	"modalidade" text,
	"tipo_oportunidade" text,
	"abrangencia" text,
	"data_inicio" text,
	"hora_inicio" text,
	"data_fim" text,
	"hora_fim" text,
	"data_publicacao" text,
	"data_abertura" text,
	"hora_abertura" text,
	"data_disputa" text,
	"hora_disputa" text,
	"posting_date" text,
	"dou_num" text,
	"regioes" text,
	"limite_dias" integer,
	"equalizada" text,
	"pre_qualificada" text,
	"natureza" text,
	"tipo_servico" text,
	"segmento" text,
	"relevancia" text,
	"score_interesse" integer,
	"perfis_match" text,
	"melhor_perfil" text,
	"dados_completos" jsonb,
	"criado_em" timestamp DEFAULT now(),
	"atualizado_em" timestamp DEFAULT now(),
	CONSTRAINT "licitacoes_numero_unique" UNIQUE("numero")
);
--> statement-breakpoint
CREATE TABLE "participacoes_documentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participacao_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"nome_arquivo" text NOT NULL,
	"blob_url" text NOT NULL,
	"blob_key" text NOT NULL,
	"tamanho_bytes" integer,
	"content_type" text,
	"valor_proposta" numeric(15, 2),
	"uploadado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "participacoes_historico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participacao_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"acao" text NOT NULL,
	"dados_anteriores" jsonb,
	"dados_novos" jsonb,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "participacoes_licitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero_edital" text NOT NULL,
	"empresa_contratante" text NOT NULL,
	"objeto" text NOT NULL,
	"url_portal" text,
	"licitacao_petro_radar_id" uuid,
	"prazo_portal" timestamp with time zone NOT NULL,
	"prazo_interno" timestamp with time zone,
	"fase" text DEFAULT 'PROSPECCAO' NOT NULL,
	"resultado" text,
	"proposto_por" uuid NOT NULL,
	"lider_id" uuid,
	"responsavel_tecnico" uuid,
	"responsavel_orcamento" uuid,
	"editando_por" uuid,
	"editando_desde" timestamp with time zone,
	"versao" integer DEFAULT 0 NOT NULL,
	"valor_proposta" numeric(15, 2),
	"observacoes" text,
	"deletado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "participacoes_notificacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participacao_id" uuid,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"titulo" text NOT NULL,
	"mensagem" text NOT NULL,
	"lida" boolean DEFAULT false NOT NULL,
	"email_enviado" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "participacoes_prazos_extensao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participacao_id" uuid NOT NULL,
	"solicitado_por" uuid NOT NULL,
	"novo_prazo" timestamp with time zone NOT NULL,
	"motivo" text NOT NULL,
	"status" text DEFAULT 'PENDENTE' NOT NULL,
	"decidido_por" uuid,
	"decidido_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "perfis_interesse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"ativo" boolean DEFAULT true,
	"filtros" jsonb NOT NULL,
	"criado_em" timestamp DEFAULT now(),
	"atualizado_em" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" text NOT NULL,
	"total_encontradas" integer DEFAULT 0,
	"novas" integer DEFAULT 0,
	"atualizadas" integer DEFAULT 0,
	"erros" integer DEFAULT 0,
	"detalhes" text,
	"executado_em" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"nome" text,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'VISUALIZADOR' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "analises_ia" ADD CONSTRAINT "analises_ia_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anexos" ADD CONSTRAINT "anexos_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historico_alteracoes" ADD CONSTRAINT "historico_alteracoes_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens" ADD CONSTRAINT "itens_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_documentos" ADD CONSTRAINT "participacoes_documentos_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_documentos" ADD CONSTRAINT "participacoes_documentos_uploadado_por_users_id_fk" FOREIGN KEY ("uploadado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_historico" ADD CONSTRAINT "participacoes_historico_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_historico" ADD CONSTRAINT "participacoes_historico_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_licitacao_petro_radar_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_petro_radar_id") REFERENCES "public"."licitacoes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_proposto_por_users_id_fk" FOREIGN KEY ("proposto_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_lider_id_users_id_fk" FOREIGN KEY ("lider_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_responsavel_tecnico_users_id_fk" FOREIGN KEY ("responsavel_tecnico") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_responsavel_orcamento_users_id_fk" FOREIGN KEY ("responsavel_orcamento") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_licitacao" ADD CONSTRAINT "participacoes_licitacao_editando_por_users_id_fk" FOREIGN KEY ("editando_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_notificacoes" ADD CONSTRAINT "participacoes_notificacoes_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_notificacoes" ADD CONSTRAINT "participacoes_notificacoes_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_prazos_extensao" ADD CONSTRAINT "participacoes_prazos_extensao_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_prazos_extensao" ADD CONSTRAINT "participacoes_prazos_extensao_solicitado_por_users_id_fk" FOREIGN KEY ("solicitado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participacoes_prazos_extensao" ADD CONSTRAINT "participacoes_prazos_extensao_decidido_por_users_id_fk" FOREIGN KEY ("decidido_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_anexos_lic" ON "anexos" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_audit_user" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_hist_lic" ON "historico_alteracoes" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_itens_lic" ON "itens" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_lic_relevancia" ON "licitacoes" USING btree ("relevancia");--> statement-breakpoint
CREATE INDEX "idx_lic_fase" ON "licitacoes" USING btree ("fase");--> statement-breakpoint
CREATE INDEX "idx_lic_data_fim" ON "licitacoes" USING btree ("data_fim");--> statement-breakpoint
CREATE INDEX "idx_lic_empresa" ON "licitacoes" USING btree ("empresa");--> statement-breakpoint
CREATE INDEX "idx_docs_part" ON "participacoes_documentos" USING btree ("participacao_id");--> statement-breakpoint
CREATE INDEX "idx_docs_tipo" ON "participacoes_documentos" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "idx_hist_part_id" ON "participacoes_historico" USING btree ("participacao_id");--> statement-breakpoint
CREATE INDEX "idx_hist_part_usuario" ON "participacoes_historico" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "idx_hist_part_acao" ON "participacoes_historico" USING btree ("acao");--> statement-breakpoint
CREATE INDEX "idx_part_fase" ON "participacoes_licitacao" USING btree ("fase");--> statement-breakpoint
CREATE INDEX "idx_part_prazo_portal" ON "participacoes_licitacao" USING btree ("prazo_portal");--> statement-breakpoint
CREATE INDEX "idx_part_prazo_interno" ON "participacoes_licitacao" USING btree ("prazo_interno");--> statement-breakpoint
CREATE INDEX "idx_part_proposto_por" ON "participacoes_licitacao" USING btree ("proposto_por");--> statement-breakpoint
CREATE INDEX "idx_part_resp_tec" ON "participacoes_licitacao" USING btree ("responsavel_tecnico");--> statement-breakpoint
CREATE INDEX "idx_part_resp_orc" ON "participacoes_licitacao" USING btree ("responsavel_orcamento");--> statement-breakpoint
CREATE INDEX "idx_part_lider" ON "participacoes_licitacao" USING btree ("lider_id");--> statement-breakpoint
CREATE INDEX "idx_notif_usuario" ON "participacoes_notificacoes" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "idx_notif_lida" ON "participacoes_notificacoes" USING btree ("lida");--> statement-breakpoint
CREATE INDEX "idx_notif_part" ON "participacoes_notificacoes" USING btree ("participacao_id");--> statement-breakpoint
CREATE INDEX "idx_notif_criado" ON "participacoes_notificacoes" USING btree ("criado_em");--> statement-breakpoint
CREATE INDEX "idx_notif_usuario_lida" ON "participacoes_notificacoes" USING btree ("usuario_id","lida");--> statement-breakpoint
CREATE INDEX "idx_notif_email_lida" ON "participacoes_notificacoes" USING btree ("email_enviado","lida");--> statement-breakpoint
CREATE INDEX "idx_ext_part" ON "participacoes_prazos_extensao" USING btree ("participacao_id");--> statement-breakpoint
CREATE INDEX "idx_ext_status" ON "participacoes_prazos_extensao" USING btree ("status");