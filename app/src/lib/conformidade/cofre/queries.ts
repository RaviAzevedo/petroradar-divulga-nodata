/**
 * Queries Reutilizáveis — Módulo Habilitação (Cofre de Documentos)
 */

import { db } from "@/db";
import {
  documentosHabilitacao,
  documentosHabilitacaoAnexos,
  documentosFamilias,
  documentosProjetos,
  alertasVencimento,
  disciplinas,
  familias,
  operacoes,
  profissionalDocumentos,
  users,
  type DocumentoHabilitacao,
  type StatusDocHab,
  type CategoriaDocHab,
} from "@/db/schema";
import { eq, and, or, ilike, isNull, isNotNull, desc, asc, count, lt, gte, sql, type SQL, inArray } from "drizzle-orm";
import { isConformidade } from "@/lib/permissions";
import type { TipoDocumento } from "@/lib/conformidade/operacoes";
import type { FiltrosDocumentoInput } from "./validations";

// ── Predicado restrito (0034 · 00-ARQUITETURA §3.2) ─────────────────────────

/**
 * Fragmento WHERE do predicado restrito (00-ARQUITETURA §3.2): documento
 * restrito só é visível para Conformidade. Usar em TODAS as queries do cofre
 * (lista, busca, dossiê, verificar*, ZIP). (*verificar não filtra a linha —
 * oculta metadado; ver R5.)
 */
export function restricaoVisivel(role: string): SQL {
  return isConformidade(role) ? sql`true` : eq(documentosHabilitacao.restrito, false);
}

/**
 * Barreira do PAI restrito (0034/S8–S13 · 02-APIS §16-B.1/§16-B.2): true quando
 * o documento existe, é `restrito` e o papel está fora de Conformidade — caso em
 * que a rota-satélite (anexos/famílias/projetos) responde o MESMO 404 de
 * documento inexistente ("anexo não encontrado" ou 403 confirmaria a existência
 * do pai; ADR-05). Pai inexistente devolve false: os gates atuais de cada rota
 * tratam. Homônimo no BFF: `_pai_restrito_invisivel` dos routers-satélite.
 *
 * O WHERE compara `id::text` (não a coluna uuid) de propósito: as rotas-satélite
 * não validam o `id` do path, e um id não-uuid deve cair no comportamento
 * pré-existente da rota (não estourar 22P02 aqui dentro).
 */
export async function paiRestritoInvisivel(id: string, role: string): Promise<boolean> {
  const [row] = await db
    .select({ restrito: documentosHabilitacao.restrito })
    .from(documentosHabilitacao)
    .where(sql`${documentosHabilitacao.id}::text = ${id}`)
    .limit(1);
  return row !== undefined && row.restrito && !isConformidade(role);
}

// ── Buscar por ID ────────────────────────────────────────────────────────────

export async function getDocumentoById(id: string): Promise<DocumentoHabilitacao | null> {
  const [row] = await db
    .select()
    .from(documentosHabilitacao)
    .where(eq(documentosHabilitacao.id, id))
    .limit(1);
  return row ?? null;
}

// ── Listagem com filtros ─────────────────────────────────────────────────────

/**
 * `operacaoId` chegou na 0033; a 0034 (R6) traz `semOperacao` (órfãos),
 * `tipoDocumento` e o parâmetro `role`: o predicado restrito entra SEMPRE, nas
 * DUAS queries (rows e count), para `total`/`pages` refletirem só o visível —
 * contagem não pode denunciar o oculto (00-ARQUITETURA §3.2).
 *
 * 0043: `disciplinaId` (coluna do próprio documento) e `profissionalId`
 * ("documentos deste RT", por pré-seleção de ids). Os dois entram no MESMO
 * `where` das duas queries; a disciplina vem aninhada em cada item.
 */
