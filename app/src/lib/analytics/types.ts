/**
 * Tipos de resposta das APIs de analytics. Compartilhados entre lib e UI.
 */

export interface PerformanceTrimestre {
  trimestre:        string;        // "2025-T2"
  inicio:           string;        // ISO date
  fim:              string;        // ISO date
  participacoes:    number;        // licitações que Proponente propôs
  vitorias:         number;        // que Proponente venceu (total — diretas + convocações)
  vitoriasDiretas:  number;        // vencedor anunciado direto
  vitoriasConvocacao: number;      // vitória após desclassificação do 1º
  taxaSucesso:      number;        // % (0..100)
  valorPropostoTotal: number;      // R$
  valorGanhoTotal:    number;      // R$
  posicaoMedia:     number | null; // ranking médio (1 = primeiro lugar)
}

export interface PerformanceResponse {
  trimestres:       PerformanceTrimestre[];
  resumo: {
    taxaSucessoAtual:   number;    // % do trimestre mais recente
    taxaSucessoAnterior: number;   // % do trimestre anterior (para delta)
    delta:              number;    // diferença em pontos percentuais
    valorGanho12m:      number;
    posicaoMediaAtual:  number | null;
  };
}

// ── Mercado ──────────────────────────────────────────────────────────────────

export interface SegmentoMercado {
  segmento:           string;
  totalLicitacoes:    number;
  valorTotalGasto:    number;
  valorMedioVencedor: number;
  spreadMedio:        number;       // (max - min) / med * 100, %
  mediaParticipantes: number;
  participacoesProponente: number;
  vitoriasProponente:   number;
  taxaSucessoProponente: number;
}

export interface SerieTemporalMes {
  mes:                string;       // "2025-04"
  totalLicitacoes:    number;
  valorTotal:         number;
  mediaPrecoVencedor: number;
}

export interface MercadoResponse {
  segmentos:          SegmentoMercado[];
  serieTemporal:      SerieTemporalMes[];
  totais: {
    licitacoesPeriodo: number;
    valorTotalPeriodo: number;
    mediaParticipantes: number;
    fornecedoresUnicos: number;
    concentracaoTop5:  number;     // % dos contratos ficam com top5
    percentualMeEpp:   number;     // % vencedores ME/EPP
  };
}

// ── Concorrência ─────────────────────────────────────────────────────────────

export interface ConcorrenteRanking {
  cnpj:              string;
  fornecedor:        string;
  encontros:         number;       // licitações onde apareceu junto com Proponente
  vitoriasDele:      number;       // vezes que ele ganhou
  vitoriasProponente:  number;       // vezes que Proponente ganhou (no encontro)
  taxaVitoriaDele:   number;       // %
}

export interface ConcorrenteAscensao {
  cnpj:              string;
  fornecedor:        string;
  vitorias3m:        number;       // vitórias últimos 3 meses
  vitorias12m:       number;       // vitórias 12 meses
  delta:             number;       // (3m / 3) − (12m / 12), positivo = ascensão
}

export interface HeatmapCelula {
  cnpj:              string;
  fornecedor:        string;
  segmento:          string;
  vitorias:          number;
  valorGanho:        number;
}

export interface ConcorrenciaResponse {
  topConcorrentes:    ConcorrenteRanking[];
  emAscensao:         ConcorrenteAscensao[];
  heatmap:            HeatmapCelula[];      // 10 cnpjs × 8 segmentos = ~80 células
  segmentosTop:       string[];             // ordenado por # licitações
}

// ── Oportunidades perdidas ──────────────────────────────────────────────────

export interface OportunidadePerdida {
  licitacaoId:       string;
  numero:            string;
  objeto:            string | null;
  segmento:          string | null;
  natureza:          string | null;
  empresa:           string | null;
  valorVencedor:     number | null;
  cnpjVencedor:      string | null;
  fornecedorVencedor: string | null;
  scoreAderencia:    number;       // 0..100
  itensCobertos:     number;
  totalItens:        number;
  detectadoEm:       string;       // ISO
}

