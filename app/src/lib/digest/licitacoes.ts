/**
 * Núcleo do Digest de E-mail de Licitações (0026) — usado pelo cron
 * /api/cron/digest-licitacoes e pelo botão "Enviar teste" do Admin Center.
 *
 * Os FILTROS DE E-MAIL são entidade própria (filtros_email.criterios jsonb),
 * independente dos perfis_interesse do sistema — avaliados aqui em SQL puro
 * sobre as colunas classificadas de licitacoes (natureza/tipo_servico/segmento
 * estão 100% preenchidas para TODA licitação) + keywords no objeto com
 * f_unaccent + regex de fronteira de palavra (\m..\M), input escapado.
 *
 * Dedup POR ASSINANTE via ledger assinaturas_email_envios (UNIQUE
 * assinatura+licitação; ON CONFLICT DO NOTHING). NUNCA usar
 * licitacoes.notificado_perfil_em aqui (marca GLOBAL do broadcast push/webhook).
 */

import { db } from "@/db";
import { licitacoes, assinaturasEmailEnvios, assinaturasEmail } from "@/db/schema";
import { and, eq, gte, inArray, ilike, or, desc, sql, type SQL } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { coberturaCrcPorLicitacao, contarFamiliasAtivas } from "@/lib/licitacoes/habilitacao";
import { templateDigestFiltro, type DigestFiltroItem } from "@/lib/email/templates";
import {
  SCORE_POR_RELEVANCIA, UF_PARA_NOME,
  montarRegexKeywords, normalizarCriterios, cadenciaVencida, janelaDesde,
  type CriteriosFiltroEmail,
} from "@/lib/digest/criterios";

// Reexporta as funções puras (rotas importam tudo daqui).
export {
  normalizarCriterios, montarRegexKeywords, cadenciaVencida, janelaDesde,
  type CriteriosFiltroEmail,
};

// ── Seleção das licitações que casam com o filtro ────────────────────────────

export interface OpcoesBusca {
  desde:         Date;
  /** Com assinaturaId: exclui as já enviadas (ledger). Sem (preview): não. */
  assinaturaId?: string;
  limite?:       number;
}

const CAMPOS_ITEM = {
  id:             licitacoes.id,
  numero:         licitacoes.numero,
  objeto:         licitacoes.objeto,
  objetoResumido: licitacoes.objetoResumido,
  empresa:        licitacoes.empresa,
  dataFim:        licitacoes.dataFim,
  relevancia:     licitacoes.relevancia,
  scoreInteresse: licitacoes.scoreInteresse,
  tipoServico:    licitacoes.tipoServico,
  segmento:       licitacoes.segmento,
  fonte:          licitacoes.fonte,
};

export async function buscarLicitacoesParaFiltro(
  criterios: CriteriosFiltroEmail,
  opts: OpcoesBusca,
): Promise<DigestFiltroItem[]> {
  const c = criterios;
  const where: SQL[] = [gte(licitacoes.criadoEm, opts.desde)];

  // Assinatura por PERFIL (0029): casa pela MESMA coluna que o motor preenche e
  // que o /explorar filtra. O que a pessoa ve no Explorar com aquele perfil e o
  // que ela recebe por e-mail — sem um segundo conjunto de criterios para
  // divergir. Quando ha perfil, ele e o criterio; os demais campos ficam vazios.
  if (c.perfil) {
    where.push(ilike(licitacoes.perfisMatch, `%${c.perfil}%`));
  }

  if (c.naturezas?.length)     where.push(inArray(licitacoes.natureza, c.naturezas));
  if (c.tipos_servico?.length) where.push(inArray(licitacoes.tipoServico, c.tipos_servico));
  if (c.segmentos?.length)     where.push(inArray(licitacoes.segmento, c.segmentos));
  if (c.estados?.length) {
    // regioes grava NOMES COMPLETOS (petronect) ou "Cidade/UF" (transparência)
    // — ver UF_PARA_NOME em criterios.ts; UFs já validadas na normalização.
    const porUf = c.estados.flatMap((uf) => [
      ilike(licitacoes.regioes, `%${UF_PARA_NOME[uf]}%`),
      ilike(licitacoes.regioes, `%/${uf}%`),
    ]);
    where.push(or(...porUf)!);
  }

  const regexIncluir = montarRegexKeywords(c.keywords_incluir ?? []);
  if (regexIncluir) {
    where.push(sql`f_unaccent(${licitacoes.objeto}) ~* ${regexIncluir}`);
  }
  const regexExcluir = montarRegexKeywords(c.keywords_excluir ?? []);
  if (regexExcluir) {
    where.push(sql`NOT (f_unaccent(coalesce(${licitacoes.objeto}, '')) ~* ${regexExcluir})`);
  }

  const piso = SCORE_POR_RELEVANCIA[c.min_relevancia ?? "TODAS"] ?? 0;
  if (piso > 0) where.push(gte(licitacoes.scoreInteresse, piso));

  if (opts.assinaturaId) {
    where.push(sql`NOT EXISTS (
      SELECT 1 FROM ${assinaturasEmailEnvios} e
      WHERE e.assinatura_id = ${opts.assinaturaId} AND e.licitacao_id = ${licitacoes.id}
    )`);
  }

  const rows = await db
    .select(CAMPOS_ITEM)
    .from(licitacoes)
    .where(and(...where))
    .orderBy(sql`${licitacoes.scoreInteresse} DESC NULLS LAST`, desc(licitacoes.criadoEm))
    .limit(opts.limite ?? 200);

  return rows as DigestFiltroItem[];
}

