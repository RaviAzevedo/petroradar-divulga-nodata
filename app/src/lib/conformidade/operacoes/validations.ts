/**
 * Schemas de Validação — Cofre por operação (migration 0033)
 *
 * Cobre as rotas novas (/api/conformidade/operacoes*) e as EXTENSÕES das rotas
 * já existentes do cofre (filtro `operacaoId` no GET, campos `operacaoId`/`papel`
 * no POST, dedup por hash em /cofre/documentos/verificar).
 *
 * Por que as extensões moram aqui e não em `cofre/validations.ts`: elas são
 * `.extend()` dos schemas do cofre, então o schema-base continua sendo um só —
 * quem já valida upload hoje não muda de comportamento, e a lista de campos
 * novos fica junto do resto do domínio "operação".
 *
 * As tuplas de valores (DETENTORAS, PAPEIS_DOCUMENTO) vêm de
 * `@/lib/conformidade/operacoes` para não existir lista de enum duplicada entre
 * o domínio compartilhado com a tela e os schemas de request.
 *
 * MENSAGENS: todas em pt-BR porque caem direto na tela (o `detalhes` do 422 é
 * renderizado campo a campo). O Zod v4 só emite inglês no que não dá pra
 * customizar — erro de TIPO (`Invalid input: expected string, received number`)
 * e opção de enum (`Invalid option: expected one of "A"|"B"`). O espelho do BFF
 * replica as duas famílias literalmente.
 */

import { z } from "zod";
import {
  DETENTORAS,
  PAPEIS_DOCUMENTO,
  SITUACOES_PROVA,
  TIPOS_DOCUMENTO,
} from "@/lib/conformidade/operacoes";
import {
  CriarDocumentoSchema,
  FiltrosDocumentoSchema,
} from "@/lib/conformidade/cofre/validations";

// Reexportado (não recopiado) de propósito: o `detalhes` de 400/422 tem de ser
// o MESMO dict path→mensagem nas rotas do cofre e nas de operação, e é esse
// formato que o BFF replica.
export { formatZodErrors } from "@/lib/conformidade/cofre/validations";

// ── Helpers ──────────────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid("ID inválido");

/**
 * `true` quando a string é um UUID.
 *
 * Rota dinâmica usa isto ANTES de ir ao banco: `WHERE id = 'abc'` com id
 * não-UUID faz o Postgres estourar no cast (`uuid = text`) e a rota devolveria
 * 500 em vez de 404. O espelho do BFF resolve o mesmo caso comparando
 * `id::text = :id` — nos dois lados o resultado observável é 404.
 */
export function ehUuid(valor: string): boolean {
  return uuidSchema.safeParse(valor).success;
}

/**
 * "AAAA-MM-DD" que EXISTE no calendário.
 *
 * Só o formato não basta: "2019-02-31" passa em qualquer regex e o Postgres o
 * recusa no INSERT com erro de banco — ou seja, 500 em vez de 422. O
 * round-trip pelo `Date` resolve os dois casos (mês 13 vira Invalid Date; dia
 * 31 de fevereiro vira 03/03 e deixa de bater com a entrada).
 *
 * Exportado na 0034: o scan v2 (R13) valida `emitidoEm` com ESTA função — a
 * regra de data válida tem de ser uma só no módulo.
 */
export function ehDataIso(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const data = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === valor;
}

/**
 * `periodo_inicio`/`periodo_fim` são colunas `date` (não `timestamptz`): o
 * Drizzle devolve a STRING "AAAA-MM-DD" e é isso que entra e sai da API. Não
 * use o `dateTimeSchema` do cofre aqui — ISO 8601 com hora não cabe em `date`.
 *
 * Um `refine` só (em vez de `.regex().refine()`) de propósito: dois checks
 * gerariam DUAS mensagens para o mesmo campo, e o `formatZodErrors` guarda uma
 * por path — o BFF replicaria a errada.
 */
const dataSchema = z.string().refine(ehDataIso, "Data inválida. Use o formato AAAA-MM-DD.");

/**
 * Código da operação: "10008" no catálogo, mas cadastro manual pode usar
 * sufixo/prefixo ("10008-A", "OP.2026"). Regex da spec, sem espaço nem acento
 * — o código entra em URL, em nome de arquivo e no prefixo de título.
 */
const CODIGO_OPERACAO_REGEX = /^[A-Za-z0-9._-]{2,32}$/;

