/**
 * Go/No-Go Score de Aderência CRC + Habilitabilidade
 *
 * Cruza, antes de orçar, três sinais para emitir um semáforo VERDE/AMARELO/VERMELHO
 * de habilitabilidade direto na página da licitação:
 *
 *   1. Aderência de famílias CRC (licitacoes_familias_match / calcularAderencia)
 *   2. Cobertura dos requisitos do edital (requisitos_edital) pelo cofre
 *      (documentos_habilitacao VIGENTE) e pelas famílias CRC ativas
 *   3. Status das famílias CRC envolvidas (statusFluxoCrc = 'A' / validadeFim)
 *
 * É read-only: NÃO persiste — o resultado materializado de gap fica em
 * gap_habilitacao (ver gap-habilitacao.ts). Aqui calculamos o "veredito" rápido
 * que a UI mostra ao abrir a licitação.
 */

import { db } from "@/db";
import {
  licitacoes,
  requisitosEdital,
  documentosHabilitacao,
  familias,
  licitacoesFamiliasMatch,
} from "@/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { calcularAderencia } from "@/lib/conformidade/familias/match";

type SemaforoGoNoGo = "VERDE" | "AMARELO" | "VERMELHO" | "SEM_DADOS";

interface RequisitoCobertura {
  requisitoId:  string;
  codigo:       string;
  descricao:    string;
  obrigatorio:  boolean;
  status:       "ATENDIDO" | "PARCIAL" | "FALTANTE" | "VENCE_ANTES_DA_DATA";
  documentoId:  string | null;
  documentoTitulo: string | null;
  venceEm:      string | null;   // ISO — validadeFim do documento, se aplicável
}

export interface GoNoGoResult {
  licitacaoId:   string;
  numero:        string;
  semaforo:      SemaforoGoNoGo;
  // Aderência de famílias CRC (reaproveita o cache de match)
  scoreAderencia: number;        // 0..100
  totalItens:    number;
  itensCobertos: number;
  familiasFaltantes: string[];
  // Famílias CRC da Proponente que COBREM itens desta licitação (= familiasUsadas
  // enriquecidas com o nome). Mostra em QUAIS famílias CRC nos habilitamos.
  familiasHabilitadas: { codigoCrc: string; nome: string; itensCobertos: number }[];
  // Cobertura dos requisitos do edital
  totalRequisitos:      number;
  requisitosAtendidos:  number;
  requisitosFaltantes:  number;
  requisitosVencendo:   number;  // documento vence antes da data de abertura
  requisitos:           RequisitoCobertura[];
  // Famílias CRC com status crítico (vencidas / não ativas)
  familiasComProblema:  { codigoCrc: string; nome: string; statusFluxoCrc: string | null; validadeFim: string | null }[];
  // Data de referência usada para o teste de validade (abertura/disputa do edital)
  dataReferencia:       string | null;
  recomendacao:         string;
}

/**
 * Resolve a data de referência (a partir da qual o documento precisa estar
 * vigente). Preferimos dataAbertura, depois dataDisputa, depois dataFim.
 * As colunas são `text` no schema, então parseamos defensivamente.
 */
