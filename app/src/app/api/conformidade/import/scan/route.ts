export const runtime = "nodejs";

/**
 * POST /api/conformidade/import/scan — ingestor 1-a-1 do acervo (v2, 0034).
 *
 * Recebe arquivos da pasta de rede do acervo enviados pelo pipeline de
 * ingestão (CLI, WP-14). Retrocompatível e SEM /v2 (ADR-08): a
 * chamada antiga (file + pathRelativo + sha256 [+ jobId]) mantém o
 * comportamento byte a byte; todos os campos novos são OPCIONAIS.
 *
 * Body (multipart/form-data):
 *   - file:            binário do arquivo
 *   - pathRelativo:    ex.: "01_Proponente/12345 - .../02_Comprovacao/ART x.pdf"
 *   - sha256:          SHA-256 hex do conteúdo (pra dedupe)
 *   - jobId?:          uuid do import_job (pra agrupar)
 *   — v2 (0034), todos opcionais —
 *   - operacaoCodigo?: resolve operacoes.codigo → operacao_id (nunca CRIA operação)
 *   - papel? / tipoDocumento? / situacaoProva? / detentora?:  taxonomia do dossiê
 *   - restrito?:       "true"|"1" liga; resto (inclusive ausente) desliga
 *   - categoria? + subcategoria?: par presente e VÁLIDO sobrepõe inferirDestino
 *   - emitidoEm?:      AAAA-MM-DD (meia-noite UTC)
 *   - numeroDocumento?: gravado como veio
 *   - origemPath?:     default = pathRelativo (N6)
 *
 * Correções A–D (ESTUDO §6.2): (A) NENHUM blob sobe antes do último 422
 * possível; (B) contadores do job em UPDATE atômico; (C) o dedupe conta antes
 * de retornar; (D) dedupe ADOTA órfão (preenche NULL, nunca sobrescreve).
 *
 * Auth: Bearer <import-token> (gerado em /api/conformidade/import/token)
 *       ou sessão NextAuth com SGI/LIDER/ADMIN.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import {
  documentosHabilitacao,
  familias,
  familiasAnexos,
  importJobs,
  auditLog,
  operacoes,
  type Operacao,
} from "@/db/schema";
import { eq, isNull, and, asc, sql, type SQL } from "drizzle-orm";
import { podeImportarConformidade } from "@/lib/permissions";
import { verificarImportToken } from "@/lib/conformidade/import-tokens";
import { uploadByKey, validarMagicBytes, validarTipoArquivo } from "@/lib/storage/upload";
import {
  inferirDestino,
  extrairValidadeDoNome,
  tituloDoNome,
  type Destino,
} from "@/lib/conformidade/inferir-categoria";
import { normalizarCodigoCrc } from "@/lib/conformidade/familias/validations";
import {
  DETENTORAS,
  PAPEIS_DOCUMENTO,
  SITUACOES_PROVA,
  TIPOS_DOCUMENTO,
  type Detentora,
  type PapelDocumento,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import { ehDataIso, ehUuid } from "@/lib/conformidade/operacoes/validations";
import {
  categoriaSchema,
  subcategoriaSchema,
} from "@/lib/conformidade/cofre/validations";
import type { CategoriaDocHab, SubcategoriaDocHab } from "@/db/schema";

interface AuthInfo { userId: string; role: string; }

async function autenticar(request: NextRequest): Promise<AuthInfo | { erro: string; status: number }> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verificarImportToken(token);
    if (!payload) return { erro: "Token de importação inválido ou expirado", status: 401 };
    if (!podeImportarConformidade(payload.role)) {
      return { erro: "Token sem permissão de importação", status: 403 };
    }
    return { userId: payload.sub, role: payload.role };
  }

  const session = await auth();
  if (!session?.user) return { erro: "Não autenticado", status: 401 };
  if (!podeImportarConformidade(session.user.role)) return { erro: "Permissão negada", status: 403 };
  return { userId: session.user.id, role: session.user.role };
}

function sanitizarNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.\./g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Campo multipart opcional: string aparada, vazio → null. */
function campo(formData: FormData, nome: string): string | null {
  const raw = formData.get(nome);
  if (typeof raw !== "string") return null;
  const aparado = raw.trim();
  return aparado.length > 0 ? aparado : null;
}