// ── Envio para UMA assinatura (cron e enviar-teste) ──────────────────────────

export interface AssinaturaParaEnvio {
  id:            string;
  email:         string;
  formato:       "resumido" | "completo";
  /** Rotulo mostrado no e-mail: nome do perfil (0029) ou do filtro legado. */
  filtroNome:    string;
  criterios:     CriteriosFiltroEmail;
}

export interface ResultadoEnvio {
  enviado: boolean;
  total:   number;
  itens:   number;
  erro?:   string;
}

/**
 * Busca, renderiza e envia o digest de UMA assinatura.
 * `teste=true` ignora o ledger na seleção E não grava nada (subject [TESTE]).
 * Sucesso real: transação ledger (ON CONFLICT DO NOTHING) + ultimo_envio_em.
 * Falha de envio: NADA é gravado — as licitações saem de novo na próxima rodada.
 *
 * A janela é SEMPRE o teto fixo de 7 dias (janelaDesde(null)): a dedup do
 * envio real é 100% do ledger NOT EXISTS. Avançar a janela pelo ultimo_envio_em
 * perderia PARA SEMPRE o excedente do teto de itens (criadoEm < último envio —
 * achado do review 2026-07-08); ultimo_envio_em serve só à cadência.
 */
export async function enviarDigestAssinatura(
  ass: AssinaturaParaEnvio,
  maxItens: number,
  teste = false,
): Promise<ResultadoEnvio> {
  const encontradas = await buscarLicitacoesParaFiltro(ass.criterios, {
    desde:        janelaDesde(null),
    assinaturaId: teste ? undefined : ass.id,
    limite:       500,
  });

  if (encontradas.length === 0) return { enviado: false, total: 0, itens: 0 };

  // Clamp: teto <1 geraria e-mail vazio em loop (itens=[] nunca marca ledger).
  const itens = encontradas.slice(0, Math.max(1, maxItens));

  // Mesmo enriquecimento CRC do caminho consolidado — este e o caminho do botao
  // "Enviar teste". Sem isso o teste mostraria um e-mail SEM o badge e o real COM,
  // que e exatamente o jeito de um teste deixar de testar o que interessa.
  const cobertura = await coberturaCrcPorLicitacao(itens.map((i) => i.id));
  for (const i of itens) {
    const c = cobertura.get(i.id);
    if (c) i.coberturaCrc = c;
  }
  const familiasAtivas = itens.some((i) => i.coberturaCrc) ? await contarFamiliasAtivas() : undefined;

  const tpl = templateDigestFiltro({
    nomeFiltro:       ass.filtroNome,
    formato:          ass.formato,
    itens,
    totalEncontradas: encontradas.length,
    teste,
    familiasAtivas,
  });

  // O logo da marca (cid:logo-proponente, referenciado pelo layout único) é
  // anexado inline pelo próprio sendEmail() — não passe inlineImages aqui.
  const res = await sendEmail({
    to: ass.email, subject: tpl.subject, html: tpl.html, text: tpl.text,
  });
  if (!res.ok) return { enviado: false, total: encontradas.length, itens: itens.length, erro: res.error };

  if (!teste) {
    // Marca no ledger só o que FOI para o e-mail — o excedente do teto continua
    // fora do ledger e sai na próxima rodada (janela fixa de 7d garante isso).
    await db.transaction(async (tx) => {
      await tx
        .insert(assinaturasEmailEnvios)
        .values(itens.map((l) => ({ assinaturaId: ass.id, licitacaoId: l.id })))
        .onConflictDoNothing();
      await tx
        .update(assinaturasEmail)
        .set({ ultimoEnvioEm: new Date() })
        .where(eq(assinaturasEmail.id, ass.id));
    });
  }

  return { enviado: true, total: encontradas.length, itens: itens.length };
}


// ── Envio CONSOLIDADO: um e-mail por PESSOA ──────────────────────────────────

