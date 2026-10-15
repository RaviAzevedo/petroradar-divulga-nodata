/**
 * Tipos e constantes compartilhados dos relatórios (módulo folha — não importa
 * nenhum outro módulo de relatório, para evitar ciclos com o registry).
 */

export const CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CT_PDF  = "application/pdf";

export type Formato = "xlsx" | "pdf";

export interface RelatorioArquivo {
  buffer:      Buffer;
  contentType: string;
  ext:         "xlsx" | "pdf";
  /**
   * Nome do arquivo SEM extensão. Opcional: sem ele a rota usa
   * `relatorio-<slug>-<data>`, que é o comportamento dos dois relatórios
   * antigos e continua byte a byte igual.
   *
   * Existe para relatório POR ENTIDADE: dois arquivos baixados no mesmo dia
   * sairiam com o MESMO nome e um sobrescreveria o outro.
   */
  nome?:       string;
}

export interface RelatorioDef {
  slug:        string;
  nome:        string;
  descricao:   string;
  /** Rótulo do público-alvo (só apresentação no card). */
  publico:     "gestao" | "comercial" | "operacional";
  /** Formatos oferecidos (o card só mostra os botões destes formatos). */
  formatos:    Formato[];
  /** Barreira real server-side (requireGestao | requireVisualizar). Lança em 401/403. */
  guard:       () => Promise<unknown>;
  /** Predicado p/ mostrar/esconder o card na UI (coerente com o guard). */
  podeVer:     (role: string) => boolean;
  /**
   * Coleta os dados e gera o arquivo no formato pedido (com fallback interno se preciso).
   * `params` é a query string inteira da rota — só relatório PARAMETRIZADO a lê
   * (ex.: `curriculo-rt`, que recebe o id do profissional);
   * os demais continuam com dois parâmetros e seguem atribuíveis a este tipo.
   */
  gerar:       (periodoMeses: number, formato: Formato, params?: URLSearchParams) => Promise<RelatorioArquivo>;
  /**
   * Se true, o relatório filtra por janela temporal → o card mostra o seletor de
   * meses. Se false/ausente, o relatório é "estado atual" (não usa período) e o
   * card esconde o seletor (evita seletor que não faz nada).
   */
  usaPeriodo?: boolean;
  /** Se true, a página /relatorios renderiza um preview em tela deste relatório. */
  temPreview?: boolean;
  /** Relatório parametrizado, chamado por outra tela pela URL — sem card no hub (o card não tem os inputs). */
  ocultoNoHub?: boolean;
}
