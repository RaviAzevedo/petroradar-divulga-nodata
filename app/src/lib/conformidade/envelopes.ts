/**
 * Helpers de Envelopes de Habilitação (pós-vitória).
 *
 * Fluxo principal:
 *   1. Quando uma participação muda pra resultado='GANHOU', chamar
 *      criarEnvelopeAposVitoria(participacaoId).
 *   2. Os requisitos do edital são extraídos da análise IA
 *      (analises_ia.criteriosHabilitacao + .requisitos).
 *   3. Pra cada requisito, sugerimos o documento mais recente vigente
 *      da subcategoria correspondente.
 *   4. Status dos itens é recalculado periodicamente pelo cron de saúde.
 */

import { db } from "@/db";
import {
  participacoesLicitacao,
  licitacoes,
  envelopesHabilitacao,
  envelopeItens,
  requisitosEdital,
  documentosHabilitacao,
  analisesIa,
  type SubcategoriaDocHab,
  type StatusItemEnvelope,
  type OrigemEnvelope,
  type SituacaoProva,
} from "@/db/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

// 0034/§16-B.5 — "regra da barra" (00-ARQ §1.2): só prova assinada (ou sem
// classificação/indefinida) entra em envelope; rascunho, superada, cancelada e
// modelo ficam de fora. Espelha o literal de participacoes_id_fase.py do BFF.
const SITUACOES_PROVA_ENVELOPAVEIS: SituacaoProva[] = [
  "ASSINADA_PROPONENTE",
  "ASSINADA_CLIENTE",
  "INDEFINIDA",
];

// ── Mapa de palavra-chave → subcategoria de doc ──────────────────────────────
// Usado pra mapear texto do edital pra requisitos estruturados.
const KEYWORD_TO_SUB: Array<{ regex: RegExp; codigo: SubcategoriaDocHab; descricao: string }> = [
  { regex: /cnd[\s_-]?federal|debitos\s+federais|pgfn/i,    codigo: "CND_FEDERAL",     descricao: "Certidão Negativa de Débitos Federais" },
  { regex: /\bfgts\b|crf/i,                                  codigo: "FGTS",            descricao: "Certificado de Regularidade FGTS" },
  { regex: /\bcndt\b|debitos\s+trabalhistas/i,               codigo: "CNDT",            descricao: "CNDT — Trabalhista" },
  { regex: /cnd\s+estadual|sefaz/i,                          codigo: "CND_ESTADUAL",    descricao: "Certidão Estadual" },
  { regex: /cnd\s+municipal/i,                               codigo: "CND_MUNICIPAL",   descricao: "Certidão Municipal" },
  { regex: /falencia|concordata|recupera[çc][aã]o/i,         codigo: "FALENCIA",        descricao: "Negativa de Falência" },
  { regex: /balan[çc]o|demonstra[çc][oõ]es/i,                codigo: "BALANCO",         descricao: "Balanço Patrimonial" },
  { regex: /[íi]ndices?\s+(financeir|liquidez|solv)/i,       codigo: "INDICES_FINANCEIROS", descricao: "Índices Financeiros" },
  { regex: /contrato\s+social/i,                             codigo: "CONTRATO_SOCIAL", descricao: "Contrato Social" },
  { regex: /cart[aã]o\s+cnpj|comprovante\s+cnpj/i,           codigo: "CNPJ",            descricao: "Cartão CNPJ" },
  { regex: /ato\s+constitutivo/i,                            codigo: "ATO_CONSTITUTIVO", descricao: "Ato Constitutivo" },
  { regex: /procura[çc][aã]o/i,                              codigo: "PROCURACAO",      descricao: "Procuração" },
  { regex: /atestad|capacidade\s+t[ée]cnica|\bact\b/i,       codigo: "ATESTADO_ACT",    descricao: "Atestado de Capacidade Técnica" },
  { regex: /iso\s*9001/i,                                    codigo: "ISO_9001",        descricao: "ISO 9001" },
  { regex: /iso\s*14001/i,                                   codigo: "ISO_14001",       descricao: "ISO 14001" },
  { regex: /iso\s*45001/i,                                   codigo: "ISO_45001",       descricao: "ISO 45001" },
  { regex: /nr\s*-?\s*10\b/i,                                codigo: "NR_10",           descricao: "NR-10 Eletricidade" },
  { regex: /nr\s*-?\s*13\b/i,                                codigo: "NR_13",           descricao: "NR-13 Vasos de Pressão" },
  { regex: /nr\s*-?\s*35\b/i,                                codigo: "NR_35",           descricao: "NR-35 Trabalho em Altura" },
  { regex: /\basme\b/i,                                      codigo: "ASME",            descricao: "ASME" },
  { regex: /api\s*q1/i,                                      codigo: "API_Q1",          descricao: "API Q1" },
  { regex: /api\s*6d/i,                                      codigo: "API_6D",          descricao: "API 6D" },
  { regex: /\bped\b/i,                                       codigo: "PED",             descricao: "PED" },
  { regex: /crea[\s_-]*pj|registro\s+(da\s+)?empresa/i,      codigo: "CREA_PJ",         descricao: "CREA Pessoa Jurídica" },
  { regex: /crea[\s_-]*pf|engenheiro\s+respons[áa]vel/i,     codigo: "CREA_PF",         descricao: "CREA Pessoa Física" },
  { regex: /\bart\b|cat[\s_-]+t[ée]cn/i,                     codigo: "ART_CAT",         descricao: "ART / CAT" },
  { regex: /menor.*n[aã]o\s+emprega|trabalho\s+menor/i,      codigo: "DECL_MENOR_NAO_EMPREGA", descricao: "Decl. Não Emprega Menor" },
  { regex: /idoneidade/i,                                    codigo: "DECL_IDONEIDADE", descricao: "Decl. Idoneidade" },
  { regex: /me[\s_-]*epp|microempresa/i,                     codigo: "DECL_ME_EPP",     descricao: "Decl. ME / EPP" },
];