export interface AssinaturaDoUsuario {
  id:         string;
  rotulo:     string;                       // nome do perfil (ou filtro legado)
  formato:    "resumido" | "completo";
  criterios:  CriteriosFiltroEmail;
}

export interface ResultadoEnvioUsuario {
  enviado:  boolean;
  itens:    number;
  total:    number;
  perfis:   string[];
  erro?:    string;
}

/**
 * Junta TODAS as assinaturas de uma pessoa num ÚNICO e-mail diário.
 *
 * Antes era um e-mail por assinatura: quem assinava 3 perfis recebia 3 e-mails
 * na mesma manhã, com a mesma cara — o caminho mais curto para a pessoa criar
 * uma regra de caixa e parar de ler. Agora as licitações dos perfis dela são
 * unidas, deduplicadas (uma licitação pode casar com 2 perfis) e ordenadas pelo
 * score, do melhor para o pior.
 *
 * O ledger continua sendo POR ASSINATURA: cada licitação enviada é registrada em
 * TODAS as assinaturas que a trouxeram. Sem isso, uma licitação que casa com dois
 * perfis voltaria amanhã pelo perfil que não a registrou.
 */
export async function enviarDigestUsuario(
  email: string,
  assinaturas: AssinaturaDoUsuario[],
  maxItens: number,
  teste = false,
): Promise<ResultadoEnvioUsuario> {
  const porLicitacao = new Map<string, { item: DigestFiltroItem; assinaturas: string[] }>();

  for (const ass of assinaturas) {
    const achadas = await buscarLicitacoesParaFiltro(ass.criterios, {
      desde:        janelaDesde(null),
      assinaturaId: teste ? undefined : ass.id,
      limite:       500,
    });
    for (const item of achadas) {
      const reg = porLicitacao.get(item.id);
      if (reg) reg.assinaturas.push(ass.id);
      else porLicitacao.set(item.id, { item, assinaturas: [ass.id] });
    }
  }

  const perfis = assinaturas.map((a) => a.rotulo);
  if (porLicitacao.size === 0) {
    return { enviado: false, itens: 0, total: 0, perfis };
  }

  // Melhores primeiro: o e-mail tem teto, então o corte tem de cair no que menos
  // importa, não no que chegou por último.
  const ordenadas = [...porLicitacao.values()].sort(
    (a, b) => (b.item.scoreInteresse ?? 0) - (a.item.scoreInteresse ?? 0),
  );
  const escolhidas = ordenadas.slice(0, Math.max(1, maxItens));

  // Cobertura CRC — o sinal "Habilitamos?" que o Explorar mostra. Vai DEPOIS do
  // slice de proposito: consultar so os itens que entram no e-mail, nao os 500 da
  // busca. E nunca entra no WHERE — cobertura filtra o que a pessoa VE, nao o que
  // ela recebe; um perfil que casa mas nao temos CRC continua valendo o aviso.
  const cobertura = await coberturaCrcPorLicitacao(escolhidas.map((e) => e.item.id));
  for (const e of escolhidas) {
    const c = cobertura.get(e.item.id);
    if (c) e.item.coberturaCrc = c;
  }

  // Contexto do rodape. So consulta se algum card vai de fato exibir o sinal —
  // sem isso seria um COUNT a cada digest para alimentar uma nota que nao renderiza.
  const familiasAtivas = escolhidas.some((e) => e.item.coberturaCrc)
    ? await contarFamiliasAtivas()
    : undefined;

  // Formato: "completo" se QUALQUER assinatura da pessoa pedir — rebaixar para
  // resumido perderia informação que ela pediu explicitamente.
  const formato = assinaturas.some((a) => a.formato === "completo") ? "completo" : "resumido";

  const tpl = templateDigestFiltro({
    nomeFiltro:       perfis.length === 1 ? perfis[0] : perfis.join(" · "),
    formato,
    itens:            escolhidas.map((e) => e.item),
    totalEncontradas: porLicitacao.size,
    teste,
    familiasAtivas,
  });

  const res = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  if (!res.ok) {
    return { enviado: false, itens: escolhidas.length, total: porLicitacao.size, perfis, erro: res.error };
  }

  if (!teste) {
    const agora = new Date();
    const linhas = escolhidas.flatMap((e) =>
      e.assinaturas.map((assinaturaId) => ({ assinaturaId, licitacaoId: e.item.id })),
    );
    await db.transaction(async (tx) => {
      if (linhas.length > 0) {
        await tx.insert(assinaturasEmailEnvios).values(linhas).onConflictDoNothing();
      }
      for (const ass of assinaturas) {
        await tx
          .update(assinaturasEmail)
          .set({ ultimoEnvioEm: agora })
          .where(eq(assinaturasEmail.id, ass.id));
      }
    });
  }

  return { enviado: true, itens: escolhidas.length, total: porLicitacao.size, perfis };
}