/** SHA-256 em hexadecimal MINÚSCULO — é o que `sha256Hex()` e o `createHash` do
 *  Node produzem, e é como o cofre grava a coluna `sha256`. */
const SHA256_REGEX = /^[0-9a-f]{64}$/;

// Mesma constante e mesma mensagem de `valorMonetarioSchema` (cofre/validations):
// o teto é o do domínio, não o da coluna numeric(18,2), e reaproveitá-lo evita
// inventar um segundo limite para a mesma grandeza.
const valorSchema = z
  .number()
  .nonnegative("Valor não pode ser negativo")
  .max(999_999_999_999_99, "Valor excede o limite permitido");

// numeric(14,2) comporta 12 dígitos inteiros; o teto abaixo é o da coluna.
const hhSchema = z
  .number()
  .nonnegative("HH não pode ser negativo")
  .max(999_999_999_999, "HH excede o limite permitido");

// ── 1. Filtros da listagem de operações ──────────────────────────────────────

/**
 * `comProva` chega como boolean já resolvido pelo handler ("1"/"true" → true),
 * mesmo padrão do `validadeIndeterminada` no POST do cofre. Fica no schema (e
 * não solto na rota) para o tipo do filtro ser um só e chegar tipado na query.
 */
export const FiltrosOperacaoSchema = z
  .object({
    busca: z.string().max(200, "Busca muito longa").optional(),
    comProva: z.boolean().default(false),
    detentora: z.enum(DETENTORAS).optional(),
    // 0044 (D11): TRI-ESTADO e sem default. Ausente = todas (ativas E
    // inativas), que é EXATAMENTE o conjunto de hoje. `true` = só ativas;
    // `false` = só inativas. Um default `true` aqui seria o corte escondido
    // que o D11 existe para não repetir (spec ONDA-5 §1c) — e no dia seguinte
    // seriam "obras que sumiram do índice". O handler resolve "1"/"0" fora do
    // zod, como já faz com `comProva`.
    ativo: z.boolean().optional(),
    // Janela sobre o PERÍODO DA OBRA, ambos ausentes por padrão. `ehDataIso`
    // valida formato E calendário ("2020-13-01" passa em regex e o Postgres
    // recusa com 22008, virando 500 em vez de 400).
    de:  z.string().refine(ehDataIso, "Data no formato AAAA-MM-DD").optional(),
    ate: z.string().refine(ehDataIso, "Data no formato AAAA-MM-DD").optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((d, ctx) => {
    // Comparação de STRING: vale porque o formato é AAAA-MM-DD já validado
    // acima (mesmo argumento do `CoberturaQuerySchema` da onda 4 e do
    // `AtendimentoQuerySchema` da onda 2) — em AAAA-MM-DD a ordem
    // lexicográfica e a cronológica coincidem.
    if (d.de && d.ate && d.de > d.ate) {
      ctx.addIssue({ code: "custom", message: "Data inicial maior que a final", path: ["ate"] });
    }
  });

export type FiltrosOperacaoInput = z.infer<typeof FiltrosOperacaoSchema>;

// ── 2. Criar operação (cadastro manual) ──────────────────────────────────────

/**
 * Só `codigo` e `clienteNome` são obrigatórios: o cadastro manual existe para
 * destravar um upload no meio da licitação, não para reproduzir a planilha do
 * catálogo. Todo campo opcional aceita `null` (a tela manda `null` no que o
 * usuário deixou em branco) e o handler trata `null` e ausente do mesmo jeito.
 *
 * `origem` NÃO entra no body: quem passa por aqui é sempre MANUAL. CATALOGO é
 * privativo da carga do catálogo (seed).
 */
export const CriarOperacaoSchema = z.object({
  codigo: z
    .string()
    .regex(
      CODIGO_OPERACAO_REGEX,
      "Código inválido. Use de 2 a 32 caracteres entre letras, números, ponto, hífen e sublinhado."
    ),

  clienteNome: z
    .string()
    .min(2, "Nome do cliente deve ter pelo menos 2 caracteres")
    .max(200, "Nome do cliente muito longo"),

  clienteGrupo: z.string().max(200, "Grupo do cliente muito longo").optional().nullable(),
  clienteCnpj: z
    .string()
    .regex(/^\d{14}$/, "CNPJ deve conter 14 dígitos")
    .optional()
    .nullable(),

  contratoNumero: z.string().max(100, "Número do contrato muito longo").optional().nullable(),
  unidade: z.string().max(200, "Unidade muito longa").optional().nullable(),
  // 0044 (B5): a ÁREA dentro da planta ("U-32", "Área 30", "Off-site"). Texto
  // livre, sem catálogo — o vocabulário é do cliente (spec ONDA-5 §1l).
  // `unidade` fica onde está e diz outra coisa (a planta/base).
  area: z.string().max(200, "Área muito longa").optional().nullable(),

  detentora: z.enum(DETENTORAS).default("PROPONENTE"),

  ramo: z.string().max(200, "Ramo muito longo").optional().nullable(),
  onshoreOffshore: z.string().max(50, "Valor muito longo").optional().nullable(),

  // Sem checagem cruzada início≤fim de propósito: o próprio catálogo pode ter
  // pares invertidos na origem, e recusar o cadastro por isso travaria o
  // usuário sem resolver o dado errado.
  periodoInicio: dataSchema.optional().nullable(),
  periodoFim: dataSchema.optional().nullable(),

  // Números no JSON (não string): a coluna é numeric e o handler converte com
  // String() na hora de inserir — casas decimais além de 2 o Postgres arredonda.
  valor: valorSchema.optional().nullable(),
  hh: hhSchema.optional().nullable(),

  escopo: z.string().max(4000, "Escopo muito longo").optional().nullable(),

  // Códigos CRC de referência para triagem — o vínculo que vale continua sendo
  // documentos_familias.
  familiasSugeridas: z
    .array(z.string().max(50, "Código de família muito longo"))
    .max(200, "Máximo de 200 famílias sugeridas")
    .optional()
    .nullable(),
});

export type CriarOperacaoInput = z.infer<typeof CriarOperacaoSchema>;

// ── 2b. Editar operação (PATCH /operacoes/[id] — R4, migration 0034) ─────────

/**
 * PATCH de operação: o CriarOperacaoSchema com tudo opcional, MENOS `codigo` e
 * `origem`, que NÃO são editáveis (chave de negócio e proveniência do seed).
 * `codigo` presente no body é recusado ANTES do parse (ver handler); `origem`
 * presente é ignorado (strip do z.object, como qualquer campo desconhecido).
 * `clienteNome` e `detentora` são optional SEM nullable: dá para não mexer,
 * não dá para apagar. `ativo` entra aqui (não existe no Criar): é o único jeito
 * de desativar operação sem DELETE.
 */
export const EditarOperacaoSchema = z.object({
  clienteNome: z.string().min(2, "Nome do cliente deve ter pelo menos 2 caracteres")
                 .max(200, "Nome do cliente muito longo").optional(),
  clienteGrupo: z.string().max(200, "Grupo do cliente muito longo").optional().nullable(),
  clienteCnpj: z.string().regex(/^\d{14}$/, "CNPJ deve conter 14 dígitos").optional().nullable(),
  contratoNumero: z.string().max(100, "Número do contrato muito longo").optional().nullable(),
  unidade: z.string().max(200, "Unidade muito longa").optional().nullable(),
  area: z.string().max(200, "Área muito longa").optional().nullable(),   // 0044 (B5)
  detentora: z.enum(DETENTORAS).optional(),
  ramo: z.string().max(200, "Ramo muito longo").optional().nullable(),
  onshoreOffshore: z.string().max(50, "Valor muito longo").optional().nullable(),
  periodoInicio: dataSchema.optional().nullable(),
  periodoFim: dataSchema.optional().nullable(),
  valor: valorSchema.optional().nullable(),
  hh: hhSchema.optional().nullable(),
  escopo: z.string().max(4000, "Escopo muito longo").optional().nullable(),
  familiasSugeridas: z.array(z.string().max(50, "Código de família muito longo"))
                      .max(200, "Máximo de 200 famílias sugeridas").optional().nullable(),
  ativo: z.boolean().optional(),
});

export type EditarOperacaoInput = z.infer<typeof EditarOperacaoSchema>;

// ── 3. Dedup por hash (POST /cofre/documentos/verificar) ─────────────────────

/**
 * A tela calcula o SHA-256 no navegador e pergunta ANTES de subir. Teto de 50
 * por chamada porque o lote da tela é de dezenas de arquivos, não de milhares —
 * e o `IN (...)` fica com tamanho previsível.
 */
export const VerificarHashesSchema = z.object({
  sha256: z
    .array(
      z
        .string()
        .regex(
          SHA256_REGEX,
          "Hash inválido. Informe o SHA-256 com 64 caracteres hexadecimais minúsculos."
        )
    )
    .min(1, "Informe ao menos um hash")
    .max(50, "Máximo de 50 hashes por chamada"),
});

// ── 4. Extensões dos schemas do cofre ────────────────────────────────────────

/**
 * GET /cofre/documentos ganha o filtro por operação (0033) e, na 0034, os
 * filtros do dossiê. `semOperacao` chega como boolean já resolvido pelo handler
 * ("1"/"true" → true, padrão do `comProva` de R1) → `operacao_id IS NULL`.
 * `semOperacao` combinado com `operacaoId` não é erro: os dois predicados se
 * aplicam e o resultado é vazio (decisão declarada — nenhum 4xx especial).
 */
export const FiltrosDocumentoComOperacaoSchema = FiltrosDocumentoSchema.extend({
  operacaoId: uuidSchema.optional(),
  // "1"/"true" resolvido no handler (padrão comProva) → operacao_id IS NULL
  semOperacao: z.boolean().default(false),
  tipoDocumento: z.enum(TIPOS_DOCUMENTO).optional(),
  // 0043 — filtro do cofre por disciplina (uuid, não código: o `<select>` é
  // populado pelo catálogo e disciplina é linha de tabela, não enum, §1g) e
  // "documentos deste RT" (a tela monta o chip a partir da própria URL).
  disciplinaId:   uuidSchema.optional(),
  profissionalId: uuidSchema.optional(),
});

export type FiltrosDocumentoComOperacaoInput = z.infer<
  typeof FiltrosDocumentoComOperacaoSchema
>;

/**
 * POST /cofre/documentos ganha a operação que o arquivo comprova, o papel da
 * prova e, na 0034, o dossiê (tipo/situação/detentora). Todos OPCIONAIS: quem
 * já subia certidão sem operação continua subindo igual. `permitirDuplicata` e
 * `restrito` não entram aqui — são flags de multipart lidas como "true"/"1" no
 * handler, igual a `validadeIndeterminada`.
 */
export const CriarDocumentoComOperacaoSchema = CriarDocumentoSchema.extend({
  operacaoId: uuidSchema.optional(),
  papel: z.enum(PAPEIS_DOCUMENTO).optional(),
  tipoDocumento: z.enum(TIPOS_DOCUMENTO).optional(),      // 0034
  situacaoProva: z.enum(SITUACOES_PROVA).optional(),      // 0034
  detentora: z.enum(DETENTORAS).optional(),               // 0034
  // 0043: a disciplina que o documento prova. Só a FORMA é validada aqui; a
  // rota chama `conferirDisciplina()` antes do INSERT para o id inexistente
  // sair como 422 no campo, e não como 23503 → 500 (§1a).
  disciplinaId: uuidSchema.optional(),                    // 0043
});

// ── 5. Adoção em lote (POST /cofre/documentos/vincular-operacao — R11) ───────

/**
 * Adoção em lote de documentos órfãos por UMA operação. Só preenche onde
 * `operacao_id IS NULL` (documento já vinculado é pulado, nunca sobrescrito —
 * sobrescrever é ato unitário via PATCH). Contrato de erro: issue com path
 * começando em `ids` vira o 422 fixo
 * `{"error":"Esperado { ids: string[] } com 1 a 200 itens"}` (sem detalhes);
 * o resto cai no 422 padrão com `formatZodErrors` — o handler implementa a
 * precedência, o BFF replica.
 */
export const VincularOperacaoEmLoteSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(200),
  operacaoId: uuidSchema,
  papel: z.enum(PAPEIS_DOCUMENTO).optional(),
});

export type VincularOperacaoEmLoteInput = z.infer<typeof VincularOperacaoEmLoteSchema>;

// ── 6. Jobs de ingestão (GET /import/jobs — R14) ─────────────────────────────

/**
 * O domínio de jobs de ingestão do acervo mora junto do resto da 0033/0034.
 * `status` espelha o CHECK/tipo `StatusImport` de import_jobs (schema.ts).
 */
export const ListarImportJobsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["EM_ANDAMENTO", "CONCLUIDO", "FALHOU", "CANCELADO"]).optional(),
});

export type ListarImportJobsInput = z.infer<typeof ListarImportJobsSchema>;
