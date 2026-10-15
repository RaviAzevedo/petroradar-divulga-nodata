-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0013 — Consolidação das 25 features novas do Petro Radar
-- (petitórios, gap de habilitação, impacto de circulares, RAG/pgvector,
--  API pública v1 + webhooks HMAC, Web Push) + colunas de IA/dedup.
-- Consolida o que os specs pediam em 0014–0018 numa única migration (a base
-- já estava em 0012; numerar 0014+ colidiria).
-- ════════════════════════════════════════════════════════════════════════════

-- ── pgvector: pré-requisito de acervo_chunks.embedding ──────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

-- ── NOVAS TABELAS ───────────────────────────────────────────────────────────
CREATE TABLE "petitorios_licitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"participacao_id" uuid,
	"tipo" text NOT NULL,
	"status" text DEFAULT 'RASCUNHO' NOT NULL,
	"prazo_limite" timestamp with time zone,
	"protocolado_em" timestamp with time zone,
	"fundamentacao" text,
	"blob_key" text,
	"blob_url" text,
	"resposta" text,
	"autor_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now(),
	"atualizado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "petitorios_historico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"petitorio_id" uuid NOT NULL,
	"acao" text NOT NULL,
	"detalhes" jsonb,
	"usuario_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "gap_habilitacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"requisito_id" uuid,
	"requisito_codigo" text,
	"status_cobertura" text NOT NULL,
	"documento_id" uuid,
	"familia_id" uuid,
	"vence_em" timestamp with time zone,
	"metodo_match" text,
	"confianca" real,
	"justificativa" text,
	"calculado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "circulares_impacto" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"circular_id" uuid NOT NULL,
	"licitacao_id" uuid NOT NULL,
	"impacto" text NOT NULL,
	"resumo" text,
	"requisitos_novos" jsonb,
	"acao_recomendada" text,
	"reorcamento_sugerido" boolean DEFAULT false NOT NULL,
	"modelo_usado" text,
	"avaliado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "acervo_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origem_tipo" text NOT NULL,
	"origem_id" uuid NOT NULL,
	"licitacao_id" uuid,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"texto" text NOT NULL,
	"embedding" vector(1536),
	"metadata" jsonb,
	"indexado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "acervo_index_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origem_tipo" text NOT NULL,
	"origem_id" uuid NOT NULL,
	"texto_hash" text NOT NULL,
	"modelo_embedding" text NOT NULL,
	"chunks_gerados" integer DEFAULT 0 NOT NULL,
	"indexado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prefixo" text NOT NULL,
	"key_hash" text NOT NULL,
	"escopos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"nome" text NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_uso_em" timestamp with time zone,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now(),
	"revogado_em" timestamp with time zone,
	CONSTRAINT "api_keys_prefixo_unique" UNIQUE("prefixo")
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"secret_hmac" text NOT NULL,
	"eventos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filtro_perfil" jsonb,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultima_entrega_em" timestamp with time zone,
	"ultimo_status_http" integer,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"ultimo_envio_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- ── ALTERS EM TABELAS EXISTENTES ────────────────────────────────────────────
ALTER TABLE "circulares" ADD COLUMN "notificado_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "circulares" ADD COLUMN "impacto_ia" text;--> statement-breakpoint
ALTER TABLE "analises_ia" ADD COLUMN "erro_parse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "analises_ia" ADD COLUMN "schema_versao" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "analises_ia" ADD COLUMN "prob_vitoria" real;--> statement-breakpoint
ALTER TABLE "analises_ia" ADD COLUMN "prob_vitoria_fatores" jsonb;--> statement-breakpoint
ALTER TABLE "analises_ia" ADD COLUMN "prob_vitoria_calculada_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "licitacao_eventos_vencedor" ADD COLUMN "convocacao_notificada_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requisitos_edital" ADD COLUMN "anexo_id" uuid;--> statement-breakpoint
ALTER TABLE "requisitos_edital" ADD COLUMN "trecho_citado" text;--> statement-breakpoint
ALTER TABLE "requisitos_edital" ADD COLUMN "confianca" real;--> statement-breakpoint
ALTER TABLE "licitacoes" ADD COLUMN "classificacao_ia" jsonb;--> statement-breakpoint
ALTER TABLE "licitacoes" ADD COLUMN "classificado_ia_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "licitacoes" ADD COLUMN "notificado_perfil_em" timestamp with time zone;--> statement-breakpoint

