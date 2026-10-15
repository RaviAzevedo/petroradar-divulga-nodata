/**
 * Gap de Habilitação Inteligente: edital × cofre × CRC
 *
 * Cruza requisitos_edital + analises_ia.criteriosHabilitacao contra:
 *   - o cofre (documentos_habilitacao por subcategoria, status VIGENTE,
 *     validadeFim > dataAbertura)
 *   - as famílias CRC (statusFluxoCrc = 'A')
 *
 * Match primário por CÓDIGO (req.codigo ≈ SubcategoriaDocHab). Os requisitos
 * que ficam ambíguos (sem match por código mas com descrição) são resolvidos
 * por Claude (Haiku) em UM batch só — gate gracioso por ANTHROPIC_API_KEY.
 *
 * Persiste o resultado materializado em gap_habilitacao (recalculável por cron
 * e on-demand). Escritas via db.batch (neon-http NÃO suporta db.transaction).
 */

import { db } from "@/db";
import {
  licitacoes,
  requisitosEdital,
  documentosHabilitacao,
  analisesIa,
  gapHabilitacao,
  familias,
} from "@/db/schema";
import type { StatusCobertura, MetodoMatchGap, SubcategoriaDocHab } from "@/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { criarClienteAnthropic, iaPermitida } from "@/lib/ia/gate";
import { calcularAderencia } from "@/lib/conformidade/familias/match";

interface GapItem {
  requisitoId:    string | null;
  requisitoCodigo: string | null;
  descricao:      string;
  statusCobertura: StatusCobertura;
  documentoId:    string | null;
  documentoTitulo: string | null;
  venceEm:        string | null;
  metodoMatch:    MetodoMatchGap | null;
  confianca:      number | null;
  justificativa:  string | null;
}

export interface GapResult {
  licitacaoId: string;
  numero:      string;
  semaforo:    "VERDE" | "AMARELO" | "VERMELHO" | "SEM_DADOS";
  totais: {
    total:               number;
    atendidos:           number;
    parciais:            number;
    faltantes:           number;
    venceAntesDaData:    number;
  };
  itens:        GapItem[];
  // Famílias CRC da Proponente que COBREM itens desta licitação (derivado, não
  // persistido) — mostra em quais famílias CRC nos habilitamos.
  familiasHabilitadas: { codigoCrc: string; nome: string; itensCobertos: number }[];
  calculadoEm:  string;
}

// Vocabulário de subcategorias válido para validação do match por IA
const SUBCATEGORIAS: SubcategoriaDocHab[] = [
  "CND_FEDERAL", "FGTS", "CNDT", "CND_ESTADUAL", "CND_MUNICIPAL", "FALENCIA",
  "BALANCO", "INDICES_FINANCEIROS",
  "CONTRATO_SOCIAL", "CNPJ", "ATO_CONSTITUTIVO", "PROCURACAO",
  "ATESTADO_ACT", "ISO_9001", "ISO_14001", "ISO_45001",
  "NR_10", "NR_13", "NR_35", "ASME", "API_Q1", "API_6D", "PED", "OUTROS_TECNICOS",
  "CREA_PJ", "CREA_PF", "ART_CAT", "CTPS", "FORMACAO",
  "DECL_MENOR_NAO_EMPREGA", "DECL_IDONEIDADE", "DECL_ME_EPP", "DECL_OUTRA",
  "OUTRO",
];

