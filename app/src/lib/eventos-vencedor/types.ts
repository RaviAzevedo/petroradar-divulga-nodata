import type {
  TipoEventoVencedor, MotivoEventoVencedor, FonteEventoVencedor,
} from "@/db/schema";

export type { TipoEventoVencedor, MotivoEventoVencedor, FonteEventoVencedor };

export interface EventoVencedor {
  id:             string;
  numeroLicitacao: string;
  ordem:          number;
  cnpj:           string;
  fornecedor:     string;
  tipo:           TipoEventoVencedor;
  dataEvento:     string;          // ISO
  motivo:         MotivoEventoVencedor | null;
  motivoDetalhe:  string | null;
  fonte:          FonteEventoVencedor;
  observacao:     string | null;
  registradoPor:  string | null;
  registradoPorNome: string | null;
  registradoEm:   string;
}

export interface AguardandoConvocacao {
  numeroLicitacao: string;
  licitacaoId:     string | null;
  objeto:          string | null;
  segmento:        string | null;
  empresa:         string | null;
  cnpjVencedorAtual:    string | null;
  fornecedorVencedor:   string | null;
  posicaoProponente:      number;        // 2, 3, 4...
  valorPropostaProponente: number | null;
  detectadoEm:     string;
  diasDesdeAnuncio: number;
}

export interface EstatisticasConvocacoes {
  periodoMeses:           number;
  totalConvocacoes:       number;       // total de eventos CONVOCADO no período
  convocacoesParaProponente: number;
  desclassificacoesObservadas: number;
  topVencedoresQueDesclassificam: Array<{
    cnpj:       string;
    fornecedor: string;
    vencidas:   number;
    desclassificadas: number;
    taxa:       number;     // %
  }>;
}