// ── Extração de requisitos a partir da análise IA ────────────────────────────

/**
 * Lê analises_ia da licitação e extrai uma lista de requisitos estruturados.
 * Retorna pares (codigo, descricao) baseados em keyword matching no texto.
 *
 * O prompt da análise IA já pede `criterios_habilitacao` e `requisitos_tecnicos`
 * como arrays de strings — aqui transformamos em códigos quando possível.
 */
function extrairRequisitosDeAnalise(textos: string[]): Array<{ codigo: string; descricao: string }> {
  const vistos = new Set<string>();
  const requisitos: Array<{ codigo: string; descricao: string }> = [];

  for (const texto of textos) {
    if (!texto) continue;
    for (const kw of KEYWORD_TO_SUB) {
      if (kw.regex.test(texto)) {
        if (vistos.has(kw.codigo)) continue;
        vistos.add(kw.codigo);
        requisitos.push({ codigo: kw.codigo, descricao: kw.descricao });
      }
    }
  }

  // Sempre incluir o "core" (CND_FEDERAL, FGTS, CNDT, CONTRATO_SOCIAL, CNPJ)
  // que Petrobras quase sempre exige, mesmo se a IA não citou explicitamente
  const CORE: Array<{ codigo: SubcategoriaDocHab; descricao: string }> = [
    { codigo: "CND_FEDERAL",     descricao: "CND Federal (Receita/PGFN)" },
    { codigo: "FGTS",            descricao: "CRF FGTS" },
    { codigo: "CNDT",            descricao: "CNDT (Trabalhista)" },
    { codigo: "CONTRATO_SOCIAL", descricao: "Contrato Social" },
    { codigo: "CNPJ",            descricao: "Cartão CNPJ" },
  ];
  for (const c of CORE) {
    if (!vistos.has(c.codigo)) {
      vistos.add(c.codigo);
      requisitos.push(c);
    }
  }

  return requisitos;
}

// ── Sugestão de documento pra um requisito ───────────────────────────────────

/**
 * Procura no cofre o documento mais recente vigente da subcategoria
 * correspondente ao código do requisito. Retorna o documentoId e um score
 * 0..1 baseado na qualidade do match.
 */
