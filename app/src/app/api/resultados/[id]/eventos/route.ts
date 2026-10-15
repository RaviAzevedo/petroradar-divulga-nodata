export const runtime = "nodejs";

/**
 * GET  /api/resultados/[id]/eventos — linha do tempo de eventos do vencedor
 * POST /api/resultados/[id]/eventos — registra novo evento (ANUNCIADO,
 *   DESCLASSIFICADO, CONVOCADO, DESISTIU, HOMOLOGADO)
 *
 * Quando tipo=CONVOCADO + cnpj=Proponente, dispara workflow:
 *   - cria envelope (de participação se houver, senão avulso) com prazo de 5 dias úteis
 *   - marca participação como GANHOU
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { resultadosLicitacao, petronectLicEventos } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { podeGerenciarEnvelope } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import { listarEventos, registrarEvento } from "@/lib/eventos-vencedor/queries";
import { RegistrarEventoSchema, formatZodErrors } from "@/lib/eventos-vencedor/validations";

type Params = { params: Promise<{ id: string }> };

async function numeroPorId(id: string): Promise<string | null> {
  // Aceita numero direto OU UUID legado
  if (/^\d{8,12}$/.test(id)) return id;
  const [r] = await db
    .select({ numero: resultadosLicitacao.numeroLicitacao })
    .from(resultadosLicitacao)
    .where(eq(resultadosLicitacao.id, id))
    .limit(1);
  return r?.numero ?? null;
}

/**
 * GET retorna timeline UNIFICADA:
 *   • eventos MANUAIS (licitacao_eventos_vencedor): ANUNCIADO, DESCLASSIFICADO,
 *     CONVOCADO, DESISTIU, HOMOLOGADO — registrados por humanos da equipe SGI
 *   • eventos AUTOMÁTICOS (petronect_lic_eventos): winner_revealed,
 *     status_changed, document_added, etc. — detectados pelo change_detector V2
 *
 * Cada item tem `fonteEvento: 'manual' | 'automatico'` para a UI distinguir.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const numero = await numeroPorId(id);
  if (!numero) return NextResponse.json({ error: "Resultado não encontrado" }, { status: 404 });

  const [eventosManuais, eventosAuto] = await Promise.all([
    listarEventos(numero),
    db.select()
      .from(petronectLicEventos)
      .where(eq(petronectLicEventos.numero, numero))
      .orderBy(desc(petronectLicEventos.detectadoEm)),
  ]);

  const manuaisFormatados = (eventosManuais as unknown as Array<Record<string, unknown>>).map((e) => ({
    ...e,
    fonteEvento: "manual" as const,
  }));

  const automaticosFormatados = eventosAuto.map((e) => ({
    id:           e.id,
    numero:       e.numero,
    tipo:         e.tipo,
    campo:        e.campo,
    valorAnterior: e.valorAnterior,
    valorNovo:    e.valorNovo,
    payload:      e.payload,
    detectadoEm:  e.detectadoEm,
    fonteEvento:  "automatico" as const,
  }));

  // Merge — manuais primeiro (mais críticos) + automáticos por data desc
  return NextResponse.json({
    data: [...manuaisFormatados, ...automaticosFormatados],
    counts: {
      manuais:     manuaisFormatados.length,
      automaticos: automaticosFormatados.length,
      total:       manuaisFormatados.length + automaticosFormatados.length,
    },
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarEnvelope(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada — restrita a CONFORMIDADE" }, { status: 403 });
  }

  const numero = await numeroPorId(id);
  if (!numero) return NextResponse.json({ error: "Resultado não encontrado" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const parsed = RegistrarEventoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 },
    );
  }
  const data = parsed.data;

  const result = await registrarEvento({
    numeroLicitacao: numero,
    cnpj:            data.cnpj,
    fornecedor:      data.fornecedor,
    tipo:            data.tipo,
    dataEvento:      data.dataEvento ? new Date(data.dataEvento) : undefined,
    motivo:          data.motivo,
    motivoDetalhe:   data.motivoDetalhe,
    fonte:           data.fonte,
    observacao:      data.observacao,
    userId:          session.user.id,
  });

  return NextResponse.json(result, { status: 201 });
}