function resolverDataReferencia(lic: typeof licitacoes.$inferSelect): Date | null {
  const candidatos = [lic.dataAbertura, lic.dataDisputa, lic.dataFim];
  for (const c of candidatos) {
    if (!c) continue;
    // Aceita ISO (YYYY-MM-DD...) ou dd/mm/yyyy
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

/**
 * Calcula o Go/No-Go de uma licitação. Lança Error se a licitação não existir
 * (o route converte em 404).
 */
export async function calcularGoNoGo(licitacaoId: string): Promise<GoNoGoResult> {
  const [lic] = await db
    .select()
    .from(licitacoes)
    .where(eq(licitacoes.id, licitacaoId))
    .limit(1);

  if (!lic) {
    throw new GoNoGoNotFound();
  }

  const dataRef = resolverDataReferencia(lic);

  // 1. Aderência de famílias — reusa o cache se existir, senão calcula ao vivo
  const [matchCache] = await db
    .select()
    .from(licitacoesFamiliasMatch)
    .where(eq(licitacoesFamiliasMatch.licitacaoId, licitacaoId))
    .limit(1);

  const aderencia = matchCache
    ? {
        totalItens:        matchCache.totalItens,
        itensCobertos:     matchCache.itensCobertos,
        scoreAderencia:    matchCache.scoreAderencia,
        familiasUsadas:    matchCache.familiasUsadas ?? [],
        familiasFaltantes: matchCache.familiasFaltantes ?? [],
      }
    : await calcularAderencia(licitacaoId);

  // A aderência só é um sinal válido quando houve itens-família para avaliar.
  // Sem itens (licitação sem itens CRC mapeados / sem cache), scoreAderencia é 0
  // por convenção — NÃO significa baixa aderência, e por isso não pode derrubar
  // o semáforo para VERMELHO/AMARELO.
  const aderenciaAvaliada = aderencia.totalItens > 0;

  // 2. Requisitos do edital
  const requisitos = await db
    .select()
    .from(requisitosEdital)
    .where(eq(requisitosEdital.licitacaoId, licitacaoId))
    .orderBy(requisitosEdital.ordem);

  // Documentos VIGENTES do cofre (cofre é global — não há vínculo por licitação)
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
        // 0034/S14: INCONDICIONAL — a seleção de prova do
        // go/no-go nunca cita documento restrito, nem p/ Conformidade.
        // Espelha licitacoes_id_go_no_go.py do BFF.
        eq(documentosHabilitacao.restrito, false),
      ),
    );

  // Index por subcategoria — escolhe o doc com maior validade
  const docPorSubcat = new Map<string, (typeof docsVigentes)[number]>();
  for (const d of docsVigentes) {
    const atual = docPorSubcat.get(d.subcategoria);
    if (!atual) {
      docPorSubcat.set(d.subcategoria, d);
      continue;
    }
    // Prioriza indeterminada; senão, maior validadeFim
    if (d.validadeIndeterminada && !atual.validadeIndeterminada) {
      docPorSubcat.set(d.subcategoria, d);
    } else if (!atual.validadeIndeterminada && d.validadeFim && atual.validadeFim && d.validadeFim > atual.validadeFim) {
      docPorSubcat.set(d.subcategoria, d);
    }
  }

  const coberturas: RequisitoCobertura[] = requisitos.map((req) => {
    // O `codigo` do requisito segue o vocabulário de SubcategoriaDocHab quando possível
    const doc = docPorSubcat.get(req.codigo);
    if (!doc) {
      return {
        requisitoId:  req.id,
        codigo:       req.codigo,
        descricao:    req.descricao,
        obrigatorio:  req.obrigatorio,
        status:       "FALTANTE",
        documentoId:  null,
        documentoTitulo: null,
        venceEm:      null,
      };
    }
    // Verifica validade vs data de referência
    let status: RequisitoCobertura["status"] = "ATENDIDO";
    if (!doc.validadeIndeterminada && doc.validadeFim && dataRef && doc.validadeFim < dataRef) {
      status = "VENCE_ANTES_DA_DATA";
    }
    return {
      requisitoId:  req.id,
      codigo:       req.codigo,
      descricao:    req.descricao,
      obrigatorio:  req.obrigatorio,
      status,
      documentoId:  doc.id,
      documentoTitulo: doc.titulo,
      venceEm:      doc.validadeFim ? doc.validadeFim.toISOString() : null,
    };
  });

  const totalRequisitos     = coberturas.length;
  const requisitosAtendidos = coberturas.filter((c) => c.status === "ATENDIDO").length;
  const requisitosFaltantes = coberturas.filter((c) => c.status === "FALTANTE" && c.obrigatorio).length;
  const requisitosVencendo  = coberturas.filter((c) => c.status === "VENCE_ANTES_DA_DATA").length;

  // 3. Famílias CRC envolvidas (as que deram match) com status crítico.
  // Prioriza o cache; sem cache, usa as famílias do cálculo ao vivo (calcularAderencia
  // expõe `familiasUsadas`), garantindo que famílias vencidas/suspensas sejam
  // sinalizadas mesmo quando o match nunca foi materializado.
  const familiasUsadas = matchCache?.familiasUsadas ?? aderencia.familiasUsadas ?? [];
  const familiasUsadasIds = familiasUsadas.map((f) => f.familiaId);
  let familiasComProblema: GoNoGoResult["familiasComProblema"] = [];
  // Nome por id — reaproveita a mesma busca em `familias` (por id) que sinaliza
  // famílias com problema, agora também para enriquecer as famílias habilitadas.
  const nomePorFamiliaId = new Map<string, string>();
  if (familiasUsadasIds.length > 0) {
    const fams = await db
      .select({
        id:             familias.id,
        codigoCrc:      familias.codigoCrc,
        nome:           familias.nome,
        statusFluxoCrc: familias.statusFluxoCrc,
        validadeFim:    familias.validadeFim,
      })
      .from(familias)
      .where(
        and(
          inArray(familias.id, familiasUsadasIds),
          isNull(familias.deletadoEm),
        ),
      );

    for (const f of fams) nomePorFamiliaId.set(f.id, f.nome);

    familiasComProblema = fams
      .filter((f) => {
        const naoAtiva = f.statusFluxoCrc !== "A";
        const vencida  = f.validadeFim != null && dataRef != null && f.validadeFim < dataRef;
        return naoAtiva || vencida;
      })
      .map((f) => ({
        codigoCrc:      f.codigoCrc,
        nome:           f.nome,
        statusFluxoCrc: f.statusFluxoCrc ?? null,
        validadeFim:    f.validadeFim ? f.validadeFim.toISOString() : null,
      }));
  }

  // Famílias CRC em que nos habilitamos: as que cobrem itens (familiasUsadas),
  // enriquecidas com o nome buscado acima.
  const familiasHabilitadas: GoNoGoResult["familiasHabilitadas"] = familiasUsadas.map((f) => ({
    codigoCrc:     f.codigoCrc,
    nome:          nomePorFamiliaId.get(f.familiaId) ?? f.codigoCrc,
    itensCobertos: f.itensCobertos,
  }));

  // ── Veredito do semáforo ───────────────────────────────────────────────────
  // VERMELHO: requisito obrigatório faltante, ou família crítica, ou aderência muito baixa
  // AMARELO:  documento vence antes da data, ou aderência média, ou cobertura parcial
  // VERDE:    tudo atendido e aderência alta
  // A aderência só pesa no semáforo quando foi REALMENTE avaliada sobre itens
  // (aderenciaAvaliada). Caso contrário é tratada como NEUTRA: uma licitação sem
  // itens CRC mas com habilitação 100% coberta deve ficar VERDE, não VERMELHA.
  // NADA AVALIÁVEL: sem requisitos do edital mapeados E sem itens CRC avaliados —
  // não há habilitação para cobrir. Estado NEUTRO (não é "coberta"): a UI orienta
  // rodar a análise IA do edital, em vez de liberar o orçamento com um falso verde.
  const nadaAvaliavel = totalRequisitos === 0 && !aderenciaAvaliada;

  let semaforo: SemaforoGoNoGo;
  if (nadaAvaliavel) {
    semaforo = "SEM_DADOS";
  } else if (
    requisitosFaltantes > 0 ||
    familiasComProblema.length > 0 ||
    (aderenciaAvaliada && aderencia.scoreAderencia < 40)
  ) {
    semaforo = "VERMELHO";
  } else if (
    requisitosVencendo > 0 ||
    (aderenciaAvaliada && aderencia.scoreAderencia < 70) ||
    (totalRequisitos > 0 && requisitosAtendidos < totalRequisitos)
  ) {
    semaforo = "AMARELO";
  } else {
    semaforo = "VERDE";
  }

  const recomendacao =
    semaforo === "SEM_DADOS"
      ? "Sem requisitos de habilitação nem itens CRC mapeados — rode a análise IA do edital para avaliar a habilitação."
      : semaforo === "VERMELHO"
        ? "NÃO recomendado prosseguir sem resolver gaps de habilitação/CRC antes de orçar."
        : semaforo === "AMARELO"
          ? "Avaliar com cautela — há documentos vencendo ou cobertura parcial; renovar antes do protocolo."
          : "Habilitação coberta — pode prosseguir para orçamento.";

  return {
    licitacaoId:   lic.id,
    numero:        lic.numero,
    semaforo,
    scoreAderencia: Math.round(aderencia.scoreAderencia * 10) / 10,
    totalItens:    aderencia.totalItens,
    itensCobertos: aderencia.itensCobertos,
    familiasFaltantes: aderencia.familiasFaltantes,
    familiasHabilitadas,
    totalRequisitos,
    requisitosAtendidos,
    requisitosFaltantes,
    requisitosVencendo,
    requisitos:    coberturas,
    familiasComProblema,
    dataReferencia: dataRef ? dataRef.toISOString() : null,
    recomendacao,
  };
}

/** Erro tipado para o route converter em 404. */
export class GoNoGoNotFound extends Error {
  constructor() {
    super("Licitação não encontrada");
    this.name = "GoNoGoNotFound";
  }
}
