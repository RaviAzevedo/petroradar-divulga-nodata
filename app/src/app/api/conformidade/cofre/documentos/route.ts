export const runtime = "nodejs";
// OCR síncrono de PDFs grandes (Claude Haiku via vision) pode passar do timeout
// padrão; estende a janela de execução desta rota.
export const maxDuration = 120;

/**
 * GET  /api/conformidade/cofre/documentos — Lista documentos do cofre com filtros
 * POST /api/conformidade/cofre/documentos — Faz upload (multipart/form-data) e cria registro
 *
 * Body do POST (multipart):
 *  - file:           File obrigatório
 *  - categoria:      string (CategoriaDocHab)
 *  - subcategoria:   string (SubcategoriaDocHab)
 *  - titulo:         string
 *  - descricao?:     string
 *  - numeroDocumento?: string
 *  - emitidoEm?:     ISO 8601
 *  - validadeFim?:   ISO 8601
 *  - validadeIndeterminada?: "true" | "false"
 *  - tags?:          string[] (JSON-stringified)
 *  - operacaoId?:    uuid da operação que o arquivo comprova           (0033)
 *  - papel?:         ATESTADO|CAT_ART|CONTRATO|ADITIVO|NOTA_FISCAL|
 *                    DECLARACAO|OUTRO                                  (0033)
 *  - permitirDuplicata?: "true" | "1" — sobe mesmo se o SHA-256 já      (0033)
 *                    existir no cofre
 *  - disciplinaId?:  uuid da disciplina que o documento prova            (0043)
 *
 * 0043 (disciplina e profissional) — dois acréscimos, nenhuma remoção:
 *  - GET  ganhou os filtros `disciplinaId` (coluna do próprio documento) e
 *    `profissionalId` ("documentos deste RT", por pré-seleção de ids), e cada
 *    item ganhou `disciplinaId` e `disciplina: { id, codigo, nome } | null`.
 *  - POST ganhou o campo multipart `disciplinaId`, conferido contra o catálogo
 *    ANTES do upload (`conferirDisciplina`): com a FK da 0043 um uuid
 *    inexistente viraria 23503 → 500, e a resposta honesta é 422 no campo.
 *
 * 0033 (cofre por operação) — o que mudou aqui, sem tirar nada do que existia:
 *  - GET  ganhou o filtro `operacaoId` e cada item ganhou `operacaoId`, `papel`
 *    e `operacao: { id, codigo, clienteNome } | null`.
 *  - POST ganhou os três campos multipart acima e um 409 de duplicata exata
 *    (`{ error: "Arquivo já está no cofre", documentoId, titulo }`), checado
 *    DEPOIS de validar arquivo e metadados e ANTES do OCR e do upload — subir o
 *    blob para só então recusar deixaria arquivo órfão no MinIO e ainda pagaria
 *    OCR por um documento que não vai ser gravado.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosHabilitacao, auditLog } from "@/db/schema";
import { inArray } from "drizzle-orm";
import {
  podeGerenciarDocumentosHabilitacao,
  podeExcluirDocumentoHabilitacao,
  isConformidade,
} from "@/lib/permissions";
import { redigirPii } from "@/lib/seguranca/pii";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import { deleteDocumento } from "@/lib/storage/upload";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import {
  CriarDocumentoComOperacaoSchema,
  FiltrosDocumentoComOperacaoSchema,
} from "@/lib/conformidade/operacoes/validations";
import { listDocumentos, getDocumentoPorSha256 } from "@/lib/conformidade/cofre/queries";
import { getOperacaoById } from "@/lib/conformidade/operacoes/queries";
// 0043: a trava de existência da disciplina — handler não monta SQL.
import { conferirDisciplina } from "@/lib/conformidade/disciplinas/queries";
import {
  uploadHabilitacao,
  validarTipoArquivo,
  validarTamanhoArquivo,
  validarMagicBytes,
} from "@/lib/storage/upload";
import { createHash } from "node:crypto";

async function sha256OfFile(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  return createHash("sha256").update(Buffer.from(ab)).digest("hex");
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  // Flag booleana lida fora do zod (padrão do `comProva` de R1): "1" e "true"
  // ligam, qualquer outra coisa (inclusive ausente) desliga.
  const semOperacaoRaw = searchParams.get("semOperacao");

  const parsed = FiltrosDocumentoComOperacaoSchema.safeParse({
    categoria:    searchParams.get("categoria")    ?? undefined,
    subcategoria: searchParams.get("subcategoria") ?? undefined,
    status:       searchParams.get("status")       ?? undefined,
    familiaId:    searchParams.get("familiaId")    ?? undefined,
    operacaoId:   searchParams.get("operacaoId")   ?? undefined,
    semOperacao:  semOperacaoRaw === "1" || semOperacaoRaw === "true",
    tipoDocumento: searchParams.get("tipoDocumento") ?? undefined,
    // 0043 — disciplina é uuid (o `<select>` é populado pelo catálogo) e
    // `profissionalId` recorta "documentos deste RT". Os dois entram no MESMO
    // `where` das duas queries de `listDocumentos` (linhas e contagem).
    disciplinaId:   searchParams.get("disciplinaId")   ?? undefined,
    profissionalId: searchParams.get("profissionalId") ?? undefined,
    busca:        searchParams.get("busca")        ?? undefined,
    vencendoEm:   searchParams.get("vencendoEm")   ?? undefined,
    page:         searchParams.get("page")         ?? "1",
    limit:        searchParams.get("limit")        ?? "50",
    order:        searchParams.get("order")        ?? "validade",
    dir:          searchParams.get("dir")          ?? "asc",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Parâmetros inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 400 }
    );
  }

  // O papel entra na query: documento restrito é filtrado (linha E contagem)
  // para quem está fora de Conformidade — total/pages não denunciam o oculto.
  const result = await listDocumentos(parsed.data, user.role);
  return NextResponse.json(result);
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Esperado multipart/form-data" }, { status: 400 });
  }

  // Gate 4 (R7 — a POSIÇÃO é contrato): `restrito` é flag de multipart (padrão
  // validadeIndeterminada, fora do zod) e só Conformidade pode ligá-la. Vem
  // ANTES das validações de arquivo de propósito — permissão antes de validação
  // — e o BFF replica a posição exata.
  const restritoRaw = formData.get("restrito");
  const restrito = restritoRaw === "true" || restritoRaw === "1";
  if (restrito && !isConformidade(session.user.role)) {
    return NextResponse.json(
      { error: "Apenas Conformidade pode alterar a restrição de acesso" },
      { status: 403 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Arquivo é obrigatório" }, { status: 422 });
  }

  // Validações de arquivo
  const tipoCheck = validarTipoArquivo(file);
  if (!tipoCheck.valido) {
    return NextResponse.json({ error: tipoCheck.erro }, { status: 422 });
  }

  const tamCheck = validarTamanhoArquivo(file, 50);
  if (!tamCheck.valido) {
    return NextResponse.json({ error: tamCheck.erro }, { status: 422 });
  }

  const magicCheck = await validarMagicBytes(file);
  if (!magicCheck.valido) {
    return NextResponse.json({ error: magicCheck.erro }, { status: 422 });
  }

  // Validação dos campos
  const tagsRaw = formData.get("tags");
  let tags: string[] | undefined;
  if (typeof tagsRaw === "string" && tagsRaw.length > 0) {
    try {
      const parsed = JSON.parse(tagsRaw);
      if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
    } catch { /* ignora */ }
  }

  const validadeIndeterminadaRaw = formData.get("validadeIndeterminada");
  const validadeIndeterminada =
    validadeIndeterminadaRaw === "true" || validadeIndeterminadaRaw === "1";

  // "Enviar mesmo assim" da tela: o usuário viu o aviso de duplicata e insistiu.
  // Mesma leitura de flag do campo acima ("true" ou "1"; ausente = false).
  const permitirDuplicataRaw = formData.get("permitirDuplicata");
  const permitirDuplicata =
    permitirDuplicataRaw === "true" || permitirDuplicataRaw === "1";

  const dadosParse = CriarDocumentoComOperacaoSchema.safeParse({
    categoria:             formData.get("categoria"),
    subcategoria:          formData.get("subcategoria"),
    titulo:                formData.get("titulo"),
    descricao:             formData.get("descricao") || undefined,
    numeroDocumento:       formData.get("numeroDocumento") || undefined,
    // 0044 (B6): a REVISÃO carimbada pela engenharia ("R0", "R1", "02A"). Não
    // é `versao` (§1h): aquilo é o versionamento de certidão do cofre, com
    // cadeia navegável; isto é texto livre que não ordena e não substitui nada.
    // `|| undefined` como os irmãos: campo em branco no formulário é AUSÊNCIA,
    // nunca `""`.
    revisao:               formData.get("revisao") || undefined,
    emitidoEm:             formData.get("emitidoEm") || undefined,
    validadeFim:           formData.get("validadeFim") || undefined,
    validadeIndeterminada,
    status:                formData.get("status") || "VIGENTE",
    tags,
    operacaoId:            formData.get("operacaoId") || undefined,
    papel:                 formData.get("papel") || undefined,
    // 0034 (R7) — taxonomia do dossiê, todos opcionais.
    tipoDocumento:         formData.get("tipoDocumento") || undefined,
    situacaoProva:         formData.get("situacaoProva") || undefined,
    detentora:             formData.get("detentora") || undefined,
    // 0043 — a disciplina que o documento prova. `|| undefined` como os irmãos
    // acima: campo vazio no form é AUSÊNCIA, não uuid inválido.
    disciplinaId:          formData.get("disciplinaId") || undefined,
  });

  if (!dadosParse.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(dadosParse.error) },
      { status: 422 }
    );
  }

  const data = dadosParse.data;

  // A operação precisa EXISTIR antes de subir qualquer coisa. O zod só garante
  // que o campo é um uuid; um uuid válido que não está em `operacoes` (operação
  // apagada entre abrir o seletor e enviar, ou id colado à mão) só falharia lá
  // na frente, na FK do INSERT — depois do blob já ter subido, deixando arquivo
  // órfão no MinIO. Mesma razão pela qual o 409 de duplicata vem antes do upload.
  // A linha resolvida fica no escopo: é dela que a `detentora` é herdada (R7).
  let operacao: Awaited<ReturnType<typeof getOperacaoById>> = null;
  if (data.operacaoId) {
    operacao = await getOperacaoById(data.operacaoId);
    if (!operacao) {
      return NextResponse.json(
        { error: "Dados inválidos", detalhes: { operacaoId: "Operação não encontrada" } },
        { status: 422 }
      );
    }
  }

  // 0043: a disciplina também precisa EXISTIR antes de subir qualquer coisa. O
  // zod só garante a forma; com a FK `fk_doch_disciplina` da 0043, um uuid bem
  // formado que não está em `disciplinas` estouraria 23503 no INSERT — 500, e
  // com o blob já no MinIO. Mesma razão do gate de operação acima (§1a).
  if (!(await conferirDisciplina(data.disciplinaId))) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: { disciplinaId: "Disciplina não encontrada" } },
      { status: 422 }
    );
  }

  // SHA-256 do conteúdo — calculado ANTES do OCR e do upload porque é ele que
  // decide se este arquivo já está guardado. A ordem importa: recusar depois de
  // subir deixaria blob órfão no MinIO, e depois do OCR teria custado dinheiro.
  const sha256 = await sha256OfFile(file);

  if (!permitirDuplicata) {
    const jaNoCofre = await getDocumentoPorSha256(sha256);
    if (jaNoCofre) {
      // 0034 (§3.2): duplicata de documento RESTRITO não vaza o título a papel
      // fora de Conformidade — `documentoId` fica (o uploader precisa saber que
      // é duplicata, como no R5/verificar), `titulo` sai cego (null).
      const cegar = jaNoCofre.restrito && !isConformidade(session.user.role);
      return NextResponse.json(
        {
          error:       "Arquivo já está no cofre",
          documentoId: jaNoCofre.id,
          titulo:      cegar ? null : jaNoCofre.titulo,
        },
        { status: 409 }
      );
    }
  }

  // OCR opt-in: usuário marca checkbox "auto-preencher metadados" → custa
  // ~R$0.02/doc no Anthropic, mas economiza tempo de digitação. Só roda em PDF.
  const ocrFlag = formData.get("ocr") === "true" || formData.get("ocr") === "1";
  let ocrMeta: { numeroDocumento?: string | null; emitidoEm?: Date | null; validadeFim?: Date | null;
                 validadeIndeterminada?: boolean; ocrTexto?: string; ocrConfianca?: number } = {};
  if (ocrFlag && file.type === "application/pdf") {
    try {
      const { extrairMetadadosDocumento } = await import("@/lib/conformidade/ocr");
      const buf = await file.arrayBuffer();
      const r = await extrairMetadadosDocumento(buf, data.categoria, data.subcategoria);
      // Só sobrescreve campos que o usuário NÃO preencheu
      ocrMeta = {
        numeroDocumento:       data.numeroDocumento ?? r.numeroDocumento,
        emitidoEm:             data.emitidoEm ? new Date(data.emitidoEm) : r.emitidoEm,
        validadeFim:           data.validadeFim ? new Date(data.validadeFim) : r.validadeFim,
        validadeIndeterminada: data.validadeIndeterminada || r.validadeIndeterminada,
        ocrTexto:              redigirPii(r.textoResumo),
        ocrConfianca:          r.ocrConfianca,
      };
    } catch (e) {
      console.error("[upload-cofre] OCR falhou (segue sem meta):", e instanceof Error ? e.message : e);
    }
  }

  // Upload para R2 (path: habilitacao/<categoria>/<subcategoria>/<timestamp>_<nome>)
  const upload = await uploadHabilitacao(file, data.categoria, data.subcategoria, file.name);

  const [novo] = await db
    .insert(documentosHabilitacao)
    .values({
      categoria:             data.categoria,
      subcategoria:          data.subcategoria,
      titulo:                data.titulo,
      descricao:             data.descricao || null,
      // 0033: a obra que o arquivo comprova e o que ele prova nela. Ficam NULL
      // quando o documento não é de operação (certidão, ISO, declaração).
      operacaoId:            data.operacaoId ?? null,
      papel:                 data.papel      ?? null,
      // 0034: taxonomia do dossiê. Sem detentora explícita, herda a da operação
      // resolvida no gate acima; senão NULL. import_job_id/origem_path ficam
      // NULL no upload de tela — são do pipeline (R13).
      tipoDocumento:         data.tipoDocumento ?? null,
      situacaoProva:         data.situacaoProva ?? null,
      detentora:             data.detentora ?? (operacao?.detentora ?? null),
      // 0043: NULL quando o upload não declara disciplina — a ficha e o cofre
      // mostram o documento do mesmo jeito, e a tela D4 é onde se completa.
      disciplinaId:          data.disciplinaId ?? null,
      restrito,
      nomeArquivo:           file.name,
      blobUrl:               upload.url,
      blobKey:               upload.key,
      tamanhoBytes:          upload.size,
      contentType:           upload.contentType,
      sha256,
      numeroDocumento:       ocrMeta.numeroDocumento ?? data.numeroDocumento ?? null,
      // 0044 (B6): sem esta linha o campo seria validado e jogado fora — o 201
      // traria `revisao: null` mesmo com o carimbo preenchido no formulário. O
      // OCR não a preenche: revisão é carimbo de engenharia, não metadado de
      // certidão.
      revisao:               data.revisao ?? null,
      emitidoEm:             ocrMeta.emitidoEm   ?? (data.emitidoEm   ? new Date(data.emitidoEm)   : null),
      validadeFim:           ocrMeta.validadeFim ?? (data.validadeFim ? new Date(data.validadeFim) : null),
      validadeIndeterminada: ocrMeta.validadeIndeterminada ?? data.validadeIndeterminada,
      status:                data.status,
      tags:                  data.tags ?? null,
      ocrTexto:              redigirPii(ocrMeta.ocrTexto ?? null),
      ocrConfianca:          ocrMeta.ocrConfianca ?? null,
      uploadadoPor:          session.user.id,
      atualizadoPor:         session.user.id,
    })
    .returning();

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "UPLOAD_DOCUMENTO_HABILITACAO",
    entidade:   "documento_habilitacao",
    entidadeId: novo.id,
    detalhes:   {
      categoria: novo.categoria,
      subcategoria: novo.subcategoria,
      titulo: novo.titulo,
      validadeFim: novo.validadeFim,
      // 0033: sem isto a auditoria não responde "quem ligou esta prova a esta obra".
      operacaoId: novo.operacaoId,
      papel: novo.papel,
      // 0034: taxonomia do dossiê e a marca de sigilo. Proibido: ocrTexto (§0.4).
      tipoDocumento: novo.tipoDocumento,
      situacaoProva: novo.situacaoProva,
      detentora: novo.detentora,
      restrito: novo.restrito,
    },
  });

  return NextResponse.json(novo, { status: 201 });
}