// ── KPIs Proponente (agora respondem ao filtro temporal) ─────────────────────

interface ProponenteKpis {
  totalParticipacoes: number;
  totalVitorias:      number;
  taxaSucesso:        number;      // %
  periodoMeses:       number;      // 0 = all-time
}

// ── Aba Proponente: lista de licitações onde Proponente propôs ──────────────────

/**
 * Tipo da vitória — explica de onde vem a marcação `proponenteVenceu`:
 *   DIRETA       — cnpj_vencedor no portal = Proponente, sem evento de convocação
 *   CONVOCACAO   — Proponente foi convocada após desclassificação (há evento CONVOCADO/HOMOLOGADO)
 *   PIPELINE_ONLY — pipeline interno marcou GANHOU mas portal ainda não publicou resultado
 *   CONFLITO     — pipeline marcou GANHOU mas portal mostra outro vencedor (alerta)
 */
type VitoriaTipo = "DIRETA" | "CONVOCACAO" | "PIPELINE_ONLY" | "CONFLITO";

export interface ParticipacaoProponenteItem {
  numeroLicitacao:       string;
  licitacaoId:           string | null;
  objeto:                string | null;
  segmento:              string | null;
  empresa:               string | null;
  // Posição & valor da proposta Proponente (melhor de todos os itens)
  melhorPosicao:         number | null;
  valorProposta:         number | null;
  dataProposta:          string | null;
  // Vencedor atual da licitação (após eventos)
  cnpjVencedorAtual:     string | null;
  fornecedorVencedor:    string | null;
  valorVencedor:         number | null;
  totalParticipantes:    number | null;
  resultadoEm:           string | null;
  // Pipeline (se houver)
  participacaoId:        string | null;
  participacaoFase:      string | null;
  participacaoResultado: string | null;
  participacaoVersao:    number | null;
  // Flags derivadas (priorização: portal > eventos > pipeline)
  proponenteVenceu:        boolean;
  vitoriaTipo:           VitoriaTipo | null;
  venceuPorConvocacao:   boolean;
}