/** O shape unificado v2 (§12.9) — as MESMAS chaves nos três desfechos. */
interface RespostaScan {
  ok: boolean;
  tipo: string;
  documentoId: string | null;
  familiaAnexoId: string | null;
  jobId: string | null;
  dedupe: boolean;
  acao: "INSERIDO" | "DEDUPE" | "DEDUPE_ADOTADO";
  operacaoId: string | null;
  operacaoCodigo: string | null;
  papel: string | null;
  tipoDocumento: string | null;
  situacaoProva: string | null;
  detentora: string | null;
  restrito: boolean;
  categoria: string | null;
  subcategoria: string | null;
  camposPreenchidos?: Record<string, string>;
}

export async function POST(request: NextRequest) {
  const a = await autenticar(request);
  if ("erro" in a) return NextResponse.json({ error: a.erro }, { status: a.status });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Esperado multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  const pathRelativo = String(formData.get("pathRelativo") ?? "").trim();
  const sha256 = String(formData.get("sha256") ?? "").trim();
  const jobIdParam = String(formData.get("jobId") ?? "").trim();

  // ── Campos v2 (todos opcionais) ───────────────────────────────────────────
  const operacaoCodigo  = campo(formData, "operacaoCodigo");
  const papelRaw        = campo(formData, "papel");
  const tipoDocRaw      = campo(formData, "tipoDocumento");
  const situacaoRaw     = campo(formData, "situacaoProva");
  const detentoraRaw    = campo(formData, "detentora");
  const categoriaRaw    = campo(formData, "categoria");
  const subcategoriaRaw = campo(formData, "subcategoria");
  const emitidoEmRaw    = campo(formData, "emitidoEm");
  const numeroDocumento = campo(formData, "numeroDocumento");
  const origemPathRaw   = campo(formData, "origemPath");
  const restritoRaw     = formData.get("restrito");
  const restrito        = restritoRaw === "true" || restritoRaw === "1";

  // Job resolvido UMA vez: contadores (inclusive `erros`) e import_job_id só
  // valem para jobId que é UUID e existe — o resto mantém o best-effort atual.
  let jobResolvido: string | null = null;
  if (jobIdParam && ehUuid(jobIdParam)) {
    const [job] = await db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(eq(importJobs.id, jobIdParam))
      .limit(1);
    jobResolvido = job?.id ?? null;
  }

  /**
   * Incremento ATÔMICO no SQL (correção B): `SET x = x + 1`, nunca
   * read-modify-write — duas chamadas concorrentes com o mesmo job não podem
   * perder escrita. Best-effort: falha de contador não derruba o scan.
   */
  async function contar(colunas: Array<"processados" | "novos" | "atualizados" | "ignorados" | "erros">) {
    if (!jobResolvido) return;
    try {
      const sets: SQL[] = colunas.map(
        (c) => sql`${sql.identifier(c)} = ${sql.identifier(c)} + 1`
      );
      await db.execute(
        sql`UPDATE import_jobs SET ${sql.join(sets, sql`, `)} WHERE id = ${jobResolvido}`
      );
    } catch { /* não bloqueia o scan */ }
  }

  /** 4xx pós-autenticação: conta `erros` no job (quando resolve) e responde. */
  async function erro4xx(corpo: Record<string, unknown>, status: number) {
    await contar(["erros"]);
    return NextResponse.json(corpo, { status });
  }

  try {
    if (!(file instanceof File)) {
      return erro4xx({ error: "Arquivo é obrigatório" }, 422);
    }
    if (!pathRelativo) {
      return erro4xx({ error: "pathRelativo é obrigatório" }, 422);
    }
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
      return erro4xx({ error: "sha256 inválido" }, 422);
    }
    if (file.size > 50 * 1024 * 1024) {
      return erro4xx({ error: "Arquivo excede 50 MB" }, 422);
    }

    // Whitelist de tipo (extensão + Content-Type) — segue o mesmo set do cofre.
    const tipoArq = validarTipoArquivo(file);
    if (!tipoArq.valido) {
      return erro4xx({ error: tipoArq.erro ?? "Tipo de arquivo não permitido" }, 422);
    }

    // Verifica conteúdo binário real (magic-bytes) — impede que um arquivo com
    // extensão forjada (.exe renomeado .pdf, etc.) seja gravado no cofre via CLI.
    const magic = await validarMagicBytes(file);
    if (!magic.valido) {
      return erro4xx(
        { error: magic.erro ?? "Conteúdo do arquivo não corresponde ao tipo declarado" },
        422,
      );
    }

    // ── Passo 9 — destino, com a precedência da v2 (§12.4) ──────────────────
    // categoria E subcategoria presentes E válidas → destino DOCUMENTO_HABILITACAO
    // e inferirDestino NEM RODA (pathRelativo vira só procedência). Caso
    // contrário, inferirDestino como sempre — e o par incompleto/ inválido ainda
    // é validado individualmente no passo 9b.
    const categoriaValida =
      categoriaRaw !== null && categoriaSchema.safeParse(categoriaRaw).success;
    const subcategoriaValida =
      subcategoriaRaw !== null && subcategoriaSchema.safeParse(subcategoriaRaw).success;

    let destino: Destino;
    if (categoriaValida && subcategoriaValida) {
      destino = {
        tipo: "DOCUMENTO_HABILITACAO",
        categoria: categoriaRaw as CategoriaDocHab,
        subcategoria: subcategoriaRaw as SubcategoriaDocHab,
      };
    } else {
      destino = inferirDestino(pathRelativo);
      if (destino.tipo === "DESCONHECIDO") {
        return erro4xx({ error: `Path não reconhecido: ${destino.motivo}`, pathRelativo }, 422);
      }
    }

    // ── Passo 9b — enums novos, UM erro por resposta, na ordem fixa ─────────
    if (papelRaw !== null && !(PAPEIS_DOCUMENTO as readonly string[]).includes(papelRaw)) {
      return erro4xx({ error: `papel inválido: ${papelRaw}`, code: "PAPEL_INVALIDO" }, 422);
    }
    if (tipoDocRaw !== null && !(TIPOS_DOCUMENTO as readonly string[]).includes(tipoDocRaw)) {
      return erro4xx({ error: `tipoDocumento inválido: ${tipoDocRaw}`, code: "TIPO_DOCUMENTO_INVALIDO" }, 422);
    }
    if (situacaoRaw !== null && !(SITUACOES_PROVA as readonly string[]).includes(situacaoRaw)) {
      return erro4xx({ error: `situacaoProva inválida: ${situacaoRaw}`, code: "SITUACAO_PROVA_INVALIDA" }, 422);
    }
    if (detentoraRaw !== null && !(DETENTORAS as readonly string[]).includes(detentoraRaw)) {
      return erro4xx({ error: `detentora inválida: ${detentoraRaw}`, code: "DETENTORA_INVALIDA" }, 422);
    }
    if (categoriaRaw !== null && !categoriaValida) {
      return erro4xx({ error: `categoria inválida: ${categoriaRaw}`, code: "CATEGORIA_INVALIDA" }, 422);
    }
    if (subcategoriaRaw !== null && !subcategoriaValida) {
      return erro4xx({ error: `subcategoria inválida: ${subcategoriaRaw}`, code: "SUBCATEGORIA_INVALIDA" }, 422);
    }
    if (emitidoEmRaw !== null && !ehDataIso(emitidoEmRaw)) {
      return erro4xx({ error: "emitidoEm inválido: use YYYY-MM-DD", code: "EMITIDO_EM_INVALIDO" }, 422);
    }

    const papel     = papelRaw     as PapelDocumento | null;
    const tipoDoc   = tipoDocRaw   as TipoDocumento  | null;
    const situacao  = situacaoRaw  as SituacaoProva  | null;
    const detentora = detentoraRaw as Detentora      | null;

    // ── Passo 9c — operação resolve por CÓDIGO (chave de negócio, ADR-09) ───
    // O scan NUNCA cria operação: o conserto é seed aprovado (P4).
    let operacaoResolvida: Operacao | null = null;
    if (operacaoCodigo !== null) {
      const [op] = await db
        .select()
        .from(operacoes)
        .where(eq(operacoes.codigo, operacaoCodigo))
        .limit(1);
      if (!op) {
        return erro4xx(
          {
            error: `Operação "${operacaoCodigo}" não cadastrada — semeie o catálogo antes de importar`,
            code: "OPERACAO_NAO_ENCONTRADA",
            operacaoCodigo,
          },
          422,
        );
      }
      operacaoResolvida = op;
    }

    // Herança de detentora (N3): explícita > da operação resolvida > NULL.
    const detentoraEfetiva: Detentora | null = detentora ?? operacaoResolvida?.detentora ?? null;

    // ── Passo 9d — família ANTES do upload (correção A) ─────────────────────
    // Era pós-upload: cada 422 deixava blob órfão no MinIO.
    let familiaId: string | null = null;
    if (destino.tipo === "FAMILIA_ANEXO") {
      const norm = normalizarCodigoCrc(destino.codigoFamilia);
      const [fam] = await db
        .select({ id: familias.id })
        .from(familias)
        .where(and(eq(familias.codigoNormalizado, norm), isNull(familias.deletadoEm)))
        .limit(1);
      if (!fam) {
        return erro4xx({
          ok:    false,
          tipo:  destino.tipo,
          error: `Família com código "${destino.codigoFamilia}" não encontrada — importe o catálogo (planilha) primeiro`,
        }, 422);
      }
      familiaId = fam.id;
    }

    // ── Passo 10 — dedupe por SHA-256 + ADOÇÃO DE ÓRFÃO (correção D) ────────
    if (destino.tipo === "DOCUMENTO_HABILITACAO" || destino.tipo === "ACT") {
      // "O mais antigo vence" — a mesma regra de desempate do /verificar, para
      // a escolha ser determinística nos dois lados.
      const [existente] = await db
        .select({
          id:            documentosHabilitacao.id,
          operacaoId:    documentosHabilitacao.operacaoId,
          papel:         documentosHabilitacao.papel,
          tipoDocumento: documentosHabilitacao.tipoDocumento,
          situacaoProva: documentosHabilitacao.situacaoProva,
          detentora:     documentosHabilitacao.detentora,
          restrito:      documentosHabilitacao.restrito,
          categoria:     documentosHabilitacao.categoria,
          subcategoria:  documentosHabilitacao.subcategoria,
        })
        .from(documentosHabilitacao)
        .where(eq(documentosHabilitacao.sha256, sha256))
        .orderBy(asc(documentosHabilitacao.criadoEm), asc(documentosHabilitacao.id))
        .limit(1);

      if (existente) {
        // Adoção: preenche APENAS onde o existente é NULL e o request traz
        // valor. Nunca sobrescreve valor não-nulo. `restrito`, `origem_path` e
        // `import_job_id` NÃO participam (o doc pertence ao job que o criou).
        const camposPreenchidos: Record<string, string> = {};
        const updates: Partial<typeof documentosHabilitacao.$inferInsert> = {};
        const guardas: SQL[] = [eq(documentosHabilitacao.id, existente.id)];

        if (operacaoResolvida && existente.operacaoId === null) {
          camposPreenchidos.operacaoId = operacaoResolvida.id;
          updates.operacaoId = operacaoResolvida.id;
          guardas.push(isNull(documentosHabilitacao.operacaoId));
        }
        if (papel !== null && existente.papel === null) {
          camposPreenchidos.papel = papel;
          updates.papel = papel;
          guardas.push(isNull(documentosHabilitacao.papel));
        }
        if (tipoDoc !== null && existente.tipoDocumento === null) {
          camposPreenchidos.tipoDocumento = tipoDoc;
          updates.tipoDocumento = tipoDoc;
          guardas.push(isNull(documentosHabilitacao.tipoDocumento));
        }
        if (situacao !== null && existente.situacaoProva === null) {
          camposPreenchidos.situacaoProva = situacao;
          updates.situacaoProva = situacao;
          guardas.push(isNull(documentosHabilitacao.situacaoProva));
        }
        if (detentoraEfetiva !== null && existente.detentora === null) {
          camposPreenchidos.detentora = detentoraEfetiva;
          updates.detentora = detentoraEfetiva;
          guardas.push(isNull(documentosHabilitacao.detentora));
        }

        let adotado = false;
        if (Object.keys(camposPreenchidos).length > 0) {
          // O `IS NULL` repetido no WHERE fecha a corrida entre duas adoções:
          // a segunda afeta 0 linhas e cai no caminho de DEDUPE puro.
          updates.atualizadoEm = new Date();
          updates.atualizadoPor = a.userId;
          const linhas = await db
            .update(documentosHabilitacao)
            .set(updates)
            .where(and(...guardas))
            .returning({ id: documentosHabilitacao.id });
          adotado = linhas.length > 0;
        }

        if (adotado) {
          // É DESTE registro que o desfazer (R15) reverte adoções (ADR-10).
          await db.insert(auditLog).values({
            userId:     a.userId,
            acao:       "IMPORT_ADOCAO",
            entidade:   "documento_habilitacao",
            entidadeId: existente.id,
            detalhes:   { jobId: jobResolvido, documentoId: existente.id, camposPreenchidos },
          });
          await contar(["processados", "atualizados"]);
        } else {
          // Correção C: o dedupe CONTA antes de retornar.
          await contar(["processados", "ignorados"]);
        }

        // Campos de operação da resposta = os DO EXISTENTE, pós-adoção.
        const operacaoIdFinal = existente.operacaoId ?? (adotado ? camposPreenchidos.operacaoId ?? null : null);
        let codigoFinal: string | null = null;
        if (operacaoIdFinal !== null) {
          if (operacaoResolvida && operacaoResolvida.id === operacaoIdFinal) {
            codigoFinal = operacaoResolvida.codigo;
          } else {
            const [op] = await db
              .select({ codigo: operacoes.codigo })
              .from(operacoes)
              .where(eq(operacoes.id, operacaoIdFinal))
              .limit(1);
            codigoFinal = op?.codigo ?? null;
          }
        }

        const resposta: RespostaScan = {
          ok: true,
          tipo: destino.tipo,
          documentoId: existente.id,
          familiaAnexoId: null,
          jobId: jobIdParam || null,
          dedupe: true,
          acao: adotado ? "DEDUPE_ADOTADO" : "DEDUPE",
          operacaoId: operacaoIdFinal,
          operacaoCodigo: codigoFinal,
          papel: existente.papel ?? (adotado ? camposPreenchidos.papel ?? null : null),
          tipoDocumento: existente.tipoDocumento ?? (adotado ? camposPreenchidos.tipoDocumento ?? null : null),
          situacaoProva: existente.situacaoProva ?? (adotado ? camposPreenchidos.situacaoProva ?? null : null),
          detentora: existente.detentora ?? (adotado ? camposPreenchidos.detentora ?? null : null),
          restrito: existente.restrito,
          categoria: existente.categoria,
          subcategoria: existente.subcategoria,
        };
        if (adotado) resposta.camposPreenchidos = camposPreenchidos;
        return NextResponse.json(resposta);
      }
    }

    // ── Passo 11 — upload MinIO (só chega aqui quem vai gravar) ─────────────
    const nomeSanitizado = sanitizarNome(file.name);
    const timestamp = Date.now();

    let blobPath: string;
    if (destino.tipo === "FAMILIA_ANEXO") {
      blobPath = `conformidade/familias/${normalizarCodigoCrc(destino.codigoFamilia)}/${timestamp}_${nomeSanitizado}`;
    } else if (destino.tipo === "DOCUMENTO_HABILITACAO" || destino.tipo === "ACT") {
      // Chave de blob INALTERADA (§1.5 da arquitetura): a árvore bonita é do
      // ZIP do dossiê, não do bucket.
      blobPath = `conformidade/cofre/${destino.categoria}/${destino.subcategoria}/${timestamp}_${nomeSanitizado}`;
    } else {
      blobPath = `conformidade/contratos/${sanitizarNome(destino.numeroContrato)}/${timestamp}_${nomeSanitizado}`;
    }

    const blob = await uploadByKey(blobPath, file, file.type);

    const validadeFim = extrairValidadeDoNome(file.name);
    const titulo = tituloDoNome(file.name);

    let documentoId: string | null = null;
    let familiaAnexoId: string | null = null;

    // ── Passo 12 — INSERT conforme destino ──────────────────────────────────
    if (destino.tipo === "FAMILIA_ANEXO") {
      const tipoAnexo = /certificado|crc/i.test(file.name)
        ? "CERTIFICADO_CRC"
        : /ata|auditoria/i.test(file.name)
        ? "ATA_AUDITORIA"
        : "OUTRO";

      const [novo] = await db
        .insert(familiasAnexos)
        .values({
          familiaId:    familiaId!,
          tipo:         tipoAnexo,
          nomeArquivo:  file.name,
          blobUrl:      blob.url,
          blobKey:      blob.key,
          tamanhoBytes: file.size,
          contentType:  blob.contentType,
          validadeFim,
          uploadadoPor: a.userId,
        })
        .returning({ id: familiasAnexos.id });

      familiaAnexoId = novo.id;
    } else if (destino.tipo === "DOCUMENTO_HABILITACAO" || destino.tipo === "ACT") {
      const [novo] = await db
        .insert(documentosHabilitacao)
        .values({
          categoria:             destino.categoria,
          subcategoria:          destino.subcategoria,
          titulo,
          descricao:             null,
          nomeArquivo:           file.name,
          blobUrl:               blob.url,
          blobKey:               blob.key,
          tamanhoBytes:          file.size,
          contentType:           blob.contentType,
          sha256,
          // v2: emitidoEm explícito vence a extração do nome; meia-noite UTC.
          numeroDocumento,
          emitidoEm:             emitidoEmRaw ? new Date(emitidoEmRaw) : null,
          validadeFim,
          validadeIndeterminada: validadeFim === null,
          status:                "VIGENTE",
          // 0033/0034 — o que o pipeline agora sabe dizer sobre o arquivo.
          operacaoId:            operacaoResolvida?.id ?? null,
          papel,
          tipoDocumento:         tipoDoc,
          situacaoProva:         situacao,
          detentora:             detentoraEfetiva,
          restrito,
          importJobId:           jobResolvido,
          origemPath:            origemPathRaw ?? pathRelativo,
          uploadadoPor:          a.userId,
          atualizadoPor:         a.userId,
        })
        .returning({ id: documentosHabilitacao.id });

      documentoId = novo.id;
    }
    // CONTRATO_ANEXO: deixar pra Sprint 2 (precisa contratos_execucao já criado)

    // ── Passo 13 — contadores atômicos (correção B) ─────────────────────────
    await contar(["processados", "novos"]);

    // ── Passo 14 — resposta (shape unificado v2) ────────────────────────────
    // FAMILIA_ANEXO/CONTRATO_ANEXO: campos de operação null (não se aplicam).
    const parDocumento =
      destino.tipo === "DOCUMENTO_HABILITACAO" || destino.tipo === "ACT"
        ? { categoria: destino.categoria, subcategoria: destino.subcategoria }
        : null;
    const resposta: RespostaScan = {
      ok:    true,
      tipo:  destino.tipo,
      documentoId,
      familiaAnexoId,
      jobId: jobIdParam || null,
      dedupe: false,
      acao: "INSERIDO",
      operacaoId:     parDocumento ? operacaoResolvida?.id ?? null : null,
      operacaoCodigo: parDocumento ? operacaoResolvida?.codigo ?? null : null,
      papel:          parDocumento ? papel : null,
      tipoDocumento:  parDocumento ? tipoDoc : null,
      situacaoProva:  parDocumento ? situacao : null,
      detentora:      parDocumento ? detentoraEfetiva : null,
      restrito:       parDocumento ? restrito : false,
      categoria:      parDocumento?.categoria ?? null,
      subcategoria:   parDocumento?.subcategoria ?? null,
    };
    return NextResponse.json(resposta);
  } catch (e) {
    // 5xx pós-autenticação também conta em `erros` (§12.8) — e responde JSON,
    // não a página default do Next.
    await contar(["erros"]);
    console.error("[import-scan] erro inesperado:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