// ── DELETE em massa (somente ADMIN) ──────────────────────────────────────────
// Body: { ids: string[] }
// Apaga os blobs no R2 (best-effort) e os registros no DB.
export async function DELETE(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeExcluirDocumentoHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Somente administradores podem excluir documentos" }, { status: 403 });
  }

  let body: { ids?: string[] } = {};
  try { body = await request.json(); } catch { /* tolerante */ }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) return NextResponse.json({ error: "Body deve ter ids: string[]" }, { status: 400 });
  if (ids.length > 100) return NextResponse.json({ error: "Máximo 100 IDs por chamada" }, { status: 400 });

  // Busca pra capturar blob_keys antes de apagar
  const docs = await db
    .select({ id: documentosHabilitacao.id, blobKey: documentosHabilitacao.blobKey, titulo: documentosHabilitacao.titulo })
    .from(documentosHabilitacao)
    .where(inArray(documentosHabilitacao.id, ids));

  // Apaga blobs no R2 em paralelo (best-effort, allSettled).
  // Antes era sequencial — bulk delete de 100 docs significava 100× latência R2.
  const deleteResults = await Promise.allSettled(
    docs.map((d) => deleteDocumento(d.blobKey)),
  );
  const blobsApagados = deleteResults.filter((r) => r.status === "fulfilled").length;

  // Apaga registros DB (cascata em vínculos, projetos, alertas)
  const apagados = await db
    .delete(documentosHabilitacao)
    .where(inArray(documentosHabilitacao.id, ids))
    .returning({ id: documentosHabilitacao.id });

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "BULK_DELETE_DOCUMENTOS_HABILITACAO",
    entidade:   "documento_habilitacao",
    entidadeId: null,
    detalhes:   { ids: apagados.map((a) => a.id), titulos: docs.map((d) => d.titulo), blobsApagados },
  });

  return NextResponse.json({
    ok: true,
    apagados: apagados.length,
    blobsApagados,
  });
}