async function sugerirDocumentoParaRequisito(
  codigoRequisito: string,
  prazoMinimoVigencia: Date,
): Promise<{ documentoId: string | null; score: number }> {
  // Tenta usar o código como subcategoria direta (na maioria dos casos é mesmo)
  const sub = codigoRequisito as SubcategoriaDocHab;

  const docs = await db
    .select({
      id:           documentosHabilitacao.id,
      validadeFim:  documentosHabilitacao.validadeFim,
      validadeIndeterminada: documentosHabilitacao.validadeIndeterminada,
      status:       documentosHabilitacao.status,
    })
    .from(documentosHabilitacao)
    .where(
      and(
        eq(documentosHabilitacao.subcategoria, sub),
        eq(documentosHabilitacao.status, "VIGENTE"),
        // 0034/§16-B.5 (decisão do detalhador, dois lados — espelha
        // participacoes_id_fase.py do BFF):
        // 2. regra da barra — rascunho/superada/cancelada/modelo não entra
        //    em envelope;
        or(
          isNull(documentosHabilitacao.situacaoProva),
          inArray(documentosHabilitacao.situacaoProva, SITUACOES_PROVA_ENVELOPAVEIS),
        ),
        // 3. restrito = false — seleção AUTOMÁTICA de prova nunca anexa
        //    documento sob cláusula de sigilo.
        eq(documentosHabilitacao.restrito, false),
      ),
    )
    // 1. DESC NULLS LAST — no Postgres, DESC põe NULL PRIMEIRO; os docs de
    //    ingestão com validade NULL passariam à frente das certidões
    //    vigentes.
    .orderBy(sql`${documentosHabilitacao.validadeFim} DESC NULLS LAST`)
    .limit(5);

  if (docs.length === 0) {
    return { documentoId: null, score: 0 };
  }

  // Preferir o que ainda estará válido na data limite
  const valido = docs.find((d) =>
    d.validadeIndeterminada || (d.validadeFim && new Date(d.validadeFim) >= prazoMinimoVigencia),
  );
  if (valido) return { documentoId: valido.id, score: 0.9 };

  // Senão, pega o mais recente mesmo
  return { documentoId: docs[0].id, score: 0.5 };
}

// ── Seleção Just-in-Time de doc por requisito (auto-montar) ──────────────────

/**
 * Resultado da escolha do melhor documento VIGENTE para um requisito,
 * já classificado em função do prazo de protocolo do envelope.
 *
 * Diferente de `sugerirDocumentoParaRequisito` (que só devolve um id+score),
 * aqui o status final do item já vem decidido para a Pasta de Habilitação
 * Just-in-Time:
 *   - ATRIBUIDO                 doc vigente e válido na data de protocolo
 *   - VENCE_ANTES_DO_PROTOCOLO  só existe doc que vence antes do protocolo
 *   - PENDENTE                  nenhum doc vigente na subcategoria
 */
interface EscolhaDocRequisito {
  documentoId: string | null;
  status:      Extract<StatusItemEnvelope, "ATRIBUIDO" | "VENCE_ANTES_DO_PROTOCOLO" | "PENDENTE">;
  score:       number;
  /** Quando o melhor candidato seguro vence (null se indeterminado/ausente). */
  venceEm:     Date | null;
  /** Subcategoria efetivamente consultada no cofre. */
  subcategoria: SubcategoriaDocHab;
}

/**
 * Escolhe o melhor documento VIGENTE do cofre para um requisito, exigindo que a
 * validade ultrapasse o prazo de protocolo (validadeFim > prazoProtocolo) — daí
 * o "just-in-time". Quando não há candidato seguro, marca
 * VENCE_ANTES_DO_PROTOCOLO (existe doc vigente mas vence cedo demais) ou
 * PENDENTE (cofre não tem nada da subcategoria).
 *
 * Preferência de ordenação:
 *   1. validade indeterminada (contrato social, CREA-PJ etc.) — sempre seguro;
 *   2. maior validadeFim (mais "folga" sobre o prazo de protocolo).
 */
