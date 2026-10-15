/**
 * Análise estruturada de editais via Claude (tool-use / JSON-schema + Zod).
 *
 * Antes, este módulo pedia "responda em JSON" e parseava texto cru com regex e
 * balanceamento de chaves — frágil: qualquer markdown, vírgula sobrando ou
 * truncamento corrompia a análise silenciosamente.
 *
 * Agora forçamos o modelo a responder via tool-use (function calling) com um
 * JSON-schema rígido (ver analise-schema.ts). O SDK devolve o `input` do
 * tool_use já desserializado; validamos com Zod e, se algo escapar, marcamos
 * a flag erro_parse (persistida em analises_ia) em vez de inventar dados.
 *
 * A interface AnaliseResult é mantida (consumida por pacote-orcamento/briefing
 * e pela rota /api/licitacoes/[id]/analise); novos campos foram acrescentados
 * de forma aditiva — nada removido.
 *
 * SEGURANÇA (Frente #9): as instruções ficam SEMPRE no parâmetro `system`,
 * separadas do dado não confiável; o texto do edital entra no message do usuário
 * delimitado por <documento_nao_confiavel> (defesa contra prompt injection); o
 * cliente usa timeout/maxRetries explícitos; e tratamos stop_reason="max_tokens"
 * como erro (NÃO persistimos saída truncada como análise válida).
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/lib/config";
import { INSTRUCAO_ANALISE_EDITAL } from "@/lib/ai-contract";
import { criarClienteAnthropic } from "@/lib/ia/gate";
import {
  SCHEMA_VERSAO,
  TOOL_ANALISE_NOME,
  buildToolInputSchema,
  validarAnalise,
  type RequisitoEstruturado,
} from "./analise-schema";

// Instrução estática do sistema — fonte canônica: shared/ai-contract.json (H2).
const INSTRUCAO_SISTEMA = INSTRUCAO_ANALISE_EDITAL;

export interface AnaliseResult {
  resumo_executivo: string;
  objeto_detalhado: string;
  escopo_resumido: string;
  exclusoes_escopo: string;
  requisitos_tecnicos: string[];
  criterios_habilitacao: string[];
  criterios_julgamento: string;
  valor_estimado: string;
  prazos_importantes: string[];
  riscos_alertas: Array<{ descricao: string; classificacao: string }>;
  recomendacao: string;
  checklist: Record<string, unknown>;
  // ── Extração estruturada com rastreabilidade ──
  requisitos_estruturados: RequisitoEstruturado[];
  _modelo: string;
  _tokens_input: number;
  _tokens_output: number;
  // Tokens de cache (prompt caching do bloco system). Sempre numéricos — nunca
  // undefined —, senão JSON.stringify os OMITE e o respostaRaw deixa de casar
  // com o do BFF (paridade Next↔BFF é invariante do projeto). Antes o custo
  // gravado subfaturava, porque ignorava os dois.
  _cache_creation_input_tokens: number;
  _cache_read_input_tokens: number;
  _tempo_ms: number;
  // ── Metadados de qualidade da extração ──
  _erro_parse: boolean;
  _schema_versao: number;
  _erro_detalhe?: string;
}

export async function analisarComClaude(
  texto: string,
  numero: string,
  modelo: string = MODELS.analise,
): Promise<AnaliseResult> {
  const start = Date.now();

  // Cliente criado AQUI (não no topo do módulo): a trava da allowlist só pode
  // disparar quando a análise de fato roda, não na importação do módulo — senão
  // qualquer rota que importe este arquivo quebraria no boot.
  const client = criarClienteAnthropic("analise-edital");

  const tool: Anthropic.Tool = {
    name: TOOL_ANALISE_NOME,
    description:
      "Registra a análise estruturada do edital de licitação (resumo, escopo, requisitos rastreáveis, riscos, recomendação e checklist).",
    input_schema: buildToolInputSchema(),
  };

  // Dado NÃO confiável (texto extraído do edital) vai no message do usuário,
  // dentro de um delimitador claro. As instruções ficam todas no `system`.
  //
  // O TETO. Era `texto.slice(0, 100000)` — 100 mil caracteres, ~28,5k tokens.
  // Herdado de quando o modelo tinha 200k de contexto. O Sonnet 5 tem 1 MILHÃO.
  //
  // Medido numa licitação de referência: a documentação completa tinha ~930 mil
  // caracteres. O teto de 100k entregava 10,7% dela ao modelo — e como a
  // concatenação segue a ordem do banco, o que sobrava eram os dois PDFs do edital
  // e MAIS NADA: a Especificação Técnica, os Requisitos de Habilitação e o
  // Detalhamento dos Postos de Serviço ficavam de fora. O briefing saía incompleto
  // e ninguém sabia por quê, porque o corte era mudo.
  //
  // 1.500.000 chars ≈ 430k tokens: cabe o maior edital que já vimos, com folga
  // dentro do 1M de contexto, e custa ~US$ 1,29 de input no pior caso. Frente ao
  // valor de uma licitação desse porte, isso é ruído.
  //
  // Se AINDA assim estourar, o corte é ANUNCIADO ao modelo (e o chamador recebe
  // _truncado) — um briefing que se sabe incompleto vale mais que um que mente.
  const MAX_CHARS = Number(process.env.ANALISE_MAX_CHARS ?? 1_500_000);
  const truncado = texto.length > MAX_CHARS;
  const corpo = truncado ? texto.slice(0, MAX_CHARS) : texto;

  const avisoTruncagem = truncado
    ? `\n\nATENÇÃO: a documentação desta licitação (${texto.length.toLocaleString("pt-BR")} caracteres) excedeu o limite processável e foi CORTADA em ${MAX_CHARS.toLocaleString("pt-BR")} caracteres. Você está vendo apenas o início. Diga explicitamente no resumo_executivo que a análise é PARCIAL e liste, em riscos_alertas, um risco ALTO de que requisitos podem não ter sido lidos.`
    : "";

  const conteudoUsuario = `Edital da licitação ${numero}. Analise o texto a seguir (delimitado) e chame a ferramenta "${TOOL_ANALISE_NOME}" com os dados estruturados.${avisoTruncagem}

<documento_nao_confiavel>
${corpo}
</documento_nao_confiavel>`;

  // STREAMING, e não `messages.create`. Este é o ponto mais caro do sistema e a
  // combinação anterior podia FATURAR A MESMA ANÁLISE 3 VEZES:
  //
  //   O gate cria o cliente com `timeout: 120000, maxRetries: 2`. O timeout do SDK
  //   é POR TENTATIVA, e um timeout de conexão é um erro *retryable* — o SDK repete.
  //   Cada tentativa é uma geração COMPLETA, faturada no servidor da Anthropic
  //   mesmo que o cliente já tenha desistido. Com max_tokens=16000, uma saída de
  //   tool_use grande (checklist de 12 seções + requisitos com trecho_citado) leva
  //   mais de 120s — e aí são 3 gerações pagas, ~US$ 0,60, e um 503 na cara do
  //   usuário. Pior: o SDK TEM uma proteção para isso (calculateNonstreamingTimeout,
  //   que para max_tokens=16000 daria ~600s), mas ela só roda quando o cliente NÃO
  //   define `timeout` — ao fixarmos 120s, nós a desligamos sem saber.
  //
  // Com `.stream()` o timeout de inatividade deixa de valer sobre a geração inteira
  // (os eventos SSE chegam continuamente), que é exatamente a recomendação oficial
  // da Anthropic para max_tokens alto. `finalMessage()` devolve a mesma Message do
  // caminho não-streaming — nada abaixo daqui muda.
  const stream = client.messages.stream({
    model: modelo,
    // 32000: precisa caber o raciocínio (abaixo) MAIS o tool_use completo — que
    // num edital com ET + adendos vem gordo (12 seções de checklist + dezenas de
    // requisitos rastreáveis com trecho_citado). Só é seguro porque a chamada é
    // streaming; num POST comum, esse teto arriscaria timeout de HTTP.
    max_tokens: 32000,
    // RACIOCÍNIO LIGADO — e isto mudou de ideia junto com o teto de entrada.
    //
    // Enquanto o modelo via 28k tokens (o corte antigo de 100k chars), desligar o
    // thinking era defensável: era pouca coisa, e os tokens de raciocínio comem o
    // orçamento de saída. Agora ele recebe o acervo inteiro — ~340k tokens de
    // edital, ET, adendos, critérios de habilitação e planilha de postos. Pedir a
    // um modelo que leia 340k tokens e preencha 12 seções rastreáveis SEM pensar é
    // exatamente o cenário em que ele passa o olho e devolve genérico — que é a
    // queixa que originou esta correção.
    //
    // Na Claude API, tool_choice forçado convive com adaptive thinking (a restrição
    // que exige thinking desligado é só do Bedrock).
    thinking: { type: "adaptive" },
    // Efeito alto: a tarefa é achar a agulha (um critério técnico de 1.069 chars
    // perdido em 1,2 milhão) — não é hora de economizar raciocínio.
    output_config: { effort: "high" },
    // Bloco estático (instruções + tool) entra como system com cache_control:
    // entre licitações só muda o texto do edital, então cacheamos o invariante.
    system: [
      {
        type: "text",
        text: INSTRUCAO_SISTEMA,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [tool],
    // Força o modelo a usar exatamente este tool (sem texto solto / sem markdown).
    tool_choice: { type: "tool", name: TOOL_ANALISE_NOME },
    messages: [{ role: "user", content: conteudoUsuario }],
  });

  const message = await stream.finalMessage();
  const elapsed = Date.now() - start;

  // Se o modelo bateu o teto de tokens, o `input` do tool_use vem truncado e
  // inválido. NÃO devemos persistir isso como análise válida — lança pra rota
  // tratar (em vez de gravar um fallback "fake" como análise concluída).
  if (message.stop_reason === "max_tokens") {
    throw new Error("Resposta da IA truncada (max_tokens). Texto do edital muito longo.");
  }

  // Tokens de cache: o SDK só popula estes campos quando há cache_control (é o
  // nosso caso, no bloco system). Normalizamos para número — o custo real da
  // chamada inclui os dois, e ignorá-los subfatura a análise.
  const cacheCriacao = message.usage.cache_creation_input_tokens ?? 0;
  const cacheLeitura = message.usage.cache_read_input_tokens ?? 0;

  // Localiza o bloco tool_use (com tool_choice forçado, deve existir).
  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  if (!toolUse) {
    // Modelo não chamou o tool (raro com tool_choice forçado) → erro de parse.
    return montarResultado(
      validarAnalise({}).data,
      modelo,
      message.usage.input_tokens,
      message.usage.output_tokens,
      cacheCriacao,
      cacheLeitura,
      elapsed,
      true,
      "Modelo não retornou bloco tool_use",
    );
  }

  const { ok, data, erro } = validarAnalise(toolUse.input);

  return montarResultado(
    data,
    modelo,
    message.usage.input_tokens,
    message.usage.output_tokens,
    cacheCriacao,
    cacheLeitura,
    elapsed,
    !ok,
    erro,
  );
}

function montarResultado(
  data: ReturnType<typeof validarAnalise>["data"],
  modelo: string,
  tokensInput: number,
  tokensOutput: number,
  cacheCriacao: number,
  cacheLeitura: number,
  tempoMs: number,
  erroParse: boolean,
  erroDetalhe?: string,
): AnaliseResult {
  return {
    resumo_executivo:   data.resumo_executivo,
    objeto_detalhado:   data.objeto_detalhado,
    escopo_resumido:    data.escopo_resumido,
    exclusoes_escopo:   data.exclusoes_escopo,
    requisitos_tecnicos:    data.requisitos_tecnicos,
    criterios_habilitacao:  data.criterios_habilitacao,
    criterios_julgamento:   data.criterios_julgamento,
    valor_estimado:     data.valor_estimado,
    prazos_importantes: data.prazos_importantes,
    riscos_alertas:     data.riscos_alertas,
    recomendacao:       data.recomendacao,
    checklist:          data.checklist,
    requisitos_estruturados: data.requisitos_estruturados,
    _modelo:        modelo,
    _tokens_input:  tokensInput,
    _tokens_output: tokensOutput,
    _cache_creation_input_tokens: cacheCriacao,
    _cache_read_input_tokens:     cacheLeitura,
    _tempo_ms:      tempoMs,
    _erro_parse:    erroParse,
    _schema_versao: SCHEMA_VERSAO,
    _erro_detalhe:  erroDetalhe,
  };
}
