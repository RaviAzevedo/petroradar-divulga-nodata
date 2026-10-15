/**
 * Execução + persistência da análise de edital — o ÚNICO caminho que gasta token.
 *
 * Extraído de app/api/licitacoes/[id]/analise/route.ts para que a rota clássica
 * (POST /analise) e a rota do dossiê (POST /dossie) compartilhem exatamente a
 * mesma lógica de: montar o texto-fonte, chamar o Claude, precificar e gravar.
 * Duplicar isso significaria duas tabelas de preço, dois upserts e — na prática —
 * duas chances de cobrar e não gravar.
 *
 * Toda a política de custo mora aqui:
 *   - o cliente Anthropic vem do gate (lib/ia/gate.ts), que só libera este módulo;
 *   - o modelo é validado contra a allowlist de MODELS;
 *   - o custo inclui os tokens de cache (write 1,25x / read 0,1x), que a versão
 *     anterior ignorava e por isso subfaturava;
 *   - o upsert é atômico (onConflictDoUpdate) — em corrida, dois requests não
 *     violam a UNIQUE de licitacao_id.
 */

import { db } from "@/db";
import { anexos, analisesIa, circulares } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { analisarComClaude } from "@/lib/licitacoes/claude";
import { MODELS, MODEL_PRICING } from "@/lib/config";

export type AnaliseSalva = typeof analisesIa.$inferSelect;

/** Erro de negócio com código estável para a rota traduzir em HTTP. */
export class AnaliseError extends Error {
  constructor(readonly code: "NO_TEXT" | "INVALID_MODEL", message: string) {
    super(message);
    this.name = "AnaliseError";
  }
}

/**
 * Junta o texto dos anexos DEDUPLICANDO documentos repetidos.
 *
 * Por que isso existe: o Petronect entrega o mesmo acervo mais de uma vez. Numa
 * licitação de referência, "Adendo do Edital_.zip" e "Adendos do Edital.zip" continham
 * quase os mesmos arquivos — extrair os dois cru quase dobrava o volume de
 * caracteres em relação à documentação única. Isso não é só desperdício de token
 * (~US$ 1,50 a mais): o mesmo requisito aparecendo duas vezes com redações
 * ligeiramente diferentes confunde o modelo, e o excesso ainda empurrava conteúdo
 * único para fora do teto.
 *
 * O extrator de ZIP marca cada arquivo interno com `### <caminho>`. Aqui cortamos
 * nessas marcas e descartamos a seção cujo CONTEÚDO já apareceu (hash exato — nada
 * de "parecido", que arriscaria jogar fora um adendo que de fato mudou o texto).
 */