async function escolherMelhorDocVigente(
  codigoRequisito: string,
  prazoProtocolo: Date,
): Promise<EscolhaDocRequisito> {
  const sub = codigoRequisito as SubcategoriaDocHab;

  const docs = await db
    .select({
      id:                    documentosHabilitacao.id,
      validadeFim:           documentosHabilitacao.validadeFim,
      validadeIndeterminada: documentosHabilitacao.validadeIndeterminada,
    })
    .from(documentosHabilitacao)
    .where(
      and(
        eq(documentosHabilitacao.subcategoria, sub),
        eq(documentosHabilitacao.status, "VIGENTE"),
        // 0034/§16-B.5 — mesmas três regras do seletor acima (dois lados):
        // regra da barra + restrito nunca entra em envelope + NULLS LAST.
        or(
          isNull(documentosHabilitacao.situacaoProva),
          inArray(documentosHabilitacao.situacaoProva, SITUACOES_PROVA_ENVELOPAVEIS),
        ),
        eq(documentosHabilitacao.restrito, false),
      ),
    )
    .orderBy(sql`${documentosHabilitacao.validadeFim} DESC NULLS LAST`)
    .limit(10);

  if (docs.length === 0) {
    return { documentoId: null, status: "PENDENTE", score: 0, venceEm: null, subcategoria: sub };
  }

  // 1. Candidato seguro: indeterminado OU vence depois do protocolo.
  const seguros = docs
    .filter((d) => d.validadeIndeterminada || (d.validadeFim && new Date(d.validadeFim) > prazoProtocolo))
    // indeterminado primeiro, depois maior validade (mais folga)
    .sort((a, b) => {
      if (a.validadeIndeterminada !== b.validadeIndeterminada) return a.validadeIndeterminada ? -1 : 1;
      const va = a.validadeFim ? new Date(a.validadeFim).getTime() : Infinity;
      const vb = b.validadeFim ? new Date(b.validadeFim).getTime() : Infinity;
      return vb - va;
    });

  if (seguros.length > 0) {
    const escolhido = seguros[0];
    return {
      documentoId: escolhido.id,
      status:      "ATRIBUIDO",
      score:       escolhido.validadeIndeterminada ? 1 : 0.9,
      venceEm:     escolhido.validadeIndeterminada ? null : (escolhido.validadeFim ? new Date(escolhido.validadeFim) : null),
      subcategoria: sub,
    };
  }

  // 2. Só há doc que vence antes do protocolo — atribui mas sinaliza o risco.
  const maisLongevo = docs[0];
  return {
    documentoId: maisLongevo.id,
    status:      "VENCE_ANTES_DO_PROTOCOLO",
    score:       0.4,
    venceEm:     maisLongevo.validadeFim ? new Date(maisLongevo.validadeFim) : null,
    subcategoria: sub,
  };
}

// ── Criar envelope ───────────────────────────────────────────────────────────

export interface CriarEnvelopeResult {
  envelopeId: string;
  totalRequisitos: number;
  itensComDoc: number;
  itensPendentes: number;
}

/**
 * Cria um envelope vazio para a participação ganha e popula com os requisitos
 * extraídos da análise IA do edital + sugestão automática de docs do cofre.
 *
 * Idempotente: se já existir envelope para a participação, retorna o existente.
 */