-- ── FOREIGN KEYS ────────────────────────────────────────────────────────────
ALTER TABLE "petitorios_licitacao" ADD CONSTRAINT "petitorios_licitacao_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitorios_licitacao" ADD CONSTRAINT "petitorios_licitacao_participacao_id_participacoes_licitacao_id_fk" FOREIGN KEY ("participacao_id") REFERENCES "public"."participacoes_licitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitorios_licitacao" ADD CONSTRAINT "petitorios_licitacao_autor_id_users_id_fk" FOREIGN KEY ("autor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitorios_historico" ADD CONSTRAINT "petitorios_historico_petitorio_id_petitorios_licitacao_id_fk" FOREIGN KEY ("petitorio_id") REFERENCES "public"."petitorios_licitacao"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitorios_historico" ADD CONSTRAINT "petitorios_historico_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_habilitacao" ADD CONSTRAINT "gap_habilitacao_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_habilitacao" ADD CONSTRAINT "gap_habilitacao_requisito_id_requisitos_edital_id_fk" FOREIGN KEY ("requisito_id") REFERENCES "public"."requisitos_edital"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_habilitacao" ADD CONSTRAINT "gap_habilitacao_documento_id_documentos_habilitacao_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documentos_habilitacao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_habilitacao" ADD CONSTRAINT "gap_habilitacao_familia_id_familias_id_fk" FOREIGN KEY ("familia_id") REFERENCES "public"."familias"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circulares_impacto" ADD CONSTRAINT "circulares_impacto_circular_id_circulares_id_fk" FOREIGN KEY ("circular_id") REFERENCES "public"."circulares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circulares_impacto" ADD CONSTRAINT "circulares_impacto_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acervo_chunks" ADD CONSTRAINT "acervo_chunks_licitacao_id_licitacoes_id_fk" FOREIGN KEY ("licitacao_id") REFERENCES "public"."licitacoes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_criado_por_users_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitos_edital" ADD CONSTRAINT "requisitos_edital_anexo_id_anexos_id_fk" FOREIGN KEY ("anexo_id") REFERENCES "public"."anexos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── INDEXES ─────────────────────────────────────────────────────────────────
CREATE INDEX "idx_petit_lic" ON "petitorios_licitacao" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_petit_part" ON "petitorios_licitacao" USING btree ("participacao_id");--> statement-breakpoint
CREATE INDEX "idx_petit_status" ON "petitorios_licitacao" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_petit_prazo" ON "petitorios_licitacao" USING btree ("prazo_limite");--> statement-breakpoint
CREATE INDEX "idx_petit_hist_petit" ON "petitorios_historico" USING btree ("petitorio_id");--> statement-breakpoint
CREATE INDEX "idx_gaphab_lic" ON "gap_habilitacao" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_gaphab_req" ON "gap_habilitacao" USING btree ("requisito_id");--> statement-breakpoint
CREATE INDEX "idx_gaphab_status" ON "gap_habilitacao" USING btree ("status_cobertura");--> statement-breakpoint
CREATE INDEX "idx_circimp_lic" ON "circulares_impacto" USING btree ("licitacao_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_circimp_circular" ON "circulares_impacto" USING btree ("circular_id");--> statement-breakpoint
CREATE INDEX "idx_acervo_origem" ON "acervo_chunks" USING btree ("origem_tipo","origem_id");--> statement-breakpoint
CREATE INDEX "idx_acervo_lic" ON "acervo_chunks" USING btree ("licitacao_id");--> statement-breakpoint
CREATE INDEX "idx_acervo_embedding" ON "acervo_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acervo_log" ON "acervo_index_log" USING btree ("origem_tipo","origem_id","modelo_embedding");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_apikey_prefixo" ON "api_keys" USING btree ("prefixo");--> statement-breakpoint
CREATE INDEX "idx_apikey_ativo" ON "api_keys" USING btree ("ativo");--> statement-breakpoint
CREATE INDEX "idx_websub_ativo" ON "webhook_subscriptions" USING btree ("ativo");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_push_endpoint" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "idx_push_user" ON "push_subscriptions" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "idx_req_anexo" ON "requisitos_edital" USING btree ("anexo_id");