export interface ParticipacoesProponenteResponse {
  data: ParticipacaoProponenteItem[];
  totais: {
    total:            number;
    ganhou:           number;
    perdeu:           number;
    cancelou:         number;
    semResultado:     number;
    semParticipacao:  number;       // proposta no portal mas sem pipeline
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURES 25: tipos de analytics avançado (8 features compartilham este arquivo)
// ═══════════════════════════════════════════════════════════════════════════

// ── Benchmark de preço da PARTICIPAÇÃO (Análise de Preço-Alvo no DFP/PPU) ────
//
// A partir do segmento/natureza da licitação vinculada à participação, calcula
// a faixa de valorVencedor (p25/mediana/p75) em resultados similares + win-rate
// Proponente, e posiciona a proposta atual em relação à mediana de mercado.

// ── Mapa de Concorrentes por Família CRC ────────────────────────────────────
//
// Por família/segmento: top vencedores, ticket médio, desconto médio e
// head-to-head Proponente × concorrente.

// ── Copiloto de DFP/PPU: sugestão de preço ──────────────────────────────────

// ── Ficha de Concorrente 360 (dossiê por CNPJ) ──────────────────────────────

export interface DossieConcorrenteFamilia {
  familiaCodigo:    string | null;
  segmento:         string | null;
  vitorias:         number;
  ticketMedio:      number;
}

export interface DossieConcorrenteSerie {
  mes:              string;            // "2025-04"
  vitorias:         number;
  valorGanho:       number;
}

// Contrato revelado via Portal da Transparência (valor real + vigência)
export interface DossieConcorrenteContrato {
  numeroLicitacao:  string;
  licitacaoId:      string | null;
  objeto:           string | null;
  segmento:         string | null;
  valor:            number;            // valor_contrato_real
  contrato:         string | null;     // nº do contrato na Transparência
  situacao:         string | null;
  aditivos:         number | null;
  vigenciaInicio:   string | null;     // ISO "YYYY-MM-DD"
  vigenciaFim:      string | null;     // ISO "YYYY-MM-DD"
}

// ── Histórico Petrobras completo (Portal da Transparência, all-time por CNPJ) ─
//
// Alimentado pela tabela `transparencia_contratos` (sweep semanal cnpj-sweep).
// Diferente de `contratosRevelados` (só contratos ligados a licitações coletadas):
// aqui é o universo ALL-TIME do fornecedor na Petrobras.

export interface DossieHistoricoTransparenciaResumo {
  totalContratos:   number;
  valorTotal:       number;            // Σ valor (R$)
  ativos:           number;            // situacao = 'Ativo'
  primeiroAno:      number | null;     // min(ano de vigencia_inicio)
  ultimoAno:        number | null;     // max(ano de vigencia_fim)
}

export interface DossieHistoricoTransparenciaAno {
  ano:              number;            // ano de vigencia_inicio
  quantidade:       number;
  valor:            number;
}

export interface DossieHistoricoTransparenciaUnidade {
  unidade:          string;            // unidade administrativa (geografia)
  quantidade:       number;
  valor:            number;
}

export interface DossieHistoricoTransparenciaModalidade {
  modalidade:       string;
  quantidade:       number;
}

export interface DossieHistoricoTransparenciaContrato {
  processo:         string | null;     // nº licitação Petronect (COTR_CD_PROCESSO)
  objeto:           string | null;
  valor:            number;
  situacao:         string | null;     // Ativo / Concluído / Cancelado
  unidade:          string | null;
  vigenciaInicio:   string | null;     // ISO "YYYY-MM-DD"
  vigenciaFim:      string | null;     // ISO "YYYY-MM-DD"
}

export interface DossieHistoricoTransparencia {
  resumo:           DossieHistoricoTransparenciaResumo;
  porAno:           DossieHistoricoTransparenciaAno[];
  unidades:         DossieHistoricoTransparenciaUnidade[];       // top 5 por valor
  modalidades:      DossieHistoricoTransparenciaModalidade[];
  maioresContratos: DossieHistoricoTransparenciaContrato[];      // top 15 por valor
}

export interface DossieConcorrente {
  cnpj:             string;
  fornecedor:       string | null;
  // Histórico global de disputas
  encontrosGlobais: number;            // licitações em que apareceu (propostas)
  vitoriasGlobais:  number;            // vitórias (resultados)
  winRateGlobal:    number;            // %
  // Head-to-head vs Proponente
  encontrosProponente: number;
  vitoriasDeleVsProponente: number;
  vitoriasProponenteVsDele: number;
  // Agressividade de preço: desconto médio do vencedor sobre o maior valor
  descontoMedio:    number;            // %
  // Desclassificações registradas (licitacao_eventos_vencedor)
  desclassificacoes: number;
  // Tendência: ritmo 3m vs 12m
  vitorias3m:       number;
  vitorias12m:      number;
  tendencia:        "ALTA" | "ESTAVEL" | "QUEDA";
  // Famílias/segmentos onde mais vence
  familias:         DossieConcorrenteFamilia[];
  // Série temporal mensal de vitórias
  serie:            DossieConcorrenteSerie[];
  // Contratos revelados (Transparência): valor real + vigência
  contratosRevelados: DossieConcorrenteContrato[];
  // Histórico Petrobras completo (Transparência, all-time por CNPJ) — null se vazio
  historicoTransparencia: DossieHistoricoTransparencia | null;
  periodoMeses:     number;
}

// ── Benchmark de preço por família CRC (faixa de mercado) ───────────────────

// POST: onde um preço proposto cairia na distribuição
// ── Análise pós-mortem de derrota ───────────────────────────────────────────

// ── Radar de tendências de mercado ──────────────────────────────────────────

// ── Previsão de win-rate do edital (heurística ponderada) ───────────────────