export async function listDocumentos(
  filtros: FiltrosDocumentoInput & {
    operacaoId?: string;
    semOperacao?: boolean;
    tipoDocumento?: TipoDocumento;
    disciplinaId?: string;      // 0043
    profissionalId?: string;    // 0043
  },
  role: string,
) {
  const conditions: SQL[] = [restricaoVisivel(role)];

  if (filtros.categoria) {
    conditions.push(eq(documentosHabilitacao.categoria, filtros.categoria));
  }

  if (filtros.subcategoria) {
    conditions.push(eq(documentosHabilitacao.subcategoria, filtros.subcategoria));
  }

  if (filtros.status) {
    conditions.push(eq(documentosHabilitacao.status, filtros.status));
  }

  // Provas de UMA operação (0033) — é a coluna do próprio documento, então não
  // depende do join com `operacoes`.
  if (filtros.operacaoId) {
    conditions.push(eq(documentosHabilitacao.operacaoId, filtros.operacaoId));
  }

  // Órfãos (0034/R6). Combinado com `operacaoId` não é erro: os dois predicados
  // se aplicam e o resultado é vazio (decisão declarada — nenhum 4xx especial).
  if (filtros.semOperacao) {
    conditions.push(isNull(documentosHabilitacao.operacaoId));
  }

  if (filtros.tipoDocumento) {
    conditions.push(eq(documentosHabilitacao.tipoDocumento, filtros.tipoDocumento));
  }

  // 0043 — disciplina é coluna do PRÓPRIO documento (não da operação): entra
  // como igualdade simples e, por estar no `where` compartilhado, vale nas
  // duas queries (linhas e contagem) sem nenhum cuidado extra.
  if (filtros.disciplinaId) {
    conditions.push(eq(documentosHabilitacao.disciplinaId, filtros.disciplinaId));
  }

  if (filtros.busca) {
    const termo = `%${filtros.busca}%`;
    conditions.push(
      or(
        ilike(documentosHabilitacao.titulo, termo),
        ilike(documentosHabilitacao.descricao, termo),
        ilike(documentosHabilitacao.numeroDocumento, termo)
      )!
    );
  }

  if (filtros.vencendoEm) {
    const limite = new Date();
    limite.setDate(limite.getDate() + filtros.vencendoEm);
    conditions.push(
      and(
        gte(documentosHabilitacao.validadeFim, new Date()),
        lt(documentosHabilitacao.validadeFim, limite)
      )!
    );
  }

  // Filtro por família (vincula via tabela N:N)
  if (filtros.familiaId) {
    const docsIds = await db
      .select({ documentoId: documentosFamilias.documentoId })
      .from(documentosFamilias)
      .where(eq(documentosFamilias.familiaId, filtros.familiaId));
    const ids = docsIds.map((r) => r.documentoId);
    if (ids.length === 0) {
      return { data: [], total: 0, page: filtros.page, limit: filtros.limit, pages: 0 };
    }
    conditions.push(inArray(documentosHabilitacao.id, ids));
  }

  // 0043 — "documentos deste RT" (molde literal do bloco de família acima):
  // pré-seleciona os ids em `profissional_documentos` e devolve lista vazia
  // quando o profissional não assina nada. A pré-seleção NÃO filtra restrito —
  // ela só junta ids; quem recorta é `restricaoVisivel(role)`, que já é a
  // primeira condição do `where` e vale nas DUAS queries. Sem isso, `total`
  // denunciaria documento oculto. Combinado com `familiaId` dá a interseção:
  // os dois `inArray` são AND, e é esse o comportamento certo.
  if (filtros.profissionalId) {
    const docsDoProfissional = await db
      .select({ documentoId: profissionalDocumentos.documentoId })
      .from(profissionalDocumentos)
      .where(eq(profissionalDocumentos.profissionalId, filtros.profissionalId));
    const ids = docsDoProfissional.map((r) => r.documentoId);
    if (ids.length === 0) {
      return { data: [], total: 0, page: filtros.page, limit: filtros.limit, pages: 0 };
    }
    conditions.push(inArray(documentosHabilitacao.id, ids));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const orderCol =
    filtros.order === "titulo"     ? documentosHabilitacao.titulo :
    filtros.order === "categoria"  ? documentosHabilitacao.categoria :
    filtros.order === "status"     ? documentosHabilitacao.status :
    filtros.order === "criado_em"  ? documentosHabilitacao.criadoEm :
                                     documentosHabilitacao.validadeFim;

  const orderFn = filtros.dir === "desc" ? desc : asc;
  const offset = (filtros.page - 1) * filtros.limit;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id:                    documentosHabilitacao.id,
        categoria:             documentosHabilitacao.categoria,
        subcategoria:          documentosHabilitacao.subcategoria,
        titulo:                documentosHabilitacao.titulo,
        descricao:             documentosHabilitacao.descricao,
        nomeArquivo:           documentosHabilitacao.nomeArquivo,
        blobUrl:               documentosHabilitacao.blobUrl,
        contentType:           documentosHabilitacao.contentType,
        tamanhoBytes:          documentosHabilitacao.tamanhoBytes,
        numeroDocumento:       documentosHabilitacao.numeroDocumento,
        emitidoEm:             documentosHabilitacao.emitidoEm,
        validadeFim:           documentosHabilitacao.validadeFim,
        validadeIndeterminada: documentosHabilitacao.validadeIndeterminada,
        status:                documentosHabilitacao.status,
        versao:                documentosHabilitacao.versao,
        revisao:               documentosHabilitacao.revisao,   // 0044 (B6)
        tags:                  documentosHabilitacao.tags,
        ocrConfianca:          documentosHabilitacao.ocrConfianca,
        uploadadoPor:          documentosHabilitacao.uploadadoPor,
        uploadadoPorNome:      users.nome,
        criadoEm:              documentosHabilitacao.criadoEm,
        atualizadoEm:          documentosHabilitacao.atualizadoEm,
        // 0033 — campos NOVOS (nenhum campo acima foi removido ou renomeado).
        operacaoId:            documentosHabilitacao.operacaoId,
        papel:                 documentosHabilitacao.papel,
        // 0034 (R6) — 5 chaves novas por item, na ordem do contrato.
        tipoDocumento:         documentosHabilitacao.tipoDocumento,
        situacaoProva:         documentosHabilitacao.situacaoProva,
        detentora:             documentosHabilitacao.detentora,
        restrito:              documentosHabilitacao.restrito,
        importJobId:           documentosHabilitacao.importJobId,
        // Achatados no SELECT e aninhados no map abaixo: um join só resolve a
        // operação de todos os documentos da página (nada de N+1).
        operacaoRefId:         operacoes.id,
        operacaoCodigo:        operacoes.codigo,
        operacaoClienteNome:   operacoes.clienteNome,
        // 0043 — a disciplina do documento: o id no topo (é por ele que o
        // PATCH e o filtro trabalham) e o rótulo pelo LEFT JOIN, achatado aqui
        // e aninhado no map, igual à operação. LEFT e 1:1 por FK — não
        // multiplica linha nem muda `total`.
        disciplinaId:          documentosHabilitacao.disciplinaId,
        disciplinaCodigo:      disciplinas.codigo,
        disciplinaNome:        disciplinas.nome,
      })
      .from(documentosHabilitacao)
      .leftJoin(users, eq(documentosHabilitacao.uploadadoPor, users.id))
      .leftJoin(operacoes, eq(documentosHabilitacao.operacaoId, operacoes.id))
      .leftJoin(disciplinas, eq(documentosHabilitacao.disciplinaId, disciplinas.id))
      .where(where!)
      // D8: desempate por chave primária. Sem ele, `ORDER BY validade_fim`
      // (o default) empata em milhares de linhas com NULL e o LIMIT/OFFSET
      // devolve páginas que se repetem e se pulam — invisível com paginação
      // numerada, evidente com rolagem infinita. Espelho OBRIGATÓRIO em
      // conf_cofre_documentos.py (spec ONDA-5 §1b). Nada de NULLS FIRST/LAST
      // em lugar nenhum: os dois lados são Postgres e é o default que os
      // mantém idênticos.
      .orderBy(orderFn(orderCol), asc(documentosHabilitacao.id))
      .limit(filtros.limit)
      .offset(offset),

    db.select({ total: count() }).from(documentosHabilitacao).where(where!),
  ]);

  // Documento sem operação (certidão, ISO, declaração — e todo o legado até o
  // backfill) sai com `operacao: null`, não com um objeto de campos nulos.
  // Documento sem disciplina (0043) sai com `disciplina: null` pelo mesmo
  // motivo — e `disciplinaId` continua no topo do item.
  const data = rows.map((row) => {
    const {
      operacaoRefId, operacaoCodigo, operacaoClienteNome,
      disciplinaCodigo, disciplinaNome,
      ...documento
    } = row;
    return {
      ...documento,
      operacao:
        operacaoRefId !== null && operacaoCodigo !== null && operacaoClienteNome !== null
          ? { id: operacaoRefId, codigo: operacaoCodigo, clienteNome: operacaoClienteNome }
          : null,
      disciplina:
        documento.disciplinaId !== null && disciplinaCodigo !== null && disciplinaNome !== null
          ? { id: documento.disciplinaId, codigo: disciplinaCodigo, nome: disciplinaNome }
          : null,
    };
  });

  return {
    data,
    total: totalRow?.total ?? 0,
    page: filtros.page,
    limit: filtros.limit,
    pages: Math.ceil((totalRow?.total ?? 0) / filtros.limit),
  };
}

