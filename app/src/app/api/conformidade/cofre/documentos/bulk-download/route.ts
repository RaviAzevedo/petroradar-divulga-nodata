export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/conformidade/cofre/documentos/bulk-download
 *
 * Duas formas (0034 — R12/B5):
 *   { ids: [...] }                       → forma ATUAL, intacta: ZIP por
 *     <categoria>/, anexos incluídos, INDICE.txt, nome cofre_<stamp>_<n>docs.zip
 *   { operacaoId, secao?, ids?, arvore? } → forma NOVA: ZIP do DOSSIÊ, árvore
 *     por seção da ficha (SECOES_FICHA), sem anexos, nome dossie_<codigo>_….zip.
 *     `secao` (1..9) filtra uma seção; `ids` presente vira RECORTE (interseção
 *     com os documentos visíveis da operação/seção — fatiamento das seções que
 *     estouram o teto de contagem sozinhas).
 *
 * C6 (0044, onda 5) — `arvore: "secao" | "disciplina"` é campo do BODY, nunca
 * query string: esta rota não lê `searchParams` em ponto nenhum, nem aqui nem
 * no espelho `conf_cofre_bulk_download.py`, e um `?arvore=` seria ignorado em
 * silêncio dos dois lados (spec ONDA-5 §1a). Três regras:
 *   - ausente → `"secao"`, e NADA muda em byte nenhum da resposta atual;
 *   - valor fora dos dois → 422;
 *   - presente na forma ANTIGA (`{ ids }` sem `operacaoId`) → 422, nunca
 *     ignorado: a forma por ids agrupa por CATEGORIA, e entregar outra árvore
 *     calado faria o usuário baixar uma coisa acreditando ter pedido outra.
 * ⚠️ `arvore` COMBINA com `secao` — o filtro decide O QUE entra, a árvore
 * decide COMO as pastas são montadas — e não filtra nada: os tetos e o conjunto
 * de documentos são exatamente os mesmos.
 *
 * Restrito: para papel fora de Conformidade o documento restrito NÃO entra no
 * ZIP nem no INDICE.txt — nem como "1 omitido" (ADR-05). Para Conformidade
 * entra, e cada restrito incluído gera linha em audit_download_restrito (0035)
 * ANTES de montar o buffer.
 *
 * ADR-07: ZIP em MEMÓRIA nos dois lados (JSZip aqui, zipfile+BytesIO no BFF) —
 * os tetos de 100 docs / 200 MB tornam o buffer aceitável e streaming
 * assimétrico mataria a paridade.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { disciplinas, documentosHabilitacao, documentosHabilitacaoAnexos, operacoes } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { isConformidade } from "@/lib/permissions";
import { restricaoVisivel } from "@/lib/conformidade/cofre/queries";
import { registrarDownloadRestrito, type ViaDownloadRestrito } from "@/lib/conformidade/cofre/audit-restrito";
import { secaoDoDocumento, SECOES_FICHA } from "@/lib/conformidade/operacoes";
import { ehUuid } from "@/lib/conformidade/operacoes/validations";
import { getR2ObjectBuffer } from "@/lib/storage/download";
import { loggerFor } from "@/lib/observability/logger";
import JSZip from "jszip";

const LIMITE = 100;
// Teto de bytes somados (docs + anexos). Acima disso recusamos pra não estourar
// a memória do serverless ao montar o ZIP inteiro em buffer. ~200 MB.
const LIMITE_BYTES = 200 * 1024 * 1024;

function sanitize(nome: string): string {
  return nome
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "arquivo";
}

/**
 * Colisão de caminho na forma nova: o 2º caminho idêntico ganha sufixo " (2)",
 * " (3)"… antes da extensão, na ordem estável da query — sem isso o JSZip
 * sobrescreveria em silêncio. Espelho literal no BFF.
 */
function caminhoUnico(usados: Map<string, number>, caminho: string): string {
  const vezes = usados.get(caminho) ?? 0;
  usados.set(caminho, vezes + 1);
  if (vezes === 0) return caminho;

  const ponto = caminho.lastIndexOf(".");
  const barra = caminho.lastIndexOf("/");
  // Extensão só conta se o ponto está no NOME do arquivo (depois da última /).
  if (ponto > barra + 1) {
    return `${caminho.slice(0, ponto)} (${vezes + 1})${caminho.slice(ponto)}`;
  }
  return `${caminho} (${vezes + 1})`;
}