function resolverDataReferencia(lic: typeof licitacoes.$inferSelect): Date | null {
  const candidatos = [lic.dataAbertura, lic.dataDisputa, lic.dataFim];
  for (const c of candidatos) {
    if (!c) continue;
    const iso = c.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
      if (!isNaN(d.getTime())) return d;
    }
    const br = c.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) {
      const d = new Date(`${br[3]}-${br[2]}-${br[1]}T00:00:00Z`);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

interface DocVigente {
  id:           string;
  titulo:       string;
  subcategoria: SubcategoriaDocHab;
  validadeFim:  Date | null;
  validadeIndeterminada: boolean;
}

/**
 * Para cada requisito (já com subcategoria resolvida), classifica a cobertura.
 */
function classificarCobertura(
  subcat: string | null,
  docPorSubcat: Map<string, DocVigente>,
  dataRef: Date | null,
): { status: StatusCobertura; doc: DocVigente | null } {
  if (!subcat) return { status: "FALTANTE", doc: null };
  const doc = docPorSubcat.get(subcat);
  if (!doc) return { status: "FALTANTE", doc: null };
  if (!doc.validadeIndeterminada && doc.validadeFim && dataRef && doc.validadeFim < dataRef) {
    return { status: "VENCE_ANTES_DA_DATA", doc };
  }
  return { status: "ATENDIDO", doc };
}

/**
 * Resolve via Claude (Haiku) o código de subcategoria de requisitos ambíguos.
 * Retorna Map<descricao, { subcategoria, confianca }>. Gate gracioso: se não há
 * ANTHROPIC_API_KEY, retorna mapa vazio (cai em FALTANTE/IA-indefinido).
 */
async function resolverAmbiguosComIA(
  descricoes: string[],
): Promise<Map<string, { subcategoria: string | null; confianca: number; justificativa: string }>> {
  const out = new Map<string, { subcategoria: string | null; confianca: number; justificativa: string }>();
  // IA BLOQUEADA para este módulo por decisão de produto (ver lib/ia/gate.ts):
  // iaPermitida("gap-habilitacao") é sempre false, então devolvemos o mapa vazio
  // e os requisitos ambíguos caem em FALTANTE/IA-indefinido — que já era o
  // fallback gracioso quando faltava a chave. Nada quebra, nada gasta.
  if (descricoes.length === 0 || !iaPermitida("gap-habilitacao")) return out;

  // Inalcançável enquanto o módulo estiver fora da allowlist (lança se chamado).
  const client = criarClienteAnthropic("gap-habilitacao");
  const lista = descricoes.map((d, i) => `${i + 1}. ${d}`).join("\n");

  const prompt = `Você é um especialista em habilitação de licitações da Petrobras.
Para cada requisito abaixo, classifique a qual SUBCATEGORIA de documento de habilitação ele corresponde.
Subcategorias válidas: ${SUBCATEGORIAS.join(", ")}.

Responda EXATAMENTE em JSON válido (sem markdown):
{ "itens": [ { "indice": 1, "subcategoria": "ISO_9001" | null, "confianca": 0.0-1.0, "justificativa": "1 frase" } ] }

Use null em subcategoria quando o requisito não corresponder a nenhum documento padrão.

REQUISITOS:
${lista}`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    const texto = block?.type === "text" ? block.text : "";
    const cleaned = texto.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      itens?: { indice: number; subcategoria: string | null; confianca: number; justificativa: string }[];
    };
    for (const item of parsed.itens ?? []) {
      const desc = descricoes[item.indice - 1];
      if (!desc) continue;
      const subcat = item.subcategoria && SUBCATEGORIAS.includes(item.subcategoria as SubcategoriaDocHab)
        ? item.subcategoria
        : null;
      out.set(desc, {
        subcategoria: subcat,
        confianca:    typeof item.confianca === "number" ? item.confianca : 0.5,
        justificativa: typeof item.justificativa === "string" ? item.justificativa : "",
      });
    }
  } catch {
    // Falha de IA não quebra o cálculo — requisitos ambíguos ficam FALTANTE
  }
  return out;
}

/**
 * Recalcula e PERSISTE o gap de habilitação em gap_habilitacao.
 * Escritas via db.batch (delete antigo + inserts novos), idempotente por licitação.
 */
