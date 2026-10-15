/**
 * POST /api/licitacoes/[id]/dossie — O BOTÃO. O único caminho que gasta token.
 *
 * Um clique faz o pipeline inteiro, de ponta a ponta:
 *
 *   1. baixa os anexos do Petronect e extrai o texto (local quando dá; Haiku só
 *      no PDF escaneado que não rende texto) — é isso que "manda toda a
 *      documentação da licitação para a Anthropic";
 *   2. chama o Claude Sonnet 5 com o texto de TODOS os anexos + circulares;
 *   3. devolve um ZIP com o briefing em PDF, o CHECK-LIST oficial preenchido e
 *      os documentos originais.
 *
 * ROTA WEB-ONLY. O nginx manda todo /api/ para o BFF (FastAPI); esta rota está na
 * lista de exceções (nginx/conf.d/petro-radar.conf e nginx/strangler/routes.conf)
 * porque o entregável é binário gerado por libs de Node — pdf-lib, ExcelJS e
 * JSZip. Se você renomear a rota, ATUALIZE OS DOIS ARQUIVOS DO NGINX, senão ela
 * cai no BFF e responde 404.
 *
 * CUSTO: ~US$ 0,15 por dossiê no Sonnet 5 (edital de ~30k tokens), mais alguns
 * centavos de Haiku por anexo escaneado. O rate limit é POR LICITAÇÃO (não por
 * usuário) — dois analistas clicando na mesma licitação ao mesmo tempo pagariam
 * a análise duas vezes.
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db";
import { licitacoes, anexos, analisesIa, circulares } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { requirePropor, handleApiError } from "@/lib/api/guards";
import { briefingIaHabilitado, BRIEFING_DESABILITADO } from "@/lib/licitacoes/briefing-flag";
import { rateLimit } from "@/lib/rate-limit";
import { processarAnexosDaLicitacao } from "@/lib/licitacoes/extrair-anexos";
import {
  montarTextoDaLicitacao,
  resolverModelo,
  executarEPersistirAnalise,
  AnaliseError,
  type AnaliseSalva,
} from "@/lib/licitacoes/executar-analise";
import { condicaoDeParticipar } from "@/lib/licitacoes/habilitacao-familias";
import { montarDossie, type AnexoDossie, type CircularDossie } from "@/lib/licitacoes/dossie";
import type { AnaliseRow, BriefingMeta } from "@/lib/licitacoes/briefing";
import type { RequisitoBriefing } from "@/lib/licitacoes/briefing-pdf";

// Baixar N anexos + OCR + análise + montar ZIP não cabe no timeout padrão.
export const maxDuration = 300;
export const runtime = "nodejs";

/** Converte a linha do banco no shape que o briefing/checklist consomem. */
function paraAnaliseRow(a: AnaliseSalva): AnaliseRow {
  return {
    resumo: a.resumo ?? null,
    objetoDetalhado: a.objetoDetalhado ?? null,
    checklist: a.checklist ?? null,
    requisitos: a.requisitos ?? null,
    criteriosHabilitacao: a.criteriosHabilitacao ?? null,
    criteriosJulgamento: a.criteriosJulgamento ?? null,
    valorEstimado: a.valorEstimado ?? null,
    prazos: a.prazos ?? null,
    riscos: a.riscos ?? null,
    recomendacao: a.recomendacao ?? null,
    modeloUsado: a.modeloUsado ?? null,
    erroParse: a.erroParse ?? null,
    schemaVersao: a.schemaVersao ?? null,
    fonteTexto: a.fonteTexto ?? null,
    charsEntrada: a.charsEntrada ?? null,
    probVitoria: a.probVitoria ?? null,
    analisadoEm: a.analisadoEm ?? null,
  };
}

/**
 * Os requisitos rastreáveis não têm coluna própria — vivem dentro do JSON de
 * `resposta_raw`. Extraímos aqui para alimentar a tabela de habilitação do PDF.
 */