// ── Dedup por SHA-256 ────────────────────────────────────────────────────────

/**
 * Documentos do cofre cujo conteúdo bate com um dos hashes — a consulta por trás
 * de POST /cofre/documentos/verificar (a tela pergunta ANTES de subir).
 *
 * Devolve UM documento por hash: quando o mesmo arquivo foi subido duas vezes
 * (registros anteriores à checagem de duplicata), vale o MAIS
 * ANTIGO, que é o registro que o usuário deve reaproveitar. `id` desempata para
 * a ordem ser total e o BFF poder replicá-la.
 */
export async function getDocumentosPorSha256(hashes: string[]) {
  if (hashes.length === 0) return [];

  return db
    .select({
      sha256:         documentosHabilitacao.sha256,
      id:             documentosHabilitacao.id,
      titulo:         documentosHabilitacao.titulo,
      criadoEm:       documentosHabilitacao.criadoEm,
      operacaoCodigo: operacoes.codigo,
      // 0034 (R5): a linha restrita NÃO é filtrada aqui — o uploader precisa
      // saber que é duplicata — mas o handler cega título/data/operação para
      // papel fora de Conformidade.
      restrito:       documentosHabilitacao.restrito,
    })
    .from(documentosHabilitacao)
    .leftJoin(operacoes, eq(documentosHabilitacao.operacaoId, operacoes.id))
    .where(inArray(documentosHabilitacao.sha256, hashes))
    .orderBy(asc(documentosHabilitacao.criadoEm), asc(documentosHabilitacao.id));
}