export async function calcularGapHabilitacao(
  licitacaoId: string,
  opts: { usarIA?: boolean } = {},
): Promise<GapResult> {
  const usarIA = opts.usarIA ?? true;

  const [lic] = await db
    .select()
    .from(licitacoes)
    .where(eq(licitacoes.id, licitacaoId))
    .limit(1);

  if (!lic) throw new GapNotFound();

  const dataRef = resolverDataReferencia(lic);

  // Requisitos estruturados (rastreáveis)
  const requisitos = await db
    .select()
    .from(requisitosEdital)
    .where(eq(requisitosEdital.licitacaoId, licitacaoId))
    .orderBy(requisitosEdital.ordem);

  // Critérios da análise IA (texto livre — vira gap sem requisitoId)
  const [analise] = await db
    .select({ criterios: analisesIa.criteriosHabilitacao })
    .from(analisesIa)
    .where(eq(analisesIa.licitacaoId, licitacaoId))
    .limit(1);

  const criteriosTexto: string[] = Array.isArray(analise?.criterios)
    ? (analise!.criterios as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  // Cofre VIGENTE indexado por subcategoria (melhor validade)
  const docsVigentes = await db
    .select({
      id:           documentosHabilitacao.id,
      titulo:       documentosHabilitacao.titulo,
      subcategoria: documentosHabilitacao.subcategoria,
      validadeFim:  documentosHabilitacao.validadeFim,
      validadeIndeterminada: documentosHabilitacao.validadeIndeterminada,
    })
    .from(documentosHabilitacao)
    .where(
      and(
        eq(documentosHabilitacao.status, "VIGENTE"),
        // 0034/S14: INCONDICIONAL — o gap é agregado e não
        // há por que citar documento restrito nem p/ Conformidade. Espelha
        // licitacoes_id_gap_habilitacao.py (e o piggyback do cron de saúde,
        // que roda no Next em produção — NGINX manda /api/cron/ para cá).
        eq(documentosHabilitacao.restrito, false),
      ),
    );

  const docPorSubcat = new Map<string, DocVigente>();
  for (const d of docsVigentes) {
    const atual = docPorSubcat.get(d.subcategoria);
    if (!atual) { docPorSubcat.set(d.subcategoria, d); continue; }
    if (d.validadeIndeterminada && !atual.validadeIndeterminada) {
      docPorSubcat.set(d.subcategoria, d);
    } else if (!atual.validadeIndeterminada && d.validadeFim && atual.validadeFim && d.validadeFim > atual.validadeFim) {
      docPorSubcat.set(d.subcategoria, d);
    }
  }

  // ── Match por CÓDIGO ───────────────────────────────────────────────────────
  const itens: GapItem[] = [];
  const ambiguos: { descricao: string; requisitoId: string | null }[] = [];

  for (const req of requisitos) {
    const matchPorCodigo = docPorSubcat.has(req.codigo) || SUBCATEGORIAS.includes(req.codigo as SubcategoriaDocHab);
    if (matchPorCodigo) {
      const { status, doc } = classificarCobertura(req.codigo, docPorSubcat, dataRef);
      itens.push({
        requisitoId:     req.id,
        requisitoCodigo: req.codigo,
        descricao:       req.descricao,
        statusCobertura: status,
        documentoId:     doc?.id ?? null,
        documentoTitulo: doc?.titulo ?? null,
        venceEm:         doc?.validadeFim ? doc.validadeFim.toISOString() : null,
        metodoMatch:     "CODIGO",
        confianca:       1,
        justificativa:   doc ? `Match por código (${req.codigo}).` : `Sem documento VIGENTE para ${req.codigo}.`,
      });
    } else {
      ambiguos.push({ descricao: req.descricao, requisitoId: req.id });
    }
  }

  // Critérios da IA sem requisito estruturado também entram como ambíguos
  for (const crit of criteriosTexto) {
    if (requisitos.some((r) => r.descricao === crit)) continue;
    ambiguos.push({ descricao: crit, requisitoId: null });
  }

  // ── Match por IA nos ambíguos ──────────────────────────────────────────────
  const resolucao = usarIA
    ? await resolverAmbiguosComIA(ambiguos.map((a) => a.descricao))
    : new Map<string, { subcategoria: string | null; confianca: number; justificativa: string }>();

  for (const amb of ambiguos) {
    const r = resolucao.get(amb.descricao);
    const subcat = r?.subcategoria ?? null;
    const { status, doc } = classificarCobertura(subcat, docPorSubcat, dataRef);
    itens.push({
      requisitoId:     amb.requisitoId,
      requisitoCodigo: subcat,
      descricao:       amb.descricao,
      statusCobertura: subcat ? status : "FALTANTE",
      documentoId:     doc?.id ?? null,
      documentoTitulo: doc?.titulo ?? null,
      venceEm:         doc?.validadeFim ? doc.validadeFim.toISOString() : null,
      metodoMatch:     "IA",
      confianca:       r?.confianca ?? 0,
      justificativa:   r?.justificativa ?? "Requisito ambíguo, sem mapeamento de subcategoria.",
    });
  }

  // ── Persistência atômica: DELETE + INSERTs numa transação real ─────────────
  // (era db.batch no legado neon-http — sem atomicidade; convertido 2026-07-02.
  // Crítico aqui: falha no meio deixava o gap SEM linhas ou parcial.)
  const calculadoEm = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(gapHabilitacao).where(eq(gapHabilitacao.licitacaoId, licitacaoId));
    for (const it of itens) {
      await tx.insert(gapHabilitacao).values({
        licitacaoId,
        requisitoId:     it.requisitoId,
        requisitoCodigo: it.requisitoCodigo,
        statusCobertura: it.statusCobertura,
        documentoId:     it.documentoId,
        familiaId:       null,
        venceEm:         it.venceEm ? new Date(it.venceEm) : null,
        metodoMatch:     it.metodoMatch,
        confianca:       it.confianca,
        justificativa:   it.justificativa,
        calculadoEm,
      });
    }
  });

  const familiasHabilitadas = await computarFamiliasHabilitadas(licitacaoId);
  return montarResultado(lic.id, lic.numero, itens, calculadoEm, familiasHabilitadas);
}