export async function criarEnvelopeAposVitoria(
  participacaoId: string,
  responsavelSgi?: string,
): Promise<CriarEnvelopeResult | null> {
  // Já existe?
  const [existente] = await db
    .select()
    .from(envelopesHabilitacao)
    .where(eq(envelopesHabilitacao.participacaoId, participacaoId))
    .limit(1);

  if (existente) {
    const itens = await db
      .select({ id: envelopeItens.id, status: envelopeItens.status })
      .from(envelopeItens)
      .where(eq(envelopeItens.envelopeId, existente.id));
    return {
      envelopeId:      existente.id,
      totalRequisitos: itens.length,
      itensComDoc:     itens.filter((i) => i.status === "ATRIBUIDO").length,
      itensPendentes:  itens.filter((i) => i.status === "PENDENTE").length,
    };
  }

  // Buscar dados da participação + análise IA do edital
  const [part] = await db
    .select({
      id:                    participacoesLicitacao.id,
      numeroEdital:          participacoesLicitacao.numeroEdital,
      empresaContratante:    participacoesLicitacao.empresaContratante,
      objeto:                participacoesLicitacao.objeto,
      licitacaoPetroRadarId: participacoesLicitacao.licitacaoPetroRadarId,
      prazoPortal:           participacoesLicitacao.prazoPortal,
    })
    .from(participacoesLicitacao)
    .where(eq(participacoesLicitacao.id, participacaoId))
    .limit(1);

  if (!part) return null;

  // Pré-computa requisitos+sugestões (reads) fora da transação, depois grava
  // envelope + requisitos + itens atomicamente em batch.
  const plano = await montarPlanoRequisitos({
    licitacaoId:   part.licitacaoPetroRadarId,
    prazoVigencia: part.prazoPortal ?? new Date(),
  });

  // NOTA: o driver neon-http não suporta transações; os statements rodam
  // sequencialmente. O INSERT do envelope e os INSERTs em batch dos requisitos
  // e itens são, cada um, statement único e atômico por si.
  // Cria envelope com snapshot da participação
  const [envelope] = await db
    .insert(envelopesHabilitacao)
    .values({
      origem:             "PARTICIPACAO",
      participacaoId,
      licitacaoId:        part.licitacaoPetroRadarId ?? null,
      numeroEdital:       part.numeroEdital,
      empresaContratante: part.empresaContratante,
      objeto:             part.objeto,
      status:             "EM_MONTAGEM",
      prazoProtocolo:     null, // SGI preenche manualmente quando recebe o ofício
      responsavelSgi:     responsavelSgi ?? null,
    })
    .returning();

  const resultado = await gravarRequisitosDoEnvelope(db, {
    envelopeId:  envelope.id,
    licitacaoId: part.licitacaoPetroRadarId,
    plano,
  });

  return {
    envelopeId: envelope.id,
    ...resultado,
  };
}

// ── Criar envelope avulso (sem participação) ────────────────────────────────

export interface CriarEnvelopeAvulsoInput {
  /** Dados básicos do edital — sempre obrigatórios */
  numeroEdital:       string;
  empresaContratante: string;
  objeto:             string;
  /** Vínculo opcional com licitação cadastrada (do scraper Petronect) */
  licitacaoId?:       string | null;
  /** Prazo declarado pela Petrobras pra protocolar */
  prazoProtocolo?:    Date | null;
  /** Quem é o responsável SGI inicial */
  responsavelSgi?:    string | null;
  observacoes?:       string | null;
}

/**
 * Cria envelope sem passar pelo pipeline de Participações.
 *
 * Se `licitacaoId` é fornecido e existe na tabela `licitacoes`, populamos
 * requisitos via análise IA (se houver) — mesma lógica do automático.
 * Se não, cria envelope vazio que SGI preenche os requisitos manualmente.
 *
 * Origem: "LICITACAO" se vinculou a uma licitação Petro Radar;
 *         "AVULSO" se totalmente manual (sem licitacaoId).
 */