function extrairRequisitos(respostaRaw: string | null): RequisitoBriefing[] {
  if (!respostaRaw) return [];
  try {
    const raw = JSON.parse(respostaRaw) as { requisitos_estruturados?: unknown };
    if (!Array.isArray(raw.requisitos_estruturados)) return [];
    return raw.requisitos_estruturados
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        codigo: String(r.codigo ?? "OUTRO"),
        descricao: String(r.descricao ?? ""),
        obrigatorio: r.obrigatorio !== false,
        confianca: typeof r.confianca === "number" ? r.confianca : undefined,
      }))
      .filter((r) => r.descricao);
  } catch {
    return [];
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Chave geral da geração por IA (desligada por padrão). Vem ANTES do RBAC
  // de propósito: desligada, a rota não deve nem revelar quem pode propor.
  if (!briefingIaHabilitado()) {
    return NextResponse.json(BRIEFING_DESABILITADO, { status: 503 });
  }

  // Só RBAC: o rate limit desta rota é por LICITAÇÃO, não por usuário, então
  // não precisamos da identidade além da autorização.
  try {
    await requirePropor();
  } catch (e) {
    return handleApiError(e, request);
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const force = body.force === true;

  // CONFIRMAÇÃO EXPLÍCITA DE INTENÇÃO — o pedágio da única rota que gasta dinheiro.
  //
  // Um POST sem corpo não pode disparar Petronect + Haiku + Sonnet. Isso não é
  // paranoia: o harness de paridade (tests/parity/test_route_inventory.py) SONDA
  // cada rota do inventário com um POST de corpo `{}` para provar que o RBAC
  // autoriza — e a sonda rodaria o pipeline inteiro, gastando ~US$ 0,15 a cada
  // execução da suíte. O mesmo vale para qualquer curl, script ou retry
  // automático que caia aqui por engano.
  //
  // O teste continua passando: 400 é aceito como prova de autorização em rotas de
  // escrita (o guard passou; faltou o corpo). Só que agora ele não paga por isso.
  if (body.confirmar !== true) {
    return NextResponse.json(
      {
        error: {
          code: "CONFIRMACAO_OBRIGATORIA",
          message:
            'Esta rota consome a API da Anthropic. Envie {"confirmar": true} no corpo para executar.',
        },
      },
      { status: 400 },
    );
  }

  // Rate limit POR LICITAÇÃO. Proposital: o recurso caro é a licitação, não o
  // usuário. Chavear por usuário (como faz a rota /analise) deixa dois analistas
  // pagarem a mesma análise em paralelo.
  const rl = await rateLimit({ key: `dossie:lic:${id}`, max: 1, windowMs: 3 * 60 * 1000 });
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Já existe um dossiê sendo gerado para esta licitação. Aguarde alguns minutos.",
        },
      },
      { status: 429 },
    );
  }

  const [lic] = await db.select().from(licitacoes).where(eq(licitacoes.id, id)).limit(1);
  if (!lic) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Licitação não encontrada" } },
      { status: 404 },
    );
  }

  try {
    // ── 1. Documentos: baixa e extrai o texto ────────────────────────────────
    // Idempotente por anexo (pula quem já tem texto_cache), exceto com force.
    const resumoAnexos = await processarAnexosDaLicitacao(id, { force, request });

    // ── 2. Análise ───────────────────────────────────────────────────────────
    let analise: AnaliseSalva | undefined;
    let reaproveitada = false;

    if (!force) {
      [analise] = await db.select().from(analisesIa).where(eq(analisesIa.licitacaoId, id)).limit(1);
      reaproveitada = !!analise;
    }

    if (!analise) {
      const fonte = await montarTextoDaLicitacao(id, lic.objeto);

      // GATE DE CUSTO — a decisão mais importante desta rota.
      //
      // Se nenhum anexo rendeu texto, `montarTextoDaLicitacao` cai no campo
      // `objeto` (uma linha). Analisar isso custa o MESMO (~US$ 0,15) e devolve
      // um briefing vazio: sem prazos, sem habilitação, sem riscos — porque essa
      // informação nunca esteve no texto enviado. Preço cheio, valor zero.
      //
      // Quando a licitação TEM anexos e nenhum deles virou texto, o problema é de
      // coleta (Petronect fora do ar, phio_objid faltando, PDF ilegível) — e o
      // certo é dizer isso, não cobrar do usuário por um documento em branco.
      // Se ela não tem anexo NENHUM, analisar o objeto é o melhor possível e
      // seguimos (o LEIA-ME do ZIP registra a procedência).
      if (!fonte.temTextoDeAnexos && resumoAnexos.total > 0) {
        const detalhe = resumoAnexos.falhas.length
          ? ` Falhas: ${resumoAnexos.falhas.slice(0, 3).map((f) => `${f.descricao} (${f.erro})`).join("; ")}`
          : "";
        return NextResponse.json(
          {
            error: {
              code: "NO_TEXT",
              message:
                `Nenhum dos ${resumoAnexos.total} anexo(s) rendeu texto legível, então a análise seria feita ` +
                `apenas sobre o objeto da licitação — custaria o mesmo e voltaria vazia. ` +
                `Verifique os anexos no Petronect e tente de novo.${detalhe}`,
            },
          },
          { status: 400 },
        );
      }

      const modelo = resolverModelo(body.modelo);
      analise = await executarEPersistirAnalise(
        id, lic.numero, fonte.texto, modelo,
        fonte.temTextoDeAnexos ? "ANEXOS" : "OBJETO",
      );
    }

    // ── 3. Dossiê ────────────────────────────────────────────────────────────
    const licAnexos = await db
      .select({
        descricao: anexos.descricao,
        s3Key: anexos.s3Key,
        contentType: anexos.contentType,
        tamanhoBytes: anexos.tamanhoBytes,
      })
      .from(anexos)
      .where(eq(anexos.licitacaoId, id));

    const licCirculares = await db
      .select({
        tipo: circulares.tipo,
        autor: circulares.autor,
        mensagem: circulares.mensagem,
        dataPublicacao: circulares.dataPublicacao,
        anexoDescricao: circulares.anexoDescricao,
      })
      .from(circulares)
      .where(eq(circulares.licitacaoId, id))
      .orderBy(desc(circulares.dataPublicacao));

    const anexosDossie: AnexoDossie[] = licAnexos.map((a) => ({
      descricao: a.descricao,
      s3Key: a.s3Key,
      contentType: a.contentType,
      tamanhoBytes: a.tamanhoBytes,
      origem: "EDITAL" as const,
    }));

    const circularesDossie: CircularDossie[] = licCirculares.map((ci) => ({
      tipo: ci.tipo,
      autor: ci.autor,
      mensagem: ci.mensagem,
      dataPublicacao: ci.dataPublicacao,
    }));

    const meta: BriefingMeta = {
      numero: lic.numero,
      objeto: lic.objeto ?? null,
      empresa: lic.empresa ?? null,
      segmento: lic.segmento ?? null,
    };

    // Habilitação por família CRC — junção determinística, CUSTO ZERO DE TOKEN.
    // Roda mesmo com a IA desligada e é a única parte do dossiê que responde o
    // que a Proponente TEM, e não o que o edital exige.
    const habilitacao = await condicaoDeParticipar(id).catch(() => null);

    const dossie = await montarDossie({
      habilitacao,
      meta,
      analise: paraAnaliseRow(analise),
      requisitos: extrairRequisitos(analise.respostaRaw),
      anexos: anexosDossie,
      circulares: circularesDossie,
    });

    return new NextResponse(new Uint8Array(dossie.buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${dossie.filename}"`,
        // Telemetria para a UI mostrar o que aconteceu sem abrir o ZIP.
        "X-Dossie-Documentos": String(dossie.incluidos),
        "X-Dossie-Pendencias": String(dossie.pulados),
        "X-Dossie-Anexos-Novos": String(resumoAnexos.processados ?? 0),
        "X-Dossie-Analise-Reaproveitada": String(reaproveitada),
      },
    });
  } catch (error) {
    if (error instanceof AnaliseError) {
      const status = error.code === "NO_TEXT" ? 400 : 400;
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status });
    }

    // Indisponibilidade temporária da Anthropic → 503 (o usuário pode reclicar).
    if (
      (error instanceof Anthropic.APIError &&
        (error.status === 429 || error.status === 529 || error.status === 503)) ||
      error instanceof Anthropic.APIConnectionTimeoutError ||
      error instanceof Anthropic.APIConnectionError
    ) {
      return NextResponse.json(
        {
          error: {
            code: "AI_UNAVAILABLE",
            message: "Serviço de IA temporariamente indisponível. Tente novamente em alguns instantes.",
          },
        },
        { status: 503 },
      );
    }

    return handleApiError(error, request);
  }
}