/** Lê o gap já materializado (sem recalcular). Retorna null se nunca calculado. */
export async function getGapHabilitacao(licitacaoId: string): Promise<GapResult | null> {
  const [lic] = await db
    .select({ id: licitacoes.id, numero: licitacoes.numero })
    .from(licitacoes)
    .where(eq(licitacoes.id, licitacaoId))
    .limit(1);
  if (!lic) throw new GapNotFound();

  const rows = await db
    .select()
    .from(gapHabilitacao)
    .where(eq(gapHabilitacao.licitacaoId, licitacaoId));

  if (rows.length === 0) return null;

  // Junta títulos de documentos para exibição
  const docIds = rows.map((r) => r.documentoId).filter((d): d is string => !!d);
  const titulos = new Map<string, string>();
  if (docIds.length > 0) {
    const docs = await db
      .select({ id: documentosHabilitacao.id, titulo: documentosHabilitacao.titulo })
      .from(documentosHabilitacao)
      // 0034/S14: título de restrito não sai no gap (incondicional) — espelha
      // o SELECT de enriquecimento de licitacoes_id_gap_habilitacao.py.
      .where(and(inArray(documentosHabilitacao.id, docIds), eq(documentosHabilitacao.restrito, false)));
    for (const d of docs) titulos.set(d.id, d.titulo);
  }

  // gap_habilitacao não materializa a descrição do requisito — só requisitoId/codigo
  // + justificativa. Para exibir a descrição REAL (e não a justificativa), buscamos
  // em requisitos_edital. Indexamos por id (preciso) e por código (fallback, escopado
  // por licitação). Critérios da IA sem requisito estruturado não casam e caem no
  // fallback (justificativa → código), preservando o comportamento anterior.
  const requisitosLic = await db
    .select({
      id:        requisitosEdital.id,
      codigo:    requisitosEdital.codigo,
      descricao: requisitosEdital.descricao,
    })
    .from(requisitosEdital)
    .where(eq(requisitosEdital.licitacaoId, licitacaoId));

  const descPorReqId   = new Map<string, string>();
  const descPorCodigo  = new Map<string, string>();
  for (const r of requisitosLic) {
    descPorReqId.set(r.id, r.descricao);
    // Se vários requisitos compartilham o mesmo código, o primeiro vence (fallback).
    if (!descPorCodigo.has(r.codigo)) descPorCodigo.set(r.codigo, r.descricao);
  }

  const itens: GapItem[] = rows.map((r) => {
    const descricaoReal =
      (r.requisitoId ? descPorReqId.get(r.requisitoId) : undefined) ??
      (r.requisitoCodigo ? descPorCodigo.get(r.requisitoCodigo) : undefined) ??
      r.justificativa ??
      r.requisitoCodigo ??
      "";
    return {
      requisitoId:     r.requisitoId,
      requisitoCodigo: r.requisitoCodigo,
      descricao:       descricaoReal,
      statusCobertura: r.statusCobertura,
      documentoId:     r.documentoId,
      documentoTitulo: r.documentoId ? titulos.get(r.documentoId) ?? null : null,
      venceEm:         r.venceEm ? r.venceEm.toISOString() : null,
      metodoMatch:     r.metodoMatch,
      confianca:       r.confianca,
      justificativa:   r.justificativa,
    };
  });

  const calculadoEm = rows[0]?.calculadoEm ?? new Date();
  const familiasHabilitadas = await computarFamiliasHabilitadas(licitacaoId);
  return montarResultado(lic.id, lic.numero, itens, calculadoEm, familiasHabilitadas);
}