export async function criarEnvelopeAvulso(
  input: CriarEnvelopeAvulsoInput,
): Promise<CriarEnvelopeResult> {
  const origem: OrigemEnvelope = input.licitacaoId ? "LICITACAO" : "AVULSO";

  // Se vinculou a licitação, busca dados pra confirmar (e re-puxa snapshot)
  let dadosLic: { numero: string; empresa: string | null; objeto: string | null } | null = null;
  if (input.licitacaoId) {
    const [lic] = await db
      .select({
        numero:  licitacoes.numero,
        empresa: licitacoes.empresa,
        objeto:  licitacoes.objeto,
      })
      .from(licitacoes)
      .where(eq(licitacoes.id, input.licitacaoId))
      .limit(1);
    if (!lic) {
      throw new Error("Licitação informada não existe");
    }
    dadosLic = lic;
  }

  // Snapshot — usa input do usuário, com fallback pros dados da licitação
  const numeroEdital       = input.numeroEdital       || dadosLic?.numero  || "";
  const empresaContratante = input.empresaContratante || dadosLic?.empresa || "Petrobras";
  const objeto             = input.objeto             || dadosLic?.objeto  || "";

  // Pré-computa requisitos+sugestões (reads) fora da transação, depois grava
  // envelope + requisitos + itens atomicamente em batch.
  const plano = await montarPlanoRequisitos({
    licitacaoId:   input.licitacaoId ?? null,
    prazoVigencia: input.prazoProtocolo ?? new Date(),
  });

  // NOTA: o driver neon-http não suporta transações; os statements rodam
  // sequencialmente. O INSERT do envelope e os INSERTs em batch dos requisitos
  // e itens são, cada um, statement único e atômico por si.
  const [envelope] = await db
    .insert(envelopesHabilitacao)
    .values({
      origem,
      participacaoId:     null,
      licitacaoId:        input.licitacaoId ?? null,
      numeroEdital,
      empresaContratante,
      objeto,
      status:             "EM_MONTAGEM",
      prazoProtocolo:     input.prazoProtocolo ?? null,
      responsavelSgi:     input.responsavelSgi ?? null,
      observacoes:        input.observacoes ?? null,
    })
    .returning();

  const resultado = await gravarRequisitosDoEnvelope(db, {
    envelopeId:  envelope.id,
    licitacaoId: input.licitacaoId ?? null,
    plano,
  });

  return {
    envelopeId: envelope.id,
    ...resultado,
  };
}

// ── Helpers: montar plano (reads) + gravar em batch (writes) ───

/** Um requisito já com a sugestão de documento resolvida (ainda sem IDs). */
interface RequisitoPlanejado {
  codigo:      string;
  descricao:   string;
  ordem:       number;
  documentoId: string | null;
  score:       number;
}

/**
 * Lê a análise IA + sugere documentos do cofre (somente leituras).
 * Não escreve nada — o resultado é gravado depois, dentro da transação.
 */
async function montarPlanoRequisitos(args: {
  licitacaoId:   string | null;
  prazoVigencia: Date;
}): Promise<RequisitoPlanejado[]> {
  let requisitosExtraidos: Array<{ codigo: string; descricao: string }> = [];

  if (args.licitacaoId) {
    const [analise] = await db
      .select({
        criteriosHabilitacao: analisesIa.criteriosHabilitacao,
        requisitos:           analisesIa.requisitos,
        objetoDetalhado:      analisesIa.objetoDetalhado,
      })
      .from(analisesIa)
      .where(eq(analisesIa.licitacaoId, args.licitacaoId))
      .limit(1);

    if (analise) {
      const textos: string[] = [];
      const ch = analise.criteriosHabilitacao;
      if (Array.isArray(ch)) textos.push(...ch.map((s) => String(s)));
      else if (typeof ch === "string") textos.push(ch);

      const rq = analise.requisitos;
      if (Array.isArray(rq)) textos.push(...rq.map((s) => String(s)));

      if (analise.objetoDetalhado) textos.push(analise.objetoDetalhado);

      requisitosExtraidos = extrairRequisitosDeAnalise(textos);
    }
  }

  if (requisitosExtraidos.length === 0) {
    // Fallback: só os core (CND federal, FGTS, CNDT, contrato social, CNPJ)
    requisitosExtraidos = extrairRequisitosDeAnalise([]);
  }

  if (!args.licitacaoId || requisitosExtraidos.length === 0) {
    // Sem requisitos a criar — envelope nasce vazio, SGI preenche manualmente
    return [];
  }

  // Resolve a sugestão de documento de cada requisito em paralelo (reads).
  return await Promise.all(
    requisitosExtraidos.map(async (r, i) => {
      const sugestao = await sugerirDocumentoParaRequisito(r.codigo, args.prazoVigencia);
      return {
        codigo:      r.codigo,
        descricao:   r.descricao,
        ordem:       i,
        documentoId: sugestao.documentoId,
        score:       sugestao.score,
      };
    }),
  );
}