function deduplicar(textos: string[]): string {
  const vistos = new Set<string>();
  const saida: string[] = [];

  for (const texto of textos) {
    // Divide em seções `### nome`, preservando o preâmbulo sem marca.
    const partes = texto.split(/^(?=### )/m);
    for (const parte of partes) {
      const corpo = parte.replace(/^### .*\n/, "").trim();
      if (corpo.length < 50) continue;

      // Hash barato e suficiente: tamanho + amostras do começo/meio/fim. Dois
      // documentos diferentes praticamente não colidem; dois idênticos sempre batem.
      const chave = `${corpo.length}|${corpo.slice(0, 200)}|${corpo.slice(corpo.length >> 1, (corpo.length >> 1) + 100)}|${corpo.slice(-200)}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      saida.push(parte.trim());
    }
  }

  return saida.join("\n\n---\n\n");
}

export interface TextoDaLicitacao {
  texto: string;
  /**
   * true quando o texto veio de fato dos ANEXOS. false = só o campo `objeto`
   * (uma linha) + circulares.
   *
   * O chamador PRECISA olhar isto antes de gastar. A análise sobre o `objeto`
   * sozinho custa o mesmo (~US$ 0,15) e devolve um briefing vazio: sem prazos,
   * sem habilitação, sem riscos — porque essa informação nunca esteve no texto.
   * É a pior compra possível: preço cheio, valor zero.
   */
  temTextoDeAnexos: boolean;
  /** Quantos anexos contribuíram com texto. */
  anexosComTexto: number;
}

/**
 * Monta o texto-fonte da análise: o texto extraído de TODOS os anexos, mais as
 * circulares/esclarecimentos. É isto que vai para a Anthropic.
 */
export async function montarTextoDaLicitacao(
  licitacaoId: string,
  objetoFallback: string | null,
): Promise<TextoDaLicitacao> {
  const licAnexos = await db.select().from(anexos).where(eq(anexos.licitacaoId, licitacaoId));

  const comTexto = licAnexos.filter((a) => a.textoCache && a.textoCache.length > 100);
  const textoAnexos = deduplicar(comTexto.map((a) => a.textoCache!));

  const licCirculares = await db
    .select({
      tipo: circulares.tipo,
      autor: circulares.autor,
      mensagem: circulares.mensagem,
      dataPublicacao: circulares.dataPublicacao,
    })
    .from(circulares)
    .where(eq(circulares.licitacaoId, licitacaoId))
    .orderBy(desc(circulares.dataPublicacao));

  let textoCirculares = "";
  if (licCirculares.length > 0) {
    const itens = licCirculares
      .filter((c) => c.mensagem && c.mensagem.length > 5)
      .map((c) => {
        const data = c.dataPublicacao ? ` (${new Date(c.dataPublicacao).toLocaleDateString("pt-BR")})` : "";
        return `[${c.tipo}] ${c.autor ?? ""}${data}: ${c.mensagem}`;
      })
      .join("\n");
    if (itens) {
      textoCirculares = `\n\n--- NOTAS E ESCLARECIMENTOS (${licCirculares.length} circulares) ---\n${itens}`;
    }
  }

  return {
    texto: (textoAnexos || objetoFallback || "") + textoCirculares,
    temTextoDeAnexos: textoAnexos.length > 0,
    anexosComTexto: comTexto.length,
  };
}

/** Valida o modelo pedido contra a allowlist; devolve o default quando ausente. */
export function resolverModelo(pedido: unknown): string {
  if (typeof pedido !== "string") return MODELS.analise;
  const permitidos = Object.values(MODELS) as string[];
  if (!permitidos.includes(pedido)) {
    throw new AnaliseError("INVALID_MODEL", "Modelo de IA não permitido");
  }
  return pedido;
}

/**
 * Chama o Claude, calcula o custo real e grava em `analises_ia`.
 *
 * ESTA É A ÚNICA FUNÇÃO DO SISTEMA QUE GASTA DINHEIRO. Só a chame atrás de um
 * gate de autorização e de um rate limit.
 */
export async function executarEPersistirAnalise(
  licitacaoId: string,
  numero: string,
  texto: string,
  modelo: string,
  /**
   * De onde veio o texto que está sendo pago. PARÂMETRO OBRIGATÓRIO: quem gasta
   * tem de declarar sobre o que gastou. O chamador já sabe
   * (`TextoDaLicitacao.temTextoDeAnexos`); deixar isto opcional foi como a
   * procedência sumiu do banco nas análises já gravadas.
   */
  fonteTexto: "ANEXOS" | "OBJETO",
): Promise<AnaliseSalva> {
  if (texto.length < 50) {
    throw new AnaliseError("NO_TEXT", "Sem texto suficiente para análise. Baixe os anexos primeiro.");
  }

  const r = await analisarComClaude(texto, numero, modelo);

  // Tarifa por modelo, com degradação: modelo → default → referência do Sonnet.
  // Sem isso, um modelo fora da tabela estourava um TypeError DEPOIS da chamada
  // já paga, descartando a análise inteira.
  const preco =
    MODEL_PRICING[r._modelo] ??
    MODEL_PRICING[MODELS.analise] ??
    { input: 0.003, output: 0.015 };

  const precoCacheWrite = preco.cache_write ?? preco.input * 1.25;
  const precoCacheRead = preco.cache_read ?? preco.input * 0.1;

  const custoEstimado =
    (r._tokens_input * preco.input +
      r._tokens_output * preco.output +
      (r._cache_creation_input_tokens ?? 0) * precoCacheWrite +
      (r._cache_read_input_tokens ?? 0) * precoCacheRead) /
    1000;

  const valores = {
    resumo: r.resumo_executivo,
    objetoDetalhado: r.objeto_detalhado,
    checklist: r.checklist as Record<string, unknown>,
    requisitos: r.requisitos_tecnicos as unknown[],
    criteriosHabilitacao: r.criterios_habilitacao as unknown[],
    criteriosJulgamento: r.criterios_julgamento,
    valorEstimado: r.valor_estimado,
    prazos: r.prazos_importantes as unknown[],
    riscos: r.riscos_alertas as unknown[],
    recomendacao: r.recomendacao,
    modeloUsado: r._modelo,
    tokensInput: r._tokens_input,
    tokensOutput: r._tokens_output,
    tempoSegundos: r._tempo_ms / 1000,
    custoEstimado,
    // erro_parse e schema_versao existem no banco e vinham SEMPRE no default:
    // o insert nunca os gravava, então a UI nunca acendia o aviso de extração suja
    // e uma análise de schema antigo era servida como cache para sempre.
    erroParse: r._erro_parse,
    schemaVersao: r._schema_versao,
    // PROCEDÊNCIA. Sem estes dois, o briefing sai com cara de completo mesmo
    // quando foi construído sobre uma linha de objeto — e o leitor não tem como
    // saber. `texto.length` é o número que de fato entrou no modelo (anexos
    // deduplicados + circulares), não o tamanho do que existia no banco.
    fonteTexto,
    charsEntrada: texto.length,
    respostaRaw: JSON.stringify(r),
  };

  const [saved] = await db
    .insert(analisesIa)
    .values({ licitacaoId, ...valores })
    .onConflictDoUpdate({
      target: analisesIa.licitacaoId,
      set: { ...valores, atualizadoEm: new Date() },
    })
    .returning();

  return saved;
}