/**
 * Computa as famílias CRC em que nos habilitamos (derivado, não persistido):
 * roda calcularAderencia(licitacaoId) e enriquece familiasUsadas com o nome
 * (SELECT em familias por id). Operação leve. Falha silenciosa → [].
 */
async function computarFamiliasHabilitadas(
  licitacaoId: string,
): Promise<GapResult["familiasHabilitadas"]> {
  try {
    const aderencia = await calcularAderencia(licitacaoId);
    const usadas = aderencia.familiasUsadas ?? [];
    if (usadas.length === 0) return [];

    const fams = await db
      .select({ id: familias.id, nome: familias.nome })
      .from(familias)
      .where(
        and(
          inArray(familias.id, usadas.map((f) => f.familiaId)),
          isNull(familias.deletadoEm),
        ),
      );
    const nomePorId = new Map<string, string>();
    for (const f of fams) nomePorId.set(f.id, f.nome);

    return usadas.map((f) => ({
      codigoCrc:     f.codigoCrc,
      nome:          nomePorId.get(f.familiaId) ?? f.codigoCrc,
      itensCobertos: f.itensCobertos,
    }));
  } catch {
    return [];
  }
}

function montarResultado(
  licitacaoId: string,
  numero: string,
  itens: GapItem[],
  calculadoEm: Date,
  familiasHabilitadas: GapResult["familiasHabilitadas"] = [],
): GapResult {
  const atendidos        = itens.filter((i) => i.statusCobertura === "ATENDIDO").length;
  const parciais         = itens.filter((i) => i.statusCobertura === "PARCIAL").length;
  const faltantes        = itens.filter((i) => i.statusCobertura === "FALTANTE").length;
  const venceAntesDaData = itens.filter((i) => i.statusCobertura === "VENCE_ANTES_DA_DATA").length;

  // classificarCobertura só emite ATENDIDO / VENCE_ANTES_DA_DATA / FALTANTE — não há
  // lógica de "parcial" real, então `parciais` é sempre 0 e não deve influenciar o
  // semáforo (mantemos a contagem em `totais` apenas para a forma do contrato/UI).
  // Sem NENHUM item mapeado (edital não analisado) não há habilitação a cobrir —
  // estado NEUTRO, não "coberta" (evita falso verde antes de rodar a análise IA).
  let semaforo: GapResult["semaforo"];
  if (itens.length === 0) semaforo = "SEM_DADOS";
  else if (faltantes > 0) semaforo = "VERMELHO";
  else if (venceAntesDaData > 0) semaforo = "AMARELO";
  else semaforo = "VERDE";

  return {
    licitacaoId,
    numero,
    semaforo,
    totais: { total: itens.length, atendidos, parciais, faltantes, venceAntesDaData },
    itens,
    familiasHabilitadas,
    calculadoEm: calculadoEm.toISOString(),
  };
}

/** Erro tipado para o route converter em 404. */
export class GapNotFound extends Error {
  constructor() {
    super("Licitação não encontrada");
    this.name = "GapNotFound";
  }
}