/** Espelho 0035, best-effort ANTES de montar o buffer (política §1.4). */
async function espelharRestritos(
  docs: Array<{ id: string; titulo: string; restrito: boolean; operacaoCodigo: string | null }>,
  user: { id: string; email?: string | null; role: string },
  via: ViaDownloadRestrito,
  log: ReturnType<typeof loggerFor>,
): Promise<void> {
  for (const d of docs) {
    if (!d.restrito) continue;
    try {
      await registrarDownloadRestrito({
        documentoId:    d.id,
        titulo:         d.titulo,
        operacaoCodigo: d.operacaoCodigo,
        userId:         user.id,
        userEmail:      user.email ?? "",
        role:           user.role,
        via,
      });
    } catch (e) {
      log.error("Falha ao gravar espelho 0035 (best-effort)", e, { docId: d.id });
    }
  }
}

export async function POST(request: NextRequest) {
  const log = loggerFor(request, { route: "cofre/bulk-download" });
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const corpo = (body ?? {}) as { ids?: unknown; operacaoId?: unknown; secao?: unknown; arvore?: unknown };
  const temIds = corpo.ids !== undefined;
  const temOperacao = corpo.operacaoId !== undefined;

  if (!temIds && !temOperacao) {
    return NextResponse.json({ error: "Informe ids ou operacaoId" }, { status: 422 });
  }

  // Validação de `ids` compartilhada: forma pura (4a/5a) e recorte (4c) usam
  // as MESMAS strings — o recorte é subconjunto, não um contrato novo.
  function validarIds(ids: unknown): NextResponse | string[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== "string")) {
      return NextResponse.json({ error: "Esperado { ids: string[] } com pelo menos 1 id" }, { status: 422 });
    }
    if (ids.length > LIMITE) {
      return NextResponse.json({ error: `Máximo de ${LIMITE} documentos por download` }, { status: 422 });
    }
    return ids as string[];
  }

  // 4b-bis. `arvore` só existe na forma NOVA e só aceita dois valores. A
  // validação do VALOR vem antes de escolher a forma: "arvore: 'xpto'" é erro
  // de formato nas duas, e o 422 tem de dizer isso.
  let arvore: "secao" | "disciplina" = "secao";
  if (corpo.arvore !== undefined) {
    if (corpo.arvore !== "secao" && corpo.arvore !== "disciplina") {
      return NextResponse.json({ error: "arvore deve ser secao ou disciplina" }, { status: 422 });
    }
    arvore = corpo.arvore;
  }

  // ════════════════════════════════════════════════════════════════════════
  // FORMA NOVA — dossiê da operação (operacaoId presente; ids = recorte)
  // ════════════════════════════════════════════════════════════════════════
  if (temOperacao) {
    // 4b. `secao` presente tem de ser inteiro 1..9.
    let secao: number | null = null;
    if (corpo.secao !== undefined) {
      if (typeof corpo.secao !== "number" || !Number.isInteger(corpo.secao) ||
          corpo.secao < 1 || corpo.secao > 9) {
        return NextResponse.json({ error: "secao deve ser um inteiro de 1 a 9" }, { status: 422 });
      }
      secao = corpo.secao;
    }

    // 4c. recorte com ids inválidos → mesmas strings de 4a/5a.
    let recorte: Set<string> | null = null;
    if (temIds) {
      const validados = validarIds(corpo.ids);
      if (validados instanceof NextResponse) return validados;
      recorte = new Set(validados);
    }

    // 5b. operação não-UUID ou inexistente → 404.
    const operacaoId = corpo.operacaoId;
    if (typeof operacaoId !== "string" || !ehUuid(operacaoId)) {
      return NextResponse.json({ error: "Operação não encontrada" }, { status: 404 });
    }
    const [operacao] = await db
      .select({ id: operacoes.id, codigo: operacoes.codigo, clienteNome: operacoes.clienteNome })
      .from(operacoes)
      .where(eq(operacoes.id, operacaoId))
      .limit(1);
    if (!operacao) {
      return NextResponse.json({ error: "Operação não encontrada" }, { status: 404 });
    }

    // 6b. Docs visíveis da operação, ordem estável (criado_em, id) — o predicado
    // restrito entra na QUERY: papel fora de Conformidade nunca vê a linha.
    const docsDaOperacao = await db
      .select({
        id:            documentosHabilitacao.id,
        titulo:        documentosHabilitacao.titulo,
        nomeArquivo:   documentosHabilitacao.nomeArquivo,
        blobKey:       documentosHabilitacao.blobKey,
        tamanhoBytes:  documentosHabilitacao.tamanhoBytes,
        tipoDocumento: documentosHabilitacao.tipoDocumento,
        papel:         documentosHabilitacao.papel,
        restrito:      documentosHabilitacao.restrito,
        // 0043 — a disciplina que o documento prova (C6). LEFT, nunca INNER:
        // documento sem disciplina é caso comum, e um INNER faria o ZIP
        // sair SEM ele — o pior erro possível num download de dossiê.
        disciplinaId:     documentosHabilitacao.disciplinaId,
        disciplinaCodigo: disciplinas.codigo,
        disciplinaNome:   disciplinas.nome,
      })
      .from(documentosHabilitacao)
      .leftJoin(disciplinas, eq(documentosHabilitacao.disciplinaId, disciplinas.id))
      .where(and(
        eq(documentosHabilitacao.operacaoId, operacaoId),
        restricaoVisivel(user.role),
      ))
      .orderBy(asc(documentosHabilitacao.criadoEm), asc(documentosHabilitacao.id));

    // Filtro de seção em memória: a seção é DERIVADA, não coluna (ADR-02).
    // Recorte: interseção com `ids`, preservando a ordem estável da query —
    // ids fora da operação/seção são ignorados em silêncio (subconjunto).
    const docs = docsDaOperacao
      .filter((d) => secao === null || secaoDoDocumento(d.tipoDocumento, d.papel) === secao)
      .filter((d) => recorte === null || recorte.has(d.id));

    // 7b.
    if (docs.length === 0) {
      return NextResponse.json({ error: "Nenhum documento encontrado" }, { status: 404 });
    }

    // 8b. Tetos com mensagens que nunca mandam o usuário fazer o que ele acabou
    // de fazer: sem `secao` → "Baixe por seção."; com → "Baixe em partes pela ficha.".
    // C6: quem clicou em "Baixar por disciplina" e recebe "Baixe por seção."
    // precisa saber POR QUE a saída está no outro eixo — sem a frase entre
    // parênteses, a mensagem parece ignorar o que ele pediu. Os TETOS em si não
    // mudam, e o conjunto de documentos também não: `arvore` não filtra nada.
    if (docs.length > LIMITE) {
      const erro =
        secao !== null
          ? `A seção ${secao} tem ${docs.length} documentos — o ZIP aceita ${LIMITE}. Baixe em partes pela ficha.`
          : arvore === "disciplina"
            ? `A operação tem ${docs.length} documentos — o ZIP aceita ${LIMITE}. Baixe por seção (o ZIP por disciplina é sempre do dossiê inteiro).`
            : `A operação tem ${docs.length} documentos — o ZIP aceita ${LIMITE}. Baixe por seção.`;
      return NextResponse.json({ error: erro, code: "LIMITE_DOCUMENTOS" }, { status: 422 });
    }
    const totalBytes = docs.reduce((acc, d) => acc + (d.tamanhoBytes ?? 0), 0);
    if (totalBytes > LIMITE_BYTES) {
      const mb = (totalBytes / 1048576).toFixed(0);
      const sufixo =
        secao !== null
          ? "Baixe em partes pela ficha."
          : arvore === "disciplina"
            ? "Baixe por seção (o ZIP por disciplina é sempre do dossiê inteiro)."
            : "Baixe por seção.";
      return NextResponse.json(
        { error: `Pacote de ${mb} MB — o máximo é ${(LIMITE_BYTES / 1048576).toFixed(0)} MB por download. ${sufixo}`,
          code: "LIMITE_BYTES" },
        { status: 422 },
      );
    }

    // Espelho 0035 (só Conformidade chega aqui com restrito na lista).
    await espelharRestritos(
      docs.map((d) => ({ id: d.id, titulo: d.titulo, restrito: d.restrito, operacaoCodigo: operacao.codigo })),
      user, "ZIP_DOSSIE", log,
    );

    // 9. Árvore do dossiê: <codigo - cliente>/<slug da seção>/<titulo__arquivo>.
    // Anexos extras ficam FORA da forma nova (dossiê é a prova principal).
    const raiz = sanitize(`${operacao.codigo} - ${operacao.clienteNome}`);
    const zip = new JSZip();
    const indice: string[] = [
      `Dossiê da operação ${operacao.codigo} - ${operacao.clienteNome} — Petro Radar`,
      `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
      `Documentos: ${docs.length}`,
      "─────────────────────────────────────────────",
    ];

    let incluidos = 0;
    let falhas = 0;
    const usados = new Map<string, number>();

    const buffers = await Promise.allSettled(docs.map((d) => getR2ObjectBuffer(d.blobKey)));
    docs.forEach((d, i) => {
      const slug =
        arvore === "disciplina"
          ? (d.disciplinaCodigo
              ? sanitize(`${d.disciplinaCodigo}_${d.disciplinaNome}`)
              // O "0_" na frente põe a pasta em PRIMEIRO na listagem de
              // qualquer descompactador: o que falta classificar aparece antes
              // do que já está, em vez de se esconder no fim do alfabeto.
              : "0_Sem_disciplina")
          : SECOES_FICHA[secaoDoDocumento(d.tipoDocumento, d.papel)].slug;
      const relativo = caminhoUnico(usados, `${slug}/${sanitize(d.titulo)}__${sanitize(d.nomeArquivo)}`);
      const r = buffers[i];
      if (r.status === "fulfilled") {
        zip.file(`${raiz}/${relativo}`, r.value);
        indice.push(`[OK]    ${relativo}`);
        incluidos++;
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : "?";
        indice.push(`[ERRO]  ${sanitize(d.titulo)} — falha ao baixar do storage (${msg})`);
        falhas++;
      }
    });

    indice.push("");
    indice.push(`Total incluído: ${incluidos}  |  Falhas: ${falhas}`);
    zip.file(`${raiz}/INDICE.txt`, indice.join("\n"));

    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

    // Nome: dossie_<codigo>_<yyyy-mm-dd>.zip; com seção (E com recorte — o
    // servidor não sabe qual parte é; o front renomeia), dossie_…_secao<N>_….zip;
    // com árvore por disciplina, o sufixo `_disciplina` antes do stamp. Os
    // quatro nomes possíveis (C6): dossie_12345_2026-01-15.zip,
    // dossie_12345_secao3_2026-01-15.zip, dossie_12345_disciplina_2026-01-15.zip
    // e dossie_12345_secao3_disciplina_2026-01-15.zip.
    const stamp = new Date().toISOString().slice(0, 10);
    const codigoSan = sanitize(operacao.codigo);
    const parteSecao  = secao === null ? "" : `_secao${secao}`;
    const parteArvore = arvore === "disciplina" ? "_disciplina" : "";
    const filename = `dossie_${codigoSan}${parteSecao}${parteArvore}_${stamp}.zip`;

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type":        "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length":      String(bytes.length),
        "Cache-Control":       "private, no-store",
      },
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // FORMA ATUAL — seleção por ids (intacta + predicado restrito)
  // ════════════════════════════════════════════════════════════════════════

  // `arvore` sem `operacaoId` é 422, nunca ignorado em silêncio: o usuário
  // pediu uma árvore que esta forma não sabe montar (a forma por ids agrupa
  // por CATEGORIA), e entregar outra coisa calado é pior que recusar.
  if (corpo.arvore !== undefined) {
    return NextResponse.json(
      { error: "arvore só se aplica ao dossiê da operação (informe operacaoId)" },
      { status: 422 },
    );
  }

  const idsValidados = validarIds(corpo.ids);
  if (idsValidados instanceof NextResponse) return idsValidados;
  const ids = idsValidados;

  // Predicado restrito na QUERY: ids restritos são silenciosamente excluídos
  // ANTES dos tetos para papel fora de Conformidade (nem o 404 os denuncia —
  // o corpo é o mesmo de "nenhum encontrado").
  const docs = await db
    .select({
      id:           documentosHabilitacao.id,
      titulo:       documentosHabilitacao.titulo,
      categoria:    documentosHabilitacao.categoria,
      subcategoria: documentosHabilitacao.subcategoria,
      nomeArquivo:  documentosHabilitacao.nomeArquivo,
      blobKey:      documentosHabilitacao.blobKey,
      tamanhoBytes: documentosHabilitacao.tamanhoBytes,
      restrito:     documentosHabilitacao.restrito,
      // Para o espelho 0035 (via LEFT JOIN — documento órfão sai null).
      operacaoCodigo: operacoes.codigo,
    })
    .from(documentosHabilitacao)
    .leftJoin(operacoes, eq(documentosHabilitacao.operacaoId, operacoes.id))
    .where(and(inArray(documentosHabilitacao.id, ids), restricaoVisivel(user.role)));

  if (docs.length === 0) {
    return NextResponse.json({ error: "Nenhum documento encontrado" }, { status: 404 });
  }

  const anexos = await db
    .select({
      id:          documentosHabilitacaoAnexos.id,
      documentoId: documentosHabilitacaoAnexos.documentoId,
      titulo:      documentosHabilitacaoAnexos.titulo,
      nomeArquivo: documentosHabilitacaoAnexos.nomeArquivo,
      blobKey:     documentosHabilitacaoAnexos.blobKey,
      tamanhoBytes: documentosHabilitacaoAnexos.tamanhoBytes,
    })
    .from(documentosHabilitacaoAnexos)
    .where(inArray(documentosHabilitacaoAnexos.documentoId, docs.map((d) => d.id)));

  // Teto de tamanho total — soma docs + anexos antes de baixar do R2.
  // Evita OOM quando o ZIP inteiro é montado em buffer. tamanhoBytes pode ser
  // null (legado/sem metadata): nesse caso não há como prever, então passa.
  const totalBytes =
    docs.reduce((acc, d) => acc + (d.tamanhoBytes ?? 0), 0) +
    anexos.reduce((acc, a) => acc + (a.tamanhoBytes ?? 0), 0);
  if (totalBytes > LIMITE_BYTES) {
    return NextResponse.json(
      {
        error: `Pacote muito grande (${(totalBytes / 1048576).toFixed(0)} MB). ` +
          `Máximo de ${(LIMITE_BYTES / 1048576).toFixed(0)} MB por download — selecione menos documentos.`,
      },
      { status: 422 },
    );
  }

  // Espelho 0035: Conformidade baixando restrito por seleção → ZIP_SELECAO.
  if (isConformidade(user.role)) {
    await espelharRestritos(docs, user, "ZIP_SELECAO", log);
  }

  const zip = new JSZip();
  const indice: string[] = [
    "Pacote de documentos — Petro Radar (Cofre de Habilitação)",
    `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
    `Documentos: ${docs.length}  |  Anexos extras: ${anexos.length}`,
    "─────────────────────────────────────────────",
    "",
  ];

  let incluidos = 0;
  let pulados = 0;

  // Download principal em paralelo (allSettled — uma falha não derruba o ZIP)
  const principais = await Promise.allSettled(docs.map((d) => getR2ObjectBuffer(d.blobKey)));
  docs.forEach((d, i) => {
    const pasta = sanitize(d.categoria);
    const tituloSan = sanitize(d.titulo);
    const arqSan = sanitize(d.nomeArquivo);
    const r = principais[i];
    if (r.status === "fulfilled") {
      zip.file(`${pasta}/${tituloSan}__${arqSan}`, r.value);
      indice.push(`[OK]    ${pasta}/${tituloSan}__${arqSan}  (${d.subcategoria})`);
      incluidos++;
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : "?";
      indice.push(`[ERRO]  ${tituloSan} — falha ao baixar do storage (${msg})`);
      pulados++;
    }
  });

  // Anexos
  if (anexos.length > 0) {
    indice.push("");
    indice.push("Anexos extras:");
    const buffers = await Promise.allSettled(anexos.map((a) => getR2ObjectBuffer(a.blobKey)));
    const docPorId = new Map(docs.map((d) => [d.id, d]));
    anexos.forEach((a, i) => {
      const doc = docPorId.get(a.documentoId);
      if (!doc) return;
      const pasta = sanitize(doc.categoria);
      const tituloSan = sanitize(doc.titulo);
      const arqSan = sanitize(a.titulo || a.nomeArquivo);
      const r = buffers[i];
      if (r.status === "fulfilled") {
        zip.file(`${pasta}/${tituloSan}/anexos/${arqSan}`, r.value);
        indice.push(`  [OK]   ${pasta}/${tituloSan}/anexos/${arqSan}`);
        incluidos++;
      } else {
        indice.push(`  [ERRO] ${tituloSan}/anexos/${arqSan} — falha ao baixar`);
        pulados++;
      }
    });
  }

  indice.push("");
  indice.push(`Total incluído: ${incluidos}  |  Falhas: ${pulados}`);
  zip.file("INDICE.txt", indice.join("\n"));

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `cofre_${stamp}_${docs.length}docs.zip`;

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type":        "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length":      String(bytes.length),
      "Cache-Control":       "private, no-store",
    },
  });
}