/**
 * O documento que já guarda estes bytes, se houver — usado pelo POST de upload
 * para recusar duplicata ANTES de mandar o blob pro storage. Mesma regra de
 * desempate da função acima: o mais antigo é o que responde.
 *
 * `restrito` sai junto (0034): o 409 de duplicata mantém o `documentoId` (o
 * uploader precisa saber que é duplicata, como no R5/verificar) mas o handler
 * CEGA o título para papel fora de Conformidade — regra única do §3.2.
 */
export async function getDocumentoPorSha256(
  sha256: string
): Promise<{ id: string; titulo: string; restrito: boolean } | null> {
  const [row] = await db
    .select({
      id:       documentosHabilitacao.id,
      titulo:   documentosHabilitacao.titulo,
      restrito: documentosHabilitacao.restrito,
    })
    .from(documentosHabilitacao)
    .where(eq(documentosHabilitacao.sha256, sha256))
    .orderBy(asc(documentosHabilitacao.criadoEm), asc(documentosHabilitacao.id))
    .limit(1);
  return row ?? null;
}

// ── Famílias vinculadas a um documento ──────────────────────────────────────

export async function getFamiliasByDocumento(documentoId: string) {
  return db
    .select({
      vinculoId:        documentosFamilias.id,
      familiaId:        familias.id,
      codigoCrc:        familias.codigoCrc,
      nome:             familias.nome,
      status:           familias.status,
      observacao:       documentosFamilias.observacao,
      vinculadoEm:      documentosFamilias.criadoEm,
    })
    .from(documentosFamilias)
    .innerJoin(familias, eq(documentosFamilias.familiaId, familias.id))
    .where(eq(documentosFamilias.documentoId, documentoId))
    .orderBy(asc(familias.codigoCrc));
}