/**
 * Grava requisitos + itens do envelope em BATCH.
 * Um único INSERT pra requisitos e um único INSERT pra itens (sem N+1).
 * Cada INSERT em batch é um statement único e atômico por si.
 */
async function gravarRequisitosDoEnvelope(
  executor: typeof db,
  args: {
    envelopeId:  string;
    licitacaoId: string | null;
    plano:       RequisitoPlanejado[];
  },
): Promise<{ totalRequisitos: number; itensComDoc: number; itensPendentes: number }> {
  if (!args.licitacaoId || args.plano.length === 0) {
    return { totalRequisitos: 0, itensComDoc: 0, itensPendentes: 0 };
  }

  // 1 INSERT pra todos os requisitos
  const requisitosCriados = await executor
    .insert(requisitosEdital)
    .values(
      args.plano.map((r) => ({
        licitacaoId: args.licitacaoId!,
        codigo:      r.codigo,
        descricao:   r.descricao,
        obrigatorio: true,
        fonte:       "ANALISE_IA" as const,
        ordem:       r.ordem,
      })),
    )
    .returning({ id: requisitosEdital.id });

  // 1 INSERT pra todos os itens — casa requisito criado ↔ sugestão por índice
  const agora = new Date();
  const itensValues = requisitosCriados.map((req, i) => {
    const p = args.plano[i];
    const status: StatusItemEnvelope = p.documentoId ? "ATRIBUIDO" : "PENDENTE";
    return {
      envelopeId:    args.envelopeId,
      requisitoId:   req.id,
      documentoId:   p.documentoId,
      status,
      scoreSugestao: p.score,
      atribuidoEm:   p.documentoId ? agora : null,
    };
  });

  await executor.insert(envelopeItens).values(itensValues);

  const comDoc = args.plano.filter((p) => p.documentoId).length;

  return {
    totalRequisitos: requisitosCriados.length,
    itensComDoc:     comDoc,
    itensPendentes:  requisitosCriados.length - comDoc,
  };
}

// ── Recalcular saúde de um envelope ──────────────────────────────────────────

async function recalcularStatusEnvelope(envelopeId: string): Promise<{
  totalItens: number;
  pendentes: number;
  vencidos: number;
  prontos: number;
}> {
  const [env] = await db
    .select({ id: envelopesHabilitacao.id, prazoProtocolo: envelopesHabilitacao.prazoProtocolo })
    .from(envelopesHabilitacao)
    .where(eq(envelopesHabilitacao.id, envelopeId))
    .limit(1);
  if (!env) return { totalItens: 0, pendentes: 0, vencidos: 0, prontos: 0 };

  const itens = await db
    .select({
      itemId:       envelopeItens.id,
      documentoId:  envelopeItens.documentoId,
      docValidade:  documentosHabilitacao.validadeFim,
      docIndeterm:  documentosHabilitacao.validadeIndeterminada,
      docStatus:    documentosHabilitacao.status,
    })
    .from(envelopeItens)
    .leftJoin(documentosHabilitacao, eq(envelopeItens.documentoId, documentosHabilitacao.id))
    .where(eq(envelopeItens.envelopeId, envelopeId));

  const prazo = env.prazoProtocolo ?? new Date();

  let pendentes = 0;
  let vencidos = 0;
  let prontos = 0;

  for (const it of itens) {
    let novoStatus: StatusItemEnvelope;
    if (!it.documentoId) {
      novoStatus = "PENDENTE";
      pendentes++;
    } else if (it.docStatus === "VENCIDO") {
      novoStatus = "VENCIDO";
      vencidos++;
    } else if (!it.docIndeterm && it.docValidade && new Date(it.docValidade) < prazo) {
      novoStatus = "VENCE_ANTES_DO_PROTOCOLO";
      vencidos++;
    } else {
      novoStatus = "ATRIBUIDO";
      prontos++;
    }

    await db
      .update(envelopeItens)
      .set({ status: novoStatus, atualizadoEm: new Date() })
      .where(eq(envelopeItens.id, it.itemId));
  }

  return { totalItens: itens.length, pendentes, vencidos, prontos };
}
