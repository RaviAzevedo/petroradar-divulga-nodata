import {
  pgTable, text, integer, timestamp, uuid, jsonb, index, uniqueIndex, serial, boolean, real, numeric,
  primaryKey,
  date,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { UserRole } from "@/lib/permissions";
import type { TipoEmail } from "@/lib/email/tipos";

// ── PGVECTOR (extensão `vector` no Neon) ────────────────────────────────────
// drizzle-orm não tem tipo `vector` nativo; definimos via customType.
// Representamos o embedding como number[] no lado TS e serializamos no formato
// textual aceito pelo pgvector ("[0.1,0.2,...]"). A extensão é criada na
// migration 0013 (CREATE EXTENSION IF NOT EXISTS vector) ANTES de acervo_chunks.
export const vector = (name: string, opts: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
    dataType(config) {
      return `vector(${config?.dimensions ?? opts.dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .filter((s) => s.length > 0)
        .map((s) => Number(s));
    },
  })(name, opts);

// ── TIPOS DO MÓDULO DE PARTICIPAÇÕES ────────────────────────────────────────

export type FaseParticipacao =
  | "PROSPECCAO"   // proposta cadastrada, aguardando aprovação do líder
  | "APROVADA"     // líder aprovou, equipe designada
  | "ELABORACAO"   // documentos sendo preparados
  | "ENVIADA"      // proposta submetida ao portal Petronect
  | "RESULTADO"    // resultado registrado (ganhou/perdeu/cancelada)
  | "REJEITADA"    // líder rejeitou a proposta
  | "CANCELADA";   // cancelada internamente após aprovação

export type ResultadoParticipacao = "GANHOU" | "PERDEU" | "CANCELADA";

export type TipoDocumentoParticipacao = "DFP" | "PPU" | "OUTRO";

export type StatusExtensao = "PENDENTE" | "APROVADO" | "NEGADO";

export type TipoNotificacaoParticipacao =
  | "PRAZO_PORTAL"           // 1 dia antes do prazo do portal
  | "PRAZO_INTERNO"          // 2 dias antes do prazo interno
  | "FASE_ALTERADA"
  | "DOCUMENTO_ENVIADO"
  | "APROVACAO"
  | "REJEICAO"
  | "CANCELAMENTO"
  | "RESULTADO"
  | "EXTENSAO_SOLICITADA"
  | "EXTENSAO_DECIDIDA"
  | "CIRCULAR_PUBLICADA";

export type AcaoHistoricoParticipacao =
  | "CRIADA"
  | "APROVADA"
  | "REJEITADA"
  | "ELABORACAO_INICIADA"
  | "DOCUMENTO_ENVIADO"
  | "DOCUMENTO_REMOVIDO"
  | "ENVIADA_PORTAL"
  | "RESULTADO_REGISTRADO"
  | "CANCELADA"
  | "CAMPO_EDITADO"
  | "RESPONSAVEL_ALTERADO"
  | "PRAZO_ALTERADO"
  | "EXTENSAO_SOLICITADA"
  | "EXTENSAO_APROVADA"
  | "EXTENSAO_NEGADA"
  | "LOCK_ADQUIRIDO"
  | "LOCK_LIBERADO";

// ── USERS ──
// Roles: ADMIN | LIDER | ORCAMENTISTA | TECNICO | VISUALIZADOR | EXTERNO
// Migração: admin→ADMIN  editor→LIDER  viewer→VISUALIZADOR
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  nome: text("nome"),
  // NULL para usuários só-SSO (Entra ID); preenchido apenas no break-glass (0025).
  passwordHash: text("password_hash"),
  role: text("role").$type<UserRole>().notNull().default("VISUALIZADOR"),
  ativo: boolean("ativo").notNull().default(true),
  // Claim `oid` do Entra ID — identidade imutável no tenant; e-mail pode mudar,
  // oid não. Match primário do login SSO (0025).
  entraOid: text("entra_oid").unique(),
  // Fila de aprovação SSO: autenticou no tenant mas aguarda liberação do ADMIN
  // (ativo=false + pendente=true). Aprovar → ativo=true/pendente=false (0025).
  pendente: boolean("pendente").notNull().default(false),
  ultimoLogin: timestamp("ultimo_login", { withTimezone: true }),
  // Quando o soft-delete ocorreu (ativo=false); NULL enquanto ativo ou ao reativar.
  desativadoEm: timestamp("desativado_em", { withTimezone: true }),
  criadoEm: timestamp("criado_em").defaultNow(),
});
// NOTA (0017): CHECK users_role_check garante role ∈ 7 papéis canônicos no banco
// (Drizzle não modela CHECK aqui; criado na migration).

// ── LICITACOES ──
export const licitacoes = pgTable("licitacoes", {
  id: uuid("id").primaryKey().defaultRandom(),
  numero: text("numero").notNull().unique(),
  // Origem: 'petronect' (scraper nativo, default) | 'transparencia' (descoberta
  // no Portal da Transparência e ingerida — dados finos). Migration 0024.
  fonte: text("fonte").notNull().default("petronect"),
  objeto: text("objeto"),
  objetoResumido: text("objeto_resumido"),
  empresa: text("empresa"),
  empresaCodigo: text("empresa_codigo"),
  statusCode: text("status_code"),
  status: text("status"),
  subStatus: text("sub_status"),
  fase: text("fase"),
  modalidade: text("modalidade"),
  tipoOportunidade: text("tipo_oportunidade"),
  abrangencia: text("abrangencia"),
  dataInicio: text("data_inicio"),
  horaInicio: text("hora_inicio"),
  dataFim: text("data_fim"),
  horaFim: text("hora_fim"),
  dataPublicacao: text("data_publicacao"),
  dataAbertura: text("data_abertura"),
  horaAbertura: text("hora_abertura"),
  dataDisputa: text("data_disputa"),
  horaDisputa: text("hora_disputa"),
  postingDate: text("posting_date"),
  douNum: text("dou_num"),
  regioes: text("regioes"),
  limiteDias: integer("limite_dias"),
  equalizada: text("equalizada"),
  preQualificada: text("pre_qualificada"),
  // Classificacao
  natureza: text("natureza"),
  tipoServico: text("tipo_servico"),
  segmento: text("segmento"),
  relevancia: text("relevancia"),
  scoreInteresse: integer("score_interesse"),
  perfisMatch: text("perfis_match"),
  melhorPerfil: text("melhor_perfil"),
  // Triagem semântica do feed (Haiku) — {score,segmento,aderencia,justificativa,perfil_sugerido}
  classificacaoIa:   jsonb("classificacao_ia"),
  classificadoIaEm:  timestamp("classificado_ia_em", { withTimezone: true }),
  // Dedup do cron oportunidades-novas (idx_lic_score já existe)
  notificadoPerfilEm: timestamp("notificado_perfil_em", { withTimezone: true }),
  // Dados completos
  dadosCompletos: jsonb("dados_completos"),
  criadoEm: timestamp("criado_em").defaultNow(),
  atualizadoEm: timestamp("atualizado_em").defaultNow(),
}, (table) => [
  // idx_lic_relevancia dropado na 0017: prefixo coberto por idx_lic_relevancia_score.
  index("idx_lic_fase").on(table.fase),
  index("idx_lic_data_fim").on(table.dataFim),
  index("idx_lic_empresa").on(table.empresa),
  index("idx_lic_score").on(table.scoreInteresse),
  index("idx_lic_relevancia_score").on(table.relevancia, table.scoreInteresse),
  // Busca global (E12): índices GIN trigram idx_lic_numero_trgm / idx_lic_objeto_trgm /
  // idx_lic_empresa_trgm criados na migration 0017 via SQL bruto (drizzle não modela
  // gin_trgm_ops) — aceleram os ILIKE '%x%' de /api/licitacoes/search.
  // Na 0018 (busca acento-insensível, flag SEARCH_TRGM): função f_unaccent(text)
  // IMMUTABLE + índices de expressão idx_lic_numero_unaccent_trgm /
  // idx_lic_objeto_unaccent_trgm / idx_lic_empresa_unaccent_trgm
  // (gin (f_unaccent(col) gin_trgm_ops)) — suportam o WHERE
  // f_unaccent(col) ILIKE f_unaccent('%x%') e o ranking similarity() da rota.
]);

// ── ITENS ──
export const itens = pgTable("itens", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id").notNull().references(() => licitacoes.id, { onDelete: "cascade" }),
  itemNumero: text("item_numero"),
  exlin: text("exlin"),
  descricao: text("descricao"),
  material: text("material"),
  familia: text("familia"),
  familiaDescricao: text("familia_descricao"),
  familiaClassif: text("familia_classif"),
  quantidade: real("quantidade"),
  unidade: text("unidade"),
  dataEntrega: text("data_entrega"),
  tipoProcesso: text("tipo_processo"),
  nivelAgrupamento: text("nivel_agrupamento"),
  notas: text("notas"),
  dadosBrutos: jsonb("dados_brutos"),
  criadoEm: timestamp("criado_em").defaultNow(),
}, (table) => [
  index("idx_itens_lic").on(table.licitacaoId),
]);

// ── ANEXOS ──
export const anexos = pgTable("anexos", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id").notNull().references(() => licitacoes.id, { onDelete: "cascade" }),
  descricao: text("descricao"),
  phioObjid: text("phio_objid"),
  s3Key: text("s3_key"),
  tamanhoBytes: integer("tamanho_bytes"),
  contentType: text("content_type"),
  textoCache: text("texto_cache"),
  baixadoEm: timestamp("baixado_em"),
  erroDownload: text("erro_download"),
  criadoEm: timestamp("criado_em").defaultNow(),
}, (table) => [
  index("idx_anexos_lic").on(table.licitacaoId),
]);

// ── CIRCULARES (Notas e Esclarecimentos do Petronect) ──
export type TipoCircular = "MENSAGEM" | "ADENDO" | "COMUNICADO" | "ESCLARECIMENTO" | "OUTRO";

// Classificação de impacto de uma circular/adendo (avaliada por IA — Haiku)
export type ImpactoCircular = "NENHUM" | "PRAZO" | "ESCOPO" | "HABILITACAO" | "VALOR";

export const circulares = pgTable("circulares", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id").notNull().references(() => licitacoes.id, { onDelete: "cascade" }),
  tipo: text("tipo").$type<TipoCircular>().notNull().default("MENSAGEM"),
  autor: text("autor"),
  mensagem: text("mensagem"),
  dataPublicacao: timestamp("data_publicacao"),
  anexoPhioObjid: text("anexo_phio_objid"),
  anexoDescricao: text("anexo_descricao"),
  hashConteudo: text("hash_conteudo"),
  dadosBrutos: jsonb("dados_brutos"),
  // Dedup do alerta CIRCULAR_PUBLICADA já disparado pelo cron circulares-watch
  notificadoEm: timestamp("notificado_em", { withTimezone: true }),
  // Classificação rápida de impacto via Haiku: NENHUM|PRAZO|ESCOPO|VALOR|HABILITACAO
  // (a avaliação detalhada vive em circulares_impacto)
  impactoIa: text("impacto_ia").$type<ImpactoCircular>(),
  criadoEm: timestamp("criado_em").defaultNow(),
}, (table) => [
  index("idx_circ_lic").on(table.licitacaoId),
  index("idx_circ_tipo").on(table.tipo),
  index("idx_circ_data").on(table.dataPublicacao),
  index("idx_circ_hash").on(table.hashConteudo),
]);

// ── HISTORICO DE ALTERACOES ──
export const historicoAlteracoes = pgTable("historico_alteracoes", {
  id: serial("id").primaryKey(),
  licitacaoId: uuid("licitacao_id").notNull().references(() => licitacoes.id, { onDelete: "cascade" }),
  campo: text("campo").notNull(),
  valorAnterior: text("valor_anterior"),
  valorNovo: text("valor_novo"),
  detectadoEm: timestamp("detectado_em").defaultNow(),
  notificado: boolean("notificado").default(false),
}, (table) => [
  index("idx_hist_lic").on(table.licitacaoId),
]);

// ── ANALISES IA ──
export const analisesIa = pgTable("analises_ia", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id").notNull().references(() => licitacoes.id, { onDelete: "cascade" }).unique(),
  resumo: text("resumo"),
  objetoDetalhado: text("objeto_detalhado"),
  checklist: jsonb("checklist"),
  requisitos: jsonb("requisitos"),
  criteriosHabilitacao: jsonb("criterios_habilitacao"),
  criteriosJulgamento: text("criterios_julgamento"),
  valorEstimado: text("valor_estimado"),
  prazos: jsonb("prazos"),
  riscos: jsonb("riscos"),
  recomendacao: text("recomendacao"),
  modeloUsado: text("modelo_usado"),
  tokensInput: integer("tokens_input"),
  tokensOutput: integer("tokens_output"),
  custoEstimado: real("custo_estimado"),
  tempoSegundos: real("tempo_segundos"),
  respostaRaw: text("resposta_raw"),
  // Extração estruturada (tool-use/JSON-schema): flag de falha de parse e versão do schema
  erroParse:    boolean("erro_parse").notNull().default(false),
  schemaVersao: integer("schema_versao").notNull().default(1),
  // Procedência (0032): sobre QUE texto esta análise foi feita.
  // "ANEXOS" = leu os documentos do edital; "OBJETO" = leu só a linha de objeto
  // (~70 chars — análise PARCIAL); null = anterior à 0032, procedência ignorada.
  fonteTexto:   text("fonte_texto"),
  charsEntrada: integer("chars_entrada"),
  // Previsão de win-rate (heurística ponderada — sem ML)
  probVitoria:            real("prob_vitoria"),
  probVitoriaFatores:     jsonb("prob_vitoria_fatores"),
  probVitoriaCalculadaEm: timestamp("prob_vitoria_calculada_em", { withTimezone: true }),
  analisadoEm: timestamp("analisado_em").defaultNow(),
  atualizadoEm: timestamp("atualizado_em").defaultNow(),
});

// ── PERFIS DE INTERESSE ──
export const perfisInteresse = pgTable("perfis_interesse", {
  id: uuid("id").primaryKey().defaultRandom(),
  nome: text("nome").notNull(),
  descricao: text("descricao"),
  ativo: boolean("ativo").default(true),
  filtros: jsonb("filtros").notNull(),
  criadoEm: timestamp("criado_em").defaultNow(),
  atualizadoEm: timestamp("atualizado_em").defaultNow(),
}, (table) => [
  index("idx_perfis_ativo").on(table.ativo),
]);

// ── DIGEST DE E-MAIL (0026) ──
// Filtros PRÓPRIOS do e-mail — independentes de perfis_interesse (decisão de
// produto): avaliados em SQL puro na hora do envio.
export const filtrosEmail = pgTable("filtros_email", {
  id: uuid("id").primaryKey().defaultRandom(),
  nome: text("nome").notNull().unique(),
  descricao: text("descricao"),
  // criterios (todos opcionais; {} = todas as licitações novas):
  //   keywords_incluir[], keywords_excluir[], naturezas[], tipos_servico[],
  //   segmentos[], estados[], min_relevancia ('ALTA'|'MEDIA'|'TODAS')
  criterios: jsonb("criterios").notNull().default({}),
  ativo: boolean("ativo").notNull().default(true),
  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
});

export const assinaturasEmail = pgTable("assinaturas_email", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Origem da assinatura: PERFIL (novo padrão, 0029) ou FILTRO (legado). O banco
  // garante exatamente um dos dois via CHECK chk_assinatura_origem.
  filtroId: uuid("filtro_id").references(() => filtrosEmail.id, { onDelete: "cascade" }),
  perfilId: uuid("perfil_id").references(() => perfisInteresse.id, { onDelete: "cascade" }),
  formato: text("formato").notNull().default("resumido"),       // resumido | completo
  // Piso de relevância (0030): ALTA | MEDIA | TODAS. Usa a MESMA régua do motor
  // (SCORE_POR_RELEVANCIA), então "só ALTA" no e-mail = badge ALTA no Explorar.
  relevanciaMinima: text("relevancia_minima").notNull().default("MEDIA"),
  frequencia: text("frequencia").notNull().default("diario"),   // tempo-real | diario | semanal
  ativo: boolean("ativo").notNull().default(true),
  ultimoEnvioEm: timestamp("ultimo_envio_em", { withTimezone: true }),
  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_ass_email_filtro").on(table.filtroId),
]);
// NOTA (0026): UNIQUE(user_id, filtro_id) + CHECKs de formato/frequencia no banco.

// Ledger de dedup POR ASSINANTE — cada (assinatura, licitação) enviada 1x.
export const assinaturasEmailEnvios = pgTable("assinaturas_email_envios", {
  id: uuid("id").primaryKey().defaultRandom(),
  assinaturaId: uuid("assinatura_id").notNull().references(() => assinaturasEmail.id, { onDelete: "cascade" }),
  licitacaoId: uuid("licitacao_id").notNull().references(() => licitacoes.id, { onDelete: "cascade" }),
  enviadoEm: timestamp("enviado_em", { withTimezone: true }).defaultNow(),
});
// NOTA (0026): UNIQUE(assinatura_id, licitacao_id) no banco — inserir com ON CONFLICT DO NOTHING.

// ── PREFERÊNCIAS DE E-MAIL POR TIPO (0028) ──
// Quais tipos de e-mail do sistema cada usuário recebe. O catálogo dos tipos
// (13 chaves, 1:1 com os templates) vive em lib/email/tipos.ts; a resolução de
// destinatário, em lib/email/destinatarios.ts.
//
// SUBTRATIVA: o papel do usuário continua sendo o gate (quem não tem o papel
// nunca recebe); esta tabela só DESLIGA. AUSÊNCIA DE LINHA = HABILITADO — é o
// que mantém a retrocompatibilidade, então os crons precisam usar LEFT JOIN,
// nunca INNER JOIN.
export const preferenciasEmail = pgTable("preferencias_email", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tipo: text("tipo").$type<TipoEmail>().notNull(),
  habilitado: boolean("habilitado").notNull().default(true),
  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_pref_email_user").on(table.userId),
]);
// NOTA (0028): UNIQUE(user_id, tipo) + CHECK do tipo (13 chaves) no banco.

// ── SYNC LOG ──
export const syncLog = pgTable("sync_log", {
  id: serial("id").primaryKey(),
  tipo: text("tipo").notNull(),
  totalEncontradas: integer("total_encontradas").default(0),
  novas: integer("novas").default(0),
  atualizadas: integer("atualizadas").default(0),
  erros: integer("erros").default(0),
  detalhes: text("detalhes"),
  executadoEm: timestamp("executado_em").defaultNow(),
}, (table) => [
  index("idx_sync_executado_em").on(table.executadoEm),
]);

// ── AUDIT LOG ──
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  acao: text("acao").notNull(),
  entidade: text("entidade"),
  entidadeId: text("entidade_id"),
  detalhes: jsonb("detalhes"),
  criadoEm: timestamp("criado_em").defaultNow(),
}, (table) => [
  index("idx_audit_user").on(table.userId),
  index("idx_audit_criado_em").on(table.criadoEm),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: GESTÃO DE PARTICIPAÇÕES EM LICITAÇÕES
// ═══════════════════════════════════════════════════════════════════════════

// ── PARTICIPACOES LICITACAO (tabela principal) ───────────────────────────────
export const participacoesLicitacao = pgTable("participacoes_licitacao", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Identificação do edital (preenchido manualmente ou via prefill do Petro Radar)
  numeroEdital:       text("numero_edital").notNull(),
  empresaContratante: text("empresa_contratante").notNull(),
  objeto:             text("objeto").notNull(),
  urlPortal:          text("url_portal"),

  // Referência opcional para licitação existente no Petro Radar
  licitacaoPetroRadarId: uuid("licitacao_petro_radar_id")
    .references(() => licitacoes.id, { onDelete: "set null" }),

  // Prazos
  prazoPortal:   timestamp("prazo_portal",   { withTimezone: true }).notNull(),
  prazoInterno:  timestamp("prazo_interno",  { withTimezone: true }),

  // Pipeline
  fase:      text("fase").$type<FaseParticipacao>().notNull().default("PROSPECCAO"),
  resultado: text("resultado").$type<ResultadoParticipacao>(),

  // Responsáveis
  propostoPor:          uuid("proposto_por").notNull().references(() => users.id),
  liderId:              uuid("lider_id").references(() => users.id, { onDelete: "set null" }),
  responsavelTecnico:   uuid("responsavel_tecnico").references(() => users.id, { onDelete: "set null" }),
  responsavelOrcamento: uuid("responsavel_orcamento").references(() => users.id, { onDelete: "set null" }),

  // Soft Lock (edição concorrente — expira em 5 minutos)
  editandoPor:   uuid("editando_por").references(() => users.id, { onDelete: "set null" }),
  editandoDesde: timestamp("editando_desde", { withTimezone: true }),

  // Optimistic Lock (safety net — incrementa a cada UPDATE)
  versao: integer("versao").notNull().default(0),

  // Financeiro (preenchido automaticamente com o valor do último documento)
  valorProposta: numeric("valor_proposta", { precision: 15, scale: 2 }),

  // Metadados
  observacoes: text("observacoes"),
  deletadoEm:  timestamp("deletado_em", { withTimezone: true }), // soft delete

  criadoEm:    timestamp("criado_em",    { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_part_fase").on(table.fase),
  // FK quente (0017): lookup por licitação em licitacoes/[id] e cron circulares-watch
  index("idx_part_licradar").on(table.licitacaoPetroRadarId),
  index("idx_part_prazo_portal").on(table.prazoPortal),
  index("idx_part_prazo_interno").on(table.prazoInterno),
  index("idx_part_proposto_por").on(table.propostoPor),
  index("idx_part_resp_tec").on(table.responsavelTecnico),
  index("idx_part_resp_orc").on(table.responsavelOrcamento),
  index("idx_part_lider").on(table.liderId),
  // Índice parcial para a listagem ativa (não-deletadas) ordenada por fase/prazo
  index("idx_part_ativas").on(table.fase, table.prazoPortal).where(sql`deletado_em IS NULL`),
]);

// ── PARTICIPACOES DOCUMENTOS (DFP, PPU, outros) ─────────────────────────────
export const participacoesDocumentos = pgTable("participacoes_documentos", {
  id:             uuid("id").primaryKey().defaultRandom(),
  participacaoId: uuid("participacao_id")
    .notNull()
    .references(() => participacoesLicitacao.id, { onDelete: "cascade" }),

  tipo:         text("tipo").$type<TipoDocumentoParticipacao>().notNull(), // DFP | PPU | OUTRO
  nomeArquivo:  text("nome_arquivo").notNull(),   // nome original do arquivo
  blobUrl:      text("blob_url").notNull(),        // URL pública Vercel Blob
  blobKey:      text("blob_key").notNull(),        // pathname para delete
  tamanhoBytes: integer("tamanho_bytes"),
  contentType:  text("content_type"),

  // Valor da proposta registrado no momento do upload
  valorProposta: numeric("valor_proposta", { precision: 15, scale: 2 }),

  uploadadoPor: uuid("uploadado_por")
    .notNull()
    .references(() => users.id),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_docs_part").on(table.participacaoId),
  index("idx_docs_tipo").on(table.tipo),
]);

// ── PARTICIPACOES HISTORICO (auditoria completa) ─────────────────────────────
export const participacoesHistorico = pgTable("participacoes_historico", {
  id:             uuid("id").primaryKey().defaultRandom(),
  participacaoId: uuid("participacao_id")
    .notNull()
    .references(() => participacoesLicitacao.id, { onDelete: "cascade" }),
  usuarioId: uuid("usuario_id")
    .notNull()
    .references(() => users.id),

  acao:             text("acao").$type<AcaoHistoricoParticipacao>().notNull(),
  dadosAnteriores:  jsonb("dados_anteriores"), // snapshot antes da mudança
  dadosNovos:       jsonb("dados_novos"),       // snapshot após a mudança
  observacao:       text("observacao"),         // comentário livre

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_hist_part_id").on(table.participacaoId),
  index("idx_hist_part_usuario").on(table.usuarioId),
  index("idx_hist_part_acao").on(table.acao),
]);

// ── PARTICIPACOES NOTIFICACOES (in-app + controle de email) ─────────────────
export const participacoesNotificacoes = pgTable("participacoes_notificacoes", {
  id: uuid("id").primaryKey().defaultRandom(),

  // null = notificação global (ex: prazo de licitação já encerrada)
  participacaoId: uuid("participacao_id")
    .references(() => participacoesLicitacao.id, { onDelete: "cascade" }),

  usuarioId: uuid("usuario_id")
    .notNull()
    .references(() => users.id),

  tipo:     text("tipo").$type<TipoNotificacaoParticipacao>().notNull(),
  titulo:   text("titulo").notNull(),
  mensagem: text("mensagem").notNull(),

  lida:          boolean("lida").notNull().default(false),
  emailEnviado:  boolean("email_enviado").notNull().default(false),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_notif_usuario dropado na 0017: prefixo coberto por idx_notif_usuario_lida.
  index("idx_notif_lida").on(table.lida),
  index("idx_notif_part").on(table.participacaoId),
  index("idx_notif_criado").on(table.criadoEm),
  // Composite: polling count query (WHERE usuarioId = ? AND lida = false)
  index("idx_notif_usuario_lida").on(table.usuarioId, table.lida),
  // Composite: cron reprocess query (WHERE emailEnviado = false AND lida = false)
  index("idx_notif_email_lida").on(table.emailEnviado, table.lida),
]);

// ── PARTICIPACOES PRAZOS EXTENSAO ────────────────────────────────────────────
export const participacoesPrazosExtensao = pgTable("participacoes_prazos_extensao", {
  id:             uuid("id").primaryKey().defaultRandom(),
  participacaoId: uuid("participacao_id")
    .notNull()
    .references(() => participacoesLicitacao.id, { onDelete: "cascade" }),

  solicitadoPor: uuid("solicitado_por")
    .notNull()
    .references(() => users.id),

  novoPrazo: timestamp("novo_prazo", { withTimezone: true }).notNull(),
  motivo:    text("motivo").notNull(),

  status: text("status").$type<StatusExtensao>().notNull().default("PENDENTE"),

  decididoPor: uuid("decidido_por").references(() => users.id),
  decididoEm:  timestamp("decidido_em", { withTimezone: true }),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_ext_part").on(table.participacaoId),
  index("idx_ext_status").on(table.status),
]);

// ── PROPOSTAS DE LICITAÇÃO (dados de cotações/fornecedores) ─────────────────

export const propostasLicitacao = pgTable("propostas_licitacao", {
  id:               uuid("id").primaryKey().defaultRandom(),
  licitacaoId:      uuid("licitacao_id").references(() => licitacoes.id, { onDelete: "set null" }),
  numeroLicitacao:  text("numero_licitacao").notNull(),
  itemNumero:       text("item_numero"),
  itemDescricao:    text("item_descricao"),
  cnpj:             text("cnpj").notNull(),
  fornecedor:       text("fornecedor").notNull(),
  meEpp:            boolean("me_epp").default(false),
  valorUnitario:    numeric("valor_unitario", { precision: 18, scale: 2 }),
  valorTotal:       numeric("valor_total", { precision: 18, scale: 2 }),
  declinou:         boolean("declinou").default(false),
  dataProposta:     text("data_proposta"),
  posicao:          integer("posicao"),
  criadoEm:         timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_prop_licitacao").on(table.licitacaoId),
  index("idx_prop_numero").on(table.numeroLicitacao),
  index("idx_prop_cnpj").on(table.cnpj),
  index("idx_prop_fornecedor").on(table.fornecedor),
]);

// ── RESULTADOS DE LICITAÇÃO (resumo: vencedor, estatísticas) ────────────────

export const resultadosLicitacao = pgTable("resultados_licitacao", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  licitacaoId:        uuid("licitacao_id").references(() => licitacoes.id, { onDelete: "set null" }),
  numeroLicitacao:    text("numero_licitacao").notNull().unique(),
  cnpjVencedor:       text("cnpj_vencedor"),
  fornecedorVencedor: text("fornecedor_vencedor"),
  valorVencedor:      numeric("valor_vencedor", { precision: 18, scale: 2 }),
  totalParticipantes: integer("total_participantes").default(0),
  totalPropostas:     integer("total_propostas").default(0),
  menorValor:         numeric("menor_valor", { precision: 18, scale: 2 }),
  maiorValor:         numeric("maior_valor", { precision: 18, scale: 2 }),
  statusResultado:    text("status_resultado"),
  objeto:             text("objeto"),
  empresa:            text("empresa"),
  segmento:           text("segmento"),
  natureza:           text("natureza"),
  dataFim:            text("data_fim"),
  // Valor REAL do contrato (Portal da Transparência) — preenche o vazio dos
  // valores simbólicos de disputa fechada (migration 0019; cron no worker).
  valorContratoReal:      numeric("valor_contrato_real", { precision: 18, scale: 2 }),
  contratoTransparencia:  text("contrato_transparencia"),
  contratoVigenciaFim:    text("contrato_vigencia_fim"),
  transparenciaChecadoEm: timestamp("transparencia_checado_em", { withTimezone: true }),
  // Vencedor + metadados do contrato (migration 0020) — fallback rotulado
  // "Transparência" quando a coleta Petronect não capturou o vencedor.
  contratoFornecedor:     text("contrato_fornecedor"),
  contratoCnpj:           text("contrato_cnpj"),
  contratoSituacao:       text("contrato_situacao"),
  contratoAditivos:       integer("contrato_aditivos"),
  contratoMoeda:          text("contrato_moeda"),
  contratoVigenciaInicio: text("contrato_vigencia_inicio"),
  contratoDados:          jsonb("contrato_dados"),
  detectadoEm:        timestamp("detectado_em", { withTimezone: true }).defaultNow(),
  criadoEm:           timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_res_licitacao").on(table.licitacaoId),
  // idx_res_numero dropado na 0017: duplicata da UNIQUE constraint
  // resultados_licitacao_numero_licitacao_unique (via .unique() da coluna).
  index("idx_res_vencedor_cnpj").on(table.cnpjVencedor),
  index("idx_res_segmento").on(table.segmento),
  index("idx_res_natureza").on(table.natureza),
]);

// ── CONTRATOS DA TRANSPARÊNCIA (sweeps semanais do worker — migration 0022) ──
// Histórico all-time por CNPJ (cnpj-sweep) + universo de prospecção por objeto
// (objeto-sweep) + vencedores recentes (adjudicacao — migration 0027). Leitura
// via raw SQL nas queries de analytics; definido aqui para referência/tipagem
// quando necessário. `origem` distingue a procedência da linha.
export const transparenciaContratos = pgTable("transparencia_contratos", {
  id:              uuid("id").primaryKey().defaultRandom(),
  contratoCd:      text("contrato_cd").notNull().unique(),
  processo:        text("processo"),
  cnpj:            text("cnpj"),
  fornecedor:      text("fornecedor"),
  objeto:          text("objeto"),
  valor:           numeric("valor", { precision: 18, scale: 2 }),
  moeda:           text("moeda"),
  situacao:        text("situacao"),
  modalidade:      text("modalidade"),
  unidade:         text("unidade"),
  orgaoSuperior:   text("orgao_superior"),
  vigenciaInicio:  text("vigencia_inicio"),
  vigenciaFim:     text("vigencia_fim"),
  aditivosQtd:     integer("aditivos_qtd"),
  fundamentoLegal: text("fundamento_legal"),
  instrumento:     text("instrumento"),
  origem:          text("origem").notNull().default("cnpj-sweep"),
  aderencia:       integer("aderencia").default(0),
  segmentoEstimado: text("segmento_estimado"),
  // ── Adjudicações / prospecção de parcerias (migration 0027) ──
  // dataLogInclusao: quando o contrato apareceu no portal (≠ início da vigência,
  // que pode ser retroativo) — o sinal honesto de "recém-adjudicado".
  dataLogInclusao: text("data_log_inclusao"),
  patrocinio:      boolean("patrocinio").notNull().default(false),
  // papelVencedor: construtora | projetista | hibrido | desconhecido.
  papelVencedor:   text("papel_vencedor"),
  // classificacaoIa: { v, fonte: 'regex'|'llm', tipo_escopo, contem_engenharia, fit }
  classificacaoIa: jsonb("classificacao_ia"),
  capturadoEm:     timestamp("capturado_em", { withTimezone: true }).defaultNow(),
  atualizadoEm:    timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_tc_cnpj").on(table.cnpj),
  index("idx_tc_vigencia_fim").on(table.vigenciaFim),
  index("idx_tc_vigencia_inicio").on(table.vigenciaInicio),
  index("idx_tc_origem_inicio").on(table.origem, table.vigenciaInicio),
  index("idx_tc_modalidade").on(table.modalidade),
]);

// ── LICITAÇÕES DA TRANSPARÊNCIA (descoberta suplementar — migration 0023) ────
// Universo de licitações das 5 empresas Petrobras publicado no módulo Licitações
// do Portal da Transparência (sweep semanal do worker via EXPORT XLSX). `noBanco`
// = a licitação também existe na nossa tabela `licitacoes` (join por numero);
// noBanco=false => LACUNA que o scraper Petronect não coletou (superfície
// "Cobertura Petronect"). Leitura via raw SQL.
export const transparenciaLicitacoes = pgTable("transparencia_licitacoes", {
  id:             uuid("id").primaryKey().defaultRandom(),
  numero:         text("numero").notNull().unique(),
  processo:       text("processo"),
  objeto:         text("objeto"),
  cidade:         text("cidade"),
  uf:             text("uf"),
  situacao:       text("situacao"),
  modalidade:     text("modalidade"),
  dataAbertura:   text("data_abertura"),
  dataPublicacao: text("data_publicacao"),
  temContratos:   boolean("tem_contratos").notNull().default(false),
  orgao:          text("orgao"),
  noBanco:        boolean("no_banco").notNull().default(false),
  capturadoEm:    timestamp("capturado_em", { withTimezone: true }).defaultNow(),
  atualizadoEm:   timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_tl_numero").on(table.numero),
  index("idx_tl_no_banco").on(table.noBanco),
  index("idx_tl_data_publicacao").on(table.dataPublicacao),
]);

// ── EVENTOS DE VENCEDOR (linha do tempo de mudanças pós-resultado) ──────────
//
// Captura o caso "1º colocado foi desclassificado, 2º foi convocado" e variações.
// Histórico — não snapshot. Cada evento = uma linha. Ordem cronológica via `ordem`.
//
// O `resultados_licitacao.cnpj_vencedor` reflete o vencedor ATUAL (último
// CONVOCADO ou HOMOLOGADO). Histórico completo aqui.

export type TipoEventoVencedor =
  | "ANUNCIADO"          // 1º colocado anunciado vencedor (snapshot inicial — opcional registrar)
  | "DESCLASSIFICADO"    // empresa desclassificada (motivo registrado)
  | "CONVOCADO"          // próximo colocado chamado a apresentar documentação
  | "DESISTIU"           // empresa renunciou voluntariamente após convocação
  | "HOMOLOGADO";        // contrato firmado / homologação oficial

export type MotivoEventoVencedor =
  | "DOCUMENTACAO_INSUFICIENTE"
  | "INEXEQUIBILIDADE"
  | "DESCUMPRIMENTO_REQUISITOS"
  | "DESISTENCIA_VOLUNTARIA"
  | "CADUCIDADE_PRAZO"
  | "OUTRO";

export type FonteEventoVencedor =
  | "PORTAL_PETRONECT"
  | "EMAIL_PETROBRAS"
  | "DOU"
  | "CONFIRMACAO_INTERNA"
  | "OUTRO";

export const licitacaoEventosVencedor = pgTable("licitacao_eventos_vencedor", {
  id:              uuid("id").primaryKey().defaultRandom(),
  numeroLicitacao: text("numero_licitacao").notNull(),

  // Ordem cronológica do evento na licitação (1, 2, 3...). Único por licitação.
  ordem: integer("ordem").notNull(),

  cnpj:       text("cnpj").notNull(),
  fornecedor: text("fornecedor").notNull(),

  tipo:       text("tipo").$type<TipoEventoVencedor>().notNull(),
  dataEvento: timestamp("data_evento", { withTimezone: true }).notNull(),

  motivo:        text("motivo").$type<MotivoEventoVencedor>(),
  motivoDetalhe: text("motivo_detalhe"),
  fonte:         text("fonte").$type<FonteEventoVencedor>().notNull().default("CONFIRMACAO_INTERNA"),
  observacao:    text("observacao"),

  registradoPor: uuid("registrado_por").references(() => users.id, { onDelete: "set null" }),
  registradoEm:  timestamp("registrado_em", { withTimezone: true }).defaultNow(),

  // Radar de Convocação do Remanescente — evita re-disparar alerta para o mesmo evento
  convocacaoNotificadaEm: timestamp("convocacao_notificada_em", { withTimezone: true }),
}, (table) => [
  // idx_levev_lic dropado na 0017: prefixo coberto por idx_levev_lic_ordem.
  index("idx_levev_cnpj").on(table.cnpj),
  index("idx_levev_tipo").on(table.tipo),
  index("idx_levev_data").on(table.dataEvento),
  uniqueIndex("idx_levev_lic_ordem").on(table.numeroLicitacao, table.ordem),
  // A8 (0017): 1 marco por (licitação, cnpj, tipo) vindo do portal — fecha a
  // corrida projeção×backfill do worker (ON CONFLICT DO NOTHING genérico).
  uniqueIndex("uq_levev_marco_portal")
    .on(table.numeroLicitacao, table.cnpj, table.tipo)
    .where(sql`fonte = 'PORTAL_PETRONECT'`),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: FAMÍLIAS CRC PETROBRAS
// ═══════════════════════════════════════════════════════════════════════════

export type NivelFamilia = "FAMILIA" | "SUBFAMILIA" | "GRUPO" | "ITEM";

export type StatusFamilia =
  | "ATIVA"          // CRC vigente em todos os critérios obrigatórios
  | "EM_RENOVACAO"   // dentro da janela de 60 dias antes do vencimento
  | "SUSPENSA"       // bloqueada temporariamente
  | "VENCIDA"        // expirou e ainda não foi renovada
  | "REJEITADA";     // não aprovada pela Petrobras

export type StatusCriterioCrc =
  | "APROVADO"        // critério em dia (Petrobras: A)
  | "QUALIFICADO"     // qualificação parcial (Q)
  | "EM_AVALIACAO"    // sob análise da Petrobras (D)
  | "REJEITADO"       // reprovado (R)
  | "CANCELADO";      // descadastrado (X)

export type CriterioCrc =
  | "JURIDICO"
  | "ECONOMICO"
  | "TECNICO"
  | "TECNICO_SMS"
  | "LFO"            // Linha de Fornecimento (autodeclaratório)
  | "REVENDEDOR"     // distribuidor / revendedor
  | "INTEGRIDADE";

// Segmento oficial Petrobras — define o rigor da auditoria do CRC
export type SegmentoPetrobras =
  | "YELLOW_PAGES"   // baixa complexidade, interesse local
  | "OPERACIONAL"    // média complexidade, suprimentos contínuos
  | "CRITICA"        // alta complexidade, impacto na performance
  | "ESTRATEGICA";   // crítica máxima, tecnologia avançada

// Status de fluxo oficial Petrobras (separado do status interno)
//   D = Declaração de Interesse (jurídico aprovado, sem qualificação técnica)
//   Q = Tecnicamente Qualificado (aguardando jurídico/econômico)
//   A = Aprovado (todos os critérios aprovados — apto a licitar)
//   X = Cancelado (por solicitação ou ação Petrobras)
export type StatusFluxoCrc = "D" | "Q" | "A" | "X";

// ── FAMILIAS ─────────────────────────────────────────────────────────────────
// Catálogo hierárquico de famílias CRC (família → subfamília → grupo → item).
// Estrutura espelha a oficial Petrobras com 4 níveis.
export const familias = pgTable("familias", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Codificação Petrobras (ex.: "G02.01.05")
  codigoCrc: text("codigo_crc").notNull().unique(),
  // Mesmo código sem pontuação — facilita match com itens.familia (legado texto)
  codigoNormalizado: text("codigo_normalizado").notNull(),

  nome:      text("nome").notNull(),
  descricao: text("descricao"),

  // Hierarquia
  nivel:    text("nivel").$type<NivelFamilia>().notNull().default("FAMILIA"),
  parentId: uuid("parent_id").references((): AnyPgColumn => familias.id, { onDelete: "cascade" }),
  // Materialized path (ex.: "G02/G02.01/G02.01.05") para queries de árvore
  path:     text("path"),

  // Modalidade do cadastro Petrobras
  cadastroCorporativo: boolean("cadastro_corporativo").notNull().default(true),

  // Segmento oficial Petrobras (Yellow Pages / Operacional / Crítica / Estratégica)
  segmentoPetrobras: text("segmento_petrobras").$type<SegmentoPetrobras>(),

  // Status global da família (consolida critérios — uso interno Proponente)
  status: text("status").$type<StatusFamilia>().notNull().default("ATIVA"),

  // Status oficial Petrobras (D / Q / A / X) — separado do status interno
  statusFluxoCrc: text("status_fluxo_crc").$type<StatusFluxoCrc>(),

  // Validade do CRC para esta família (menor data entre os critérios)
  validadeFim: timestamp("validade_fim", { withTimezone: true }),

  // Próxima janela de renovação (calculado: validadeFim - 60 dias)
  proximaRenovacaoEm: timestamp("proxima_renovacao_em", { withTimezone: true }),

  // Detalhamento por critério (JSONB)
  // Ex.: { JURIDICO: { status: "APROVADO", validadeFim: "2027-03-15" }, ECONOMICO: {...} }
  criterios: jsonb("criterios").$type<
    Partial<Record<CriterioCrc, { status: StatusCriterioCrc; validadeFim: string | null; observacao?: string }>>
  >(),

  // Metadados
  tags:           jsonb("tags").$type<string[]>(),
  escoposCobertos: jsonb("escopos_cobertos").$type<string[]>(),
  observacoes:    text("observacoes"),

  // Soft delete
  deletadoEm: timestamp("deletado_em", { withTimezone: true }),

  criadoPor:   uuid("criado_por").references(() => users.id, { onDelete: "set null" }),
  atualizadoPor: uuid("atualizado_por").references(() => users.id, { onDelete: "set null" }),
  criadoEm:    timestamp("criado_em",    { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_fam_codigo_norm").on(table.codigoNormalizado),
  index("idx_fam_status").on(table.status),
  index("idx_fam_validade").on(table.validadeFim),
  index("idx_fam_parent").on(table.parentId),
  index("idx_fam_path").on(table.path),
  index("idx_fam_deletado").on(table.deletadoEm),
  index("idx_fam_segmento").on(table.segmentoPetrobras),
  index("idx_fam_status_fluxo").on(table.statusFluxoCrc),
  index("idx_fam_renovacao").on(table.proximaRenovacaoEm),
]);

/**
 * CATÁLOGO de famílias CRC — o mercado observado, separado do NOSSO cadastro.
 *
 * `familias` (acima) são as famílias em que a Proponente está CADASTRADA, com
 * validade, renovação e certificado. Esta tabela é outra coisa: as famílias que
 * apareceram nas licitações que o Petro Radar coletou.
 *
 * A separação é deliberada. Despejar centenas de linhas quase vazias dentro de
 * `familias` afogaria as linhas operacionais — e o aviso de renovação
 * vencendo, que é para o que a tela existe, sumiria no meio. Além disso
 * `familias` tem writers humanos; o catálogo é DERIVADO e reconstruído a cada
 * `make migrate` (migração 0040).
 *
 * ⚠️ NÃO É o catálogo oficial da Petrobras. `licitacoes` mede DEMANDA OBSERVADA,
 * não demanda real: uma família cadastrada pode não aparecer em licitação nenhuma
 * da base — existe, só nunca foi exigida no que foi coletado. Ausência daqui
 * NÃO significa que a família não existe.
 *
 * A junção com `familias` é por `f_codigo_crc()` (migração 0040), que poda o
 * zero à esquerda do padding do SAP — `98010591` e `000000000098010591` são a
 * mesma família. `codigoNormalizado` NÃO faz isso, e não deve passar a fazer:
 * é a chave única do cadastro.
 */
export const familiasCatalogo = pgTable("familias_catalogo", {
  /** Código normalizado por f_codigo_crc(): maiúsculas, alfanumérico, sem padding. */
  codigo:       text("codigo").primaryKey(),
  /** Como o Petronect devolveu — rastreio até a fonte. */
  codigoOrigem: text("codigo_origem").notNull(),
  /** NULL é comum: o Petronect nem sempre manda descrição. */
  nome:         text("nome"),
  /**
   * 98* = BEM/MATERIAL (válvula gaveta, transmissor de vazão). 99* = SERVIÇO.
   * Para uma proponente de serviços, cujo cadastro é todo 99*,
   * MATERIAL é ruído — mas fica gravado, porque filtrar na consulta é
   * reversível e apagar na carga não é.
   */
  segmento:     text("segmento").$type<"MATERIAL" | "SERVICO" | "OUTRO">().notNull(),
  /** Licitações distintas que exigiram esta família. DEMANDA OBSERVADA. */
  licitacoes:   integer("licitacoes").notNull().default(0),
  itens:        integer("itens").notNull().default(0),
  primeiraVezEm: timestamp("primeira_vez_em", { withTimezone: true }),
  /** Recência: família exigida pela última vez em 2019 não é oportunidade. */
  ultimaVezEm:   timestamp("ultima_vez_em", { withTimezone: true }),
  fontes:        text("fontes").array().notNull().default([]),
  medidoEm:      timestamp("medido_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_fam_catalogo_segmento").on(table.segmento, table.licitacoes),
  index("idx_fam_catalogo_demanda").on(table.licitacoes),
]);

// ── FAMILIAS ALIASES ─────────────────────────────────────────────────────────
// Petrobras eventualmente refunde/renomeia famílias.
// Aliases mapeiam códigos antigos → família atual para preservar histórico.
export const familiasAliases = pgTable("familias_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  familiaId: uuid("familia_id")
    .notNull()
    .references(() => familias.id, { onDelete: "cascade" }),
  codigoAlternativo:           text("codigo_alternativo").notNull(),
  codigoAlternativoNormalizado: text("codigo_alternativo_normalizado").notNull(),
  observacao: text("observacao"),
  criadoEm:   timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_fam_alias_familia").on(table.familiaId),
  index("idx_fam_alias_codigo").on(table.codigoAlternativoNormalizado),
]);

// ── FAMILIAS ANEXOS ──────────────────────────────────────────────────────────
// Certificados CRC, atas de auditoria, documentos comprobatórios.
export type TipoAnexoFamilia = "CERTIFICADO_CRC" | "ATA_AUDITORIA" | "OUTRO";

export const familiasAnexos = pgTable("familias_anexos", {
  id: uuid("id").primaryKey().defaultRandom(),
  familiaId: uuid("familia_id")
    .notNull()
    .references(() => familias.id, { onDelete: "cascade" }),

  tipo:         text("tipo").$type<TipoAnexoFamilia>().notNull().default("OUTRO"),
  nomeArquivo:  text("nome_arquivo").notNull(),
  blobUrl:      text("blob_url").notNull(),
  blobKey:      text("blob_key").notNull(),
  tamanhoBytes: integer("tamanho_bytes"),
  contentType:  text("content_type"),

  validadeFim: timestamp("validade_fim", { withTimezone: true }),

  uploadadoPor: uuid("uploadado_por")
    .notNull()
    .references(() => users.id),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_fam_anexo_familia").on(table.familiaId),
  index("idx_fam_anexo_tipo").on(table.tipo),
]);

// ── LICITACOES × FAMILIAS MATCH ──────────────────────────────────────────────
// Cache de aderência por licitação (recalculado por cron e on-demand).
export const licitacoesFamiliasMatch = pgTable("licitacoes_familias_match", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id")
    .notNull()
    .references(() => licitacoes.id, { onDelete: "cascade" })
    .unique(),

  totalItens:    integer("total_itens").notNull().default(0),
  itensCobertos: integer("itens_cobertos").notNull().default(0),
  scoreAderencia: real("score_aderencia").notNull().default(0), // 0..100

  // IDs e códigos das famílias usadas no match (para drill-down)
  familiasUsadas: jsonb("familias_usadas").$type<{ familiaId: string; codigoCrc: string; itensCobertos: number }[]>(),

  // Códigos de família da licitação que NÃO temos em catálogo (gap analysis)
  familiasFaltantes: jsonb("familias_faltantes").$type<string[]>(),

  calculadoEm: timestamp("calculado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_lfm_licitacao dropado na 0017: duplicata da UNIQUE constraint
  // licitacoes_familias_match_licitacao_id_unique (via .unique() da coluna).
  index("idx_lfm_score").on(table.scoreAderencia),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: HABILITAÇÃO (Cofre de Documentos)
// ═══════════════════════════════════════════════════════════════════════════

export type CategoriaDocHab =
  | "JURIDICA"             // contrato social, CNPJ, atos
  | "FISCAL"               // CND, FGTS, CNDT, estaduais, municipais
  | "ECONOMICA"            // balanço, índices
  | "TECNICA"              // ACT, ISO, NR, ASME, API
  | "QUALIFICACAO_PESSOAL" // CREA, CTPS, formação
  | "DECLARACAO";          // padrões: menor, idoneidade, ME/EPP

export type SubcategoriaDocHab =
  // FISCAL
  | "CND_FEDERAL" | "FGTS" | "CNDT" | "CND_ESTADUAL" | "CND_MUNICIPAL" | "FALENCIA"
  // ECONOMICA
  | "BALANCO" | "INDICES_FINANCEIROS"
  // JURIDICA
  | "CONTRATO_SOCIAL" | "CNPJ" | "ATO_CONSTITUTIVO" | "PROCURACAO"
  // TECNICA
  | "ATESTADO_ACT" | "ISO_9001" | "ISO_14001" | "ISO_45001"
  | "NR_10" | "NR_13" | "NR_35" | "ASME" | "API_Q1" | "API_6D" | "PED" | "OUTROS_TECNICOS"
  // QUALIFICACAO PESSOAL
  | "CREA_PJ" | "CREA_PF" | "ART_CAT" | "CTPS" | "FORMACAO"
  // DECLARACOES
  | "DECL_MENOR_NAO_EMPREGA" | "DECL_IDONEIDADE" | "DECL_ME_EPP" | "DECL_OUTRA"
  // OUTROS
  | "OUTRO";

export type StatusDocHab =
  | "VIGENTE"        // dentro da validade
  | "EM_RENOVACAO"   // dentro da janela de aviso
  | "VENCIDO"        // ultrapassou a validade
  | "SUBSTITUIDO";   // existe versão mais nova

export type TipoAlertaVencimento = "D_60" | "D_30" | "D_15" | "D_7" | "D_1" | "VENCIDO";

export type FonteCertidao = "ECAC" | "FGTS" | "CNDT" | "SEFAZ_ESTADUAL" | "CRC_PETROBRAS";

// De QUEM é o acervo da operação. Parte das obras do catálogo pode ser de terceiro:
// um atestado da COLIGADA só habilita a Proponente em licitação que aceite coligada,
// por isso a detentora é campo de primeira classe e não observação no escopo.
export type Detentora = "PROPONENTE" | "COLIGADA" | "PARCEIRO";

// CATALOGO = veio da Relação de Operações (carga inicial); MANUAL = cadastrada na
// tela de upload. Separadas para poder re-semear o catálogo sem pisar no que
// foi digitado à mão.
export type OrigemOperacao = "CATALOGO" | "MANUAL";

// O que o arquivo PROVA na operação — ortogonal a categoria/subcategoria, que
// dizem o que ele é do ponto de vista de habilitação.
// CAT_ART só aparece aqui quando a CAT é prova AUTÔNOMA de acervo profissional;
// quando ela instrui um atestado específico, entra como anexo daquele documento
// (documentosHabilitacaoAnexos).
export type PapelDocumento =
  | "ATESTADO"
  | "CAT_ART"
  | "CONTRATO"
  | "ADITIVO"
  | "NOTA_FISCAL"
  | "DECLARACAO"
  | "OUTRO";

// Taxonomia fina do dossiê (migration 0034). A seção da ficha DERIVA deste
// valor (SECAO_POR_TIPO em @/lib/conformidade/operacoes) — não existe coluna
// `secao` (ADR-02). NULL = seção 9 "Sem tipo definido" (fila de trabalho).
export type TipoDocumento =
  | "ART" | "CAT" | "ATESTADO" | "CONTRATO" | "ADITIVO" | "ANEXO_CONTRATO"
  | "CREA_PJ" | "ISO" | "DECLARACAO" | "PROPOSTA" | "ANEXO_ET" | "DOC_PROJETO"
  | "PEDIDO" | "NF" | "CARTA" | "RELATORIO" | "PESSOAL" | "CAPA_OP"
  | "COMPACTADO" | "OUTRO";

// Ciclo de vida de PROVA (não confundir com StatusDocHab, que é ciclo de vida
// de CERTIDÃO). RASCUNHO/SUPERADA/CANCELADA/MODELO não contam na barra.
export type SituacaoProva =
  | "RASCUNHO" | "ASSINADA_PROPONENTE" | "ASSINADA_CLIENTE"
  | "SUPERADA" | "CANCELADA" | "MODELO" | "INDEFINIDA";

// ── OPERACOES ────────────────────────────────────────────────────────────────
// A obra como entidade (migration 0033). Antes dela a operação só existia como
// prefixo digitado no título do documento ("10008 - CLIENTE ..."), o que impedia
// filtrar, agrupar e somar valor/HH por cliente.
// Espelha a Relação de Operações do catálogo do Acervo Técnico (carga
// inicial com origem=CATALOGO).
// Chave de negócio é `codigo`, não o uuid: é por ele que o seed casa
// (ON CONFLICT) e que o backfill liga os documentos já existentes.
export const operacoes = pgTable("operacoes", {
  id: uuid("id").primaryKey().defaultRandom(),

  codigo:       text("codigo").notNull().unique(), // "10008" — código da Relação de Operações
  clienteNome:  text("cliente_nome").notNull(),
  // "Petrobras" unificado — o catálogo separa "Petrobras" de "Petrobras
  // Transpetro"; a unificação é trabalho do gerador do seed.
  clienteGrupo: text("cliente_grupo"),
  clienteCnpj:  text("cliente_cnpj"),

  contratoNumero:   text("contrato_numero"),
  unidade:          text("unidade"), // unidade/local da obra (REF-A, TSC, FPSO ...)
  // 0044: a AREA dentro da planta — "U-32", "Area 30", "Off-site". O
  // edital cita a area, e hoje ela so existe misturada em `unidade` ou solta
  // no escopo. Texto livre, nullable, sem catalogo: o vocabulario e do
  // cliente. `unidade` fica onde esta e diz outra coisa (a planta/base).
  area:             text("area"),
  detentora:        text("detentora").$type<Detentora>().notNull().default("PROPONENTE"),
  // 0043: CNPJ do ESTABELECIMENTO da detentora (matriz × filial).
  // `detentora` continua sendo a chave — este campo só qualifica qual CNPJ
  // detém o acervo, e importa quando o edital exige atestado no CNPJ da
  // licitante. Nullable, sem default: nada existente muda. CHECK de 14 dígitos
  // vive na migration (chk_oper_detentora_cnpj).
  detentoraCnpj:    text("detentora_cnpj"),
  ramo:             text("ramo"),
  onshoreOffshore:  text("onshore_offshore"),

  // `date` (não timestamp): o catálogo só tem ANO de início/fim, e a coluna
  // date devolve a STRING "YYYY-MM-DD" no Drizzle — que é exatamente o que o
  // espelho do BFF tem de emitir para a paridade fechar.
  periodoInicio: date("periodo_inicio"),
  periodoFim:    date("periodo_fim"),

  // numeric sai como STRING nos dois lados (Drizzle e BFF) — nunca number.
  valor: numeric("valor", { precision: 18, scale: 2 }),
  hh:    numeric("hh",    { precision: 14, scale: 2 }),

  escopo: text("escopo"), // objeto do contrato

  // Códigos CRC sugeridos pelo catálogo: REFERÊNCIA para triagem, não vínculo.
  // O vínculo que vale continua sendo documentosFamilias.
  familiasSugeridas: jsonb("familias_sugeridas").$type<string[]>(),

  origem: text("origem").$type<OrigemOperacao>().notNull().default("CATALOGO"),
  ativo:  boolean("ativo").notNull().default(true),

  criadoEm:     timestamp("criado_em",     { withTimezone: true }).defaultNow(),
  // Sem trigger no banco (nenhuma tabela deste schema tem): todo UPDATE
  // precisa setar atualizadoEm = now() na mão.
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx do `codigo` vem de graça pela UNIQUE da coluna (operacoes_codigo_key).
  index("idx_oper_cliente_grupo").on(table.clienteGrupo),
  // Índice de expressão: casa cliente sem depender de caixa (igualdade e
  // prefixo). Não atende o `ILIKE '%termo%'` da busca da tela — com poucas centenas de linhas
  // o seq scan é irrelevante e não vale um GIN trigram como o da 0018.
  index("idx_oper_cliente_nome").on(sql`lower(${table.clienteNome})`),
  // Indice de expressao, igual ao de cliente_nome: casa a area sem depender de
  // caixa. Nao atende ILIKE '%termo%' — com poucas centenas de linhas o seq scan e irrelevante.
  index("idx_oper_area").on(sql`lower(${table.area})`),
]);

// ── DOCUMENTOS HABILITACAO ───────────────────────────────────────────────────
// Cofre principal: certidões, atestados, ISO, declarações, CREAs.
export const documentosHabilitacao = pgTable("documentos_habilitacao", {
  id: uuid("id").primaryKey().defaultRandom(),

  categoria:    text("categoria").$type<CategoriaDocHab>().notNull(),
  subcategoria: text("subcategoria").$type<SubcategoriaDocHab>().notNull(),

  titulo:    text("titulo").notNull(),
  descricao: text("descricao"),

  // Operação que o documento comprova (0033). NULL = prova solta ou documento
  // que não é de obra (certidão, ISO, declaração). SET NULL no delete: apagar
  // uma operação cadastrada errado não pode levar junto a prova digitalizada.
  operacaoId: uuid("operacao_id").references(() => operacoes.id, { onDelete: "set null" }),
  // Papel da prova NA operação. Começa NULL nos documentos legados e só
  // ganha 'ATESTADO' no backfill —
  // por isso o CHECK do banco aceita NULL.
  papel: text("papel").$type<PapelDocumento>(),

  // ── 0034 — dossiê da operação ──────────────────────────────────────────────
  tipoDocumento: text("tipo_documento").$type<TipoDocumento>(),
  situacaoProva: text("situacao_prova").$type<SituacaoProva>(),
  // detentora DESTA prova — independente da operação (órfão precisa da marca)
  detentora:     text("detentora").$type<Detentora>(),
  // 0043: CNPJ do estabelecimento detentor DESTA prova — mesmo
  // sentido de `operacoes.detentoraCnpj`, mas por documento, porque o órfão
  // (sem operação) também precisa da marca. Nullable; CHECK de 14 dígitos na
  // migration (chk_doch_detentora_cnpj).
  detentoraCnpj: text("detentora_cnpj"),
  restrito:      boolean("restrito").notNull().default(false),
  // referência forward a importJobs (declarada abaixo na mesma unidade) — o
  // arrow resolve, mesmo padrão do self-ref documentoAnteriorId.
  importJobId:   uuid("import_job_id").references(() => importJobs.id, { onDelete: "set null" }),
  // 0043: qual disciplina ESTE documento prova. Nullable — documento sem
  // disciplina se comporta exatamente como hoje; entra como filtro, nunca como
  // obrigação. Referência para frente pelo arrow, igual a `importJobId` acima.
  disciplinaId:  uuid("disciplina_id").references(() => disciplinas.id, { onDelete: "set null" }),
  origemPath:    text("origem_path"),

  // Arquivo
  nomeArquivo:  text("nome_arquivo").notNull(),
  blobUrl:      text("blob_url").notNull(),
  blobKey:      text("blob_key").notNull(),
  tamanhoBytes: integer("tamanho_bytes"),
  contentType:  text("content_type"),
  // SHA-256 do arquivo — usado para detectar duplicatas no upload
  sha256: text("sha256"),

  // Identificação documental
  numeroDocumento: text("numero_documento"), // ex.: número da CND
  emitidoEm:       timestamp("emitido_em", { withTimezone: true }),
  validadeFim:     timestamp("validade_fim", { withTimezone: true }),
  // true para contrato social, CREA-PJ etc. (sem prazo formal)
  validadeIndeterminada: boolean("validade_indeterminada").notNull().default(false),

  status: text("status").$type<StatusDocHab>().notNull().default("VIGENTE"),

  // Versionamento
  versao:               integer("versao").notNull().default(1),
  // 0044: a REVISAO carimbada pela engenharia ("R0", "R1", "02A"). Nao e
  // `versao`: aquela e o versionamento de certidao do cofre (v2 SUBSTITUI v1,
  // com documento_anterior_id). Esta nao ordena, nao substitui e nao tem
  // gramatica unica entre clientes — por isso text nullable, sem CHECK.
  revisao:              text("revisao"),
  documentoAnteriorId:  uuid("documento_anterior_id").references((): AnyPgColumn => documentosHabilitacao.id, { onDelete: "set null" }),

  // OCR
  // LGPD (auditoria 02/07): ocr_texto é um RESUMO de exibição (1-2 frases) e NÃO
  // alimenta a busca (o filtro usa titulo/descricao/numero_documento). CPF e
  // e-mail são REDIGIDOS ([CPF-REMOVIDO]/[EMAIL-REMOVIDO]) antes de gravar no BFF
  // e, para o legado, pela migration 0016.
  ocrTexto:     text("ocr_texto"),
  ocrMetadata:  jsonb("ocr_metadata"),
  ocrConfianca: real("ocr_confianca"),

  tags: jsonb("tags").$type<string[]>(),

  uploadadoPor: uuid("uploadado_por").notNull().references(() => users.id),
  atualizadoPor: uuid("atualizado_por").references(() => users.id, { onDelete: "set null" }),

  criadoEm:    timestamp("criado_em", { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_doch_categoria dropado na 0017: prefixo coberto por idx_doch_cat_status.
  index("idx_doch_subcategoria").on(table.subcategoria),
  index("idx_doch_status").on(table.status),
  index("idx_doch_validade").on(table.validadeFim),
  index("idx_doch_cat_status").on(table.categoria, table.status),
  index("idx_doch_sha").on(table.sha256),
  // FK quente (0017): self-FK de versionamento — DELETE de documento varre a
  // própria tabela (SET NULL) sem este índice.
  index("idx_doch_doc_anterior").on(table.documentoAnteriorId),
  // 0033: agrupamento por operação na lista do cofre, dossiê da operação e o
  // SET NULL do DELETE de operação.
  index("idx_doch_operacao").on(table.operacaoId),
  // 0034: seção da ficha e contagens por tipo.
  index("idx_doch_tipo_documento").on(table.tipoDocumento),
  // 0034: chave do desfazer (R15/desfazer.py) e do relatório por job.
  index("idx_doch_import_job").on(table.importJobId),
  // 0034: parcial — só os restritos (auditoria); um índice cheio de false não paga.
  index("idx_doch_restrito").on(table.restrito).where(sql`${table.restrito}`),
  // 0043: parcial — a coluna nasce NULL em toda linha e índice cheio de NULL
  // não paga.
  index("idx_doch_disciplina").on(table.disciplinaId).where(sql`${table.disciplinaId} IS NOT NULL`),
]);

// ── DOCUMENTOS HABILITACAO ANEXOS ───────────────────────────────────────────
// Anexos extras ligados ao mesmo registro de documento (ex.: ART + CAT do mesmo
// engenheiro, balanço + DRE etc.). O arquivo "principal" continua em
// documentos_habilitacao; aqui ficam apenas os complementares.
export type TipoAnexoDocumento = "COMPLEMENTAR" | "ANEXO" | "RETIFICACAO" | "OUTRO";

export const documentosHabilitacaoAnexos = pgTable("documentos_habilitacao_anexos", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentoId: uuid("documento_id")
    .notNull()
    .references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  tipo:         text("tipo").$type<TipoAnexoDocumento>().notNull().default("ANEXO"),
  titulo:       text("titulo"),
  nomeArquivo:  text("nome_arquivo").notNull(),
  blobUrl:      text("blob_url").notNull(),
  blobKey:      text("blob_key").notNull(),
  tamanhoBytes: integer("tamanho_bytes"),
  contentType:  text("content_type"),

  uploadadoPor: uuid("uploadado_por")
    .notNull()
    .references(() => users.id),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_doch_anexo_doc").on(table.documentoId),
]);

// ── DOCUMENTOS × FAMILIAS (N:N) ──────────────────────────────────────────────
// Vincula ACTs, ISO etc. às famílias CRC que comprovam.
export const documentosFamilias = pgTable("documentos_familias", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentoId: uuid("documento_id")
    .notNull()
    .references(() => documentosHabilitacao.id, { onDelete: "cascade" }),
  familiaId: uuid("familia_id")
    .notNull()
    .references(() => familias.id, { onDelete: "cascade" }),
  observacao: text("observacao"),
  criadoEm:   timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_docfam_doc dropado na 0017: prefixo coberto por idx_docfam_unique.
  index("idx_docfam_familia").on(table.familiaId),
  uniqueIndex("idx_docfam_unique").on(table.documentoId, table.familiaId),
]);

// ── DOCUMENTOS × PROJETOS ────────────────────────────────────────────────────
// Vincula um ACT ao projeto/cliente que o originou (1:N — um doc pode aparecer
// em N obras se for atestado consolidado, mas geralmente é 1:1).
export const documentosProjetos = pgTable("documentos_projetos", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentoId: uuid("documento_id")
    .notNull()
    .references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  clienteCnpj:   text("cliente_cnpj"),
  clienteNome:   text("cliente_nome").notNull(),
  projetoNome:   text("projeto_nome").notNull(),
  valorContrato: numeric("valor_contrato", { precision: 18, scale: 2 }),
  periodoInicio: timestamp("periodo_inicio", { withTimezone: true }),
  periodoFim:    timestamp("periodo_fim",    { withTimezone: true }),
  descricaoServico: text("descricao_servico"),

  // Engenheiro responsável (técnico-profissional)
  engenheiroResponsavel: text("engenheiro_responsavel"),
  registroCrea:          text("registro_crea"),
  numeroArt:             text("numero_art"),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_docproj_doc").on(table.documentoId),
  index("idx_docproj_cnpj").on(table.clienteCnpj),
]);

// ── ALERTAS DE VENCIMENTO ────────────────────────────────────────────────────
// Idempotência: garante 1 alerta por (documento, tipo) — evita reenvio.
export const alertasVencimento = pgTable("alertas_vencimento", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentoId: uuid("documento_id")
    .notNull()
    .references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  tipoAlerta:    text("tipo_alerta").$type<TipoAlertaVencimento>().notNull(),
  agendadoPara:  timestamp("agendado_para", { withTimezone: true }),
  enviadoEm:     timestamp("enviado_em",    { withTimezone: true }),
  destinatarios: jsonb("destinatarios").$type<string[]>(),

  criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_alerta_doc dropado na 0017: prefixo coberto por idx_alerta_unique.
  uniqueIndex("idx_alerta_unique").on(table.documentoId, table.tipoAlerta),
  index("idx_alerta_agendado").on(table.agendadoPara),
]);

// ── CONSULTAS DE CERTIDOES (validacao automatica) ────────────────────────────
// Histórico de chamadas a APIs externas (eCAC, FGTS, CNDT...) para validar
// a vigência de cada documento. Permite retry e auditoria.
export const consultasCertidoes = pgTable("consultas_certidoes", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentoId: uuid("documento_id")
    .notNull()
    .references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  fonte:           text("fonte").$type<FonteCertidao>().notNull(),
  tentativaEm:     timestamp("tentativa_em", { withTimezone: true }).defaultNow(),
  sucesso:         boolean("sucesso").notNull().default(false),
  statusCertidao:  text("status_certidao"),
  validadeFimNova: timestamp("validade_fim_nova", { withTimezone: true }),
  payloadResposta: jsonb("payload_resposta"),
  erro:            text("erro"),
}, (table) => [
  index("idx_consc_doc").on(table.documentoId),
  index("idx_consc_fonte").on(table.fonte),
  index("idx_consc_data").on(table.tentativaEm),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: CONFORMIDADE — IMPORTAÇÃO E VIGILÂNCIA OPERACIONAL (SGI)
// ═══════════════════════════════════════════════════════════════════════════

// ── IMPORT JOBS ──────────────────────────────────────────────────────────────
// Histórico de execuções de importação em massa (planilha XLSX ou CLI agent).
export type FonteImport = "PLANILHA" | "CLI" | "API";
export type StatusImport = "EM_ANDAMENTO" | "CONCLUIDO" | "FALHOU" | "CANCELADO";

export const importJobs = pgTable("import_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  fonte: text("fonte").$type<FonteImport>().notNull(),
  iniciadoPor: uuid("iniciado_por").references(() => users.id),

  status: text("status").$type<StatusImport>().notNull().default("EM_ANDAMENTO"),

  totalArquivos: integer("total_arquivos").notNull().default(0),
  processados:   integer("processados").notNull().default(0),
  novos:         integer("novos").notNull().default(0),
  atualizados:   integer("atualizados").notNull().default(0),
  ignorados:     integer("ignorados").notNull().default(0),
  erros:         integer("erros").notNull().default(0),

  // Resumo / log estruturado (lista de itens processados, mensagens)
  payload:    jsonb("payload"),
  observacao: text("observacao"),

  iniciadoEm:   timestamp("iniciado_em",   { withTimezone: true }).defaultNow(),
  finalizadoEm: timestamp("finalizado_em", { withTimezone: true }),
}, (table) => [
  index("idx_import_status").on(table.status),
  index("idx_import_iniciado").on(table.iniciadoEm),
  index("idx_import_user").on(table.iniciadoPor),
]);

// ── AUDIT DOWNLOAD RESTRITO (0035 · P7/D-7) ─────────────────────────────────
// Espelho SEM EXPURGO dos downloads de documento restrito. Sem FK de propósito:
// a linha é prova e sobrevive ao DELETE do usuário e do documento.
// "DOWNLOAD_ANEXO" chegou com S10 (02-APIS §16-B.1): a coluna é text SEM CHECK
// (0035), então o valor novo é compatível sem migration.
export type ViaDownloadRestrito = "DOWNLOAD" | "ZIP_DOSSIE" | "ZIP_SELECAO" | "DOWNLOAD_ANEXO";

export const auditDownloadRestrito = pgTable("audit_download_restrito", {
  id:             uuid("id").primaryKey().defaultRandom(),
  documentoId:    uuid("documento_id").notNull(),   // SEM .references() — de propósito
  titulo:         text("titulo").notNull(),
  operacaoCodigo: text("operacao_codigo"),
  userId:         uuid("user_id").notNull(),        // SEM .references() — de propósito
  userEmail:      text("user_email").notNull(),
  role:           text("role").notNull(),
  via:            text("via").$type<ViaDownloadRestrito>().notNull(),
  criadoEm:       timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_adr_documento").on(table.documentoId),
  index("idx_adr_criado").on(table.criadoEm),
]);

// ── CNPJ STATUS LOG ──────────────────────────────────────────────────────────
// Vigilância contínua do estado cadastral do CNPJ Proponente na Receita Federal.
// Petrobras suspende automaticamente fornecedores com CNPJ irregular.
export type SituacaoCadastralCnpj =
  | "ATIVA"
  | "SUSPENSA"
  | "INAPTA"
  | "BAIXADA"
  | "NULA"
  | "DESCONHECIDA";

export const cnpjStatusLog = pgTable("cnpj_status_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  cnpj: text("cnpj").notNull(),

  situacao:        text("situacao").$type<SituacaoCadastralCnpj>().notNull(),
  motivoSituacao:  text("motivo_situacao"),
  razaoSocial:     text("razao_social"),
  ultimaAtualizacao: timestamp("ultima_atualizacao", { withTimezone: true }),

  // Resposta crua da BrasilAPI (ou de outra fonte)
  // LGPD (auditoria 02/07): payload raw raramente lido. CPF formatado e e-mail são
  // REDIGIDOS no legado pela migration 0016; expurgo por retenção (>2 anos) no
  // worker. Residual: nome_socio (QSA) — ver WP09 (writer do coletor, outra frente).
  fonte:        text("fonte").notNull().default("BrasilAPI"),
  dadosBrutos:  jsonb("dados_brutos"),

  // true se mudou em relação ao último registro do mesmo CNPJ
  mudou:    boolean("mudou").notNull().default(false),
  alertado: boolean("alertado").notNull().default(false),

  checadoEm: timestamp("checado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_cnpj_log_cnpj").on(table.cnpj),
  index("idx_cnpj_log_data").on(table.checadoEm),
  index("idx_cnpj_log_mudou").on(table.mudou),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: CONFORMIDADE — PÓS-VITÓRIA (ENVELOPES + CONTRATOS + IQF)
// ═══════════════════════════════════════════════════════════════════════════

// ── REQUISITOS DE EDITAL ─────────────────────────────────────────────────────
// Materializa os requisitos de habilitação extraídos do edital (via análise IA
// ou cadastrados manualmente). Um requisito pode mapear para 1+ documento.
export type FonteRequisito = "ANALISE_IA" | "MANUAL";

export const requisitosEdital = pgTable("requisitos_edital", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id")
    .notNull()
    .references(() => licitacoes.id, { onDelete: "cascade" }),

  // Código padronizado do requisito (ex.: "CND_FEDERAL", "ISO_9001", "ATESTADO_ACT")
  // Tenta seguir o vocabulário de SubcategoriaDocHab para auto-sugestão
  codigo:    text("codigo").notNull(),
  descricao: text("descricao").notNull(),

  obrigatorio: boolean("obrigatorio").notNull().default(true),
  fonte:       text("fonte").$type<FonteRequisito>().notNull().default("ANALISE_IA"),

  observacao: text("observacao"),
  ordem:      integer("ordem").notNull().default(0),

  // Rastreabilidade da extração estruturada (tool-use/JSON-schema + citação)
  anexoId:      uuid("anexo_id").references(() => anexos.id, { onDelete: "set null" }),
  trechoCitado: text("trecho_citado"),
  confianca:    real("confianca"),

  criadoEm:    timestamp("criado_em",    { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_req_lic").on(table.licitacaoId),
  index("idx_req_codigo").on(table.codigo),
  index("idx_req_anexo").on(table.anexoId),
]);

// ── ENVELOPES DE HABILITAÇÃO ─────────────────────────────────────────────────
// Um envelope por participação ganha. Agrega os documentos a serem entregues
// à Petrobras na fase de assinatura do contrato.
export type StatusEnvelope =
  | "EM_MONTAGEM"   // SGI ainda preenchendo
  | "PRONTO"        // todos itens completos, aguardando protocolo
  | "PROTOCOLADO"   // entregue à Petrobras
  | "EM_ANALISE"    // Petrobras analisando
  | "APROVADO"      // contrato pode ser assinado
  | "REJEITADO";    // pendência apontada pela Petrobras

// Origem do envelope: PARTICIPACAO (vindo do pipeline de licitações) ou
// AVULSO (cadastrado direto pelo SGI sem passar por Participações)
export type OrigemEnvelope = "PARTICIPACAO" | "LICITACAO" | "AVULSO";

export const envelopesHabilitacao = pgTable("envelopes_habilitacao", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Origem do envelope (define como foi criado)
  origem: text("origem").$type<OrigemEnvelope>().notNull().default("PARTICIPACAO"),

  // Vínculos opcionais — só preenchido quando há rastreabilidade
  participacaoId: uuid("participacao_id")
    .references(() => participacoesLicitacao.id, { onDelete: "set null" }),
  licitacaoId: uuid("licitacao_id")
    .references(() => licitacoes.id, { onDelete: "set null" }),

  // Snapshot dos dados do edital (sempre preenchido — evita JOIN obrigatório)
  numeroEdital:       text("numero_edital").notNull(),
  empresaContratante: text("empresa_contratante").notNull().default("Petrobras"),
  objeto:             text("objeto").notNull(),

  status: text("status").$type<StatusEnvelope>().notNull().default("EM_MONTAGEM"),

  // Prazo declarado pela Petrobras pra protocolar o envelope
  prazoProtocolo: timestamp("prazo_protocolo", { withTimezone: true }),

  // Número do contrato (assim que assinado)
  contratoNumero: text("contrato_numero"),
  contratoAssinadoEm: timestamp("contrato_assinado_em", { withTimezone: true }),

  responsavelSgi: uuid("responsavel_sgi").references(() => users.id, { onDelete: "set null" }),

  observacoes:  text("observacoes"),
  motivoRejeicao: text("motivo_rejeicao"),

  // Auditoria
  protocoladoEm: timestamp("protocolado_em", { withTimezone: true }),
  decididoEm:    timestamp("decidido_em",    { withTimezone: true }),

  // ── Carta formal de apresentação ─────────────────────────────────────────
  // Versionamento real fica em envelope_carta_versoes (linked-list);
  // este campo é só cache da versão ativa e a data do documento.
  cartaVersaoAtualId: uuid("carta_versao_atual_id"),
  cartaData:          timestamp("carta_data", { withTimezone: true }),

  criadoEm:    timestamp("criado_em",    { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_env_status").on(table.status),
  index("idx_env_prazo").on(table.prazoProtocolo),
  index("idx_env_resp").on(table.responsavelSgi),
  index("idx_env_contrato").on(table.contratoNumero),
  index("idx_env_origem").on(table.origem),
  index("idx_env_lic").on(table.licitacaoId),
  // Garante 1 envelope por participação (quando houver) — partial unique
  uniqueIndex("idx_env_part_unique").on(table.participacaoId).where(sql`participacao_id IS NOT NULL`),
]);

// ── ENVELOPE ITENS ───────────────────────────────────────────────────────────
// Cada requisito do edital × documento atribuído (ou ainda em falta).
export type StatusItemEnvelope =
  | "PENDENTE"                  // ainda sem documento atribuído
  | "ATRIBUIDO"                 // documento atribuído e válido
  | "VENCIDO"                   // doc atribuído mas vencido
  | "VENCE_ANTES_DO_PROTOCOLO"  // doc vence antes da data de protocolo
  | "SUBSTITUIDO";              // substituído por uma versão mais nova

export const envelopeItens = pgTable("envelope_itens", {
  id: uuid("id").primaryKey().defaultRandom(),

  envelopeId: uuid("envelope_id")
    .notNull()
    .references(() => envelopesHabilitacao.id, { onDelete: "cascade" }),
  requisitoId: uuid("requisito_id")
    .notNull()
    .references(() => requisitosEdital.id, { onDelete: "cascade" }),

  // Documento atribuído ao requisito (pode ser null em PENDENTE)
  documentoId: uuid("documento_id").references(() => documentosHabilitacao.id, { onDelete: "set null" }),

  status: text("status").$type<StatusItemEnvelope>().notNull().default("PENDENTE"),

  // Auto-sugestão: quão confiante o sistema está no match doc → requisito (0..1)
  scoreSugestao: real("score_sugestao"),

  observacao: text("observacao"),

  // Quem atribuiu
  atribuidoPor: uuid("atribuido_por").references(() => users.id, { onDelete: "set null" }),
  atribuidoEm:  timestamp("atribuido_em", { withTimezone: true }),

  criadoEm:    timestamp("criado_em",    { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_env_item_env").on(table.envelopeId),
  index("idx_env_item_req").on(table.requisitoId),
  index("idx_env_item_doc").on(table.documentoId),
  index("idx_env_item_status").on(table.status),
]);

// ── CARTA DE APRESENTAÇÃO (versionada) ───────────────────────────────────────
// Cada SAVE gera uma nova versão. A versão ativa é sempre a maior `versao`
// (também cacheada em envelopesHabilitacao.cartaVersaoAtualId).
// Histórico permanente — sem trim.
export interface SignatarioCarta {
  ordem:   number;
  nome:    string;
  cargo:   string;
  // LGPD (auditoria 02/07): grave SEMPRE MASCARADO — só os 2 últimos dígitos, no
  // formato "***.***.***-XX". O CPF completo NÃO é necessário para o negócio (a
  // feature de render da carta foi removida). Um eventual writer futuro deve
  // aplicar a máscara na ORIGEM; dados legados são mascarados pela migration
  // 0016. NÃO persistir CPF em claro. (Se algum dia for preciso o CPF completo
  // para gerar carta oficial, cifrar com pgcrypto/APP_CRYPTO_KEY em vez de mascarar.)
  cpf?:    string;            // MASCARADO: "***.***.***-XX"
  userId?: string;            // quando interno; snapshot de nome/cargo na hora de salvar
  email?:  string;
  externo: boolean;
}

export const envelopeCartaVersoes = pgTable("envelope_carta_versoes", {
  id:         uuid("id").primaryKey().defaultRandom(),
  envelopeId: uuid("envelope_id")
    .notNull()
    .references(() => envelopesHabilitacao.id, { onDelete: "cascade" }),
  versao:     integer("versao").notNull(),

  destinatario: text("destinatario").notNull(),
  referencia:   text("referencia"),
  assunto:      text("assunto").notNull(),
  vocativo:     text("vocativo").notNull().default("Prezados Senhores,"),
  corpo:        text("corpo").notNull(),
  fecho:        text("fecho").notNull().default("Atenciosamente,"),

  signatarios:  jsonb("signatarios").$type<SignatarioCarta[]>().notNull().default([]),

  motivoRevisao: text("motivo_revisao"),

  criadoPor: uuid("criado_por").references(() => users.id, { onDelete: "set null" }),
  criadoEm:  timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_carta_env dropado na 0017: prefixo coberto por idx_carta_env_versao (UNIQUE).
  uniqueIndex("idx_carta_env_versao").on(table.envelopeId, table.versao),
]);

// ── DOCUMENTOS EXTRAS DO ENVELOPE ─────────────────────────────────────────────
// Documentos do cofre anexados ao envelope ALÉM dos requisitos do edital.
// Tipicamente: declarações, procurações, atestados complementares.
// No ZIP final entram em "99_extras/".
export const envelopeDocumentosExtras = pgTable("envelope_documentos_extras", {
  id:         uuid("id").primaryKey().defaultRandom(),
  envelopeId: uuid("envelope_id")
    .notNull()
    .references(() => envelopesHabilitacao.id, { onDelete: "cascade" }),
  documentoId: uuid("documento_id")
    .notNull()
    .references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  ordem:      integer("ordem").notNull().default(0),
  observacao: text("observacao"),

  adicionadoPor: uuid("adicionado_por").references(() => users.id),
  adicionadoEm:  timestamp("adicionado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_envextras_env dropado na 0017: prefixo coberto por idx_envextras_env_doc (UNIQUE).
  index("idx_envextras_doc").on(table.documentoId),
  uniqueIndex("idx_envextras_env_doc").on(table.envelopeId, table.documentoId),
]);

// ── CONTRATOS EM EXECUÇÃO ────────────────────────────────────────────────────
// Após envelope APROVADO e contrato assinado, vira um registro vivo.
// Acompanha vencimentos durante toda a execução do contrato.
export type StatusSaudeContrato = "OK" | "ATENCAO" | "CRITICO";
export type StatusContrato = "ATIVO" | "ENCERRADO" | "RESCINDIDO" | "SUSPENSO";

export const contratosExecucao = pgTable("contratos_execucao", {
  id: uuid("id").primaryKey().defaultRandom(),

  numero:        text("numero").notNull().unique(),
  editalNumero:  text("edital_numero"),
  participacaoId: uuid("participacao_id").references(() => participacoesLicitacao.id, { onDelete: "set null" }),
  envelopeId:    uuid("envelope_id").references(() => envelopesHabilitacao.id, { onDelete: "set null" }),

  objeto:    text("objeto").notNull(),
  empresaContratante: text("empresa_contratante").notNull().default("Petrobras"),

  periodoInicio: timestamp("periodo_inicio", { withTimezone: true }).notNull(),
  periodoFim:    timestamp("periodo_fim",    { withTimezone: true }).notNull(),

  valorContratado: numeric("valor_contratado", { precision: 18, scale: 2 }),

  status:       text("status").$type<StatusContrato>().notNull().default("ATIVO"),
  statusSaude:  text("status_saude").$type<StatusSaudeContrato>().notNull().default("OK"),
  iqfAtual:     real("iqf_atual"), // último IQF apurado (0..100)

  // Documentos que precisam estar válidos durante a execução do contrato
  // (snapshot dos requisitos do envelope, com cobertura recalculada por cron)
  documentosObrigatorios: jsonb("documentos_obrigatorios").$type<{
    requisitoCodigo: string;
    documentoId: string | null;
    venceEm: string | null;
    cobreContrato: boolean;
  }[]>(),

  responsavelSgi: uuid("responsavel_sgi").references(() => users.id, { onDelete: "set null" }),

  observacoes: text("observacoes"),

  criadoEm:    timestamp("criado_em",    { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  // idx_contrato_numero dropado na 0017: duplicata da UNIQUE constraint
  // contratos_execucao_numero_unique (via .unique() da coluna).
  index("idx_contrato_status").on(table.status),
  index("idx_contrato_saude").on(table.statusSaude),
  index("idx_contrato_periodo_fim").on(table.periodoFim),
  index("idx_contrato_resp").on(table.responsavelSgi),
]);

// ── IQF AVALIAÇÕES ───────────────────────────────────────────────────────────
// Histórico de Índice de Qualidade do Fornecedor (IQF) por contrato/período.
// Importação manual (Petrobras não tem API) — útil pra acompanhar tendência.
export type ClassificacaoIqf = "OTIMO" | "BOM" | "REGULAR" | "RUIM" | "CRITICO";

export const iqfAvaliacoes = pgTable("iqf_avaliacoes", {
  id: uuid("id").primaryKey().defaultRandom(),

  contratoId: uuid("contrato_id")
    .notNull()
    .references(() => contratosExecucao.id, { onDelete: "cascade" }),

  // Período de referência (ex.: 2025-Q4)
  periodoRef: text("periodo_ref").notNull(),

  indice:         real("indice").notNull(), // 0..100
  classificacao:  text("classificacao").$type<ClassificacaoIqf>(),

  observacoes: text("observacoes"),
  // PDF/print do relatório oficial (opcional)
  blobUrl:     text("blob_url"),
  blobKey:     text("blob_key"),

  registradoPor: uuid("registrado_por").references(() => users.id, { onDelete: "set null" }),
  registradoEm:  timestamp("registrado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_iqf_contrato").on(table.contratoId),
  index("idx_iqf_periodo").on(table.periodoRef),
]);


// ──────────────────────────────────────────────────────────────────────
// PETRONECT V2 — pipeline novo de extração via UI/OData públicos
// (independente do pipeline antigo de coleta; sem login)
// ──────────────────────────────────────────────────────────────────────

/**
 * petronect_lic_andamento — header detalhado de licitação obtido via
 * YPCON_GET_PUB_LIC_IN_PROGRESS_SRV/GETLISTLICITINPROGRESSSet
 * (33 campos do endpoint público que a UI consulta na busca individual).
 *
 * Uma linha por número de licitação. Cada execução do scraper faz UPSERT.
 * Mudanças relevantes geram entrada em petronect_lic_eventos.
 */
export const petronectLicAndamento = pgTable("petronect_lic_andamento", {
  numero: text("numero").primaryKey(),

  // Modo da disputa: '01' aberta | '02' fechada | '03' pregão
  disputeMode: text("dispute_mode").notNull(),

  // Status alto-nível (I1011=Publicado, I1013=Em Disputa, I1016=Concluído ...)
  status:      text("status"),
  statusDesc:  text("status_desc"),

  // Sub-status granular: '01' Aguardando Lance, '02' Aberto Lance,
  //                      '04' Análise Propostas, '05' Resultado Divulgado
  subStatus:   text("sub_status"),

  opportType:  text("opport_type"),       // ex: 'LIDT'
  company:     text("company"),           // código (ex: '1000' Petrobras)
  companyDesc: text("company_desc"),

  opportDescr:     text("opport_descr"),
  descObjContrat:  text("desc_obj_contrat"),

  postingDate:   text("posting_date"),
  douPublDate:   text("dou_publ_date"),
  douNum:        text("dou_num"),
  startDate:     text("start_date"),
  startHour:     text("start_hour"),
  endDate:       text("end_date"),
  endHour:       text("end_hour"),
  openDate:      text("open_date"),
  openHour:      text("open_hour"),
  aucStartDate:  text("auc_start_date"),
  aucStartTime:  text("auc_start_time"),
  pqVendorListDate: text("pq_vendor_list_date"),
  pqVendorListHour: text("pq_vendor_list_hour"),

  isEqualized:     boolean("is_equalized").default(false),
  hasPrequalified: boolean("has_prequalified").default(false),
  isPrequali:      boolean("is_prequali").default(false),
  limitInDays:     integer("limit_in_days").default(0),
  natCoverage:     text("nat_coverage"),

  // Listas: regiões + payload completo (rastreabilidade/replay)
  regions:     jsonb("regions").$type<string[]>().default([]),
  rawPayload:  jsonb("raw_payload"), // dump completo do TAB[0] do OData

  capturedAt:  timestamp("captured_at", { withTimezone: true }).defaultNow(),
  updatedAt:   timestamp("updated_at",  { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_petronect_andamento_dispute").on(table.disputeMode),
  index("idx_petronect_andamento_substatus").on(table.subStatus),
  index("idx_petronect_andamento_status").on(table.status),
  index("idx_petronect_andamento_captured").on(table.capturedAt),
]);

/**
 * petronect_lic_items — items/lotes da licitação (campo ITEMS do header).
 * Re-sincronizado a cada coleta; chave única (numero, item_num).
 */
export const petronectLicItems = pgTable("petronect_lic_items", {
  id: uuid("id").primaryKey().defaultRandom(),

  numero: text("numero").notNull()
    .references(() => petronectLicAndamento.numero, { onDelete: "cascade" }),

  itemNum:         text("item_num").notNull(),
  exlin:           text("exlin"),                // sub-lote (ex: '8001.AA')
  itemDesc:        text("item_desc"),
  unit:            text("unit"),                 // 'LE', 'ST', ...
  quantity:        numeric("quantity", { precision: 18, scale: 4 }),
  delivDate:       text("deliv_date"),
  groupingLevel:   text("grouping_level"),
  itemProcessTyp:  text("item_process_typ"),     // 'OUTL', 'SERVICE'
  family:          text("family"),
  familyDescr:     text("family_descr"),
  numMaterial:     text("num_material"),
  familyClassif:   text("family_classif"),
  itemNotes:       jsonb("item_notes").$type<unknown[]>().default([]),

  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("uq_petronect_item_numero_itemnum").on(table.numero, table.itemNum),
  index("idx_petronect_item_family").on(table.family),
]);

/**
 * petronect_lic_anexos — anexos disponíveis no portal para esta licitação,
 * incluindo adendos publicados pós-edital. PHIO_OBJID identifica o blob
 * para download via YPCON_PUB_ATTACHMENT_DOWNLOAD_SRV.
 */
export const petronectLicAnexos = pgTable("petronect_lic_anexos", {
  id: uuid("id").primaryKey().defaultRandom(),

  numero: text("numero").notNull()
    .references(() => petronectLicAndamento.numero, { onDelete: "cascade" }),

  description: text("description").notNull(),
  phioObjid:   text("phio_objid").notNull(),

  // Quando este anexo foi visto pela primeira vez e a última
  detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("uq_petronect_anexo_numero_phio").on(table.numero, table.phioObjid),
]);

/**
 * petronect_lic_propostas — propostas individuais obtidas via
 * YPCON_PUB_HISTORIC_SRV/historyCollection (QUOTATION_LIST).
 * O campo CHARACTERISTIC é a fonte da verdade sobre o vencedor:
 *   'Awarded'                          → vencedor oficial
 *   'Featured Quotation'               → concorrente classificado
 *   'Did Not Present'                  → não apresentou
 *   'Desclassification - ...'          → desclassificado
 *
 * Re-sincronizado a cada coleta (delete-and-insert por número).
 */
export const petronectLicPropostas = pgTable("petronect_lic_propostas", {
  id: uuid("id").primaryKey().defaultRandom(),

  numero: text("numero").notNull()
    .references(() => petronectLicAndamento.numero, { onDelete: "cascade" }),

  itemNumeroInt: text("item_numero_int"),  // NUMBER_INT (ex '8001')
  itemDescricao: text("item_descricao"),

  cnpj:        text("cnpj"),
  fornecedor:  text("fornecedor"),
  meEpp:       boolean("me_epp").default(false),

  unitValue:   numeric("unit_value",  { precision: 18, scale: 2 }),
  totalValue:  numeric("total_value", { precision: 18, scale: 2 }),
  quantity:    numeric("quantity",    { precision: 18, scale: 4 }),

  characteristic: text("characteristic"),   // 'Awarded' | 'Featured Quotation' | ...
  declinou:       boolean("declinou").default(false),

  dataProposta: text("data_proposta"),
  posicao:      integer("posicao"),

  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_petronect_proposta_numero").on(table.numero),
  index("idx_petronect_proposta_cnpj").on(table.cnpj),
  index("idx_petronect_proposta_characteristic").on(table.characteristic),
]);

/**
 * petronect_lic_resultado — consolidação por licitação: vencedor + stats.
 * Calculado a partir das propostas a cada sync.
 */
export const petronectLicResultado = pgTable("petronect_lic_resultado", {
  numero: text("numero").primaryKey()
    .references(() => petronectLicAndamento.numero, { onDelete: "cascade" }),

  cnpjVencedor:       text("cnpj_vencedor"),
  fornecedorVencedor: text("fornecedor_vencedor"),
  valorVencedor:      numeric("valor_vencedor", { precision: 18, scale: 2 }),

  totalParticipantes: integer("total_participantes").default(0),
  totalPropostas:     integer("total_propostas").default(0),
  menorValor:         numeric("menor_valor", { precision: 18, scale: 2 }),
  maiorValor:         numeric("maior_valor", { precision: 18, scale: 2 }),

  // Label humano do detector ('Homologada (oficial)', 'Adjudicada (explícita)',
  // 'Classificação Oficial', 'Classificação por Lote', 'Aguardando definição (em curso)')
  statusResultado: text("status_resultado"),

  // Confiança categórica derivada do status_resultado:
  //   'OFFICIAL' — Homologada/Adjudicada explícita (alta confiança)
  //   'RANKED'   — ORDERED_CLASS_TOTAL ou LOTE (média confiança)
  //   'PENDING'  — sem vencedor, licitação em curso
  confidenceLevel: text("confidence_level").$type<"OFFICIAL" | "RANKED" | "PENDING">(),

  detectadoEm:  timestamp("detectado_em",  { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_petronect_resultado_cnpj").on(table.cnpjVencedor),
]);

/**
 * petronect_lic_eventos — change log entre snapshots.
 * Cada mudança detectada no Change Detector vira uma linha aqui.
 */
export const petronectLicEventos = pgTable("petronect_lic_eventos", {
  id: uuid("id").primaryKey().defaultRandom(),

  numero: text("numero").notNull()
    .references(() => petronectLicAndamento.numero, { onDelete: "cascade" }),

  // 'status_changed' | 'sub_status_changed' | 'winner_revealed' |
  // 'winner_changed' | 'document_added' | 'document_removed' |
  // 'ranking_changed' | 'price_revised'
  tipo:  text("tipo").notNull(),
  campo: text("campo"),

  valorAnterior: text("valor_anterior"),
  valorNovo:     text("valor_novo"),

  payload: jsonb("payload"),  // dados auxiliares (ex: lista de docs adicionados)

  detectadoEm: timestamp("detectado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_petronect_evento_numero").on(table.numero),
  index("idx_petronect_evento_tipo").on(table.tipo),
  index("idx_petronect_evento_data").on(table.detectadoEm),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: PETITÓRIOS (Esclarecimentos / Impugnações / Recursos / Contrarrazões)
// ═══════════════════════════════════════════════════════════════════════════

export type TipoPetitorio =
  | "ESCLARECIMENTO"
  | "IMPUGNACAO"
  | "RECURSO"
  | "CONTRARRAZAO";

export type StatusPetitorio =
  | "RASCUNHO"
  | "PROTOCOLADO"
  | "DEFERIDO"
  | "INDEFERIDO"
  | "PARCIAL";

// ── PETITÓRIOS DA LICITAÇÃO ──────────────────────────────────────────────────
// Petições do fluxo de licitação com prazo-limite fatal, status, fundamentação,
// anexo no R2 e resposta da Petrobras. Prazos alimentam o cron de prazos.
export const petitoriosLicitacao = pgTable("petitorios_licitacao", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id")
    .notNull()
    .references(() => licitacoes.id, { onDelete: "cascade" }),
  participacaoId: uuid("participacao_id")
    .references(() => participacoesLicitacao.id, { onDelete: "set null" }),

  tipo:   text("tipo").$type<TipoPetitorio>().notNull(),
  status: text("status").$type<StatusPetitorio>().notNull().default("RASCUNHO"),

  prazoLimite:   timestamp("prazo_limite",   { withTimezone: true }),
  protocoladoEm: timestamp("protocolado_em", { withTimezone: true }),

  fundamentacao: text("fundamentacao"),

  // Anexo no R2 (minuta protocolada / comprovante)
  blobKey: text("blob_key"),
  blobUrl: text("blob_url"),

  // Resposta/decisão da Petrobras
  resposta: text("resposta"),

  autorId:   uuid("autor_id").references(() => users.id, { onDelete: "set null" }),
  criadoEm:  timestamp("criado_em",   { withTimezone: true }).defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_petit_lic").on(table.licitacaoId),
  index("idx_petit_part").on(table.participacaoId),
  index("idx_petit_status").on(table.status),
  index("idx_petit_prazo").on(table.prazoLimite),
]);

// ── HISTÓRICO DE PETITÓRIOS (trilha de auditoria) ────────────────────────────
export const petitoriosHistorico = pgTable("petitorios_historico", {
  id: uuid("id").primaryKey().defaultRandom(),
  petitorioId: uuid("petitorio_id")
    .notNull()
    .references(() => petitoriosLicitacao.id, { onDelete: "cascade" }),
  acao:     text("acao").notNull(),
  detalhes: jsonb("detalhes"),
  usuarioId: uuid("usuario_id").references(() => users.id, { onDelete: "set null" }),
  criadoEm:  timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_petit_hist_petit").on(table.petitorioId),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: GAP DE HABILITAÇÃO INTELIGENTE (edital × cofre × CRC)
// ═══════════════════════════════════════════════════════════════════════════

export type StatusCobertura =
  | "ATENDIDO"
  | "PARCIAL"
  | "FALTANTE"
  | "VENCE_ANTES_DA_DATA";

export type MetodoMatchGap = "CODIGO" | "IA";

// Resultado materializado do cruzamento requisito-do-edital × cobertura real
// (cofre/CRC). Recalculável por cron e on-demand; alimenta o semáforo da licitação.
export const gapHabilitacao = pgTable("gap_habilitacao", {
  id: uuid("id").primaryKey().defaultRandom(),
  licitacaoId: uuid("licitacao_id")
    .notNull()
    .references(() => licitacoes.id, { onDelete: "cascade" }),
  requisitoId: uuid("requisito_id")
    .references(() => requisitosEdital.id, { onDelete: "cascade" }),
  requisitoCodigo: text("requisito_codigo"),

  statusCobertura: text("status_cobertura").$type<StatusCobertura>().notNull(),

  documentoId: uuid("documento_id")
    .references(() => documentosHabilitacao.id, { onDelete: "set null" }),
  familiaId: uuid("familia_id")
    .references(() => familias.id, { onDelete: "set null" }),

  venceEm:       timestamp("vence_em", { withTimezone: true }),
  metodoMatch:   text("metodo_match").$type<MetodoMatchGap>(),
  confianca:     real("confianca"),
  justificativa: text("justificativa"),
  calculadoEm:   timestamp("calculado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_gaphab_lic").on(table.licitacaoId),
  index("idx_gaphab_req").on(table.requisitoId),
  index("idx_gaphab_status").on(table.statusCobertura),
  // FK quente (0017): DELETE de documento do cofre faz SET NULL aqui — sem
  // índice, cada exclusão varre a tabela inteira.
  index("idx_gaphab_doc").on(table.documentoId),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: IMPACTO DE CIRCULARES (avaliação IA por circular)
// ═══════════════════════════════════════════════════════════════════════════

// Persiste a avaliação de impacto IA por circular (idempotente por circular_id),
// evitando re-classificar; exibe diff/ação recomendada na timeline.
export const circularesImpacto = pgTable("circulares_impacto", {
  id: uuid("id").primaryKey().defaultRandom(),
  circularId: uuid("circular_id")
    .notNull()
    .references(() => circulares.id, { onDelete: "cascade" }),
  licitacaoId: uuid("licitacao_id")
    .notNull()
    .references(() => licitacoes.id, { onDelete: "cascade" }),

  impacto: text("impacto").$type<ImpactoCircular>().notNull(),
  resumo:  text("resumo"),
  requisitosNovos:   jsonb("requisitos_novos"),
  acaoRecomendada:   text("acao_recomendada"),
  reorcamentoSugerido: boolean("reorcamento_sugerido").notNull().default(false),
  modeloUsado: text("modelo_usado"),
  avaliadoEm:  timestamp("avaliado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_circimp_lic").on(table.licitacaoId),
  uniqueIndex("uniq_circimp_circular").on(table.circularId),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: RAG ACERVO (pgvector)
// ═══════════════════════════════════════════════════════════════════════════

export type OrigemAcervo = "ANEXO_EDITAL" | "DOC_HABILITACAO" | "PROJETO";

// Dimensão do embedding — on-prem BGE-m3 (local/TEI) = 1024.
// Migração 0015 converte a coluna acervo_chunks.embedding de 1536→1024.
export const ACERVO_EMBEDDING_DIM = 1024;

// Chunks de texto do acervo (editais, docs habilitação, projetos) com embedding
// pgvector e metadata para retrieval semântico filtrável. Base do RAG.
export const acervoChunks = pgTable("acervo_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  origemTipo: text("origem_tipo").$type<OrigemAcervo>().notNull(),
  origemId:   uuid("origem_id").notNull(),
  licitacaoId: uuid("licitacao_id")
    .references(() => licitacoes.id, { onDelete: "set null" }),
  chunkIndex: integer("chunk_index").notNull().default(0),
  texto:      text("texto").notNull(),
  embedding:  vector("embedding", { dimensions: ACERVO_EMBEDDING_DIM }),
  metadata:   jsonb("metadata"),
  indexadoEm: timestamp("indexado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_acervo_origem").on(table.origemTipo, table.origemId),
  index("idx_acervo_lic").on(table.licitacaoId),
  // Índice HNSW criado na migration via SQL bruto (drizzle não modela hnsw/vector_cosine_ops)
]);

// Idempotência da indexação por fonte (texto_hash + modelo_embedding) para o
// cron reindexar só o que mudou e respeitar o budget de embeddings.
export const acervoIndexLog = pgTable("acervo_index_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  origemTipo: text("origem_tipo").notNull(),
  origemId:   uuid("origem_id").notNull(),
  textoHash:  text("texto_hash").notNull(),
  modeloEmbedding: text("modelo_embedding").notNull(),
  chunksGerados:   integer("chunks_gerados").notNull().default(0),
  indexadoEm: timestamp("indexado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("uniq_acervo_log").on(table.origemTipo, table.origemId, table.modeloEmbedding),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: ACERVO — DISCIPLINAS (migration 0043)
// ═══════════════════════════════════════════════════════════════════════════
// A disciplina técnica pela qual o edital escreve a exigência ("atestado de
// montagem de TUBULAÇÃO", "acervo em INSTRUMENTAÇÃO"). Catálogo de LINHA, não
// enum: não há tupla espelho no TS nem CHECK no banco — o rótulo vem daqui, e
// acrescentar disciplina é acrescentar tupla no seed.

export const disciplinas = pgTable("disciplinas", {
  id: uuid("id").primaryKey().defaultRandom(),

  codigo: text("codigo").notNull().unique(),  // 'TUB', 'EST', 'INS'
  nome:   text("nome").notNull(),             // rótulo de tela — vem do banco
  ordem:  integer("ordem").notNull().default(0),
  // `ativo` em vez de DELETE: disciplina em desuso continua referenciada pelo
  // histórico.
  ativo:  boolean("ativo").notNull().default(true),
});

// Quais disciplinas a OBRA teve. PK composta — o par é a linha inteira.
// CASCADE nos dois lados: sem a operação ou sem a disciplina, a linha não diz
// nada (diferente de `documentosHabilitacao.disciplinaId`, que é SET NULL: lá
// o documento continua provando o que provava, só perde o rótulo).
export const operacaoDisciplinas = pgTable("operacao_disciplinas", {
  operacaoId:   uuid("operacao_id").notNull().references(() => operacoes.id, { onDelete: "cascade" }),
  disciplinaId: uuid("disciplina_id").notNull().references(() => disciplinas.id, { onDelete: "cascade" }),
  criadoEm:     timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.operacaoId, table.disciplinaId] }),
  // O lado esquerdo da PK já resolve "as disciplinas desta operação"; este
  // índice resolve o contrário — a cobertura por disciplina (C3) e o filtro da
  // tela de operações.
  index("idx_opdisc_disciplina").on(table.disciplinaId),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: ACERVO — PROFISSIONAIS E ATIVIDADES (migration 0043)
// ═══════════════════════════════════════════════════════════════════════════
// O responsável técnico como ENTIDADE (hoje: três colunas de texto livre em
// `documentosProjetos`) e o que a ART lista.
//
// ⚠️ `participacoesLicitacao.responsavelTecnico -> users` (l. ~429) NÃO é isto:
// lá é o usuário do sistema que acompanha a licitação; aqui é o profissional
// que assina a ART e cujo acervo habilita a empresa.

/** Papel do PROFISSIONAL no documento — não confundir com `documentosHabilitacao.papel`. */
export type PapelProfissional = "RT" | "CORRESPONSAVEL" | "EQUIPE";

// SEM CPF de propósito: `lib/seguranca/pii.ts` redige CPF do `ocrTexto` antes
// de gravar e o BFF espelha — guardar CPF aqui contrariaria a política do
// próprio módulo. O CREA identifica para efeito de habilitação.
export const profissionais = pgTable("profissionais", {
  id: uuid("id").primaryKey().defaultRandom(),

  nome:     text("nome").notNull(),
  crea:     text("crea"),
  creaUf:   text("crea_uf"),
  formacao: text("formacao"),
  ativo:    boolean("ativo").notNull().default(true),

  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  // Sem trigger no banco: todo UPDATE seta atualizadoEm = new Date() na mão.
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // A chave de deduplicação: uma pessoa, um CREA. PARCIAL porque profissional
  // sem registro informado é caso frequente e N linhas com crea NULL convivem.
  uniqueIndex("uniq_profissional_crea").on(table.crea).where(sql`${table.crea} IS NOT NULL`),
  // Busca por nome na tela, sem depender de caixa.
  index("idx_profissional_nome").on(sql`lower(${table.nome})`),
]);

// Qual documento cada profissional assina, e COMO. `numeroArt` mora aqui (e
// não só em `documentosProjetos`) porque a ART é do PAR: dois corresponsáveis
// do mesmo atestado têm números diferentes.
export const profissionalDocumentos = pgTable("profissional_documentos", {
  id: uuid("id").primaryKey().defaultRandom(),

  profissionalId: uuid("profissional_id").notNull().references(() => profissionais.id, { onDelete: "cascade" }),
  documentoId:    uuid("documento_id").notNull().references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  papel:     text("papel").$type<PapelProfissional>().notNull().default("RT"),
  numeroArt: text("numero_art"),

  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Um profissional aparece UMA vez por documento — trocar o papel é UPDATE,
  // não segunda linha. É o árbitro do ON CONFLICT do backfill da 0043.
  uniqueIndex("uniq_profdoc").on(table.profissionalId, table.documentoId),
  index("idx_profdoc_documento").on(table.documentoId),
]);

// O que a ART LISTA.
//
// POR QUE `quantidadeTexto` é TEXTO e não numeric + unidade: a quantidade é
// evidência literal ("3.600,00 HH"), exibida e nunca somada.
export const documentoAtividades = pgTable("documento_atividades", {
  id: uuid("id").primaryKey().defaultRandom(),

  documentoId: uuid("documento_id").notNull().references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  atividade:       text("atividade").notNull(),
  quantidadeTexto: text("quantidade_texto"),

  ordem:    integer("ordem").notNull().default(0),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),

}, (table) => [
  index("idx_docativ_doc").on(table.documentoId, table.ordem),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: ACERVO — ANOTAÇÕES E ITENS TAGUEADOS (migration 0044)
// ═══════════════════════════════════════════════════════════════════════════
// O que uma pessoa quer dizer sobre uma coisa do acervo (B7) e o equipamento
// com TAG que o documento lista.

/** Alvo de uma anotação. Fechado no banco por `chk_anot_alvo` (0044). */
export type AlvoAnotacao = "OPERACAO" | "DOCUMENTO" | "PROFISSIONAL";

// Anotação livre. `documentosFamilias.observacao` continua existindo e é outra
// coisa (observação DO VÍNCULO documento × família); `auditLog` continua sendo
// só trilha — tem expurgo de 12 meses (0035) e por isso não serve de anotação.
export const acervoAnotacoes = pgTable("acervo_anotacoes", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Alvo POLIMÓRFICO: o par (tipo, id) sem FK, no molde de
  // `auditDownloadRestrito` (0035). O preço está declarado na migration —
  // não há CASCADE, e anotação de alvo apagado fica órfã (nunca aparece na
  // tela, porque toda listagem parte de um alvo que acabou de ser carregado).
  alvoTipo: text("alvo_tipo").$type<AlvoAnotacao>().notNull(),
  alvoId:   uuid("alvo_id").notNull(),

  autorId: uuid("autor_id").references(() => users.id, { onDelete: "set null" }),
  // Desnormalizado de propósito: `users.nome` é NULLABLE (l. 88) e o usuário
  // pode ser desligado. Quem grava usa `nome ?? email`.
  autorNome: text("autor_nome").notNull(),

  // Já REDIGIDO (`redigirPii`) pela rota, antes do INSERT — a mesma regra do
  // `ocrTexto`, aplicada na ESCRITA porque aqui a fonte somos nós.
  texto: text("texto").notNull(),

  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  // Sem trigger no banco: todo UPDATE seta na mão. NULL enquanto nunca editada.
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }),
  // NULL = aberta. Resolver é UPDATE, nunca DELETE.
  resolvidaEm:  timestamp("resolvida_em", { withTimezone: true }),
}, (table) => [
  // A única consulta que existe: as anotações deste alvo, da mais recente para
  // a mais antiga — WHERE + ORDER BY resolvidos pelo mesmo índice.
  // ⚠️ Sem `desc()` aqui de propósito: o sentido DESC vive na migration, que é
  // quem cria o índice. Este arquivo declara tabelas, não consultas, e importa
  // de drizzle-orm apenas o helper de SQL bruto (l. 8) — a diferença de sentido
  // não muda plano de execução (o Postgres percorre o índice nos dois sentidos)
  // e não vale um import novo. NÃO importe `desc` aqui.
  index("idx_anot_alvo").on(table.alvoTipo, table.alvoId, table.criadoEm),
]);

// O equipamento com TAG que o documento lista (mínimo).
//
// ⚠️ NÃO confundir com `documentosHabilitacao.tags` (jsonb): aquilo é rótulo
// livre de arquivamento do ARQUIVO; isto é inventário de EQUIPAMENTO citado
// dentro dele. Sem quantidade numérica: é inventário, não soma de obra.
export const documentoItensTag = pgTable("documento_itens_tag", {
  id: uuid("id").primaryKey().defaultRandom(),

  documentoId: uuid("documento_id").notNull().references(() => documentosHabilitacao.id, { onDelete: "cascade" }),

  tag:       text("tag").notNull(),   // 'P-101 A/B', 'TQ-4210'
  descricao: text("descricao"),
  // Material, diâmetro, classe, spec — chave/valor livre.
  especificacao: jsonb("especificacao").$type<Record<string, string>>(),

  ordem:    integer("ordem").notNull().default(0),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // A mesma TAG não entra duas vezes no mesmo documento. É também o caminho de
  // "os itens deste documento" (a coluna líder é `documentoId`), por isso não
  // há índice separado por documento.
  uniqueIndex("uniq_docitem_tag").on(table.documentoId, sql`upper(btrim(${table.tag}))`),
]);

// ═══════════════════════════════════════════════════════════════════════════
// MÓDULO: API PÚBLICA v1 + WEBHOOKS (HMAC) + WEB PUSH
// ═══════════════════════════════════════════════════════════════════════════

// Chaves de API com hash bcrypt e escopos para acesso programático externo.
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  prefixo:  text("prefixo").notNull().unique(),
  keyHash:  text("key_hash").notNull(),
  escopos:  jsonb("escopos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  nome:     text("nome").notNull(),
  ativo:    boolean("ativo").notNull().default(true),
  ultimoUsoEm: timestamp("ultimo_uso_em", { withTimezone: true }),
  criadoPor:   uuid("criado_por").references(() => users.id, { onDelete: "set null" }),
  criadoEm:    timestamp("criado_em",  { withTimezone: true }).defaultNow(),
  revogadoEm:  timestamp("revogado_em", { withTimezone: true }),
}, (table) => [
  // uniq_apikey_prefixo dropado na 0017: duplicata exata da UNIQUE constraint
  // api_keys_prefixo_unique (via .unique() da coluna prefixo).
  index("idx_apikey_ativo").on(table.ativo),
]);

// Assinaturas de eventos para POST HMAC-assinado a N destinos.
export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  url:        text("url").notNull(),
  secretHmac: text("secret_hmac").notNull(),
  eventos:    jsonb("eventos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  filtroPerfil: jsonb("filtro_perfil"),
  ativo:      boolean("ativo").notNull().default(true),
  ultimaEntregaEm:  timestamp("ultima_entrega_em", { withTimezone: true }),
  ultimoStatusHttp: integer("ultimo_status_http"),
  criadoEm:   timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_websub_ativo").on(table.ativo),
]);

// Inscrições Web Push (VAPID) por usuário/dispositivo.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  usuarioId: uuid("usuario_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  endpoint:  text("endpoint").notNull(),
  p256dh:    text("p256dh").notNull(),
  auth:      text("auth").notNull(),
  userAgent: text("user_agent"),
  ultimoEnvioEm: timestamp("ultimo_envio_em", { withTimezone: true }),
  criadoEm:  timestamp("criado_em", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("uniq_push_endpoint").on(table.endpoint),
  index("idx_push_user").on(table.usuarioId),
]);


// ── TYPES ──
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Licitacao = typeof licitacoes.$inferSelect;
export type Item = typeof itens.$inferSelect;
export type Anexo = typeof anexos.$inferSelect;
export type AnaliseIa = typeof analisesIa.$inferSelect;
export type PerfilInteresse = typeof perfisInteresse.$inferSelect;
export type HistoricoAlteracao = typeof historicoAlteracoes.$inferSelect;
export type Circular = typeof circulares.$inferSelect;
export type NewCircular = typeof circulares.$inferInsert;

// Tipos do módulo de Participações
export type ParticipacaoLicitacao    = typeof participacoesLicitacao.$inferSelect;
export type NewParticipacaoLicitacao = typeof participacoesLicitacao.$inferInsert;
export type ParticipacaoDocumento    = typeof participacoesDocumentos.$inferSelect;
export type NewParticipacaoDocumento = typeof participacoesDocumentos.$inferInsert;
export type ParticipacaoHistorico    = typeof participacoesHistorico.$inferSelect;
export type ParticipacaoNotificacao  = typeof participacoesNotificacoes.$inferSelect;
export type ParticipacaoExtensao     = typeof participacoesPrazosExtensao.$inferSelect;

// Tipos do módulo de Resultados
export type PropostaLicitacao    = typeof propostasLicitacao.$inferSelect;
export type NewPropostaLicitacao = typeof propostasLicitacao.$inferInsert;
export type ResultadoLicitacao    = typeof resultadosLicitacao.$inferSelect;
export type NewResultadoLicitacao = typeof resultadosLicitacao.$inferInsert;

// Tipos do módulo de Famílias CRC
export type Familia              = typeof familias.$inferSelect;
export type NewFamilia           = typeof familias.$inferInsert;
export type FamiliaAlias         = typeof familiasAliases.$inferSelect;
export type FamiliaAnexo         = typeof familiasAnexos.$inferSelect;
export type NewFamiliaAnexo      = typeof familiasAnexos.$inferInsert;
export type LicitacaoFamiliaMatch = typeof licitacoesFamiliasMatch.$inferSelect;
export type NewLicitacaoFamiliaMatch = typeof licitacoesFamiliasMatch.$inferInsert;

// Tipos do módulo de Habilitação
export type Operacao                = typeof operacoes.$inferSelect;
export type NewOperacao             = typeof operacoes.$inferInsert;
export type DocumentoHabilitacao    = typeof documentosHabilitacao.$inferSelect;
export type NewDocumentoHabilitacao = typeof documentosHabilitacao.$inferInsert;
export type DocumentoHabilitacaoAnexo    = typeof documentosHabilitacaoAnexos.$inferSelect;
export type NewDocumentoHabilitacaoAnexo = typeof documentosHabilitacaoAnexos.$inferInsert;
export type DocumentoFamilia        = typeof documentosFamilias.$inferSelect;
export type DocumentoProjeto        = typeof documentosProjetos.$inferSelect;
export type NewDocumentoProjeto     = typeof documentosProjetos.$inferInsert;
export type AlertaVencimento        = typeof alertasVencimento.$inferSelect;
export type ConsultaCertidao        = typeof consultasCertidoes.$inferSelect;
// Acervo — Disciplina e profissional (0043)
export type Disciplina             = typeof disciplinas.$inferSelect;
export type NewDisciplina          = typeof disciplinas.$inferInsert;
export type OperacaoDisciplina     = typeof operacaoDisciplinas.$inferSelect;
export type Profissional           = typeof profissionais.$inferSelect;
export type NewProfissional        = typeof profissionais.$inferInsert;
export type ProfissionalDocumento  = typeof profissionalDocumentos.$inferSelect;
export type NewProfissionalDocumento = typeof profissionalDocumentos.$inferInsert;
export type DocumentoAtividade     = typeof documentoAtividades.$inferSelect;
export type NewDocumentoAtividade  = typeof documentoAtividades.$inferInsert;
// Acervo — Anotações e itens tagueados (0044). `AlvoAnotacao` é exportado
// junto do bloco, como `PapelProfissional`.
export type AcervoAnotacao         = typeof acervoAnotacoes.$inferSelect;
export type NewAcervoAnotacao      = typeof acervoAnotacoes.$inferInsert;
export type DocumentoItemTag       = typeof documentoItensTag.$inferSelect;
export type NewDocumentoItemTag    = typeof documentoItensTag.$inferInsert;

// Tipos do módulo de Conformidade — Importação e Vigilância
export type ImportJob          = typeof importJobs.$inferSelect;
export type NewImportJob       = typeof importJobs.$inferInsert;
export type AuditDownloadRestrito    = typeof auditDownloadRestrito.$inferSelect;
export type NewAuditDownloadRestrito = typeof auditDownloadRestrito.$inferInsert;
export type CnpjStatusLogRow   = typeof cnpjStatusLog.$inferSelect;
export type NewCnpjStatusLog   = typeof cnpjStatusLog.$inferInsert;

// Tipos do módulo de Conformidade — Pós-Vitória
export type RequisitoEdital      = typeof requisitosEdital.$inferSelect;
export type NewRequisitoEdital   = typeof requisitosEdital.$inferInsert;
export type EnvelopeHabilitacao  = typeof envelopesHabilitacao.$inferSelect;
export type NewEnvelopeHabilitacao = typeof envelopesHabilitacao.$inferInsert;
export type EnvelopeItem         = typeof envelopeItens.$inferSelect;
export type NewEnvelopeItem      = typeof envelopeItens.$inferInsert;
export type ContratoExecucao     = typeof contratosExecucao.$inferSelect;
export type NewContratoExecucao  = typeof contratosExecucao.$inferInsert;
export type IqfAvaliacao         = typeof iqfAvaliacoes.$inferSelect;
export type NewIqfAvaliacao      = typeof iqfAvaliacoes.$inferInsert;

// Tipos do pipeline Petronect V2
export type PetronectLicAndamento    = typeof petronectLicAndamento.$inferSelect;
export type NewPetronectLicAndamento = typeof petronectLicAndamento.$inferInsert;
export type PetronectLicItem         = typeof petronectLicItems.$inferSelect;
export type NewPetronectLicItem      = typeof petronectLicItems.$inferInsert;
export type PetronectLicAnexo        = typeof petronectLicAnexos.$inferSelect;
export type NewPetronectLicAnexo     = typeof petronectLicAnexos.$inferInsert;
export type PetronectLicProposta     = typeof petronectLicPropostas.$inferSelect;
export type NewPetronectLicProposta  = typeof petronectLicPropostas.$inferInsert;
export type PetronectLicResultado    = typeof petronectLicResultado.$inferSelect;
export type NewPetronectLicResultado = typeof petronectLicResultado.$inferInsert;
export type PetronectLicEvento       = typeof petronectLicEventos.$inferSelect;
export type NewPetronectLicEvento    = typeof petronectLicEventos.$inferInsert;

// Tipos das 25 features novas (lane-schema / migration 0013)
export type PetitorioLicitacao    = typeof petitoriosLicitacao.$inferSelect;
export type NewPetitorioLicitacao = typeof petitoriosLicitacao.$inferInsert;
export type PetitorioHistorico    = typeof petitoriosHistorico.$inferSelect;
export type NewPetitorioHistorico = typeof petitoriosHistorico.$inferInsert;
export type GapHabilitacao        = typeof gapHabilitacao.$inferSelect;
export type NewGapHabilitacao     = typeof gapHabilitacao.$inferInsert;
export type CircularImpacto       = typeof circularesImpacto.$inferSelect;
export type NewCircularImpacto    = typeof circularesImpacto.$inferInsert;
export type AcervoChunk           = typeof acervoChunks.$inferSelect;
export type NewAcervoChunk        = typeof acervoChunks.$inferInsert;
export type AcervoIndexLog        = typeof acervoIndexLog.$inferSelect;
export type NewAcervoIndexLog     = typeof acervoIndexLog.$inferInsert;
export type ApiKey                = typeof apiKeys.$inferSelect;
export type NewApiKey             = typeof apiKeys.$inferInsert;
export type WebhookSubscription   = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
export type PushSubscription      = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription   = typeof pushSubscriptions.$inferInsert;