// ── Documentos vinculados a uma família ─────────────────────────────────────

/**
 * 0034/S12 (02-APIS §16-B.2): a lista de provas da família filtra o restrito
 * para papel fora de Conformidade — `role` entra no predicado, como no espelho
 * `conf_familias_id.py` do BFF.
 */
export async function getDocumentosByFamilia(familiaId: string, role: string) {
  return db
    .select({
      vinculoId:    documentosFamilias.id,
      documentoId:  documentosHabilitacao.id,
      titulo:       documentosHabilitacao.titulo,
      categoria:    documentosHabilitacao.categoria,
      subcategoria: documentosHabilitacao.subcategoria,
      status:       documentosHabilitacao.status,
      validadeFim:  documentosHabilitacao.validadeFim,
      observacao:   documentosFamilias.observacao,
      vinculadoEm:  documentosFamilias.criadoEm,
    })
    .from(documentosFamilias)
    .innerJoin(documentosHabilitacao, eq(documentosFamilias.documentoId, documentosHabilitacao.id))
    .where(and(eq(documentosFamilias.familiaId, familiaId), restricaoVisivel(role)))
    .orderBy(asc(documentosHabilitacao.titulo));
}

// ── Projetos vinculados a um documento ──────────────────────────────────────

export async function getProjetosByDocumento(documentoId: string) {
  return db
    .select()
    .from(documentosProjetos)
    .where(eq(documentosProjetos.documentoId, documentoId))
    .orderBy(desc(documentosProjetos.periodoFim));
}

// ── Anexos extras do documento ──────────────────────────────────────────────

export async function getAnexosByDocumento(documentoId: string) {
  return db
    .select({
      id:           documentosHabilitacaoAnexos.id,
      documentoId:  documentosHabilitacaoAnexos.documentoId,
      tipo:         documentosHabilitacaoAnexos.tipo,
      titulo:       documentosHabilitacaoAnexos.titulo,
      nomeArquivo:  documentosHabilitacaoAnexos.nomeArquivo,
      blobUrl:      documentosHabilitacaoAnexos.blobUrl,
      blobKey:      documentosHabilitacaoAnexos.blobKey,
      tamanhoBytes: documentosHabilitacaoAnexos.tamanhoBytes,
      contentType:  documentosHabilitacaoAnexos.contentType,
      uploadadoPor: documentosHabilitacaoAnexos.uploadadoPor,
      uploadadoPorNome: users.nome,
      criadoEm:     documentosHabilitacaoAnexos.criadoEm,
    })
    .from(documentosHabilitacaoAnexos)
    .leftJoin(users, eq(documentosHabilitacaoAnexos.uploadadoPor, users.id))
    .where(eq(documentosHabilitacaoAnexos.documentoId, documentoId))
    .orderBy(desc(documentosHabilitacaoAnexos.criadoEm));
}

// ── Métricas (dashboard de habilitação) ─────────────────────────────────────

async function getMetricasHabilitacao() {
  const agora    = new Date();
  const em30dias = new Date(); em30dias.setDate(em30dias.getDate() + 30);
  const em60dias = new Date(); em60dias.setDate(em60dias.getDate() + 60);
  const em90dias = new Date(); em90dias.setDate(em90dias.getDate() + 90);

  const [porCategoria, porStatus, total, vencendo30, vencendo60, vencendo90, vencidos] = await Promise.all([
    db
      .select({ categoria: documentosHabilitacao.categoria, total: count() })
      .from(documentosHabilitacao)
      .groupBy(documentosHabilitacao.categoria),

    db
      .select({ status: documentosHabilitacao.status, total: count() })
      .from(documentosHabilitacao)
      .groupBy(documentosHabilitacao.status),

    db.select({ total: count() }).from(documentosHabilitacao),

    db
      .select({ total: count() })
      .from(documentosHabilitacao)
      .where(
        and(
          isNotNull(documentosHabilitacao.validadeFim),
          gte(documentosHabilitacao.validadeFim, agora),
          lt(documentosHabilitacao.validadeFim, em30dias)
        )
      ),

    db
      .select({ total: count() })
      .from(documentosHabilitacao)
      .where(
        and(
          isNotNull(documentosHabilitacao.validadeFim),
          gte(documentosHabilitacao.validadeFim, agora),
          lt(documentosHabilitacao.validadeFim, em60dias)
        )
      ),

    db
      .select({ total: count() })
      .from(documentosHabilitacao)
      .where(
        and(
          isNotNull(documentosHabilitacao.validadeFim),
          gte(documentosHabilitacao.validadeFim, agora),
          lt(documentosHabilitacao.validadeFim, em90dias)
        )
      ),

    db
      .select({ total: count() })
      .from(documentosHabilitacao)
      .where(
        and(
          isNotNull(documentosHabilitacao.validadeFim),
          lt(documentosHabilitacao.validadeFim, agora)
        )
      ),
  ]);

  const mapaCategoria = {} as Record<CategoriaDocHab, number>;
  for (const r of porCategoria) {
    mapaCategoria[r.categoria as CategoriaDocHab] = r.total;
  }

  const mapaStatus = {} as Record<StatusDocHab, number>;
  for (const r of porStatus) {
    mapaStatus[r.status as StatusDocHab] = r.total;
  }

  return {
    total: total[0]?.total ?? 0,
    porCategoria: mapaCategoria,
    porStatus:    mapaStatus,
    vencendoEm30Dias: vencendo30[0]?.total ?? 0,
    vencendoEm60Dias: vencendo60[0]?.total ?? 0,
    vencendoEm90Dias: vencendo90[0]?.total ?? 0,
    vencidos:         vencidos[0]?.total ?? 0,
  };
}

// ── Documentos vencendo (lista para dashboard) ──────────────────────────────

async function getDocumentosVencendo(diasJanela: number) {
  const agora  = new Date();
  const limite = new Date();
  limite.setDate(limite.getDate() + diasJanela);

  return db
    .select({
      id:           documentosHabilitacao.id,
      titulo:       documentosHabilitacao.titulo,
      categoria:    documentosHabilitacao.categoria,
      subcategoria: documentosHabilitacao.subcategoria,
      validadeFim:  documentosHabilitacao.validadeFim,
      status:       documentosHabilitacao.status,
    })
    .from(documentosHabilitacao)
    .where(
      and(
        isNotNull(documentosHabilitacao.validadeFim),
        gte(documentosHabilitacao.validadeFim, agora),
        lt(documentosHabilitacao.validadeFim, limite)
      )
    )
    .orderBy(asc(documentosHabilitacao.validadeFim));
}

// ── Alertas pendentes ────────────────────────────────────────────────────────

async function getAlertasPendentes() {
  const agora = new Date();
  return db
    .select()
    .from(alertasVencimento)
    .where(
      and(
        isNull(alertasVencimento.enviadoEm),
        lt(alertasVencimento.agendadoPara, agora)
      )
    );
}
